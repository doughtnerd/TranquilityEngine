//! Rv1 (0171/0172 M5, ADR 0172 owner decision 1; architecture §4.5 "Post-fader sends", §3.3 and
//! §4.7 "Last reverb send removed"; R11): the bus reverb send is post-fader, and the shared
//! convolver runs out after the last send is removed, then resets.
//!
//! - **Post-fader** (`sends::feed`): a bus's reverb contribution (the 1 KB scratch `fx.process`
//!   writes) is multiplied by the bus's gain for the quantum (`lanes::apply`'s `Gain`: all seven
//!   lanes) before it joins the convolver input. A muted, dipped, monitor-muted, faded or ducked
//!   bus stops feeding (or feeds scaled); a settled gain of 1 (`Gain::Unity`) skips the multiply,
//!   bit-identical with the pre-fader send.
//! - **The run-out** (`sends::convolver_should_run`, `sends::run_out_quanta`): with no send left
//!   the convolver keeps running on silent input until that input has been silent for more than
//!   the IR's length in quanta plus `zones::IDLE_MARGIN_QUANTA`, then resets (histories cleared,
//!   clock restarted) and stops; a later send replays nothing stale.
//!
//! Leaf L-Rv1a fills the cases below. The golden (`golden/m5/bus-mute-send.json`) and the click
//! check are the lead's, in `sends_post_fader_golden.rs`.

mod common;

use audio_core::fx::kind;
use audio_core::lanes::Gain;
use audio_core::{sends, zones, QUANTUM};
use audio_wire::generated as wire;
use common::*;

/// A zeroed send area (all-zero is valid: an empty scratch, no tail to ring out).
fn send_area() -> Box<sends::SendArea> {
    // SAFETY: all-zero is a valid SendArea.
    Box::new(unsafe { core::mem::zeroed() })
}

const V1: u32 = 0x0001_0001;

fn bits(v: &[f32]) -> Vec<u32> {
    v.iter().map(|x| x.to_bits()).collect()
}

/// A scratch pattern with awkward values: a NaN with a payload, -0.0, tiny and large values.
fn scratch(seed: f32) -> Vec<f32> {
    let mut x: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.37 + seed).sin() * 0.3).collect();
    x[3] = f32::from_bits(0x7FC0_1234);
    x[5] = -0.0;
    x[9] = 1e-30;
    x[11] = 1e4;
    x
}

/// A convolver input pattern (with -0.0 and a NaN payload too).
fn input(seed: f32) -> Vec<f32> {
    let mut y: Vec<f32> = (0..QUANTUM).map(|i| (i as f32 * 0.11 + seed).cos() * 0.2).collect();
    y[5] = -0.0;
    y[7] = f32::from_bits(0x7FC0_00AB);
    y
}

/// An area whose scratch holds `xl`, `xr`.
fn loaded(xl: &[f32], xr: &[f32]) -> Box<sends::SendArea> {
    let mut a = send_area();
    a.l.copy_from_slice(xl);
    a.r.copy_from_slice(xr);
    a
}

fn cleared(a: &sends::SendArea) -> bool {
    a.l.iter().chain(&a.r).all(|s| s.to_bits() == 0)
}

// --- `feed`, unit level ------------------------------------------------------------------------

/// L-Rv1a: `Gain::Unity` adds the scratch into the convolver input bit for bit as `rev + x`
/// (no multiply; NaN payloads and -0.0 kept), and clears the scratch.
#[test]
fn a_settled_unity_gain_is_bit_identical_with_the_pre_fader_send() {
    let (xl, xr) = (scratch(0.0), scratch(1.0));
    let (yl, yr) = (input(0.0), input(2.0));
    let mut area = loaded(&xl, &xr);
    let (mut rl, mut rr) = (yl.clone(), yr.clone());
    // The curve is ignored on Unity: a poison value shows a multiply.
    sends::feed(&mut area, Gain::Unity, &[7.0; QUANTUM], &mut rl, &mut rr);
    let want_l: Vec<f32> = yl.iter().zip(&xl).map(|(y, x)| y + x).collect();
    let want_r: Vec<f32> = yr.iter().zip(&xr).map(|(y, x)| y + x).collect();
    assert_eq!(bits(&rl), bits(&want_l), "left is rev + x");
    assert_eq!(bits(&rr), bits(&want_r), "right is rev + x");
    assert!(cleared(&area), "the scratch is cleared");
}

