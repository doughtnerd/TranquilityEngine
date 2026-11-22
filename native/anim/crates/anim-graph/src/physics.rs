//! Node family `physics`: the physical-pose graph input and its blend (ADR 0342, 0345; T44r),
//! calling `anim-physics`. The drive targets themselves are computed by the host after the fixed
//! evaluation (`anim-wasm`'s `physics_drive`) from the first `PHYSICS_BLEND` node's animated input.
//!
//! # `PHYSICAL_POSE` (kind 0)
//!
//! Inputs: `[fallback]` (optional). The ragdoll's simulated pose: the host copies the bodies the
//! ragdoll plugin wrote back (the `physics` family's input view, converted from body frames to
//! bone frames) into the node's state each fixed step ([`write_body`], [`set_valid`]); the node
//! turns them into the skeleton's local pose with `anim_physics::pose::bodies_to_local`. Bones
//! without a simulated body keep the fallback's local transform (the rest pose without a
//! fallback). Words: none. Before the first write it outputs its fallback (alpha 0 without one).
//! No root motion. Timing and the weighted walks are the fallback's.
//!
//! State: [`physical::VALID`], then per bone [`physical::BONE_WORDS`] words (a simulated flag,
//! model position x, y, z, model rotation x, y, z, w), so a snapshot holds the physical pose.
//!
//! # `PHYSICS_BLEND` (kind 1)
//!
//! Inputs: `[animated, physical]`. `lerp(animated, physical, w)` per bone, `w` the blend weight
//! times the bone's mask weight (PuppetMaster's `pinWeight`/blend, ADR 0345's `blend`). Words: 0
//! `f32` weight (1 when absent), 1 `u32` a float parameter giving it instead, or `NONE`, 2 `u32` a
//! mask: a string id bound to a mask asset, or `NONE` (every bone). Root motion is the animated
//! input's scaled by `1 − w` (a ragdoll doesn't walk); timing is the animated input's; the
//! weighted walks visit both at `1 − w` and `w`.
//!
//! It also keeps the **drive source**: each Pose evaluation stores the animated input's pose and
//! the one before it, with the seconds between them ([`blend`] layout), which the host's drive
//! step reads ([`drive_source`]). In the blob, so drives after a restore are exact.

use anim_format::NONE;
use anim_math::SoaTransform;
use anim_physics::pose::{bodies_to_local, BodyPose};
use anim_pose::root::RootDelta;

use crate::dispatch::NodeStatus;
use crate::eval::{
    pose_from_words, pose_to_words, scale_root, EvalContext, NodeData, Phase,
    SOA_WORDS,
};
use crate::mixing;

/// The family's node kinds.
pub mod kind {
    /// The ragdoll's simulated pose.
    pub const PHYSICAL_POSE: u16 = 0;
    /// Animated ↔ physical by a weight and an optional mask.
    pub const PHYSICS_BLEND: u16 = 1;
}

/// A `PHYSICAL_POSE` node's state words.
pub mod physical {
    /// 1 once the host has written a pose.
    pub const VALID: usize = 0;
    /// The first bone's words.
    pub const BONES: usize = 1;
    /// Words per bone: flag, position (3), rotation (4).
    pub const BONE_WORDS: usize = 8;
}

/// A `PHYSICS_BLEND` node's state words.
pub mod blend {
    /// Seconds since the last Pose evaluation (accumulated by Update).
    pub const DT_ACC: usize = 0;
    /// Seconds between the stored previous and current animated poses.
    pub const POSE_DT: usize = 1;
    /// Animated poses stored: 0, 1 or 2.
    pub const COUNT: usize = 2;
    /// The current animated pose (`SOA_WORDS` per group), then the previous one.
    pub const POSES: usize = 3;
}

/// Writes bone `bone`'s simulated model-space bone pose (`None`: not simulated) into a
/// `PHYSICAL_POSE` node's state (the host, each fixed step). Out-of-range bones are ignored.
pub fn write_body(state: &mut [u32], bone: usize, pose: Option<BodyPose>) {
    let at = physical::BONES + bone * physical::BONE_WORDS;
    let Some(w) = state.get_mut(at..at + physical::BONE_WORDS) else {
        return;
    };
    match pose {
        Some(p) => {
            let (t, q) = (p.position, p.rotation);
            w[0] = 1;
            for (o, v) in w[1..].iter_mut().zip([t.x, t.y, t.z, q.x, q.y, q.z, q.w]) {
                *o = v.to_bits();
            }
        }
        None => w.fill(0),
    }
}

