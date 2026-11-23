//! Look-at and aim over a chain of bones (spine, neck, head; or spine, arm, weapon).

use crate::geom::{
    angle_between, clamp_angle, clamp_cone, fmin, fraction, from_to, normalize_or, DEGENERATE_SQ,
};
use crate::pose::{gather, rotate_from, write_chain, ChainJoint, RigPose};
use anim_math::trig::atan2;
use anim_math::{AosQuat, AosVec3};

/// A bone's aim axes, in its local frame.
#[derive(Clone, Copy, Debug)]
pub struct AimAxes {
    /// The axis that points at the target (unit).
    pub forward: AosVec3,
    /// The axis kept toward [`AimGoal::up`] (unit, not parallel to `forward`).
    pub up: AosVec3,
}

impl Default for AimAxes {
    /// Forward +Z, up +Y.
    fn default() -> Self {
        Self {
            forward: AosVec3::new(0.0, 0.0, 1.0),
            up: AosVec3::new(0.0, 1.0, 0.0),
        }
    }
}

/// One joint that turns in a look-at or aim.
#[derive(Clone, Copy, Debug)]
pub struct AimJoint {
    pub bone: u16,
    /// The share of the remaining turn this joint takes, in `[0, 1]` (see [`look_at`]).
    pub weight: f32,
    /// The most this joint may turn, radians (π or more: free).
    pub limit: f32,
    /// This bone's axes (used by [`look_at`]; [`aim`] uses the aim bone's).
    pub axes: AimAxes,
}

/// A look-at or aim goal.
#[derive(Clone, Copy, Debug)]
pub struct AimGoal {
    /// The model-space point to look at or aim at.
    pub target: AosVec3,
    /// The model-space direction each bone's up axis is kept toward (unit; zero disables).
    pub up: AosVec3,
    /// How much of the up alignment to apply, in `[0, 1]`.
    pub up_weight: f32,
    /// The target direction is clamped to a cone of this half-angle around the final bone's
    /// animated forward (radians; π or more: no clamp). Final IK's clamp.
    pub max_angle: f32,
    /// Aim iterations ([`aim`] only; [`look_at`] needs one pass).
    pub iterations: u32,
    /// The entry weight in `[0, 1]`.
    pub weight: f32,
}

impl AimGoal {
    /// No up alignment, no clamp, 4 iterations, weight 1.
    pub fn new(target: AosVec3) -> Self {
        Self {
            target,
            up: AosVec3::zero(),
            up_weight: 0.0,
            max_angle: core::f32::consts::PI,
            iterations: 4,
            weight: 1.0,
        }
    }
}

fn check(joints: &[AimJoint], scratch: &[ChainJoint], extra: usize) {
    assert!(!joints.is_empty(), "no aim joints");
    assert!(
        scratch.len() >= joints.len() + extra,
        "aim scratch too short"
    );
}

/// The target moved onto the clamp cone seen from `origin` around `forward`.
fn clamped_target(goal: &AimGoal, origin: AosVec3, forward: AosVec3) -> AosVec3 {
    let to_t = goal.target - origin;
    let dist = to_t.length();
    if dist <= 1e-6 {
        return goal.target;
    }
    let dir = clamp_cone(to_t.scale(1.0 / dist), forward, goal.max_angle);
    origin + dir.scale(dist)
}

/// The twist about unit `fwd` that brings `up_now` toward `up_goal` (both projected off `fwd`),
/// scaled by `w`.
fn up_twist(fwd: AosVec3, up_now: AosVec3, up_goal: AosVec3, w: f32) -> AosQuat {
    let a = up_now - fwd.scale(up_now.dot(fwd));
    let b = up_goal - fwd.scale(up_goal.dot(fwd));
    if !(w > 0.0) || a.length_squared() <= DEGENERATE_SQ || b.length_squared() <= DEGENERATE_SQ {
        return AosQuat::identity();
    }
    let angle = atan2(a.cross(b).dot(fwd), a.dot(b));
    AosQuat::from_axis_angle(fwd, angle * fmin(w, 1.0))
}

