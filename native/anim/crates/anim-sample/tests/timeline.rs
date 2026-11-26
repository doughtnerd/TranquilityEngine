//! Timeline helpers (`anim_sample::timeline`): the playhead's wrap modes as windows, and the
//! crossfade mix. Times are exact f32 values (dyadic fractions), so comparisons are exact.

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ClipView, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_sample::timeline::{advance, mix_add, mix_begin, mix_resolve, Playhead, Wrap, MAX_LEGS};
use anim_sample::{ClipBindings, ClipSampler, Form, WINDOW_START};

fn head(time: f32, dir: f32) -> Playhead {
    Playhead { time, dir }
}

#[test]
fn once_clamps_and_finishes_at_the_end() {
    let mut h = head(1.5, 1.0);
    let a = advance(Wrap::Once, 2.0, &mut h, 0.25, true);
    assert_eq!(a.count, 1);
    assert_eq!(h.time, 1.75);
    assert!(!a.finished);
    assert_eq!(a.windows()[0].flags, WINDOW_START);
    let a = advance(Wrap::Once, 2.0, &mut h, 0.5, false);
    assert_eq!(h.time, 2.0);
    assert!(a.finished);
    assert_eq!(
        a.windows()[0].delta,
        0.5,
        "the window carries the move; the track window clamps it"
    );
    assert_eq!(a.windows()[0].flags, 0);
}

#[test]
fn backwards_once_finishes_at_zero() {
    let mut h = head(0.5, 1.0);
    let a = advance(Wrap::Hold, 2.0, &mut h, -1.0, false);
    assert_eq!(h.time, 0.0);
    assert!(a.finished);
    assert_eq!(a.windows()[0].delta, -1.0);
}

#[test]
fn loop_is_one_looping_window_and_counts_wraps() {
    let mut h = head(1.75, 1.0);
    let a = advance(Wrap::Loop, 2.0, &mut h, 0.5, false);
    assert_eq!(a.count, 1);
    assert!(a.windows()[0].looping);
    assert_eq!(h.time, 0.25);
    assert_eq!(a.wraps, 1);
    assert!(!a.finished);
    // Backwards across 0.
    let a = advance(Wrap::Loop, 2.0, &mut h, -0.5, false);
    assert_eq!(h.time, 1.75);
    assert_eq!(a.wraps, 1);
    // No wrap inside.
    let a = advance(Wrap::Loop, 2.0, &mut h, -0.25, false);
    assert_eq!(a.wraps, 0);
}

#[test]
fn loop_caps_a_huge_move_at_four_durations() {
    let mut h = head(0.0, 1.0);
    let a = advance(Wrap::Loop, 2.0, &mut h, 1000.0, false);
    assert_eq!(a.wraps, 4);
    assert_eq!(h.time, 0.0);
}

#[test]
fn pingpong_turns_at_each_end() {
    let mut h = head(1.5, 1.0);
    let a = advance(Wrap::PingPong, 2.0, &mut h, 1.0, true);
    assert_eq!(a.count, 2);
    let (w0, w1) = (a.windows()[0], a.windows()[1]);
    assert_eq!((w0.from, w0.delta), (1.5, 0.5));
    assert_eq!((w1.from, w1.delta), (2.0, -0.5));
    assert_eq!(w0.flags, WINDOW_START);
    assert_eq!(w1.flags, 0, "only the first window carries START");
    assert_eq!(h.time, 1.5);
    assert_eq!(h.dir, -1.0);
    assert_eq!(a.wraps, 1);
    // The next move continues downwards.
    let a = advance(Wrap::PingPong, 2.0, &mut h, 1.0, false);
    assert_eq!(a.count, 1);
    assert_eq!(h.time, 0.5);
    // Down through 0 and back up.
    let a = advance(Wrap::PingPong, 2.0, &mut h, 1.0, false);
    assert_eq!(a.count, 2);
    assert_eq!(h.time, 0.5);
    assert_eq!(h.dir, 1.0);
}

