//! K1's stage hooks (0171/0172 M5, plan contract K1): each hook takes its identity path, so every
//! pre-M5 digest stays bit-identical. One case per hook; the goldens (`golden_buses.rs`,
//! `zones_golden.rs`, `beds.rs`, `automation.rs`, …) check the whole render. Stage B: the M5
//! opcodes reach their owners' stubs, the M5 regions are laid out, and STATUS carries the 256-B
//! header and the three M5 sections.

mod common;

use audio_core::bus::{self, BusSlot};
use audio_core::counters::{BusDuckGain, LoudBus, MixSections, BUS_DUCK_CAP, LOUD_BUSES_CAP, LOUD_ENERGIES_CAP};
use audio_core::fx::kind;
use audio_core::lanes::{self, BusLanes, Gain};
use audio_core::layout::RegionKind;
use audio_core::{bus_order, bus_slots, duck, loudness, sends, status, QUANTUM};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;
use common::*;

fn zeroed_slot() -> BusSlot {
    // SAFETY: all-zero is a valid BusSlot (bus.rs).
    unsafe { core::mem::zeroed() }
}

fn duck_area() -> Box<duck::DuckArea> {
    // SAFETY: all-zero is a valid DuckArea.
    Box::new(unsafe { core::mem::zeroed() })
}

fn send_area() -> Box<sends::SendArea> {
    // SAFETY: all-zero is a valid SendArea.
    Box::new(unsafe { core::mem::zeroed() })
}

#[test]
fn a_bus_whose_lanes_are_settled_at_unity_skips_the_multiply() {
    let mut ramp = Ramp::at(1.0);
    // Values a multiply by 1.0 would still leave alone, plus a NaN, whose payload a multiply may
    // canonicalise: the skip keeps every bit.
    let mut l = [f32::from_bits(0x7FC0_1234); QUANTUM];
    let mut r = [-0.0f32; QUANTUM];
    let mut curve = [0.0; QUANTUM];
    assert_eq!(lanes::apply(&mut BusLanes::default(), &mut ramp, None, None, &mut l, &mut r, &mut curve), Gain::Unity);
    assert!(l.iter().all(|x| x.to_bits() == 0x7FC0_1234) && r.iter().all(|x| x.to_bits() == (-0.0f32).to_bits()));
}

#[test]
fn the_duck_lane_is_at_identity_and_skipped() {
    let mut d = duck_area();
    let mut curve = [7.0f32; QUANTUM];
    assert!(!duck::gain(&mut d, 0, &mut curve), "no rule: the gain stage gets `None` and skips the lane");
    assert!(curve.iter().all(|c| *c == 7.0), "the curve isn't written");
    // The taps are no-ops on the signal (they only read).
    let (l, r) = ([0.5f32; QUANTUM], [0.25f32; QUANTUM]);
    duck::detect(&mut d, 0, &l, &r);
    let mut meters = vec![0u8; loudness::REGION_BYTES];
    loudness::tap(&mut meters, 0, &l, &r);
    loudness::tap(&mut meters, loudness::OUTPUT_TAP, &l, &r);
    assert!(meters.iter().all(|b| *b == 0));
    assert_eq!(loudness::OUTPUT_TAP as u32, wire::LOUD_OUTPUT_TAP);
}

#[test]
fn a_send_at_unity_adds_its_scratch_unscaled_and_clears_it() {
    // Rv1 (O1, post-fader) scales the other gains: `sends_post_fader.rs`.
    for gain in [Gain::Unity] {
        let x: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.37).sin() * 0.3).collect();
        let y: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.11).cos() * 0.2).collect();
        // Today: `rev += send * signal` straight into the convolver input.
        let want_l: Vec<f32> = y.iter().zip(&x).map(|(y, x)| y + 0.5 * x).collect();
        // K1: the reverb slot adds into the zeroed scratch, `feed` adds it.
        let mut area = send_area();
        for i in 0..QUANTUM {
            area.l[i] += 0.5 * x[i];
            area.r[i] += 0.5 * x[i];
        }
        let (mut rev_l, mut rev_r) = (y.clone(), y.clone());
        sends::feed(&mut area, gain, &[0.5; QUANTUM], &mut rev_l, &mut rev_r);
        assert!(rev_l.iter().zip(&want_l).all(|(a, b)| a.to_bits() == b.to_bits()), "{gain:?}: bit-identical with today's send");
        assert_eq!(rev_l, rev_r);
        assert!(area.l.iter().chain(&area.r).all(|s| *s == 0.0), "the scratch is cleared for the next bus");
    }
}

