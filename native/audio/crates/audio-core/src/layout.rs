//! The deterministic memory layout of the core's fixed regions (architecture §5.1).
//!
//! `myco_audio_init` takes one block of linear memory and carves every fixed region out of it at
//! the offsets computed here. The offsets are a pure function of [`InitParams`], and the regions are
//! laid out in [`REGION_ORDER`], so a fresh instance given the same parameters and the same initial
//! memory lands every region on the same address. Post-M1 soft recovery (adopting a dead instance's
//! arena, architecture §7) depends on that, which is why the order is fixed and append-only.
//!
//! Rules for later tasks:
//! - A region's size changes only here, through its per-element constant.
//! - A new region is added to [`RegionKind`] and to [`REGION_ORDER`] before `Arena`; never reorder.
//! - Nothing in `init` allocates from the global allocator; every fixed buffer comes from a region.
//! - The arena is last and starts on a 64 KiB page, so it grows by whole pages (A1.3b).

use crate::params::InitParams;
use crate::{OUTPUT_CHANNELS, QUANTUM};

/// Every region starts on a 64-byte boundary (a cache line, and enough for any SIMD type).
pub const REGION_ALIGN: usize = 64;
/// WebAssembly's page size; the arena starts on a page and the block is a whole number of pages.
pub const PAGE_BYTES: usize = 65_536;

/// Core scalars and per-quantum scratch (architecture §5.1: "core state, 64 KB").
pub const CORE_STATE_BYTES: usize = 64 * 1024;
/// Scheduled records waiting for their frame (architecture §5.1: 8,192 pending × 48 B).
pub const PENDING_CAPACITY: usize = 8_192;
pub const PENDING_RECORD_BYTES: usize = 48;
/// One logical voice slot (architecture §5.1 estimate: 192 B). A1.2 sizes its slot type to fit.
pub const VOICE_SLOT_BYTES: usize = 192;
/// One entry of the mixed list (a voice slot index).
pub const MIXED_ENTRY_BYTES: usize = 4;
/// One bus: gains, ramps, effect slots, its one compressor and its stereo quantum buffer
/// (architecture §5.1 budgets 3 KB; about 4 KB since the compressor port, see the test below).
/// A2.1: the size of `bus::BusSlot`, rounded to a region alignment, so the effect state types
/// A2.2a fills (`audio_dsp::biquad`, `audio_dsp::compressor`) size it without editing here.
pub const BUS_BYTES: usize = align_up(core::mem::size_of::<crate::bus::BusSlot>(), REGION_ALIGN);
/// The clip directory: 4,096 entries × 32 B plus 32 size-class list heads (architecture §5.1).
/// A1.3b: the list-head bytes are unused. The arena has 80 classes and keeps its heads in the
/// `Arena` struct (`arena.rs`); the bytes stay in the layout so addresses don't move.
pub const CLIP_DIRECTORY_ENTRIES: usize = 4_096;
pub const CLIP_DIRECTORY_ENTRY_BYTES: usize = 32;
pub const CLIP_CLASS_LISTS: usize = 32;
pub const CLIP_CLASS_LIST_HEAD_BYTES: usize = 8;

/// The fixed regions, in the order they are laid out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RegionKind {
    /// The planar stereo output `process` returns: `[L; 128][R; 128]` as f32.
    Output,
    /// Core scalars and scratch.
    CoreState,
    /// The scheduler's pending records.
    Pending,
    /// Logical voice slots.
    Voices,
    /// The mixed list.
    Mixed,
    /// The bus tree.
    Buses,
    /// The shared convolver reverb's spectra and delay lines (`audio_dsp::convolver::region_bytes`;
    /// empty until A2.2b).
    Reverb,
    /// HRTF voice slots (H1; empty until then).
    Hrtf,
    /// Stream rings (B3, M1b; `stream::region_bytes`).
    Streams,
    /// The clip directory and the arena's size-class list heads.
    ClipDirectory,
    /// Parameters, curves, voice and bus automation and loop regions (ADR 0158 E2;
    /// `automation::region_bytes`).
    Automation,
    /// The clip arena's initial reserve. Always last.
    Arena,
}

