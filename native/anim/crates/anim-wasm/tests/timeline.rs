//! Timeline instances through the core's calls and views (`anim-wire` family `timeline`): a clip
//! used as a timeline (root columns, keyed-track records, subclip entries with offset and speed,
//! crossfades, nested timelines), sequences of tweens, wrap modes, seeks, stop, kill and
//! destroyed. Times are binary fractions; values from compressed clips are compared at 1e-3
//! (the compressor's default error is far below that on these ramps).

mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ControlKind, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_wasm::init::Core;
use anim_wire::core::{
    PASS_NORMAL, STATUS_BAD_RECORD, STATUS_FULL, STATUS_OK, STATUS_STALE_HANDLE,
};
use anim_wire::timeline::*;
use anim_wire::tracks;
use anim_wire::tween::{EASE_LINEAR, FLAG_YOYO, KIND_VALUE, LOOPS_INFINITE, TIME_FIXED};
use anim_wire::WireRecord;
use common::core;

const TOL: f32 = 1e-3;

// ---- Building clips ----

fn key(time: f32, end: f32, data: KeyData) -> Key {
    Key { time, end, data }
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

fn frames(duration: f32) -> usize {
    (duration * 30.0).round() as usize + 1
}

/// A float track `value = base + slope · t`.
fn ramp(duration: f32, base: f32, slope: f32) -> Track {
    let mut t = keyed(TrackKind::Float, Vec::new());
    t.binding = Binding::property(0, 1, 2);
    t.raw = (0..frames(duration))
        .map(|f| base + slope * f as f32 / 30.0)
        .collect();
    t
}

fn notify(at: f32) -> Key {
    key(
        at,
        at,
        KeyData::Event {
            method: 0,
            args: NONE,
            threshold: 0.0,
            always: true,
        },
    )
}

fn state(from: f32, to: f32) -> Key {
    key(
        from,
        to,
        KeyData::Event {
            method: 0,
            args: NONE,
            threshold: 0.0,
            always: true,
        },
    )
}

fn sub(
    time: f32,
    end: f32,
    clip: u32,
    offset: f32,
    speed: f32,
    blend_in: f32,
    blend_out: f32,
) -> Key {
    key(
        time,
        end,
        KeyData::Subclip {
            clip,
            offset,
            speed,
            blend_in,
            blend_out,
        },
    )
}

fn clip_bytes(duration: f32, tracks: Vec<Track>) -> Vec<u8> {
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration,
        sample_rate: 30.0,
        frame_count: frames(duration) as u32,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["a".into(), "b".into(), "c".into()],
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

// ---- Driving the core ----

fn spec() -> TimelineCreate {
    TimelineCreate {
        world: 0,
        host_id: 100,
        clip: 0,
        time_mode: 0,
        wrap: WRAP_ONCE,
        flags: FLAG_PLAY,
        speed: 1.0,
        start: 0.0,
    }
}

fn create(core: &mut Core, c: &TimelineCreate) -> u32 {
    let h = core.timeline_create(&c.encode());
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    h
}

fn control(core: &mut Core, handle: u32, op: u32, value: f32) -> u32 {
    core.timeline_control(&TimelineControl { handle, op, value }.encode())
}

fn frame(core: &mut Core, dt: f32) {
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, dt, dt);
}

/// The frame's `tracks` records as (opcode, bytes).
fn records(core: &Core) -> Vec<(u16, Vec<u8>)> {
    let (bytes, count, dropped) = core.timelines().records();
    assert_eq!(dropped, 0);
    let mut at = 0;
    let mut out = Vec::new();
    while at < bytes.len() {
        let op = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
        let d = tracks::FAMILY
            .records
            .iter()
            .find(|d| d.opcode == op)
            .unwrap();
        out.push((op, bytes[at..at + d.stride as usize].to_vec()));
        at += d.stride as usize;
    }
    assert_eq!(out.len(), count as usize);
    out
}

fn events(core: &Core) -> Vec<tracks::Event> {
    records(core)
        .iter()
        .filter(|(op, _)| *op == tracks::Event::OPCODE)
        .map(|(_, b)| tracks::Event::decode(b).unwrap())
        .collect()
}

fn states(core: &Core) -> Vec<tracks::NotifyState> {
    records(core)
        .iter()
        .filter(|(op, _)| *op == tracks::NotifyState::OPCODE)
        .map(|(_, b)| tracks::NotifyState::decode(b).unwrap())
        .collect()
}

fn changes(core: &Core) -> Vec<TimelineChange> {
    let t = core.timelines();
    let stride = TimelineChange::STRIDE as usize;
    (0..t.change_count())
        .map(|i| TimelineChange::decode(&t.changes()[i * stride..]).unwrap())
        .collect()
}

fn active(core: &Core) -> Vec<u32> {
    core.timelines().active()[..core.timelines().active_count()].to_vec()
}

/// An instance's outputs, resolved after any binding.
struct Out {
    info: TimelineInfo,
    blocks: Vec<TimelineBlock>,
}

impl Out {
    fn new(core: &Core, h: u32) -> Out {
        let info = core.timelines().info(h).expect("live instance");
        let mut bytes = vec![0u8; core.timeline_block_bytes(h) as usize];
        assert_eq!(core.timeline_blocks(h, &mut bytes) as usize, bytes.len());
        let blocks = bytes
            .chunks(TimelineBlock::STRIDE as usize)
            .map(|c| TimelineBlock::decode(c).unwrap())
            .collect();
        Out { info, blocks }
    }
    fn word(&self, core: &Core, block: usize, i: usize) -> u32 {
        let b = &self.blocks[block];
        assert!((i as u32) < b.words);
        core.timelines().values()[(self.info.value_offset + b.offset) as usize + i]
    }
    fn f(&self, core: &Core, block: usize, i: usize) -> f32 {
        f32::from_bits(self.word(core, block, i))
    }
    fn weight(&self, core: &Core, block: usize) -> f32 {
        core.timelines().weights()[self.info.weight_offset as usize + block]
    }
}

fn near(a: f32, b: f32) {
    assert!((a - b).abs() <= TOL, "{a} vs {b}");
}

// ---- A clip used as a timeline ----

/// Duration 4: a ramp `value = t`, a notify at 1, a control at 2, an audio key at 3 and an
/// activation range [1, 3).
fn tracks_clip() -> Vec<u8> {
    clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![notify(1.0)]),
            keyed(
                TrackKind::Control,
                vec![key(
                    2.0,
                    2.0,
                    KeyData::Control {
                        kind: ControlKind::ParticlePlay,
                        target: 1,
                        payload: NONE,
                    },
                )],
            ),
            keyed(
                TrackKind::Audio,
                vec![key(
                    3.0,
                    3.0,
                    KeyData::Audio {
                        asset: 2,
                        params: NONE,
                    },
                )],
            ),
            keyed(
                TrackKind::Activation,
                vec![key(1.0, 3.0, KeyData::Activation)],
            ),
        ],
    )
}

