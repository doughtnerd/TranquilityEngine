//! `Core`: the mixer's state over the fixed regions, and the render entry point.

use crate::cap::CapState;
use crate::clips::ClipStore;
use crate::layout::{Layout, RegionKind};
use crate::params::InitParams;
use crate::stream::StreamStore;
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
    /// Empty: the stream store owns the streams region (B3).
    pub streams: &'static mut [u8],
    /// Empty: the clip store owns the directory region (A1.3b).
    pub clip_directory: &'static mut [u8],
    /// Parameters, curves and automation (`automation.rs`, ADR 0158 E2).
    pub automation: &'static mut [u8],
    /// ADR 0162 C8: bed slots and private decoders (`bed.rs`).
    pub beds: &'static mut [u8],
    /// ADR 0162 C8: zone convolver states (`zones.rs`).
    pub zones: &'static mut [u8],
    /// ADR 0162 C8: wide stream rings (B4 gives them to the stream store).
    pub wide: &'static mut [u8],
    /// ADR 0162 C8: the mixed-voice pool (`fxpool.rs`).
    pub fx: &'static mut [u8],
    /// ADR 0162 C8: the 8 KB planar scratch (sources of up to 16 channels).
    pub scratch: &'static mut [u8],
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
    /// The adaptive mixed-voice cap (A3.3, `cap.rs`).
    cap: CapState,
    /// Stream rings (B3, `stream.rs`).
    streams: StreamStore,
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
            automation: bytes(RegionKind::Automation),
            beds: bytes(RegionKind::Beds),
            zones: bytes(RegionKind::Zones),
            wide: bytes(RegionKind::Wide),
            fx: bytes(RegionKind::Fx),
            scratch: bytes(RegionKind::Scratch),
            arena: bytes(RegionKind::Arena),
        };
        // A1.3b: the clip store owns the directory and arena regions (they stay empty here).
        let clips = ClipStore::over(core::mem::take(&mut regions.clip_directory), core::mem::take(&mut regions.arena));
        let cap = CapState::new(params.max_mixed, params.sample_rate);
        // B3: the stream store owns the streams region (it stays empty here).
        let streams = StreamStore::over(core::mem::take(&mut regions.streams));
        let mut core = Core { params, layout, base: base as usize, regions, frame: 0, clips, cap, streams };
        // A2.1: one root bus at unity and MASTER at unity until BUS_CONFIG, BUS_MIX and MASTER.
        crate::bus::init(&mut core);
        // ADR 0158 E2: the automation region's header (its tables are all-zero valid).
        crate::automation::init(&mut core);
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

    /// The regions and the clips at once (A1.2; the render loop now takes `render_parts`).
    #[allow(dead_code)]
    pub(crate) fn parts_mut(&mut self) -> (&mut Regions, &ClipStore) {
        (&mut self.regions, &self.clips)
    }

    /// The stream rings (B3).
    pub fn streams(&self) -> &StreamStore {
        &self.streams
    }

    /// The stream rings, mutably: the `stream_*` exports and `submit` (`onmessage`), and the render loop.
    pub fn streams_mut(&mut self) -> &mut StreamStore {
        &mut self.streams
    }

    /// The regions, the clips and the stream rings at once, for the render loop (B3's stream voices).
    pub(crate) fn render_parts(&mut self) -> (&mut Regions, &ClipStore, &mut StreamStore) {
        (&mut self.regions, &self.clips, &mut self.streams)
    }

    /// The context frame of the last rendered quantum.
    pub fn frame(&self) -> u64 {
        self.frame
    }

    /// The adaptive cap's state (A3.3).
    pub fn cap(&self) -> &CapState {
        &self.cap
    }

    /// The adaptive cap's state, mutably (`cap.rs`; tests set a low work-unit budget through it).
    pub fn cap_mut(&mut self) -> &mut CapState {
        &mut self.cap
    }

    /// Renders one quantum (exactly [`QUANTUM`] frames) starting at context frame `frame` and
    /// returns the planar stereo output, `[L; 128][R; 128]`. Never allocates or grows memory.
    ///
    /// Voices render into their buses' buffers (`voices::render`, A1.2), then the bus tree mixes
    /// down into the output (`bus::mixdown`, A2.1), then the adaptive cap models the quantum's work
    /// units, steps its controller and demotes if it must (`cap::after_render`, A3.3; its demotes
    /// fade from the next quantum).
    pub fn process(&mut self, frame: u64) -> &[f32] {
        self.frame = frame;
        crate::voices::render(self, frame);
        crate::bus::mixdown(self);
        crate::cap::after_render(self, frame);
        &self.regions.output[..OUTPUT_CHANNELS * QUANTUM]
    }

    /// Work units the model gives the last quantum (A3.3, `cap.rs`; 1 WU ≈ 1 ns on the reference
    /// machine).
    pub fn work_units(&self) -> u32 {
        self.cap.work_units()
    }

    /// `myco_audio_note_underruns`: the shell's underrun probe's running total (A3.3).
    pub fn note_underruns(&mut self, total: u32) {
        crate::cap::note_underruns(self, total);
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
        InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 32, max_buses: 8, arena_initial_bytes: 1 << 20, ..InitParams::default() }
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
