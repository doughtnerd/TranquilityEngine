//! The fade laws, evaluated at control rate (0166 M4-0, api-and-models §3.1 "Fade laws", §4.2;
//! architecture §4.4 "Fade laws at control rate"; rulings R5, R6; ADR 0167 §2).
//!
//! A shaped fade runs on the voice's linear [`crate::ramp::Ramp`]. `audio-core`'s `curves` module
//! retargets that ramp at the record's start sample and at every quantum boundary to the law's
//! value at the phase `u` there, so the law is evaluated **once per knot, never per sample**, and
//! never through `libm` `sinf`/`sqrtf` (S4: 4.5× slower in wasm).
//!
//! The laws, with `p = u` in `[0, 1]` and the fade going from `from` to `to`:
//! - `linear`: `from + (to − from)·p` (one ramp; the curve pool isn't used);
//! - `sCurve`: progress `p·p·(3 − 2p)`;
//! - `equalPowerIn`: rises as `sin(p·π/2)` (`equal_power::sin_quarter`);
//! - `equalPowerOut`: falls as `cos(p·π/2)` (`equal_power::cos_quarter`).
//!
//! A FADE to 1 with `equalPowerIn` from 0 and a FADE to 0 with `equalPowerOut` from 1 at the same
//! frame are power-complementary (`in² + out² = 1` within the table error). Seams null to 1e-5
//! against an f64 reference evaluating the same law at the same knots (R6).
//!
//! Owner: **Z2b** (bodies and tests). Q1 left the law values (the wire's `shape` word bits 0–2) and
//! the signatures; leaf **L-Z2bb** fills the stubs tagged `L-Z2bb` and un-ignores the tests below.

/// A fade law: the `shape` word's bits 0–2 (api-and-models §4.2; the wire's law values).
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Law {
    /// 0: linear (and every record without a shape word: today's behaviour).
    #[default]
    Linear = 0,
    /// 1: `p·p·(3 − 2p)`.
    SCurve = 1,
    /// 2: `sin(p·π/2)`.
    EqualPowerIn = 2,
    /// 3: `cos(p·π/2)`.
    EqualPowerOut = 3,
}

impl Law {
    /// The law of a 3-bit field (the `shape` word's bits 0–2). Values 4–7 are unassigned and read as
    /// [`Law::Linear`], so an unknown law degrades to today's behaviour rather than failing.
    pub const fn from_bits(bits: u32) -> Law {
        match bits & 0b111 {
            1 => Law::SCurve,
            2 => Law::EqualPowerIn,
            3 => Law::EqualPowerOut,
            _ => Law::Linear,
        }
    }

    /// `true` for every law but [`Law::Linear`]: a shaped fade needs a curve-pool entry.
    pub const fn is_shaped(self) -> bool {
        !matches!(self, Law::Linear)
    }
}

/// The law's progress at phase `u` (clamped to `[0, 1]`): 0 at `u = 0`, 1 at `u = 1` exactly, for
/// every law (`equalPowerOut`'s progress is `1 − cos(u·π/2)`). Control rate only.
#[inline]
pub fn progress(law: Law, u: f32) -> f32 {
    // L-Z2bb: clamp `u` to [0, 1], then linear `u`; sCurve `u*u*(3.0 - 2.0*u)`; equalPowerIn
    // `equal_power::sin_quarter(u)`; equalPowerOut `1.0 - equal_power::cos_quarter(u)`. Linear until then.
    let _ = law;
    u
}