#[test]
fn a_timeline_clip_writes_columns_and_every_keyed_record_once() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&tracks_clip());
    assert_ne!(clip, 0);
    let h = create(&mut core, &TimelineCreate { clip, ..spec() });
    let out = Out::new(&core, h);
    assert_eq!(out.blocks.len(), 1);
    assert_eq!(out.blocks[0].kind, BLOCK_ROOT);
    let mut ops = Vec::new();
    for step in 1..=16 {
        frame(&mut core, 0.25);
        assert_eq!(active(&core), [h], "evaluated every frame");
        if step < 16 {
            near(out.f(&core, 0, 0), step as f32 * 0.25);
        }
        assert_eq!(out.weight(&core, 0), 1.0);
        for (op, _) in records(&core) {
            ops.push((step, op));
        }
    }
    let at = |op: u16| -> Vec<usize> {
        ops.iter()
            .filter(|(_, o)| *o == op)
            .map(|(s, _)| *s)
            .collect()
    };
    assert_eq!(
        at(tracks::Event::OPCODE),
        [4],
        "the notify at 1.0 fires on the frame reaching it"
    );
    assert_eq!(at(tracks::Control::OPCODE), [8]);
    assert_eq!(at(tracks::Audio::OPCODE), [12]);
    // The activation range [1, 3) turns on at step 4 and off at step 12.
    assert_eq!(at(tracks::ActivationEdge::OPCODE), [4, 12]);
    // The last frame reached the end: finished, retired.
    let ch = changes(&core);
    assert_eq!(ch.len(), 1);
    assert_eq!(
        (ch[0].kind, ch[0].host_id, ch[0].instance),
        (CHANGE_FINISHED, 100, h)
    );
    assert!(
        core.timelines().info(h).is_none(),
        "once retires the instance"
    );
    assert_eq!(control(&mut core, h, OP_PLAY, 0.0), STATUS_STALE_HANDLE);
}

#[test]
fn records_name_their_instance_and_clip() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&tracks_clip());
    let h = create(&mut core, &TimelineCreate { clip, ..spec() });
    for _ in 0..4 {
        frame(&mut core, 0.25);
    }
    let e = events(&core);
    assert_eq!(e.len(), 1);
    assert_eq!((e[0].instance, e[0].clip, e[0].time), (h, clip, 1.0));
}

// ---- Seeks, stop, pause ----

#[test]
fn a_seek_fires_no_event_and_playback_continues_from_there() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&tracks_clip());
    let h = create(
        &mut core,
        &TimelineCreate {
            clip,
            flags: 0,
            ..spec()
        },
    );
    // Created paused: shown once at the start, without events.
    frame(&mut core, 0.25);
    let out = Out::new(&core, h);
    assert_eq!(active(&core), [h]);
    near(out.f(&core, 0, 0), 0.0);
    assert!(records(&core).is_empty());
    // Not playing, not evaluated.
    frame(&mut core, 0.25);
    assert!(active(&core).is_empty());
    // Seek past the notify, the control and the audio key: nothing fires, the level follows.
    assert_eq!(control(&mut core, h, OP_SEEK, 3.5), STATUS_OK);
    frame(&mut core, 0.25);
    assert!(records(&core).is_empty(), "a seek fires nothing");
    near(out.f(&core, 0, 0), 3.5);
    // The activation level followed (an edge is a change of level over the seek, reported).
    // Backwards seek: nothing either.
    control(&mut core, h, OP_SEEK, 0.5);
    frame(&mut core, 0.25);
    assert!(records(&core)
        .iter()
        .all(|(op, _)| *op == tracks::ActivationEdge::OPCODE));
    near(out.f(&core, 0, 0), 0.5);
    // Playing from 0.5 reaches the notify at 1.0 once.
    control(&mut core, h, OP_PLAY, 0.0);
    let mut fired = 0;
    for _ in 0..4 {
        frame(&mut core, 0.25);
        fired += events(&core).len();
    }
    assert_eq!(fired, 1);
}

