//! B2 (0171/0172 M5-0): the scheduler's configuration queue and the late-batch rule's mechanics
//! (api-and-models §4.2 `BUS_SLOT`, `BUS_PRESENCE`, the sequence tag; architecture §3.3, §4.7).
//! The row's acceptance cases are L-B2a's (`bus_slot.rs`); these pin the queue itself: (frame,
//! batch order), a full queue, a sequence found late only at its quantum (a frame jump), the
//! serialisation of two sequences, RESET, a slot added at the end or past it, `BUS_CONFIG`
//! unchanged, and the asap records that never queue.

mod common;

use audio_core::{bus, scheduler, status};
use audio_wire::generated as wire;
use common::*;

/// A `BUS_SLOT` record, head included.
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

/// A `BUS_RAMP` on `lane` of `bus` to `gain` over `frames`, tagged with `seq`.
fn ramp_rec(bus: u32, lane: u16, gain: f32, frames: u32, seq: u32, frame_offset: u32) -> Rec {
    let mut b = vec![0u8; wire::BusRamp::FIXED_END];
    wire::BusRamp { voice_id: bus, frame_offset, lane, mask: wire::BUS_RAMP_MASK_GAIN, gain, lp_hz: OFF, frames, shape: wire::pack_ramp_shape(0, seq, 0) }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn presence_rec(mask: u32, frame_offset: u32) -> Rec {
    let mut b = vec![0u8; wire::BusPresence::FIXED_END];
    wire::BusPresence { voice_id: 0, frame_offset, mask }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn parents(m: &Mixer) -> Vec<u16> {
    bus::slots(&m.core)[..bus::count(&m.core)].iter().map(|s| s.parent).collect()
}

fn submit_at(m: &mut Mixer, first_frame: f64, recs: &[Rec]) {
    assert_eq!(scheduler::submit(&mut m.core, &batch(first_frame, recs)), 0, "the batch was refused");
}

/// Three buses, rendered up to frame 512.
fn rig() -> Mixer {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0])]);
    m.render_n(4);
    m
}

