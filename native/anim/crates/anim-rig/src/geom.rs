//! Small deterministic geometry shared by the solvers: shortest-arc rotations, swing-twist
//! decomposition, cone clamping, angle measurement and a deterministic `e^-x`.
//!
//! Everything here follows `anim-math`'s determinism rules: only `+ − × ÷ √`, exact operations,
//! and `anim-math`'s polynomial [`sin_cos`]/[`atan2`]. No libm, no fused multiply-add. Vectors
//! named "unit" must be unit length (within f32 rounding); the functions don't renormalise them.

use anim_math::trig::{atan2, sin_cos};
use anim_math::{AosQuat, AosVec3};

/// Squared length under which a direction is treated as degenerate (lengths below 1e-6 m).
pub const DEGENERATE_SQ: f32 = 1e-12;

/// `v / |v|`, or `fallback` when `|v|² ≤ DEGENERATE_SQ`.
#[inline]
pub fn normalize_or(v: AosVec3, fallback: AosVec3) -> AosVec3 {
    let l2 = v.length_squared();
    if l2 > DEGENERATE_SQ {
        v.scale(1.0 / l2.sqrt())
    } else {
        fallback
    }
}

/// A unit vector perpendicular to the unit `u`: `normalize(u × X)` when `|u.x| < 0.57735`
/// (`u` is then at least 54.7° away from X), otherwise `normalize(u × Y)`. Deterministic, so a
/// degenerate configuration always picks the same axis.
#[inline]
pub fn any_orthogonal(u: AosVec3) -> AosVec3 {
    let axis = if u.x.abs() < 0.577_35 {
        AosVec3::new(1.0, 0.0, 0.0)
    } else {
        AosVec3::new(0.0, 1.0, 0.0)
    };
    normalize_or(u.cross(axis), AosVec3::new(0.0, 0.0, 1.0))
}

/// The shortest-arc rotation taking unit `u` to unit `v`.
///
/// With `d = u·v`: `q = normalize(u × v, 1 + d)` (the half-angle quaternion, since
/// `|u × v| = sin θ` and `1 + cos θ = 2cos²(θ/2)`). When `d < −1 + 1e-6` (opposite directions)
/// the axis is undefined and the result is the half turn about [`any_orthogonal`]`(u)`.
#[inline]
pub fn from_to(u: AosVec3, v: AosVec3) -> AosQuat {
    let d = u.dot(v);
    if d < -1.0 + 1e-6 {
        let a = any_orthogonal(u);
        return AosQuat::new(a.x, a.y, a.z, 0.0);
    }
    let c = u.cross(v);
    AosQuat::new(c.x, c.y, c.z, 1.0 + d).normalize_or_identity()
}

/// The rotation that takes unit `u1` exactly onto unit `v1` and then turns about `v1` so the part
/// of `u2` perpendicular to `u1` lines up with the part of `v2` perpendicular to `v1`.
///
/// `q1 = from_to(u1, v1)`; `a = ⊥(q1·u2)`, `b = ⊥(v2)` (projections onto the plane normal to
/// `v1`); `q2` is the rotation about `v1` by the signed angle from `a` to `b`
/// (`atan2((a × b)·v1, a·b)`). Returns `q2 · q1`. If either projection is degenerate the
/// secondary alignment is skipped (`q1` alone).
#[inline]
pub fn from_to_pair(u1: AosVec3, u2: AosVec3, v1: AosVec3, v2: AosVec3) -> AosQuat {
    let q1 = from_to(u1, v1);
    let a = q1.rotate(u2);
    let a = a - v1.scale(a.dot(v1));
    let b = v2 - v1.scale(v2.dot(v1));
    if a.length_squared() <= DEGENERATE_SQ || b.length_squared() <= DEGENERATE_SQ {
        return q1;
    }
    let angle = atan2(a.cross(b).dot(v1), a.dot(b));
    (AosQuat::from_axis_angle(v1, angle) * q1).normalize_or_identity()
}

/// Splits `q` into `swing · twist`, with `twist` a rotation about the unit `axis` and `swing` a
/// rotation about an axis perpendicular to it.
///
/// `twist = normalize((q.xyz · axis)·axis, q.w)`; `swing = q · twist⁻¹`. When `q` is a half turn
/// about an axis perpendicular to `axis` the twist is undefined and is identity.
#[inline]
pub fn swing_twist(q: AosQuat, axis: AosVec3) -> (AosQuat, AosQuat) {
    let p = axis.scale(q.xyz().dot(axis));
    let twist = AosQuat::new(p.x, p.y, p.z, q.w).normalize_or_identity();
    let swing = (q * twist.conjugate()).normalize_or_identity();
    (swing, twist)
}

/// The angle in `[0, π]` between two vectors (any lengths): `atan2(|u × v|, u·v)`, accurate near
/// 0 and π (unlike `acos`). 0 when either is zero.
#[inline]
pub fn angle_between(u: AosVec3, v: AosVec3) -> f32 {
    atan2(u.cross(v).length(), u.dot(v))
}

