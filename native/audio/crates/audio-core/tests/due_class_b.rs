//! Class B, the due list's stamped `BUS_RAMP`s (0171/0172 M5 B1b; ARCH §4.5, R6): a stamp mid-quantum
//! ramps its lane from the lane's value at its sample, two stamps of one lane apply in frame order,
//! two lanes multiply per frame, a full due list or a full stage applies early and counts
//! `busRecordsEarly` without a split, a stamp at a quantum's first frame equals the asap record sent
//! one quantum earlier, and a sequence found late only at its pop shifts whole. Real BATCH messages
//! through `scheduler::submit`; a DC voice makes each level exact, and the reference per sample is
//! `audio_dsp::ramp::Ramp` (hold the lane's motion up to the stamp's sample, retarget there, `next`).

mod common;

use audio_core::{bus, due, lanes, status};
use audio_dsp::ramp::Ramp;
use audio_wire::generated as wire;
use common::*;

const TOL: f32 = 1e-7;
const V1: u32 = 0x0001_0001;
const MASTER_OUT: u32 = wire::BUS_MASTER_OUT;
const AUTHORED: u32 = wire::LANE_AUTHORED;
const RUNTIME: u32 = wire::LANE_RUNTIME;
const SNAPSHOT: u32 = wire::LANE_SNAPSHOT;
const MONITOR: u32 = wire::LANE_MONITOR;
const DIP: u32 = wire::LANE_DIP;

/// A stamped `BUS_RAMP` of `lane` on `bus` to `gain` over `frames`, due at absolute frame `at`, in a
/// batch whose first frame is `base` (the frame `m.frame` stands at when it is submitted).
fn stamp(base: u64, bus: u32, lane: u32, gain: f32, frames: u32, at: u64) -> Rec {
    Rec::Ramps(vec![wire::BusRamp { frame_offset: (at - base) as u32, ..lane_ramp(bus, lane, Some(gain), None, frames) }])
}

/// An asap `BUS_RAMP` of `lane` on `bus`.
fn asap(bus: u32, lane: u32, gain: f32, frames: u32) -> Rec {
    Rec::Ramps(vec![lane_ramp(bus, lane, Some(gain), None, frames)])
}