#[test]
fn pingpong_reverse_speed_flips_the_travel() {
    let mut h = head(1.0, 1.0);
    let a = advance(Wrap::PingPong, 2.0, &mut h, -0.5, false);
    assert_eq!(a.count, 1);
    assert_eq!(a.windows()[0].delta, -0.5);
    assert_eq!(h.time, 0.5);
    assert_eq!(
        h.dir, 1.0,
        "the leg direction is kept; only this move reversed"
    );
}

#[test]
fn pingpong_reduces_whole_round_trips_and_never_exceeds_the_leg_cap() {
    let mut h = head(0.0, 1.0);
    let a = advance(Wrap::PingPong, 2.0, &mut h, 4.5, false);
    // 4.5 = one whole round trip (4.0) + 0.5.
    assert!(a.count <= MAX_LEGS);
    assert_eq!(h.time, 0.5);
    assert_eq!(h.dir, 1.0);
}

#[test]
fn an_arrival_exactly_at_the_end_turns_on_the_next_move() {
    let mut h = head(1.0, 1.0);
    let a = advance(Wrap::PingPong, 2.0, &mut h, 1.0, false);
    assert_eq!((a.count, a.wraps, h.time, h.dir), (1, 0, 2.0, 1.0));
    let a = advance(Wrap::PingPong, 2.0, &mut h, 0.5, false);
    assert_eq!((a.count, a.wraps, h.time, h.dir), (1, 1, 1.5, -1.0));
}

#[test]
fn degenerate_inputs_are_safe() {
    let mut h = head(f32::NAN, 1.0);
    let a = advance(Wrap::Once, 2.0, &mut h, f32::NAN, true);
    assert_eq!(a.count, 1);
    assert_eq!(h.time, 0.0);
    // No duration: nothing to wrap or turn.
    for wrap in [Wrap::Loop, Wrap::PingPong] {
        let mut h = head(0.0, 1.0);
        let a = advance(wrap, 0.0, &mut h, 1.0, false);
        assert_eq!((a.count, a.wraps, a.finished, h.time), (1, 0, false, 0.0));
    }
    // Infinite duration runs on.
    let mut h = head(0.0, 1.0);
    let a = advance(Wrap::Once, f32::INFINITY, &mut h, 5.0, false);
    assert_eq!((h.time, a.finished), (5.0, false));
}

// ---- Mixing ----

