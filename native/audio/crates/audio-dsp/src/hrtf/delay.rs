// SPDX-License-Identifier: BSD-3-Clause
// Ported from chromium/src/third_party/blink/renderer/platform/audio/delay.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/delay.h @ cbba46fd94646232cfd2318ac962138c2a98c1f9
// Ported from chromium/src/third_party/blink/renderer/platform/audio/audio_utilities.cc @ cbba46fd94646232cfd2318ac962138c2a98c1f9
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

//! The interaural delay line: a port of Blink's `Delay` k-rate path (`SetDelayFrames`,
//! `ProcessKRate`, `Reset`) with `BufferLengthForDelay` and `audio_utilities::TimeToSampleFrame`
//! (round up).
//!
//! Differences from upstream: the buffer is a fixed array sized for the largest supported rate
//! (`buffer_length` of it is used), so the line is a plain value; the a-rate path,
//! `SetDelayTime` and the accessors the panner doesn't use are dropped; frames per call are at
//! most one render quantum (upstream's DCHECK, enforced by truncation); a NaN delay reads as 0
//! (upstream's `ClampTo` would pass it on into an undefined cast). Nothing here allocates.

use super::QUANTUM_FRAMES;

/// Room for `QUANTUM_FRAMES + ceil(0.002 s * 176.4 kHz)` frames, the panner's worst case.
pub const MAX_DELAY_BUFFER_FRAMES: usize = 512;

/// Upstream `Delay`, k-rate only.
#[derive(Clone, Copy)]
pub struct DelayLine {
    buffer: [f32; MAX_DELAY_BUFFER_FRAMES],
    buffer_length: usize,
    /// Upstream stores the maximum delay time as `float`.
    max_delay_time: f32,
    write_index: usize,
    desired_delay_frames: f64,
    sample_rate: f32,
}

impl DelayLine {
    /// `Delay(max_delay_time, sample_rate, render_quantum_frames)` with `render_quantum_frames` =
    /// 128: `buffer_length = 128 + TimeToSampleFrame(max_delay_time, sample_rate, kRoundUp)`,
    /// capped at [`MAX_DELAY_BUFFER_FRAMES`] (the panner checks its rate first).
    pub fn new(max_delay_time: f64, sample_rate: f32) -> Self {
        let buffer_length = (QUANTUM_FRAMES + time_to_sample_frame_round_up(max_delay_time, sample_rate as f64)).min(MAX_DELAY_BUFFER_FRAMES);
        Self {
            buffer: [0.0; MAX_DELAY_BUFFER_FRAMES],
            buffer_length,
            max_delay_time: max_delay_time as f32,
            write_index: 0,
            desired_delay_frames: 0.0,
            sample_rate,
        }
    }

    /// `SetDelayFrames`.
    pub fn set_delay_frames(&mut self, number_of_frames: f64) {
        self.desired_delay_frames = number_of_frames;
    }

    /// `ProcessKRate`: writes `source` into the ring, reads `destination` at the delay (clamped to
    /// 0..=max), linearly interpolating a fractional delay. Processes
    /// `min(source.len(), destination.len(), 128)` frames.
    pub fn process_k_rate(&mut self, source: &[f32], destination: &mut [f32]) {
        let frames = source.len().min(destination.len()).min(QUANTUM_FRAMES);
        let buffer_length = self.buffer_length;
        let sample_rate = self.sample_rate;
        let max_time = self.max_delay_time as f64;

        // DelayTime(), then ClampTo(delay_time, 0.0, max_time).
        let mut delay_time = self.desired_delay_frames / sample_rate as f64;
        if delay_time >= max_time {
            delay_time = max_time;
        } else if delay_time <= 0.0 || delay_time.is_nan() {
            delay_time = 0.0;
        }
        let desired_delay_frames = delay_time * sample_rate as f64;
        let mut w_index = self.write_index;
        let mut read_position = (w_index + buffer_length) as f64 - desired_delay_frames;
        if read_position >= buffer_length as f64 {
            read_position -= buffer_length as f64;
        }
        let read_index1 = (read_position as usize).min(buffer_length - 1);
        let interpolation_factor = (read_position - read_index1 as f64) as f32;

        // CopyToCircularBuffer.
        let remainder = buffer_length - self.write_index;
        let first = frames.min(remainder);
        self.buffer[self.write_index..self.write_index + first].copy_from_slice(&source[..first]);
        if frames > remainder {
            self.buffer[..frames - remainder].copy_from_slice(&source[remainder..frames]);
        }
        w_index += frames;
        if w_index >= buffer_length {
            w_index -= buffer_length;
        }
        self.write_index = w_index;

        let remainder = buffer_length - read_index1;
        let first = frames.min(remainder);
        destination[..first].copy_from_slice(&self.buffer[read_index1..read_index1 + first]);
        if frames > remainder {
            destination[remainder..frames].copy_from_slice(&self.buffer[..frames - remainder]);
        }

        if interpolation_factor != 0.0 {
            let read_index2 = (read_index1 + 1) % buffer_length;
            for (k, d) in destination[..frames].iter_mut().enumerate() {
                let mut j = read_index2 + k;
                if j >= buffer_length {
                    j -= buffer_length;
                }
                // Vsub then Vsma: dest += f * (temp - dest).
                let t = self.buffer[j] - *d;
                *d += interpolation_factor * t;
            }
        }
    }

