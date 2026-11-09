// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_panner.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/hrtf_database.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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
//
// hrtf_panner.cc carries this notice instead:
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

//! The HRTF direction grid: azimuth and elevation indices and interpolation weights (task H1-L1).
//!
//! Ports, with upstream's names in snake_case:
//! - `CalculateDesiredAzimuthIndexAndBlend` and `HRTFPanner::FftSizeForSampleRate` (hrtf_panner.cc);
//! - `IndexFromElevationAngle` and the elevation constants (hrtf_database.cc);
//! - the azimuth constants, `kMaxElevations`, and the raw-azimuth pairing `HRTFElevation::CreateForSubject`
//!   uses to build the 192 interpolated azimuths from the 24 raw ones (hrtf_elevation.cc).
//!
//! Differences from upstream: Chromium builds every interpolated kernel at load; the port computes
//! one on demand, so [`azimuth_pair`] names the two raw azimuths and the weight a given azimuth
//! index blends, and [`raw_elevation_index`] applies `kMaxElevations` per raw azimuth (upstream
//! does it inside `CreateForSubject`). Elevation indices count up from -45° (index 0) to 90°
//! (index 9), the order of the `format = 2` data, not the resource's `kElevationIndexTable` order.
//! NaN inputs give index 0 (and blend 0) where upstream's `static_cast<int>` would be undefined.
//! Nothing here allocates.

/// Spacing in degrees between the raw azimuths (`kAzimuthSpacing`).
pub const AZIMUTH_SPACING: i32 = 15;
/// Raw azimuths in the data (`kNumberOfRawAzimuths` = 360 / 15).
pub const NUMBER_OF_RAW_AZIMUTHS: usize = 24;
/// Interpolated azimuths per raw azimuth (`kInterpolationFactor` in hrtf_elevation.cc).
pub const AZIMUTH_INTERPOLATION_FACTOR: usize = 8;
/// Azimuths after interpolation (`kNumberOfTotalAzimuths`, `HRTFDatabase::NumberOfAzimuths()`).
pub const NUMBER_OF_TOTAL_AZIMUTHS: usize = NUMBER_OF_RAW_AZIMUTHS * AZIMUTH_INTERPOLATION_FACTOR;
/// Lowest elevation in degrees (`kMinElevation`).
pub const MIN_ELEVATION: i32 = -45;
/// Highest elevation in degrees (`kMaxElevation`).
pub const MAX_ELEVATION: i32 = 90;
/// Spacing in degrees between the raw elevations (`kRawElevationAngleSpacing`).
pub const RAW_ELEVATION_ANGLE_SPACING: i32 = 15;
/// Raw elevations, -45 to 90 every 15° (`kNumberOfRawElevations` = 10). Elevations are not
/// interpolated upstream (`kInterpolationFactor` = 1 in hrtf_database.cc).
pub const NUMBER_OF_RAW_ELEVATIONS: usize = 1 + ((MAX_ELEVATION - MIN_ELEVATION) / RAW_ELEVATION_ANGLE_SPACING) as usize;

/// `kMaxElevations`: the highest elevation in degrees the IRCAM data has at each raw azimuth
/// (index = azimuth / 15). The minimum is always -45.
pub const MAX_ELEVATIONS: [i32; NUMBER_OF_RAW_AZIMUTHS] = [
    90, // 0
    45, // 15
    60, // 30
    45, // 45
    75, // 60
    45, // 75
    60, // 90
    45, // 105
    75, // 120
    45, // 135
    60, // 150
    45, // 165
    75, // 180
    45, // 195
    60, // 210
    45, // 225
    75, // 240
    45, // 255
    60, // 270
    45, // 285
    75, // 300
    45, // 315
    60, // 330
    45, // 345
];

/// The two raw azimuths an azimuth index interpolates and the weight of the second, as
/// `HRTFElevation::CreateForSubject` builds `(*kernel_list)[i + jj]` from raw `i / 8` and `j / 8`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AzimuthPair {
    /// Raw azimuth index of the first kernel, `azimuth_index / 8` (0..24).
    pub raw1: usize,
    /// Raw azimuth index of the second kernel, `(raw1 + 1) % 24`.
    pub raw2: usize,
    /// `jj`, `azimuth_index % 8`: 0 means the index is the raw azimuth itself (no interpolation).
    pub step: usize,
    /// `x = (float)jj / (float)8`, the interpolation weight from `raw1` (0) to `raw2` (1).
    pub x: f32,
}