#[test]
fn a_seek_ends_open_notify_states_and_never_begins_one() {
    let clip = clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![state(1.5, 2.5)]),
        ],
    );
    let mut core = core(4, 16);
    let c = core.load_clip(&clip);
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: c,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    let mut phases = Vec::new();
    for _ in 0..8 {
        frame(&mut core, 0.25);
        phases.extend(states(&core).iter().map(|s| s.phase));
    }
    // t = 2.0 now: begun at 1.5, ticking.
    assert_eq!(phases[0], tracks::PHASE_BEGIN);
    assert!(phases[1..].iter().all(|p| *p == tracks::PHASE_TICK));
    control(&mut core, h, OP_PAUSE, 0.0);
    control(&mut core, h, OP_SEEK, 3.5);
    frame(&mut core, 0.25);
    let s = states(&core);
    assert_eq!(
        s.iter().map(|s| s.phase).collect::<Vec<_>>(),
        [tracks::PHASE_END],
        "end follows begin"
    );
    // Seeking into the state begins nothing.
    control(&mut core, h, OP_SEEK, 2.0);
    frame(&mut core, 0.25);
    assert!(states(&core).is_empty());
}

#[test]
fn stop_ends_states_rewinds_and_stays_stopped() {
    let clip = clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![state(0.5, 3.0)]),
        ],
    );
    let mut core = core(4, 16);
    let c = core.load_clip(&clip);
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: c,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    for _ in 0..4 {
        frame(&mut core, 0.25);
    }
    let out = Out::new(&core, h);
    near(out.f(&core, 0, 0), 1.0);
    control(&mut core, h, OP_STOP, 0.0);
    frame(&mut core, 0.25);
    assert_eq!(
        states(&core).iter().map(|s| s.phase).collect::<Vec<_>>(),
        [tracks::PHASE_END]
    );
    near(out.f(&core, 0, 0), 0.0);
    frame(&mut core, 0.25);
    assert!(
        active(&core).is_empty(),
        "stopped instances are not evaluated"
    );
    // Play starts again from 0, with the start point included.
    control(&mut core, h, OP_PLAY, 0.0);
    frame(&mut core, 0.5);
    assert_eq!(states(&core)[0].phase, tracks::PHASE_BEGIN);
}

#[test]
fn pause_holds_the_playhead_and_speed_scales_it() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&tracks_clip());
    let h = create(
        &mut core,
        &TimelineCreate {
            clip,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    let out = Out::new(&core, h);
    frame(&mut core, 0.5);
    near(out.f(&core, 0, 0), 0.5);
    control(&mut core, h, OP_PAUSE, 0.0);
    frame(&mut core, 0.5);
    assert!(active(&core).is_empty());
    control(&mut core, h, OP_SET_SPEED, 2.0);
    control(&mut core, h, OP_PLAY, 0.0);
    frame(&mut core, 0.5);
    near(out.f(&core, 0, 0), 1.5);
    control(&mut core, h, OP_SET_SPEED, -1.0);
    frame(&mut core, 0.5);
    near(out.f(&core, 0, 0), 1.0);
}

// ---- Wrap modes ----

fn wrap_clip() -> Vec<u8> {
    clip_bytes(
        2.0,
        vec![
            ramp(2.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![notify(1.0)]),
        ],
    )
}

fn run_wrap(wrap: u32, frames_n: usize, dt: f32) -> (Core, u32, Vec<usize>, Vec<u32>) {
    let mut core = core(4, 16);
    let clip = core.load_clip(&wrap_clip());
    let h = create(
        &mut core,
        &TimelineCreate {
            clip,
            wrap,
            ..spec()
        },
    );
    let mut fired = Vec::new();
    let mut kinds = Vec::new();
    for step in 1..=frames_n {
        frame(&mut core, dt);
        fired.extend(events(&core).iter().map(|_| step));
        kinds.extend(changes(&core).iter().map(|c| c.kind));
    }
    (core, h, fired, kinds)
}

#[test]
fn once_finishes_and_retires() {
    let (core, h, fired, kinds) = run_wrap(WRAP_ONCE, 8, 0.5);
    assert_eq!(fired, [2]);
    assert_eq!(kinds, [CHANGE_FINISHED]);
    assert!(core.timelines().info(h).is_none());
}

#[test]
fn hold_finishes_once_and_stays_at_the_end_until_played_again() {
    let (mut core, h, fired, kinds) = run_wrap(WRAP_HOLD, 8, 0.5);
    assert_eq!(fired, [2]);
    assert_eq!(kinds, [CHANGE_FINISHED]);
    assert!(core.timelines().info(h).is_some(), "alive");
    let out = Out::new(&core, h);
    near(out.f(&core, 0, 0), 2.0);
    // Play restarts from 0.
    control(&mut core, h, OP_PLAY, 0.0);
    let mut again = 0;
    for _ in 0..4 {
        frame(&mut core, 0.5);
        again += events(&core).len();
    }
    assert_eq!(again, 1);
}

#[test]
fn loop_wraps_and_fires_its_keys_each_cycle() {
    let (core, h, fired, kinds) = run_wrap(WRAP_LOOP, 8, 0.5);
    assert_eq!(fired, [2, 6]);
    assert_eq!(kinds, [CHANGE_LOOPED, CHANGE_LOOPED]);
    assert!(core.timelines().info(h).is_some());
}

#[test]
fn loop_fires_keys_at_the_end_and_at_zero_when_wrapping() {
    let clip = clip_bytes(
        2.0,
        vec![
            ramp(2.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![notify(0.0), notify(2.0)]),
        ],
    );
    let mut core = core(4, 16);
    let c = core.load_clip(&clip);
    create(
        &mut core,
        &TimelineCreate {
            clip: c,
            wrap: WRAP_LOOP,
            ..spec()
        },
    );
    let mut times = Vec::new();
    for _ in 0..8 {
        frame(&mut core, 0.5);
        times.extend(events(&core).iter().map(|e| e.time));
    }
    // The track windows' loop rule (T20r, D27): a looping window crosses the key at the end and the
    // key at 0 when it passes the loop point. The first window includes its start (the key at 0)
    // but not the end key: no previous cycle has ended.
    assert_eq!(times, [0.0, 2.0, 0.0, 2.0, 0.0]);
}

#[test]
fn pingpong_reverses_and_crosses_the_key_in_each_direction() {
    let (core, h, fired, kinds) = run_wrap(WRAP_PINGPONG, 16, 0.5);
    assert_eq!(fired, [2, 6, 10, 14]);
    assert_eq!(kinds, [CHANGE_LOOPED; 3]);
    let out = Out::new(&core, h);
    near(out.f(&core, 0, 0), 0.0);
}

#[test]
fn a_reverse_once_finishes_at_zero() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&wrap_clip());
    let h = create(
        &mut core,
        &TimelineCreate {
            clip,
            wrap: WRAP_HOLD,
            speed: -1.0,
            start: 2.0,
            ..spec()
        },
    );
    let mut fired = 0;
    let mut kinds = Vec::new();
    for _ in 0..6 {
        frame(&mut core, 0.5);
        fired += events(&core).len();
        kinds.extend(changes(&core).iter().map(|c| c.kind));
    }
    assert_eq!(fired, 1, "the key at 1.0 crossed backwards");
    assert_eq!(kinds, [CHANGE_FINISHED]);
    near(Out::new(&core, h).f(&core, 0, 0), 0.0);
}

