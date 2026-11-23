//! The rig node family through the core (T40, ADR 0372): each node in a small graph over the
//! rig test skeleton (identity inverse binds, so bone matrices are model transforms), driven by
//! the `rig` family's views and commands: IK reaches its targets at weight 1, stays at the input
//! at weight 0 and lands between at partial weights (from a parameter), LOD skips nodes, the
//! grounder follows a slope through the request/hit round trip across frames, a spring chain
//! swings and settles, a motion warp lands on its target at the window's end, distance matching
//! drives the playback rate, and snapshots stay exact with rig state. Time comes from
//! `evaluate(dt)`; tolerances are stated per check.

mod common;

use anim_format::graph::ParamValue;
use anim_format::NONE;
use anim_graph::rig::{self as rg, kind};
use anim_wasm::init::Core;
use anim_wire::core::{CHANGE_REFUSED, PASS_NORMAL, STATUS_MISMATCH, STATUS_UNKNOWN_NODES};
use anim_wire::graph::STATUS_NO_SUCH;
use common::graph::*;
use common::rig::*;
use common::*;

const MB: usize = 32;
const DT: f32 = 1.0 / 60.0;
const Q0: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

struct Rig {
    core: Core,
    skel: u32,
    model: anim_format::skeleton::Skeleton,
}

fn setup() -> Rig {
    let (model, bytes) = rig_skeleton();
    let mut core = core(8, MB as u32);
    let skel = core.load_skeleton(&bytes);
    assert_ne!(skel, 0);
    Rig { core, skel, model }
}

impl Rig {
    fn instance(&mut self, b: &mut Builder, out: u32, binds: &[(u32, u32)]) -> u32 {
        let bytes = b.build(out);
        instance(&mut self.core, &bytes, self.skel, binds).1
    }
    fn pos(&self, h: u32, bone: u16) -> [f32; 3] {
        pos(&self.core, h, MB, bone)
    }
    fn axis(&self, h: u32, bone: u16, a: usize) -> [f32; 3] {
        axis(&self.core, h, MB, bone, a)
    }
    fn frame(&mut self) {
        frame(&mut self.core, DT);
    }
}

fn close(a: [f32; 3], b: [f32; 3], tol: f32, what: &str) {
    assert!(
        dist(a, b) <= tol,
        "{what}: {a:?} vs {b:?} (tolerance {tol})"
    );
}

fn leg_ik(b: &mut Builder, input: u32, weight_param: u32, lod_skip: u32, slot: u32) -> u32 {
    use rg::two_bone::*;
    let mut v = block(1.0, weight_param, lod_skip, &[0; 8]);
    v[ROOT] = b::L_THIGH as u32;
    v[MID] = b::L_SHIN as u32;
    v[TIP] = b::L_FOOT as u32;
    v[TARGET] = slot;
    v[POLE] = NONE;
    v[TIP_MODE] = TIP_MAINTAIN;
    v[SOFT] = fb(0.0);
    v[MAX_STRETCH] = fb(1.0);
    rig_node(b, kind::TWO_BONE_IK, input, &v)
}

const REST_L_FOOT: [f32; 3] = [0.1, 0.1, 0.0];

#[test]
fn two_bone_reaches_weights_and_lod() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let w = bld.param("ikWeight", ParamValue::Float(1.0));
    let ik = leg_ik(&mut bld, src, w, 2, 0);
    let h = r.instance(&mut bld, ik, &[]);
    let target = [0.15, 0.3, 0.2];
    set_target(&mut r.core, h, 0, target, Q0, 1.0, 0.0, false);
    r.frame();
    // Analytic IK: exact up to f32 rounding (1e-4 m).
    close(r.pos(h, b::L_FOOT), target, 1e-4, "weight 1 reaches");
    // The maintained foot keeps its animated model rotation (identity: Y axis up).
    close(
        r.axis(h, b::L_FOOT, 1),
        [0.0, 1.0, 0.0],
        1e-4,
        "tip rotation kept",
    );

    command_frame(&mut r.core, &[set_float(h, w, 0.0)], DT);
    close(
        r.pos(h, b::L_FOOT),
        REST_L_FOOT,
        1e-6,
        "weight 0 is the input",
    );

    command_frame(&mut r.core, &[set_float(h, w, 0.5)], DT);
    let p = r.pos(h, b::L_FOOT);
    assert!(
        dist(p, REST_L_FOOT) > 0.05 && dist(p, target) > 0.05,
        "partial lands between: {p:?}"
    );

    // The slot's own position weight scales it the same way.
    command_frame(&mut r.core, &[set_float(h, w, 1.0)], DT);
    set_target(&mut r.core, h, 0, target, Q0, 0.5, 0.0, false);
    r.frame();
    close(
        r.pos(h, b::L_FOOT),
        p,
        1e-5,
        "slot weight 0.5 = parameter 0.5",
    );
    set_target(&mut r.core, h, 0, target, Q0, 1.0, 0.0, false);

    // LOD: skipped at level 2 and above, back below it.
    set_rig_lod(&mut r.core, h, 2);
    r.frame();
    close(r.pos(h, b::L_FOOT), REST_L_FOOT, 1e-6, "LOD 2 skips");
    set_rig_lod(&mut r.core, h, 1);
    r.frame();
    close(r.pos(h, b::L_FOOT), target, 1e-4, "LOD 1 runs");

    // World-space target: the character turned a quarter about Y and moved.
    let (s, c) = (0.25f32 * core::f32::consts::PI).sin_cos();
    let q = [0.0, s, 0.0, c];
    set_character(&mut r.core, h, [3.0, 0.0, -1.0], q);
    // world = C · model: rotate (x, z) by 90° about Y: (x, y, z) -> (z, y, -x).
    let world = [3.0 + target[2], target[1], -1.0 - target[0]];
    set_target(&mut r.core, h, 0, world, Q0, 1.0, 0.0, true);
    r.frame();
    close(
        r.pos(h, b::L_FOOT),
        target,
        1e-4,
        "world target in model space",
    );
}

