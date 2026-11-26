//! Track kinds over time windows (`anim_sample::window`): crossings against
//! `anim-offline::sample`'s brute-force reference, the inclusivity rule, loops, reverse play,
//! seeks, weight gating, notify-state sequences, activation, discrete, subclip states, sync
//! phase, columns and determinism.
//!
//! Tolerances: crossings and levels are exact (no tolerance). The runtime works in f32 and the
//! reference in f64, so random windows whose ends fall within 1e-4 s of a key instance are
//! skipped (the two may round a key at the edge to different sides); exact edges have their own
//! tests in f32. Value columns are compared bit for bit with `sample_track`.

use anim_compress::{compress, Settings};
use anim_format::clip::{
    Binding, Clip, ClipView, ControlKind, Key, KeyData, MarkerKind, Track, TrackKind, CLIP_LOOP,
};
use anim_format::NONE;
use anim_offline::sample::{self as reference, WindowRef};
use anim_sample::{
    ClipBindings, ClipSampler, ColumnType, Form, NotifyPhase, SampleError, TrackRecord, Window,
    SUBCLIP_ENTERED, SUBCLIP_EXITED, WINDOW_SEEK, WINDOW_START,
};

const D: f32 = 2.0;

fn key(time: f32, end: f32, data: KeyData) -> Key {
    Key { time, end, data }
}

fn ev(method: u32, threshold: f32, always: bool) -> KeyData {
    KeyData::Event {
        method,
        args: NONE,
        threshold,
        always,
    }
}

fn keyed(kind: TrackKind, keys: Vec<Key>) -> Track {
    Track {
        kind,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys,
    }
}

/// Track indices of the fixture.
mod t {
    pub const FLOAT: usize = 0;
    pub const MORPH: usize = 1;
    pub const EVENTS: usize = 2;
    pub const EVENTS2: usize = 3;
    pub const AUDIO: usize = 5;
    pub const CONTROL: usize = 6;
    pub const ACTIVATION: usize = 7;
    pub const DISCRETE: usize = 8;
    pub const SUBCLIP: usize = 9;
}

/// A 2-second, 30 Hz clip with every track kind.
fn fixture(looping: bool) -> Clip {
    let frames = 61u32;
    let wave = |phase: f64| -> Vec<f32> {
        (0..frames)
            .map(|f| ((f as f64 / 30.0 * 3.0 + phase).sin() * 2.0) as f32)
            .collect()
    };
    let mut float = keyed(TrackKind::Float, Vec::new());
    float.binding = Binding::property(0, 1, 2);
    float.raw = wave(0.0);
    let mut morph = keyed(TrackKind::Morph, Vec::new());
    morph.binding = Binding::property(0, 1, 3);
    morph.raw = wave(1.0).iter().map(|v| v.abs() / 2.0).collect();
    let mut tracks = vec![
        float,
        morph,
        keyed(
            TrackKind::Event,
            vec![
                key(0.0, 0.0, ev(0, 0.5, true)),
                key(0.5, 0.5, ev(1, 0.5, false)),
                key(0.6, 0.9, ev(2, 0.5, false)),
                key(1.0, 1.0, ev(1, 0.8, false)),
                key(1.5, 2.0, ev(3, 0.0, true)),
                key(2.0, 2.0, ev(4, 0.5, true)),
            ],
        ),
        keyed(TrackKind::Event, vec![key(0.5, 0.5, ev(5, 0.5, true))]),
        keyed(
            TrackKind::Marker,
            vec![
                key(
                    0.25,
                    0.25,
                    KeyData::Marker {
                        kind: MarkerKind::Sync,
                        name: 6,
                    },
                ),
                key(
                    1.25,
                    1.25,
                    KeyData::Marker {
                        kind: MarkerKind::Sync,
                        name: 7,
                    },
                ),
                key(
                    1.8,
                    1.8,
                    KeyData::Marker {
                        kind: MarkerKind::Cue,
                        name: 8,
                    },
                ),
            ],
        ),
        keyed(
            TrackKind::Audio,
            vec![key(
                0.3,
                0.8,
                KeyData::Audio {
                    asset: 9,
                    params: NONE,
                },
            )],
        ),
        keyed(
            TrackKind::Control,
            vec![key(
                1.1,
                1.1,
                KeyData::Control {
                    kind: ControlKind::ParticlePlay,
                    target: 0,
                    payload: NONE,
                },
            )],
        ),
        keyed(
            TrackKind::Activation,
            vec![
                key(0.2, 0.7, KeyData::Activation),
                key(1.4, 2.0, KeyData::Activation),
            ],
        ),
        keyed(
            TrackKind::Discrete,
            vec![
                key(0.1, 0.1, KeyData::Discrete { value: 10 }),
                key(0.4, 0.4, KeyData::Discrete { value: 11 }),
                key(0.8, 0.8, KeyData::Discrete { value: 12 }),
            ],
        ),
        keyed(
            TrackKind::Subclip,
            vec![key(
                0.5,
                1.5,
                KeyData::Subclip {
                    clip: 10,
                    offset: 0.25,
                    speed: 2.0,
                    blend_in: 0.2,
                    blend_out: 0.4,
                },
            )],
        ),
    ];
    // Enum payloads.
    tracks[t::DISCRETE].subtype = 1;
    let strings = [
        "node", "Comp", "value", "smile", "m0", "m1", "L", "R", "cue", "step.ogg", "sub.anim",
    ];
    Clip {
        flags: if looping { CLIP_LOOP } else { 0 },
        name: NONE,
        duration: D,
        sample_rate: 30.0,
        frame_count: frames,
        bone_count: 0,
        root_bone: NONE,
        strings: strings.iter().map(|s| s.to_string()).collect(),
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    }
}

