//! The algorithmic reverb (ADR 0331's `reverb`: `size` 0..1, `decay` 0.1..20 s, `mix` 0..100 %):
//! an eight-line feedback delay network. The convolver stays for reverb zones' impulse responses.
//!
//! - **Input diffusion:** each channel passes two Schroeder all-passes (gain 0.6), so a transient
//!   enters the network already smeared.
//! - **The network:** eight delay lines (mutually prime lengths, [`LINES_MS`] scaled by
//!   `0.35 + 1.65·size`), the left channel feeding the even lines and the right the odd ones; the
//!   feedback matrix is Householder (`I − 2/N·11ᵀ`, lossless and dense); each line's gain is
//!   `10^(−3·len / (rate·decay))`, so every line falls 60 dB in `decay` seconds, and a one-pole
//!   low-pass per line ([`DAMPING`]) makes the highs die first, as in a room.
//! - **Output:** the even lines (alternating signs) make the left, the odd ones the right, scaled
//!   by [`WET_GAIN`]; `(1 − mix)·dry + mix·wet`.
//! - **Size glides** move the read heads (each line read with linear interpolation at a length
//!   interpolated across the block), so a size automation bends rather than clicks. The lines are
//!   laid out for size 1 at the effect's rate ([`floats`]), so a size change never reallocates.

use super::delay::{flush, read};

/// Line lengths at size 1 / (0.35 + 1.65), ms: mutually prime at 48 kHz.
const LINES_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.3, 67.1];
/// The diffusers' lengths, ms (left two, right two).
const DIFFUSER_MS: [f32; 4] = [4.77, 3.59, 5.03, 3.83];
const DIFFUSER_GAIN: f32 = 0.6;
/// The lines' high-frequency loss: the one-pole coefficient (0 = none).
pub const DAMPING: f32 = 0.25;
/// The wet signal's scale.
pub const WET_GAIN: f32 = 0.35;
pub const LINES: usize = 8;

fn scale(size: f32) -> f32 {
    0.35 + 1.65 * size.clamp(0.0, 1.0)
}

fn line_cap(sample_rate: f32, i: usize) -> usize {
    (LINES_MS[i] * 2.0 * sample_rate / 1000.0) as usize + 4
}

fn diffuser_cap(sample_rate: f32, i: usize) -> usize {
    (DIFFUSER_MS[i] * sample_rate / 1000.0) as usize + 2
}

/// Floats the reverb needs at `sample_rate`: the eight lines at size 1 and the four diffusers.
pub fn floats(sample_rate: f32) -> usize {
    (0..LINES).map(|i| line_cap(sample_rate, i)).sum::<usize>() + (0..4).map(|i| diffuser_cap(sample_rate, i)).sum::<usize>()
}

/// The reverb's carried state (inline): the write positions, the damping filters' memory.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ReverbState {
    pub w: [u32; LINES],
    pub dw: [u32; 4],
    pub lp: [f32; LINES],
}

