//! Node family `rig`: the rig stack's nodes (ADR 0342), each one rig-stack entry calling an
//! `anim-rig` solver: IK (two-bone, CCD, FABRIK, full-body), look-at and aim, the foot grounder,
//! spring chains, copy, limit and damp constraints, stride, orientation and motion warping, and
//! distance matching.
//!
//! A rig node takes one input (the pose it adjusts; a rig stack is a chain of them at the output
//! or at any point of the graph) and passes its alpha, timing and weighted walks through, so the
//! debugger lists it among the active nodes. Nodes of a kind this build doesn't know, and nodes
//! whose parameter block breaks a limit below (a chain longer than its scratch), pass their input
//! through and are counted by [`Program::unknown_nodes`](crate::eval::Program::unknown_nodes)
//! (reported once at load).
//!
//! # Inputs and outputs ([`RigInputs`])
//!
//! Per frame the host fills the instance's row of the `rig` wire family's input view: the
//! character's model-to-world transform, the rig LOD level, [`view::MAX_TARGETS`] IK target slots
//! (position, rotation, position and rotation weights, model or world space; `anim.ik(name)` maps
//! a name to a slot index the graph compiler assigns) and [`view::MAX_RAYS`] ray hits (model
//! space, decision D41). Grounders write their ray requests (model space) into the instance's row
//! of the ray output view; the host casts them and passes the hits back next frame (ADR 0340: a
//! one-frame-old hit). Joint limits come from the skeleton's `JOINT_RANGES` at load
//! (`JointLimit::from_range` against the rest rotation; free where a bone has none); roles from
//! its `ROLES` (role → bone).
//!
//! # Bone references
//!
//! A bone word is a bone index, or [`ROLE`] | a profile role index (the Humanoid profile's,
//! `anim_retarget::profile::humanoid`), resolved through the skeleton's roles, or `NONE`. A bone
//! that doesn't resolve (out of range, a role the skeleton lacks) makes the node do nothing.
//!
//! # Parameter words
//!
//! Every block starts with the [`head`] (words 0–3):
//!
//! | Word | Type | Meaning |
//! |---|---|---|
//! | 0 | f32 | weight in \[0, 1\] (absent: 1) |
//! | 1 | u32 | a float graph parameter the weight is multiplied by, or `NONE` |
//! | 2 | u32 | a curve (name string id) of the input's timing clip, sampled at its playhead, the weight is multiplied by, or `NONE` |
//! | 3 | u32 | LOD skip: the node is skipped while the instance's rig LOD level is ≥ this (0: never) |
//!
//! then its kind's words (each kind's module lists them: [`two_bone`], [`chain`] for CCD and
//! FABRIK, [`full_body`], [`aim`] for look-at and aim, [`grounder`], [`spring`], [`copy`],
//! [`limit_rotation`], [`limit_position`], [`damp`], [`stride`], [`orientation`],
//! [`motion_warp`], [`distance`]). Floats are f32 bits; an absent float word reads as the
//! solver's default (named per word), an absent `u32` word as `NONE` where `NONE` means "none"
//! and as 0 otherwise. Positions, directions and offsets are in model space unless said; angles
//! are radians except joint ranges (degrees, as `JOINT_RANGES`). An IK target slot gives the
//! goal; the solve's weight is the node's weight times the slot's position weight.
//!
//! # State (per instance, in the blob)
//!
//! Every node has the [`state`] header: the time accumulated by Update phases since its last
//! solve (Update runs every frame, Pose only when due under update-rate LOD, decision D34), and
//! flags. Kinds with history add a fixed block: the grounder's `GrounderState`, the spring
//! chain's `SpringChainState`, damp's `DampState` (each as words, `anim_rig`'s codecs), motion
//! warp's target and window. A node skipped by LOD or by weight 0, or asked to reset (the `rig`
//! family's `RIG_RESET`: teleports), forgets its history at its next solve (springs restart on the
//! animated pose). Everything is words, so snapshot and restore stay exact.
//!
//! # Scratch
//!
//! Solves run on the pose slot the node writes and the evaluation's sampling scratch (its first
//! `bones` transforms hold the model-space cache), with fixed-size stack arrays for chain joints,
//! limits and effectors whose sizes are the limits below, checked at load (Layout). Nothing
//! allocates.
//!
//! # Where distance warping lives
//!
//! [`kind::DISTANCE_MATCH`] gates its input like `mixing`'s `TIME_SCALE`, at a playback rate it
//! computes from the input's timing clip's travel curve ([`ClipRef::distance`](crate::eval::ClipRef::distance)):
//! a locomotion cycle plays at the rate that makes its root cover the character's ground speed (a
//! float parameter), or a stop plays so its stop point lands where the character will stop (the
//! distance left, a float parameter). It is a playback-rate driver above a clip player (or any
//! sub-graph), not a pose adjustment.

// `!(x > 0.0)` is deliberate: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use core::cell::Cell;

use anim_format::NONE;
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_rig::grounder::{RayHit, RayRequest};
use anim_rig::JointLimit;

use crate::dispatch::NodeStatus;
use crate::eval::{EvalContext, NodeData, Phase};
use crate::mixing;

mod solve;
mod warp;

