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
//! - the panner is sized for a partition count `P` ([`HrtfPannerN`]): [`HrtfPanner`] (`P` = 4)
//!   takes every supported rate, `HrtfPannerN<2>` rates below 88.2 kHz at about 60% of the size
//!   ([`partitions_for_sample_rate`] says which a rate needs);
//! - no database means no `HRTFPanner`: the core uses equal-power until `hrtfReady` (H3), so the
//!   upstream copy-through branch is gone;
//! - `Reset` also forgets the kernels (they are recomputed on the next call), and the `Panner`
//!   base class, `PanWithSampleAccurateValues`, `TailTime` and `LatencyTime` are dropped.

use microfft::Complex32;

use super::convolver::{EarInput, EarView};
use super::database::HrirDatabase;
use super::delay::DelayLine;
use super::elevation_index::{calculate_desired_azimuth_index_and_blend, fft_size_for_sample_rate, index_from_elevation_angle, NUMBER_OF_TOTAL_AZIMUTHS};
use super::kernel::{compute_kernel_into, kernel_frame_delay, HrtfScratch};
use super::{lerp_f64, Ear, MAX_FFT_SIZE, MAX_PARTITIONS, PARTITION_BINS, PARTITION_FFT_SIZE, QUANTUM_FRAMES};

/// `kMaxDelayTimeSeconds`: 2 ms, the interaural delay lines' capacity.
pub const MAX_DELAY_TIME_SECONDS: f64 = 0.002;

/// The lowest context rate accepted (Web Audio's minimum).
pub const MIN_SAMPLE_RATE: f32 = 3000.0;

const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// The rate given to [`HrtfPannerN::new`] isn't supported: below 3 kHz, not finite, or so high the
/// kernel would need more partitions than the panner has (176.4 kHz and up for [`HrtfPanner`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnsupportedSampleRate(pub f32);

/// Kernel partitions a rate needs, `max(1, fft_size / 256)`; `None` for an unsupported rate.
pub fn partitions_for_sample_rate(sample_rate: f32) -> Option<usize> {
    if !sample_rate.is_finite() || sample_rate < MIN_SAMPLE_RATE {
        return None;
    }
    let fft_size = fft_size_for_sample_rate(sample_rate);
    if fft_size > MAX_FFT_SIZE {
        return None;
    }
    Some((fft_size / PARTITION_FFT_SIZE).max(1))
}

/// `CrossfadeSelection`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrossfadeSelection {
    Selection1,
    Selection2,
}

/// One kernel set's cached spectra: valid for `key` = (azimuth index, elevation index).
#[derive(Clone, Copy)]
struct KernelSet<const P: usize> {
    left: [[Complex32; PARTITION_BINS]; P],
    right: [[Complex32; PARTITION_BINS]; P],
    key: Option<(usize, usize)>,
}

impl<const P: usize> KernelSet<P> {
    const EMPTY: Self = Self { left: [[ZERO_BIN; PARTITION_BINS]; P], right: [[ZERO_BIN; PARTITION_BINS]; P], key: None };

    fn view(&mut self) -> SetView<'_> {
        SetView { left: &mut self.left, right: &mut self.right, key: &mut self.key }
    }
}

/// A kernel set with its partition count erased, so the process path is one copy for every `P`
/// (H3: the wasm carries `pan` once, not once per partition count).
struct SetView<'a> {
    left: &'a mut [[Complex32; PARTITION_BINS]],
    right: &'a mut [[Complex32; PARTITION_BINS]],
    key: &'a mut Option<(usize, usize)>,
}

/// Everything of a panner but its kernel sets and input histories (which depend on `P`).
#[derive(Clone)]
struct PanState {
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
    delay_line_l: DelayLine,
    delay_line_r: DelayLine,
    temp_l1: [f32; QUANTUM_FRAMES],
    temp_r1: [f32; QUANTUM_FRAMES],
    temp_l2: [f32; QUANTUM_FRAMES],
    temp_r2: [f32; QUANTUM_FRAMES],
    kernels_computed: u32,
}

