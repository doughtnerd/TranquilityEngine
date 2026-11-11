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
#[ignore = "L-C1a"]
fn music_rings_0_to_16_validate() {
    todo!("L-C1a")
}

/// §4.5: 17, and larger values up to `u32::MAX`, are `InitError::MusicRings`, and only that field
/// is blamed (the rest of the preset is valid).
#[test]
#[ignore = "L-C1a"]
fn music_rings_past_16_are_refused() {
    todo!("L-C1a")
}

/// §3.1, §4.5: `RING_BYTES` is 307,200 B and `stream::region_bytes` is `(G + M) × RING_BYTES` for
/// every preset, rate and `M` in 0..=16 (G = 4 / 8 / 16 on low / default / high).
#[test]
#[ignore = "L-C1a"]
fn region_bytes_is_g_plus_m_rings() {
    todo!("L-C1a")
}

/// §3.1 / architecture §6: the `Streams` region `Layout` lays out per preset at its own music rings:
/// low 12 rings (3,686,400 B), default 20 (6,144,000 B), high 32 (9,830,400 B), at every rate; and
/// with `M` = 0 it is the M3 size (G rings), so no earlier layout moves.
#[test]
#[ignore = "L-C1a"]
fn streams_size_table_per_preset() {
    todo!("L-C1a")
}

/// §3.1: a core built at each preset (48 kHz) has `G` general rings, `M` music rings at indices
/// `G..G + M`, and no wide ring (`max_wide` 0).
#[test]
#[ignore = "L-C1a"]
fn a_core_has_g_general_then_m_music_rings() {
    todo!("L-C1a")
}
