//! Sc1 (0171/0172 M5c): level-mode ducking in the core (architecture §4.6: the pre-fader tap, the
//! detector per sample, the gain computer once per quantum, the follower, the min combine, cycles
//! and `sidechainLate`; api-and-models §4.2 `BUS_DUCK` level rules).
//!
//! Acceptance, on the audio clock (core frames, the limiter's look-ahead at 0 so heard frame =
//! core frame):
//! - spike S4's follower checks: the per-quantum gain computer with the per-sample follower line
//!   stays within 0.024 dB of a per-sample computer on S4's bursty bank; the duck reaches 63 % of
//!   its depth after `attack` and keeps 37 % after `release`;
//! - a level rule over its threshold ducks the target to `amount` (steady state, 1e-4), a level
//!   inside the 6 dB knee ducks part-way, for both detectors (peak and RMS);
//! - under its threshold a level rule changes no bit (peak and RMS);
//! - the tap is pre-fader: a trigger whose own fader is at 0 still ducks;
//! - a presence rule and a level rule on one target combine by min, per sample;
//! - a level cycle that reaches the core reads its trigger a quantum late and counts
//!   `sidechainLate` once per quantum per late rule.
//!
//! The golden null test (the M5 goldens with a level rule under its threshold keep their digests)
//! is `duck_level_null.rs`.

mod common;

