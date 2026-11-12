//! 0166 M4-0, class G records in the gain loop (Z2b; api-and-models §3.1 "Fade laws", "Curve pool",
//! §4.2 the `shape` word; architecture §4.4 "Fade laws at control rate"; ADR 0167 §1.1, §2).
//!
//! Z2b's acceptance: a stamped FADE moves only its voice (no split of either kind, every other
//! voice's slot byte-identical to a twin's); unstamped work is bit-identical (the M1–M3 goldens and
//! `in_voice_hooks.rs`' digest). And the laws at control rate: an equal-power crossfade (a PLAY with
//! `fadeZero` and a stamped FADE in with `equalPowerIn`, a stamped FADE out with `equalPowerOut` and
//! `stopAtEnd` at the same frame) follows the same-knot f64 reference within 1e-5 and keeps power
//! within 1e-4 of 1 (R6); a start phase starts at the law's value there.
//!
//! The fade-in takes the apply path (its FADE is at its voice's first sample), the fade-out the
//! gain loop's compare (its voice is already playing), so both entry points are held to the same
//! reference.

#![allow(dead_code)]

mod common;

use audio_core::layout::VOICE_SLOT_BYTES;
use audio_core::{status, voices, Core, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
const K: usize = 50;
const FADE_ZERO: u16 = wire::PLAY_FLAGS_FADE_ZERO;

fn quiet() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m
}

fn play_at(voice: u32, flags: u16, gain: f32, at: u32) -> Rec {
    let Rec::Play(mut p) = play(voice, DC, ROOT, flags) else { unreachable!() };
    p.gain = gain;
    p.frame_offset = at;
    Rec::Play(p)
}

fn fade_at(voice: u32, target: f32, frames: u32, stop: bool, shape: u32, at: u32) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    let flags = if stop { wire::FADE_FLAGS_STOP_AT_END } else { 0 };
    wire::Fade { voice_id: voice, frame_offset: at, target, frames, flags, shape }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn shape(law: u32, u0: f32) -> u32 {
    law | (((u0 * 65_536.0) as u32) << wire::SHAPE_PHASE_SHIFT)
}

fn slot_bytes(core: &Core, voice: u32) -> Vec<u8> {
    let at = (voice & 0xFFFF) as usize * VOICE_SLOT_BYTES;
    core.regions().voices[at..at + VOICE_SLOT_BYTES].to_vec()
}

fn split_counts(m: &Mixer) -> (u32, u32) {
    let music = &status::counters(&m.core).music;
    (music.split_quanta, music.voice_splits)
}

/// Renders `quanta` quanta, returning the left channel.
fn run(m: &mut Mixer, quanta: usize) -> Vec<f32> {
    (0..quanta).flat_map(|_| m.render().0).collect()
}

/// The same-knot reference (R6, `curves.rs` module comment) in f64: the output at absolute frame
/// `t` of a fade from `a` to `b` starting at frame `f` over `n` frames under `law` (phase `u0`).
fn reference(law: impl Fn(f64) -> f64, a: f64, b: f64, f: usize, n: usize, u0: f64, t: usize) -> f64 {
    let val = |x: usize| -> f64 {
        let u = 1.0 - (1.0 - u0) * (f + n - x) as f64 / n as f64;
        if x == f + n { b } else { a + (b - a) * law(u) }
    };
    if t < f {
        return a;
    }
    let x = t + 1; // the first frame after a knot already moves
    if x >= f + n {
        return b;
    }
    // Knots: `f`, the quantum boundaries after it, `f + n`; `lo < x <= hi`.
    let lo = ((x - 1) / QUANTUM * QUANTUM).max(f);
    let hi = (((x - 1) / QUANTUM + 1) * QUANTUM).min(f + n);
    val(lo) + (val(hi) - val(lo)) * (x - lo) as f64 / (hi - lo) as f64
}

fn sin_q(u: f64) -> f64 {
    libm::sin(u * core::f64::consts::FRAC_PI_2)
}

fn cos_q(u: f64) -> f64 {
    libm::cos(u * core::f64::consts::FRAC_PI_2)
}

/// Three DC voices (gains 0.1, 0.1, 0.5), rendered one quantum.
fn three_voices() -> Mixer {
    let mut m = quiet();
    m.submit(&[play_at(V1, MIXED | LOOP, 0.1, wire::ASAP), play_at(V2, MIXED | LOOP, 0.1, wire::ASAP), play_at(V3, MIXED | LOOP, 0.5, wire::ASAP)]);
    m.render();
    m
}

#[test]
fn a_stamped_fade_moves_only_its_voice() {
    let mut m = three_voices();
    let mut twin = three_voices();
    m.submit(&[fade_at(V3, 0.25, 40, false, 0, K as u32)]);
    let l = run(&mut m, 1);
    twin.render();
    check(&l, 1e-6, "voice 3 fades from sample K", |k| 0.2 + 0.5 * if k < K { 1.0 } else { 1.0 - 0.75 * ((k - K + 1).min(40) as f32 / 40.0) });
    assert_eq!(split_counts(&m), (0, 0), "the gain loop takes it: no split of either kind");
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
    let s = voices::slots(&m.core);
    assert_eq!(s[3].fade.value, 0.25);
    assert_eq!(s[3].reserved, 0, "a linear fade takes no curve");
}