fn chain_block(slot: u32, limits: u32, bones: &[u16]) -> Vec<u32> {
    use rg::chain::*;
    let mut v = block(1.0, NONE, 0, &[0; 5]);
    v[TARGET] = slot;
    v[ITERATIONS] = 32;
    v[TOLERANCE] = fb(1e-4);
    v[LIMITS] = limits;
    v[COUNT] = bones.len() as u32;
    v.extend(bones.iter().map(|&x| x as u32));
    v
}

#[test]
fn ccd_and_fabrik_reach() {
    for k in [kind::CCD, kind::FABRIK] {
        let mut r = setup();
        let mut bld = Builder::new();
        let src = rest_source(&mut bld);
        let arm = [b::L_SHOULDER, b::L_UPPER_ARM, b::L_LOWER_ARM, b::L_HAND];
        let n = rig_node(&mut bld, k, src, &chain_block(3, 0, &arm));
        let h = r.instance(&mut bld, n, &[]);
        let target = [0.4, 1.3, 0.3];
        set_target(&mut r.core, h, 3, target, Q0, 1.0, 0.0, false);
        r.frame();
        // Iterative: within 10× the 0.1 mm tolerance.
        close(r.pos(h, b::L_HAND), target, 1e-3, "chain reaches");
        // Bones keep their lengths.
        let len = dist(r.pos(h, b::L_LOWER_ARM), r.pos(h, b::L_HAND));
        assert!((len - 0.25).abs() < 1e-4, "segment length {len}");
    }
}

#[test]
fn chain_limits_from_joint_ranges() {
    // The left shin's range is locked: with limits on, a CCD over the leg can't bend the knee.
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let leg = [b::L_THIGH, b::L_SHIN, b::L_FOOT];
    let n = rig_node(&mut bld, kind::CCD, src, &chain_block(0, 1, &leg));
    let h = r.instance(&mut bld, n, &[]);
    set_target(&mut r.core, h, 0, [0.1, 0.4, 0.3], Q0, 1.0, 0.0, false);
    r.frame();
    // The shin's model rotation equals the thigh's (rest local rotation is identity).
    let (a, c) = (r.axis(h, b::L_THIGH, 1), r.axis(h, b::L_SHIN, 1));
    assert!(dot(a, c) > 1.0 - 1e-5, "knee locked: {a:?} {c:?}");
}

#[test]
fn full_body_humanoid_and_explicit_chains() {
    let target = [0.45, 1.15, 0.3];
    for humanoid in [true, false] {
        let mut r = setup();
        let mut bld = Builder::new();
        let src = rest_source(&mut bld);
        use rg::full_body::*;
        let mut v = block(1.0, NONE, 0, &[0; 11]);
        v[ITERATIONS] = 16;
        v[TOLERANCE] = fb(1e-4);
        v[BODY_PULL] = fb(0.0);
        v[ROOT_SLOT] = NONE;
        v[COM_SLOT] = NONE;
        if humanoid {
            v[MODE] = MODE_HUMANOID;
            v[ROOT_BONE] = NONE;
            v[COUNT] = 0;
            v.extend([NONE, NONE, NONE, NONE, 1, NONE]);
        } else {
            v[MODE] = MODE_EXPLICIT;
            v[ROOT_BONE] = b::HIPS as u32;
            v[COUNT] = 2;
            v.extend([
                NONE,
                NONE,
                3,
                b::HIPS as u32,
                b::SPINE as u32,
                b::CHEST as u32,
            ]);
            v.extend([0, 1, 5]);
            v.extend(
                [
                    b::CHEST,
                    b::L_SHOULDER,
                    b::L_UPPER_ARM,
                    b::L_LOWER_ARM,
                    b::L_HAND,
                ]
                .map(|x| x as u32),
            );
        }
        let n = rig_node(&mut bld, kind::FULL_BODY_IK, src, &v);
        let h = r.instance(&mut bld, n, &[]);
        set_target(&mut r.core, h, 1, target, Q0, 1.0, 0.0, false);
        r.frame();
        // FABRIK over the tree: within 2 mm.
        close(r.pos(h, b::L_HAND), target, 2e-3, "hand effector");
        // The feet carry no effector but the root didn't move (body pull 0).
        close(r.pos(h, b::HIPS), [0.0, 1.0, 0.0], 1e-4, "root stays");
    }
}

