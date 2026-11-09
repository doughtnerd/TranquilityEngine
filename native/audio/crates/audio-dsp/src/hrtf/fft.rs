// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Real FFTs for the HRTF code on `microfft`, in the packed layout Blink's `FFTFrame` uses (and
//! microfft produces): `n / 2` complex bins, bin 0 holding DC in `re` and Nyquist in `im`. The
//! forward transform is unscaled; the inverse scales by `1 / n`, so a round trip is the identity
//! (the same conventions as `FFTFrame` over RustFFT at the pinned commit).
//!
//! Sizes are powers of two from 32 to [`MAX_FFT_SIZE`] (1024). The inverse runs microfft's
//! `n / 2`-point complex inverse on the even/odd split of the spectrum, which needs the twiddles
//! in [`Twiddles`] (built once, outside the process path). Nothing here allocates.

#![allow(dead_code)] // skeleton: the H1 core removes this

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
        todo!("H1-core")
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
    let _ = buf;
    todo!("H1-core")
}

/// Inverse of [`rfft`]: the `n / 2` packed bins in `spec` to `out[..n]`, scaled by `1 / n`.
/// `work` holds at least `n / 2` bins.
pub fn irfft(spec: &[Complex32], out: &mut [f32], work: &mut [Complex32], twiddles: &Twiddles) {
    let _ = (spec, out, work, twiddles);
    todo!("H1-core")
}