/// The fade's value at phase `u` going from `from` to `to` under `law`: `from` at `u = 0`, `to` at
/// `u = 1` exactly. For the equal-power pair it is evaluated so that a fade 1 → 0 under
/// `equalPowerOut` is `cos(u·π/2)` and 0 → 1 under `equalPowerIn` is `sin(u·π/2)` to within the
/// table error (the seam goldens hold it to 1e-5). Control rate only.
///
/// **The f32 formulation (Z2b's ruling; Z3's offline reference evaluates the same law in f64):**
/// `u <= 0` (or NaN) returns `from` and `u >= 1` returns `to` exactly; otherwise
/// - `Linear`: `from + (to − from)·u`;
/// - `SCurve`: `from + (to − from)·(u·u·(3 − 2u))`;
/// - `EqualPowerIn`: `from + (to − from)·sin_quarter(u)`;
/// - `EqualPowerOut`: `to + (from − to)·cos_quarter(u)` (written from `to`, not as `1 − cos`, so a
///   fade 1 → 0 is `cos_quarter(u)` with no cancellation and pairs with `EqualPowerIn` 0 → 1 to the
///   table's power error).
#[inline]
pub fn value(law: Law, from: f32, to: f32, u: f32) -> f32 {
    // L-Z2bb: the formulation above. Linear until then.
    from + (to - from) * progress(law, u)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAWS: [Law; 4] = [Law::Linear, Law::SCurve, Law::EqualPowerIn, Law::EqualPowerOut];
    /// `sin_quarter`'s measured error is 3.522e-7 (see `equal_power`); a law adds f32 rounding.
    const LAW_ERROR: f64 = 5e-7;
    /// The in/out pair's `in² + out² − 1`, measured 8.0e-7 through `equal_power` (ARCH §5.3, R6).
    const POWER_ERROR: f64 = 1e-6;

    fn grid() -> impl Iterator<Item = f32> {
        (0..=100_000u32).map(|k| k as f32 / 100_000.0)
    }

    fn exact_progress(law: Law, u: f64) -> f64 {
        let h = core::f64::consts::FRAC_PI_2;
        match law {
            Law::Linear => u,
            Law::SCurve => u * u * (3.0 - 2.0 * u),
            Law::EqualPowerIn => libm::sin(u * h),
            Law::EqualPowerOut => 1.0 - libm::cos(u * h),
        }
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn progress_is_zero_at_zero_and_one_at_one_for_every_law() {
        for law in LAWS {
            assert_eq!(progress(law, 0.0), 0.0, "{law:?}");
            assert_eq!(progress(law, 1.0), 1.0, "{law:?}");
            assert_eq!(progress(law, -1.0), 0.0, "{law:?} clamps below");
            assert_eq!(progress(law, 2.0), 1.0, "{law:?} clamps above");
        }
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn progress_follows_each_law() {
        for law in LAWS {
            for u in grid() {
                let err = (progress(law, u) as f64 - exact_progress(law, u as f64)).abs();
                assert!(err <= LAW_ERROR, "{law:?} at {u}: {err:e}");
            }
        }
        assert_eq!(progress(Law::SCurve, 0.5), 0.5);
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn value_lands_exactly_on_from_and_to() {
        let pairs = [(0.0f32, 1.0f32), (1.0, 0.0), (0.7, 0.3), (0.25, 0.8), (2.0, -1.5)];
        for law in LAWS {
            for (from, to) in pairs {
                assert_eq!(value(law, from, to, 0.0), from, "{law:?} {from} -> {to}");
                assert_eq!(value(law, from, to, 1.0), to, "{law:?} {from} -> {to}");
                assert_eq!(value(law, from, to, -0.25), from, "{law:?} clamps below");
                assert_eq!(value(law, from, to, 1.25), to, "{law:?} clamps above");
            }
        }
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn value_maps_progress_between_from_and_to() {
        for law in LAWS {
            for u in grid() {
                let (from, to) = (0.8f64, 0.2f64);
                let exact = from + (to - from) * exact_progress(law, u as f64);
                let err = (value(law, from as f32, to as f32, u) as f64 - exact).abs();
                assert!(err <= LAW_ERROR * 2.0, "{law:?} at {u}: {err:e}");
            }
        }
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn the_equal_power_pair_is_the_quarter_sine_and_cosine() {
        for u in grid() {
            assert_eq!(value(Law::EqualPowerIn, 0.0, 1.0, u), crate::equal_power::sin_quarter(u), "in at {u}");
            if u > 0.0 && u < 1.0 {
                assert_eq!(value(Law::EqualPowerOut, 1.0, 0.0, u), crate::equal_power::cos_quarter(u), "out at {u}");
            }
        }
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn the_equal_power_crossfade_keeps_power_within_1e_6() {
        let mut max = 0.0f64;
        for u in grid() {
            let fade_in = value(Law::EqualPowerIn, 0.0, 1.0, u) as f64;
            let fade_out = value(Law::EqualPowerOut, 1.0, 0.0, u) as f64;
            max = max.max((fade_in * fade_in + fade_out * fade_out - 1.0).abs());
        }
        assert!(max <= POWER_ERROR, "max power error {max:e}");
    }

    #[test]
    #[ignore = "L-Z2bb"]
    fn every_law_is_monotone() {
        for law in LAWS {
            let mut last = 0.0f32;
            for u in grid() {
                let p = progress(law, u);
                assert!(p >= last, "{law:?} at {u}");
                last = p;
            }
        }
    }

    #[test]
    fn unknown_law_bits_read_as_linear() {
        for bits in 4..8 {
            assert_eq!(Law::from_bits(bits), Law::Linear);
        }
        assert_eq!(Law::from_bits(0b1010), Law::EqualPowerIn, "only bits 0-2 count");
        assert!(!Law::Linear.is_shaped() && Law::SCurve.is_shaped());
    }
}
