//! F-21: a linear fade stays on its line whatever its length (`curves::linear_knot`).
//!
//! A linear FADE, a STOP's fade and a SET_PARAMS gain ramp each run on one `Ramp`, and
//! `value += step` rounds the same way frame after frame: before F-21 a 500 ms crossfade drifted
//! 1.68e-5 from its line and the drift grew with the fade's length. The core now puts a linear
//! ramp back on its line (`target − step·remaining`) at every quantum boundary, so the error is
//! one quantum's accumulation at most, however long the fade. Each scene here fades a DC voice
//! for seconds, stamped (the gain loop's compare) and unstamped (applied at a quantum's start),
//! and holds the output to [`bound`] against the exact line, `a + (b − a)·(t + 1 − F)/N`.
//!
//! **The bound, proved.** At a knot the ramp is on the line to within `LINEAR_DRIFT` (2^-22, below
//! which it is left alone), the f32 slope's `2^-24·|b − a|` and the knot's own rounding (a half
//! ulp). Between knots, inside one binade, `value + step` lands on `value + round(step)`, so the
//! ramp runs with its slope rounded to the binade's ulp and drifts at most a half ulp a frame: 128
//! half ulps by the next knot. For values below 1 that is 2^-18 = 3.8e-6, whatever the fade's
//! length (before F-21 the drift grew with it: 1.1e-3 over these 3 to 5 s fades at level 0.5, and
//! 1.68e-5 on the 500 ms seam). A fade whose roundings fall one way reaches the bound (the fade
//! to silence here measures 1.9e-6 at level 0.5); most measure a few 1e-7.

mod common;
mod in_voice_reference;

use audio_wire::generated as wire;
use common::*;
use in_voice_reference::{max_error, Fade, Law};

const Q: usize = audio_core::QUANTUM;
const V1: u32 = 0x0001_0001;
/// The voice's gain: the DC clip at 0.5 comes out at 0.5 on the left.
const GAIN: f32 = 0.5;
/// The proved bound on `level` times a linear ramp from `a` to `b` (see the module comment), plus
/// the output's own rounding (the level's product, a half ulp of the output).
fn bound(level: f64, a: f64, b: f64) -> f64 {
    let peak = a.abs().max(b.abs());
    // The half ulp of the binade below `peak` (the ramp leaves `peak` on its first frame).
    let half_ulp = 2f64.powi(peak.log2().ceil() as i32 - 25);
    let knot = audio_core::curves::LINEAR_DRIFT as f64 + 2f64.powi(-24) * (b - a).abs() + half_ulp;
    level * (128.0 * half_ulp + knot) + 2f64.powi(-25)
}
/// 5 s at 48 kHz.
const LONG: usize = 240_000;
/// Where a stamped record lands in its quantum.
const K: usize = 50;

fn played(voice: u32, gain: f32) -> Rec {
    let Rec::Play(mut p) = play(voice, DC, ROOT, MIXED | LOOP) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

fn fade_rec(voice: u32, target: f32, frames: usize, at: u32) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice, frame_offset: at, target, frames: frames as u32, flags: 0, shape: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn stop_rec(voice: u32, frames: usize, at: u32) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: at, fade_frames: frames as u32, reason: 0, shape: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn gain_rec(voice: u32, gain: f32, frames: usize, at: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: at, mask: wire::SET_PARAMS_MASK_GAIN, gain, ramp_frames: frames as u32, ..Default::default() })
}

/// Plays the DC voice, renders a quantum, sends `rec` (which lands at frame `Q + at`, `at` 0 for an
/// unstamped record), renders past `frames`, and returns the left channel and the record's frame.
fn scene(rec: impl Fn(u32) -> Rec, stamped: bool, frames: usize) -> (Vec<f32>, usize) {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m.submit(&[played(V1, GAIN)]);
    let (mut left, _) = m.render_n(1);
    let at = if stamped { K } else { 0 };
    m.submit(&[rec(if stamped { at as u32 } else { wire::ASAP })]);
    let (l, _) = m.render_n(frames / Q + 3);
    left.extend(l);
    (left, Q + at)
}