/// L-Rv1a: `Gain::Scalar(g)` adds `x·g` (exactly the f32 product), `Gain::Scalar(0.0)` adds
/// nothing (the input is unchanged bit for bit), and both clear the scratch.
#[test]
fn a_scalar_gain_scales_the_send_and_zero_adds_nothing() {
    let (xl, xr) = (scratch(0.5), scratch(1.5));
    let (yl, yr) = (input(0.3), input(1.3));
    for g in [0.5f32, 0.3, 2.0, -0.7] {
        let mut area = loaded(&xl, &xr);
        let (mut rl, mut rr) = (yl.clone(), yr.clone());
        sends::feed(&mut area, Gain::Scalar(g), &[7.0; QUANTUM], &mut rl, &mut rr);
        let want_l: Vec<f32> = yl.iter().zip(&xl).map(|(y, x)| y + x * g).collect();
        let want_r: Vec<f32> = yr.iter().zip(&xr).map(|(y, x)| y + x * g).collect();
        assert_eq!(bits(&rl), bits(&want_l), "Scalar({g}): left is rev + x·g");
        assert_eq!(bits(&rr), bits(&want_r), "Scalar({g}): right is rev + x·g");
        assert!(cleared(&area), "Scalar({g}): the scratch is cleared");
    }
    let mut area = loaded(&xl, &xr);
    let (mut rl, mut rr) = (yl.clone(), yr.clone());
    sends::feed(&mut area, Gain::Scalar(0.0), &[7.0; QUANTUM], &mut rl, &mut rr);
    assert_eq!((bits(&rl), bits(&rr)), (bits(&yl), bits(&yr)), "a zero gain adds nothing, bit for bit");
    assert!(cleared(&area), "Scalar(0): the scratch is cleared");
}

/// L-Rv1a: `Gain::Curve` adds `x[i]·curve[i]` frame by frame (left and right alike), and clears
/// the scratch.
#[test]
fn a_curve_gain_scales_the_send_frame_by_frame() {
    let (xl, xr) = (scratch(0.7), scratch(2.7));
    let (yl, yr) = (input(0.9), input(1.9));
    let mut curve = [0.0f32; QUANTUM];
    for (i, c) in curve.iter_mut().enumerate() {
        *c = i as f32 / (QUANTUM - 1) as f32;
    }
    curve[17] = 0.0;
    let mut area = loaded(&xl, &xr);
    let (mut rl, mut rr) = (yl.clone(), yr.clone());
    sends::feed(&mut area, Gain::Curve, &curve, &mut rl, &mut rr);
    let want_l: Vec<f32> = (0..QUANTUM).map(|i| yl[i] + xl[i] * curve[i]).collect();
    let want_r: Vec<f32> = (0..QUANTUM).map(|i| yr[i] + xr[i] * curve[i]).collect();
    assert_eq!(bits(&rl), bits(&want_l), "left is rev[i] + x[i]·curve[i]");
    assert_eq!(bits(&rr), bits(&want_r), "right is rev[i] + x[i]·curve[i]");
    assert!(cleared(&area), "the scratch is cleared");
}

// --- Post-fader through the core ---------------------------------------------------------------
// A bus with a reverb send (`fx::kind::REVERB_SEND`) and a voice on it: with the bus's gain at 0
// its dry path is silent, so the output is the reverb's wet signal alone.

/// BUS_CONFIG of bus 0 (under the root) with a full reverb send, or with none.
fn bus_config(send: bool) -> Rec {
    config_fx(&[(ROOT, if send { vec![(kind::REVERB_SEND, 1.0, 0.0)] } else { vec![] })])
}

/// A looping DC voice on bus 0 at a gain low enough that the master limiter stays out of it.
fn quiet_dc(voice: u32, gain: f32) -> Rec {
    let Rec::Play(mut p) = dc(voice, 0, 0.0) else { unreachable!() };
    p.gain = gain;
    Rec::Play(p)
}

/// One bus 0 setting its `lane` to `gain` at once.
fn lane_to(lane: u32, gain: f32) -> Rec {
    Rec::Ramps(vec![lane_ramp(0, lane, Some(gain), None, 0)])
}

