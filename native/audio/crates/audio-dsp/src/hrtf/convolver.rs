// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Uniform partitioned convolution for the HRTF panner (api-and-models §5): 128-frame partitions,
//! overlap-save on `microfft`'s 256-point real FFT. It replaces Blink's `FFTConvolver` (512-point,
//! 256-frame blocks) and is Myco's own code, not a port.
//!
//! Each ear keeps an [`EarInput`]: the previous input block and a frequency-domain delay line of
//! the last `MAX_PARTITIONS` input spectra. Pushing a quantum costs one 256-point FFT; convolving
//! it with a kernel costs `partitions` complex multiply-adds over 128 bins and one inverse FFT.
//! Both kernel sets of a panner share their ear's delay line, so a set that resumes after sitting
//! idle filters the true input history. Output frame `n` is the linear convolution of the input
//! with the kernel at frame `n`: no latency. Nothing here allocates.

use microfft::Complex32;

use super::kernel::{HrtfScratch, KernelSpectra};
use super::{MAX_PARTITIONS, PARTITION_BINS, QUANTUM_FRAMES};

/// One ear's input history.
#[derive(Clone, Copy)]
pub struct EarInput {
    /// Spectra of the input frames `[block - 1, block]` for the newest `MAX_PARTITIONS` blocks,
    /// in a ring; `newest` indexes the latest.
    spectra: [[Complex32; PARTITION_BINS]; MAX_PARTITIONS],
    newest: usize,
    previous: [f32; QUANTUM_FRAMES],
}

impl EarInput {
    pub const ZERO: Self = Self {
        spectra: [[Complex32 { re: 0.0, im: 0.0 }; PARTITION_BINS]; MAX_PARTITIONS],
        newest: 0,
        previous: [0.0; QUANTUM_FRAMES],
    };

    /// Clears the history (silence before now).
    pub fn reset(&mut self) {
        *self = Self::ZERO;
    }

    /// Appends one quantum of input: transforms `[previous, block]` into the newest slot.
    pub fn push(&mut self, block: &[f32; QUANTUM_FRAMES], scratch: &mut HrtfScratch) {
        let _ = (block, scratch, &self.spectra, self.newest, &self.previous);
        todo!("H1-core")
    }
}

impl Default for EarInput {
    fn default() -> Self {
        Self::ZERO
    }
}

/// Convolves the latest quantum: `sum over k < partitions of spectra[newest - k] * kernel[k]`,
/// inverse-transformed, last 128 frames into `out`.
pub fn convolve(input: &EarInput, kernel: &KernelSpectra, partitions: usize, scratch: &mut HrtfScratch, out: &mut [f32; QUANTUM_FRAMES]) {
    let _ = (input, kernel, partitions, scratch, out);
    todo!("H1-core")
}
