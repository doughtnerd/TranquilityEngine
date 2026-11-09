//! Linear memory as `myco_audio_init` sees it: something that grows by whole pages.
//!
//! On wasm it's the imported `env.memory` (`--import-memory`): the shell creates the
//! `WebAssembly.Memory({initial, maximum})` (architecture §5.1). `memory.grow` returns the previous
//! size, so a fresh instance given the same `initial` gets its first grown pages at the same
//! address every time; that's what makes init deterministic. Natively, `HostMemory` imitates it
//! over one page-aligned reservation, so tests can build several "fresh instances" side by side.

use audio_core::layout::PAGE_BYTES;

pub trait LinearMemory {
    /// Grows by `pages` 64 KiB pages and returns a pointer to the first new byte (zeroed), or
    /// `None` when the memory's maximum would be passed.
    fn grow(&mut self, pages: usize) -> Option<*mut u8>;
    /// `ptr`'s address in linear memory (its offset from byte 0).
    fn address(&self, ptr: *const u8) -> usize;
}

/// The imported memory of the wasm instance.
#[cfg(target_arch = "wasm32")]
pub struct WasmMemory;

#[cfg(target_arch = "wasm32")]
impl LinearMemory for WasmMemory {
    fn grow(&mut self, pages: usize) -> Option<*mut u8> {
        let previous = core::arch::wasm32::memory_grow::<0>(pages);
        if previous == usize::MAX {
            return None;
        }
        Some((previous * PAGE_BYTES) as *mut u8)
    }

    fn address(&self, ptr: *const u8) -> usize {
        ptr as usize
    }
}

/// A native stand-in for linear memory: `initial` pages already "used" (as the wasm module's data
/// and stack would be), growing up to `maximum`. The reservation is zeroed and lazily committed by
/// the OS, and leaked, because the core holds `'static` slices into it.
pub struct HostMemory {
    initial: usize,
    maximum: usize,
    origin: *mut u8,
    pages: usize,
}

impl HostMemory {
    pub const fn new(initial: usize, maximum: usize) -> HostMemory {
        HostMemory { initial, maximum, origin: core::ptr::null_mut(), pages: initial }
    }

    fn origin(&mut self) -> Option<*mut u8> {
        if self.origin.is_null() {
            let layout = std::alloc::Layout::from_size_align(self.maximum * PAGE_BYTES, PAGE_BYTES).ok()?;
            // SAFETY: non-zero size (maximum ≥ 1 in every caller); leaked on purpose.
            let p = unsafe { std::alloc::alloc_zeroed(layout) };
            if p.is_null() {
                return None;
            }
            self.origin = p;
            self.pages = self.initial;
        }
        Some(self.origin)
    }
}

impl LinearMemory for HostMemory {
    fn grow(&mut self, pages: usize) -> Option<*mut u8> {
        let origin = self.origin()?;
        if self.pages + pages > self.maximum {
            return None;
        }
        let previous = self.pages;
        self.pages += pages;
        // SAFETY: within the reservation (checked above).
        Some(unsafe { origin.add(previous * PAGE_BYTES) })
    }

    fn address(&self, ptr: *const u8) -> usize {
        ptr as usize - self.origin as usize
    }
}

/// The memory the exported functions use.
#[cfg(target_arch = "wasm32")]
pub type PlatformMemory = WasmMemory;
#[cfg(target_arch = "wasm32")]
pub const PLATFORM_MEMORY: PlatformMemory = WasmMemory;

/// Natively the exports exist only so the crate builds and tests can call the stateless ones.
#[cfg(not(target_arch = "wasm32"))]
pub type PlatformMemory = HostMemory;
#[cfg(not(target_arch = "wasm32"))]
pub const PLATFORM_MEMORY: PlatformMemory = HostMemory::new(32, 8_192);
