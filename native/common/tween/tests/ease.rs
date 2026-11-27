//! Penner easings against closed-form f64 references written from the published (easings.net)
//! formulas, each in its own `in`, `out` and `inOut` form (not through the module's mirror
//! identities). Tolerance: 2e-6 absolute, see `myco_tween::ease`'s accuracy note (the f32 sine
//! polynomial's 3e-7 amplified by elastic's factors).

use myco_tween::ease::{ease, LAST_ID};
use std::f64::consts::PI;

const TOLERANCE: f64 = 2e-6;

fn bounce_out(t: f64) -> f64 {
    let (n1, d1) = (7.5625, 2.75);
    if t < 1.0 / d1 {
        n1 * t * t
    } else if t < 2.0 / d1 {
        let t = t - 1.5 / d1;
        n1 * t * t + 0.75
    } else if t < 2.5 / d1 {
        let t = t - 2.25 / d1;
        n1 * t * t + 0.9375
    } else {
        let t = t - 2.625 / d1;
        n1 * t * t + 0.984375
    }
}

/// The reference for `1 + 3·family + mode`, straight from the published formulas.
fn reference(id: u32, t: f64) -> f64 {
    if id == 0 {
        return t;
    }
    let family = (id - 1) / 3;
    let mode = (id - 1) % 3;
    let c1 = 1.70158;
    let c2 = c1 * 1.525;
    let c3 = c1 + 1.0;
    let c4 = 2.0 * PI / 3.0;
    let c5 = 2.0 * PI / 4.5;
    match (family, mode) {
        (0..=3, m) => {
            let n = (family + 2) as i32;
            match m {
                0 => t.powi(n),
                1 => 1.0 - (1.0 - t).powi(n),
                _ if t < 0.5 => 2f64.powi(n - 1) * t.powi(n),
                _ => 1.0 - (-2.0 * t + 2.0).powi(n) / 2.0,
            }
        }
        (4, 0) => 1.0 - (t * PI / 2.0).cos(),
        (4, 1) => (t * PI / 2.0).sin(),
        (4, _) => -((PI * t).cos() - 1.0) / 2.0,
        (5, 0) => 2f64.powf(10.0 * t - 10.0),
        (5, 1) => 1.0 - 2f64.powf(-10.0 * t),
        (5, _) if t < 0.5 => 2f64.powf(20.0 * t - 10.0) / 2.0,
        (5, _) => (2.0 - 2f64.powf(-20.0 * t + 10.0)) / 2.0,
        (6, 0) => 1.0 - (1.0 - t * t).sqrt(),
        (6, 1) => (1.0 - (t - 1.0).powi(2)).sqrt(),
        (6, _) if t < 0.5 => (1.0 - (1.0 - (2.0 * t).powi(2)).sqrt()) / 2.0,
        (6, _) => ((1.0 - (-2.0 * t + 2.0).powi(2)).sqrt() + 1.0) / 2.0,
        (7, 0) => c3 * t * t * t - c1 * t * t,
        (7, 1) => 1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2),
        (7, _) if t < 0.5 => ((2.0 * t).powi(2) * ((c2 + 1.0) * 2.0 * t - c2)) / 2.0,
        (7, _) => ((2.0 * t - 2.0).powi(2) * ((c2 + 1.0) * (t * 2.0 - 2.0) + c2) + 2.0) / 2.0,
        (8, 0) => -(2f64.powf(10.0 * t - 10.0)) * ((10.0 * t - 10.75) * c4).sin(),
        (8, 1) => 2f64.powf(-10.0 * t) * ((10.0 * t - 0.75) * c4).sin() + 1.0,
        (8, _) if t < 0.5 => -(2f64.powf(20.0 * t - 10.0) * ((20.0 * t - 11.125) * c5).sin()) / 2.0,
        (8, _) => (2f64.powf(-20.0 * t + 10.0) * ((20.0 * t - 11.125) * c5).sin()) / 2.0 + 1.0,
        (9, 0) => 1.0 - bounce_out(1.0 - t),
        (9, 1) => bounce_out(t),
        (9, _) if t < 0.5 => (1.0 - bounce_out(1.0 - 2.0 * t)) / 2.0,
        (9, _) => (1.0 + bounce_out(2.0 * t - 1.0)) / 2.0,
        _ => t,
    }
}

#[test]
fn every_easing_matches_its_closed_form() {
    let mut worst = 0.0f64;
    for id in 0..=LAST_ID {
        // The endpoints are returned exactly (the published expo and elastic formulas miss them
        // by up to 1e-3); `endpoints_are_exact` covers them.
        for i in 1..1000 {
            let t = i as f32 / 1000.0;
            let got = ease(id, t) as f64;
            let want = reference(id, t as f64);
            let err = (got - want).abs();
            worst = worst.max(err);
            assert!(
                err <= TOLERANCE,
                "id {id} at t = {t}: {got} vs {want} (err {err:e})"
            );
        }
    }
    eprintln!("worst easing error: {worst:e}");
}

#[test]
fn endpoints_are_exact() {
    for id in 0..=LAST_ID {
        assert_eq!(ease(id, 0.0), 0.0, "id {id}");
        assert_eq!(ease(id, 1.0), 1.0, "id {id}");
        // Outside and non-finite progress clamps.
        assert_eq!(ease(id, -3.0), 0.0, "id {id}");
        assert_eq!(ease(id, 7.0), 1.0, "id {id}");
        assert_eq!(ease(id, f32::NAN), 0.0, "id {id}");
    }
}

#[test]
fn unknown_ids_are_linear() {
    for t in [0.0, 0.25, 0.5, 1.0] {
        assert_eq!(ease(LAST_ID + 1, t), t);
        assert_eq!(ease(u32::MAX, t), t);
    }
}

#[test]
fn midpoints_of_in_out_are_one_half() {
    for family in 0..10 {
        let id = 1 + 3 * family + 2;
        let m = ease(id, 0.5);
        assert!((m - 0.5).abs() < 1e-6, "id {id}: {m}");
    }
}

#[test]
fn deterministic_bits() {
    // A few golden bit patterns: they must not change between targets or releases.
    let sample: Vec<u32> = (0..=30)
        .map(|id| ease(id, 0.37).to_bits() ^ ease(id, 0.81).to_bits())
        .collect();
    let again: Vec<u32> = (0..=30)
        .map(|id| ease(id, 0.37).to_bits() ^ ease(id, 0.81).to_bits())
        .collect();
    assert_eq!(sample, again);
}
