//! B3 (0171/0172 M5-0): the `BUS_DUCK` rule table as the core stores and checks it, and the
//! re-runs of the bus order (api-and-models §4.2 `BUS_DUCK`, §4.4; architecture §4.6; R5).
//!
//! Acceptance: a `BUS_SLOT` re-parent re-runs the order; `BUS_DUCK` re-runs it with the level
//! edges; at most 32 rules, 8 of them level (the rest dropped and counted); a rule naming a
//! tombstone or an ancestor (or self) trigger is inert; a level cycle drops its closing edge in
//! rule order and marks that rule late; presence rules change no order and no sound.

mod common;

use audio_core::duck::{self, Rule, FLAG_INERT, FLAG_LATE};
use audio_core::{bus, status};
use audio_wire::generated as wire;
use common::*;

const LEVEL: u32 = wire::DUCK_FLAG_LEVEL;
const RMS: u32 = wire::DUCK_FLAG_RMS;

fn rule(trigger: u16, target: u16, flags: u32) -> wire::BusDuckRules {
    wire::BusDuckRules { target, trigger, flags, threshold_db: -30.0, amount: 0.3, attack: 0.05, release: 0.4 }
}

/// A `BUS_DUCK` record of `rules`, head included; past 32 rules the items are appended by hand
/// (the generated writer refuses them; the core keeps 32 and counts the rest).
fn duck_rec(rules: &[wire::BusDuckRules]) -> Rec {
    let first = &rules[..rules.len().min(32)];
    let mut b = vec![0u8; wire::BusDuck::FIXED_END + rules.len() * wire::BusDuckRules::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: first.to_vec() }.write(&mut b, 0).unwrap();
    for (i, r) in rules.iter().enumerate().skip(32) {
        r.write(&mut b, wire::BusDuck::FIXED_END + i * wire::BusDuckRules::FIXED_END).unwrap();
    }
    b[12..16].copy_from_slice(&(rules.len() as u32).to_le_bytes());
    let words = (b.len() / 4) as u16;
    b[2..4].copy_from_slice(&words.to_le_bytes());
    Rec::Raw(b)
}

/// A `BUS_SLOT` (asap, no effects) giving `slot` the parent `parent`.
fn slot_rec(slot: u16, parent: u16) -> Rec {
    let r = wire::BusSlot { voice_id: 0, frame_offset: wire::ASAP, slot, parent, ..Default::default() };
    let mut b = vec![0u8; wire::BusSlot::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn duck_area(m: &mut Mixer) -> duck::DuckArea {
    *duck::area(&mut m.core.regions_mut().duck[..]).unwrap()
}

fn order(m: &Mixer) -> Vec<u8> {
    bus::area(&m.core).order[..bus::count(&m.core)].to_vec()
}

fn mix(m: &mut Mixer) -> audio_core::counters::MixCounters {
    status::counters_mut(&mut m.core).mix
}

fn pos(o: &[u8], b: usize) -> usize {
    o.iter().position(|&x| x as usize == b).unwrap()
}

/// The default tree (Master, Music, SFX, UI, Voice).
fn rig() -> Mixer {
    let mut m = Mixer::new(32);
    m.submit(&[config(&[ROOT, 0, 0, 0, 0])]);
    m
}

#[test]
fn bus_duck_stores_the_rules_in_record_order() {
    let mut m = rig();
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL | RMS | 0xF0), rule(2, 1, 0)])]);
    let d = duck_area(&mut m);
    assert_eq!((d.rule_count, d.level_count), (2, 1));
    assert_eq!(d.rules()[0], Rule { target: 1, trigger: 4, flags: LEVEL | RMS, threshold_db: -30.0, amount: 0.3, attack: 0.05, release: 0.4 }, "unknown wire bits cleared");
    assert!(d.rules()[0].is_level() && d.rules()[0].is_rms() && !d.rules()[1].is_level());
    assert_eq!(d.detectors[0].rule, 0);
    assert_eq!(d.rules_for(1).map(|(i, _)| i).collect::<Vec<_>>(), vec![0, 1]);
    assert!(d.is_target(1) && !d.is_target(4));
    let c = mix(&mut m);
    assert_eq!((c.duck_rules_inert, c.duck_rules_dropped, c.duck_edges_dropped, c.sidechain_late), (0, 0, 0, 0));
    // Replace-all: an empty record clears the table.
    m.submit(&[duck_rec(&[])]);
    let d = duck_area(&mut m);
    assert_eq!((d.rule_count, d.level_count), (0, 0));
    assert_eq!(d.rules[0], Rule::default());
}

#[test]
fn past_32_rules_and_past_8_level_rules_are_dropped_and_counted() {
    let mut m = rig();
    // 10 level rules first (the 9th and 10th dropped), then 30 presence rules (8 past the 32).
    let mut rules: Vec<_> = (0..10).map(|_| rule(4, 1, LEVEL)).collect();
    rules.extend((0..30).map(|i| rule(2 + (i % 3) as u16, 1, 0)));
    m.submit(&[duck_rec(&rules)]);
    let d = duck_area(&mut m);
    assert_eq!((d.rule_count, d.level_count), (32, 8));
    assert!(d.rules()[..8].iter().all(Rule::is_level) && d.rules()[8..].iter().all(|r| !r.is_level()));
    assert_eq!(d.rules()[8].trigger, 2, "the first presence rule follows the eighth level rule");
    assert_eq!(mix(&mut m).duck_rules_dropped, 2 + 6);
    // A record within the limits clears the level.
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL)])]);
    assert_eq!(mix(&mut m).duck_rules_dropped, 0);
}

