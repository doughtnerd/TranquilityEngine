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
    let Rec::Raw(mut bytes) = slot else { panic!("the slot is a BUS_SLOT record") };
    let (mut s, _) = wire::BusSlot::read(&bytes, 0).unwrap();
    s.frame_offset = b;
    s.write(&mut bytes, 0).unwrap();
    vec![
        ramp_rec(bus as u32, wire::LANE_DIP as u16, 0.0, d, seq as u32, f0),
        Rec::Raw(bytes),
        ramp_rec(bus as u32, wire::LANE_DIP as u16, 1.0, d, seq as u32, b),
    ]
}

/// The configured buses' parents.
fn parents(m: &Mixer) -> Vec<u16> {
    bus::slots(&m.core)[..bus::count(&m.core)].iter().map(|s| s.parent).collect()
}

/// Submits `recs` as one batch whose first frame is `first_frame` (stamped offsets count from it).
fn submit_at(m: &mut Mixer, first_frame: f64, recs: &[Rec]) {
    assert_eq!(scheduler::submit(&mut m.core, &batch(first_frame, recs)), 0, "the batch was refused");
}

/// Three buses (`[ROOT, 0, 0]`), rendered up to frame 512.
fn rig() -> Mixer {
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0])]);
    m.render_n(4);
    m
}

#[test]
fn a_tombstone_is_a_silent_root_that_keeps_its_index() {
    // Tree [ROOT, 0, 1] with a low-pass and a reverb send on bus 1; tombstone bus 1 (parent ROOT,
    // no effects). Bus 1 keeps index 1 and `bus::count` stays 3; it is a root with no effects
    // (`fx.count` 0), `has_reverb` is 0; bus 2 still names parent 1; the order re-ran.
    let mut m = Mixer::new(8);
    m.submit(&[config_fx(&[(ROOT, vec![]), (0, vec![(wire::effect_type::LOWPASS, 1_000.0, 0.7), (wire::effect_type::REVERB_SEND, 0.5, 0.0)]), (1, vec![])])]);
    assert_eq!(bus::count(&m.core), 3);
    assert_eq!(bus::slots(&m.core)[1].fx.count, 2);
    assert_eq!(bus::area(&m.core).has_reverb, 1);
    assert_eq!(&bus::area(&m.core).order[..3], &[2, 1, 0], "deepest first before the tombstone");

    m.submit(&[slot_rec(1, 0, 0, ROOT, &[], wire::ASAP)]);
    assert_eq!(bus::count(&m.core), 3, "the index is kept");
    assert_eq!(parents(&m), vec![ROOT, ROOT, 1], "bus 1 is a root, bus 2 still names it");
    assert_eq!(bus::slots(&m.core)[1].depth, 0);
    assert_eq!(bus::slots(&m.core)[1].fx.count, 0, "no effects");
    assert_eq!(bus::area(&m.core).has_reverb, 0, "no reverb send left in use");
    assert_eq!(&bus::area(&m.core).order[..3], &[2, 0, 1], "re-ordered: bus 2 (depth 1), then the roots by index");
    m.render_n(2);
    assert_eq!(status::counters(&m.core).late_commands, 0);
}