/// Two buses, one reverb send each (after a high-pass and before a low-pass): the scratch route
/// (`FxChain::process` into the zeroed scratch, then `feed`) leaves the convolver input bit for bit
/// as today's route (`process` straight into it), quantum after quantum. (A bus with two or more
/// send slots sums them in the scratch first, so it may differ in the last bit; G1's golden.)
#[test]
fn a_single_send_per_bus_through_the_scratch_is_bit_identical_with_todays_route() {
    use audio_core::fx::FxChain;
    let fx = |send: f32| {
        let mut c = FxChain::default();
        c.configure([(kind::HIGHPASS, [90.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]), (kind::REVERB_SEND, [send, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), (kind::LOWPASS, [900.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0])], RATE);
        c
    };
    let (mut today, mut k1) = ([fx(0.3), fx(0.7)], [fx(0.3), fx(0.7)]);
    let mut area = send_area();
    for q in 0..8 {
        let (mut rev_today, mut rev_k1) = (vec![0.0f32; 2 * QUANTUM], vec![0.0f32; 2 * QUANTUM]);
        for b in 0..2 {
            let sig = |i: usize| ((q * QUANTUM + i) as f32 * (0.031 + 0.017 * b as f32)).sin() * 0.6;
            let mut l: Vec<f32> = (0..QUANTUM).map(sig).collect();
            let mut r: Vec<f32> = l.iter().map(|x| -0.5 * x).collect();
            let (mut l2, mut r2) = (l.clone(), r.clone());
            let (tl, tr) = rev_today.split_at_mut(QUANTUM);
            assert!(today[b].process(&mut l, &mut r, tl, tr));
            assert!(k1[b].process(&mut l2, &mut r2, &mut area.l, &mut area.r));
            let (kl, kr) = rev_k1.split_at_mut(QUANTUM);
            sends::feed(&mut area, Gain::Unity, &[1.0; QUANTUM], kl, kr);
            assert_eq!((l, r), (l2, r2), "the bus signal is unchanged");
        }
        let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&rev_today), bits(&rev_k1), "quantum {q}");
    }
}

#[test]
fn the_convolver_runs_by_todays_rule() {
    let (mut area, mut reverb) = (send_area(), [0u8; 64]);
    assert!(!sends::convolver_should_run(&mut area, &mut reverb, false, false));
    assert!(sends::convolver_should_run(&mut area, &mut reverb, true, false));
    assert!(sends::convolver_should_run(&mut area, &mut reverb, false, true));
}

#[test]
fn the_order_is_todays_by_depth_deepest_first_ties_by_index() {
    let mut slots: Vec<BusSlot> = (0..6).map(|_| zeroed_slot()).collect();
    for (s, d) in slots.iter_mut().zip([0u16, 2, 1, 2, 1, 0]) {
        s.depth = d;
    }
    let mut out = [0u8; 6];
    bus_order::compute(&slots, &mut out);
    assert_eq!(out, [1, 3, 2, 4, 0, 5]);
}