#[test]
fn self_ancestor_tombstone_and_out_of_range_rules_are_inert() {
    let mut m = Mixer::new(32);
    // 0 Master; 1, 2 under it; 3 under 1; 4 a tombstone (a second root).
    m.submit(&[config(&[ROOT, 0, 0, 1, ROOT])]);
    let rules = [
        rule(2, 2, 0),     // self
        rule(1, 3, LEVEL), // trigger is the target's parent
        rule(0, 3, 0),     // the master is every bus's ancestor
        rule(4, 1, 0),     // trigger a tombstone
        rule(2, 4, LEVEL), // target a tombstone
        rule(9, 1, 0),     // past the configured buses
        rule(3, 2, LEVEL), // live
        rule(3, 1, 0),     // live: the target is the trigger's ancestor, not the reverse
    ];
    m.submit(&[duck_rec(&rules)]);
    let d = duck_area(&mut m);
    let inert: Vec<bool> = d.rules().iter().map(Rule::is_inert).collect();
    assert_eq!(inert, vec![true, true, true, true, true, true, false, false]);
    assert_eq!(d.rules()[1].flags, LEVEL | FLAG_INERT);
    assert_eq!(mix(&mut m).duck_rules_inert, 6);
    assert_eq!(d.rules_for(3).count(), 0, "inert rules duck nothing");
    assert_eq!(d.rules_for(1).map(|(i, _)| i).collect::<Vec<_>>(), vec![7]);
    // The inert level rule 1 -> 3 adds no edge; the live 3 -> 2 does (3 is already first).
    let o = order(&m);
    assert!(pos(&o, 3) < pos(&o, 2));
}

#[test]
fn bus_duck_reruns_the_order_with_level_edges_only() {
    let mut m = rig();
    let today = order(&m);
    assert_eq!(today, vec![1, 2, 3, 4, 0]);
    // Voice (4) ducks Music (1) by presence: no edge.
    m.submit(&[duck_rec(&[rule(4, 1, 0)])]);
    assert_eq!(order(&m), today);
    // By level: Voice before Music.
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL)])]);
    assert_eq!(order(&m), vec![2, 3, 4, 1, 0]);
    // Rules removed: today's order again.
    m.submit(&[duck_rec(&[])]);
    assert_eq!(order(&m), today);
}

#[test]
fn a_level_cycle_drops_its_closing_edge_and_marks_the_rule_late() {
    let mut m = rig();
    m.submit(&[duck_rec(&[rule(1, 2, LEVEL), rule(2, 1, 0), rule(2, 1, LEVEL), rule(3, 1, LEVEL)])]);
    let d = duck_area(&mut m);
    let late: Vec<bool> = d.rules().iter().map(Rule::is_late).collect();
    assert_eq!(late, vec![false, false, true, false]);
    assert_eq!(d.rules()[2].flags, LEVEL | FLAG_LATE);
    assert_eq!(mix(&mut m).duck_edges_dropped, 1);
    let o = order(&m);
    assert!(pos(&o, 3) < pos(&o, 1) && pos(&o, 1) < pos(&o, 2));
    // `sidechainLate` counts quanta a detector reads late (Sc1): one per quantum the late rule's
    // target mixes, held in `late_pending` until a STATUS take adds them to the counter.
    m.render_n(4);
    assert_eq!(mix(&mut m).sidechain_late, 0, "not before a take");
    assert_eq!(duck_area(&mut m).late_pending, 4);
    let mut block = vec![0u8; status::BUFFER_BYTES];
    assert!(status::take(&mut m.core, &mut block, 0x400) > 0);
    assert_eq!(mix(&mut m).sidechain_late, 4);
    // The cycle gone, the mark goes.
    m.submit(&[duck_rec(&[rule(1, 2, LEVEL)])]);
    assert!(!duck_area(&mut m).rules()[0].is_late());
    assert_eq!(mix(&mut m).duck_edges_dropped, 0);
}

