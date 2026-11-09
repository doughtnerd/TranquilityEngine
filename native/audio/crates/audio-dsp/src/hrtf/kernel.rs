// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_kernel.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_kernel.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/fft_frame.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_elevation.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010 Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
//
// 1.  Redistributions of source code must retain the above copyright
//     notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//     notice, this list of conditions and the following disclaimer in the
//     documentation and/or other materials provided with the distribution.
// 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
//     its contributors may be used to endorse or promote products derived
//     from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
// THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

//! HRTF kernels on demand: ports of `HRTFKernel` (truncation, fade-out, `CreateInterpolatedKernel`),
//! `FFTFrame::CreateInterpolatedFrame`, `InterpolateFrequencyComponents`,
//! `ExtractAverageGroupDelay` and `AddConstantGroupDelay`, and the azimuth interpolation of
//! `HRTFElevation::CreateForSubject`.
//!
//! Differences from upstream:
//! - A kernel is computed when asked for, from the `format = 2` table, instead of all 3,840 at load.
//!   Its time-domain response (`fft_size / 2` taps) is cut into 128-frame partitions and each goes
//!   through a 256-point FFT ([`KernelSpectra`]), the convolver's format, instead of one
//!   `fft_size`-point frame.
//! - A raw (15°) kernel's response is the faded, truncated impulse response itself; upstream
//!   round-trips it through `DoPaddedFFT`, which changes it only by rounding.
//! - An interpolated kernel follows `CreateInterpolatedFrame`: both raw responses are padded to
//!   `fft_size` and transformed, blended by `InterpolateFrequencyComponents`, transformed back, and
//!   the second half zeroed. The port keeps the time-domain half rather than transforming again.
//! - `ExtractAverageGroupDelay` is not in the kernel path: the `format = 2` responses arrive with
//!   their delay already removed (H2 runs [`extract_average_group_delay`] before upload).
//!
//! Nothing here allocates; all buffers are in [`HrtfScratch`] or the caller's [`KernelSpectra`].

#![allow(dead_code)] // skeleton: the H1 core removes this

use microfft::Complex32;

use super::database::HrirDatabase;
use super::fft::Twiddles;
use super::{Ear, MAX_FFT_SIZE, MAX_PARTITIONS, PARTITION_BINS, PARTITION_FFT_SIZE};

/// One ear's kernel in the convolver's format: partition `k` is the 256-point packed FFT of taps
/// `128k .. 128k + 128` zero-padded to 256. Partitions past the kernel's count are unused.
#[derive(Clone, Copy)]
pub struct KernelSpectra {
    pub partitions: [[Complex32; PARTITION_BINS]; MAX_PARTITIONS],
}

impl KernelSpectra {
    pub const ZERO: Self = Self { partitions: [[Complex32 { re: 0.0, im: 0.0 }; PARTITION_BINS]; MAX_PARTITIONS] };
}

impl Default for KernelSpectra {
    fn default() -> Self {
        Self::ZERO
    }
}

/// Working buffers for kernel computation and the partition FFTs, shared by every panner on the
/// render thread (one per core, built outside the process path).
#[derive(Clone)]
pub struct HrtfScratch {
    pub(crate) time_a: [f32; MAX_FFT_SIZE],
    pub(crate) time_b: [f32; MAX_FFT_SIZE],
    pub(crate) spectrum: [Complex32; MAX_FFT_SIZE / 2],
    pub(crate) work: [Complex32; MAX_FFT_SIZE / 2],
    pub(crate) block: [f32; PARTITION_FFT_SIZE],
    pub(crate) twiddles: Twiddles,
}

impl HrtfScratch {
    /// Builds the buffers and the FFT twiddles (uses `libm`; not in the process path).
    pub fn new() -> Self {
        todo!("H1-core")
    }
}

impl Default for HrtfScratch {
    fn default() -> Self {
        Self::new()
    }
}

/// Fade-out length at the truncation point, `(unsigned)(sample_rate / 4410)` (10 frames at 44.1 kHz).
pub fn number_of_fade_out_frames(sample_rate: f32) -> usize {
    let _ = sample_rate;
    todo!("H1-core")
}

/// The kernel's frame delay for (`azimuth_index` 0..192, `elevation_index` 0..10, `ear`): the
/// raw azimuth's table delay, or `lerp(delay1, delay2, x)` in `f32` between the two raw azimuths
/// of an interpolated index (`CreateInterpolatedKernel`), each at its own capped elevation.
pub fn kernel_frame_delay(db: &HrirDatabase<'_>, azimuth_index: usize, elevation_index: usize, ear: Ear) -> f32 {
    let _ = (db, azimuth_index, elevation_index, ear);
    todo!("H1-core")
}

/// The kernel's time-domain response into `out[..fft_size / 2]` (`fft_size` from
/// `fft_size_for_sample_rate(sample_rate)`); returns `fft_size / 2`. `out` must hold that many.
pub fn kernel_time_response(
    db: &HrirDatabase<'_>,
    sample_rate: f32,
    azimuth_index: usize,
    elevation_index: usize,
    ear: Ear,
    scratch: &mut HrtfScratch,
    out: &mut [f32],
) -> usize {
    let _ = (db, sample_rate, azimuth_index, elevation_index, ear, scratch, out);
    todo!("H1-core")
}

/// One kernel computation: the response as [`kernel_time_response`], partitioned and transformed
/// into `out`. Returns the number of partitions used (`max(1, fft_size / 256)`).
pub fn compute_kernel(
    db: &HrirDatabase<'_>,
    sample_rate: f32,
    azimuth_index: usize,
    elevation_index: usize,
    ear: Ear,
    scratch: &mut HrtfScratch,
    out: &mut KernelSpectra,
) -> usize {
    let _ = (db, sample_rate, azimuth_index, elevation_index, ear, scratch, out);
    todo!("H1-core")
}

/// `ExtractAverageGroupDelay` (hrtf_kernel.cc and fft_frame.cc), for H2's preprocessing: estimates
/// the magnitude-weighted average group delay of `ir` (length a power of two, 32..=1024), removes
/// it less 20 frames of headroom and the DC term in the frequency domain, writes the result back
/// into `ir`, and returns the removed delay in frames.
pub fn extract_average_group_delay(ir: &mut [f32], scratch: &mut HrtfScratch) -> f32 {
    let _ = (ir, scratch);
    todo!("H1-core")
}
