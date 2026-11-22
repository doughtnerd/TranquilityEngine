//! An allocator that frees (ADR 0344 §5): the host destroys and re-creates instances in place after a fault or a
//! reload, so memory a destroyed instance held must come back, or every reset would leak until the module's
//! `memoryMB` runs out. (The B0 spike's bump allocator leaked on every reset.)
//!
//! [`FreeList`] is a first-fit, address-ordered free list that splits blocks and merges neighbours on free; it takes
//! its regions from a grow function. Allocation happens in `create` and `destroy`, never per block, so a linear walk is
//! fine. [`WasmHeap`] wraps it over `memory.grow` as a `GlobalAlloc` (single-threaded: wasm32 without threads, which the
//! host refuses).
//!
//! Layout: every block is 16-byte aligned and a multiple of 16 bytes, starting with a 16-byte header whose first word
//! is the block's size (header included). A free block's second word links the next free block (0 ends the list).
//! Allocations aligned above 16 over-allocate and keep the block's payload address just below the aligned pointer.

use core::alloc::{GlobalAlloc, Layout};
use core::cell::UnsafeCell;

/// Block alignment and header size.
const UNIT: usize = 16;
/// The smallest block: a header and one unit of payload.
const MIN_BLOCK: usize = 2 * UNIT;
const WORD: usize = core::mem::size_of::<usize>();

const fn round_up(n: usize, to: usize) -> usize {
    (n + to - 1) & !(to - 1)
}

/// A first-fit free list over regions handed to it.
pub struct FreeList {
    /// The lowest free block's address (0: none).
    head: usize,
}

impl Default for FreeList {
    fn default() -> Self {
        Self::new()
    }
}

impl FreeList {
    pub const fn new() -> Self {
        FreeList { head: 0 }
    }

    unsafe fn size(block: usize) -> usize {
        *(block as *const usize)
    }
    unsafe fn set_size(block: usize, size: usize) {
        *(block as *mut usize) = size;
    }
    unsafe fn next(block: usize) -> usize {
        *((block + WORD) as *const usize)
    }
    unsafe fn set_next(block: usize, next: usize) {
        *((block + WORD) as *mut usize) = next;
    }

    /// Hands the region `[start, start + len)` to the list. Safety: the region is writable, unused, not already in the
    /// list, `start` is 16-byte aligned and non-zero, and `len` is a multiple of 16 of at least 32.
    pub unsafe fn add_region(&mut self, start: usize, len: usize) {
        debug_assert!(start != 0 && start % UNIT == 0 && len % UNIT == 0 && len >= MIN_BLOCK);
        Self::set_size(start, len);
        self.insert(start);
    }

    /// Links free block `block` in address order and merges it with the blocks it touches.
    unsafe fn insert(&mut self, block: usize) {
        let mut prev = 0usize;
        let mut cur = self.head;
        while cur != 0 && cur < block {
            prev = cur;
            cur = Self::next(cur);
        }
        // Merge with the next block.
        if cur != 0 && block + Self::size(block) == cur {
            Self::set_size(block, Self::size(block) + Self::size(cur));
            Self::set_next(block, Self::next(cur));
        } else {
            Self::set_next(block, cur);
        }
        // Merge with the previous block, or link after it.
        if prev != 0 && prev + Self::size(prev) == block {
            Self::set_size(prev, Self::size(prev) + Self::size(block));
            Self::set_next(prev, Self::next(block));
        } else if prev != 0 {
            Self::set_next(prev, block);
        } else {
            self.head = block;
        }
    }

    /// Takes a block of at least `need` bytes (a multiple of 16) from the list; its address, or 0.
    unsafe fn take(&mut self, need: usize) -> usize {
        let mut prev = 0usize;
        let mut cur = self.head;
        while cur != 0 {
            let size = Self::size(cur);
            if size >= need {
                let rest = size - need;
                let after = if rest >= MIN_BLOCK {
                    let tail = cur + need;
                    Self::set_size(tail, rest);
                    Self::set_next(tail, Self::next(cur));
                    Self::set_size(cur, need);
                    tail
                } else {
                    Self::next(cur)
                };
                if prev == 0 {
                    self.head = after;
                } else {
                    Self::set_next(prev, after);
                }
                return cur;
            }
            prev = cur;
            cur = Self::next(cur);
        }
        0
    }

    /// Allocates `layout`, growing through `grow(bytes) -> Option<(start, len)>` when nothing fits (the region it returns
    /// follows `add_region`'s rules). Null when growing fails. Safety: as `GlobalAlloc::alloc`.
    pub unsafe fn alloc(&mut self, layout: Layout, grow: &mut dyn FnMut(usize) -> Option<(usize, usize)>) -> *mut u8 {
        if layout.align() > UNIT {
            // Over-allocate, align inside, and keep the payload address in the word below the aligned pointer.
            let Ok(inner) = Layout::from_size_align(layout.size() + layout.align(), UNIT) else { return core::ptr::null_mut() };
            let p = self.alloc(inner, grow) as usize;
            if p == 0 {
                return core::ptr::null_mut();
            }
            let q = round_up(p + UNIT, layout.align());
            *((q - WORD) as *mut usize) = p;
            return q as *mut u8;
        }
        let Some(need) = layout.size().max(1).checked_add(UNIT + UNIT - 1).map(|n| (n & !(UNIT - 1)).max(MIN_BLOCK)) else {
            return core::ptr::null_mut();
        };
        let mut block = self.take(need);
        if block == 0 {
            let Some((start, len)) = grow(need) else { return core::ptr::null_mut() };
            self.add_region(start, len);
            block = self.take(need);
            if block == 0 {
                return core::ptr::null_mut();
            }
        }
        (block + UNIT) as *mut u8
    }