/// The layout order. Append-only before `Arena` (see the module comment).
pub const REGION_ORDER: [RegionKind; 12] = [
    RegionKind::Output,
    RegionKind::CoreState,
    RegionKind::Pending,
    RegionKind::Voices,
    RegionKind::Mixed,
    RegionKind::Buses,
    RegionKind::Reverb,
    RegionKind::Hrtf,
    RegionKind::Streams,
    RegionKind::ClipDirectory,
    RegionKind::Automation,
    RegionKind::Arena,
];

/// A region's place in the block: `offset` bytes from the block's base, `len` bytes long.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Region {
    pub offset: usize,
    pub len: usize,
}

impl Region {
    pub fn end(&self) -> usize {
        self.offset + self.len
    }
}

/// Where each fixed region goes, and the block's total size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    regions: [Region; REGION_ORDER.len()],
    total: usize,
}

const fn align_up(n: usize, to: usize) -> usize {
    (n + to - 1) / to * to
}

/// A region's size in bytes, from the parameters.
fn region_len(kind: RegionKind, p: &InitParams) -> usize {
    match kind {
        RegionKind::Output => OUTPUT_CHANNELS * QUANTUM * core::mem::size_of::<f32>(),
        RegionKind::CoreState => CORE_STATE_BYTES,
        RegionKind::Pending => PENDING_CAPACITY * PENDING_RECORD_BYTES,
        RegionKind::Voices => p.max_logical as usize * VOICE_SLOT_BYTES,
        RegionKind::Mixed => p.max_mixed as usize * MIXED_ENTRY_BYTES,
        RegionKind::Buses => p.max_buses as usize * BUS_BYTES,
        // A2.2b sizes the shared convolver's state in its own module (K5).
        RegionKind::Reverb => align_up(audio_dsp::convolver::region_bytes(p.sample_rate), REGION_ALIGN),
        RegionKind::Hrtf => 0,
        // B3: the stream rings (`stream.rs`, K5-style: sized in its own module).
        RegionKind::Streams => crate::stream::region_bytes(p),
        RegionKind::ClipDirectory => CLIP_DIRECTORY_ENTRIES * CLIP_DIRECTORY_ENTRY_BYTES + CLIP_CLASS_LISTS * CLIP_CLASS_LIST_HEAD_BYTES,
        // ADR 0158 E2: sized in its own module, like the streams.
        RegionKind::Automation => crate::automation::region_bytes(p),
        RegionKind::Arena => align_up(p.arena_initial_bytes as usize, PAGE_BYTES),
    }
}

impl Layout {
    /// Lays the regions out in [`REGION_ORDER`]. Pure: the same parameters give the same layout.
    pub fn new(p: &InitParams) -> Layout {
        let mut regions = [Region::default(); REGION_ORDER.len()];
        let mut cursor = 0usize;
        for (i, kind) in REGION_ORDER.iter().enumerate() {
            let align = if *kind == RegionKind::Arena { PAGE_BYTES } else { REGION_ALIGN };
            let offset = align_up(cursor, align);
            let len = region_len(*kind, p);
            regions[i] = Region { offset, len };
            cursor = offset + len;
        }
        Layout { regions, total: align_up(cursor, PAGE_BYTES) }
    }

    /// The region for `kind`.
    pub fn region(&self, kind: RegionKind) -> Region {
        let i = REGION_ORDER.iter().position(|k| *k == kind).expect("every kind is in REGION_ORDER");
        self.regions[i]
    }