fn aim_block(
    is_aim: bool,
    slot: u32,
    forward: [f32; 3],
    joints: &[(u16, f32)],
    aim_bone: u16,
) -> Vec<u32> {
    use rg::aim::*;
    let mut v = block(1.0, NONE, 0, &[0; 12]);
    v[TARGET] = slot;
    v[UP_WEIGHT] = fb(0.0);
    v[MAX_ANGLE] = fb(core::f32::consts::PI);
    for k in 0..3 {
        v[FORWARD + k] = fb(forward[k]);
    }
    v[UP + 1] = fb(1.0);
    if is_aim {
        v.extend([aim_bone as u32, 8]);
    }
    v.push(joints.len() as u32);
    for &(bone, w) in joints {
        v.extend([bone as u32, fb(w), fb(0.0)]);
    }
    v
}

#[test]
fn look_at_and_aim_point_at_the_target() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let target = [1.0, 1.9, 1.2];
    let look = rig_node(
        &mut bld,
        kind::LOOK_AT,
        src,
        &aim_block(
            false,
            0,
            [0.0, 0.0, 1.0],
            &[(b::NECK, 0.5), (b::HEAD, 1.0)],
            0,
        ),
    );
    let aimed = rig_node(
        &mut bld,
        kind::AIM,
        look,
        &aim_block(
            true,
            1,
            [1.0, 0.0, 0.0],
            &[(b::L_UPPER_ARM, 0.5), (b::L_LOWER_ARM, 1.0)],
            b::L_HAND,
        ),
    );
    let h = r.instance(&mut bld, aimed, &[]);
    let aim_target = [0.7, 1.0, 0.6];
    set_target(&mut r.core, h, 0, target, Q0, 1.0, 0.0, false);
    set_target(&mut r.core, h, 1, aim_target, Q0, 1.0, 0.0, false);
    r.frame();
    let to = norm(sub(target, r.pos(h, b::HEAD)));
    assert!(
        dot(r.axis(h, b::HEAD, 2), to) > 1.0 - 1e-5,
        "the head faces the target"
    );
    let to = norm(sub(aim_target, r.pos(h, b::L_HAND)));
    // Aim iterates (8 iterations): within 0.5°.
    assert!(
        dot(r.axis(h, b::L_HAND, 0), to) > 0.99996,
        "the hand's +X points at the target"
    );
}

fn grounder_block(lod_skip: u32) -> Vec<u32> {
    use rg::grounder::*;
    let mut v = block(1.0, NONE, lod_skip, &[0; 15]);
    v[PELVIS] = r(anim_retarget::profile::humanoid::HIPS);
    v[RAY_BASE] = 0;
    v[UP + 1] = fb(1.0);
    let d = anim_rig::grounder::GrounderSettings::default();
    v[RAY_HEIGHT] = fb(d.ray_height);
    v[RAY_DEPTH] = fb(d.ray_depth);
    v[MAX_STEP] = fb(d.max_step);
    v[MAX_FOOT_ANGLE] = fb(d.max_foot_angle);
    v[FOOT_ROTATION_WEIGHT] = fb(1.0);
    v[FOOT_HALF_LIFE] = fb(0.05);
    v[PELVIS_HALF_LIFE] = fb(0.1);
    v[MAX_PELVIS_DOWN] = fb(0.5);
    v[MAX_PELVIS_UP] = fb(0.0);
    v[COUNT] = 2;
    v.extend(
        [
            b::L_THIGH,
            b::L_SHIN,
            b::L_FOOT,
            b::R_THIGH,
            b::R_SHIN,
            b::R_FOOT,
        ]
        .map(|x| x as u32),
    );
    v
}

/// The slope `y = 0.5 x`: hits for the core's requests (the host's ray cast).
fn cast_slope(r: &mut Rig, h: u32) -> usize {
    let n = norm([-0.5, 1.0, 0.0]);
    let reqs = rays(&r.core, h);
    let mut valid = 0;
    for (i, q) in reqs.iter().enumerate() {
        if q.valid {
            valid += 1;
            assert_eq!(q.direction, [0.0, -1.0, 0.0]);
            let p = [q.origin[0], 0.5 * q.origin[0], q.origin[2]];
            set_hit(&mut r.core, h, i, p, n, true);
        } else {
            set_hit(&mut r.core, h, i, [0.0; 3], [0.0, 1.0, 0.0], false);
        }
    }
    valid
}

