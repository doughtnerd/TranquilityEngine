//! Two-bone, CCD and FABRIK: reach, singular configurations, poles, soft IK, stretch, tip
//! rotation, weights, convergence, tolerance and joint limits, against `anim-offline::rig`.
//!
//! Tolerances against the f64 reference: positions within 2e-5 for the analytic two-bone solve
//! (a few f32 roundings of unit-length vectors, each ≤ 6e-8, plus the 1e-7-level differences
//! between a projected knee and an `acos` knee); 2e-4 for the iterative solvers, whose dozens of
//! f32 rotations each add ~1e-7 and whose path depends on them.

mod common;

use anim_math::{AosQuat, AosVec3};
use anim_offline::rig as r;
use anim_rig::chain::{ccd, fabrik, ChainGoal};
use anim_rig::two_bone::{two_bone, Pole, TipRotation, TwoBone, TwoBoneGoal};
use anim_rig::{ChainJoint, JointLimit};
use common::*;

const LIMB: TwoBone = TwoBone {
    root: 1,
    mid: 2,
    tip: 3,
};

fn solve(rig: &mut Rig, goal: &TwoBoneGoal) -> anim_rig::two_bone::TwoBoneResult {
    let mut p = rig.pose();
    two_bone(&mut p, LIMB, goal)
}

fn lengths(rig: &Rig) -> (f32, f32) {
    (dist(rig.pos(1), rig.pos(2)), dist(rig.pos(2), rig.pos(3)))
}

#[test]
fn two_bone_reaches_targets_inside_reach() {
    for target in [
        v3(1.2, 0.8, 0.3),
        v3(0.5, -0.9, 0.4),
        v3(-0.3, 0.6, -1.1),
        v3(0.2, 0.1, 0.05),
    ] {
        let mut rig = arm();
        let (a, b, c) = (rig.pos(1), rig.pos(2), rig.pos(3));
        solve(&mut rig, &TwoBoneGoal::new(target));
        assert_close(rig.pos(3), target, 1e-5, "tip");
        let (la, lb) = lengths(&rig);
        assert!(
            (la - 1.0).abs() < 1e-5 && (lb - 1.0).abs() < 1e-5,
            "lengths {la} {lb}"
        );
        let (mid, tip) = r::two_bone(v64(a), v64(b), v64(c), v64(target), None);
        assert!(
            dist64(rig.pos(2), mid) < 2e-5,
            "mid vs reference: {:?} {mid:?}",
            rig.pos(2)
        );
        assert!(dist64(rig.pos(3), tip) < 2e-5);
        // The lazy cache agrees with a full recompute.
        let fresh = rig.fresh_model();
        for (i, f) in fresh.iter().enumerate() {
            assert_close(rig.model[i].translation, f.translation, 1e-6, "cache");
        }
    }
}

#[test]
fn two_bone_outside_reach_straightens_toward_the_target() {
    let mut rig = arm();
    let target = v3(3.0, 2.0, -1.0);
    let res = solve(&mut rig, &TwoBoneGoal::new(target));
    let dir = target.scale(1.0 / target.length());
    assert_close(rig.pos(3), dir.scale(2.0), 2e-5, "tip at full reach");
    assert_close(rig.pos(2), dir, 2e-5, "mid on the line");
    assert!((res.reach - 2.0).abs() < 1e-6);
    let (mid, tip) = r::two_bone(
        v64(v3(0.0, 0.0, 0.0)),
        v64(arm().pos(2)),
        v64(arm().pos(3)),
        v64(target),
        None,
    );
    assert!(dist64(rig.pos(2), mid) < 2e-5 && dist64(rig.pos(3), tip) < 2e-5);
    assert_finite(&rig);
}

