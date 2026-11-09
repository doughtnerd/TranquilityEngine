// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Real FFTs for the HRTF code on `microfft`, in the packed layout Blink's `FFTFrame` uses (and
//! microfft produces): `n / 2` complex bins, bin 0 holding DC in `re` and Nyquist in `im`. The
//! forward transform is unscaled; the inverse scales by `1 / n`, so a round trip is the identity
//! (the same conventions as `FFTFrame` over RustFFT at the pinned commit).
//!
//! Sizes are powers of two from 32 to [`MAX_FFT_SIZE`] (1024). The inverse runs microfft's
//! `n / 2`-point complex inverse on the even/odd split of the spectrum, which needs the twiddles
//! in [`Twiddles`] (built once, outside the process path). Nothing here allocates; an unsupported
//! size does nothing (an empty result) rather than panic.

use microfft::Complex32;

use super::MAX_FFT_SIZE;

/// `0.5 * exp(-2πik / 1024)` for k in 0..512: the inverse transform's twiddles for size `n` are
/// every `1024 / n`-th entry.
#[derive(Clone)]
pub struct Twiddles {
    w: [Complex32; MAX_FFT_SIZE / 2],
}

impl Twiddles {
    /// Builds the table with `libm` (not in the process path).
    pub fn new() -> Self {
        let mut w = [Complex32 { re: 0.0, im: 0.0 }; MAX_FFT_SIZE / 2];
        for (k, c) in w.iter_mut().enumerate() {
            let angle = -2.0 * core::f64::consts::PI * (k as f64) / (MAX_FFT_SIZE as f64);
            *c = Complex32 { re: (0.5 * libm::cos(angle)) as f32, im: (0.5 * libm::sin(angle)) as f32 };
        }
        Self { w }
    }
}

impl Default for Twiddles {
    fn default() -> Self {
        Self::new()
    }
}

/// Forward real FFT of `buf[..n]` in place, `n = buf.len()` (a power of two, 32..=1024). Returns
/// the `n / 2` packed bins, which alias `buf`.
pub fn rfft(buf: &mut [f32]) -> &mut [Complex32] {
    use microfft::real::*;
    macro_rules! go {
        ($f:ident) => {
            match buf.try_into() {
                Ok(a) => &mut $f(a)[..],
                Err(_) => &mut [],
            }
        };
    }
    match buf.len() {
        32 => go!(rfft_32),
        64 => go!(rfft_64),
        128 => go!(rfft_128),
        256 => go!(rfft_256),
        512 => go!(rfft_512),
        1024 => go!(rfft_1024),
        _ => &mut [],
    }
}

/// microfft's normalised complex inverse of `buf.len()` points (16..=512), in place.
fn ifft(buf: &mut [Complex32]) {
    use microfft::inverse::*;
    macro_rules! go {
        ($f:ident) => {
            if let Ok(a) = buf.try_into() {
                let _ = $f(a);
            }
        };
    }
    match buf.len() {
        16 => go!(ifft_16),
        32 => go!(ifft_32),
        64 => go!(ifft_64),
        128 => go!(ifft_128),
        256 => go!(ifft_256),
        512 => go!(ifft_512),
        _ => {}
    }
}

/// Inverse of [`rfft`]: the `n / 2` packed bins in `spec` to `out[..n]`, scaled by `1 / n`.
/// `work` holds at least `n / 2` bins.
pub fn irfft(spec: &[Complex32], out: &mut [f32], work: &mut [Complex32], twiddles: &Twiddles) {
    let half = spec.len();
    let n = 2 * half;
    if !(32..=MAX_FFT_SIZE).contains(&n) || !n.is_power_of_two() || out.len() < n || work.len() < half {
        return;
    }
    let stride = MAX_FFT_SIZE / n;
    let z = &mut work[..half];
    // Even/odd split: z[k] = Fe[k] + i Fo[k], where x[2m] + i x[2m+1] has spectrum z.
    let (r0, i0) = (spec[0].re, spec[0].im);
    z[0] = Complex32 { re: 0.5 * (r0 + i0), im: 0.5 * (r0 - i0) };
    let limit = (half - 1) / 2;
    for k in 1..=limit {
        let x_k = spec[k];
        let x_mk_conj = spec[half - k].conj();
        let f_even = (x_k + x_mk_conj) * 0.5;
        let f_odd = twiddles.w[k * stride].conj() * (x_k - x_mk_conj);
        let i_f_odd = Complex32 { re: -f_odd.im, im: f_odd.re };
        z[k] = f_even + i_f_odd;
        z[half - k] = (f_even - i_f_odd).conj();
    }
    let mid = half / 2;
    z[mid] = Complex32 { re: spec[mid].re, im: -spec[mid].im };
    ifft(z);
    for (m, c) in z.iter().enumerate() {
        out[2 * m] = c.re;
        out[2 * m + 1] = c.im;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(n: usize) -> Vec<f32> {
        (0..n).map(|i| libm::sinf(i as f32 * 0.37) + 0.25 * libm::cosf(i as f32 * 1.91) + 0.1).collect()
    }

    #[test]
    fn rfft_matches_a_naive_dft_in_the_packed_layout() {
        for n in [32usize, 256, 1024] {
            let x = signal(n);
            let mut buf = x.clone();
            let spec = rfft(&mut buf).to_vec();
            assert_eq!(spec.len(), n / 2);
            for k in 0..=n / 2 {
                let (mut re, mut im) = (0.0f64, 0.0f64);
                for (j, v) in x.iter().enumerate() {
                    let a = -2.0 * core::f64::consts::PI * (k * j) as f64 / n as f64;
                    re += *v as f64 * libm::cos(a);
                    im += *v as f64 * libm::sin(a);
                }
                let (got_re, got_im) = match k {
                    0 => (spec[0].re as f64, 0.0),
                    k if k == n / 2 => (spec[0].im as f64, 0.0),
                    k => (spec[k].re as f64, spec[k].im as f64),
                };
                let tol = 1e-4 * n as f64;
                assert!((got_re - re).abs() < tol && (got_im - im).abs() < tol, "n {n} k {k}");
            }
        }
    }

    #[test]
    fn irfft_inverts_rfft() {
        let tw = Twiddles::new();
        for n in [32usize, 64, 128, 256, 512, 1024] {
            let x = signal(n);
            let mut buf = x.clone();
            let spec = rfft(&mut buf).to_vec();
            let mut out = vec![0.0f32; n];
            let mut work = vec![Complex32::default(); n / 2];
            irfft(&spec, &mut out, &mut work, &tw);
            for (a, b) in x.iter().zip(&out) {
                assert!((a - b).abs() < 1e-5, "n {n}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn unsupported_sizes_do_nothing() {
        let mut buf = [1.0f32; 48];
        assert!(rfft(&mut buf).is_empty());
    }
}