/// `CalculateDesiredAzimuthIndexAndBlend` (hrtf_panner.cc): for an azimuth in -180..=180 degrees
/// (already in the database's convention, i.e. the panner's azimuth negated), the azimuth index
/// 0..192 and the blend 0..1 towards the next index. Negative azimuths add 360; the index is the
/// truncated `azimuth / (360 / 192)`, clamped to 0..=191; the blend is the fractional part. NaN
/// gives `(0, 0.0)`.
pub fn calculate_desired_azimuth_index_and_blend(azimuth: f64) -> (usize, f64) {
    if azimuth.is_nan() {
        return (0, 0.0);
    }
    // Beyond this the index has no fractional part in f64; saturate instead of truncating.
    const LIMIT: f64 = 4_503_599_627_370_496.0; // 2^52
    let last = NUMBER_OF_TOTAL_AZIMUTHS - 1;
    let mut azimuth = azimuth;
    if azimuth < 0.0 {
        azimuth += 360.0;
    }
    let angle_between_azimuths = 360.0 / NUMBER_OF_TOTAL_AZIMUTHS as f64;
    let index_float = azimuth / angle_between_azimuths;
    if !(index_float.abs() < LIMIT) {
        return (if index_float > 0.0 { last } else { 0 }, 0.0);
    }
    if index_float < 0.0 {
        // Only reached for azimuths below -360, which the index clamp maps to 0 anyway.
        return (0, 0.0);
    }
    let index = index_float as usize;
    let blend = index_float - index as f64;
    (index.min(last), blend)
}

/// `IndexFromElevationAngle` (hrtf_database.cc): the elevation index 0..10 for an angle in degrees,
/// clamped to -45..=90 first, then `(int)((angle + 45) / 15)`. NaN gives 0.
pub fn index_from_elevation_angle(elevation_angle: f64) -> usize {
    if elevation_angle.is_nan() {
        return 0;
    }
    let clamped = elevation_angle.max(MIN_ELEVATION as f64).min(MAX_ELEVATION as f64);
    let index = (clamped - MIN_ELEVATION as f64) / RAW_ELEVATION_ANGLE_SPACING as f64;
    index as usize
}

/// The elevation index whose data a raw azimuth actually uses for elevation index
/// `elevation_index`: `CreateForSubject` loads `min(elevation, kMaxElevations[raw])`, so the angle
/// `-45 + 15 * elevation_index` is capped at `MAX_ELEVATIONS[raw_azimuth]` and turned back into an
/// index. `elevation_index` must be below 10 and `raw_azimuth` below 24 (larger values are clamped
/// to the last valid index).
pub fn raw_elevation_index(elevation_index: usize, raw_azimuth: usize) -> usize {
    let elevation_index = elevation_index.min(NUMBER_OF_RAW_ELEVATIONS - 1);
    let raw_azimuth = raw_azimuth.min(NUMBER_OF_RAW_AZIMUTHS - 1);
    let angle = MIN_ELEVATION + RAW_ELEVATION_ANGLE_SPACING * elevation_index as i32;
    let capped = angle.min(MAX_ELEVATIONS[raw_azimuth]);
    let index = (capped - MIN_ELEVATION) / RAW_ELEVATION_ANGLE_SPACING;
    index.max(0) as usize
}

/// The raw pair and weight for an azimuth index 0..192 (see [`AzimuthPair`]). An index of 192 or
/// more is taken modulo 192.
pub fn azimuth_pair(azimuth_index: usize) -> AzimuthPair {
    let index = azimuth_index % NUMBER_OF_TOTAL_AZIMUTHS;
    let raw1 = index / AZIMUTH_INTERPOLATION_FACTOR;
    let raw2 = (raw1 + 1) % NUMBER_OF_RAW_AZIMUTHS;
    let step = index % AZIMUTH_INTERPOLATION_FACTOR;
    let x = step as f32 / AZIMUTH_INTERPOLATION_FACTOR as f32;
    AzimuthPair { raw1, raw2, step, x }
}