#[test]
fn two_bone_target_closer_than_fold_folds_fully() {
    let mut rig = Rig::new(
        vec![u16::MAX, 0, 1, 2],
        &[
            tr(0.0, 0.0, 0.0),
            tr(0.0, 0.0, 0.0),
            trq(1.0, 0.0, 0.0, axis_angle(0.0, 0.0, 1.0, 20.0)),
            tr(0.6, 0.0, 0.0),
        ],
    );
    let target = v3(0.1, 0.1, 0.0);
    solve(&mut rig, &TwoBoneGoal::new(target));
    // |a − b| = 0.4: the tip lands 0.4 from the root toward the target.
    let dir = target.scale(1.0 / target.length());
    assert_close(rig.pos(3), dir.scale(0.4), 2e-5, "folded tip");
    assert_finite(&rig);
}

#[test]
fn two_bone_singular_straight_arm() {
    // Straight arm, target inside reach on the arm's own line, no pole: the bend direction is
    // degenerate and falls back to a fixed perpendicular.
    let mut rig = straight_arm();
    let target = v3(1.5, 0.0, 0.0);
    solve(&mut rig, &TwoBoneGoal::new(target));
    assert_close(rig.pos(3), target, 1e-5, "tip");
    let (la, lb) = lengths(&rig);
    assert!((la - 1.0).abs() < 1e-5 && (lb - 1.0).abs() < 1e-5);
    assert_finite(&rig);
    // With a pole the bend goes that way, as in the reference.
    for pole in [v3(0.0, 1.0, 0.0), v3(0.0, 0.0, -1.0)] {
        let mut rig = straight_arm();
        let mut goal = TwoBoneGoal::new(target);
        goal.pole = Pole::Direction(pole);
        solve(&mut rig, &goal);
        let (mid, _) = r::two_bone(
            v64(v3(0.0, 0.0, 0.0)),
            v64(v3(1.0, 0.0, 0.0)),
            v64(v3(2.0, 0.0, 0.0)),
            v64(target),
            Some(v64(pole)),
        );
        assert!(
            dist64(rig.pos(2), mid) < 2e-5,
            "{:?} vs {mid:?}",
            rig.pos(2)
        );
        assert!(rig.pos(2).dot(pole) > 0.5);
    }
    // Target exactly on the root: finite, lengths kept.
    let mut rig = straight_arm();
    solve(&mut rig, &TwoBoneGoal::new(v3(0.0, 0.0, 0.0)));
    assert_finite(&rig);
}

#[test]
fn two_bone_pole_flips_the_bend() {
    let target = v3(1.2, 0.0, 0.5);
    for (pole, sign) in [(v3(0.0, 1.0, 0.0), 1.0f32), (v3(0.0, -1.0, 0.0), -1.0)] {
        for kind in 0..2 {
            let mut rig = arm();
            let mut goal = TwoBoneGoal::new(target);
            goal.pole = if kind == 0 {
                Pole::Direction(pole)
            } else {
                Pole::Position(pole.scale(3.0))
            };
            solve(&mut rig, &goal);
            assert_close(rig.pos(3), target, 1e-5, "tip");
            assert!(
                rig.pos(2).y * sign > 0.3,
                "mid on the pole's side: {:?}",
                rig.pos(2)
            );
            let (mid, _) = r::two_bone(
                v64(v3(0.0, 0.0, 0.0)),
                v64(arm().pos(2)),
                v64(arm().pos(3)),
                v64(target),
                Some(v64(pole)),
            );
            assert!(dist64(rig.pos(2), mid) < 2e-5);
        }
    }
}

#[test]
fn two_bone_soft_ik_eases_into_full_reach() {
    let soft = 0.1;
    let mut last = 0.0f32;
    for i in 0..60 {
        let d = 1.5 + i as f32 * 0.02;
        let mut rig = arm();
        let mut goal = TwoBoneGoal::new(v3(d, 0.0, 0.0));
        goal.soft = soft;
        let res = solve(&mut rig, &goal);
        let want = r::soft_reach(d as f64, 2.0, soft as f64);
        assert!(
            (res.reach as f64 - want).abs() < 2e-6,
            "reach at {d}: {} vs {want}",
            res.reach
        );
        assert!(
            res.reach < 2.0 && res.reach >= last,
            "monotone, never straight"
        );
        assert!((dist(rig.pos(3), v3(0.0, 0.0, 0.0)) - res.reach).abs() < 1e-5);
        last = res.reach;
    }
    // Below the band it is hard IK.
    let mut rig = arm();
    let mut goal = TwoBoneGoal::new(v3(1.0, 0.5, 0.0));
    goal.soft = soft;
    solve(&mut rig, &goal);
    assert_close(rig.pos(3), v3(1.0, 0.5, 0.0), 1e-5, "inside the band start");
}

