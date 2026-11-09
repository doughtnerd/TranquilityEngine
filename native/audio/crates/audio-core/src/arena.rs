//! The clip arena (ADR 0157, api-and-models §5 "Arena", architecture §5.2): size-class slabs, no
//! compaction.
//!
//! - **Classes.** Four per power of two from 4 KB ([`size_class`]); a request rounds up to its
//!   class, and a block (one clip's slab) is exactly its class's bytes.
//! - **Allocate.** Pop the class's free list; else take a free block from up to two classes larger;
//!   else carve from a segment's bump pointer; else grow memory.
//! - **Growth** happens only here, in [`Arena::alloc`], which only `onmessage` reaches
//!   (`myco_audio_clip_reserve`): never in `process`. It grows by max(block, 4 MB, 25% of the
//!   arena) and, if that fails, by just enough for the block. Memory grows at the end of linear
//!   memory, so new pages extend the last segment when they're contiguous with it and start a new
//!   segment otherwise.
//! - **Free.** The block goes back to its class's free list (the link lives in the block's first
//!   bytes); no splitting, merging or compaction. When the last block is freed, every bump pointer
//!   returns to its segment's start and the lists clear. Memory isn't returned to the browser.
//! - **Ceiling.** The primary ceiling check is the main-side clip registry, which refuses a load
//!   past `clipMemoryMB` before it sends CLIP_BEGIN. In the core, the ceiling is the imported
//!   Memory's `maximum` (the shell sets it to the fixed regions plus the clip ceiling, architecture
//!   §5.1), so a full arena refuses as [`Refusal::Grow`] (refusedGrow). [`Refusal::Ceiling`]
//!   (refusedCeiling) comes only from a class-byte ceiling set with [`Arena::set_ceiling`]
//!   (`usize::MAX`, none, by default), a request past the largest class, or a full clip directory
//!   (`ClipStore`).
//!
//! Nothing here allocates from the global allocator: the state is fixed arrays, and blocks come
//! from the `Arena` region or from grown memory.

pub mod size_class;

use audio_wire::generated as wire;

use crate::layout::PAGE_BYTES;

/// Grows memory by `pages` 64 KiB pages and returns the first new byte (zeroed), or `None` when it
/// can't. [`platform_grow`] by default; tests install their own.
pub type GrowFn = fn(pages: usize) -> Option<*mut u8>;

/// Growth is at least this (architecture §5.2: max(block, 4 MB, 25% of the arena)).
pub const GROW_MIN_BYTES: usize = 4 << 20;

/// Most segments (runs of contiguous arena memory). Each growth adds at most one and is at least
/// 25% of the arena, so 64 is far more than a 4 GiB memory can need.
pub const MAX_SEGMENTS: usize = 64;

/// Why `alloc` refused. Each is a STATUS clip event and an ABI code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The ceiling (class bytes) would be passed, or the request is past the largest class.
    Ceiling,
    /// Memory couldn't grow (the Memory's `maximum`, or the segment table is full).
    Grow,
}

impl Refusal {
    /// The `clipEvents` code (2 refusedCeiling, 3 refusedGrow).
    pub fn clip_event(self) -> u32 {
        match self {
            Refusal::Ceiling => wire::clip_event::REFUSED_CEILING,
            Refusal::Grow => wire::clip_event::REFUSED_GROW,
        }
    }

    /// The ABI result (`ERR_CEILING`, `ERR_ARENA_FULL`).
    pub fn code(self) -> i32 {
        match self {
            Refusal::Ceiling => wire::ERR_CEILING,
            Refusal::Grow => wire::ERR_ARENA_FULL,
        }
    }
}

/// One allocated block: its address and its class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub addr: usize,
    pub class: u8,
}

impl Block {
    /// The block's bytes (its class's).
    pub fn len(&self) -> usize {
        size_class::class_bytes(self.class as usize)
    }
}

/// A run of contiguous arena memory, carved from `start` up to `bump`.
#[derive(Clone, Copy, Debug, Default)]
struct Segment {
    start: usize,
    end: usize,
    bump: usize,
}

