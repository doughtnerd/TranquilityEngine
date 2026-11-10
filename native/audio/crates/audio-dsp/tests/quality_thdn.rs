//! Objective quality: the linear resampler's THD+N and image/alias level (ADR 0157,
//! api-and-models section 8 "Objective quality"; the architecture sets no number: "thresholds set
//! at M1a.3, then ratcheted").
//!
//! Method: a coherent sine (an exact number of cycles in the 32,768-frame output), generated at the
//! source frequency `f_out / pitch`, is resampled by `audio_dsp::resample::linear` at a constant
//! `pitch` (clip rate equals context rate, so step = pitch). The Hann-windowed spectrum is split
//! into the fundamental (bin +- 2) and the rest.
//!
//! Each limit is the measurement rounded up to the next 5 dB, at least 3 dB of margin, so a
//! regression in the interpolation (or a switch to a worse kernel) fails while noise in the last
//! bit does not. A better kernel lowers the measurements: ratchet the constants down with it.
//! `-- --nocapture` prints every measurement.
mod quality_common;
use audio_dsp::resample::{linear, Samples, Source};
use quality_common::*;

const N: usize = 32_768;
const RATE: f64 = 48_000.0;

/// Resamples a sine whose output lands on bin `k` of an `N`-frame render at `pitch`.
fn render(k: usize, pitch: f64) -> Vec<f32> {
    let src_len = (N as f64 * pitch).ceil() as usize + 8;
    let cycles_per_src_frame = k as f64 / (N as f64 * pitch);
    let src: Vec<f32> = (0..src_len).map(|i| (0.5 * (2.0 * std::f64::consts::PI * cycles_per_src_frame * i as f64).sin()) as f32).collect();
    let source = Source { samples: Samples::F32(&src), channels: 1, frames: src_len as u32 };
    let steps = vec![pitch as f32; N];
    let (mut l, mut r) = (vec![0.0f32; N], vec![0.0f32; N]);
    let mut pos = 0.0;
    assert_eq!(linear(&source, &mut pos, &steps, false, &mut l, &mut r), N);
    l
}

fn bin_for(hz: f64) -> usize {
    (hz * N as f64 / RATE).round() as usize
}

fn hz_of(k: usize) -> f64 {
    k as f64 * RATE / N as f64
}

const SEMITONE: f64 = 1.059_463_094_359_295_3;

/// (output Hz, pitch, THD+N limit in dB). The comment on a row is the measurement. The source tone
/// is `hz / pitch`, kept well under Nyquist: 1 kHz rows are the typical case (voices, footsteps,
/// mid-range), 5 and 10 kHz show how linear interpolation sags in the top octaves.
const THDN_LIMITS: &[(f64, f64, f64)] = &[
    (1_000.0, 1.0, -140.0),        // -153.7 (a unit step lands on whole frames: lossless)
    (1_000.0, 2.0, -140.0),        // -153.7
    (200.0, 1.5, -90.0),           // -94.3
    (200.0, SEMITONE, -85.0),      // -92.8
    (200.0, 1.0 / SEMITONE, -85.0), // -90.8
    (200.0, 0.75, -80.0),          // -84.8
    (200.0, 0.5, -70.0),           // -75.3
    (200.0, 1.0 / 3.0, -65.0),     // -69.8
    (1_000.0, 1.5, -60.0),         // -66.4
    (1_000.0, SEMITONE, -60.0),    // -64.9
    (1_000.0, 1.0 / SEMITONE, -55.0), // -62.9
    (1_000.0, 0.75, -50.0),        // -56.9
    (1_000.0, 0.5, -40.0),         // -47.3
    (5_000.0, 1.5, -35.0),         // -38.4
    (5_000.0, SEMITONE, -30.0),    // -36.6
    (5_000.0, 1.0 / SEMITONE, -30.0), // -34.4
    (10_000.0, SEMITONE, -20.0),   // -23.4
];

#[test]
fn resampler_thd_n_stays_within_the_limits() {
    for &(hz, pitch, limit) in THDN_LIMITS {
        let k = bin_for(hz);
        let v = thd_n_db(&render(k, pitch), k);
        println!("THD+N {:.0} Hz pitch {pitch:.4}: {v:.1} dB (limit {limit})", hz_of(k));
        assert!(v <= limit, "THD+N at {:.0} Hz, pitch {pitch:.4}: {v:.1} dB exceeds {limit} dB", hz_of(k));
    }
}

/// (output Hz, pitch, worst spur in dBc). Images of the interpolation kernel (pitch < 1 repeats the
/// spectrum around the source rate) and their aliases (pitch > 1 folds them back in band).
const SPUR_LIMITS: &[(f64, f64, f64)] = &[
    (1_000.0, 0.5, -45.0),      // -49.1, at 23 kHz (the image of the 2 kHz source)
    (1_000.0, 1.5, -65.0),      // -68.2, at 23 kHz
    (1_000.0, SEMITONE, -65.0), // -71.0
    (5_000.0, 1.5, -35.0),      // -40.2
    (5_000.0, 0.75, -30.0),     // -32.1 (not 5 kHz source: 6.7 kHz)
];

#[test]
fn resampler_image_and_alias_spurs_stay_within_the_limits() {
    for &(hz, pitch, limit) in SPUR_LIMITS {
        let k = bin_for(hz);
        let (v, bin) = worst_spur_db(&render(k, pitch), k);
        println!("spur {:.0} Hz pitch {pitch:.4}: {v:.1} dBc at {:.0} Hz (limit {limit})", hz_of(k), hz_of(bin));
        assert!(v <= limit, "worst spur at {:.0} Hz, pitch {pitch:.4}: {v:.1} dBc exceeds {limit} dBc", hz_of(k));
    }
}

/// The linear kernel has no anti-alias filter: content that pitching pushes past Nyquist folds
/// back at full level (alias rejection 0 dB). A 15 kHz source at pitch 2 should sit at 30 kHz; it
/// lands at 48 - 30 = 18 kHz instead. This pins the known limit of the M1a resampler: when a
/// better kernel (the M1a.3 choice) lands this test must flip to a rejection threshold.
#[test]
fn linear_pitch_up_folds_content_past_nyquist_without_rejection() {
    let (k_out, pitch) = (bin_for(30_000.0), 2.0); // 30 kHz out: past Nyquist, as bin arithmetic
    // Render the source tone directly at the folded bin: output bin = N - k_out.
    let k_folded = N - k_out;
    let out = render(k_out, pitch);
    let p = power_spectrum(&out);
    let at_fold: f64 = p.iter().enumerate().filter(|(i, _)| i.abs_diff(k_folded) <= 2).map(|(_, v)| v).sum();
    let total: f64 = p.iter().skip(2).sum();
    let level = db(at_fold / total);
    println!("fold: 15 kHz source at pitch 2 lands at {:.0} Hz holding {level:.2} dB of the energy", hz_of(k_folded));
    assert!(level > -1.0, "the folded tone carries the energy: {level} dB");
}
