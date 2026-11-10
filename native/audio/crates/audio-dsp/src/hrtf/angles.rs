// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/modules/webaudio/panner_handler.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/ui/gfx/geometry/vector3d_f.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/base/numerics/angle_conversions.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright 2022 The Chromium Authors (panner_handler.cc)
// Copyright 2012 The Chromium Authors (vector3d_f.cc)
// Copyright 2024 The Chromium Authors (angle_conversions.h)
// Use of this source code is governed by a BSD-style license that can be found in Chromium's LICENSE file
// (native/audio/third_party/blink/CHROMIUM-LICENSE: Copyright 2015 The Chromium Authors; clause 3 names Google LLC):
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

//! The HRTF panner's azimuth and elevation (task H5): `PannerHandler::CalculateAzimuthElevation`
//! for Web Audio's default listener, in Blink's own f32 arithmetic.
//!
//! The panner picks a kernel by truncating `azimuth / 1.875` and `(elevation + 45) / 15`, so a
//! source exactly on a grid line sits on the edge of two kernels, and the last bit of the angle
//! decides which (a step of 1.875 degrees in azimuth or 15 in elevation, several dB). Blink
//! computes the angles with `gfx::Vector3dF` (f32 components, squared lengths in f64), `acos` and
//! the degree conversion in float, and the elevation's `90 - angle` in float; this module does the
//! same operations in the same order, so a direction on a boundary picks Chromium's kernel.

/// `gfx::Vector3dF::GetNormalized`: the squared length in f64, then (above a length of 1e-6) each
/// component divided by the length rounded to f32. Below it, `v` unchanged and `false`.
fn normalized(v: [f32; 3]) -> ([f32; 3], bool) {
    let length_squared = v[0] as f64 * v[0] as f64 + v[1] as f64 * v[1] as f64 + v[2] as f64 * v[2] as f64;
    if length_squared < 1.0e-6 * 1.0e-6 {
        return (v, false);
    }
    let length = libm::sqrt(length_squared) as f32;
    ([v[0] / length, v[1] / length, v[2] / length], true)
}

/// `gfx::Vector3dF::Length`: the f64 length rounded to f32.
fn length(v: [f32; 3]) -> f32 {
    libm::sqrt(v[0] as f64 * v[0] as f64 + v[1] as f64 * v[1] as f64 + v[2] as f64 * v[2] as f64) as f32
}

