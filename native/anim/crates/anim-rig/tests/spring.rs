//! Spring bones: rest stability, energy decay, collider non-penetration, dt independence,
//! teleport resets, and one particle against `anim-offline::rig::spring_step`.

mod common;

use anim_math::{AosQuat, AosTransform, AosVec3};
use anim_offline::rig as r;
use anim_rig::spring::{spring, ColliderShape, SpringChainState, SpringCollider, SpringSettings};
use common::*;

/// An anchor (1) under a root (0) at (0, 1, 0) and four bones hanging 0.1 apart down −Y.
fn tail() -> Rig {
    Rig::new(
        vec![u16::MAX, 0, 1, 2, 3, 4],
        &[
            tr(0.0, 1.0, 0.0),
            tr(0.0, 0.0, 0.0),
            tr(0.0, -0.1, 0.0),
            tr(0.0, -0.1, 0.0),
            tr(0.0, -0.1, 0.0),
            tr(0.0, -0.1, 0.0),
        ],
    )
}

const CHAIN: [u16; 5] = [1, 2, 3, 4, 5];

fn at(x: f32, y: f32, z: f32) -> AosTransform {
    tr(x, y, z)
}

/// Runs one update on a fresh copy of the animated tail and returns the simulated model
/// positions of the chain.
fn step(
    s: &SpringSettings,
    st: &mut SpringChainState,
    colliders: &[SpringCollider],
    character: AosTransform,
    dt: f32,
) -> Rig {
    let mut rig = tail();
    spring(&mut rig.pose(), &CHAIN, colliders, character, s, st, dt);
    rig
}

#[test]
fn rest_does_not_drift() {
    for gravity in [AosVec3::zero(), v3(0.0, -9.81, 0.0)] {
        let s = SpringSettings {
            gravity,
            ..SpringSettings::default()
        };
        let mut st = SpringChainState::new();
        let orig = tail();
        let mut rig = tail();
        for _ in 0..600 {
            rig = step(&s, &mut st, &[], AosTransform::identity(), 1.0 / 60.0);
        }
        for i in 0..6 {
            assert_close(rig.pos(i), orig.pos(i), 2e-6, "bone at rest");
        }
    }
}

/// The tip's distance from its animated position after a sideways jerk of the character, sampled
/// per update over `seconds`.
fn jerk_response(s: &SpringSettings, dt: f32, seconds: f32) -> Vec<(f32, AosVec3)> {
    let mut st = SpringChainState::new();
    let mut out = Vec::new();
    let steps = (seconds / dt).round() as usize;
    for i in 0..=steps {
        let t = i as f32 * dt;
        // The character slides 0.3 m along +X at constant speed for 0.2 s, then holds (the
        // corners fall on frame boundaries for every dt tested, so every run sees the same
        // input path).
        let x = 0.3 * (t / 0.2).min(1.0);
        let character = at(x, 0.0, 0.0);
        step(s, &mut st, &[], character, dt);
        let anim_tip = character.transform_point(tail().pos(5));
        out.push((t, st.position(4) - anim_tip));
    }
    out
}

#[test]
fn motion_decays_back_to_rest() {
    let s = SpringSettings {
        gravity: AosVec3::zero(),
        ..SpringSettings::default()
    };
    let resp = jerk_response(&s, 1.0 / 60.0, 6.0);
    // The swing peaks after the character stops get smaller every time.
    let mag: Vec<f32> = resp.iter().map(|(_, d)| d.length()).collect();
    let mut peaks = Vec::new();
    for i in 1..mag.len() - 1 {
        if resp[i].0 > 0.25 && mag[i] > mag[i - 1] && mag[i] >= mag[i + 1] && mag[i] > 1e-4 {
            peaks.push(mag[i]);
        }
    }
    assert!(peaks.len() >= 3, "it swings: {peaks:?}");
    for w in peaks.windows(2) {
        assert!(w[1] < 0.8 * w[0], "energy decays: {peaks:?}");
    }
    let late = mag[mag.len() - 60..].iter().fold(0.0f32, |a, &b| a.max(b));
    assert!(late < 1e-3, "back to rest: {late}");
}

