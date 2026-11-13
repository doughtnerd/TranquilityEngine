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
//! A port of `dynamics_compressor.cc` (A2.2a; at the pinned commit the old
//! `DynamicsCompressorKernel` is folded into this file): the static curve (linear to the
//! threshold, an exponential knee whose `k` is searched so its slope meets `1 / ratio`, then the
//! constant ratio), the makeup gain `(1 / saturate(1))^0.6`, the detector with its 2.5 ms
//! saturation release, the attack and the adaptive release (the fourth-order polynomial through
//! the release zones), the sine warp of the gain, and the 6 ms pre-delay (look-ahead), with the
//! detection stereo-linked (the louder channel). Arithmetic follows upstream's float and double
//! choices, transcendentals through `libm` (upstream's `fdlibm` and C library calls).
//!
//! Differences from upstream, none audible in the signal path:
//! - **Pre-delay line**: sized for 6 ms at 48 kHz ([`MAX_PRE_DELAY_FRAMES`], 288 frames) instead of
//!   upstream's 1,024-frame ring, so a bus's four effect slots stay small. At rates up to 48 kHz
//!   the delay is upstream's exactly; above, it is held at 288 frames (upstream holds it at 1,023,
//!   which it reaches at 170.5 kHz).
//! - **No metering**: upstream's `reduction` value (a per-frame `log10f`) feeds nothing on the
//!   bus, so it is not computed.
//! - **Parameters** are clamped to `DynamicsCompressorNode`'s nominal ranges in
//!   [`Compressor::configure`] (an `AudioParam` does the same before upstream sees them).
//! - **[`Compressor::reset`]** returns the compressor to a new node's state. Upstream's `Reset`
//!   leaves the write index at its 256-frame default without re-applying the pre-delay; here the
//!   next quantum re-runs the constructor's setup, so the pre-delay stays 6 ms.
//! - The work upstream does whose result goes unused is skipped (the knee curve of a near-silent
//!   frame, the saturation release rate of a frame that isn't releasing); results are unchanged.
//!
//! Contract (`audio-core` relies on it):
//! - `#[repr(C)]` and **all-zero valid**: a zeroed `Compressor` passes samples through until it is
//!   configured with a rate; the first quantum after that runs upstream's constructor setup.
//! - Nothing allocates (the pre-delay line is a fixed array inside the struct).
//! - [`Compressor::configure`] keeps the envelope and the pre-delay line, but sets the parameters
//!   at once: a changed threshold, knee or ratio steps the makeup gain at the next quantum (a
//!   click). A live edit glides instead ([`Compressor::glide`], driven per quantum by `fx.rs`).

use core::f32::consts::FRAC_PI_2;

/// `true` while this module was the A2.1 stub. The port is in: `false`.
pub const PASSTHROUGH: bool = false;

/// Upstream `kPreDelay`, seconds.
const PRE_DELAY_S: f32 = 0.006;
/// The longest pre-delay the line holds: 6 ms at 48 kHz.
pub const MAX_PRE_DELAY_FRAMES: u32 = 288;
/// The line's length: one more than the delay (a write precedes the read of the same frame).
const LINE: usize = MAX_PRE_DELAY_FRAMES as usize + 1;
/// Upstream `kDefaultPreDelayFrames`: the write index of a new node, before the first quantum.
const DEFAULT_PRE_DELAY_FRAMES: u32 = 256;
/// Upstream `kNumberOfDivisionFrames`: the envelope rate is updated every 32 frames.
const DIVISION_FRAMES: usize = 32;
/// Upstream `kSatReleaseTime`, seconds.
const SAT_RELEASE_TIME: f32 = 0.0025;
/// Upstream `kUninitializedValue`.
const UNINITIALIZED: f32 = -1.0;