/// The family's node kinds (append-only; stored in `myco.animgraph@1`).
pub mod kind {
    /// Analytic two-bone IK toward a target slot.
    pub const TWO_BONE_IK: u16 = 0;
    /// Cyclic coordinate descent over a chain.
    pub const CCD: u16 = 1;
    /// FABRIK over a chain.
    pub const FABRIK: u16 = 2;
    /// FABRIK over a tree of chains with effectors and a centre of mass.
    pub const FULL_BODY_IK: u16 = 3;
    /// Bones turn toward a target (spine, neck, head).
    pub const LOOK_AT: u16 = 4;
    /// Bones turn so an aim bone points at a target.
    pub const AIM: u16 = 5;
    /// Feet onto the ground from last frame's ray hits, with a pelvis offset.
    pub const GROUNDER: u16 = 6;
    /// A Verlet spring chain with colliders.
    pub const SPRING_CHAIN: u16 = 7;
    /// Copy a bone's transform onto another.
    pub const COPY: u16 = 8;
    /// Swing-twist rotation limits.
    pub const LIMIT_ROTATION: u16 = 9;
    /// A position region.
    pub const LIMIT_POSITION: u16 = 10;
    /// A bone trails its animation as a critically damped spring.
    pub const DAMP: u16 = 11;
    /// Stride warping.
    pub const STRIDE_WARP: u16 = 12;
    /// Orientation warping.
    pub const ORIENTATION_WARP: u16 = 13;
    /// Root motion bent to land on a target over a window.
    pub const MOTION_WARP: u16 = 14;
    /// The input's playback rate from root travel.
    pub const DISTANCE_MATCH: u16 = 15;
    /// The last kind.
    pub const LAST: u16 = DISTANCE_MATCH;
}

/// A bone word with this bit set names a profile role (low 16 bits) instead of a bone.
pub const ROLE: u32 = 0x8000_0000;
/// "No bone" in [`RigInputs::roles`].
pub const NO_BONE: u16 = 0xFFFF;

/// The most bones in a CCD or FABRIK chain.
pub const MAX_CHAIN: usize = 16;
/// The most bones over all chains of a full-body solve.
pub const MAX_BODY_BONES: usize = 64;
/// The most joints of a look-at or aim.
pub const MAX_AIM_JOINTS: usize = 8;
/// The most bones one `LIMIT_ROTATION` limits, and the most spine bones of an orientation warp.
pub const MAX_LIST: usize = 32;
/// The most colliders of a spring chain (`anim_rig::spring::MAX_SPRING_COLLIDERS`).
pub const MAX_COLLIDERS: usize = anim_rig::spring::MAX_SPRING_COLLIDERS;

/// The layouts of the input view's target and hit entries and the ray output view's requests
/// (words; `anim-wire`'s `rig` family gives the same layout in bytes).
pub mod view {
    /// IK target slots per instance.
    pub const MAX_TARGETS: usize = 16;
    /// Words per target slot.
    pub const TARGET_WORDS: usize = 12;
    /// Target: position (3 f32).
    pub const TARGET_POSITION: usize = 0;
    /// Target: rotation (4 f32, x y z w).
    pub const TARGET_ROTATION: usize = 3;
    /// Target: position weight in \[0, 1\] (0: the slot is off).
    pub const TARGET_POSITION_WEIGHT: usize = 7;
    /// Target: rotation weight in \[0, 1\].
    pub const TARGET_ROTATION_WEIGHT: usize = 8;
    /// Target: flags ([`TARGET_WORLD`]).
    pub const TARGET_FLAGS: usize = 9;
    /// Target flag: position and rotation are in world space (converted with the character's
    /// transform); otherwise model space.
    pub const TARGET_WORLD: u32 = 1;
    /// Ray hits and requests per instance.
    pub const MAX_RAYS: usize = 8;
    /// Words per hit.
    pub const HIT_WORDS: usize = 8;
    /// Hit: point (3 f32, model space).
    pub const HIT_POINT: usize = 0;
    /// Hit: unit normal (3 f32, model space).
    pub const HIT_NORMAL: usize = 3;
    /// Hit: flags ([`HIT_VALID`]).
    pub const HIT_FLAGS: usize = 6;
    /// Hit flag: the ray hit something (otherwise it missed).
    pub const HIT_VALID: u32 = 1;
    /// Words per ray request.
    pub const RAY_WORDS: usize = 8;
    /// Request: origin (3 f32, model space).
    pub const RAY_ORIGIN: usize = 0;
    /// Request: unit direction (3 f32, model space).
    pub const RAY_DIRECTION: usize = 3;
    /// Request: length (f32).
    pub const RAY_LENGTH: usize = 6;
    /// Request: flags ([`RAY_VALID`]).
    pub const RAY_FLAGS: usize = 7;
    /// Request flag: a grounder asked for this ray this frame.
    pub const RAY_VALID: u32 = 1;
}

/// The rig stack's per-frame inputs and outputs, and the skeleton's joint limits and roles
/// (module docs).
#[derive(Clone, Copy)]
pub struct RigInputs<'a> {
    /// The character's model-to-world transform this frame.
    pub character: AosTransform,
    /// The rig LOD level (0: full detail).
    pub lod: u32,
    /// [`view::MAX_TARGETS`] slots of [`view::TARGET_WORDS`] words (or fewer: missing slots are off).
    pub targets: &'a [u32],
    /// [`view::MAX_RAYS`] hits of [`view::HIT_WORDS`] words (missing: misses).
    pub hits: &'a [u32],
    /// [`view::MAX_RAYS`] requests of [`view::RAY_WORDS`] words, written by grounders.
    pub rays: &'a [Cell<u32>],
    /// A limit per bone (`JointLimit::FREE` where the skeleton has no range); empty: all free.
    pub limits: &'a [JointLimit],
    /// The bone of each profile role ([`NO_BONE`] for none).
    pub roles: &'a [u16],
}

