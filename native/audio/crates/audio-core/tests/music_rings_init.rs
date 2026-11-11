//! 0166 M4, C1 (api-and-models §3.1, §4.5; architecture §4.2, §6): `max_music_rings` is validated
//! to 0..16 (`InitError::MusicRings` past it) and sizes the `Streams` region to `(G + M) ×
//! RING_BYTES`: the `G = max_mixed / 16` general rings (4..16), then the `M` music rings.
//!
//! Leaf L-C1a fills these cases. The presets are the editor's (`audioSettingsModel.ts`): low
//! (1,024 logical, 64 mixed, 64 MB arena, 8 music rings), default (4,096, 128, 16 MB, 12) and high
//! (4,096, 256, 256 MB, 16).

#![allow(unused_imports, dead_code)]

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::stream::{self, RING_BYTES};
use audio_core::{Core, InitError, InitParams, RegionKind};

/// One preset: (name, max_logical, max_mixed, arena MB, music rings).
const PRESETS: [(&str, u32, u32, u32, u32); 3] = [("low", 1_024, 64, 64, 8), ("default", 4_096, 128, 16, 12), ("high", 4_096, 256, 256, 16)];

/// The rates the presets run at.
const RATES: [f32; 4] = [44_100.0, 48_000.0, 96_000.0, 192_000.0];

/// A preset's parameters at `rate` with `music_rings` music rings.
fn preset(rate: f32, max_logical: u32, max_mixed: u32, arena_mb: u32, music_rings: u32) -> InitParams {
    InitParams { sample_rate: rate, max_logical, max_mixed, max_buses: 32, arena_initial_bytes: arena_mb << 20, max_music_rings: music_rings, ..InitParams::default() }
}

/// A core over a leaked, zeroed, page-aligned block, as `myco_audio_init` would get it.
fn new_core(p: InitParams) -> Core {
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// §4.5: `max_music_rings` 0..=16 validates on every preset and rate.
#[test]
fn music_rings_0_to_16_validate() {
    for &(name, max_logical, max_mixed, arena_mb, _) in PRESETS.iter() {
        for &rate in RATES.iter() {
            for m in 0..=16u32 {
                let p = preset(rate, max_logical, max_mixed, arena_mb, m);
                assert_eq!(p.validate(), Ok(()), "{name} at {rate} Hz, {m} music rings");
            }
        }
    }
}

/// §4.5: 17, and larger values up to `u32::MAX`, are `InitError::MusicRings`, and only that field
/// is blamed (the rest of the preset is valid).
#[test]
fn music_rings_past_16_are_refused() {
    for &(name, max_logical, max_mixed, arena_mb, _) in PRESETS.iter() {
        for &rate in RATES.iter() {
            // The preset is valid at 16 rings, so 17 and up blame the music-ring count alone.
            assert_eq!(preset(rate, max_logical, max_mixed, arena_mb, 16).validate(), Ok(()), "{name} at {rate} Hz, 16 music rings");
            for m in [17u32, 100, u32::MAX] {
                let p = preset(rate, max_logical, max_mixed, arena_mb, m);
                assert_eq!(p.validate(), Err(InitError::MusicRings), "{name} at {rate} Hz, {m} music rings");
            }
        }
    }
}

/// §3.1, §4.5: `RING_BYTES` is 307,200 B and `stream::region_bytes` is `(G + M) × RING_BYTES` for
/// every preset, rate and `M` in 0..=16 (G = 4 / 8 / 16 on low / default / high).
#[test]
fn region_bytes_is_g_plus_m_rings() {
    assert_eq!(RING_BYTES, 307_200);
    // G = max_mixed / 16 clamped to 4..=16: 4 on low, 8 on default, 16 on high.
    let general = [4usize, 8, 16];
    for (i, &(name, max_logical, max_mixed, arena_mb, _)) in PRESETS.iter().enumerate() {
        for &rate in RATES.iter() {
            for m in 0..=16u32 {
                let p = preset(rate, max_logical, max_mixed, arena_mb, m);
                let g = stream::stream_count(&p);
                assert_eq!(g, general[i], "{name} general rings");
                let expected = (general[i] + m as usize) * RING_BYTES;
                assert_eq!(stream::region_bytes(&p), expected, "{name} at {rate} Hz, M {m}");
                assert_eq!(Layout::new(&p).region(RegionKind::Streams).len, expected, "{name} Streams region at {rate} Hz, M {m}");
            }
        }
    }
}

/// §3.1 / architecture §6: the `Streams` region `Layout` lays out per preset at its own music rings:
/// low 12 rings (3,686,400 B), default 20 (6,144,000 B), high 32 (9,830,400 B), at every rate; and
/// with `M` = 0 it is the M3 size (G rings), so no earlier layout moves.
#[test]
fn streams_size_table_per_preset() {
    // At each preset's own M (low 8, default 12, high 16): 12, 20 and 32 rings.
    let at_own_m = [3_686_400usize, 6_144_000, 9_830_400];
    // At M = 0: G rings (4, 8, 16), the M3 size.
    let at_zero_m = [1_228_800usize, 2_457_600, 4_915_200];
    for (i, &(name, max_logical, max_mixed, arena_mb, music)) in PRESETS.iter().enumerate() {
        for &rate in RATES.iter() {
            let p = preset(rate, max_logical, max_mixed, arena_mb, music);
            assert_eq!(Layout::new(&p).region(RegionKind::Streams).len, at_own_m[i], "{name} at {rate} Hz");
            let p0 = preset(rate, max_logical, max_mixed, arena_mb, 0);
            assert_eq!(Layout::new(&p0).region(RegionKind::Streams).len, at_zero_m[i], "{name} at {rate} Hz, M 0");
        }
    }
}

/// §3.1: a core built at each preset (48 kHz) has `G` general rings, `M` music rings at indices
/// `G..G + M`, and no wide ring (`max_wide` 0).
#[test]
fn a_core_has_g_general_then_m_music_rings() {
    let general = [4usize, 8, 16];
    for (i, &(name, max_logical, max_mixed, _, music)) in PRESETS.iter().enumerate() {
        // No arena: this case builds the core only, so it needn't allocate the preset's 16 or 256 MB.
        let p = preset(48_000.0, max_logical, max_mixed, 0, music);
        let core = new_core(p);
        let s = core.streams();
        let (g, m) = (general[i], music as usize);
        assert_eq!(s.general_count(), g, "{name} general rings");
        assert_eq!(s.music_count(), m, "{name} music rings");
        assert_eq!(s.narrow_count(), g + m, "{name} narrow rings");
        assert_eq!(s.capacity(), g + m, "{name} rings (no wide ring)");
        for ring in 0..s.capacity() {
            assert_eq!(s.is_music(ring), (g..g + m).contains(&ring), "{name} ring {ring}");
        }
        assert!(!s.is_music(g + m), "{name}: no ring past the music pool");
    }
}
