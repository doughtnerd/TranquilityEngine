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
    let _ = azimuth;
    todo!("H1-L1")
}

/// `IndexFromElevationAngle` (hrtf_database.cc): the elevation index 0..10 for an angle in degrees,
/// clamped to -45..=90 first, then `(int)((angle + 45) / 15)`. NaN gives 0.
pub fn index_from_elevation_angle(elevation_angle: f64) -> usize {
    let _ = elevation_angle;
    todo!("H1-L1")
}

/// The elevation index whose data a raw azimuth actually uses for elevation index
/// `elevation_index`: `CreateForSubject` loads `min(elevation, kMaxElevations[raw])`, so the angle
/// `-45 + 15 * elevation_index` is capped at `MAX_ELEVATIONS[raw_azimuth]` and turned back into an
/// index. `elevation_index` must be below 10 and `raw_azimuth` below 24 (larger values are clamped
/// to the last valid index).
pub fn raw_elevation_index(elevation_index: usize, raw_azimuth: usize) -> usize {
    let _ = (elevation_index, raw_azimuth);
    todo!("H1-L1")
}

/// The raw pair and weight for an azimuth index 0..192 (see [`AzimuthPair`]). An index of 192 or
/// more is taken modulo 192.
pub fn azimuth_pair(azimuth_index: usize) -> AzimuthPair {
    let _ = azimuth_index;
    todo!("H1-L1")
}

/// `HRTFPanner::FftSizeForSampleRate`: the kernel FFT size for a context rate. The 256-frame
/// truncated response is resampled (`256 * (sample_rate / 44100)`, the ratio computed in `f32`
/// as upstream divides a `float` by an `int`), the analysis size is `1 << (unsigned)log2(that)`
/// (at least `FFTFrame::MinFFTSize()` = 2), and the result is twice the analysis size. 512 at
/// 44.1 and 48 kHz, 1024 at 88.2 and 96 kHz.
pub fn fft_size_for_sample_rate(sample_rate: f32) -> usize {
    let _ = sample_rate;
    todo!("H1-L1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "H1-L1"]
    fn azimuth_index_and_blend_match_chromium() {
        let _ = calculate_desired_azimuth_index_and_blend(0.0);
    }

    #[test]
    #[ignore = "H1-L1"]
    fn elevation_index_matches_chromium() {
        let _ = index_from_elevation_angle(0.0);
    }

    #[test]
    #[ignore = "H1-L1"]
    fn raw_elevation_index_applies_max_elevations() {
        let _ = raw_elevation_index(9, 1);
    }

    #[test]
    #[ignore = "H1-L1"]
    fn azimuth_pair_matches_create_for_subject() {
        let _ = azimuth_pair(0);
    }

    #[test]
    #[ignore = "H1-L1"]
    fn fft_size_matches_chromium() {
        let _ = fft_size_for_sample_rate(48000.0);
    }
}
