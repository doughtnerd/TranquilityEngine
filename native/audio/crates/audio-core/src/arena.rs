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
//! - **Ceiling.** Counted in class bytes (what's taken). Past it, `alloc` refuses
//!   ([`Refusal::Ceiling`]); a failed growth refuses too ([`Refusal::Grow`]). The wasm path's
//!   ceiling is the imported Memory's `maximum` (the shell sets it to the fixed regions plus
//!   `clipMemoryMB`), so it refuses as `Grow`; [`Arena::set_ceiling`] sets a core-side ceiling.
//!
//! Nothing here allocates from the global allocator: the state is fixed arrays, and blocks come
//! from the `Arena` region or from grown memory.

pub mod size_class;

use audio_wire::generated as wire;

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
        let _ = initial;
        todo!("A1.3b")
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
    /// (a reused block holds its last clip's samples).
    pub fn alloc(&mut self, bytes: usize) -> Result<Block, Refusal> {
        let _ = bytes;
        todo!("A1.3b")
    }

    /// Returns `block` to its class's free list; the last live block resets the arena (bump
    /// pointers to their starts, lists cleared). `block` must come from this arena's `alloc` and
    /// not be freed twice.
    pub fn free(&mut self, block: Block) {
        let _ = block;
        todo!("A1.3b")
    }

    /// Reclaims everything (RESET with `keepClips = 0`): no live blocks, bump pointers at their
    /// starts, lists cleared. Segments are kept (memory isn't returned).
    pub fn reset(&mut self) {
        todo!("A1.3b")
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
        todo!("A1.3b")
    }
}

impl Default for Arena {
    fn default() -> Arena {
        Arena::empty()
    }
}

/// Grows linear memory: `memory.grow` on wasm (the imported Memory; the pages land at the end of
/// memory, zeroed), a leaked, zeroed, page-aligned allocation natively.
pub fn platform_grow(pages: usize) -> Option<*mut u8> {
    let _ = pages;
    todo!("A1.3b")
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "A1.3b"]
    fn alloc_rounds_up_to_the_class() {}

    #[test]
    #[ignore = "A1.3b"]
    fn a_freed_block_is_reused_by_its_class() {}

    #[test]
    #[ignore = "A1.3b"]
    fn a_free_block_up_to_two_classes_larger_is_taken() {}

    #[test]
    #[ignore = "A1.3b"]
    fn an_empty_arena_grows_by_at_least_4_mb() {}

    #[test]
    #[ignore = "A1.3b"]
    fn growth_falls_back_to_just_the_block() {}

    #[test]
    #[ignore = "A1.3b"]
    fn past_the_ceiling_is_refused() {}

    #[test]
    #[ignore = "A1.3b"]
    fn a_failed_growth_is_refused() {}

    #[test]
    #[ignore = "A1.3b"]
    fn freeing_the_last_block_resets_the_bump_pointers() {}

    #[test]
    #[ignore = "A1.3b"]
    fn reset_reclaims_everything() {}
}
