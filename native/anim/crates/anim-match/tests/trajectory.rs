//! Springs and the trajectory predictor: convergence, no overshoot (critically damped), the
//! position being the velocity's integral, frame-rate independence, the character frame, the
//! shortest turn, and the history.
//!
//! Tolerances: the springs are closed-form and use `exp2`'s polynomial (relative error ~1e-7),
//! so stepping `dt` N times matches one step of `N·dt` to a few f32 ulps per step: 2e-5 over a
//! second at 240 Hz (values ≤ ~2). The predictor's samples go through `sin_cos` (3e-7) and one
//! rotation: 1e-5. The past interpolates exact linear motion: 1e-4 (positions up to 1.4 m in
//! f32 accumulated over 60 updates). The closed-loop comparison runs 16 against 121 updates of
//! the same closed-form springs (measured 4e-7 apart): 1e-5.

use anim_match::spring::{spring_damper, velocity_spring, wrap_angle};
use anim_match::{Trajectory, TrajectoryInput, TrajectoryPredictor, TrajectorySettings};
use std::f32::consts::{FRAC_PI_2, PI};

#[test]
fn the_spring_converges_without_overshoot() {
    for hl in [0.05f32, 0.2, 0.6] {
        let (mut x, mut v) = (0.0f32, 0.0f32);
        let mut last = 0.0;
        let dt = 1.0 / 120.0;
        for step in 1..=(1200.0 * hl) as usize {
            (x, v) = spring_damper(x, v, 1.0, hl, dt);
            assert!(x >= last - 1e-7 && x <= 1.0 + 1e-6, "hl {hl} step {step}: {x}");
            last = x;
        }
        // Ten half-lives: (1 + y·t)·e^(−y·t) ≈ 1.4e-5 of the gap remains.
        assert!((x - 1.0).abs() < 1e-4 && v.abs() < 1e-3, "hl {hl}: {x} {v}");
        // After one half-life from rest, (1 + y·t)·e^(−y·t) of the gap remains, y·t = 2 ln 2:
        // (1 + 2 ln 2)/4 ≈ 0.597 (the ε added to the half-life moves it by < 1e-4).
        let (x1, _) = spring_damper(0.0, 0.0, 1.0, hl, hl);
        assert!((x1 - (1.0 - (1.0 + 2.0 * 2f32.ln()) / 4.0)).abs() < 1e-4);
    }
}

#[test]
fn the_velocity_spring_converges_and_integrates() {
    let hl = 0.3;
    let (mut x, mut v, mut a) = (0.0f32, 0.0f32, 0.0f32);
    let mut integral = 0.0f64;
    let dt = 1.0 / 1000.0;
    let mut last_v = 0.0;
    for _ in 0..3000 {
        let (x1, v1, a1) = velocity_spring(x, v, a, 2.0, hl, dt);
        integral += 0.5 * (v as f64 + v1 as f64) * dt as f64;
        (x, v, a) = (x1, v1, a1);
        assert!(v >= last_v - 1e-6 && v <= 2.0 + 1e-5, "no overshoot: {v}");
        last_v = v;
    }
    assert!((v - 2.0).abs() < 1e-3 && a.abs() < 1e-2);
    assert!((x as f64 - integral).abs() < 1e-3, "{x} vs {integral}");
    // Half the velocity gap closes in one half-life (from rest with zero acceleration the
    // remaining gap is (1 + y·t)·e^(−y·t), with y·t = 2 ln 2 at t = hl: (1 + 2 ln 2)/4).
    let (_, v1, _) = velocity_spring(0.0, 0.0, 0.0, 1.0, hl, hl);
    assert!(((1.0 - v1) - (1.0 + 2.0 * 2f32.ln()) / 4.0).abs() < 1e-4);
}

#[test]
fn stepping_is_frame_rate_independent() {
    let (hl, total) = (0.25f32, 1.0f32);
    let (x1, v1, a1) = velocity_spring(0.3, -1.0, 0.5, 1.7, hl, total);
    let (y1, w1) = spring_damper(0.3, -1.0, 1.7, hl, total);
    for n in [30u32, 60, 240] {
        let dt = total / n as f32;
        let (mut x, mut v, mut a) = (0.3f32, -1.0f32, 0.5f32);
        let (mut y, mut w) = (0.3f32, -1.0f32);
        for _ in 0..n {
            (x, v, a) = velocity_spring(x, v, a, 1.7, hl, dt);
            (y, w) = spring_damper(y, w, 1.7, hl, dt);
        }
        for (got, want) in [(x, x1), (v, v1), (a, a1), (y, y1), (w, w1)] {
            assert!((got - want).abs() < 2e-5, "{n} Hz: {got} vs {want}");
        }
    }
}

#[test]
fn angles_wrap_into_minus_pi_to_pi() {
    for (x, want) in [(0.0, 0.0), (3.0, 3.0), (4.0, 4.0 - 2.0 * PI), (-7.0, -7.0 + 2.0 * PI)] {
        assert!((wrap_angle(x) - want).abs() < 1e-6);
    }
}

const OFFSETS: [f32; 4] = [-0.33, 0.33, 0.66, 1.0];
fn settings() -> TrajectorySettings {
    TrajectorySettings::default()
}

fn predict(p: &TrajectoryPredictor, input: &TrajectoryInput) -> Trajectory {
    let mut t = Trajectory::default();
    p.predict(input, &settings(), &OFFSETS, &mut t);
    t
}

fn close(a: [f32; 2], b: [f32; 2], tol: f32) -> bool {
    (a[0] - b[0]).abs() <= tol && (a[1] - b[1]).abs() <= tol
}

