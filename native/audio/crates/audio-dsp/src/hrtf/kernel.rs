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
//!   their delay already removed (H2 runs [`extract_average_group_delay`] before upload). A silent
//!   response (zero total magnitude) gives a delay of 0 and is left alone, where upstream would
//!   produce NaN.
//! - `std::abs`, `arg`, `polar`, `log10` and `pow` become `libm::hypot`, `atan2`, `cos`/`sin`,
//!   `log10` and `pow`.
//!
//! Nothing here allocates; all buffers are in [`HrtfScratch`] or the caller's [`KernelSpectra`].

use core::f64::consts::PI;

use microfft::Complex32;

use super::database::HrirDatabase;
use super::elevation_index::{azimuth_pair, fft_size_for_sample_rate, raw_elevation_index};
use super::fft::{irfft, rfft, Twiddles};
use super::{lerp_f32, Ear, MAX_FFT_SIZE, MAX_PARTITIONS, PARTITION_BINS, PARTITION_FFT_SIZE, QUANTUM_FRAMES};

const TWO_PI: f64 = 2.0 * PI;
const ZERO_BIN: Complex32 = Complex32 { re: 0.0, im: 0.0 };

/// One ear's kernel in the convolver's format: partition `k` is the 256-point packed FFT of taps
/// `128k .. 128k + 128` zero-padded to 256. Partitions past the kernel's count are unused.
#[derive(Clone, Copy)]
pub struct KernelSpectra {
    pub partitions: [[Complex32; PARTITION_BINS]; MAX_PARTITIONS],
}

impl KernelSpectra {
    pub const ZERO: Self = Self { partitions: [[ZERO_BIN; PARTITION_BINS]; MAX_PARTITIONS] };
}

impl Default for KernelSpectra {
    fn default() -> Self {
        Self::ZERO
    }
}

/// Working buffers for kernel computation and the partition FFTs, shared by every panner on the
/// render thread (one per core, built outside the process path). About 21 KB.
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
        Self {
            time_a: [0.0; MAX_FFT_SIZE],
            time_b: [0.0; MAX_FFT_SIZE],
            spectrum: [ZERO_BIN; MAX_FFT_SIZE / 2],
            work: [ZERO_BIN; MAX_FFT_SIZE / 2],
            block: [0.0; PARTITION_FFT_SIZE],
            twiddles: Twiddles::new(),
        }
    }
}

impl Default for HrtfScratch {
    fn default() -> Self {
        Self::new()
    }
}

/// Fade-out length at the truncation point, `(unsigned)(sample_rate / 4410)` (10 frames at 44.1 kHz).
pub fn number_of_fade_out_frames(sample_rate: f32) -> usize {
    let n = sample_rate / 4410.0;
    if n.is_nan() || n <= 0.0 {
        0
    } else {
        n as usize
    }
}

/// The kernel's frame delay for (`azimuth_index` 0..=191, `elevation_index` 0..=9, `ear`): the
/// raw azimuth's table delay, or `lerp(delay1, delay2, x)` in `f32` between the two raw azimuths
/// of an interpolated index (`CreateInterpolatedKernel`), each at its own capped elevation.
pub fn kernel_frame_delay(db: &HrirDatabase<'_>, azimuth_index: usize, elevation_index: usize, ear: Ear) -> f32 {
    let pair = azimuth_pair(azimuth_index);
    let d1 = db.ear_delay(raw_elevation_index(elevation_index, pair.raw1), pair.raw1, ear);
    if pair.step == 0 {
        return d1;
    }
    let d2 = db.ear_delay(raw_elevation_index(elevation_index, pair.raw2), pair.raw2, ear);
    lerp_f32(d1, d2, pair.x)
}

/// The `HRTFKernel` constructor's response: the impulse response truncated (or zero-padded) to
/// `taps` and faded out over its last `number_of_fade_out_frames` frames.
fn raw_response(db: &HrirDatabase<'_>, sample_rate: f32, elevation_index: usize, raw_azimuth: usize, ear: Ear, out: &mut [f32]) {
    let taps = out.len();
    out.fill(0.0);
    db.read_ir(elevation_index, raw_azimuth, ear, out);
    let fade = number_of_fade_out_frames(sample_rate);
    if fade == 0 || fade >= taps {
        return;
    }
    let start = taps - fade;
    for (i, v) in out.iter_mut().enumerate().skip(start) {
        let x = 1.0f32 - (i - start) as f32 / fade as f32;
        *v *= x;
    }
}