fn clip_bytes(tracks: Vec<Track>) -> Vec<u8> {
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 1.0,
        sample_rate: 30.0,
        frame_count: 2,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["n".into(), "c".into(), "f".into()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    compress(&clip, None, &settings).unwrap().bytes
}

fn value_track(kind: TrackKind, width: usize, v: &[f32]) -> Track {
    let mut raw = Vec::new();
    for _ in 0..2 {
        raw.extend_from_slice(&v[..width]);
    }
    Track {
        kind,
        flags: 0,
        subtype: 0,
        binding: Binding::property(0, 1, 2),
        raw,
        keys: Vec::new(),
    }
}

fn discrete(value: u32) -> Track {
    Track {
        kind: TrackKind::Discrete,
        flags: 0,
        subtype: 1,
        binding: Binding::property(0, 1, 2),
        raw: Vec::new(),
        keys: vec![Key {
            time: 0.0,
            end: 0.0,
            data: KeyData::Discrete { value },
        }],
    }
}

fn bindings(bytes: &[u8]) -> ClipBindings {
    let view = ClipView::parse(bytes).unwrap();
    ClipBindings::new(&ClipSampler::new(view, Form::Compressed).unwrap())
}

#[test]
fn mixing_averages_floats_nlerps_quats_and_picks_the_heaviest_word() {
    let s = std::f32::consts::FRAC_1_SQRT_2;
    let mk = |f: f32, q: [f32; 4], d: u32| {
        clip_bytes(vec![
            value_track(TrackKind::Vec2, 2, &[f, -f]),
            value_track(TrackKind::Quat, 4, &q),
            discrete(d),
        ])
    };
    let a = mk(0.0, [0.0, 0.0, 0.0, 1.0], 7);
    let b = mk(10.0, [0.0, s, 0.0, s], 9);
    let (ba, bb) = (bindings(&a), bindings(&b));
    assert!(ba.same_layout(&bb));
    let n = ba.column_words();
    let sample = |bind: &ClipBindings, bytes: &[u8]| {
        let view = ClipView::parse(bytes).unwrap();
        let sampler = ClipSampler::new(view, Form::Compressed).unwrap();
        let bound = bind.bind(&sampler).unwrap();
        let mut cols = vec![0u32; n];
        assert!(bound.sample_columns(0.0, true, &mut cols));
        cols
    };
    let (ca, cb) = (sample(&ba, &a), sample(&bb, &b));
    let mut acc = vec![0u32; n];
    let mut best = vec![0.0f32; n];
    mix_begin(&mut acc, &mut best);
    mix_add(&ba, &mut acc, &mut best, &ca, 0.25);
    mix_add(&ba, &mut acc, &mut best, &cb, 0.75);
    let mut out = vec![0u32; n];
    mix_resolve(&ba, &acc, 1.0, &mut out);
    let f = |i: usize| f32::from_bits(out[i]);
    let cols: Vec<_> = ba.columns().collect();
    let v2 = cols[0].offset as usize;
    let q = cols[1].offset as usize;
    let d = cols[2].offset as usize;
    assert!((f(v2) - 7.5).abs() < 1e-5 && (f(v2 + 1) + 7.5).abs() < 1e-5);
    assert_eq!(out[d], 9, "the heaviest entry's word");
    // Weighted nlerp: normalised (0, 0.75 s, 0, 0.25 + 0.75 s).
    let (x, y, z, w) = (f(q), f(q + 1), f(q + 2), f(q + 3));
    let len = (x * x + y * y + z * z + w * w).sqrt();
    assert!((len - 1.0).abs() < 1e-5);
    let ey = 0.75 * s;
    let ew = 0.25 + 0.75 * s;
    let l = (ey * ey + ew * ew).sqrt();
    assert!((y - ey / l).abs() < 1e-5 && (w - ew / l).abs() < 1e-5 && x == 0.0 && z == 0.0);
}

#[test]
fn a_lone_entry_below_full_weight_mixes_to_itself() {
    let a = clip_bytes(vec![value_track(TrackKind::Float, 1, &[4.0])]);
    let ba = bindings(&a);
    let view = ClipView::parse(&a).unwrap();
    let sampler = ClipSampler::new(view, Form::Compressed).unwrap();
    let bound = ba.bind(&sampler).unwrap();
    let mut cols = vec![0u32; ba.column_words()];
    bound.sample_columns(0.0, true, &mut cols);
    let mut acc = vec![0u32; cols.len()];
    let mut best = vec![0.0f32; cols.len()];
    mix_begin(&mut acc, &mut best);
    mix_add(&ba, &mut acc, &mut best, &cols, 0.2);
    let mut out = vec![0u32; cols.len()];
    mix_resolve(&ba, &acc, 0.2, &mut out);
    assert!(
        (f32::from_bits(out[0]) - 4.0).abs() < 1e-5,
        "divided by the total, not 1"
    );
}

#[test]
fn different_layouts_are_told_apart() {
    let a = bindings(&clip_bytes(vec![value_track(TrackKind::Float, 1, &[0.0])]));
    let b = bindings(&clip_bytes(vec![value_track(
        TrackKind::Vec2,
        2,
        &[0.0, 0.0],
    )]));
    assert!(!a.same_layout(&b));
    assert!(a.same_layout(&a));
}
