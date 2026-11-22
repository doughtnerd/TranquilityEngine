//! The playlist fade-shape set (ADR 0336, `src/engine/audio/playlist/fadeShapes.ts`) as crossfade
//! gains, for the core's sample-loop seam and exit crossfades (ABI 4.9, the wire's `FADE_SHAPE_*`).
//!
//! A crossfade at phase `u` (0..1) reads the incoming side at [`fade_in`] and the outgoing side at
//! [`fade_out`]:
//! - `equalPower` (code 0, the default and the core's crossfade before 4.9): `sin(uπ/2)` in and
//!   `cos(uπ/2)` out, so the power is kept (the quarter-sine table, `equal_power`);
//! - every other shape: in is the fraction of the change done at `u`, out is `1 − in`, as
//!   `fadeShapes.ts`: `linear` u; `sCurve` u²(3 − 2u); `invSCurve` 2u − u²(3 − 2u); `logN`
//!   1 − (1 − u)^p and `expN` u^p with p = 1.41, 2, 3.
//!
//! An unknown code reads as equal power. Transcendentals go through `libm` (only the 1.41 powers
//! need one).

use crate::equal_power::{cos_quarter, sin_quarter};

/// The wire's `FADE_SHAPE_*` codes.
pub mod shape {
    pub const EQUAL_POWER: u8 = 0;
    pub const LINEAR: u8 = 1;
    pub const S_CURVE: u8 = 2;
    pub const INV_S_CURVE: u8 = 3;
    pub const LOG1: u8 = 4;
    pub const LOG2: u8 = 5;
    pub const LOG3: u8 = 6;
    pub const EXP1: u8 = 7;
    pub const EXP2: u8 = 8;
    pub const EXP3: u8 = 9;
}

#[inline]
fn pow(x: f32, which: u8) -> f32 {
    match which {
        0 => libm::powf(x, 1.41),
        1 => x * x,
        _ => x * x * x,
    }
}

/// The fraction of the change a fade of `shape` has made at phase `u` (clamped to 0..1); equal
/// power reads as its fade in.
#[inline]
pub fn level(shape: u8, u: f32) -> f32 {
    let t = u.clamp(0.0, 1.0);
    let smooth = t * t * (3.0 - 2.0 * t);
    match shape {
        shape::LINEAR => t,
        shape::S_CURVE => smooth,
        shape::INV_S_CURVE => 2.0 * t - smooth,
        shape::LOG1..=shape::LOG3 => 1.0 - pow(1.0 - t, shape - shape::LOG1),
        shape::EXP1..=shape::EXP3 => pow(t, shape - shape::EXP1),
        _ => sin_quarter(t),
    }
}

/// The incoming side's gain at phase `u`.
#[inline]
pub fn fade_in(shape: u8, u: f32) -> f32 {
    level(shape, u)
}

/// The outgoing side's gain at phase `u`.
#[inline]
pub fn fade_out(shape: u8, u: f32) -> f32 {
    match shape {
        shape::LINEAR..=shape::EXP3 => 1.0 - level(shape, u),
        _ => cos_quarter(u),
    }
}

/// Both gains at phase `u`: `(in, out)`.
#[inline]
pub fn crossfade(shape: u8, u: f32) -> (f32, f32) {
    (fade_in(shape, u), fade_out(shape, u))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_power_keeps_power_and_unknown_codes_read_as_it() {
        for k in 0..=20 {
            let u = k as f32 / 20.0;
            let (i, o) = crossfade(shape::EQUAL_POWER, u);
            assert!((i * i + o * o - 1.0).abs() < 1e-5, "{u}");
            assert_eq!(crossfade(15, u), (i, o));
        }
    }

    #[test]
    fn every_shape_runs_from_out_to_in_and_matches_the_ts_formulas() {
        for s in shape::LINEAR..=shape::EXP3 {
            assert_eq!(crossfade(s, 0.0), (0.0, 1.0), "shape {s}");
            assert!((fade_in(s, 1.0) - 1.0).abs() < 1e-6 && fade_out(s, 1.0).abs() < 1e-6, "shape {s}");
        }
        let u = 0.3f32;
        assert!((level(shape::LINEAR, u) - 0.3).abs() < 1e-7);
        assert!((level(shape::S_CURVE, u) - 0.216).abs() < 1e-6);
        assert!((level(shape::INV_S_CURVE, u) - (0.6 - 0.216)).abs() < 1e-6);
        assert!((level(shape::LOG1, u) - (1.0 - 0.7f64.powf(1.41)) as f32).abs() < 1e-6);
        assert!((level(shape::LOG2, u) - 0.51).abs() < 1e-6);
        assert!((level(shape::LOG3, u) - (1.0 - 0.343)).abs() < 1e-6);
        assert!((level(shape::EXP1, u) - 0.3f64.powf(1.41) as f32).abs() < 1e-6);
        assert!((level(shape::EXP2, u) - 0.09).abs() < 1e-6);
        assert!((level(shape::EXP3, u) - 0.027).abs() < 1e-6);
        // Linear is amplitude-complementary: 0.5 / 0.5 at the middle (−6 dB each, not equal power's −3 dB).
        assert_eq!(crossfade(shape::LINEAR, 0.5), (0.5, 0.5));
    }
}
