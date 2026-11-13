//! 0171/0172 M5 Cp1 (architecture §4.3, R18; api-and-models §4.3 `wu*`): the core's cumulative
//! work-unit totals. Each quantum adds its modelled work units, split by section, to the f64 totals
//! in `Counters::mix`; they sum the per-quantum values exactly, never go down, survive every take
//! (STATUS carries them at 192..231) and start at 0 with a fresh core.

mod common;

use audio_core::cap::{wu, WorkSections};
use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{status, Core};
use audio_wire::generated as wire;
use common::*;

fn core_with(max_mixed: u32) -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed, max_buses: 2, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: a fresh zeroed block of `layout.total()` bytes, page-aligned.
    unsafe { Core::new(p, layout, base) }
}

fn id(k: u32) -> u32 {
    (1 << 16) | k
}

fn voices(n: u32) -> Vec<Rec> {
    (1..=n)
        .map(|k| {
            let Rec::Play(mut p) = dc(id(k), ROOT, 0.0) else { unreachable!() };
            p.gain = 1.0 / 64.0;
            p.score = k as f32;
            Rec::Play(p)
        })
        .collect()
}

/// The four core-owned totals plus `wuLoudness`, as the counters hold them.
fn totals(core: &Core) -> [f64; 5] {
    let x = &status::counters(core).mix;
    [x.wu_voices, x.wu_buses, x.wu_spatial, x.wu_music, x.wu_loudness]
}

fn add(sum: &mut [f64; 5], s: WorkSections) {
    sum[0] += s.voices as f64;
    sum[1] += s.buses as f64;
    sum[2] += s.spatial as f64;
    sum[3] += s.music as f64;
}

/// Renders a quantum as the shell does (`after_quantum`, then a take every 6th, which ends the block).
fn quantum(m: &mut Mixer, q: usize, out: &mut [u8]) {
    m.render();
    status::after_quantum(&mut m.core);
    if q % 6 == 5 {
        assert!(status::take(&mut m.core, out, 0) > 0);
    }
}

#[test]
fn the_totals_sum_the_per_quantum_sections_and_never_go_down() {
    let mut m = Mixer::over(core_with(16));
    assert_eq!(totals(&m.core), [0.0; 5], "a fresh core starts at 0");
    let mut out = vec![0u8; 32 * 1024];
    let mut sum = [0.0f64; 5];
    let mut last = [0.0f64; 5];
    let mut q = 0usize;
    let mut step = |m: &mut Mixer, q: &mut usize, sum: &mut [f64; 5], last: &mut [f64; 5]| {
        quantum(m, *q, &mut out);
        *q += 1;
        let s = m.core.cap().work_sections();
        // The cap's own total is the voices, buses and HRTF parts; the beds' and zones' work is extra.
        let c = status::counters(&m.core);
        let hrtf = s.spatial - c.spatial.work_bed as u64 - c.spatial.work_zones as u64;
        assert_eq!(s.voices + s.buses + hrtf, m.core.work_units() as u64, "the split is the cap's model");
        add(sum, s);
        let now = totals(&m.core);
        assert_eq!(now, *sum, "the totals are the sum of the per-quantum sections (quantum {q})");
        for i in 0..5 {
            assert!(now[i] >= last[i], "section {i} never goes down");
        }
        *last = now;
    };
    // Idle: buses and the limiter only.
    for _ in 0..12 {
        step(&mut m, &mut q, &mut sum, &mut last);
    }
    assert_eq!(m.core.cap().work_sections(), WorkSections { voices: 0, buses: (wu::BUS + wu::LIMITER) as u64, spatial: 0, music: 0 });
    // Ten mixed voices; their PLAY records count once, in voices.
    m.submit(&voices(10));
    step(&mut m, &mut q, &mut sum, &mut last);
    let voice = (wu::MIXED_VOICE + wu::SOURCE_QUANTUM) as u64;
    assert_eq!(m.core.cap().work_sections().voices, 10 * voice + 10 * wu::RECORD as u64);
    for _ in 0..40 {
        step(&mut m, &mut q, &mut sum, &mut last);
    }
    assert_eq!(m.core.cap().work_sections().voices, 10 * voice);
    // A second bus with a lowpass and a compressor goes into buses (its record into voices).
    m.submit(&[config_fx(&[(ROOT, vec![]), (0, vec![(wire::effect_type::LOWPASS, 1_000.0, 0.0), (wire::effect_type::COMPRESSOR, -24.0, 30.0)])])]);
    for _ in 0..40 {
        step(&mut m, &mut q, &mut sum, &mut last);
    }
    let s = m.core.cap().work_sections();
    assert_eq!(s.buses, (2 * wu::BUS + wu::BIQUAD + wu::COMPRESSOR + wu::LIMITER) as u64);
    assert_eq!((s.spatial, s.music), (0, 0), "no HRTF, beds, zones or music here");
    let t = totals(&m.core);
    assert!(t[0] > 0.0 && t[1] > 0.0);
    assert_eq!(t[4], 0.0, "wuLoudness is loudness.rs's (Ld2): nothing here writes it");
}

#[test]
fn a_take_carries_the_totals_and_keeps_them() {
    let mut m = Mixer::over(core_with(16));
    m.submit(&voices(4));
    let mut out = vec![0u8; 32 * 1024];
    for q in 0..30 {
        quantum(&mut m, q, &mut out);
    }
    let before = totals(&m.core);
    let n = status::take(&mut m.core, &mut out, 0);
    assert!(n > 0);
    let at = |off: usize| f64::from_le_bytes(out[off..off + 8].try_into().unwrap());
    assert_eq!([at(192), at(200), at(208), at(216), at(224)], before, "STATUS 192..231");
    assert_eq!(totals(&m.core), before, "the take (and its end_block) resets nothing");
    // The shell's fields are the shell's: the core sends 0 for them, and `loadPermille` stays 0.
    assert_eq!((at(176), at(184)), (0.0, 0.0));
    assert_eq!(u16::from_le_bytes([out[80], out[81]]), 0, "loadPermille");
    // A fresh core (a driver restart) starts again at 0.
    let fresh = core_with(16);
    assert_eq!(totals(&fresh), [0.0; 5]);
}