// Release zone values 0 -> 1, and the polynomial's base coefficients (upstream's constexprs,
// evaluated in f32 in the same order).
const RELEASE_ZONE1: f32 = 0.09;
const RELEASE_ZONE2: f32 = 0.16;
const RELEASE_ZONE3: f32 = 0.42;
const RELEASE_ZONE4: f32 = 0.98;
const A_BASE: f32 = 0.999_999_999_999_999_8 * RELEASE_ZONE1 + 1.843_221_968_432_392_3e-16 * RELEASE_ZONE2 - 1.937_339_435_167_642_3e-16 * RELEASE_ZONE3 + 8.824_516_011_816_245e-18 * RELEASE_ZONE4;
const B_BASE: f32 = -1.578_832_035_284_588_8 * RELEASE_ZONE1 + 2.330_583_703_207_428_6 * RELEASE_ZONE2 - 0.914_119_420_484_042_9 * RELEASE_ZONE3 + 0.162_367_752_561_203_2 * RELEASE_ZONE4;
const C_BASE: f32 = 0.533_414_286_910_642_4 * RELEASE_ZONE1 - 1.272_736_789_213_631 * RELEASE_ZONE2 + 0.925_885_604_220_751_2 * RELEASE_ZONE3 - 0.186_563_101_917_762_26 * RELEASE_ZONE4;
const D_BASE: f32 = 0.087_834_631_382_072_34 * RELEASE_ZONE1 - 0.169_416_296_792_562_2 * RELEASE_ZONE2 + 0.085_880_579_515_952_72 * RELEASE_ZONE3 - 0.004_298_914_105_462_83 * RELEASE_ZONE4;
const E_BASE: f32 = -0.042_416_883_008_123_074 * RELEASE_ZONE1 + 0.111_569_382_798_760_2 * RELEASE_ZONE2 - 0.097_646_763_252_658_72 * RELEASE_ZONE3 + 0.028_494_263_462_021_576 * RELEASE_ZONE4;

/// `audio_utilities::LinearToDecibels`.
#[inline]
pub fn linear_to_db(linear: f32) -> f32 {
    20.0 * libm::log10f(linear)
}

/// `audio_utilities::DecibelsToLinear`.
#[inline]
pub fn db_to_linear(db: f32) -> f32 {
    libm::powf(10.0, 0.05 * db)
}

/// Upstream `EnsureFinite`.
#[inline]
fn ensure_finite(x: f32, default: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        default
    }
}

/// `DenormalDisabler::FlushDenormalFloatToZero`.
#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < f32::MIN_POSITIVE {
        0.0
    } else {
        x
    }
}

/// The static compression curve and its cached parameters (upstream's `ratio_` to `knee_`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Curve {
    pub ratio: f32,
    /// Inverse ratio.
    pub slope: f32,
    pub linear_threshold: f32,
    pub db_threshold: f32,
    pub db_knee: f32,
    pub knee_threshold: f32,
    pub db_knee_threshold: f32,
    pub db_yknee_threshold: f32,
    /// The knee's `k`.
    pub knee: f32,
}

impl Curve {
    const UNINITIALIZED: Curve = Curve {
        ratio: UNINITIALIZED,
        slope: UNINITIALIZED,
        linear_threshold: UNINITIALIZED,
        db_threshold: UNINITIALIZED,
        db_knee: UNINITIALIZED,
        knee_threshold: UNINITIALIZED,
        db_knee_threshold: UNINITIALIZED,
        db_yknee_threshold: UNINITIALIZED,
        knee: UNINITIALIZED,
    };

    /// `KneeCurve`: linear up to the threshold, then an exponential that is first-derivative
    /// matched there and approaches `linear_threshold + 1 / k`.
    pub fn knee_curve(&self, x: f32, k: f32) -> f32 {
        if x < self.linear_threshold {
            return x;
        }
        self.linear_threshold + (1.0 - libm::exp((-k * (x - self.linear_threshold)) as f64) as f32) / k
    }

    /// `Saturate`: the full curve, with the constant ratio after the knee.
    pub fn saturate(&self, x: f32, k: f32) -> f32 {
        if x < self.knee_threshold {
            return self.knee_curve(x, k);
        }
        let db_x = linear_to_db(x);
        let db_y = self.db_yknee_threshold + self.slope * (db_x - self.db_knee_threshold);
        db_to_linear(db_y)
    }

    /// `KAtSlope`: the `k` whose knee has slope `desired_slope` (in dB over dB) at the knee's end,
    /// by 15 steps of a geometric bisection.
    pub fn k_at_slope(&self, desired_slope: f32) -> f32 {
        let db_x = self.db_threshold + self.db_knee;
        let x = db_to_linear(db_x);
        let mut x2 = 1.0f32;
        let mut db_x2 = 0.0f32;
        if !(x < self.linear_threshold) {
            x2 = (x as f64 * 1.001) as f32;
            db_x2 = linear_to_db(x2);
        }
        let mut min_k = 0.1f32;
        let mut max_k = 10_000.0f32;
        let mut k = 5.0f32;
        let mut slope = 1.0f32;
        for _ in 0..15 {
            if !(x < self.linear_threshold) {
                let db_y = linear_to_db(self.knee_curve(x, k));
                let db_y2 = linear_to_db(self.knee_curve(x2, k));
                slope = (db_y2 - db_y) / (db_x2 - db_x);
            }
            if slope < desired_slope {
                max_k = k;
            } else {
                min_k = k;
            }
            k = libm::sqrtf(min_k * max_k);
        }
        k
    }

