//! Filter designs the catalogue needs beyond Blink's low-pass and high-pass (ADR 0345): the
//! three-band EQ's shelves and peak, and the band-pass. Robert Bristow-Johnson's "Audio EQ
//! Cookbook" formulas, in `f64` like `biquad::coeffs`, normalised by `a0`, through `libm`.
//!
//! - **Three-band EQ** (`low`, `mid`, `high`, −18..18 dB): a low shelf at [`EQ_LOW_HZ`] (shelf
//!   slope 1), a peak at [`EQ_MID_HZ`] (Q [`EQ_MID_Q`], about 1.9 octaves) and a high shelf at
//!   [`EQ_HIGH_HZ`] (slope 1): the usual console layout (FMOD's three-EQ, Wwise's parametric
//!   defaults). A band at 0 dB is the identity.
//! - **Band-pass** (`centre`, `resonance` 0..1): constant 0 dB peak gain, Q from 0.5 (resonance 0,
//!   wide) to 10 (resonance 1, narrow) on a log scale ([`bandpass_q`]).

use crate::biquad::coeffs::{normalized, Coefficients, IDENTITY};
use core::f64::consts::PI;

pub const EQ_LOW_HZ: f32 = 250.0;
pub const EQ_MID_HZ: f32 = 1_000.0;
pub const EQ_MID_Q: f32 = 0.7;
pub const EQ_HIGH_HZ: f32 = 4_000.0;

fn omega(sample_rate: f32, hz: f32) -> Option<f64> {
    let rate = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate as f64 } else { 48_000.0 };
    let f = hz as f64;
    if !(f > 0.0) {
        return None;
    }
    // Keep under Nyquist so the design stays defined.
    Some(2.0 * PI * f.min(rate * 0.49) / rate)
}

/// A low shelf of `gain_db` at `hz` (slope 1).
pub fn low_shelf(sample_rate: f32, hz: f32, gain_db: f32) -> Coefficients {
    shelf(sample_rate, hz, gain_db, false)
}

/// A high shelf of `gain_db` at `hz` (slope 1).
pub fn high_shelf(sample_rate: f32, hz: f32, gain_db: f32) -> Coefficients {
    shelf(sample_rate, hz, gain_db, true)
}

fn shelf(sample_rate: f32, hz: f32, gain_db: f32, high: bool) -> Coefficients {
    let Some(w) = omega(sample_rate, hz) else { return IDENTITY };
    if gain_db == 0.0 || !gain_db.is_finite() {
        return IDENTITY;
    }
    let a = libm::pow(10.0, gain_db as f64 / 40.0);
    let (sw, cw) = (libm::sin(w), libm::cos(w));
    // Slope S = 1: alpha = sin(w)/2 * sqrt(2).
    let alpha = sw / 2.0 * core::f64::consts::SQRT_2;
    let k = 2.0 * libm::sqrt(a) * alpha;
    if high {
        normalized(
            a * ((a + 1.0) + (a - 1.0) * cw + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
            a * ((a + 1.0) + (a - 1.0) * cw - k),
            (a + 1.0) - (a - 1.0) * cw + k,
            2.0 * ((a - 1.0) - (a + 1.0) * cw),
            (a + 1.0) - (a - 1.0) * cw - k,
        )
    } else {
        normalized(
            a * ((a + 1.0) - (a - 1.0) * cw + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
            a * ((a + 1.0) - (a - 1.0) * cw - k),
            (a + 1.0) + (a - 1.0) * cw + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * cw),
            (a + 1.0) + (a - 1.0) * cw - k,
        )
    }
}

/// A peak of `gain_db` at `hz` with quality `q`.
pub fn peak(sample_rate: f32, hz: f32, q: f32, gain_db: f32) -> Coefficients {
    let Some(w) = omega(sample_rate, hz) else { return IDENTITY };
    if gain_db == 0.0 || !gain_db.is_finite() || !(q > 0.0) {
        return IDENTITY;
    }
    let a = libm::pow(10.0, gain_db as f64 / 40.0);
    let alpha = libm::sin(w) / (2.0 * q as f64);
    let cw = libm::cos(w);
    normalized(1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cw, 1.0 - alpha / a)
}

/// The band-pass's Q at `resonance` (0..1, clamped): `0.5 · 20^r`, 0.5 to 10.
pub fn bandpass_q(resonance: f32) -> f32 {
    let r = super::shape::clamp(resonance, 0.0, 1.0);
    0.5 * libm::powf(20.0, r)
}

/// A band-pass at `hz` with quality `q`, 0 dB at the centre.
pub fn bandpass(sample_rate: f32, hz: f32, q: f32) -> Coefficients {
    let Some(w) = omega(sample_rate, hz) else { return IDENTITY };
    let q = if q > 0.0 { q as f64 } else { 0.5 };
    let alpha = libm::sin(w) / (2.0 * q);
    normalized(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * libm::cos(w), 1.0 - alpha)
}

/// The magnitude of `c` at `hz` (tests and a debugger).
pub fn magnitude(c: &Coefficients, sample_rate: f32, hz: f32) -> f64 {
    let w = 2.0 * PI * hz as f64 / sample_rate as f64;
    let (c1, s1, c2, s2) = (libm::cos(w), libm::sin(w), libm::cos(2.0 * w), libm::sin(2.0 * w));
    let [b0, b1, b2, a1, a2] = *c;
    let (nr, ni) = (b0 + b1 * c1 + b2 * c2, -(b1 * s1 + b2 * s2));
    let (dr, di) = (1.0 + a1 * c1 + a2 * c2, -(a1 * s1 + a2 * s2));
    libm::sqrt((nr * nr + ni * ni) / (dr * dr + di * di))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(x: f64) -> f64 {
        20.0 * libm::log10(x)
    }

    #[test]
    fn shelves_and_peak_reach_their_gain_where_they_should() {
        let sr = 48_000.0;
        let lo = low_shelf(sr, EQ_LOW_HZ, 12.0);
        assert!((db(magnitude(&lo, sr, 20.0)) - 12.0).abs() < 0.3);
        assert!(db(magnitude(&lo, sr, 10_000.0)).abs() < 0.2);
        let hi = high_shelf(sr, EQ_HIGH_HZ, -12.0);
        assert!((db(magnitude(&hi, sr, 20_000.0)) + 12.0).abs() < 0.6);
        assert!(db(magnitude(&hi, sr, 50.0)).abs() < 0.2);
        let mid = peak(sr, EQ_MID_HZ, EQ_MID_Q, 6.0);
        assert!((db(magnitude(&mid, sr, 1_000.0)) - 6.0).abs() < 0.05);
        assert_eq!(peak(sr, 1_000.0, 0.7, 0.0), IDENTITY, "0 dB is the identity");
    }

    #[test]
    fn bandpass_peaks_at_its_centre() {
        let sr = 48_000.0;
        let c = bandpass(sr, 2_000.0, bandpass_q(0.5));
        assert!(db(magnitude(&c, sr, 2_000.0)).abs() < 0.01);
        assert!(db(magnitude(&c, sr, 200.0)) < -12.0);
        assert!(db(magnitude(&c, sr, 20_000.0)) < -12.0);
        assert_eq!(bandpass_q(0.0), 0.5);
        assert!((bandpass_q(1.0) - 10.0).abs() < 1e-4);
    }
}
