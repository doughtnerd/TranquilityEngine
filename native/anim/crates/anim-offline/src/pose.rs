//! Reference area `pose`: f64 blend, additive, masked layers, local to model space, root motion,
//! mirroring and inertialization, the reference for `anim-pose`.
//!
//! Plain `Vec<Transform>` poses (one entry per bone, no SoA, no padding), the textbook formulas,
//! and where possible a different route than `anim-pose`:
//!
//! - blends accumulate in f64 with normalised weights (the same nlerp definition, since the
//!   SIMD path blends with nlerp by design, but written per bone with `Quat::nlerp`);
//! - mirroring reflects through the *axis-angle* (axis reflected as a pseudo-vector), where the
//!   fast path flips quaternion components;
//! - yaw extraction goes through `atan2` and `from_axis_angle`, where the fast path projects
//!   the quaternion;
//! - the inertialization quintic is the Hermite-basis form
//!   `x0 h0(s) + v0 T h1(s) + a0 T^2 h2(s)`, where the fast path solves for `A..F`.
//!
//! Conventions as in `math`: `(x, y, z, w)` quaternions, `a * b` applies `b` first, row-major
//! 3x4 matrices. The behaviours that are *choices* (no-weight blends give `rest`, the no-overshoot
//! limit `2.5`) are repeated from `anim-pose`'s docs.

use crate::math::{local_to_model, Mat3x4, Quat, Transform, Vec3};

