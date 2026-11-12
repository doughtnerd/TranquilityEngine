//! Z3's offline reference for shaped fades (0166 M4-0; architecture §4.4 "Fade laws at control
//! rate"; README "Notes for the build"; build log, Z2b's "Exact law for Z3").
//!
//! The core runs a shaped fade on a linear ramp retargeted at control rate, so the reference does
//! the same, in f64:
//! - **Knots** at the fade's start `F`, at each quantum boundary after it, and at `F + N`.
//! - At a knot `x`, the phase is `u = 1 − (1 − u0)·(F + N − x)/N` and the value the law's value
//!   there (`b` exactly at `F + N`).
//! - The output at frame `t` is the linear interpolation between the knots around `x = t + 1` (the
//!   first frame after a knot already moves, as `Ramp` does). Before `F` it is `a`; from `F + N − 1`
//!   on it is `b`.
//!
//! [`Fade::at`] is that same-knot reference: seams null to **1e-5** against it. [`Fade::exact`]
//! evaluates the law itself at `x = t + 1` (no knots): seams null to **1e-4** against it, the
//! bound on what control rate costs.
//!
//! The laws are written as `audio_dsp::curve_laws::value` writes them (Z2b's ruling), in f64 with
//! `libm`'s `sin`/`cos`: `linear` `a + (b − a)·u`; `sCurve` `a + (b − a)·u²(3 − 2u)`;
//! `equalPowerIn` `a + (b − a)·sin(uπ/2)`; `equalPowerOut` `b + (a − b)·cos(uπ/2)`.

#![allow(dead_code)]

use audio_core::QUANTUM;
use audio_wire::generated as wire;

/// A fade law (the wire's `fade_law` values).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Law {
    Linear,
    SCurve,
    EqualPowerIn,
    EqualPowerOut,
}

impl Law {
    /// The wire value (the `shape` word's bits 0–2).
    pub fn bits(self) -> u32 {
        match self {
            Law::Linear => wire::fade_law::LINEAR,
            Law::SCurve => wire::fade_law::S_CURVE,
            Law::EqualPowerIn => wire::fade_law::EQUAL_POWER_IN,
            Law::EqualPowerOut => wire::fade_law::EQUAL_POWER_OUT,
        }
    }

    /// The law's value at phase `u` going from `a` to `b` (exact at both ends).
    pub fn value(self, a: f64, b: f64, u: f64) -> f64 {
        if u <= 0.0 {
            return a;
        }
        if u >= 1.0 {
            return b;
        }
        let h = core::f64::consts::FRAC_PI_2;
        match self {
            Law::Linear => a + (b - a) * u,
            Law::SCurve => a + (b - a) * (u * u * (3.0 - 2.0 * u)),
            Law::EqualPowerIn => a + (b - a) * libm::sin(u * h),
            Law::EqualPowerOut => b + (a - b) * libm::cos(u * h),
        }
    }
}

/// The `shape` word of `law` with start phase `u0` (16-bit fixed point, as the wire packs it).
pub fn shape(law: Law, u0: f64) -> u32 {
    wire::pack_shape(law.bits(), (u0 * wire::SHAPE_PHASE_SCALE as f64) as u32)
}

/// A fade from `a` to `b` under `law`, starting at absolute frame `f`, over `n` frames, from phase `u0`.
#[derive(Clone, Copy, Debug)]
pub struct Fade {
    pub law: Law,
    pub a: f64,
    pub b: f64,
    pub f: usize,
    pub n: usize,
    pub u0: f64,
}

impl Fade {
    pub fn new(law: Law, a: f64, b: f64, f: usize, n: usize) -> Fade {
        Fade { law, a, b, f, n, u0: 0.0 }
    }

    /// The phase at frame `x` (`u0` at `f`, 1 at `f + n`).
    fn phase(&self, x: usize) -> f64 {
        1.0 - (1.0 - self.u0) * (self.f + self.n - x) as f64 / self.n as f64
    }

    /// The value at knot `x` (`b` exactly at `f + n`).
    fn knot(&self, x: usize) -> f64 {
        if x >= self.f + self.n { self.b } else { self.law.value(self.a, self.b, self.phase(x)) }
    }

    /// The same-knot reference: the output's gain at absolute frame `t`.
    pub fn at(&self, t: usize) -> f64 {
        if t < self.f {
            return self.a;
        }
        let x = t + 1;
        if x >= self.f + self.n {
            return self.b;
        }
        let lo = ((x - 1) / QUANTUM * QUANTUM).max(self.f);
        let hi = (((x - 1) / QUANTUM + 1) * QUANTUM).min(self.f + self.n);
        let (vl, vh) = (self.knot(lo), self.knot(hi));
        vl + (vh - vl) * (x - lo) as f64 / (hi - lo) as f64
    }

    /// The exact curve: the law at frame `t + 1`, with no knots.
    pub fn exact(&self, t: usize) -> f64 {
        if t < self.f {
            return self.a;
        }
        let x = t + 1;
        if x >= self.f + self.n { self.b } else { self.law.value(self.a, self.b, self.phase(x)) }
    }
}

/// The largest `|got[t] − want(t)|` over `range`.
pub fn max_error(got: &[f32], range: core::ops::Range<usize>, want: impl Fn(usize) -> f64) -> f64 {
    range.map(|t| (got[t] as f64 - want(t)).abs()).fold(0.0, f64::max)
}