/// The kernel's response, left in `scratch.time_a[..taps]`; returns `taps` (0 for a rate past
/// [`MAX_FFT_SIZE`]).
fn response_into_scratch(db: &HrirDatabase<'_>, sample_rate: f32, azimuth_index: usize, elevation_index: usize, ear: Ear, scratch: &mut HrtfScratch) -> usize {
    let fft_size = fft_size_for_sample_rate(sample_rate);
    if !(32..=MAX_FFT_SIZE).contains(&fft_size) {
        return 0;
    }
    let taps = fft_size / 2;
    let pair = azimuth_pair(azimuth_index);
    let e1 = raw_elevation_index(elevation_index, pair.raw1);
    if pair.step == 0 {
        raw_response(db, sample_rate, e1, pair.raw1, ear, &mut scratch.time_a[..taps]);
        return taps;
    }
    let e2 = raw_elevation_index(elevation_index, pair.raw2);
    // CreateInterpolatedKernel -> CreateInterpolatedFrame on DoPaddedFFT'd responses.
    raw_response(db, sample_rate, e1, pair.raw1, ear, &mut scratch.time_a[..taps]);
    scratch.time_a[taps..fft_size].fill(0.0);
    raw_response(db, sample_rate, e2, pair.raw2, ear, &mut scratch.time_b[..taps]);
    scratch.time_b[taps..fft_size].fill(0.0);
    let HrtfScratch { time_a, time_b, spectrum, work, twiddles, .. } = scratch;
    {
        let frame1 = rfft(&mut time_a[..fft_size]);
        let frame2 = rfft(&mut time_b[..fft_size]);
        interpolate_frequency_components(frame1, frame2, pair.x as f64, &mut spectrum[..taps]);
    }
    irfft(&spectrum[..taps], &mut time_a[..fft_size], &mut work[..taps], twiddles);
    // "In the time-domain, the 2nd half of the response must be zero": keep the first half.
    taps
}

/// The kernel's time-domain response into `out[..fft_size / 2]` (`fft_size` from
/// `fft_size_for_sample_rate(sample_rate)`); returns `fft_size / 2` (0, writing nothing, if `out`
/// is shorter or the rate is unsupported).
pub fn kernel_time_response(
    db: &HrirDatabase<'_>,
    sample_rate: f32,
    azimuth_index: usize,
    elevation_index: usize,
    ear: Ear,
    scratch: &mut HrtfScratch,
    out: &mut [f32],
) -> usize {
    let taps = fft_size_for_sample_rate(sample_rate) / 2;
    if out.len() < taps {
        return 0;
    }
    let taps = response_into_scratch(db, sample_rate, azimuth_index, elevation_index, ear, scratch);
    out[..taps].copy_from_slice(&scratch.time_a[..taps]);
    taps
}

/// Cuts `scratch.time_a[..taps]` into 128-frame partitions and transforms each into `out`.
/// Returns the partition count, `max(1, taps / 128)`, or 0 if `out` has too few.
fn partition_scratch(taps: usize, scratch: &mut HrtfScratch, out: &mut [[Complex32; PARTITION_BINS]]) -> usize {
    let parts = taps.div_ceil(QUANTUM_FRAMES).max(1);
    if taps == 0 || parts > out.len() {
        return 0;
    }
    for (k, part) in out.iter_mut().take(parts).enumerate() {
        let start = k * QUANTUM_FRAMES;
        let end = (start + QUANTUM_FRAMES).min(taps);
        scratch.block.fill(0.0);
        scratch.block[..end - start].copy_from_slice(&scratch.time_a[start..end]);
        part.copy_from_slice(rfft(&mut scratch.block));
    }
    parts
}

/// [`compute_kernel`] into any number of partitions (the panner's storage is sized for its rate).
pub(crate) fn compute_kernel_into(
    db: &HrirDatabase<'_>,
    sample_rate: f32,
    azimuth_index: usize,
    elevation_index: usize,
    ear: Ear,
    scratch: &mut HrtfScratch,
    out: &mut [[Complex32; PARTITION_BINS]],
) -> usize {
    let taps = response_into_scratch(db, sample_rate, azimuth_index, elevation_index, ear, scratch);
    partition_scratch(taps, scratch, out)
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
    compute_kernel_into(db, sample_rate, azimuth_index, elevation_index, ear, scratch, &mut out.partitions)
}

/// Transforms an arbitrary response of up to `MAX_KERNEL_FRAMES` taps into partitions (tests).
#[cfg(test)]
pub(crate) fn partition_response(response: &[f32], scratch: &mut HrtfScratch, out: &mut [[Complex32; PARTITION_BINS]]) -> usize {
    scratch.time_a[..response.len()].copy_from_slice(response);
    partition_scratch(response.len(), scratch, out)
}

/// Unwraps a phase difference into -π..=π (upstream's two `if`s, in its order).
#[inline]
fn unwrap_upper_first(mut d: f64) -> f64 {
    if d > PI {
        d -= TWO_PI;
    }
    if d < -PI {
        d += TWO_PI;
    }
    d
}