fn bytes(looping: bool) -> Vec<u8> {
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    compress(&fixture(looping), None, &settings).unwrap().bytes
}

struct Fx {
    bytes: Vec<u8>,
}

impl Fx {
    fn new(looping: bool) -> Self {
        Fx {
            bytes: bytes(looping),
        }
    }
    fn view(&self) -> ClipView<'_> {
        ClipView::parse(&self.bytes).unwrap()
    }
    fn bindings(&self, form: Form) -> ClipBindings {
        ClipBindings::new(&ClipSampler::new(self.view(), form).unwrap())
    }
}

fn collect(f: impl FnOnce(&mut dyn FnMut(TrackRecord))) -> Vec<TrackRecord> {
    let mut out = Vec::new();
    f(&mut |r| out.push(r));
    out
}

fn crossings(b: &ClipBindings, w: Window, weight: f32) -> Vec<TrackRecord> {
    let mut out = Vec::new();
    b.crossings(&w, weight, &mut |r| out.push(r));
    out
}

/// (track, key, time) of crossing records.
fn cross_ids(rs: &[TrackRecord]) -> Vec<(usize, usize, f32)> {
    rs.iter()
        .filter_map(|r| match *r {
            TrackRecord::Event {
                track, key, time, ..
            }
            | TrackRecord::Marker {
                track, key, time, ..
            }
            | TrackRecord::Audio {
                track, key, time, ..
            }
            | TrackRecord::Control {
                track, key, time, ..
            } => Some((track as usize, key as usize, time)),
            _ => None,
        })
        .collect()
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f32(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (self.next() % 1_000_000) as f32 / 1_000_000.0 * (hi - lo)
    }
}

#[test]
fn crossings_match_the_reference() {
    let fx = Fx::new(true);
    let view = fx.view();
    let b = fx.bindings(Form::Compressed);
    let key_times: Vec<f64> = (0..view.track_count())
        .flat_map(|i| {
            view.track_keys(i)
                .map(|k| k.time as f64)
                .collect::<Vec<_>>()
        })
        .collect();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut checked = 0;
    for _ in 0..4000 {
        let looping = !rng.next().is_multiple_of(3);
        let start = rng.next().is_multiple_of(5);
        let from = rng.f32(-1.0, 3.0);
        let delta = match rng.next() % 4 {
            0 => rng.f32(-0.1, 0.1),
            1 => rng.f32(-1.0, 1.0),
            2 => rng.f32(-10.0, 10.0),
            _ => 0.0,
        };
        let weight = [0.0, 0.3, 0.5, 0.7, 0.9, 1.0][(rng.next() % 6) as usize];
        let w = Window::new(from, delta, looping).with(if start { WINDOW_START } else { 0 });
        let r = WindowRef {
            from: from as f64,
            delta: delta as f64,
            looping,
            start,
            seek: false,
        };
        // Skip windows whose ends sit within 1e-4 s of a key instance (f32 vs f64 rounding).
        let (a, bb, lp) = reference::window_span(&r, D as f64);
        let near = key_times.iter().any(|&t| {
            (-12..=12).any(|k: i64| {
                let u = t + if lp { k as f64 * D as f64 } else { 0.0 };
                (u - a).abs() < 1e-4 || (u - bb).abs() < 1e-4
            })
        });
        if near {
            continue;
        }
        let got = cross_ids(&crossings(&b, w, weight));
        let want: Vec<(usize, usize, f32)> = reference::crossed_keys(&view, &r, weight as f64)
            .iter()
            .map(|c| (c.track, c.key, c.time as f32))
            .collect();
        assert_eq!(got, want, "window {w:?} weight {weight}");
        checked += 1;
    }
    assert!(checked > 2500, "only {checked} windows checked");
}