    /// `UpdateStaticCurveParameters`: recomputes when a parameter changed; returns `k`.
    pub fn update(&mut self, db_threshold: f32, db_knee: f32, ratio: f32) -> f32 {
        if db_threshold != self.db_threshold || db_knee != self.db_knee || ratio != self.ratio {
            self.db_threshold = db_threshold;
            self.linear_threshold = db_to_linear(db_threshold);
            self.db_knee = db_knee;
            self.ratio = ratio;
            self.slope = 1.0 / ratio;
            let k = self.k_at_slope(1.0 / ratio);
            self.db_knee_threshold = db_threshold + db_knee;
            self.knee_threshold = db_to_linear(self.db_knee_threshold);
            self.db_yknee_threshold = linear_to_db(self.knee_curve(self.knee_threshold, k));
            self.knee = k;
        }
        self.knee
    }
}

/// A stereo compressor. All-zero is valid (a passthrough until configured).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Compressor {
    /// `threshold dB, knee dB, ratio, attack s, release s`, as BUS_CONFIG sends them, clamped to
    /// `DynamicsCompressorNode`'s ranges.
    pub params: [f32; 5],
    /// The context rate it was configured for.
    pub sample_rate: f32,
    /// 0 until the first quantum runs upstream's constructor setup.
    pub constructed: u32,
    pub detector_average: f32,
    pub compressor_gain: f32,
    /// Upstream `db_max_attack_compression_diff_` (-1: none yet).
    pub db_max_attack_compression_diff: f32,
    pub curve: Curve,
    pub last_pre_delay_frames: u32,
    pub pre_delay_read: u32,
    pub pre_delay_write: u32,
    /// The look-ahead line, per channel.
    pub pre_delay: [[f32; LINE]; 2],
}

impl Default for Compressor {
    fn default() -> Compressor {
        // SAFETY: integers and floats only; all-zero is this type's documented empty state.
        unsafe { core::mem::zeroed() }
    }
}

/// `DynamicsCompressorNode`'s nominal ranges, `(min, max)` per parameter.
const RANGES: [(f32, f32); 5] = [(-100.0, 0.0), (0.0, 40.0), (1.0, 20.0), (0.0, 1.0), (0.0, 1.0)];

impl Compressor {
    /// Sets the parameters (Web Audio's `DynamicsCompressorNode` units: threshold dB, knee dB,
    /// ratio, attack s, release s; each clamped to the node's range, a NaN to its minimum).
    pub fn configure(&mut self, sample_rate: f32, threshold_db: f32, knee_db: f32, ratio: f32, attack_s: f32, release_s: f32) {
        self.sample_rate = sample_rate;
        self.params = Compressor::clamp([threshold_db, knee_db, ratio, attack_s, release_s]);
    }

    /// The parameters `threshold dB, knee dB, ratio, attack s, release s` clamped as
    /// [`Compressor::configure`] clamps them (each to the node's range, a NaN to its minimum): the
    /// target of a glide ([`Compressor::glide`]) compares equal to `params` exactly when
    /// `configure` would store the same values.
    pub fn clamp(raw: [f32; 5]) -> [f32; 5] {
        let mut out = [0.0f32; 5];
        for ((dst, v), (lo, hi)) in out.iter_mut().zip(raw).zip(RANGES) {
            *dst = if v >= hi {
                hi
            } else if v > lo {
                v
            } else {
                lo
            };
        }
        out
    }