fn check(what: &str, left: &[f32], bound: f64, want: impl Fn(usize) -> f64) -> f64 {
    let err = max_error(left, 0..left.len(), want);
    eprintln!("{what}: {err:e} against the exact line (bound {bound:e})");
    assert!(err <= bound, "{what}: {err:e} over {bound:e}");
    err
}

#[test]
fn a_five_second_linear_fade_stays_on_its_line() {
    for stamped in [false, true] {
        let (left, f) = scene(|at| fade_rec(V1, 0.2, LONG, at), stamped, LONG);
        let fade = Fade::new(Law::Linear, 1.0, 0.2, f, LONG);
        check(&format!("FADE 1 to 0.2 over 5 s, stamped {stamped}"), &left, bound(0.5, 1.0, 0.2), |t| GAIN as f64 * fade.exact(t));
        assert_eq!(left[f + LONG - 1], GAIN * 0.2, "lands exactly on its target");
    }
}

#[test]
fn a_fade_out_to_silence_stays_on_its_line_to_the_end() {
    // Small values: the line reaches 0, where the f32 grid is finest.
    for stamped in [false, true] {
        let (left, f) = scene(|at| fade_rec(V1, 0.0, 3 * LONG / 5, at), stamped, 3 * LONG / 5);
        let fade = Fade::new(Law::Linear, 1.0, 0.0, f, 3 * LONG / 5);
        check(&format!("FADE 1 to 0 over 3 s, stamped {stamped}"), &left, bound(0.5, 1.0, 0.0), |t| GAIN as f64 * fade.exact(t));
    }
}

#[test]
fn a_long_stop_fade_stays_on_its_line() {
    for stamped in [false, true] {
        let n = 4 * LONG / 5;
        let (left, f) = scene(|at| stop_rec(V1, n, at), stamped, n);
        let fade = Fade::new(Law::Linear, 1.0, 0.0, f, n);
        check(&format!("STOP over 4 s, stamped {stamped}"), &left, bound(0.5, 1.0, 0.0), |t| if t >= f + n { 0.0 } else { GAIN as f64 * fade.exact(t) });
    }
}

#[test]
fn a_long_gain_ramp_stays_on_its_line() {
    for stamped in [false, true] {
        let (left, f) = scene(|at| gain_rec(V1, 0.15, LONG, at), stamped, LONG);
        let ramp = Fade::new(Law::Linear, GAIN as f64, 0.15, f, LONG);
        check(&format!("SET_PARAMS gain 0.5 to 0.15 over 5 s, stamped {stamped}"), &left, bound(1.0, 0.5, 0.15), |t| ramp.exact(t));
    }
}

/// T2's case in miniature: a 500 ms linear crossfade, one voice out and one in, sums to the level
/// it started at (to the two ramps' bound) all the way through (2.6e-6 before F-21).
#[test]
fn a_500_ms_linear_crossfade_nulls() {
    const N: usize = 24_000;
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m.submit(&[played(V1, GAIN)]);
    let (mut left, _) = m.render_n(1);
    let Rec::Play(mut p) = play(0x0001_0002, DC, ROOT, MIXED | LOOP | wire::PLAY_FLAGS_FADE_ZERO) else { unreachable!() };
    p.gain = GAIN;
    p.frame_offset = K as u32;
    m.submit(&[fade_rec(V1, 0.0, N, K as u32), Rec::Play(p), fade_rec(0x0001_0002, 1.0, N, K as u32)]);
    let (l, _) = m.render_n(N / Q + 3);
    left.extend(l);
    let (out, into) = (Fade::new(Law::Linear, 1.0, 0.0, Q + K, N), Fade::new(Law::Linear, 0.0, 1.0, Q + K, N));
    check("500 ms linear crossfade", &left, 2.0 * bound(0.5, 1.0, 0.0), |t| GAIN as f64 * (out.exact(t) + if t < Q + K { 0.0 } else { into.exact(t) }));
}