/// `FFTFrame::InterpolateFrequencyComponents`: magnitudes blended in dB (with the empirical tweak
/// that keeps high-frequency zeroes), group delays blended and re-accumulated into phase; DC and
/// Nyquist (bin 0) blended linearly.
pub(crate) fn interpolate_frequency_components(frame1: &[Complex32], frame2: &[Complex32], interp: f64, out: &mut [Complex32]) {
    let packed_size = frame1.len().min(frame2.len()).min(out.len());
    if packed_size == 0 {
        return;
    }
    let s1base = 1.0 - interp;
    let s2base = interp;
    let mut phase_accum = 0.0f64;
    let mut last_phase1 = 0.0f64;
    let mut last_phase2 = 0.0f64;

    out[0] = Complex32 {
        re: (s1base * frame1[0].re as f64 + s2base * frame2[0].re as f64) as f32,
        im: (s1base * frame1[0].im as f64 + s2base * frame2[0].im as f64) as f32,
    };

    for i in 1..packed_size {
        let (re1, im1) = (frame1[i].re as f64, frame1[i].im as f64);
        let (re2, im2) = (frame2[i].re as f64, frame2[i].im as f64);
        let mag1 = libm::hypot(re1, im1);
        let mag2 = libm::hypot(re2, im2);

        // Interpolate magnitudes in decibels.
        let db_mag1 = 20.0 * libm::log10(mag1);
        let db_mag2 = 20.0 * libm::log10(mag2);

        let mut s1 = s1base;
        let mut s2 = s2base;
        let db_mag_diff = db_mag1 - db_mag2;

        // Empirical tweak to retain higher-frequency zeroes.
        let threshold = if i > 16 { 5.0 } else { 2.0 };
        if db_mag_diff < -threshold && db_mag1 < 0.0 {
            s1 = libm::pow(s1, 0.75);
            s2 = 1.0 - s1;
        } else if db_mag_diff > threshold && db_mag2 < 0.0 {
            s2 = libm::pow(s2, 0.75);
            s1 = 1.0 - s2;
        }

        let db_mag = s1 * db_mag1 + s2 * db_mag2;
        let mag = libm::pow(10.0, 0.05 * db_mag);

        // Now, deal with phase.
        let phase1 = libm::atan2(im1, re1);
        let phase2 = libm::atan2(im2, re2);
        let delta_phase1 = unwrap_upper_first(phase1 - last_phase1);
        let delta_phase2 = unwrap_upper_first(phase2 - last_phase2);
        last_phase1 = phase1;
        last_phase2 = phase2;

        // Blend group-delays.
        let delta_phase_blend = if delta_phase1 - delta_phase2 > PI {
            s1 * delta_phase1 + s2 * (TWO_PI + delta_phase2)
        } else if delta_phase2 - delta_phase1 > PI {
            s1 * (TWO_PI + delta_phase1) + s2 * delta_phase2
        } else {
            s1 * delta_phase1 + s2 * delta_phase2
        };

        phase_accum = unwrap_upper_first(phase_accum + delta_phase_blend);

        out[i] = Complex32 { re: (mag * libm::cos(phase_accum)) as f32, im: (mag * libm::sin(phase_accum)) as f32 };
    }
}