/// A scene: bus 0 with (or without) the send, its `lane` settled at `gain` before the voice starts,
/// then `quanta` rendered. Returns the output, left and right.
fn scene(send: bool, lane: u32, gain: f32, quanta: usize) -> (Vec<f32>, Vec<f32>) {
    let mut m = Mixer::new(2);
    m.submit(&[bus_config(send), lane_to(lane, gain)]);
    m.render();
    m.submit(&[quiet_dc(V1, 0.25)]);
    m.render_n(quanta)
}

fn peak(v: &[f32]) -> f32 {
    v.iter().fold(0.0, |a, x| a.max(x.abs()))
}

/// The wet signal alone: the scene with the send, minus the same scene without it.
fn wet(lane: u32, gain: f32, quanta: usize) -> (Vec<f32>, Vec<f32>) {
    let (wl, wr) = scene(true, lane, gain, quanta);
    let (dl, dr) = scene(false, lane, gain, quanta);
    (wl.iter().zip(&dl).map(|(a, b)| a - b).collect(), wr.iter().zip(&dr).map(|(a, b)| a - b).collect())
}

/// Quanta rendered by the post-fader scenes: far beyond the IR's head (the first partitions).
const SCENE_QUANTA: usize = 40;

/// L-Rv1a: a bus muted on its `runtime` lane (settled at 0 before the voice starts) never feeds
/// the reverb: the output is exactly 0 for many quanta (more than the IR's head). **Fails before
/// Rv1** (the pre-fader send fed the reverb whatever the gain): say so in the report.
#[test]
fn a_muted_bus_stops_feeding_the_reverb() {
    // Control: unmuted, the same scene is audible and its wet signal is not silent.
    let (cl, _) = wet(wire::LANE_RUNTIME, 1.0, SCENE_QUANTA);
    assert!(peak(&cl) > 1e-4, "the scene's reverb is audible at gain 1 (peak {})", peak(&cl));
    let (l, r) = scene(true, wire::LANE_RUNTIME, 0.0, SCENE_QUANTA);
    assert!(l.iter().chain(&r).all(|x| *x == 0.0), "a muted bus: no dry, no wet (peak {})", peak(&l).max(peak(&r)));
}

/// L-Rv1a: the same with the `dip` lane at 0 (the structural dip), and with the `monitor` lane at
/// 0 (a monitor mute), and with the `authored` lane at 0: no wet output.
#[test]
fn a_dipped_or_monitor_muted_bus_stops_feeding_the_reverb() {
    for (name, lane) in [("dip", wire::LANE_DIP), ("monitor", wire::LANE_MONITOR), ("authored", wire::LANE_AUTHORED)] {
        let (l, r) = scene(true, lane, 0.0, SCENE_QUANTA);
        assert!(l.iter().chain(&r).all(|x| *x == 0.0), "{name} lane at 0: no output (peak {})", peak(&l).max(peak(&r)));
    }
}

/// L-Rv1a: a bus faded to 0.5 (`runtime` lane, settled) feeds the reverb at half: its wet output
/// (the dry path removed, e.g. a second core whose bus has no send, subtracted) is 0.5 × the wet
/// output of the same scene at gain 1, to f32 rounding (the convolver is linear).
#[test]
fn a_faded_bus_feeds_the_reverb_scaled_by_its_gain() {
    let (full_l, full_r) = wet(wire::LANE_RUNTIME, 1.0, SCENE_QUANTA);
    let (half_l, half_r) = wet(wire::LANE_RUNTIME, 0.5, SCENE_QUANTA);
    assert!(peak(&full_l) > 1e-4 && peak(&full_r) > 1e-4, "the reverb is audible at gain 1");
    for (ch, full, half) in [("left", &full_l, &half_l), ("right", &full_r, &half_r)] {
        check(half, 1e-6, ch, |i| 0.5 * full[i]);
    }
}

// --- The run-out -------------------------------------------------------------------------------