/// `gfx::DotProduct`: f32, left to right.
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `acos` of a float in float (libc++'s `acos(float)` overload, `acosf`): computed in f64 and
/// rounded, which is `acosf` correctly rounded.
fn acos_f32(x: f32) -> f32 {
    libm::acos(x as f64) as f32
}

/// `base::RadToDeg<float>`'s factor, `180 / std::numbers::pi_v<float>` in float.
const RAD_TO_DEG_F32: f32 = 180.0 / core::f32::consts::PI;

/// The azimuth (-180..180, 0 ahead, +90 right) and elevation (-90..90, +90 up) in degrees of a
/// listener-space direction, as Blink's `PannerHandler::CalculateAzimuthElevation` computes them
/// for Web Audio's default listener (at the origin, forward -Z, up +Y), the direction standing for
/// the source's position. For that listener Blink's right vector (`normalize(forward x up)`) and
/// its recomputed up (`right x normalize(forward)`) are exactly (1, 0, 0) and (0, 1, 0). A
/// direction shorter than 1e-6 gives (0, 0), as upstream; a non-finite one also gives (0, 0)
/// (upstream would give an azimuth of 90).
pub fn azimuth_elevation(dir: [f32; 3]) -> (f64, f64) {
    const RIGHT: [f32; 3] = [1.0, 0.0, 0.0];
    const FORWARD: [f32; 3] = [0.0, 0.0, -1.0];
    const UP: [f32; 3] = [0.0, 1.0, 0.0];
    if !dir.iter().all(|c| c.is_finite()) {
        return (0.0, 0.0);
    }
    // Quick default return if the source and listener are at the same position.
    let (source, ok) = normalized(dir);
    if !ok {
        return (0.0, 0.0);
    }
    let up_projection = dot(source, UP);
    let projected = [source[0] - UP[0] * up_projection, source[1] - UP[1] * up_projection, source[2] - UP[2] * up_projection];
    // Upstream ignores whether this normalisation succeeded (a vertical source keeps its tiny or zero projection).
    let (projected, _) = normalized(projected);
    let mut azimuth = (acos_f32(dot(projected, RIGHT).clamp(-1.0, 1.0)) * RAD_TO_DEG_F32) as f64;
    // Source in front or behind the listener.
    if (dot(projected, FORWARD) as f64) < 0.0 {
        azimuth = 360.0 - azimuth;
    }
    // Make azimuth relative to "front" and not "right" listener vector.
    azimuth = if (0.0..=270.0).contains(&azimuth) { 90.0 - azimuth } else { 450.0 - azimuth };
    // `90 - gfx::AngleBetweenVectorsInDegrees(source, up)`: an int minus a float, so float.
    let cos = (dot(source, UP) / length(source) / length(UP)).min(1.0).max(-1.0);
    let mut elevation = (90.0f32 - acos_f32(cos) * RAD_TO_DEG_F32) as f64;
    if elevation > 90.0 {
        elevation = 180.0 - elevation;
    } else if elevation < -90.0 {
        elevation = -180.0 - elevation;
    }
    (azimuth, elevation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cardinal_directions() {
        assert_eq!(azimuth_elevation([0.0, 0.0, -1.0]), (0.0, 0.0));
        assert_eq!(azimuth_elevation([1.0, 0.0, 0.0]), (90.0, 0.0));
        assert_eq!(azimuth_elevation([-1.0, 0.0, 0.0]), (-90.0, 0.0));
        assert_eq!(azimuth_elevation([0.0, 0.0, 1.0]).0.abs(), 180.0);
        assert_eq!(azimuth_elevation([0.0, 1.0, 0.0]), (0.0, 90.0), "straight up");
        assert_eq!(azimuth_elevation([0.0, -2.0, 0.0]), (0.0, -90.0), "straight down");
        assert_eq!(azimuth_elevation([0.0, 0.0, 0.0]), (0.0, 0.0), "zero");
        assert_eq!(azimuth_elevation([1e-7, 0.0, 0.0]), (0.0, 0.0), "shorter than 1e-6");
        assert_eq!(azimuth_elevation([f32::NAN, 0.0, -1.0]), (0.0, 0.0), "not finite");
    }

    #[test]
    fn close_to_the_f64_angles_and_rounded_to_float_before_widening() {
        let mut seed = 0x1234_5678u32;
        let mut next = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 4.0 - 2.0
        };
        for _ in 0..1000 {
            let dir = [next(), next(), next()];
            let (az, el) = azimuth_elevation(dir);
            let (x, y, z) = (dir[0] as f64, dir[1] as f64, dir[2] as f64);
            let mut az64 = libm::atan2(x, -z).to_degrees();
            if (az64 - az).abs() > 180.0 {
                az64 += if az64 < az { 360.0 } else { -360.0 };
            }
            let el64 = 90.0 - libm::acos(y / libm::sqrt(x * x + y * y + z * z)).to_degrees();
            assert!((az - az64).abs() < 2e-3, "{dir:?}: {az} vs {az64}");
            assert!((el - el64).abs() < 2e-3, "{dir:?}: {el} vs {el64}");
            assert_eq!(el as f32 as f64, el);
        }
    }

    #[test]
    fn on_a_grid_line_the_result_is_the_f32_arithmetic() {
        // 30 degrees right, between azimuth kernels 15 and 16 (1.875 degrees each).
        let dir = [0.5f32, 0.0, -0.866_025_4];
        let (az, el) = azimuth_elevation(dir);
        assert_eq!(el, 0.0);
        let source = normalized(dir).0;
        let projected = normalized([source[0], 0.0, source[2]]).0;
        assert_eq!(az, 90.0 - (acos_f32(projected[0]) * RAD_TO_DEG_F32) as f64);
        assert!((az - 30.0).abs() < 1e-5);
    }
}
