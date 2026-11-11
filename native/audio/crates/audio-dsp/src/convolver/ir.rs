// SPDX-License-Identifier: BSD-3-Clause
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Ported from chromium/src/third_party/blink/renderer/platform/audio/reverb.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! The shared reverb's impulse response: decaying stereo noise, generated rather than shipped, in
//! the shape of `makeImpulse` in `src/plugins/audio/testing/webAudioReference.ts` (1.8 s, decay
//! exponent 3), with a seeded generator instead of `Math.random`, so every build and every parity
//! scene hears the same room. The generator is Myco's code (Apache-2.0 OR MIT); the normalisation
//! is ported from Blink's `reverb.cc` (BSD-3-Clause).
//!
//! **Sample `i` of channel `c`** (`frames = floor(sample_rate * 1.8)`; channel 0's samples are
//! drawn first, then channel 1's, as `makeImpulse`'s loops):
//! `((u / 2^32) * 2 - 1) * e * e * e` with `e = 1 - i / frames`, in `f64`, rounded to `f32`, where
//! `u` is the next output of mulberry32 seeded with [`SEED`]. (The cube is two multiplications,
//! not `pow`: the same in TypeScript, and no `libm::pow` in the wasm.) mulberry32 is 32-bit integer
//! arithmetic, so a TypeScript reference reproduces every sample exactly with `Math.imul`:
//!
//! ```text
//! s = (s + 0x6D2B79F5) | 0; t = Math.imul(s ^ (s >>> 15), s | 1);
//! t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t; u = (t ^ (t >>> 14)) >>> 0;
//! ```
//!
//! **Normalisation** is Blink's (`CalculateNormalizationScale`, applied because a `ConvolverNode`
//! normalises by default): `1 / rms` over both channels (rms at least `kMinPower`), times
//! `10^(-58 / 20)` (`kGainCalibration`), times `44100 / sample_rate`. The convolver bakes the scale
//! into its partition spectra, as Blink's stages scale their kernels.
//!
//! Nothing here allocates: [`Generator`] yields the samples one at a time, so `init` transforms
//! the response straight into the convolver's region without storing it.

/// The impulse response's length in seconds (`makeImpulse`'s default).
pub const SECONDS: f64 = 1.8;
/// The envelope's exponent (`makeImpulse`'s `decay`), computed as a cube.
pub const DECAY: u32 = 3;
/// mulberry32's seed ("MYCO" in ASCII).
pub const SEED: u32 = 0x4D59_434F;
/// Channels of the response (left, right).
pub const CHANNELS: usize = 2;
/// The highest sample rate the response is generated for (Web Audio's upper bound); a higher rate
/// gets no reverb rather than an unbounded region.
pub const MAX_SAMPLE_RATE: f32 = 768_000.0;

// reverb.cc: "Empirical gain calibration tested across many impulse responses to ensure perceived
// volume is same as dry (unprocessed) signal".
const GAIN_CALIBRATION: f32 = -58.0;
const GAIN_CALIBRATION_SAMPLE_RATE: f32 = 44_100.0;
// reverb.cc: "A minimum power value to when normalizing a silent (or very quiet) impulse response".
const MIN_POWER: f32 = 0.000125;

/// Frames per channel at `sample_rate`: `floor(sample_rate * 1.8)`, at least 1; 0 for a rate that
/// isn't finite, positive and at most [`MAX_SAMPLE_RATE`].
pub const fn frames(sample_rate: f32) -> usize {
    if !(sample_rate > 0.0 && sample_rate <= MAX_SAMPLE_RATE) {
        return 0;
    }
    let n = (sample_rate as f64 * SECONDS) as usize;
    if n == 0 {
        1
    } else {
        n
    }
}

/// The response's samples in order: channel 0's `frames`, then channel 1's.
#[derive(Clone, Debug)]
pub struct Generator {
    state: u32,
    frames: usize,
    index: usize,
}

impl Generator {
    /// A generator positioned at sample 0 of channel 0.
    pub fn new(sample_rate: f32) -> Self {
        Self { state: SEED, frames: frames(sample_rate), index: 0 }
    }

    /// Frames per channel.
    pub fn frames(&self) -> usize {
        self.frames
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6D2B_79F5);
        let s = self.state;
        let mut t = (s ^ (s >> 15)).wrapping_mul(s | 1);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61)) ^ t;
        t ^ (t >> 14)
    }

    /// The next sample (channel 0 first, then channel 1); 0 once both channels are done.
    pub fn next_sample(&mut self) -> f32 {
        if self.frames == 0 || self.index >= CHANNELS * self.frames {
            return 0.0;
        }
        let i = self.index % self.frames;
        self.index += 1;
        let noise = (self.next_u32() as f64 / 4_294_967_296.0) * 2.0 - 1.0;
        let e = 1.0 - i as f64 / self.frames as f64;
        (noise * e * e * e) as f32
    }
}