// ---- Subclips ----

/// A leaf clip: a ramp `value = base + slope · t` over `duration` and an optional notify.
fn leaf(duration: f32, base: f32, slope: f32, notify_at: Option<f32>) -> Vec<u8> {
    let mut tracks = vec![ramp(duration, base, slope)];
    if let Some(t) = notify_at {
        tracks.push(keyed(TrackKind::Event, vec![notify(t)]));
    }
    clip_bytes(duration, tracks)
}

#[test]
fn nested_subclip_timing_follows_start_offset_and_speed() {
    let mut core = core(4, 16);
    let leaf_clip = core.load_clip(&leaf(4.0, 0.0, 1.0, Some(1.5)));
    // The entry covers timeline time [1, 3) and plays the leaf from 0.5 at double speed.
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(1.0, 3.0, 0, 0.5, 2.0, 0.0, 0.0)],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    assert_eq!(core.timeline_bind(h, root, 0, leaf_clip), STATUS_OK);
    let out = Out::new(&core, h);
    assert_eq!(
        out.blocks.iter().map(|b| b.kind).collect::<Vec<_>>(),
        [BLOCK_ROOT, BLOCK_SUBCLIP]
    );
    let mut event_at = None;
    for step in 1..=14 {
        frame(&mut core, 0.25);
        let t = step as f32 * 0.25;
        if t < 1.0 {
            assert_eq!(out.weight(&core, 1), 0.0, "t = {t}: no entry active");
        } else if t < 3.0 {
            assert_eq!(out.weight(&core, 1), 1.0, "t = {t}");
            near(out.f(&core, 1, 0), 0.5 + (t - 1.0) * 2.0);
        }
        for e in events(&core) {
            assert_eq!(
                (e.clip, e.instance),
                (leaf_clip, h),
                "the nested clip's own event"
            );
            event_at = Some((t, e.time));
        }
    }
    // Local time 1.5 is reached at timeline time 1 + (1.5 - 0.5) / 2 = 1.5.
    assert_eq!(event_at, Some((1.5, 1.5)));
}

#[test]
fn a_nested_clip_entered_mid_window_includes_its_start_key() {
    let mut core = core(4, 16);
    let leaf_clip = core.load_clip(&leaf(2.0, 0.0, 1.0, Some(0.0)));
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(1.0, 3.0, 0, 0.0, 1.0, 0.0, 0.0)],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.timeline_bind(h, root, 0, leaf_clip);
    frame(&mut core, 1.5);
    // The entry began at 1.0, inside the frame: its key at local 0 fires.
    assert_eq!(events(&core).len(), 1);
    frame(&mut core, 1.0);
    assert!(events(&core).is_empty());
}

