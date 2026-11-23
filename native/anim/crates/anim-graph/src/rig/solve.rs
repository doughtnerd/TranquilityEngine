//! The Pose phase of the rig nodes that adjust the pose: each reads its words (`super`'s modules
//! document them), resolves bones and targets, and calls its `anim-rig` solver on the node's
//! output slot. Never allocates: scratch is fixed-size stack arrays whose sizes the load-time check
//! (`super::valid`) guarantees.

use anim_format::skeleton::JointRange;
use anim_format::NONE;
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_retarget::profile::humanoid as role;
use anim_rig::aim::{aim as aim_solve, look_at, AimAxes, AimGoal, AimJoint};
use anim_rig::chain::{ccd, fabrik, ChainGoal};
use anim_rig::constraints::{
    copy as copy_solve, damp as damp_solve, limit_position as limit_position_solve,
    limit_rotation as limit_rotation_solve, CopyTransform, Damp, DampState, PositionLimit, Space,
};
use anim_rig::full_body::{
    full_body as full_body_solve, BodyChain, CentreOfMass, Effector, FullBodyGoal, MAX_CHAINS,
};
use anim_rig::grounder::{
    apply as ground_apply, ray_requests, solve as ground_solve, GrounderSettings, GrounderState,
    RayHit, RayRequest, MAX_FEET,
};
use anim_rig::spring::{
    spring as spring_solve, ColliderShape, SpringChainState, SpringCollider, SpringSettings,
    MAX_SPRING_BONES,
};
use anim_rig::two_bone::{two_bone as two_bone_solve, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_rig::warp::{heading_angle, orientation_warp, stride_warp, OrientationWarp, StrideWarp};
use anim_rig::{blend_rotation, ChainJoint, JointLimit, RigPose};

use super::{
    aim, chain, copy, damp, full_body, grounder, kind, limit_position, limit_rotation, lod_skipped,
    orientation, spring, state, stride, two_bone, weight, RigInputs, MAX_AIM_JOINTS,
    MAX_BODY_BONES, MAX_CHAIN, MAX_COLLIDERS, MAX_EXTRA_WORDS, MAX_LIST, ROLE,
};
use crate::eval::{EvalContext, NodeData};
use crate::mixing::unit;

const PI: f32 = core::f32::consts::PI;
const Y: AosVec3 = AosVec3 {
    x: 0.0,
    y: 1.0,
    z: 0.0,
};
const Z: AosVec3 = AosVec3 {
    x: 0.0,
    y: 0.0,
    z: 1.0,
};

/// What a solve reads besides the pose and its state words.
struct Solve<'s, 'a> {
    rig: &'s RigInputs<'a>,
    node: &'s NodeData<'s>,
    rest: &'s [AosTransform],
    bones: usize,
    /// The node's effective weight (> 0).
    w: f32,
    dt: f32,
    /// Forget the history (after a skip or a reset command).
    reset: bool,
    /// Values read from graph parameters and the input before the pose was borrowed.
    pre: Pre,
}

/// Parameter-driven values (read before the pose slot is borrowed).
#[derive(Clone, Copy)]
struct Pre {
    /// Stride scale.
    scale: f32,
    /// Stride direction.
    direction: AosVec3,
    /// Orientation-warp angle.
    angle: f32,
}

impl Solve<'_, '_> {
    fn bone(&self, i: usize) -> Option<u16> {
        self.rig.bone(self.node.word_or_none(i), self.bones)
    }
    fn f(&self, i: usize, default: f32) -> f32 {
        self.node.f32_or(i, default)
    }
    fn u(&self, i: usize) -> u32 {
        self.node.word(i)
    }
    /// A vec3 at words `i..i + 3`; `default` when absent or zero.
    fn v3(&self, i: usize, default: AosVec3) -> AosVec3 {
        vec3_words(self.node, i, default)
    }
    /// The legs (root, mid, tip triples) from word `at`, `count` of them.
    fn legs(&self, at: usize, count: usize, out: &mut [TwoBone; MAX_FEET]) -> bool {
        for (k, leg) in out.iter_mut().enumerate().take(count) {
            let (Some(root), Some(mid), Some(tip)) = (
                self.bone(at + 3 * k),
                self.bone(at + 3 * k + 1),
                self.bone(at + 3 * k + 2),
            ) else {
                return false;
            };
            *leg = TwoBone { root, mid, tip };
        }
        true
    }
}

fn vec3_words(node: &NodeData<'_>, i: usize, default: AosVec3) -> AosVec3 {
    if node.params.len() < i + 3 {
        return default;
    }
    let v = AosVec3::new(
        node.f32_or(i, 0.0),
        node.f32_or(i + 1, 0.0),
        node.f32_or(i + 2, 0.0),
    );
    if v.length_squared() > 0.0 {
        v
    } else {
        default
    }
}

/// A vec3 graph parameter (`None` for `NONE` or a zero vector).
fn param_vec3(cx: &EvalContext<'_>, p: u32) -> Option<AosVec3> {
    if p == NONE {
        return None;
    }
    let w = cx.param_words(p);
    let f = |x: u32| {
        let v = f32::from_bits(x);
        if v.is_finite() {
            v
        } else {
            0.0
        }
    };
    let v = AosVec3::new(f(w[0]), f(w[1]), f(w[2]));
    (v.length_squared() > 0.0).then_some(v)
}

fn prepare(cx: &mut EvalContext<'_>, kind: u16, node: &NodeData<'_>, input: u32) -> Pre {
    let mut pre = Pre {
        scale: 1.0,
        direction: Z,
        angle: 0.0,
    };
    match kind {
        kind::STRIDE_WARP => {
            let speed = node.word_or_none(stride::SPEED_PARAM);
            let scale = node.word_or_none(stride::SCALE_PARAM);
            pre.scale = if speed != NONE {
                let v = cx.param_f32(speed);
                let timing = cx.eval_timing(input);
                let root = if timing.clip != 0 {
                    cx.assets()
                        .clip(timing.clip)
                        .map_or(0.0, |c| crate::sources::root_speed(&c))
                } else {
                    0.0
                };
                if root > 0.0 {
                    v / root
                } else {
                    1.0
                }
            } else if scale != NONE {
                cx.param_f32(scale)
            } else {
                node.f32_or(stride::SCALE, 1.0)
            };
            pre.direction = param_vec3(cx, node.word_or_none(stride::DIRECTION_PARAM))
                .unwrap_or_else(|| vec3_words(node, stride::DIRECTION, Z));
        }
        kind::ORIENTATION_WARP => {
            let dir = node.word_or_none(orientation::DIRECTION_PARAM);
            let angle = node.word_or_none(orientation::ANGLE_PARAM);
            pre.angle = if let Some(d) = param_vec3(cx, dir) {
                heading_angle(Z, d, vec3_words(node, orientation::UP, Y))
            } else if angle != NONE {
                cx.param_f32(angle)
            } else {
                node.f32_or(orientation::ANGLE, 0.0)
            };
        }
        _ => {}
    }
    pre
}

/// The Pose phase of a pose-adjusting rig node (module docs of `super`).
pub(super) fn pose(cx: &mut EvalContext<'_>, kind: u16, node: &NodeData<'_>, input: u32) {
    let out = cx.out();
    cx.eval_pose(input, out);
    let w = if lod_skipped(cx, node) {
        0.0
    } else {
        weight(cx, node, input)
    };
    let mut local = [0u32; MAX_EXTRA_WORDS];
    let (dt, reset, extra) = {
        let s = cx.state();
        if s.len() < state::WORDS {
            return;
        }
        let dt = f32::from_bits(s[state::DT]);
        s[state::DT] = 0;
        if !(w > 0.0) {
            s[state::FLAGS] |= state::FLAG_SKIPPED;
            return;
        }
        let reset = s[state::FLAGS] & (state::FLAG_SKIPPED | state::FLAG_RESET) != 0;
        s[state::FLAGS] = 0;
        let extra = (s.len() - state::WORDS).min(MAX_EXTRA_WORDS);
        local[..extra].copy_from_slice(&s[state::WORDS..state::WORDS + extra]);
        (if dt.is_finite() { dt } else { 0.0 }, reset, extra)
    };
    let pre = prepare(cx, kind, node, input);
    let rig = cx.rig();
    let skel = cx.skeleton();
    let n = skel.bones();
    {
        let (pose, sample) = cx.pose_and_sample_scratch(out);
        if n == 0 || sample.len() < n || pose.len() != soa_len(n) {
            return;
        }
        let mut rp = RigPose::stale(skel.parents, pose, &mut sample[..n]);
        let s = Solve {
            rig: &rig,
            node,
            rest: skel.rest,
            bones: n,
            w,
            dt,
            reset,
            pre,
        };
        let st = &mut local[..extra];
        match kind {
            kind::TWO_BONE_IK => solve_two_bone(&mut rp, &s),
            kind::CCD | kind::FABRIK => solve_chain(&mut rp, &s, kind == kind::FABRIK),
            kind::FULL_BODY_IK => solve_full_body(&mut rp, &s),
            kind::LOOK_AT | kind::AIM => solve_aim(&mut rp, &s, kind == kind::AIM),
            kind::GROUNDER => solve_grounder(&mut rp, &s, st),
            kind::SPRING_CHAIN => solve_spring(&mut rp, &s, st),
            kind::COPY => solve_copy(&mut rp, &s),
            kind::LIMIT_ROTATION => solve_limit_rotation(&mut rp, &s),
            kind::LIMIT_POSITION => solve_limit_position(&mut rp, &s),
            kind::DAMP => solve_damp(&mut rp, &s, st),
            kind::STRIDE_WARP => solve_stride(&mut rp, &s),
            kind::ORIENTATION_WARP => solve_orientation(&mut rp, &s),
            _ => {}
        }
        // The model cache lives in the sampling scratch, which nothing reads after this node.
        rp.discard();
    }
    let s = cx.state();
    s[state::WORDS..state::WORDS + extra].copy_from_slice(&local[..extra]);
}

fn solve_two_bone(rp: &mut RigPose, s: &Solve) {
    use two_bone::*;
    let (Some(root), Some(mid), Some(tip)) = (s.bone(ROOT), s.bone(MID), s.bone(TIP)) else {
        return;
    };
    let Some(t) = s.rig.target(s.node.word_or_none(TARGET)) else {
        return;
    };
    let pole = s
        .rig
        .target(s.node.word_or_none(POLE))
        .map_or(Pole::Animated, |p| Pole::Position(p.position));
    let tip_rotation = match s.u(TIP_MODE) {
        TIP_MAINTAIN => TipRotation::Maintain,
        TIP_TARGET => {
            let current = rp.model(tip as usize).rotation;
            TipRotation::Target(blend_rotation(current, t.rotation, t.rotation_weight))
        }
        _ => TipRotation::Inherit,
    };
    let soft = s.f(SOFT, 0.0);
    let goal = TwoBoneGoal {
        target: t.position,
        pole,
        tip_rotation,
        soft: if soft > 0.0 { soft.min(0.99) } else { 0.0 },
        max_stretch: s.f(MAX_STRETCH, 1.0).max(1.0),
        weight: s.w * t.position_weight,
    };
    two_bone_solve(rp, TwoBone { root, mid, tip }, &goal);
}

fn solve_chain(rp: &mut RigPose, s: &Solve, use_fabrik: bool) {
    use chain::*;
    let count = s.u(COUNT) as usize;
    let mut bones = [0u16; MAX_CHAIN];
    for (j, b) in bones.iter_mut().enumerate().take(count) {
        match s.bone(BONES + j) {
            Some(x) => *b = x,
            None => return,
        }
    }
    let Some(t) = s.rig.target(s.node.word_or_none(TARGET)) else {
        return;
    };
    let mut limits = [JointLimit::FREE; MAX_CHAIN];
    let limited = s.u(LIMITS) == 1;
    if limited {
        for j in 0..count {
            limits[j] = s.rig.limit(bones[j]);
        }
    }
    let iterations = match s.u(ITERATIONS) {
        0 => 16,
        k => k.min(256),
    };
    let goal = ChainGoal {
        target: t.position,
        iterations,
        tolerance: s.f(TOLERANCE, 1e-3),
        weight: s.w * t.position_weight,
    };
    let mut scratch = [ChainJoint::default(); MAX_CHAIN];
    let lim: &[JointLimit] = if limited { &limits[..count] } else { &[] };
    if use_fabrik {
        fabrik(rp, &bones[..count], lim, &goal, &mut scratch);
    } else {
        ccd(rp, &bones[..count], lim, &goal, &mut scratch);
    }
}

/// One chain being built: its start in the bone buffer, length, parent chain and effector slot.
#[derive(Clone, Copy, Default)]
struct ChainDef {
    start: usize,
    len: usize,
    parent: Option<u8>,
    slot: u32,
}

struct Body {
    bones: [u16; MAX_BODY_BONES],
    used: usize,
    chains: [ChainDef; MAX_CHAINS],
    count: usize,
}

impl Body {
    /// Adds a chain of the resolved bones of `words` (unresolved ones skipped), if it keeps two
    /// or more; returns its index.
    fn push(&mut self, s: &Solve, words: &[u32], parent: Option<u8>, slot: u32) -> Option<u8> {
        if self.count >= MAX_CHAINS {
            return None;
        }
        let start = self.used;
        for &wd in words {
            if let Some(b) = s.rig.bone(wd, s.bones) {
                if self.used >= MAX_BODY_BONES {
                    self.used = start;
                    return None;
                }
                self.bones[self.used] = b;
                self.used += 1;
            }
        }
        let len = self.used - start;
        if len < 2 {
            self.used = start;
            return None;
        }
        self.chains[self.count] = ChainDef {
            start,
            len,
            parent,
            slot,
        };
        self.count += 1;
        Some(self.count as u8 - 1)
    }
}

fn solve_full_body(rp: &mut RigPose, s: &Solve) {
    use full_body::*;
    let mut body = Body {
        bones: [0; MAX_BODY_BONES],
        used: 0,
        chains: [ChainDef::default(); MAX_CHAINS],
        count: 0,
    };
    let root;
    if s.u(MODE) == MODE_HUMANOID {
        let r = |x: u16| ROLE | x as u32;
        let Some(hips) = s.rig.bone(r(role::HIPS), s.bones) else {
            return;
        };
        root = hips;
        let slot = |k: usize| s.node.word_or_none(CHAINS + k);
        let spine = body.push(
            s,
            &[
                r(role::HIPS),
                r(role::SPINE),
                r(role::CHEST),
                r(role::UPPER_CHEST),
            ],
            None,
            slot(0),
        );
        body.push(
            s,
            &[
                r(role::HIPS),
                r(role::LEFT_UPPER_LEG),
                r(role::LEFT_LOWER_LEG),
                r(role::LEFT_FOOT),
            ],
            None,
            slot(1),
        );
        body.push(
            s,
            &[
                r(role::HIPS),
                r(role::RIGHT_UPPER_LEG),
                r(role::RIGHT_LOWER_LEG),
                r(role::RIGHT_FOOT),
            ],
            None,
            slot(2),
        );
        let top = match spine {
            Some(c) => {
                let d = body.chains[c as usize];
                body.bones[d.start + d.len - 1] as u32
            }
            None => hips as u32,
        };
        body.push(s, &[top, r(role::NECK), r(role::HEAD)], spine, slot(3));
        body.push(
            s,
            &[
                top,
                r(role::LEFT_SHOULDER),
                r(role::LEFT_UPPER_ARM),
                r(role::LEFT_LOWER_ARM),
                r(role::LEFT_HAND),
            ],
            spine,
            slot(4),
        );
        body.push(
            s,
            &[
                top,
                r(role::RIGHT_SHOULDER),
                r(role::RIGHT_UPPER_ARM),
                r(role::RIGHT_LOWER_ARM),
                r(role::RIGHT_HAND),
            ],
            spine,
            slot(5),
        );
    } else {
        let Some(rb) = s.bone(ROOT_BONE) else {
            return;
        };
        root = rb;
        let mut at = CHAINS;
        for ci in 0..s.u(COUNT) as usize {
            let p = s.node.word_or_none(at);
            let slot = s.node.word_or_none(at + 1);
            let k = s.u(at + 2) as usize;
            let parent = if p == NONE {
                None
            } else if (p as usize) < ci {
                Some(p as u8)
            } else {
                return;
            };
            let start = body.used;
            for j in 0..k {
                match s.bone(at + 3 + j) {
                    Some(b) if body.used < MAX_BODY_BONES => {
                        body.bones[body.used] = b;
                        body.used += 1;
                    }
                    _ => return,
                }
            }
            body.chains[ci] = ChainDef {
                start,
                len: k,
                parent,
                slot,
            };
            body.count = ci + 1;
            at += 3 + k;
        }
    }
    let nc = body.count;
    if nc == 0 {
        return;
    }
    // The solver's shape rules, checked here so a bad block does nothing instead of panicking.
    for ci in 0..nc {
        let d = body.chains[ci];
        let first = body.bones[d.start];
        let ok = match d.parent {
            None => first == root,
            Some(p) => {
                let pd = body.chains[p as usize];
                (p as usize) < ci && first == body.bones[pd.start + pd.len - 1]
            }
        };
        if !ok || d.len < 2 {
            return;
        }
    }
    let mut chains = [BodyChain {
        bones: &[],
        parent: None,
    }; MAX_CHAINS];
    let mut effectors = [Effector::NONE; MAX_CHAINS];
    for ci in 0..nc {
        let d = body.chains[ci];
        chains[ci] = BodyChain {
            bones: &body.bones[d.start..d.start + d.len],
            parent: d.parent,
        };
        if let Some(t) = s.rig.target(d.slot) {
            effectors[ci] = Effector {
                position: t.position,
                position_weight: t.position_weight,
                rotation: t.rotation,
                rotation_weight: t.rotation_weight,
            };
        }
    }
    let root_effector = s
        .rig
        .target(s.node.word_or_none(ROOT_SLOT))
        .map_or(Effector::NONE, |t| Effector {
            position: t.position,
            position_weight: t.position_weight,
            rotation: t.rotation,
            rotation_weight: t.rotation_weight,
        });
    let centre_of_mass = s
        .rig
        .target(s.node.word_or_none(COM_SLOT))
        .map(|t| CentreOfMass {
            target: t.position,
            weight: t.position_weight,
            masses: &[],
            up: s.v3(COM_UP, AosVec3::zero()),
        });
    let goal = FullBodyGoal {
        root: root_effector,
        effectors: &effectors[..nc],
        centre_of_mass,
        body_pull: unit(s.f(BODY_PULL, 0.5)),
        iterations: match s.u(ITERATIONS) {
            0 => 8,
            k => k.min(256),
        },
        tolerance: s.f(TOLERANCE, 1e-3),
        weight: s.w,
    };
    let mut scratch = [ChainJoint::default(); MAX_BODY_BONES];
    full_body_solve(rp, root, &chains[..nc], &goal, &mut scratch);
}

fn solve_aim(rp: &mut RigPose, s: &Solve, is_aim: bool) {
    use aim::*;
    let Some(t) = s.rig.target(s.node.word_or_none(TARGET)) else {
        return;
    };
    let axes = AimAxes {
        forward: s.v3(FORWARD, Z).normalize_or_zero_fallback(Z),
        up: s.v3(UP, Y).normalize_or_zero_fallback(Y),
    };
    let count_at = if is_aim { AIM_COUNT } else { LOOK_COUNT };
    let count = s.u(count_at) as usize;
    let mut joints = [AimJoint {
        bone: 0,
        weight: 0.0,
        limit: PI,
        axes,
    }; MAX_AIM_JOINTS];
    for (j, joint) in joints.iter_mut().enumerate().take(count) {
        let at = count_at + 1 + JOINT_WORDS * j;
        let Some(bone) = s.bone(at) else {
            return;
        };
        let limit = s.f(at + 2, PI);
        *joint = AimJoint {
            bone,
            weight: unit(s.f(at + 1, 1.0)),
            limit: if limit > 0.0 { limit } else { PI },
            axes,
        };
    }
    let goal_up = s.v3(GOAL_UP, AosVec3::zero());
    let goal = AimGoal {
        target: t.position,
        up: goal_up.normalize_or_zero_fallback(AosVec3::zero()),
        up_weight: unit(s.f(UP_WEIGHT, 0.0)),
        max_angle: s.f(MAX_ANGLE, PI),
        iterations: match s.u(ITERATIONS) {
            0 => 4,
            k => k.min(64),
        },
        weight: s.w * t.position_weight,
    };
    let mut scratch = [ChainJoint::default(); MAX_AIM_JOINTS + 1];
    if is_aim {
        let Some(aim_bone) = s.bone(AIM_BONE) else {
            return;
        };
        aim_solve(rp, &joints[..count], aim_bone, axes, &goal, &mut scratch);
    } else {
        look_at(rp, &joints[..count], &goal, &mut scratch);
    }
}

trait NormalizeOr {
    fn normalize_or_zero_fallback(self, fallback: AosVec3) -> AosVec3;
}

impl NormalizeOr for AosVec3 {
    fn normalize_or_zero_fallback(self, fallback: AosVec3) -> AosVec3 {
        anim_rig::geom::normalize_or(self, fallback)
    }
}

fn solve_grounder(rp: &mut RigPose, s: &Solve, st: &mut [u32]) {
    use grounder::*;
    let count = s.u(COUNT) as usize;
    let mut legs = [TwoBone {
        root: 0,
        mid: 0,
        tip: 0,
    }; MAX_FEET];
    let Some(pelvis) = s.bone(PELVIS) else {
        return;
    };
    if !s.legs(LEGS, count, &mut legs) || st.len() < GrounderState::WORDS {
        return;
    }
    let d = GrounderSettings::default();
    let settings = GrounderSettings {
        up: s.v3(UP, Y).normalize_or_zero_fallback(Y),
        ray_height: s.f(RAY_HEIGHT, d.ray_height),
        ray_depth: s.f(RAY_DEPTH, d.ray_depth),
        max_step: s.f(MAX_STEP, d.max_step),
        max_foot_angle: s.f(MAX_FOOT_ANGLE, d.max_foot_angle),
        foot_rotation_weight: unit(s.f(FOOT_ROTATION_WEIGHT, d.foot_rotation_weight)),
        foot_half_life: s.f(FOOT_HALF_LIFE, d.foot_half_life),
        pelvis_half_life: s.f(PELVIS_HALF_LIFE, d.pelvis_half_life),
        max_pelvis_down: s.f(MAX_PELVIS_DOWN, d.max_pelvis_down),
        max_pelvis_up: s.f(MAX_PELVIS_UP, d.max_pelvis_up),
        weight: s.w,
    };
    let base = s.u(RAY_BASE) as usize;
    let legs = &legs[..count];
    // This frame's rays from the animated pose (cast by the host for the next frame).
    let mut requests = [RayRequest {
        origin: AosVec3::zero(),
        direction: AosVec3::zero(),
        length: 0.0,
    }; MAX_FEET];
    ray_requests(rp, legs, &settings, &mut requests);
    let mut hits = [RayHit::MISS; MAX_FEET];
    for i in 0..count {
        s.rig.write_ray(base + i, &requests[i]);
        hits[i] = s.rig.hit(base + i);
    }
    let mut state = GrounderState::read_words(st);
    if s.reset {
        state.reset();
    }
    let targets = ground_solve(rp, legs, &hits[..count], &settings, &mut state, s.dt);
    ground_apply(rp, pelvis, legs, &targets, &settings);
    state.write_words(st);
}

fn solve_spring(rp: &mut RigPose, s: &Solve, st: &mut [u32]) {
    use spring::*;
    let count = s.u(COUNT) as usize;
    let colliders_n = s.u(COLLIDERS) as usize;
    if st.len() < SpringChainState::WORDS {
        return;
    }
    let mut bones = [0u16; MAX_SPRING_BONES];
    for (j, b) in bones.iter_mut().enumerate().take(count) {
        match s.bone(BONES + j) {
            Some(x) => *b = x,
            None => return,
        }
    }
    let mut colliders = [SpringCollider {
        bone: 0,
        shape: ColliderShape::Sphere {
            center: AosVec3::zero(),
            radius: 0.0,
        },
    }; MAX_COLLIDERS];
    let mut m = 0;
    for k in 0..colliders_n {
        let at = BONES + count + COLLIDER_WORDS * k;
        let Some(bone) = s.bone(at) else {
            continue;
        };
        let a = s.v3(at + 2, AosVec3::zero());
        let b = s.v3(at + 5, AosVec3::zero());
        let radius = s.f(at + 8, 0.0).max(0.0);
        colliders[m] = SpringCollider {
            bone,
            shape: if s.u(at + 1) == SHAPE_CAPSULE {
                ColliderShape::Capsule { a, b, radius }
            } else {
                ColliderShape::Sphere { center: a, radius }
            },
        };
        m += 1;
    }
    let d = SpringSettings::default();
    let settings = SpringSettings {
        stiffness: s.f(STIFFNESS, d.stiffness),
        damping: s.f(DAMPING, d.damping),
        drag: s.f(DRAG, d.drag),
        gravity: if s.node.params.len() >= GRAVITY + 3 {
            AosVec3::new(
                s.f(GRAVITY, 0.0),
                s.f(GRAVITY + 1, 0.0),
                s.f(GRAVITY + 2, 0.0),
            )
        } else {
            d.gravity
        },
        max_angle: s.f(MAX_ANGLE, d.max_angle),
        radius: s.f(RADIUS, d.radius),
        max_step: s.f(MAX_STEP, d.max_step),
        max_substeps: match s.u(MAX_SUBSTEPS) {
            0 => d.max_substeps,
            k => k.min(64),
        },
        teleport_distance: s.f(TELEPORT, d.teleport_distance),
        weight: s.w,
    };
    let mut state = SpringChainState::read_words(st);
    if s.reset {
        state.reset();
    }
    spring_solve(
        rp,
        &bones[..count],
        &colliders[..m],
        s.rig.character,
        &settings,
        &mut state,
        s.dt,
    );
    state.write_words(st);
}

fn solve_copy(rp: &mut RigPose, s: &Solve) {
    use copy::*;
    let (Some(source), Some(target)) = (s.bone(SOURCE), s.bone(TARGET)) else {
        return;
    };
    let ro = if s.node.params.len() >= ROTATION_OFFSET + 4 {
        AosQuat::new(
            s.f(ROTATION_OFFSET, 0.0),
            s.f(ROTATION_OFFSET + 1, 0.0),
            s.f(ROTATION_OFFSET + 2, 0.0),
            s.f(ROTATION_OFFSET + 3, 0.0),
        )
        .normalize_or_identity()
    } else {
        AosQuat::identity()
    };
    let scale_offset = if s.node.params.len() >= SCALE_OFFSET + 3 {
        AosVec3::new(
            s.f(SCALE_OFFSET, 1.0),
            s.f(SCALE_OFFSET + 1, 1.0),
            s.f(SCALE_OFFSET + 2, 1.0),
        )
    } else {
        AosVec3::one()
    };
    let c = CopyTransform {
        source,
        target,
        space: if s.u(SPACE) == 1 {
            Space::Model
        } else {
            Space::Local
        },
        position_weight: unit(s.f(POSITION_WEIGHT, 1.0)),
        rotation_weight: unit(s.f(ROTATION_WEIGHT, 1.0)),
        scale_weight: unit(s.f(SCALE_WEIGHT, 1.0)),
        position_offset: s.v3(POSITION_OFFSET, AosVec3::zero()),
        rotation_offset: ro,
        scale_offset,
        weight: s.w,
    };
    copy_solve(rp, &c);
}

fn solve_limit_rotation(rp: &mut RigPose, s: &Solve) {
    use limit_rotation::*;
    let explicit = s.u(SOURCE) == SOURCE_EXPLICIT;
    let range = JointRange {
        swing_y: s.f(SWING_Y, 180.0),
        swing_z: s.f(SWING_Z, 180.0),
        twist_min: s.f(TWIST_MIN, -180.0),
        twist_max: s.f(TWIST_MAX, 180.0),
    };
    for j in 0..s.u(COUNT) as usize {
        let Some(b) = s.bone(BONES + j) else {
            continue;
        };
        let limit = if explicit {
            let rest = s
                .rest
                .get(b as usize)
                .map_or(AosQuat::identity(), |t| t.rotation);
            JointLimit::from_range(rest, &range)
        } else {
            s.rig.limit(b)
        };
        limit_rotation_solve(rp, b, &limit, s.w);
    }
}

fn solve_limit_position(rp: &mut RigPose, s: &Solve) {
    use limit_position::*;
    let Some(b) = s.bone(BONE) else {
        return;
    };
    let a = s.v3(A, AosVec3::zero());
    let limit = if s.u(SHAPE) == SHAPE_SPHERE {
        PositionLimit::Sphere {
            center: a,
            radius: s.f(RADIUS, 0.0),
        }
    } else {
        PositionLimit::Box {
            min: a,
            max: s.v3(B, AosVec3::zero()),
        }
    };
    let space = if s.u(SPACE) == 1 {
        Space::Model
    } else {
        Space::Local
    };
    limit_position_solve(rp, b, &limit, space, s.w);
}

fn solve_damp(rp: &mut RigPose, s: &Solve, st: &mut [u32]) {
    use damp::*;
    let Some(bone) = s.bone(BONE) else {
        return;
    };
    if st.len() < DampState::WORDS {
        return;
    }
    let d = Damp {
        bone,
        position_half_life: s.f(POSITION_HALF_LIFE, 0.0),
        rotation_half_life: s.f(ROTATION_HALF_LIFE, 0.0),
        weight: s.w,
    };
    let mut state = DampState::read_words(st);
    if s.reset {
        state.reset();
    }
    damp_solve(rp, &d, &mut state, s.dt);
    state.write_words(st);
}

fn solve_stride(rp: &mut RigPose, s: &Solve) {
    use stride::*;
    let count = s.u(COUNT) as usize;
    let mut legs = [TwoBone {
        root: 0,
        mid: 0,
        tip: 0,
    }; MAX_FEET];
    let Some(pelvis) = s.bone(PELVIS) else {
        return;
    };
    if !s.legs(LEGS, count, &mut legs) {
        return;
    }
    let scale = if s.pre.scale.is_finite() {
        s.pre.scale
    } else {
        1.0
    };
    let w = StrideWarp {
        pelvis,
        direction: s.pre.direction.normalize_or_zero_fallback(Z),
        scale,
        up: s.v3(UP, Y).normalize_or_zero_fallback(Y),
        pelvis_weight: unit(s.f(PELVIS_WEIGHT, 1.0)),
        max_pelvis_drop: s.f(MAX_PELVIS_DROP, 0.2),
        max_reach: s.f(MAX_REACH, 0.995),
        weight: s.w,
    };
    stride_warp(rp, &legs[..count], &w);
}

fn solve_orientation(rp: &mut RigPose, s: &Solve) {
    use orientation::*;
    let count = s.u(COUNT) as usize;
    let Some(pelvis) = s.bone(PELVIS) else {
        return;
    };
    let mut spine = [0u16; MAX_LIST];
    for (j, b) in spine.iter_mut().enumerate().take(count) {
        match s.bone(BONES + j) {
            Some(x) => *b = x,
            None => return,
        }
    }
    let mut weights = [0.0f32; MAX_LIST];
    let has_weights = s.node.params.len() >= BONES + 2 * count;
    if has_weights {
        for (j, w) in weights.iter_mut().enumerate().take(count) {
            *w = s.f(BONES + count + j, 1.0);
        }
    }
    let angle = if s.pre.angle.is_finite() {
        s.pre.angle
    } else {
        0.0
    };
    let w = OrientationWarp {
        pelvis,
        spine: &spine[..count],
        spine_weights: if has_weights { &weights[..count] } else { &[] },
        angle,
        max_angle: s.f(MAX_ANGLE, 0.5 * PI),
        up: s.v3(UP, Y).normalize_or_zero_fallback(Y),
        weight: s.w,
    };
    let mut scratch = [ChainJoint::default(); MAX_LIST + 1];
    orientation_warp(rp, &w, &mut scratch);
}
