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

/// Core scalars and per-quantum scratch (architecture §5.1: "core state, 64 KB"; 128 KB from ABI 5.0,
/// whose 16-parameter effect records more than doubled the stamped configuration queue, ADR 0352).
pub const CORE_STATE_BYTES: usize = 128 * 1024;
/// Scheduled records waiting for their frame (architecture §5.1: 8,192 pending × 48 B).
pub const PENDING_CAPACITY: usize = 8_192;
pub const PENDING_RECORD_BYTES: usize = 48;
/// One logical voice slot (architecture §5.1 estimate: 192 B; 200 since the slot keeps a cell for a
/// taken-over voice's report, ADR 0386). A1.2 sizes its slot type to fit.
pub const VOICE_SLOT_BYTES: usize = 200;
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
/// ADR 0162 C8: the shared planar scratch a source of up to 16 channels reads into (16 × 128 × f32).
pub const PLANAR_SCRATCH_BYTES: usize = 16 * QUANTUM * core::mem::size_of::<f32>();

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
    /// ADR 0162 C8: bed slots and private decoders (`bed::region_bytes`; 0 without beds).
    Beds,
    /// ADR 0162 C8: zone convolver states (`zones::region_bytes`; 0 without zone slots).
    Zones,
    /// ADR 0162 C8: wide stream rings (`stream::wide_region_bytes`; 0 without wide rings).
    Wide,
    /// ADR 0162 C8: the mixed-voice pool (`fxpool::region_bytes`, from `max_mixed`).
    Fx,
    /// ADR 0162 C8: the 8 KB planar scratch for sources of up to 16 channels.
    Scratch,
    /// 0166 M4-0: the due list and the parked records (`due::REGION_BYTES`: `(DUE_RECORDS +
    /// PARKED_RECORDS) × 48` = 18,432 B on every preset).
    Due,
    /// 0166 M4-0: the curve pool (`curves::REGION_BYTES`: `CURVE_ENTRIES × 32` = 8,160 B).
    Curves,
    /// 0166 M4a: the group table (`groups::REGION_BYTES`: `MAX_GROUPS × 160` = 2,560 B).
    Groups,
    /// 0171/0172 M5 (K1): the gain lanes, one `lanes::BusLanes` per bus slot plus the output's
    /// (`lanes::region_bytes`: `(max_buses + 1) × 128` = 4,224 B at 32 buses).
    Lanes,
    /// 0171/0172 M5 (K1): the duck rules, followers and detectors (`duck::REGION_BYTES`, ≈ 1.4 KB
    /// on every preset).
    Duck,
    /// 0171/0172 M5 (K1): the loudness meters (`loudness::REGION_BYTES`: 64 + 9 × (1,512 + 128) =
    /// 14,824 B on every preset).
    Loudness,
    /// 0171/0172 M5 (K1): the shared bus send scratch and the reverb run-out
    /// (`sends::REGION_BYTES`: 1,024 + 64 = 1,088 B on every preset).
    Sends,
    /// ADR 0345 (ABI 4.5): the instance submix slots (`submix::REGION_BYTES`, ≈ 320 KB on every
    /// preset).
    Submixes,
    /// ADR 0345 (ABI 4.6): the effect memory of bus chains and submixes (`fxmem::region_bytes`:
    /// `FX_MEMORY_SECONDS` of stereo audio at the rate, 7.7 MB at 48 kHz).
    FxMem,
    /// ADR 0351 A4 (ABI 4.12): the ADPCM voice cursors, one per mixed-voice pool entry
    /// (`adpcm_voice::region_bytes`: `max_mixed` × `CURSOR_BYTES`).
    AdpcmCursors,
    /// ADR 0360 (ABI 5.1): the generator voices' slot records and pool (`generator::region_bytes`: max(16,
    /// `max_mixed` / 4) entries of `generator::ENTRY_BYTES` and 8 B per voice slot).
    GenEntries,
    /// The clip arena's initial reserve. Always last.
    Arena,
}

