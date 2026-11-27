//! Critically damped springs in closed form (Daniel Holden, "Spring-It-On: The Game Developer's
//! Spring-Roll-Call", orange-duck.com, 2021): the trajectory predictor's maths.
//!
//! Both springs are exact solutions of the critically damped ODE, so stepping `dt` twice equals
//! stepping `2·dt` once up to rounding (and the accuracy of [`neg_exp`]). The damping comes from a
//! half-life: the time it takes to close half the gap to the goal (for a step input).
//!
//! Deterministic (the rules of `anim-math`): plain `+ − × ÷`, no fused multiply-add, and
//! `e^-x` through `anim_math::trig::exp2`, never libm.

use anim_math::trig::exp2;
use anim_math::Lane;

/// Added to a half-life so a zero half-life doesn't divide by zero (it then snaps).
pub const HALF_LIFE_EPSILON: f32 = 1e-5;

/// `e^-x` for `x ≥ 0`, deterministically (`2^(-x·log2 e)` through `anim_math::trig::exp2`;
/// relative error about 1e-7 for `x` up to ~10). Negative or NaN `x` gives 1.
#[inline]
pub fn neg_exp(x: f32) -> f32 {
    if !(x > 0.0) {
        return 1.0;
    }
    if x > 87.0 {
        return 0.0;
    }
    exp2(-(x * core::f32::consts::LOG2_E))
}

/// The damping `y` of a critically damped spring (`x'' = −2y·x' − y²·x`) whose half-life is
/// `half_life`: `y = 2·ln 2 / (half_life + ε)` (Holden's `halflife_to_damping / 2`).
#[inline]
pub fn damping(half_life: f32) -> f32 {
    (2.0 * core::f32::consts::LN_2) / (Lane::max(half_life, 0.0) + HALF_LIFE_EPSILON)
}

/// A value `x` with velocity `v` pulled toward `goal`, after `dt` seconds (Holden's
/// `simple_spring_damper_exact`). Returns the new `(x, v)`. Critically damped: from rest it never
/// overshoots `goal`.
#[inline]
pub fn spring_damper(x: f32, v: f32, goal: f32, half_life: f32, dt: f32) -> (f32, f32) {
    let y = damping(half_life);
    let j0 = x - goal;
    let j1 = v + j0 * y;
    let e = neg_exp(y * dt);
    (e * (j0 + j1 * dt) + goal, e * (v - j1 * y * dt))
}

/// A position `x` whose velocity `v` (and acceleration `a`) is pulled toward `v_goal`, after `dt`
/// seconds (Holden's `spring_character_update`). Returns the new `(x, v, a)`. The velocity is
/// critically damped toward `v_goal`; the position is its exact integral.
#[inline]
pub fn velocity_spring(
    x: f32,
    v: f32,
    a: f32,
    v_goal: f32,
    half_life: f32,
    dt: f32,
) -> (f32, f32, f32) {
    let y = damping(half_life);
    let j0 = v - v_goal;
    let j1 = a + j0 * y;
    let e = neg_exp(y * dt);
    let yy = y * y;
    let x1 = e * ((-j1) / yy + (-j0 - j1 * dt) / y) + j1 / yy + j0 / y + v_goal * dt + x;
    let v1 = e * (j0 + j1 * dt) + v_goal;
    let a1 = e * (a - j1 * y * dt);
    (x1, v1, a1)
}

/// `x` wrapped into `[−π, π]` (`x − 2π·round(x / 2π)`, ties to even).
#[inline]
pub fn wrap_angle(x: f32) -> f32 {
    const TAU: f32 = core::f32::consts::TAU;
    x - TAU * (x / TAU).round_even()
}
