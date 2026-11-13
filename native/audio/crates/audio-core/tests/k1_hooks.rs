//! K1's stage hooks (0171/0172 M5, plan contract K1): each hook takes its identity path, so every
//! pre-M5 digest stays bit-identical. One case per hook; the goldens (`golden_buses.rs`,
//! `zones_golden.rs`, `beds.rs`, `automation.rs`, …) check the whole render.

mod common;

use audio_core::bus::{self, BusSlot};
use audio_core::fx::kind;
use audio_core::lanes::{self, Gain};
use audio_core::{bus_order, bus_slots, duck, loudness, sends, status, QUANTUM};
use audio_dsp::ramp::Ramp;
use common::*;

fn zeroed_slot() -> BusSlot {
    // SAFETY: all-zero is a valid BusSlot (bus.rs).
    unsafe { core::mem::zeroed() }
}

#[test]
fn a_bus_whose_lanes_are_settled_at_unity_skips_the_multiply() {
    let mut ramp = Ramp::at(1.0);
    // Values a multiply by 1.0 would still leave alone, plus a NaN, whose payload a multiply may
    // canonicalise: the skip keeps every bit.
    let mut l = [f32::from_bits(0x7FC0_1234); QUANTUM];
    let mut r = [-0.0f32; QUANTUM];
    let mut curve = [0.0; QUANTUM];
    assert_eq!(lanes::apply(&mut ramp, None, None, &mut l, &mut r, &mut curve), Gain::Unity);
    assert!(l.iter().all(|x| x.to_bits() == 0x7FC0_1234) && r.iter().all(|x| x.to_bits() == (-0.0f32).to_bits()));
}

#[test]
fn the_duck_lane_is_at_identity_and_skipped() {
    let mut curve = [7.0f32; QUANTUM];
    assert!(!duck::gain(0, &mut curve), "no rule: the gain stage gets `None` and skips the lane");
    assert!(curve.iter().all(|c| *c == 7.0), "the curve isn't written");
    // The taps are no-ops on the signal (they only read).
    let (l, r) = ([0.5f32; QUANTUM], [0.25f32; QUANTUM]);
    duck::detect(0, &l, &r);
    loudness::tap(0, &l, &r);
    loudness::tap(loudness::OUTPUT_TAP, &l, &r);
}

#[test]
fn a_send_adds_its_scratch_unscaled_whatever_the_gain_and_clears_it() {
    for gain in [Gain::Unity, Gain::Scalar(0.25), Gain::Curve] {
        let x: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.37).sin() * 0.3).collect();
        let y: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.11).cos() * 0.2).collect();
        // Today: `rev += send * signal` straight into the convolver input.
        let want_l: Vec<f32> = y.iter().zip(&x).map(|(y, x)| y + 0.5 * x).collect();
        // K1: the reverb slot writes into the zeroed scratch, `feed` adds it.
        let mut scratch_l: Vec<f32> = x.iter().map(|x| 0.0 + 0.5 * x).collect();
        let mut scratch_r = scratch_l.clone();
        let (mut rev_l, mut rev_r) = (y.clone(), y.clone());
        sends::feed(&mut scratch_l, &mut scratch_r, gain, &[0.5; QUANTUM], &mut rev_l, &mut rev_r);
        assert!(rev_l.iter().zip(&want_l).all(|(a, b)| a.to_bits() == b.to_bits()), "{gain:?}: bit-identical with today's send");
        assert_eq!(rev_l, rev_r);
        assert!(scratch_l.iter().chain(&scratch_r).all(|s| *s == 0.0), "the scratch is cleared for the next bus");
    }
}

#[test]
fn the_convolver_runs_by_todays_rule() {
    assert!(!sends::convolver_should_run(false, false));
    assert!(sends::convolver_should_run(true, false));
    assert!(sends::convolver_should_run(false, true));
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
