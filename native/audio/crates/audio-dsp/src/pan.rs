// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/equal_power_panner.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/equal_power_panner.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! The equal-power panner: a port of Blink's `EqualPowerPanner` (api-and-models §5, task A1.2).
//!
//! The port keeps upstream's structure and names (snake_case). Differences from upstream:
//! - `AudioBus` becomes channel slices: `source_r` is `None` for a mono input (upstream reads the
//!   left channel twice), and the destination is two slices of at least `frames_to_process`.
//! - `fdlibm::cos`/`fdlibm::sin` become `libm::cos`/`libm::sin` (both are fdlibm), so native and
//!   wasm give bit-identical gains.
//! - `ClampTo(azimuth, -180.0, 180.0)` is written out: `>= 180` gives 180, `<= -180` gives -180,
//!   anything else (NaN included) passes through, as `ClampTo` does.
//! - `UpdateDesiredGain` is public (upstream it's private) and `desired_gains` reads the cache, so
//!   `audio-core`'s `panner.rs` can turn an azimuth into gains without panning a buffer.
//! - The `Panner` base class, `Reset`, `TailTime`, `LatencyTime` and `RequiresTailProcessing` are
//!   dropped: the panner has no tail and no latency, and `Reset` is empty upstream.
//!
//! All-zero is a valid `EqualPowerPanner` (an uncached panner, as upstream's comment on
//! `cached_number_of_input_channels_` intends). Nothing here allocates.

/// π/2, upstream's `kPiOverTwoDouble`.
pub const PI_OVER_TWO_DOUBLE: f64 = core::f64::consts::FRAC_PI_2;

/// Upstream `EqualPowerPanner`: the "common type of stereo panner as found in normal audio mixing
/// equipment".
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EqualPowerPanner {
    desired_gain_l: f64,
    desired_gain_r: f64,
    cached_azimuth: f64,
    /// 0 (an illegal value) forces a cache refresh on the first `update_desired_gain`.
    cached_number_of_input_channels: i32,
}

impl EqualPowerPanner {
    /// Upstream's constructor: `UpdateDesiredGain(0.0, 1)` to initialise the cache. (The
    /// `sample_rate` argument is unused upstream and dropped.)
    pub fn new() -> EqualPowerPanner {
        let mut panner = EqualPowerPanner::default();
        panner.update_desired_gain(0.0, 1);
        panner
    }

    /// Upstream `Pan`: pans `frames_to_process` frames of a mono (`source_r == None`) or stereo
    /// input to the stereo destination with one azimuth (degrees; elevation is ignored upstream and
    /// not taken here). Returns early, writing nothing, if any slice is empty.
    pub fn pan(&mut self, azimuth: f64, source_l: &[f32], source_r: Option<&[f32]>, destination_l: &mut [f32], destination_r: &mut [f32], frames_to_process: usize) {
        let number_of_input_channels = if source_r.is_some() { 2 } else { 1 };
        let source_r = source_r.unwrap_or(source_l);
        if source_l.is_empty() || source_r.is_empty() || destination_l.is_empty() || destination_r.is_empty() {
            return;
        }

        let azimuth = self.update_desired_gain(azimuth, number_of_input_channels);
        let gain_l = self.desired_gain_l;
        let gain_r = self.desired_gain_r;

        if number_of_input_channels == 1 {
            // For mono source case.
            for i in 0..frames_to_process {
                let input_l = source_l[i];
                destination_l[i] = (input_l as f64 * gain_l) as f32;
                destination_r[i] = (input_l as f64 * gain_r) as f32;
            }
        } else if azimuth <= 0.0 {
            // from -90 -> 0
            for i in 0..frames_to_process {
                let input_l = source_l[i];
                let input_r = source_r[i];
                destination_l[i] = (input_l as f64 + input_r as f64 * gain_l) as f32;
                destination_r[i] = (input_r as f64 * gain_r) as f32;
            }
        } else {
            // from 0 -> +90
            for i in 0..frames_to_process {
                let input_l = source_l[i];
                let input_r = source_r[i];
                destination_l[i] = (input_l as f64 * gain_l) as f32;
                destination_r[i] = (input_r as f64 + input_l as f64 * gain_r) as f32;
            }
        }
    }

