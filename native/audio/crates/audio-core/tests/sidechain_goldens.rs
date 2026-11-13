//! Gs1 (0171/0172 M5c): the sidechain goldens (architecture §4.6; api-and-models §10 "Golden",
//! "sidechain null tests"): fixtures under `golden/m5/sidechain/`, written here with
//! `UPDATE_GOLDENS=1` (G1's recorder, `m5_common`) and replayed bit for bit on the real wasm by
//! `runtime/golden/audioGoldenSidechain.test.ts`.
//!
//! **The rig.** Master (0), Music (1, the target), SFX (2, the trigger), UI (3, the presence
//! rule's trigger slot), no look-ahead. A DC voice
//! at 0.5 on Music; the trigger is a DC voice at 0.5 (−6.02 dBFS) on SFX with SFX's fader at 0, so
//! the output is Music alone while the detector reads SFX's pre-fader signal (the tap is before
//! every lane). The trigger starts stamped mid-quantum and stops (no fade) stamped mid-quantum.
//!
//! **The scenes.**
//! - `level-null` and `level-null-plain`: a peak and an RMS level rule whose thresholds (−5 dB) sit
//!   over the trigger's −6.02 dB, and the same scene with no `BUS_DUCK`: one digest.
//! - `level-peak` and `level-rms`: one level rule each (threshold −20 dB, amount 0.25, attack
//!   20 ms, release 150 ms): the trigger's onset ducks, its stop releases through the 6 dB knee.
//! - `presence-level`: a presence rule (slot 3's bit, amount 0.5, attack 5 ms, release 100 ms) and a
//!   peak level rule (threshold −20 dB, amount 0.2, attack 60 ms, release 200 ms) on Music: per
//!   sample, the min of the two.
//!
//! **The offline reference** (§4.6, in f64, from the formulas alone; nothing from the core but
//! the scene's known trigger signal, which a trigger-alone render confirms bit for bit):
//! - detector per sample: peak `env = x > env ? x : x + p(env − x)` on `x = max(|l|, |r|)`, RMS
//!   `env = x + p(env − x)` on `x = (l² + r²)/2`, `p = e^(−1/(0.010 · 48,000))`; the quantum's level
//!   is the envelope at its end, `20 log10` (peak) or `10 log10` (RMS);
//! - gain computer per quantum: depth = clamp((level − threshold)/6, 0, 1), goal = 1 − depth(1 − amount);
//!   a presence rule's goal is `amount` while its bit is set (from the quantum holding the stamp);
//! - follower: the quantum's end gain `goal + (g − goal) e^(−128/(τ · 48,000))`, τ the attack when
//!   falling and the release when rising, the samples between on the line `g + (end − g)(k + 1)/128`;
//! - rules combine by min per sample; the output is `0.5 × gain` on both channels. Tolerance 1e-5.
//!
//! **DS0:** over the duck's onset and release the largest sample step stays within 1 % (plus 1e-6)
//! of the reference's own largest step there (`maxStep`, F-40).

mod m5_common;

use audio_core::QUANTUM;
use audio_wire::generated as wire;
use m5_common::common::*;
use m5_common::*;

const TEST: &str = "sidechain_goldens";
const MUSIC: u32 = 0x0001_0001;
const SFX: u32 = 0x0002_0002;
/// The trigger's start and stop frames (stamped, mid-quantum).
const START: u64 = 1024 + 37;
const STOP: u64 = 8192 + 50;
/// The trigger's level: DC 0.5 (−6.02 dBFS on both detectors' scales: peak 0.5, RMS 0.25 mean square).
const TRIG: f32 = 0.5;
const TOL: f64 = 1e-5;
const QUANTA: usize = 200;
/// The presence bit's set and clear frames (`presence-level`).
const PRESENCE_ON: u64 = 512 + 300;
const PRESENCE_OFF: u64 = 5120 + 64;
const PRESENCE_SLOT: u16 = 3;

/// One level rule: `(trigger, target, rms, threshold dB, amount, attack s, release s)`.
type LevelRule = (u16, u16, bool, f32, f32, f32, f32);

