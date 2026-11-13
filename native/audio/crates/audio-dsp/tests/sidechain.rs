//! The ducking sidechain's detectors and gain computer (ADR 0171/0172, architecture §4.6; spike S4's
//! `Rule::detect` and the static computer, ported to the interface's dB levels).
use audio_dsp::sidechain::{detect_peak, detect_rms, gain_goal, DetectorCoeffs, DetectorState};

const Q: usize = 128;

fn sine(amp: f32, rate: f32, n: usize) -> Vec<f32> {
    (0..n).map(|i| amp * libm::sinf(2.0 * core::f32::consts::PI * 1000.0 * i as f32 / rate)).collect()
}

fn quantum(v: &[f32], at: usize) -> [f32; Q] {
    let mut o = [0.0; Q];
    o.copy_from_slice(&v[at * Q..(at + 1) * Q]);
    o
}

#[test]
fn coefficients_are_a_10ms_63_percent_constant() {
    for rate in [48_000.0f32, 44_100.0] {
        let c = DetectorCoeffs::new(rate);
        assert_eq!(c.peak_release, c.rms_alpha);
        // 10 ms of silence from 1.0 leaves e^-1.
        let n = (0.010 * rate).round() as i32;
        let after = c.peak_release.powi(n);
        assert!((after - (-1.0f32).exp()).abs() < 1e-4, "{rate}: {after}");
        assert!((c.peak_release - (-1.0 / (0.010 * rate)).exp()).abs() < 1e-7);
    }
    assert_eq!(DetectorCoeffs::default(), DetectorCoeffs { peak_release: 0.0, rms_alpha: 0.0 });
}

#[test]
fn peak_envelope_after_10ms_of_silence_is_e_minus_1() {
    for rate in [51_200.0f32, 25_600.0] {
        let c = DetectorCoeffs::new(rate);
        let mut s = DetectorState { env: 1.0 };
        let z = [0.0; Q];
        let quanta = ((0.010 * rate) / Q as f32).round() as usize;
        let mut db = 0.0;
        for _ in 0..quanta {
            db = detect_peak(&mut s, &c, &z, &z);
        }
        let expected = c.peak_release.powi((quanta * Q) as i32);
        assert!((s.env - expected).abs() < 1e-6);
        assert!((db - 20.0 * libm::log10f(expected)).abs() < 1e-3);
        // these rates make 10 ms a whole number of quanta (512 and 256 samples): exactly e^-1
        assert!((s.env - (-1.0f32).exp()).abs() < 1e-4, "{rate}: {}", s.env);
    }
}

#[test]
fn peak_attack_is_instant_and_the_level_is_the_envelope_at_the_quantums_end() {
    let c = DetectorCoeffs::new(48_000.0);
    let mut s = DetectorState::default();
    let mut l = [0.0; Q];
    let r = [0.0; Q];
    l[Q - 1] = 0.5; // one loud last sample sets the level
    let db = detect_peak(&mut s, &c, &l, &r);
    assert_eq!(s.env, 0.5);
    assert!((db - 20.0 * libm::log10f(0.5)).abs() < 1e-4);
    // a loud first sample has released by the quantum's end (the end, not the max)
    let mut s = DetectorState::default();
    let mut l = [0.0; Q];
    l[0] = 0.5;
    let db = detect_peak(&mut s, &c, &l, &r);
    let expected = 0.5 * c.peak_release.powi(127);
    assert!((s.env - expected).abs() < 1e-6);
    assert!((db - 20.0 * libm::log10f(expected)).abs() < 1e-3);
    assert!(db < 20.0 * libm::log10f(0.5));
}

#[test]
fn peak_release_follows_the_one_pole_law() {
    let c = DetectorCoeffs::new(48_000.0);
    let mut s = DetectorState { env: 0.8 };
    let z = [0.0; Q];
    for k in 1..=5 {
        detect_peak(&mut s, &c, &z, &z);
        let expected = 0.8 * c.peak_release.powi((k * Q) as i32);
        assert!((s.env - expected).abs() < 1e-5 * expected.max(1.0), "k={k}: {} vs {expected}", s.env);
    }
    // a lower level while releasing: a sample above the envelope attacks, below keeps releasing
    let mut s = DetectorState { env: 0.8 };
    let l = [0.1; Q];
    detect_peak(&mut s, &c, &l, &z);
    let mut env = 0.8f32;
    for _ in 0..Q {
        env = 0.1 + c.peak_release * (env - 0.1);
    }
    assert!((s.env - env).abs() < 1e-5);
}