/// The layout order. Append-only before `Arena` (see the module comment).
pub const REGION_ORDER: [RegionKind; 28] = [
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
    RegionKind::Beds,
    RegionKind::Zones,
    RegionKind::Wide,
    RegionKind::Fx,
    RegionKind::Scratch,
    RegionKind::Due,
    RegionKind::Curves,
    RegionKind::Groups,
    RegionKind::Lanes,
    RegionKind::Duck,
    RegionKind::Loudness,
    RegionKind::Sends,
    RegionKind::Submixes,
    RegionKind::FxMem,
    RegionKind::AdpcmCursors,
    RegionKind::GenEntries,
    RegionKind::Arena,
];

/// 0166 M4 (api-and-models §3.1, architecture §6): the bytes `Due`, `Curves` and `Groups` add on
/// every preset, 18,432 + 8,160 + 2,560. `Curves` (8,160 B) isn't a multiple of `REGION_ALIGN`, so
/// `Groups` starts 32 B after its end: the three span [`M4_REGIONS_SPAN`] = 29,184 B.
pub const M4_REGIONS_BYTES: usize = crate::due::REGION_BYTES + crate::curves::REGION_BYTES + crate::groups::REGION_BYTES;
/// The bytes from `Due`'s start to `Groups`' end, alignment included (`Due` starts aligned).
pub const M4_REGIONS_SPAN: usize = align_up(align_up(crate::due::REGION_BYTES, REGION_ALIGN) + crate::curves::REGION_BYTES, REGION_ALIGN) + crate::groups::REGION_BYTES;

const _: () = assert!(M4_REGIONS_BYTES == 29_152, "api-and-models §3.1");

/// 0171/0172 M5 (architecture §6; K1 stage B): the bytes `Lanes`, `Duck`, `Loudness` and `Sends`
/// add at `max_buses` buses: loudness 14.8 KB, lanes, duck state and the send scratch ≈ 6.7 KB at
/// 32 buses (ARCH §6 estimated ≈ 9 KB).
pub fn m5_regions_bytes(max_buses: u32) -> usize {
    let p = InitParams { max_buses, ..InitParams::default() };
    crate::lanes::region_bytes(&p) + crate::duck::REGION_BYTES + crate::loudness::REGION_BYTES + crate::sends::REGION_BYTES
}
const _: () = assert!(M4_REGIONS_SPAN == 29_184);

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
        // ADR 0162 C8: each sized in its feature's module, so A4, C3, B4 and D1 never edit this file.
        RegionKind::Beds => crate::bed::region_bytes(p),
        RegionKind::Zones => crate::zones::region_bytes(p),
        RegionKind::Wide => crate::stream::wide_region_bytes(p),
        RegionKind::Fx => crate::fxpool::region_bytes(p),
        RegionKind::Scratch => PLANAR_SCRATCH_BYTES,
        // 0166 M4: always laid out, sized in their modules from the generated constants (Q1).
        RegionKind::Due => crate::due::REGION_BYTES,
        RegionKind::Curves => crate::curves::REGION_BYTES,
        RegionKind::Groups => crate::groups::REGION_BYTES,
        // 0171/0172 M5 (K1): sized in their modules, so B1a, B3, Dp1, Sc1, Ld2 and Rv1 never edit this file.
        RegionKind::Lanes => crate::lanes::region_bytes(p),
        RegionKind::Duck => crate::duck::REGION_BYTES,
        RegionKind::Loudness => crate::loudness::REGION_BYTES,
        RegionKind::Sends => crate::sends::REGION_BYTES,
        RegionKind::Submixes => crate::submix::REGION_BYTES,
        RegionKind::FxMem => crate::fxmem::region_bytes(p),
        RegionKind::AdpcmCursors => crate::adpcm_voice::region_bytes(p),
        RegionKind::GenEntries => crate::generator::region_bytes(p),
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

