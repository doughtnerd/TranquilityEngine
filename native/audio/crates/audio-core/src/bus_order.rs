//! The order buses are mixed in (ADR 0171 amended by 0172 §1.1, §1.7; architecture §4.6 "The
//! order", R5; api-and-models §4.4).
//!
//! **Design.** At `BUS_CONFIG`, `BUS_SLOT` and `BUS_DUCK`, the core runs Kahn's algorithm over
//! child → parent edges plus one trigger → target edge per **level** rule, choosing deepest first,
//! then the lowest index. With no level rules this is exactly the pre-M5 order (by depth, deepest
//! first, ties by index), so unstamped goldens stay identical. Presence rules add no edge (their
//! input is a flag, not a buffer). A level cycle that reaches the core drops its last edge in rule
//! order (that rule reads the previous quantum; `sidechainLate`, set by `duck.rs`).
//!
//! **Who fills what.** K1 (W1): [`compute`] is the pre-M5 `bus.rs` `order()`, moved verbatim.
//! B3 (W3): Kahn with the level edges from `duck.rs`'s rule table, called again from `BUS_DUCK`
//! and (B2) `BUS_SLOT` re-parents.
//!
//! Runs in `onmessage`, never inside `process`; nothing allocates (at most 256 buses).

use crate::bus::BusSlot;

/// Writes the mix order into `out` (`out.len()` = the configured buses = `slots.len()`): bus
/// indices by depth, deepest first, ties by index (stable insertion sort). Each slot's `depth` is
/// set (`bus.rs`'s tree repair). K1: the pre-M5 order, verbatim. B3: Kahn's algorithm over the
/// tree's child → parent edges and the level rules' trigger → target edges (a new parameter for
/// the rule table), equal to this order when there is no level rule.
pub fn compute(slots: &[BusSlot], out: &mut [u8]) {
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
}
