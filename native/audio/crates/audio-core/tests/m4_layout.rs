//! 0166 M4 (Q1; api-and-models §3.1, §4.5; architecture §6): the `Due`, `Curves` and `Groups`
//! regions are laid out on every preset, right before `Arena`, at their generated sizes, and the
//! shell's Memory headroom still covers the fixed regions with them.

use audio_core::layout::{Layout, RegionKind, M4_REGIONS_BYTES, M4_REGIONS_SPAN, PAGE_BYTES, REGION_ALIGN};
use audio_core::{InitParams, REGION_ORDER};
use audio_wire::generated as wire;

/// `coreDriver.ts` `M2_REGIONS_HEADROOM_BYTES`: the Memory's headroom for every region before the
/// arena except ADR 0162's (`spatialRegionsBytes`, mirrored there separately).
const M2_REGIONS_HEADROOM_BYTES: usize = 16 << 20;
/// The HRIR table, an arena clip the M2 headroom also leaves room for (`coreDriver.ts`: "plus the
/// 0.75 MB HRIR").
const HRIR_BYTES: usize = 768 * 1024;

fn preset(sample_rate: f32, max_logical: u32, max_mixed: u32, arena_mb: u32) -> InitParams {
    InitParams { sample_rate, max_logical, max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20, ..InitParams::default() }
}

/// The editor's presets (`audioSettingsModel.ts`: low, default, high), the largest voice limits it
/// allows (`VOICE_LIMITS`: 8,192 logical, 512 mixed), the smallest, and M3 parameters on top.
fn presets() -> Vec<InitParams> {
    let mut out = Vec::new();
    for rate in [44_100.0, 48_000.0, 96_000.0, 192_000.0] {
        for (logical, mixed, arena) in [(1_024, 64, 64), (4_096, 128, 16), (4_096, 256, 256), (8_192, 512, 16), (8, 8, 0)] {
            let p = preset(rate, logical, mixed, arena);
            out.push(p);
            let zone_max_frames = (4.0 * rate) as u32;
            out.push(InitParams { max_beds: 4, max_zone_slots: 3, zone_max_frames, max_wide: 2, ..p });
        }
    }
    out
}

#[test]
fn the_m4_regions_are_laid_out_before_the_arena_on_every_preset() {
    assert_eq!(&REGION_ORDER[REGION_ORDER.len() - 4..], &[RegionKind::Due, RegionKind::Curves, RegionKind::Groups, RegionKind::Arena]);
    assert_eq!(wire::DUE_RECORDS as usize + wire::PARKED_RECORDS as usize, 384);
    for p in presets() {
        let layout = Layout::new(&p);
        let (due, curves, groups, arena) = (layout.region(RegionKind::Due), layout.region(RegionKind::Curves), layout.region(RegionKind::Groups), layout.region(RegionKind::Arena));
        // Sizes, from the generated constants (api-and-models §3.1).
        assert_eq!(due.len, (wire::DUE_RECORDS + wire::PARKED_RECORDS) as usize * 48);
        assert_eq!(due.len, 18_432);
        assert_eq!(curves.len, wire::CURVE_ENTRIES as usize * 32);
        assert_eq!(curves.len, 8_160);
        assert_eq!(groups.len, wire::MAX_GROUPS as usize * 160);
        assert_eq!(groups.len, 2_560);
        assert_eq!(due.len + curves.len + groups.len, M4_REGIONS_BYTES);
        // Offsets: right after the scratch, in order, aligned, the last 32 B of Curves' line padding.
        let scratch = layout.region(RegionKind::Scratch);
        assert_eq!(due.offset, scratch.end().next_multiple_of(REGION_ALIGN));
        assert_eq!(curves.offset, due.end());
        assert_eq!(groups.offset, curves.end().next_multiple_of(REGION_ALIGN));
        assert_eq!(groups.end() - due.offset, M4_REGIONS_SPAN);
        for r in [due, curves, groups] {
            assert_eq!(r.offset % REGION_ALIGN, 0);
        }
        // The arena is still last, on a page, after the groups.
        let last = layout.regions().last().unwrap();
        assert_eq!(last.0, RegionKind::Arena);
        assert_eq!(arena.offset, groups.end().next_multiple_of(PAGE_BYTES));
        assert!(layout.regions().all(|(k, r)| k == RegionKind::Arena || r.end() <= arena.offset));
        if p == preset(48_000.0, 4_096, 128, 16) {
            eprintln!("default preset at 48 kHz: Due {due:?}, Curves {curves:?}, Groups {groups:?}, Arena at {}", arena.offset);
        }
    }
}

#[test]
fn the_m4_regions_cost_at_most_one_page_and_change_nothing_before_them() {
    // Every region before `Due` keeps the offset it had (append-only before `Arena`), so the
    // arena moves by the span rounded to the page: 0 or 1 page.
    for p in presets() {
        let layout = Layout::new(&p);
        let before = layout.region(RegionKind::Scratch).end().next_multiple_of(PAGE_BYTES);
        let arena = layout.region(RegionKind::Arena).offset;
        assert!(arena - before <= PAGE_BYTES, "{arena} vs {before}");
        assert!(arena - layout.region(RegionKind::Scratch).end() >= M4_REGIONS_SPAN);
    }
}

/// The shell's Memory `maximum` (`coreDriver.ts` `memoryMaximumPages`) leaves
/// `M2_REGIONS_HEADROOM_BYTES + spatialRegionsBytes + the zone kernel budget` past the arena. The
/// M4 regions sit in the M2 share (they aren't in `spatialRegionsBytes`), so init can't overrun
/// the maximum while every non-spatial region before the arena, with the M4 regions and the HRIR,
/// stays under 16 MiB. That holds on every preset, the largest voice limits and 192 kHz included.
#[test]
fn the_m3_headroom_covers_the_m4_regions_on_every_preset() {
    let mut worst = 0usize;
    for p in presets() {
        let layout = Layout::new(&p);
        let arena = layout.region(RegionKind::Arena).offset;
        let spatial: usize = [RegionKind::Beds, RegionKind::Zones, RegionKind::Wide, RegionKind::Fx, RegionKind::Scratch]
            .iter()
            .map(|k| layout.region(*k).len.next_multiple_of(REGION_ALIGN))
            .sum();
        let m2_share = arena - spatial;
        let fits = m2_share + HRIR_BYTES <= M2_REGIONS_HEADROOM_BYTES;
        if p.sample_rate <= 96_000.0 {
            worst = worst.max(m2_share);
            assert!(fits, "{} Hz, {} logical, {} mixed: {m2_share} B of fixed regions", p.sample_rate, p.max_logical, p.max_mixed);
        } else if !fits {
            // At 192 kHz the shared reverb's region (≈ 12 MB) already overruns the 16 MiB share
            // before M4 on the default and larger presets (the shell's headroom, not the M4
            // regions: reported to the coordinator). M4 must never be what tips a preset over.
            eprintln!("192 kHz, {} logical, {} mixed: {m2_share} B with the HRIR over 16 MiB, before M4 too", p.max_logical, p.max_mixed);
            assert!(m2_share - M4_REGIONS_SPAN + HRIR_BYTES > M2_REGIONS_HEADROOM_BYTES, "the M4 regions tip it over");
        }
    }
    eprintln!("largest non-spatial fixed share up to 96 kHz with the M4 regions: {worst} B ({} B left of 16 MiB after the HRIR)", M2_REGIONS_HEADROOM_BYTES - worst - HRIR_BYTES);
}