/// The arena's state. Fixed size; no heap.
pub struct Arena {
    segments: [Segment; MAX_SEGMENTS],
    segment_count: usize,
    /// Each class's free-list head (a block address), 0 when empty.
    heads: [usize; size_class::NUM_CLASSES],
    /// Class bytes in live blocks.
    used: usize,
    /// Live blocks.
    live: usize,
    /// Class-byte ceiling; `usize::MAX` = none (the Memory's `maximum` bounds it).
    ceiling: usize,
    grow: GrowFn,
}

impl Arena {
    /// An arena with no memory: the first `alloc` grows. Doesn't allocate.
    pub const fn empty() -> Arena {
        Arena {
            segments: [Segment { start: 0, end: 0, bump: 0 }; MAX_SEGMENTS],
            segment_count: 0,
            heads: [0; size_class::NUM_CLASSES],
            used: 0,
            live: 0,
            ceiling: usize::MAX,
            grow: platform_grow,
        }
    }

    /// An arena whose first segment is `initial` (the `Arena` region, page-aligned, last in the
    /// block so growth can extend it). An empty `initial` gives [`Arena::empty`].
    pub fn over(initial: &'static mut [u8]) -> Arena {
        let mut arena = Arena::empty();
        if !initial.is_empty() {
            let start = initial.as_mut_ptr() as usize;
            arena.segments[0] = Segment { start, end: start + initial.len(), bump: start };
            arena.segment_count = 1;
        }
        arena
    }

    /// Installs the growth function (tests; the default is [`platform_grow`]).
    pub fn set_grow(&mut self, grow: GrowFn) {
        self.grow = grow;
    }

    /// Sets the class-byte ceiling (`usize::MAX` for none). Live blocks are kept even when they
    /// pass a lowered ceiling; later allocations are refused.
    pub fn set_ceiling(&mut self, bytes: usize) {
        self.ceiling = bytes;
    }

    pub fn ceiling(&self) -> usize {
        self.ceiling
    }

    /// Allocates a block for `bytes` (rounded up to its class), in the order the module comment
    /// gives, growing memory if it must. **`onmessage` only.** The block's bytes are not zeroed
    /// (a reused block holds its last clip's samples). A refusal changes nothing but, possibly,
    /// memory already grown (kept for later allocations).
    pub fn alloc(&mut self, bytes: usize) -> Result<Block, Refusal> {
        let class = size_class::class_of(bytes).ok_or(Refusal::Ceiling)?;
        let block = self.take(class)?;
        self.used += block.len();
        self.live += 1;
        Ok(block)
    }

    fn fits_ceiling(&self, class: usize) -> bool {
        self.used.checked_add(size_class::class_bytes(class)).is_some_and(|n| n <= self.ceiling)
    }

    fn take(&mut self, class: usize) -> Result<Block, Refusal> {
        if !self.fits_ceiling(class) {
            return Err(Refusal::Ceiling);
        }
        // The class's own list, then up to two classes larger (the block keeps its own class).
        for c in class..(class + 3).min(size_class::NUM_CLASSES) {
            if self.heads[c] != 0 && self.fits_ceiling(c) {
                return Ok(Block { addr: self.pop(c), class: c as u8 });
            }
        }
        let bytes = size_class::class_bytes(class);
        if let Some(addr) = self.carve(bytes) {
            return Ok(Block { addr, class: class as u8 });
        }
        self.grow_for(bytes)?;
        self.carve(bytes).map(|addr| Block { addr, class: class as u8 }).ok_or(Refusal::Grow)
    }

    /// Carves `bytes` from the first segment whose tail holds them.
    fn carve(&mut self, bytes: usize) -> Option<usize> {
        let seg = self.segments[..self.segment_count].iter_mut().find(|s| s.end - s.bump >= bytes)?;
        let addr = seg.bump;
        seg.bump += bytes;
        Some(addr)
    }