/// A coordinate axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    fn unit(self) -> Vec3 {
        match self {
            Axis::X => Vec3::new(1.0, 0.0, 0.0),
            Axis::Y => Vec3::new(0.0, 1.0, 0.0),
            Axis::Z => Vec3::new(0.0, 0.0, 1.0),
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

fn lerp_transform(a: Transform, b: Transform, t: f64) -> Transform {
    Transform {
        translation: a.translation.lerp(b.translation, t),
        rotation: a.rotation.nlerp(b.rotation, t),
        scale: a.scale.lerp(b.scale, t),
    }
}

/// `lerp(a, b, t)` per bone, `t` clamped to [0, 1].
pub fn lerp(a: &[Transform], b: &[Transform], t: f64) -> Vec<Transform> {
    let t = t.clamp(0.0, 1.0);
    a.iter()
        .zip(b)
        .map(|(&a, &b)| lerp_transform(a, b, t))
        .collect()
}

/// Weighted blend of poses: positive weights normalised by their sum, rotations sign-aligned to
/// `poses[0]`, summed and normalised. With no positive weight the result is `rest`.
pub fn blend(poses: &[&[Transform]], weights: &[f64], rest: &[Transform]) -> Vec<Transform> {
    let w: Vec<f64> = weights.iter().map(|&w| w.max(0.0)).collect();
    let total: f64 = w.iter().sum();
    if total <= 1e-12 {
        return rest.to_vec();
    }
    (0..rest.len())
        .map(|i| {
            let mut t = Vec3::ZERO;
            let mut s = Vec3::ZERO;
            let mut q = Quat::new(0.0, 0.0, 0.0, 0.0);
            let reference = poses[0][i].rotation;
            for (k, pose) in poses.iter().enumerate() {
                if w[k] <= 0.0 {
                    continue;
                }
                let f = w[k] / total;
                let p = pose[i];
                t = t + p.translation.scale(f);
                s = s + p.scale.scale(f);
                let r = if reference.dot(p.rotation) < 0.0 {
                    -p.rotation
                } else {
                    p.rotation
                };
                q = q + r.scale(f);
            }
            Transform {
                translation: t,
                rotation: q.normalize_or_identity(),
                scale: s,
            }
        })
        .collect()
}

/// Layered blend: `lerp(base, layer, clamp(mask[i] * weight))` per bone; `mask` has one entry per
/// bone (no padding).
pub fn blend_masked(
    base: &[Transform],
    layer: &[Transform],
    mask: &[f64],
    weight: f64,
) -> Vec<Transform> {
    let w = weight.clamp(0.0, 1.0);
    (0..base.len())
        .map(|i| {
            let t = (mask[i] * w).clamp(0.0, 1.0);
            if t > 0.0 {
                lerp_transform(base[i], layer[i], t)
            } else {
                base[i]
            }
        })
        .collect()
}

/// The additive delta of `pose` from `reference`: translation `p - r`, rotation `r⁻¹ p`, scale
/// `p / r` (1 where `|r| <= 1e-8`).
pub fn make_additive(pose: &[Transform], reference: &[Transform]) -> Vec<Transform> {
    let ratio = |p: f64, r: f64| if r.abs() > 1e-8 { p / r } else { 1.0 };
    pose.iter()
        .zip(reference)
        .map(|(p, r)| Transform {
            translation: p.translation - r.translation,
            rotation: r.rotation.conjugate() * p.rotation,
            scale: Vec3::new(
                ratio(p.scale.x, r.scale.x),
                ratio(p.scale.y, r.scale.y),
                ratio(p.scale.z, r.scale.z),
            ),
        })
        .collect()
}

fn apply_one(b: Transform, d: Transform, w: f64) -> Transform {
    let part = Quat::IDENTITY.nlerp(d.rotation, w);
    let s = |base: f64, ds: f64| base * (1.0 + (ds - 1.0) * w);
    Transform {
        translation: b.translation + d.translation.scale(w),
        rotation: b.rotation * part,
        scale: Vec3::new(
            s(b.scale.x, d.scale.x),
            s(b.scale.y, d.scale.y),
            s(b.scale.z, d.scale.z),
        ),
    }
}

/// `base` plus the additive `delta` with weight `weight`.
pub fn apply_additive(base: &[Transform], delta: &[Transform], weight: f64) -> Vec<Transform> {
    base.iter()
        .zip(delta)
        .map(|(&b, &d)| apply_one(b, d, weight))
        .collect()
}

/// [`apply_additive`] with the per-bone weight `mask[i] * weight`.
pub fn apply_additive_masked(
    base: &[Transform],
    delta: &[Transform],
    mask: &[f64],
    weight: f64,
) -> Vec<Transform> {
    (0..base.len())
        .map(|i| apply_one(base[i], delta[i], mask[i] * weight))
        .collect()
}

/// Reflects one local transform across the plane through the origin with normal `axis`: the
/// translation by the reflection matrix `I - 2nnᵀ`, the rotation by reflecting its axis as a
/// pseudo-vector (`axis' = -(I - 2nnᵀ) axis`, same angle), scale unchanged.
pub fn mirror_transform(t: Transform, axis: Axis) -> Transform {
    let n = axis.unit();
    let reflect = |v: Vec3| v - n.scale(2.0 * v.dot(n));
    let (a, angle) = t.rotation.to_axis_angle();
    Transform {
        translation: reflect(t.translation),
        rotation: Quat::from_axis_angle(-reflect(a), angle),
        scale: t.scale,
    }
}

/// `out[i] = mirror(pose[partner[i]])`; a partner out of range counts as `i`.
pub fn mirror(pose: &[Transform], partner: &[u16], axis: Axis) -> Vec<Transform> {
    let n = partner.len();
    (0..n)
        .map(|i| {
            let p = partner[i] as usize;
            mirror_transform(pose[if p < n { p } else { i }], axis)
        })
        .collect()
}

/// Local to model space.
pub fn model_space(parents: &[u16], local: &[Transform]) -> Vec<Transform> {
    local_to_model(parents, local)
}

/// The exact affine inverse of each bind-pose model transform (identity when singular).
pub fn inverse_bind_matrices(bind_model: &[Transform]) -> Vec<Mat3x4> {
    bind_model
        .iter()
        .map(|&t| {
            Mat3x4::from_transform(t)
                .inverse()
                .unwrap_or(Mat3x4::IDENTITY)
        })
        .collect()
}

/// Skinning matrices `from_transform(model[i]) * inverse_bind[i]`.
pub fn skinning_matrices(
    parents: &[u16],
    local: &[Transform],
    inverse_bind: &[Mat3x4],
) -> Vec<Mat3x4> {
    local_to_model(parents, local)
        .iter()
        .zip(inverse_bind)
        .map(|(&m, &ib)| Mat3x4::from_transform(m) * ib)
        .collect()
}

/// How much of the root's rotation is root motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootRotation {
    None,
    Yaw,
    Full,
}

/// Which root components are root motion.
#[derive(Clone, Copy, Debug)]
pub struct RootMotionAxes {
    pub translate: [bool; 3],
    pub rotation: RootRotation,
}