#[test]
fn the_end_is_inclusive_and_the_start_exclusive() {
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    let ids = |w: Window| cross_ids(&crossings(&b, w, 1.0));
    // Forward (0.4, 0.5]: both 0.5 notifies, by track.
    assert_eq!(
        ids(Window::new(0.4, 0.1, false)),
        vec![(t::EVENTS, 1, 0.5), (t::EVENTS2, 6, 0.5)]
    );
    // The next window starts at 0.5 and doesn't cross them again.
    assert_eq!(ids(Window::new(0.5, 0.05, false)), vec![]);
    // Reverse [0.5, 0.6): 0.5 is crossed, in reverse order.
    assert_eq!(
        ids(Window::new(0.6, -0.1, false)),
        vec![(t::EVENTS2, 6, 0.5), (t::EVENTS, 1, 0.5)]
    );
    // Reverse from exactly 0.5: excluded.
    assert_eq!(ids(Window::new(0.5, -0.05, false)), vec![]);
    // Keys at the start fire only with WINDOW_START.
    assert_eq!(ids(Window::new(0.0, 0.05, false)), vec![]);
    assert_eq!(
        ids(Window::new(0.0, 0.05, false).with(WINDOW_START)),
        vec![(t::EVENTS, 0, 0.0)]
    );
    // Zero-length windows cross nothing, except exactly-at keys with WINDOW_START.
    assert_eq!(ids(Window::new(0.5, 0.0, false)), vec![]);
    assert_eq!(
        ids(Window::new(0.5, 0.0, false).with(WINDOW_START)),
        vec![(t::EVENTS, 1, 0.5), (t::EVENTS2, 6, 0.5)]
    );
    // The clip's end is reached and held: the key at 2.0 fires once.
    assert_eq!(
        ids(Window::new(1.95, 0.1, false)),
        vec![(t::EVENTS, 5, 2.0)]
    );
    assert_eq!(ids(Window::new(2.0, 0.1, false)), vec![]);
}

#[test]
fn loops_wrap_forward_and_backward() {
    let fx = Fx::new(true);
    let b = fx.bindings(Form::Compressed);
    let ids = |w: Window| cross_ids(&crossings(&b, w, 1.0));
    // Forward over the loop point: the end key, then the start key of the next cycle.
    assert_eq!(
        ids(Window::new(1.9, 0.2, true)),
        vec![(t::EVENTS, 5, 2.0), (t::EVENTS, 0, 0.0)]
    );
    assert!((Window::new(1.9, 0.2, true).end_time(D) - 0.1).abs() < 1e-6);
    // Backward over it: the start key, then the end key of the previous cycle.
    assert_eq!(
        ids(Window::new(0.1, -0.2, true)),
        vec![(t::EVENTS, 0, 0.0), (t::EVENTS, 5, 2.0)]
    );
    // The same window without looping stops at the start, crossing its key (as playing forward
    // into the end crosses the key at the end).
    assert_eq!(
        ids(Window::new(0.1, -0.2, false)),
        vec![(t::EVENTS, 0, 0.0)]
    );
    assert_eq!(ids(Window::new(0.0, -0.2, false)), vec![]);
    // Several cycles: each crossed key once per cycle.
    let many = ids(Window::new(0.0, 4.0 * D, true));
    let notify_05 = many.iter().filter(|c| c.0 == t::EVENTS2).count();
    assert_eq!(notify_05, 4);
    // Past MAX_WRAPS cycles the travel is capped.
    let capped = ids(Window::new(0.0, 100.0 * D, true));
    assert_eq!(capped, many);
    // `from` outside the clip wraps.
    assert_eq!(
        ids(Window::new(4.45, 0.1, true)),
        ids(Window::new(0.45, 0.1, true))
    );
    assert_eq!(
        ids(Window::new(-1.55, 0.1, true)),
        ids(Window::new(0.45, 0.1, true))
    );
}

