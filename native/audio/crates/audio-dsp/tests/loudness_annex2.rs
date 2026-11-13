//! K-weighting against ITU-R BS.1770's Annex 1 coefficient tables (task Ld6b; the file keeps its
//! `annex2` name from the plan's task title; spike S1 couldn't get the table,
//! its README says "ITU hosts blocked", so this is the first check against the published numbers):
//! - at 48 kHz the computed coefficients equal the table's, to the digits the table gives;
//! - the cascade's magnitude response at 1/3-octave centres (20 Hz to 20 kHz) matches the response
//!   of the table's coefficients at 48 kHz, and at 44.1 and 96 kHz matches the 48 kHz response
//!   (the same analogue prototype, so the digital responses agree except for the bilinear
//!   transform's frequency warping near Nyquist);
//! - a full-scale 997 Hz sine in one channel reads -3.01 LKFS, BS.1770's calibration statement.
//!
//! The constants below are ITU-R BS.1770-5 (11/2023) Annex 1, Table 1 ("Filter coefficients for
//! stage 1 of the pre-filter to model a spherical head") and Table 2 ("Filter coefficients for the
//! second stage weighting curve"), 48 kHz, as published; checked digit for digit against the
//! document on 2026-11-13. The calibration statement (a 0 dB FS 997 Hz sine reads -3.01 LKFS) is
//! Annex 1's too.

use audio_dsp::loudness::{lufs, KCoef, Meter, Ring};
use std::f64::consts::PI;

/// Stage 1 (high shelf), 48 kHz: b0, b1, b2 and a1, a2 (a0 = 1).
const TABLE1_B: [f64; 3] = [1.53512485958697, -2.69169618940638, 1.19839281085285];
const TABLE1_A: [f64; 2] = [-1.69065929318241, 0.73248077421585];
/// Stage 2 (RLB high-pass), 48 kHz.
const TABLE2_B: [f64; 3] = [1.0, -2.0, 1.0];
const TABLE2_A: [f64; 2] = [-1.99004745483398, 0.99007225036621];

/// Magnitude (dB) of one biquad at `f` Hz and sample rate `fs`.
fn biquad_db(b: &[f64; 3], a: &[f64; 2], f: f64, fs: f64) -> f64 {
    let w = 2.0 * PI * f / fs;
    let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
    let nr = b[0] + b[1] * c1 + b[2] * c2;
    let ni = -(b[1] * s1 + b[2] * s2);
    let dr = 1.0 + a[0] * c1 + a[1] * c2;
    let di = -(a[0] * s1 + a[1] * s2);
    10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
}

fn cascade_db(c: &KCoef, f: f64, fs: f64) -> f64 {
    biquad_db(&c.b[0], &c.a[0], f, fs) + biquad_db(&c.b[1], &c.a[1], f, fs)
}

fn table_db(f: f64) -> f64 {
    biquad_db(&TABLE1_B, &TABLE1_A, f, 48_000.0) + biquad_db(&TABLE2_B, &TABLE2_A, f, 48_000.0)
}

/// 1/3-octave centres 20 Hz .. 20 kHz (base 10: 10^(n/10), n = 13..=43).
fn third_octaves() -> Vec<f64> {
    (13..=43).map(|n| 10f64.powf(n as f64 / 10.0)).collect()
}

#[test]
fn coefficients_at_48k_match_the_annex_2_table() {
    let c = KCoef::new(48_000.0);
    // The table gives 14-15 significant digits (stage 2's a1, a2 only 8 decimals); the computed
    // set derives from libebur128's rounded f0/G/Q, so allow 1e-6, far below an audible change.
    let tol = 1e-6;
    for i in 0..3 {
        assert!((c.b[0][i] - TABLE1_B[i]).abs() < tol, "stage 1 b{i}: {} vs {}", c.b[0][i], TABLE1_B[i]);
        assert_eq!(c.b[1][i], TABLE2_B[i], "stage 2 b{i}");
    }
    for i in 0..2 {
        assert!((c.a[0][i] - TABLE1_A[i]).abs() < tol, "stage 1 a{}: {} vs {}", i + 1, c.a[0][i], TABLE1_A[i]);
        assert!((c.a[1][i] - TABLE2_A[i]).abs() < tol, "stage 2 a{}: {} vs {}", i + 1, c.a[1][i], TABLE2_A[i]);
    }
}