#[test]
fn overlapping_entries_crossfade_by_their_blend_weights() {
    let mut core = core(4, 16);
    let a = core.load_clip(&leaf(4.0, 0.0, 0.0, None));
    let b = core.load_clip(&leaf(4.0, 10.0, 0.0, None));
    // A covers [0, 3) fading out over 1 s; B covers [2, 4) fading in over 1 s: they cross on [2, 3).
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![
                    sub(0.0, 3.0, 0, 0.0, 1.0, 0.0, 1.0),
                    sub(2.0, 4.0, 1, 0.0, 1.0, 1.0, 0.0),
                ],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.timeline_bind(h, root, 0, a);
    core.timeline_bind(h, root, 1, b);
    let out = Out::new(&core, h);
    let mut seen = Vec::new();
    for step in 1..=15 {
        frame(&mut core, 0.25);
        seen.push((step as f32 * 0.25, out.f(&core, 1, 0), out.weight(&core, 1)));
    }
    let at = |t: f32| seen.iter().find(|s| s.0 == t).copied().unwrap();
    near(at(1.0).1, 0.0);
    near(at(2.25).1, 2.5); // A 0.75, B 0.25
    near(at(2.5).1, 5.0);
    near(at(2.75).1, 7.5);
    near(at(3.5).1, 10.0);
    for t in [1.0, 2.25, 2.5, 2.75, 3.5] {
        assert!(
            (at(t).2 - 1.0).abs() < 1e-6,
            "the crossfade's weights sum to 1 at {t}"
        );
    }
    // B's first instant has weight 0: only A counts.
    near(at(2.0).1, 0.0);
}

#[test]
fn a_lone_blend_in_reports_a_partial_weight() {
    let mut core = core(4, 16);
    let a = core.load_clip(&leaf(4.0, 6.0, 0.0, None));
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(0.0, 4.0, 0, 0.0, 1.0, 2.0, 0.0)],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.timeline_bind(h, root, 0, a);
    let out = Out::new(&core, h);
    frame(&mut core, 0.5);
    near(out.f(&core, 1, 0), 6.0);
    assert!(
        (out.weight(&core, 1) - 0.25).abs() < 1e-6,
        "the host blends the rest from the field"
    );
    frame(&mut core, 1.5);
    assert_eq!(out.weight(&core, 1), 1.0);
}

#[test]
fn nested_timelines_drive_their_own_subclips() {
    let mut core = core(4, 16);
    let leaf_clip = core.load_clip(&leaf(2.0, 0.0, 1.0, Some(0.5)));
    // The middle timeline plays the leaf for its whole 2 s; the root plays the middle at [1, 3).
    let mid = core.load_clip(&clip_bytes(
        2.0,
        vec![
            ramp(2.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(0.0, 2.0, 0, 0.0, 1.0, 0.0, 0.0)],
            ),
        ],
    ));
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(1.0, 3.0, 0, 0.0, 1.0, 0.0, 0.0)],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    assert_eq!(core.timeline_bind(h, root, 0, mid), STATUS_OK);
    assert_eq!(core.timeline_bind(h, mid, 0, leaf_clip), STATUS_OK);
    let out = Out::new(&core, h);
    assert_eq!(
        out.blocks.len(),
        2,
        "the mid timeline's value block mixes in; deeper ones add records only"
    );
    let mut fired = Vec::new();
    for step in 1..=16 {
        frame(&mut core, 0.25);
        let t = step as f32 * 0.25;
        for e in events(&core) {
            fired.push((t, e.clip, e.time));
        }
        if (1.25..3.0).contains(&t) {
            near(out.f(&core, 1, 0), t - 1.0);
        }
    }
    // The leaf's notify at local 0.5 is timeline time 1.5, from the leaf clip.
    assert_eq!(fired, [(1.5, leaf_clip, 0.5)]);
}

#[test]
fn a_nested_notify_state_ends_when_its_entry_is_left() {
    let mut core = core(4, 16);
    let leaf_clip = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![state(0.5, 3.5)]),
        ],
    ));
    // The entry [1, 2) cuts the leaf's [0.5, 3.5) state short.
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![sub(1.0, 2.0, 0, 0.0, 1.0, 0.0, 0.0)],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.timeline_bind(h, root, 0, leaf_clip);
    let mut phases = Vec::new();
    for _ in 0..12 {
        frame(&mut core, 0.25);
        phases.extend(states(&core).iter().map(|s| s.phase));
    }
    assert_eq!(phases.first(), Some(&tracks::PHASE_BEGIN));
    assert_eq!(
        phases.iter().filter(|p| **p == tracks::PHASE_BEGIN).count(),
        1
    );
    assert_eq!(
        phases.iter().filter(|p| **p == tracks::PHASE_END).count(),
        1
    );
    assert_eq!(phases.last(), Some(&tracks::PHASE_END), "end comes last");
}

#[test]
fn an_unbound_or_mismatched_entry_contributes_nothing() {
    let mut core = core(4, 16);
    let two = core.load_clip(&clip_bytes(
        4.0,
        vec![ramp(4.0, 0.0, 1.0), {
            let mut t = ramp(4.0, 0.0, 1.0);
            t.binding = Binding::property(1, 1, 2);
            t
        }],
    ));
    let ok = core.load_clip(&leaf(4.0, 3.0, 0.0, None));
    let root = core.load_clip(&clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(
                TrackKind::Subclip,
                vec![
                    sub(0.0, 4.0, 0, 0.0, 1.0, 0.0, 0.0),
                    sub(0.0, 4.0, 1, 0.0, 1.0, 0.0, 0.0),
                    sub(0.0, 4.0, 2, 0.0, 1.0, 0.0, 0.0),
                ],
            ),
        ],
    ));
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: root,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.timeline_bind(h, root, 0, ok);
    core.timeline_bind(h, root, 1, two);
    // String id 2 stays unbound.
    let out = Out::new(&core, h);
    frame(&mut core, 0.5);
    assert_eq!(
        out.blocks[1].words, 1,
        "the block takes the first entry's layout"
    );
    near(out.f(&core, 1, 0), 3.0);
    assert_eq!(
        out.weight(&core, 1),
        1.0,
        "the two-column entry didn't count"
    );
    assert_eq!(
        core.timeline_bind(h, root, 0, 0xdead_beef),
        STATUS_STALE_HANDLE
    );
}

