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
//! **Who fills what.** K1 (W1): the pre-M5 `bus.rs` `order()`, moved verbatim (still the path
//! when no level edge is live). B3 (W3): Kahn ([`compute_with`], the planned leaf L-B3a, done by
//! the lead) with the level edges of `duck.rs`'s rule table, and [`rerun`],
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
/// Why it equals the pre-M5 order without level edges: the deepest unprocessed bus is always
/// ready (its children are deeper, so already out), so taking the deepest ready bus, then the
/// lowest index, emits every bus by depth descending, ties by index.
pub fn compute_with(slots: &[BusSlot], rules: &[Rule], out: &mut [u8]) -> u32 {
    let n = slots.len().min(out.len()).min(MAX_NODES);
    let parent = |b: usize| match slots[b].parent {
        p if (p as usize) < n && p as usize != b => Some(p as usize),
        _ => None,
    };
    // The kept level edges, in rule order (≤ MAX_LEVEL of them that matter; more are kept too).
    let mut edges = [(0u8, 0u8); duck::MAX_RULES];
    let mut kept = 0usize;
    let mut late = 0u32;
    for (i, r) in rules.iter().enumerate().take(duck::MAX_RULES) {
        let (t, g) = (r.trigger as usize, r.target as usize);
        if !r.is_level() || r.is_inert() || t >= n || g >= n || t == g {
            continue;
        }
        if reaches(g, t, n, &parent, &edges[..kept]) {
            late |= 1 << i;
        } else {
            edges[kept] = (t as u8, g as u8);
            kept += 1;
        }
    }
    let edges = &edges[..kept];
    if edges.is_empty() {
        // No level edge: the pre-M5 sort itself (stable insertion sort by depth, deepest first),
        // which Kahn below equals on every repaired tree; kept so the order without level rules is
        // today's code, bit for bit, whatever the slots hold.
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = i as u8;
        }
        for i in 1..n {
            let mut j = i;
            while j > 0 && slots[out[j - 1] as usize].depth < slots[out[j] as usize].depth {
                out.swap(j - 1, j);
                j -= 1;
            }
        }
        return late;
    }
    let mut indeg = [0u16; MAX_NODES];
    for b in 0..n {
        if let Some(p) = parent(b) {
            indeg[p] += 1;
        }
    }
    for &(_, g) in edges {
        indeg[g as usize] += 1;
    }
    let mut done = [false; MAX_NODES];
    for k in 0..n {
        // The deepest ready bus, then the lowest index. The graph is acyclic (closing edges were
        // dropped, the tree is repaired), so one is always ready; the fallback guards a bad tree.
        let mut pick = None::<usize>;
        for b in 0..n {
            if !done[b] && indeg[b] == 0 && pick.is_none_or(|p| slots[b].depth > slots[p].depth) {
                pick = Some(b);
            }
        }
        let b = match pick.or_else(|| (0..n).find(|&b| !done[b])) {
            Some(b) => b,
            None => break,
        };
        done[b] = true;
        out[k] = b as u8;
        if let Some(p) = parent(b) {
            indeg[p] = indeg[p].saturating_sub(1);
        }
        for &(t, g) in edges {
            if t as usize == b {
                indeg[g as usize] = indeg[g as usize].saturating_sub(1);
            }
        }
    }
    late
}

/// Most buses the order handles (the `u8` order entries; `InitParams::MAX_BUSES`).
const MAX_NODES: usize = 256;

/// `true` when `to` is reachable from `from` over the child → parent edges and `edges` (a
/// depth-first walk on fixed stack arrays).
fn reaches(from: usize, to: usize, n: usize, parent: &impl Fn(usize) -> Option<usize>, edges: &[(u8, u8)]) -> bool {
    let mut seen = [false; MAX_NODES];
    let mut stack = [0u8; MAX_NODES];
    let mut top = 1usize;
    stack[0] = from as u8;
    seen[from] = true;
    while top > 0 {
        top -= 1;
        let b = stack[top] as usize;
        if b == to {
            return true;
        }
        let mut push = |x: usize| {
            if x < n && !seen[x] {
                seen[x] = true;
                stack[top] = x as u8;
                top += 1;
            }
        };
        if let Some(p) = parent(b) {
            push(p);
        }
        for &(t, g) in edges {
            if t as usize == b {
                push(g as usize);
            }
        }
    }
    false
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