const PEAK_RULE: LevelRule = (2, 1, false, -20.0, 0.25, 0.02, 0.15);
const RMS_RULE: LevelRule = (2, 1, true, -20.0, 0.25, 0.02, 0.15);
/// `presence-level`'s rules: the presence rule `(slot, target, amount, attack, release)` and the level rule.
const COMBO_PRESENCE: PresenceRule = (1, PRESENCE_SLOT, 0.5, 0.005, 0.1);
const COMBO_LEVEL: LevelRule = (2, 1, false, -20.0, 0.2, 0.06, 0.2);

fn level_item(r: LevelRule) -> wire::BusDuckRules {
    let (trigger, target, rms, threshold_db, amount, attack, release) = r;
    let flags = wire::DUCK_FLAG_LEVEL | if rms { wire::DUCK_FLAG_RMS } else { 0 };
    wire::BusDuckRules { target, trigger, flags, threshold_db, amount, attack, release }
}

fn presence_item(r: PresenceRule) -> wire::BusDuckRules {
    let (target, trigger, amount, attack, release) = r;
    wire::BusDuckRules { target, trigger, flags: 0, threshold_db: 0.0, amount, attack, release }
}

/// `BUS_DUCK` of `rules` (asap, replace-all).
fn duck(rules: &[wire::BusDuckRules]) -> Rec {
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: rules.to_vec() }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// A DC voice at `gain` on `bus`, stamped `offset` frames after its batch's first frame.
fn dc_stamped(voice: u32, bus: u16, gain: f32, offset: u32) -> Rec {
    let Rec::Play(mut p) = dc_at(voice, bus, gain) else { unreachable!() };
    p.frame_offset = offset;
    Rec::Play(p)
}

/// STOP of `voice`, no fade, stamped `offset` frames after its batch's first frame.
fn stop(voice: u32, offset: u32) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: offset, fade_frames: 0, ..Default::default() }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// The rig with `rules` (none: no `BUS_DUCK`). `music`: Music's voice plays; `sfx_fader`: SFX's
/// runtime lane (0 in every golden: the output is Music alone). `presence`: the presence stamps.
fn scene(rules: Option<&[wire::BusDuckRules]>, music: bool, sfx_fader: f32, presence_stamps: bool) -> Scene {
    let mut s = Scene::new();
    let mut first = vec![config(&[ROOT, 0, 0, 0]), gains(0, &[1.0, 1.0, sfx_fader, 1.0])];
    if let Some(r) = rules {
        first.push(duck(r));
    }
    if music {
        first.push(dc_at(MUSIC, 1, 0.5));
    }
    s.send(&first);
    s.run(4);
    assert_eq!(s.frame(), 512);
    // The trigger's start (and the presence bit's set) two or more quanta ahead: stamped.
    let mut recs = vec![dc_stamped(SFX, 2, TRIG, (START - 512) as u32)];
    if presence_stamps {
        recs.push(presence(1 << PRESENCE_SLOT, (PRESENCE_ON - 512) as u32));
    }
    s.send(&recs);
    s.run(36);
    assert_eq!(s.frame(), 5120);
    let mut recs = vec![stop(SFX, (STOP - 5120) as u32)];
    if presence_stamps {
        recs.push(presence(0, (PRESENCE_OFF - 5120) as u32));
    }
    s.send(&recs);
    s.run(QUANTA - 40);
    s
}

/// The trigger's pre-fader signal per frame (both channels): `TRIG` over `[START, STOP)`.
fn trigger(n: usize) -> Vec<f64> {
    (0..n as u64).map(|f| if (START..STOP).contains(&f) { TRIG as f64 } else { 0.0 }).collect()
}

/// One rule's follower in the reference: its gain at the last quantum's end.
struct Follower {
    g: f64,
    attack: f64,
    release: f64,
}

impl Follower {
    fn new(attack: f32, release: f32) -> Follower {
        Follower { g: 1.0, attack: attack as f64, release: release as f64 }
    }
    /// One quantum toward `goal`: the per-sample line.
    fn quantum(&mut self, goal: f64) -> [f64; QUANTUM] {
        let q = QUANTUM as f64;
        let tau = if goal < self.g { self.attack } else { self.release };
        let end = goal + (self.g - goal) * (-q / (tau * RATE as f64)).exp();
        let mut out = [0.0; QUANTUM];
        for (k, o) in out.iter_mut().enumerate() {
            *o = self.g + (end - self.g) * (k + 1) as f64 / q;
        }
        self.g = end;
        out
    }
}