#[test]
fn seeks_cross_nothing() {
    let fx = Fx::new(true);
    let b = fx.bindings(Form::Compressed);
    let w = Window::new(0.0, 1.9, true).with(WINDOW_SEEK);
    assert!(crossings(&b, w, 1.0).is_empty());
    // Nor do notify states begin.
    let mut open = vec![0u32; b.notify_words()];
    let rs = collect(|s| {
        b.notify_states(
            &Window::new(0.0, 0.7, true).with(WINDOW_SEEK),
            1.0,
            &mut open,
            s,
        )
    });
    assert!(rs.is_empty(), "{rs:?}");
    assert_eq!(open, vec![0]);
}

#[test]
fn notifies_are_gated_by_weight() {
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    let w = Window::new(0.0, 2.0, false).with(WINDOW_START);
    let methods = |weight: f32| -> Vec<u32> {
        crossings(&b, w, weight)
            .iter()
            .filter_map(|r| match r {
                TrackRecord::Event { method, .. } => Some(*method),
                _ => None,
            })
            .collect()
    };
    // Thresholds: 0.0 key always, 0.5 key 0.5, 0.5 always (other track), 1.0 key 0.8, 2.0 always.
    assert_eq!(methods(1.0), vec![0, 1, 5, 1, 4]);
    assert_eq!(methods(0.9), vec![0, 1, 5, 1, 4]);
    assert_eq!(
        methods(0.8),
        vec![0, 1, 5, 4],
        "the weight must exceed the threshold"
    );
    assert_eq!(methods(0.51), vec![0, 1, 5, 4]);
    assert_eq!(methods(0.5), vec![0, 5, 4]);
    assert_eq!(methods(0.0), vec![0, 5, 4]);
    assert_eq!(methods(f32::NAN), vec![0, 5, 4]);
    // Audio and control fire above weight 0; markers always.
    let kinds = |weight: f32| -> (usize, usize, usize) {
        let rs = crossings(&b, w, weight);
        let n = |f: fn(&TrackRecord) -> bool| rs.iter().filter(|r| f(r)).count();
        (
            n(|r| matches!(r, TrackRecord::Audio { .. })),
            n(|r| matches!(r, TrackRecord::Control { .. })),
            n(|r| matches!(r, TrackRecord::Marker { .. })),
        )
    };
    assert_eq!(kinds(0.01), (1, 1, 3));
    assert_eq!(kinds(0.0), (0, 0, 3));
    // Records carry the weight and payloads.
    let rs = crossings(&b, w, 0.25);
    assert!(rs.contains(&TrackRecord::Audio {
        track: t::AUDIO as u32,
        key: 10,
        asset: 9,
        params: NONE,
        time: 0.3,
        duration: 0.5,
        weight: 0.25,
    }));
    assert!(rs.contains(&TrackRecord::Control {
        track: t::CONTROL as u32,
        key: 11,
        kind: ControlKind::ParticlePlay,
        target: 0,
        payload: NONE,
        time: 1.1,
        duration: 0.0,
        weight: 0.25,
    }));
}

/// (method, phase, time) of notify-state records.
fn phases(rs: &[TrackRecord]) -> Vec<(u32, NotifyPhase, f32)> {
    rs.iter()
        .filter_map(|r| match *r {
            TrackRecord::NotifyState {
                method,
                phase,
                time,
                ..
            } => Some((method, phase, time)),
            _ => None,
        })
        .collect()
}

/// Plays `steps` windows of `dt` from `from` (the first with WINDOW_START) at the weights given
/// per step, returning every notify-state record.
fn play(
    b: &ClipBindings,
    looping: bool,
    from: f32,
    dt: f32,
    weights: &[f32],
    open: &mut [u32],
) -> (Vec<(u32, NotifyPhase, f32)>, f32) {
    let mut out = Vec::new();
    let mut t = from;
    for (i, &weight) in weights.iter().enumerate() {
        let w = Window::new(t, dt, looping).with(if i == 0 { WINDOW_START } else { 0 });
        b.notify_states(&w, weight, open, &mut |r| out.push(r));
        t = w.end_time(b.duration());
    }
    (phases(&out), t)
}

