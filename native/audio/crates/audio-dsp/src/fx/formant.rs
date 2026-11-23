//! The formant shifter (ADR 0345's `formantShift`: −12..12 semitones): moves the spectral envelope
//! (a voice's vowel colour, an instrument's body) up or down while the pitch stays.
//!
//! Linear prediction, once per block:
//! 1. **Analysis.** The block's mid signal joins a ring of [`WINDOW_MS`]; its Hann-windowed
//!    autocorrelation gives, by Levinson–Durbin, an all-pole envelope `E/|A(e^{jω})|²` of order
//!    [`ORDER`].
//! 2. **Warp.** The target envelope is the analysed one read at `ω / k` (`k = 2^(st/12)`, clamped to
//!    Nyquist), sampled on [`GRID`] frequencies; its autocorrelation (a cosine sum) and a second
//!    Levinson give the all-pole fit `E'/|B|²` of the shifted envelope.
//! 3. **Resynthesis.** Each channel is whitened by `A` (the residual keeps the pitch and the
//!    noise) and coloured by `1/B` with gain `√(E'/E)`.
//!
//! A shift of 0, settled, passes the signal through untouched (the histories keep following, so
//! a shift that comes in continues from the signal). Silence keeps the last envelope. The filters
//! change once per block (both minimum phase, from Levinson, so the switch is stable). All in
//! caller-owned memory ([`floats`]); `libm` for the transcendentals; nothing allocates.

/// The prediction order.
pub const ORDER: usize = 16;
/// The analysis window, ms.
pub const WINDOW_MS: f32 = 20.0;
/// Frequencies the warped envelope is sampled on.
pub const GRID: usize = 64;
/// The longest window (192 kHz × 20 ms).
const MAX_WINDOW: usize = 3_840;

fn window_len(sample_rate: f32) -> usize {
    ((WINDOW_MS * sample_rate / 1000.0) as usize).clamp(64, MAX_WINDOW)
}

// Memory layout (floats): ring[W] | hann[W] | scratch[W] | per channel {x[P], y[P]} × 2 | a[P+1] | b[P+1] | gain, ready.
const STATE: usize = 4 * ORDER + 2 * (ORDER + 1) + 2;

/// Floats the shifter needs at `sample_rate`.
pub fn floats(sample_rate: f32) -> usize {
    3 * window_len(sample_rate) + STATE
}

/// The shifter's inline state: the ring's write position.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FormantState {
    pub w: u32,
}

fn levinson(r: &[f64; ORDER + 1], a: &mut [f64; ORDER + 1]) -> f64 {
    *a = [0.0; ORDER + 1];
    a[0] = 1.0;
    let mut e = r[0];
    if !(e > 0.0) {
        return 0.0;
    }
    let mut tmp = [0.0f64; ORDER + 1];
    for i in 1..=ORDER {
        let mut acc = r[i];
        for j in 1..i {
            acc += a[j] * r[i - j];
        }
        let k = -acc / e;
        if !(k.abs() < 1.0) {
            break;
        }
        tmp[..i].copy_from_slice(&a[..i]);
        for j in 1..i {
            a[j] = tmp[j] + k * tmp[i - j];
        }
        a[i] = k;
        e *= 1.0 - k * k;
        if !(e > 0.0) {
            break;
        }
    }
    e
}