/// A target slot in model space.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub position: AosVec3,
    pub rotation: AosQuat,
    pub position_weight: f32,
    pub rotation_weight: f32,
}

const IDENTITY: AosTransform = AosTransform {
    translation: AosVec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    },
    rotation: AosQuat {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        w: 1.0,
    },
    scale: AosVec3 {
        x: 1.0,
        y: 1.0,
        z: 1.0,
    },
};

fn finite(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

impl<'a> RigInputs<'a> {
    /// No inputs: the character at the origin, LOD 0, no targets, hits, rays, limits or roles.
    pub const NONE: RigInputs<'static> = RigInputs {
        character: IDENTITY,
        lod: 0,
        targets: &[],
        hits: &[],
        rays: &[],
        limits: &[],
        roles: &[],
    };

    /// Target slot `slot` in model space, or `None` for `NONE`, a missing slot or a slot whose
    /// position weight is 0.
    pub fn target(&self, slot: u32) -> Option<Target> {
        use view::*;
        if slot == NONE || slot as usize >= MAX_TARGETS {
            return None;
        }
        let w = self
            .targets
            .get(slot as usize * TARGET_WORDS..(slot as usize + 1) * TARGET_WORDS)?;
        let f = |i: usize| finite(f32::from_bits(w[i]));
        let pw = mixing::unit(f(TARGET_POSITION_WEIGHT));
        if !(pw > 0.0) {
            return None;
        }
        let mut position = AosVec3::new(
            f(TARGET_POSITION),
            f(TARGET_POSITION + 1),
            f(TARGET_POSITION + 2),
        );
        let mut rotation = AosQuat::new(
            f(TARGET_ROTATION),
            f(TARGET_ROTATION + 1),
            f(TARGET_ROTATION + 2),
            f(TARGET_ROTATION + 3),
        )
        .normalize_or_identity();
        if w[TARGET_FLAGS] & TARGET_WORLD != 0 {
            let inv = self.character.inverse();
            position = inv.transform_point(position);
            rotation = (self.character.rotation.conjugate() * rotation).normalize_or_identity();
        }
        Some(Target {
            position,
            rotation,
            position_weight: pw,
            rotation_weight: mixing::unit(f(TARGET_ROTATION_WEIGHT)),
        })
    }

    /// Ray hit `i` (model space); a miss when absent.
    pub fn hit(&self, i: usize) -> RayHit {
        use view::*;
        let Some(w) = self.hits.get(i * HIT_WORDS..(i + 1) * HIT_WORDS) else {
            return RayHit::MISS;
        };
        let f = |k: usize| finite(f32::from_bits(w[k]));
        if w[HIT_FLAGS] & HIT_VALID == 0 {
            return RayHit::MISS;
        }
        RayHit {
            point: AosVec3::new(f(HIT_POINT), f(HIT_POINT + 1), f(HIT_POINT + 2)),
            normal: AosVec3::new(f(HIT_NORMAL), f(HIT_NORMAL + 1), f(HIT_NORMAL + 2)),
            valid: true,
        }
    }

    /// Writes ray request `i` (dropped when the view has no such row).
    pub fn write_ray(&self, i: usize, r: &RayRequest) {
        use view::*;
        let Some(w) = self.rays.get(i * RAY_WORDS..(i + 1) * RAY_WORDS) else {
            return;
        };
        let v = [
            r.origin.x,
            r.origin.y,
            r.origin.z,
            r.direction.x,
            r.direction.y,
            r.direction.z,
            r.length,
        ];
        for (c, x) in w.iter().zip(v) {
            c.set(x.to_bits());
        }
        w[RAY_FLAGS].set(RAY_VALID);
    }

    /// The bone a bone word names (module docs), if it is one of the `bones` bones.
    pub fn bone(&self, word: u32, bones: usize) -> Option<u16> {
        if word == NONE {
            return None;
        }
        let b = if word & ROLE != 0 {
            *self.roles.get((word & 0xFFFF) as usize)?
        } else {
            u16::try_from(word).ok()?
        };
        (b != NO_BONE && (b as usize) < bones).then_some(b)
    }

    /// Bone `b`'s skeleton limit (free when the skeleton has none).
    pub fn limit(&self, b: u16) -> JointLimit {
        self.limits
            .get(b as usize)
            .copied()
            .unwrap_or(JointLimit::FREE)
    }
}

/// The words every block starts with (module docs).
pub mod head {
    /// f32 weight (absent: 1).
    pub const WEIGHT: usize = 0;
    /// Float parameter multiplying the weight, or `NONE`.
    pub const WEIGHT_PARAM: usize = 1;
    /// Curve name string id multiplying the weight, or `NONE`.
    pub const WEIGHT_CURVE: usize = 2;
    /// Skip at rig LOD ≥ this (0: never).
    pub const LOD_SKIP: usize = 3;
    /// Words in the head.
    pub const WORDS: usize = 4;
}