/// `ExtractAverageGroupDelay` (hrtf_kernel.cc and fft_frame.cc), for H2's preprocessing: estimates
/// the magnitude-weighted average group delay of `ir` (length a power of two, 32..=1024), removes
/// it less 20 frames of headroom and the DC term in the frequency domain, writes the result back
/// into `ir`, and returns the removed delay in frames. Another length, or a silent `ir`, returns
/// 0 and leaves `ir` alone.
pub fn extract_average_group_delay(ir: &mut [f32], scratch: &mut HrtfScratch) -> f32 {
    let n = ir.len();
    if !(32..=MAX_FFT_SIZE).contains(&n) || !n.is_power_of_two() {
        return 0.0;
    }
    let packed_size = n / 2;
    let HrtfScratch { time_a, spectrum, work, twiddles, .. } = scratch;
    time_a[..n].copy_from_slice(ir);
    spectrum[..packed_size].copy_from_slice(rfft(&mut time_a[..n]));
    let spec = &mut spectrum[..packed_size];

    let mut ave_sum = 0.0f64;
    let mut weight_sum = 0.0f64;
    let mut last_phase = 0.0f64;
    let sample_phase_delay = TWO_PI / n as f64;

    // Upstream includes bin 0, read as the complex (DC, Nyquist).
    for c in spec.iter() {
        let (re, im) = (c.re as f64, c.im as f64);
        let mag = libm::hypot(re, im);
        let phase = libm::atan2(im, re);
        let mut delta_phase = phase - last_phase;
        last_phase = phase;
        if delta_phase < -PI {
            delta_phase += TWO_PI;
        }
        if delta_phase > PI {
            delta_phase -= TWO_PI;
        }
        ave_sum += mag * delta_phase;
        weight_sum += mag;
    }
    if weight_sum == 0.0 {
        return 0.0;
    }

    let ave = ave_sum / weight_sum;
    let mut ave_sample_delay = -ave / sample_phase_delay;
    // Leave 20 sample headroom (for leading edge of impulse).
    if ave_sample_delay > 20.0 {
        ave_sample_delay -= 20.0;
    }

    // AddConstantGroupDelay(-ave_sample_delay).
    let phase_adj = ave_sample_delay * sample_phase_delay;
    for (i, c) in spec.iter_mut().enumerate().skip(1) {
        let (re, im) = (c.re as f64, c.im as f64);
        let mag = libm::hypot(re, im);
        let phase = libm::atan2(im, re) + i as f64 * phase_adj;
        *c = Complex32 { re: (mag * libm::cos(phase)) as f32, im: (mag * libm::sin(phase)) as f32 };
    }
    // Remove DC offset.
    spec[0].re = 0.0;

    irfft(spec, ir, &mut work[..packed_size], twiddles);
    ave_sample_delay as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade_out_frames_follow_the_rate() {
        assert_eq!(number_of_fade_out_frames(44100.0), 10);
        assert_eq!(number_of_fade_out_frames(48000.0), 10);
        assert_eq!(number_of_fade_out_frames(96000.0), 21);
        assert_eq!(number_of_fade_out_frames(3000.0), 0);
    }

    fn spectrum_of(x: &[f32]) -> Vec<Complex32> {
        let mut buf = x.to_vec();
        rfft(&mut buf).to_vec()
    }

    #[test]
    fn interpolating_a_frame_with_itself_returns_it() {
        let x: Vec<f32> = (0..512).map(|i| if i < 256 { libm::expf(-(i as f32) / 30.0) * libm::sinf(i as f32 * 0.7) } else { 0.0 }).collect();
        let s = spectrum_of(&x);
        let mut out = vec![Complex32::default(); 256];
        interpolate_frequency_components(&s, &s, 0.375, &mut out);
        for (a, b) in s.iter().zip(&out) {
            assert!((a.re - b.re).abs() < 1e-4 && (a.im - b.im).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn interpolation_at_zero_returns_the_first_frame() {
        let x: Vec<f32> = (0..64).map(|i| if i < 32 { 1.0 / (1.0 + i as f32) } else { 0.0 }).collect();
        let y: Vec<f32> = (0..64).map(|i| if (3..35).contains(&i) { 0.5 / (1.0 + i as f32) } else { 0.0 }).collect();
        let (s1, s2) = (spectrum_of(&x), spectrum_of(&y));
        let mut out = vec![Complex32::default(); 32];
        interpolate_frequency_components(&s1, &s2, 0.0, &mut out);
        for (a, b) in s1.iter().zip(&out) {
            assert!((a.re - b.re).abs() < 1e-4 && (a.im - b.im).abs() < 1e-4, "{a} vs {b}");
        }
    }

    #[test]
    fn group_delay_of_a_late_impulse_is_removed_less_20_frames() {
        let mut scratch = HrtfScratch::new();
        let mut ir = [0.0f32; 256];
        ir[50] = 1.0;
        let delay = extract_average_group_delay(&mut ir, &mut scratch);
        // Upstream's estimate reads bin 0 as the complex (DC, Nyquist), which pulls a pure 50-frame
        // delay to about 49.3; less the 20 frames of headroom that is about 29.3.
        assert!((delay - 29.34).abs() < 0.05, "delay {delay}");
        let peak = ir.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
        assert!((20..=21).contains(&peak), "peak {peak}");
        let mut silent = [0.0f32; 64];
        assert_eq!(extract_average_group_delay(&mut silent, &mut scratch), 0.0);
    }

    #[test]
    fn partitions_cover_the_response() {
        let mut scratch = HrtfScratch::new();
        let mut out = [[ZERO_BIN; PARTITION_BINS]; MAX_PARTITIONS];
        let response: Vec<f32> = (0..256).map(|i| i as f32).collect();
        assert_eq!(partition_response(&response, &mut scratch, &mut out), 2);
        // Partition 1's DC is the sum of taps 128..256.
        let dc: f32 = (128..256).map(|i| i as f32).sum();
        assert!((out[1][0].re - dc).abs() < 1e-2);
        assert_eq!(partition_response(&response[..64], &mut scratch, &mut out), 1);
        assert_eq!(partition_response(&response, &mut scratch, &mut out[..1]), 0);
    }
}
