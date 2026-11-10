// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Real FFTs for the HRTF code, in the packed layout Blink's `FFTFrame` uses: `n / 2` complex bins,
//! bin 0 holding DC in `re` and Nyquist in `im`. The forward transform is unscaled; the inverse
//! scales by `1 / n`, so a round trip is the identity (the same conventions as `FFTFrame` over
//! RustFFT at the pinned commit).
//!
//! Sizes are powers of two from 32 to [`MAX_FFT_SIZE`] (1024): 256 for the partitions, and the
//! kernel's `fft_size` (64 at 8 kHz up to 1,024 at 96 kHz) for interpolated kernels.
//!
//! **Built on the reverb's complex FFT** (`convolver::fft::cfft`, H3), which runs microfft's
//! 16-point transform from one call site plus radix-2 passes. microfft instantiates and inlines each
//! size's whole recursion, so H1's run-time dispatch over `rfft_32 ..= rfft_1024` and
//! `ifft_16 ..= ifft_512` cost about 28 KB of wasm against the mixer's 150 KB gate (A2.2b's
//! measurement); sharing the reverb's transform costs nothing more. Written here: the real transform
//! of `2h` points from the complex one of `h` points (even/odd packing and its split), and the
//! inverse through the conjugate of the forward transform.
//!
//! Twiddles are the reverb's table, `exp(-2πik / 4096)` for k in 0..2048 ([`Twiddles`], 16 KB,
//! built once outside the process path); a size `n` takes every `4096 / n`-th entry. Nothing here
//! allocates; an unsupported size does nothing (an empty result) rather than panic.

use microfft::Complex32;

use super::MAX_FFT_SIZE;
use crate::convolver::fft::{self as cfft, cfft};

/// The twiddle table (`convolver::fft`'s): `exp(-2πik / 4096)` for k in 0..2048.
#[derive(Clone)]
pub struct Twiddles {
    w: cfft::Twiddles,
}

impl Twiddles {
    /// Builds the table with `libm` (not in the process path).
    pub fn new() -> Self {
        let mut w = [Complex32 { re: 0.0, im: 0.0 }; cfft::BINS];
        cfft::twiddles(&mut w);
        Self { w }
    }
}

impl Default for Twiddles {
    fn default() -> Self {
        Self::new()
    }
}

/// Views `n` floats as `n / 2` complex values.
fn as_complex(buf: &mut [f32]) -> &mut [Complex32] {
    // SAFETY: `Complex32` is `#[repr(C)] { re: f32, im: f32 }`: `2h` floats are `h` of them, and
    // f32 alignment is Complex32 alignment.
    unsafe { core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut Complex32, buf.len() / 2) }
}

fn supported(n: usize) -> bool {
    (32..=MAX_FFT_SIZE).contains(&n) && n.is_power_of_two()
}

/// Forward real FFT of `buf[..n]` in place, `n = buf.len()` (a power of two, 32..=1024). Returns
/// the `n / 2` packed bins, which alias `buf`. `work` holds at least `n / 2` bins.
pub fn rfft<'a>(buf: &'a mut [f32], work: &mut [Complex32], w: &Twiddles) -> &'a mut [Complex32] {
    let n = buf.len();
    if !supported(n) || work.len() < n / 2 {
        return &mut [];
    }
    let h = n / 2;
    let z = as_complex(buf);
    cfft(z, work, &w.w);
    let stride = cfft::SIZE / n;
    let z0 = z[0];
    z[0] = Complex32 { re: z0.re + z0.im, im: z0.re - z0.im };
    for k in 1..h / 2 {
        let a = z[k];
        let b = z[h - k].conj();
        let even = (a + b) * 0.5;
        let o = (a - b) * 0.5;
        // W^k * Fo[k], with Fo[k] = o / i.
        let t = w.w[k * stride] * Complex32 { re: o.im, im: -o.re };
        z[k] = even + t;
        z[h - k] = (even - t).conj();
    }
    z[h / 2] = z[h / 2].conj();
    z
}

