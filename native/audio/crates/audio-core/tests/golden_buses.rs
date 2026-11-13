//! Native goldens for the core's buses (ADR 0157, api-and-models §8, §9 row A2.1: "duck and
//! snapshot goldens"), in the style of `golden_native.rs`: real BATCH messages through
//! `scheduler::submit`, quanta from `Core::process`, samples checked against values computed here
//! from the spec (linear ramps over `rampFrames`, gains multiplied down the tree, Blink's
//! equal-power pan for hard left and right).
//!
//! - **Duck:** what the mixer's ducking sends: a bus's runtime-lane gain (`BUS_RAMP`; BUS_MIX before
//!   0171/0172 M5) falls, holds, and recovers while another bus plays on. Sample-exact, and
//!   click-free (no step larger than the ramp's).
//! - **Snapshot:** what a snapshot sends: one batch of `BUS_RAMP`s changing several buses' gains and a low-pass
//!   cut-off at once, plus the root. Sample-exact on the buses without a low-pass; the low-passed
//!   bus is sample-exact while `audio_dsp::biquad` is the A2.1 passthrough stub, and checked at its
//!   settled level (a low-pass passes DC) once A2.2a fills the filter.
//! - MASTER is at 0.25 in both goldens, so the sums (up to 2.0 on a bus) stay under the master
//!   limiter's ceiling (A2.8) and the checks see the bus math alone; the scale is exact in f32.
//! - The levels are expected in core time and checked against the output the master limiter's
//!   fixed latency later (A2.9; `Mixer::expect`).
//! - `process` never allocates with buses, every effect kind, reverb sends and ramps under way.

mod common;

use audio_core::bus;
use audio_core::fx::kind;
use audio_core::QUANTUM;
use common::*;
use std::alloc::{GlobalAlloc, System};
use std::cell::Cell;

const TOL: f32 = 1e-6;
/// A long ramp adds its f32 step once per frame (`Ramp::next`), so its rounding accumulates: about
/// 1e-6 after 1,000 frames.
const LONG_RAMP_TOL: f32 = 1e-5;
/// Equal-power gains for hard left/right are cos(π/2) ≈ 6e-17 and 1; ramps multiply in f32.
const PAN_TOL: f32 = 1e-5;

/// MASTER in both goldens: keeps the output under the limiter's ceiling (see the module comment).
const M: f32 = 0.25;

const MUSIC: u16 = 1;
const SFX: u16 = 2;
const UI: u16 = 3;

/// The largest step between neighbouring samples.
fn max_step(x: &[f32]) -> f32 {
    x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
}

#[test]
fn duck_golden() {
    let mut m = Mixer::new(8);
    // Master (root), Music and SFX under it. Music at 1.0, SFX at 0.5 (its voice's gain).
    m.submit(&[config(&[ROOT, 0, 0]), gains(0, &[1.0, 1.0, 1.0]), master(M, false, 0), dc(0x0001_0001, MUSIC, 0.0)]);
    let Rec::Play(mut sfx) = dc(0x0001_0002, SFX, 0.0) else { unreachable!() };
    sfx.gain = 0.5;
    m.submit(&[Rec::Play(sfx)]);
    let (l, r) = m.render_n(2);
    assert_eq!(l, r);
    m.expect(L, TOL, "before the duck", |_| M * 1.5);

    // Duck Music to 0.25 over 300 frames (not a whole number of quanta), as the mixer sent it
    // (BUS_MIX before 0171/0172 M5; now asap BUS_RAMPs on each bus's runtime lane and snapshot
    // low-pass, bit-identical by R3): every bus's own gain, only Music's changes.
    m.submit(&[gains(300, &[1.0, 0.25, 1.0])]);
    let (duck, duck_r) = m.render_n(4);
    assert_eq!(duck, duck_r);
    m.expect(L, TOL, "ducking", |k| M * (ramp_to(1.0, 0.25, 300, k) + 0.5));
    assert!(max_step(&duck) <= M * 0.75 / 300.0 + TOL, "click-free: the largest step is the ramp's");

    // Hold, then recover to unity over 1,000 frames.
    m.render_n(2);
    m.expect(L, TOL, "held", |_| M * 0.75);
    m.submit(&[gains(1_000, &[1.0, 1.0, 1.0])]);
    let (rec, _) = m.render_n(9);
    m.expect(L, LONG_RAMP_TOL, "recovering", |k| M * (ramp_to(0.25, 1.0, 1_000, k) + 0.5));
    assert!(max_step(&rec) <= M * 0.75 / 1_000.0 + TOL);

    // A duck that is cut short: a new runtime-lane ramp starts from wherever the gain is.
    m.submit(&[gains(256, &[1.0, 0.0, 1.0])]);
    m.render();
    let mid = bus::slots(&m.core)[MUSIC as usize].gain.value;
    assert!((mid - 0.5).abs() < TOL, "half way: {mid}");
    m.submit(&[gains(128, &[1.0, 1.0, 1.0])]);
    m.render();
    m.expect(L, TOL, "reversed mid-ramp", |k| M * (ramp_to(mid, 1.0, 128, k) + 0.5));
}

