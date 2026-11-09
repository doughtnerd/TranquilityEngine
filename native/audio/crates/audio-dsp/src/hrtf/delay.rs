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
//! most one render quantum (upstream's DCHECK). Nothing here allocates.

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
    /// which must fit [`MAX_DELAY_BUFFER_FRAMES`] (the panner checks its rate first).
    pub fn new(max_delay_time: f64, sample_rate: f32) -> Self {
        let _ = (max_delay_time, sample_rate, QUANTUM_FRAMES);
        todo!("H1-core")
    }

    /// `SetDelayFrames`.
    pub fn set_delay_frames(&mut self, number_of_frames: f64) {
        self.desired_delay_frames = number_of_frames;
    }

    /// `ProcessKRate`: writes `source` into the ring, reads `destination` at the delay (clamped to
    /// 0..=max), linearly interpolating a fractional delay. `source.len() == destination.len()`,
    /// at most 128.
    pub fn process_k_rate(&mut self, source: &[f32], destination: &mut [f32]) {
        let _ = (source, destination, &self.buffer, self.buffer_length, self.max_delay_time, self.write_index, self.sample_rate);
        todo!("H1-core")
    }

    /// `Reset`: zeroes the buffer (the write index and delay stay, as upstream).
    pub fn reset(&mut self) {
        self.buffer = [0.0; MAX_DELAY_BUFFER_FRAMES];
    }
}

/// `audio_utilities::TimeToSampleFrame(time, sample_rate, kRoundUp)`: `ceil` of
/// `round(time * sample_rate * 1024) / 1024`.
pub fn time_to_sample_frame_round_up(time: f64, sample_rate: f64) -> usize {
    let _ = (time, sample_rate);
    todo!("H1-core")
}
