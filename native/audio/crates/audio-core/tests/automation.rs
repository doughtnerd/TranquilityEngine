//! ADR 0158 E2: parameters, curves, voice and bus automation, and SET_LOOP, through
//! `scheduler::submit` and `Core::process` (limiter look-ahead 0, so heard frames are core frames).
//!
//! - PARAM moves a parameter toward its target by `seek × 128 / rate` per quantum (no overshoot);
//!   seek 0 jumps; out-of-range groups and slots are ignored.
//! - A voice's volume binding multiplies its gain by the curve at the parameter's value, ramped
//!   linearly across each quantum; the first quantum after AUTOMATE starts at its value.
//! - Local bindings read the voice's PLAY `group`; a voice in group 0 reads 0.
//! - Pitch bindings scale the read rate; lowpass bindings filter the voice at `min(lpHz, lpAuto)`.
//! - Bus bindings scale the bus after its main-written gain lanes (`BUS_RAMP`; BUS_MIX before
//!   0171/0172 M5) and lower its snapshot low-pass.
//! - SET_LOOP loops a clip region gaplessly; a release plays on to the clip's end and ends the voice.
//! - RESET clears every table; a voice that ends leaves the active list.

mod common;

use audio_core::automation;
use audio_core::voices::{self, state};
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const TOL: f32 = 1e-6;

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

/// CURVES from `first`: each curve a list of `(x, y, interp)`.
fn curves(first: u32, list: &[&[(f32, f32, u32)]]) -> Rec {
    let c = wire::Curves {
        voice_id: 0,
        frame_offset: wire::ASAP,
        first_curve: first,
        curves: list
            .iter()
            .map(|keys| wire::CurvesCurves { reserved: 0, keys: keys.iter().map(|&(x, y, interp)| wire::CurvesCurvesKeys { x, y, interp, in_dx: 0.0, in_dy: 0.0, out_dx: 0.0, out_dy: 0.0 }).collect() })
            .collect(),
    };
    raw(move |b| c.write(b, 0))
}

/// CURVES of one curve at `first` from `(x, y, interp, [inDx, inDy, outDx, outDy])` keys (ADR 0332).
fn bezier_curve(first: u32, keys: &[(f32, f32, u32, [f32; 4])]) -> Rec {
    let c = wire::Curves {
        voice_id: 0,
        frame_offset: wire::ASAP,
        first_curve: first,
        curves: vec![wire::CurvesCurves {
            reserved: 0,
            keys: keys.iter().map(|&(x, y, interp, h)| wire::CurvesCurvesKeys { x, y, interp, in_dx: h[0], in_dy: h[1], out_dx: h[2], out_dy: h[3] }).collect(),
        }],
    };
    raw(move |b| c.write(b, 0))
}

fn param(group: u16, slot: u16, value: f32, seek: f32) -> Rec {
    let p = wire::Param { voice_id: 0, frame_offset: wire::ASAP, group, slot, value, seek_per_second: seek };
    raw(move |b| p.write(b, 0))
}

/// AUTOMATE `voice` with `(param, curve, target)` bindings.
fn automate(voice: u32, bindings: &[(u16, u16, u32)]) -> Rec {
    let a = wire::Automate {
        voice_id: voice,
        frame_offset: wire::ASAP,
        bindings: bindings.iter().map(|&(param, curve, target)| wire::AutomateBindings { param, curve, target, offset: 0.0 }).collect(),
    };
    raw(move |b| a.write(b, 0))
}

fn bus_automate(bus: u32, bindings: &[(u16, u16, u32)]) -> Rec {
    let a = wire::BusAutomate {
        voice_id: bus,
        frame_offset: wire::ASAP,
        bindings: bindings.iter().map(|&(param, curve, target)| wire::BusAutomateBindings { param, curve, target }).collect(),
    };
    raw(move |b| a.write(b, 0))
}

fn set_loop(voice: u32, frame_offset: u32, start: u32, end: u32, looping: bool) -> Rec {
    let l = wire::SetLoop { voice_id: voice, frame_offset, loop_start_frame: start, loop_end_frame: end, flags: looping as u32 };
    raw(move |b| l.write(b, 0))
}