#[test]
fn snapshot_golden() {
    let mut m = Mixer::new(8);
    // Root, Music, SFX, UI. Music is panned hard left, SFX and UI hard right, so the left channel
    // is Music alone and the right is SFX + UI.
    m.submit(&[config(&[ROOT, 0, 0, 0]), gains(0, &[1.0; 4]), master(M, false, 0), dc(0x0001_0001, MUSIC, -1.0), dc(0x0001_0002, SFX, 1.0), dc(0x0001_0003, UI, 1.0)]);
    m.render();
    m.expect(L, PAN_TOL, "Music before", |_| M * 1.0);
    m.expect(R, PAN_TOL, "SFX + UI before", |_| M * 2.0);

    // One snapshot: the root to 0.8, Music to 0.5 with a 800 Hz low-pass, SFX to 0.25, UI muted;
    // all over 256 frames.
    const N: usize = 256;
    m.submit(&[mix(N as u32, &[(0.8, OFF), (0.5, 800.0), (0.25, OFF), (0.0, OFF)])]);
    m.render_n(3);
    let root = |k| ramp_to(1.0, 0.8, N, k);
    m.expect(R, PAN_TOL, "SFX + UI through the root", |k| M * (ramp_to(1.0, 0.25, N, k) + ramp_to(1.0, 0.0, N, k)) * root(k));
    if audio_dsp::biquad::PASSTHROUGH {
        m.expect(L, PAN_TOL, "Music through the root (passthrough low-pass)", |k| M * ramp_to(1.0, 0.5, N, k) * root(k));
    }
    let s = bus::slots(&m.core);
    assert_eq!(s[MUSIC as usize].lp.value, 800.0, "the cut-off reached its target");
    assert_eq!([s[0].gain.value, s[1].gain.value, s[2].gain.value, s[3].gain.value], [0.8, 0.5, 0.25, 0.0]);

    // Settled: 100 ms later every level is its product (a low-pass passes DC unchanged).
    m.render_n(37);
    m.render();
    m.expect(R, PAN_TOL, "SFX + UI settled", |_| M * 0.25 * 0.8);
    let lp_tol = if audio_dsp::biquad::PASSTHROUGH { PAN_TOL } else { 1e-3 };
    m.expect(L, lp_tol, "Music settled", |_| M * 0.5 * 0.8);

    // The snapshot ends: back to unity with the low-pass off, at once.
    m.submit(&[mix(0, &[(1.0, OFF); 4])]);
    m.render();
    m.expect(R, PAN_TOL, "SFX + UI restored", |_| M * 2.0);
    assert_eq!(bus::slots(&m.core)[MUSIC as usize].lp.value, OFF);
}

// The allocation counter (as in `golden_native.rs`): every allocation on this thread bumps it.
thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

fn allocations() -> u64 {
    ALLOCATIONS.with(Cell::get)
}

struct CountingAlloc;

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: std::alloc::Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|c| c.set(c.get() + 1));
        System.realloc(ptr, layout, new_size)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

#[test]
fn process_never_allocates_with_buses_and_effects() {
    let mut m = Mixer::new(32);
    // A deep tree with every effect kind, reverb sends, ramps of gains, cut-offs and MASTER under
    // way, and voices on every bus (one on an unconfigured index).
    let mut buses = vec![(ROOT, vec![(kind::COMPRESSOR, -24.0, 30.0)])];
    for b in 1..32u16 {
        let fx = match b % 4 {
            0 => vec![(kind::LOWPASS, 900.0, 1.0)],
            1 => vec![(kind::HIGHPASS, 100.0, 0.0), (kind::REVERB_SEND, 0.3, 0.0)],
            2 => vec![(kind::COMPRESSOR, -12.0, 6.0), (kind::LOWPASS, 2_000.0, 3.0)],
            _ => vec![],
        };
        buses.push((b - 1, fx));
    }
    let mixes: Vec<(f32, f32)> = (0..32).map(|b| (0.5 + b as f32 / 64.0, if b % 2 == 0 { 600.0 } else { OFF })).collect();
    let mut recs = vec![config_fx(&buses), mix(500, &mixes), master(0.7, false, 300)];
    for b in 0..33u16 {
        recs.push(dc(0x0001_0000 | (b as u32 + 1), b, if b % 2 == 0 { -0.5 } else { 0.0 }));
    }
    m.submit(&recs);

    let before = allocations();
    let mut sink = 0.0f32;
    for q in 0..20u64 {
        let out = m.core.process(q * QUANTUM as u64);
        sink += out.iter().sum::<f32>();
    }
    assert_eq!(allocations(), before, "process allocated");
    assert!(sink.is_finite() && sink != 0.0);
    assert!(bus::area(&m.core).limited > 0, "the master limiter ran (33 DC voices go over the ceiling)");
}