/// Marks a `PHYSICAL_POSE` node's state as holding a pose (or not).
pub fn set_valid(state: &mut [u32], valid: bool) {
    if let Some(w) = state.get_mut(physical::VALID) {
        *w = valid as u32;
    }
}

fn read_body(state: &[u32], bone: usize) -> Option<BodyPose> {
    let at = physical::BONES + bone * physical::BONE_WORDS;
    let w = state.get(at..at + physical::BONE_WORDS)?;
    if w[0] == 0 {
        return None;
    }
    let f = |i: usize| f32::from_bits(w[i]);
    let p = BodyPose {
        position: anim_math::AosVec3::new(f(1), f(2), f(3)),
        rotation: anim_math::AosQuat::new(f(4), f(5), f(6), f(7)),
    };
    let ok = [f(1), f(2), f(3), f(4), f(5), f(6), f(7)]
        .iter()
        .all(|v| v.is_finite());
    ok.then_some(p)
}

/// Replaces the simulated bones of `local` (the fallback pose, SoA) with a `PHYSICAL_POSE`
/// node's state (the node's own conversion, and the host's capture for get-up). `model` is
/// scratch of one transform per bone. Returns whether the state holds a pose (else `local` is
/// unchanged). Never allocates.
pub fn physical_to_local(
    state: &[u32],
    parents: &[u16],
    local: &mut [SoaTransform],
    model: &mut [anim_math::AosTransform],
) -> bool {
    if state.get(physical::VALID).copied().unwrap_or(0) == 0 {
        return false;
    }
    bodies_to_local(parents, |b| read_body(state, b), local, model);
    true
}

/// A `PHYSICS_BLEND` node's drive source (the host's drive step): fills `now` (and `prev` when
/// two poses are stored) from its state; returns the poses stored (0, 1 or 2) and the seconds
/// between them. `now` and `prev` have `groups` transforms.
pub fn drive_source(
    state: &[u32],
    groups: usize,
    now: &mut [SoaTransform],
    prev: &mut [SoaTransform],
) -> (u32, f32) {
    let len = groups * SOA_WORDS;
    let Some(words) = state.get(blend::POSES..blend::POSES + 2 * len) else {
        return (0, 0.0);
    };
    let count = state[blend::COUNT].min(2);
    if count >= 1 {
        pose_from_words(&words[..len], now);
    }
    if count >= 2 {
        pose_from_words(&words[len..], prev);
    }
    (count, f32::from_bits(state[blend::POSE_DT]))
}

/// Evaluates a node of this family. Called only by [`crate::dispatch`].
pub(crate) fn evaluate(cx: &mut EvalContext<'_>, kind: u16, node: NodeData<'_>) -> NodeStatus {
    match kind {
        kind::PHYSICAL_POSE => physical_pose(cx, node),
        kind::PHYSICS_BLEND => physics_blend(cx, node),
        _ => return NodeStatus::UnknownKind,
    }
    NodeStatus::Done
}

fn physical_pose(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let fallback = node.inputs.first().copied();
    match cx.phase() {
        Phase::Layout => cx.set_state_words(
            physical::BONES as u32,
            (physical::BONE_WORDS * anim_math::layout::LANES) as u32,
        ),
        Phase::Init | Phase::Update => {}
        Phase::Alpha => {
            if cx.state()[physical::VALID] != 0 {
                cx.set_alpha(1.0);
            } else if let Some(f) = fallback {
                let a = cx.eval_alpha(f);
                cx.set_alpha(a);
            } else {
                cx.set_alpha(0.0);
            }
        }
        Phase::Pose => {
            let out = cx.out();
            match fallback {
                Some(f) => cx.eval_pose(f, out),
                None => cx.fill_rest(out),
            }
            let parents = cx.skeleton().parents;
            if let Some((state, pose, model)) = cx.state_slot_sample(out) {
                physical_to_local(state, parents, pose, model);
            }
        }
        Phase::Root => cx.set_root(RootDelta::identity()),
        _ => match fallback {
            Some(f) => mixing::pass(cx, f),
            None => mixing::empty(cx),
        },
    }
}

