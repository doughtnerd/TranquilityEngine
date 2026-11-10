// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/biquad.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! The biquad filter: Blink's `Biquad` (api-and-models §5), used by the bus effects `lowpass` and
//! `highpass` and by each bus's snapshot low-pass (`audio-core`'s `fx.rs`, contract K5).
//!
//! **A passthrough stub until A2.2a.** A2.1 fixed the signatures `audio-core` calls; A2.2a ports
//! Blink's coefficient setters (Q in dB, linear Q = 10^(q/20)) and the direct-form kernel into this
//! module only (it may split into `biquad/coeffs.rs` and `biquad/kernel.rs` beside this file) and
//! sets [`PASSTHROUGH`] to `false`. Until then [`Biquad::process`] leaves the samples unchanged.
//!
//! Contract for the port:
//! - `#[repr(C)]` and **all-zero valid** (it lives in the zeroed `Buses` region): a zeroed `Biquad`
//!   must process without NaNs (the stub's zeroed state is a passthrough).
//! - Nothing allocates; transcendentals through `libm`.
//! - The struct may grow: `audio-core` sizes a bus from `size_of` (`layout::BUS_BYTES`).
//! - `set_*` may be called once per quantum with the same values; keep the filter state then (no
//!   click), and recompute coefficients only when a value changed.

/// `true` while this module is the A2.1 stub (`process` leaves samples unchanged). The goldens use
/// it to tell an exact passthrough from a filtered bus. A2.2a sets it to `false`.
pub const PASSTHROUGH: bool = true;

/// A stereo biquad: the coefficients and both channels' history. All-zero is valid.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Biquad {
    /// `b0, b1, b2, a1, a2`, normalised by `a0` (Blink keeps doubles).
    pub coefficients: [f64; 5],
    /// Per channel `x1, x2, y1, y2`.
    pub history: [[f64; 4]; 2],
    /// The last `set_*` arguments `(kind, frequency, q)`, so an unchanged call keeps the
    /// coefficients (kind 0 none, 1 lowpass, 2 highpass).
    pub last: [f32; 3],
}

impl Biquad {
    /// Blink's `SetLowpassParams`: `frequency_hz` cut-off at `sample_rate`, `q_db` resonance in dB.
    pub fn set_lowpass(&mut self, sample_rate: f32, frequency_hz: f32, q_db: f32) {
        let _ = sample_rate;
        self.last = [1.0, frequency_hz, q_db];
    }

    /// Blink's `SetHighpassParams`: as [`Biquad::set_lowpass`].
    pub fn set_highpass(&mut self, sample_rate: f32, frequency_hz: f32, q_db: f32) {
        let _ = sample_rate;
        self.last = [2.0, frequency_hz, q_db];
    }

    /// Filters `left` and `right` in place (equal lengths, at most one quantum). Stub: unchanged.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let _ = (left, right);
    }

    /// Clears the history (Blink's `Reset`), keeping the coefficients.
    pub fn reset(&mut self) {
        self.history = [[0.0; 4]; 2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_passes_samples_through() {
        let mut b = Biquad::default();
        b.set_lowpass(48_000.0, 500.0, 1.0);
        let mut l = [0.5f32, -0.25, 1.0];
        let mut r = [0.125f32, 0.0, -1.0];
        b.process(&mut l, &mut r);
        assert!(PASSTHROUGH);
        assert_eq!(l, [0.5, -0.25, 1.0]);
        assert_eq!(r, [0.125, 0.0, -1.0]);
    }
}