/// Look-at: every joint turns its own forward axis toward the target, taking its share of what
/// remains.
///
/// `joints` run from the chain's root (lower spine) to its end (head, eyes); each bone must be a
/// descendant of the one before.
///
/// # Algorithm
///
/// 1. The target is clamped to the cone of `max_angle` around the last joint's animated forward,
///    as seen from the last joint ([`clamp_cone`]).
/// 2. For each joint `j` in order, with its current forward `fⱼ = Rⱼ·forwardⱼ` and the
///    direction `dⱼ` from its position to the target, the full turn is `qⱼ = from_to(fⱼ, dⱼ)`.
///    The joint takes `fraction(qⱼ, weightⱼ)` (a slerp from identity, so the share is exact in
///    angle), clamped to `limitⱼ`, then twists about its new forward so its up axis moves toward
///    `goal.up` by `up_weight·weightⱼ`. Joints below turn with it.
///
/// Joints after `j` see the turn already taken, so with weights `w₁, w₂, …` and a target far away
/// the shares are `w₁θ`, `w₂(1 − w₁)θ`, …; a last weight of 1 (and no limit hit) points the last
/// joint exactly at the target. Locals are written once, blended by `goal.weight`. Never
/// allocates.
pub fn look_at(
    pose: &mut RigPose,
    joints: &[AimJoint],
    goal: &AimGoal,
    scratch: &mut [ChainJoint],
) -> AosVec3 {
    check(joints, scratch, 0);
    let n = joints.len();
    let at = |j: usize| joints[j].bone as usize;
    gather(pose, n, at, scratch);
    let c = &mut scratch[..n];
    let last_fwd = c[n - 1].rotation.rotate(joints[n - 1].axes.forward);
    let target = clamped_target(goal, c[n - 1].position, last_fwd);
    for j in 0..n {
        let fwd = c[j].rotation.rotate(joints[j].axes.forward);
        let to_t = target - c[j].position;
        if to_t.length_squared() <= DEGENERATE_SQ {
            continue;
        }
        let dir = to_t.scale(1.0 / to_t.length());
        let q = fraction(from_to(normalize_or(fwd, dir), dir), joints[j].weight);
        let q = clamp_angle(q, joints[j].limit);
        rotate_from(c, n, j, q);
        if goal.up_weight > 0.0 && goal.up.length_squared() > DEGENERATE_SQ {
            let f = normalize_or(c[j].rotation.rotate(joints[j].axes.forward), dir);
            let u = c[j].rotation.rotate(joints[j].axes.up);
            let tw = up_twist(f, u, goal.up, goal.up_weight * joints[j].weight);
            rotate_from(c, n, j, tw);
        }
    }
    write_chain(pose, c, n, at, goal.weight);
    target
}

/// Aim: the joints turn so that the aim bone's forward axis (a weapon, a hand, a camera bone)
/// points at the target from the aim bone's own position.
///
/// `aim_bone` must be a descendant of (or equal to) the last joint. `scratch` needs
/// `joints.len() + 1` entries.
///
/// # Algorithm
///
/// Final IK's AimIK: each iteration visits the joints in order. At joint `j` the aim ray is
/// origin `o` (the aim bone's position) and direction `f` (its forward); the full turn is
/// `from_to(f, normalize(t − o))`, of which the joint takes `fraction(·, weightⱼ)` clamped to
/// `limitⱼ`, turning about its own position (which moves `o`). Iterating removes the error that
/// moving `o` leaves. The target is clamped once, from the aim bone, as in [`look_at`]. The up
/// alignment twists the last joint about the aim axis at the end, so the aim bone's up axis
/// moves toward `goal.up`. Locals are written once, blended by `goal.weight`. Returns the angle in radians
/// between the aim axis and the direction to the (clamped) target, at full weight.
pub fn aim(
    pose: &mut RigPose,
    joints: &[AimJoint],
    aim_bone: u16,
    axes: AimAxes,
    goal: &AimGoal,
    scratch: &mut [ChainJoint],
) -> f32 {
    check(joints, scratch, 1);
    let n = joints.len();
    let at = |j: usize| {
        if j < n {
            joints[j].bone as usize
        } else {
            aim_bone as usize
        }
    };
    gather(pose, n + 1, at, scratch);
    let c = &mut scratch[..n + 1];
    let fwd0 = c[n].rotation.rotate(axes.forward);
    let target = clamped_target(goal, c[n].position, fwd0);
    let error = |c: &[ChainJoint]| {
        let f = c[n].rotation.rotate(axes.forward);
        angle_between(f, target - c[n].position)
    };
    for _ in 0..goal.iterations.max(1) {
        for j in 0..n {
            let f = c[n].rotation.rotate(axes.forward);
            let to_t = target - c[n].position;
            if to_t.length_squared() <= DEGENERATE_SQ || f.length_squared() <= DEGENERATE_SQ {
                continue;
            }
            let dir = to_t.scale(1.0 / to_t.length());
            let q = fraction(from_to(normalize_or(f, dir), dir), joints[j].weight);
            let q = clamp_angle(q, joints[j].limit);
            rotate_from(c, n + 1, j, q);
        }
    }
    if goal.up_weight > 0.0 && goal.up.length_squared() > DEGENERATE_SQ {
        let f = normalize_or(c[n].rotation.rotate(axes.forward), AosVec3::zero());
        let u = c[n].rotation.rotate(axes.up);
        let tw = up_twist(f, u, goal.up, goal.up_weight);
        // Twist the last joint about the aim axis (through its own position): the aim direction
        // is unchanged; the aim origin moves only if it sits off the joint's aim line.
        rotate_from(c, n + 1, n - 1, tw);
    }
    let err = error(c);
    write_chain(pose, c, n, at, goal.weight);
    err
}