    /// Grows by max(block, 4 MB, 25% of the arena), else by just the block (architecture §5.2).
    fn grow_for(&mut self, bytes: usize) -> Result<(), Refusal> {
        let pages_for = |n: usize| n.div_ceil(PAGE_BYTES);
        let wanted = pages_for(bytes.max(GROW_MIN_BYTES).max(self.reserved_bytes() / 4));
        let minimal = pages_for(bytes);
        let (ptr, pages) = match (self.grow)(wanted) {
            Some(p) => (p, wanted),
            None if minimal < wanted => ((self.grow)(minimal).ok_or(Refusal::Grow)?, minimal),
            None => return Err(Refusal::Grow),
        };
        let (start, len) = (ptr as usize, pages * PAGE_BYTES);
        if let Some(last) = self.segments[..self.segment_count].last_mut() {
            if last.end == start {
                last.end += len;
                return Ok(());
            }
        }
        if self.segment_count == MAX_SEGMENTS {
            return Err(Refusal::Grow);
        }
        self.segments[self.segment_count] = Segment { start, end: start + len, bump: start };
        self.segment_count += 1;
        Ok(())
    }

    fn pop(&mut self, class: usize) -> usize {
        let addr = self.heads[class];
        // SAFETY: a free block of this arena; its first bytes hold the next link (`push`).
        self.heads[class] = unsafe { core::ptr::read_unaligned(addr as *const usize) };
        addr
    }

    fn push(&mut self, class: usize, addr: usize) {
        // SAFETY: a block of this arena (at least 4 KB) that no clip holds any more.
        unsafe { core::ptr::write_unaligned(addr as *mut usize, self.heads[class]) };
        self.heads[class] = addr;
    }

    /// Returns `block` to its class's free list; the last live block resets the arena (bump
    /// pointers to their starts, lists cleared). `block` must come from this arena's `alloc` and
    /// not be freed twice.
    pub fn free(&mut self, block: Block) {
        debug_assert!(self.live > 0);
        self.used -= block.len();
        self.live -= 1;
        if self.live == 0 {
            self.reset();
        } else {
            self.push(block.class as usize, block.addr);
        }
    }

    /// Reclaims everything (RESET with `keepClips = 0`): no live blocks, bump pointers at their
    /// starts, lists cleared. Segments are kept (memory isn't returned).
    pub fn reset(&mut self) {
        for s in &mut self.segments[..self.segment_count] {
            s.bump = s.start;
        }
        self.heads = [0; size_class::NUM_CLASSES];
        self.used = 0;
        self.live = 0;
    }

    /// Class bytes in live blocks (STATUS `arenaUsedKB` × 1024).
    pub fn used_bytes(&self) -> usize {
        self.used
    }

    /// Live blocks.
    pub fn live_blocks(&self) -> usize {
        self.live
    }

    /// Bytes the arena holds across its segments, used or not.
    pub fn reserved_bytes(&self) -> usize {
        self.segments[..self.segment_count].iter().map(|s| s.end - s.start).sum()
    }

    /// The largest block `alloc` could hand out without growing: the largest class with a free
    /// block, or the largest segment tail (STATUS `arenaLargestFreeKB` × 1024).
    pub fn largest_free_bytes(&self) -> usize {
        let listed = (0..size_class::NUM_CLASSES).rev().find(|&c| self.heads[c] != 0).map_or(0, size_class::class_bytes);
        let tail = self.segments[..self.segment_count].iter().map(|s| s.end - s.bump).max().unwrap_or(0);
        listed.max(tail)
    }

    /// Each segment as `(start address, bytes)`, in the order they were added.
    pub fn segments(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.segments[..self.segment_count].iter().map(|s| (s.start, s.end - s.start))
    }
}

impl Default for Arena {
    fn default() -> Arena {
        Arena::empty()
    }
}