// --- The Memory the core needs (ADR 0327) ------------------------------------------------------

/// ADR 0327: the arena past its initial reserve, to hold `clip_ceiling_bytes` of clips (`audio.clipMemoryMB`, which main
/// counts in raw bytes) in their size classes. A class wastes under 25% of a request of 4 KB or more and a smaller one
/// takes 4 KB, so the clips take at most `5/4 x ceiling + CLIP_DIRECTORY_ENTRIES x 4 KB` (16 MiB): no fragmentation
/// counted (the arena never splits or merges blocks, so a pattern of loads and unloads can still run it out).
pub fn clip_growth_bytes(arena_initial_bytes: usize, clip_ceiling_bytes: usize) -> usize {
    let classes = clip_ceiling_bytes.saturating_add(clip_ceiling_bytes / 4).saturating_add(CLIP_DIRECTORY_ENTRIES * crate::arena::size_class::MIN_CLASS_BYTES);
    classes.saturating_sub(arena_initial_bytes)
}

/// ADR 0327: the arena blocks of the spatial data main sends outside `clipMemoryMB` (api-and-models §5): the largest
/// HRIR table the core accepts (Chromium's grid at `MAX_IR_LENGTH`) and the HRTF bank built with it, at a rate HRTF runs
/// at, and the MagLS filters at their high-rate length when a bed or a wide stream's private decoder is laid out.
pub fn spatial_data_bytes(p: &InitParams) -> usize {
    use audio_dsp::hrtf::database::{HEADER_BYTES, MAX_IR_LENGTH};
    use audio_dsp::hrtf::elevation_index::{NUMBER_OF_RAW_AZIMUTHS, NUMBER_OF_RAW_ELEVATIONS};
    use audio_wire::generated::{BED_CHANNELS, MAGLS_HEADER_BYTES, MAGLS_TAPS_HIGH_RATE};
    let block = crate::zones::arena_block_bytes;
    let hrtf = match crate::panner::HrtfBank::bytes_for(p.sample_rate) {
        Some(bank) => {
            let directions = NUMBER_OF_RAW_AZIMUTHS * NUMBER_OF_RAW_ELEVATIONS;
            block(HEADER_BYTES + directions * 2 * 4 + directions * MAX_IR_LENGTH as usize * 2 * 2) + block(bank)
        }
        None => 0, // the core refuses an HRIR table at this rate (176.4 kHz and up)
    };
    let magls = if p.max_beds + p.max_wide > 0 { block(MAGLS_HEADER_BYTES as usize + BED_CHANNELS as usize * 2 * MAGLS_TAPS_HIGH_RATE as usize * 4) } else { 0 };
    hrtf + magls
}

/// ADR 0327: bytes the core grows its Memory by over its life, past the module's own pages, for these parameters and
/// `clip_ceiling_bytes`: the block `init` takes ([`Layout::total`], the arena's initial reserve included), the arena's
/// growth to the clip ceiling ([`clip_growth_bytes`]), the zone kernel budget (`zones::kernel_budget_bytes`) and the
/// spatial data ([`spatial_data_bytes`]). The shell's Memory `maximum` is its initial pages plus this. Saturates.
pub fn memory_growth_bytes(p: &InitParams, clip_ceiling_bytes: usize) -> usize {
    let layout = Layout::new(p);
    layout
        .total()
        .saturating_add(clip_growth_bytes(layout.region(RegionKind::Arena).len, clip_ceiling_bytes))
        .saturating_add(crate::zones::kernel_budget_bytes(p.max_zone_slots, p.zone_max_frames))
        .saturating_add(spatial_data_bytes(p))
}