/// A DC voice at `gain` on `bus` (a quieter sibling, so two buses sum under the 0 dBFS ceiling).
fn quiet_dc(voice: u32, bus: u16, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, bus, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

/// Buses 0 to 2 under the root, a DC voice on bus 1 (the target), and with `sibling` a quieter DC
/// voice on bus 2. No limiter look-ahead.
fn scene(sibling: bool) -> Mixer {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    let mut recs = vec![config(&[ROOT, ROOT, ROOT]), dc(V1, 1, 0.0)];
    if sibling {
        recs.push(quiet_dc(V1 + 1, 2, 0.25));
    }
    m.submit(&recs);
    m
}

/// One retarget of a lane: at absolute frame `at` it heads for `gain` over `frames`.
#[derive(Clone, Copy)]
struct Event {
    at: u64,
    gain: f32,
    frames: u32,
}

fn ev(at: u64, gain: f32, frames: u32) -> Event {
    Event { at, gain, frames }
}

/// A lane's gain per frame from 1.0 over `n` frames. Each event retargets from the value the lane
/// has at its frame, before that frame's `next` (the core's order at a stamp's sample).
fn reference(events: &[Event], n: usize) -> Vec<f32> {
    let mut r = Ramp::at(1.0);
    (0..n as u64)
        .map(|f| {
            for e in events.iter().filter(|e| e.at == f) {
                r.set_target(e.gain, e.frames);
            }
            r.next()
        })
        .collect()
}

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

/// Bus `bus`'s runtime ramp, its low-pass and its lane entry's bytes: the state another bus's
/// records must leave alone.
fn state(m: &Mixer, bus: usize) -> (Ramp, Ramp, Vec<u8>) {
    let s = bus::slots(&m.core)[bus];
    let e = lanes::BUS_LANES_BYTES;
    let region = m.core.regions().lanes.to_vec();
    (s.gain, s.lp, region[bus * e..(bus + 1) * e].to_vec())
}

fn split_quanta(m: &Mixer) -> u32 {
    status::counters(&m.core).music.split_quanta
}

fn early(m: &Mixer) -> u16 {
    status::counters(&m.core).mix.bus_records_early
}

#[test]
fn a_stamped_ramp_on_each_lane_moves_only_its_bus() {
    for lane in [AUTHORED, RUNTIME, SNAPSHOT, MONITOR, DIP] {
        let mut m = scene(true);
        // The target lane steps to 0.5 first, so the bus and its quieter sibling sum under the ceiling.
        m.submit(&[asap(1, lane, 0.5, 0)]);
        m.render();
        let base = m.frame as usize;
        let sibling = state(&m, 2);
        m.submit(&[stamp(base as u64, 1, lane, 0.25, 150, base as u64 + 72)]);
        m.render_n(3);
        let refv = reference(&[ev(0, 0.5, 0), ev(base as u64 + 72, 0.25, 150)], base + 384);
        m.expect(L, TOL, &format!("lane {lane}: left"), |k| refv[base + k] + 0.25);
        m.expect(R, TOL, &format!("lane {lane}: right"), |k| refv[base + k] + 0.25);
        assert_eq!(state(&m, 2), sibling, "lane {lane}: the sibling bus is untouched, bit for bit");
        assert_eq!((split_quanta(&m), early(&m)), (0, 0), "lane {lane}");
    }
}

#[test]
fn a_retarget_mid_ramp_starts_from_the_lanes_value_at_its_stamp() {
    let mut m = scene(false);
    m.submit(&[asap(1, MONITOR, 0.5, 400)]);
    let refv = reference(&[ev(0, 0.5, 400), ev(300, 1.0, 128)], 512);
    let (l1, _) = m.render_n(2);
    m.expect(L, TOL, "the asap ramp before the stamp", |k| refv[k]);
    // The stamp at 300 is inside the second span (offset 44 of quantum 256).
    m.submit(&[stamp(256, 1, MONITOR, 1.0, 128, 300)]);
    let (l2, _) = m.render_n(2);
    m.expect(L, TOL, "retargeted from its value at 300", |k| refv[256 + k]);
    let all: Vec<f32> = l1.into_iter().chain(l2).collect();
    for k in 1..all.len() {
        assert!((all[k] - all[k - 1]).abs() <= 1.0 / 128.0, "a jump at frame {k}: {} to {}", all[k - 1], all[k]);
    }
    assert_eq!((split_quanta(&m), early(&m)), (0, 0));
}

/// Two stamps on one lane in one quantum (at 30 and 90), submitted in one of three ways: variant 0,
/// two batches in frame order; 1, one batch in frame order; 2, one batch out of frame order.
fn two_on_one_lane(variant: u8) -> (Vec<u32>, Vec<u32>) {
    let mut m = scene(false);
    m.render();
    let base = m.frame;
    let a = || stamp(base, 1, MONITOR, 0.5, 40, base + 30);
    let b = || stamp(base, 1, MONITOR, 0.9, 40, base + 90);
    match variant {
        0 => {
            m.submit(&[a()]);
            m.submit(&[b()]);
        }
        1 => m.submit(&[a(), b()]),
        _ => m.submit(&[b(), a()]),
    }
    let (l, r) = m.render_n(2);
    let refv = reference(&[ev(base + 30, 0.5, 40), ev(base + 90, 0.9, 40)], base as usize + 256);
    m.expect(L, TOL, &format!("variant {variant}: left"), |k| refv[base as usize + k]);
    m.expect(R, TOL, &format!("variant {variant}: right"), |k| refv[base as usize + k]);
    assert_eq!((split_quanta(&m), early(&m)), (0, 0), "variant {variant}");
    (bits(&l), bits(&r))
}

#[test]
fn two_stamps_on_one_lane_in_one_quantum_apply_in_frame_order() {
    let (two_batches, one_in_order, one_out_of_order) = (two_on_one_lane(0), two_on_one_lane(1), two_on_one_lane(2));
    assert_eq!(one_in_order, two_batches, "one batch and two batches agree bit for bit");
    assert_eq!(one_out_of_order, two_batches, "a batch out of frame order applies in frame order");
}

#[test]
fn two_lanes_ramping_at_once_multiply_per_frame() {
    let mut m = scene(false);
    m.submit(&[asap(1, AUTHORED, 0.5, 300)]);
    m.render();
    let base = m.frame as usize;
    m.submit(&[stamp(base as u64, 1, DIP, 0.25, 100, base as u64 + 72)]);
    m.render_n(3);
    let a = reference(&[ev(0, 0.5, 300)], base + 384);
    let b = reference(&[ev(base as u64 + 72, 0.25, 100)], base + 384);
    m.expect(L, TOL, "the product of the two lanes", |k| a[base + k] * b[base + k]);
    assert_eq!((split_quanta(&m), early(&m)), (0, 0));
}

#[test]
fn a_full_due_list_applies_the_stamp_at_the_quantum_start_and_counts_early() {
    let mut m = scene(false);
    m.render();
    let base = m.frame;
    // DUE_RECORDS low-pass stamps at the quantum's second frame fill the due list. Their low-pass
    // target is the open one already, so they change nothing and stage nothing.
    let fill: Vec<Rec> = (0..due::DUE_RECORDS).map(|_| Rec::Ramps(vec![wire::BusRamp { frame_offset: 1, ..lane_ramp(2, SNAPSHOT, None, Some(OFF), 0) }])).collect();
    m.submit(&fill);
    // The 257th due record of the quantum: it finds the list full.
    m.submit(&[stamp(base, 1, MONITOR, 0.25, 100, base + 100)]);
    m.render_n(2);
    let refv = reference(&[ev(base, 0.25, 100)], base as usize + 256);
    m.expect(L, TOL, "applied from the quantum's first sample", |k| refv[base as usize + k]);
    assert_eq!(early(&m), 1, "counted once");
    assert_eq!(split_quanta(&m), 0, "never splits");
}

#[test]
fn a_fourth_stamped_gain_ramp_on_one_bus_in_a_quantum_applies_at_its_start() {
    let mut m = scene(false);
    m.render();
    let base = m.frame;
    // Three stamps stage on bus 1 (lanes 1, 2 and 3 at 10, 20 and 30); the fourth, on lane 4 at 60,
    // finds the stage slots full and applies at the quantum's start.
    let staged = [RUNTIME, SNAPSHOT, MONITOR];
    assert_eq!(staged.len(), lanes::STAMPS);
    m.submit(&[
        stamp(base, 1, RUNTIME, 0.5, 50, base + 10),
        stamp(base, 1, SNAPSHOT, 0.75, 50, base + 20),
        stamp(base, 1, MONITOR, 0.25, 50, base + 30),
        stamp(base, 1, DIP, 0.5, 50, base + 60),
    ]);
    m.render_n(2);
    let r1 = reference(&[ev(base as u64 + 10, 0.5, 50)], base as usize + 256);
    let r2 = reference(&[ev(base as u64 + 20, 0.75, 50)], base as usize + 256);
    let r3 = reference(&[ev(base as u64 + 30, 0.25, 50)], base as usize + 256);
    let r4 = reference(&[ev(base as u64, 0.5, 50)], base as usize + 256);
    // The core multiplies the runtime lane first, then lanes 2, 3 and 4.
    m.expect(L, TOL, "the four lanes, multiplied", |k| {
        let i = base as usize + k;
        r1[i] * r2[i] * r3[i] * r4[i]
    });
    assert_eq!((early(&m), split_quanta(&m)), (1, 0));
}

/// The output of a stamp at the quantum's first frame (`stamped`), or of the same record sent asap
/// in the quantum before, on `(bus, lane)`.
fn first_frame_run(stamped: bool, bus: u32, lane: u32) -> (Vec<u32>, Vec<u32>) {
    let mut m = scene(false);
    m.render();
    let base = m.frame;
    if stamped {
        m.submit(&[stamp(base, bus, lane, 0.25, 100, base)]);
    } else {
        m.submit(&[asap(bus, lane, 0.25, 100)]);
    }
    let (l, r) = m.render_n(3);
    assert!(l.iter().any(|&x| x != 1.0), "bus {bus:#x} lane {lane}: the ramp moved the output");
    (bits(&l), bits(&r))
}

#[test]
fn a_stamp_at_the_quantum_start_is_the_asap_record_sent_one_quantum_earlier() {
    for (bus, lane) in [(1, MONITOR), (1, RUNTIME), (MASTER_OUT, RUNTIME)] {
        assert_eq!(first_frame_run(true, bus, lane), first_frame_run(false, bus, lane), "bus {bus:#x} lane {lane}");
    }
}

#[test]
fn bus_master_out_takes_a_stamped_ramp_from_its_sample() {
    let mut m = scene(false);
    m.render();
    let base = m.frame as usize;
    m.submit(&[stamp(base as u64, MASTER_OUT, RUNTIME, 0.25, 100, base as u64 + 72)]);
    m.render_n(3);
    let refv = reference(&[ev(base as u64 + 72, 0.25, 100)], base + 384);
    m.expect(L, TOL, "the output scaled from the stamp's sample", |k| refv[base + k]);
    assert_eq!((split_quanta(&m), early(&m)), (0, 0));
}

#[test]
fn a_sequence_found_late_only_at_its_pop_shifts_whole_and_counts_once() {
    let mut m = scene(false);
    m.render_n(4);
    // Sequence 7's dip-down, on time at 512 (its F0).
    m.submit(&[Rec::Ramps(vec![wire::BusRamp { frame_offset: 0, shape: wire::pack_ramp_shape(0, 7, 0), ..lane_ramp(1, DIP, Some(0.5), None, 128) }])]);
    assert_eq!(status::counters(&m.core).late_commands, 0);
    // The shell's clock jumps to 1,280. The ramp lands at F0 + ceil((1,280 − 512) / 128) × 128 = 1,280.
    m.frame = 1280;
    m.render_n(2);
    let refv = reference(&[ev(1280, 0.5, 128)], 1280 + 256);
    m.expect(L, TOL, "the dip-down from the shifted frame", |k| refv[1280 + k]);
    let c = status::counters(&m.core);
    assert_eq!((c.late_commands, c.max_lateness_frames), (1, 768), "counted once, s = 768");
}
