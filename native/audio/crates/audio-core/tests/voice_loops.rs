//! ADR 0328: loop programs (LOOPS) through `scheduler::submit` and `Core::process`, on a ramp clip
//! (sample `k` is `k / 1000`), so the output tells the playhead: a forward loop with a count, a
//! ping-pong loop, a held loop released by a stamped SET_LOOP on its exact frame, a hold point, a
//! parameter loop leaving by crossfade, the seam's equal-power crossfade, virtual voices keeping
//! time, and LOOPS on stream voices ignored.

mod common;

use audio_core::automation::{self, LOOP_PROGRAM};
use audio_core::voice_loops::{active, direction, exit, flags};
use audio_core::voices;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    let clip: Vec<f32> = (0..4000).map(|i| i as f32 / 1000.0).collect();
    m.load_clip(2, &clip);
    m
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

#[derive(Clone, Copy, Default)]
struct L {
    start: u32,
    end: u32,
    xfade: u32,
    exit_fade: u32,
    count: u16,
    dir: u8,
    act: u8,
    exit: u8,
    reenter: bool,
    below: bool,
    param: u16,
    threshold: f32,
}

fn loops(voice: u32, list: &[L]) -> Rec {
    let rec = wire::Loops {
        voice_id: voice,
        frame_offset: wire::ASAP,
        loops: list
            .iter()
            .map(|l| wire::LoopsLoops {
                start_frame: l.start,
                end_frame: l.end,
                crossfade_frames: l.xfade,
                exit_fade_frames: l.exit_fade,
                count: l.count,
                flags: l.dir as u16 | (l.act as u16) << flags::ACTIVE_SHIFT | (l.exit as u16) << flags::EXIT_SHIFT | if l.reenter { flags::REENTER } else { 0 } | if l.below { flags::BELOW } else { 0 },
                param: l.param,
                reserved: 0,
                threshold: l.threshold,
            })
            .collect(),
    };
    raw(move |b| rec.write(b, 0))
}

fn release(voice: u32, frame_offset: u32) -> Rec {
    let l = wire::SetLoop { voice_id: voice, frame_offset, loop_start_frame: 0, loop_end_frame: 0, flags: 0 };
    raw(move |b| l.write(b, 0))
}

fn param(slot: u16, value: f32) -> Rec {
    let p = wire::Param { voice_id: 0, frame_offset: wire::ASAP, group: 0, slot, value, seek_per_second: 0.0 };
    raw(move |b| p.write(b, 0))
}

/// The clip frame a ramp sample reads.
fn frame_of(s: f32) -> f32 {
    s * 1000.0
}

fn frames(l: &[f32]) -> Vec<i32> {
    l.iter().map(|&s| frame_of(s).round() as i32).collect()
}

#[test]
fn a_forward_loop_plays_its_count_then_plays_on() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED), loops(V1, &[L { start: 100, end: 200, count: 3, ..L::default() }])]);
    let (l, _) = m.render_n(4);
    let want: Vec<i32> = (0..200).chain(100..200).chain(100..200).chain(200..312).collect();
    assert_eq!(frames(&l), want);
    let e = automation::voice_entry(&mut m.core, 1).unwrap();
    assert_eq!((e.loop_on, automation::program(&mut m.core, 1).unwrap().cur), (LOOP_PROGRAM, 1));
    assert_eq!(automation::programs_in_use(&mut m.core), 1);
}

#[test]
fn a_ping_pong_loop_turns_at_both_ends() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED), loops(V1, &[L { start: 50, end: 100, dir: direction::PING_PONG, ..L::default() }])]);
    let (l, _) = m.render_n(2);
    let f = frames(&l);
    assert_eq!(&f[..101], &(0..=100).collect::<Vec<_>>()[..]);
    assert_eq!(f[101], 99);
    assert_eq!(f[150], 50);
    assert_eq!(f[151], 51);
    assert!(f.iter().all(|&x| x <= 100));
}

#[test]
fn a_held_loop_is_released_on_the_stamped_frame_and_finishes_its_pass() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED), loops(V1, &[L { start: 100, end: 200, act: active::HELD, ..L::default() }])]);
    m.render_n(2);
    // Released at frame 330 (clip frame 130, in its third pass): it plays to 200, then on.
    let frame = m.frame;
    m.submit(&[release(V1, (330 - frame) as u32)]);
    let (l, _) = m.render_n(2);
    let f = frames(&l);
    let at = |k: usize| f[k - frame as usize];
    assert_eq!(at(330), 130);
    assert_eq!(at(399), 199);
    assert_eq!(at(400), 200, "the pass played out, then on past the loop");
    assert_eq!(at(450), 250);
}