// ---- Sequences ----

fn member(host_id: u32, column: u32, offset: f32, duration: f32, to: f32) -> SeqMember {
    SeqMember {
        host_id,
        column,
        value_kind: KIND_VALUE,
        width: 1,
        ease: EASE_LINEAR,
        flags: 0,
        loops: 1,
        offset,
        duration,
        delay: 0.0,
        from0: 0.0,
        to0: to,
        ..SeqMember::default()
    }
}

fn seq_bytes(head: &SeqCreate, members: &[SeqMember]) -> Vec<u8> {
    let mut v = SeqCreate {
        members: members.len() as u32,
        ..*head
    }
    .encode();
    for m in members {
        v.extend(m.encode());
    }
    v
}

fn seq_head(wrap: u32) -> SeqCreate {
    SeqCreate {
        world: 0,
        host_id: 200,
        time_mode: 0,
        wrap,
        flags: FLAG_PLAY,
        speed: 1.0,
        members: 0,
    }
}

fn create_seq(core: &mut Core, head: &SeqCreate, members: &[SeqMember]) -> u32 {
    let h = core.timeline_create_sequence(&seq_bytes(head, members));
    assert_ne!(h, 0, "refused with status {}", core.last_status());
    h
}

fn done_ids(core: &Core) -> Vec<(u32, u32)> {
    changes(core).iter().map(|c| (c.kind, c.member)).collect()
}

#[test]
fn a_sequence_runs_its_members_in_order_and_reports_each_completion() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[member(11, 5, 0.0, 1.0, 1.0), member(12, 6, 1.0, 1.0, 2.0)],
    );
    let out = Out::new(&core, h);
    assert_eq!(
        out.blocks
            .iter()
            .map(|b| (b.kind, b.column, b.host_id))
            .collect::<Vec<_>>(),
        [(BLOCK_MEMBER, 5, 11), (BLOCK_MEMBER, 6, 12)]
    );
    assert_eq!(out.info.duration, 2.0);
    frame(&mut core, 0.5);
    assert_eq!(out.f(&core, 0, 0), 0.5);
    assert_eq!(out.weight(&core, 0), 1.0);
    assert_eq!(
        out.weight(&core, 1),
        0.0,
        "the second member hasn't started"
    );
    assert!(changes(&core).is_empty());
    frame(&mut core, 0.5);
    assert_eq!(
        out.f(&core, 0, 0),
        1.0,
        "a finished member holds its end value"
    );
    assert_eq!(done_ids(&core), [(CHANGE_MEMBER_DONE, 11)]);
    assert_eq!(out.weight(&core, 1), 1.0);
    frame(&mut core, 0.5);
    assert_eq!(out.f(&core, 1, 0), 1.0, "halfway to 2");
    frame(&mut core, 0.5);
    assert_eq!(
        done_ids(&core),
        [(CHANGE_MEMBER_DONE, 12), (CHANGE_FINISHED, NONE)]
    );
    assert_eq!(out.f(&core, 1, 0), 2.0);
    assert!(core.timelines().info(h).is_none(), "once retires");
}

#[test]
fn a_parallel_group_reports_completions_by_time_not_by_index() {
    let mut core = core(4, 16);
    create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[
            member(1, 1, 0.0, 2.0, 1.0),
            member(2, 2, 0.0, 1.0, 1.0),
            member(3, 3, 0.0, 1.5, 1.0),
        ],
    );
    frame(&mut core, 2.5);
    assert_eq!(
        done_ids(&core),
        [
            (CHANGE_MEMBER_DONE, 2),
            (CHANGE_MEMBER_DONE, 3),
            (CHANGE_MEMBER_DONE, 1),
            (CHANGE_FINISHED, NONE)
        ]
    );
}

#[test]
fn a_nested_sequence_offsets_add_up() {
    // sequence(a, parallel(b, c)): the host flattens it into offsets.
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_HOLD),
        &[
            member(1, 1, 0.0, 1.0, 1.0),
            member(2, 2, 1.0, 0.5, 1.0),
            member(3, 3, 1.0, 1.0, 1.0),
        ],
    );
    let out = Out::new(&core, h);
    assert_eq!(out.info.duration, 2.0);
    let mut log = Vec::new();
    for _ in 0..8 {
        frame(&mut core, 0.25);
        log.extend(changes(&core).iter().map(|c| (c.kind, c.member)));
    }
    assert_eq!(
        log,
        [
            (CHANGE_MEMBER_DONE, 1),
            (CHANGE_MEMBER_DONE, 2),
            (CHANGE_MEMBER_DONE, 3),
            (CHANGE_FINISHED, NONE)
        ]
    );
}

#[test]
fn a_sequence_seek_reports_no_completion_and_follows_the_levels() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &SeqCreate {
            flags: 0,
            ..seq_head(WRAP_HOLD)
        },
        &[member(1, 1, 0.0, 1.0, 1.0), member(2, 2, 1.0, 1.0, 2.0)],
    );
    let out = Out::new(&core, h);
    frame(&mut core, 0.25);
    assert_eq!(out.weight(&core, 0), 1.0, "shown at time 0");
    control(&mut core, h, OP_SEEK, 1.5);
    frame(&mut core, 0.25);
    assert!(changes(&core).is_empty());
    assert_eq!(out.f(&core, 0, 0), 1.0);
    assert_eq!(out.f(&core, 1, 0), 1.0);
    // Playing on completes only what remains.
    control(&mut core, h, OP_PLAY, 0.0);
    let mut log = Vec::new();
    for _ in 0..3 {
        frame(&mut core, 0.25);
        log.extend(changes(&core).iter().map(|c| (c.kind, c.member)));
    }
    assert_eq!(log, [(CHANGE_MEMBER_DONE, 2), (CHANGE_FINISHED, NONE)]);
}

