//! The foot grounder: flat, slope and step ground, the max-step clamp, the pelvis offset,
//! smoothing over frames, misses, resets and the ray-request layout.
//!
//! Smoothing is compared with the closed form `1 − 2^(−dt/half_life)`; `exp_neg` is within
//! 1e-6 relative of it, so the offsets agree within 1e-5.

// Settings tweak one field from the defaults per case.
#![allow(clippy::field_reassign_with_default)]

mod common;

use anim_math::AosQuat;
use anim_rig::grounder::{
    apply, ray_requests, solve, GroundTargets, GrounderSettings, GrounderState, RayHit, RayRequest,
};
use anim_rig::two_bone::TwoBone;
use common::*;

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

fn flat(y: f32) -> RayHit {
    RayHit {
        point: v3(0.0, y, 0.0),
        normal: v3(0.0, 1.0, 0.0),
        valid: true,
    }
}

fn frame(
    rig: &mut Rig,
    hits: &[RayHit; 2],
    s: &GrounderSettings,
    state: &mut GrounderState,
    dt: f32,
) -> GroundTargets {
    let mut p = rig.pose();
    let t = solve(&mut p, &LEGS, hits, s, state, dt);
    apply(&mut p, 0, &LEGS, &t, s);
    t
}

#[test]
fn flat_ground_changes_nothing() {
    let mut rig = legs();
    let orig = legs();
    let s = GrounderSettings::default();
    let mut st = GrounderState::new();
    let t = frame(&mut rig, &[flat(0.0), flat(0.0)], &s, &mut st, 1.0 / 60.0);
    assert_eq!(t.pelvis_offset, 0.0);
    for i in 0..7 {
        assert_close(rig.pos(i), orig.pos(i), 1e-5, "bone");
    }
}

#[test]
fn step_up_raises_one_foot_and_keeps_the_pelvis() {
    let mut rig = legs();
    let orig = legs();
    let s = GrounderSettings::default();
    let mut st = GrounderState::new();
    let t = frame(&mut rig, &[flat(0.2), flat(0.0)], &s, &mut st, 1.0 / 60.0);
    assert_eq!(
        t.pelvis_offset, 0.0,
        "max_pelvis_up 0: the pelvis never rises"
    );
    assert_close(
        rig.pos(3),
        orig.pos(3) + v3(0.0, 0.2, 0.0),
        1e-4,
        "left foot up",
    );
    assert_close(rig.pos(6), orig.pos(6), 1e-4, "right foot stays");
    assert_close(rig.pos(0), orig.pos(0), 1e-6, "pelvis stays");
}

#[test]
fn step_down_lowers_the_pelvis_to_the_lowest_foot() {
    let mut rig = legs();
    let orig = legs();
    let s = GrounderSettings::default();
    let mut st = GrounderState::new();
    let t = frame(&mut rig, &[flat(-0.15), flat(0.0)], &s, &mut st, 1.0 / 60.0);
    assert!((t.pelvis_offset + 0.15).abs() < 1e-6);
    assert_close(
        rig.pos(0),
        orig.pos(0) - v3(0.0, 0.15, 0.0),
        1e-5,
        "pelvis down",
    );
    assert_close(
        rig.pos(3),
        orig.pos(3) - v3(0.0, 0.15, 0.0),
        1e-4,
        "left foot down",
    );
    assert_close(
        rig.pos(6),
        orig.pos(6),
        1e-4,
        "right foot stays (its knee bends)",
    );
    // Raising is allowed when max_pelvis_up permits: both feet up 0.1.
    let mut rig = legs();
    let mut s = GrounderSettings::default();
    s.max_pelvis_up = 0.05;
    let mut st = GrounderState::new();
    let t = frame(&mut rig, &[flat(0.1), flat(0.1)], &s, &mut st, 1.0 / 60.0);
    assert!(
        (t.pelvis_offset - 0.05).abs() < 1e-6,
        "raised up to the limit"
    );
    // The pelvis drop is limited.
    let mut rig = legs();
    let mut s = GrounderSettings::default();
    s.max_pelvis_down = 0.1;
    let mut st = GrounderState::new();
    let t = frame(&mut rig, &[flat(-0.3), flat(0.0)], &s, &mut st, 1.0 / 60.0);
    assert!((t.pelvis_offset + 0.1).abs() < 1e-6);
}

#[test]
fn max_step_clamps_the_foot_offset() {
    let mut s = GrounderSettings::default();
    s.max_step = 0.3;
    for (h, want) in [(1.0f32, 0.3f32), (-1.0, -0.3), (0.25, 0.25)] {
        let mut rig = legs();
        let mut st = GrounderState::new();
        let t = frame(&mut rig, &[flat(h), flat(0.0)], &s, &mut st, 1.0 / 60.0);
        assert!(
            (t.feet[0].offset - want).abs() < 1e-6,
            "{h}: {}",
            t.feet[0].offset
        );
    }
}