#[test]
fn grounder_follows_a_slope_through_the_ray_round_trip() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let g = rig_node(&mut bld, kind::GROUNDER, src, &grounder_block(0));
    let h = r.instance(&mut bld, g, &[]);
    r.frame();
    // No hits yet (a miss returns the foot to its animated height); two requests out.
    close(
        r.pos(h, b::L_FOOT),
        REST_L_FOOT,
        1e-6,
        "first frame animated",
    );
    let q = rays(&r.core, h);
    assert!(q[0].valid && q[1].valid && !q[2].valid);
    close(
        q[0].origin,
        [0.1, 0.6, 0.0],
        1e-6,
        "ray from the animated foot, raised",
    );
    assert!((q[0].length - 1.0).abs() < 1e-6);
    // Each frame: cast last frame's requests, feed the hits, evaluate.
    for _ in 0..90 {
        assert_eq!(cast_slope(&mut r, h), 2);
        r.frame();
    }
    // Settled (1.5 s, half-lives 0.05 and 0.1 s): feet on the slope, pelvis down to the lower.
    close(
        r.pos(h, b::L_FOOT),
        [0.1, 0.15, 0.0],
        1e-3,
        "left foot raised",
    );
    close(
        r.pos(h, b::R_FOOT),
        [-0.1, 0.05, 0.0],
        1e-3,
        "right foot lowered",
    );
    assert!((r.pos(h, b::HIPS)[1] - 0.95).abs() < 1e-3, "pelvis lowered");
    let n = norm([-0.5, 1.0, 0.0]);
    assert!(
        dot(r.axis(h, b::L_FOOT, 1), n) > 1.0 - 1e-4,
        "foot tilted to the normal"
    );
    // LOD skip: no requests, animated pose; re-enabled, the smoothing restarts (snaps).
    let g2 = {
        let mut bld = Builder::new();
        let src = rest_source(&mut bld);
        let g = rig_node(&mut bld, kind::GROUNDER, src, &grounder_block(1));
        r.instance(&mut bld, g, &[])
    };
    set_rig_lod(&mut r.core, g2, 1);
    r.frame();
    assert!(
        rays(&r.core, g2).iter().all(|q| !q.valid),
        "skipped grounders ask nothing"
    );
    close(r.pos(g2, b::L_FOOT), REST_L_FOOT, 1e-6, "skipped");
}

fn spring_block(lod_skip: u32) -> Vec<u32> {
    use rg::spring::*;
    let mut v = block(1.0, NONE, lod_skip, &[0; 13]);
    v[STIFFNESS] = fb(40.0);
    v[DAMPING] = fb(4.0);
    v[DRAG] = fb(1.0);
    v[GRAVITY + 1] = fb(-9.81);
    v[MAX_ANGLE] = fb(core::f32::consts::PI);
    v[RADIUS] = fb(0.0);
    v[MAX_STEP] = fb(1.0 / 120.0);
    v[MAX_SUBSTEPS] = 8;
    v[TELEPORT] = fb(2.0);
    v[COUNT] = 4;
    v[COLLIDERS] = 0;
    v.extend(b::TAIL.map(|x| x as u32));
    v
}

const TAIL_TIP_REST: [f32; 3] = [0.0, 1.0, -0.55];

#[test]
fn spring_chain_swings_settles_resets_and_skips() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let s = rig_node(&mut bld, kind::SPRING_CHAIN, src, &spring_block(1));
    let h = r.instance(&mut bld, s, &[]);
    for _ in 0..900 {
        r.frame();
    }
    let settled = r.pos(h, b::TAIL[3]);
    assert!(
        settled[1] < TAIL_TIP_REST[1] - 0.005,
        "gravity droops the tail: {settled:?}"
    );
    r.frame();
    close(r.pos(h, b::TAIL[3]), settled, 1e-6, "at rest it stays");
    // The character steps 0.3 m to +X: in model space the tip trails toward −X, then settles.
    set_character(&mut r.core, h, [0.3, 0.0, 0.0], Q0);
    r.frame();
    let mut most = 0.0f32;
    for _ in 0..30 {
        r.frame();
        most = most.max((r.pos(h, b::TAIL[3])[0] - settled[0]).abs());
    }
    assert!(most > 0.02, "the tail swings ({most} m)");
    for _ in 0..300 {
        r.frame();
    }
    close(r.pos(h, b::TAIL[3]), settled, 1e-3, "settles back");
    // A teleport within the spring's own threshold, with RIG_RESET: no swing at all.
    set_character(&mut r.core, h, [1.3, 0.0, 0.0], Q0);
    command_frame(&mut r.core, &[reset(h, anim_wire::rig::NODE_ALL)], DT);
    close(
        r.pos(h, b::TAIL[3]),
        TAIL_TIP_REST,
        1e-5,
        "reset restarts on the animated pose",
    );
    // LOD skip: the animated pose; back on, the chain restarts there.
    for _ in 0..60 {
        r.frame();
    }
    set_rig_lod(&mut r.core, h, 1);
    r.frame();
    close(r.pos(h, b::TAIL[3]), TAIL_TIP_REST, 1e-6, "skipped by LOD");
    set_rig_lod(&mut r.core, h, 0);
    r.frame();
    close(
        r.pos(h, b::TAIL[3]),
        TAIL_TIP_REST,
        1e-5,
        "re-enabled from rest",
    );
    r.frame();
    assert!(
        dist(r.pos(h, b::TAIL[3]), TAIL_TIP_REST) > 1e-5,
        "and simulates again"
    );
}