#[test]
fn notify_states_begin_tick_and_end() {
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    assert_eq!(b.notify_state_count(), 2);
    let mut open = vec![0u32; b.notify_words()];
    // 0.5 → 1.0 in 0.1 steps: the 0.6–0.9 state begins at 0.6 on the window that reaches it,
    // ticks while inside, and ends at 0.9.
    let (seq, _) = play(&b, false, 0.5, 0.1, &[1.0; 5], &mut open);
    let only2: Vec<_> = seq.iter().filter(|s| s.0 == 2).map(|s| s.1).collect();
    assert_eq!(
        only2,
        vec![
            NotifyPhase::Begin,
            NotifyPhase::Tick,
            NotifyPhase::Tick,
            NotifyPhase::End
        ]
    );
    assert_eq!(seq[0], (2, NotifyPhase::Begin, 0.6));
    assert_eq!(seq.last().unwrap().1, NotifyPhase::End);
    assert!((seq.last().unwrap().2 - 0.9).abs() < 1e-6);
    assert_eq!(open, vec![0]);

    // Crossed within one window: begin then end.
    let (seq, _) = play(&b, false, 0.55, 0.5, &[1.0], &mut open);
    assert_eq!(
        seq,
        vec![(2, NotifyPhase::Begin, 0.6), (2, NotifyPhase::End, 0.9)]
    );

    // Reverse: enters at its end, ticks inside, leaves at its start.
    let (seq, _) = play(&b, false, 1.0, -0.2, &[1.0, 1.0, 1.0], &mut open);
    let want = [
        (NotifyPhase::Begin, 0.9),
        (NotifyPhase::Tick, 0.6),
        (NotifyPhase::End, 0.6),
    ];
    assert_eq!(seq.len(), want.len(), "{seq:?}");
    for (g, w) in seq.iter().zip(want) {
        assert_eq!(g.1, w.0, "{seq:?}");
        assert!((g.2 - w.1).abs() < 1e-6, "{seq:?}");
    }
    assert_eq!(open, vec![0]);
}

#[test]
fn notify_states_follow_the_weight_and_interrupts() {
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    let mut open = vec![0u32; b.notify_words()];
    // Inside the 0.6–0.9 state (threshold 0.5): the weight falls to 0.5, then rises again.
    let (seq, t) = play(&b, false, 0.6, 0.05, &[1.0, 1.0, 0.5, 0.4, 0.6], &mut open);
    assert_eq!(
        seq.iter().map(|s| s.1).collect::<Vec<_>>(),
        vec![
            NotifyPhase::Begin, // starts inside at 0.6 (WINDOW_START)
            NotifyPhase::Tick,
            NotifyPhase::End,   // weight 0.5: not above 0.5
            NotifyPhase::Begin, // weight 0.6 inside: begins where the window started
        ]
    );
    assert!(
        (seq[2].2 - 0.75).abs() < 1e-6,
        "ends at the window's end: {seq:?}"
    );
    assert!(
        (seq[3].2 - 0.8).abs() < 1e-6,
        "begins at the window's start: {seq:?}"
    );
    assert!((t - 0.85).abs() < 1e-6);
    assert_eq!(open, vec![1]);
    // The play is interrupted: every open state ends.
    let rs = collect(|s| b.end_notify_states(0.85, 0.7, &mut open, s));
    assert_eq!(phases(&rs), vec![(2, NotifyPhase::End, 0.85)]);
    assert_eq!(open, vec![0]);
    // Ending again does nothing.
    assert!(collect(|s| b.end_notify_states(0.85, 0.7, &mut open, s)).is_empty());

    // A zero-length window (paused) inside an open state ticks it.
    let (seq, _) = play(&b, false, 0.7, 0.0, &[1.0, 1.0], &mut open);
    assert_eq!(
        seq.iter().map(|s| s.1).collect::<Vec<_>>(),
        vec![NotifyPhase::Begin, NotifyPhase::Tick]
    );
    // A seek out of it ends it; a seek into it begins nothing.
    let rs = collect(|s| {
        b.notify_states(
            &Window::new(0.7, 0.5, false).with(WINDOW_SEEK),
            1.0,
            &mut open,
            s,
        )
    });
    assert_eq!(phases(&rs), vec![(2, NotifyPhase::End, 1.2)]);
    let rs = collect(|s| {
        b.notify_states(
            &Window::new(1.2, -0.5, false).with(WINDOW_SEEK),
            1.0,
            &mut open,
            s,
        )
    });
    assert!(rs.is_empty());
    // The next plain window inside begins it where it started.
    let rs = collect(|s| b.notify_states(&Window::new(0.7, 0.05, false), 1.0, &mut open, s));
    assert_eq!(phases(&rs), vec![(2, NotifyPhase::Begin, 0.7)]);
}

