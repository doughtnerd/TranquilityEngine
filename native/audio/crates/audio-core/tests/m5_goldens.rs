//! G1 (0171/0172 M5-0; api-and-models §10 "Golden" and M5-0's exit check; architecture §3.3, §4.5,
//! §4.7): the new goldens of the stamped-ramp and slot-table flips, each written natively here in
//! Z3's format under `golden/m5/` and replayed bit for bit on the real wasm by
//! `runtime/golden/audioGoldenM5.test.ts`.
//!
//! - **`stamped-fade`**: a script fade on the `runtime` lane stamped mid-quantum, then retargeted
//!   mid-ramp by a second stamp; against the per-sample offline reference (§4.5, 1e-7).
//! - **`stamped-snapshot`**: a snapshot transition on the `snapshot` lane stamped mid-quantum while
//!   a stamped `runtime` fade overlaps it (two lanes multiply per sample), against the reference;
//!   then a stamped snapshot low-pass (the discontinuity check only).
//! - **`stamped-slot`**: a `BUS_SLOT` re-parent stamped mid-quantum applies at the start of the
//!   quantum holding its frame, and not before.
//! - **`tombstone`**: a removal's sequence (dip-down, then the tombstone `BUS_SLOT`): the removed
//!   bus is a silent root that keeps its index, and the bus after it is still addressed by its index.
//! - **`late-sequence`**: a structural sequence whose batch arrives after its F0 is shifted whole by
//!   whole quanta (`lateCommands` once, `maxLatenessFrames` = the shift), against the reference.
//! - **`two-sends`** (build log D2): a bus with two reverb sends sums them in the post-fader scratch.
//!
//! `splitQuanta` is 0 in every scene. DS0's discontinuity windows (F-40's `maxStep`) ride in the
//! fixtures of the fade and snapshot scenes and run here and on the wasm output.

mod m5_common;

use audio_core::{bus, fx::kind};
use audio_wire::generated as wire;
use m5_common::common::*;
use m5_common::*;

const TEST: &str = "m5_goldens";
const RUNTIME: u32 = wire::LANE_RUNTIME;
const SNAPSHOT: u32 = wire::LANE_SNAPSHOT;
/// §4.5's exactness for class B: S4 measured 5e-8.
const EXACT: f64 = 1e-7;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0002_0002;

/// The discontinuity bound of a window whose reference's own largest step is `ideal`: 1 % over
/// it plus 1e-6 (rounding). A step of the change at once (no ramp) is the whole move.
fn bound(ideal: f32) -> f32 {
    ideal * 1.01 + 1e-6
}

/// Checks the scene against `want` over `[from, to)` at `EXACT`, and against the f64 line at
/// `line_tol`; returns the error against `want`.
fn null(s: &Scene, name: &str, from: usize, to: usize, want: &[f32], line: &[f64], line_tol: f64) -> f64 {
    let err = max_error(s, from, to, |i| want[i] as f64);
    let line_err = max_error(s, from, to, |i| line[i]);
    eprintln!("{name}: max error {err:e} against the per-sample reference, {line_err:e} against the exact line");
    assert!(err <= EXACT, "{name}: {err} against the reference over {from}..{to}");
    assert!(line_err <= line_tol, "{name}: {line_err} against the exact line over {from}..{to}");
    err
}

/// Every window's `maxStep` (both channels) within its bound.
fn ds0(s: &Scene, name: &str, windows: &[(usize, usize, f32)]) {
    for &(from, to, b) in windows {
        let step = max_step(&s.left[from..to]).max(max_step(&s.right[from..to]));
        eprintln!("{name}: DS0 window {from}..{to}: maxStep {step:e} (bound {b:e})");
        assert!(step <= b, "{name}: a step of {step} in {from}..{to}, over {b}");
    }
}

