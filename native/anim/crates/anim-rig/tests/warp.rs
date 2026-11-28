//! Warping: motion warping lands exactly on the target at t1 and is the clip's own motion before
//! t0; distance warping maps clip time to travel; stride and orientation warping.
//!
//! Against `anim-offline::rig`: root positions within 2e-5 (values up to ~10 m, so a few f32
//! ulps of 1e-6) and rotations within 2e-5 rad; distance-curve times within 1e-5 s.

mod common;

use anim_format::frames::FrameClock;
use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_offline::rig as r;
use anim_rig::pose::ChainJoint;
use anim_rig::two_bone::TwoBone;
use anim_rig::warp::{
    cumulative_distance, heading_angle, motion_warp, motion_warp_delta, orientation_warp,
    stride_warp, DistanceCurve, MotionWarp, OrientationWarp, RootCurve, StrideWarp,
};
use common::*;

const DT: f32 = 1.0 / 30.0;

/// A one-second root curve: accelerating along +Z, turning 30° left, bobbing.
fn root_samples() -> Vec<AosTransform> {
    (0..=30)
        .map(|i| {
            let t = i as f32 * DT;
            let z = 1.5 * t * t + 0.5 * t;
            let yaw = axis_angle(0.0, 1.0, 0.0, 30.0 * t);
            trq(0.1 * t, 0.02 * (t * 6.0).sin(), z, yaw)
        })
        .collect()
}

fn warp() -> MotionWarp {
    MotionWarp {
        t0: 0.2,
        t1: 0.8,
        start: trq(5.0, 0.0, 2.0, axis_angle(0.0, 1.0, 0.0, 90.0)),
        target: trq(6.5, 0.3, 1.0, axis_angle(0.0, 1.0, 0.0, 70.0)),
        up: v3(0.0, 1.0, 0.0),
    }
}

fn reference(samples: &[AosTransform], w: &MotionWarp, t: f32) -> anim_offline::math::Transform {
    let s: Vec<_> = samples.iter().map(|&x| t64(x)).collect();
    r::motion_warp(
        &s,
        DT as f64,
        w.t0 as f64,
        w.t1 as f64,
        t64(w.start),
        t64(w.target),
        v64(w.up),
        t as f64,
    )
}

#[test]
fn motion_warp_lands_on_the_target_at_t1() {
    let samples = root_samples();
    let curve = RootCurve {
        samples: &samples,
        clock: FrameClock::uniform(1.0 / DT, samples.len() as u32),
    };
    let w = warp();
    let end = motion_warp(&curve, &w, w.t1);
    assert_close(
        end.translation,
        w.target.translation,
        2e-6 * 10.0,
        "position at t1",
    );
    assert!(
        quat_angle(end.rotation, w.target.rotation) < 2e-5,
        "yaw at t1"
    );
    // After t1 the clip continues from the target.
    let after = motion_warp(&curve, &w, 0.9);
    let rel = end
        .rotation
        .conjugate()
        .rotate(after.translation - end.translation);
    let c1 = curve.sample(0.8);
    let c2 = curve.sample(0.9);
    let want = c1
        .rotation
        .conjugate()
        .rotate(c2.translation - c1.translation);
    assert_close(rel, want, 2e-5, "clip motion after t1");
}

