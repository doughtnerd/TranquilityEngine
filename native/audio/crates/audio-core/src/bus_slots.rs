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
//! [`on_slot`] a stub. B2 (W2): [`on_slot`] applies one slot (kept state per index, `fresh` with
//! unity lanes, an added slot at the end, the tombstone, the tree repair and the order re-run);
//! the timing (a stamped record's quantum, the sequence shift) is the scheduler's configuration
//! queue (`scheduler.rs`, `apply_due_config`, `sequence_shifts`, `shift_sequence`).
//!
//! Runs in `onmessage`, never inside `process`; nothing allocates.

use audio_wire::generated as wire;

use crate::bus::{self, BusSlot};
use crate::core::Core;
use crate::params::InitParams;
use crate::status;
use crate::wire_read::{u16_at, u32_at};

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
/// `effectCount` effects of 32 B (pass 1 of `scheduler::submit`: a malformed record refuses the
/// batch; past 4 effects the rest are dropped at apply, not refused).
pub fn slot_is_well_formed(msg: &[u8], off: usize, len: usize) -> bool {
    if len < wire::BusSlot::FIXED_END || off + len > msg.len() {
        return false;
    }
    let n = crate::wire_read::u16_at(msg, off + 26) as usize;
    n.checked_mul(wire::BusSlotEffects::FIXED_END).is_some_and(|bytes| wire::BusSlot::FIXED_END + bytes <= len)
}

/// `BUS_SLOT` (0x1C, API §4.2): applies one slot's configuration **now**. The scheduler calls it
/// at submit for an asap record (`at` = `None`) and, for a stamped one, at the start of the first
/// quantum holding its frame (`at` = `Some(frame)`, already shifted with its sequence; the
/// scheduler's configuration queue and the late-batch rule live in `scheduler.rs`).
/// - **The slot:** `slot` < the configured count is reconfigured in place; `slot` = the count adds
///   one slot at the end (a new bus at the next index, always fresh); a slot past that, or past
///   `max_buses`, is dropped and counted with its effects in `BusArea::dropped`.
/// - **Kept state per index (R9):** without `fresh`, the slot keeps its gain, low-pass, meter,
///   lanes and the state of effect kinds that stay in their place (`FxChain::configure`).
///   With `fresh` (a re-add after recycling) the slot starts zeroed (`bus::fresh`) with **unity
///   lanes**.
/// - **Tombstone (R9):** a silent root (`parent` = `BUS_ROOT`, no effects) needs nothing more: its
///   effects and their tails go, and its lanes are kept, so the `dip` lane main brought to 0 stays
///   there (main holds it until the slot is recycled; no wire sentinel).
/// - **The tree:** a parent out of range, the slot itself or one of its descendants (a cycle) is
///   replaced by the first root, as BUS_CONFIG repairs a tree; depths are recomputed, the bus order
///   re-runs (`bus_order::compute`, as for BUS_CONFIG and BUS_DUCK) and the reverb flag is
///   recomputed over every configured slot.
///
/// Past `BUS_SLOT_MAX_EFFECTS` (4) effects the rest are dropped and counted. Nothing allocates.
pub fn on_slot(core: &mut Core, msg: &[u8], off: usize, _at: Option<u64>) {
    let sample_rate = core.params().sample_rate;
    let max_buses = core.params().max_buses as usize;
    let slot = u16_at(msg, off + 12) as usize;
    let flags = u16_at(msg, off + 14);
    let parent = u16_at(msg, off + 24);
    let n = u16_at(msg, off + 26) as usize;
    let kept = n.min(wire::BUS_SLOT_MAX_EFFECTS as usize);
    let v = bus::view(core.regions_mut());
    let max = max_buses.min(v.slots.len()).min(InitParams::MAX_BUSES as usize);
    let count = (v.area.count as usize).min(max);
    if slot >= max || slot > count {
        v.area.dropped = v.area.dropped.wrapping_add(1 + n as u32);
        return;
    }
    let added = slot == count;
    let fresh = added || flags & wire::BUS_SLOT_FLAGS_FRESH != 0;
    let effects = (0..kept).map(|e| {
        let at = off + wire::BusSlot::FIXED_END + e * wire::BusSlotEffects::FIXED_END;
        let mut p = [0.0f32; 7];
        for (k, v) in p.iter_mut().enumerate() {
            *v = f32::from_bits(u32_at(msg, at + 4 + 4 * k));
        }
        (u32_at(msg, at), p)
    });
    let (dropped, _) = apply(&mut v.slots[slot], fresh, parent, effects, sample_rate);
    let count = if added { count + 1 } else { count };
    attach(&mut v.slots[..count], slot);
    crate::bus_order::compute(&v.slots[..count], &mut v.area.order[..count]);
    v.area.count = count as u32;
    v.area.has_reverb = v.slots[..count].iter().any(|s| s.fx.has_reverb_send()) as u32;
    v.area.dropped = v.area.dropped.wrapping_add(dropped + (n - kept) as u32);
    if fresh {
        if let Some(e) = crate::lanes::entry(&mut core.regions_mut().lanes[..], slot) {
            // Unity lanes, as `lanes::init` sets them.
            crate::lanes::reset_unity(e);
        }
    }
    if added {
        let c = status::counters_mut(core);
        c.set_bus_count(count);
        c.set_peak(slot, 0.0, 0.0);
    }
}

/// Checks slot `slot`'s new parent in the forest `slots` (every other slot already valid): a
/// parent out of range, `slot` itself, or one of `slot`'s descendants (the walk up from the parent
/// meets `slot`) is replaced by the first other root, or `BUS_ROOT` when there is none
/// (BUS_CONFIG's repair rule, `bus.rs`). Then every slot's `depth` is recomputed.
fn attach(slots: &mut [BusSlot], slot: usize) {
    let n = slots.len();
    let p = slots[slot].parent;
    if p != bus::ROOT {
        let mut bad = p as usize >= n;
        let mut b = p as usize;
        let mut steps = 0usize;
        while !bad {
            if b == slot || steps > n {
                bad = true;
                break;
            }
            let up = slots[b].parent;
            if up == bus::ROOT || up as usize >= n {
                break;
            }
            b = up as usize;
            steps += 1;
        }
        if bad {
            slots[slot].parent = slots.iter().enumerate().position(|(i, s)| i != slot && s.parent == bus::ROOT).map_or(bus::ROOT, |r| r as u16);
        }
    }
    for i in 0..n {
        let (mut b, mut depth) = (i, 0u16);
        while slots[b].parent != bus::ROOT && (slots[b].parent as usize) < n && (depth as usize) <= n {
            b = slots[b].parent as usize;
            depth += 1;
        }
        slots[i].depth = depth;
    }
}
