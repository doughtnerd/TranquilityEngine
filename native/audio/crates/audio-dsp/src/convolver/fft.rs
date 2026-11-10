// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The reverb's real FFTs, 256 points (head) and 4,096 points (tail), built on one `microfft`
//! transform: the 16-point complex FFT. The layout is `hrtf::fft`'s (and Blink's `FFTFrame`'s):
//! `n / 2` complex bins, bin 0 holding DC in `re` and Nyquist in `im`; the forward transform
//! unscaled, the inverse scaled by `1 / n`, so a round trip is the identity.
//!
//! **Why not `microfft::real::rfft_4096`.** microfft instantiates and inlines every size's whole
//! radix-2 recursion: `rfft_4096` with `ifft_2048` added 92 KB of wasm, `rfft_256` with `ifft_128`
//! 13 KB, and `hrtf::fft`'s run-time size dispatch 28 KB, against a gate of 150 KB for the whole
//! mixer (measured on the A2.1 tree, `+simd128`, release). So microfft computes the 16-point
//! complex transforms, from a single non-inlined call site (1.5 KB; a 128-point base costs 16 KB
//! more for no measurable speed-up), and the rest is written here:
//! - a complex FFT of `16 * 2^p` points: the 16-point sub-transforms of the bit-reversed
//!   decimation, then the remaining radix-2 butterfly passes (the levels microfft would unroll);
//! - the real transform of `2h` points from the complex one of `h` points (even/odd packing and
//!   its split), and the inverse through the conjugate of the forward transform.
//!
//! Twiddles come from one table, `exp(-2πik / 4096)` for k in 0..2048 (built by `init` with
//! `libm`, kept in the convolver's region); a size `n` takes every `4096 / n`-th entry. Nothing
//! here allocates; a buffer of the wrong size does nothing.

use microfft::Complex32;

/// Points of the tail's transform.
pub const SIZE: usize = 4096;
/// Packed bins of the tail's transform.
pub const BINS: usize = SIZE / 2;
/// The complex size microfft computes.
const BASE: usize = 16;
/// Points of the head's transform.
pub const HEAD_SIZE: usize = 256;

/// `exp(-2πik / 4096)` for k in 0..2048.
pub type Twiddles = [Complex32; BINS];

/// Fills `w` (`libm`; not in the process path).
pub fn twiddles(w: &mut Twiddles) {
    for (k, c) in w.iter_mut().enumerate() {
        let angle = -2.0 * core::f64::consts::PI * (k as f64) / (SIZE as f64);
        *c = Complex32 { re: libm::cos(angle) as f32, im: libm::sin(angle) as f32 };
    }
}

/// microfft's 16-point forward transform, from one call site.
#[inline(never)]
fn cfft_base(x: &mut [Complex32]) {
    if let Ok(a) = <&mut [Complex32; BASE]>::try_from(x) {
        let _ = microfft::complex::cfft_16(a);
    }
}

/// Forward complex FFT of `x` in place (unscaled); `x.len()` is `16 * 2^p` up to 2,048, and
/// `work` holds at least as many bins. `hrtf::fft` builds its real transforms on it too (H3), so
/// the mixer carries one copy.
pub(crate) fn cfft(x: &mut [Complex32], work: &mut [Complex32], w: &Twiddles) {
    let n = x.len();
    if n == BASE {
        cfft_base(x);
        return;
    }
    if !(n.is_power_of_two() && n > BASE && n <= BINS && work.len() >= n) {
        return;
    }
    let work = &mut work[..n];
    // Decimation in time: block b holds the 16-point transform of x[groups * m + rev(b)].
    let groups = n / BASE;
    let bits = groups.trailing_zeros();
    for b in 0..groups {
        let r = b.reverse_bits() >> (usize::BITS - bits);
        let block = &mut work[b * BASE..(b + 1) * BASE];
        for (m, y) in block.iter_mut().enumerate() {
            *y = x[groups * m + r];
        }
        cfft_base(block);
    }
    // The remaining levels: butterflies of span s with twiddles exp(-2πik / s).
    let mut s = 2 * BASE;
    while s <= n {
        let half = s / 2;
        let stride = SIZE / s;
        for group in work.chunks_exact_mut(s) {
            let (lo, hi) = group.split_at_mut(half);
            for (k, (a, b)) in lo.iter_mut().zip(hi.iter_mut()).enumerate() {
                let t = w[k * stride] * *b;
                *b = *a - t;
                *a += t;
            }
        }
        s *= 2;
    }
    x.copy_from_slice(work);
}