#[test]
fn a_tombstone_mixes_nothing_and_holds_its_lanes_at_0() {
    // A DC voice on bus 1 is heard; main moves it to bus 0 (`set_bus`) and tombstones bus 1 with its
    // dip lane at 0 (write `lanes::entry(..., 1).lanes[LANE_DIP] = Ramp::at(0.0)` before the record,
    // as the dip-down would leave it). After the record applies: the lane entry is unchanged (the
    // tombstone is not `fresh`), and with the voice gone the output is exactly what bus 0's voice
    // alone gives (bus 1 adds nothing, its effects' tails gone).
    // Both mixers have the same tree, with a low-pass on bus 1; the voice runs at gain 0.5, so the
    // limiter never engages and its output is the input delayed by the latency.
    const V: u32 = 0x0001_0001; // a voice id: generation 1, slot 1
    let tree = || config_fx(&[(ROOT, vec![]), (0, vec![(wire::effect_type::LOWPASS, 800.0, 0.7)]), (0, vec![])]);
    let half = |voice: u32, bus: u16| {
        let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
        p.gain = 0.5;
        Rec::Play(p)
    };
    // Reference: the voice on bus 0 all along, eight quanta.
    let mut a = Mixer::new(8);
    a.submit(&[tree()]);
    a.submit(&[half(V, 0)]);
    let (ref_out, _) = a.render_n(8);

    // The voice on bus 1, then (at frame 256) moved to bus 0 and bus 1 tombstoned.
    let mut b = Mixer::new(8);
    b.submit(&[tree()]);
    b.submit(&[half(V, 1)]);
    let (pre, _) = b.render_n(2);
    let lat = b.latency();
    assert!(pre[lat + 100] > 0.3, "before the move the voice is heard through bus 1");
    lanes::entry(&mut b.core.regions_mut().lanes[..], 1).unwrap().lanes[wire::LANE_DIP as usize] = audio_dsp::ramp::Ramp::at(0.0);
    b.submit(&[set_bus(V, 0), slot_rec(1, 0, 0, ROOT, &[], wire::ASAP)]);
    let (post, _) = b.render_n(6);
    let got: Vec<f32> = pre.into_iter().chain(post).collect();

    // After the move (core frame 256 is heard at 256 + latency): the same as the reference.
    assert!(ref_out[600] > 0.1, "the reference voice is heard");
    for h in 256 + lat..1024 {
        assert!((got[h] - ref_out[h]).abs() <= 1e-6, "heard frame {h} is {}, the voice on bus 0 alone gives {}", got[h], ref_out[h]);
    }
    let e = lanes::entry(&mut b.core.regions_mut().lanes[..], 1).unwrap();
    assert_eq!(e.lanes[wire::LANE_DIP as usize].value, 0.0, "the tombstone is not fresh: its dip lane stays at 0");
    assert_eq!(bus::slots(&b.core)[1].fx.count, 0);
}

#[test]
fn a_fresh_re_add_starts_zeroed_with_unity_lanes() {
    // After a tombstone (lane held at 0), a `fresh` BUS_SLOT on the same index: every lane of its
    // entry is a settled 1, its effects are the new ones with zeroed state, its parent is set.
    let mut m = Mixer::new(8);
    m.submit(&[config_fx(&[(ROOT, vec![]), (0, vec![(wire::effect_type::LOWPASS, 1_000.0, 0.7)]), (1, vec![])])]);
    m.render_n(2);
    // Main holds the tombstoned bus's lanes at 0, as it does while the bus is a tombstone.
    let e = lanes::entry(&mut m.core.regions_mut().lanes[..], 1).unwrap();
    for lane in e.lanes.iter_mut() {
        *lane = audio_dsp::ramp::Ramp::at(0.0);
    }
    m.submit(&[slot_rec(1, 0, 0, ROOT, &[], wire::ASAP)]);
    let e = lanes::entry(&mut m.core.regions_mut().lanes[..], 1).unwrap();
    assert!(e.lanes.iter().all(|r| r.value == 0.0), "the tombstone keeps its lanes at 0");

    // The re-add: fresh, parent 0, one new effect.
    m.submit(&[slot_rec(1, wire::BUS_SLOT_FLAGS_FRESH, 0, 0, &[(wire::effect_type::LOWPASS, 2_000.0)], wire::ASAP)]);
    assert_eq!(parents(&m)[1], 0);
    assert_eq!(bus::count(&m.core), 3, "a re-add isn't a new index");
    let slot = &bus::slots(&m.core)[1];
    assert_eq!(slot.fx.count, 1, "the new effect");
    assert_eq!((slot.gain.value, slot.gain.target), (1.0, 1.0), "the bus's gain starts at unity");
    let e = lanes::entry(&mut m.core.regions_mut().lanes[..], 1).unwrap();
    assert!(e.lanes.iter().all(|r| r.value == 1.0 && r.is_settled()), "every lane is a settled 1");
    assert_eq!(e.moving, 0, "no lane is moving");
}