use audio_core::duck::{self, DuckArea, Follower, Rule};
use audio_core::{status, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const Q: usize = QUANTUM;
const LEVEL: u32 = wire::DUCK_FLAG_LEVEL;
const RMS: u32 = wire::DUCK_FLAG_RMS;

// ---------------------------------------------------------------------------------------------
// The duck state alone (S4's checks): `duck::detect` then `duck::gain`, as `bus::mixdown` calls them.

/// A duck state with one level rule (trigger 2 → target 1) and its follower's coefficients.
fn one_rule(flags: u32, threshold_db: f32, amount: f32, attack: f32, release: f32) -> Box<DuckArea> {
    // SAFETY: all-zero is a valid DuckArea (integers and floats).
    let mut d: Box<DuckArea> = Box::new(unsafe { std::mem::zeroed() });
    d.rule_count = 1;
    d.level_count = 1;
    d.rules[0] = Rule { target: 1, trigger: 2, flags: LEVEL | flags, threshold_db, amount, attack, release };
    d.followers[0] = Follower { gain: 1.0, goal: 1.0, attack_coef: duck::coefficient(attack, RATE), release_coef: duck::coefficient(release, RATE) };
    d.detectors[0] = duck::Detector { rule: 0, level_db: duck::LEVEL_FLOOR_DB, ..Default::default() };
    duck::set_sample_rate(&mut d, RATE);
    d
}

/// One quantum: the trigger's tap, then the target's lane. Returns the target's gain curve.
fn quantum(d: &mut DuckArea, l: &[f32], r: &[f32]) -> [f32; Q] {
    duck::detect(d, 2, l, r);
    let mut c = [0.0f32; Q];
    if !duck::gain(d, 1, &mut c) {
        c = [1.0; Q];
    }
    c
}

/// S4's xorshift and bursty bank (`spikes/audio-mix/mix-core/src/lib.rs`): 8 quanta of noise at
/// 0.4, 8 at 0.01, repeating.
struct Rng(u32);
impl Rng {
    fn unit(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32 - 0.5
    }
}
fn bank(n: usize, seed: u32) -> Vec<[f32; 2 * Q]> {
    let mut r = Rng(seed);
    (0..n)
        .map(|q| {
            let amp = if (q / 8) % 2 == 0 { 0.4 } else { 0.01 };
            let mut b = [0.0f32; 2 * Q];
            for x in b.iter_mut() {
                *x = r.unit() * amp;
            }
            b
        })
        .collect()
}

/// The per-sample computer S4 compares with (f64): the same detector per sample (peak: instant
/// attack, 10 ms release; RMS: 10 ms one-pole on the mean of l² and r²), the gain computer every
/// sample, and the follower per sample (63 % one-pole, attack falling, release rising).
struct PerSample {
    rms: bool,
    env: f64,
    gain: f64,
    det: f64,
    att: f64,
    rel: f64,
    threshold: f64,
    amount: f64,
}
impl PerSample {
    fn new(rms: bool, threshold: f32, amount: f32, attack: f32, release: f32) -> PerSample {
        let c = |t: f32| (-1.0 / (t as f64 * RATE as f64)).exp();
        PerSample { rms, env: 0.0, gain: 1.0, det: c(0.010), att: c(attack), rel: c(release), threshold: threshold as f64, amount: amount as f64 }
    }
    fn next(&mut self, l: f32, r: f32) -> f64 {
        let (l, r) = (l as f64, r as f64);
        let level = if self.rms {
            let x = 0.5 * (l * l + r * r);
            self.env = x + self.det * (self.env - x);
            10.0 * self.env.max(1e-24).log10()
        } else {
            let x = l.abs().max(r.abs());
            self.env = if x > self.env { x } else { x + self.det * (self.env - x) };
            20.0 * self.env.max(1e-12).log10()
        };
        let depth = ((level - self.threshold) / 6.0).clamp(0.0, 1.0);
        let goal = 1.0 - depth * (1.0 - self.amount);
        let c = if goal < self.gain { self.att } else { self.rel };
        self.gain = goal + (self.gain - goal) * c;
        self.gain
    }
}

fn db(x: f64) -> f64 {
    20.0 * x.max(1e-30).log10()
}

#[test]
fn s4_the_per_quantum_computer_is_within_0_024_db_of_a_per_sample_computer() {
    // S4's check 5 on its bursty bank with sound-lab's rule (threshold −40 dB, amount 0.3, attack
    // 50 ms, release 400 ms), for both detectors.
    let trig = bank(400, 5);
    for rms in [false, true] {
        let (threshold, amount, attack, release) = (-40.0, 0.3, 0.05, 0.4);
        let mut d = one_rule(if rms { RMS } else { 0 }, threshold, amount, attack, release);
        let mut reference = PerSample::new(rms, threshold, amount, attack, release);
        let (mut worst, mut deepest) = (0.0f64, 1.0f64);
        for b in &trig {
            let (l, r) = b.split_at(Q);
            let c = quantum(&mut d, l, r);
            for i in 0..Q {
                let want = reference.next(l[i], r[i]);
                worst = worst.max((db(c[i] as f64) - db(want)).abs());
                deepest = deepest.min(c[i] as f64);
            }
        }
        eprintln!("S4 check 5 ({}): max |gain difference| {worst:.4} dB (deepest gain {deepest:.3})", if rms { "rms" } else { "peak" });
        assert!(deepest < 0.35, "the bank ducks");
        assert!(worst <= 0.024, "{}: {worst} dB from the per-sample computer", if rms { "rms" } else { "peak" });
    }
}

#[test]
fn s4_the_duck_reaches_63_percent_at_attack_and_keeps_37_percent_at_release() {
    // S4's check 4: from silence to a loud trigger the reduction is 63 % of its depth at `attack`;
    // once the gain computer's goal is back at 1, 37 % is left at `release`.
    for rms in [false, true] {
        let (amount, attack, release) = (0.3f32, 0.05f32, 0.4f32);
        let mut d = one_rule(if rms { RMS } else { 0 }, -40.0, amount, attack, release);
        let (loud, quiet) = ([0.5f32; Q], [0.0f32; Q]);
        let depth = |g: f32| (1.0 - g as f64) / (1.0 - amount as f64);
        // The duck's end-of-quantum gain at `attack` (to the nearest frame, interpolated in the line).
        let at = (attack * RATE) as usize;
        let mut curve = Vec::new();
        while curve.len() <= at {
            curve.extend(quantum(&mut d, &loud, &loud));
        }
        let at_attack = depth(curve[at - 1]);
        for _ in 0..400 {
            quantum(&mut d, &loud, &loud);
        }
        assert!((d.followers[0].gain - amount).abs() < 1e-6, "settled on amount");
        // The release starts once the detector falls under the threshold (its own 10 ms release
        // for peak, its one-pole for RMS): count from the first quantum whose goal is 1.
        let mut q = 0;
        while d.followers[0].goal < 1.0 || q == 0 {
            quantum(&mut d, &quiet, &quiet);
            q += 1;
        }
        let held = depth(d.followers[0].gain);
        let quanta = ((release * RATE) as usize).div_ceil(Q);
        let mut g = d.followers[0].gain;
        for _ in 0..quanta - 1 {
            g = quantum(&mut d, &quiet, &quiet)[Q - 1];
        }
        let at_release = depth(g) / held;
        eprintln!("S4 check 4 ({}): attack {at_attack:.3}, release {at_release:.3} (goal back at 1 after {q} quanta)", if rms { "rms" } else { "peak" });
        assert!((at_attack - 0.632).abs() < 0.03, "attack: {at_attack}");
        assert!((at_release - 0.368).abs() < 0.03, "release: {at_release}");
    }
}

#[test]
fn a_rule_under_its_threshold_is_identity_and_a_late_rule_starts_from_silence() {
    // The lane is skipped (gain returns false) while the trigger is under the threshold.
    let mut d = one_rule(0, -6.0, 0.2, 0.01, 0.1);
    let quiet = [0.25f32; Q]; // −12 dB, 6 dB under the threshold: depth 0.
    let mut c = [0.0f32; Q];
    for _ in 0..50 {
        duck::detect(&mut d, 2, &quiet, &quiet);
        assert!(!duck::gain(&mut d, 1, &mut c), "under the threshold the lane is at identity");
    }
    // A late rule reads the previous quantum's level: before any, a new detector reads silence.
    let mut d = one_rule(0, -30.0, 0.2, 0.0, 0.1);
    d.rules[0].set_late(true);
    assert!(!duck::gain(&mut d, 1, &mut c), "a new late rule reads silence, not 0 dB");
    duck::detect(&mut d, 2, &[0.5; Q], &[0.5; Q]);
    assert!(duck::gain(&mut d, 1, &mut c) && (c[Q - 1] - 0.2).abs() < 1e-6, "then the level of the quantum before");
    assert_eq!(d.late_pending, 2, "a late detection per quantum");
}

// ---------------------------------------------------------------------------------------------
// The core: BATCH records through `scheduler::submit`, quanta from `Core::process`.

fn level(trigger: u16, target: u16, flags: u32, threshold_db: f32, amount: f32, attack: f32, release: f32) -> wire::BusDuckRules {
    wire::BusDuckRules { target, trigger, flags: LEVEL | flags, threshold_db, amount, attack, release }
}

fn presence_rule(trigger: u16, target: u16, amount: f32, attack: f32, release: f32) -> wire::BusDuckRules {
    wire::BusDuckRules { target, trigger, flags: 0, threshold_db: 0.0, amount, attack, release }
}

fn duck_rec(rules: &[wire::BusDuckRules]) -> Rec {
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: rules.to_vec() }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn presence(mask: u32) -> Rec {
    let mut b = vec![0u8; wire::BusPresence::FIXED_END];
    wire::BusPresence { voice_id: 0, frame_offset: wire::ASAP, mask }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// Master, Music (1, the target), SFX (2, the trigger), UI (3). A DC 1.0 voice on Music with Music
/// at 0.25 (under the limiter); `trigger` true adds a DC 1.0 voice on SFX with SFX's fader at 0, so
/// the output is Music alone while the trigger's pre-fader level is 0 dB (peak and RMS).
fn scene(trigger: bool) -> Mixer {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    m.submit(&[config(&[ROOT, 0, 0, 0]), gains(0, &[1.0, 0.25, 0.0, 1.0]), dc(0x0001_0001, 1, 0.0)]);
    if trigger {
        m.submit(&[dc(0x0002_0002, 2, 0.0)]);
    }
    m
}

/// The duck gain per frame: the output over Music's undiminished 0.25.
fn duck_gain(out: &[f32]) -> Vec<f32> {
    out.iter().map(|x| x / 0.25).collect()
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

/// The per-quantum follower the core runs: the end-of-quantum gains from 1 toward `goal`.
fn step(start: f32, goal: f32, c: f32) -> f32 {
    let e = goal + (start - goal) * c;
    if (e - goal).abs() < duck::SETTLE {
        goal
    } else {
        e
    }
}

fn take_late(m: &mut Mixer) -> u16 {
    let mut out = vec![0u8; status::BUFFER_BYTES];
    assert!(status::take(&mut m.core, &mut out, 0x400) > 0);
    status::counters(&m.core).mix.sidechain_late
}

#[test]
fn a_level_rule_over_its_threshold_ducks_the_target_to_amount() {
    // Both detectors (a DC 1.0 trigger reads 0 dB on each); a level 30 dB over the threshold
    // ducks fully, one 3 dB over (half the 6 dB knee) ducks halfway in gain.
    for flags in [0, RMS] {
        for (threshold, amount, want) in [(-30.0f32, 0.3f32, 0.3f32), (-3.0, 0.3, 0.65)] {
            let mut m = scene(true);
            m.submit(&[duck_rec(&[level(2, 1, flags, threshold, amount, 0.01, 0.1)])]);
            let g = duck_gain(&m.render_n(200).0);
            let settled = &g[150 * Q..];
            let worst = settled.iter().map(|x| (x - want).abs()).fold(0.0, f32::max);
            assert!(worst < 1e-4, "flags {flags:#x}, threshold {threshold}: steady {} vs {want}", settled[0]);
            // The STATUS section reads the follower.
            let mut mix = audio_core::counters::MixSections::default();
            duck::status(&mut m.core, &mut mix);
            assert!((mix.bus_duck.as_slice()[0].gain - want).abs() < 1e-4);
            // Peak: the duck attacks by the follower law from the first quantum (the trigger mixes
            // first). RMS: its 10 ms one-pole reads -6.3 dB at the first quantum's end, so a -3 dB
            // threshold first fires in the second quantum.
            if flags == RMS {
                continue;
            }
            let c = duck::coefficient(0.01, RATE);
            let end0 = step(1.0, want, c);
            for k in 0..Q {
                let w = 1.0 + (end0 - 1.0) * (k + 1) as f32 / Q as f32;
                assert!((g[k] - w).abs() < 2e-6, "frame {k}: {} vs {w}", g[k]);
            }
        }
    }
}

#[test]
fn a_level_rule_under_its_threshold_changes_no_bit() {
    // The same 0 dB trigger under thresholds of +0.5 dB and +12 dB: the goal is exactly 1, so the
    // lane stays skipped, bit for bit the scene without the rule, for both detectors.
    let plain = scene(true).render_n(60);
    for flags in [0, RMS] {
        for threshold in [0.5f32, 12.0] {
            let mut m = scene(true);
            m.submit(&[duck_rec(&[level(2, 1, flags, threshold, 0.1, 0.0, 0.05)])]);
            let got = m.render_n(60);
            assert_eq!((bits(&got.0), bits(&got.1)), (bits(&plain.0), bits(&plain.1)), "flags {flags:#x}, threshold {threshold}");
        }
    }
}

#[test]
fn the_tap_is_pre_fader_and_the_trigger_going_quiet_releases() {
    // SFX's fader is 0 in the scene (the output is Music alone) and still ducks; when SFX's voice
    // stops, the detector falls and the duck releases to exactly 1 (the lane at identity again).
    let mut m = scene(true);
    m.submit(&[duck_rec(&[level(2, 1, 0, -20.0, 0.5, 0.0, 0.02)])]);
    let g = duck_gain(&m.render_n(4).0);
    // Attack 0: the first quantum is the line from 1 to amount, then amount.
    assert!(g[0] < 1.0 && g[Q..].iter().all(|&x| (x - 0.5).abs() < 1e-6), "ducked from the first quantum");
    m.submit(&[Rec::Set(wire::SetParams { voice_id: 0x0002_0002, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_GAIN, gain: 0.0, ..Default::default() })]);
    m.render_n(400);
    let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    assert_eq!(d.followers[0].gain, 1.0, "released to exactly 1");
    let mut c = [0.0f32; Q];
    assert!(!duck::gain(d, 1, &mut c), "identity: the lane skipped");
}

#[test]
fn a_presence_rule_and_a_level_rule_on_one_target_take_the_min_per_sample() {
    // Presence (trigger slot 3's bit) ducks Music to 0.5 fast; the level rule (SFX at 0 dB, 30 dB
    // over) to 0.2 slowly: the presence rule leads, then the level rule.
    let (a1, a2) = (0.002f32, 0.05f32);
    let mut m = scene(true);
    m.submit(&[duck_rec(&[presence_rule(3, 1, 0.5, a1, 0.1), level(2, 1, 0, -30.0, 0.2, a2, 0.1)]), presence(1 << 3)]);
    let quanta = 60;
    let g = duck_gain(&m.render_n(quanta).0);
    let (c1, c2) = (duck::coefficient(a1, RATE), duck::coefficient(a2, RATE));
    let (mut s1, mut s2) = (1.0f32, 1.0f32);
    let (mut lead1, mut lead2) = (false, false);
    for q in 0..quanta {
        let (e1, e2) = (step(s1, 0.5, c1), step(s2, 0.2, c2));
        for k in 0..Q {
            let f = (k + 1) as f32 / Q as f32;
            let (p, l) = (s1 + (e1 - s1) * f, s2 + (e2 - s2) * f);
            let want = p.min(l);
            let c = q * Q + k;
            assert!((g[c] - want).abs() < 2e-6, "frame {c}: {} vs min({p}, {l})", g[c]);
            lead1 |= p < l;
            lead2 |= l < p;
        }
        (s1, s2) = (e1, e2);
    }
    assert!(lead1 && lead2, "each rule leads in turn");
    let mut mix = audio_core::counters::MixSections::default();
    duck::status(&mut m.core, &mut mix);
    assert_eq!(mix.bus_duck.len(), 1, "one entry for the target");
    assert!((mix.bus_duck.as_slice()[0].gain - s1.min(s2)).abs() < 1e-6);
}

#[test]
fn a_level_cycle_that_reaches_the_core_reads_late_and_counts_sidechain_late() {
    // Music → SFX (threshold +10 dB: never fires, but adds its edge first) and SFX → Music: the
    // second closes a cycle, so its edge is dropped (Music mixes before SFX) and its detector is
    // read a quantum late. SFX's voice starts at quantum 4: the late duck starts at quantum 5,
    // the same rule without the cycle at quantum 4.
    let run = |cycle: bool| {
        let mut m = scene(false);
        let mut rules = vec![level(2, 1, 0, -30.0, 0.3, 0.0, 0.1)];
        if cycle {
            rules.insert(0, level(1, 2, 0, 10.0, 0.3, 0.0, 0.1));
        }
        m.submit(&[duck_rec(&rules)]);
        let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
        assert_eq!(d.rules().iter().any(Rule::is_late), cycle);
        let mut g = duck_gain(&m.render_n(4).0);
        m.submit(&[dc(0x0002_0002, 2, 0.0)]);
        g.extend(duck_gain(&m.render_n(4).0));
        (m, g)
    };
    let (mut late, gl) = run(true);
    let (mut direct, gd) = run(false);
    // Attack 0: the duck's first quantum is the line from 1 to amount, then amount.
    let starts_at = |g: &[f32], q: usize| g[..q * Q].iter().all(|&x| x == 1.0) && g[q * Q] < 1.0 && g[(q + 1) * Q..].iter().all(|&x| (x - 0.3).abs() < 1e-6);
    assert!(starts_at(&gd, 4), "no cycle: the duck starts at quantum 4");
    assert!(starts_at(&gl, 5), "a cycle: a quantum late, at quantum 5");
    // One late detection per quantum the late rule ran (8), none without the cycle.
    assert_eq!(take_late(&mut late), 8);
    assert_eq!(take_late(&mut direct), 0);
    late.render_n(3);
    assert_eq!(take_late(&mut late), 11, "cumulative");
    // The cycle gone, no more late detections.
    late.submit(&[duck_rec(&[level(2, 1, 0, -30.0, 0.3, 0.0, 0.1)])]);
    late.render_n(3);
    assert_eq!(take_late(&mut late), 11);
}

#[test]
fn reset_clears_the_detectors_and_the_rules_resume_from_silence() {
    let mut m = scene(true);
    m.submit(&[duck_rec(&[level(2, 1, 0, -30.0, 0.3, 0.0, 0.1)])]);
    m.render_n(4);
    m.submit(&[reset(true)]);
    let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    assert_eq!((d.followers[0].gain, d.detectors[0].env, d.detectors[0].level_db), (1.0, 0.0, duck::LEVEL_FLOOR_DB));
    assert_eq!(d.rule_count, 1, "the rules stay");
}
