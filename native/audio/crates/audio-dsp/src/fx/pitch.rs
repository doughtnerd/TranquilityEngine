//! The pitch shifter (ADR 0331's `pitchShift`: −24..24 semitones, −50..50 cents): granular, as the
//! record asks first ("a phase vocoder later if needed").
//!
//! Two read heads sweep a delay line of [`WINDOW_MS`] at `1 − ratio` frames per frame, half a
//! window apart, each weighted by `sin²(π·d / W)` of its delay `d`: a head wraps (from 0 to W, or W
//! to 0) where its weight is 0, and the two weights always sum to 1. The pitch moves by `ratio`
//! and the formants with it (the shifter resamples the grains); the latency is about half a
//! window. A ratio of exactly 1, settled, passes the signal through untouched (two fixed heads
//! would comb-filter it).

use super::delay::read;

/// The grain window, ms (40 ms: smooth on sustained sounds, a slight smear on transients).
pub const WINDOW_MS: f32 = 40.0;

/// The pitch ratio of `semitones` + `cents` (each clamped to the catalogue's range).
pub fn ratio(semitones: f32, cents: f32) -> f32 {
    let st = super::shape::clamp(semitones, -24.0, 24.0) + super::shape::clamp(cents, -50.0, 50.0) / 100.0;
    libm::exp2f(st / 12.0)
}

fn window(sample_rate: f32) -> f32 {
    WINDOW_MS * sample_rate / 1000.0
}

/// Floats the shifter needs at `sample_rate` (two rings of a window and a margin).
pub fn floats(sample_rate: f32) -> usize {
    2 * (window(sample_rate) as usize + super::BLOCK + 8)
}

/// The shifter's carried state: the write position and the first head's delay (frames, 0..W).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PitchState {
    pub w: u32,
    pub d: f32,
}

/// One block, the ratio moving from `r0` to `r1` across it.
pub fn process(state: &mut PitchState, mem: &mut [f32], sample_rate: f32, l: &mut [f32], r: &mut [f32], r0: f32, r1: f32) {
    let half = mem.len() / 2;
    let win = window(sample_rate);
    if half < win as usize + 4 || !(win > 4.0) {
        return;
    }
    let (ml, mr) = mem.split_at_mut(half);
    let n = l.len().min(r.len());
    let mut w = state.w as usize % half;
    let mut d = if state.d.is_finite() { state.d.rem_euclid(win) } else { 0.0 };
    let pi_w = core::f32::consts::PI / win;
    for i in 0..n {
        let ratio = r0 + (r1 - r0) * (i as f32 + 1.0) / n as f32;
        ml[w] = l[i];
        mr[w] = r[i];
        let d2 = if d + 0.5 * win >= win { d - 0.5 * win } else { d + 0.5 * win };
        // Sin² weights: g1 + g2 = 1 (the heads are half a window apart).
        let s = libm::sinf(pi_w * d);
        let g1 = s * s;
        let g2 = 1.0 - g1;
        // A head reads at least one frame behind the write.
        let (a, b) = (d + 1.0, d2 + 1.0);
        l[i] = g1 * read(ml, w, a) + g2 * read(ml, w, b);
        r[i] = g1 * read(mr, w, a) + g2 * read(mr, w, b);
        d += 1.0 - ratio;
        if d < 0.0 {
            d += win;
        } else if d >= win {
            d -= win;
        }
        w += 1;
        if w == half {
            w = 0;
        }
    }
    state.w = w as u32;
    state.d = d;
}

/// Writes a block into the rings without shifting (the effect is settled at a ratio of 1 and
/// passes the signal through): when a shift comes in, its heads read the recent signal, not a
/// stale one. The first head parks at the window's start.
pub fn follow(state: &mut PitchState, mem: &mut [f32], l: &[f32], r: &[f32]) {
    let half = mem.len() / 2;
    if half < 4 {
        return;
    }
    let (ml, mr) = mem.split_at_mut(half);
    let mut w = state.w as usize % half;
    for (a, b) in l.iter().zip(r.iter()) {
        ml[w] = *a;
        mr[w] = *b;
        w += 1;
        if w == half {
            w = 0;
        }
    }
    state.w = w as u32;
    state.d = 0.0;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dominant frequency of `x` by counting upward zero crossings.
    fn crossings_hz(x: &[f32], sr: f32) -> f32 {
        let c = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        c as f32 * sr / x.len() as f32
    }

    #[test]
    fn an_octave_up_doubles_the_frequency() {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; floats(sr)];
        let mut s = PitchState::default();
        let rt = ratio(12.0, 0.0);
        assert!((rt - 2.0).abs() < 1e-6);
        let mut out = Vec::new();
        for q in 0..200 {
            let mut l: Vec<f32> = (0..128).map(|i| libm::sinf(core::f32::consts::TAU * 220.0 * (q * 128 + i) as f32 / sr)).collect();
            let mut r = l.clone();
            process(&mut s, &mut mem, sr, &mut l, &mut r, rt, rt);
            out.extend_from_slice(&l);
        }
        let hz = crossings_hz(&out[9_600..], sr);
        assert!((hz - 440.0).abs() < 25.0, "{hz}");
        assert!(out.iter().all(|x| x.abs() <= 1.01));
    }

    #[test]
    fn a_fifth_down_lowers_the_frequency() {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; floats(sr)];
        let mut s = PitchState::default();
        let rt = ratio(-7.0, 0.0);
        let mut out = Vec::new();
        for q in 0..200 {
            let mut l: Vec<f32> = (0..128).map(|i| libm::sinf(core::f32::consts::TAU * 660.0 * (q * 128 + i) as f32 / sr)).collect();
            let mut r = l.clone();
            process(&mut s, &mut mem, sr, &mut l, &mut r, rt, rt);
            out.extend_from_slice(&l);
        }
        let hz = crossings_hz(&out[9_600..], sr);
        assert!((hz - 660.0 * rt).abs() < 25.0, "{hz} vs {}", 660.0 * rt);
    }
}