/// Upstream `HRTFPanner` with kernels of up to `P` partitions, one per HRTF voice. A fixed-size
/// value (about 31 KB at `P` = 4, 19 KB at `P` = 2); nothing in [`pan`](Self::pan) allocates.
#[derive(Clone)]
pub struct HrtfPannerN<const P: usize> {
    state: PanState,
    set1: KernelSet<P>,
    set2: KernelSet<P>,
    input_l: EarInput<P>,
    input_r: EarInput<P>,
}

/// The panner for every supported rate (4 partitions).
pub type HrtfPanner = HrtfPannerN<MAX_PARTITIONS>;

/// Makes sure `set` holds the kernels for `key`; returns the kernel computations made (0 or 2).
fn ensure_kernels(set: &mut SetView<'_>, key: (usize, usize), db: &HrirDatabase<'_>, sample_rate: f32, scratch: &mut HrtfScratch) -> u32 {
    if *set.key == Some(key) {
        return 0;
    }
    compute_kernel_into(db, sample_rate, key.0, key.1, Ear::Left, scratch, set.left);
    compute_kernel_into(db, sample_rate, key.0, key.1, Ear::Right, scratch, set.right);
    *set.key = Some(key);
    2
}

/// `GetKernelsFromAzimuth`'s delays: each ear's kernel delay at `azimuth_index`, linearly
/// interpolated towards the next index by `azimuth_blend`.
fn frame_delays(db: &HrirDatabase<'_>, azimuth_blend: f64, azimuth_index: usize, elevation_index: usize) -> (f64, f64) {
    let next = (azimuth_index + 1) % NUMBER_OF_TOTAL_AZIMUTHS;
    let l = lerp_f64(kernel_frame_delay(db, azimuth_index, elevation_index, Ear::Left) as f64, kernel_frame_delay(db, next, elevation_index, Ear::Left) as f64, azimuth_blend);
    let r = lerp_f64(kernel_frame_delay(db, azimuth_index, elevation_index, Ear::Right) as f64, kernel_frame_delay(db, next, elevation_index, Ear::Right) as f64, azimuth_blend);
    (l, r)
}

impl<const P: usize> HrtfPannerN<P> {
    /// A panner for a context rate (the rate the `format = 2` data is at).
    pub fn new(sample_rate: f32) -> Result<Self, UnsupportedSampleRate> {
        let partitions = match partitions_for_sample_rate(sample_rate) {
            Some(p) if p <= P => p,
            _ => return Err(UnsupportedSampleRate(sample_rate)),
        };
        Ok(Self {
            state: PanState {
                sample_rate,
                fft_size: fft_size_for_sample_rate(sample_rate),
                partitions,
                crossfade_selection: CrossfadeSelection::Selection1,
                azimuth_index1: None,
                elevation1: 0.0,
                azimuth_index2: None,
                elevation2: 0.0,
                crossfade_x: 0.0,
                crossfade_incr: 0.0,
                delay_line_l: DelayLine::new(MAX_DELAY_TIME_SECONDS, sample_rate),
                delay_line_r: DelayLine::new(MAX_DELAY_TIME_SECONDS, sample_rate),
                temp_l1: [0.0; QUANTUM_FRAMES],
                temp_r1: [0.0; QUANTUM_FRAMES],
                temp_l2: [0.0; QUANTUM_FRAMES],
                temp_r2: [0.0; QUANTUM_FRAMES],
                kernels_computed: 0,
            },
            set1: KernelSet::EMPTY,
            set2: KernelSet::EMPTY,
            input_l: EarInput::ZERO,
            input_r: EarInput::ZERO,
        })
    }

    /// `Reset`: silence in the delay lines and convolvers; kernels are recomputed on the next call.
    pub fn reset(&mut self) {
        self.input_l.reset();
        self.input_r.reset();
        self.state.delay_line_l.reset();
        self.state.delay_line_r.reset();
        self.set1.key = None;
        self.set2.key = None;
    }