/// ADR 0327: one part of what the core takes, for the debug panel's memory row: a wire `MemoryPart` value, `None` for
/// another.
pub fn memory_part_bytes(p: &InitParams, part: u32) -> Option<usize> {
    use audio_wire::generated::memory_part as mp;
    let layout = Layout::new(p);
    Some(match part {
        mp::LAYOUT => layout.total(),
        mp::BEDS => layout.region(RegionKind::Beds).len,
        mp::ZONES => layout.region(RegionKind::Zones).len,
        mp::WIDE => layout.region(RegionKind::Wide).len,
        mp::ZONE_KERNELS => crate::zones::kernel_budget_bytes(p.max_zone_slots, p.zone_max_frames),
        mp::SPATIAL_DATA => spatial_data_bytes(p),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(max_logical: u32, max_mixed: u32, arena_mb: u32) -> InitParams {
        InitParams { sample_rate: 48_000.0, max_logical, max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20, ..InitParams::default() }
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
        // Voices 800 KB since ADR 0386 (a 4 B cell per slot for a taken-over voice's report; 768 KB before).
        assert_eq!(layout.region(RegionKind::Voices).len, 800 * 1024);
        assert_eq!(layout.region(RegionKind::Arena).len, 16 << 20);
        // The shared reverb (A2.2b): spectra and delay lines of the 1.8 s stereo IR, ≈ 3.0 MB at 48 kHz.
        let reverb = layout.region(RegionKind::Reverb).len;
        assert!(reverb > 2_600_000 && reverb < 3_200_000, "reverb region: {reverb}");
        let fixed = layout.region(RegionKind::Arena).offset - reverb;
        let streams = layout.region(RegionKind::Streams).len;
        assert_eq!(streams, 8 * crate::stream::RING_BYTES, "8 rings at the default preset (architecture §5.3)");
        let automation = layout.region(RegionKind::Automation).len;
        // ≈ 2.4 MB since ADR 0346 (64-key curves with Bézier control points: the curve table is ≈ 1.6 MB of it).
        assert!(automation < 3 << 20, "the automation region (ADR 0158 E2, 0346): {automation}");
        // ADR 0345's effect memory (7.7 MB at 48 kHz) and submix slots are their own budget lines.
        let fxmem = layout.region(RegionKind::FxMem).len;
        assert_eq!(fxmem, crate::fxmem::region_bytes(&preset(4_096, 128, 16)));
        let submixes = layout.region(RegionKind::Submixes).len;
        // ADR 0351 A4: the ADPCM voice cursors (a 512-frame stereo window each), ≈ 264 KB at 128 mixed voices.
        let adpcm = layout.region(RegionKind::AdpcmCursors).len;
        assert_eq!(adpcm, 128 * crate::adpcm_voice::CURSOR_BYTES);
        assert!(adpcm < 300 * 1024, "ADPCM cursors: {adpcm}");
        // ADR 0360: the generator pool, 32 entries at 128 mixed voices (≈ 160 KB), and 8 B per voice slot.
        let gen = layout.region(RegionKind::GenEntries).len;
        assert_eq!(gen, crate::generator::region_bytes(&preset(4_096, 128, 16)));
        assert!(gen < 240 * 1024, "generator pool: {gen}");
        let fixed = fixed - streams - automation - fxmem - submixes - adpcm - gen;
        assert!(fixed < 2 << 20, "fixed regions stay under 2 MB before reverb, HRTF, streams, automation, effect memory, submixes, ADPCM cursors and the generator pool: {fixed}");
        eprintln!("default preset: automation {automation} B, total {} B", layout.total());
    }

    #[test]
    fn the_m3_regions_are_zero_without_their_parameters_and_sized_per_c8() {
        let m2 = Layout::new(&preset(4_096, 128, 16));
        for kind in [RegionKind::Beds, RegionKind::Wide] {
            assert_eq!(m2.region(kind).len, 0, "{kind:?}");
        }
        assert_eq!(m2.region(RegionKind::Zones).len, 32 * 1024 + (64 + 32 * 512) + 64, "the aux accumulator and the sends area (32 buses) and the tail, without slots");
        assert_eq!(m2.region(RegionKind::Fx).len, 128 * 560, "70 KB at 128 mixed (ADR 0347 spread; 56 KB before)");
        assert_eq!(m2.region(RegionKind::Scratch).len, 8 * 1024);
        let p = InitParams { max_beds: 2, max_zone_slots: 3, zone_max_frames: 96_000, max_wide: 1, ..preset(4_096, 128, 16) };
        let m3 = Layout::new(&p);
        // A4: 2 beds and 1 private decoder, the decoder's scratch and the shared MagLS filters
        // (`bed::region_bytes`; ≈ 262 KB at 48 kHz, api-and-models §3.1's 208 KB without the
        // header and scratch).
        let beds = m3.region(RegionKind::Beds).len;
        assert_eq!(beds, crate::bed::region_bytes(&p));
        assert!(beds > 3 * 48 * 1024 && beds < 320 * 1024, "2 beds and 1 private decoder: {beds}");
        assert_eq!(m3.region(RegionKind::Zones).len, 3 * crate::zones::slot_state_bytes(96_000) + 32 * 1024 + (64 + 32 * 512) + 64);
        // R16: 32,768-frame wide rings after B4's 300 ms stall test failed at 16,384 (2.22 MiB, §3.1).
        assert_eq!(m3.region(RegionKind::Wide).len, 16 * (32_768 + 2_048 + 1_536) * 4);
        let wide_mib = m3.region(RegionKind::Wide).len as f64 / (1 << 20) as f64;
        assert!((wide_mib - 2.22).abs() < 0.01, "{wide_mib} MiB");
        assert!(m3.region(RegionKind::Arena).offset > m2.region(RegionKind::Arena).offset);
    }

    #[test]
    fn the_m5_regions_follow_the_memory_table() {
        let layout = Layout::new(&preset(4_096, 128, 16));
        assert_eq!(layout.region(RegionKind::Lanes).len, 33 * 128, "32 buses and the output, 128 B each");
        assert_eq!(layout.region(RegionKind::Loudness).len, 14_824, "64 + 9 × (1,512 + 128)");
        assert_eq!(layout.region(RegionKind::Sends).len, 1_088, "the 1 KB scratch and the 64 B header");
        let duck = layout.region(RegionKind::Duck).len;
        assert!(duck < 2 * 1024, "duck rules, followers and detectors: {duck}");
        let m5 = m5_regions_bytes(32);
        eprintln!("M5 regions at 32 buses: {m5} B (lanes 4,224, duck {duck}, loudness 14,824, sends 1,088)");
        assert!(m5 < 24 * 1024, "ARCH §6: ≈ 24 KB: {m5}");
        // Appended before the arena: M4's regions keep their offsets.
        let groups = layout.region(RegionKind::Groups);
        assert!(layout.region(RegionKind::Lanes).offset >= groups.end());
        for (kind, r) in layout.regions() {
            if matches!(kind, RegionKind::Lanes | RegionKind::Duck | RegionKind::Loudness | RegionKind::Sends) {
                assert_eq!(r.offset % REGION_ALIGN, 0, "{kind:?}");
            }
        }
    }

    #[test]
    fn a_bus_stays_near_the_memory_table() {
        // architecture §5.1 budgets 3 KB per bus. The stereo quantum buffer (1 KB) and the bus's one
        // compressor (2.4 KB, most of it the 6 ms pre-delay line) were most of a bus at 4 KB. ADR 0345
        // (ABI 4.6): eight slots, each with a catalogue effect's small state (≈ 600 B: three biquads,
        // smoothed parameters, kernel cursors; delay lines live in the effect memory), make it
        // ≈ 9.5 KB, 32 buses ≈ 305 KB (a compressor per slot inline would have made it 27 KB). ABI 5.0
        // (ADR 0352): 16 parameters a slot (wire and glide) and a plugin slot's handle make it ≈ 10.3 KB.
        let (slot, fx) = (core::mem::size_of::<crate::bus::BusSlot>(), core::mem::size_of::<crate::fx::FxChain>());
        eprintln!("BusSlot {slot} B, BUS_BYTES {BUS_BYTES} B, FxChain {fx} B, FxSlot {} B", core::mem::size_of::<crate::fx::FxSlot>());
        assert!(BUS_BYTES <= 11 * 1024, "BUS_BYTES: {BUS_BYTES}");
        assert_eq!(Layout::new(&preset(4_096, 128, 16)).region(RegionKind::Buses).len, 32 * BUS_BYTES);
    }

    /// ADR 0327 (F-1): at 192 kHz with the voices the settings parser allows (8,192 logical, 512 mixed) and every M3
    /// count at its high preset, the Memory the core asks for covers its block, a full arena and the kernel budget.
    #[test]
    fn the_memory_need_covers_the_largest_preset() {
        let p = InitParams { sample_rate: 192_000.0, max_logical: 8_192, max_mixed: 512, max_buses: 32, arena_initial_bytes: 16 << 20, max_beds: 4, max_zone_slots: 3, zone_max_frames: 768_000, max_wide: 4, max_music_rings: 16 };
        assert_eq!(p.validate(), Ok(()));
        let ceiling = 1024 << 20;
        let layout = Layout::new(&p);
        let need = memory_growth_bytes(&p, ceiling);
        let kernels = crate::zones::kernel_budget_bytes(3, 768_000);
        assert!(need >= layout.total() + (ceiling - layout.region(RegionKind::Arena).len) + kernels, "{need}");
        assert!(need < 4 << 30, "under wasm32's 4 GiB: {need}");
        eprintln!("192 kHz, 8,192 voices: block {} B, need {need} B", layout.total());
    }

    #[test]
    fn the_memory_parts_are_the_layouts_regions() {
        use audio_wire::generated::memory_part as mp;
        let p = InitParams { max_beds: 2, max_zone_slots: 3, zone_max_frames: 96_000, max_wide: 1, ..preset(4_096, 128, 16) };
        let layout = Layout::new(&p);
        assert_eq!(memory_part_bytes(&p, mp::LAYOUT), Some(layout.total()));
        assert_eq!(memory_part_bytes(&p, mp::BEDS), Some(layout.region(RegionKind::Beds).len));
        assert_eq!(memory_part_bytes(&p, mp::ZONES), Some(layout.region(RegionKind::Zones).len));
        assert_eq!(memory_part_bytes(&p, mp::WIDE), Some(layout.region(RegionKind::Wide).len));
        assert_eq!(memory_part_bytes(&p, mp::ZONE_KERNELS), Some(crate::zones::kernel_budget_bytes(3, 96_000)));
        assert_eq!(memory_part_bytes(&p, 99), None);
        // An M2 preset: no kernel budget, no MagLS; the HRIR table and bank are still allowed for.
        let m2 = preset(4_096, 128, 16);
        assert_eq!(memory_part_bytes(&m2, mp::ZONE_KERNELS), Some(0));
        let spatial = memory_part_bytes(&m2, mp::SPATIAL_DATA).unwrap();
        assert!(spatial > 985_040 && spatial < 4 << 20, "{spatial}");
        assert_eq!(spatial_data_bytes(&InitParams { sample_rate: 192_000.0, ..m2 }), 0, "no HRTF at 192 kHz");
    }

    #[test]
    fn clip_growth_allows_for_size_classes_past_the_initial_reserve() {
        assert_eq!(clip_growth_bytes(0, 0), 16 << 20);
        assert_eq!(clip_growth_bytes(0, 128 << 20), (160 << 20) + (16 << 20));
        assert_eq!(clip_growth_bytes(1 << 30, 128 << 20), 0);
    }
}