#[test]
fn stamped_records_apply_in_frame_then_batch_order() {
    let mut m = rig();
    // Three stamped records, out of frame order; two share the quantum at 640.
    submit_at(&mut m, 512.0, &[slot_rec(2, 1, 0, 1, &[], 200), slot_rec(1, 1, 0, ROOT, &[], 150), slot_rec(2, 1, 0, ROOT, &[], 250)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 3);
    assert_eq!(scheduler::config_area(&m.core).records[0].frame, 662, "sorted by frame");
    m.render(); // 512..640: nothing due
    assert_eq!(parents(&m), vec![ROOT, 0, 0]);
    m.render(); // 640..768: all three, in (frame, batch order)
    assert_eq!(parents(&m), vec![ROOT, ROOT, ROOT], "slot 2 first under 1 (712), then a root (762)");
    assert_eq!(scheduler::config_pending_len(&m.core), 0);
    assert_eq!(status::counters(&m.core).late_commands, 0);
}

#[test]
fn records_of_one_frame_keep_their_batch_order() {
    let mut m = rig();
    submit_at(&mut m, 512.0, &[slot_rec(2, 1, 0, 1, &[], 130), slot_rec(2, 1, 0, ROOT, &[], 130)]);
    m.render_n(2);
    assert_eq!(parents(&m)[2], ROOT, "the later record of the batch wins");
    submit_at(&mut m, 768.0, &[slot_rec(2, 1, 0, ROOT, &[], 10), slot_rec(2, 1, 0, 1, &[], 10)]);
    m.render();
    assert_eq!(parents(&m)[2], 1);
}

#[test]
fn a_full_queue_applies_the_record_at_once() {
    let mut m = rig();
    let recs: Vec<Rec> = (0..scheduler::CONFIG_PENDING).map(|_| presence_rec(1, 10_000)).collect();
    submit_at(&mut m, 512.0, &recs);
    assert_eq!(scheduler::config_pending_len(&m.core), scheduler::CONFIG_PENDING);
    submit_at(&mut m, 512.0, &[slot_rec(1, 1, 0, 2, &[], 10_000)]);
    assert_eq!(parents(&m)[1], 2, "no room: applied when it arrived");
    assert_eq!(scheduler::config_pending_len(&m.core), scheduler::CONFIG_PENDING);
}

#[test]
fn reset_drops_waiting_configuration_and_the_sequence_in_flight() {
    let mut m = rig();
    submit_at(&mut m, 512.0, &[ramp_rec(1, wire::LANE_DIP as u16, 0.0, 128, 5, 0), slot_rec(1, 1, 5, 2, &[], 128), presence_rec(3, 40)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 2);
    assert_eq!(scheduler::config_area(&m.core).inflight_sequence, 5);
    m.submit(&[reset(true)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0);
    assert_eq!(scheduler::config_area(&m.core).inflight_sequence, 0);
    m.render_n(3);
    assert_eq!(parents(&m)[1], 0, "the dropped BUS_SLOT never applied");
}

#[test]
fn a_sequence_late_only_at_its_quantum_is_shifted_whole_then() {
    let mut m = rig();
    // On time when it arrives (q = 512): slot at 640, dip-up at 640.
    submit_at(&mut m, 512.0, &[ramp_rec(1, wire::LANE_DIP as u16, 0.0, 128, 9, 0), slot_rec(1, 1, 9, 2, &[], 128), ramp_rec(1, wire::LANE_DIP as u16, 1.0, 128, 9, 128)]);
    assert_eq!(status::counters(&m.core).late_commands, 0);
    // The shell's clock jumps: the next quantum is 1,280..1,408, and the slot (640) is late there.
    m.frame = 1_280;
    m.render();
    // B1b: the dip-down (F0 = 512) still waits in the pending queue, so the whole sequence moves by
    // ⌈(1,280 − 512) / 128⌉ × 128 = 768: the dip-down to 1,280 (this quantum's start), the slot
    // and the dip-up to 1,408, so the slot still follows a full dip-down.
    assert_eq!(parents(&m)[1], 0, "the slot waits for the next quantum");
    let c = status::counters(&m.core);
    assert_eq!((c.late_commands, c.max_lateness_frames), (1, 768), "counted once, not as a late record too");
    assert_eq!(scheduler::config_area(&m.core).inflight_end, 768 + 768, "the in-flight end moved with it");
    m.render();
    assert_eq!(parents(&m)[1], 2);
    assert_eq!(status::counters(&m.core).late_commands, 1);
}

#[test]
fn a_later_sequence_waits_for_the_shifted_end_of_the_one_in_flight() {
    let mut m = rig();
    // Sequence 1, late by 212 frames: shifted by 256 (slot 512 → 768, end 640 + 128 → 896).
    submit_at(&mut m, 300.0, &[ramp_rec(1, wire::LANE_DIP as u16, 0.0, 100, 1, 0), slot_rec(1, 1, 1, 2, &[], 212), ramp_rec(1, wire::LANE_DIP as u16, 1.0, 100, 1, 212)]);
    // Sequence 2 stamped at the planned end of 1 (612 + 100 = 712 → its own F0 = 712, slot at 896):
    // it would start before 1's shifted end (868), so it moves to start there, by whole quanta.
    submit_at(&mut m, 512.0, &[ramp_rec(2, wire::LANE_DIP as u16, 0.0, 100, 2, 200), slot_rec(2, 1, 2, 1, &[], 384), ramp_rec(2, wire::LANE_DIP as u16, 1.0, 100, 2, 384)]);
    let frames: Vec<u64> = scheduler::config_area(&m.core).records[..2].iter().map(|r| r.frame).collect();
    assert_eq!(frames, vec![768, 896 + 256], "868 − 712 = 156 → 256");
    let c = status::counters(&m.core);
    assert_eq!((c.late_commands, c.max_lateness_frames), (2, 256), "each shifted sequence counts once");
    assert_eq!(scheduler::config_area(&m.core).inflight_sequence, 2);
}

#[test]
fn an_on_time_sequence_is_not_shifted() {
    let mut m = rig();
    submit_at(&mut m, 512.0, &[ramp_rec(1, wire::LANE_DIP as u16, 0.0, 100, 3, 0), slot_rec(1, 1, 3, 2, &[], 128), ramp_rec(1, wire::LANE_DIP as u16, 1.0, 100, 3, 128)]);
    assert_eq!(scheduler::config_area(&m.core).records[0].frame, 640);
    assert_eq!(status::counters(&m.core).late_commands, 0);
    assert_eq!(scheduler::config_area(&m.core).inflight_end, 740);
}

#[test]
fn a_late_record_outside_a_sequence_applies_at_the_quantum_start_and_counts() {
    let mut m = rig();
    submit_at(&mut m, 400.0, &[slot_rec(1, 0, 0, 2, &[], 0)]);
    assert_eq!(parents(&m)[1], 0, "stamped: it waits for the next quantum");
    m.render();
    assert_eq!(parents(&m)[1], 2);
    let c = status::counters(&m.core);
    assert_eq!((c.late_commands, c.max_lateness_frames), (1, 112));
}

#[test]
fn a_slot_at_the_count_is_added_and_one_past_it_dropped() {
    let mut m = rig();
    let dropped = bus::area(&m.core).dropped;
    m.submit(&[slot_rec(3, 2, 0, 1, &[(wire::effect_type::LOWPASS, 1_000.0)], wire::ASAP)]);
    assert_eq!(bus::count(&m.core), 4);
    assert_eq!(parents(&m), vec![ROOT, 0, 0, 1]);
    assert_eq!(bus::slots(&m.core)[3].depth, 2);
    assert_eq!(&bus::area(&m.core).order[..4], &[3, 1, 2, 0], "deepest first, then by index");
    m.submit(&[slot_rec(6, 0, 0, ROOT, &[(wire::effect_type::LOWPASS, 1_000.0)], wire::ASAP)]);
    assert_eq!(bus::count(&m.core), 4);
    assert_eq!(bus::area(&m.core).dropped, dropped + 2, "the record and its effect");
}

#[test]
fn a_bad_parent_is_repaired_like_bus_config() {
    let mut m = rig();
    m.submit(&[config(&[ROOT, 0, 1])]);
    m.submit(&[slot_rec(1, 0, 0, 2, &[], wire::ASAP)]);
    assert_eq!(parents(&m), vec![ROOT, 0, 1], "under its own child: the first root instead");
    m.submit(&[slot_rec(1, 0, 0, 1, &[], wire::ASAP)]);
    assert_eq!(parents(&m)[1], 0, "itself");
    m.submit(&[slot_rec(1, 0, 0, 40, &[], wire::ASAP)]);
    assert_eq!(parents(&m)[1], 0, "out of range");
}

#[test]
fn effects_past_four_are_dropped_from_a_queued_slot() {
    let mut m = rig();
    let dropped = bus::area(&m.core).dropped;
    let fx: Vec<(u32, f32)> = (0..6).map(|_| (wire::effect_type::LOWPASS, 2_000.0)).collect();
    submit_at(&mut m, 512.0, &[slot_rec(1, 1, 0, 0, &fx, 10)]);
    m.render();
    assert_eq!(bus::slots(&m.core)[1].fx.count, 4);
    assert_eq!(bus::area(&m.core).dropped, dropped + 2);
}

#[test]
fn asap_records_never_queue() {
    let mut m = rig();
    let mut duck = vec![0u8; wire::BusDuck::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: 9_000, rules: vec![] }.write(&mut duck, 0).unwrap();
    let mut loud = vec![0u8; wire::LoudConfig::FIXED_END];
    wire::LoudConfig { voice_id: 0, frame_offset: 9_000, tp_gate_dbfs: -7.0, meters: vec![] }.write(&mut loud, 0).unwrap();
    m.submit(&[Rec::Raw(duck), Rec::Raw(loud), presence_rec(1, wire::ASAP), slot_rec(2, 0, 0, 1, &[], wire::ASAP)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0, "BUS_DUCK and LOUD_CONFIG ignore their frame");
    assert_eq!(parents(&m)[2], 1, "an asap BUS_SLOT applies when it arrives");
}

#[test]
fn bus_config_keeps_its_behaviour() {
    // An untombstoned tree through BUS_CONFIG: the same slots, order and counts as before M5.
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 1, 0])]);
    assert_eq!(&bus::area(&m.core).order[..4], &[2, 1, 3, 0]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0);
    assert_eq!(scheduler::config_area(&m.core).inflight_sequence, 0);
}