    /// Frees what `alloc` returned for `layout`. Safety: as `GlobalAlloc::dealloc`.
    pub unsafe fn dealloc(&mut self, ptr: *mut u8, layout: Layout) {
        if layout.align() > UNIT {
            let p = *((ptr as usize - WORD) as *const usize);
            self.dealloc(p as *mut u8, Layout::from_size_align_unchecked(layout.size() + layout.align(), UNIT));
            return;
        }
        self.insert(ptr as usize - UNIT);
    }

    /// Free bytes in the list and the number of free blocks (for tests and diagnostics).
    pub fn free_stats(&self) -> (usize, usize) {
        let (mut bytes, mut blocks) = (0, 0);
        let mut cur = self.head;
        while cur != 0 {
            unsafe {
                bytes += Self::size(cur);
                cur = Self::next(cur);
            }
            blocks += 1;
        }
        (bytes, blocks)
    }
}

/// [`FreeList`] over the module's memory, growing it a page (64 KiB) or more at a time. The global allocator on wasm32
/// with the `runtime` feature.
pub struct WasmHeap(UnsafeCell<FreeList>);

// SAFETY: wasm32 plugin modules are single-threaded (the host refuses threads and shared memory).
unsafe impl Sync for WasmHeap {}

impl WasmHeap {
    pub const fn new() -> Self {
        WasmHeap(UnsafeCell::new(FreeList::new()))
    }
}

impl Default for WasmHeap {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_arch = "wasm32")]
fn grow_memory(bytes: usize) -> Option<(usize, usize)> {
    const PAGE: usize = 65536;
    let pages = bytes.div_ceil(PAGE);
    let old = core::arch::wasm32::memory_grow(0, pages);
    if old == usize::MAX {
        return None;
    }
    // Page 0 never comes from memory.grow (the module's initial memory holds the stack and data), so start ≠ 0.
    Some((old * PAGE, pages * PAGE))
}

#[cfg(not(target_arch = "wasm32"))]
fn grow_memory(_bytes: usize) -> Option<(usize, usize)> {
    None
}

unsafe impl GlobalAlloc for WasmHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        (*self.0.get()).alloc(layout, &mut grow_memory)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        (*self.0.get()).dealloc(ptr, layout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;
    use std::vec::Vec;

    /// A free list over a 16-aligned arena, growing from it a chunk at a time.
    struct Arena {
        mem: Vec<u128>,
        used: usize,
        list: FreeList,
    }

    impl Arena {
        fn new(bytes: usize) -> Self {
            Arena { mem: vec![0u128; bytes / 16], used: 0, list: FreeList::new() }
        }
        fn base(&self) -> usize {
            self.mem.as_ptr() as usize
        }
        fn alloc(&mut self, size: usize, align: usize) -> usize {
            let base = self.base();
            let cap = self.mem.len() * 16;
            let used = &mut self.used;
            let mut grow = |bytes: usize| {
                let len = round_up(bytes, 4096);
                if *used + len > cap {
                    return None;
                }
                let start = base + *used;
                *used += len;
                Some((start, len))
            };
            unsafe { self.list.alloc(Layout::from_size_align(size, align).unwrap(), &mut grow) as usize }
        }
        fn free(&mut self, ptr: usize, size: usize, align: usize) {
            unsafe { self.list.dealloc(ptr as *mut u8, Layout::from_size_align(size, align).unwrap()) }
        }
    }

    #[test]
    fn freed_memory_is_reused_so_create_destroy_cycles_do_not_grow() {
        let mut a = Arena::new(1 << 20);
        for _ in 0..1000 {
            let io = a.alloc(2 * 128 * 4 + 128, 16);
            let state = a.alloc(48_000 * 4, 4);
            assert!(io != 0 && state != 0);
            a.free(state, 48_000 * 4, 4);
            a.free(io, 2 * 128 * 4 + 128, 16);
        }
        // One growth's worth: every cycle reused the first one's memory.
        assert!(a.used <= round_up(48_000 * 4 + 32, 4096) + 4096, "grew to {} bytes", a.used);
        let (bytes, blocks) = a.list.free_stats();
        assert_eq!((bytes, blocks), (a.used, 1), "everything freed merges back into one block");
    }

    #[test]
    fn blocks_are_aligned_distinct_and_writable() {
        let mut a = Arena::new(1 << 20);
        let mut live = Vec::new();
        for i in 1..200usize {
            let (size, align) = (i * 7 % 300 + 1, [1, 2, 4, 8, 16, 32, 64, 256][i % 8]);
            let p = a.alloc(size, align);
            assert_ne!(p, 0);
            assert_eq!(p % align, 0, "align {align}");
            unsafe { core::ptr::write_bytes(p as *mut u8, i as u8, size) };
            live.push((p, size, align, i as u8));
        }
        for &(p, size, _, fill) in &live {
            let s = unsafe { core::slice::from_raw_parts(p as *const u8, size) };
            assert!(s.iter().all(|&b| b == fill), "a block was overwritten by another");
        }
        // Free every other block, then the rest: everything merges back.
        for (i, &(p, size, align, _)) in live.iter().enumerate() {
            if i % 2 == 0 {
                a.free(p, size, align);
            }
        }
        for (i, &(p, size, align, _)) in live.iter().enumerate() {
            if i % 2 == 1 {
                a.free(p, size, align);
            }
        }
        assert_eq!(a.list.free_stats(), (a.used, 1));
    }

    #[test]
    fn returns_null_when_growing_fails() {
        let mut a = Arena::new(8192);
        assert_eq!(a.alloc(1 << 20, 16), 0);
        assert_ne!(a.alloc(100, 16), 0);
    }
}