#[test]
fn always_states_and_loops() {
    let fx = Fx::new(true);
    let b = fx.bindings(Form::Compressed);
    let mut open = vec![0u32; b.notify_words()];
    // The 1.5–2.0 state is `always`: weight 0 still runs it. Looping 1.4 → 2.1 → ...
    let (seq, _) = play(&b, true, 1.4, 0.35, &[0.0, 0.0, 0.0], &mut open);
    // 1.4→1.75: begin at 1.5; 1.75→2.1(0.1): end at 2.0; 0.1→0.45: nothing.
    assert_eq!(
        seq,
        vec![(3, NotifyPhase::Begin, 1.5), (3, NotifyPhase::End, 2.0)]
    );
    // A window over several cycles: begin and end once per cycle crossed.
    let rs = collect(|s| b.notify_states(&Window::new(0.0, 2.0 * D, true), 0.0, &mut open, s));
    let three: Vec<_> = phases(&rs)
        .iter()
        .filter(|s| s.0 == 3)
        .map(|s| s.1)
        .collect();
    assert_eq!(
        three,
        vec![
            NotifyPhase::Begin,
            NotifyPhase::End,
            NotifyPhase::Begin,
            NotifyPhase::End
        ]
    );
}

#[test]
fn activation_levels_and_edges() {
    for looping in [false, true] {
        let fx = Fx::new(looping);
        let view = fx.view();
        let b = fx.bindings(Form::Raw);
        let mut rng = Rng(7);
        for _ in 0..500 {
            let t = rng.f32(0.0, D);
            assert_eq!(
                b.active_at(t::ACTIVATION, t, !looping),
                reference::active_at(&view, t::ACTIVATION, t as f64, !looping),
                "t {t}"
            );
        }
        // Range ends are exclusive; the clip's end is held when not looping.
        assert!(b.active_at(t::ACTIVATION, 0.2, false));
        assert!(!b.active_at(t::ACTIVATION, 0.7, false));
        assert!(b.active_at(t::ACTIVATION, D, true));
        assert!(!b.active_at(t::ACTIVATION, D, false));
        assert!(
            !b.active_at(t::FLOAT, 0.3, false),
            "not an activation track"
        );
    }
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    let edges = |w: Window| -> Vec<(bool, i32)> {
        collect(|s| b.activation_edges(&w, s))
            .iter()
            .map(|r| match *r {
                TrackRecord::Activation {
                    track,
                    active,
                    time,
                } => {
                    assert_eq!(track as usize, t::ACTIVATION);
                    (active, (time * 1000.0).round() as i32)
                }
                _ => panic!("{r:?}"),
            })
            .collect()
    };
    assert_eq!(edges(Window::new(0.1, 0.2, false)), vec![(true, 300)]);
    assert_eq!(edges(Window::new(0.3, 0.2, false)), vec![]);
    assert_eq!(edges(Window::new(0.6, 0.2, false)), vec![(false, 800)]);
    // A range passed over within one window changes nothing visible.
    assert_eq!(edges(Window::new(0.1, 0.8, false)), vec![]);
    // The first window of a play starts from off; seeks report level changes too.
    assert_eq!(
        edges(Window::new(0.3, 0.0, false).with(WINDOW_START)),
        vec![(true, 300)]
    );
    assert_eq!(
        edges(Window::new(0.3, 1.0, false).with(WINDOW_SEEK)),
        vec![(false, 1300)]
    );
    // Held at the end of a non-looping play.
    assert_eq!(edges(Window::new(1.9, 0.5, false)), vec![]);
}

#[test]
fn discrete_payloads() {
    let fx = Fx::new(false);
    let view = fx.view();
    let b = fx.bindings(Form::Raw);
    let mut rng = Rng(11);
    for _ in 0..500 {
        let t = rng.f32(-0.5, 2.5);
        assert_eq!(
            b.discrete_at(t::DISCRETE, t),
            reference::discrete_at(&view, t::DISCRETE, t as f64),
            "t {t}"
        );
    }
    assert_eq!(
        b.discrete_at(t::DISCRETE, 0.0),
        Some(10),
        "before the first key"
    );
    assert_eq!(b.discrete_at(t::DISCRETE, 0.4), Some(11), "at a key");
    assert_eq!(b.discrete_at(t::DISCRETE, 0.79), Some(11));
    assert_eq!(b.discrete_at(t::DISCRETE, 2.0), Some(12));
    assert_eq!(b.discrete_at(t::FLOAT, 0.0), None);
}

/// (flags, local time, local delta, weight).
type SubState = (u32, f32, f32, f32);