/// One block. `size0`/`size1` the size at the block's start and end (a glide), `decay` seconds,
/// `mix` 0..1. `mem` must hold [`floats`] floats for `sample_rate` (a shorter one passes through).
pub fn process(state: &mut ReverbState, mem: &mut [f32], sample_rate: f32, l: &mut [f32], r: &mut [f32], size0: f32, size1: f32, decay: f32, mix: f32) {
    if mem.len() < floats(sample_rate) || sample_rate <= 0.0 {
        return;
    }
    let mix = mix.clamp(0.0, 1.0);
    let n = l.len().min(r.len());
    // Carve the lines and the diffusers out of `mem`.
    let mut lines: [&mut [f32]; LINES] = Default::default();
    let mut rest = &mut mem[..];
    for (i, slot) in lines.iter_mut().enumerate() {
        let (a, b) = core::mem::take(&mut rest).split_at_mut(line_cap(sample_rate, i));
        *slot = a;
        rest = b;
    }
    let mut diff: [&mut [f32]; 4] = Default::default();
    for (i, slot) in diff.iter_mut().enumerate() {
        let (a, b) = core::mem::take(&mut rest).split_at_mut(diffuser_cap(sample_rate, i));
        *slot = a;
        rest = b;
    }
    let fpm = sample_rate / 1000.0;
    let (s0, s1) = (scale(size0), scale(size1));
    let mut len0 = [0.0f32; LINES];
    let mut len1 = [0.0f32; LINES];
    let mut gain = [0.0f32; LINES];
    let decay = decay.clamp(0.05, 60.0);
    for i in 0..LINES {
        let max = (lines[i].len() - 3) as f32;
        len0[i] = (LINES_MS[i] * s0 * fpm).clamp(2.0, max);
        len1[i] = (LINES_MS[i] * s1 * fpm).clamp(2.0, max);
        // 60 dB over `decay` seconds, per pass through the line (its length at the block's end).
        gain[i] = libm::powf(10.0, -3.0 * len1[i] / (sample_rate * decay));
    }
    let dlen: [f32; 4] = core::array::from_fn(|i| (diff[i].len() - 1) as f32);
    let dry = 1.0 - mix;
    let wet_scale = WET_GAIN * mix;
    let inv_n = 2.0 / LINES as f32;
    for k in 0..n {
        let u = (k as f32 + 1.0) / n.max(1) as f32;
        let (xl, xr) = (l[k], r[k]);
        // Input diffusion: two all-passes per channel.
        let mut dl = xl;
        let mut dr = xr;
        for j in 0..4 {
            let x = if j < 2 { dl } else { dr };
            let line = &mut *diff[j];
            let w = state.dw[j] as usize % line.len();
            let delayed = read(line, w, dlen[j]);
            let v = flush(x + DIFFUSER_GAIN * delayed);
            line[w] = v;
            let y = delayed - DIFFUSER_GAIN * v;
            state.dw[j] = ((w + 1) % line.len()) as u32;
            if j < 2 {
                dl = y;
            } else {
                dr = y;
            }
        }
        // Read the lines, damp them, mix through the Householder matrix.
        let mut o = [0.0f32; LINES];
        let mut sum = 0.0f32;
        for i in 0..LINES {
            let line = &*lines[i];
            let w = state.w[i] as usize % line.len();
            let d = len0[i] + (len1[i] - len0[i]) * u;
            let y = read(line, w, d);
            let lp = flush(y + DAMPING * (state.lp[i] - y));
            state.lp[i] = lp;
            o[i] = lp;
            sum += lp;
        }
        let s = sum * inv_n;
        let mut wl = 0.0f32;
        let mut wr = 0.0f32;
        for i in 0..LINES {
            let f = o[i] - s;
            let input = if i % 2 == 0 { dl } else { dr };
            let line = &mut *lines[i];
            let w = state.w[i] as usize % line.len();
            line[w] = flush(input + gain[i] * f);
            state.w[i] = ((w + 1) % line.len()) as u32;
            let sign = if (i / 2) % 2 == 0 { 1.0 } else { -1.0 };
            if i % 2 == 0 {
                wl += sign * o[i];
            } else {
                wr += sign * o[i];
            }
        }
        l[k] = dry * xl + wet_scale * wl;
        r[k] = dry * xr + wet_scale * wr;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy_after(decay: f32, quanta: usize) -> Vec<f32> {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; floats(sr)];
        let mut s = ReverbState::default();
        let mut out = Vec::new();
        for q in 0..quanta {
            let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
            if q == 0 {
                l[0] = 1.0;
                r[0] = 1.0;
            }
            process(&mut s, &mut mem, sr, &mut l, &mut r, 0.5, 0.5, decay, 1.0);
            out.push(l.iter().chain(r.iter()).map(|x| x * x).sum::<f32>());
        }
        out
    }

    #[test]
    fn an_impulse_rings_and_decays_about_as_set() {
        // 1 s decay: the energy 0.5 s in is about 30 dB under the energy at 0.1 s (60 dB/s).
        let e = energy_after(1.0, 400);
        let at = |s: f32| -> f32 { let q = (s * 48_000.0 / 128.0) as usize; e[q..q + 8].iter().sum::<f32>() };
        let drop_db = 10.0 * libm::log10f(at(0.1) / at(0.6));
        assert!((20.0..40.0).contains(&drop_db), "{drop_db} dB over 0.5 s");
        assert!(e.iter().all(|x| x.is_finite()));
        // A longer decay keeps more of the tail.
        let long = energy_after(8.0, 400);
        assert!(long[300] > e[300] * 10.0);
    }

    #[test]
    fn mix_zero_is_dry_and_a_short_memory_passes_through() {
        let sr = 48_000.0;
        let mut mem = vec![0.0f32; floats(sr)];
        let mut s = ReverbState::default();
        let (mut l, mut r) = ([0.25f32; 128], [0.5f32; 128]);
        process(&mut s, &mut mem, sr, &mut l, &mut r, 0.5, 0.5, 2.0, 0.0);
        assert_eq!((l, r), ([0.25; 128], [0.5; 128]));
        let mut short = vec![0.0f32; 16];
        process(&mut s, &mut short, sr, &mut l, &mut r, 0.5, 0.5, 2.0, 1.0);
        assert_eq!(l, [0.25; 128]);
    }
}
