//! L-B2a (0171/0172 M5-0, task B2's acceptance): `BUS_SLOT`, tombstones and the late-batch rule
//! as the core applies them (api-and-models §4.2; architecture §3.3, §4.7; rulings R7–R9).
//!
//! Acceptance: a tombstoned bus mixes nothing, keeps its index and holds lanes at 0; a stamped slot
//! record applies at the first quantum holding its frame; a late sequence is shifted whole by whole
//! quanta (`lateCommands` once, `maxLatenessFrames` raised); a re-parent re-runs the bus order;
//! asap configuration unchanged.
//!
//! The queue's own mechanics (batch order, a full queue, a frame jump, RESET) are pinned in
//! `bus_slot_queue.rs`. `BUS_RAMP`'s body is B1a's and B1b's (`lanes::on_ramp`): these tests send
//! the sequence's dip ramps so the sequence is whole, but assert nothing about the lanes they
//! drive; where a lane value matters the test writes it through `lanes::entry` directly.

mod common;

use audio_core::{bus, lanes, scheduler, status};
use audio_wire::generated as wire;
use common::*;

/// A `BUS_SLOT` record, head included; an effect is `(type, p0)` (p1 = 0.7).
fn slot_rec(slot: u16, flags: u16, seq: u16, parent: u16, effects: &[(u32, f32)], frame_offset: u32) -> Rec {
    let r = wire::BusSlot {
        voice_id: 0,
        frame_offset,
        slot,
        flags,
        sequence_id: seq,
        reserved: 0,
        reserved2: 0,
        parent,
        effects: effects.iter().map(|&(t, p0)| wire::BusSlotEffects { type_: t, p: [p0, 0.7, 0.0, 0.0, 0.0, 0.0, 0.0] }).collect(),
    };
    let mut b = vec![0u8; wire::BusSlot::FIXED_END + effects.len() * wire::BusSlotEffects::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// A `BUS_RAMP` on `lane` of `bus` to `gain` over `frames`, tagged with sequence `seq`.
fn ramp_rec(bus: u32, lane: u16, gain: f32, frames: u32, seq: u32, frame_offset: u32) -> Rec {
    let mut b = vec![0u8; wire::BusRamp::FIXED_END];
    wire::BusRamp { voice_id: bus, frame_offset, lane, mask: wire::BUS_RAMP_MASK_GAIN, gain, lp_hz: OFF, frames, shape: wire::pack_ramp_shape(0, seq, 0) }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// One stamped structural sequence (ARCH §3.3): dip-down on `bus` at `f0` over `d`, the slot
/// record at `b`, dip-up at `b` over `d`, all tagged `seq`, offsets from the batch's first frame.
fn sequence(seq: u16, bus: u16, slot: Rec, f0: u32, d: u32, b: u32) -> Vec<Rec> {
    let _ = (seq, bus, slot, f0, d, b);
    todo!("L-B2a")
}

/// The configured buses' parents.
fn parents(m: &Mixer) -> Vec<u16> {
    bus::slots(&m.core)[..bus::count(&m.core)].iter().map(|s| s.parent).collect()
}

/// Submits `recs` as one batch whose first frame is `first_frame` (stamped offsets count from it).
fn submit_at(m: &mut Mixer, first_frame: f64, recs: &[Rec]) {
    assert_eq!(scheduler::submit(&mut m.core, &batch(first_frame, recs)), 0, "the batch was refused");
}

#[test]
#[ignore = "L-B2a"]
fn a_tombstone_is_a_silent_root_that_keeps_its_index() {
    // Tree [ROOT, 0, 1] with a low-pass and a reverb send on bus 1; tombstone bus 1 (structural,
    // parent ROOT, no effects). Bus 1 keeps index 1 and `bus::count` stays 3; it is a root with no
    // effects (`fx.count` 0), `has_reverb` is 0; bus 2 still names parent 1; the order re-ran.
    let _ = (lanes::LANES, status::counters, sequence, parents, submit_at, slot_rec, ramp_rec);
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn a_tombstone_mixes_nothing_and_holds_its_lanes_at_0() {
    // A DC voice on bus 1 is heard; main moves it to bus 0 (`set_bus`) and tombstones bus 1 with its
    // dip lane at 0 (write `lanes::entry(..., 1).lanes[LANE_DIP] = Ramp::at(0.0)` before the record,
    // as the dip-down would leave it). After the record applies: the lane entry is unchanged (the
    // tombstone is not `fresh`), and with the voice gone the output is exactly what bus 0's voice
    // alone gives (bus 1 adds nothing, its effects' tails gone).
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn a_fresh_re_add_starts_zeroed_with_unity_lanes() {
    // After a tombstone (lane held at 0), a `fresh` BUS_SLOT on the same index: every lane of its
    // entry is a settled 1, its effects are the new ones with zeroed state, its parent is set.
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn a_stamped_slot_applies_at_the_first_quantum_holding_its_frame() {
    // Stamp a re-parent at a frame in the middle of a quantum (and one at a quantum's first frame):
    // the tree is unchanged after every earlier quantum and changed after the quantum holding the
    // frame; `scheduler::config_pending_len` goes 1 → 0 there; `lateCommands` stays 0.
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn a_late_sequence_is_shifted_whole_by_whole_quanta() {
    // A sequence whose F0 is before the next quantum's first frame q (first_frame below the rendered
    // frames): its BUS_SLOT applies at B + s, s = ⌈(q − F0) / 128⌉ × 128, not before;
    // `lateCommands` + 1 once (not once per record) and `maxLatenessFrames` = s. Cover q − F0 of 1
    // frame (s = 128) and of exactly 128 (s = 128) and 129 (s = 256).
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn a_re_parent_re_runs_the_bus_order() {
    // Tree [ROOT, 0, 0, 2]: order [3, 1, 2, 0]. BUS_SLOT moves bus 1 under bus 3 (asap and
    // stamped): depths become [0, 3, 1, 2] and `bus::area(..).order` [1, 3, 2, 0], equal to the
    // order a BUS_CONFIG of the same tree gives.
    todo!("L-B2a")
}

#[test]
#[ignore = "L-B2a"]
fn asap_configuration_is_unchanged() {
    // An asap BUS_SLOT applies when it arrives (before any render), BUS_DUCK and LOUD_CONFIG with a
    // stamped `frameOffset` never queue; a BUS_CONFIG of an untombstoned tree gives the same slots,
    // order and `busCount` as before M5.
    todo!("L-B2a")
}