/// Fills `left` and `right` (each at least [`frames`] long; extra samples are left alone) with the
/// response, unscaled. For tests and references; `init` uses [`Generator`] directly.
pub fn generate(sample_rate: f32, left: &mut [f32], right: &mut [f32]) {
    let mut g = Generator::new(sample_rate);
    let n = g.frames();
    for out in [left, right] {
        for x in out.iter_mut().take(n) {
            *x = g.next_sample();
        }
    }
}

/// Blink's `CalculateNormalizationScale` for the generated response at `sample_rate` (a pass of
/// the generator; the sum of squares runs in `f64` where Blink's `Vsvesq` sums `f32`).
pub fn normalization_scale(sample_rate: f32) -> f32 {
    let mut g = Generator::new(sample_rate);
    let n = g.frames();
    let mut sum = 0.0f64;
    for _ in 0..CHANNELS * n {
        let x = g.next_sample() as f64;
        sum += x * x;
    }
    blink_normalization_scale(sum, CHANNELS * n, sample_rate)
}

/// Blink's `CalculateNormalizationScale` from a response's sum of squares (`f64`, every channel's
/// samples) over `samples` samples in all, at `sample_rate`: `1 / rms` (rms at least `kMinPower`)
/// times `10^(-58 / 20)` times `44100 / sample_rate`. [`normalization_scale`] uses it for the
/// seeded response; the decoder's IR preparation (task C2a) uses it for zone IRs, passing the
/// result as `kernel::IrSpec::scale`.
#[inline(never)]
pub fn blink_normalization_scale(sum_squares: f64, samples: usize, sample_rate: f32) -> f32 {
    let sum = sum_squares;
    let mut power = if samples == 0 { 0.0 } else { libm::sqrt(sum / samples as f64) as f32 };
    // Protect against accidental overload.
    if !power.is_finite() || power < MIN_POWER {
        power = MIN_POWER;
    }
    let mut scale = 1.0 / power;
    // Calibrate to make perceived volume same as unprocessed.
    scale *= libm::powf(10.0, GAIN_CALIBRATION * 0.05);
    // Scale depends on sample-rate.
    if sample_rate > 0.0 {
        scale *= GAIN_CALIBRATION_SAMPLE_RATE / sample_rate;
    }
    scale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_follow_make_impulse() {
        assert_eq!(frames(48_000.0), 86_400);
        assert_eq!(frames(44_100.0), 79_380);
        assert_eq!(frames(0.0), 0);
        assert_eq!(frames(f32::NAN), 0);
        assert_eq!(frames(1e9), 0);
        assert_eq!(frames(0.1), 1);
    }

    /// mulberry32 written the way the JavaScript form reads (signed 32-bit, `Math.imul`).
    fn mulberry32_reference(seed: u32, draws: usize) -> u32 {
        let imul = |a: i32, b: i32| a.wrapping_mul(b);
        let mut s = seed as i32;
        let mut u = 0;
        for _ in 0..draws {
            s = s.wrapping_add(0x6D2B79F5);
            let mut t = imul(s ^ ((s as u32) >> 15) as i32, s | 1);
            t = t.wrapping_add(imul(t ^ ((t as u32) >> 7) as i32, t | 61)) ^ t;
            u = (t ^ ((t as u32) >> 14) as i32) as u32;
        }
        u
    }

    #[test]
    fn the_response_is_seeded_decaying_noise() {
        let n = frames(48_000.0);
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        generate(48_000.0, &mut l, &mut r);
        let (mut l2, mut r2) = (vec![0.0f32; n], vec![0.0f32; n]);
        generate(48_000.0, &mut l2, &mut r2);
        assert_eq!((&l, &r), (&l2, &r2), "deterministic");
        assert_ne!(l, r, "the channels differ");
        let mut g = Generator::new(48_000.0);
        for k in 1..=3 {
            assert_eq!(g.next_u32(), mulberry32_reference(SEED, k), "draw {k} as the TypeScript form computes it");
        }
        let energy = |x: &[f32]| x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
        assert!(energy(&l[..n / 10]) > 100.0 * energy(&l[n * 9 / 10..]));
        assert!(l.iter().chain(&r).all(|v| v.abs() <= 1.0));
        assert!(l[0].abs() > 0.0 && l[n - 1].abs() < 1e-12);
    }

    #[test]
    fn the_scale_normalises_by_rms() {
        let sr = 48_000.0;
        let n = frames(sr);
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        generate(sr, &mut l, &mut r);
        let rms = (l.iter().chain(&r).map(|v| (*v as f64).powi(2)).sum::<f64>() / (2 * n) as f64).sqrt();
        let want = (1.0 / rms) * 10f64.powf(-2.9) * 44_100.0 / 48_000.0;
        assert!((normalization_scale(sr) as f64 / want - 1.0).abs() < 1e-5);
        // Uniform noise under a (1 - x)^3 envelope has rms sqrt(1/21), about 0.218.
        assert!((rms - (1.0f64 / 21.0).sqrt()).abs() < 0.01, "{rms}");
    }
}
