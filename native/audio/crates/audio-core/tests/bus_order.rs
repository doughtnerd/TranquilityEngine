//! L-B3a (0171/0172 M5-0, task B3): the bus order, Kahn over child → parent edges plus one
//! trigger → target edge per level rule, deepest first then lowest index (architecture §4.6 "The
//! order (R5)", api-and-models §4.4).
//!
//! Acceptance: with no level rule the order equals `bus.rs:386-399`'s (depth, deepest first, ties
//! by index); every level rule's trigger comes first (spike S4's 36 of 90 and 438 of 992 pairs);
//! presence rules add no edge; a level cycle is detected (its closing edge in rule order dropped).
//!
//! These are pure tests of `bus_order::compute_with` on hand-built slots; the re-run triggers
//! (`BUS_DUCK`, `BUS_SLOT`, `BUS_CONFIG`) are pinned in `duck_rules.rs`.

use audio_core::bus::{BusSlot, ROOT};
use audio_core::bus_order;
use audio_core::duck::{Rule, FLAG_INERT};
use audio_wire::generated as wire;

/// Slots for the tree `parents` (index = bus, `ROOT` for a root), depths set as the tree repair
/// sets them. The tree must be valid (every walk reaches a root).
fn tree(parents: &[u16]) -> Vec<BusSlot> {
    let mut slots: Vec<BusSlot> = parents
        .iter()
        .map(|&p| {
            // SAFETY: all-zero is a valid BusSlot (`bus.rs`).
            let mut s: BusSlot = unsafe { core::mem::zeroed() };
            s.parent = p;
            s
        })
        .collect();
    for i in 0..slots.len() {
        let (mut b, mut d) = (i, 0u16);
        while slots[b].parent != ROOT {
            b = slots[b].parent as usize;
            d += 1;
        }
        slots[i].depth = d;
    }
    slots
}

/// `bus.rs:386-399`'s order, independently: indices by depth, deepest first, ties by index.
fn today(slots: &[BusSlot]) -> Vec<u8> {
    let mut o: Vec<u8> = (0..slots.len()).map(|i| i as u8).collect();
    o.sort_by(|&a, &b| slots[b as usize].depth.cmp(&slots[a as usize].depth).then(a.cmp(&b)));
    o
}

fn order(slots: &[BusSlot], rules: &[Rule]) -> (Vec<u8>, u32) {
    let mut o = vec![0u8; slots.len()];
    let late = bus_order::compute_with(slots, rules, &mut o);
    (o, late)
}

fn pos(o: &[u8], b: usize) -> usize {
    o.iter().position(|&x| x as usize == b).unwrap()
}

fn level(trigger: u16, target: u16) -> Rule {
    Rule { target, trigger, flags: wire::DUCK_FLAG_LEVEL, amount: 0.5, attack: 0.05, release: 0.4, ..Rule::default() }
}

fn presence(trigger: u16, target: u16) -> Rule {
    Rule { flags: 0, ..level(trigger, target) }
}

fn is_ancestor(slots: &[BusSlot], a: usize, b: usize) -> bool {
    let mut x = slots[b].parent;
    while x != ROOT {
        if x as usize == a {
            return true;
        }
        x = slots[x as usize].parent;
    }
    false
}

/// Every child mixes before its parent.
fn assert_children_first(slots: &[BusSlot], o: &[u8]) {
    for (i, s) in slots.iter().enumerate() {
        if s.parent != ROOT {
            assert!(pos(o, i) < pos(o, s.parent as usize), "bus {i} after its parent in {o:?}");
        }
    }
}

/// `samples/sound-lab/project.json`'s tree (Master and nine children), as spike S4 read it.
const SOUND_LAB: [u16; 10] = [ROOT, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/// `samples/stress/project.json`'s tree (Master, Mix0..3, Bus00..26 under Mix0..3 in turn).
const STRESS: [u16; 32] = [ROOT, 0, 0, 0, 0, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3];

/// A small deterministic generator for random trees (no dependency).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n as u64) as usize
    }
}

/// A random forest of `n` buses: bus `i`'s parent is an earlier bus or (rarely) a root; indices
/// are then shuffled so children may come before parents.
fn random_tree(rng: &mut Lcg, n: usize) -> Vec<u16> {
    let mut p = vec![ROOT; n];
    for i in 1..n {
        p[i] = if rng.next(8) == 0 { ROOT } else { rng.next(i) as u16 };
    }
    let mut perm: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        perm.swap(i, rng.next(i + 1));
    }
    let mut q = vec![ROOT; n];
    for i in 0..n {
        q[perm[i]] = if p[i] == ROOT { ROOT } else { perm[p[i] as usize] as u16 };
    }
    q
}

#[test]
fn with_no_rule_the_order_is_todays() {
    let mut rng = Lcg(0x5eed);
    for n in [1usize, 2, 3, 5, 10, 32, 64, 256] {
        for _ in 0..20 {
            let s = tree(&random_tree(&mut rng, n));
            let (o, late) = order(&s, &[]);
            assert_eq!(o, today(&s), "n = {n}");
            assert_eq!(late, 0);
            let mut t = vec![0u8; n];
            bus_order::compute(&s, &mut t);
            assert_eq!(t, o, "compute is compute_with without rules");
        }
    }
    for p in [&SOUND_LAB[..], &STRESS[..]] {
        let s = tree(p);
        assert_eq!(order(&s, &[]).0, today(&s));
    }
}