/// Forward real FFT of `buf` (256 or 4,096 points) in place; returns the `n / 2` packed bins,
/// which alias `buf`. `work` holds at least `n / 2` bins.
pub fn rfft<'a>(buf: &'a mut [f32], work: &mut [Complex32], w: &Twiddles) -> &'a mut [Complex32] {
    let n = buf.len();
    if !(n == HEAD_SIZE || n == SIZE) {
        return &mut [];
    }
    let h = n / 2;
    // SAFETY: `Complex32` is `#[repr(C)] { re: f32, im: f32 }`: `n` floats are `n / 2` of them,
    // and f32 alignment is Complex32 alignment.
    let z = unsafe { core::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut Complex32, h) };
    cfft(z, work, w);
    let stride = SIZE / n;
    let z0 = z[0];
    z[0] = Complex32 { re: z0.re + z0.im, im: z0.re - z0.im };
    for k in 1..h / 2 {
        let a = z[k];
        let b = z[h - k].conj();
        let even = (a + b) * 0.5;
        let o = (a - b) * 0.5;
        // W^k * Fo[k], with Fo[k] = o / i.
        let t = w[k * stride] * Complex32 { re: o.im, im: -o.re };
        z[k] = even + t;
        z[h - k] = (even - t).conj();
    }
    z[h / 2] = z[h / 2].conj();
    z
}

/// Inverse of [`rfft`]: the `n / 2` packed bins of `spec` to `out[..n]` (256 or 4,096 points),
/// scaled by `1 / n`. `z` and `work` hold at least `n / 2` bins each.
pub fn irfft(spec: &[Complex32], out: &mut [f32], z: &mut [Complex32], work: &mut [Complex32], w: &Twiddles) {
    let h = spec.len();
    let n = 2 * h;
    if !(n == HEAD_SIZE || n == SIZE) || out.len() < n || z.len() < h {
        return;
    }
    let z = &mut z[..h];
    let stride = SIZE / n;
    // Even/odd split, conjugated for the inverse: z[k] = conj(Fe[k] + i Fo[k]).
    let (r0, i0) = (spec[0].re, spec[0].im);
    z[0] = Complex32 { re: 0.5 * (r0 + i0), im: -0.5 * (r0 - i0) };
    for k in 1..h / 2 {
        let x_k = spec[k];
        let x_mk_conj = spec[h - k].conj();
        let f_even = (x_k + x_mk_conj) * 0.5;
        let f_odd = w[k * stride].conj() * (x_k - x_mk_conj) * 0.5;
        let i_f_odd = Complex32 { re: -f_odd.im, im: f_odd.re };
        z[k] = (f_even + i_f_odd).conj();
        z[h - k] = f_even - i_f_odd;
    }
    z[h / 2] = spec[h / 2];
    // ifft(v) = conj(fft(conj(v))) / h.
    cfft(z, work, w);
    let scale = 1.0 / h as f32;
    for (m, c) in z.iter().enumerate() {
        out[2 * m] = c.re * scale;
        out[2 * m + 1] = -c.im * scale;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Twiddles {
        let mut w = [Complex32::default(); BINS];
        twiddles(&mut w);
        w
    }

    #[test]
    fn rfft_matches_a_naive_dft_and_irfft_inverts_it() {
        let w = table();
        let mut work = vec![Complex32::default(); BINS];
        let mut z = vec![Complex32::default(); BINS];
        for n in [256usize, SIZE] {
            let x: Vec<f32> = (0..n).map(|i| libm::sinf(i as f32 * 0.37) + 0.25 * libm::cosf(i as f32 * 1.91) + 0.1).collect();
            let mut buf = x.clone();
            let spec = rfft(&mut buf, &mut work, &w).to_vec();
            assert_eq!(spec.len(), n / 2);
            for k in [0usize, 1, 7, n / 4, n / 2 - 1, n / 2] {
                let (mut re, mut im) = (0.0f64, 0.0f64);
                for (j, v) in x.iter().enumerate() {
                    let a = -2.0 * core::f64::consts::PI * ((k * j) % n) as f64 / n as f64;
                    re += *v as f64 * a.cos();
                    im += *v as f64 * a.sin();
                }
                let (got_re, got_im) = match k {
                    0 => (spec[0].re as f64, 0.0),
                    k if k == n / 2 => (spec[0].im as f64, 0.0),
                    k => (spec[k].re as f64, spec[k].im as f64),
                };
                let tol = 2e-5 * n as f64;
                assert!((got_re - re).abs() < tol && (got_im - im).abs() < tol, "n {n} k {k}: {got_re} {got_im} vs {re} {im}");
            }
            let mut out = vec![0.0f32; n];
            irfft(&spec, &mut out, &mut z, &mut work, &w);
            for (a, b) in x.iter().zip(&out) {
                assert!((a - b).abs() < 1e-5, "n {n}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn wrong_sizes_do_nothing() {
        let w = table();
        let mut work = vec![Complex32::default(); BINS];
        let mut buf = [1.0f32; 512];
        assert!(rfft(&mut buf, &mut work, &w).is_empty());
    }
}
