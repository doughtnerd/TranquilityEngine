//! Penner easings by id, deterministic: only `+ − × ÷ √`, the exact `round_even`, and
//! `anim_math::trig`'s polynomial sine and cosine, so every target gives the same bits (no libm
//! `pow`, `exp` or `sin`). Used by the tween table and timeline programs (ADR 0371, 0372).
//!
//! # Ids
//!
//! `0` is linear. Id `1 + 3·family + mode` is a family's easing, with the families in order
//! `quad, cubic, quart, quint, sine, expo, circ, back, elastic, bounce` and the modes
//! `0 = in`, `1 = out`, `2 = inOut` ([`LAST_ID`] is 30). An unknown id is linear. The ids are
//! [`crate::wire`]'s `EASE_*` constants (a test in `anim-wasm` holds the two equal).
//!
//! Moved here from `anim-math` (ADR 0420 spike). `2^x` ([`exp2`]) stayed in `anim-math`
//! (`anim_math::trig::exp2`): `anim-match`'s springs use it too.
//!
//! # Formulas
//!
//! `t` is progress, clamped to `[0, 1]`; **`ease(id, 0) = 0` and `ease(id, 1) = 1` exactly** for
//! every id (the endpoints are returned, not computed). Inside, with `in(t)` the family's ease-in
//! (the formulas of easings.net, which are Penner's):
//!
//! | Family | `in(t)` |
//! |---|---|
//! | quad, cubic, quart, quint | `t²`, `t³`, `t⁴`, `t⁵` |
//! | sine | `1 − cos(t·π/2)` |
//! | expo | `2^(10t − 10)` |
//! | circ | `1 − √(1 − t²)` |
//! | back | `(c+1)·t³ − c·t²`, `c = 1.70158` (inOut: `c = 1.70158·1.525`) |
//! | elastic | `−2^(10t − 10) · sin((10t − 10.75)·2π/3)` (inOut: `−2^(10t − 10) · sin((10t − 11.125)·2π/4.5)`) |
//! | bounce | `1 − out(1 − t)`, with `out(t)` the four parabolas `7.5625·t²` (+ 0, 0.75, 0.9375, 0.984375) |
//!
//! `out(t) = 1 − in(1 − t)` and `inOut(t) = in(2t)/2` for `t < ½`, `1 − in(2 − 2t)/2` otherwise
//! (for back and elastic with the inOut constants above). For sine and bounce `out` is the
//! published one; for elastic it equals easings.net's `2^(−10t)·sin((10t − 0.75)·2π/3) + 1`.
//!
//! `2^x` is `2^round(x)` (exact, built from the exponent bits) times the degree-7 Taylor series
//! of `e^(r·ln 2)` for the remainder `r` in `[−½, ½]` (truncation error under 6e-9 relative).
//!
//! # Accuracy
//!
//! Against f64 evaluations of the same formulas (`tests/ease.rs`): absolute error ≤ 2e-6 for
//! every id on a 1,001-point grid (the sine polynomial's 3e-7 amplified by elastic's factors of
//! 10π/3 at most).

use anim_math::trig::{exp2, sin_cos};

/// The highest easing id.
pub const LAST_ID: u32 = 30;

/// Families in id order (`1 + 3·family + mode`).
const QUAD: u32 = 0;
const CUBIC: u32 = 1;
const QUART: u32 = 2;
const QUINT: u32 = 3;
const SINE: u32 = 4;
const EXPO: u32 = 5;
const CIRC: u32 = 6;
const BACK: u32 = 7;
const ELASTIC: u32 = 8;
const BOUNCE: u32 = 9;

const HALF_PI: f32 = core::f32::consts::FRAC_PI_2;
const PI: f32 = core::f32::consts::PI;
const BACK_C: f32 = 1.70158;
const BACK_C_IN_OUT: f32 = BACK_C * 1.525;
const ELASTIC_C4: f32 = 2.0 * PI / 3.0;
const ELASTIC_C5: f32 = 2.0 * PI / 4.5;

/// The out-bounce parabolas.
fn bounce_out(t: f32) -> f32 {
    const N1: f32 = 7.5625;
    const D1: f32 = 2.75;
    if t < 1.0 / D1 {
        N1 * t * t
    } else if t < 2.0 / D1 {
        let t = t - 1.5 / D1;
        N1 * t * t + 0.75
    } else if t < 2.5 / D1 {
        let t = t - 2.25 / D1;
        N1 * t * t + 0.9375
    } else {
        let t = t - 2.625 / D1;
        N1 * t * t + 0.984375
    }
}

/// The family's ease-in at `t` in `(0, 1)`; `in_out` selects back's and elastic's inOut constants.
fn ease_in(family: u32, t: f32, in_out: bool) -> f32 {
    match family {
        QUAD => t * t,
        CUBIC => t * t * t,
        QUART => {
            let s = t * t;
            s * s
        }
        QUINT => {
            let s = t * t;
            s * s * t
        }
        SINE => 1.0 - sin_cos(t * HALF_PI).1,
        EXPO => exp2(10.0 * t - 10.0),
        CIRC => 1.0 - (1.0 - t * t).max(0.0).sqrt(),
        BACK => {
            let c = if in_out { BACK_C_IN_OUT } else { BACK_C };
            t * t * ((c + 1.0) * t - c)
        }
        ELASTIC => {
            let (c, phase) = if in_out {
                (ELASTIC_C5, 11.125)
            } else {
                (ELASTIC_C4, 10.75)
            };
            -exp2(10.0 * t - 10.0) * sin_cos((10.0 * t - phase) * c).0
        }
        BOUNCE => 1.0 - bounce_out(1.0 - t),
        _ => t,
    }
}

/// The easing `id` at progress `t` (see the module docs). A NaN `t` reads as 0.
pub fn ease(id: u32, t: f32) -> f32 {
    let t = if t > 0.0 { t } else { 0.0 };
    if id == 0 || id > LAST_ID {
        return t.min(1.0);
    }
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let family = (id - 1) / 3;
    match (id - 1) % 3 {
        0 => ease_in(family, t, false),
        1 => 1.0 - ease_in(family, 1.0 - t, false),
        _ => {
            if t < 0.5 {
                ease_in(family, 2.0 * t, true) * 0.5
            } else {
                1.0 - ease_in(family, 2.0 - 2.0 * t, true) * 0.5
            }
        }
    }
}