#[test]
fn damp_copy_and_limits() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let ik = leg_ik(&mut bld, src, NONE, 0, 0);
    let damped = {
        use rg::damp::*;
        let mut v = block(1.0, NONE, 0, &[0; 3]);
        v[BONE] = b::L_FOOT as u32;
        v[POSITION_HALF_LIFE] = fb(0.1);
        v[ROTATION_HALF_LIFE] = fb(0.1);
        rig_node(&mut bld, kind::DAMP, ik, &v)
    };
    let copied = {
        use rg::copy::*;
        let mut v = block(1.0, NONE, 0, &[0; 16]);
        v[SOURCE] = b::L_HAND as u32;
        v[TARGET] = b::R_HAND as u32;
        v[SPACE] = 1;
        v[POSITION_WEIGHT] = fb(1.0);
        v[ROTATION_WEIGHT] = fb(1.0);
        v[SCALE_WEIGHT] = fb(0.0);
        v[POSITION_OFFSET + 1] = fb(0.1);
        rig_node(&mut bld, kind::COPY, damped, &v)
    };
    let limited = {
        use rg::limit_position::*;
        let mut v = block(1.0, NONE, 0, &[0; 10]);
        v[BONE] = b::HIPS as u32;
        v[SPACE] = 0;
        v[SHAPE] = SHAPE_BOX;
        for (k, x) in [-0.05f32, 0.9, -0.05].iter().enumerate() {
            v[A + k] = fb(*x);
        }
        for (k, x) in [0.05f32, 0.97, 0.05].iter().enumerate() {
            v[B + k] = fb(*x);
        }
        rig_node(&mut bld, kind::LIMIT_POSITION, copied, &v)
    };
    let h = r.instance(&mut bld, limited, &[]);
    let a = [0.15, 0.3, 0.2];
    set_target(&mut r.core, h, 0, a, Q0, 1.0, 0.0, false);
    for _ in 0..60 {
        r.frame();
    }
    // The limit lowered the hips 3 cm after the IK ran, so the foot moved with them.
    let foot_at_a = [a[0], a[1] - 0.03, a[2]];
    close(
        r.pos(h, b::L_FOOT),
        foot_at_a,
        1e-4,
        "damp settled on the IK result",
    );
    let b_ = [0.15, 0.3, -0.1];
    set_target(&mut r.core, h, 0, b_, Q0, 1.0, 0.0, false);
    r.frame();
    let p = r.pos(h, b::L_FOOT);
    let gap = dist(foot_at_a, [b_[0], b_[1] - 0.03, b_[2]]);
    let moved = dist(p, foot_at_a);
    assert!(
        moved > 0.0 && moved < 0.25 * gap,
        "the foot trails ({moved} of {gap})"
    );
    for _ in 0..120 {
        r.frame();
    }
    close(
        r.pos(h, b::L_FOOT),
        [b_[0], b_[1] - 0.03, b_[2]],
        1e-3,
        "and catches up",
    );
    // Copy: the right hand sits 0.1 above the left (offset in the left hand's frame).
    let l = r.pos(h, b::L_HAND);
    close(
        r.pos(h, b::R_HAND),
        [l[0], l[1] + 0.1, l[2]],
        1e-5,
        "copied",
    );
    assert!(
        (r.pos(h, b::HIPS)[1] - 0.97).abs() < 1e-6,
        "hips clamped into the box"
    );
}

#[test]
fn limit_rotation_from_the_skeleton_and_explicit() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let left = leg_ik(&mut bld, src, NONE, 0, 0);
    let right = {
        use rg::two_bone::*;
        let mut v = block(1.0, NONE, 0, &[0; 8]);
        v[ROOT] = b::R_THIGH as u32;
        v[MID] = b::R_SHIN as u32;
        v[TIP] = b::R_FOOT as u32;
        v[TARGET] = 1;
        v[POLE] = NONE;
        v[MAX_STRETCH] = fb(1.0);
        rig_node(&mut bld, kind::TWO_BONE_IK, left, &v)
    };
    use rg::limit_rotation::*;
    let skel_limited = {
        let mut v = block(1.0, NONE, 0, &[0; 6]);
        v[SOURCE] = SOURCE_SKELETON;
        v[COUNT] = 1;
        v.push(common::rig::r(
            anim_retarget::profile::humanoid::LEFT_LOWER_LEG,
        ));
        rig_node(&mut bld, kind::LIMIT_ROTATION, right, &v)
    };
    let explicit = {
        let mut v = block(1.0, NONE, 0, &[0; 6]);
        v[SOURCE] = SOURCE_EXPLICIT;
        v[SWING_Y] = fb(10.0);
        v[SWING_Z] = fb(10.0);
        v[TWIST_MIN] = fb(-5.0);
        v[TWIST_MAX] = fb(5.0);
        v[COUNT] = 1;
        v.push(b::R_SHIN as u32);
        rig_node(&mut bld, kind::LIMIT_ROTATION, skel_limited, &v)
    };
    let h = r.instance(&mut bld, explicit, &[]);
    set_target(&mut r.core, h, 0, [0.1, 0.4, 0.25], Q0, 1.0, 0.0, false);
    set_target(&mut r.core, h, 1, [-0.1, 0.4, 0.25], Q0, 1.0, 0.0, false);
    r.frame();
    let (t, s) = (r.axis(h, b::L_THIGH, 1), r.axis(h, b::L_SHIN, 1));
    assert!(dot(t, s) > 1.0 - 1e-5, "locked range: the knee straightens");
    let (t, s) = (r.axis(h, b::R_THIGH, 1), r.axis(h, b::R_SHIN, 1));
    let angle = dot(t, s).clamp(-1.0, 1.0).acos().to_degrees();
    // The knee bends about local X, the twist axis: limited to the 5° twist range.
    assert!((angle - 5.0).abs() < 1e-2, "explicit twist range: {angle}°");
}