#[test]
fn a_still_character_predicts_standing_still() {
    let mut p = TrajectoryPredictor::new();
    let input = TrajectoryInput {
        position: [5.0, -3.0],
        yaw: 1.0,
        desired_yaw: 1.0,
        ..TrajectoryInput::default()
    };
    for _ in 0..10 {
        p.update(1.0 / 60.0, &input, &settings());
    }
    let t = predict(&p, &input);
    assert_eq!(t.count, 4);
    for i in 0..4 {
        assert!(close(t.positions[i], [0.0, 0.0], 1e-6), "{i}");
        assert!(close(t.directions[i], [0.0, 1.0], 1e-6), "{i}");
    }
    assert_eq!(t.sample(0.66), Some((t.positions[2], t.directions[2])));
    assert_eq!(t.sample(0.5), None);
}

#[test]
fn steady_motion_predicts_straight_ahead_in_character_space() {
    // Facing +X (yaw π/2) and moving along +X at 1.4 m/s: straight ahead is local +Z.
    for (yaw, vel) in [(0.0f32, [0.0f32, 1.4f32]), (FRAC_PI_2, [1.4, 0.0])] {
        let mut p = TrajectoryPredictor::new();
        let mut input = TrajectoryInput {
            position: [0.0, 0.0],
            yaw,
            velocity: vel,
            desired_velocity: vel,
            desired_yaw: yaw,
        };
        let dt = 1.0 / 60.0;
        for _ in 0..=60 {
            p.update(dt, &input, &settings());
            input.position[0] += vel[0] * dt;
            input.position[1] += vel[1] * dt;
        }
        input.position[0] -= vel[0] * dt;
        input.position[1] -= vel[1] * dt;
        let t = predict(&p, &input);
        for (i, &o) in OFFSETS.iter().enumerate() {
            assert!(
                close(t.positions[i], [0.0, 1.4 * o], 1e-4),
                "yaw {yaw} offset {o}: {:?}",
                t.positions[i]
            );
            assert!(close(t.directions[i], [0.0, 1.0], 1e-5));
        }
    }
}

#[test]
fn a_new_desire_follows_the_spring_and_turns_the_short_way() {
    let mut p = TrajectoryPredictor::new();
    let input = TrajectoryInput {
        position: [1.0, 2.0],
        yaw: 3.0,
        velocity: [0.0, 0.0],
        desired_velocity: [0.0, 2.0],
        desired_yaw: -3.0,
    };
    p.update(1.0 / 60.0, &input, &settings());
    let t = predict(&p, &input);
    let s = settings();
    let (sin, cos) = 3.0f32.sin_cos();
    for (i, &o) in OFFSETS.iter().enumerate().skip(1) {
        let (dz, _, _) = velocity_spring(0.0, 0.0, 0.0, 2.0, s.velocity_half_life, o);
        // World (0, dz) in the frame facing yaw 3: right = (cos, −sin), forward = (sin, cos).
        let want = [dz * -sin, dz * cos];
        assert!(close(t.positions[i], want, 1e-5), "{o}: {:?} {want:?}", t.positions[i]);
        // −3 is 0.28 rad past +π: the turn goes up through π, so the relative yaw grows positive
        // toward 2π − 6 ≈ 0.283 and never the long way.
        let rel = t.directions[i][0].atan2(t.directions[i][1]);
        assert!(rel > 0.0 && rel <= 2.0 * PI - 6.0 + 1e-5, "{o}: {rel}");
    }
}

#[test]
fn the_past_comes_from_the_history() {
    let mut p = TrajectoryPredictor::new();
    let dt = 1.0 / 90.0;
    let mut input = TrajectoryInput {
        velocity: [0.0, 1.4],
        desired_velocity: [0.0, 1.4],
        ..TrajectoryInput::default()
    };
    for i in 0..=90 {
        input.position = [0.0, 1.4 * i as f32 * dt];
        p.update(dt, &input, &settings());
    }
    let t = predict(&p, &input);
    assert!(close(t.positions[0], [0.0, -1.4 * 0.33], 1e-4), "{:?}", t.positions[0]);
    // Older than the history: clamps to the oldest sample.
    let mut q = TrajectoryPredictor::new();
    q.update(dt, &input, &settings());
    let mut out = Trajectory::default();
    q.predict(&input, &settings(), &[-0.5], &mut out);
    assert!(close(out.positions[0], [0.0, 0.0], 1e-6));
}

#[test]
fn closed_loop_prediction_is_frame_rate_independent() {
    // A character driven by the same spring, its desire changing at t = 0: after 0.5 s the
    // predictions at 30 Hz and 240 Hz agree.
    let run = |hz: u32| {
        let s = settings();
        let dt = 1.0 / hz as f32;
        let mut p = TrajectoryPredictor::new();
        let (mut x, mut v, mut a) = ([0.0f32; 2], [0.0f32; 2], [0.0f32; 2]);
        let desired = [1.0, 1.5];
        let (mut yaw, mut w) = (0.0f32, 0.0f32);
        let mut input = TrajectoryInput::default();
        for _ in 0..=hz / 2 {
            input = TrajectoryInput {
                position: x,
                yaw,
                velocity: v,
                desired_velocity: desired,
                desired_yaw: 0.6,
            };
            p.update(dt, &input, &s);
            for k in 0..2 {
                (x[k], v[k], a[k]) =
                    velocity_spring(x[k], v[k], a[k], desired[k], s.velocity_half_life, dt);
            }
            (yaw, w) = spring_damper(yaw, w, 0.6, s.facing_half_life, dt);
        }
        predict(&p, &input)
    };
    let (a, b) = (run(30), run(240));
    for i in 1..4 {
        assert!(close(a.positions[i], b.positions[i], 1e-5), "{i}: {:?} {:?}", a.positions[i], b.positions[i]);
        assert!(close(a.directions[i], b.directions[i], 1e-5), "{i}");
    }
}
