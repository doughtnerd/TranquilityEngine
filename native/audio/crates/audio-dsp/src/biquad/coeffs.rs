// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! Blink's lowpass and highpass coefficient setters: `Biquad::SetLowpassParams`,
//! `SetHighpassParams` and `SetNormalizedCoefficients`, with the file's `pow10`. Line for line,
//! in `f64` as upstream, through `libm` (upstream's `fdlibm::sin`, `cos` and `expf`).

use core::f64::consts::{LN_10, PI};

/// `[b0, b1, b2, a1, a2]`, normalised by `a0`.
pub type Coefficients = [f64; 5];

/// The z-transform 1 (Blink's pass-thru, `SetNormalizedCoefficients(1, 0, 0, 1, 0, 0)`).
pub const IDENTITY: Coefficients = [1.0, 0.0, 0.0, 0.0, 0.0];
/// The z-transform 0.
pub const SILENT: Coefficients = [0.0; 5];

/// Upstream's `pow10`: `fdlibm::expf(x * ln 10)`, a single-precision exponential of a double
/// argument (so the linear Q carries float precision, as in Chromium).
pub fn pow10(x: f64) -> f64 {
    libm::expf((x * LN_10) as f32) as f64
}

/// `SetNormalizedCoefficients`: divides by `a0`.
pub fn normalized(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefficients {
    let a0_inverse = 1.0 / a0;
    [b0 * a0_inverse, b1 * a0_inverse, b2 * a0_inverse, a1 * a0_inverse, a2 * a0_inverse]
}

/// WTF's `ClampTo`: a NaN passes through (and then matches neither branch below, as upstream).
fn clamp01(x: f64) -> f64 {
    if x >= 1.0 {
        1.0
    } else if x <= 0.0 {
        0.0
    } else {
        x
    }
}

/// `SetLowpassParams`: `cutoff` is the frequency over Nyquist (0 to 1), `resonance` is Q in dB.
pub fn lowpass(cutoff: f64, resonance: f64) -> Coefficients {
    let cutoff = clamp01(cutoff);
    if cutoff == 1.0 {
        IDENTITY
    } else if cutoff > 0.0 {
        let resonance = pow10(resonance / 20.0);
        let theta = PI * cutoff;
        let alpha = libm::sin(theta) / (2.0 * resonance);
        let cosw = libm::cos(theta);
        let beta = (1.0 - cosw) / 2.0;
        normalized(beta, 2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha)
    } else {
        // Nothing gets through at a zero cut-off.
        SILENT
    }
}

/// `SetHighpassParams`: as [`lowpass`].
pub fn highpass(cutoff: f64, resonance: f64) -> Coefficients {
    let cutoff = clamp01(cutoff);
    if cutoff == 1.0 {
        SILENT
    } else if cutoff > 0.0 {
        let resonance = pow10(resonance / 20.0);
        let theta = PI * cutoff;
        let alpha = libm::sin(theta) / (2.0 * resonance);
        let cosw = libm::cos(theta);
        let beta = (1.0 + cosw) / 2.0;
        normalized(beta, -2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha)
    } else {
        // At a zero cut-off the z-transform is 1 (upstream avoids the 0/0 pole-zero pair).
        IDENTITY
    }
}

/// The normalised frequency `BiquadDSPKernel` hands the setters: `frequency / nyquist` in `f64`,
/// with Nyquist a float (`AudioDSPKernel::Nyquist`). The bus filters have no detune.
pub fn normalize_frequency(sample_rate: f32, frequency_hz: f32) -> f64 {
    let nyquist = 0.5 * sample_rate;
    frequency_hz as f64 / nyquist as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_follow_upstream() {
        assert_eq!(lowpass(1.0, 0.0), IDENTITY);
        assert_eq!(lowpass(2.0, 0.0), IDENTITY);
        assert_eq!(lowpass(0.0, 0.0), SILENT);
        assert_eq!(lowpass(-1.0, 0.0), SILENT);
        assert_eq!(highpass(1.0, 0.0), SILENT);
        assert_eq!(highpass(0.0, 0.0), IDENTITY);
        assert_eq!(lowpass(f64::NAN, 0.0), SILENT, "NaN matches neither branch");
    }

    #[test]
    fn a_lowpass_passes_dc_and_a_highpass_blocks_it() {
        let [b0, b1, b2, a1, a2] = lowpass(0.1, 3.0);
        assert!(((b0 + b1 + b2) / (1.0 + a1 + a2) - 1.0).abs() < 1e-12);
        let [b0, b1, b2, ..] = highpass(0.1, 3.0);
        assert!((b0 + b1 + b2).abs() < 1e-12);
    }
}