/// Grows linear memory: `memory.grow` on the imported Memory. The pages land at the end of
/// memory, zeroed; `None` past the Memory's `maximum`.
#[cfg(target_arch = "wasm32")]
pub fn platform_grow(pages: usize) -> Option<*mut u8> {
    let previous = core::arch::wasm32::memory_grow::<0>(pages);
    if previous == usize::MAX {
        return None;
    }
    Some((previous * PAGE_BYTES) as *mut u8)
}

/// Grows "linear memory" natively: a leaked, zeroed, page-aligned allocation.
#[cfg(not(target_arch = "wasm32"))]
pub fn platform_grow(pages: usize) -> Option<*mut u8> {
    let layout = std::alloc::Layout::from_size_align(pages.checked_mul(PAGE_BYTES)?, PAGE_BYTES).ok()?;
    if layout.size() == 0 {
        return None;
    }
    // SAFETY: non-zero size; leaked on purpose (the arena keeps addresses into it for good).
    let p = unsafe { std::alloc::alloc_zeroed(layout) };
    (!p.is_null()).then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::sync::atomic::{AtomicUsize, Ordering};

    const KB: usize = 1024;

    /// A leaked, zeroed, page-aligned region of `bytes`, as the `Arena` region would be.
    fn region(bytes: usize) -> &'static mut [u8] {
        let p = platform_grow(bytes / PAGE_BYTES).unwrap();
        // SAFETY: fresh, leaked, `bytes` long.
        unsafe { core::slice::from_raw_parts_mut(p, bytes) }
    }

    fn never(_: usize) -> Option<*mut u8> {
        None
    }

    #[test]
    fn alloc_rounds_up_to_the_class() {
        let mut a = Arena::over(region(PAGE_BYTES));
        let b = a.alloc(4 * KB + 1).unwrap();
        assert_eq!(b.len(), 5 * KB);
        assert_eq!(a.used_bytes(), 5 * KB);
        let c = a.alloc(1).unwrap();
        assert_eq!(c.len(), 4 * KB);
        assert_eq!(c.addr, b.addr + 5 * KB, "carved after the first");
        assert_eq!(a.live_blocks(), 2);
    }

    #[test]
    fn a_freed_block_is_reused_by_its_class() {
        let mut a = Arena::over(region(PAGE_BYTES));
        let b = a.alloc(6 * KB).unwrap();
        let _keep = a.alloc(4 * KB).unwrap();
        a.free(b);
        assert_eq!(a.used_bytes(), 4 * KB);
        assert_eq!(a.largest_free_bytes(), PAGE_BYTES - 10 * KB, "the tail is larger than the free block");
        assert_eq!(a.alloc(5 * KB + 1).unwrap(), b);
    }

    #[test]
    fn a_free_block_up_to_two_classes_larger_is_taken() {
        let mut a = Arena::over(region(PAGE_BYTES));
        a.set_grow(never);
        let big = a.alloc(6 * KB).unwrap(); // class 2
        let keep = a.alloc(56 * KB).unwrap(); // a class of its own; 2 KB of tail left
        a.free(big);
        let got = a.alloc(4 * KB).unwrap(); // class 0 takes the class-2 block
        assert_eq!(got, big);
        assert_eq!(a.used_bytes(), 6 * KB + keep.len(), "counted in the block's own class");

        let mut b = Arena::over(region(PAGE_BYTES));
        b.set_grow(never);
        let c3 = b.alloc(7 * KB).unwrap(); // class 3
        let _rest = b.alloc(56 * KB).unwrap(); // 1 KB of tail left
        b.free(c3);
        assert_eq!(b.alloc(4 * KB), Err(Refusal::Grow), "three classes larger is too far");
    }

    #[test]
    fn an_empty_arena_grows_by_at_least_4_mb() {
        let mut a = Arena::empty();
        assert_eq!(a.reserved_bytes(), 0);
        a.alloc(4 * KB).unwrap();
        assert_eq!(a.reserved_bytes(), GROW_MIN_BYTES);
        let b = a.alloc(5 << 20).unwrap();
        assert!(a.reserved_bytes() >= GROW_MIN_BYTES + b.len(), "grows by at least the block");
    }

    #[test]
    fn growth_falls_back_to_just_the_block() {
        fn small(pages: usize) -> Option<*mut u8> {
            if pages * PAGE_BYTES >= GROW_MIN_BYTES {
                None
            } else {
                platform_grow(pages)
            }
        }
        let mut a = Arena::empty();
        a.set_grow(small);
        let b = a.alloc(64 * KB).unwrap();
        assert_eq!(b.len(), 64 * KB);
        assert_eq!(a.reserved_bytes(), 64 * KB);
    }

    #[test]
    fn contiguous_growth_extends_the_last_segment() {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        fn after(pages: usize) -> Option<*mut u8> {
            if pages > 15 {
                return None;
            }
            Some(NEXT.fetch_add(pages * PAGE_BYTES, Ordering::Relaxed) as *mut u8)
        }
        let base = region(16 * PAGE_BYTES).as_mut_ptr() as usize;
        // The arena gets the first page; "memory" grows into the pages after it.
        // SAFETY: inside the leaked 16-page region.
        let first = unsafe { core::slice::from_raw_parts_mut(base as *mut u8, PAGE_BYTES) };
        NEXT.store(base + PAGE_BYTES, Ordering::Relaxed);
        let mut a = Arena::over(first);
        a.set_grow(after);
        a.alloc(40 * KB).unwrap();
        let b = a.alloc(40 * KB).unwrap(); // the first page's 24 KB tail can't hold it
        assert_eq!(b.addr, base + 40 * KB, "carved across the old end");
        assert_eq!(a.segments().count(), 1);
        assert_eq!(a.reserved_bytes(), 2 * PAGE_BYTES);
    }

    #[test]
    fn past_the_ceiling_is_refused() {
        let mut a = Arena::over(region(PAGE_BYTES));
        a.set_ceiling(8 * KB);
        a.alloc(4 * KB).unwrap();
        a.alloc(4 * KB).unwrap();
        assert_eq!(a.alloc(1), Err(Refusal::Ceiling));
        assert_eq!(a.alloc(size_class::MAX_CLASS_BYTES + 1), Err(Refusal::Ceiling));
        assert_eq!(Refusal::Ceiling.clip_event(), wire::clip_event::REFUSED_CEILING);
        assert_eq!(Refusal::Ceiling.code(), wire::ERR_CEILING);
    }

    #[test]
    fn a_failed_growth_is_refused() {
        let mut a = Arena::over(region(PAGE_BYTES));
        a.set_grow(never);
        a.alloc(PAGE_BYTES).unwrap();
        assert_eq!(a.alloc(4 * KB), Err(Refusal::Grow));
        assert_eq!(a.live_blocks(), 1, "a refusal changes nothing");
        assert_eq!(Refusal::Grow.clip_event(), wire::clip_event::REFUSED_GROW);
        assert_eq!(Refusal::Grow.code(), wire::ERR_ARENA_FULL);
    }

    #[test]
    fn freeing_the_last_block_resets_the_bump_pointers() {
        let mut a = Arena::over(region(PAGE_BYTES));
        let x = a.alloc(8 * KB).unwrap();
        let y = a.alloc(4 * KB).unwrap();
        a.free(x);
        a.free(y);
        assert_eq!((a.used_bytes(), a.live_blocks()), (0, 0));
        assert_eq!(a.largest_free_bytes(), PAGE_BYTES);
        assert_eq!(a.alloc(4 * KB).unwrap().addr, x.addr, "carved from the start again");
    }

    #[test]
    fn reset_reclaims_everything() {
        let mut a = Arena::over(region(PAGE_BYTES));
        for _ in 0..4 {
            a.alloc(10 * KB).unwrap();
        }
        let reserved = a.reserved_bytes();
        a.reset();
        assert_eq!((a.used_bytes(), a.live_blocks()), (0, 0));
        assert_eq!(a.reserved_bytes(), reserved, "memory is kept");
        assert_eq!(a.largest_free_bytes(), reserved);
    }
}