const G: u16 = 0x8000;
/// The identity curve over 0..1.
const IDENTITY: &[(f32, f32, u32)] = &[(0.0, 0.0, 0), (1.0, 1.0, 0)];

fn ramp(a: f32, b: f32, j: usize) -> f32 {
    automation::ramp_at(a, b, j)
}

#[test]
fn a_volume_binding_follows_a_seeking_parameter_ramped_per_quantum() {
    let mut m = mixer();
    // 187.5 units/s at 48 kHz: 0.5 per quantum.
    m.submit(&[curves(0, &[IDENTITY]), param(0, 0, 0.0, 0.0), dc(V1, 0, 0.0), automate(V1, &[(G, 0, 0)])]);
    let (l, r) = m.render();
    check(&l, TOL, "silent at 0", |_| 0.0);
    check(&r, TOL, "silent at 0", |_| 0.0);
    m.submit(&[param(0, 0, 1.0, 187.5)]);
    let (l, _) = m.render();
    check(&l, TOL, "0 to 0.5", |j| ramp(0.0, 0.5, j));
    assert_eq!(automation::param_value(&mut m.core, 0, 0), Some(0.5));
    let (l, _) = m.render();
    check(&l, TOL, "0.5 to 1", |j| ramp(0.5, 1.0, j));
    let (l, _) = m.render();
    check(&l, TOL, "settled at 1", |_| 1.0);
    // Back down to 0.25: 0.5 per quantum, no overshoot past the target.
    m.submit(&[param(0, 0, 0.25, 187.5)]);
    let (l, _) = m.render();
    check(&l, TOL, "1 to 0.5", |j| ramp(1.0, 0.5, j));
    let (l, _) = m.render();
    check(&l, TOL, "0.5 to 0.25", |j| ramp(0.5, 0.25, j));
    assert_eq!(automation::param_value(&mut m.core, 0, 0), Some(0.25));
    // A jump (seek 0) ramps across one quantum, from the last value to the new one.
    m.submit(&[param(0, 0, 1.0, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "jump", |j| ramp(0.25, 1.0, j));
}

#[test]
fn the_first_quantum_after_automate_starts_at_its_value() {
    let mut m = mixer();
    m.submit(&[curves(3, &[IDENTITY]), param(0, 5, 0.5, 0.0), dc(V1, 0, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "unbound", |_| 1.0);
    m.submit(&[automate(V1, &[(G | 5, 3, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "bound: 0.5 at once", |_| 0.5);
    // Clearing the bindings (count 0) puts the voice back at its own gain.
    m.submit(&[automate(V1, &[])]);
    let (l, _) = m.render();
    check(&l, TOL, "cleared", |_| 1.0);
}

#[test]
fn local_bindings_read_the_voice_group() {
    let mut m = mixer();
    let Rec::Play(mut p1) = dc(V1, 0, 0.0) else { unreachable!() };
    p1.group = 3;
    let Rec::Play(p2) = dc(V2, 1, 0.0) else { unreachable!() };
    m.submit(&[common::config(&[ROOT, ROOT]), curves(0, &[IDENTITY]), param(3, 1, 0.25, 0.0), param(0, 1, 0.75, 0.0)]);
    m.submit(&[Rec::Play(p1), automate(V1, &[(1, 0, 0)]), Rec::Play(p2), automate(V2, &[(1, 0, 0)])]);
    let (l, _) = m.render();
    // Group 3's slot 1 (0.25) for V1; V2 is in group 0, so its local binding reads 0, not global slot 1.
    check(&l, TOL, "group 3 local", |_| 0.25);
    // Out of range: ignored.
    m.submit(&[param(1025, 0, 1.0, 0.0), param(3, 16, 1.0, 0.0), param(0, 64, 1.0, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "unchanged", |_| 0.25);
}

#[test]
fn several_volume_curves_multiply_and_an_undefined_curve_is_zero() {
    let mut m = mixer();
    m.submit(&[curves(0, &[&[(0.0, 0.5, 0)], &[(0.0, 0.5, 0)]]), dc(V1, 0, 0.0), automate(V1, &[(G, 0, 0), (G, 1, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "0.5 x 0.5", |_| 0.25);
    m.submit(&[automate(V1, &[(G, 999, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "an empty curve is 0", |_| 0.0);
}

#[test]
fn each_binding_is_clamped_before_it_combines() {
    // `events/automation.ts` `evaluate`'s rules (the parity test holds the two together): a negative volume curve is
    // silence for its binding, so two negatives don't make a positive gain; a pitch curve at or below 0 is a factor of 1.
    let mut m = mixer();
    m.submit(&[curves(0, &[&[(0.0, -0.5, 0)], &[(0.0, -0.8, 0)], &[(0.0, 0.5, 0)]]), dc(V1, 0, 0.0), automate(V1, &[(G, 0, 0), (G, 1, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "-0.5 x -0.8 is silence, not 0.4", |_| 0.0);
    m.submit(&[automate(V1, &[(G, 0, 0), (G, 2, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "-0.5 x 0.5 is silence", |_| 0.0);

    let mut m = mixer();
    let clip: Vec<f32> = (0..4096).map(|i| i as f32 / 4096.0).collect();
    m.load_clip(2, &clip);
    m.submit(&[curves(0, &[&[(0.0, 2.0, 0)], &[(0.0, -3.0, 0)], &[(0.0, 0.0, 0)]]), play(V1, 2, 0, MIXED), automate(V1, &[(G, 0, 1), (G, 1, 1), (G, 2, 1)])]);
    let (l, _) = m.render();
    check(&l, 1e-6, "pitch 2 x (-3 ignored) x (0 ignored)", |j| (2 * j) as f32 / 4096.0);
}

#[test]
fn a_pitch_binding_scales_the_read_rate() {
    let mut m = mixer();
    let clip: Vec<f32> = (0..4096).map(|i| i as f32 / 4096.0).collect();
    m.load_clip(2, &clip);
    m.submit(&[curves(0, &[&[(0.0, 2.0, 0)]]), play(V1, 2, 0, MIXED), automate(V1, &[(G, 0, 1)])]);
    let (l, _) = m.render();
    check(&l, 1e-6, "pitch 2", |j| (2 * j) as f32 / 4096.0);
}

#[test]
fn a_lowpass_binding_filters_the_voice_and_off_passes_it() {
    let mut m = mixer();
    // Nyquist: +1, -1, ...
    let clip: Vec<f32> = (0..8192).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
    m.load_clip(2, &clip);
    m.submit(&[curves(0, &[&[(0.0, 500.0, 0)], &[(0.0, 24_000.0, 0)]]), play(V1, 2, 0, MIXED)]);
    m.submit(&[automate(V1, &[(G, 1, 2)])]);
    let (l, _) = m.render();
    check(&l, 0.0, "a cut-off at Nyquist passes the voice exactly", |j| if j % 2 == 0 { 1.0 } else { -1.0 });
    m.submit(&[automate(V1, &[(G, 0, 2)])]);
    m.render_n(4);
    let (l, _) = m.render();
    let peak = l.iter().fold(0.0f32, |a, x| a.max(x.abs()));
    assert!(peak < 0.01, "500 Hz removes Nyquist: peak {peak}");
}

#[test]
fn bus_automation_scales_the_bus_and_lowers_its_lowpass() {
    let mut m = mixer();
    m.submit(&[common::config(&[ROOT, 0]), curves(0, &[IDENTITY]), param(0, 2, 0.5, 0.0), dc(V1, 1, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "unbound", |_| 1.0);
    // A local binding and a pitch binding are ignored on a bus; the volume one applies.
    m.submit(&[bus_automate(1, &[(2, 0, 0), (G | 2, 0, 1), (G | 2, 0, 0)])]);
    assert_eq!(automation::bus_entry(&mut m.core, 1).unwrap().count, 1);
    let (l, _) = m.render();
    check(&l, TOL, "bus at 0.5 at once", |_| 0.5);
    m.submit(&[param(0, 2, 1.0, 187.5)]);
    let (l, _) = m.render();
    check(&l, TOL, "bus ramps", |j| ramp(0.5, 1.0, j));
    m.submit(&[bus_automate(1, &[])]);
    let (l, _) = m.render();
    check(&l, TOL, "cleared", |_| 1.0);
}

#[test]
fn a_loop_region_repeats_and_a_release_plays_on_to_the_end() {
    let mut m = mixer();
    let clip: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0).collect();
    m.load_clip(2, &clip);
    m.submit(&[play(V1, 2, 0, MIXED), set_loop(V1, wire::ASAP, 100, 200, true)]);
    let (l, _) = m.render_n(2);
    // 0..100, then 100..200 repeating.
    check(&l, 1e-6, "intro then loop", |j| if j < 100 { j as f32 / 1000.0 } else { (100 + (j - 100) % 100) as f32 / 1000.0 });
    // A release stamped at frame 300 (the batch's firstFrame is `m.frame`): it ends the pass it is in
    // (clip frame 100 again at frame 300) and plays on through the tail.
    let frame = m.frame;
    m.submit(&[set_loop(V1, (300 - frame) as u32, 0, 0, false)]);
    let (l, _) = m.render_n(6);
    let at = |j: usize| -> f32 {
        let f = frame as usize + j;
        let clip_frame = if f < 300 { 100 + (f - 100) % 100 } else { 100 + (f - 300) };
        if clip_frame >= 1000 {
            0.0
        } else {
            clip_frame as f32 / 1000.0
        }
    };
    check(&l, 1e-6, "released", at);
    // Played to the end (clip frame 999 at frame 1199) and ended.
    m.render_n(2);
    assert_eq!(voices::live_count(&mut m.core), 0, "the released voice ended");
    assert_eq!(automation::active_count(&mut m.core), 0, "and left the active list");
}

#[test]
fn a_whole_clip_loop_released_ends_at_the_clip_end() {
    let mut m = mixer();
    let clip: Vec<f32> = (0..300).map(|i| i as f32 / 300.0).collect();
    m.load_clip(2, &clip);
    m.submit(&[play(V1, 2, 0, MIXED | LOOP)]);
    m.render_n(4); // 512 frames: wrapped once
    m.submit(&[set_loop(V1, wire::ASAP, 0, 0, false)]);
    let (l, _) = m.render();
    check(&l, 1e-6, "plays on", |j| {
        let c = (512 + j) % 300;
        if 512 + j >= 600 {
            0.0
        } else {
            c as f32 / 300.0
        }
    });
    m.render();
    assert_eq!(voices::live_count(&mut m.core), 0);
}

#[test]
fn a_stream_voice_ignores_set_loop() {
    let mut m = mixer();
    m.submit(&[play(V1, 77, 0, MIXED | wire::PLAY_FLAGS_STREAM | LOOP), set_loop(V1, wire::ASAP, 0, 10, true)]);
    let s = voices::slots(&m.core)[1];
    assert_ne!(s.flags & voices::flag::LOOP, 0, "the loop flag stays");
    assert_eq!(automation::active_count(&mut m.core), 0);
}

#[test]
fn reset_clears_every_table_and_an_ended_voice_leaves_the_list() {
    let mut m = mixer();
    m.submit(&[curves(0, &[IDENTITY]), param(0, 0, 0.5, 0.0), dc(V1, 0, 0.0), automate(V1, &[(G, 0, 0)])]);
    m.render();
    assert_eq!(automation::active_count(&mut m.core), 1);
    let stop = wire::Stop { voice_id: V1, frame_offset: wire::ASAP, fade_frames: 0, reason: 0, shape: 0 };
    m.submit(&[raw(move |b| stop.write(b, 0))]);
    m.render_n(2);
    assert_eq!(automation::active_count(&mut m.core), 0, "the ended voice left the list");
    m.submit(&[dc(V2, 0, 0.0), automate(V2, &[(G, 0, 0)]), bus_automate(0, &[(G, 0, 0)])]);
    m.render();
    m.submit(&[reset(true)]);
    assert_eq!(automation::active_count(&mut m.core), 0);
    assert_eq!(automation::param_value(&mut m.core, 0, 0), Some(0.0));
    assert_eq!(automation::bus_entry(&mut m.core, 0).unwrap().count, 0);
    // A new voice in the same slot with no bindings plays at its gain.
    m.submit(&[dc(V2, 0, 0.0)]);
    let (l, _) = m.render();
    check(&l, TOL, "after reset", |_| 1.0);
}

#[test]
fn malformed_records_refuse_the_batch() {
    let mut m = mixer();
    let Rec::Raw(mut a) = automate(V1, &[(G, 0, 0)]) else { unreachable!() };
    a[12] = 5; // bindingCount 5, one present
    assert_eq!(m.try_submit(&[Rec::Raw(a)]), wire::ERR_MALFORMED);
    let Rec::Raw(mut c) = curves(0, &[IDENTITY]) else { unreachable!() };
    c[20] = 9; // keyCount 9, two present
    assert_eq!(m.try_submit(&[Rec::Raw(c)]), wire::ERR_MALFORMED);
}

#[test]
fn extra_bindings_and_keys_are_ignored() {
    let mut m = mixer();
    // 70 keys: the first 64 (ADR 0332's limit) are 1, the rest 0; at x = 69 the kept curve holds key 63's 1.
    let keys: Vec<(f32, f32, u32)> = (0..70).map(|i| (i as f32, if i < automation::CURVE_KEYS { 1.0 } else { 0.0 }, 0)).collect();
    m.submit(&[curves(1023, &[&keys, IDENTITY]), param(0, 0, 69.0, 0.0), dc(V1, 0, 0.0)]);
    let many: Vec<(u16, u16, u32)> = (0..10).map(|_| (G, 1023, 0)).collect();
    m.submit(&[automate(V1, &many)]);
    assert_eq!(automation::voice_entry(&mut m.core, 1).unwrap().count, 8);
    let (l, _) = m.render();
    check(&l, TOL, "the 64-key curve is 1 everywhere", |_| 1.0);
    let s = voices::slots(&m.core)[1];
    assert_eq!(s.state, state::PLAYING);
}

#[test]
fn a_bezier_volume_curve_shapes_the_gain() {
    // ADR 0332: a Bézier key with a flat third-long out handle before a plain key is smoothstep's cubic; a second
    // Bézier segment with handles on the line is linear. Parameter values off the keys.
    let mut m = mixer();
    let third = 1.0 / 3.0;
    m.submit(&[
        bezier_curve(0, &[(0.0, 0.0, 5, [0.0, 0.0, third, 0.0]), (1.0, 1.0, 5, [-0.25, -0.25, 0.25, -0.25]), (2.0, 0.0, 5, [-0.25, 0.25, 0.0, 0.0])]),
        param(0, 0, 0.25, 0.0),
        dc(V1, 0, 0.0),
        automate(V1, &[(G, 0, 0)]),
    ]);
    let (l, _) = m.render();
    // Segment 0: out (1/3, 0), next key Bézier with in (-0.25, -0.25): control points (1/3, 0) and (0.75, 0.75).
    let expected = 0.25f32;
    let got = l[127];
    assert!(got > 0.0 && got < expected, "{got}: the cubic sits under the line at 0.25");
    // Segment 1 runs on the line from (1, 1) to (2, 0): at 1.5 the gain is 0.5.
    m.submit(&[param(0, 0, 1.5, 0.0)]);
    m.render();
    let (l, _) = m.render();
    check(&l, 1e-4, "on the line", |_| 0.5);
}

#[test]
fn a_virtual_voice_keeps_time_at_its_pitch_binding() {
    let mut m = mixer();
    let clip = vec![0.0f32; 48_000];
    m.load_clip(2, &clip);
    m.submit(&[curves(0, &[&[(0.0, 2.0, 0)]]), play(V1, 2, 0, 0), automate(V1, &[(G, 0, 1)])]);
    m.render_n(3);
    assert_eq!(voices::slots(&m.core)[1].position, (3 * 2 * 128) as f64);
}

// --- ADR 0332: time parameters ---

const T_VOICE: u16 = (wire::PARAM_TIME | wire::TIME_VOICE) as u16;
const T_CLIP: u16 = (wire::PARAM_TIME | wire::TIME_CLIP) as u16;
const T_SEQ: u16 = (wire::PARAM_TIME | wire::TIME_SEQUENCE) as u16;
/// 0 at 0 s to 1 at 0.01 s (480 frames at 48 kHz).
const TEN_MS: &[(f32, f32, u32)] = &[(0.0, 0.0, 0), (0.01, 1.0, 0)];

fn time(group: u16, which: u32, value: f32, rate: f32, frame_offset: u32) -> Rec {
    let t = wire::Time { voice_id: 0, frame_offset, group, which: which as u16, value, rate };
    raw(move |b| t.write(b, 0))
}

/// The curve TEN_MS at `frames` frames (48 kHz).
fn ten_ms(frames: f32) -> f32 {
    (frames / 480.0).min(1.0)
}

#[test]
fn a_voice_time_binding_follows_the_voice_from_its_start() {
    let mut m = mixer();
    m.submit(&[curves(0, &[TEN_MS]), dc(V1, 0, 0.0), automate(V1, &[(T_VOICE, 0, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "0 s at the start (the first quantum starts at its value)", |_| 0.0);
    let (l, _) = m.render();
    check(&l, 1e-5, "128 frames later", |j| ramp(0.0, ten_ms(128.0), j));
    m.render_n(2);
    let (l, _) = m.render();
    check(&l, 1e-5, "512 frames: past the last key", |j| ramp(ten_ms(384.0), 1.0, j));
    // A stamped voice counts from its stamp, not from its PLAY: silent until frame 1,024, at its curve's start then.
    let frame = m.frame;
    let Rec::Play(mut p) = dc(V2, 0, 0.0) else { unreachable!() };
    p.frame_offset = (1024 - frame) as u32;
    m.submit(&[raw(|b| wire::Stop { voice_id: V1, frame_offset: wire::ASAP, fade_frames: 0, reason: 0, shape: 0 }.write(b, 0)), Rec::Play(p), automate(V2, &[(T_VOICE, 0, 0)])]);
    while m.frame < 1024 {
        m.render();
    }
    let (l, _) = m.render();
    check(&l, TOL, "V2 at its start (V1 stopped)", |_| 0.0);
    let (l, _) = m.render();
    check(&l, 1e-5, "V2 128 frames after its stamp", |j| ramp(0.0, ten_ms(128.0), j));
    assert_eq!(automation::voice_entry(&mut m.core, 2).unwrap().vstart, 1024);
}

/// ABI 4.9 (ADR 0332 "time origin"): a binding's offset reads its time parameter that many seconds
/// later, exactly as a copy of the curve shifted by it would (the playlist runtime no longer uploads
/// shifted copies per voice), and only for time parameters.
#[test]
fn a_time_offset_binding_evaluates_like_the_shifted_curve_copy() {
    let offset = 0.004f32; // 192 frames into TEN_MS
    let shifted: Vec<(f32, f32, u32)> = TEN_MS.iter().map(|&(x, y, i)| (x - offset, y, i)).collect();
    let run = |curve: &[(f32, f32, u32)], off: f32| {
        let mut m = mixer();
        let a = wire::Automate { voice_id: V1, frame_offset: wire::ASAP, bindings: vec![wire::AutomateBindings { param: T_VOICE, curve: 0, target: 0, offset: off }] };
        m.submit(&[curves(0, &[curve]), dc(V1, 0, 0.0), raw(move |b| a.write(b, 0))]);
        (0..4).flat_map(|_| m.render().0).collect::<Vec<f32>>()
    };
    let with_offset = run(TEN_MS, offset);
    let with_copy = run(&shifted, 0.0);
    assert_eq!(with_offset, with_copy);
    check(&with_offset[..128], 1e-5, "starts 192 frames into the curve", |_| ten_ms(192.0));
    // A parameter binding ignores the offset.
    let mut m = mixer();
    let a = wire::Automate { voice_id: V1, frame_offset: wire::ASAP, bindings: vec![wire::AutomateBindings { param: 0x8000, curve: 0, target: 0, offset: 0.004 }] };
    m.submit(&[curves(0, &[TEN_MS]), param(0, 0, 0.002, 0.0), dc(V1, 0, 0.0), raw(move |b| a.write(b, 0))]);
    let (l, _) = m.render();
    check(&l, 1e-5, "the parameter's value, unshifted", |_| ten_ms(96.0));
}

#[test]
fn a_clip_time_binding_follows_the_playhead() {
    // Pitch 2: the playhead moves 256 clip frames a quantum, so clip time runs twice as fast as voice time.
    let mut m = mixer();
    m.load_clip(2, &[1.0f32; 48_000]);
    let Rec::Play(mut p) = play(V1, 2, 0, MIXED) else { unreachable!() };
    p.pitch = 2.0;
    m.submit(&[curves(0, &[TEN_MS]), Rec::Play(p), automate(V1, &[(T_CLIP, 0, 0)])]);
    m.render();
    let (l, _) = m.render();
    check(&l, 1e-5, "256 clip frames", |j| ramp(0.0, ten_ms(256.0), j));
    // A seek moves clip time with it (not voice time).
    m.submit(&[raw(|b| wire::Seek { voice_id: V1, frame_offset: wire::ASAP, clip_frame: 0, epoch: 0 }.write(b, 0))]);
    m.render_n(3);
    let pos = voices::slots(&m.core)[1].position as f32;
    let (l, _) = m.render();
    assert!(l[127] < ten_ms(pos + 256.0) + 1e-5 && l[127] > 0.0, "{}: clip time follows the seek ({pos})", l[127]);
}

#[test]
fn a_sequence_time_binding_follows_its_group_clock_and_time_re_anchors_it() {
    let mut m = mixer();
    let Rec::Play(mut p) = dc(V1, 0, 0.0) else { unreachable!() };
    p.group = 3;
    // A clock that stays at 0 until TIME: y = x / 2 over 0..2 s.
    m.submit(&[curves(0, &[&[(0.0, 0.0, 0), (2.0, 1.0, 0)]]), Rec::Play(p), automate(V1, &[(T_SEQ, 0, 0)])]);
    let (l, _) = m.render();
    check(&l, TOL, "parked at 0", |_| 0.0);
    // Stamped at frame 256: 1 s there, running at half speed.
    let frame = m.frame;
    m.submit(&[time(3, wire::TIME_SEQUENCE, 1.0, 0.5, (256 - frame) as u32)]);
    let (l, _) = m.render();
    check(&l, TOL, "not anchored yet", |_| 0.0);
    assert_eq!(automation::clock(&mut m.core, 3).unwrap(), automation::GroupClock::default());
    m.render(); // the quantum holding frame 256 applies it (after its bindings were read)
    assert_eq!(automation::clock(&mut m.core, 3).unwrap(), automation::GroupClock { value: 1.0, rate: 0.5, anchor: 256 });
    let at = |frame: f32| (1.0 + 0.5 * (frame - 256.0) / 48_000.0) / 2.0;
    let (l, _) = m.render();
    check(&l, 1e-5, "running from its anchor", |j| ramp(0.0, at(384.0), j));
    let (l, _) = m.render();
    check(&l, 1e-5, "still running", |j| ramp(at(384.0), at(512.0), j));
    // Asap, rate 0: parked at 0.5 s from the next quantum on.
    m.submit(&[time(3, wire::TIME_SEQUENCE, 0.5, 0.0, wire::ASAP)]);
    let (l, _) = m.render();
    check(&l, 1e-5, "parked", |j| ramp(at(512.0), 0.25, j));
    assert_eq!(automation::clock(&mut m.core, 3).unwrap().anchor, 640);
    // Another clock (`which`), a bad value or a group out of range is ignored.
    m.submit(&[time(3, wire::TIME_VOICE, 9.0, 1.0, wire::ASAP), time(3, wire::TIME_SEQUENCE, f32::NAN, 1.0, wire::ASAP), time(1025, wire::TIME_SEQUENCE, 9.0, 1.0, wire::ASAP)]);
    let (l, _) = m.render();
    check(&l, 1e-5, "unchanged", |_| 0.25);
    // A voice in another group reads that group's clock (0 here); RESET clears every clock.
    m.submit(&[reset(true)]);
    assert_eq!(automation::clock(&mut m.core, 3).unwrap(), automation::GroupClock::default());
}

#[test]
fn time_records_never_split_the_quantum() {
    let mut m = mixer();
    m.submit(&[curves(0, &[TEN_MS]), dc(V1, 0, 0.0)]);
    m.render();
    let frame = m.frame;
    m.submit(&[time(0, wire::TIME_SEQUENCE, 0.0, 1.0, (frame + 37) as u32 - frame as u32)]);
    m.render();
    assert_eq!(audio_core::status::counters(&m.core).music.split_quanta, 0);
    assert_eq!(automation::clock(&mut m.core, 0).unwrap().anchor, frame + 37);
}

/// ABI 4.4: a mono voice's equal-power pan gains, normalised so pan 0 is the identity.
fn mono_pan(p: f32) -> (f32, f32) {
    let theta = (p + 1.0) * core::f32::consts::FRAC_PI_4;
    (core::f32::consts::SQRT_2 * theta.cos(), core::f32::consts::SQRT_2 * theta.sin())
}

/// A looping mixed PLAY of the (mono) DC clip at gain 0.5, so a +3 dB pan stays under the limiter.
fn dc_half(voice: u32) -> Rec {
    let Rec::Play(mut p) = dc(voice, 0, 0.0) else { unreachable!() };
    p.gain = 0.5;
    Rec::Play(p)
}

#[test]
fn a_pan_binding_pans_a_mono_voice_by_equal_power_and_sums_its_curves() {
    let mut m = mixer();
    // Curves 0: the identity over -1..1; 1: a constant 0.25.
    m.submit(&[curves(0, &[&[(-1.0, -1.0, 0), (1.0, 1.0, 0)], &[(0.0, 0.25, 0)]]), param(0, 0, -0.5, 0.0), dc_half(V1)]);
    let (l, r) = m.render();
    check(&l, TOL, "unbound", |_| 0.5);
    check(&r, TOL, "unbound", |_| 0.5);
    // Two pan curves sum: -0.5 + 0.25 = -0.25, at once on the first quantum.
    m.submit(&[automate(V1, &[(G, 0, 4), (G, 1, 4)])]);
    let (gl, gr) = mono_pan(-0.25);
    let (l, r) = m.render();
    check(&l, 1e-5, "left", |_| 0.5 * gl);
    check(&r, 1e-5, "right", |_| 0.5 * gr);
    // A jump to 1 + 0.25 clamps to 1 (hard right), the gains interpolated across the quantum.
    m.submit(&[param(0, 0, 1.0, 0.0)]);
    let (l, r) = m.render();
    let (el, er) = mono_pan(1.0);
    assert!((l[127] - 0.5 * el).abs() < 1e-5 && (r[127] - 0.5 * er).abs() < 1e-5, "{} {}", l[127], r[127]);
    assert!((l[0] - 0.5 * gl).abs() < 0.03 && l[64] < 0.5 * gl && l[64] > 0.5 * el, "ramped: {} {}", l[0], l[64]);
    let (l, r) = m.render();
    check(&l, 1e-5, "hard right: left silent", |_| 0.5 * el);
    check(&r, 1e-5, "hard right: +3 dB right", |_| 0.5 * er);
}

#[test]
fn a_spatial_voice_ignores_its_pan_binding() {
    let mut m = mixer();
    m.submit(&[curves(0, &[&[(0.0, 1.0, 0)]]), dc(V1, 0, 1.0)]);
    m.render_n(2);
    let before = m.render();
    m.submit(&[automate(V1, &[(G, 0, 4)])]);
    let after = m.render();
    check(&after.0, 1e-6, "left", |j| before.0[j]);
    check(&after.1, 1e-6, "right", |j| before.1[j]);
}

#[test]
fn a_highpass_binding_floors_the_voice_highpass_and_zero_passes_it() {
    let mut m = mixer();
    m.submit(&[curves(0, &[&[(0.0, 0.0, 0)], &[(0.0, 2_000.0, 0)]]), dc(V1, 0, 0.0)]);
    // A floor at 0 is no high-pass: DC passes exactly.
    m.submit(&[automate(V1, &[(G, 0, 3)])]);
    let (l, _) = m.render();
    check(&l, 0.0, "a 0 Hz floor passes the voice", |_| 1.0);
    // 2 kHz (highest wins over 0) removes DC.
    m.submit(&[automate(V1, &[(G, 0, 3), (G, 1, 3)])]);
    m.render_n(8);
    let (l, _) = m.render();
    let peak = l.iter().fold(0.0f32, |a, x| a.max(x.abs()));
    assert!(peak < 1e-3, "2 kHz removes DC: peak {peak}");
    // Buses ignore highpass and pan bindings.
    m.submit(&[bus_automate(0, &[(G, 1, 3), (G, 1, 4)])]);
    assert_eq!(automation::bus_entry(&mut m.core, 0).unwrap().count, 0);
}
