// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_panner.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_panner.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2010, Google Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions
// are met:
// 1.  Redistributions of source code must retain the above copyright
//    notice, this list of conditions and the following disclaimer.
// 2.  Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS'' AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
// LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
// OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
// DAMAGE.

//! The HRTF panner: a port of Blink's `HRTFPanner::Pan` (k-rate).
//!
//! Kept from upstream: the azimuth negation (IRCAM azimuths run the other way), the snap to the
//! first direction, the two kernel sets with their crossfade over 2,048 frames (4,096 above
//! 48 kHz), starting a crossfade only when none is running and the target index or the elevation
//! changed, the interaural delays interpolated by the azimuth blend and crossfaded with `x`, and
//! the end-of-crossfade test.
//!
//! Differences from upstream (see the module doc of `hrtf` for the convolution ones):
//! - one quantum (128 frames) per call, so upstream's segment loop runs once;
//! - kernels come from [`compute_kernel`](super::kernel::compute_kernel) when a set's (azimuth
//!   index, elevation index) changes, and only for sets that are convolved this quantum; their
//!   delays are looked up every quantum, as upstream's `GetKernelsFromAzimuthElevation`;
//! - no database means no `HRTFPanner`: the core uses equal-power until `hrtfReady` (H3), so the
//!   upstream copy-through branch is gone;
//! - `Reset` also forgets the kernels (they are recomputed on the next call), and the `Panner`
//!   base class, `PanWithSampleAccurateValues`, `TailTime` and `LatencyTime` are dropped.

#![allow(dead_code)] // skeleton: the H1 core removes this

use super::convolver::EarInput;
use super::database::HrirDatabase;
use super::delay::DelayLine;
use super::kernel::{HrtfScratch, KernelSpectra};
use super::QUANTUM_FRAMES;

/// `kMaxDelayTimeSeconds`: 2 ms, the interaural delay lines' capacity.
pub const MAX_DELAY_TIME_SECONDS: f64 = 0.002;

/// The rate given to [`HrtfPanner::new`] isn't supported: below 3 kHz, not finite, or so high the
/// kernel would exceed `MAX_PARTITIONS` (176.4 kHz and up).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnsupportedSampleRate(pub f32);

/// `CrossfadeSelection`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrossfadeSelection {
    Selection1,
    Selection2,
}

/// One kernel set's cached spectra: valid for (`azimuth_index`, `elevation_index`).
#[derive(Clone, Copy)]
struct KernelSet {
    left: KernelSpectra,
    right: KernelSpectra,
    /// The direction the spectra were computed for; `None` until the first computation.
    key: Option<(usize, usize)>,
}

/// Upstream `HRTFPanner`, one per HRTF voice. A fixed-size value (about 29 KB); nothing in
/// [`pan`](Self::pan) allocates.
#[derive(Clone)]
pub struct HrtfPanner {
    sample_rate: f32,
    fft_size: usize,
    partitions: usize,
    crossfade_selection: CrossfadeSelection,
    /// `None` is upstream's `kUninitializedAzimuth`.
    azimuth_index1: Option<usize>,
    elevation1: f64,
    azimuth_index2: Option<usize>,
    elevation2: f64,
    crossfade_x: f32,
    crossfade_incr: f32,
    set1: KernelSet,
    set2: KernelSet,
    input_l: EarInput,
    input_r: EarInput,
    delay_line_l: DelayLine,
    delay_line_r: DelayLine,
    temp_l1: [f32; QUANTUM_FRAMES],
    temp_r1: [f32; QUANTUM_FRAMES],
    temp_l2: [f32; QUANTUM_FRAMES],
    temp_r2: [f32; QUANTUM_FRAMES],
    kernels_computed: u32,
}

impl HrtfPanner {
    /// A panner for a context rate (the rate the `format = 2` data is at).
    pub fn new(sample_rate: f32) -> Result<Self, UnsupportedSampleRate> {
        let _ = sample_rate;
        todo!("H1-core")
    }

    /// `Reset`: silence in the delay lines and convolvers; kernels are recomputed on the next call.
    pub fn reset(&mut self) {
        todo!("H1-core")
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// `FftSize()`: the kernel FFT size for this rate (512 at 44.1 and 48 kHz).
    pub fn fft_size(&self) -> usize {
        self.fft_size
    }

    /// Kernel partitions at this rate, `max(1, fft_size / 256)`.
    pub fn partitions(&self) -> usize {
        self.partitions
    }

    /// True while the two kernel sets are crossfading.
    pub fn is_crossfading(&self) -> bool {
        self.crossfade_incr != 0.0
    }

    /// Kernel computations the last [`pan`](Self::pan) call made (0 to 4).
    pub fn kernels_computed_last(&self) -> u32 {
        self.kernels_computed
    }

    /// `Pan` for one quantum: `desired_azimuth` in -180..=180 degrees (the panner's convention,
    /// positive to the right as Web Audio's `PannerNode` computes it) and `elevation` in degrees.
    /// A mono source passes `source_r = None` (both ears filter `source_l`); a stereo source's
    /// left channel goes through the left-ear HRTF and its right through the right-ear one.
    #[allow(clippy::too_many_arguments)]
    pub fn pan(
        &mut self,
        db: &HrirDatabase<'_>,
        scratch: &mut HrtfScratch,
        desired_azimuth: f64,
        elevation: f64,
        source_l: &[f32; QUANTUM_FRAMES],
        source_r: Option<&[f32; QUANTUM_FRAMES]>,
        destination_l: &mut [f32; QUANTUM_FRAMES],
        destination_r: &mut [f32; QUANTUM_FRAMES],
    ) {
        let _ = (db, scratch, desired_azimuth, elevation, source_l, source_r, destination_l, destination_r);
        todo!("H1-core")
    }
}