#[test]
fn a_looping_sequence_reports_each_pass() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_LOOP),
        &[member(1, 1, 0.0, 1.0, 1.0)],
    );
    let out = Out::new(&core, h);
    let mut log = Vec::new();
    for _ in 0..6 {
        frame(&mut core, 0.5);
        log.extend(changes(&core).iter().map(|c| (c.kind, c.member)));
    }
    // 3 s: it completes at 1 and 2 and 3 (reaching the end counts, then the wrap), and wraps.
    assert_eq!(log.iter().filter(|c| c.0 == CHANGE_MEMBER_DONE).count(), 3);
    assert_eq!(log.iter().filter(|c| c.0 == CHANGE_LOOPED).count(), 3);
    assert!(core.timelines().info(h).is_some());
    let _ = out;
}

#[test]
fn a_pingpong_sequence_turns_and_reports_each_completion() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_PINGPONG),
        &[member(1, 1, 0.0, 1.0, 1.0)],
    );
    let mut log = Vec::new();
    for _ in 0..6 {
        frame(&mut core, 0.5);
        log.extend(changes(&core).iter().map(|c| c.kind));
    }
    // Forward to 1 (done), back to 0 (the member is undone silently), forward again to 1 (done).
    assert_eq!(log.iter().filter(|k| **k == CHANGE_MEMBER_DONE).count(), 2);
    assert!(core.timelines().info(h).is_some());
}

#[test]
fn an_endless_member_never_finishes_the_sequence() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[
            SeqMember {
                loops: LOOPS_INFINITE,
                flags: FLAG_YOYO,
                ..member(1, 1, 0.0, 1.0, 1.0)
            },
            member(2, 2, 0.0, 0.5, 1.0),
        ],
    );
    assert!(Out::new(&core, h).info.duration.is_infinite());
    for _ in 0..40 {
        frame(&mut core, 0.5);
    }
    assert!(core.timelines().info(h).is_some());
}

#[test]
fn a_sequence_member_with_a_delay_and_loops_has_its_total_length() {
    let mut core = core(4, 16);
    let h = create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[SeqMember {
            delay: 0.5,
            loops: 2,
            ..member(1, 1, 0.5, 1.0, 1.0)
        }],
    );
    assert_eq!(
        Out::new(&core, h).info.duration,
        3.0,
        "offset 0.5 + delay 0.5 + 2 x 1"
    );
}

#[test]
fn an_empty_sequence_finishes_at_once() {
    let mut core = core(4, 16);
    create_seq(&mut core, &seq_head(WRAP_ONCE), &[]);
    frame(&mut core, 0.25);
    assert_eq!(done_ids(&core), [(CHANGE_FINISHED, NONE)]);
}

// ---- Kill, destroyed, capacity, bad input ----

#[test]
fn kill_ends_open_states_and_reports_killed_next_frame() {
    let clip = clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![state(0.5, 3.0)]),
        ],
    );
    let mut core = core(4, 16);
    let c = core.load_clip(&clip);
    let h = create(
        &mut core,
        &TimelineCreate {
            clip: c,
            wrap: WRAP_LOOP,
            ..spec()
        },
    );
    for _ in 0..4 {
        frame(&mut core, 0.25);
    }
    assert_eq!(control(&mut core, h, OP_KILL, 0.0), STATUS_OK);
    assert_eq!(control(&mut core, h, OP_PAUSE, 0.0), STATUS_STALE_HANDLE);
    frame(&mut core, 0.25);
    assert_eq!(
        states(&core).iter().map(|s| s.phase).collect::<Vec<_>>(),
        [tracks::PHASE_END]
    );
    let ch = changes(&core);
    assert_eq!(
        (ch.len(), ch[0].kind, ch[0].host_id),
        (1, CHANGE_KILLED, 100)
    );
    assert!(active(&core).is_empty());
    assert!(core.timelines().info(h).is_none());
}

#[test]
fn destroyed_reports_destroyed_without_end_records() {
    let clip = clip_bytes(
        4.0,
        vec![
            ramp(4.0, 0.0, 1.0),
            keyed(TrackKind::Event, vec![state(0.5, 3.0)]),
        ],
    );
    let mut core = core(4, 16);
    let c = core.load_clip(&clip);
    let h = create(&mut core, &TimelineCreate { clip: c, ..spec() });
    for _ in 0..4 {
        frame(&mut core, 0.25);
    }
    control(&mut core, h, OP_DESTROYED, 0.0);
    frame(&mut core, 0.25);
    assert!(records(&core).is_empty());
    assert_eq!(
        changes(&core).iter().map(|c| c.kind).collect::<Vec<_>>(),
        [CHANGE_DESTROYED]
    );
    // The slot is free again with a new generation.
    let h2 = create(&mut core, &TimelineCreate { clip: c, ..spec() });
    assert_ne!(h, h2);
}