#[test]
fn a_slot_apply_keeps_or_freshens_the_bus_as_bus_config_did() {
    let mut s = zeroed_slot();
    s.gain = Ramp::at(0.3);
    let (dropped, reverb) = bus_slots::apply(&mut s, false, 4, [(kind::REVERB_SEND, [0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), (99, [0.0; 7])], RATE);
    assert_eq!((dropped, reverb, s.parent, s.gain.value), (1, true, 4, 0.3), "kept: the gain stays");
    let (dropped, reverb) = bus_slots::apply(&mut s, true, ROOT, [(kind::LOWPASS, [800.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0])], RATE);
    assert_eq!((dropped, reverb, s.parent, s.gain.value, s.lp.value), (0, false, ROOT, 1.0, OFF), "fresh: a unity bus");
}

#[test]
fn reset_settles_the_lanes_on_their_targets() {
    let mut m = Mixer::new(4);
    m.submit(&[config(&[ROOT, 0]), mix(48_000, &[(0.5, OFF), (0.25, 900.0)]), master(0.5, false, 48_000)]);
    m.render();
    m.submit(&[reset(true)]);
    let s = bus::slots(&m.core);
    assert!(s[..2].iter().all(|b| b.gain.is_settled() && b.lp.is_settled()));
    assert_eq!((s[0].gain.value, s[1].gain.value, s[1].lp.value), (0.5, 0.25, 900.0));
    assert_eq!((bus::area(&m.core).master.value, bus::area(&m.core).master.is_settled()), (0.5, true));
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Vec<u8> {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    b
}

/// One record of each M5 opcode, as main will send them: BUS_RAMP, BUS_DUCK, BUS_PRESENCE
/// (stamped), LOUD_CONFIG, BUS_SLOT.
fn m5_records() -> [Vec<u8>; 5] {
    let rule = wire::BusDuckRules { target: 1, trigger: 0, flags: wire::DUCK_FLAG_LEVEL, threshold_db: -30.0, amount: 0.25, attack: 0.01, release: 0.2 };
    [
        // B1a filled BUS_RAMP: a runtime-lane ramp to the value the lane already holds (1) is
        // dispatched and leaves the output bit-identical (`lanes_*.rs` test what it changes).
        raw(|b| wire::BusRamp { voice_id: 1, frame_offset: wire::ASAP, lane: wire::LANE_RUNTIME as u16, mask: 1, gain: 1.0, lp_hz: OFF, frames: 480, shape: 0 }.write(b, 0)),
        raw(|b| wire::BusDuck { voice_id: 0, frame_offset: wire::ASAP, rules: vec![rule.clone()] }.write(b, 0)),
        raw(|b| wire::BusPresence { voice_id: 0, frame_offset: 64, mask: 1 }.write(b, 0)),
        raw(|b| wire::LoudConfig { voice_id: 0, frame_offset: wire::ASAP, tp_gate_dbfs: -7.0, meters: vec![wire::LoudConfigMeters { slot: 1, reserved: 0 }] }.write(b, 0)),
        raw(|b| wire::BusSlot { voice_id: 0, frame_offset: wire::ASAP, slot: 1, flags: 0, sequence_id: 0, reserved: 0, reserved2: 0, parent: 2, effects: vec![] }.write(b, 0)),
    ]
}

#[test]
fn every_m5_opcode_is_dispatched_to_a_stub_that_changes_nothing() {
    let render = |extra: bool| {
        let mut m = Mixer::new(4);
        m.submit(&[config(&[ROOT, 0, 0]), mix(0, &[(0.5, OFF), (1.0, OFF), (1.0, OFF)]), dc(0x0001_0001, 1, 0.0)]);
        if extra {
            m.submit(&m5_records().map(Rec::Raw));
        }
        let out = m.render_n(4);
        (out, status::counters(&m.core).mix, bus::slots(&m.core)[1].parent)
    };
    let (want, _, parent) = render(false);
    let (got, mix, parent_after) = render(true);
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    assert!(want.0.iter().any(|x| *x != 0.0), "the scene is audible");
    assert_eq!((bits(&want.0), bits(&want.1)), (bits(&got.0), bits(&got.1)), "bit-identical");
    // B2 filled BUS_SLOT: the asap record re-parents bus 1 under bus 2 (both at unity, no effects,
    // so the sound is the same).
    assert_eq!((parent, parent_after), (0, 2), "BUS_SLOT re-parents (B2)");
    assert_eq!((mix.lane_records_ignored, mix.duck_rules_inert, mix.loud_meters_dropped, mix.live_deferred), (0, 0, 0, 0), "the stubs count nothing");
}

#[test]
fn a_malformed_m5_record_refuses_the_batch() {
    let mut m = Mixer::new(4);
    // Shrinks a record by `by` bytes, keeping its item count: the count claims more than it holds.
    let shrink = |mut b: Vec<u8>, by: usize| {
        let words = (b.len() - by) / 4;
        b.truncate(words * 4);
        b[0..2].copy_from_slice(&(words as u16).to_le_bytes());
        Rec::Raw(b)
    };
    let [ramp, duck, _, loud, slot] = m5_records();
    assert_eq!(m.try_submit(&[shrink(duck, 24)]), wire::ERR_MALFORMED, "BUS_DUCK");
    assert_eq!(m.try_submit(&[shrink(loud, 4)]), wire::ERR_MALFORMED, "LOUD_CONFIG");
    assert_eq!(m.try_submit(&[shrink(ramp, 4)]), wire::ERR_MALFORMED, "BUS_RAMP shorter than 32 B");
    let mut b = slot;
    b[26..28].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(m.try_submit(&[Rec::Raw(b)]), wire::ERR_MALFORMED, "BUS_SLOT with an effect count past its length");
}

#[test]
fn the_m5_regions_are_laid_out_and_the_lanes_start_at_unity() {
    let m = Mixer::new(4);
    let layout = m.core.layout();
    assert_eq!(layout.region(RegionKind::Lanes).len, 5 * lanes::BUS_LANES_BYTES, "4 buses and the output");
    assert_eq!(layout.region(RegionKind::Loudness).len, loudness::REGION_BYTES);
    assert_eq!(layout.region(RegionKind::Sends).len, sends::REGION_BYTES);
    assert_eq!(layout.region(RegionKind::Duck).len, duck::REGION_BYTES);
    let mut lanes_region = m.core.regions().lanes.to_vec();
    let entries = lanes::entries(&mut lanes_region);
    assert_eq!(entries.len(), 5);
    assert!(entries.iter().all(|e| e.lanes.iter().all(|r| r.is_settled() && r.value == 1.0) && e.moving == 0));
    let mut meters = vec![0u8; loudness::REGION_BYTES];
    let (state, ring) = loudness::meter(&mut meters, 8).unwrap();
    assert_eq!((state.len(), ring.len()), (loudness::METER_STATE_BYTES, loudness::RING_BYTES));
    assert!(loudness::meter(&mut meters, 9).is_none());
}

#[test]
fn the_m5_status_sections_read_back_through_the_generated_reader() {
    // K1's stubs: a take carries the 256-B header and empty M5 sections.
    let mut m = Mixer::new(4);
    let mut out = vec![0u8; status::BUFFER_BYTES];
    let n = status::take(&mut m.core, &mut out, 0x400);
    assert_eq!(n, status::HEADER_BYTES);
    let (s, read) = wire::StatusBlock::read(&out, 0).unwrap();
    assert_eq!(read, 256);
    assert_eq!((s.loud_buses.len(), s.loud_energies.len(), s.bus_duck.len(), s.abi_version), (0, 0, 0, 0x400));
    // At their caps (what Ld2 and Dp1 will fill): the 17,824 B worst case.
    let c = *status::counters(&m.core);
    let mut mix = MixSections::default();
    for i in 0..LOUD_BUSES_CAP as u16 {
        let slot = if i == 0 { loudness::OUTPUT_TAP } else { i };
        assert!(mix.loud_buses.push(LoudBus { slot, flags: 32 | wire::LOUD_FLAG_GATED as u16, first_seq: 70 + i as u32, true_peak: 0.875, gated_quanta: 11 }));
    }
    for i in 0..LOUD_ENERGIES_CAP {
        assert!(mix.loud_energies.push(i as f32 / 1024.0));
    }
    for i in 0..BUS_DUCK_CAP as u16 {
        assert!(mix.bus_duck.push(BusDuckGain { slot: i, gain: 1.0 - i as f32 / 64.0 }));
    }
    let n = status::write_with(&c, &mix, 3, &mut out);
    assert_eq!(n, status::message_bytes_with(&c, &mix));
    let (s, read) = wire::StatusBlock::read(&out, 0).unwrap();
    assert_eq!(read, n);
    assert_eq!((s.loud_buses.len(), s.loud_energies.len(), s.bus_duck.len()), (LOUD_BUSES_CAP, LOUD_ENERGIES_CAP, BUS_DUCK_CAP));
    let b = &s.loud_buses[0];
    assert_eq!((b.slot, b.flags, b.first_seq, b.true_peak, b.gated_quanta), (0xFFFF, 32 | 0x200, 70, 0.875, 11));
    assert_eq!(s.loud_energies[287], 287.0 / 1024.0);
    assert_eq!((s.bus_duck[31].slot, s.bus_duck[31].gain), (31, 1.0 - 31.0 / 64.0));
}

#[test]
fn the_m5_record_stubs_ignore_the_record_and_count_nothing() {
    let mut m = Mixer::new(4);
    let before = status::counters(&m.core).mix;
    let msg = [0u8; 64];
    assert!(lanes::ramp_is_well_formed(&msg, 0, 32) && duck::rules_is_well_formed(&msg, 0, 16));
    assert!(bus_slots::slot_is_well_formed(&msg, 0, 28) && loudness::config_is_well_formed(&msg, 0, 20));
    lanes::on_ramp(&mut m.core, &msg, 0, None);
    bus_slots::on_slot(&mut m.core, &msg, 0, Some(128));
    duck::on_rules(&mut m.core, &msg, 0);
    duck::on_presence(&mut m.core, &msg, 0, None);
    loudness::on_config(&mut m.core, &msg, 0);
    let after = status::counters(&m.core).mix;
    assert_eq!((before.lane_records_ignored, before.live_deferred, before.bus_records_early), (after.lane_records_ignored, after.live_deferred, after.bus_records_early));
    assert_eq!((after.lane_records_ignored, after.live_deferred, after.duck_rules_inert, after.loud_meters_dropped), (0, 0, 0, 0));
}