/// The angle in `[0, π]` of a unit quaternion: `2·atan2(|xyz|, |w|)`.
#[inline]
pub fn rotation_angle(q: AosQuat) -> f32 {
    2.0 * atan2(q.xyz().length(), q.w.abs())
}

/// Unit `dir`, pulled back onto the cone of half-angle `max_angle` around unit `axis` when it lies
/// outside: `axis·cos(max) + p·sin(max)`, `p` the unit part of `dir` perpendicular to `axis`.
/// A `max_angle` of π or more never clamps.
#[inline]
pub fn clamp_cone(dir: AosVec3, axis: AosVec3, max_angle: f32) -> AosVec3 {
    if max_angle >= core::f32::consts::PI {
        return dir;
    }
    let max_angle = fmax(max_angle, 0.0);
    if angle_between(dir, axis) <= max_angle {
        return dir;
    }
    let p = normalize_or(dir - axis.scale(dir.dot(axis)), any_orthogonal(axis));
    let (s, c) = sin_cos(max_angle);
    axis.scale(c) + p.scale(s)
}

/// The unit rotation `q` limited to at most `max_angle` radians (same axis). A `max_angle` of π
/// or more never clamps.
#[inline]
pub fn clamp_angle(q: AosQuat, max_angle: f32) -> AosQuat {
    if max_angle >= core::f32::consts::PI {
        return q;
    }
    let (axis, angle) = q.to_axis_angle();
    let max_angle = fmax(max_angle, 0.0);
    if angle <= max_angle {
        q
    } else {
        AosQuat::from_axis_angle(axis, max_angle)
    }
}

/// `q` scaled to the fraction `t` of its angle: `slerp(identity, q, t)` (exact in angle, unlike
/// nlerp). `t ≤ 0` gives identity and `t ≥ 1` gives `q` unchanged.
#[inline]
pub fn fraction(q: AosQuat, t: f32) -> AosQuat {
    if !(t > 0.0) {
        AosQuat::identity()
    } else if t >= 1.0 {
        q
    } else {
        AosQuat::identity().slerp(q, t).normalize_or_identity()
    }
}

/// `e^-x` for `x ≥ 0`, deterministically (no libm): with `y = x·log2(e)`, `k = ⌊y⌋` and
/// `f = y − k ∈ [0, 1)`, `e^-x = 2^-f · 2^-k`, where `2^-f = e^(-f·ln 2)` is its degree-8 Taylor
/// polynomial (Horner, truncation error < 1.1e-7 relative) and `2^-k` is built exactly from its
/// bits. Negative or NaN `x` gives 1; `x > 87` gives 0. Relative error against f64 `exp` is
/// within about `(1 + x)·1.2e-7` (the rounding of `x·log2 e` grows with `x`).
#[inline]
pub fn exp_neg(x: f32) -> f32 {
    if !(x > 0.0) {
        return 1.0;
    }
    if x > 87.0 {
        return 0.0;
    }
    let y = x * core::f32::consts::LOG2_E;
    let k = y.floor();
    let f = (y - k) * -core::f32::consts::LN_2; // in (-ln 2, 0]
                                                // e^f, Taylor to degree 8.
    let p = 1.0
        + f * (1.0
            + f * (0.5
                + f * (1.0 / 6.0
                    + f * (1.0 / 24.0
                        + f * (1.0 / 120.0
                            + f * (1.0 / 720.0 + f * (1.0 / 5040.0 + f * (1.0 / 40320.0))))))));
    let scale = f32::from_bits(((127 - k as i32) as u32) << 23);
    p * scale
}

/// The fraction of the way a critically damped follower closes its gap in `dt` seconds with the
/// given half-life: `1 − e^(−ln 2 · dt / half_life)` (half the gap closes every `half_life`).
/// A half-life at or below 0 snaps (1); `dt ≤ 0` gives 0.
#[inline]
pub fn half_life_alpha(half_life: f32, dt: f32) -> f32 {
    if !(dt > 0.0) {
        return 0.0;
    }
    if !(half_life > 0.0) {
        return 1.0;
    }
    1.0 - exp_neg(core::f32::consts::LN_2 * dt / half_life)
}

/// `x` clamped to `[0, 1]`; NaN gives 0 (weights from parameters may be anything).
#[inline]
pub fn unit_clamp(x: f32) -> f32 {
    if x > 0.0 {
        if x < 1.0 {
            x
        } else {
            1.0
        }
    } else {
        0.0
    }
}

/// Pseudo-maximum `if a < b { b } else { a }` (wasm `pmax`, `anim-math`'s rule 6): one
/// comparison, so NaN and signed zeros behave the same on every target (unlike `f32::max`,
/// whose result for `±0` is unspecified).
#[inline(always)]
pub fn fmax(a: f32, b: f32) -> f32 {
    anim_math::Lane::max(a, b)
}

/// Pseudo-minimum `if b < a { b } else { a }` (wasm `pmin`); see [`fmax`].
#[inline(always)]
pub fn fmin(a: f32, b: f32) -> f32 {
    anim_math::Lane::min(a, b)
}