#[test]
fn two_bone_stretch_reaches_past_full_length() {
    let mut rig = arm();
    let mut goal = TwoBoneGoal::new(v3(2.4, 0.0, 0.0));
    goal.max_stretch = 1.5;
    let res = solve(&mut rig, &goal);
    assert!((res.stretch - 1.2).abs() < 1e-5);
    assert_close(rig.pos(3), v3(2.4, 0.0, 0.0), 1e-4, "stretched tip");
    // Capped.
    let mut rig = arm();
    goal.target = v3(4.0, 0.0, 0.0);
    let res = solve(&mut rig, &goal);
    assert!((res.stretch - 1.5).abs() < 1e-6);
    assert_close(rig.pos(3), v3(3.0, 0.0, 0.0), 1e-4, "capped stretch");
    // Soft and stretch together still reach the target.
    let mut rig = arm();
    goal.target = v3(1.95, 0.0, 0.0);
    goal.soft = 0.1;
    solve(&mut rig, &goal);
    assert_close(rig.pos(3), v3(1.95, 0.0, 0.0), 1e-4, "soft + stretch");
}

#[test]
fn two_bone_tip_rotation_options() {
    let target = v3(1.0, 1.0, 0.2);
    // Inherit: the tip's local rotation is unchanged.
    let mut rig = arm();
    let before = rig.local(3).rotation;
    solve(&mut rig, &TwoBoneGoal::new(target));
    assert!(quat_angle(rig.local(3).rotation, before) < 1e-6);
    // Maintain: the tip's model rotation is unchanged.
    let mut rig = arm();
    let before = rig.rot(3);
    let mut goal = TwoBoneGoal::new(target);
    goal.tip_rotation = TipRotation::Maintain;
    solve(&mut rig, &goal);
    assert!(quat_angle(rig.rot(3), before) < 1e-5, "maintained");
    // Target: the tip takes the given model rotation.
    let q = axis_angle(1.0, 2.0, 0.5, 70.0);
    let mut rig = arm();
    goal.tip_rotation = TipRotation::Target(q);
    solve(&mut rig, &goal);
    assert!(quat_angle(rig.rot(3), q) < 1e-5, "targeted");
}

#[test]
fn two_bone_weight_blends_locals() {
    let target = v3(0.4, 1.2, 0.6);
    let mut rig = arm();
    let orig = rig.clone_rig();
    let mut goal = TwoBoneGoal::new(target);
    goal.weight = 0.0;
    solve(&mut rig, &goal);
    assert!(same_pose(&rig, &orig), "weight 0 leaves the pose untouched");
    let mut full = arm();
    goal.weight = 1.0;
    solve(&mut full, &goal);
    let mut half = arm();
    goal.weight = 0.5;
    solve(&mut half, &goal);
    for b in [1usize, 2] {
        let want = orig.local(b).rotation.nlerp(full.local(b).rotation, 0.5);
        assert!(quat_angle(half.local(b).rotation, want) < 1e-6, "bone {b}");
    }
}

fn chain_bones(n: usize) -> Vec<u16> {
    (1..=n as u16).collect()
}

fn positions(rig: &Rig, chain: &[u16]) -> Vec<anim_offline::math::Vec3> {
    chain.iter().map(|&b| v64(rig.pos(b as usize))).collect()
}

