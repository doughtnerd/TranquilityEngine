//! The linear resampler (api-and-models §5: "`resample` (linear, then the M1a.3 choice)").
//!
//! A voice reads its clip at a fractional position that advances by `pitch * clipRate /
//! contextRate` per output frame. [`linear`] renders a block of frames by linear interpolation
//! between neighbouring clip frames; [`advance`] moves the position the same way without reading
//! (virtual voices keep time, architecture §2.2). Both use exactly the same position arithmetic, so
//! a voice that goes virtual and comes back lands on the same frame it would have played.
//!
//! Clips are interleaved, 1 or 2 channels, f32 or int16 (architecture §5.2). Nothing allocates.

/// A clip's samples, interleaved (`frames * channels` values).
#[derive(Clone, Copy, Debug)]
pub enum Samples<'a> {
    F32(&'a [f32]),
    /// Converted as `s as f32 / 32768.0`.
    I16(&'a [i16]),
}

/// What the resampler reads: a clip's samples and shape.
#[derive(Clone, Copy, Debug)]
pub struct Source<'a> {
    pub samples: Samples<'a>,
    /// 1 or 2.
    pub channels: u32,
    /// Frames in the clip; `samples` holds at least `frames * channels` values.
    pub frames: u32,
}

/// Renders `out_l.len()` frames (`out_l`, `out_r` and `steps` have the same length) from `src`,
/// starting at `*pos` (in clip frames), by linear interpolation. Returns the frames written.
///
/// For each output frame `i`, in order:
/// 1. If `!looping` and `*pos >= frames as f64`: zero-fill `out_l[i..]` and `out_r[i..]` and return `i`.
/// 2. `idx = *pos as usize` (truncation; `*pos` is never negative), `t = (*pos - idx as f64) as f32`.
///    The next frame is `idx + 1` if `idx + 1 < frames`; else `0` when `looping`; else `idx` (the
///    last frame holds, as Chromium's `AudioBufferSourceNode` does).
/// 3. Per channel, `y = a + (b - a) * t` with `a` the sample at `idx`, `b` at the next frame.
///    `out_l[i]` is channel 0; `out_r[i]` is channel 1, or a copy of channel 0 for a mono clip.
/// 4. `*pos += steps[i] as f64`; then, if `looping`, `while *pos >= frames as f64 { *pos -= frames as f64 }`.
///
/// Returns `out_l.len()` when the block was filled. A clip with `frames == 0` writes zeros and
/// returns 0.
pub fn linear(src: &Source<'_>, pos: &mut f64, steps: &[f32], looping: bool, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let _ = (src, pos, steps, looping, out_l, out_r);
    todo!("A1.2-L1")
}

/// Moves `*pos` through `steps.len()` frames of a clip of `frames` frames without reading samples:
/// the position arithmetic of [`linear`] (steps 1 and 4) exactly. Returns the frames consumed:
/// `i` when a non-looping position reached `frames` before frame `i`, else `steps.len()`.
/// `frames == 0` returns 0.
pub fn advance(pos: &mut f64, steps: &[f32], frames: u32, looping: bool) -> usize {
    let _ = (pos, steps, frames, looping);
    todo!("A1.2-L1")
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "A1.2-L1"]
    fn unit_steps_read_the_clip_exactly() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn half_steps_interpolate_between_frames() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn double_steps_skip_frames() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn a_mono_clip_is_copied_to_both_outputs() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn a_stereo_clip_keeps_its_channels() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn int16_samples_are_scaled_by_1_over_32768() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn a_non_looping_clip_stops_and_zero_fills_at_its_end() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn the_last_frame_holds_when_not_looping() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn a_looping_clip_wraps_and_interpolates_across_the_seam() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn per_frame_steps_follow_a_changing_pitch() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn advance_matches_the_position_linear_reaches() {}

    #[test]
    #[ignore = "A1.2-L1"]
    fn an_empty_clip_renders_nothing() {}
}