    /// Upstream `PanWithSampleAccurateValues`: as [`EqualPowerPanner::pan`] with one azimuth per
    /// frame (`azimuth.len() >= frames_to_process`).
    pub fn pan_with_sample_accurate_values(&mut self, azimuth: &[f64], source_l: &[f32], source_r: Option<&[f32]>, destination_l: &mut [f32], destination_r: &mut [f32], frames_to_process: usize) {
        let number_of_input_channels = if source_r.is_some() { 2 } else { 1 };
        let source_r = source_r.unwrap_or(source_l);
        if source_l.is_empty() || source_r.is_empty() || destination_l.is_empty() || destination_r.is_empty() {
            return;
        }

        if number_of_input_channels == 1 {
            // For mono source case.
            for i in 0..frames_to_process {
                let input_l = source_l[i];
                self.update_desired_gain(azimuth[i], number_of_input_channels);
                destination_l[i] = (input_l as f64 * self.desired_gain_l) as f32;
                destination_r[i] = (input_l as f64 * self.desired_gain_r) as f32;
            }
        } else {
            // For stereo source case.
            for i in 0..frames_to_process {
                let input_l = source_l[i];
                let input_r = source_r[i];
                let clamped_azimuth = self.update_desired_gain(azimuth[i], number_of_input_channels);
                if clamped_azimuth <= 0.0 {
                    // from -90 -> 0
                    destination_l[i] = (input_l as f64 + input_r as f64 * self.desired_gain_l) as f32;
                    destination_r[i] = (input_r as f64 * self.desired_gain_r) as f32;
                } else {
                    // from 0 -> +90
                    destination_l[i] = (input_l as f64 * self.desired_gain_l) as f32;
                    destination_r[i] = (input_r as f64 + input_l as f64 * self.desired_gain_r) as f32;
                }
            }
        }
    }

    /// Upstream `UpdateDesiredGain`: clamps and aliases `azimuth`, refreshes the cached gains when
    /// the azimuth or channel count changed, and returns the clamped, aliased azimuth.
    pub fn update_desired_gain(&mut self, azimuth: f64, number_of_input_channels: i32) -> f64 {
        // Clamp azimuth to allowed range of -180 -> +180 (ClampTo; NaN passes through).
        let mut azimuth = if azimuth >= 180.0 {
            180.0
        } else if azimuth <= -180.0 {
            -180.0
        } else {
            azimuth
        };

        // Alias the azimuth ranges behind us to in front of us:
        // -90 -> -180 to -90 -> 0 and 90 -> 180 to 90 -> 0
        if azimuth < -90.0 {
            azimuth = -180.0 - azimuth;
        } else if azimuth > 90.0 {
            azimuth = 180.0 - azimuth;
        }

        if self.cached_azimuth == azimuth && self.cached_number_of_input_channels == number_of_input_channels {
            return azimuth;
        }
        self.cached_azimuth = azimuth;
        self.cached_number_of_input_channels = number_of_input_channels;

        let desired_pan_position = if number_of_input_channels == 1 {
            // For mono source case: pan smoothly from left to right with azimuth going from
            // -90 -> +90 degrees.
            (azimuth + 90.0) / 180.0
        } else if azimuth <= 0.0 {
            // For stereo source case, from -90 -> 0: sourceL -> destL and "equal-power pan"
            // sourceR as in mono case by transforming the azimuth from -90 -> 0 into -90 -> +90.
            (azimuth + 90.0) / 90.0
        } else {
            // For stereo source case, from 0 -> +90: sourceR -> destR and "equal-power pan"
            // sourceL as in mono case by transforming the azimuth from 0 -> +90 into -90 -> +90.
            azimuth / 90.0
        };

        self.desired_gain_l = libm::cos(PI_OVER_TWO_DOUBLE * desired_pan_position);
        self.desired_gain_r = libm::sin(PI_OVER_TWO_DOUBLE * desired_pan_position);
        azimuth
    }

