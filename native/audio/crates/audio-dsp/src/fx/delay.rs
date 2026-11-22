//! Delay lines on caller-owned memory (ADR 0331's `delay` and `chorus`, and the lines of the
//! reverb and the pitch shifter).
//!
//! The core hands each effect a slice of its effect memory (`audio-core`'s `fxmem.rs`); an offline
//! renderer hands it a `Vec`. Nothing here allocates or assumes a worklet.
//!
//! - **Delay** (`time` 1..2000 ms, `feedback` 0..95 %, `mix` 0..100 %): a stereo line read with
//!   linear interpolation; a time change glides across the block (tape-style: the read head moves,
//!   so a ramped time bends the pitch briefly instead of clicking). The output is
//!   `(1 − mix)·dry + mix·wet`; the line is fed `dry + feedback·wet`.
//! - **Chorus** (`rate` 0.05..10 Hz, `depth` 0..100 %, `mix`): one modulated tap per channel at
//!   [`CHORUS_BASE_MS`] ± `depth` × [`CHORUS_DEPTH_MS`], the right LFO a quarter cycle after the
//!   left (stereo width). The LFO is evaluated at the block's ends and interpolated across it
//!   (at most 10 Hz against a 2.7 ms block: indistinguishable from per-sample, two `sin` a block).

/// A read at `d` frames (fractional, ≥ 1) behind the write position `w` of `line` (a ring).
#[inline]
pub fn read(line: &[f32], w: usize, d: f32) -> f32 {
    let n = line.len();
    let di = d as usize;
    let frac = d - di as f32;
    // w - di - 1 and w - di, modulo n.
    let i0 = (w + n - (di % n)) % n;
    let i1 = (i0 + n - 1) % n;
    let a = line[i0];
    let b = line[i1];
    a + (b - a) * frac
}

/// Frames a delay of `ms` needs at `sample_rate`, with a block and interpolation margin.
pub fn frames_for_ms(sample_rate: f32, ms: f32) -> usize {
    (ms.max(0.0) * sample_rate / 1000.0) as usize + 2 * crate::fx::BLOCK + 4
}

/// Floats the delay effect needs for `time_ms` (two channels): at least [`DELAY_MIN_MS`] so short
/// edits don't reallocate, the time rounded up by half again so a modest lengthening keeps the
/// line (and its tail).
pub fn delay_floats(sample_rate: f32, time_ms: f32) -> usize {
    let ms = (time_ms * 1.5).clamp(DELAY_MIN_MS, DELAY_MAX_MS);
    2 * frames_for_ms(sample_rate, ms)
}

/// The shortest line a delay allocates, ms.
pub const DELAY_MIN_MS: f32 = 250.0;
/// The catalogue's longest time, ms.
pub const DELAY_MAX_MS: f32 = 2_000.0;

/// The delay's carried state (in the effect's inline state): the write position.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DelayState {
    pub w: u32,
}

/// One block of the delay. `mem` is two equal rings (left, right); `d0` and `d1` the delay in
/// frames at the block's start and end (clamped to the line).
pub fn delay(state: &mut DelayState, mem: &mut [f32], l: &mut [f32], r: &mut [f32], d0: f32, d1: f32, feedback: f32, mix: f32) {
    let half = mem.len() / 2;
    if half < 4 {
        return;
    }
    let (ml, mr) = mem.split_at_mut(half);
    let max = (half - 2) as f32;
    let n = l.len().min(r.len());
    let fb = feedback.clamp(0.0, 0.95);
    let mix = mix.clamp(0.0, 1.0);
    let dry = 1.0 - mix;
    let step = if n > 0 { (d1 - d0) / n as f32 } else { 0.0 };
    let mut w = state.w as usize % half;
    for i in 0..n {
        let d = (d0 + step * (i as f32 + 1.0)).clamp(1.0, max);
        let wl = read(ml, w, d);
        let wr = read(mr, w, d);
        let (xl, xr) = (l[i], r[i]);
        ml[w] = flush(xl + fb * wl);
        mr[w] = flush(xr + fb * wr);
        l[i] = dry * xl + mix * wl;
        r[i] = dry * xr + mix * wr;
        w += 1;
        if w == half {
            w = 0;
        }
    }
    state.w = w as u32;
}

/// Denormals and non-finite values to 0, so a feedback tail dies cleanly.
#[inline]
pub fn flush(x: f32) -> f32 {
    if x.is_finite() && x.abs() > 1e-20 {
        x
    } else {
        0.0
    }
}

