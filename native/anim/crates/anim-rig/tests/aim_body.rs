//! Look-at and aim (limits, clamp, weight distribution, up axis) and full-body IK (effectors in
//! tree poses, root effector, centre-of-mass pull, rotations).
//!
//! Look-at against `anim-offline::rig::look_at`: rotations within 1e-4 rad (a few f32 slerps and
//! polynomial `atan2`/`sin_cos`, each ~3e-7, plus the shortest-arc formula's ~1e-7).

mod common;

use anim_math::{AosQuat, AosVec3};
use anim_offline::rig as r;
use anim_rig::aim::{aim, look_at, AimAxes, AimGoal, AimJoint};
use anim_rig::full_body::{full_body, scratch_len, BodyChain, CentreOfMass, Effector, FullBodyGoal};
use anim_rig::geom::angle_between;
use anim_rig::ChainJoint;
use common::*;

const PI: f32 = core::f32::consts::PI;

fn joint(bone: u16, weight: f32) -> AimJoint {
    AimJoint {
        bone,
        weight,
        limit: PI,
        axes: AimAxes::default(),
    }
}

/// Spine (1), neck (2), head (3) stacked along +Y under a root, all facing +Z.
fn spine() -> Rig {
    Rig::new(
        vec![u16::MAX, 0, 1, 2],
        &[tr(0.0, 1.0, 0.0), tr(0.0, 0.1, 0.0), tr(0.0, 0.3, 0.0), tr(0.0, 0.15, 0.0)],
    )
}

fn forward(rig: &Rig, b: usize) -> AosVec3 {
    rig.rot(b).rotate(v3(0.0, 0.0, 1.0))
}

#[test]
fn look_at_points_the_last_joint_at_the_target_and_matches_reference() {
    for target in [v3(1.0, 1.8, 2.0), v3(-2.0, 1.2, 0.5), v3(0.3, 2.5, -1.0)] {
        let mut rig = spine();
        let joints = [joint(1, 0.3), joint(2, 0.5), joint(3, 1.0)];
        let refj: Vec<r::AimJoint> = joints
            .iter()
            .map(|j| r::AimJoint {
                position: v64(rig.pos(j.bone as usize)),
                rotation: q64(rig.rot(j.bone as usize)),
                forward: v64(j.axes.forward),
                weight: j.weight as f64,
                limit: j.limit as f64,
            })
            .collect();
        let mut scratch = vec![ChainJoint::default(); 3];
        look_at(&mut rig.pose(), &joints, &AimGoal::new(target), &mut scratch);
        let to_t = target - rig.pos(3);
        assert!(angle_between(forward(&rig, 3), to_t) < 1e-4, "head looks at the target");
        let want = r::look_at(&refj, v64(target));
        for (k, j) in joints.iter().enumerate() {
            let a = quat_angle64(rig.rot(j.bone as usize), want[k]);
            assert!(a < 1e-4, "joint {k}: {a} rad from the reference");
        }
    }
}

#[test]
fn look_at_shares_the_turn_by_weight() {
    // Co-located joints, a target 90° to the side: shares w1·θ, w2·(1 − w1)·θ, rest.
    let mut rig = Rig::new(
        vec![u16::MAX, 0, 1, 2],
        &[tr(0.0, 0.0, 0.0), tr(0.0, 0.0, 0.0), tr(0.0, 0.0, 0.0), tr(0.0, 0.0, 0.0)],
    );
    let joints = [joint(1, 0.3), joint(2, 0.5), joint(3, 1.0)];
    let mut scratch = vec![ChainJoint::default(); 3];
    look_at(&mut rig.pose(), &joints, &AimGoal::new(v3(10.0, 0.0, 0.0)), &mut scratch);
    let theta = PI / 2.0;
    let shares = [0.3 * theta, 0.5 * 0.7 * theta, 0.35 * theta];
    for (k, s) in shares.iter().enumerate() {
        let a = anim_rig::geom::rotation_angle(rig.local(k + 1).rotation);
        assert!((a - s).abs() < 1e-4, "joint {k}: {a} vs {s}");
    }
}

