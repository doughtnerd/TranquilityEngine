//! A stream loop's seam crossfade (ADR 0328 loops on stream voices; ABI 1.4, `myco_decode_seam`).
//!
//! A streamed loop wraps in the decoder worker: it reads up to the loop's end, seeks back to its
//! start (sample-accurately) and reads on, so the core's ring holds one continuous signal. With a
//! crossfade of `length` frames the seam is the clip voice's (`audio-core`'s `voice_loops.rs`): the
//! audio past the loop's end goes on as a **tail** fading out while the loop's start fades in, at
//! seam frame `k` (0 the first frame after the wrap) with phase `u = k / length` read through the
//! same shape table, `audio_dsp::fade_shapes::crossfade`, so a streamed loop and a decoded one cross
//! the same way. The worker reads the tail (the `length` frames from the loop's end) before it
//! seeks, then mixes it into the frames it reads from the loop's start, in as many pieces as its
//! chunks cut the crossfade into (`phase` says where a piece starts).
//!
//! Interleaved f32 frames; nothing allocates.

/// Mixes `tail` into `out`: frame `i` of `out` (and of `tail`) is seam frame `phase + i`; while that
/// is below `length`, `out = out · in(u) + tail · out(u)` with `u = (phase + i) / length` and
/// `(in, out)` the crossfade gains of `shape` (a `FADE_SHAPE_*` code). Returns the frames mixed
/// (`min(frames, length - phase)`, 0 past the crossfade). `channels` is 1..=16; `out` and `tail`
/// hold at least `frames · channels` samples, else nothing is mixed and 0 returned.
pub fn crossfade(out: &mut [f32], tail: &[f32], frames: usize, channels: usize, phase: u32, length: u32, shape: u8) -> usize {
    if channels == 0 || channels > 16 || phase >= length || out.len() < frames * channels || tail.len() < frames * channels {
        return 0;
    }
    let n = frames.min((length - phase) as usize);
    for i in 0..n {
        let u = (phase as usize + i) as f32 / length as f32;
        let (g_in, g_out) = audio_dsp::fade_shapes::crossfade(shape, u);
        for c in 0..channels {
            let k = i * channels + c;
            out[k] = out[k] * g_in + tail[k] * g_out;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sine's frames `from..from + n`, interleaved over `ch` channels (channel c at `c + 1` times the frequency).
    fn sine(from: usize, n: usize, ch: usize, period: f32) -> Vec<f32> {
        (from..from + n).flat_map(|i| (0..ch).map(move |c| (core::f32::consts::TAU * (c + 1) as f32 * i as f32 / period).sin())).collect()
    }

    #[test]
    fn the_seam_starts_on_the_tail_and_ends_on_the_loop() {
        let (len, ch) = (64u32, 2usize);
        let mut out = vec![1.0f32; 64 * ch];
        let tail = vec![-1.0f32; 64 * ch];
        assert_eq!(crossfade(&mut out, &tail, 64, ch, 0, len, 1), 64);
        // Linear: frame 0 is all tail, the midpoint half and half, and it moves evenly.
        assert_eq!(out[0], -1.0);
        assert!((out[32 * ch]).abs() < 1e-6);
        for i in 1..64 {
            assert!((out[i * ch] - out[(i - 1) * ch] - 2.0 / 64.0).abs() < 1e-5);
        }
    }

    #[test]
    fn a_crossfade_cut_into_pieces_is_the_same_as_one() {
        let (len, ch) = (300u32, 2usize);
        let tail = sine(1000, 300, ch, 37.3);
        let head = sine(0, 300, ch, 41.9);
        let mut whole = head.clone();
        crossfade(&mut whole, &tail, 300, ch, 0, len, 0);
        let mut parts = head.clone();
        let mut at = 0usize;
        for piece in [7usize, 128, 100, 65] {
            let done = crossfade(&mut parts[at * ch..], &tail[at * ch..], piece, ch, at as u32, len, 0);
            assert_eq!(done, piece);
            at += piece;
        }
        assert_eq!(whole, parts);
        // Past the crossfade nothing changes.
        let mut after = head.clone();
        assert_eq!(crossfade(&mut after, &tail, 10, ch, 300, len, 0), 0);
        assert_eq!(after, head);
    }

    #[test]
    fn equal_power_keeps_an_uncorrelated_seam_level_and_refuses_bad_arguments() {
        // Two equal-level uncorrelated signals through the equal-power seam: the power stays the same.
        let len = 4_800u32;
        let a = sine(0, 4_800, 1, 97.0);
        let b: Vec<f32> = sine(0, 4_800, 1, 61.0);
        let mut out = a.clone();
        crossfade(&mut out, &b, 4_800, 1, 0, len, 0);
        let p = |x: &[f32]| x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64;
        assert!((p(&out) / p(&a) - 1.0).abs() < 0.05, "{}", p(&out) / p(&a));
        let mut short = vec![0.0f32; 3];
        assert_eq!(crossfade(&mut short, &b, 4, 1, 0, len, 0), 0);
        assert_eq!(crossfade(&mut out, &b, 4, 0, 0, len, 0), 0);
        assert_eq!(crossfade(&mut out, &b, 4, 17, 0, len, 0), 0);
    }
}
