//! Copy, limit and damp constraints, the joint-limit model, and the shared geometry helpers.
//!
//! `exp_neg` against f64 `exp`: relative error within `(1 + x)·1.2e-7` (the rounding of
//! `x·log2 e` grows with `x`; the polynomial's own error is under 1.1e-7).

mod common;

use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_rig::constraints::{
    copy, damp, limit_position, limit_rotation, CopyTransform, Damp, DampState, PositionLimit,
    Space,
};
use anim_rig::geom::{
    clamp_cone, exp_neg, from_to, from_to_pair, half_life_alpha, rotation_angle, swing_twist,
};
use anim_rig::JointLimit;
use common::*;

/// 0 root at (0, 1, 0) turned 30° about Y; 1 source; 2 target (both children of the root).
fn pair() -> Rig {
    Rig::new(
        vec![u16::MAX, 0, 0],
        &[
            trq(0.0, 1.0, 0.0, axis_angle(0.0, 1.0, 0.0, 30.0)),
            AosTransform::new(v3(0.3, 0.2, 0.1), axis_angle(1.0, 1.0, 0.0, 40.0), v3(1.5, 1.5, 1.5)),
            tr(-0.3, 0.0, 0.0),
        ],
    )
}

#[test]
fn copy_local_with_offsets_and_weights() {
    let mut rig = pair();
    let src = rig.local(1);
    let mut c = CopyTransform::new(1, 2);
    c.position_offset = v3(0.0, 0.1, 0.0);
    c.rotation_offset = axis_angle(0.0, 0.0, 1.0, 10.0);
    c.scale_offset = v3(2.0, 1.0, 1.0);
    copy(&mut rig.pose(), &c);
    let t = rig.local(2);
    assert_close(t.translation, src.translation + v3(0.0, 0.1, 0.0), 1e-6, "position");
    assert!(quat_angle(t.rotation, src.rotation * c.rotation_offset) < 1e-6);
    assert_close(t.scale, v3(3.0, 1.5, 1.5), 1e-6, "scale");
    // Per-channel weights.
    let mut rig = pair();
    let before = rig.local(2);
    let mut c = CopyTransform::new(1, 2);
    c.position_weight = 0.5;
    c.rotation_weight = 0.0;
    c.scale_weight = 1.0;
    c.weight = 0.5;
    copy(&mut rig.pose(), &c);
    let t = rig.local(2);
    assert_close(t.translation, before.translation.lerp(src.translation, 0.25), 1e-6, "position");
    assert!(quat_angle(t.rotation, before.rotation) < 1e-7, "rotation untouched");
    assert_close(t.scale, AosVec3::one().lerp(src.scale, 0.5), 1e-6, "scale");
}

#[test]
fn copy_model_space() {
    let mut rig = pair();
    let src = rig.model[1];
    let mut c = CopyTransform::new(1, 2);
    c.space = Space::Model;
    c.position_offset = v3(0.0, 0.0, 0.2);
    copy(&mut rig.pose(), &c);
    let t = rig.model[2];
    assert_close(t.translation, src.translation + src.rotation.rotate(v3(0.0, 0.0, 0.2)), 1e-5, "position");
    assert!(quat_angle(t.rotation, src.rotation) < 1e-5);
    assert_close(t.scale, src.scale, 1e-5, "scale");
}

