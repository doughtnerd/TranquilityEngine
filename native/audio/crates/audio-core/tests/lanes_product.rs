//! The seven gain lanes (0171/0172 M5 §4.5, R1, R3, R12; task B1a): the lane product, identity
//! lanes skipped bit for bit, a retarget from the current value, `BUS_MASTER_OUT`, RESET on
//! targets, the core-owned lanes and bad records ignored and counted, a non-finite target left
//! alone. Real BATCH messages through `scheduler::submit`; a DC 1.0 voice makes each level exact.

mod common;

use audio_core::lanes::{self, BusLanes, Gain};
use audio_core::{bus, status, QUANTUM};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;
use common::*;

const TOL: f32 = 1e-6;
const V1: u32 = 0x0001_0001;
const MASTER_OUT: u32 = wire::BUS_MASTER_OUT;

fn ramp(bus: u32, lane: u32, gain: f32, frames: u32) -> wire::BusRamp {
    lane_ramp(bus, lane, Some(gain), None, frames)
}

fn ramps(rs: &[wire::BusRamp]) -> Rec {
    Rec::Ramps(rs.to_vec())
}

/// A mixer with bus 1 under the root and a DC voice on it, no limiter look-ahead.
fn scene() -> Mixer {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    m.submit(&[config(&[ROOT, 0]), dc(V1, 1, 0.0)]);
    m
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

fn ignored(m: &Mixer) -> u32 {
    status::counters(&m.core).mix.lane_records_ignored
}

#[test]
fn the_bus_gain_is_the_product_of_its_lanes() {
    let mut m = scene();
    m.submit(&[ramps(&[ramp(1, wire::LANE_AUTHORED, 0.5, 0), ramp(1, wire::LANE_RUNTIME, 2.0, 0), ramp(1, wire::LANE_SNAPSHOT, 0.75, 0), ramp(1, wire::LANE_MONITOR, 1.0, 0), ramp(1, wire::LANE_DIP, 0.5, 0)])]);
    m.render();
    m.expect(L, TOL, "settled lanes fold into one scalar", |_| 0.5 * 2.0 * 0.75 * 0.5);
    // Two lanes moving at once: each frame is the product of their `Ramp::next` values.
    m.submit(&[ramps(&[ramp(1, wire::LANE_AUTHORED, 1.0, 200), ramp(1, wire::LANE_DIP, 0.0, 300)])]);
    m.render_n(3);
    m.expect(L, TOL, "two ramps multiply", |k| 2.0 * 0.75 * ramp_to(0.5, 1.0, 200, k) * ramp_to(0.5, 0.0, 300, k));
    // Lanes compose on a parent and a child.
    m.submit(&[ramps(&[ramp(1, wire::LANE_DIP, 1.0, 0), ramp(0, wire::LANE_MONITOR, 0.5, 0)])]);
    m.render();
    m.expect(L, TOL, "down the tree", |_| 2.0 * 0.75 * 0.5);
}

#[test]
fn a_lone_lane_is_bit_identical_whichever_lane_it_is_and_identity_lanes_are_skipped() {
    // The same moves on the runtime lane (BUS_MIX's before M5) and on the authored lane: the same
    // bits, because a lone lane uses `Ramp::next` and the others are skipped.
    let render = |lane: u32, extra: &[wire::BusRamp]| {
        let mut m = scene();
        m.submit(&[ramps(extra)]);
        let mut out = Vec::new();
        for (g, f) in [(0.3f32, 0u32), (0.9, 300), (0.1, 77), (1.0, 128), (0.7, 1_000)] {
            m.submit(&[ramps(&[ramp(1, lane, g, f)])]);
            let (l, r) = m.render_n(3);
            out.extend(bits(&l));
            out.extend(bits(&r));
        }
        out
    };
    let want = render(wire::LANE_RUNTIME, &[]);
    assert_eq!(render(wire::LANE_AUTHORED, &[]), want, "authored alone");
    assert_eq!(render(wire::LANE_DIP, &[]), want, "dip alone");
    // Lanes written to 1 (a step, and a ramp that has landed) are identity: skipped, not multiplied.
    let ones = [ramp(1, wire::LANE_MONITOR, 1.0, 0), ramp(1, wire::LANE_SNAPSHOT, 0.5, 0), ramp(1, wire::LANE_SNAPSHOT, 1.0, 0), ramp(0, wire::LANE_AUTHORED, 1.0, 0)];
    assert_eq!(render(wire::LANE_RUNTIME, &ones), want, "with every other lane at 1");
}

#[test]
fn a_bus_at_identity_keeps_every_bit_and_a_lane_back_at_one_is_skipped_again() {
    let mut rt = Ramp::at(1.0);
    let mut l = [f32::from_bits(0x7FC0_1234); QUANTUM];
    let mut r = [-0.0f32; QUANTUM];
    let mut curve = [0.0; QUANTUM];
    let mut e = BusLanes::default();
    assert_eq!(lanes::apply(&mut e, &mut rt, None, None, &mut l, &mut r, &mut curve), Gain::Unity);
    assert!(l.iter().all(|x| x.to_bits() == 0x7FC0_1234) && r.iter().all(|x| x.to_bits() == (-0.0f32).to_bits()));
    // A lane that ramps away and lands back on 1 clears its bit: from then on, skipped again.
    let mut m = scene();
    m.submit(&[ramps(&[ramp(1, wire::LANE_MONITOR, 0.5, 64), ramp(1, wire::LANE_MONITOR, 1.0, 64)])]);
    m.render();
    let mut region = m.core.regions().lanes.to_vec();
    assert_eq!(lanes::entries(&mut region)[1].moving, 0);
}

#[test]
fn a_retarget_starts_from_the_lanes_current_value() {
    let mut m = scene();
    m.submit(&[ramps(&[ramp(1, wire::LANE_MONITOR, 0.0, 256)])]);
    m.render();
    m.expect(L, TOL, "half way down", |k| ramp_to(1.0, 0.0, 256, k));
    m.submit(&[ramps(&[ramp(1, wire::LANE_MONITOR, 1.0, 128)])]);
    m.render();
    m.expect(L, TOL, "back up from 0.5, no jump", |k| ramp_to(0.5, 1.0, 128, k));
    // A step (frames 0) lands at once.
    m.submit(&[ramps(&[ramp(1, wire::LANE_MONITOR, 0.25, 0)])]);
    m.render();
    m.expect(L, TOL, "a step", |_| 0.25);
}

#[test]
fn bus_master_out_drives_the_output_gain() {
    let mut m = scene();
    m.submit(&[master(0.5, false, 0)]);
    m.render();
    m.expect(L, TOL, "MASTER", |_| 0.5);
    // The output's runtime lane is MASTER's own ramp: one value, not multiplied twice.
    m.submit(&[ramps(&[ramp(MASTER_OUT, wire::LANE_RUNTIME, 0.25, 128)])]);
    m.render();
    m.expect(L, TOL, "the runtime lane ramps MASTER's value", |k| ramp_to(0.5, 0.25, 128, k));
    assert_eq!(bus::area(&m.core).master.value, 0.25);
    // Its other lanes multiply on top; a low-pass on the output is ignored.
    m.submit(&[ramps(&[ramp(MASTER_OUT, wire::LANE_MONITOR, 0.5, 0), lane_ramp(MASTER_OUT, wire::LANE_SNAPSHOT, None, Some(200.0), 0)])]);
    m.render();
    m.expect(L, TOL, "the monitor lane on the output", |_| 0.125);
    assert_eq!(ignored(&m), 0);
    // The bus tree is untouched by the output's lanes.
    assert_eq!(bus::slots(&m.core)[1].gain.target, 1.0);
}

#[test]
fn reset_settles_every_lane_on_its_target() {
    let mut m = scene();
    m.submit(&[ramps(&[
        ramp(1, wire::LANE_RUNTIME, 0.5, 10_000),
        ramp(1, wire::LANE_DIP, 0.5, 10_000),
        lane_ramp(1, wire::LANE_SNAPSHOT, Some(0.5), Some(900.0), 10_000),
        ramp(MASTER_OUT, wire::LANE_AUTHORED, 0.5, 10_000),
        ramp(MASTER_OUT, wire::LANE_RUNTIME, 2.0, 10_000),
    ])]);
    m.render();
    m.submit(&[reset(true), dc(V1 + 1, 1, 0.0)]);
    let s = bus::slots(&m.core)[1];
    assert!(s.gain.is_settled() && s.lp.is_settled());
    assert_eq!((s.gain.value, s.lp.value), (0.5, 900.0));
    let mut region = m.core.regions().lanes.to_vec();
    let e = lanes::entries(&mut region);
    assert_eq!((e[1].lane(wire::LANE_DIP as usize), e[1].lane(wire::LANE_SNAPSHOT as usize)), (Ramp::at(0.5), Ramp::at(0.5)));
    assert_eq!(e.last().unwrap().lane(wire::LANE_AUTHORED as usize), Ramp::at(0.5));
    // The low-pass (900 Hz, its state cleared by RESET) passes DC once it has risen.
    m.render_n(8);
    m.render();
    m.expect(L, 1e-4, "every lane at its target", |_| 0.5 * 0.5 * 0.5 * 0.5 * 2.0);
}

#[test]
fn the_core_owned_lanes_unknown_lanes_and_absent_slots_are_ignored_and_counted() {
    let mut m = scene();
    m.submit(&[ramps(&[ramp(1, wire::LANE_DUCK, 0.0, 0), ramp(1, wire::LANE_AUTOMATION, 0.0, 0), ramp(1, 9, 0.0, 0), ramp(2, wire::LANE_RUNTIME, 0.0, 0), ramp(0xFFFE, wire::LANE_RUNTIME, 0.0, 0)])]);
    assert_eq!(ignored(&m), 5);
    m.render();
    m.expect(L, TOL, "nothing changed", |_| 1.0);
}

#[test]
fn a_non_finite_target_leaves_the_lane_alone_and_values_clamp() {
    let mut m = scene();
    m.submit(&[ramps(&[ramp(1, wire::LANE_AUTHORED, 0.5, 0)])]);
    m.submit(&[ramps(&[ramp(1, wire::LANE_AUTHORED, f32::NAN, 0), ramp(1, wire::LANE_AUTHORED, f32::INFINITY, 64), ramp(1, wire::LANE_AUTHORED, f32::NEG_INFINITY, 64)])]);
    m.render();
    m.expect(L, TOL, "the target stayed", |_| 0.5);
    assert_eq!(ignored(&m), 0, "a non-finite value is left, not counted");
    m.submit(&[ramps(&[ramp(1, wire::LANE_AUTHORED, 7.0, 0), ramp(1, wire::LANE_RUNTIME, -3.0, 0)])]);
    let mut region = m.core.regions().lanes.to_vec();
    assert_eq!(lanes::entries(&mut region)[1].lane(wire::LANE_AUTHORED as usize).target, 4.0, "clamped to 4");
    assert_eq!(bus::slots(&m.core)[1].gain.target, 0.0, "clamped to 0");
}
