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
/// Reads one interleaved sample as f32 (int16 scaled by 1/32768).
#[inline]
fn sample(samples: &Samples<'_>, index: usize) -> f32 {
    match *samples {
        Samples::F32(s) => s[index],
        Samples::I16(s) => s[index] as f32 / 32768.0,
    }
}

pub fn linear(src: &Source<'_>, pos: &mut f64, steps: &[f32], looping: bool, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
    let len = out_l.len();
    debug_assert!(out_r.len() == len && steps.len() == len);
    let frames = src.frames as usize;
    if frames == 0 {
        out_l.fill(0.0);
        out_r.fill(0.0);
        return 0;
    }
    let frames_f = frames as f64;
    let stereo = src.channels == 2;
    if looping {
        // A position handed in past the end wraps first, the same way step 4 keeps it.
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    for i in 0..len {
        if !looping && *pos >= frames_f {
            out_l[i..].fill(0.0);
            out_r[i..].fill(0.0);
            return i;
        }
        let idx = *pos as usize;
        let t = (*pos - idx as f64) as f32;
        let next = if idx + 1 < frames {
            idx + 1
        } else if looping {
            0
        } else {
            idx
        };
        if stereo {
            let l0 = sample(&src.samples, 2 * idx);
            let l1 = sample(&src.samples, 2 * next);
            let r0 = sample(&src.samples, 2 * idx + 1);
            let r1 = sample(&src.samples, 2 * next + 1);
            out_l[i] = l0 + (l1 - l0) * t;
            out_r[i] = r0 + (r1 - r0) * t;
        } else {
            let a = sample(&src.samples, idx);
            let b = sample(&src.samples, next);
            let y = a + (b - a) * t;
            out_l[i] = y;
            out_r[i] = y;
        }
        *pos += steps[i] as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    len
}

/// Moves `*pos` through `steps.len()` frames of a clip of `frames` frames without reading samples:
/// the position arithmetic of [`linear`] (steps 1 and 4) exactly. Returns the frames consumed:
/// `i` when a non-looping position reached `frames` before frame `i`, else `steps.len()`.
/// `frames == 0` returns 0.
pub fn advance(pos: &mut f64, steps: &[f32], frames: u32, looping: bool) -> usize {
    if frames == 0 {
        return 0;
    }
    let frames_f = frames as f64;
    if looping {
        while *pos >= frames_f {
            *pos -= frames_f;
        }
    }
    for (i, &step) in steps.iter().enumerate() {
        if !looping && *pos >= frames_f {
            return i;
        }
        *pos += step as f64;
        if looping {
            while *pos >= frames_f {
                *pos -= frames_f;
            }
        }
    }
    steps.len()
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    /// Frame `i` holds `i / 256`, so interpolated values are exact in f32.
    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| i as f32 / 256.0).collect()
    }

    fn mono(data: &[f32]) -> Source<'_> {
        Source { samples: Samples::F32(data), channels: 1, frames: data.len() as u32 }
    }

    fn stereo(data: &[f32]) -> Source<'_> {
        Source { samples: Samples::F32(data), channels: 2, frames: (data.len() / 2) as u32 }
    }

    fn close(a: &[f32], b: &[f32]) {
        assert_eq!(a.len(), b.len());
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            assert!((x - y).abs() < 1e-6, "index {i}: {x} != {y}");
        }
    }

    #[test]
    fn unit_steps_read_the_clip_exactly() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
        let n = linear(&src, &mut pos, &[1.0f32; 8], false, &mut l, &mut r);
        assert_eq!(n, 8);
        assert_eq!(&l[..], &x[..]);
        assert_eq!(&r[..], &x[..]);
        assert_eq!(pos, 8.0);
    }

    #[test]
    fn half_steps_interpolate_between_frames() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
        linear(&src, &mut pos, &[0.5f32; 8], false, &mut l, &mut r);
        // Even outputs land on a frame; odd outputs sit halfway between a pair of frames.
        let expected: Vec<f32> = (0..8usize)
            .map(|i| {
                let k = (i / 2) as f32;
                if i % 2 == 0 { k / 256.0 } else { (k + 0.5) / 256.0 }
            })
            .collect();
        close(&l, &expected);
        assert_eq!(pos, 4.0);
    }

    #[test]
    fn double_steps_skip_frames() {
        let x = ramp(8);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        let n = linear(&src, &mut pos, &[2.0f32; 4], false, &mut l, &mut r);
        assert_eq!(n, 4);
        assert_eq!(l, [x[0], x[2], x[4], x[6]]);
        assert_eq!(pos, 8.0);
    }

    #[test]
    fn a_mono_clip_is_copied_to_both_outputs() {
        let x = [0.25f32, -0.5, 0.75, 1.0];
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[0.5f32; 4], false, &mut l, &mut r);
        assert_eq!(l, r);
        // Positions 0, 0.5, 1.0, 1.5: a frame, then midpoints and frames again.
        close(&l, &[0.25, -0.125, -0.5, 0.125]);
    }

    #[test]
    fn a_stereo_clip_keeps_its_channels() {
        // Interleaved pairs: left = f / 16, right = 1 - f / 16.
        let mut data: Vec<f32> = Vec::new();
        for f in 0..4 {
            data.push(f as f32 / 16.0);
            data.push(1.0 - f as f32 / 16.0);
        }
        let src = stereo(&data);
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[1.0f32; 4], false, &mut l, &mut r);
        assert_eq!(l, [0.0, 1.0 / 16.0, 2.0 / 16.0, 3.0 / 16.0]);
        assert_eq!(r, [1.0, 15.0 / 16.0, 14.0 / 16.0, 13.0 / 16.0]);
    }

    #[test]
    fn int16_samples_are_scaled_by_1_over_32768() {
        let x: [i16; 4] = [16384, -16384, 0, 32767];
        let src = Source { samples: Samples::I16(&x[..]), channels: 1, frames: 4 };
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        linear(&src, &mut pos, &[1.0f32; 4], false, &mut l, &mut r);
        assert_eq!(l, [0.5, -0.5, 0.0, 32767.0 / 32768.0]);
        assert_eq!(r, l);
    }

    #[test]
    fn a_non_looping_clip_stops_and_zero_fills_at_its_end() {
        let x = ramp(5);
        let src = mono(&x);
        let mut pos = 0.0;
        let (mut l, mut r) = ([1.0f32; 8], [1.0f32; 8]);
        let n = linear(&src, &mut pos, &[1.0f32; 8], false, &mut l, &mut r);
        assert_eq!(n, 5);
        assert_eq!(&l[..5], &x[..]);
        assert!(l[5..].iter().all(|&v| v == 0.0));
        assert!(r[5..].iter().all(|&v| v == 0.0));
        assert_eq!(pos, 5.0);
    }

    #[test]
    fn the_last_frame_holds_when_not_looping() {
        let x = ramp(4);
        let src = mono(&x);
        let mut pos = 3.5;
        let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
        let n = linear(&src, &mut pos, &[1.0f32], false, &mut l, &mut r);
        assert_eq!(n, 1);
        assert_eq!(l[0], x[3]);
        assert_eq!(pos, 4.5);
        // Past the end now: nothing more is written.
        let n = linear(&src, &mut pos, &[1.0f32], false, &mut l, &mut r);
        assert_eq!(n, 0);
        assert_eq!(l[0], 0.0);
    }

    #[test]
    fn a_looping_clip_wraps_and_interpolates_across_the_seam() {
        let x = ramp(4);
        let src = mono(&x);
        let mut pos = 3.5;
        let (mut l, mut r) = ([0.0f32; 2], [0.0f32; 2]);
        let n = linear(&src, &mut pos, &[0.5f32, 0.5], true, &mut l, &mut r);
        assert_eq!(n, 2);
        // Frame 3 mixed with frame 0 across the seam, then frame 0 after the wrap.
        assert_eq!(l[0], 0.5 * x[3]);
        assert_eq!(l[1], 0.0);
        assert_eq!(pos, 0.5);
    }

    #[test]
    fn per_frame_steps_follow_a_changing_pitch() {
        let x = ramp(8);
        let src = mono(&x);
        let steps: [f32; 5] = [1.0, 2.0, 0.5, 0.5, 1.0];
        let mut pos = 0.0;
        let (mut l, mut r) = ([0.0f32; 5], [0.0f32; 5]);
        let n = linear(&src, &mut pos, &steps, false, &mut l, &mut r);
        assert_eq!(n, 5);
        // Read positions: 0, 1, 3, 3.5, 4.
        let expected = [0.0f32, 1.0, 3.0, 3.5, 4.0].map(|p| p / 256.0);
        close(&l, &expected);
        assert_eq!(pos, 5.0);
    }

    #[test]
    fn advance_matches_the_position_linear_reaches() {
        let x = ramp(5);
        let src = mono(&x);
        let steps: [f32; 8] = [1.0, 1.5, 0.7, 1.0, 1.0, 2.0, 1.0, 1.0];
        for &looping in &[false, true] {
            let mut lin_pos = 0.25;
            let mut adv_pos = 0.25;
            let (mut l, mut r) = ([0.0f32; 8], [0.0f32; 8]);
            let n_lin = linear(&src, &mut lin_pos, &steps, looping, &mut l, &mut r);
            let n_adv = advance(&mut adv_pos, &steps, 5, looping);
            // Non-looping stops at frame 5 (the clip has 5 frames); looping fills all 8.
            let expected = if looping { 8 } else { 5 };
            assert_eq!(n_lin, expected);
            assert_eq!(n_adv, expected);
            assert_eq!(lin_pos, adv_pos);
        }
    }

    #[test]
    fn an_empty_clip_renders_nothing() {
        let empty: &[f32] = &[];
        let src = Source { samples: Samples::F32(empty), channels: 1, frames: 0 };
        for &looping in &[false, true] {
            let mut pos = 1.5;
            let (mut l, mut r) = ([1.0f32; 3], [1.0f32; 3]);
            let n = linear(&src, &mut pos, &[1.0f32; 3], looping, &mut l, &mut r);
            assert_eq!(n, 0);
            assert_eq!(l, [0.0; 3]);
            assert_eq!(r, [0.0; 3]);
            assert_eq!(pos, 1.5);
            assert_eq!(advance(&mut pos, &[1.0f32; 3], 0, looping), 0);
            assert_eq!(pos, 1.5);
        }
    }
}