#[test]
fn a_stamped_slot_applies_at_the_first_quantum_holding_its_frame() {
    // Stamp a re-parent at a frame in the middle of a quantum (and one at a quantum's first frame):
    // the tree is unchanged after every earlier quantum and changed after the quantum holding the
    // frame; `scheduler::config_pending_len` goes 1 → 0 there; `lateCommands` stays 0.
    let mut m = rig(); // rendered to 512
    // Mid-quantum: frame 712, in the quantum 640..768.
    submit_at(&mut m, 512.0, &[slot_rec(2, 1, 0, 1, &[], 200)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 1);
    m.render(); // 512..640
    assert_eq!(parents(&m), vec![ROOT, 0, 0], "not before its frame");
    assert_eq!(scheduler::config_pending_len(&m.core), 1);
    m.render(); // 640..768: applies
    assert_eq!(parents(&m), vec![ROOT, 0, 1]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0);

    // At a quantum's first frame: frame 768 (q = 768, so not late).
    submit_at(&mut m, 768.0, &[slot_rec(2, 1, 0, ROOT, &[], 0)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 1);
    assert_eq!(parents(&m), vec![ROOT, 0, 1], "not applied on arrival: it waits for its quantum");
    m.render(); // 768..896: applies at its start
    assert_eq!(parents(&m), vec![ROOT, 0, ROOT]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0);
    assert_eq!(status::counters(&m.core).late_commands, 0);
}

#[test]
fn a_late_sequence_is_shifted_whole_by_whole_quanta() {
    // A sequence whose F0 is before the next quantum's first frame q (first_frame below the rendered
    // frames): its BUS_SLOT applies at B + s, s = ⌈(q − F0) / 128⌉ × 128, not before;
    // `lateCommands` + 1 once (not once per record) and `maxLatenessFrames` = s. Cover q − F0 of 1
    // frame (s = 128) and of exactly 128 (s = 128) and 129 (s = 256).
    for (late, s) in [(1u32, 128u64), (128, 128), (129, 256)] {
        let mut m = rig(); // rendered to 512, so q = 512
        // The dip-down starts at F0 = 512 − late, the slot and dip-up at B = 640 (unshifted).
        let seq = sequence(9, 1, slot_rec(1, 1, 9, 2, &[], 0), 0, 100, 128 + late);
        submit_at(&mut m, (512 - late) as f64, &seq);
        let applied_at = 640 + s;
        let c = status::counters(&m.core);
        assert_eq!((c.late_commands, c.max_lateness_frames), (1, s as u32), "late by {late}: counted once for the sequence");
        assert_eq!(scheduler::config_area(&m.core).records[0].frame, applied_at, "the slot moved with its sequence");
        assert_eq!(scheduler::config_pending_len(&m.core), 1);

        // Rendering the quanta up to the one holding `applied_at`: the re-parent lands there, not before.
        while m.frame <= applied_at {
            m.render();
            let applied = parents(&m)[1] == 2;
            assert_eq!(applied, m.frame > applied_at, "late by {late}: applied only in the quantum holding {applied_at}");
        }
        let c = status::counters(&m.core);
        assert_eq!((c.late_commands, c.max_lateness_frames), (1, s as u32), "the apply itself is not late");
    }
}

#[test]
fn a_re_parent_re_runs_the_bus_order() {
    // Tree [ROOT, 0, 0, 2]: order [3, 1, 2, 0]. BUS_SLOT moves bus 1 under bus 3 (asap and
    // stamped): depths become [0, 3, 1, 2] and `bus::area(..).order` [1, 3, 2, 0], equal to the
    // order a BUS_CONFIG of the same tree gives.
    let depths = |m: &Mixer| bus::slots(&m.core)[..bus::count(&m.core)].iter().map(|s| s.depth).collect::<Vec<u16>>();
    let order = |m: &Mixer| bus::area(&m.core).order[..bus::count(&m.core)].to_vec();
    // The tree a BUS_CONFIG of the moved tree gives: [ROOT, 3, 0, 2].
    let mut reference = Mixer::new(8);
    reference.submit(&[config(&[ROOT, 3, 0, 2])]);

    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0, 2])]);
    assert_eq!(&bus::area(&m.core).order[..4], &[3, 1, 2, 0]);
    m.submit(&[slot_rec(1, 0, 0, 3, &[], wire::ASAP)]);
    assert_eq!(depths(&m), vec![0, 3, 1, 2], "asap: depths re-run");
    assert_eq!(&order(&m)[..], &[1, 3, 2, 0]);
    assert_eq!((order(&m), depths(&m), parents(&m)), (order(&reference), depths(&reference), parents(&reference)));

    // Stamped: the same move at frame 128 applies at the start of the quantum 128..256.
    let mut s = Mixer::new(8);
    s.submit(&[config(&[ROOT, 0, 0, 2])]);
    submit_at(&mut s, 0.0, &[slot_rec(1, 1, 0, 3, &[], 128)]);
    s.render();
    assert_eq!(depths(&s), vec![0, 1, 1, 2], "not before its quantum");
    s.render();
    assert_eq!(depths(&s), vec![0, 3, 1, 2], "stamped: depths re-run");
    assert_eq!((order(&s), depths(&s), parents(&s)), (order(&reference), depths(&reference), parents(&reference)));
    assert_eq!(status::counters(&s.core).late_commands, 0);
}