/// The root's movement in its parent space.
#[derive(Clone, Copy, Debug)]
pub struct RootDelta {
    pub translation: Vec3,
    pub rotation: Quat,
}

/// The yaw (rotation about `up`) of a rotation, through `atan2` of the twist components, as a
/// rotation. `q` and `-q` give the same result.
fn yaw_of(q: Quat, up: Axis) -> Quat {
    let (w, c) = if q.w < 0.0 {
        (-q.w, -[q.x, q.y, q.z][up.index()])
    } else {
        (q.w, [q.x, q.y, q.z][up.index()])
    };
    Quat::from_axis_angle(up.unit(), 2.0 * c.atan2(w))
}

/// Root movement from `from` to `to`: translation difference of the flagged axes, rotation
/// `to * from⁻¹` (all, its yaw about `up`, or none).
pub fn root_delta(from: Transform, to: Transform, axes: RootMotionAxes, up: Axis) -> RootDelta {
    let d = to.translation - from.translation;
    let pick = |i: usize, v: f64| if axes.translate[i] { v } else { 0.0 };
    let dq = to.rotation * from.rotation.conjugate();
    let rotation = match axes.rotation {
        RootRotation::None => Quat::IDENTITY,
        RootRotation::Full => {
            if dq.w < 0.0 {
                -dq
            } else {
                dq
            }
        }
        RootRotation::Yaw => yaw_of(dq, up),
    };
    RootDelta {
        translation: Vec3::new(pick(0, d.x), pick(1, d.y), pick(2, d.z)),
        rotation,
    }
}

/// `t` with the flagged root-motion components reset to `reference`'s (yaw: the yaw of
/// `t.r * reference.r⁻¹` removed from the left).
pub fn bake_out_root(
    t: Transform,
    reference: Transform,
    axes: RootMotionAxes,
    up: Axis,
) -> Transform {
    let pick = |i: usize, own: f64, r: f64| if axes.translate[i] { r } else { own };
    let rotation = match axes.rotation {
        RootRotation::None => t.rotation,
        RootRotation::Full => reference.rotation,
        RootRotation::Yaw => {
            let yaw = yaw_of(t.rotation * reference.rotation.conjugate(), up);
            (yaw.conjugate() * t.rotation).normalize_or_identity()
        }
    };
    Transform {
        translation: Vec3::new(
            pick(0, t.translation.x, reference.translation.x),
            pick(1, t.translation.y, reference.translation.y),
            pick(2, t.translation.z, reference.translation.z),
        ),
        rotation,
        scale: t.scale,
    }
}

/// A transition shorter than this is a cut.
pub const MIN_BLEND_TIME: f64 = 1e-4;
/// `|v0| T / |x0|` above this overshoots (the exact bound is 2.50087; see `anim-pose`).
pub const NO_OVERSHOOT_K: f64 = 2.5;

/// The inertialization quintic in Hermite form: `x(t) = x0 h0(s) + v0 T h1(s) + a0 T² h2(s)` with
/// `s = t / T` and the quintic Hermite basis for zero end conditions,
/// `h0 = 1 - 10s³ + 15s⁴ - 6s⁵`, `h1 = s - 6s³ + 8s⁴ - 3s⁵`,
/// `h2 = s²/2 - 3s³/2 + 3s⁴/2 - s⁵/2`.
#[derive(Clone, Copy, Debug)]
pub struct Quintic {
    pub x0: f64,
    pub v0: f64,
    pub a0: f64,
    /// Zero (and a zero curve) when the duration is below [`MIN_BLEND_TIME`].
    pub duration: f64,
}

impl Quintic {
    pub fn new(x0: f64, v0: f64, a0: f64, duration: f64) -> Self {
        if duration >= MIN_BLEND_TIME {
            Self {
                x0,
                v0,
                a0,
                duration,
            }
        } else {
            Self {
                x0: 0.0,
                v0: 0.0,
                a0: 0.0,
                duration: 0.0,
            }
        }
    }