#[test]
fn motion_warp_is_the_clip_before_t0_and_matches_reference() {
    let samples = root_samples();
    let curve = RootCurve {
        samples: &samples,
        clock: FrameClock::uniform(1.0 / DT, samples.len() as u32),
    };
    let w = warp();
    for i in 0..=30 {
        let t = i as f32 * DT;
        let got = motion_warp(&curve, &w, t);
        let want = reference(&samples, &w, t);
        assert!(
            dist64(got.translation, want.translation) < 2e-5,
            "t {t}: position"
        );
        assert!(
            quat_angle64(got.rotation, want.rotation) < 2e-5,
            "t {t}: rotation"
        );
        if t <= w.t0 {
            // Exactly the clip's motion since t0, carried onto start.
            let r0 = curve.sample(w.t0);
            let rt = curve.sample(t);
            let rel = r0
                .rotation
                .conjugate()
                .rotate(rt.translation - r0.translation);
            let p = w.start.translation + w.start.rotation.rotate(rel);
            assert_close(got.translation, p, 1e-6, "unwarped before t0");
        }
    }
    // A smooth start: the correction grows as the square of the time since t0.
    let correction = |e: f32| {
        let t = w.t0 + e;
        let r0 = curve.sample(w.t0);
        let rt = curve.sample(t);
        let rel = r0
            .rotation
            .conjugate()
            .rotate(rt.translation - r0.translation);
        let unwarped = w.start.translation + w.start.rotation.rotate(rel);
        dist(motion_warp(&curve, &w, t).translation, unwarped)
    };
    let ratio = correction(0.005) / correction(0.01);
    assert!((ratio - 0.25).abs() < 0.03, "quadratic onset: {ratio}");
}

#[test]
fn motion_warp_deltas_accumulate_onto_the_target() {
    let samples = root_samples();
    let curve = RootCurve {
        samples: &samples,
        clock: FrameClock::uniform(1.0 / DT, samples.len() as u32),
    };
    let w = warp();
    let mut at = motion_warp(&curve, &w, 0.0);
    let mut t = 0.0f32;
    let step = 1.0 / 60.0;
    for _ in 0..48 {
        let d = motion_warp_delta(&curve, &w, t, t + step);
        at = AosTransform::new(
            at.translation + at.rotation.rotate(d.translation),
            (at.rotation * d.rotation).normalize_or_identity(),
            AosVec3::one(),
        );
        t += step;
    }
    assert!((t - 0.8).abs() < 1e-5);
    assert_close(
        at.translation,
        w.target.translation,
        1e-4,
        "accumulated position",
    );
    assert!(quat_angle(at.rotation, w.target.rotation) < 1e-4);
}

fn travel() -> Vec<f32> {
    // Accelerate, cruise, stop and stand (a flat end).
    let mut pos = Vec::new();
    for i in 0..=40 {
        let t = i as f32 * DT;
        let z = if t < 1.0 { 1.2 * t * t } else { 1.2 };
        pos.push(v3(0.0, 0.01 * (t * 9.0).sin(), z.min(1.2)));
    }
    let mut d = vec![0.0f32; pos.len()];
    cumulative_distance(&pos, v3(0.0, 1.0, 0.0), &mut d);
    d
}

#[test]
fn distance_curve_inverts_and_matches_reference() {
    let d = travel();
    let c = DistanceCurve {
        distance: &d,
        clock: FrameClock::uniform(1.0 / DT, d.len() as u32),
    };
    assert!(
        (d[d.len() - 1] - 1.2).abs() < 1e-5,
        "ground travel ignores the bob"
    );
    let d64: Vec<f64> = d.iter().map(|&x| x as f64).collect();
    for k in 0..=24 {
        let want = k as f32 * 0.05;
        let t = c.time_at(want);
        let back = c.distance_at(t);
        assert!(
            (back - want).abs() < 1e-5,
            "distance_at(time_at({want})) = {back}"
        );
        let rt = r::time_at_distance(&d64, DT as f64, want as f64);
        assert!((t as f64 - rt).abs() < 1e-5, "{want}: {t} vs {rt}");
    }
    // The flat end: the earliest time the full distance is reached (t = 1).
    assert!((c.time_at(1.2) - 1.0).abs() < 1e-5);
    assert!((c.time_at(5.0) - 1.0).abs() < 1e-5);
    assert_eq!(c.time_at(-1.0), 0.0);
}