/// The chorus's centre delay, ms.
pub const CHORUS_BASE_MS: f32 = 12.0;
/// The chorus's deviation at depth 100 %, ms.
pub const CHORUS_DEPTH_MS: f32 = 7.0;

/// Floats the chorus needs at `sample_rate` (two rings).
pub fn chorus_floats(sample_rate: f32) -> usize {
    2 * frames_for_ms(sample_rate, CHORUS_BASE_MS + CHORUS_DEPTH_MS + 1.0)
}

/// The chorus's carried state: the write position and the LFO phase (cycles, 0..1).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChorusState {
    pub w: u32,
    pub phase: f32,
}

/// One block of the chorus (`rate` Hz, `depth` 0..1, `mix` 0..1).
pub fn chorus(state: &mut ChorusState, mem: &mut [f32], sample_rate: f32, l: &mut [f32], r: &mut [f32], rate: f32, depth: f32, mix: f32) {
    let half = mem.len() / 2;
    if half < 8 {
        return;
    }
    let (ml, mr) = mem.split_at_mut(half);
    let n = l.len().min(r.len());
    let fpm = sample_rate / 1000.0;
    let base = CHORUS_BASE_MS * fpm;
    let dev = CHORUS_DEPTH_MS * fpm * depth.clamp(0.0, 1.0);
    let mix = mix.clamp(0.0, 1.0);
    let dry = 1.0 - mix;
    let inc = rate.clamp(0.0, 20.0) / sample_rate * n as f32;
    let tau = core::f32::consts::TAU;
    let p0 = state.phase;
    let p1 = p0 + inc;
    let (sl0, sl1) = (libm::sinf(tau * p0), libm::sinf(tau * p1));
    let (sr0, sr1) = (libm::cosf(tau * p0), libm::cosf(tau * p1));
    let max = (half - 2) as f32;
    let mut w = state.w as usize % half;
    for i in 0..n {
        let u = (i as f32 + 1.0) / n as f32;
        let dl = (base + dev * (sl0 + (sl1 - sl0) * u)).clamp(1.0, max);
        let dr = (base + dev * (sr0 + (sr1 - sr0) * u)).clamp(1.0, max);
        let (xl, xr) = (l[i], r[i]);
        ml[w] = xl;
        mr[w] = xr;
        let wl = read(ml, w, dl);
        let wr = read(mr, w, dr);
        l[i] = dry * xl + mix * wl;
        r[i] = dry * xr + mix * wr;
        w += 1;
        if w == half {
            w = 0;
        }
    }
    state.w = w as u32;
    state.phase = p1 - libm::floorf(p1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_impulse_comes_back_after_the_delay_with_feedback_echoes() {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; delay_floats(sr, 10.0)];
        let mut s = DelayState::default();
        let d = 480.0; // 10 ms
        let mut out = Vec::new();
        for q in 0..12 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            if q == 0 {
                l[0] = 1.0;
                r[0] = 1.0;
            }
            delay(&mut s, &mut mem, &mut l, &mut r, d, d, 0.5, 1.0);
            out.extend_from_slice(&l);
        }
        assert!((out[480] - 1.0).abs() < 1e-6, "{}", out[480]);
        assert!((out[960] - 0.5).abs() < 1e-6, "{}", out[960]);
        assert!((out[1440] - 0.25).abs() < 1e-6);
        assert!(out[0].abs() < 1e-9, "mix 100 % has no dry");
    }

    #[test]
    fn chorus_at_zero_mix_is_dry_and_at_full_mix_is_a_delayed_copy() {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; chorus_floats(sr)];
        let mut s = ChorusState::default();
        let mut l: Vec<f32> = (0..128).map(|i| i as f32 / 128.0).collect();
        let mut r = l.clone();
        let dry = l.clone();
        chorus(&mut s, &mut mem, sr, &mut l, &mut r, 1.0, 0.5, 0.0);
        assert_eq!(l, dry);
        assert!(s.phase > 0.0);
        let mut mem2 = vec![0.0f32; chorus_floats(sr)];
        let mut s2 = ChorusState::default();
        let (mut l2, mut r2) = ([1.0f32; 128], [1.0f32; 128]);
        chorus(&mut s2, &mut mem2, sr, &mut l2, &mut r2, 1.0, 0.0, 1.0);
        assert_eq!(l2, [0.0; 128], "12 ms of silence first: the tap is behind the input");
    }
}