#[test]
fn peak_takes_the_larger_channel_by_magnitude() {
    let c = DetectorCoeffs::new(48_000.0);
    for (l, r, want) in [(0.2f32, 0.6f32, 0.6f32), (0.6, 0.2, 0.6), (-0.7, 0.3, 0.7), (0.3, -0.9, 0.9)] {
        let mut s = DetectorState::default();
        let db = detect_peak(&mut s, &c, &[l; Q], &[r; Q]);
        assert!((s.env - want).abs() < 1e-6);
        assert!((db - 20.0 * libm::log10f(want)).abs() < 1e-4);
    }
}

#[test]
fn rms_of_a_full_scale_sine_settles_to_minus_3_01_db() {
    for rate in [48_000.0f32, 44_100.0] {
        let c = DetectorCoeffs::new(rate);
        let x = sine(1.0, rate, Q * 400);
        let mut s = DetectorState::default();
        let mut db = 0.0;
        for q in 0..400 {
            let b = quantum(&x, q);
            db = detect_rms(&mut s, &c, &b, &b);
        }
        // the one-pole ripples at twice the tone: allow 0.1 dB
        assert!((db - -3.0103).abs() < 0.1, "{rate}: {db}");
    }
}

#[test]
fn rms_of_dc_half_is_minus_6_02_db() {
    let c = DetectorCoeffs::new(48_000.0);
    let mut s = DetectorState::default();
    let mut db = 0.0;
    for _ in 0..400 {
        db = detect_rms(&mut s, &c, &[0.5; Q], &[0.5; Q]);
    }
    assert!((db - -6.0206).abs() < 1e-3, "{db}");
    // one channel only: the mean of l^2 and r^2 halves the power
    let mut s = DetectorState::default();
    for _ in 0..400 {
        db = detect_rms(&mut s, &c, &[0.5; Q], &[0.0; Q]);
    }
    assert!((db - (-6.0206 - 3.0103)).abs() < 1e-3, "{db}");
}

#[test]
fn rms_follows_the_one_pole_law_in_both_directions() {
    let c = DetectorCoeffs::new(48_000.0);
    // rising from silence to ms = 0.25: after n samples ms = 0.25 (1 - a^n)
    let mut s = DetectorState::default();
    detect_rms(&mut s, &c, &[0.5; Q], &[0.5; Q]);
    let want = 0.25 * (1.0 - c.rms_alpha.powi(Q as i32));
    assert!((s.env - want).abs() < 1e-6, "{} vs {want}", s.env);
    // falling: from ms 0.25 over silence the mean square decays by a^n (a power law, not amplitude)
    let mut s = DetectorState { env: 0.25 };
    let z = [0.0; Q];
    let db = detect_rms(&mut s, &c, &z, &z);
    let want = 0.25 * c.rms_alpha.powi(Q as i32);
    assert!((s.env - want).abs() < 1e-6);
    assert!((db - 10.0 * libm::log10f(want)).abs() < 1e-3);
    // after 10 ms the mean square is e^-1 of where it started
    let mut s = DetectorState { env: 1.0 };
    for _ in 0..(480 / Q) {
        detect_rms(&mut s, &c, &z, &z);
    }
    let expected = c.rms_alpha.powi(((480 / Q) * Q) as i32);
    assert!((s.env - expected).abs() < 1e-6);
}

#[test]
fn silence_reads_the_floor_and_never_nan() {
    let c = DetectorCoeffs::new(48_000.0);
    let z = [0.0; Q];
    let mut sp = DetectorState::default();
    let mut sr = DetectorState::default();
    assert_eq!(detect_peak(&mut sp, &c, &z, &z), -240.0);
    assert_eq!(detect_rms(&mut sr, &c, &z, &z), -240.0);
    assert_eq!(sp, DetectorState { env: 0.0 });
    // a tail that decays away reaches the floor, flushed to exact zero, with no NaN on the way
    let mut sp = DetectorState { env: 1.0 };
    let mut sr = DetectorState { env: 1.0 };
    for _ in 0..4000 {
        let p = detect_peak(&mut sp, &c, &z, &z);
        let r = detect_rms(&mut sr, &c, &z, &z);
        assert!(p.is_finite() && r.is_finite() && p >= -240.0 && r >= -240.0);
    }
    assert_eq!((sp.env, sr.env), (0.0, 0.0));
    // a tiny but representable signal still clamps at the floor
    let mut s = DetectorState::default();
    let db = detect_peak(&mut s, &c, &[1e-30; Q], &[0.0; Q]);
    assert_eq!(db, -240.0);
    // non-finite input does not poison the state
    let mut s = DetectorState::default();
    let db = detect_peak(&mut s, &c, &[f32::NAN; Q], &z);
    assert!(db.is_finite());
    assert!(s.env.is_finite());
}