#[test]
fn a_held_loop_with_a_jump_exit_leaves_at_the_release() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED), loops(V1, &[L { start: 100, end: 200, act: active::HELD, exit: exit::JUMP, ..L::default() }])]);
    m.render_n(2);
    let frame = m.frame;
    m.submit(&[release(V1, (330 - frame) as u32)]);
    let (l, _) = m.render_n(2);
    let f = frames(&l);
    assert_eq!(f[329 - frame as usize], 129);
    assert_eq!(f[330 - frame as usize], 200, "jumped to the loop's end (no crossfade)");
    assert_eq!(f[331 - frame as usize], 201);
}

#[test]
fn a_hold_point_parks_silent_until_the_key_off() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED), loops(V1, &[L { start: 300, end: 300, act: active::HELD, ..L::default() }])]);
    let (l, _) = m.render_n(4);
    assert_eq!(frame_of(l[299]).round(), 299.0);
    assert!(l[301..].iter().all(|&s| s == 0.0), "parked: silent");
    assert_eq!(voices::slots(&m.core)[1].position, 300.0);
    m.submit(&[release(V1, wire::ASAP)]);
    let (l, _) = m.render();
    assert_eq!(frames(&l[..3]), [300, 301, 302], "goes on from the hold point");
}

#[test]
fn a_parameter_loop_leaves_by_crossfade_when_its_parameter_falls() {
    let mut m = mixer();
    m.submit(&[
        param(4, 1.0),
        play(V1, 2, 0, MIXED),
        loops(V1, &[L { start: 100, end: 200, act: active::PARAMETER, exit: exit::CROSSFADE, exit_fade: 64, param: 0x8004, threshold: 0.5, ..L::default() }]),
    ]);
    m.render_n(3); // looping: 384 frames, at clip frame 184
    assert_eq!(voices::slots(&m.core)[1].position, 184.0);
    m.submit(&[param(4, 0.0)]);
    let (l, _) = m.render();
    // At the quantum's start: main at 200 fading in, the tail from 184 fading out (equal power).
    let g = audio_dsp::equal_power::sin_quarter(0.5);
    let h = audio_dsp::equal_power::cos_quarter(0.5);
    // Frame 32 of 64: main at 232, the tail (184 read on, unwrapped) at 216.
    assert!((l[0] - 0.184).abs() < 1e-6, "{}", l[0]);
    let want = 0.232 * g + 0.216 * h;
    assert!((l[32] - want).abs() < 1e-5, "{} vs {want}", l[32]);
    assert_eq!(frame_of(l[100]).round(), 300.0, "after the fade, on past the loop");
}

#[test]
fn a_virtual_voice_keeps_time_through_its_program() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, 0), loops(V1, &[L { start: 100, end: 200, count: 2, ..L::default() }])]);
    m.render_n(3);
    // 384 frames: 0..200, 100..200 (2 passes), then 84 past 200.
    assert_eq!(voices::slots(&m.core)[1].position, 284.0);
}

#[test]
fn loops_replace_and_clear_and_a_stream_ignores_them() {
    let mut m = mixer();
    m.submit(&[play(V1, 2, 0, MIXED | LOOP), loops(V1, &[L { start: 100, end: 200, ..L::default() }])]);
    assert_eq!(voices::slots(&m.core)[1].flags & voices::flag::LOOP, 0, "the whole-clip loop flag no longer applies");
    m.submit(&[loops(V1, &[])]);
    assert_eq!(automation::voice_entry(&mut m.core, 1).unwrap().loop_on, 0);
    let mut m = mixer();
    m.submit(&[play(V1, 77, 0, MIXED | wire::PLAY_FLAGS_STREAM | LOOP), loops(V1, &[L { start: 0, end: 10, ..L::default() }])]);
    assert_eq!(automation::active_count(&mut m.core), 0);
    // A truncated program refuses the batch.
    let Rec::Raw(mut b) = loops(V1, &[L::default()]) else { unreachable!() };
    b.truncate(b.len() - 4);
    let words = (b.len() / 4) as u16;
    b[2..4].copy_from_slice(&words.to_le_bytes());
    assert_eq!(m.try_submit(&[Rec::Raw(b)]), wire::ERR_MALFORMED);
}