#[test]
fn stride_and_orientation_warps() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let left = leg_ik(&mut bld, src, NONE, 0, 0);
    let right = {
        use rg::two_bone::*;
        let mut v = block(1.0, NONE, 0, &[0; 8]);
        v[ROOT] = b::R_THIGH as u32;
        v[MID] = b::R_SHIN as u32;
        v[TIP] = b::R_FOOT as u32;
        v[TARGET] = 1;
        v[POLE] = NONE;
        v[TIP_MODE] = rg::two_bone::TIP_MAINTAIN;
        v[MAX_STRETCH] = fb(1.0);
        rig_node(&mut bld, kind::TWO_BONE_IK, left, &v)
    };
    let scale = bld.param("stride", ParamValue::Float(2.2));
    let stride = {
        use rg::stride::*;
        let mut v = block(1.0, NONE, 0, &[0; 15]);
        v[PELVIS] = b::HIPS as u32;
        v[SCALE] = fb(1.0);
        v[SCALE_PARAM] = scale;
        v[SPEED_PARAM] = NONE;
        v[DIRECTION + 2] = fb(1.0);
        v[DIRECTION_PARAM] = NONE;
        v[UP + 1] = fb(1.0);
        v[PELVIS_WEIGHT] = fb(1.0);
        v[MAX_PELVIS_DROP] = fb(0.2);
        v[MAX_REACH] = fb(0.999);
        v[COUNT] = 2;
        v.extend(
            [
                b::L_THIGH,
                b::L_SHIN,
                b::L_FOOT,
                b::R_THIGH,
                b::R_SHIN,
                b::R_FOOT,
            ]
            .map(|x| x as u32),
        );
        rig_node(&mut bld, kind::STRIDE_WARP, right, &v)
    };
    let angle = bld.param("turn", ParamValue::Float(0.5));
    let orient = {
        use rg::orientation::*;
        let mut v = block(1.0, NONE, 0, &[0; 9]);
        v[PELVIS] = b::HIPS as u32;
        v[ANGLE] = fb(0.0);
        v[ANGLE_PARAM] = angle;
        v[DIRECTION_PARAM] = NONE;
        v[MAX_ANGLE] = fb(1.0);
        v[UP + 1] = fb(1.0);
        v[COUNT] = 2;
        v.extend([b::SPINE as u32, b::CHEST as u32]);
        rig_node(&mut bld, kind::ORIENTATION_WARP, stride, &v)
    };
    let h = r.instance(&mut bld, stride, &[]);
    let h2 = {
        let bytes = bld.build(orient);
        instance(&mut r.core, &bytes, r.skel, &[]).1
    };
    for hh in [h, h2] {
        set_target(&mut r.core, hh, 0, [0.1, 0.15, 0.15], Q0, 1.0, 0.0, false);
        set_target(&mut r.core, hh, 1, [-0.1, 0.15, -0.15], Q0, 1.0, 0.0, false);
    }
    r.frame();
    // Stride 2.2 about the point under the pelvis, along +Z: ±0.15 → ±0.33; the pelvis drops so
    // the legs reach (analytic IK per leg: 1e-4 m).
    close(r.pos(h, b::L_FOOT), [0.1, 0.15, 0.33], 1e-4, "left stride");
    close(
        r.pos(h, b::R_FOOT),
        [-0.1, 0.15, -0.33],
        1e-4,
        "right stride",
    );
    assert!(r.pos(h, b::HIPS)[1] < 0.999, "pelvis dropped");
    // Orientation warp: the hips turn 0.5 rad about Y; the chest keeps facing +Z.
    let z = r.axis(h2, b::HIPS, 2);
    close(z, [0.5f32.sin(), 0.0, 0.5f32.cos()], 1e-5, "hips turned");
    close(
        r.axis(h2, b::CHEST, 2),
        [0.0, 0.0, 1.0],
        1e-5,
        "chest keeps facing",
    );
}

/// Integrates root deltas into the character transform (position, yaw), as the host does.
fn apply_root(core: &Core, h: u32, p: &mut [f32; 3], yaw: &mut f32) {
    let d = root(core, h);
    let (s, c) = yaw.sin_cos();
    // Rotate the delta's translation by the yaw about +Y.
    p[0] += c * d[0] + s * d[2];
    p[1] += d[1];
    p[2] += -s * d[0] + c * d[2];
    *yaw += 2.0 * d[4].atan2(d[6]);
}