#[test]
fn stamped_fade_lands_on_its_stamp_and_matches_the_reference() {
    let name = "stamped-fade";
    let mut s = Scene::new();
    s.send(&[config(&[ROOT, 0]), dc_at(V1, 1, 0.5)]);
    s.run(4);
    // A fade to 0.25 over 1,000 frames from 712 (offset 72 of the quantum at 640).
    assert_eq!(s.frame(), 512);
    s.send(&[stamped(1, RUNTIME, 0.25, 1000, 200)]);
    s.run(12);
    // Retargeted to 1 over 480 frames from 2,381 (mid-ramp, offset 77 of 2,304's quantum).
    assert_eq!(s.frame(), 2048);
    s.send(&[stamped(1, RUNTIME, 1.0, 480, 333)]);
    s.run(8);
    let n = s.left.len();
    let events = [(712, 0.25, 1000), (2381, 1.0, 480)];
    let lane = lane_reference(1.0, &events, n);
    let want: Vec<f32> = lane.iter().map(|g| 0.5 * g).collect();
    let line: Vec<f64> = lane_line(1.0, &events, n).iter().map(|g| 0.5 * g).collect();
    assert!(s.left[..712].iter().all(|&x| x == 0.5), "nothing moves before the stamp");
    assert!(s.left[712] < 0.5, "the fade starts on its stamped frame");
    let err = null(&s, name, 0, n, &want, &line, 1e-5);
    assert_eq!(s.split_quanta(), 0);
    assert_eq!(s.early(), 0);
    // DS0: the fade and its retarget; the ideal step is the faster segment's.
    let ideal = max_step(&want);
    let windows = vec![(512, n, bound(ideal))];
    ds0(&s, name, &windows);
    eprintln!("{name}: the fade at once would step {}", 0.5 * 0.75);
    write_or_check(TEST, name, "G1: a script fade on the runtime lane stamped mid-quantum (712), retargeted mid-ramp by a second stamp (2381); against the per-sample reference", &s, &Extra { null: Some((err, EXACT, 0, n)), ds0: windows, ..Extra::default() });
}

/// The snapshot scene: a snapshot to 0.5 over 960 frames (20 ms) stamped at 600, and a script fade
/// to 0.75 over 300 frames stamped at 1,000, inside the snapshot's transition; then the snapshot's
/// low-pass closes to 800 Hz over 960 frames and opens again, stamped 40 frames into the quanta at
/// 2,560 and 4,608 (`stamped_lp`) or sent asap there (the twin). Returns the scene and where the
/// low-pass part starts.
fn snapshot_scene(stamped_lp: bool) -> (Scene, usize) {
    let mut s = Scene::new();
    s.send(&[config(&[ROOT, 0]), dc_at(V1, 1, 0.5)]);
    s.run(4);
    s.send(&[stamped(1, SNAPSHOT, 0.5, 960, 88), stamped(1, RUNTIME, 0.75, 300, 488)]);
    s.run(16);
    let gain_end = s.left.len();
    let offset = if stamped_lp { 40 } else { wire::ASAP };
    s.send(&[Rec::Ramps(vec![wire::BusRamp { frame_offset: offset, ..lane_ramp(1, SNAPSHOT, None, Some(800.0), 960) }])]);
    s.run(16);
    s.send(&[Rec::Ramps(vec![wire::BusRamp { frame_offset: offset, ..lane_ramp(1, SNAPSHOT, None, Some(OFF), 960) }])]);
    s.run(16);
    (s, gain_end)
}

#[test]
fn stamped_snapshot_multiplies_with_an_overlapping_fade_and_matches_the_reference() {
    let name = "stamped-snapshot";
    let (s, gain_end) = snapshot_scene(true);
    assert_eq!(gain_end, 2560);
    let n = s.left.len();
    let snap = lane_reference(1.0, &[(600, 0.5, 960)], gain_end);
    let fade = lane_reference(1.0, &[(1000, 0.75, 300)], gain_end);
    // The core multiplies the runtime lane first, then the snapshot lane; the voice's 0.5 is exact.
    let want: Vec<f32> = snap.iter().zip(&fade).map(|(a, b)| 0.5 * (b * a)).collect();
    let snap_line = lane_line(1.0, &[(600, 0.5, 960)], gain_end);
    let fade_line = lane_line(1.0, &[(1000, 0.75, 300)], gain_end);
    let line: Vec<f64> = snap_line.iter().zip(&fade_line).map(|(a, b)| 0.5 * a * b).collect();
    assert!(s.left[..600].iter().all(|&x| x == 0.5) && s.left[600] < 0.5, "the snapshot starts on its stamped frame");
    let err = null(&s, name, 0, gain_end, &want, &line, 1e-5);
    assert_eq!(s.split_quanta(), 0);
    assert_eq!(s.early(), 0);
    // DS0: the gain transition, at its ideal step.
    let windows = vec![(512, gain_end, bound(max_step(&want)))];
    ds0(&s, name, &windows);
    // The snapshot low-pass engaging from off steps far over that on this DC signal (a transient
    // when the filter comes in: M2's bus low-pass, not the stamp's doing). The stamp adds nothing:
    // the stamped low-pass steps no more than the same records sent asap.
    let (twin, _) = snapshot_scene(false);
    let stamped_lp = max_step(&s.left[gain_end..n]).max(max_step(&s.right[gain_end..n]));
    let asap_lp = max_step(&twin.left[gain_end..n]).max(max_step(&twin.right[gain_end..n]));
    eprintln!("{name}: the low-pass part steps {stamped_lp:e} stamped, {asap_lp:e} asap");
    assert!(stamped_lp <= asap_lp * 1.01 + 1e-6, "the stamped low-pass steps {stamped_lp}, the asap one {asap_lp}");
    write_or_check(TEST, name, "G1: a snapshot transition (snapshot lane, stamped at 600) with a stamped script fade inside it (runtime lane, 1000), the lanes multiplied per sample; then the snapshot low-pass closes and opens (stamped at 2600 and 4648)", &s, &Extra { null: Some((err, EXACT, 0, gain_end)), ds0: windows, ..Extra::default() });
}