/// Inverse of [`rfft`]: the `n / 2` packed bins in `spec` to `out[..n]`, scaled by `1 / n`.
/// `work` holds at least `n / 2` bins; `spec` must not alias `out`.
pub fn irfft(spec: &[Complex32], out: &mut [f32], work: &mut [Complex32], w: &Twiddles) {
    let h = spec.len();
    let n = 2 * h;
    if !supported(n) || out.len() < n || work.len() < h {
        return;
    }
    let z = as_complex(&mut out[..n]);
    let stride = cfft::SIZE / n;
    // Even/odd split, conjugated for the inverse: z[k] = conj(Fe[k] + i Fo[k]).
    let (r0, i0) = (spec[0].re, spec[0].im);
    z[0] = Complex32 { re: 0.5 * (r0 + i0), im: -0.5 * (r0 - i0) };
    for k in 1..h / 2 {
        let x_k = spec[k];
        let x_mk_conj = spec[h - k].conj();
        let f_even = (x_k + x_mk_conj) * 0.5;
        let f_odd = w.w[k * stride].conj() * (x_k - x_mk_conj) * 0.5;
        let i_f_odd = Complex32 { re: -f_odd.im, im: f_odd.re };
        z[k] = (f_even + i_f_odd).conj();
        z[h - k] = f_even - i_f_odd;
    }
    z[h / 2] = spec[h / 2];
    // ifft(v) = conj(fft(conj(v))) / h; `z` is `out` itself, so this writes in place.
    cfft(z, work, &w.w);
    let scale = 1.0 / h as f32;
    for c in z.iter_mut() {
        *c = Complex32 { re: c.re * scale, im: -c.im * scale };
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
        let tw = Twiddles::new();
        let mut work = vec![Complex32::default(); MAX_FFT_SIZE / 2];
        for n in [32usize, 64, 256, 512, 1024] {
            let x = signal(n);
            let mut buf = x.clone();
            let spec = rfft(&mut buf, &mut work, &tw).to_vec();
            assert_eq!(spec.len(), n / 2);
            for k in 0..=n / 2 {
                let (mut re, mut im) = (0.0f64, 0.0f64);
                for (j, v) in x.iter().enumerate() {
                    let a = -2.0 * core::f64::consts::PI * ((k * j) % n) as f64 / n as f64;
                    re += *v as f64 * libm::cos(a);
                    im += *v as f64 * libm::sin(a);
                }
                let (got_re, got_im) = match k {
                    0 => (spec[0].re as f64, 0.0),
                    k if k == n / 2 => (spec[0].im as f64, 0.0),
                    k => (spec[k].re as f64, spec[k].im as f64),
                };
                let tol = 2e-5 * n as f64;
                assert!((got_re - re).abs() < tol && (got_im - im).abs() < tol, "n {n} k {k}");
            }
        }
    }

    #[test]
    fn irfft_inverts_rfft() {
        let tw = Twiddles::new();
        let mut work = vec![Complex32::default(); MAX_FFT_SIZE / 2];
        for n in [32usize, 64, 128, 256, 512, 1024] {
            let x = signal(n);
            let mut buf = x.clone();
            let spec = rfft(&mut buf, &mut work, &tw).to_vec();
            let mut out = vec![0.0f32; n];
            irfft(&spec, &mut out, &mut work, &tw);
            for (a, b) in x.iter().zip(&out) {
                assert!((a - b).abs() < 1e-5, "n {n}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn unsupported_sizes_do_nothing() {
        let tw = Twiddles::new();
        let mut work = vec![Complex32::default(); MAX_FFT_SIZE / 2];
        let mut buf = [1.0f32; 48];
        assert!(rfft(&mut buf, &mut work, &tw).is_empty());
        let mut buf = [1.0f32; 16];
        assert!(rfft(&mut buf, &mut work, &tw).is_empty());
    }
}