#[test]
fn response_at_48k_matches_the_annex_2_coefficients() {
    let c = KCoef::new(48_000.0);
    for f in third_octaves() {
        let d = (cascade_db(&c, f, 48_000.0) - table_db(f)).abs();
        assert!(d < 0.001, "{f:.1} Hz: {d} dB apart");
    }
}

#[test]
fn response_at_other_rates_matches_the_48k_response() {
    // Same analogue prototype, so the stages' responses agree except for (a) the bilinear
    // transform's warp, which moves the shelf by up to 0.006 dB at 96 kHz and 0.0015 dB at 44.1 kHz
    // (tolerance 0.01 dB, the whole 20 Hz .. 20 kHz range), and (b) a flat gain offset of the
    // high-pass, which libebur128's formulas leave at the bilinear value of b = [1, -2, 1] (the
    // standard's own 48 kHz set has its passband at ~0 dB): measured +0.0038 dB at 44.1 kHz and
    // -0.0216 dB at 96 kHz, the same at every frequency (spread < 0.001 dB). That offset is the
    // formulas' (loudness.rs follows libebur128 by design), so it is bounded here, not removed:
    // 0.025 dB is 0.6 % of a loudness reading's 0.1 LU resolution.
    for fs in [44_100.0, 96_000.0] {
        let c = KCoef::new(fs);
        let mut hp = Vec::new();
        for f in third_octaves() {
            let shelf = biquad_db(&c.b[0], &c.a[0], f, fs) - biquad_db(&TABLE1_B, &TABLE1_A, f, 48_000.0);
            assert!(shelf.abs() < 0.01, "fs {fs}, {f:.1} Hz: shelf {shelf} dB apart");
            hp.push(biquad_db(&c.b[1], &c.a[1], f, fs) - biquad_db(&TABLE2_B, &TABLE2_A, f, 48_000.0));
        }
        let (lo, hi) = hp.iter().fold((f64::MAX, f64::MIN), |(l, h), &v| (l.min(v), h.max(v)));
        assert!(hi - lo < 0.001, "fs {fs}: high-pass offset isn't flat ({lo} .. {hi})");
        assert!(lo.abs() < 0.025 && hi.abs() < 0.025, "fs {fs}: high-pass offset {lo} .. {hi} dB");
    }
}

#[test]
fn full_scale_997_hz_sine_reads_minus_3_01_lkfs() {
    // BS.1770: a 0 dBFS (peak 1.0) 997 Hz sine in one channel, silence in the other, reads
    // -3.01 LKFS; K-weighting's +0.691 dB at 997 Hz is what the -0.691 offset in `lufs` cancels.
    for fs in [48_000.0, 44_100.0, 96_000.0] {
        let mut m = Meter::new(fs);
        let mut ring: Ring = [0.0; 32];
        let frames = fs as usize * 2;
        let l: Vec<f32> = (0..frames).map(|n| (2.0 * PI * 997.0 * n as f64 / fs).sin() as f32).collect();
        let r = vec![0.0f32; frames];
        let mut done = 0u32;
        let mut sum = 0.0f64;
        let mut count = 0;
        for (cl, cr) in l.chunks(128).zip(r.chunks(128)) {
            let before = m.seq();
            done += m.process_energy(cl, cr, &mut ring);
            for s in before..m.seq() {
                // Skip the first 5 sub-blocks (filter settling).
                if s >= 5 {
                    sum += ring[s as usize % 32] as f64;
                    count += 1;
                }
            }
        }
        assert!(done >= 19, "fs {fs}: {done} sub-blocks");
        let v = lufs(sum / count as f64);
        // 48 and 44.1 kHz to 0.01; 96 kHz carries the high-pass's -0.0216 dB offset (see above).
        let tol = if fs == 96_000.0 { 0.03 } else { 0.01 };
        assert!((v - -3.01).abs() < tol, "fs {fs}: {v} LKFS");
    }
}