#[test]
fn colliders_are_never_penetrated() {
    // Sideways gravity swings the tail into a sphere bound to the root and a capsule.
    let s = SpringSettings {
        gravity: v3(9.81, 0.0, 0.0),
        stiffness: 5.0,
        radius: 0.01,
        ..SpringSettings::default()
    };
    let sphere = SpringCollider {
        bone: 0,
        shape: ColliderShape::Sphere {
            center: v3(0.12, -0.25, 0.0),
            radius: 0.08,
        },
    };
    let capsule = SpringCollider {
        bone: 0,
        shape: ColliderShape::Capsule {
            a: v3(0.1, -0.42, -0.2),
            b: v3(0.1, -0.42, 0.2),
            radius: 0.05,
        },
    };
    let colliders = [sphere, capsule];
    let mut st = SpringChainState::new();
    let mut touched = false;
    for _ in 0..240 {
        let rig = step(
            &s,
            &mut st,
            &colliders,
            AosTransform::identity(),
            1.0 / 60.0,
        );
        let base = rig.pos(0);
        for j in 1..5 {
            let p = st.position(j);
            let ds = dist(p, base + v3(0.12, -0.25, 0.0));
            assert!(ds >= 0.09 - 1e-5, "inside the sphere: {ds}");
            let c = v3(0.1, p.y.max(-10.0), 0.0);
            let _ = c;
            // Distance to the capsule's segment (along Z, at x 0.1, y −0.42 + 1).
            let q = v3(0.1, 1.0 - 0.42, p.z.clamp(-0.2, 0.2));
            let dc = dist(p, q);
            assert!(dc >= 0.06 - 1e-5, "inside the capsule: {dc}");
            touched |= ds < 0.095 || dc < 0.065;
        }
    }
    assert!(touched, "the chain reached a collider");
}

#[test]
fn substeps_make_the_result_dt_independent() {
    let s = SpringSettings {
        gravity: v3(0.0, -9.81, 0.0),
        ..SpringSettings::default()
    };
    // Updates of 1/30, 1/60 and 1/120 s all run 1/120 s substeps: the same simulation.
    let r120 = jerk_response(&s, 1.0 / 120.0, 1.0);
    for dt in [1.0 / 30.0, 1.0 / 60.0] {
        let k = (1.0 / 120.0 / dt as f64).recip().round() as usize;
        for (i, (t, d)) in jerk_response(&s, dt, 1.0).iter().enumerate() {
            let e = dist(*d, r120[i * k].1);
            assert!(e < 1e-5, "dt {dt}: at t = {t}, {e} m from the 120 Hz run");
        }
    }
    // Shorter substeps converge on one answer, to first order (the error halves with h).
    let base = SpringSettings {
        max_substeps: 64,
        ..s
    };
    let reference = jerk_response(
        &SpringSettings {
            max_step: 1.0 / 1920.0,
            ..base
        },
        1.0 / 240.0,
        1.0,
    );
    let mut errors = Vec::new();
    for hz in [240.0f32, 480.0, 960.0] {
        let r = jerk_response(
            &SpringSettings {
                max_step: 1.0 / hz,
                ..base
            },
            1.0 / 240.0,
            1.0,
        );
        let e = r
            .iter()
            .zip(reference.iter())
            .map(|(a, b)| dist(a.1, b.1))
            .fold(0.0f32, f32::max);
        errors.push(e);
    }
    assert!(errors[0] < 0.05, "{errors:?}");
    assert!(
        errors[1] < 0.6 * errors[0] && errors[2] < 0.6 * errors[1],
        "first order: {errors:?}"
    );
    // Other update rates with the default 1/120 s max step (substeps of 1/150 to 1/120 s) stay
    // within that first-order error of the 240 Hz run: the largest difference comes right after
    // the anchor's 1.5 m/s stop at 0.2 s; the swing itself reaches 0.34 m.
    let fine = jerk_response(&s, 1.0 / 240.0, 1.0);
    for dt in [1.0 / 30.0, 1.0 / 50.0, 1.0 / 90.0] {
        for (t, d) in jerk_response(&s, dt, 1.0).iter() {
            let k = (t * 240.0).round() as usize;
            let e = dist(*d, fine[k].1);
            assert!(e < 0.04, "dt {dt}: at t = {t}, {e} m from the 240 Hz run");
        }
    }
}

