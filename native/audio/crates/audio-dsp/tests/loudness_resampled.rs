//! The voice resampler keeps a tone's level into the meter: EBU Tech 3341 case 1 (a 1 kHz sine at
//! −23 dBFS peak on both channels) as a 48 kHz, 16-bit, 2 s looped clip, read by the voice
//! resampler (`resample::lagrange`) at the context's rate and metered by `loudness::Meter` at that
//! rate, reads −22.99 LUFS within ±0.02 LU at 48 kHz (whole steps: the clip's own samples) and at
//! 44.1 kHz (a step of 48/44.1: every read interpolated). This is the path a clip takes in the core
//! when its rate isn't the context's, the Sound Lab's `loudness-reference.wav` in a 44.1 kHz page;
//! `loudness_s1.rs` meters the same tone generated at each rate, without the resampler.

use audio_dsp::loudness::{lufs, Meter, Ring, QUANTUM, RING};
use audio_dsp::resample::{lagrange, Samples, Source};
use core::f64::consts::PI;

const CLIP_RATE: f64 = 48_000.0;
/// EBU Tech 3341 case 1 at the meter's precision (spike S1 at 48 kHz: −22.9933).
const EXPECTED_LUFS: f64 = -22.99;
const TOLERANCE_LU: f64 = 0.02;

/// The clip as `makeLoudness.mjs` writes it: 2 s of a 1 kHz sine at −23 dBFS peak, stereo, int16.
fn reference_clip() -> Vec<i16> {
    let amp = libm::pow(10.0, -23.0 / 20.0);
    let frames = (2.0 * CLIP_RATE) as usize;
    let mut out = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        let s = libm::round(amp * libm::sin(2.0 * PI * 1000.0 * i as f64 / CLIP_RATE) * 32767.0) as i16;
        out.push(s);
        out.push(s);
    }
    out
}

/// The clip looped through the resampler into a meter at `rate` for 8 s; the mean-square of the
/// sub-blocks after the first second (the K-weighting filters settled), as LUFS.
fn metered(rate: f64) -> f64 {
    let clip = reference_clip();
    let src = Source { samples: Samples::I16(&clip), channels: 2, frames: (clip.len() / 2) as u32, reversed: false };
    let steps = [(CLIP_RATE / rate) as f32; QUANTUM];
    let (mut l, mut r) = ([0.0f32; QUANTUM], [0.0f32; QUANTUM]);
    let mut pos = 0.0f64;
    let mut meter = Meter::new(rate);
    let mut ring: Ring = [0.0; RING];
    let skip = 10; // sub-blocks of 0.1 s
    let (mut seen, mut sum, mut n) = (0u32, 0.0f64, 0u32);
    for _ in 0..(8.0 * rate) as usize / QUANTUM {
        assert_eq!(lagrange(&src, &mut pos, &steps, true, &mut l, &mut r), QUANTUM);
        meter.process(&l, &r, &mut ring);
        while seen < meter.seq() {
            if seen >= skip {
                sum += ring[seen as usize % RING] as f64;
                n += 1;
            }
            seen += 1;
        }
    }
    assert!(n >= 60, "{n} sub-blocks at {rate} Hz");
    lufs(sum / n as f64)
}

#[test]
fn reference_tone_reads_its_level_at_the_clip_rate() {
    let got = metered(48_000.0);
    assert!((got - EXPECTED_LUFS).abs() <= TOLERANCE_LU, "48 kHz: {got} LUFS");
}

#[test]
fn reference_tone_reads_its_level_resampled_to_44_1_khz() {
    let got = metered(44_100.0);
    assert!((got - EXPECTED_LUFS).abs() <= TOLERANCE_LU, "44.1 kHz: {got} LUFS");
}