    /// [`reset`](Self::reset) plus the direction state: the next call snaps to its direction as a
    /// new panner does, with no kernel crossfade from the last direction (H3 reuses one panner for
    /// another voice). Nothing is allocated or copied wholesale.
    pub fn restart(&mut self) {
        self.reset();
        let s = &mut self.state;
        s.crossfade_selection = CrossfadeSelection::Selection1;
        s.azimuth_index1 = None;
        s.elevation1 = 0.0;
        s.azimuth_index2 = None;
        s.elevation2 = 0.0;
        s.crossfade_x = 0.0;
        s.crossfade_incr = 0.0;
        s.kernels_computed = 0;
    }

    pub fn sample_rate(&self) -> f32 {
        self.state.sample_rate
    }

    /// `FftSize()`: the kernel FFT size for this rate (512 at 44.1 and 48 kHz).
    pub fn fft_size(&self) -> usize {
        self.state.fft_size
    }

    /// Kernel partitions at this rate, `max(1, fft_size / 256)`.
    pub fn partitions(&self) -> usize {
        self.state.partitions
    }

    /// True while the two kernel sets are crossfading.
    pub fn is_crossfading(&self) -> bool {
        self.state.crossfade_incr != 0.0
    }

    /// Kernel computations the last [`pan`](Self::pan) call made (0 to 4).
    pub fn kernels_computed_last(&self) -> u32 {
        self.state.kernels_computed
    }

    /// Kernel computations [`pan`](Self::pan) would make for this direction now (0, 2 or 4),
    /// without changing anything: the same decisions as `pan`. H3 uses it to keep the kernel work
    /// of all voices within a per-quantum budget (architecture §2.4: "at most 4 kernel
    /// computations per quantum; further switches wait a quantum").
    pub fn kernels_needed(&self, desired_azimuth: f64, elevation: f64) -> u32 {
        let s = &self.state;
        let (index, _) = calculate_desired_azimuth_index_and_blend(-desired_azimuth);
        let (a1, e1) = match s.azimuth_index1 {
            Some(a) => (a, s.elevation1),
            None => (index, elevation),
        };
        let (a2, e2) = match s.azimuth_index2 {
            Some(a) => (a, s.elevation2),
            None => (index, elevation),
        };
        let (mut key1, mut key2) = ((a1, index_from_elevation_angle(e1)), (a2, index_from_elevation_angle(e2)));
        let mut incr = s.crossfade_incr;
        if s.crossfade_x == 0.0 && s.crossfade_selection == CrossfadeSelection::Selection1 && (index != a1 || elevation != e1) {
            incr = 1.0;
            key2 = (index, index_from_elevation_angle(elevation));
        }
        if s.crossfade_x == 1.0 && s.crossfade_selection == CrossfadeSelection::Selection2 && (index != a2 || elevation != e2) {
            incr = -1.0;
            key1 = (index, index_from_elevation_angle(elevation));
        }
        let crossfading = incr != 0.0;
        let use1 = s.crossfade_selection == CrossfadeSelection::Selection1 || crossfading;
        let use2 = s.crossfade_selection == CrossfadeSelection::Selection2 || crossfading;
        2 * (use1 && self.set1.key != Some(key1)) as u32 + 2 * (use2 && self.set2.key != Some(key2)) as u32
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
        let Self { state, set1, set2, input_l, input_r } = self;
        let io = PanIo { desired_azimuth, elevation, source_l, source_r, destination_l, destination_r };
        state.pan(db, scratch, set1.view(), set2.view(), input_l.view(), input_r.view(), io);
    }
}

/// One quantum's direction, input and output for [`PanState::pan`].
struct PanIo<'a> {
    desired_azimuth: f64,
    elevation: f64,
    source_l: &'a [f32; QUANTUM_FRAMES],
    source_r: Option<&'a [f32; QUANTUM_FRAMES]>,
    destination_l: &'a mut [f32; QUANTUM_FRAMES],
    destination_r: &'a mut [f32; QUANTUM_FRAMES],
}