#[test]
fn ccd_converges_within_tolerance_and_matches_reference() {
    let chain = chain_bones(5);
    for target in [v3(2.0, 1.5, 0.5), v3(-1.0, 2.0, 1.0), v3(1.0, -1.0, -2.0)] {
        let mut rig = bent_chain(5, 0.8, 15.0);
        let start = positions(&rig, &chain);
        let mut scratch = vec![ChainJoint::default(); 5];
        let mut goal = ChainGoal::new(target);
        goal.tolerance = 1e-4;
        goal.iterations = 64;
        let res = {
            let mut p = rig.pose();
            ccd(&mut p, &chain, &[], &goal, &mut scratch)
        };
        assert!(res.error <= 1e-4, "converged: {res:?}");
        assert_close(rig.pos(5), target, 1.1e-4, "tip");
        let (refp, refit, _) = r::ccd(&start, v64(target), res.iterations, 0.0);
        assert_eq!(refit, res.iterations);
        for (j, &b) in chain.iter().enumerate() {
            assert!(dist64(rig.pos(b as usize), refp[j]) < 2e-4, "joint {j}");
        }
        for j in 1..5 {
            let l = dist(rig.pos(j), rig.pos(j + 1));
            assert!((l - 0.8).abs() < 1e-5, "length kept");
        }
    }
}

#[test]
fn ccd_error_never_grows_and_stops_at_tolerance() {
    let chain = chain_bones(4);
    let target = v3(1.0, 1.8, 0.7);
    let mut last = f32::INFINITY;
    for it in 0..12 {
        let mut rig = bent_chain(4, 0.8, 10.0);
        let mut scratch = vec![ChainJoint::default(); 4];
        let mut goal = ChainGoal::new(target);
        goal.iterations = it;
        goal.tolerance = 0.0;
        let res = {
            let mut p = rig.pose();
            ccd(&mut p, &chain, &[], &goal, &mut scratch)
        };
        assert!(
            res.error <= last + 1e-6,
            "iteration {it}: {} > {last}",
            res.error
        );
        last = res.error;
    }
    // A loose tolerance stops early.
    let mut rig = bent_chain(4, 0.8, 10.0);
    let mut scratch = vec![ChainJoint::default(); 4];
    let mut goal = ChainGoal::new(target);
    goal.tolerance = 0.05;
    let res = {
        let mut p = rig.pose();
        ccd(&mut p, &chain, &[], &goal, &mut scratch)
    };
    assert!(res.error <= 0.05 && res.iterations < 16);
    // Already there: nothing runs, nothing changes.
    let mut rig = bent_chain(4, 0.8, 10.0);
    let orig = rig.clone_rig();
    goal.target = rig.pos(4);
    let res = {
        let mut p = rig.pose();
        ccd(&mut p, &chain, &[], &goal, &mut scratch)
    };
    assert_eq!(res.iterations, 0);
    assert!(same_pose(&rig, &orig));
}

#[test]
fn ccd_and_fabrik_unreachable_straighten() {
    let chain = chain_bones(4);
    let target = v3(5.0, 3.0, 0.0);
    let dir = target.scale(1.0 / target.length());
    for which in 0..2 {
        let mut rig = bent_chain(4, 0.8, 10.0);
        let mut scratch = vec![ChainJoint::default(); 4];
        let mut goal = ChainGoal::new(target);
        goal.iterations = 200;
        let res = {
            let mut p = rig.pose();
            if which == 0 {
                ccd(&mut p, &chain, &[], &goal, &mut scratch)
            } else {
                fabrik(&mut p, &chain, &[], &goal, &mut scratch)
            }
        };
        let reach = target.length() - 2.4;
        assert!(
            (res.error - reach).abs() < 2e-3,
            "solver {which}: {}",
            res.error
        );
        assert_close(
            rig.pos(4),
            dir.scale(2.4),
            3e-3,
            "straight toward the target",
        );
    }
}