#[test]
fn look_at_limits_and_clamp() {
    // Per-joint limit.
    let mut rig = spine();
    let mut joints = [joint(1, 1.0), joint(2, 1.0), joint(3, 1.0)];
    for j in joints.iter_mut() {
        j.limit = 10f32.to_radians();
    }
    joints[0].weight = 0.5;
    let mut scratch = vec![ChainJoint::default(); 3];
    look_at(&mut rig.pose(), &joints, &AimGoal::new(v3(5.0, 1.5, 0.0)), &mut scratch);
    for k in 1..4 {
        let a = anim_rig::geom::rotation_angle(rig.local(k).rotation);
        assert!(a <= 10f32.to_radians() + 1e-5, "joint {k} turned {a}");
    }
    // Clamp cone: the head ends at most max_angle from its animated forward.
    let mut rig = spine();
    let joints = [joint(1, 0.3), joint(2, 0.5), joint(3, 1.0)];
    // Behind and far (so the joints' own offsets, ≤ 0.55, shift the view by under 0.006 rad).
    let mut goal = AimGoal::new(v3(0.0, 21.5, -100.0));
    goal.max_angle = 60f32.to_radians();
    look_at(&mut rig.pose(), &joints, &goal, &mut scratch);
    let a = angle_between(forward(&rig, 3), v3(0.0, 0.0, 1.0));
    assert!((a - 60f32.to_radians()).abs() < 6e-3, "clamped to the cone: {a}");
}

#[test]
fn look_at_up_axis_and_weight() {
    let mut rig = Rig::new(
        vec![u16::MAX, 0],
        &[tr(0.0, 0.0, 0.0), trq(0.0, 0.0, 0.0, axis_angle(0.0, 0.0, 1.0, 40.0))],
    );
    let joints = [joint(1, 1.0)];
    let mut goal = AimGoal::new(v3(0.0, 0.0, 5.0));
    goal.up = v3(0.0, 1.0, 0.0);
    goal.up_weight = 1.0;
    let mut scratch = vec![ChainJoint::default(); 1];
    look_at(&mut rig.pose(), &joints, &goal, &mut scratch);
    let up = rig.rot(1).rotate(v3(0.0, 1.0, 0.0));
    assert!(angle_between(up, v3(0.0, 1.0, 0.0)) < 1e-4, "rolled upright: {up:?}");
    // Weight 0 changes nothing.
    let mut rig = spine();
    let orig = rig.clone_rig();
    let joints = [joint(1, 0.3), joint(2, 0.5), joint(3, 1.0)];
    let mut goal = AimGoal::new(v3(3.0, 0.0, 0.0));
    goal.weight = 0.0;
    let mut scratch = vec![ChainJoint::default(); 3];
    look_at(&mut rig.pose(), &joints, &goal, &mut scratch);
    assert!(same_pose(&rig, &orig));
}

#[test]
fn aim_points_an_offset_axis_at_the_target() {
    // Spine (1), shoulder (2), and a gun (3) held 0.3 to the side and 0.4 forward.
    let mut rig = Rig::new(
        vec![u16::MAX, 0, 1, 2],
        &[tr(0.0, 1.0, 0.0), tr(0.0, 0.2, 0.0), tr(0.0, 0.3, 0.0), tr(0.3, -0.1, 0.4)],
    );
    let joints = [joint(1, 0.5), joint(2, 1.0)];
    let mut goal = AimGoal::new(v3(-2.0, 2.5, 3.0));
    goal.iterations = 10;
    let mut scratch = vec![ChainJoint::default(); 3];
    let err = aim(&mut rig.pose(), &joints, 3, AimAxes::default(), &goal, &mut scratch);
    let f = forward(&rig, 3);
    let real = angle_between(f, goal.target - rig.pos(3));
    assert!(real < 1e-3 && (real - err).abs() < 1e-4, "aim error {real} (reported {err})");
}

// ---------------------------------------------------------------------------------------------
// Full body