fn subclip(rs: &[TrackRecord]) -> Vec<SubState> {
    rs.iter()
        .map(|r| match *r {
            TrackRecord::Subclip {
                track,
                key,
                clip,
                flags,
                local_time,
                local_delta,
                weight,
            } => {
                assert_eq!((track as usize, key, clip), (t::SUBCLIP, 17, 10));
                (flags, local_time, local_delta, weight)
            }
            _ => panic!("{r:?}"),
        })
        .collect()
}

fn close(a: SubState, b: SubState) -> bool {
    a.0 == b.0 && (a.1 - b.1).abs() < 1e-5 && (a.2 - b.2).abs() < 1e-5 && (a.3 - b.3).abs() < 1e-5
}

#[test]
fn subclip_states() {
    let fx = Fx::new(false);
    let b = fx.bindings(Form::Raw);
    let st = |w: Window| subclip(&collect(|s| b.subclips(&w, s)));
    // Entry [0.5, 1.5): offset 0.25, speed 2, blend in 0.2, blend out 0.4.
    let cases: Vec<(Window, Vec<SubState>)> = vec![
        (Window::new(0.3, 0.1, false), vec![]),
        // Entered: from its start (local 0.25) to 0.6 (local 0.45); blend in half way.
        (
            Window::new(0.4, 0.2, false),
            vec![(SUBCLIP_ENTERED, 0.45, 0.2, 0.5)],
        ),
        // Inside: full weight.
        (Window::new(0.6, 0.1, false), vec![(0, 0.65, 0.2, 1.0)]),
        // Blending out: 0.2 s before the end, half way.
        (Window::new(1.2, 0.1, false), vec![(0, 1.85, 0.2, 0.5)]),
        // Left: at its end (local 2.25), weight 0.
        (
            Window::new(1.4, 0.2, false),
            vec![(SUBCLIP_EXITED, 2.25, 0.2, 0.0)],
        ),
        // Passed over in one window.
        (
            Window::new(0.0, 2.0, false),
            vec![(SUBCLIP_ENTERED | SUBCLIP_EXITED, 2.25, 2.0, 0.0)],
        ),
        // Reverse: entered at its end.
        (
            Window::new(1.6, -0.2, false),
            vec![(SUBCLIP_ENTERED, 2.05, -0.2, 0.25)],
        ),
        // Paused inside: no travel.
        (Window::new(1.0, 0.0, false), vec![(0, 1.25, 0.0, 1.0)]),
        // A play starting inside: entered at the window's start.
        (
            Window::new(1.0, 0.1, false).with(WINDOW_START),
            vec![(SUBCLIP_ENTERED, 1.45, 0.2, 1.0)],
        ),
    ];
    for (w, want) in cases {
        let got = st(w);
        assert_eq!(got.len(), want.len(), "{w:?}: {got:?}");
        for (g, x) in got.iter().zip(&want) {
            assert!(close(*g, *x), "{w:?}: got {g:?}, want {x:?}");
        }
    }
    // Looping: entered again after the loop point.
    let fx = Fx::new(true);
    let b = fx.bindings(Form::Raw);
    let got = subclip(&collect(|s| b.subclips(&Window::new(1.4, 1.2, true), s)));
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].0, SUBCLIP_EXITED);
    assert_eq!(got[1].0, SUBCLIP_ENTERED);
}

#[test]
fn sync_markers_and_phase() {
    let fx = Fx::new(true);
    let b = fx.bindings(Form::Compressed);
    let m: Vec<(u32, f32)> = b.sync_markers().iter().map(|m| (m.id, m.time)).collect();
    assert_eq!(m, vec![(6, 0.25), (7, 1.25)]);
    let p = b.sync_phase(0.75, true);
    assert_eq!((p.marker, p.id), (0, 6));
    assert!((p.fraction - 0.5).abs() < 1e-6);
    // Wrapping: before the first marker of a loop lies in the last segment.
    let p = b.sync_phase(0.0, true);
    assert_eq!((p.marker, p.id), (1, 7));
}