#[test]
fn motion_warp_lands_on_target_at_window_end() {
    let mut r = setup();
    let clip = still_clip(
        &r.model,
        2.0,
        false,
        1.0,
        &[("vault", 0.5), ("vault.end", 1.5)],
    );
    let c = r.core.load_clip(&clip);
    let mut bld = Builder::new();
    let player = bld.player("vault");
    let (start, end) = (bld.s("vault"), bld.s("vault.end"));
    let mw = {
        use rg::motion_warp::*;
        let mut v = block(1.0, NONE, 0, &[0; 6]);
        v[WINDOW] = WINDOW_MARKERS;
        v[START] = start;
        v[END] = end;
        v[UP + 1] = fb(1.0);
        rig_node(&mut bld, kind::MOTION_WARP, player, &v)
    };
    let clip_id = bld.s("vault");
    let h = r.instance(&mut bld, mw, &[(clip_id, c)]);
    let dt = 1.0 / 30.0;
    let target = [0.6, 0.0, 1.8];
    let target_yaw = 0.4f32;
    let (mut p, mut yaw) = ([0.0f32; 3], 0.0f32);
    let mut t = 0.0f32;
    send(&mut r.core, &[warp(h, mw, target, target_yaw)]);
    let mut landed = false;
    for f in 0..55 {
        let (s, co) = (0.5 * yaw).sin_cos();
        set_character(&mut r.core, h, p, [0.0, s, 0.0, co]);
        if f > 0 {
            r.core.write_inputs(0);
        }
        r.core.evaluate(0, PASS_NORMAL, dt, dt);
        let before = p;
        apply_root(&r.core, h, &mut p, &mut yaw);
        t += dt;
        if t <= 0.5 - 1e-4 {
            // Before the window: the clip's own motion (1 m/s along +Z).
            close(
                sub(p, before),
                [0.0, 0.0, dt],
                1e-5,
                "unwarped before the window",
            );
        }
        if !landed && t >= 1.5 - 1e-4 {
            landed = true;
            // Smoothstep window, root-curve sampling, f32 integration over 45 frames: 1 mm.
            close(p, target, 1e-3, "lands on the target at the window's end");
            assert!((yaw - target_yaw).abs() < 1e-3, "with its yaw ({yaw})");
        }
    }
    assert!(landed);
    // After the window the clip's motion continues, turned by the warp's yaw.
    let before = p;
    let (s, co) = (0.5 * yaw).sin_cos();
    set_character(&mut r.core, h, p, [0.0, s, 0.0, co]);
    r.core.write_inputs(0);
    r.core.evaluate(0, PASS_NORMAL, dt, dt);
    apply_root(&r.core, h, &mut p, &mut yaw);
    let step = sub(p, before);
    close(
        step,
        [yaw.sin() * dt, 0.0, yaw.cos() * dt],
        1e-4,
        "clip motion after the window",
    );
}

#[test]
fn distance_match_drives_the_playback_rate() {
    let mut r = setup();
    let clip = still_clip(&r.model, 1.0, true, 1.0, &[]);
    let c = r.core.load_clip(&clip);
    let mut bld = Builder::new();
    let player = bld.player("walk");
    let speed = bld.param("speed", ParamValue::Float(1.5));
    let dm = {
        use rg::distance::*;
        let mut v = block(1.0, NONE, 0, &[0; 5]);
        v[MODE] = MODE_SPEED;
        v[PARAM] = speed;
        v[MIN_RATE] = fb(0.5);
        v[MAX_RATE] = fb(2.0);
        v[MARKER] = NONE;
        rig_node(&mut bld, kind::DISTANCE_MATCH, player, &v)
    };
    let walk = bld.s("walk");
    let h = r.instance(&mut bld, dm, &[(walk, c)]);
    let dt = 1.0 / 30.0;
    for _ in 0..3 {
        r.core.write_inputs(0);
        r.core.evaluate(0, PASS_NORMAL, dt, dt);
    }
    // The clip covers 1 m/s; at 1.5 m/s it plays at rate 1.5 (the root curve is linear: 1e-4).
    assert!(
        (root(&r.core, h)[2] - 1.5 * dt).abs() < 1e-4,
        "rate 1.5: {:?}",
        root(&r.core, h)
    );
    command_frame(&mut r.core, &[set_float(h, speed, 5.0)], dt);
    assert!(
        (root(&r.core, h)[2] - 2.0 * dt).abs() < 1e-4,
        "clamped at 2"
    );
    // Across the loop seam the travel stays matched.
    command_frame(&mut r.core, &[set_float(h, speed, 1.2)], dt);
    for _ in 0..40 {
        r.core.write_inputs(0);
        r.core.evaluate(0, PASS_NORMAL, dt, dt);
        assert!(
            (root(&r.core, h)[2] - 1.2 * dt).abs() < 1e-4,
            "{:?}",
            root(&r.core, h)
        );
    }
}

