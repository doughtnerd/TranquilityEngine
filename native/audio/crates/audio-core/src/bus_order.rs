//! The order buses are mixed in (ADR 0171 amended by 0172 §1.1, §1.7; architecture §4.6 "The
//! order", R5; api-and-models §4.4).
//!
//! **Design.** At `BUS_CONFIG`, `BUS_SLOT` and `BUS_DUCK`, the core runs Kahn's algorithm over
//! child → parent edges plus one trigger → target edge per **level** rule, choosing deepest first,
//! then the lowest index. With no level rules this is exactly the pre-M5 order (by depth, deepest
//! first, ties by index), so unstamped goldens stay identical. Presence rules add no edge (their
//! input is a flag, not a buffer). A level cycle that reaches the core drops its last edge in rule
//! order: the level edges are added one at a time in rule order and an edge whose addition would
//! close a cycle is dropped; that rule reads the previous quantum (`duck::FLAG_LATE`, and
//! `sidechainLate` counts the quanta its detector reads late, Sc1).
//!
//! **Who fills what.** K1 (W1): the pre-M5 `bus.rs` `order()`, moved verbatim. B3 (W3): Kahn
//! ([`compute_with`], leaf L-B3a) with the level edges of `duck.rs`'s rule table, and [`rerun`],
//! the re-run that validates the rules against the tree, orders and marks the late rules, called
//! from `BUS_DUCK` (`duck::on_rules`), `BUS_SLOT` (`bus_slots::on_slot`) and `BUS_CONFIG`
//! (`bus::configure`, the coordinator's line: it still calls the tree-only [`compute`]).
//!
//! Runs in `onmessage`, never inside `process`; nothing allocates (at most 256 buses, 8 level
//! edges: fixed arrays on the stack).

use crate::bus::{self, BusSlot};
use crate::core::Core;
use crate::duck::{self, Rule};

/// Writes the tree-only mix order into `out` (`out.len()` = the configured buses =
/// `slots.len()`): [`compute_with`] with no rule, which is the pre-M5 order (bus indices by depth,
/// deepest first, ties by index). Each slot's `depth` must be set (the tree repair).
pub fn compute(slots: &[BusSlot], out: &mut [u8]) {
    compute_with(slots, &[], out);
}

/// Writes the mix order into `out` (`out.len()` = `slots.len()` ≤ 256) by Kahn's algorithm over
/// the tree's child → parent edges (a parent that is `ROOT` or out of range adds none) and one
/// trigger → target edge for each rule of `rules` that is a level rule (`Rule::is_level`), not
/// inert (`Rule::is_inert`) and names two distinct buses below `slots.len()`. Among the ready
/// buses it takes the deepest (`BusSlot::depth`), then the lowest index; with no such edge this is
/// exactly the pre-M5 order. Level edges are added in rule order, and an edge whose addition would
/// close a cycle (its target already reaches its trigger) is dropped. Returns the dropped rules as
/// a mask (bit `i` = `rules[i]`; `rules.len()` ≤ 32). Nothing allocates.
///
/// L-B3a fills this body; until then it is the pre-M5 order and drops nothing.
pub fn compute_with(slots: &[BusSlot], rules: &[Rule], out: &mut [u8]) -> u32 {
    let _ = rules;
    for (i, o) in out.iter_mut().enumerate() {
        *o = i as u8;
    }
    for i in 1..out.len() {
        let mut j = i;
        while j > 0 && slots[out[j - 1] as usize].depth < slots[out[j] as usize].depth {
            out.swap(j - 1, j);
            j -= 1;
        }
    }
    0
}

/// Re-runs the order for the configured tree and the stored rule table (`BUS_DUCK`, a `BUS_SLOT`,
/// `BUS_CONFIG`): validates each rule against the tree (`duck::validate`: inert rules), computes
/// the order with the level edges ([`compute_with`]) into `BusArea::order`, sets each rule's
/// `duck::FLAG_LATE` from the dropped mask, and sets the levels `duckRulesInert` and
/// `duckEdgesDropped`. The slots' depths must be current. Nothing allocates.
pub fn rerun(core: &mut Core) {
    let regions = core.regions_mut();
    // The duck region is borrowed apart from the bus view (distinct regions); it is put back below.
    let duck_bytes = core::mem::take(&mut regions.duck);
    let (inert, dropped) = {
        let v = bus::view(regions);
        let count = (v.area.count as usize).clamp(1, v.slots.len()).min(v.area.order.len());
        match duck::area(&mut *duck_bytes) {
            Some(d) => {
                let n = (d.rule_count as usize).min(duck::MAX_RULES);
                let rules = &mut d.rules[..n];
                let inert = duck::validate(rules, &v.slots[..count]);
                let late = compute_with(&v.slots[..count], rules, &mut v.area.order[..count]);
                for (i, r) in rules.iter_mut().enumerate() {
                    r.set_late(late & (1 << i) != 0);
                }
                (inert, late.count_ones())
            }
            None => {
                compute(&v.slots[..count], &mut v.area.order[..count]);
                (0, 0)
            }
        }
    };
    let regions = core.regions_mut();
    regions.duck = duck_bytes;
    let mix = &mut crate::status::counters_mut(core).mix;
    mix.duck_rules_inert = inert as u16;
    mix.duck_edges_dropped = dropped as u16;
}