/// The state header every rig node has (module docs).
pub mod state {
    /// Seconds accumulated by Update since the last solve (f32 bits).
    pub const DT: usize = 0;
    /// [`FLAG_SKIPPED`] | [`FLAG_RESET`].
    pub const FLAGS: usize = 1;
    /// Words in the header.
    pub const WORDS: usize = 2;
    /// The last solve was skipped (LOD or weight 0): the next one starts afresh.
    pub const FLAG_SKIPPED: u32 = 1;
    /// A reset was asked for (`RIG_RESET`).
    pub const FLAG_RESET: u32 = 2;
}

/// [`kind::TWO_BONE_IK`]'s words.
pub mod two_bone {
    /// Bone: the limb root (upper arm, thigh).
    pub const ROOT: usize = 4;
    /// Bone: the mid bone (forearm, shin).
    pub const MID: usize = 5;
    /// Bone: the tip (hand, foot).
    pub const TIP: usize = 6;
    /// The target slot.
    pub const TARGET: usize = 7;
    /// A target slot whose position is the pole (knee or elbow target), or `NONE`: keep the
    /// animated bend plane.
    pub const POLE: usize = 8;
    /// The tip's rotation: [`TIP_INHERIT`], [`TIP_MAINTAIN`] or [`TIP_TARGET`].
    pub const TIP_MODE: usize = 9;
    /// f32 soft-IK band as a fraction of the reach (absent: 0, hard).
    pub const SOFT: usize = 10;
    /// f32 largest stretch (absent: 1, none).
    pub const MAX_STRETCH: usize = 11;
    /// The tip keeps its local rotation.
    pub const TIP_INHERIT: u32 = 0;
    /// The tip keeps its animated model rotation.
    pub const TIP_MAINTAIN: u32 = 1;
    /// The tip turns to the target's rotation by the slot's rotation weight.
    pub const TIP_TARGET: u32 = 2;
}

/// [`kind::CCD`]'s and [`kind::FABRIK`]'s words.
pub mod chain {
    /// The target slot (for the chain's last bone).
    pub const TARGET: usize = 4;
    /// Iterations (absent or 0: 16).
    pub const ITERATIONS: usize = 5;
    /// f32 tolerance, model units (absent: 0.001).
    pub const TOLERANCE: usize = 6;
    /// 1: apply the skeleton's joint limits to every chain bone; 0: none.
    pub const LIMITS: usize = 7;
    /// The chain's bone count, 2 to [`MAX_CHAIN`](super::MAX_CHAIN).
    pub const COUNT: usize = 8;
    /// The bones, root to tip (each a descendant of the one before).
    pub const BONES: usize = 9;
}

/// [`kind::FULL_BODY_IK`]'s words.
pub mod full_body {
    /// Iterations (absent or 0: 8).
    pub const ITERATIONS: usize = 4;
    /// f32 tolerance (absent: 0.001).
    pub const TOLERANCE: usize = 5;
    /// f32 body pull in \[0, 1\] (absent: 0.5).
    pub const BODY_PULL: usize = 6;
    /// The root (hips) effector's target slot, or `NONE`.
    pub const ROOT_SLOT: usize = 7;
    /// The centre-of-mass target slot (its position weight is the pull), or `NONE`.
    pub const COM_SLOT: usize = 8;
    /// The centre of mass pulls only across this up axis (3 f32; zero: in 3D).
    pub const COM_UP: usize = 9;
    /// [`MODE_EXPLICIT`] or [`MODE_HUMANOID`].
    pub const MODE: usize = 12;
    /// Explicit: the root bone. Humanoid: unused (the `Hips` role).
    pub const ROOT_BONE: usize = 13;
    /// Explicit: the chain count, 1 to 8 (`anim_rig::full_body::MAX_CHAINS`).
    pub const COUNT: usize = 14;
    /// Explicit: per chain, the chain it branches from (an earlier index, or `NONE` for one
    /// starting at the root), its effector slot (or `NONE`), its bone count `k` (≥ 2), then `k`
    /// bones (the first is the sub-base: the root, or the parent chain's last bone). Humanoid:
    /// six effector slots (or `NONE`), for the spine's end (the chest), the left foot, the right
    /// foot, the head, the left hand and the right hand; the chains come from the roles
    /// (`Hips`–`Spine`–`Chest`–`UpperChest`; `Hips`–upper leg–lower leg–foot per side; chest–`Neck`–
    /// `Head`; chest–`Shoulder`–upper arm–lower arm–hand per side; missing roles are skipped and a
    /// chain left with fewer than two bones is dropped).
    pub const CHAINS: usize = 15;
    /// Chains from explicit words.
    pub const MODE_EXPLICIT: u32 = 0;
    /// Chains from the Humanoid profile's roles.
    pub const MODE_HUMANOID: u32 = 1;
}

/// [`kind::LOOK_AT`]'s and [`kind::AIM`]'s words.
pub mod aim {
    /// The target slot.
    pub const TARGET: usize = 4;
    /// f32 up alignment in \[0, 1\] (absent: 0).
    pub const UP_WEIGHT: usize = 5;
    /// f32 clamp cone half-angle, radians (absent: π, none).
    pub const MAX_ANGLE: usize = 6;
    /// The bones' forward axis, local (3 f32; zero: +Z).
    pub const FORWARD: usize = 7;
    /// The bones' up axis, local (3 f32; zero: +Y).
    pub const UP: usize = 10;
    /// The model-space direction up axes are kept toward (3 f32; zero: none).
    pub const GOAL_UP: usize = 13;
    /// Look-at: the joint count (1 to [`MAX_AIM_JOINTS`](super::MAX_AIM_JOINTS)); then per joint
    /// its bone, f32 share in \[0, 1\] and f32 limit in radians (≤ 0: free), root to end.
    pub const LOOK_COUNT: usize = 16;
    /// Aim: the aim bone (a descendant of the last joint, or it).
    pub const AIM_BONE: usize = 16;
    /// Aim: iterations (absent or 0: 4).
    pub const ITERATIONS: usize = 17;
    /// Aim: the joint count; then the joints as for look-at.
    pub const AIM_COUNT: usize = 18;
    /// Words per joint.
    pub const JOINT_WORDS: usize = 3;
}