    /// `Reset`: zeroes the buffer (the write index and delay stay, as upstream).
    pub fn reset(&mut self) {
        self.buffer = [0.0; MAX_DELAY_BUFFER_FRAMES];
    }
}

/// `audio_utilities::TimeToSampleFrame(time, sample_rate, kRoundUp)`: `ceil` of
/// `round(time * sample_rate * 1024) / 1024`.
pub fn time_to_sample_frame_round_up(time: f64, sample_rate: f64) -> usize {
    const OVERSAMPLE_FACTOR: f64 = 1024.0;
    let frame = libm::round(time * sample_rate * OVERSAMPLE_FACTOR) / OVERSAMPLE_FACTOR;
    let frame = libm::ceil(frame);
    if frame <= 0.0 || frame.is_nan() {
        0
    } else {
        frame as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_length_follows_buffer_length_for_delay() {
        assert_eq!(time_to_sample_frame_round_up(0.002, 48000.0), 96);
        assert_eq!(time_to_sample_frame_round_up(0.002, 44100.0), 89);
        assert_eq!(DelayLine::new(0.002, 48000.0).buffer_length, 224);
        assert_eq!(DelayLine::new(0.002, 176000.0).buffer_length, 480);
    }

    #[test]
    fn integer_and_fractional_delays_on_a_ramp() {
        let ramp: Vec<f32> = (1..=128).map(|i| i as f32).collect();
        let mut line = DelayLine::new(0.002, 48000.0);
        line.set_delay_frames(3.0);
        let mut out = [0.0f32; 128];
        line.process_k_rate(&ramp, &mut out);
        assert_eq!(&out[..5], &[0.0, 0.0, 0.0, 1.0, 2.0]);
        assert_eq!(out[127], 125.0);

        let mut line = DelayLine::new(0.002, 48000.0);
        line.set_delay_frames(2.5);
        line.process_k_rate(&ramp, &mut out);
        assert_eq!(&out[..5], &[0.0, 0.0, 0.5, 1.5, 2.5]);
        // The next quantum continues across the ring's wrap.
        let next: Vec<f32> = (129..=256).map(|i| i as f32).collect();
        line.process_k_rate(&next, &mut out);
        assert_eq!(out[0], 126.5);
        assert_eq!(out[127], 253.5);
    }

    #[test]
    fn delay_is_clamped_to_the_maximum() {
        let ramp: Vec<f32> = (1..=128).map(|i| i as f32).collect();
        let mut line = DelayLine::new(0.002, 48000.0);
        line.set_delay_frames(500.0);
        let mut out = [0.0f32; 128];
        line.process_k_rate(&ramp, &mut out);
        // The maximum is the float 0.002 (96.0000046 frames at 48 kHz), as upstream.
        assert!((out[96] - 1.0).abs() < 1e-4 && (out[97] - 2.0).abs() < 1e-4);
        line.set_delay_frames(f64::NAN);
        line.process_k_rate(&ramp, &mut out);
        assert_eq!(out[0], 1.0);
    }
}