#[test]
fn asap_configuration_is_unchanged() {
    // An asap BUS_SLOT applies when it arrives (before any render), BUS_DUCK and LOUD_CONFIG with a
    // stamped `frameOffset` never queue; a BUS_CONFIG of an untombstoned tree gives the same slots,
    // order and `busCount` as before M5.
    let mut m = Mixer::new(8);
    m.submit(&[config(&[ROOT, 0, 0])]);
    m.submit(&[slot_rec(2, 0, 0, 1, &[], wire::ASAP)]);
    assert_eq!(parents(&m), vec![ROOT, 0, 1], "applied when it arrived, before any render");
    assert_eq!(scheduler::config_pending_len(&m.core), 0);

    let mut duck = vec![0u8; wire::BusDuck::FIXED_END];
    wire::BusDuck { voice_id: 0, frame_offset: 9_000, rules: vec![] }.write(&mut duck, 0).unwrap();
    let mut loud = vec![0u8; wire::LoudConfig::FIXED_END];
    wire::LoudConfig { voice_id: 0, frame_offset: 9_000, tp_gate_dbfs: -7.0, meters: vec![] }.write(&mut loud, 0).unwrap();
    m.submit(&[Rec::Raw(duck), Rec::Raw(loud)]);
    assert_eq!(scheduler::config_pending_len(&m.core), 0, "BUS_DUCK and LOUD_CONFIG ignore their frame");

    let mut plain = Mixer::new(8);
    plain.submit(&[config(&[ROOT, 0, 1, 0])]);
    assert_eq!(bus::count(&plain.core), 4);
    assert_eq!(parents(&plain), vec![ROOT, 0, 1, 0]);
    assert_eq!(&bus::area(&plain.core).order[..4], &[2, 1, 3, 0]);
    assert_eq!(bus::area(&plain.core).has_reverb, 0);
    assert_eq!(scheduler::config_pending_len(&plain.core), 0);
    assert_eq!(scheduler::config_area(&plain.core).inflight_sequence, 0);
}