/// `HRTFPanner::FftSizeForSampleRate`: the kernel FFT size for a context rate. The 256-frame
/// truncated response is resampled (`256 * (sample_rate / 44100)`, the ratio computed in `f32`
/// as upstream divides a `float` by an `int`), the analysis size is `1 << (unsigned)log2(that)`
/// (at least `FFTFrame::MinFFTSize()` = 2), and the result is twice the analysis size. 512 at
/// 44.1 and 48 kHz, 1024 at 88.2 and 96 kHz.
pub fn fft_size_for_sample_rate(sample_rate: f32) -> usize {
    const TRUNCATED_IMPULSE_LENGTH: f64 = 256.0;
    const MIN_FFT_SIZE: usize = 2; // FFTFrame::MinFFTSize()
    // `sample_rate / 44100` divides a float by an int, so the ratio is computed in f32.
    let sample_rate_ratio = sample_rate / 44100.0_f32;
    let resampled_length = TRUNCATED_IMPULSE_LENGTH * sample_rate_ratio as f64;
    // Saturating float-to-int casts keep NaN and negative inputs at exponent 0, and the cap keeps
    // the shift in range for infinite or huge rates.
    let exponent = (libm::log2(resampled_length) as u32).min(usize::BITS - 2);
    let analysis_fft_size = (1usize << exponent).max(MIN_FFT_SIZE);
    2 * analysis_fft_size
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_blend(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-12, "blend {actual} != {expected}");
    }

    #[test]
    fn azimuth_index_and_blend_match_chromium() {
        assert_eq!(calculate_desired_azimuth_index_and_blend(0.0), (0, 0.0));
        assert_eq!(calculate_desired_azimuth_index_and_blend(1.875), (1, 0.0));
        let (i, b) = calculate_desired_azimuth_index_and_blend(10.0);
        assert_eq!(i, 5);
        assert_blend(b, 1.0 / 3.0);
        let (i, b) = calculate_desired_azimuth_index_and_blend(-10.0);
        assert_eq!(i, 186);
        assert_blend(b, 2.0 / 3.0);
        assert_eq!(calculate_desired_azimuth_index_and_blend(180.0), (96, 0.0));
        assert_eq!(calculate_desired_azimuth_index_and_blend(-180.0), (96, 0.0));
        let (i, b) = calculate_desired_azimuth_index_and_blend(-1e-9);
        assert_eq!(i, 191);
        assert!(b > 0.99 && b < 1.0, "blend {b}");
        assert_eq!(calculate_desired_azimuth_index_and_blend(f64::NAN), (0, 0.0));
        // Infinities and huge values stay in range and never panic.
        assert_eq!(calculate_desired_azimuth_index_and_blend(f64::INFINITY), (191, 0.0));
        assert_eq!(calculate_desired_azimuth_index_and_blend(f64::NEG_INFINITY), (0, 0.0));
        let (i, b) = calculate_desired_azimuth_index_and_blend(1e300);
        assert_eq!(i, 191);
        assert_eq!(b, 0.0);
    }

    #[test]
    fn elevation_index_matches_chromium() {
        assert_eq!(index_from_elevation_angle(-90.0), 0);
        assert_eq!(index_from_elevation_angle(-45.0), 0);
        assert_eq!(index_from_elevation_angle(-44.9), 0);
        assert_eq!(index_from_elevation_angle(0.0), 3);
        assert_eq!(index_from_elevation_angle(14.99), 3);
        assert_eq!(index_from_elevation_angle(15.0), 4);
        assert_eq!(index_from_elevation_angle(89.9), 8);
        assert_eq!(index_from_elevation_angle(90.0), 9);
        assert_eq!(index_from_elevation_angle(400.0), 9);
        assert_eq!(index_from_elevation_angle(f64::NAN), 0);
    }

    #[test]
    fn raw_elevation_index_applies_max_elevations() {
        assert_eq!(raw_elevation_index(9, 0), 9);
        assert_eq!(raw_elevation_index(9, 1), 6);
        assert_eq!(raw_elevation_index(5, 1), 5);
        assert_eq!(raw_elevation_index(8, 2), 7);
        assert_eq!(raw_elevation_index(7, 4), 7);
        assert_eq!(raw_elevation_index(8, 4), 8);
        assert_eq!(raw_elevation_index(0, 13), 0);
        // Out-of-range inputs clamp instead of panicking.
        assert_eq!(raw_elevation_index(usize::MAX, usize::MAX), raw_elevation_index(9, 23));
    }

    #[test]
    fn azimuth_pair_matches_create_for_subject() {
        let check = |a: usize, raw1, raw2, step, x: f32| {
            let p = azimuth_pair(a);
            assert_eq!((p.raw1, p.raw2, p.step), (raw1, raw2, step), "index {a}");
            assert_eq!(p.x, x, "index {a}");
        };
        check(0, 0, 1, 0, 0.0);
        check(8, 1, 2, 0, 0.0);
        check(13, 1, 2, 5, 0.625);
        check(191, 23, 0, 7, 0.875);
        check(192, 0, 1, 0, 0.0);
    }

    #[test]
    fn fft_size_matches_chromium() {
        assert_eq!(fft_size_for_sample_rate(3000.0), 32);
        assert_eq!(fft_size_for_sample_rate(8000.0), 64);
        assert_eq!(fft_size_for_sample_rate(16000.0), 128);
        assert_eq!(fft_size_for_sample_rate(22050.0), 256);
        assert_eq!(fft_size_for_sample_rate(44100.0), 512);
        assert_eq!(fft_size_for_sample_rate(48000.0), 512);
        assert_eq!(fft_size_for_sample_rate(88200.0), 1024);
        assert_eq!(fft_size_for_sample_rate(96000.0), 1024);
        assert_eq!(fft_size_for_sample_rate(176400.0), 2048);
        // Degenerate rates give the minimum size and never panic.
        assert_eq!(fft_size_for_sample_rate(f32::NAN), 4);
        assert_eq!(fft_size_for_sample_rate(f32::INFINITY), 1usize << (usize::BITS - 1));
    }
}