#[test]
fn limit_rotation_clamps_twist_and_swing() {
    let limit = JointLimit {
        rest: AosQuat::identity(),
        swing_y: 30f32.to_radians(),
        swing_z: 60f32.to_radians(),
        twist_min: -20f32.to_radians(),
        twist_max: 45f32.to_radians(),
    };
    let x = v3(1.0, 0.0, 0.0);
    // Twist only.
    for (deg, want) in [(70.0f32, 45.0f32), (-50.0, -20.0), (30.0, 30.0)] {
        let q = axis_angle(1.0, 0.0, 0.0, deg);
        let l = limit.apply(q);
        let (_, tw) = swing_twist(l, x);
        let a = rotation_angle(tw).to_degrees() * deg.signum();
        assert!((a - want).abs() < 1e-3, "twist {deg}: {a}");
    }
    // Swing about Y beyond 30°, about Z inside 60°, and on the ellipse diagonal.
    let l = limit.apply(axis_angle(0.0, 1.0, 0.0, 50.0));
    assert!((rotation_angle(l).to_degrees() - 30.0).abs() < 1e-3);
    let q = axis_angle(0.0, 0.0, 1.0, 50.0);
    assert!(limit.limit(q).is_none(), "inside: untouched");
    let l = limit.apply(axis_angle(0.0, 1.0, 1.0, 90.0));
    let (axis, angle) = l.to_axis_angle();
    let (ty, tz) = (angle * axis.y, angle * axis.z);
    let e = (ty / 30f32.to_radians()).powi(2) + (tz / 60f32.to_radians()).powi(2);
    assert!((e - 1.0).abs() < 1e-3, "on the ellipse: {e}");
    // Relative to a rest rotation.
    let rest = axis_angle(0.0, 0.0, 1.0, 40.0);
    let lr = JointLimit { rest, ..limit };
    let q = rest * axis_angle(1.0, 0.0, 0.0, 90.0);
    let l = lr.apply(q);
    let (_, tw) = swing_twist(rest.conjugate() * l, x);
    assert!((rotation_angle(tw).to_degrees() - 45.0).abs() < 1e-3);
    // Zero swing half-axis forbids that swing.
    let hinge = JointLimit {
        swing_y: 0.0,
        ..limit
    };
    let l = hinge.apply(axis_angle(0.0, 1.0, 0.0, 20.0));
    assert!(rotation_angle(l) < 1e-6);
    // Through the constraint, with weight.
    let mut rig = Rig::new(vec![u16::MAX, 0], &[tr(0.0, 0.0, 0.0), trq(0.0, 0.0, 0.0, axis_angle(1.0, 0.0, 0.0, 90.0))]);
    limit_rotation(&mut rig.pose(), 1, &limit, 1.0);
    assert!((rotation_angle(rig.local(1).rotation).to_degrees() - 45.0).abs() < 1e-3);
    // Free limits never change anything.
    assert!(JointLimit::FREE.limit(axis_angle(1.0, 2.0, 3.0, 170.0)).is_none());
}

#[test]
fn limit_position_box_and_sphere() {
    let bx = PositionLimit::Box {
        min: v3(-0.1, 0.0, -0.1),
        max: v3(0.1, 0.5, 0.1),
    };
    let mut rig = pair();
    limit_position(&mut rig.pose(), 1, &bx, Space::Local, 1.0);
    assert_close(rig.local(1).translation, v3(0.1, 0.2, 0.1), 1e-7, "local box");
    let sp = PositionLimit::Sphere {
        center: v3(0.0, 1.0, 0.0),
        radius: 0.2,
    };
    let mut rig = pair();
    limit_position(&mut rig.pose(), 1, &sp, Space::Model, 1.0);
    let d = dist(rig.pos(1), v3(0.0, 1.0, 0.0));
    assert!((d - 0.2).abs() < 1e-5, "model sphere: {d}");
    let mut rig = pair();
    let before = rig.pos(1);
    limit_position(&mut rig.pose(), 1, &sp, Space::Model, 0.5);
    let d = dist(rig.pos(1), v3(0.0, 1.0, 0.0));
    assert!(d > 0.2 && d < dist(before, v3(0.0, 1.0, 0.0)), "half weight is half way");
}

