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
//! A port of `biquad.cc` (A2.2a): [`coeffs`] holds the lowpass and highpass coefficient setters
//! (Q in dB: linear Q = 10^(q/20), through upstream's single-precision `pow10`), [`kernel`] the
//! direct-form processing (double history, float output). The coefficients are computed the way
//! `BiquadDSPKernel` does for k-rate parameters: from `frequency / nyquist`, whenever a value
//! changes.
//!
//! Contract (`audio-core` relies on it):
//! - `#[repr(C)]` and **all-zero valid**: a zeroed `Biquad` that was never set passes samples
//!   through (Blink's constructor initialises the filter as a pass-thru).
//! - Nothing allocates; transcendentals through `libm`.
//! - `set_*` may be called once per quantum with the same values: the filter state is kept and the
//!   coefficients are recomputed only when the kind, the frequency, the Q or the rate changed.

pub mod coeffs;
pub mod kernel;

/// `true` while this module was the A2.1 stub. The goldens use it to tell an exact passthrough
/// from a filtered bus. The port is in: `false`.
pub const PASSTHROUGH: bool = false;

/// `last[0]` of a filter never set (it passes samples through).
const KIND_NONE: f32 = 0.0;
const KIND_LOWPASS: f32 = 1.0;
const KIND_HIGHPASS: f32 = 2.0;

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
    /// The context rate of the last `set_*`.
    pub sample_rate: f32,
}

impl Biquad {
    /// Blink's `SetLowpassParams`: `frequency_hz` cut-off at `sample_rate`, `q_db` resonance in dB.
    pub fn set_lowpass(&mut self, sample_rate: f32, frequency_hz: f32, q_db: f32) {
        self.set(KIND_LOWPASS, sample_rate, frequency_hz, q_db);
    }

    /// Blink's `SetHighpassParams`: as [`Biquad::set_lowpass`].
    pub fn set_highpass(&mut self, sample_rate: f32, frequency_hz: f32, q_db: f32) {
        self.set(KIND_HIGHPASS, sample_rate, frequency_hz, q_db);
    }

    fn set(&mut self, kind: f32, sample_rate: f32, frequency_hz: f32, q_db: f32) {
        let args = [kind, frequency_hz, q_db];
        if self.last == args && self.sample_rate == sample_rate {
            return;
        }
        self.last = args;
        self.sample_rate = sample_rate;
        let cutoff = coeffs::normalize_frequency(sample_rate, frequency_hz);
        self.coefficients = if kind == KIND_LOWPASS { coeffs::lowpass(cutoff, q_db as f64) } else { coeffs::highpass(cutoff, q_db as f64) };
    }

    /// Filters `left` and `right` in place (equal lengths, at most one quantum).
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.last[0] == KIND_NONE {
            return;
        }
        kernel::process_stereo(&self.coefficients, &mut self.history, left, right);
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
    fn a_zeroed_filter_passes_samples_through() {
        let mut b = Biquad::default();
        let mut l = [0.5f32, -0.25, 1.0];
        let mut r = [0.125f32, 0.0, -1.0];
        b.process(&mut l, &mut r);
        assert_eq!((l, r), ([0.5, -0.25, 1.0], [0.125, 0.0, -1.0]));
    }

    #[test]
    fn an_unchanged_set_keeps_the_state_and_a_change_recomputes() {
        let mut b = Biquad::default();
        b.set_lowpass(48_000.0, 500.0, 1.0);
        let c = b.coefficients;
        let (mut l, mut r) = ([1.0f32; 8], [1.0f32; 8]);
        b.process(&mut l, &mut r);
        let h = b.history;
        b.set_lowpass(48_000.0, 500.0, 1.0);
        assert_eq!((b.coefficients, b.history), (c, h));
        b.set_lowpass(48_000.0, 600.0, 1.0);
        assert_ne!(b.coefficients, c);
        assert_eq!(b.history, h, "a parameter change keeps the history (no click)");
        b.set_highpass(48_000.0, 600.0, 1.0);
        assert_eq!(b.last, [2.0, 600.0, 1.0]);
        b.set_highpass(44_100.0, 600.0, 1.0);
        assert_eq!(b.sample_rate, 44_100.0);
    }

    #[test]
    fn a_lowpass_settles_to_dc_and_a_highpass_removes_it() {
        let mut lp = Biquad::default();
        let mut hp = Biquad::default();
        lp.set_lowpass(48_000.0, 800.0, 1.0);
        hp.set_highpass(48_000.0, 800.0, 1.0);
        let (mut a, mut b, mut c, mut d) = ([0.0f32; 128], [0.0f32; 128], [0.0f32; 128], [0.0f32; 128]);
        for _ in 0..40 {
            a = [0.5; 128];
            b = [0.5; 128];
            c = [0.5; 128];
            d = [0.5; 128];
            lp.process(&mut a, &mut b);
            hp.process(&mut c, &mut d);
        }
        assert!((a[127] - 0.5).abs() < 1e-4 && (b[127] - 0.5).abs() < 1e-4, "{} {}", a[127], b[127]);
        assert!(c[127].abs() < 1e-6 && d[127].abs() < 1e-6);
    }
}
