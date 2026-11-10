//! Objective quality: the voices' resampler (4-point Lagrange, A3.6) against A1.2's linear kernel:
//! THD+N, image/alias spurs and folding past Nyquist (ADR 0157, api-and-models section 8
//! "Objective quality"; the architecture sets no number: "thresholds set at M1a.3, then
//! ratcheted").
//!
//! Method: a coherent sine (an exact number of cycles in the 32,768-frame output), generated at the
//! source frequency `f_out / pitch`, is resampled by `audio_dsp::resample::lagrange` (or `linear`
//! for the comparison) at a constant `pitch` (clip rate equals context rate, so step = pitch). The
//! Hann-windowed spectrum is split into the fundamental (bin +- 2) and the rest.
//!
//! Each limit is the measurement rounded up to the next 5 dB, at least 3 dB of margin, so a
//! regression in the interpolation (or a switch to a worse kernel) fails while noise in the last
//! bit does not. A better kernel lowers the measurements: ratchet the constants down with it.
//! The comment on a row is the Lagrange measurement, then linear's (A2.7 set its limits on linear).
//! `-- --nocapture` prints every measurement.
mod quality_common;
use audio_dsp::resample::{lagrange, linear, Samples, Source};
use quality_common::*;

const N: usize = 32_768;
const RATE: f64 = 48_000.0;

#[derive(Clone, Copy, PartialEq)]
enum Kernel {
    Lagrange,
    Linear,
}

/// Resamples a sine whose output lands on bin `k` of an `N`-frame render at `pitch`.
fn render_with(kernel: Kernel, k: usize, pitch: f64) -> Vec<f32> {
    let src_len = (N as f64 * pitch).ceil() as usize + 8;
    let cycles_per_src_frame = k as f64 / (N as f64 * pitch);
    let src: Vec<f32> = (0..src_len).map(|i| (0.5 * (2.0 * std::f64::consts::PI * cycles_per_src_frame * i as f64).sin()) as f32).collect();
    let source = Source { samples: Samples::F32(&src), channels: 1, frames: src_len as u32 };
    let steps = vec![pitch as f32; N];
    let (mut l, mut r) = (vec![0.0f32; N], vec![0.0f32; N]);
    let mut pos = 0.0;
    let n = match kernel {
        Kernel::Lagrange => lagrange(&source, &mut pos, &steps, false, &mut l, &mut r),
        Kernel::Linear => linear(&source, &mut pos, &steps, false, &mut l, &mut r),
    };
    assert_eq!(n, N);
    l
}

/// The voices' kernel.
fn render(k: usize, pitch: f64) -> Vec<f32> {
    render_with(Kernel::Lagrange, k, pitch)
}

fn bin_for(hz: f64) -> usize {
    (hz * N as f64 / RATE).round() as usize
}

fn hz_of(k: usize) -> f64 {
    k as f64 * RATE / N as f64
}

const SEMITONE: f64 = 1.059_463_094_359_295_3;