    /// One quantum of a parameter glide (B4, R7: a compressor edit is smoothed over
    /// `COMPRESSOR_SMOOTH_MS`): moves `params` toward `target` (already [`Compressor::clamp`]ed)
    /// by `frames / frames_left` of the way, before the block of `frames` is compressed, and counts
    /// `frames_left` down; the quantum that reaches 0 lands on `target` exactly. So the parameters
    /// follow a straight line from where they were when the glide began (or was retargeted) to
    /// `target`, stepping once per quantum (S4: a threshold blended per quantum over 20 ms reads
    /// abrupt 0.19–0.23, the hard step 0.78). `frames_left` 0 does nothing: a compressor whose
    /// parameters don't change costs nothing here and processes bit-identically.
    ///
    /// The step is the click's cure: `process` derives the makeup gain
    /// (`(1 / saturate(1))^0.6`) from the curve once per quantum and applies it unsmoothed, so a
    /// threshold, knee or ratio jump steps the output's level within one sample (read in B4; S4
    /// inferred it from the step's shape). The envelope itself is smoothed by attack and release.
    pub fn glide(&mut self, target: &[f32; 5], frames_left: &mut u32, frames: u32) {
        if *frames_left == 0 {
            return;
        }
        if *frames_left <= frames {
            self.params = *target;
            *frames_left = 0;
            return;
        }
        let u = frames as f32 / *frames_left as f32;
        for (p, &t) in self.params.iter_mut().zip(target) {
            *p += (t - *p) * u;
        }
        *frames_left -= frames;
    }

    /// The pre-delay in frames at the configured rate (upstream's `SetPreDelayTime`, held at
    /// [`MAX_PRE_DELAY_FRAMES`]); the compressor's latency.
    pub fn pre_delay_frames(&self) -> u32 {
        ((PRE_DELAY_S * self.sample_rate) as u32).min(MAX_PRE_DELAY_FRAMES)
    }

    /// Upstream's constructor after `SetNumberOfChannels(2)`: `Reset()` and uninitialised curve
    /// parameters (the line is already zero or is zeroed here).
    fn construct(&mut self) {
        self.detector_average = 0.0;
        self.compressor_gain = 1.0;
        self.db_max_attack_compression_diff = -1.0;
        self.pre_delay = [[0.0; LINE]; 2];
        self.pre_delay_read = 0;
        self.pre_delay_write = DEFAULT_PRE_DELAY_FRAMES;
        self.last_pre_delay_frames = DEFAULT_PRE_DELAY_FRAMES;
        self.curve = Curve::UNINITIALIZED;
        self.constructed = 1;
    }

    /// Upstream `SetPreDelayTime(kPreDelay)`: a changed delay clears the line.
    fn set_pre_delay(&mut self) {
        let frames = self.pre_delay_frames();
        if self.last_pre_delay_frames != frames {
            self.last_pre_delay_frames = frames;
            self.pre_delay = [[0.0; LINE]; 2];
            self.pre_delay_read = 0;
            self.pre_delay_write = frames;
        }
    }

