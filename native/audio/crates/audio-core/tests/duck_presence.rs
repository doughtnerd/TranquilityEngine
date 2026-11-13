//! Dp1 (0171/0172 M5-0): presence ducking in the core (architecture §4.6 R4; api-and-models §4.2
//! `BUS_DUCK`, `BUS_PRESENCE`, §4.3 `busDuck`).
//!
//! Acceptance, on the audio clock (core frames; the output is compared heard against a reference
//! render of the same scene without the duck, so the ratio is the duck gain at each core frame):
//! a presence duck starts on its stamped frame's quantum and releases with `release`; `busDuck`
//! reads the follower; rules combine by min; a bus no rule targets stays bit-identical; RESET
//! settles the followers.

mod common;

use audio_core::counters::MixSections;
use audio_core::{duck, status, QUANTUM};
use audio_wire::generated as wire;
use common::*;

const Q: usize = QUANTUM;

fn rule(trigger: u16, target: u16, amount: f32, attack: f32, release: f32) -> wire::BusDuckRules {
    wire::BusDuckRules { target, trigger, flags: 0, threshold_db: -30.0, amount, attack, release }
}

fn duck_rec(rules: &[wire::BusDuckRules]) -> Rec {
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: rules.to_vec() }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// `BUS_PRESENCE` of `mask`, stamped at absolute frame `at` (submitted at `now`), or asap.
fn presence(mask: u32, now: u64, at: Option<u64>) -> Rec {
    let frame_offset = at.map_or(wire::ASAP, |f| (f - now) as u32);
    let mut b = vec![0u8; wire::BusPresence::FIXED_END];
    wire::BusPresence { voice_id: 0, frame_offset, mask }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// Master, Music (1), SFX (2), UI (3); a DC voice on Music, Music at 0.5 (well under the limiter).
fn scene() -> Mixer {
    let mut m = Mixer::new(4);
    m.submit(&[config(&[ROOT, 0, 0, 0]), gains(0, &[1.0, 0.5, 1.0, 1.0]), dc(0x0001_0001, 1, 0.0)]);
    m
}

/// The per-quantum coefficient the core uses.
fn coef(t: f32) -> f32 {
    duck::coefficient(t, RATE)
}

/// The analytic follower: the gains at the end of each quantum from `start` toward `goal`.
fn step(start: f32, goal: f32, c: f32) -> f32 {
    let e = goal + (start - goal) * c;
    if (e - goal).abs() < duck::SETTLE {
        goal
    } else {
        e
    }
}

/// The duck gain at each core frame of `test` against `reference` (left channel), from core frame 0.
fn ratio(test: &[f32], reference: &[f32], latency: usize) -> Vec<f32> {
    (latency..test.len()).map(|h| if reference[h] == 0.0 { f32::NAN } else { test[h] / reference[h] }).collect()
}

fn duck_status(m: &mut Mixer) -> Vec<(u16, f32)> {
    let mut mix = MixSections::default();
    duck::status(&mut m.core, &mut mix);
    mix.bus_duck.as_slice().iter().map(|d| (d.slot, d.gain)).collect()
}

#[test]
fn a_presence_duck_starts_on_its_stamped_frame_and_releases_with_release() {
    let (amount, attack, release) = (0.25, 0.01, 0.2);
    let (on_at, off_at) = (10 * Q as u64, 30 * Q as u64);
    let mut reference = scene();
    let mut m = scene();
    m.submit(&[duck_rec(&[rule(2, 1, amount, attack, release)])]);
    assert_eq!(duck_status(&mut m), vec![(1, 1.0)], "a target reads gain 1 before any presence");
    // Stamped presence (SFX has a voice from frame on_at), then its explicit stop at off_at.
    m.submit(&[presence(1 << 2, 0, Some(on_at)), presence(0, 0, Some(off_at))]);
    let quanta = 120;
    let want_ref = reference.render_n(quanta).0;
    let got = m.render_n(quanta).0;
    let lat = m.latency();
    let g = ratio(&got, &want_ref, lat);
    // Before the stamp: bit-identical (the lane is skipped).
    for c in Q..on_at as usize {
        assert_eq!(got[c + lat].to_bits(), want_ref[c + lat].to_bits(), "core frame {c} before the stamp");
    }
    // From the stamped frame: the attack, interpolated per sample from 1.
    let (ca, cr) = (coef(attack), coef(release));
    let mut start = 1.0f32;
    let mut held = 0.0;
    for q in (on_at as usize / Q)..quanta {
        let goal = if (q * Q) < off_at as usize { amount } else { 1.0 };
        let end = step(start, goal, if goal < start { ca } else { cr });
        for k in 0..Q {
            let c = q * Q + k;
            if c >= g.len() {
                break;
            }
            let want = start + (end - start) * (k + 1) as f32 / Q as f32;
            assert!((g[c] - want).abs() < 2e-5, "core frame {c}: duck gain {} expected {want}", g[c]);
        }
        if (q + 1) * Q == off_at as usize {
            held = end;
        }
        start = end;
    }
    assert!(g[on_at as usize] < 1.0 && g[on_at as usize - 1] == 1.0, "the duck starts at core frame {on_at}");
    assert!(held < 0.3, "attacked toward amount by the stop: {held}");
    // The release: 63 % of the way back to 1 after `release` seconds (to a quantum).
    let tau = (release * RATE) as usize;
    let at_tau = g[off_at as usize + tau];
    let want_tau = 1.0 - (1.0 - held) * (-1.0f32).exp();
    assert!((at_tau - want_tau).abs() < 0.01, "after release: {at_tau} ~ {want_tau}");
    // `busDuck` reads the follower at the end of the last quantum.
    let s = duck_status(&mut m);
    assert_eq!(s.len(), 1);
    assert!((s[0].1 - start).abs() < 1e-6 && s[0].1 > held && s[0].1 < 1.0, "busDuck {:?} vs {start}", s);
}

#[test]
fn a_stamp_inside_a_quantum_applies_from_that_quantum_and_status_reads_it() {
    let mut m = scene();
    m.submit(&[duck_rec(&[rule(2, 1, 0.5, 0.0, 0.0)])]);
    // Frame 700 is inside quantum 5 (640..768): the mask is in force for that whole quantum.
    m.submit(&[presence(1 << 2, 0, Some(700))]);
    m.render_n(5);
    assert_eq!(duck_status(&mut m), vec![(1, 1.0)]);
    m.render();
    assert_eq!(duck_status(&mut m), vec![(1, 0.5)], "an attack of 0 lands on amount in the quantum");
    // Through STATUS's wire block too.
    let mut out = vec![0u8; status::BUFFER_BYTES];
    let n = status::take(&mut m.core, &mut out, 0x400);
    let (s, _) = wire::StatusBlock::read(&out[..n], 0).unwrap();
    assert_eq!((s.bus_duck.len(), s.bus_duck[0].slot, s.bus_duck[0].gain), (1, 1, 0.5));
}

#[test]
fn rules_on_one_target_combine_by_min_per_sample() {
    let mut reference = scene();
    let mut m = scene();
    // SFX ducks Music to 0.5 fast; UI to 0.2 slowly: the fast rule leads, then the deep one.
    let (a1, a2) = (0.002, 0.05);
    m.submit(&[duck_rec(&[rule(2, 1, 0.5, a1, 0.1), rule(3, 1, 0.2, a2, 0.1)]), presence((1 << 2) | (1 << 3), 0, None)]);
    let quanta = 60;
    let want_ref = reference.render_n(quanta).0;
    let got = m.render_n(quanta).0;
    let g = ratio(&got, &want_ref, m.latency());
    let (mut s1, mut s2) = (1.0f32, 1.0f32);
    let mut crossed = false;
    for q in 0..quanta {
        let (e1, e2) = (step(s1, 0.5, coef(a1)), step(s2, 0.2, coef(a2)));
        for k in 0..Q {
            let c = q * Q + k;
            let f = (k + 1) as f32 / Q as f32;
            let want = (s1 + (e1 - s1) * f).min(s2 + (e2 - s2) * f);
            if c >= Q && c < g.len() {
                assert!((g[c] - want).abs() < 2e-5, "core frame {c}: {} expected {want}", g[c]);
            }
        }
        crossed |= e2 < e1 && s2 > s1;
        (s1, s2) = (e1, e2);
    }
    assert!(crossed, "the min switches rule");
    let s = duck_status(&mut m);
    assert_eq!(s.len(), 1, "one entry per target");
    assert!((s[0].1 - s1.min(s2)).abs() < 1e-6);
}

#[test]
fn a_bus_no_rule_targets_and_an_untriggered_rule_change_no_sample() {
    let mut reference = scene();
    let mut m = scene();
    // A rule on SFX (no voice there) triggered; a rule on Music whose trigger (UI) has no voice.
    m.submit(&[duck_rec(&[rule(1, 2, 0.1, 0.01, 0.1), rule(3, 1, 0.1, 0.01, 0.1)]), presence(1 << 1, 0, None)]);
    let want = reference.render_n(20);
    let got = m.render_n(20);
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert_eq!((bits(&want.0), bits(&want.1)), (bits(&got.0), bits(&got.1)));
    let s = duck_status(&mut m);
    assert_eq!(s.len(), 2);
    assert!(s.iter().any(|&(slot, g)| slot == 2 && g < 0.2), "SFX is ducked (silently): {s:?}");
    assert!(s.contains(&(1, 1.0)));
}

#[test]
fn a_released_duck_settles_at_exactly_one_and_reset_settles_followers() {
    let mut m = scene();
    m.submit(&[duck_rec(&[rule(2, 1, 0.3, 0.005, 0.01)]), presence(1 << 2, 0, None)]);
    m.render_n(10);
    assert!(duck_status(&mut m)[0].1 < 0.31);
    m.submit(&[presence(0, m.frame, None)]);
    m.render_n(200);
    assert_eq!(duck_status(&mut m), vec![(1, 1.0)], "released to exactly 1");
    let mut curve = [0.0f32; Q];
    let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    assert!(!duck::gain(d, 1, &mut curve), "settled: identity, the lane skipped");
    // Ducked again, then RESET: the mask clears and the follower settles at 1 (the rules stay).
    m.submit(&[presence(1 << 2, m.frame, None)]);
    m.render_n(10);
    m.submit(&[reset(true)]);
    let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    assert_eq!((d.presence, d.rule_count, d.followers[0].gain, d.followers[0].goal), (0, 1, 1.0, 1.0));
    // An edit of the times keeps the follower (B3's key), with new coefficients.
    m.submit(&[duck_rec(&[rule(2, 1, 0.3, 0.5, 1.0)])]);
    let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
    assert_eq!((d.followers[0].attack_coef, d.followers[0].release_coef), (coef(0.5), coef(1.0)));
}

#[test]
fn the_coefficient_is_a_63_percent_time_constant_per_quantum() {
    assert_eq!(duck::coefficient(0.0, RATE), 0.0);
    assert_eq!(duck::coefficient(-1.0, RATE), 0.0);
    assert_eq!(duck::coefficient(f32::NAN, RATE), 0.0);
    // After `t` seconds of quanta, 1/e of the step remains.
    let c = duck::coefficient(0.1, RATE) as f64;
    let quanta = 0.1 * RATE as f64 / Q as f64;
    assert!((c.powf(quanta) - (-1.0f64).exp()).abs() < 1e-6);
}