/// A 250 ms equal-power crossfade at sample K of the second quantum, each side in its own mixer
/// (so each output is one voice): the in side a PLAY with `fadeZero` and a FADE to 1 at the same
/// sample, the out side a playing voice with a FADE to 0 and `stopAtEnd`.
#[test]
fn an_equal_power_crossfade_follows_the_same_knot_reference_and_keeps_power() {
    const N: usize = 12_000;
    const G: f32 = 0.5;
    let f = QUANTUM + K;
    let quanta = (f + N) / QUANTUM + 3;

    let mut fade_in = quiet();
    fade_in.render();
    fade_in.submit(&[play_at(V1, MIXED | LOOP | FADE_ZERO, G, K as u32), fade_at(V1, 1.0, N as u32, false, shape(wire::fade_law::EQUAL_POWER_IN, 0.0), K as u32)]);
    let mut out_in = vec![0.0f32; QUANTUM];
    out_in.extend(run(&mut fade_in, quanta - 1));

    let mut fade_out = quiet();
    fade_out.submit(&[play_at(V1, MIXED | LOOP, G, wire::ASAP)]);
    fade_out.render();
    fade_out.submit(&[fade_at(V1, 0.0, N as u32, true, shape(wire::fade_law::EQUAL_POWER_OUT, 0.0), K as u32)]);
    let mut out_out = vec![G; QUANTUM];
    out_out.extend(run(&mut fade_out, quanta - 1));

    let (mut seam_in, mut seam_out, mut power) = (0.0f64, 0.0f64, 0.0f64);
    for t in 0..quanta * QUANTUM {
        let a = out_in[t] as f64 / G as f64;
        let b = out_out[t] as f64 / G as f64;
        seam_in = seam_in.max((a - reference(sin_q, 0.0, 1.0, f, N, 0.0, t)).abs());
        seam_out = seam_out.max((b - reference(|u| 1.0 - cos_q(u), 1.0, 0.0, f, N, 0.0, t)).abs());
        power = power.max((a * a + b * b - 1.0).abs());
    }
    eprintln!("seam in {seam_in:e}, seam out {seam_out:e}, power {power:e}");
    assert!(seam_in < 1e-5, "fade in against the same-knot reference: {seam_in:e}");
    assert!(seam_out < 1e-5, "fade out against the same-knot reference: {seam_out:e}");
    assert!(power < 1e-4, "in² + out² − 1: {power:e}");
    assert_eq!(out_in[f + N - 1], G, "the fade in lands on 1");
    assert_eq!(out_out[f + N - 1], 0.0, "the fade out lands on 0");
    assert!(out_out[f + N..].iter().all(|&x| x == 0.0), "and its voice has ended");
    assert_eq!(voices::slots(&fade_out.core)[1].state, voices::state::FREE, "freed");
    assert_eq!(voices::slots(&fade_in.core)[1].reserved, 0, "the curve is released");
    for m in [&fade_in, &fade_out] {
        assert_eq!(split_counts(m), (0, 0));
        assert_eq!(status::counters(&m.core).music.curve_pool_full, 0);
    }
}

/// REPLAY's case: a fade in re-sent with start phase 0.5 starts at `sin(π/4)` and runs the other
/// half over its frames.
#[test]
fn a_start_phase_starts_at_the_laws_value() {
    const N: usize = 1_000;
    let mut m = quiet();
    m.render();
    m.submit(&[play_at(V1, MIXED | LOOP | FADE_ZERO, 0.5, K as u32), fade_at(V1, 1.0, N as u32, false, shape(wire::fade_law::EQUAL_POWER_IN, 0.5), K as u32)]);
    let mut out = vec![0.0f32; QUANTUM];
    out.extend(run(&mut m, 12));
    let f = QUANTUM + K;
    let mut max = 0.0f64;
    for t in f..f + N {
        let want = reference(sin_q, 0.0, 1.0, f, N, 0.5, t);
        max = max.max((out[t] as f64 / 0.5 - want).abs());
    }
    assert!(max < 1e-5, "against the same-knot reference: {max:e}");
    assert!((out[f] as f64 / 0.5 - core::f64::consts::FRAC_1_SQRT_2).abs() < 2e-3, "starts near sin(π/4): {}", out[f] / 0.5);
    assert_eq!(out[f + N - 1], 0.5);
}

/// A gain-only SET_PARAMS with a law drives the `gain` ramp and leaves `fade` alone.
#[test]
fn a_shaped_gain_ramp_drives_the_gain_ramp() {
    const N: usize = 600;
    let mut m = quiet();
    m.submit(&[play_at(V1, MIXED | LOOP, 1.0, wire::ASAP)]);
    m.render();
    let rec = Rec::Set(wire::SetParams { voice_id: V1, frame_offset: K as u32, mask: wire::SET_PARAMS_MASK_GAIN, gain: 0.2, ramp_frames: N as u32, shape: shape(wire::fade_law::S_CURVE, 0.0), ..Default::default() });
    m.submit(&[rec]);
    let mut out = vec![1.0f32; QUANTUM];
    out.extend(run(&mut m, 7));
    let f = QUANTUM + K;
    let s_curve = |u: f64| u * u * (3.0 - 2.0 * u);
    let mut max = 0.0f64;
    for t in 0..out.len() {
        max = max.max((out[t] as f64 - reference(s_curve, 1.0, 0.2, f, N, 0.0, t)).abs());
    }
    assert!(max < 1e-5, "against the same-knot reference: {max:e}");
    let s = voices::slots(&m.core);
    assert_eq!((s[1].fade.value, s[1].gain.value, s[1].reserved), (1.0, 0.2, 0));
    assert_eq!(split_counts(&m), (0, 0));
}
