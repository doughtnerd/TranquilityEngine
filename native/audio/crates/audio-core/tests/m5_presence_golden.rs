//! G1's presence duck (0171/0172 M5-0; architecture §4.6 "Presence mode", R4; api-and-models §4.2
//! `BUS_DUCK`, `BUS_PRESENCE`; M5-0's exit check "a presence duck starts on its stamped frame"):
//! `golden/m5/presence-duck.json`, against an offline reference, natively here and bit for bit on
//! the real wasm (`runtime/golden/audioGoldenM5.test.ts`).
//!
//! **The scene.** A DC voice at 0.5 on bus 1 (the target); one presence rule, target 1, trigger
//! slot 2, `amount` 0.4, `attack` 50 ms, `release` 300 ms. `BUS_PRESENCE` sets slot 2's bit stamped
//! at 1,024 and clears it stamped at 13,824 (both quantum starts, two and many quanta ahead of the
//! batch: stamped, not asap); the release runs out over the rest.
//!
//! **The offline reference (§4.6).** Per quantum the rule's goal is `amount` while the trigger's bit
//! is set (from the start of the quantum holding the stamp: `BUS_PRESENCE` applies there), else 1;
//! the gain at the quantum's end is `goal + (g − goal) · e^(−128 / (τ · 48,000))` with τ the
//! `attack` when falling and the `release` when rising (63 % one-pole time constants), and the
//! samples between are the straight line from `g` to that end value, `g + (end − g)(k + 1)/128`.
//! Computed in f64; the output is `0.5 × gain` on both channels. Tolerance 1e-5 (the sidechain
//! offline tolerance of §10); the native error is recorded in the fixture.
//!
//! **Also:** the output is exactly 0.5 before the stamped frame and below it at that frame; the same
//! scene stamped mid-quantum (77 and 50 frames into those quanta) is bit-identical (the record
//! applies at the start of the quantum holding its frame); `splitQuanta` 0; DS0's window over the
//! duck and its release, under 1 % over the reference's own largest step.
//!
//! Needs Dp1's core (`duck::on_presence`, `duck::gain`); before it the duck never starts.

mod m5_common;

use audio_core::QUANTUM;
use m5_common::common::*;
use m5_common::*;

const TEST: &str = "m5_presence_golden";
const NAME: &str = "presence-duck";
const V1: u32 = 0x0001_0001;
/// The rule: target 1, trigger slot 2.
const RULE: PresenceRule = (1, 2, 0.4, 0.05, 0.3);
const ON: u64 = 1024;
const OFF_AT: u64 = 13_824;
const TOL: f64 = 1e-5;
/// Quanta rendered in all.
const QUANTA: usize = 300;

/// The scene, with the presence stamps `skew` frames into their quanta.
fn scene(skew: u32) -> Scene {
    let mut s = Scene::new();
    s.send(&[config(&[ROOT, 0, 0]), duck_rules(&[RULE]), dc_at(V1, 1, 0.5)]);
    s.run(4);
    assert_eq!(s.frame(), 512);
    s.send(&[presence(1 << RULE.1, (ON - 512) as u32 + skew)]);
    s.run(100);
    assert_eq!(s.frame(), 13_312);
    s.send(&[presence(0, (OFF_AT - 13_312) as u32 + skew)]);
    s.run(QUANTA - 104);
    s
}

/// The reference duck gain per frame for `n` frames (see the module comment).
fn reference(n: usize) -> Vec<f64> {
    let (_, _, amount, attack, release) = RULE;
    let q = QUANTUM as f64;
    let mut g = 1.0f64;
    let mut out = Vec::with_capacity(n);
    for start in (0..n as u64).step_by(QUANTUM) {
        let goal = if (ON..OFF_AT).contains(&start) { amount as f64 } else { 1.0 };
        let tau = if goal < g { attack } else { release } as f64;
        let end = goal + (g - goal) * (-q / (tau * RATE as f64)).exp();
        for k in 0..QUANTUM {
            out.push(g + (end - g) * (k + 1) as f64 / q);
        }
        g = end;
    }
    out.truncate(n);
    out
}

#[test]
fn a_presence_duck_starts_on_its_stamped_frame_and_matches_the_reference() {
    let s = scene(0);
    let n = s.left.len();
    assert!(s.left.iter().chain(&s.right).all(|x| x.is_finite()));
    let on = ON as usize;
    assert!(s.left[..on].iter().chain(&s.right[..on]).all(|&x| x == 0.5), "untouched before the stamped frame");
    assert!(s.left[on] < 0.5, "the duck starts on its stamped frame");
    let g = reference(n);
    let err = max_error(&s, 0, n, |i| 0.5 * g[i]);
    eprintln!("{NAME}: max error {err:e} against the offline reference (tolerance {TOL:e})");
    assert!(err <= TOL, "{NAME}: {err} against the reference");
    // Deep in the hold the gain is near `amount`; at the end the release is under way.
    assert!((s.left[OFF_AT as usize - 1] - 0.2).abs() < 2e-3);
    assert!(s.left[n - 1] > 0.4 && s.left[n - 1] < 0.5);
    assert_eq!(s.split_quanta(), 0);
    // Stamped mid-quantum: the same bits.
    let skewed = scene(77);
    assert!(skewed.left == s.left && skewed.right == s.right, "BUS_PRESENCE applies at the start of the quantum holding its frame");
    // DS0: the duck and its release.
    let ideal = (1..n).map(|i| (0.5 * (g[i] - g[i - 1])).abs()).fold(0.0, f64::max) as f32;
    let b = ideal * 1.01 + 1e-6;
    let step = max_step(&s.left[512..]).max(max_step(&s.right[512..]));
    eprintln!("{NAME}: DS0 maxStep {step:e} (bound {b:e}); the duck at once would step {}", 0.5 * (1.0 - RULE.2));
    assert!(step <= b, "{NAME}: a step of {step}, over {b}");
    // What busDuck reports: the rule's follower at the end of the last quantum, which is the
    // curve's last sample (the wasm side checks its STATUS block against the output the same way).
    let mut s = s;
    let follower = audio_core::duck::area(&mut s.m.core.regions_mut().duck[..]).unwrap().followers[0].gain;
    assert_eq!(follower, s.left[n - 1] / 0.5, "the follower is the curve's last sample");
    let raw = format!(",\"busDuck\":{{\"slot\":{},\"level\":0.5}}", RULE.0);
    let about = "G1: a presence duck (rule target 1, trigger slot 2, amount 0.4, attack 50 ms, release 300 ms) set stamped at 1024 and cleared stamped at 13824; against the per-quantum one-pole reference of architecture 4.6";
    write_or_check(TEST, NAME, about, &s, &Extra { null: Some((err, TOL, 0, n)), ds0: vec![(512, n, b)], late: false, raw });
}
