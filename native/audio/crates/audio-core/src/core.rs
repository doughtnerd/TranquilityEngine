//! `Core`: the mixer's state over the fixed regions, and the render entry point.

use crate::clips::ClipStore;
use crate::layout::{Layout, RegionKind};
use crate::params::InitParams;
use crate::{OUTPUT_CHANNELS, QUANTUM};

/// The fixed regions as slices. Each one is a distinct, non-overlapping range of the block that
/// `Core::new` carved, so holding them as `&'static mut` is sound. Later tasks view their region as
/// their own types (A1.2 voice slots and pending records, A2.1 buses, A1.3b arena).
pub struct Regions {
    pub output: &'static mut [f32],
    pub core_state: &'static mut [u8],
    pub pending: &'static mut [u8],
    pub voices: &'static mut [u8],
    pub mixed: &'static mut [u8],
    pub buses: &'static mut [u8],
    pub reverb: &'static mut [u8],
    pub hrtf: &'static mut [u8],
    pub streams: &'static mut [u8],
    /// Empty: the clip store owns the directory region (A1.3b).
    pub clip_directory: &'static mut [u8],
    /// Empty: the clip store owns the arena region (A1.3b).
    pub arena: &'static mut [u8],
}

/// The whole mixer. No I/O and no globals: the caller owns the block and the instance.
pub struct Core {
    params: InitParams,
    layout: Layout,
    base: usize,
    regions: Regions,
    /// The context frame of the last rendered quantum.
    frame: u64,
    /// Clip PCM (K11: A1.3b replaces the store's body with the slab arena).
    clips: ClipStore,
}

impl Core {
    /// Builds a core over a block laid out by `layout`.
    ///
    /// Doesn't allocate: every buffer is a region of the block, carved in [`crate::REGION_ORDER`].
    ///
    /// # Safety
    /// `base` must point to `layout.total()` zeroed bytes, aligned to [`crate::layout::PAGE_BYTES`],
    /// that nothing else uses and that live for the rest of the program (`'static`). `layout` must
    /// be `Layout::new(&params)`.
    pub unsafe fn new(params: InitParams, layout: Layout, base: *mut u8) -> Core {
        debug_assert_eq!(layout, Layout::new(&params));
        debug_assert_eq!(base as usize % crate::layout::PAGE_BYTES, 0);
        let bytes = |kind: RegionKind| -> &'static mut [u8] {
            let r = layout.region(kind);
            // SAFETY: the caller guarantees the block; regions don't overlap (Layout's test).
            unsafe { core::slice::from_raw_parts_mut(base.add(r.offset), r.len) }
        };
        let out = layout.region(RegionKind::Output);
        // SAFETY: as above; the output region is 64-byte aligned and a whole number of f32s.
        let output = unsafe { core::slice::from_raw_parts_mut(base.add(out.offset) as *mut f32, out.len / 4) };
        let mut regions = Regions {
            output,
            core_state: bytes(RegionKind::CoreState),
            pending: bytes(RegionKind::Pending),
            voices: bytes(RegionKind::Voices),
            mixed: bytes(RegionKind::Mixed),
            buses: bytes(RegionKind::Buses),
            reverb: bytes(RegionKind::Reverb),
            hrtf: bytes(RegionKind::Hrtf),
            streams: bytes(RegionKind::Streams),
            clip_directory: bytes(RegionKind::ClipDirectory),
            arena: bytes(RegionKind::Arena),
        };
        // A1.3b: the clip store owns the directory and arena regions (they stay empty here).
        let clips = ClipStore::over(core::mem::take(&mut regions.clip_directory), core::mem::take(&mut regions.arena));
        let mut core = Core { params, layout, base: base as usize, regions, frame: 0, clips };
        // A2.1: one root bus at unity and MASTER at unity until BUS_CONFIG, BUS_MIX and MASTER.
        crate::bus::init(&mut core);
        core
    }

    pub fn params(&self) -> &InitParams {
        &self.params
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// The block's base address.
    pub fn base(&self) -> usize {
        self.base
    }

    pub fn regions(&self) -> &Regions {
        &self.regions
    }

    pub fn regions_mut(&mut self) -> &mut Regions {
        &mut self.regions
    }

    /// The clips voices read (A1.2, K11).
    pub fn clips(&self) -> &ClipStore {
        &self.clips
    }

    /// The clips, mutably: `onmessage` only (the `clip_*` exports and tests), never in `process`.
    pub fn clips_mut(&mut self) -> &mut ClipStore {
        &mut self.clips
    }

    /// The regions and the clips at once, for the render loop (A1.2).
    pub(crate) fn parts_mut(&mut self) -> (&mut Regions, &ClipStore) {
        (&mut self.regions, &self.clips)
    }

    /// The context frame of the last rendered quantum.
    pub fn frame(&self) -> u64 {
        self.frame
    }

    /// Renders one quantum (exactly [`QUANTUM`] frames) starting at context frame `frame` and
    /// returns the planar stereo output, `[L; 128][R; 128]`. Never allocates or grows memory.
    ///
    /// Voices render into their buses' buffers (`voices::render`, A1.2), then the bus tree mixes
    /// down into the output (`bus::mixdown`, A2.1).
    pub fn process(&mut self, frame: u64) -> &[f32] {
        self.frame = frame;
        crate::voices::render(self, frame);
        crate::bus::mixdown(self);
        &self.regions.output[..OUTPUT_CHANNELS * QUANTUM]
    }

    /// Work units spent in the last quantum (A3.3's model; 0 until then).
    pub fn work_units(&self) -> u32 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::PAGE_BYTES;

    /// A page-aligned, zeroed, leaked block, as `myco_audio_init` would get from `memory.grow`.
    fn block(len: usize) -> *mut u8 {
        let layout = std::alloc::Layout::from_size_align(len, PAGE_BYTES).unwrap();
        // SAFETY: non-zero size; leaked on purpose ('static).
        unsafe { std::alloc::alloc_zeroed(layout) }
    }

    fn params() -> InitParams {
        InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 32, max_buses: 8, arena_initial_bytes: 1 << 20 }
    }

    #[test]
    fn regions_sit_at_their_layout_offsets() {
        let layout = Layout::new(&params());
        let base = block(layout.total());
        let core = unsafe { Core::new(params(), layout.clone(), base) };
        let r = core.regions();
        let at = |p: *const u8| p as usize - base as usize;
        assert_eq!(at(r.output.as_ptr() as *const u8), layout.region(RegionKind::Output).offset);
        assert_eq!(at(r.voices.as_ptr()), layout.region(RegionKind::Voices).offset);
        let (arena_start, arena_len) = core.clips().arena().segments().next().unwrap();
        assert_eq!(arena_start - base as usize, layout.region(RegionKind::Arena).offset);
        assert_eq!(arena_len, 1 << 20);
        assert!(r.arena.is_empty() && r.clip_directory.is_empty(), "the clip store owns them");
    }

    #[test]
    fn process_renders_a_quantum_of_silence() {
        let layout = Layout::new(&params());
        let mut core = unsafe { Core::new(params(), layout.clone(), block(layout.total())) };
        core.regions_mut().output[3] = 1.0;
        let out = core.process(128);
        assert_eq!(out.len(), 256);
        assert!(out.iter().all(|s| *s == 0.0));
        assert_eq!(core.frame(), 128);
    }
}