#[test]
fn a_stamped_bus_slot_applies_at_the_start_of_the_quantum_holding_its_frame() {
    let name = "stamped-slot";
    let mut s = Scene::new();
    // Bus 2 at 0.5 (runtime lane, settled); the voice on bus 1, a root's child.
    s.send(&[config(&[ROOT, 0, 0]), asap(2, RUNTIME, 0.5, 0), dc_at(V1, 1, 0.5)]);
    s.run(4);
    // Re-parent bus 1 under bus 2, stamped at 712: it applies at 640, the start of its quantum.
    s.send(&[slot(1, 0, 0, 2, &[], 200)]);
    assert_eq!(bus::slots(&s.m.core)[1].parent, 0, "stamped: it waits");
    s.run(1);
    assert_eq!(bus::slots(&s.m.core)[1].parent, 0, "not in the quantum before its own");
    s.run(3);
    assert_eq!(bus::slots(&s.m.core)[1].parent, 2);
    let n = s.left.len();
    let want = |i: usize| if i < 640 { 0.5 } else { 0.25 };
    let err = max_error(&s, 0, n, want);
    eprintln!("{name}: max error {err:e}");
    assert_eq!(err, 0.0, "0.5 to 640, then 0.25 exactly");
    assert_eq!(s.split_quanta(), 0);
    assert_eq!(s.late(), (0, 0));
    write_or_check(TEST, name, "G1: a BUS_SLOT re-parent stamped at 712 applies at 640, the first frame of the quantum holding its frame, and not before", &s, &Extra { null: Some((err, 0.0, 0, n)), ..Extra::default() });
}

#[test]
fn a_tombstone_is_a_silent_root_that_keeps_its_index() {
    let name = "tombstone";
    let mut s = Scene::new();
    // Bus 1 (a low-pass) and bus 2 under bus 0; a DC voice on each.
    s.send(&[config_fx(&[(ROOT, vec![]), (0, vec![(kind::LOWPASS, 1_000.0, 0.7)]), (0, vec![])]), dc_at(V1, 1, 0.25), dc_at(V2, 2, 0.25)]);
    s.run(8);
    // Remove bus 1: sequence 5, dip-down from 1,124 over 256 (to 1,380), the tombstone at 1,408
    // (the first quantum start after the dip). Main holds the dip at 0 (no dip-up for a removal).
    assert_eq!(s.frame(), 1024);
    s.send(&[dip(1, 0.0, 256, 5, 100), slot(1, wire::BUS_SLOT_FLAGS_STRUCTURAL, 5, ROOT, &[], 384)]);
    s.run(16);
    assert_eq!(bus::count(&s.m.core), 3, "the index is kept");
    let slots = bus::slots(&s.m.core);
    assert_eq!((slots[1].parent, slots[1].fx.count, slots[2].parent), (ROOT, 0, 0), "a silent root with no effects; bus 2 untouched");
    // Bus 2 is still addressed by its index: a stamped fade to 2 over 200 frames from 3,122.
    assert_eq!(s.frame(), 3072);
    s.send(&[stamped(2, RUNTIME, 2.0, 200, 50)]);
    s.run(8);
    let n = s.left.len();
    let lane2 = lane_reference(1.0, &[(3122, 2.0, 200)], n);
    // From the dip's end the removed bus adds exactly nothing: the output is bus 2's alone.
    let err = max_error(&s, 1380, n, |i| 0.25 * lane2[i] as f64);
    eprintln!("{name}: max error after the dip {err:e}");
    assert_eq!(err, 0.0, "bus 1 silent from the dip's end, through the tombstone");
    assert!(s.left[1100] > 0.45, "both buses heard before the dip");
    assert_eq!(s.split_quanta(), 0);
    assert_eq!(s.late(), (0, 0));
    write_or_check(TEST, name, "G1: bus 1 removed (sequence 5: dip-down at 1124, tombstone BUS_SLOT at 1408): a silent root that keeps index 1; bus 2 still fades by its index (3122)", &s, &Extra { null: Some((err, 0.0, 1380, n)), ..Extra::default() });
}