    /// Compresses `left` and `right` in place (equal lengths, at most one quantum): upstream's
    /// `Process` with the source and destination the same stereo bus.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        if !(self.sample_rate > 0.0) {
            return;
        }
        if self.constructed == 0 {
            self.construct();
        }
        let frames = left.len().min(right.len());
        let [db_threshold, db_knee, ratio, attack_time, release_time] = self.params;
        let sample_rate = self.sample_rate;

        let k = self.curve.update(db_threshold, db_knee, ratio);
        let curve = self.curve;

        // Makeup gain with empirical/perceptual tuning.
        let linear_post_gain = libm::powf(1.0 / curve.saturate(1.0, k), 0.6);

        let attack_frames = 0.001f32.max(attack_time) * sample_rate;
        let release_frames = sample_rate * release_time;
        let sat_release_frames = SAT_RELEASE_TIME * sample_rate;
        // The saturation release rate of a frame whose attenuation is at most 2 dB.
        let sat_release_rate_2db = db_to_linear(2.0 / sat_release_frames) - 1.0;

        // The adaptive release polynomial y = a + b x + c x^2 + d x^3 + e x^4, through the
        // release zones at x = 0, 1, 2, 3 (-15, -10, -5, 0 dB of compression difference).
        let a = release_frames * A_BASE;
        let b = release_frames * B_BASE;
        let c = release_frames * C_BASE;
        let d = release_frames * D_BASE;
        let e = release_frames * E_BASE;

        self.set_pre_delay();

        let mut frame_index = 0usize;
        while frame_index < frames {
            self.detector_average = ensure_finite(self.detector_average, 1.0);
            let desired_gain = self.detector_average;

            // Pre-warp so we get desired_gain after the sin() warp below.
            let scaled_desired_gain = libm::asinf(desired_gain) / FRAC_PI_2;

            let is_releasing = scaled_desired_gain > self.compressor_gain;
            let mut db_compression_diff = if scaled_desired_gain == 0.0 {
                if is_releasing {
                    -1.0
                } else {
                    1.0
                }
            } else {
                linear_to_db(self.compressor_gain / scaled_desired_gain)
            };

            let envelope_rate = if is_releasing {
                // Release: the difference is negative dB. Higher compression releases faster.
                self.db_max_attack_compression_diff = -1.0;
                db_compression_diff = ensure_finite(db_compression_diff, -1.0);
                // Contain within -12 to 0, then scale to 0 to 3.
                let mut x = db_compression_diff;
                x = if x >= 0.0 {
                    0.0
                } else if x <= -12.0 {
                    -12.0
                } else {
                    x
                };
                x = 0.25 * (x + 12.0);
                let x2 = x * x;
                let x3 = x2 * x;
                let x4 = x2 * x2;
                let calc_release_frames = a + b * x + c * x2 + d * x3 + e * x4;
                const DB_SPACING: f32 = 5.0;
                let db_per_frame = DB_SPACING / calc_release_frames;
                db_to_linear(db_per_frame)
            } else {
                // Attack: the difference is positive dB; the rate follows the largest seen.
                db_compression_diff = ensure_finite(db_compression_diff, 1.0);
                if self.db_max_attack_compression_diff == -1.0 || self.db_max_attack_compression_diff < db_compression_diff {
                    self.db_max_attack_compression_diff = db_compression_diff;
                }
                let db_eff_atten_diff = 0.5f32.max(self.db_max_attack_compression_diff);
                let x = 0.25 / db_eff_atten_diff;
                1.0 - libm::powf(x, 1.0 / attack_frames)
            };

            let mut read = self.pre_delay_read as usize;
            let mut write = self.pre_delay_write as usize;
            let mut detector_average = self.detector_average;
            let mut compressor_gain = self.compressor_gain;

            let end = frames.min(frame_index + DIVISION_FRAMES);
            while frame_index < end {
                // Pre-delay the signal; compute the compression from the undelayed frame, linked
                // across channels (the louder one).
                let undelayed_l = left[frame_index];
                let undelayed_r = right[frame_index];
                self.pre_delay[0][write] = undelayed_l;
                self.pre_delay[1][write] = undelayed_r;
                let mut compressor_input = 0.0f32;
                for s in [undelayed_l, undelayed_r] {
                    let abs = if s > 0.0 { s } else { -s };
                    if compressor_input < abs {
                        compressor_input = abs;
                    }
                }
                let abs_input = compressor_input;

                // The shaping curve: linear to the threshold, the knee, then the ratio.
                let attenuation = if abs_input <= 0.0001 { 1.0 } else { curve.saturate(abs_input, k) / abs_input };

                let is_release = attenuation > detector_average;
                let rate = if is_release {
                    let db_attenuation = if attenuation == 1.0 { 2.0 } else { 2.0f32.max(-linear_to_db(attenuation)) };
                    if db_attenuation == 2.0 {
                        sat_release_rate_2db
                    } else {
                        db_to_linear(db_attenuation / sat_release_frames) - 1.0
                    }
                } else {
                    1.0
                };
                detector_average += (attenuation - detector_average) * rate;
                detector_average = 1.0f32.min(detector_average);
                detector_average = ensure_finite(detector_average, 1.0);

                // Exponential approach to the desired gain.
                if envelope_rate < 1.0 {
                    compressor_gain += (scaled_desired_gain - compressor_gain) * envelope_rate;
                } else {
                    compressor_gain *= envelope_rate;
                    compressor_gain = 1.0f32.min(compressor_gain);
                }

                // Warp the gain to smooth out sharp exponential transitions, then the makeup gain.
                let post_warp_compressor_gain = libm::sin((FRAC_PI_2 * compressor_gain) as f64) as f32;
                let total_gain = linear_post_gain * post_warp_compressor_gain;

                left[frame_index] = self.pre_delay[0][read] * total_gain;
                right[frame_index] = self.pre_delay[1][read] * total_gain;

                frame_index += 1;
                read += 1;
                if read == LINE {
                    read = 0;
                }
                write += 1;
                if write == LINE {
                    write = 0;
                }
            }

            self.pre_delay_read = read as u32;
            self.pre_delay_write = write as u32;
            self.detector_average = flush(detector_average);
            self.compressor_gain = flush(compressor_gain);
        }
    }

    /// Clears the envelope and the pre-delay line, keeping the parameters: the next quantum starts
    /// as a new node would (see the module notes on upstream's `Reset`).
    pub fn reset(&mut self) {
        self.constructed = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zeroed_compressor_passes_samples_through() {
        let mut c = Compressor::default();
        let mut l = [0.5f32, -0.25];
        let mut r = [1.0f32, -1.0];
        c.process(&mut l, &mut r);
        assert_eq!((l, r), ([0.5, -0.25], [1.0, -1.0]));
        c.reset();
        c.process(&mut l, &mut r);
        assert_eq!((l, r), ([0.5, -0.25], [1.0, -1.0]));
    }

    #[test]
    fn configure_clamps_to_the_node_ranges() {
        let mut c = Compressor::default();
        c.configure(48_000.0, -200.0, 50.0, 0.0, f32::NAN, 2.0);
        assert_eq!(c.params, [-100.0, 40.0, 1.0, 0.0, 1.0]);
        c.configure(48_000.0, -24.0, 30.0, 12.0, 0.003, 0.25);
        assert_eq!(c.params, [-24.0, 30.0, 12.0, 0.003, 0.25]);
    }

    #[test]
    fn the_pre_delay_is_6_ms_up_to_48_khz() {
        let mut c = Compressor::default();
        for (rate, frames) in [(8_000.0, 48), (44_100.0, 264), (48_000.0, 288), (96_000.0, 288)] {
            c.configure(rate, -24.0, 30.0, 12.0, 0.003, 0.25);
            assert_eq!(c.pre_delay_frames(), frames, "{rate}");
        }
    }

    #[test]
    fn the_release_polynomial_passes_through_the_zones() {
        let p = |x: f32| A_BASE + B_BASE * x + C_BASE * x * x + D_BASE * x * x * x + E_BASE * x * x * x * x;
        for (x, zone) in [(0.0, RELEASE_ZONE1), (1.0, RELEASE_ZONE2), (2.0, RELEASE_ZONE3), (3.0, RELEASE_ZONE4)] {
            assert!((p(x) - zone).abs() < 1e-6, "x = {x}: {} vs {zone}", p(x));
        }
    }

    #[test]
    fn configure_keeps_the_envelope() {
        let mut c = Compressor::default();
        c.configure(48_000.0, -24.0, 30.0, 12.0, 0.003, 0.25);
        let (mut l, mut r) = ([0.9f32; 128], [0.9f32; 128]);
        c.process(&mut l, &mut r);
        let (gain, line) = (c.compressor_gain, c.pre_delay);
        c.configure(48_000.0, -30.0, 30.0, 12.0, 0.003, 0.25);
        assert_eq!((c.compressor_gain, c.pre_delay), (gain, line));
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
    }

    #[test]
    fn clamp_is_configures_clamp() {
        let mut c = Compressor::default();
        for raw in [[-200.0, 50.0, 0.0, f32::NAN, 2.0], [-24.0, 30.0, 12.0, 0.003, 0.25], [0.0, 0.0, 1.0, 1.0, -1.0]] {
            c.configure(48_000.0, raw[0], raw[1], raw[2], raw[3], raw[4]);
            assert_eq!(Compressor::clamp(raw), c.params);
        }
    }

    #[test]
    fn a_glide_is_a_straight_line_per_quantum_and_lands_on_the_target() {
        let mut c = Compressor::default();
        c.configure(48_000.0, -24.0, 6.0, 4.0, 0.003, 0.25);
        let target = Compressor::clamp([-40.0, 6.0, 8.0, 0.003, 0.25]);
        let mut left = 960u32;
        let mut seen = vec![];
        while left > 0 {
            c.glide(&target, &mut left, 128);
            seen.push(c.params);
        }
        assert_eq!(seen.len(), 8, "960 frames take 8 quanta (the last one lands)");
        assert_eq!(c.params, target, "exactly on the target");
        for (q, p) in seen.iter().enumerate().take(7) {
            let u = (q + 1) as f32 * 128.0 / 960.0;
            assert!((p[0] - (-24.0 - 16.0 * u)).abs() < 1e-4, "quantum {q}: threshold {}", p[0]);
            assert!((p[2] - (4.0 + 4.0 * u)).abs() < 1e-5, "quantum {q}: ratio {}", p[2]);
            assert_eq!((p[1], p[3], p[4]), (6.0, 0.003, 0.25), "unchanged parameters stay exact");
        }
        let before = c;
        c.glide(&target, &mut left, 128);
        assert_eq!(c, before, "no glide: nothing moves");
    }
}