/// [`kind::GROUNDER`]'s words. The float settings' absent defaults are `GrounderSettings`'s.
pub mod grounder {
    /// Bone: the pelvis.
    pub const PELVIS: usize = 4;
    /// The first of the instance's ray rows this grounder uses (one per foot).
    pub const RAY_BASE: usize = 5;
    /// Model up (3 f32; zero: +Y).
    pub const UP: usize = 6;
    /// f32 ray start above the foot (default 0.5).
    pub const RAY_HEIGHT: usize = 9;
    /// f32 ray reach below the foot (0.5).
    pub const RAY_DEPTH: usize = 10;
    /// f32 largest foot raise or drop (0.5).
    pub const MAX_STEP: usize = 11;
    /// f32 largest foot tilt, radians (45°).
    pub const MAX_FOOT_ANGLE: usize = 12;
    /// f32 share of the ground tilt the feet take (1).
    pub const FOOT_ROTATION_WEIGHT: usize = 13;
    /// f32 foot smoothing half-life, seconds (0.05).
    pub const FOOT_HALF_LIFE: usize = 14;
    /// f32 pelvis smoothing half-life, seconds (0.1).
    pub const PELVIS_HALF_LIFE: usize = 15;
    /// f32 largest pelvis drop (0.5).
    pub const MAX_PELVIS_DOWN: usize = 16;
    /// f32 largest pelvis raise (0).
    pub const MAX_PELVIS_UP: usize = 17;
    /// The foot count, 1 to 4 (`anim_rig::grounder::MAX_FEET`).
    pub const COUNT: usize = 18;
    /// Per leg: root, mid and tip bones (thigh, shin, foot).
    pub const LEGS: usize = 19;
}

/// [`kind::SPRING_CHAIN`]'s words. The float settings' absent defaults are `SpringSettings`'s.
pub mod spring {
    /// f32 stiffness, 1/s² (60).
    pub const STIFFNESS: usize = 4;
    /// f32 damping, 1/s (6).
    pub const DAMPING: usize = 5;
    /// f32 drag, 1/s (0.5).
    pub const DRAG: usize = 6;
    /// World gravity (3 f32; absent: (0, −9.81, 0)).
    pub const GRAVITY: usize = 7;
    /// f32 largest swing from the animated direction, radians (π).
    pub const MAX_ANGLE: usize = 10;
    /// f32 particle radius (0).
    pub const RADIUS: usize = 11;
    /// f32 longest substep, seconds (1/120).
    pub const MAX_STEP: usize = 12;
    /// Most substeps per update (absent or 0: 8).
    pub const MAX_SUBSTEPS: usize = 13;
    /// f32 anchor jump that resets the chain, world units (2).
    pub const TELEPORT: usize = 14;
    /// The chain's bone count, 2 to 16 (`anim_rig::spring::MAX_SPRING_BONES`), anchor first.
    pub const COUNT: usize = 15;
    /// The collider count, 0 to [`MAX_COLLIDERS`](super::MAX_COLLIDERS).
    pub const COLLIDERS: usize = 16;
    /// The bones (anchor to tip), then per collider [`COLLIDER_WORDS`] words: its bone, its shape
    /// ([`SHAPE_SPHERE`] or [`SHAPE_CAPSULE`]), point `a` (3 f32, the bone's local space: the
    /// sphere's centre or the capsule's first end), point `b` (3 f32: the capsule's other end),
    /// f32 radius.
    pub const BONES: usize = 17;
    /// Words per collider.
    pub const COLLIDER_WORDS: usize = 9;
    /// A sphere collider.
    pub const SHAPE_SPHERE: u32 = 0;
    /// A capsule collider.
    pub const SHAPE_CAPSULE: u32 = 1;
}

/// [`kind::COPY`]'s words.
pub mod copy {
    /// Bone: the source.
    pub const SOURCE: usize = 4;
    /// Bone: the target.
    pub const TARGET: usize = 5;
    /// 0: local space; 1: model space.
    pub const SPACE: usize = 6;
    /// f32 position weight (absent: 1).
    pub const POSITION_WEIGHT: usize = 7;
    /// f32 rotation weight (absent: 1).
    pub const ROTATION_WEIGHT: usize = 8;
    /// f32 scale weight (absent: 1).
    pub const SCALE_WEIGHT: usize = 9;
    /// Position offset in the source's frame (3 f32).
    pub const POSITION_OFFSET: usize = 10;
    /// Rotation offset after the copied rotation (4 f32; zero: identity).
    pub const ROTATION_OFFSET: usize = 13;
    /// Scale multiplier (3 f32; absent: 1).
    pub const SCALE_OFFSET: usize = 17;
}

