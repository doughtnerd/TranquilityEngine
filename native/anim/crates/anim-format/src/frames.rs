//! Where a clip's frames sit in time (ADR 0451, "As built: the clamped last frame").
//!
//! A clip of `duration` seconds at `rate` Hz has [`frame_count`] samples per sampled track,
//! `ceil(duration · rate − 1e-6) + 1`, and frame `i` sits at [`frame_time`] `min(i / rate,
//! duration)`. When `duration · rate` isn't whole, the last frame therefore sits at `duration`,
//! less than a full frame after the one before it. Every writer (the TypeScript raw clip writer
//! `engine/animation/compile/rawClip.ts`, the compressor's resampler) places frames by this rule,
//! and every reader maps time to frames with a [`FrameClock`], which honours it.
//!
//! Files whose frame count doesn't follow the rule still read: frame times are
//! `min(i / rate, duration)` whatever the count, so a count rounded down leaves a uniform grid
//! that ends before `duration` (held from its last frame on).

/// Samples per sampled track for a clip of `duration` seconds at `rate` Hz:
/// `ceil(duration · rate − 1e-6) + 1`, at least 1 (the 1e-6 absorbs float noise in a duration
/// that is a whole number of frames). A rate or duration that isn't a positive finite number
/// gives 1.
pub fn frame_count(duration: f64, rate: f64) -> u32 {
    let x = duration * rate;
    if !(x.is_finite() && x > 0.0) {
        return 1;
    }
    ((x - 1e-6).ceil().max(0.0) as u32).saturating_add(1)
}

/// The time of frame `i`: `min(i / rate, duration)`.
pub fn frame_time(i: u32, rate: f64, duration: f64) -> f64 {
    (i as f64 / rate).min(duration)
}

/// Where time `t` falls between two frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePos {
    /// The earlier frame.
    pub f0: u32,
    /// The later frame (`f0` at the end).
    pub f1: u32,
    /// The weight of `f1`, in [0, 1).
    pub alpha: f32,
}

/// Time-to-frame mapping of a clip: `f0 = floor(t · rate)`, `alpha = t · rate − f0`, except that
/// the segment ending on the last frame spans only up to the last frame's time, and from that
/// time on the last frame is held. Copy, no allocation; [`pos`](Self::pos) costs one compare and
/// one multiply over a uniform grid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameClock {
    rate: f32,
    last: u32,
    /// The last frame's position in frame units, `min(duration · rate, last)`.
    end_x: f32,
    /// `1 / (end_x − (last − 1))`: stretches the last segment's fraction to 0..1 (1 when the
    /// last frame is a full frame after the one before it).
    tail_scale: f32,
}

impl FrameClock {
    /// The clock of `frames` samples at `rate` Hz over `duration` seconds.
    pub fn new(duration: f32, rate: f32, frames: u32) -> Self {
        let last = frames.saturating_sub(1);
        let xd = duration * rate;
        // A duration within float noise (relative 1e-6) of the last frame's grid time is that
        // time: a uniform grid stays exactly uniform.
        let lastf = last as f32;
        let end_x = if xd.is_nan() || xd < 0.0 {
            0.0
        } else if xd >= lastf - 1e-6 * lastf.max(1.0) {
            lastf
        } else {
            xd
        };
        let tail = end_x - last.saturating_sub(1) as f32;
        let tail_scale = if last >= 1 && tail > 0.0 && tail < 1.0 {
            1.0 / tail
        } else {
            1.0
        };
        FrameClock {
            rate,
            last,
            end_x,
            tail_scale,
        }
    }

    /// A uniform grid: `frames` samples, frame `i` at `i / rate`.
    pub fn uniform(rate: f32, frames: u32) -> Self {
        Self::new(f32::INFINITY, rate, frames)
    }

    /// The frames around `t` seconds. Before 0 (and NaN) it is frame 0; from the last frame's
    /// time on, the last frame.
    #[inline]
    pub fn pos(&self, t: f32) -> FramePos {
        let x = t * self.rate;
        let x = if x >= 0.0 { x } else { 0.0 };
        if x >= self.end_x {
            return FramePos {
                f0: self.last,
                f1: self.last,
                alpha: 0.0,
            };
        }
        // x < end_x ≤ last, so f0 ≤ last − 1.
        let f0 = x.floor() as u32;
        let f1 = f0 + 1;
        let mut alpha = x - f0 as f32;
        if f1 == self.last {
            alpha *= self.tail_scale;
        }
        FramePos { f0, f1, alpha }
    }

    /// The time (seconds) of a fractional frame position `x` (clamped to `0..=last`): the inverse
    /// of [`pos`](Self::pos).
    pub fn time(&self, x: f32) -> f32 {
        let x = if x >= 0.0 {
            x.min(self.last as f32)
        } else {
            0.0
        };
        let penult = self.last.saturating_sub(1) as f32;
        let x = if self.last >= 1 && x > penult {
            penult + (x - penult) / self.tail_scale
        } else {
            x
        };
        x / self.rate
    }

    /// The last frame's time: the clip's duration, or earlier when its frames end before it.
    pub fn end_time(&self) -> f32 {
        self.end_x / self.rate
    }

    /// The frame count.
    pub fn frames(&self) -> u32 {
        self.last + 1
    }

    /// The sample rate, Hz.
    pub fn rate(&self) -> f32 {
        self.rate
    }
}