#[test]
fn fabrik_converges_and_matches_reference() {
    let chain = chain_bones(5);
    for target in [v3(2.0, 1.5, 0.5), v3(-1.0, 2.0, 1.0), v3(0.5, 0.3, -0.4)] {
        let mut rig = bent_chain(5, 0.8, 15.0);
        let start = positions(&rig, &chain);
        let mut scratch = vec![ChainJoint::default(); 5];
        let mut goal = ChainGoal::new(target);
        goal.tolerance = 1e-4;
        goal.iterations = 64;
        let res = {
            let mut p = rig.pose();
            fabrik(&mut p, &chain, &[], &goal, &mut scratch)
        };
        assert!(res.error <= 1e-4, "{res:?}");
        assert_close(rig.pos(5), target, 1.1e-4, "tip");
        let (refp, refit, _) = r::fabrik(&start, v64(target), res.iterations, 0.0);
        assert_eq!(refit, res.iterations);
        for (j, &b) in chain.iter().enumerate() {
            assert!(
                dist64(rig.pos(b as usize), refp[j]) < 2e-4,
                "joint {j}: {:?} {:?}",
                rig.pos(b as usize),
                refp[j]
            );
        }
    }
}

/// The local rotation of every limited joint is inside its limit (re-limiting changes it by
/// less than `tol` radians).
fn assert_within_limits(rig: &Rig, chain: &[u16], limits: &[JointLimit], tol: f32) {
    for (j, &b) in chain.iter().enumerate().take(chain.len() - 1) {
        let local = rig.local(b as usize).rotation;
        let limited = limits[j].apply(local);
        assert!(
            quat_angle(local, limited) < tol,
            "joint {j} outside its limit by {}",
            quat_angle(local, limited)
        );
    }
}

#[test]
fn chain_solvers_respect_joint_limits() {
    let chain = chain_bones(4);
    let rest = axis_angle(0.0, 0.0, 1.0, 10.0);
    let limit = JointLimit {
        rest,
        swing_y: 20f32.to_radians(),
        swing_z: 35f32.to_radians(),
        twist_min: -5f32.to_radians(),
        twist_max: 5f32.to_radians(),
    };
    let mut limits = vec![limit; 4];
    limits[0] = JointLimit::FREE;
    for which in 0..2 {
        for target in [v3(0.0, 2.0, 0.0), v3(1.0, 0.5, 1.5), v3(-0.5, -1.0, 0.2)] {
            let mut rig = bent_chain(4, 0.8, 10.0);
            let mut scratch = vec![ChainJoint::default(); 4];
            let goal = ChainGoal::new(target);
            {
                let mut p = rig.pose();
                if which == 0 {
                    ccd(&mut p, &chain, &limits, &goal, &mut scratch);
                } else {
                    fabrik(&mut p, &chain, &limits, &goal, &mut scratch);
                }
            }
            assert_within_limits(&rig, &chain, &limits, 2e-4);
            assert_finite(&rig);
        }
    }
    // Free limits change nothing compared with no limits.
    let target = v3(1.0, 1.5, 0.3);
    let mut a = bent_chain(4, 0.8, 10.0);
    let mut b = bent_chain(4, 0.8, 10.0);
    let mut scratch = vec![ChainJoint::default(); 4];
    let goal = ChainGoal::new(target);
    ccd(&mut a.pose(), &chain, &[], &goal, &mut scratch);
    ccd(
        &mut b.pose(),
        &chain,
        &[JointLimit::FREE; 4],
        &goal,
        &mut scratch,
    );
    assert!(same_pose(&a, &b));
}

#[test]
fn chain_weight_blends_locals() {
    let chain = chain_bones(4);
    let target = v3(0.3, 2.0, 0.4);
    let orig = bent_chain(4, 0.8, 10.0);
    let mut full = bent_chain(4, 0.8, 10.0);
    let mut half = bent_chain(4, 0.8, 10.0);
    let mut scratch = vec![ChainJoint::default(); 4];
    let mut goal = ChainGoal::new(target);
    fabrik(&mut full.pose(), &chain, &[], &goal, &mut scratch);
    goal.weight = 0.25;
    fabrik(&mut half.pose(), &chain, &[], &goal, &mut scratch);
    for &b in &chain[..3] {
        let b = b as usize;
        let want = orig.local(b).rotation.nlerp(full.local(b).rotation, 0.25);
        assert!(quat_angle(half.local(b).rotation, want) < 1e-6);
    }
    let _ = AosQuat::identity();
    let _ = AosVec3::zero();
}
