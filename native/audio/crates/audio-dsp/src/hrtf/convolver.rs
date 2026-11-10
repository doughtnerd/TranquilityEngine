// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Uniform partitioned convolution for the HRTF panner (api-and-models §5): 128-frame partitions,
//! overlap-save on `microfft`'s 256-point real FFT. It replaces Blink's `FFTConvolver` (512-point,
//! 256-frame blocks) and is Myco's own code, not a port.
//!
//! Each ear keeps an [`EarInput`]: the previous input block and a frequency-domain delay line of
//! the last `P` input spectra. Pushing a quantum costs one 256-point FFT; convolving it with a
//! kernel costs `partitions` complex multiply-adds over 128 bins and one inverse FFT. Both kernel
//! sets of a panner share their ear's delay line, so a set that resumes after sitting idle filters
//! the true input history. Output frame `n` is the linear convolution of the input with the kernel
//! at frame `n`: no latency. Nothing here allocates.

use microfft::Complex32;

use super::fft::{irfft, rfft};
use super::kernel::HrtfScratch;
use super::{MAX_PARTITIONS, PARTITION_BINS, PARTITION_FFT_SIZE, QUANTUM_FRAMES};

const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// One ear's input history for kernels of up to `P` partitions.
#[derive(Clone, Copy)]
pub struct EarInput<const P: usize = MAX_PARTITIONS> {
    /// Spectra of the input frames `[block - 1, block]` for the newest `P` blocks, in a ring;
    /// `newest` indexes the latest.
    spectra: [[Complex32; PARTITION_BINS]; P],
    newest: usize,
    previous: [f32; QUANTUM_FRAMES],
}

impl<const P: usize> EarInput<P> {
    pub const ZERO: Self = Self { spectra: [[ZERO_BIN; PARTITION_BINS]; P], newest: 0, previous: [0.0; QUANTUM_FRAMES] };

    /// Clears the history (silence before now).
    pub fn reset(&mut self) {
        *self = Self::ZERO;
    }

    /// Appends one quantum of input: transforms `[previous, block]` into the newest slot.
    pub fn push(&mut self, block: &[f32; QUANTUM_FRAMES], scratch: &mut HrtfScratch) {
        self.view().push(block, scratch);
    }

    /// The history with its partition count erased (the panner's one process path, H3).
    pub(crate) fn view(&mut self) -> EarView<'_> {
        EarView { spectra: &mut self.spectra, newest: &mut self.newest, previous: &mut self.previous }
    }
}

/// An [`EarInput`] of any `P`, borrowed: what the panner's process path uses, so the wasm carries
/// it once rather than once per partition count (H3).
pub(crate) struct EarView<'a> {
    spectra: &'a mut [[Complex32; PARTITION_BINS]],
    newest: &'a mut usize,
    previous: &'a mut [f32; QUANTUM_FRAMES],
}

impl EarView<'_> {
    /// [`EarInput::push`].
    pub(crate) fn push(&mut self, block: &[f32; QUANTUM_FRAMES], scratch: &mut HrtfScratch) {
        let p = self.spectra.len();
        if p == 0 {
            return;
        }
        let HrtfScratch { block: buf, work, twiddles, .. } = scratch;
        buf[..QUANTUM_FRAMES].copy_from_slice(&self.previous[..]);
        buf[QUANTUM_FRAMES..].copy_from_slice(block);
        *self.previous = *block;
        *self.newest = (*self.newest + 1) % p;
        self.spectra[*self.newest].copy_from_slice(rfft(buf, work, twiddles));
    }

    /// [`convolve`] on this history.
    pub(crate) fn convolve(&self, kernel: &[[Complex32; PARTITION_BINS]], partitions: usize, scratch: &mut HrtfScratch, out: &mut [f32; QUANTUM_FRAMES]) {
        convolve_ring(self.spectra, *self.newest, kernel, partitions, scratch, out);
    }
}

impl<const P: usize> Default for EarInput<P> {
    fn default() -> Self {
        Self::ZERO
    }
}

/// Convolves the latest quantum: `sum over k < partitions of spectra[newest - k] * kernel[k]`,
/// inverse-transformed, last 128 frames into `out`. `partitions` is capped at `P` and
/// `kernel.len()`.
pub fn convolve<const P: usize>(
    input: &EarInput<P>,
    kernel: &[[Complex32; PARTITION_BINS]],
    partitions: usize,
    scratch: &mut HrtfScratch,
    out: &mut [f32; QUANTUM_FRAMES],
) {
    convolve_ring(&input.spectra, input.newest, kernel, partitions, scratch, out);
}

/// [`convolve`] over the ring as a slice, so the wasm carries one copy for every `P` (H3).
#[inline(never)]
fn convolve_ring(
    spectra: &[[Complex32; PARTITION_BINS]],
    newest: usize,
    kernel: &[[Complex32; PARTITION_BINS]],
    partitions: usize,
    scratch: &mut HrtfScratch,
    out: &mut [f32; QUANTUM_FRAMES],
) {
    let p = spectra.len();
    let HrtfScratch { spectrum, time_a, work, twiddles, .. } = scratch;
    let acc = &mut spectrum[..PARTITION_BINS];
    acc.fill(ZERO_BIN);
    for (k, h) in kernel.iter().take(partitions.min(p)).enumerate() {
        let x = &spectra[(newest + p - k) % p];
        // Bin 0 packs two real values: DC in re, Nyquist in im.
        acc[0].re += x[0].re * h[0].re;
        acc[0].im += x[0].im * h[0].im;
        for b in 1..PARTITION_BINS {
            acc[b] += x[b] * h[b];
        }
    }
    irfft(acc, &mut time_a[..PARTITION_FFT_SIZE], &mut work[..PARTITION_BINS], twiddles);
    out.copy_from_slice(&time_a[QUANTUM_FRAMES..PARTITION_FFT_SIZE]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hrtf::kernel::partition_response;

    fn noise(n: usize, mut s: u32) -> Vec<f32> {
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                (s as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect()
    }

    fn check(taps: usize) {
        let mut scratch = HrtfScratch::new();
        let h = noise(taps, 7);
        let mut kernel = [[ZERO_BIN; PARTITION_BINS]; MAX_PARTITIONS];
        let parts = partition_response(&h, &mut scratch, &mut kernel);
        let x = noise(QUANTUM_FRAMES * 9, 99);
        let mut input = EarInput::<MAX_PARTITIONS>::ZERO;
        let mut out = [0.0f32; QUANTUM_FRAMES];
        for q in 0..9 {
            let block: &[f32; QUANTUM_FRAMES] = x[q * QUANTUM_FRAMES..(q + 1) * QUANTUM_FRAMES].try_into().unwrap();
            input.push(block, &mut scratch);
            convolve(&input, &kernel, parts, &mut scratch, &mut out);
            for (i, got) in out.iter().enumerate() {
                let n = q * QUANTUM_FRAMES + i;
                let want: f64 = (0..taps.min(n + 1)).map(|m| h[m] as f64 * x[n - m] as f64).sum();
                assert!((*got as f64 - want).abs() < 1e-4, "taps {taps} n {n}: {got} vs {want}");
            }
        }
    }

    #[test]
    fn matches_direct_convolution() {
        for taps in [16, 128, 256, 512] {
            check(taps);
        }
    }
}
