//! One core instance over one linear memory: the state behind the exports, kept out of the
//! globals so native tests can build several fresh instances and compare them.

use audio_core::{Core, InitParams, Layout};

use crate::codes;
use crate::memory::LinearMemory;

/// The block of linear memory `init` grew for the fixed regions. Kept across `dispose`, so a later
/// `init` with a layout that fits reuses it and lands on the same addresses again.
#[derive(Clone, Copy)]
struct Block {
    base: *mut u8,
    pages: usize,
}

pub struct Instance<M: LinearMemory> {
    memory: M,
    block: Option<Block>,
    core: Option<Core>,
}

impl<M: LinearMemory> Instance<M> {
    pub const fn new(memory: M) -> Instance<M> {
        Instance { memory, block: None, core: None }
    }

    /// `myco_audio_init` (api-and-models §5). **Deterministic**: it takes exactly one block of
    /// `Layout::new(&params).pages()` pages with a single `memory.grow`, before anything else has
    /// grown memory, and carves every fixed region from it in `REGION_ORDER`. Nothing here touches
    /// the global allocator. So a fresh instance, given the same `initial` memory and the same
    /// parameters, puts every region (and the output `process` returns) on the same address.
    pub fn init(&mut self, params: InitParams) -> i32 {
        if self.core.is_some() {
            return codes::ALREADY_INITIALIZED;
        }
        if params.validate().is_err() {
            return codes::INVALID_ARGUMENT;
        }
        let layout = Layout::new(&params);
        let base = match self.block {
            Some(block) if block.pages >= layout.pages() => {
                // SAFETY: the block is ours and at least `layout.total()` bytes long.
                unsafe { core::ptr::write_bytes(block.base, 0, layout.total()) };
                block.base
            }
            _ => match self.memory.grow(layout.pages()) {
                Some(base) => {
                    self.block = Some(Block { base, pages: layout.pages() });
                    base
                }
                None => return codes::OUT_OF_MEMORY,
            },
        };
        // SAFETY: `base` is a zeroed, page-aligned block of `layout.total()` bytes that only this
        // instance uses, never freed (grown linear memory, or a leaked host reservation).
        self.core = Some(unsafe { Core::new(params, layout, base) });
        codes::OK
    }

    /// `myco_audio_dispose`: drops the core. The block stays reserved for the next `init`.
    pub fn dispose(&mut self) {
        self.core = None;
    }

    pub fn core(&self) -> Option<&Core> {
        self.core.as_ref()
    }

    pub fn core_mut(&mut self) -> Option<&mut Core> {
        self.core.as_mut()
    }

    /// `myco_audio_process`: one quantum at context frame `frame`; null before `init`.
    pub fn process(&mut self, frame: u64) -> *const f32 {
        match self.core.as_mut() {
            Some(core) => core.process(frame).as_ptr(),
            None => core::ptr::null(),
        }
    }

    pub fn memory(&self) -> &M {
        &self.memory
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::HostMemory;
    use audio_core::REGION_ORDER;

    /// Pages the module's data, stack and statics would take before `init` (any fixed number).
    const INITIAL_PAGES: usize = 24;

    fn fresh(maximum: usize) -> Instance<HostMemory> {
        Instance::new(HostMemory::new(INITIAL_PAGES, maximum))
    }

    fn default_preset() -> InitParams {
        InitParams { sample_rate: 48_000.0, max_logical: 4_096, max_mixed: 128, max_buses: 32, arena_initial_bytes: 16 << 20, ..InitParams::default() }
    }

    /// Every region's address in linear memory, then the output's.
    fn addresses(instance: &mut Instance<HostMemory>) -> Vec<usize> {
        let core = instance.core().unwrap();
        let base = core.base();
        let mut out: Vec<usize> = REGION_ORDER
            .iter()
            .map(|kind| instance.memory().address((base + core.layout().region(*kind).offset) as *const u8))
            .collect();
        let output = instance.process(0) as *const u8;
        out.push(instance.memory().address(output));
        out
    }

    #[test]
    fn init_lands_on_the_same_addresses_in_fresh_instances() {
        let mut a = fresh(4_096);
        let mut b = fresh(4_096);
        assert_eq!(a.init(default_preset()), codes::OK);
        assert_eq!(b.init(default_preset()), codes::OK);
        let (aa, ba) = (addresses(&mut a), addresses(&mut b));
        assert_eq!(aa, ba);
        // The block starts right after the initial pages.
        assert_eq!(aa[0], INITIAL_PAGES * audio_core::layout::PAGE_BYTES);
    }

    #[test]
    fn dispose_then_init_reuses_the_block() {
        let mut a = fresh(4_096);
        assert_eq!(a.init(default_preset()), codes::OK);
        let before = addresses(&mut a);
        a.core_mut().unwrap().regions_mut().voices[0] = 7;
        a.dispose();
        assert_eq!(a.init(default_preset()), codes::OK);
        assert_eq!(addresses(&mut a), before);
        assert_eq!(a.core().unwrap().regions().voices[0], 0, "re-zeroed");
    }

    #[test]
    fn init_twice_is_refused() {
        let mut a = fresh(4_096);
        assert_eq!(a.init(default_preset()), codes::OK);
        assert_eq!(a.init(default_preset()), codes::ALREADY_INITIALIZED);
    }

    #[test]
    fn bad_parameters_are_refused() {
        let mut a = fresh(4_096);
        assert_eq!(a.init(InitParams { max_mixed: 0, ..default_preset() }), codes::INVALID_ARGUMENT);
        assert!(a.core().is_none());
    }

    #[test]
    fn a_full_memory_refuses_init() {
        let mut a = fresh(INITIAL_PAGES + 8);
        assert_eq!(a.init(default_preset()), codes::OUT_OF_MEMORY);
    }

    #[test]
    fn process_before_init_returns_null() {
        assert!(fresh(64).process(0).is_null());
    }
}