#[test]
fn distance_warp_rate_and_matching() {
    let d = travel();
    let c = DistanceCurve {
        distance: &d,
        clock: FrameClock::uniform(1.0 / DT, d.len() as u32),
    };
    // The rate that makes the clip travel what the character travelled.
    let (t, dt) = (0.5f32, 1.0 / 60.0);
    for want in [0.005f32, 0.02, 0.04] {
        let rate = c.playback_rate(t, dt, want, 0.1, 4.0);
        let moved = c.distance_at(t + rate * dt) - c.distance_at(t);
        assert!(
            (moved - want).abs() < 1e-5,
            "travel {want}: rate {rate} moved {moved}"
        );
    }
    assert_eq!(c.playback_rate(t, dt, 10.0, 0.25, 2.0), 2.0, "clamped");
    // Distance matching to a stop at t = 1: the remaining clip travel equals the distance left.
    for remaining in [0.6f32, 0.3, 0.1, 0.0] {
        let tm = c.time_before(1.0, remaining);
        let left = c.distance_at(1.0) - c.distance_at(tm);
        assert!((left - remaining).abs() < 1e-5, "{remaining}: {left}");
    }
}

/// A walking pose: 0 pelvis at (0, 1, 0); left leg (1–3) swung forward, right (4–6) back.
fn stride_pose() -> Rig {
    let knee = axis_angle(1.0, 0.0, 0.0, 10.0);
    Rig::new(
        vec![u16::MAX, 0, 1, 2, 0, 4, 5],
        &[
            tr(0.0, 1.0, 0.0),
            trq(0.1, 0.0, 0.0, axis_angle(1.0, 0.0, 0.0, -20.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, knee.conjugate()),
            trq(-0.1, 0.0, 0.0, axis_angle(1.0, 0.0, 0.0, 15.0)),
            trq(0.0, -0.45, 0.0, knee),
            trq(0.0, -0.45, 0.0, knee.conjugate()),
        ],
    )
}

const LEGS: [TwoBone; 2] = [
    TwoBone {
        root: 1,
        mid: 2,
        tip: 3,
    },
    TwoBone {
        root: 4,
        mid: 5,
        tip: 6,
    },
];

fn sw(scale: f32) -> StrideWarp {
    StrideWarp {
        pelvis: 0,
        direction: v3(0.0, 0.0, 1.0),
        scale,
        up: v3(0.0, 1.0, 0.0),
        pelvis_weight: 1.0,
        max_pelvis_drop: 0.3,
        max_reach: 0.999,
        weight: 1.0,
    }
}

#[test]
fn stride_warp_scales_the_feet_along_the_movement() {
    for scale in [0.7f32, 1.0, 1.25] {
        let mut rig = stride_pose();
        let orig = stride_pose();
        stride_warp(&mut rig.pose(), &LEGS, &sw(scale));
        for foot in [3usize, 6] {
            let f = orig.pos(foot);
            let want = v3(f.x, f.y, f.z * scale);
            assert_close(rig.pos(foot), want, 1e-4, "foot");
        }
        if scale <= 1.0 {
            assert_close(
                rig.pos(0),
                orig.pos(0),
                1e-6,
                "no pelvis drop when shortening",
            );
        } else {
            assert!(
                rig.pos(0).y < orig.pos(0).y,
                "the pelvis drops so the legs reach"
            );
            for leg in LEGS {
                let reach = dist(rig.pos(leg.root as usize), rig.pos(leg.tip as usize));
                assert!(reach <= 0.9 * 0.999 + 1e-4, "within reach: {reach}");
            }
        }
    }
    // Weight 0 leaves the pose.
    let mut rig = stride_pose();
    stride_warp(
        &mut rig.pose(),
        &LEGS,
        &StrideWarp {
            weight: 0.0,
            ..sw(1.3)
        },
    );
    assert!(same_pose(&rig, &stride_pose()));
}

#[test]
fn orientation_warp_turns_the_hips_and_keeps_the_chest() {
    let spine = [1u16, 2];
    for (angle, max, want) in [
        (30.0f32, 90.0f32, 30.0f32),
        (-40.0, 90.0, -40.0),
        (50.0, 20.0, 20.0),
    ] {
        let mut rig = humanoid();
        let orig = humanoid();
        let w = OrientationWarp {
            pelvis: 0,
            spine: &spine,
            spine_weights: &[],
            angle: angle.to_radians(),
            max_angle: max.to_radians(),
            up: v3(0.0, 1.0, 0.0),
            weight: 1.0,
        };
        let mut scratch = vec![ChainJoint::default(); 3];
        orientation_warp(&mut rig.pose(), &w, &mut scratch);
        let q = axis_angle(0.0, 1.0, 0.0, want);
        assert!(
            quat_angle(rig.rot(0), q * orig.rot(0)) < 1e-5,
            "hips turned {want}°"
        );
        assert!(
            quat_angle(
                rig.rot(1),
                axis_angle(0.0, 1.0, 0.0, want * 0.5) * orig.rot(1)
            ) < 1e-5,
            "spine shares half"
        );
        assert!(
            quat_angle(rig.rot(2), orig.rot(2)) < 1e-5,
            "chest keeps facing"
        );
        assert!(
            quat_angle(rig.rot(4), orig.rot(4)) < 1e-5,
            "head keeps facing"
        );
        // The feet swing round with the hips.
        let foot = q.rotate(orig.pos(13) - orig.pos(0)) + orig.pos(0);
        assert_close(rig.pos(13), foot, 1e-5, "left foot");
    }
    // Weighted spine shares.
    let mut rig = humanoid();
    let orig = humanoid();
    let w = OrientationWarp {
        pelvis: 0,
        spine: &spine,
        spine_weights: &[3.0, 1.0],
        angle: 40f32.to_radians(),
        max_angle: 1.0,
        up: v3(0.0, 1.0, 0.0),
        weight: 1.0,
    };
    let mut scratch = vec![ChainJoint::default(); 3];
    orientation_warp(&mut rig.pose(), &w, &mut scratch);
    assert!(quat_angle(rig.rot(1), axis_angle(0.0, 1.0, 0.0, 10.0) * orig.rot(1)) < 1e-5);
    assert!(quat_angle(rig.rot(2), orig.rot(2)) < 1e-5);
}

#[test]
fn heading_angle_is_signed_about_up() {
    let up = v3(0.0, 1.0, 0.0);
    let a = heading_angle(v3(0.0, 0.0, 1.0), v3(1.0, 0.0, 0.0), up);
    assert!((a - core::f32::consts::FRAC_PI_2).abs() < 1e-6);
    let a = heading_angle(v3(0.0, 0.0, 1.0), v3(-1.0, 0.3, 1.0), up);
    assert!((a + core::f32::consts::FRAC_PI_4).abs() < 1e-6);
    assert_eq!(heading_angle(v3(0.0, 1.0, 0.0), v3(1.0, 0.0, 0.0), up), 0.0);
    let _ = AosQuat::identity();
}

#[test]
fn distance_curves_honour_a_clamped_last_frame() {
    // 1.01 s at 30 Hz: 32 frames, the last at 1.01 s; travel 1 m per second of clip time.
    let d: Vec<f32> = (0..32).map(|i| (i as f32 / 30.0).min(1.01)).collect();
    let c = DistanceCurve {
        distance: &d,
        clock: FrameClock::new(1.01, 30.0, 32),
    };
    assert!((c.duration() - 1.01).abs() < 1e-6);
    assert!((c.distance_at(1.005) - 1.005).abs() < 1e-5);
    assert!((c.distance_at(1.01) - 1.01).abs() < 1e-6);
    assert!((c.time_at(1.005) - 1.005).abs() < 1e-5);
    assert!((c.time_at(5.0) - 1.01).abs() < 1e-6);
}