impl PanState {
    /// [`HrtfPannerN::pan`]'s body, for every `P`.
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    fn pan(&mut self, db: &HrirDatabase<'_>, scratch: &mut HrtfScratch, mut set1: SetView<'_>, mut set2: SetView<'_>, mut input_l: EarView<'_>, mut input_r: EarView<'_>, io: PanIo<'_>) {
        let PanIo { desired_azimuth, elevation, source_l, source_r, destination_l, destination_r } = io;
        // IRCAM HRTF azimuths values from the loaded database is reversed from the panner's
        // notion of azimuth.
        let azimuth = -desired_azimuth;
        let source_r = source_r.unwrap_or(source_l);

        let (desired_azimuth_index, azimuth_blend) = calculate_desired_azimuth_index_and_blend(azimuth);

        // Initially snap azimuth and elevation values to first values encountered.
        if self.azimuth_index1.is_none() {
            self.azimuth_index1 = Some(desired_azimuth_index);
            self.elevation1 = elevation;
        }
        if self.azimuth_index2.is_none() {
            self.azimuth_index2 = Some(desired_azimuth_index);
            self.elevation2 = elevation;
        }
        let azimuth_index1 = self.azimuth_index1.unwrap_or(desired_azimuth_index);
        let azimuth_index2 = self.azimuth_index2.unwrap_or(desired_azimuth_index);

        // Cross-fade / transition over a period of around 45 milliseconds.
        let fade_frames: f64 = if self.sample_rate <= 48000.0 { 2048.0 } else { 4096.0 };

        // Check for azimuth and elevation changes, initiating a cross-fade if needed.
        if self.crossfade_x == 0.0 && self.crossfade_selection == CrossfadeSelection::Selection1 && (desired_azimuth_index != azimuth_index1 || elevation != self.elevation1) {
            // Cross-fade from 1 -> 2.
            self.crossfade_incr = (1.0 / fade_frames) as f32;
            self.azimuth_index2 = Some(desired_azimuth_index);
            self.elevation2 = elevation;
        }
        if self.crossfade_x == 1.0 && self.crossfade_selection == CrossfadeSelection::Selection2 && (desired_azimuth_index != azimuth_index2 || elevation != self.elevation2) {
            // Cross-fade from 2 -> 1.
            self.crossfade_incr = (-1.0 / fade_frames) as f32;
            self.azimuth_index1 = Some(desired_azimuth_index);
            self.elevation1 = elevation;
        }
        let key1 = (self.azimuth_index1.unwrap_or(desired_azimuth_index), index_from_elevation_angle(self.elevation1));
        let key2 = (self.azimuth_index2.unwrap_or(desired_azimuth_index), index_from_elevation_angle(self.elevation2));

        // The interpolated delays of both sets, crossfaded.
        let (delay_l1, delay_r1) = frame_delays(db, azimuth_blend, key1.0, key1.1);
        let (delay_l2, delay_r2) = frame_delays(db, azimuth_blend, key2.0, key2.1);
        let x = self.crossfade_x as f64;
        let frame_delay_l = lerp_f64(delay_l1, delay_l2, x);
        let frame_delay_r = lerp_f64(delay_r1, delay_r2, x);

        // First run through delay lines for inter-aural time difference.
        self.delay_line_l.set_delay_frames(frame_delay_l);
        self.delay_line_r.set_delay_frames(frame_delay_r);
        self.delay_line_l.process_k_rate(source_l, destination_l);
        self.delay_line_r.process_k_rate(source_r, destination_r);

        // Both sets share each ear's input history, which advances every quantum.
        input_l.push(destination_l, scratch);
        input_r.push(destination_r, scratch);

        let needs_crossfading = self.crossfade_incr != 0.0;
        let use1 = self.crossfade_selection == CrossfadeSelection::Selection1 || needs_crossfading;
        let use2 = self.crossfade_selection == CrossfadeSelection::Selection2 || needs_crossfading;
        let parts = self.partitions;
        self.kernels_computed = 0;
        if use1 {
            self.kernels_computed += ensure_kernels(&mut set1, key1, db, self.sample_rate, scratch);
            input_l.convolve(set1.left, parts, scratch, &mut self.temp_l1);
            input_r.convolve(set1.right, parts, scratch, &mut self.temp_r1);
        }
        if use2 {
            self.kernels_computed += ensure_kernels(&mut set2, key2, db, self.sample_rate, scratch);
            input_l.convolve(set2.left, parts, scratch, &mut self.temp_l2);
            input_r.convolve(set2.right, parts, scratch, &mut self.temp_r2);
        }

        if needs_crossfading {
            // Apply linear cross-fade.
            let mut x = self.crossfade_x;
            let incr = self.crossfade_incr;
            for i in 0..QUANTUM_FRAMES {
                destination_l[i] = (1.0 - x) * self.temp_l1[i] + x * self.temp_l2[i];
                destination_r[i] = (1.0 - x) * self.temp_r1[i] + x * self.temp_r2[i];
                x += incr;
            }
            self.crossfade_x = x;

            if self.crossfade_incr > 0.0 && (self.crossfade_x - 1.0).abs() < self.crossfade_incr {
                // We've fully made the crossfade transition from 1 -> 2.
                self.crossfade_selection = CrossfadeSelection::Selection2;
                self.crossfade_x = 1.0;
                self.crossfade_incr = 0.0;
            } else if self.crossfade_incr < 0.0 && self.crossfade_x.abs() < -self.crossfade_incr {
                // We've fully made the crossfade transition from 2 -> 1.
                self.crossfade_selection = CrossfadeSelection::Selection1;
                self.crossfade_x = 0.0;
                self.crossfade_incr = 0.0;
            }
        } else if use1 {
            destination_l.copy_from_slice(&self.temp_l1);
            destination_r.copy_from_slice(&self.temp_r1);
        } else {
            destination_l.copy_from_slice(&self.temp_l2);
            destination_r.copy_from_slice(&self.temp_r2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_map_to_partitions() {
        assert_eq!(partitions_for_sample_rate(48000.0), Some(2));
        assert_eq!(partitions_for_sample_rate(44100.0), Some(2));
        assert_eq!(partitions_for_sample_rate(96000.0), Some(4));
        assert_eq!(partitions_for_sample_rate(8000.0), Some(1));
        assert_eq!(partitions_for_sample_rate(176400.0), None);
        assert_eq!(partitions_for_sample_rate(2000.0), None);
        assert_eq!(partitions_for_sample_rate(f32::NAN), None);
    }

    #[test]
    fn new_checks_the_rate_against_the_partitions() {
        assert!(HrtfPanner::new(96000.0).is_ok());
        assert_eq!(HrtfPannerN::<2>::new(96000.0).err(), Some(UnsupportedSampleRate(96000.0)));
        let p = HrtfPannerN::<2>::new(48000.0).unwrap();
        assert_eq!((p.fft_size(), p.partitions()), (512, 2));
        std::println!("HrtfPannerN<2> {} B, HrtfPanner {} B, HrtfScratch {} B", core::mem::size_of::<HrtfPannerN<2>>(), core::mem::size_of::<HrtfPanner>(), core::mem::size_of::<HrtfScratch>());
        assert!(core::mem::size_of::<HrtfPannerN<2>>() < 20 * 1024);
        assert!(core::mem::size_of::<HrtfPanner>() < 32 * 1024);
    }
    /// Every response an impulse of 0.5 at frame 0, delays 3 (left) and 7.5 (right) frames: any
    /// direction gives the source delayed and halved, before and after a crossfade.
    #[test]
    fn impulse_table_gives_the_delays_at_any_direction() {
        use crate::hrtf::database::{encode, HrirHeader};
        let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate: 48000.0 };
        let delays: std::vec::Vec<f32> = (0..480).map(|i| if i % 2 == 0 { 3.0 } else { 7.5 }).collect();
        let mut irs = std::vec![0i16; 240 * 256 * 2];
        for d in 0..240 {
            irs[d * 512] = 16384;
            irs[d * 512 + 1] = 16384;
        }
        let mut bytes = std::vec![0u8; header.byte_len()];
        encode(&header, &delays, &irs, &mut bytes).unwrap();
        let db = HrirDatabase::parse(&bytes).unwrap();
        let mut scratch = HrtfScratch::new();
        let mut panner = HrtfPannerN::<2>::new(48000.0).unwrap();
        let mut src = [0.0f32; QUANTUM_FRAMES];
        let (mut l, mut r) = ([0.0f32; QUANTUM_FRAMES], [0.0f32; QUANTUM_FRAMES]);
        for (q, azimuth) in [(0, 10.0), (1, 10.0), (2, -77.0), (3, -77.0)] {
            src.fill(0.0);
            src[20] = 1.0;
            panner.pan(&db, &mut scratch, azimuth, 5.0, &src, None, &mut l, &mut r);
            assert!(panner.kernels_computed_last() <= 4);
            if q == 0 {
                assert_eq!(panner.kernels_computed_last(), 2);
            }
            assert!((l[23] - 0.5).abs() < 1e-4, "q {q}: l[23] = {}", l[23]);
            assert!((r[27] - 0.25).abs() < 1e-4 && (r[28] - 0.25).abs() < 1e-4, "q {q}: r = {} {}", r[27], r[28]);
            let energy: f32 = l.iter().chain(r.iter()).map(|v| v * v).sum();
            assert!((energy - (0.25 + 0.125)).abs() < 1e-3, "q {q}: energy {energy}");
        }
        assert!(panner.is_crossfading());
    }

    /// `kernels_needed` predicts what `pan` then computes, through snaps, crossfades both ways,
    /// elevation-only changes and a restart (H3 budgets kernel work with it).
    #[test]
    fn kernels_needed_predicts_pan() {
        use crate::hrtf::database::{encode, HrirHeader};
        let header = HrirHeader { elevations: 10, azimuths: 24, ir_length: 256, rate: 48000.0 };
        let delays = std::vec![1.0f32; 480];
        let irs: std::vec::Vec<i16> = (0..240 * 256 * 2).map(|i| ((i * 7919) % 2000) as i16 - 1000).collect();
        let mut bytes = std::vec![0u8; header.byte_len()];
        encode(&header, &delays, &irs, &mut bytes).unwrap();
        let db = HrirDatabase::parse(&bytes).unwrap();
        let mut scratch = HrtfScratch::new();
        let mut panner = HrtfPannerN::<2>::new(48000.0).unwrap();
        let src = [0.1f32; QUANTUM_FRAMES];
        let (mut l, mut r) = ([0.0f32; QUANTUM_FRAMES], [0.0f32; QUANTUM_FRAMES]);
        let mut seed = 12345u32;
        let mut total = 0;
        for q in 0..400 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let azimuth = ((seed >> 8) % 360) as f64 - 180.0;
            let elevation = if q % 3 == 0 { ((seed >> 4) % 90) as f64 - 45.0 } else { 0.0 };
            let (azimuth, elevation) = if q % 5 < 2 { (12.0, 0.0) } else { (azimuth, elevation) };
            if q == 200 {
                panner.restart();
            }
            let want = panner.kernels_needed(azimuth, elevation);
            panner.pan(&db, &mut scratch, azimuth, elevation, &src, None, &mut l, &mut r);
            assert_eq!(want, panner.kernels_computed_last(), "quantum {q}");
            total += want;
        }
        assert!(total > 50, "the sequence switches kernels: {total}");
    }
}
