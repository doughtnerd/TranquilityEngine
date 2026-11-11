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
//! the signatures.

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
    // Z2b: the four laws (the equal-power pair through `crate::equal_power`). Linear until then.
    let _ = law;
    u
}

/// The fade's value at phase `u` going from `from` to `to` under `law`: `from` at `u = 0`, `to` at
/// `u = 1` exactly. For the equal-power pair it is evaluated so that a fade 1 → 0 under
/// `equalPowerOut` is `cos(u·π/2)` and 0 → 1 under `equalPowerIn` is `sin(u·π/2)` to within the
/// table error (Z2b chooses the f32 formulation; the seam goldens hold it to 1e-5). Control rate only.
#[inline]
pub fn value(law: Law, from: f32, to: f32, u: f32) -> f32 {
    // Z2b: the law's value. Linear until then.
    from + (to - from) * progress(law, u)
}