/// [`kind::LIMIT_ROTATION`]'s words.
pub mod limit_rotation {
    /// [`SOURCE_SKELETON`] or [`SOURCE_EXPLICIT`].
    pub const SOURCE: usize = 4;
    /// Explicit: f32 swing half-axis about local Y, degrees.
    pub const SWING_Y: usize = 5;
    /// Explicit: f32 swing half-axis about local Z, degrees.
    pub const SWING_Z: usize = 6;
    /// Explicit: f32 twist minimum about local X, degrees.
    pub const TWIST_MIN: usize = 7;
    /// Explicit: f32 twist maximum, degrees.
    pub const TWIST_MAX: usize = 8;
    /// The bone count, 1 to [`MAX_LIST`](super::MAX_LIST); then the bones.
    pub const COUNT: usize = 9;
    /// The bones.
    pub const BONES: usize = 10;
    /// Each bone's `JOINT_RANGES` entry.
    pub const SOURCE_SKELETON: u32 = 0;
    /// The explicit range, relative to each bone's rest rotation.
    pub const SOURCE_EXPLICIT: u32 = 1;
}

/// [`kind::LIMIT_POSITION`]'s words.
pub mod limit_position {
    /// Bone.
    pub const BONE: usize = 4;
    /// 0: its local translation; 1: its model position.
    pub const SPACE: usize = 5;
    /// [`SHAPE_BOX`] or [`SHAPE_SPHERE`].
    pub const SHAPE: usize = 6;
    /// The box's minimum or the sphere's centre (3 f32).
    pub const A: usize = 7;
    /// The box's maximum (3 f32).
    pub const B: usize = 10;
    /// f32 the sphere's radius.
    pub const RADIUS: usize = 13;
    /// Per-axis clamp.
    pub const SHAPE_BOX: u32 = 0;
    /// Radial clamp.
    pub const SHAPE_SPHERE: u32 = 1;
}

/// [`kind::DAMP`]'s words.
pub mod damp {
    /// Bone.
    pub const BONE: usize = 4;
    /// f32 position half-life, seconds (≤ 0: none).
    pub const POSITION_HALF_LIFE: usize = 5;
    /// f32 rotation half-life, seconds (≤ 0: none).
    pub const ROTATION_HALF_LIFE: usize = 6;
}

/// [`kind::STRIDE_WARP`]'s words.
pub mod stride {
    /// Bone: the pelvis.
    pub const PELVIS: usize = 4;
    /// f32 stride scale (absent: 1).
    pub const SCALE: usize = 5;
    /// A float parameter giving the scale instead, or `NONE`.
    pub const SCALE_PARAM: usize = 6;
    /// A float parameter with the character's ground speed: the scale is it over the root speed
    /// of the input's timing clip (when that is above 0), or `NONE`.
    pub const SPEED_PARAM: usize = 7;
    /// Movement direction (3 f32; zero: +Z).
    pub const DIRECTION: usize = 8;
    /// A vec3 parameter giving the direction instead, or `NONE`.
    pub const DIRECTION_PARAM: usize = 11;
    /// Model up (3 f32; zero: +Y).
    pub const UP: usize = 12;
    /// f32 share of the needed pelvis drop (absent: 1).
    pub const PELVIS_WEIGHT: usize = 15;
    /// f32 largest pelvis drop (absent: 0.2).
    pub const MAX_PELVIS_DROP: usize = 16;
    /// f32 longest leg extension as a fraction of its length (absent: 0.995).
    pub const MAX_REACH: usize = 17;
    /// The leg count, 1 to 4.
    pub const COUNT: usize = 18;
    /// Per leg: root, mid and tip bones.
    pub const LEGS: usize = 19;
}

/// [`kind::ORIENTATION_WARP`]'s words.
pub mod orientation {
    /// Bone: the pelvis.
    pub const PELVIS: usize = 4;
    /// f32 turn about up, radians.
    pub const ANGLE: usize = 5;
    /// A float parameter giving the angle instead, or `NONE`.
    pub const ANGLE_PARAM: usize = 6;
    /// A vec3 parameter with the movement direction (model space): the angle is the heading
    /// from the character's facing (+Z) to it; or `NONE`.
    pub const DIRECTION_PARAM: usize = 7;
    /// f32 largest turn, radians (absent: π/2).
    pub const MAX_ANGLE: usize = 8;
    /// Model up (3 f32; zero: +Y).
    pub const UP: usize = 9;
    /// The spine bone count, 1 to [`MAX_LIST`](super::MAX_LIST); then the bones (from the
    /// pelvis up), then optionally one f32 share each (absent: even).
    pub const COUNT: usize = 12;
    /// The spine bones.
    pub const BONES: usize = 13;
}

