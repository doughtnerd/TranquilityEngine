//! Reference area `rig`: f64 IK solvers, look-at, a spring-bone step and the warping maths, the
//! reference for `anim-rig`.
//!
//! Written for clarity and, where possible, by a different route than `anim-rig`: angles from
//! the law of cosines through `acos` instead of a projected knee, rotations through
//! axis-angle and libm `sin`/`cos`/`acos`/`exp`, positions-only FABRIK. Everything works on
//! model-space positions, so the comparisons don't depend on bone frames.

use crate::math::{Quat, Transform, Vec3};

/// The shortest-arc rotation from `u` to `v` (any lengths), through axis and angle:
/// axis `u × v`, angle `acos(û·v̂)`. Opposite vectors turn about an axis perpendicular to `u`
/// (`u × X`, or `u × Y` when `u` is near X).
pub fn from_to(u: Vec3, v: Vec3) -> Quat {
    let (u, v) = (u.normalize_or(Vec3::X), v.normalize_or(Vec3::X));
    let c = u.dot(v).clamp(-1.0, 1.0);
    let angle = c.acos();
    let mut axis = u.cross(v);
    if axis.length() < 1e-12 {
        if c > 0.0 {
            return Quat::IDENTITY;
        }
        axis = if u.x.abs() < 0.57735 {
            u.cross(Vec3::X)
        } else {
            u.cross(Vec3::new(0.0, 1.0, 0.0))
        };
    }
    Quat::from_axis_angle(axis.normalize_or(Vec3::X), angle)
}

/// Dixon's soft-IK reach: `d` unchanged up to `L − s` (`s = soft·L`), then
/// `L − s + s·(1 − e^(−(d − L + s)/s))`.
pub fn soft_reach(d: f64, full: f64, soft: f64) -> f64 {
    let s = soft * full;
    let start = full - s;
    if s > 1e-9 && d > start {
        start + s * (1.0 - (-(d - start) / s).exp())
    } else {
        d
    }
}