/// A level rule's detector and gain computer in the reference.
struct Detector {
    rms: bool,
    env: f64,
    pole: f64,
}

impl Detector {
    fn new(rms: bool) -> Detector {
        Detector { rms, env: 0.0, pole: (-1.0 / (0.010 * RATE as f64)).exp() }
    }
    /// The quantum's level, dB (the envelope at its end), over the trigger's mono-equal channels.
    fn quantum(&mut self, x: &[f64]) -> f64 {
        for &s in x {
            if self.rms {
                let v = 0.5 * (s * s + s * s);
                self.env = v + self.pole * (self.env - v);
            } else {
                let v = s.abs();
                self.env = if v > self.env { v } else { v + self.pole * (self.env - v) };
            }
        }
        if self.env <= 0.0 {
            f64::NEG_INFINITY
        } else if self.rms {
            10.0 * self.env.log10()
        } else {
            20.0 * self.env.log10()
        }
    }
}

/// The gain computer (§4.6).
fn goal(level_db: f64, threshold_db: f32, amount: f32) -> f64 {
    let depth = ((level_db - threshold_db as f64) / 6.0).clamp(0.0, 1.0);
    1.0 - depth * (1.0 - amount as f64)
}

/// The reference duck gain per frame of the level rule `level` and (optionally) the presence rule
/// `presence`, combined by min per sample; also each rule's own curve.
fn reference(n: usize, level: LevelRule, with_presence: Option<PresenceRule>) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let (_, _, rms, threshold, amount, attack, release) = level;
    let trig = trigger(n);
    let mut det = Detector::new(rms);
    let mut fl = Follower::new(attack, release);
    let mut fp = with_presence.map(|p| Follower::new(p.3, p.4));
    let (mut both, mut lv, mut pr) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for start in (0..n).step_by(QUANTUM) {
        let lvl = det.quantum(&trig[start..start + QUANTUM]);
        let l = fl.quantum(goal(lvl, threshold, amount));
        let p = match (&mut fp, with_presence) {
            (Some(f), Some(r)) => {
                let on = (PRESENCE_ON / QUANTUM as u64 * QUANTUM as u64..PRESENCE_OFF / QUANTUM as u64 * QUANTUM as u64).contains(&(start as u64));
                f.quantum(if on { r.2 as f64 } else { 1.0 })
            }
            _ => [1.0; QUANTUM],
        };
        for k in 0..QUANTUM {
            both.push(l[k].min(p[k]));
            lv.push(l[k]);
            pr.push(p[k]);
        }
    }
    (both, lv, pr)
}

/// The reference's own largest step of `0.5 × g` over `[from, to)`, plus 1 % and 1e-6 (DS0's bound).
fn ds0_bound(g: &[f64], from: usize, to: usize) -> f32 {
    let ideal = (from.max(1)..to).map(|i| (0.5 * (g[i] - g[i - 1])).abs()).fold(0.0, f64::max) as f32;
    ideal * 1.01 + 1e-6
}

fn step2(s: &Scene, from: usize, to: usize) -> f32 {
    max_step(&s.left[from..to]).max(max_step(&s.right[from..to]))
}

#[test]
fn the_trigger_signal_is_the_one_the_reference_assumes() {
    // The trigger alone, its fader at 1, no target, no rule: the output is its signal, bit for bit.
    let s = scene(None, false, 1.0, false);
    let want = trigger(s.left.len());
    assert!(s.left.iter().zip(&want).all(|(&x, &w)| x as f64 == w) && s.left == s.right, "the trigger is DC 0.5 over [START, STOP)");
}

