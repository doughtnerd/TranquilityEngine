//! Copy, limit and damp constraints on single bones.

use crate::geom::{exp_neg, fmax, fmin, normalize_or, unit_clamp};
use crate::limit::JointLimit;
use crate::pose::{blend_vec, RigPose};
use anim_math::{AosQuat, AosVec3};

/// The space a constraint reads and writes in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Space {
    /// The bones' local transforms (relative to their parents).
    #[default]
    Local,
    /// Model space (the character's space).
    Model,
}

/// Copy transform: the target bone takes the source bone's position, rotation and scale, each
/// with its own weight and offset (Unity's Multi-Parent / Override, Unreal's Copy Bone).
#[derive(Clone, Copy, Debug)]
pub struct CopyTransform {
    pub source: u16,
    pub target: u16,
    pub space: Space,
    /// Per channel, in `[0, 1]`.
    pub position_weight: f32,
    pub rotation_weight: f32,
    pub scale_weight: f32,
    /// Added to the copied position, in the source's frame: local `src.t + offset`, model
    /// `src.t + src.r·offset`.
    pub position_offset: AosVec3,
    /// Applied after the copied rotation: `src.r · offset`.
    pub rotation_offset: AosQuat,
    /// Multiplies the copied scale component-wise.
    pub scale_offset: AosVec3,
    /// The entry weight in `[0, 1]` (multiplies the channel weights).
    pub weight: f32,
}

impl CopyTransform {
    /// Copies everything, local space, no offsets, weight 1.
    pub fn new(source: u16, target: u16) -> Self {
        Self {
            source,
            target,
            space: Space::Local,
            position_weight: 1.0,
            rotation_weight: 1.0,
            scale_weight: 1.0,
            position_offset: AosVec3::zero(),
            rotation_offset: AosQuat::identity(),
            scale_offset: AosVec3::one(),
            weight: 1.0,
        }
    }
}

/// Applies a [`CopyTransform`] constraint. In model space the copied scale is converted to the target's
/// local scale by dividing by its parent's model scale (TRS, no shear). Never allocates.
pub fn copy(pose: &mut RigPose, c: &CopyTransform) {
    let (s, t) = (c.source as usize, c.target as usize);
    let w = unit_clamp(c.weight);
    match c.space {
        Space::Local => {
            let src = pose.local(s);
            let mut cur = pose.local(t);
            cur.translation = blend_vec(
                cur.translation,
                src.translation + c.position_offset,
                c.position_weight * w,
            );
            cur.rotation = crate::pose::blend_rotation(
                cur.rotation,
                (src.rotation * c.rotation_offset).normalize_or_identity(),
                c.rotation_weight * w,
            );
            cur.scale = blend_vec(cur.scale, src.scale * c.scale_offset, c.scale_weight * w);
            pose.set_local(t, cur);
        }
        Space::Model => {
            let src = pose.model(s);
            let rot = (src.rotation * c.rotation_offset).normalize_or_identity();
            let pos = src.translation + src.rotation.rotate(c.position_offset);
            let scale = src.scale * c.scale_offset;
            pose.blend_model_translation(t, pos, c.position_weight * w);
            pose.blend_model_rotation(t, rot, c.rotation_weight * w);
            if c.scale_weight * w > 0.0 {
                let ps = pose.parent_model(t).scale;
                let rcp = |v: f32| {
                    if v.abs() > anim_math::SCALE_EPSILON {
                        1.0 / v
                    } else {
                        0.0
                    }
                };
                let local_scale = AosVec3::new(
                    scale.x * rcp(ps.x),
                    scale.y * rcp(ps.y),
                    scale.z * rcp(ps.z),
                );
                let mut cur = pose.local(t);
                cur.scale = blend_vec(cur.scale, local_scale, c.scale_weight * w);
                pose.set_local(t, cur);
            }
        }
    }
}

/// Limits a bone's local rotation ([`JointLimit`]: swing cone and twist range relative to the
/// rest rotation), blended by `weight`.
pub fn limit_rotation(pose: &mut RigPose, bone: u16, limit: &JointLimit, weight: f32) {
    let b = bone as usize;
    let local = pose.local(b).rotation;
    if let Some(limited) = limit.limit(local) {
        pose.blend_local_rotation(b, limited, weight);
    }
}

/// A position region.
#[derive(Clone, Copy, Debug)]
pub enum PositionLimit {
    /// Each component clamped to `[min, max]`.
    Box { min: AosVec3, max: AosVec3 },
    /// Within `radius` of `center` (projected radially onto the sphere when outside).
    Sphere { center: AosVec3, radius: f32 },
}

impl PositionLimit {
    /// `p` moved into the region.
    pub fn clamp(&self, p: AosVec3) -> AosVec3 {
        match *self {
            PositionLimit::Box { min, max } => AosVec3::new(
                fmin(fmax(p.x, min.x), max.x),
                fmin(fmax(p.y, min.y), max.y),
                fmin(fmax(p.z, min.z), max.z),
            ),
            PositionLimit::Sphere { center, radius } => {
                let d = p - center;
                let r = fmax(radius, 0.0);
                if d.length_squared() <= r * r {
                    p
                } else {
                    center + normalize_or(d, AosVec3::zero()).scale(r)
                }
            }
        }
    }
}