    pub fn eval(&self, t: f64) -> f64 {
        if t >= self.duration {
            return 0.0;
        }
        let t = t.max(0.0);
        let big_t = self.duration;
        let s = t / big_t;
        let (s2, s3, s4, s5) = (s * s, s * s * s, s.powi(4), s.powi(5));
        let h0 = 1.0 - 10.0 * s3 + 15.0 * s4 - 6.0 * s5;
        let h1 = s - 6.0 * s3 + 8.0 * s4 - 3.0 * s5;
        let h2 = 0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5;
        self.x0 * h0 + self.v0 * big_t * h1 + self.a0 * big_t * big_t * h2
    }
}

/// `min(T, 2.5 |x0| / |v0|)` when `v0` heads toward zero, else `T`.
pub fn clamp_blend_time(x0: f64, v0: f64, blend_time: f64) -> f64 {
    if x0 * v0 < 0.0 {
        (NO_OVERSHOOT_K * x0.abs() / v0.abs()).min(blend_time)
    } else {
        blend_time
    }
}

/// One bone's captured inertialization offsets.
#[derive(Clone, Copy, Debug)]
pub struct BoneOffset {
    pub pos_dir: Vec3,
    pub pos: Quintic,
    pub rot_axis: Vec3,
    pub rot: Quintic,
}

fn decompose(x0: Vec3, v0: Vec3) -> (Vec3, f64, f64) {
    let len = x0.length();
    if len > 1e-9 {
        let dir = x0.scale(1.0 / len);
        return (dir, len, v0.dot(dir));
    }
    let vlen = v0.length();
    if vlen > 1e-9 {
        return (v0.scale(1.0 / vlen), 0.0, vlen);
    }
    (Vec3::X, 0.0, 0.0)
}

fn rotation_vector(q: Quat) -> Vec3 {
    let (axis, angle) = q.to_axis_angle();
    axis.scale(angle)
}

/// Captures the offsets at a switch: `prev` and `prev_prev` the last two output poses `dt` apart,
/// `new_pose` the new animation now, `new_prev` (optional) the new animation `dt` earlier
/// (otherwise its velocity is zero). `None` when `blend_time` is below [`MIN_BLEND_TIME`].
pub fn inertialize_begin(
    prev: &[Transform],
    prev_prev: &[Transform],
    new_pose: &[Transform],
    new_prev: Option<&[Transform]>,
    dt: f64,
    blend_time: f64,
) -> Option<Vec<BoneOffset>> {
    if blend_time < MIN_BLEND_TIME {
        return None;
    }
    let inv_dt = if dt > 0.0 { 1.0 / dt } else { 0.0 };
    Some(
        (0..prev.len())
            .map(|i| {
                let (p, pp, n) = (prev[i], prev_prev[i], new_pose[i]);
                let np = new_prev.map(|v| v[i]);
                let v_old = (p.translation - pp.translation).scale(inv_dt);
                let v_new = np.map_or(Vec3::ZERO, |q| {
                    (n.translation - q.translation).scale(inv_dt)
                });
                let (pos_dir, px, pv) = decompose(p.translation - n.translation, v_old - v_new);
                let w_old = rotation_vector(p.rotation * pp.rotation.conjugate()).scale(inv_dt);
                let w_new = np.map_or(Vec3::ZERO, |q| {
                    rotation_vector(n.rotation * q.rotation.conjugate()).scale(inv_dt)
                });
                let (rot_axis, rx, rv) = decompose(
                    rotation_vector(p.rotation * n.rotation.conjugate()),
                    w_old - w_new,
                );
                BoneOffset {
                    pos_dir,
                    pos: Quintic::new(px, pv, 0.0, clamp_blend_time(px, pv, blend_time)),
                    rot_axis,
                    rot: Quintic::new(rx, rv, 0.0, clamp_blend_time(rx, rv, blend_time)),
                }
            })
            .collect(),
    )
}

/// The new animation's pose with the offsets added at time `t` since the switch.
pub fn inertialize_apply(offsets: &[BoneOffset], t: f64, new_pose: &[Transform]) -> Vec<Transform> {
    new_pose
        .iter()
        .zip(offsets)
        .map(|(&n, o)| {
            let x = o.pos.eval(t);
            let angle = o.rot.eval(t);
            Transform {
                translation: n.translation + o.pos_dir.scale(x),
                rotation: (Quat::from_axis_angle(o.rot_axis, angle) * n.rotation)
                    .normalize_or_identity(),
                scale: n.scale,
            }
        })
        .collect()
}