#[test]
fn damp_follows_critically_with_the_half_life() {
    let hl = 0.2f32;
    let d = Damp {
        bone: 1,
        position_half_life: hl,
        rotation_half_life: hl,
        weight: 1.0,
    };
    let make = |x: f32, deg: f32| {
        Rig::new(vec![u16::MAX, 0], &[tr(0.0, 0.0, 0.0), trq(x, 0.0, 0.0, axis_angle(0.0, 1.0, 0.0, deg))])
    };
    for dt in [1.0 / 30.0f32, 1.0 / 120.0] {
        let mut st = DampState::new();
        damp(&mut make(0.0, 0.0).pose(), &d, &mut st, dt);
        // The goal jumps 1 m and 60°; after one half-life of updates the gap is (1 + y·t)e^(−y·t)
        // with y = 2 ln 2 / half-life: (1 + 2 ln 2)/4.
        let steps = (hl / dt).round() as usize;
        let mut last = 1.0f32;
        let mut rig = make(1.0, 60.0);
        for _ in 0..steps {
            rig = make(1.0, 60.0);
            damp(&mut rig.pose(), &d, &mut st, dt);
            let gap = 1.0 - rig.pos(1).x;
            assert!(gap <= last && gap >= 0.0, "no overshoot");
            last = gap;
        }
        let want = (1.0 + 2.0 * core::f64::consts::LN_2) / 4.0;
        assert!(((1.0 - rig.pos(1).x) as f64 - want).abs() < 1e-5, "dt {dt}: gap {}", 1.0 - rig.pos(1).x);
        let ang = quat_angle(rig.rot(1), axis_angle(0.0, 1.0, 0.0, 60.0)) as f64;
        assert!((ang - want * 60f64.to_radians()).abs() < 1e-4, "rotation gap {ang}");
    }
    // Reset snaps.
    let mut st = DampState::new();
    damp(&mut make(0.0, 0.0).pose(), &d, &mut st, 0.1);
    st.reset();
    let mut rig = make(2.0, 0.0);
    damp(&mut rig.pose(), &d, &mut st, 0.1);
    assert!((rig.pos(1).x - 2.0).abs() < 1e-6);
}

#[test]
fn geometry_helpers() {
    for x in [0.0f32, 1e-6, 0.1, 0.5, 0.693, 1.0, 2.5, 7.0, 20.0, 60.0] {
        let e = exp_neg(x) as f64;
        let want = (-(x as f64)).exp();
        assert!(((e - want) / want).abs() <= (1.0 + x as f64) * 1.2e-7, "exp_neg({x}) = {e}, {want}");
    }
    assert_eq!(exp_neg(-1.0), 1.0);
    assert_eq!(exp_neg(100.0), 0.0);
    assert!((half_life_alpha(0.5, 0.5) - 0.5).abs() < 1e-6);
    assert_eq!(half_life_alpha(0.0, 0.1), 1.0);
    assert_eq!(half_life_alpha(0.5, 0.0), 0.0);
    // Shortest arcs, including opposite vectors.
    for (u, v) in [
        (v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0)),
        (v3(0.6, 0.8, 0.0), v3(0.0, 0.0, 1.0)),
        (v3(0.0, 1.0, 0.0), v3(0.0, -1.0, 0.0)),
        (v3(1.0, 0.0, 0.0), v3(-1.0, 0.0, 0.0)),
    ] {
        let q = from_to(u, v);
        assert_close(q.rotate(u), v, 1e-6, "from_to");
        let r = anim_offline::rig::from_to(v64(u), v64(v));
        assert!((v64(q.rotate(u)) - r.rotate(v64(u))).length() < 1e-6);
    }
    // Pair alignment.
    let q0 = axis_angle(1.0, 2.0, 3.0, 77.0);
    let (u1, u2) = (v3(0.0, 1.0, 0.0), v3(1.0, 0.0, 0.0));
    let q = from_to_pair(u1, u2, q0.rotate(u1), q0.rotate(u2));
    assert!(quat_angle(q, q0) < 1e-5);
    // Swing-twist recomposes.
    let q = axis_angle(0.3, -1.0, 0.4, 130.0);
    let (s, t) = swing_twist(q, v3(1.0, 0.0, 0.0));
    assert!(quat_angle(s * t, q) < 1e-6);
    assert!(s.x.abs() < 1e-6, "swing has no X component");
    // Cone clamp.
    let d = clamp_cone(v3(0.0, 0.0, -1.0), v3(0.0, 0.0, 1.0), 30f32.to_radians());
    assert!((anim_rig::geom::angle_between(d, v3(0.0, 0.0, 1.0)).to_degrees() - 30.0).abs() < 1e-3);
}