#[test]
fn presence_and_inert_rules_add_no_edge() {
    let mut rng = Lcg(7);
    for p in [&SOUND_LAB[..], &STRESS[..]] {
        let s = tree(p);
        let n = s.len() as u16;
        let mut rules = Vec::new();
        for _ in 0..32 {
            rules.push(presence(rng.next(n as usize) as u16, rng.next(n as usize) as u16));
        }
        assert_eq!(order(&s, &rules), (today(&s), 0), "presence rules");
        // Level rules the core's check made inert, and ones naming a bus past the tree or itself.
        let mut inert = level(n - 1, 1);
        inert.flags |= FLAG_INERT;
        let rules = [inert, level(n, 1), level(1, n + 3), level(2, 2)];
        assert_eq!(order(&s, &rules), (today(&s), 0), "inert, out of range and self rules");
    }
}

#[test]
#[ignore = "L-B3a: Kahn with level edges"]
fn a_level_rules_trigger_comes_first() {
    // Default tree: Master, Music, SFX, UI, Voice; Voice ducks Music (settings.ts:14), delayed today.
    let s = tree(&[ROOT, 0, 0, 0, 0]);
    let (o, late) = order(&s, &[level(4, 1)]);
    assert_eq!(late, 0);
    // Ready at first: 2, 3, 4 (Music waits for Voice): lowest index first, then Music, Master last.
    assert_eq!(o, vec![2, 3, 4, 1, 0]);
    // A deeper target: the trigger's whole subtree waits for nothing, the target's ancestors follow.
    let s = tree(&STRESS);
    let (o, _) = order(&s, &[level(1, 6)]); // Mix0 ducks Bus01 (under Mix1)
    assert!(pos(&o, 1) < pos(&o, 6));
    assert_children_first(&s, &o);
}

/// Spike S4: over every ordered (trigger, target) pair of the sample's tree, the pairs today's
/// order computes the trigger after the target (36 of 90 in sound-lab, 438 of 992 in stress), and
/// with that pair as the one level rule Kahn puts the trigger first; ancestor pairs (9 and 58) are
/// the core's inert ones.
fn s4_pairs(parents: &[u16], delayed_want: usize, ancestors_want: usize) {
    let s = tree(parents);
    let t = today(&s);
    let (mut total, mut delayed, mut ancestors) = (0, 0, 0);
    for trig in 0..s.len() {
        for targ in 0..s.len() {
            if trig == targ {
                continue;
            }
            total += 1;
            if is_ancestor(&s, trig, targ) {
                ancestors += 1;
                continue;
            }
            if pos(&t, trig) > pos(&t, targ) {
                delayed += 1;
            }
            let (o, late) = order(&s, &[level(trig as u16, targ as u16)]);
            assert_eq!(late, 0, "{trig} -> {targ}");
            assert!(pos(&o, trig) < pos(&o, targ), "{trig} -> {targ}: {o:?}");
            assert_children_first(&s, &o);
        }
    }
    assert_eq!((total, delayed, ancestors), (s.len() * (s.len() - 1), delayed_want, ancestors_want));
}

#[test]
#[ignore = "L-B3a: Kahn with level edges"]
fn spike_s4_sound_lab_36_of_90_pairs() {
    s4_pairs(&SOUND_LAB, 36, 9);
}

#[test]
#[ignore = "L-B3a: Kahn with level edges"]
fn spike_s4_stress_438_of_992_pairs() {
    s4_pairs(&STRESS, 438, 58);
}

#[test]
#[ignore = "L-B3a: Kahn with level edges"]
fn eight_level_rules_all_come_first() {
    let s = tree(&STRESS);
    // Eight non-ancestor rules forming a chain and a fan, all acyclic.
    let rules = [level(31, 5), level(5, 2), level(2, 3), level(3, 4), level(30, 1), level(29, 1), level(28, 6), level(27, 7)];
    let (o, late) = order(&s, &rules);
    assert_eq!(late, 0);
    for r in &rules {
        assert!(pos(&o, r.trigger as usize) < pos(&o, r.target as usize), "{r:?} in {o:?}");
    }
    assert_children_first(&s, &o);
}

#[test]
#[ignore = "L-B3a: Kahn with level edges"]
fn a_level_cycle_drops_its_closing_edge_in_rule_order() {
    // Siblings 1 and 2: 1 ducks 2, 2 ducks 1: rule 1 closes the cycle and is dropped.
    let s = tree(&[ROOT, 0, 0, 0]);
    let rules = [level(1, 2), level(2, 1)];
    let (o, late) = order(&s, &rules);
    assert_eq!(late, 0b10);
    assert!(pos(&o, 1) < pos(&o, 2));
    assert_children_first(&s, &o);
    // Reversed rule order: the other edge goes.
    let (o, late) = order(&s, &[level(2, 1), level(1, 2)]);
    assert_eq!(late, 0b10);
    assert!(pos(&o, 2) < pos(&o, 1));
    // A cycle through the tree: 2 ducks 5 (2 before 5), 5 → 1 (its parent), 1 ducks 2 (1 before
    // 2): the second rule closes it.
    let s = tree(&[ROOT, 0, 0, 0, 0, 1]);
    let (o, late) = order(&s, &[level(2, 5), level(1, 2)]);
    assert_eq!(late, 0b10);
    assert!(pos(&o, 2) < pos(&o, 5));
    assert_children_first(&s, &o);
    // A presence rule between them closes nothing; an unrelated level rule after the cycle stays.
    let s = tree(&[ROOT, 0, 0, 0]);
    let (o, late) = order(&s, &[level(1, 2), presence(2, 1), level(2, 1), level(3, 1)]);
    assert_eq!(late, 0b100);
    assert!(pos(&o, 3) < pos(&o, 1) && pos(&o, 1) < pos(&o, 2));
}