fn blend_weight(cx: &EvalContext<'_>, node: &NodeData<'_>) -> f32 {
    let p = node.word_or_none(1);
    let w = if p != NONE {
        cx.param_f32(p)
    } else {
        node.f32_or(0, 1.0)
    };
    if w > 0.0 {
        w.min(1.0)
    } else {
        0.0
    }
}

fn physics_blend(cx: &mut EvalContext<'_>, node: NodeData<'_>) {
    let (Some(&animated), physical) = (node.inputs.first(), node.inputs.get(1).copied()) else {
        mixing::empty(cx);
        return;
    };
    let w = if physical.is_some() {
        blend_weight(cx, &node)
    } else {
        0.0
    };
    match cx.phase() {
        Phase::Layout => cx.set_state_words(blend::POSES as u32, 2 * SOA_WORDS as u32),
        Phase::Init => {
            let s = cx.state();
            s[blend::DT_ACC] = 0;
            s[blend::POSE_DT] = 0;
            s[blend::COUNT] = 0;
        }
        Phase::Update => {
            let dt = cx.dt();
            let s = cx.state();
            let acc = f32::from_bits(s[blend::DT_ACC]) + if dt > 0.0 { dt } else { 0.0 };
            s[blend::DT_ACC] = acc.to_bits();
        }
        Phase::Alpha => {
            let a = cx.eval_alpha(animated);
            let p = match physical {
                Some(p) if w > 0.0 => cx.eval_alpha(p),
                _ => 0.0,
            };
            cx.set_alpha(a * (1.0 - w) + p * w);
        }
        Phase::Pose => {
            let out = cx.out();
            cx.eval_pose(animated, out);
            record(cx, out);
            let Some(physical) = physical.filter(|_| w > 0.0) else {
                return;
            };
            let Some(s1) = cx.push_slot() else {
                return;
            };
            cx.eval_pose(physical, s1);
            let mask = cx.binding(node.word_or_none(2));
            match cx.assets().mask(mask) {
                Some(m) if m.len() == cx.groups() => masked_into(cx, out, s1, m, w),
                _ => cx.lerp_slot_into(out, s1, w),
            }
            cx.pop_slot();
        }
        Phase::Root => {
            let r = cx.eval_root(animated);
            cx.set_root(scale_root(r, 1.0 - w));
        }
        Phase::Timing => {
            let t = cx.eval_timing(animated);
            cx.set_timing(t);
        }
        Phase::Tracks | Phase::Weights => {
            let weight = cx.weight();
            cx.eval_tracks(animated, weight * (1.0 - w));
            if let Some(p) = physical {
                cx.eval_tracks(p, weight * w);
            }
        }
    }
}

/// `out ← lerp(out, from, clamp(mask · w))` in place, keeping `out` bit for bit where the weight
/// is 0 (`anim_pose::blend::blend_masked`'s rule).
fn masked_into(cx: &mut EvalContext<'_>, out: usize, from: usize, mask: &[anim_math::F32x4], w: f32) {
    let Some((_, [po, pf])) = cx.state_and_slots([out, from]) else {
        return;
    };
    let wl = anim_math::F32x4::splat(w);
    let (zero, one) = (anim_math::F32x4::splat(0.0), anim_math::F32x4::splat(1.0));
    use anim_math::Lane;
    for ((o, &f), &m) in po.iter_mut().zip(pf.iter()).zip(mask) {
        let t = (m * wl).max(zero).min(one);
        let blended = anim_pose::blend::lerp_transform(*o, f, t);
        *o = SoaTransform::select(t.gt(zero), blended, *o);
    }
}

/// Stores slot `out` (the animated pose) as the drive source's current pose.
fn record(cx: &mut EvalContext<'_>, out: usize) {
    let g = cx.groups();
    let len = g * SOA_WORDS;
    let Some((s, [pose])) = cx.state_and_slots([out]) else {
        return;
    };
    if s.len() < blend::POSES + 2 * len {
        return;
    }
    s.copy_within(blend::POSES..blend::POSES + len, blend::POSES + len);
    pose_to_words(pose, &mut s[blend::POSES..blend::POSES + len]);
    s[blend::POSE_DT] = s[blend::DT_ACC];
    s[blend::DT_ACC] = 0;
    s[blend::COUNT] = (s[blend::COUNT] + 1).min(2);
}
