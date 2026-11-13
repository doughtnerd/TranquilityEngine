//! Index-stable bus configuration, one slot at a time (ADR 0171 amended by 0172 §1.5, §1.6;
//! architecture §4.7, R7, R8, R9, R10; api-and-models §4.2 `BUS_SLOT`, tombstones, C27).
//!
//! **Design.**
//! - **`BUS_SLOT`** (0x1C): one slot's configuration (parent, up to 4 effects in BUS_CONFIG's item
//!   layout), so a parameter edit no longer resends the tree. `flags` bit 0 `structural` (quantum
//!   granularity, the late-batch rule), bit 1 `fresh` (the slot starts zeroed with unity lanes).
//!   Direct edits are asap; only a compressor's parameters are smoothed (B4).
//! - **The sequence tag** (C27): a dip-down `BUS_RAMP`, the `BUS_SLOT` and the dip-up share a
//!   `sequenceId`; a late sequence is shifted whole by whole quanta (`lateCommands` once,
//!   `maxLatenessFrames` raised once).
//! - **Tombstone** (R9): a removed bus is a silent root (no effects, `dip` lane held at 0 by main)
//!   until main recycles the slot.
//! - A `BUS_SLOT` re-parent re-runs the bus order (`bus_order::compute`).
//! - `BUS_CONFIG` stays the full-tree record for init and replay; its per-slot apply is
//!   [`apply`], shared with `BUS_SLOT`.
//!
//! **Who fills what.** K1 (W1): [`apply`] is `bus::configure`'s per-slot body, moved verbatim;
//! [`on_slot`] a stub. B2 (W2): `BUS_SLOT` with its frame and sequence tag (the scheduler's pending
//! queue for stamped configuration), the tombstone, kept state per index.
//!
//! Runs in `onmessage`, never inside `process`; nothing allocates.

use crate::bus::{self, BusSlot};
use crate::core::Core;

/// One slot's configuration (BUS_CONFIG's per-bus entry, and B2's `BUS_SLOT`): when `fresh`, the
/// slot starts as a new unity bus (`bus::fresh`: gain 1, low-pass off, zeroed DSP state); then its
/// parent is set and its effects `(type, p)` configured (`FxChain::configure`: kept kinds keep
/// their state). Returns `(dropped, has_reverb)`: the effects dropped (past the limits, a second
/// compressor, unknown types) and whether a slot in use is a reverb send. The tree is repaired and
/// ordered by the caller. K1: `bus::configure`'s loop body, verbatim. B2: also the tombstone and
/// `fresh` of `BUS_SLOT` (unity lanes through `lanes.rs`).
pub fn apply<I: IntoIterator<Item = (u32, [f32; 7])>>(slot: &mut BusSlot, fresh: bool, parent: u16, effects: I, sample_rate: f32) -> (u32, bool) {
    if fresh {
        *slot = bus::fresh(parent);
    }
    slot.parent = parent;
    let dropped = slot.fx.configure(effects, sample_rate);
    (dropped, slot.fx.has_reverb_send())
}

/// `true` when a `BUS_SLOT` record (0x1C, API §4.2) at `msg[off..off + len]` holds its
/// `effectCount` effects of 32 B. K1: `true` (the scheduler checks the fixed length); B2 fills it.
pub fn slot_is_well_formed(_msg: &[u8], _off: usize, _len: usize) -> bool {
    true
}

/// `BUS_SLOT` (0x1C, API §4.2): one slot's configuration at `at` (`None` asap; `Some(frame)`
/// stamped at quantum granularity). K1: a stub that ignores the record and counts nothing. B2
/// fills it (apply through [`apply`], tombstones, the sequence tag, the order re-run).
pub fn on_slot(_core: &mut Core, _msg: &[u8], _off: usize, _at: Option<u64>) {}