#[test]
fn snapshot_restore_is_exact_with_rig_state() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let g = rig_node(&mut bld, kind::GROUNDER, src, &grounder_block(0));
    let s = rig_node(&mut bld, kind::SPRING_CHAIN, g, &spring_block(0));
    let d = {
        use rg::damp::*;
        let mut v = block(1.0, NONE, 0, &[0; 3]);
        v[BONE] = b::HEAD as u32;
        v[POSITION_HALF_LIFE] = fb(0.2);
        v[ROTATION_HALF_LIFE] = fb(0.2);
        rig_node(&mut bld, kind::DAMP, s, &v)
    };
    let look = rig_node(
        &mut bld,
        kind::LOOK_AT,
        d,
        &aim_block(
            false,
            0,
            [0.0, 0.0, 1.0],
            &[(b::NECK, 0.5), (b::HEAD, 1.0)],
            0,
        ),
    );
    let bytes = bld.build(look);
    let (gh, a) = instance(&mut r.core, &bytes, r.skel, &[]);
    let b2 = r.core.create_instance(0, r.skel, gh);
    // The inputs of frame f (the hits a host would cast under the feet: x = ±0.1).
    let drive = |r: &mut Rig, h: u32, f: usize| {
        let t = f as f32 * DT;
        set_character(&mut r.core, h, [0.4 * (2.0 * t).sin(), 0.0, 0.3 * t], Q0);
        set_target(
            &mut r.core,
            h,
            0,
            [(3.0 * t).sin(), 1.7, 1.0],
            Q0,
            1.0,
            0.0,
            false,
        );
        let n = norm([-0.5, 1.0, 0.0]);
        for (i, x) in [0.1f32, -0.1].iter().enumerate() {
            let y = 0.5 * x + 0.05 * (5.0 * t).sin();
            set_hit(&mut r.core, h, i, [*x, y, 0.0], n, f % 7 != 3);
        }
    };
    for f in 0..40 {
        drive(&mut r, a, f);
        r.frame();
    }
    let mut snap = vec![0u8; r.core.snapshot_bytes(a) as usize];
    assert_eq!(r.core.snapshot(a, &mut snap), 0);
    let mut expect = Vec::new();
    for f in 40..80 {
        drive(&mut r, a, f);
        r.frame();
        expect.push(matrices(&r.core, a, MB, b::COUNT));
    }
    assert_eq!(r.core.restore(b2, &snap), 0);
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    for (k, f) in (40..80).enumerate() {
        drive(&mut r, b2, f);
        r.frame();
        let m = matrices(&r.core, b2, MB, b::COUNT);
        assert_eq!(
            bits(&m),
            bits(&expect[k]),
            "frame {f}: restored instance matches bit for bit"
        );
    }
    // And the state really moved (the comparison isn't of a static pose).
    assert_ne!(bits(&expect[0]), bits(&expect[39]));
}

#[test]
fn rig_nodes_are_active_in_the_debug_report() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let ik = leg_ik(&mut bld, src, NONE, 0, 0);
    let s = rig_node(&mut bld, kind::SPRING_CHAIN, ik, &spring_block(0));
    let h = r.instance(&mut bld, s, &[]);
    command_frame(&mut r.core, &[debug_on(h)], DT);
    let rep = report(&mut r.core, h);
    assert_eq!(rep.weight(s), 1.0);
    assert_eq!(rep.weight(ik), 1.0);
    assert_eq!(rep.weight(src), 1.0);
}

#[test]
fn commands_refuse_wrong_nodes_and_bad_blocks_load_as_unknown() {
    let mut r = setup();
    let mut bld = Builder::new();
    let src = rest_source(&mut bld);
    let ik = leg_ik(&mut bld, src, NONE, 0, 0);
    // A CCD chain longer than its scratch: passes through, reported at load.
    let mut long = chain_block(0, 0, &[1; 3]);
    long[rg::chain::COUNT] = (rg::MAX_CHAIN + 1) as u32;
    long.extend(vec![1; rg::MAX_CHAIN]);
    let bad = rig_node(&mut bld, kind::CCD, ik, &long);
    let bytes = bld.build(bad);
    let g = r.core.load_graph(&bytes);
    assert_ne!(g, 0);
    assert_eq!(r.core.last_status(), STATUS_UNKNOWN_NODES);
    let h = r.core.create_instance(0, r.skel, g);
    set_target(&mut r.core, h, 0, [0.15, 0.3, 0.2], Q0, 1.0, 0.0, false);
    send(
        &mut r.core,
        &[
            warp(h, ik, [0.0; 3], 0.0),
            warp(h, 99, [0.0; 3], 0.0),
            reset(h, ik),
        ],
    );
    let c = changes(&r.core);
    let refused: Vec<_> = c.iter().filter(|x| x.kind == CHANGE_REFUSED).collect();
    assert_eq!(refused.len(), 2);
    assert_eq!((refused[0].layer, refused[0].status), (ik, STATUS_MISMATCH));
    assert_eq!((refused[1].layer, refused[1].status), (99, STATUS_NO_SUCH));
    r.core.evaluate(0, PASS_NORMAL, DT, DT);
    close(
        r.pos(h, b::L_FOOT),
        [0.15, 0.3, 0.2],
        1e-4,
        "the bad node passes its input through",
    );
    // An implicit-graph instance refuses rig commands.
    let imp = r.core.create_instance(0, r.skel, 0);
    send(&mut r.core, &[reset(imp, 0)]);
    assert_eq!(changes(&r.core)[0].status, STATUS_MISMATCH);
}