#[test]
fn slope_tilts_the_feet_within_limits() {
    let n = axis_angle(0.0, 0.0, 1.0, 20.0).rotate(v3(0.0, 1.0, 0.0));
    let slope = RayHit {
        point: v3(0.0, 0.0, 0.0),
        normal: n,
        valid: true,
    };
    for (max_deg, weight, want_deg, tol) in [
        (45.0f32, 1.0f32, 20.0f32, 1e-3f32),
        (10.0, 1.0, 10.0, 1e-3),
        (45.0, 0.5, 10.0, 0.5),
    ] {
        let mut rig = legs();
        let orig = legs();
        let mut s = GrounderSettings::default();
        s.max_foot_angle = max_deg.to_radians();
        s.foot_rotation_weight = weight;
        let mut st = GrounderState::new();
        let t = frame(&mut rig, &[slope, slope], &s, &mut st, 1.0 / 60.0);
        for (k, foot) in [3usize, 6].iter().enumerate() {
            let tilt = (rig.rot(*foot) * orig.rot(*foot).conjugate()).normalize_or_identity();
            let a = anim_rig::geom::rotation_angle(tilt).to_degrees();
            assert!(
                (a - want_deg).abs() < tol,
                "foot {k}: tilt {a}°, want {want_deg}°"
            );
            assert!(quat_angle(rig.rot(*foot), t.feet[k].rotation) < 1e-5);
        }
    }
}

#[test]
fn smoothing_follows_the_half_life_and_reset_snaps() {
    let mut s = GrounderSettings::default();
    s.foot_half_life = 0.1;
    s.pelvis_half_life = 0.2;
    let mut rig = legs();
    let mut st = GrounderState::new();
    // First solve snaps.
    let t = frame(&mut rig, &[flat(0.0), flat(0.0)], &s, &mut st, 1.0 / 60.0);
    assert_eq!(t.feet[0].offset, 0.0);
    // One half-life later, half way.
    let mut rig = legs();
    let t = frame(&mut rig, &[flat(0.2), flat(-0.2)], &s, &mut st, 0.1);
    assert!(
        (t.feet[0].offset - 0.1).abs() < 1e-5,
        "{}",
        t.feet[0].offset
    );
    assert!((t.feet[1].offset + 0.1).abs() < 1e-5);
    let want_pelvis = -0.2 * (1.0 - 0.5f32.powf(0.5));
    assert!(
        (t.pelvis_offset - want_pelvis).abs() < 1e-5,
        "{} vs {want_pelvis}",
        t.pelvis_offset
    );
    // Another half-life: three quarters.
    let mut rig = legs();
    let t = frame(&mut rig, &[flat(0.2), flat(-0.2)], &s, &mut st, 0.1);
    assert!((t.feet[0].offset - 0.15).abs() < 1e-5);
    // Frame-rate independent: two half steps equal one full step.
    let mut a = GrounderState::new();
    let mut b = GrounderState::new();
    for st in [&mut a, &mut b] {
        frame(&mut legs(), &[flat(0.0), flat(0.0)], &s, st, 0.0);
    }
    let ta = frame(&mut legs(), &[flat(0.3), flat(0.0)], &s, &mut a, 0.08);
    frame(&mut legs(), &[flat(0.3), flat(0.0)], &s, &mut b, 0.04);
    let tb = frame(&mut legs(), &[flat(0.3), flat(0.0)], &s, &mut b, 0.04);
    assert!((ta.feet[0].offset - tb.feet[0].offset).abs() < 1e-5);
    // Reset: the next solve snaps.
    st.reset();
    let t = frame(
        &mut legs(),
        &[flat(0.25), flat(0.0)],
        &s,
        &mut st,
        1.0 / 60.0,
    );
    assert!((t.feet[0].offset - 0.25).abs() < 1e-6);
}

#[test]
fn misses_return_to_the_animation() {
    let mut rig = legs();
    let orig = legs();
    let s = GrounderSettings::default();
    let mut st = GrounderState::new();
    let t = frame(
        &mut rig,
        &[RayHit::MISS, RayHit::MISS],
        &s,
        &mut st,
        1.0 / 60.0,
    );
    assert_eq!(t.feet[0].offset, 0.0);
    assert_eq!(t.pelvis_offset, 0.0);
    assert!(quat_angle(t.feet[0].rotation, orig.rot(3)) < 1e-6);
    for i in 0..7 {
        assert_close(rig.pos(i), orig.pos(i), 1e-5, "bone");
    }
}

#[test]
fn ray_requests_layout() {
    let mut rig = legs();
    let mut s = GrounderSettings::default();
    s.ray_height = 0.4;
    s.ray_depth = 0.7;
    s.up = v3(0.0, 1.0, 0.0);
    let mut out = [RayRequest {
        origin: v3(9.0, 9.0, 9.0),
        direction: v3(0.0, 0.0, 0.0),
        length: -1.0,
    }; 3];
    let feet = [rig.pos(3), rig.pos(6)];
    ray_requests(&mut rig.pose(), &LEGS, &s, &mut out);
    for k in 0..2 {
        assert_close(out[k].origin, feet[k] + v3(0.0, 0.4, 0.0), 1e-7, "origin");
        assert_close(out[k].direction, v3(0.0, -1.0, 0.0), 0.0, "direction");
        assert!((out[k].length - 1.1).abs() < 1e-6);
    }
    assert_eq!(out[2].length, -1.0, "entries past the legs are untouched");
}

#[test]
fn weight_zero_leaves_the_pose() {
    let mut rig = legs();
    let orig = legs();
    let mut s = GrounderSettings::default();
    s.weight = 0.0;
    let mut st = GrounderState::new();
    frame(&mut rig, &[flat(0.2), flat(-0.1)], &s, &mut st, 1.0 / 60.0);
    assert!(same_pose(&rig, &orig));
    let _ = AosQuat::identity();
}