/// [`kind::MOTION_WARP`]'s words and state.
///
/// The window is `[t0, t1]` of the input's timing clip, from two cue markers or explicit times.
/// The target comes from the `rig` family's `WARP_TARGET` command (world space, as the
/// character's transform); without one, or outside the window, root motion passes through.
/// The window starts at `t0` from where the character is (the character transform of the frame
/// whose step crosses `t0`); a target set after `t0`, or changed mid-window, re-plans from the
/// current frame to `t1`. At `t1` the character's root is at the target's position with its yaw
/// (decision D42) and the target is consumed. The clip needs a root curve.
pub mod motion_warp {
    /// [`WINDOW_MARKERS`] or [`WINDOW_TIMES`].
    pub const WINDOW: usize = 4;
    /// Markers: the cue marker name (string id) that opens the window. Times: f32 seconds.
    pub const START: usize = 5;
    /// Markers: the cue marker name that closes it (the first after the start). Times: f32.
    pub const END: usize = 6;
    /// Up for the yaw correction (3 f32; zero: +Y).
    pub const UP: usize = 7;
    /// The window from cue markers.
    pub const WINDOW_MARKERS: u32 = 0;
    /// The window from explicit times.
    pub const WINDOW_TIMES: u32 = 1;
    /// State (after the header): target position (3 f32), rotation (4 f32).
    pub const S_TARGET: usize = 0;
    /// State: 1 when a target is set, 2 when it changed since the window started.
    pub const S_HAS_TARGET: usize = 7;
    /// State: the window's start transform (position 3, rotation 4).
    pub const S_START: usize = 8;
    /// State: 1 while a window runs.
    pub const S_ACTIVE: usize = 15;
    /// State: the running window's t0 and t1 (f32).
    pub const S_T0: usize = 16;
    pub const S_T1: usize = 17;
    /// State: the clip the window runs on.
    pub const S_CLIP: usize = 18;
    /// State words.
    pub const S_WORDS: usize = 19;
}

/// [`kind::DISTANCE_MATCH`]'s words.
pub mod distance {
    /// [`MODE_SPEED`] or [`MODE_STOP`].
    pub const MODE: usize = 4;
    /// The float parameter: the character's ground speed (speed mode) or the distance left to
    /// its stop (stop mode).
    pub const PARAM: usize = 5;
    /// f32 lowest rate (absent: 0.5).
    pub const MIN_RATE: usize = 6;
    /// f32 highest rate (absent: 2).
    pub const MAX_RATE: usize = 7;
    /// Stop mode: the cue marker name (string id) where the clip's stop is, or `NONE` (its end).
    pub const MARKER: usize = 8;
    /// The clip covers `speed × dt` per step.
    pub const MODE_SPEED: u32 = 0;
    /// The clip's travel left to the stop point equals the distance left.
    pub const MODE_STOP: u32 = 1;
}

/// Which kinds gate their input (eval's update contexts).
pub(crate) fn gates_input(kind: u16) -> bool {
    kind == kind::DISTANCE_MATCH
}

/// Extra state words of a kind (after the header).
fn extra_words(kind: u16) -> usize {
    match kind {
        kind::GROUNDER => anim_rig::grounder::GrounderState::WORDS,
        kind::SPRING_CHAIN => anim_rig::spring::SpringChainState::WORDS,
        kind::DAMP => anim_rig::constraints::DampState::WORDS,
        kind::MOTION_WARP => motion_warp::S_WORDS,
        _ => 0,
    }
}

/// The most extra state words any kind has.
pub(crate) const MAX_EXTRA_WORDS: usize = anim_rig::spring::SpringChainState::WORDS;

const _: () = {
    assert!(anim_rig::grounder::GrounderState::WORDS <= MAX_EXTRA_WORDS);
    assert!(anim_rig::constraints::DampState::WORDS <= MAX_EXTRA_WORDS);
    assert!(motion_warp::S_WORDS <= MAX_EXTRA_WORDS);
};

/// Whether a node's block respects the limits (module docs); a block that doesn't is treated as
/// an unknown node.
fn valid(kind: u16, node: &NodeData<'_>) -> bool {
    let n = node.params.len();
    let count_in = |at: usize, min: usize, max: usize| {
        let c = node.word(at) as usize;
        (min..=max).contains(&c)
    };
    match kind {
        kind::CCD | kind::FABRIK => {
            count_in(chain::COUNT, 2, MAX_CHAIN)
                && n >= chain::BONES + node.word(chain::COUNT) as usize
        }
        kind::FULL_BODY_IK => match node.word(full_body::MODE) {
            full_body::MODE_HUMANOID => true,
            _ => {
                if !count_in(full_body::COUNT, 1, anim_rig::full_body::MAX_CHAINS) {
                    return false;
                }
                let mut at = full_body::CHAINS;
                let mut total = 0;
                for _ in 0..node.word(full_body::COUNT) {
                    let k = node.word(at + 2) as usize;
                    if k < 2 || at + 3 + k > n {
                        return false;
                    }
                    total += k;
                    at += 3 + k;
                }
                total <= MAX_BODY_BONES
            }
        },
        kind::LOOK_AT => {
            count_in(aim::LOOK_COUNT, 1, MAX_AIM_JOINTS)
                && n >= aim::LOOK_COUNT + 1 + aim::JOINT_WORDS * node.word(aim::LOOK_COUNT) as usize
        }
        kind::AIM => {
            count_in(aim::AIM_COUNT, 1, MAX_AIM_JOINTS)
                && n >= aim::AIM_COUNT + 1 + aim::JOINT_WORDS * node.word(aim::AIM_COUNT) as usize
        }
        kind::GROUNDER => {
            count_in(grounder::COUNT, 1, anim_rig::grounder::MAX_FEET)
                && n >= grounder::LEGS + 3 * node.word(grounder::COUNT) as usize
        }
        kind::STRIDE_WARP => {
            count_in(stride::COUNT, 1, anim_rig::grounder::MAX_FEET)
                && n >= stride::LEGS + 3 * node.word(stride::COUNT) as usize
        }
        kind::SPRING_CHAIN => {
            let c = node.word(spring::COUNT) as usize;
            let m = node.word(spring::COLLIDERS) as usize;
            count_in(spring::COUNT, 2, anim_rig::spring::MAX_SPRING_BONES)
                && m <= MAX_COLLIDERS
                && n >= spring::BONES + c + spring::COLLIDER_WORDS * m
        }
        kind::LIMIT_ROTATION => {
            count_in(limit_rotation::COUNT, 1, MAX_LIST)
                && n >= limit_rotation::BONES + node.word(limit_rotation::COUNT) as usize
        }
        kind::ORIENTATION_WARP => {
            count_in(orientation::COUNT, 1, MAX_LIST)
                && n >= orientation::BONES + node.word(orientation::COUNT) as usize
        }
        _ => true,
    }
}