#[test]
fn teleport_and_reset_restart_at_rest() {
    let s = SpringSettings {
        teleport_distance: 1.0,
        ..SpringSettings::default()
    };
    let mut st = SpringChainState::new();
    for i in 0..30 {
        step(&s, &mut st, &[], at(0.02 * i as f32, 0.0, 0.0), 1.0 / 60.0);
    }
    let far = at(50.0, 0.0, 3.0);
    step(&s, &mut st, &[], far, 1.0 / 60.0);
    for j in 0..5 {
        assert_close(
            st.position(j),
            far.transform_point(tail().pos(j + 1)),
            1e-5,
            "teleported",
        );
    }
    st.reset();
    let here = at(1.0, 2.0, 3.0);
    step(&s, &mut st, &[], here, 1.0 / 60.0);
    for j in 0..5 {
        assert_close(
            st.position(j),
            here.transform_point(tail().pos(j + 1)),
            1e-5,
            "reset",
        );
    }
}

#[test]
fn output_rotations_follow_the_particles() {
    let s = SpringSettings {
        gravity: v3(6.0, 0.0, 0.0),
        stiffness: 10.0,
        ..SpringSettings::default()
    };
    let mut st = SpringChainState::new();
    let mut rig = tail();
    for _ in 0..60 {
        rig = step(&s, &mut st, &[], AosTransform::identity(), 1.0 / 60.0);
    }
    for j in 0..5 {
        assert_close(rig.pos(j + 1), st.position(j), 1e-5, "bone on its particle");
    }
    // Weight 0 leaves the animation.
    let s0 = SpringSettings { weight: 0.0, ..s };
    let rig0 = step(&s0, &mut st, &[], AosTransform::identity(), 1.0 / 60.0);
    assert!(same_pose(&rig0, &tail()));
}

#[test]
fn one_particle_matches_the_reference() {
    // Anchor and one bone; sideways gravity; one substep per update.
    let s = SpringSettings {
        gravity: v3(4.0, -9.81, 1.0),
        stiffness: 30.0,
        damping: 3.0,
        drag: 0.7,
        max_step: 1.0,
        ..SpringSettings::default()
    };
    let p = r::SpringParams {
        stiffness: 30.0,
        damping: 3.0,
        drag: 0.7,
        gravity: v64(s.gravity),
    };
    let chain = [1u16, 2];
    let mut st = SpringChainState::new();
    let dt = 1.0 / 50.0;
    let mut rig = tail();
    spring(
        &mut rig.pose(),
        &chain,
        &[],
        AosTransform::identity(),
        &s,
        &mut st,
        dt,
    );
    let anchor = v64(tail().pos(1));
    let rest = v64(tail().pos(2) - tail().pos(1));
    let (mut x, mut x_prev, mut h_prev) = (anchor + rest, anchor + rest, 0.0f64);
    for _ in 0..40 {
        let mut rig = tail();
        spring(
            &mut rig.pose(),
            &chain,
            &[],
            AosTransform::identity(),
            &s,
            &mut st,
            dt,
        );
        let h = dt as f64;
        let xn = r::spring_step(
            x,
            x_prev,
            h_prev,
            h,
            anchor,
            anim_offline::math::Vec3::ZERO,
            rest,
            &p,
        );
        let xn = anchor + (xn - anchor).normalize_or(rest).scale(rest.length());
        x_prev = x;
        x = xn;
        h_prev = h;
        let e = dist64(st.position(1), x);
        assert!(e < 2e-5, "particle {e} m from the reference");
    }
    let _ = AosQuat::identity();
}