/// (output Hz, pitch, THD+N limit in dB). The source tone is `hz / pitch`, kept well under
/// Nyquist: 1 kHz rows are the typical case (voices, footsteps, mid-range), 5 and 10 kHz show how
/// interpolation sags in the top octaves. Whole ratios read whole frames: lossless for both kernels.
const THDN_LIMITS: &[(f64, f64, f64)] = &[
    (1_000.0, 1.0, -150.0),            // -153.7; linear -153.7
    (1_000.0, 2.0, -150.0),            // -153.7; linear -153.7
    (200.0, 1.5, -145.0),              // -151.8; linear -94.3
    (200.0, SEMITONE, -125.0),         // -129.4; linear -92.8
    (200.0, 1.0 / SEMITONE, -135.0),   // -139.4; linear -90.8
    (200.0, 0.75, -145.0),             // -149.7; linear -84.8
    (200.0, 0.5, -135.0),              // -140.3; linear -75.3
    (200.0, 1.0 / 3.0, -120.0),        // -127.2; linear -69.8
    (1_000.0, 1.5, -120.0),            // -123.3; linear -66.4
    (1_000.0, SEMITONE, -105.0),       // -112.5; linear -64.9
    (1_000.0, 1.0 / SEMITONE, -105.0), // -111.4; linear -62.9
    (1_000.0, 0.75, -95.0),            // -101.8; linear -56.9
    (1_000.0, 0.5, -80.0),             // -85.2; linear -47.3
    (5_000.0, 1.5, -60.0),             // -67.6; linear -38.4
    (5_000.0, SEMITONE, -55.0),        // -59.7; linear -36.6
    (5_000.0, 1.0 / SEMITONE, -50.0),  // -55.7; linear -34.4
    (10_000.0, SEMITONE, -30.0),       // -35.6; linear -23.4
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

/// The 4-point kernel agrees with linear bit for bit at whole ratios and is at least 10 dB better
/// on THD+N wherever the position is fractional.
#[test]
fn lagrange_thd_n_beats_linear_on_every_row() {
    for &(hz, pitch, _) in THDN_LIMITS {
        let k = bin_for(hz);
        let (cubic, lin) = (render_with(Kernel::Lagrange, k, pitch), render_with(Kernel::Linear, k, pitch));
        let (a, b) = (thd_n_db(&cubic, k), thd_n_db(&lin, k));
        println!("THD+N {:.0} Hz pitch {pitch:.4}: lagrange {a:.1} dB, linear {b:.1} dB", hz_of(k));
        if pitch.fract() == 0.0 {
            assert!(cubic == lin, "whole ratio {pitch}: the kernels must agree bit for bit");
        } else {
            assert!(a <= b - 10.0, "{:.0} Hz pitch {pitch:.4}: lagrange {a:.1} dB is not 10 dB under linear {b:.1} dB", hz_of(k));
        }
    }
}

/// (output Hz, pitch, worst spur in dBc). Images of the interpolation kernel (pitch < 1 repeats the
/// spectrum around the source rate) and their aliases (pitch > 1 folds them back in band).
const SPUR_LIMITS: &[(f64, f64, f64)] = &[
    (1_000.0, 0.5, -80.0),       // -87.0 at 23 kHz (the image of the 2 kHz source); linear -49.1
    (1_000.0, 1.5, -120.0),      // -125.1 at 23 kHz; linear -68.2
    (1_000.0, SEMITONE, -115.0), // -119.4; linear -71.0
    (5_000.0, 1.5, -65.0),       // -69.3 at 19 kHz; linear -40.2
    (5_000.0, 0.75, -45.0),      // -49.7 at 17 kHz (not 5 kHz source: 6.7 kHz); linear -32.1
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

/// The level of a tone that pitching pushed past Nyquist, where it folds back in band, relative to
/// an unaliased tone of the source's amplitude (0 dB: no rejection at all), and where it lands. A
/// source at `src_hz` played at `pitch` belongs at `src_hz * pitch` (past 24 kHz) and lands at
/// `48 kHz - src_hz * pitch`.
fn fold_level_db(kernel: Kernel, src_hz: f64, pitch: f64) -> (f64, f64) {
    let k_out = bin_for(src_hz * pitch); // past N/2: a frequency past Nyquist, as bin arithmetic
    let k_folded = N - k_out;
    let band = |p: &[f64]| -> f64 { p.iter().enumerate().filter(|(i, _)| i.abs_diff(k_folded) <= 2).map(|(_, v)| v).sum() };
    let reference = band(&power_spectrum(&coherent_sine(N, k_folded as f64, 0.5)));
    let at_fold = band(&power_spectrum(&render_with(kernel, k_out, pitch)));
    (db(at_fold / reference), hz_of(k_folded))
}

/// (source Hz, pitch, highest fold level in dB). Neither kernel band-limits, so the "rejection" is
/// only the kernel's own droop at the source frequency, and the flatter 4-point kernel droops less
/// than linear: it lets folds through 0.8 to 1.5 dB louder (the price of its flatter top octave).
/// Rejecting folds needs band-limited copies of the clip (see `resample.rs`).
const FOLD_LIMITS: &[(f64, f64, f64)] = &[
    (20_000.0, 1.5, 0.0),      // -3.2 (lands at 18 kHz); linear -4.0
    (21_000.0, 1.3, 0.0),      // -4.6 (20.7 kHz); linear -5.8
    (22_000.0, 1.2, 0.0),      // -5.3 (21.6 kHz); linear -6.3
    (23_000.0, SEMITONE, 0.0), // -6.3 (23.6 kHz); linear -7.1
    (17_000.0, 1.7, 5.0),      // -2.3 (19.1 kHz); linear -3.7
];

#[test]
fn pitch_up_folds_past_nyquist_stay_within_the_limits() {
    for &(src_hz, pitch, limit) in FOLD_LIMITS {
        let (v, at) = fold_level_db(Kernel::Lagrange, src_hz, pitch);
        let (lin, _) = fold_level_db(Kernel::Linear, src_hz, pitch);
        println!("fold: {src_hz:.0} Hz at pitch {pitch:.4} lands at {at:.0} Hz at {v:.2} dB (linear {lin:.2} dB, limit {limit})");
        assert!(v <= limit, "fold of {src_hz:.0} Hz at pitch {pitch:.4}: {v:.2} dB exceeds {limit} dB");
    }
}

/// At a whole ratio a kernel that passes through the samples reads only whole frames (pitch 2:
/// every other frame), so it cannot reject a fold at all: A2.7's case (a 15 kHz source at pitch 2,
/// which belongs at 30 kHz and lands at 18 kHz) keeps the whole tone, for linear and the 4-point
/// kernel alike. This pins that limit; band-limited clip copies would flip it to a rejection.
#[test]
fn whole_ratio_pitch_up_folds_without_rejection() {
    let (v, at) = fold_level_db(Kernel::Lagrange, 15_000.0, 2.0);
    let (lin, _) = fold_level_db(Kernel::Linear, 15_000.0, 2.0);
    println!("fold: 15 kHz source at pitch 2 lands at {at:.0} Hz at {v:.2} dB (linear {lin:.2} dB)");
    assert!(v.abs() < 0.1 && v == lin, "the folded tone keeps its level: {v} dB (linear {lin} dB)");
}