/// The node's effective weight in \[0, 1\]: word 0 times its parameter and curve (module docs).
pub(crate) fn weight(cx: &mut EvalContext<'_>, node: &NodeData<'_>, input: u32) -> f32 {
    let mut w = node.f32_or(head::WEIGHT, 1.0);
    let p = node.word_or_none(head::WEIGHT_PARAM);
    if p != NONE {
        w *= cx.param_f32(p);
    }
    let c = node.word_or_none(head::WEIGHT_CURVE);
    if c != NONE {
        w *= curve_value(cx, input, c);
    }
    mixing::unit(w)
}

/// Curve `id` (a string id) of `input`'s timing clip at its playhead (0 without one).
fn curve_value(cx: &mut EvalContext<'_>, input: u32, id: u32) -> f32 {
    let hash = cx.program().string_hash(id);
    let timing = cx.eval_timing(input);
    if timing.clip == 0 {
        return 0.0;
    }
    cx.assets()
        .clip(timing.clip)
        .and_then(|c| {
            let track = c.curves.iter().find(|x| x.0 == hash)?.1;
            let mut out = [0.0f32; 4];
            c.bound.sample_track(track as usize, timing.time, &mut out);
            Some(finite(out[0]))
        })
        .unwrap_or(0.0)
}

/// Whether the instance's rig LOD skips the node.
pub(crate) fn lod_skipped(cx: &EvalContext<'_>, node: &NodeData<'_>) -> bool {
    let skip = node.word(head::LOD_SKIP);
    skip != 0 && cx.rig().lod >= skip
}

/// Asks a rig node's state for a reset at its next solve (the `rig` family's `RIG_RESET`).
pub fn request_reset(state: &mut [u32]) {
    if let Some(f) = state.get_mut(state::FLAGS) {
        *f |= state::FLAG_RESET;
    }
}

/// Sets a motion-warp node's target (world space; its state words). Marks it changed when a
/// window is running, so the warp re-plans.
pub fn set_warp_target(state: &mut [u32], position: AosVec3, rotation: AosQuat) {
    let s = &mut state[state::WORDS..];
    if s.len() < motion_warp::S_WORDS {
        return;
    }
    let r = rotation.normalize_or_identity();
    let v = [position.x, position.y, position.z, r.x, r.y, r.z, r.w];
    for (o, x) in s[motion_warp::S_TARGET..].iter_mut().zip(v) {
        *o = x.to_bits();
    }
    s[motion_warp::S_HAS_TARGET] = if s[motion_warp::S_ACTIVE] != 0 { 2 } else { 1 };
}

/// Clears a motion-warp node's target (root motion passes through again).
pub fn clear_warp_target(state: &mut [u32]) {
    let s = &mut state[state::WORDS..];
    if s.len() < motion_warp::S_WORDS {
        return;
    }
    s[motion_warp::S_HAS_TARGET] = 0;
    s[motion_warp::S_ACTIVE] = 0;
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    if kind > kind::LAST || !valid(kind, &node) {
        return NodeStatus::UnknownKind;
    }
    if cx.phase() == Phase::Layout {
        cx.set_state_words((state::WORDS + extra_words(kind)) as u32, 0);
        return NodeStatus::Done;
    }
    let Some(&input) = node.inputs.first() else {
        mixing::empty(cx);
        return NodeStatus::Done;
    };
    match cx.phase() {
        Phase::Init => {
            let s = cx.state();
            if kind == kind::MOTION_WARP && s.len() >= state::WORDS + motion_warp::S_WORDS {
                // The target outlives a re-entry (it is set before the play that uses it).
                let t = &mut s[state::WORDS..];
                t[motion_warp::S_START..].fill(0);
                if t[motion_warp::S_HAS_TARGET] != 0 {
                    t[motion_warp::S_HAS_TARGET] = 1;
                }
                s[..state::WORDS].fill(0);
            } else {
                s.fill(0);
            }
        }
        Phase::Update => {
            if kind == kind::DISTANCE_MATCH {
                warp::distance_update(cx, &node, input);
            } else {
                let dt = cx.dt();
                let s = cx.state();
                let acc = f32::from_bits(s[state::DT]) + if dt > 0.0 { dt } else { 0.0 };
                s[state::DT] = acc.to_bits();
            }
        }
        Phase::Pose if kind != kind::MOTION_WARP && kind != kind::DISTANCE_MATCH => {
            solve::pose(cx, kind, &node, input);
        }
        Phase::Root if kind == kind::MOTION_WARP => warp::motion_root(cx, &node, input),
        _ => mixing::pass(cx, input),
    }
    NodeStatus::Done
}
