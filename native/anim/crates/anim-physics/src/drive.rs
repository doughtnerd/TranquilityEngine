//! Drive targets: from the animated local pose (and the one before it) to each body's motor target.
//!
//! For a body `b` with parent body `p`, the **target rotation** is `B_p⁻¹ · B_b`: the rotation of
//! `b`'s body frame relative to `p`'s, from the animated pose's body frames (so with identity
//! joint frames and a body on every bone it is the animated local rotation). The ragdoll plugin
//! turns it into the joint's `drive.targetRotation` with the joint's rest frames (ADR 0375). A
//! root body's target is its animated body rotation in model space, and its animated body pose
//! is its **pin target**.
//!
//! The **target angular velocity** is the rotation from the previous step's target to this one
//! over `dt` (axis × angle / dt, in the parent body's frame; a root body's in model space), zero
//! without a previous pose or a positive `dt`. **Strengths**: the bone's stiffness, damping and
//! maximum force times `strength_global · bone.strength · multiplier[b]`; the pin weight is
//! `pin_global · bone.pin`.
//!
//! Each output also carries the bone's animated body pose (spawning bodies where the animation is,
//! and pinning). Deterministic (`anim-math` operations only, its polynomial `atan2`); never
//! allocates.

use crate::desc::{Ragdoll, NO_BONE};
use crate::pose::{body_from_bone, BodyPose};
use anim_math::layout::{local_to_model, soa_len};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};

/// [`Drive::flags`]: the bone has a body (the other fields are meaningful).
pub const DRIVE_BODY: u32 = 1;
/// [`Drive::flags`]: a root body (no parent body): its target is in model space and it is pinned.
pub const DRIVE_ROOT: u32 = 2;
/// [`Drive::flags`]: the angular velocity came from two poses (else it is zero).
pub const DRIVE_VELOCITY: u32 = 4;

/// One bone's drive target.
#[derive(Clone, Copy, Debug)]
pub struct Drive {
    pub flags: u32,
    /// The parent body's bone, or [`NO_BONE`].
    pub parent_body: u16,
    pub target: AosQuat,
    pub angular_velocity: AosVec3,
    pub stiffness: f32,
    pub damping: f32,
    pub max_force: f32,
    pub pin: f32,
    /// The animated body pose (model space).
    pub body: BodyPose,
}

impl Default for Drive {
    fn default() -> Self {
        Drive {
            flags: 0,
            parent_body: NO_BONE,
            target: AosQuat::identity(),
            angular_velocity: AosVec3::zero(),
            stiffness: 0.0,
            damping: 0.0,
            max_force: 0.0,
            pin: 0.0,
            body: BodyPose::default(),
        }
    }
}

/// One step's inputs.
#[derive(Clone, Copy, Debug)]
pub struct DriveInput<'a> {
    /// The animated local pose (SoA, `soa_len(bones)` groups).
    pub now: &'a [SoaTransform],
    /// The animated pose of the previous step, if any.
    pub prev: Option<&'a [SoaTransform]>,
    /// Seconds between `prev` and `now`.
    pub dt: f32,
    /// The global muscle strength (scales every bone's drive).
    pub strength: f32,
    /// The global pin weight.
    pub pin: f32,
    /// Per-bone strength multipliers (missing entries are 1).
    pub multipliers: &'a [f32],
}

/// Why a step wasn't computed (the output is untouched).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriveError {
    /// A pose isn't `soa_len(bones)` groups.
    PoseLength,
    /// The output or the scratch isn't sized for this ragdoll.
    OutLength,
}

/// Scratch for [`Ragdoll::drive`] ([`Ragdoll::scratch`]).
#[derive(Clone, Debug)]
pub struct DriveScratch {
    now: Vec<AosTransform>,
    prev: Vec<AosTransform>,
}

impl DriveScratch {
    /// Scratch for skeletons of up to `bones` bones (allocates).
    pub fn new(bones: usize) -> DriveScratch {
        DriveScratch {
            now: vec![AosTransform::identity(); bones],
            prev: vec![AosTransform::identity(); bones],
        }
    }
}

fn finite_or(v: f32, d: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        d
    }
}

/// `q` with `w ≥ 0` (the same rotation), so targets are canonical.
fn canonical(q: AosQuat) -> AosQuat {
    if q.w < 0.0 {
        -q
    } else {
        q
    }
}

impl Ragdoll {
    /// Scratch sized for this ragdoll (allocates; make it once).
    pub fn scratch(&self) -> DriveScratch {
        DriveScratch::new(self.bone_count())
    }

    /// The body frame's rotation relative to its parent body's (module docs), from model space.
    fn target(&self, model: &[AosTransform], b: usize) -> AosQuat {
        let jf = |i: usize| self.desc.bones[i].joint_frame;
        let own = body_from_bone(&model[b], jf(b)).rotation;
        let p = self.parent_body[b];
        let q = if p == NO_BONE {
            own
        } else {
            let pr = body_from_bone(&model[p as usize], jf(p as usize)).rotation;
            (pr.conjugate() * own).normalize_or_identity()
        };
        canonical(q)
    }

    /// Computes every bone's drive target into `out` (one per bone; bones without a body get
    /// [`Drive::default`]). Never allocates.
    pub fn drive(
        &self,
        input: &DriveInput<'_>,
        scratch: &mut DriveScratch,
        out: &mut [Drive],
    ) -> Result<(), DriveError> {
        let n = self.bone_count();
        let groups = soa_len(n);
        if input.now.len() != groups || input.prev.is_some_and(|p| p.len() != groups) {
            return Err(DriveError::PoseLength);
        }
        if out.len() < n || scratch.now.len() < n || scratch.prev.len() < n {
            return Err(DriveError::OutLength);
        }
        let now = &mut scratch.now[..n];
        local_to_model(&self.parents, input.now, now);
        let prev = match input.prev {
            Some(p) if input.dt > 0.0 && input.dt.is_finite() => {
                local_to_model(&self.parents, p, &mut scratch.prev[..n]);
                Some(&scratch.prev[..n])
            }
            _ => None,
        };
        let strength = finite_or(input.strength, 0.0).max(0.0);
        let pin = finite_or(input.pin, 0.0).clamp(0.0, 1.0);
        let inv_dt = if prev.is_some() { 1.0 / input.dt } else { 0.0 };
        for b in 0..n {
            let d = &self.desc.bones[b];
            if !d.body {
                out[b] = Drive::default();
                continue;
            }
            let target = self.target(now, b);
            let (flags_v, omega) = match prev {
                Some(pm) => {
                    let before = self.target(pm, b);
                    let delta = canonical((target * before.conjugate()).normalize_or_identity());
                    let (axis, angle) = delta.to_axis_angle();
                    (DRIVE_VELOCITY, axis.scale(angle * inv_dt))
                }
                None => (0, AosVec3::zero()),
            };
            let m = finite_or(input.multipliers.get(b).copied().unwrap_or(1.0), 0.0).max(0.0);
            let s = strength * d.strength * m;
            let root = self.parent_body[b] == NO_BONE;
            out[b] = Drive {
                flags: DRIVE_BODY | flags_v | if root { DRIVE_ROOT } else { 0 },
                parent_body: self.parent_body[b],
                target,
                angular_velocity: omega,
                stiffness: d.stiffness * s,
                damping: d.damping * s,
                max_force: d.max_force * s,
                pin: pin * d.pin,
                body: body_from_bone(&now[b], d.joint_frame),
            };
        }
        Ok(())
    }
}