const SPINE: [u16; 3] = [0, 1, 2];
const NECK: [u16; 3] = [2, 3, 4];
const LARM: [u16; 4] = [2, 5, 6, 7];
const RARM: [u16; 4] = [2, 8, 9, 10];
const LLEG: [u16; 4] = [0, 11, 12, 13];
const RLEG: [u16; 4] = [0, 14, 15, 16];

fn chains() -> [BodyChain<'static>; 6] {
    [
        BodyChain { bones: &SPINE, parent: None },
        BodyChain { bones: &NECK, parent: Some(0) },
        BodyChain { bones: &LARM, parent: Some(0) },
        BodyChain { bones: &RARM, parent: Some(0) },
        BodyChain { bones: &LLEG, parent: None },
        BodyChain { bones: &RLEG, parent: None },
    ]
}

fn goal<'a>(effectors: &'a [Effector]) -> FullBodyGoal<'a> {
    FullBodyGoal {
        root: Effector::NONE,
        effectors,
        centre_of_mass: None,
        body_pull: 0.0,
        iterations: 32,
        tolerance: 1e-4,
        weight: 1.0,
    }
}

fn run(rig: &mut Rig, g: &FullBodyGoal) -> anim_rig::full_body::FullBodyResult {
    let ch = chains();
    let mut scratch = vec![ChainJoint::default(); scratch_len(&ch)];
    full_body(&mut rig.pose(), 0, &ch, g, &mut scratch)
}

fn assert_lengths_kept(a: &Rig, b: &Rig) {
    for (i, &p) in a.parents.iter().enumerate() {
        if p != u16::MAX {
            let la = dist(a.pos(i), a.pos(p as usize));
            let lb = dist(b.pos(i), b.pos(p as usize));
            assert!((la - lb).abs() < 1e-4, "bone {i}: {la} vs {lb}");
        }
    }
}

fn planted(rig: &Rig) -> [Effector; 6] {
    let mut e = [Effector::NONE; 6];
    e[4] = Effector::at(rig.pos(13));
    e[5] = Effector::at(rig.pos(16));
    e
}

#[test]
fn full_body_no_effectors_keeps_the_pose() {
    let mut rig = humanoid();
    let orig = humanoid();
    let e = [Effector::NONE; 6];
    run(&mut rig, &goal(&e));
    for i in 0..17 {
        assert_close(rig.pos(i), orig.pos(i), 1e-5, "bone");
    }
}

#[test]
fn full_body_reaches_hand_effectors_with_feet_planted() {
    let mut rig = humanoid();
    let orig = humanoid();
    let mut e = planted(&rig);
    let lt = orig.pos(7) + v3(-0.1, 0.15, 0.2);
    let rt = orig.pos(10) + v3(0.05, -0.1, 0.25);
    e[2] = Effector::at(lt);
    e[3] = Effector::at(rt);
    let res = run(&mut rig, &goal(&e));
    assert!(res.error < 1e-3, "{res:?}");
    assert_close(rig.pos(7), lt, 1e-3, "left hand");
    assert_close(rig.pos(10), rt, 1e-3, "right hand");
    assert_close(rig.pos(13), orig.pos(13), 1e-3, "left foot");
    assert_close(rig.pos(16), orig.pos(16), 1e-3, "right foot");
    assert_lengths_kept(&rig, &orig);
    assert_finite(&rig);
}

#[test]
fn full_body_root_effector_and_body_pull() {
    // Hips down 8 cm with the feet planted: the knees bend, the feet stay.
    let mut rig = humanoid();
    let orig = humanoid();
    let mut e = planted(&rig);
    let mut g = goal(&e);
    g.root = Effector::at(orig.pos(0) - v3(0.0, 0.08, 0.0));
    let res = run(&mut rig, &g);
    assert!(res.error < 1e-3);
    assert_close(rig.pos(0), orig.pos(0) - v3(0.0, 0.08, 0.0), 1e-5, "hips");
    assert_close(rig.pos(13), orig.pos(13), 1e-3, "left foot");
    assert_lengths_kept(&rig, &orig);
    // A hand pulled far with body pull drags the hips; without it the hips stay.
    let far = orig.pos(7) + v3(0.6, 0.0, 0.0);
    e = [Effector::NONE; 6];
    e[2] = Effector::at(far);
    let mut a = humanoid();
    run(&mut a, &goal(&e));
    assert_close(a.pos(0), orig.pos(0), 1e-6, "no pull: hips stay");
    let mut b = humanoid();
    let mut g = goal(&e);
    g.body_pull = 1.0;
    run(&mut b, &g);
    assert!(b.pos(0).x > orig.pos(0).x + 0.05, "pulled toward the hand: {:?}", b.pos(0));
    assert!(dist(b.pos(7), far) < dist(a.pos(7), far), "the pull gets the hand closer");
}