#[test]
fn a_late_sequence_is_shifted_whole_and_counted_once() {
    let name = "late-sequence";
    let mut s = Scene::new();
    // Bus 2 at 0.5 (runtime, settled), the voice on bus 1; both under bus 0.
    s.send(&[config(&[ROOT, 0, 0]), asap(2, RUNTIME, 0.5, 0), dc_at(V1, 1, 0.5)]);
    s.run(8);
    // Sequence 9 (re-parent bus 1 under bus 2) planned at F0 = 700: dip-down over 256, the slot and
    // the dip-up at 1,024 (the first quantum start at or after 956). It arrives at 1,024, 324
    // frames late: s = ⌈324 / 128⌉ × 128 = 384, so dip-down 1,084, slot and dip-up 1,408.
    assert_eq!(s.frame(), 1024);
    s.send_at(700, &[dip(1, 0.0, 256, 9, 0), slot(1, wire::BUS_SLOT_FLAGS_STRUCTURAL, 9, 2, &[], 324), dip(1, 1.0, 256, 9, 324)]);
    s.run(8);
    assert_eq!(bus::slots(&s.m.core)[1].parent, 2);
    let n = s.left.len();
    let dip_lane = lane_reference(1.0, &[(1084, 0.0, 256), (1408, 1.0, 256)], n);
    let dip_line = lane_line(1.0, &[(1084, 0.0, 256), (1408, 1.0, 256)], n);
    let want: Vec<f32> = (0..n).map(|i| 0.5 * dip_lane[i] * if i < 1408 { 1.0 } else { 0.5 }).collect();
    let line: Vec<f64> = (0..n).map(|i| 0.5 * dip_line[i] * if i < 1408 { 1.0 } else { 0.5 }).collect();
    assert!(s.left[..1084].iter().all(|&x| x == 0.5), "the dip starts on its shifted frame");
    let err = null(&s, name, 0, n, &want, &line, 1e-6);
    assert_eq!(s.late(), (1, 384), "counted once; the shift is 384");
    assert_eq!(s.split_quanta(), 0);
    write_or_check(TEST, name, "G1: a structural sequence planned at 700 (dip-down, BUS_SLOT re-parent and dip-up at 1024) arriving at 1024 is shifted whole by 384 (lateCommands once)", &s, &Extra { null: Some((err, EXACT, 0, n)), late: true, ..Extra::default() });
}

/// A bus with reverb sends `sends` (in its chain, in order), a DC voice, then its runtime lane
/// to 0.5 over 480 frames (the scratch scaled by a moving gain).
fn sends_scene(sends: &[f32]) -> Scene {
    let mut s = Scene::new();
    let fx: Vec<(u32, f32, f32)> = sends.iter().map(|&x| (kind::REVERB_SEND, x, 0.0)).collect();
    s.send(&[config_fx(&[(ROOT, vec![]), (0, fx)]), master(0.5, false, 0), dc_at(V1, 1, 0.5)]);
    s.run(40);
    s.send(&[asap(1, RUNTIME, 0.5, 480)]);
    s.run(40);
    s
}

#[test]
fn two_reverb_sends_on_one_bus_sum_in_the_scratch() {
    let name = "two-sends";
    let s = sends_scene(&[0.3, 0.45]);
    assert!(s.left.iter().chain(&s.right).all(|x| x.is_finite()));
    let dry = sends_scene(&[]);
    let wet = s.left.iter().zip(&dry.left).fold(0.0f32, |m, (a, b)| m.max((a - b).abs()));
    assert!(wet > 1e-3, "the sends reach the reverb ({wet})");
    // Exact halves: 0.5 x + 0.25 x is 0.75 x rounded once, as one send of 0.75 is.
    let (a, b) = (sends_scene(&[0.5, 0.25]), sends_scene(&[0.75]));
    assert!(a.left == b.left && a.right == b.right, "two sends summed in the scratch equal their sum as one send, bit for bit");
    assert_eq!(s.split_quanta(), 0);
    write_or_check(TEST, name, "G1, build log D2: one bus with two reverb sends (0.3, 0.45) summed in the post-fader scratch, its runtime lane then ramped to 0.5", &s, &Extra::default());
}