/// L-Rv1a: `run_out_quanta` of the core's `Reverb` region is ceil(IR frames / 128) +
/// `zones::IDLE_MARGIN_QUANTA` (the IR is `audio_dsp::convolver::ir::frames(rate)` frames), and 0
/// for a region with no prepared response.
#[test]
fn the_run_out_lasts_the_ir_length_plus_the_idle_margin() {
    let m = Mixer::new(2);
    let frames = audio_dsp::convolver::ir::frames(RATE);
    assert!(frames > 0);
    let want = frames.div_ceil(QUANTUM) as u32 + zones::IDLE_MARGIN_QUANTA;
    assert_eq!(sends::run_out_quanta(&m.core.regions().reverb[..]), want);
    assert_eq!(sends::run_out_quanta(&[0u8; 64]), 0, "no prepared response");
    assert_eq!(sends::run_out_quanta(&[]), 0, "no region");
}

/// L-Rv1a: `convolver_should_run` on a zeroed area and a real reverb region: false while no send
/// ever existed; true while `has_reverb` or `sent`; after both go false, true for exactly
/// `run_out_quanta` more calls, then false (and `head.live` 0) from the next one on.
#[test]
fn the_convolver_runs_out_then_stops() {
    let mut m = Mixer::new(2);
    let reverb = &mut m.core.regions_mut().reverb[..];
    let n = sends::run_out_quanta(reverb);
    assert!(n > 0);
    let mut area = send_area();
    for _ in 0..5 {
        assert!(!sends::convolver_should_run(&mut area, reverb, false, false), "no send ever existed");
    }
    assert_eq!(area.head.live, 0);
    assert!(sends::convolver_should_run(&mut area, reverb, true, false), "has_reverb");
    assert!(sends::convolver_should_run(&mut area, reverb, false, true), "sent");
    assert!(sends::convolver_should_run(&mut area, reverb, true, true), "both");
    assert_eq!(area.head.live, 1);
    for k in 0..n {
        assert!(sends::convolver_should_run(&mut area, reverb, false, false), "run-out call {} of {n}", k + 1);
        assert_eq!(area.head.live, 1, "still live in call {}", k + 1);
    }
    for k in 0..5 {
        assert!(!sends::convolver_should_run(&mut area, reverb, false, false), "stopped, call {k} after the run-out");
        assert_eq!(area.head.live, 0);
    }
    // A send after the run-out starts it again, and the next run-out is as long.
    assert!(sends::convolver_should_run(&mut area, reverb, true, false));
    for _ in 0..n {
        assert!(sends::convolver_should_run(&mut area, reverb, false, false));
    }
    assert!(!sends::convolver_should_run(&mut area, reverb, false, false));
}

/// Quanta of the run-out of a default core's convolver, plus a few.
fn run_out_of(m: &Mixer) -> usize {
    sends::run_out_quanta(&m.core.regions().reverb[..]) as usize
}

/// Per quantum, the largest difference between two outputs (left and right).
fn diffs(a: &(Vec<f32>, Vec<f32>), b: &(Vec<f32>, Vec<f32>)) -> Vec<f32> {
    (0..a.0.len() / QUANTUM)
        .map(|q| {
            let s = q * QUANTUM..(q + 1) * QUANTUM;
            peak(&a.0[s.clone()].iter().zip(&b.0[s.clone()]).map(|(x, y)| x - y).collect::<Vec<_>>()).max(peak(&a.1[s.clone()].iter().zip(&b.1[s]).map(|(x, y)| x - y).collect::<Vec<_>>()))
        })
        .collect()
}

