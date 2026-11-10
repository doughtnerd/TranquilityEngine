// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/dynamics_compressor.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/dynamics_compressor.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Copyright (C) 2011 Google Inc. All rights reserved.
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

//! The dynamics compressor: Blink's `DynamicsCompressor` (api-and-models §5), used by the bus
//! effect `compressor` (`audio-core`'s `fx.rs`, contract K5).
//!
//! **A passthrough stub until A2.2a.** A2.1 fixed the signatures `audio-core` calls; A2.2a ports
//! Blink's compressor (makeup gain, knee, adaptive release, pre-delay) into this module only and
//! sets [`PASSTHROUGH`] to `false`. Until then [`Compressor::process`] leaves the samples unchanged.
//!
//! Contract for the port:
//! - `#[repr(C)]` and **all-zero valid** (it lives in the zeroed `Buses` region, in a bus's effect
//!   slot): a zeroed `Compressor` must process without NaNs.
//! - Nothing allocates (the pre-delay line is a fixed array inside the struct); transcendentals
//!   through `libm`.
//! - The struct may grow: `audio-core` sizes a bus from `size_of` (`layout::BUS_BYTES`), so the
//!   pre-delay buffer's size is this module's choice (it multiplies by `fx::MAX_EFFECTS` slots per
//!   bus and by the bus count; architecture §5.1 budgets about 3 KB a bus).
//! - [`Compressor::configure`] is called on every BUS_CONFIG that keeps the slot a compressor; keep
//!   the envelope state then (no click).

/// `true` while this module is the A2.1 stub. A2.2a sets it to `false`.
pub const PASSTHROUGH: bool = true;

/// A stereo compressor. All-zero is valid.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Compressor {
    /// `threshold dB, knee dB, ratio, attack s, release s`, as BUS_CONFIG sends them.
    pub params: [f32; 5],
    /// The context rate it was configured for.
    pub sample_rate: f32,
}

impl Compressor {
    /// Sets the parameters (Web Audio's `DynamicsCompressorNode` units).
    pub fn configure(&mut self, sample_rate: f32, threshold_db: f32, knee_db: f32, ratio: f32, attack_s: f32, release_s: f32) {
        self.sample_rate = sample_rate;
        self.params = [threshold_db, knee_db, ratio, attack_s, release_s];
    }

    /// Compresses `left` and `right` in place (equal lengths, at most one quantum). Stub: unchanged.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let _ = (left, right);
    }

    /// Clears the envelope and the pre-delay line (Blink's `Reset`), keeping the parameters.
    pub fn reset(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_passes_samples_through() {
        let mut c = Compressor::default();
        c.configure(48_000.0, -24.0, 30.0, 12.0, 0.003, 0.25);
        let mut l = [0.5f32, -0.25];
        let mut r = [1.0f32, -1.0];
        c.process(&mut l, &mut r);
        assert_eq!((l, r), ([0.5, -0.25], [1.0, -1.0]));
    }
}