#[test]
fn level_rules_over_their_trigger_are_bit_identical_to_no_rule() {
    // A peak and an RMS rule, thresholds −5 dB, over the trigger's −6.02 dB.
    let rules = [level_item((2, 1, false, -5.0, 0.1, 0.0, 0.05)), level_item((2, 1, true, -5.0, 0.1, 0.01, 0.05))];
    let mut ruled = scene(Some(&rules), true, 0.0, false);
    let plain = scene(None, true, 0.0, false);
    let n = plain.left.len();
    assert!(plain.left.iter().chain(&plain.right).all(|&x| x == 0.5), "the plain scene is Music alone");
    let (dr, dp) = (fnv1a64(&ruled.left, &ruled.right), fnv1a64(&plain.left, &plain.right));
    eprintln!("level-null: {dr}, level-null-plain: {dp}");
    assert_eq!(dr, dp, "a level rule over its trigger's level changed the sound");
    // Not vacuous: the same rules 1 dB under the trigger's level (−7 dB) are heard, each alone.
    for r in rules {
        let under = scene(Some(&[wire::BusDuckRules { threshold_db: -7.0, ..r }]), true, 0.0, false);
        assert_ne!(fnv1a64(&under.left, &under.right), dp, "a rule 1 dB under its trigger's level ducks (rms: {})", r.flags & wire::DUCK_FLAG_RMS != 0);
    }
    // Both detectors ran (the trigger has stopped by the end: both read under the threshold) and
    // neither follower moved.
    let d = audio_core::duck::area(&mut ruled.m.core.regions_mut().duck[..]).unwrap();
    assert_eq!(d.level_count, 2);
    assert!(d.detectors[..2].iter().all(|x| x.level_db < -5.0));
    assert!(d.followers[..2].iter().all(|f| f.gain == 1.0));
    let raw = ",\"twin\":\"sidechain/level-null-plain\"".to_string();
    let about = "Gs1: a peak and an RMS level rule (thresholds -5 dB) over a -6.02 dB DC trigger on SFX (fader 0) ducking Music (DC 0.5): bit-identical to sidechain/level-null-plain, the scene with no rule";
    write_or_check(TEST, "sidechain/level-null", about, &ruled, &Extra { raw, ..Extra::default() });
    let about = "Gs1: sidechain/level-null with no BUS_DUCK: its digest is level-null's";
    write_or_check(TEST, "sidechain/level-null-plain", about, &plain, &Extra::default());
    assert_eq!(n, QUANTA * QUANTUM);
}

/// A detected duck against the reference, its DS0 windows, and its fixture.
fn duck_golden(name: &str, rule: LevelRule, about: &str) {
    let s = scene(Some(&[level_item(rule)]), true, 0.0, false);
    let n = s.left.len();
    assert!(s.left.iter().chain(&s.right).all(|x| x.is_finite()));
    let (g, _, _) = reference(n, rule, None);
    let start_q = START as usize / QUANTUM * QUANTUM;
    assert!(s.left[..start_q].iter().all(|&x| x == 0.5), "{name}: untouched before the trigger's quantum");
    assert!(s.left[start_q] < 0.5, "{name}: the duck starts in the trigger's quantum");
    let err = max_error(&s, 0, n, |i| 0.5 * g[i]);
    eprintln!("{name}: max error {err:e} against the offline reference (tolerance {TOL:e})");
    assert!(err <= TOL, "{name}: {err} against the reference");
    // The duck reaches `amount` in the hold and is releasing at the end.
    let held = s.left[STOP as usize - 1] as f64 / 0.5;
    assert!((held - rule.4 as f64).abs() < 1e-3, "{name}: held at {held}");
    assert!(s.left[n - 1] > 0.5 * rule.4 && s.left[n - 1] < 0.5);
    // The knee: on the release some quantum's goal is strictly between amount and 1.
    let stop_q = STOP as usize / QUANTUM;
    let mut det = Detector::new(rule.2);
    let trig = trigger(n);
    let goals: Vec<f64> = (0..n / QUANTUM).map(|q| goal(det.quantum(&trig[q * QUANTUM..(q + 1) * QUANTUM]), rule.3, rule.4)).collect();
    assert!(goals[stop_q..].iter().any(|&x| x > rule.4 as f64 + 1e-3 && x < 1.0 - 1e-3), "{name}: the release runs through the knee");
    assert_eq!(s.split_quanta(), 0);
    // DS0: the onset and the release.
    let onset = (start_q, start_q + 64 * QUANTUM, ds0_bound(&g, start_q, start_q + 64 * QUANTUM));
    let rel_from = stop_q * QUANTUM;
    let release = (rel_from, n, ds0_bound(&g, rel_from, n));
    for (from, to, b) in [onset, release] {
        let step = step2(&s, from, to);
        eprintln!("{name}: DS0 {from}..{to}: maxStep {step:e} (bound {b:e}); the duck at once would step {}", 0.5 * (1.0 - rule.4));
        assert!(step <= b, "{name}: a step of {step} over {b} in {from}..{to}");
    }
    let raw = ",\"busDuck\":{\"slot\":1,\"level\":0.5}".to_string();
    write_or_check(TEST, name, about, &s, &Extra { null: Some((err, TOL, 0, n)), ds0: vec![onset, release], late: false, raw });
}