#[test]
fn full_body_centre_of_mass_pull_moves_the_body_toward_the_target() {
    let mut rig = humanoid();
    let orig = humanoid();
    let e = planted(&rig);
    let com = |rig: &Rig| {
        let mut s = AosVec3::zero();
        for i in 0..17 {
            s = s + rig.pos(i);
        }
        s.scale(1.0 / 17.0)
    };
    let c0 = com(&orig);
    let mut g = goal(&e);
    g.centre_of_mass = Some(CentreOfMass {
        target: c0 + v3(0.03, 0.3, 0.0),
        weight: 1.0,
        masses: &[],
        up: v3(0.0, 1.0, 0.0),
    });
    let res = run(&mut rig, &g);
    assert!(res.error < 1e-3, "{res:?}");
    let c1 = com(&rig);
    assert!((c1.x - c0.x - 0.03).abs() < 2e-3, "COM moved to the target's x: {} → {}", c0.x, c1.x);
    assert!(rig.pos(0).x > orig.pos(0).x, "hips moved toward +X");
    assert!((c1.y - c0.y).abs() < 0.02, "pull is horizontal only: {} → {}", c0.y, c1.y);
    assert_close(rig.pos(13), orig.pos(13), 2e-3, "left foot planted");
    assert_close(rig.pos(16), orig.pos(16), 2e-3, "right foot planted");
    // Half weight moves it about half as far.
    let mut half = humanoid();
    let mut g2 = g;
    g2.centre_of_mass = Some(CentreOfMass {
        weight: 0.5,
        ..g.centre_of_mass.unwrap()
    });
    run(&mut half, &g2);
    let ch = com(&half);
    assert!(ch.x - c0.x > 0.25 * (c1.x - c0.x) && ch.x - c0.x < 0.75 * (c1.x - c0.x));
}

#[test]
fn full_body_effector_rotation_and_root_rotation() {
    let mut rig = humanoid();
    let mut e = [Effector::NONE; 6];
    let q = axis_angle(0.0, 1.0, 0.0, 35.0);
    e[1] = Effector {
        rotation: q,
        rotation_weight: 1.0,
        ..Effector::NONE
    };
    let mut g = goal(&e);
    let turn = axis_angle(0.0, 1.0, 0.0, 20.0);
    g.root = Effector {
        rotation: turn,
        rotation_weight: 1.0,
        ..Effector::NONE
    };
    run(&mut rig, &g);
    assert!(quat_angle(rig.rot(4), q) < 1e-5, "head takes its effector rotation");
    // The hips turned with the body (three children: spine exactly, thighs about it).
    assert!(quat_angle(rig.rot(0), turn) < 1e-3, "hips: {}", quat_angle(rig.rot(0), turn));
    let _ = AosQuat::identity();
}

#[test]
fn full_body_weight_blends_locals() {
    let orig = humanoid();
    let mut full = humanoid();
    let mut half = humanoid();
    let mut e = planted(&orig);
    e[2] = Effector::at(orig.pos(7) + v3(0.0, 0.2, 0.2));
    let mut g = goal(&e);
    run(&mut full, &g);
    g.weight = 0.5;
    run(&mut half, &g);
    for b in [5usize, 6, 11, 12] {
        let want = orig.local(b).rotation.nlerp(full.local(b).rotation, 0.5);
        assert!(quat_angle(half.local(b).rotation, want) < 1e-6, "bone {b}");
    }
}