#[test]
fn state_is_carried_across_quanta_not_reset() {
    let c = DetectorCoeffs::new(48_000.0);
    let x = sine(0.7, 48_000.0, Q * 8);
    let mut a = DetectorState::default();
    let mut da = 0.0;
    for q in 0..8 {
        let b = quantum(&x, q);
        da = detect_rms(&mut a, &c, &b, &b);
    }
    // the same signal again, from the carried state, differs from a fresh start
    let b = quantum(&x, 0);
    let mut fresh = DetectorState::default();
    let first = detect_rms(&mut fresh, &c, &b, &b);
    assert!(da > first);
    assert_eq!(std::mem::size_of::<DetectorState>(), 4);
}

#[test]
fn gain_computer_below_threshold_is_exactly_one() {
    for level in [-240.0f32, -60.0, -30.001, -30.0] {
        assert_eq!(gain_goal(level, -30.0, 0.3), 1.0);
    }
}

#[test]
fn gain_computer_at_threshold_plus_6_db_is_exactly_amount() {
    for amount in [0.0f32, 0.1, 0.3, 0.5, 1.0] {
        assert_eq!(gain_goal(-24.0, -30.0, amount), amount);
        assert_eq!(gain_goal(0.0, -30.0, amount), amount, "far above stays at amount");
    }
}

#[test]
fn gain_computer_knee_is_linear_in_db_between() {
    let amount = 0.2;
    for k in 0..=12 {
        let over = k as f32 * 0.5;
        let g = gain_goal(-20.0 + over, -20.0, amount);
        let want = 1.0 - (over / 6.0) * (1.0 - amount);
        assert!((g - want).abs() < 1e-6, "over {over}: {g} vs {want}");
    }
    assert!((gain_goal(-17.0, -20.0, amount) - 0.6).abs() < 1e-6, "3 dB over is halfway");
}

#[test]
fn gain_computer_amount_extremes() {
    // amount 0: full duck to silence; amount 1: never ducks
    assert_eq!(gain_goal(-10.0, -30.0, 0.0), 0.0);
    assert!((gain_goal(-27.0, -30.0, 0.0) - 0.5).abs() < 1e-6);
    for level in [-240.0f32, -30.0, -27.0, -20.0, 10.0] {
        assert_eq!(gain_goal(level, -30.0, 1.0), 1.0);
    }
}

#[test]
fn a_tone_burst_ducks_through_the_whole_chain() {
    // S4's rule shape end to end at quantum rate: silence, a burst over the threshold, silence again
    let c = DetectorCoeffs::new(48_000.0);
    let mut s = DetectorState::default();
    let z = [0.0; Q];
    let loud = [0.5; Q]; // -6.02 dB peak
    let mut goals = Vec::new();
    for q in 0..60 {
        let l = if (10..30).contains(&q) { &loud } else { &z };
        goals.push(gain_goal(detect_peak(&mut s, &c, l, l), -30.0, 0.3));
    }
    assert_eq!(goals[9], 1.0);
    assert!((goals[10] - 0.3).abs() < 1e-6, "instant attack ducks on the burst's own quantum");
    assert!((goals[29] - 0.3).abs() < 1e-6);
    // the 10 ms release takes the level from -6 dB to under the knee (-24 dB) in about 5 time constants
    let up = (30..60).find(|&q| goals[q] > 0.3 + 1e-6).expect("the duck releases");
    assert!(up > 30 && up < 45, "{up}");
    assert!(goals[up] < 1.0, "through the knee, not a cliff");
    assert!(goals.windows(2).skip(29).all(|w| w[1] >= w[0]));
    assert_eq!(goals[59], 1.0);
}