#[test]
fn instances_run_in_their_world_and_time_mode() {
    let mut core = core(4, 16);
    let clip = core.load_clip(&wrap_clip());
    let w1 = create(
        &mut core,
        &TimelineCreate {
            clip,
            world: 1,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    let fixed = create(
        &mut core,
        &TimelineCreate {
            clip,
            time_mode: TIME_FIXED,
            wrap: WRAP_HOLD,
            ..spec()
        },
    );
    core.write_inputs(0);
    core.evaluate(0, PASS_NORMAL, 0.5, 0.5);
    assert!(
        active(&core).is_empty(),
        "world 1 and the fixed pass haven't run"
    );
    core.evaluate(0, anim_wire::core::PASS_FIXED, 0.5, 0.0);
    assert_eq!(active(&core), [fixed]);
    core.write_inputs(0);
    core.evaluate(1, PASS_NORMAL, 0.5, 0.5);
    assert_eq!(active(&core), [w1]);
}

#[test]
fn bad_records_a_stale_clip_and_a_full_table_are_refused() {
    let mut core = core(4, 16);
    assert_eq!(core.timeline_create(&[1, 2]), 0);
    assert_eq!(core.last_status(), STATUS_BAD_RECORD);
    assert_eq!(
        core.timeline_create(
            &TimelineCreate {
                clip: 0x1234_5678,
                ..spec()
            }
            .encode()
        ),
        0
    );
    assert_eq!(core.last_status(), STATUS_STALE_HANDLE);
    assert_eq!(core.timeline_create_sequence(&[0; 4]), 0);
    // More members than the record carries.
    let mut bytes = seq_bytes(&seq_head(WRAP_ONCE), &[member(1, 1, 0.0, 1.0, 1.0)]);
    bytes.truncate(bytes.len() - 4);
    assert_eq!(core.timeline_create_sequence(&bytes), 0);
    assert_eq!(core.last_status(), STATUS_BAD_RECORD);
    // A bad member (width 0).
    let bad = SeqMember {
        width: 0,
        ..member(1, 1, 0.0, 1.0, 1.0)
    };
    assert_eq!(
        core.timeline_create_sequence(&seq_bytes(&seq_head(WRAP_ONCE), &[bad])),
        0
    );
    assert_eq!(core.timelines_configure(1, 4096), STATUS_OK);
    let seq = create_seq(
        &mut core,
        &seq_head(WRAP_HOLD),
        &[member(1, 1, 0.0, 1.0, 1.0)],
    );
    assert_eq!(
        core.timeline_create_sequence(&seq_bytes(&seq_head(WRAP_HOLD), &[])),
        0
    );
    assert_eq!(core.last_status(), STATUS_FULL);
    // A subclip bind on a sequence is refused.
    assert_eq!(core.timeline_bind(seq, 0, 0, 0), STATUS_BAD_RECORD);
}

#[test]
fn value_regions_are_reused_after_an_instance_retires() {
    let mut core = core(4, 16);
    let a = create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[member(1, 1, 0.0, 0.5, 1.0)],
    );
    let first = Out::new(&core, a).info.value_offset;
    frame(&mut core, 1.0);
    let b = create_seq(
        &mut core,
        &seq_head(WRAP_ONCE),
        &[member(2, 2, 0.0, 0.5, 1.0)],
    );
    assert_eq!(Out::new(&core, b).info.value_offset, first);
}

#[test]
fn records_that_do_not_fit_are_counted_not_half_written() {
    let mut core = core(4, 16);
    assert_eq!(
        core.timelines_configure(8, 2 * tracks::Event::STRIDE),
        STATUS_OK
    );
    let clip = clip_bytes(
        2.0,
        vec![
            ramp(2.0, 0.0, 1.0),
            keyed(
                TrackKind::Event,
                vec![notify(0.5), notify(0.5), notify(0.5), notify(0.5)],
            ),
        ],
    );
    let c = core.load_clip(&clip);
    create(&mut core, &TimelineCreate { clip: c, ..spec() });
    frame(&mut core, 1.0);
    let (bytes, count, dropped) = core.timelines().records();
    assert_eq!((count, dropped), (2, 2));
    assert_eq!(bytes.len(), 2 * tracks::Event::STRIDE as usize);
}

#[test]
fn the_same_input_gives_the_same_bits() {
    let run = || {
        let mut core = core(4, 16);
        let a = core.load_clip(&leaf(4.0, 0.0, 0.0, Some(1.0)));
        let b = core.load_clip(&leaf(4.0, 10.0, 0.5, None));
        let root = core.load_clip(&clip_bytes(
            4.0,
            vec![
                ramp(4.0, 0.0, 1.0),
                keyed(TrackKind::Event, vec![notify(1.0)]),
                keyed(
                    TrackKind::Subclip,
                    vec![
                        sub(0.0, 3.0, 0, 0.0, 1.0, 0.0, 1.0),
                        sub(2.0, 4.0, 1, 0.0, 1.0, 1.0, 0.0),
                    ],
                ),
            ],
        ));
        let h = create(
            &mut core,
            &TimelineCreate {
                clip: root,
                wrap: WRAP_PINGPONG,
                ..spec()
            },
        );
        core.timeline_bind(h, root, 0, a);
        core.timeline_bind(h, root, 1, b);
        let out = Out::new(&core, h);
        let mut bits = Vec::new();
        for _ in 0..40 {
            frame(&mut core, 0.31);
            bits.push(out.word(&core, 0, 0));
            bits.push(out.word(&core, 1, 0));
            bits.push(out.weight(&core, 1).to_bits());
            bits.push(records(&core).len() as u32);
        }
        bits
    };
    assert_eq!(run(), run());
}