/// L-Rv1a: through the core, a bus with a send and a voice; BUS_CONFIG then removes the send (the
/// voice keeps playing dry): the wet tail goes on after the removal (the output differs from the
/// dry-only level for quanta after it, decaying), then is exactly the dry level once the run-out
/// ends. **Fails before Rv1** (the convolver stopped at once, cutting the tail).
#[test]
fn removing_the_last_send_rings_the_tail_out() {
    let mut with = Mixer::new(2);
    let mut dry = Mixer::new(2);
    with.submit(&[bus_config(true), quiet_dc(V1, 0.25)]);
    dry.submit(&[bus_config(false), quiet_dc(V1, 0.25)]);
    let before = 20;
    with.render_n(before);
    dry.render_n(before);
    with.submit(&[bus_config(false)]);
    let run_out = run_out_of(&with);
    let after = run_out + 8;
    let a = with.render_n(after);
    let b = dry.render_n(after);
    let d = diffs(&a, &b);
    let early = d[..8].iter().fold(0.0f32, |m, x| m.max(*x));
    let late = d[run_out / 2..run_out / 2 + 8].iter().fold(0.0f32, |m, x| m.max(*x));
    assert!(d[..8].iter().all(|x| *x > 1e-6), "the tail goes on after the removal: {:?}", &d[..8]);
    assert!(late < early, "and decays ({late} < {early})");
    // The IR's samples are exact zeros past its end, so the tail is over by the end of the run-out
    // proper (the IR's quanta plus the limiter's look-ahead frames).
    let ir_quanta = audio_dsp::convolver::ir::frames(RATE).div_ceil(QUANTUM);
    assert!(d[ir_quanta + 2..].iter().all(|x| *x == 0.0), "exactly the dry level once the tail is out: {:?}", &d[ir_quanta + 2..]);
    // And well after the run-out ended, the output is the dry level, bit for bit.
    let (tl, tr) = with.render_n(8);
    let (dl, dr) = dry.render_n(8);
    assert_eq!((bits(&tl), bits(&tr)), (bits(&dl), bits(&dr)));
}

/// L-Rv1a: after the run-out ended, a later send (the send re-added by BUS_CONFIG) gives exactly
/// the output of a fresh core given the same send and voice from that point: nothing stale is
/// replayed. **Fails before Rv1** (the frozen tail replayed).
#[test]
fn a_later_send_replays_nothing_stale() {
    let mut old = Mixer::new(2);
    old.submit(&[bus_config(true), quiet_dc(V1, 0.25)]);
    old.render_n(20);
    old.submit(&[bus_config(false)]);
    let run_out = run_out_of(&old);
    // Past the run-out (the convolver has been reset), then the send comes back.
    old.render_n(run_out + 8);
    old.submit(&[bus_config(true)]);
    let a = old.render_n(40);
    // A fresh core: the same voice playing dry, the send added at the same point.
    let mut fresh = Mixer::new(2);
    fresh.submit(&[bus_config(false), quiet_dc(V1, 0.25)]);
    fresh.render_n(4);
    fresh.submit(&[bus_config(true)]);
    let b = fresh.render_n(40);
    assert!(peak(&a.0) > 0.25, "the reverb is audible");
    assert_eq!((bits(&a.0), bits(&a.1)), (bits(&b.0), bits(&b.1)), "nothing stale is replayed");
}

/// L-Rv1a: a send re-added during the run-out (before the reset) continues the tail rather than
/// restarting it: with the voice stopped before the removal, the output equals that of a core
/// whose send was never removed (its bus silent, so the convolver input is zero either way), bit
/// for bit (no reset mid-tail).
#[test]
fn a_send_during_the_run_out_keeps_the_tail() {
    // A one-shot burst (the DC clip's 64 frames, not looping): the voice is over before the removal.
    let burst = || {
        let Rec::Play(mut p) = play(V1, DC, 0, MIXED) else { unreachable!() };
        p.gain = 0.25;
        Rec::Play(p)
    };
    let mut kept = Mixer::new(2);
    let mut cut = Mixer::new(2);
    kept.submit(&[bus_config(true), burst()]);
    cut.submit(&[bus_config(true), burst()]);
    let (mut a, mut b) = ((Vec::new(), Vec::new()), (Vec::new(), Vec::new()));
    let push =|o: &mut (Vec<f32>, Vec<f32>), x: (Vec<f32>, Vec<f32>)| {
        o.0.extend(x.0);
        o.1.extend(x.1);
    };
    push(&mut a, kept.render_n(10));
    push(&mut b, cut.render_n(10));
    cut.submit(&[bus_config(false)]);
    push(&mut a, kept.render_n(20));
    push(&mut b, cut.render_n(20));
    cut.submit(&[bus_config(true)]);
    push(&mut a, kept.render_n(20));
    push(&mut b, cut.render_n(20));
    assert!(peak(&a.0) > 1e-4, "there is a tail to keep (peak {})", peak(&a.0));
    assert_eq!((bits(&a.0), bits(&a.1)), (bits(&b.0), bits(&b.1)), "no reset mid-tail");
}