/// One block, shifting by `semitones`.
pub fn process(state: &mut FormantState, mem: &mut [f32], sample_rate: f32, l: &mut [f32], r: &mut [f32], semitones: f32) {
    let wl = window_len(sample_rate);
    if mem.len() < floats(sample_rate) {
        return;
    }
    let n = l.len().min(r.len());
    let (ring, rest) = mem.split_at_mut(wl);
    let (hann, rest) = rest.split_at_mut(wl);
    let (scratch, rest) = rest.split_at_mut(wl);
    let (hist, rest) = rest.split_at_mut(4 * ORDER);
    let (a_mem, rest) = rest.split_at_mut(ORDER + 1);
    let (b_mem, rest) = rest.split_at_mut(ORDER + 1);
    if rest[1] == 0.0 {
        // First block: the window table and identity filters.
        for (i, h) in hann.iter_mut().enumerate() {
            let s = libm::sinf(core::f32::consts::PI * (i as f32 + 0.5) / wl as f32);
            *h = s * s;
        }
        a_mem.fill(0.0);
        b_mem.fill(0.0);
        a_mem[0] = 1.0;
        b_mem[0] = 1.0;
        rest[0] = 1.0;
        rest[1] = 1.0;
    }
    // The ring takes the mid signal.
    let mut w = state.w as usize % wl;
    for i in 0..n {
        ring[w] = 0.5 * (l[i] + r[i]);
        w = (w + 1) % wl;
    }
    state.w = w as u32;
    let st = super::shape::clamp(semitones, -12.0, 12.0);
    if st.abs() < 1e-3 {
        // Passthrough: the histories follow the signal (an identity's would equal its input).
        for (c, ch) in [&*l, &*r].into_iter().enumerate() {
            let h = &mut hist[c * 2 * ORDER..(c + 1) * 2 * ORDER];
            for i in 0..ORDER.min(n) {
                let v = ch[n - 1 - i];
                h[i] = v;
                h[ORDER + i] = v;
            }
        }
        return;
    }
    // Analysis: windowed autocorrelation of the ring (oldest first).
    for i in 0..wl {
        scratch[i] = ring[(w + i) % wl] * hann[i];
    }
    let mut rr = [0.0f64; ORDER + 1];
    for (k, out) in rr.iter_mut().enumerate() {
        let mut acc = 0.0f64;
        for i in k..wl {
            acc += scratch[i] as f64 * scratch[i - k] as f64;
        }
        *out = acc;
    }
    if rr[0] > 1e-12 {
        rr[0] *= 1.0 + 1e-4;
        let mut a = [0.0f64; ORDER + 1];
        let ea = levinson(&rr, &mut a);
        if ea > 0.0 {
            // The envelope read at ω / k, on the grid, as an autocorrelation.
            let k = libm::exp2(st as f64 / 12.0);
            let mut rt = [0.0f64; ORDER + 1];
            let pi = core::f64::consts::PI;
            for j in 0..GRID {
                let wj = pi * (j as f64 + 0.5) / GRID as f64;
                let wq = (wj / k).min(pi);
                let (cq, sq) = (libm::cos(wq), libm::sin(wq));
                // A(e^{jω'}) = Σ a_n e^{-jnω'}, by rotation.
                let (mut pr, mut pim) = (1.0f64, 0.0f64);
                let (mut ar, mut ai) = (0.0f64, 0.0f64);
                for an in a.iter() {
                    ar += an * pr;
                    ai += an * pim;
                    let npr = pr * cq + pim * sq;
                    pim = pim * cq - pr * sq;
                    pr = npr;
                }
                let p = ea / (ar * ar + ai * ai).max(1e-30);
                // cos(m·ωj) by the Chebyshev recurrence.
                let c1 = libm::cos(wj);
                let (mut cm1, mut cm) = (1.0f64, c1);
                rt[0] += p;
                for m in 1..=ORDER {
                    rt[m] += p * cm;
                    let next = 2.0 * c1 * cm - cm1;
                    cm1 = cm;
                    cm = next;
                }
            }
            rt[0] *= 1.0 + 1e-4;
            let mut b = [0.0f64; ORDER + 1];
            let eb = levinson(&rt, &mut b) / GRID as f64;
            if eb > 0.0 {
                for i in 0..=ORDER {
                    a_mem[i] = a[i] as f32;
                    b_mem[i] = b[i] as f32;
                }
                rest[0] = libm::sqrt(eb / ea) as f32;
            }
        }
    }
    let gain = rest[0] as f64;
    // Resynthesis per channel: e = A·x, y = gain·e / B. Histories newest first.
    for (c, ch) in [l, r].into_iter().enumerate() {
        let h = &mut hist[c * 2 * ORDER..(c + 1) * 2 * ORDER];
        let mut xh = [0.0f64; ORDER];
        let mut yh = [0.0f64; ORDER];
        for i in 0..ORDER {
            xh[i] = h[i] as f64;
            yh[i] = h[ORDER + i] as f64;
        }
        for v in ch[..n].iter_mut() {
            let x = *v as f64;
            let mut e = x;
            for j in 0..ORDER {
                e += a_mem[j + 1] as f64 * xh[j];
            }
            let mut y = gain * e;
            for j in 0..ORDER {
                y -= b_mem[j + 1] as f64 * yh[j];
            }
            if !y.is_finite() {
                y = 0.0;
            }
            xh.copy_within(0..ORDER - 1, 1);
            xh[0] = x;
            yh.copy_within(0..ORDER - 1, 1);
            yh[0] = y;
            *v = y as f32;
        }
        for i in 0..ORDER {
            h[i] = xh[i] as f32;
            h[ORDER + i] = if yh[i].abs() > 1e-30 { yh[i] as f32 } else { 0.0 };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A buzz (harmonics of 150 Hz) through a resonance at `f` Hz.
    fn vowel(sr: f32, f: f32, frames: usize) -> Vec<f32> {
        let mut bq = crate::biquad::Biquad::default();
        let mut x: Vec<f32> = (0..frames).map(|i| if i % (sr as usize / 150) == 0 { 1.0 } else { 0.0 }).collect();
        let c = super::super::eq::bandpass(sr, f, 8.0);
        bq.coefficients = c;
        bq.last = [9.0, f, 8.0];
        let mut y = x.clone();
        for (a, b) in x.chunks_mut(128).zip(y.chunks_mut(128)) {
            bq.process(a, b);
        }
        x
    }

    /// The spectral centroid of `x` (a crude DFT over 32 bands up to 8 kHz).
    fn centroid(x: &[f32], sr: f32) -> f32 {
        let mut num = 0.0f32;
        let mut den = 0.0f32;
        for band in 1..64 {
            let f = band as f32 * 125.0;
            let (mut re, mut im) = (0.0f32, 0.0f32);
            for (i, v) in x.iter().enumerate() {
                let ph = core::f32::consts::TAU * f * i as f32 / sr;
                re += v * libm::cosf(ph);
                im += v * libm::sinf(ph);
            }
            let m = re * re + im * im;
            num += f * m;
            den += m;
        }
        num / den
    }

    fn run(st: f32) -> Vec<f32> {
        let sr = 48_000.0;
        let input = vowel(sr, 1_000.0, 128 * 120);
        let mut mem = vec![0.0f32; floats(sr)];
        let mut s = FormantState::default();
        let mut out = Vec::new();
        for chunk in input.chunks(128) {
            let mut l = chunk.to_vec();
            let mut r = chunk.to_vec();
            process(&mut s, &mut mem, sr, &mut l, &mut r, st);
            assert_eq!(l, r);
            out.extend_from_slice(&l);
        }
        out
    }

    #[test]
    fn a_shift_up_raises_the_envelope_and_zero_passes_through() {
        let sr = 48_000.0;
        let dry = run(0.0);
        assert_eq!(dry, vowel(sr, 1_000.0, 128 * 120), "0 st is the identity");
        let up = run(7.0);
        let down = run(-7.0);
        assert!(up.iter().chain(down.iter()).all(|x| x.is_finite() && x.abs() < 50.0));
        let (c0, cu, cd) = (centroid(&dry[6_000..], sr), centroid(&up[6_000..], sr), centroid(&down[6_000..], sr));
        assert!(cu > c0 * 1.15, "up {cu} vs {c0}");
        assert!(cd < c0 * 0.9, "down {cd} vs {c0}");
    }
}