#[test]
fn a_bus_slot_reparent_reruns_the_order_and_the_check() {
    let mut m = rig();
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL)])]);
    assert_eq!(order(&m), vec![2, 3, 4, 1, 0]);
    // Move Music (1) under UI (3): ready first are SFX (2) and Voice (4), Music waits for Voice
    // and UI for Music: 2, 4, 1, 3, 0 (today's order would put the deeper Music first).
    m.submit(&[slot_rec(1, 3)]);
    assert_eq!(bus::slots(&m.core)[1].parent, 3);
    assert_eq!(order(&m), vec![2, 4, 1, 3, 0]);
    // Move Music under Voice: the trigger is now the target's ancestor, so the rule is inert and
    // the order is the tree's.
    m.submit(&[slot_rec(1, 4)]);
    assert!(duck_area(&mut m).rules()[0].is_inert());
    assert_eq!(mix(&mut m).duck_rules_inert, 1);
    assert_eq!(order(&m), vec![1, 2, 3, 4, 0]);
    // Tombstone Voice (a silent root): still inert; then back under Master: live again.
    m.submit(&[slot_rec(1, 0), slot_rec(4, ROOT)]);
    assert!(duck_area(&mut m).rules()[0].is_inert());
    m.submit(&[slot_rec(4, 0)]);
    assert!(!duck_area(&mut m).rules()[0].is_inert());
    assert_eq!(order(&m), vec![2, 3, 4, 1, 0]);
}

#[test]
fn bus_config_reruns_the_order_and_the_check() {
    let mut m = rig();
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL)])]);
    m.submit(&[config(&[ROOT, 0, 0, 0, 0, 0])]);
    assert_eq!(order(&m), vec![2, 3, 4, 1, 5, 0]);
    m.submit(&[config(&[ROOT, 4, 0, 0, 0])]);
    assert!(duck_area(&mut m).rules()[0].is_inert());
    assert_eq!(order(&m), vec![1, 2, 3, 4, 0]);
}

#[test]
fn an_edited_rule_keeps_its_follower_and_a_new_rule_starts_at_unity() {
    let mut m = rig();
    m.submit(&[duck_rec(&[rule(4, 1, LEVEL), rule(2, 1, 0)])]);
    {
        let d = duck::area(&mut m.core.regions_mut().duck[..]).unwrap();
        assert_eq!((d.followers[0].gain, d.followers[0].goal), (1.0, 1.0));
        d.followers[0].gain = 0.5;
        d.followers[1].gain = 0.25;
        d.detectors[0].env = 0.125;
    }
    // Same keys in a new order with a new amount, plus a new rule.
    let mut edited = rule(2, 1, 0);
    edited.amount = 0.6;
    m.submit(&[duck_rec(&[edited, rule(3, 1, 0), rule(4, 1, LEVEL)])]);
    let d = duck_area(&mut m);
    assert_eq!(d.rules()[0].amount, 0.6);
    assert_eq!(d.followers[0].gain, 0.25, "2 -> 1 kept its follower");
    assert_eq!(d.followers[1].gain, 1.0, "3 -> 1 is new");
    assert_eq!(d.followers[2].gain, 0.5, "4 -> 1 kept its follower");
    assert_eq!((d.detectors[0].rule, d.detectors[0].env), (2, 0.125), "and its detector");
    // A rule changing mode is a new rule.
    m.submit(&[duck_rec(&[rule(4, 1, 0)])]);
    let d = duck_area(&mut m);
    assert_eq!(d.followers[0].gain, 1.0);
    assert_eq!(d.followers[1], duck::Follower::default());
    assert_eq!(d.detectors[0], duck::Detector::default());
}

#[test]
fn the_rule_table_changes_no_sound() {
    // DC voices on every bus of the default tree, every fader at 0.1 so the sum (0.14) stays under
    // the limiter (no look-ahead, so heard frame = core frame) and a duck would be heard. One mixer
    // has rules whose edges keep today's order and that duck nothing: a presence rule with no
    // presence bit set, two inert rules (master trigger, self), and a level rule whose trigger
    // already mixes first, its threshold +6 dB over the trigger's 0 dB pre-fader level. One has none.
    let run = |rules: Option<Vec<wire::BusDuckRules>>| {
        let mut m = rig();
        m.set_lookahead(0.0);
        let mut recs: Vec<Rec> = (0..5).map(|b| dc(0x0001_0001 * (b as u32 + 1), b, 0.0)).collect();
        recs.push(gains(0, &[0.1; 5]));
        if let Some(r) = rules {
            recs.push(duck_rec(&r));
        }
        m.submit(&recs);
        m.render_n(16)
    };
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    let plain = run(None);
    assert!(plain.0.iter().chain(&plain.1).all(|&x| (x - 0.14).abs() < 1e-6), "every voice heard, under the limiter: {}", plain.0[0]);
    let quiet_level = wire::BusDuckRules { threshold_db: THRESHOLD_OVER, ..rule(1, 2, LEVEL) };
    let ruled = run(Some(vec![rule(4, 1, 0), quiet_level, rule(0, 3, LEVEL), rule(2, 2, 0)]));
    assert_eq!((bits(&plain.0), bits(&plain.1)), (bits(&ruled.0), bits(&ruled.1)), "the rule table changed the sound");
    // The scene hears a duck: the same level rule at its −30 dB threshold ducks SFX's 0.01 to 0.003.
    let ducked = run(Some(vec![rule(1, 2, LEVEL)]));
    let last = ducked.0[16 * 128 - 1];
    assert!(last < 0.14 - 1e-3, "a firing level rule is heard: {last}");
}

/// The level rule's threshold in `the_rule_table_changes_no_sound`: over the trigger's 0 dB.
const THRESHOLD_OVER: f32 = 6.0;