    /// The cached `(desired_gain_l, desired_gain_r)` from the last `update_desired_gain`.
    pub fn desired_gains(&self) -> (f64, f64) {
        (self.desired_gain_l, self.desired_gain_r)
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    const TOLERANCE: f64 = 1e-12;

    fn assert_near(actual: f64, expected: f64) {
        assert!((actual - expected).abs() <= TOLERANCE, "expected {expected}, got {actual}");
    }

    fn assert_gains(panner: &EqualPowerPanner, expected_l: f64, expected_r: f64) {
        let (l, r) = panner.desired_gains();
        assert_near(l, expected_l);
        assert_near(r, expected_r);
    }

    #[test]
    fn new_caches_the_centre_mono_gains() {
        let panner = EqualPowerPanner::new();
        assert_eq!(panner.cached_azimuth, 0.0);
        assert_eq!(panner.cached_number_of_input_channels, 1);
        assert_gains(&panner, core::f64::consts::FRAC_1_SQRT_2, core::f64::consts::FRAC_1_SQRT_2);
    }

    #[test]
    fn mono_gains_match_blinks_formula() {
        let half_sqrt = core::f64::consts::FRAC_1_SQRT_2;
        let cases: [(f64, f64, f64); 6] = [
            (0.0, half_sqrt, half_sqrt),
            (-90.0, 1.0, 0.0),
            (90.0, libm::cos(core::f64::consts::FRAC_PI_2), 1.0),
            (30.0, 0.5, 0.8660254037844386),
            (-30.0, 0.8660254037844386, 0.5),
            (135.0, 0.38268343236508984, 0.9238795325112867),
        ];
        for (azimuth, expected_l, expected_r) in cases {
            let mut panner = EqualPowerPanner::new();
            panner.update_desired_gain(azimuth, 1);
            assert_gains(&panner, expected_l, expected_r);
        }
    }

    #[test]
    fn stereo_gains_match_blinks_formula() {
        let half_sqrt = core::f64::consts::FRAC_1_SQRT_2;
        let cases: [(f64, f64, f64); 4] = [
            (-45.0, half_sqrt, half_sqrt),
            (0.0, libm::cos(core::f64::consts::FRAC_PI_2), 1.0),
            (45.0, half_sqrt, half_sqrt),
            (90.0, libm::cos(core::f64::consts::FRAC_PI_2), 1.0),
        ];
        for (azimuth, expected_l, expected_r) in cases {
            let mut panner = EqualPowerPanner::new();
            panner.update_desired_gain(azimuth, 2);
            assert_gains(&panner, expected_l, expected_r);
        }
    }

    #[test]
    fn azimuths_behind_alias_to_the_front_and_out_of_range_clamps() {
        let mut panner = EqualPowerPanner::new();
        assert_eq!(panner.update_desired_gain(135.0, 1), 45.0);
        let aliased = panner.desired_gains();
        assert_eq!(panner.update_desired_gain(45.0, 1), 45.0);
        assert_eq!(panner.desired_gains(), aliased);

        assert_eq!(panner.update_desired_gain(-135.0, 1), -45.0);
        assert_eq!(panner.update_desired_gain(-180.0, 1), 0.0);
        assert_eq!(panner.update_desired_gain(200.0, 1), 0.0);
        assert_eq!(panner.update_desired_gain(-200.0, 1), 0.0);
        assert_eq!(panner.update_desired_gain(f64::INFINITY, 2), 0.0);
        assert_eq!(panner.update_desired_gain(1000.0, 2), 0.0);
    }

    #[test]
    fn a_zeroed_panner_refreshes_on_first_use() {
        let mut panner = EqualPowerPanner::default();
        assert_gains(&panner, 0.0, 0.0);
        assert_eq!(panner.update_desired_gain(0.0, 1), 0.0);
        assert_gains(&panner, core::f64::consts::FRAC_1_SQRT_2, core::f64::consts::FRAC_1_SQRT_2);
    }

    #[test]
    fn pan_mono_scales_by_the_gains() {
        let mut panner = EqualPowerPanner::new();
        let source = [1.0f32, -0.5, 0.25, 0.0];
        let mut dest_l = [0.0f32; 4];
        let mut dest_r = [0.0f32; 4];
        panner.pan(0.0, &source, None, &mut dest_l, &mut dest_r, 4);
        let (gl, gr) = panner.desired_gains();
        for i in 0..4 {
            assert!((dest_l[i] as f64 - source[i] as f64 * gl).abs() < 1e-6);
            assert!((dest_r[i] as f64 - source[i] as f64 * gr).abs() < 1e-6);
        }
        assert_eq!(dest_l[0], dest_r[0]);
    }

    #[test]
    fn pan_stereo_left_and_right_halves() {
        let half_sqrt = core::f64::consts::FRAC_1_SQRT_2;
        let source_l = [1.0f32, 0.5];
        let source_r = [0.25f32, -0.5];

        // Azimuth -45: left passes through with right mixed in; right is scaled.
        let mut panner = EqualPowerPanner::new();
        let mut dest_l = [0.0f32; 2];
        let mut dest_r = [0.0f32; 2];
        panner.pan(-45.0, &source_l, Some(&source_r), &mut dest_l, &mut dest_r, 2);
        for i in 0..2 {
            let expected_l = (source_l[i] as f64 + source_r[i] as f64 * half_sqrt) as f32;
            let expected_r = (source_r[i] as f64 * half_sqrt) as f32;
            assert!((dest_l[i] - expected_l).abs() < 1e-6);
            assert!((dest_r[i] - expected_r).abs() < 1e-6);
        }

        // Azimuth 45: left is scaled; right passes through with left mixed in.
        let mut panner = EqualPowerPanner::new();
        let mut dest_l = [0.0f32; 2];
        let mut dest_r = [0.0f32; 2];
        panner.pan(45.0, &source_l, Some(&source_r), &mut dest_l, &mut dest_r, 2);
        for i in 0..2 {
            let expected_l = (source_l[i] as f64 * half_sqrt) as f32;
            let expected_r = (source_r[i] as f64 + source_l[i] as f64 * half_sqrt) as f32;
            assert!((dest_l[i] - expected_l).abs() < 1e-6);
            assert!((dest_r[i] - expected_r).abs() < 1e-6);
        }
    }

    #[test]
    fn pan_with_sample_accurate_values_updates_per_frame() {
        let half_sqrt = core::f64::consts::FRAC_1_SQRT_2;
        let source = [1.0f32, 1.0, 1.0];
        let azimuth = [-90.0f64, 0.0, 90.0];
        let mut panner = EqualPowerPanner::new();
        let mut dest_l = [0.0f32; 3];
        let mut dest_r = [0.0f32; 3];
        panner.pan_with_sample_accurate_values(&azimuth, &source, None, &mut dest_l, &mut dest_r, 3);
        assert!((dest_l[0] - 1.0).abs() < 1e-6 && dest_r[0].abs() < 1e-6);
        assert!((dest_l[1] - half_sqrt as f32).abs() < 1e-6 && (dest_r[1] - half_sqrt as f32).abs() < 1e-6);
        assert!(dest_l[2].abs() < 1e-6 && (dest_r[2] - 1.0).abs() < 1e-6);

        // Stereo: the branch follows each frame's clamped azimuth.
        let stereo_azimuth = [-45.0f64, 45.0];
        let source_l = [1.0f32, 0.5];
        let source_r = [0.25f32, -0.5];
        let mut dest_l = [0.0f32; 2];
        let mut dest_r = [0.0f32; 2];
        panner.pan_with_sample_accurate_values(&stereo_azimuth, &source_l, Some(&source_r), &mut dest_l, &mut dest_r, 2);
        let expected_l0 = (source_l[0] as f64 + source_r[0] as f64 * half_sqrt) as f32;
        let expected_r0 = (source_r[0] as f64 * half_sqrt) as f32;
        let expected_l1 = (source_l[1] as f64 * half_sqrt) as f32;
        let expected_r1 = (source_r[1] as f64 + source_l[1] as f64 * half_sqrt) as f32;
        assert!((dest_l[0] - expected_l0).abs() < 1e-6 && (dest_r[0] - expected_r0).abs() < 1e-6);
        assert!((dest_l[1] - expected_l1).abs() < 1e-6 && (dest_r[1] - expected_r1).abs() < 1e-6);
    }

    #[test]
    fn equal_power_keeps_mono_power_constant() {
        let mut azimuth = -90.0;
        while azimuth <= 90.0 {
            let mut panner = EqualPowerPanner::new();
            panner.update_desired_gain(azimuth, 1);
            let (l, r) = panner.desired_gains();
            assert!((l * l + r * r - 1.0).abs() <= TOLERANCE, "power at azimuth {azimuth}");
            azimuth += 5.0;
        }
    }

    #[test]
    fn empty_slices_write_nothing() {
        // Stereo with an empty right source: nothing is written and the cache is not refreshed.
        let mut panner = EqualPowerPanner::default();
        let mut dest_l = [7.0f32; 2];
        let mut dest_r = [7.0f32; 2];
        panner.pan(-45.0, &[1.0, 2.0], Some(&[]), &mut dest_l, &mut dest_r, 2);
        assert_eq!(dest_l, [7.0, 7.0]);
        assert_eq!(dest_r, [7.0, 7.0]);
        assert_gains(&panner, 0.0, 0.0);

        // Mono with an empty source, and an empty destination.
        panner.pan(0.0, &[], None, &mut dest_l, &mut dest_r, 0);
        assert_eq!(dest_l, [7.0, 7.0]);
        panner.pan(0.0, &[1.0, 2.0], None, &mut [], &mut dest_r, 2);
        assert_eq!(dest_r, [7.0, 7.0]);

        // Sample-accurate path behaves the same.
        panner.pan_with_sample_accurate_values(&[0.0, 0.0], &[1.0, 2.0], Some(&[]), &mut dest_l, &mut dest_r, 2);
        assert_eq!(dest_l, [7.0, 7.0]);
        assert_gains(&panner, 0.0, 0.0);
    }
}