/// Limits a bone's position (its local translation, or its model-space position) to a region,
/// blended by `weight`.
pub fn limit_position(
    pose: &mut RigPose,
    bone: u16,
    limit: &PositionLimit,
    space: Space,
    weight: f32,
) {
    let b = bone as usize;
    match space {
        Space::Local => {
            let t = pose.local(b).translation;
            pose.blend_local_translation(b, limit.clamp(t), weight);
        }
        Space::Model => {
            let p = pose.model(b).translation;
            pose.blend_model_translation(b, limit.clamp(p), weight);
        }
    }
}

/// One damped bone's state: a critically damped spring on its model-space position and
/// rotation (fixed size).
#[derive(Clone, Copy, Debug)]
pub struct DampState {
    position: AosVec3,
    velocity: AosVec3,
    rotation: AosQuat,
    /// Scaled-angle-axis angular velocity, rad/s.
    angular_velocity: AosVec3,
    initialized: bool,
}

impl DampState {
    pub const fn new() -> Self {
        let z = AosVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        Self {
            position: z,
            velocity: z,
            rotation: AosQuat {
                x: 0.0,
                y: 0.0,
                z: 0.0,
                w: 1.0,
            },
            angular_velocity: z,
            initialized: false,
        }
    }

    /// Forgets the history: the next update snaps to the bone.
    pub fn reset(&mut self) {
        self.initialized = false;
    }
}

impl Default for DampState {
    fn default() -> Self {
        Self::new()
    }
}

/// The damp settings.
#[derive(Clone, Copy, Debug)]
pub struct Damp {
    pub bone: u16,
    /// Seconds for half the remaining gap to close (0 or less: no damping).
    pub position_half_life: f32,
    pub rotation_half_life: f32,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

/// `log` of a unit quaternion as a scaled axis: `axis · angle` (angle in `[0, π]`).
fn quat_log(q: AosQuat) -> AosVec3 {
    let (axis, angle) = q.to_axis_angle();
    axis.scale(angle)
}

/// The inverse of [`quat_log`].
fn quat_exp(v: AosVec3) -> AosQuat {
    let a = v.length();
    if a <= 1e-12 {
        return AosQuat::identity();
    }
    AosQuat::from_axis_angle(v.scale(1.0 / a), a)
}

/// Damped follow: the bone's model-space position and rotation trail the animated ones as a
/// critically damped spring with the given half-lives (a backpack, a lagging prop).
///
/// # Maths
///
/// Daniel Holden's exact critically damped spring: with `y = 2·ln 2 / half_life`,
/// `j₀ = x − goal`, `j₁ = v + j₀·y` and `e = e^(−y·dt)` ([`exp_neg`]):
/// `x' = e·(j₀ + j₁·dt) + goal`, `v' = e·(v − j₁·y·dt)`. It never overshoots, is exact for any
/// `dt` (frame-rate independent), and halves an initial gap with zero velocity in about one
/// half-life (with velocity it is slightly slower: `(1 + y·t)e^(−y·t)`). Rotations use the same
/// spring on the scaled-angle-axis `log(q·goal⁻¹)` with an angular velocity. The first update
/// after a reset snaps.
pub fn damp(pose: &mut RigPose, d: &Damp, state: &mut DampState, dt: f32) {
    let b = d.bone as usize;
    let goal = pose.model(b);
    if !state.initialized {
        state.position = goal.translation;
        state.rotation = goal.rotation;
        state.velocity = AosVec3::zero();
        state.angular_velocity = AosVec3::zero();
        state.initialized = true;
    } else if dt > 0.0 {
        if d.position_half_life > 0.0 {
            let y = 2.0 * core::f32::consts::LN_2 / d.position_half_life;
            let e = exp_neg(y * dt);
            let j0 = state.position - goal.translation;
            let j1 = state.velocity + j0.scale(y);
            state.position = (j0 + j1.scale(dt)).scale(e) + goal.translation;
            state.velocity = (state.velocity - j1.scale(y * dt)).scale(e);
        } else {
            state.position = goal.translation;
            state.velocity = AosVec3::zero();
        }
        if d.rotation_half_life > 0.0 {
            let y = 2.0 * core::f32::consts::LN_2 / d.rotation_half_life;
            let e = exp_neg(y * dt);
            let g = goal.rotation;
            let diff = (state.rotation * g.conjugate()).normalize_or_identity();
            let j0 = quat_log(diff);
            let j1 = state.angular_velocity + j0.scale(y);
            state.rotation = (quat_exp((j0 + j1.scale(dt)).scale(e)) * g).normalize_or_identity();
            state.angular_velocity = (state.angular_velocity - j1.scale(y * dt)).scale(e);
        } else {
            state.rotation = goal.rotation;
            state.angular_velocity = AosVec3::zero();
        }
    }
    let w = d.weight;
    pose.blend_model_translation(b, state.position, w);
    pose.blend_model_rotation(b, state.rotation, w);
}