#[test]
fn a_peak_rule_ducks_as_the_offline_reference() {
    duck_golden("sidechain/level-peak", PEAK_RULE, "Gs1: a peak level rule (threshold -20 dB, amount 0.25, attack 20 ms, release 150 ms) on a -6.02 dB DC trigger (SFX, fader 0) started stamped at 1061 and stopped at 8242, ducking Music (DC 0.5); against the per-sample detector, per-quantum gain computer and one-pole follower of architecture 4.6");
}

#[test]
fn an_rms_rule_ducks_as_the_offline_reference() {
    duck_golden("sidechain/level-rms", RMS_RULE, "Gs1: an RMS level rule (threshold -20 dB, amount 0.25, attack 20 ms, release 150 ms) on a -6.02 dB DC trigger (SFX, fader 0) started stamped at 1061 and stopped at 8242, ducking Music (DC 0.5); against the per-sample detector, per-quantum gain computer and one-pole follower of architecture 4.6");
}

#[test]
fn presence_and_level_on_one_target_combine_by_min_per_sample() {
    let rules = [presence_item(COMBO_PRESENCE), level_item(COMBO_LEVEL)];
    let s = scene(Some(&rules), true, 0.0, true);
    let n = s.left.len();
    let (g, lv, pr) = reference(n, COMBO_LEVEL, Some(COMBO_PRESENCE));
    let err = max_error(&s, 0, n, |i| 0.5 * g[i]);
    eprintln!("presence-level: max error {err:e} against min(presence, level) (tolerance {TOL:e})");
    assert!(err <= TOL, "presence-level: {err} against the reference");
    // Each rule leads somewhere, so the min is more than either rule alone.
    let lead_p = (0..n).filter(|&i| pr[i] < lv[i] - 1e-3).count();
    let lead_l = (0..n).filter(|&i| lv[i] < pr[i] - 1e-3).count();
    eprintln!("presence-level: presence leads {lead_p} frames, level {lead_l}");
    assert!(lead_p > 1000 && lead_l > 1000, "each rule leads in turn");
    let alone_l = max_error(&s, 0, n, |i| 0.5 * lv[i]);
    let alone_p = max_error(&s, 0, n, |i| 0.5 * pr[i]);
    assert!(alone_l > 1e-2 && alone_p > 1e-2, "neither rule alone is the output");
    assert_eq!(s.split_quanta(), 0);
    let from = PRESENCE_ON as usize / QUANTUM * QUANTUM;
    let w = (from, n, ds0_bound(&g, from, n));
    let step = step2(&s, w.0, w.1);
    eprintln!("presence-level: DS0 {}..{}: maxStep {step:e} (bound {:e})", w.0, w.1, w.2);
    assert!(step <= w.2);
    let raw = ",\"busDuck\":{\"slot\":1,\"level\":0.5}".to_string();
    let about = "Gs1: a presence rule (slot 3, amount 0.5, attack 5 ms, release 100 ms; set stamped at 812, cleared at 5184) and a peak level rule (threshold -20 dB, amount 0.2, attack 60 ms, release 200 ms; DC trigger -6.02 dB from 1061 to 8242) on Music (DC 0.5): per sample the min of the two references";
    write_or_check(TEST, "sidechain/presence-level", about, &s, &Extra { null: Some((err, TOL, 0, n)), ds0: vec![w], late: false, raw });
}