#[test]
fn columns_hold_values_discrete_and_activation() {
    for form in [Form::Raw, Form::Compressed] {
        let fx = Fx::new(false);
        let view = fx.view();
        let sampler = ClipSampler::new(view, form).unwrap();
        let b = ClipBindings::new(&sampler);
        let bound = b.bind(&sampler).unwrap();
        let cols: Vec<_> = b.columns().collect();
        assert_eq!(
            cols.iter()
                .map(|c| (c.track as usize, c.ty, c.offset, c.width))
                .collect::<Vec<_>>(),
            vec![
                (t::FLOAT, ColumnType::F32, 0, 1),
                (t::MORPH, ColumnType::F32, 1, 1),
                (t::ACTIVATION, ColumnType::U32, 2, 1),
                (t::DISCRETE, ColumnType::U32, 3, 1),
            ]
        );
        assert_eq!(b.column_words(), 4);
        assert!(b.column(t::EVENTS).is_none());
        let mut words = vec![0u32; 4];
        let mut rng = Rng(5);
        for _ in 0..200 {
            let t = rng.f32(0.0, D);
            assert!(bound.sample_columns(t, true, &mut words));
            for track in [t::FLOAT, t::MORPH] {
                let mut v = [0.0f32; 1];
                bound.sample_track(track, t, &mut v);
                assert_eq!(words[track], v[0].to_bits(), "track {track} t {t}");
                // The same value as the unbound sampler, bit for bit.
                let mut u = [0.0f32; 1];
                sampler.sample_track(track, t, &mut u);
                assert_eq!(v[0].to_bits(), u[0].to_bits());
            }
            assert_eq!(words[2], b.active_at(t::ACTIVATION, t, true) as u32);
            assert_eq!(Some(words[3]), b.discrete_at(t::DISCRETE, t));
        }
        let mut short = vec![7u32; 3];
        assert!(!bound.sample_columns(0.5, true, &mut short));
        assert_eq!(short, vec![7; 3]);
    }
}

#[test]
fn evaluate_runs_every_kind_in_order_and_deterministically() {
    let fx = Fx::new(true);
    let sampler = ClipSampler::new(fx.view(), Form::Compressed).unwrap();
    let b = ClipBindings::new(&sampler);
    let bound = b.bind(&sampler).unwrap();
    let run = || {
        let mut open = vec![0u32; b.notify_words()];
        let mut words = vec![0u32; b.column_words()];
        let mut out = Vec::new();
        let mut t = 0.0f32;
        for i in 0..200 {
            let speed = if i % 50 < 40 { 1.0 } else { -1.5 };
            let w = Window::new(t, speed / 30.0, true).with(if i == 0 { WINDOW_START } else { 0 });
            let weight = 0.4 + (i % 7) as f32 * 0.1;
            t = bound.evaluate(&w, weight, &mut open, &mut words, &mut |r| out.push(r));
            out.push(TrackRecord::Activation {
                track: u32::MAX,
                active: false,
                time: f32::from_bits(words[0]),
            });
        }
        out
    };
    let a = run();
    let bb = run();
    assert_eq!(a.len(), bb.len());
    for (x, y) in a.iter().zip(&bb) {
        assert_eq!(format!("{x:?}"), format!("{y:?}"));
    }
    // Within one window: crossings, then notify states, then activation edges, then subclips.
    let mut open = vec![0u32; b.notify_words()];
    let mut words = vec![0u32; b.column_words()];
    let rank = |r: &TrackRecord| match r {
        TrackRecord::Event { .. }
        | TrackRecord::Marker { .. }
        | TrackRecord::Audio { .. }
        | TrackRecord::Control { .. } => 0,
        TrackRecord::NotifyState { .. } => 1,
        TrackRecord::Activation { .. } => 2,
        TrackRecord::Subclip { .. } => 3,
    };
    let rs = collect(|s| {
        bound.evaluate(
            &Window::new(0.0, 0.65, true).with(WINDOW_START),
            1.0,
            &mut open,
            &mut words,
            s,
        );
    });
    let ranks: Vec<_> = rs.iter().map(rank).collect();
    assert!(ranks.windows(2).all(|p| p[0] <= p[1]), "{rs:?}");
    assert!(ranks.contains(&0) && ranks.contains(&1) && ranks.contains(&2) && ranks.contains(&3));
}

#[test]
fn bindings_refuse_another_clip() {
    let fx = Fx::new(false);
    let raw = ClipSampler::new(fx.view(), Form::Raw).unwrap();
    let comp = ClipSampler::new(fx.view(), Form::Compressed).unwrap();
    let b = ClipBindings::new(&raw);
    assert!(matches!(b.bind(&comp), Err(SampleError::Bindings)));
    let mut other = fixture(false);
    other.tracks.pop();
    let other = other.write().unwrap();
    let ov = ClipView::parse(&other).unwrap();
    assert!(matches!(
        b.bind(&ClipSampler::new(ov, Form::Raw).unwrap()),
        Err(SampleError::Bindings)
    ));
    assert!(b.bind(&raw).is_ok());
}