/// Two-bone IK on positions: root `a`, mid `b`, tip `c`, target `t`, bend toward `pole` (a
/// direction from the root; `None` keeps the plane of `b`). Returns the solved `(mid, tip)`.
///
/// With `r = clamp(|t − a|, |la − lb|, la + lb)` and `α = acos((la² + r² − lb²) / (2·la·r))`,
/// the mid sits at `a + la·(cos α·û + sin α·n̂)` and the tip at `a + r·û`.
pub fn two_bone(a: Vec3, b: Vec3, c: Vec3, t: Vec3, pole: Option<Vec3>) -> (Vec3, Vec3) {
    let la = (b - a).length();
    let lb = (c - b).length();
    let u = (t - a).normalize_or((c - a).normalize_or(Vec3::X));
    let r = (t - a).length().clamp((la - lb).abs(), la + lb);
    let p = pole.unwrap_or(b - a);
    let mut n = p - u.scale(p.dot(u));
    if n.length() < 1e-9 {
        let q = b - a;
        n = q - u.scale(q.dot(u));
    }
    let n = n.normalize_or(if u.x.abs() < 0.57735 {
        u.cross(Vec3::X).normalize_or(Vec3::X)
    } else {
        u.cross(Vec3::new(0.0, 1.0, 0.0)).normalize_or(Vec3::X)
    });
    let cos = if r > 1e-12 {
        ((la * la + r * r - lb * lb) / (2.0 * la * r)).clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let alpha = cos.acos();
    let mid = a + (u.scale(alpha.cos()) + n.scale(alpha.sin())).scale(la);
    (mid, a + u.scale(r))
}

/// CCD on positions: each iteration turns joints from the tip's parent back to the root by the
/// shortest arc toward the target (axis-angle). Returns `(positions, iterations, error)`.
pub fn ccd(
    positions: &[Vec3],
    target: Vec3,
    iterations: u32,
    tolerance: f64,
) -> (Vec<Vec3>, u32, f64) {
    let mut p = positions.to_vec();
    let n = p.len();
    let mut err = (p[n - 1] - target).length();
    let mut it = 0;
    while it < iterations && err > tolerance {
        it += 1;
        for j in (0..n - 1).rev() {
            let q = from_to(p[n - 1] - p[j], target - p[j]);
            let pivot = p[j];
            for pk in p.iter_mut().skip(j + 1) {
                *pk = pivot + q.rotate(*pk - pivot);
            }
        }
        err = (p[n - 1] - target).length();
    }
    (p, it, err)
}

/// Classic positions-only FABRIK (Aristidou & Lasenby 2011, algorithm 1). Returns
/// `(positions, iterations, error)`.
pub fn fabrik(
    positions: &[Vec3],
    target: Vec3,
    iterations: u32,
    tolerance: f64,
) -> (Vec<Vec3>, u32, f64) {
    let mut p = positions.to_vec();
    let n = p.len();
    let len: Vec<f64> = (0..n - 1).map(|j| (p[j + 1] - p[j]).length()).collect();
    let base = p[0];
    let mut err = (p[n - 1] - target).length();
    let mut it = 0;
    while it < iterations && err > tolerance {
        it += 1;
        p[n - 1] = target;
        for j in (0..n - 1).rev() {
            let d = (p[j] - p[j + 1]).normalize_or(Vec3::X);
            p[j] = p[j + 1] + d.scale(len[j]);
        }
        p[0] = base;
        for j in 0..n - 1 {
            let d = (p[j + 1] - p[j]).normalize_or(Vec3::X);
            p[j + 1] = p[j] + d.scale(len[j]);
        }
        err = (p[n - 1] - target).length();
    }
    (p, it, err)
}

/// One look-at joint in model space.
#[derive(Clone, Copy, Debug)]
pub struct AimJoint {
    pub position: Vec3,
    pub rotation: Quat,
    /// The bone's forward axis in its local frame.
    pub forward: Vec3,
    pub weight: f64,
    /// Max turn, radians.
    pub limit: f64,
}

/// Look-at over a chain: each joint in order turns its own forward toward `target` by the
/// fraction `weight` of the full turn (slerp from identity), capped at `limit`; joints below
/// turn about it. Returns the solved model rotations.
pub fn look_at(joints: &[AimJoint], target: Vec3) -> Vec<Quat> {
    let mut pos: Vec<Vec3> = joints.iter().map(|j| j.position).collect();
    let mut rot: Vec<Quat> = joints.iter().map(|j| j.rotation).collect();
    for j in 0..joints.len() {
        let f = rot[j].rotate(joints[j].forward);
        let full = from_to(f, target - pos[j]);
        let (axis, angle) = full.to_axis_angle();
        let a = (angle * joints[j].weight.clamp(0.0, 1.0)).min(joints[j].limit);
        let q = Quat::from_axis_angle(axis, a);
        let pivot = pos[j];
        for k in j..joints.len() {
            rot[k] = q * rot[k];
            if k > j {
                pos[k] = pivot + q.rotate(pos[k] - pivot);
            }
        }
    }
    rot
}

/// Spring-bone parameters (the same meaning as `anim-rig::spring::SpringSettings`).
#[derive(Clone, Copy, Debug)]
pub struct SpringParams {
    pub stiffness: f64,
    pub damping: f64,
    pub drag: f64,
    pub gravity: Vec3,
}

/// One substep of one spring particle: `x` now, `x_prev` one step (`h_prev`) ago, the parent's
/// new position `parent` and velocity `v_parent`, the animated offset `rest` from the parent.
/// Returns the new position before length, angle and collision constraints:
/// `v = v_p + ((x − x_prev)/h_prev − v_p)·e^(−damping·h)`, `v ← v·e^(−drag·h)`,
/// `x' = x + v·h + g·h² + (parent + rest − x)·min(k·h², 1)`.
#[allow(clippy::too_many_arguments)]
pub fn spring_step(
    x: Vec3,
    x_prev: Vec3,
    h_prev: f64,
    h: f64,
    parent: Vec3,
    v_parent: Vec3,
    rest: Vec3,
    p: &SpringParams,
) -> Vec3 {
    let v = if h_prev > 0.0 {
        (x - x_prev).scale(1.0 / h_prev)
    } else {
        Vec3::ZERO
    };
    let v = v_parent + (v - v_parent).scale((-p.damping * h).exp());
    let v = v.scale((-p.drag * h).exp());
    let kh2 = (p.stiffness * h * h).min(1.0);
    let a = parent + rest;
    x + v.scale(h) + p.gravity.scale(h * h) + (a - x).scale(kh2)
}

/// The time at which a uniformly sampled, non-decreasing travel curve first reaches `d`
/// (linear between samples), by a linear scan.
pub fn time_at_distance(distance: &[f64], sample_dt: f64, d: f64) -> f64 {
    if d <= distance[0] {
        return 0.0;
    }
    for i in 1..distance.len() {
        if distance[i] >= d {
            let seg = distance[i] - distance[i - 1];
            let f = if seg > 0.0 {
                (d - distance[i - 1]) / seg
            } else {
                0.0
            };
            return (i as f64 - 1.0 + f) * sample_dt;
        }
    }
    let last = *distance.last().unwrap();
    let mut k = distance.len() - 1;
    while k > 0 && distance[k - 1] >= last {
        k -= 1;
    }
    k as f64 * sample_dt
}

/// A root curve sample at `t`: translations lerped, rotations slerped (libm), clamped.
pub fn sample_root(samples: &[Transform], sample_dt: f64, t: f64) -> Transform {
    let n = samples.len();
    let x = (t / sample_dt).clamp(0.0, (n - 1) as f64);
    let k = (x.floor() as usize).min(n - 1);
    if k == n - 1 {
        return samples[k];
    }
    let f = x - k as f64;
    let (a, b) = (samples[k], samples[k + 1]);
    Transform {
        translation: a.translation.lerp(b.translation, f),
        rotation: a.rotation.nlerp(b.rotation, f),
        scale: Vec3::ONE,
    }
}

/// Motion warping reference: see `anim-rig::warp::motion_warp`. The yaw is the angle of the
/// twist of `target.r · U(t1).r⁻¹` about `up`, found as `atan2` of the rotated forward
/// projected on the ground plane (a different route from swing-twist).
#[allow(clippy::too_many_arguments)]
pub fn motion_warp(
    samples: &[Transform],
    sample_dt: f64,
    t0: f64,
    t1: f64,
    start: Transform,
    target: Transform,
    up: Vec3,
    t: f64,
) -> Transform {
    let unwarped = |t: f64| {
        let r0 = sample_root(samples, sample_dt, t0);
        let r = sample_root(samples, sample_dt, t);
        let inv = r0.rotation.conjugate();
        let rel_t = inv.rotate(r.translation - r0.translation);
        let rel_r = inv * r.rotation;
        Transform {
            translation: start.translation + start.rotation.rotate(rel_t),
            rotation: start.rotation * rel_r,
            scale: Vec3::ONE,
        }
    };
    let u = unwarped(t);
    let s = ((t - t0) / (t1 - t0)).clamp(0.0, 1.0);
    let alpha = s * s * (3.0 - 2.0 * s);
    if alpha <= 0.0 {
        return u;
    }
    let end = unwarped(t1);
    let dp = target.translation - end.translation;
    let diff = target.rotation * end.rotation.conjugate();
    // A ground-plane reference vector perpendicular to up.
    let refv = if up.x.abs() < 0.57735 {
        up.cross(Vec3::X)
    } else {
        up.cross(Vec3::new(0.0, 1.0, 0.0))
    }
    .normalize_or(Vec3::X);
    let turned = diff.rotate(refv);
    let turned = turned - up.scale(turned.dot(up));
    let yaw = refv.cross(turned).dot(up).atan2(refv.dot(turned));
    Transform {
        translation: u.translation + dp.scale(alpha),
        rotation: Quat::from_axis_angle(up, yaw * alpha) * u.rotation,
        scale: Vec3::ONE,
    }
}