    /// Every region, in layout order.
    pub fn regions(&self) -> impl Iterator<Item = (RegionKind, Region)> + '_ {
        REGION_ORDER.iter().copied().zip(self.regions.iter().copied())
    }

    /// The block's size in bytes: a whole number of 64 KiB pages.
    pub fn total(&self) -> usize {
        self.total
    }

    /// The block's size in 64 KiB pages.
    pub fn pages(&self) -> usize {
        self.total / PAGE_BYTES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(max_logical: u32, max_mixed: u32, arena_mb: u32) -> InitParams {
        InitParams { sample_rate: 48_000.0, max_logical, max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20 }
    }

    #[test]
    fn the_same_parameters_give_the_same_layout() {
        assert_eq!(Layout::new(&preset(4_096, 128, 16)), Layout::new(&preset(4_096, 128, 16)));
    }

    #[test]
    fn regions_are_aligned_in_order_and_do_not_overlap() {
        for p in [preset(1_024, 64, 8), preset(4_096, 128, 16), preset(4_096, 256, 32), preset(1, 1, 0)] {
            let layout = Layout::new(&p);
            let mut end = 0;
            for (kind, r) in layout.regions() {
                assert_eq!(r.offset % REGION_ALIGN, 0, "{kind:?} is aligned");
                assert!(r.offset >= end, "{kind:?} starts after the previous region");
                end = r.end();
            }
            let arena = layout.region(RegionKind::Arena);
            assert_eq!(arena.offset % PAGE_BYTES, 0, "the arena starts on a page");
            assert_eq!(layout.total() % PAGE_BYTES, 0);
            assert!(layout.total() >= arena.end());
        }
    }

    #[test]
    fn the_default_preset_matches_the_memory_table() {
        // architecture §5.1: core and scheduler ≈ 450 KB, voices 768 KB, directory ≈ 130 KB.
        let layout = Layout::new(&preset(4_096, 128, 16));
        assert_eq!(layout.region(RegionKind::Voices).len, 768 * 1024);
        assert_eq!(layout.region(RegionKind::Arena).len, 16 << 20);
        // The shared reverb (A2.2b): spectra and delay lines of the 1.8 s stereo IR, ≈ 3.0 MB at 48 kHz.
        let reverb = layout.region(RegionKind::Reverb).len;
        assert!(reverb > 2_600_000 && reverb < 3_200_000, "reverb region: {reverb}");
        let fixed = layout.region(RegionKind::Arena).offset - reverb;
        let streams = layout.region(RegionKind::Streams).len;
        assert_eq!(streams, 8 * crate::stream::RING_BYTES, "8 rings at the default preset (architecture §5.3)");
        let automation = layout.region(RegionKind::Automation).len;
        assert!(automation < 2 << 20, "the automation region (ADR 0158 E2): {automation}");
        let fixed = fixed - streams - automation;
        assert!(fixed < 2 << 20, "fixed regions stay under 2 MB before reverb, HRTF, streams and automation: {fixed}");
        eprintln!("default preset: automation {automation} B, total {} B", layout.total());
    }

    #[test]
    fn a_bus_stays_near_the_memory_table() {
        // architecture §5.1 budgets 3 KB per bus. The stereo quantum buffer (1 KB) and the bus's one
        // compressor (2.4 KB, most of it the 6 ms pre-delay line) are most of a bus; the four effect
        // slots hold only a biquad (120 B) or a send (fx.rs). About 4 KB (4,208 B rounded to a cache
        // line) keeps 32 buses near 132 KB; a compressor per slot made it 10,944 B.
        let (slot, fx) = (core::mem::size_of::<crate::bus::BusSlot>(), core::mem::size_of::<crate::fx::FxChain>());
        eprintln!("BusSlot {slot} B, BUS_BYTES {BUS_BYTES} B, FxChain {fx} B, FxSlot {} B", core::mem::size_of::<crate::fx::FxSlot>());
        assert!(BUS_BYTES <= 4 * 1024 + 2 * REGION_ALIGN, "BUS_BYTES: {BUS_BYTES}");
        assert_eq!(Layout::new(&preset(4_096, 128, 16)).region(RegionKind::Buses).len, 32 * BUS_BYTES);
    }
}
