//! `write_inputs` and `evaluate` never allocate while tweens and timelines run (ADR 0370): a
//! counting global allocator sees no allocation across frames that advance a thousand tweens
//! (loops, yoyo, quaternions, completions, kills, destroyed targets), sequences and clip
//! timelines with nested subclips, crossfades, seeks, wraps, stops and retirements. Setup and the
//! control calls between frames are outside the counted calls.

mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_wire::core::PASS_NORMAL;
use anim_wire::timeline::{self as tl, SeqCreate, SeqMember, TimelineControl, TimelineCreate};
use anim_wire::tween::{self as tw, TweenControl, TweenCreate};
use anim_wire::WireRecord;
use common::core;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn clip(
    duration: f32,
    subclips: &[(f32, f32, u32, f32, f32, f32)],
    notify: Option<f32>,
) -> Vec<u8> {
    let frames = (duration * 30.0) as usize + 1;
    let mut float = Track {
        kind: TrackKind::Float,
        flags: 0,
        subtype: 0,
        binding: Binding::property(0, 1, 2),
        raw: (0..frames).map(|f| f as f32 / 30.0).collect(),
        keys: Vec::new(),
    };
    float.raw[0] = 0.0;
    let key = |time, end, data| Key { time, end, data };
    let mut tracks = vec![float];
    if let Some(t) = notify {
        tracks.push(Track {
            kind: TrackKind::Event,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys: vec![
                key(
                    t,
                    t,
                    KeyData::Event {
                        method: 0,
                        args: NONE,
                        threshold: 0.0,
                        always: true,
                    },
                ),
                key(
                    t,
                    t + 0.5,
                    KeyData::Event {
                        method: 0,
                        args: NONE,
                        threshold: 0.0,
                        always: true,
                    },
                ),
            ],
        });
    }
    if !subclips.is_empty() {
        tracks.push(Track {
            kind: TrackKind::Subclip,
            flags: 0,
            subtype: 0,
            binding: Binding::none(),
            raw: Vec::new(),
            keys: subclips
                .iter()
                .map(|&(s, e, id, off, bi, bo)| {
                    key(
                        s,
                        e,
                        KeyData::Subclip {
                            clip: id,
                            offset: off,
                            speed: 1.0,
                            blend_in: bi,
                            blend_out: bo,
                        },
                    )
                })
                .collect(),
        });
    }
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration,
        sample_rate: 30.0,
        frame_count: frames as u32,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["a".into(), "b".into(), "c".into()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    compress(
        &clip,
        None,
        &Settings {
            keep_raw: true,
            ..Settings::default()
        },
    )
    .unwrap()
    .bytes
}

#[test]
fn frames_do_not_allocate() {
    let mut core = core(4, 16);
    assert_eq!(core.tweens_configure(2048), 0);
    // T70: a Bézier curve asset, the easing of every thirteenth tween.
    let curve = core.load_curve(&[
        0.0, 0.0, 5.0, 0.0, 0.0, 0.25, 0.5, 0.5, 1.5, 5.0, -0.25, 0.0, 0.25, 0.0, 1.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
    ]);
    assert_ne!(curve, 0);
    // A thousand tweens of every flavour.
    let mut handles = Vec::new();
    for i in 0..1000u32 {
        let c = TweenCreate {
            world: 0,
            host_id: i,
            column: i,
            value_kind: if i % 7 == 0 {
                tw::KIND_QUAT_SLERP
            } else {
                tw::KIND_VALUE
            },
            width: 1 + i % 4,
            ease: if i % 13 == 0 { curve } else { i % 31 },
            flags: if i % 3 == 0 { tw::FLAG_YOYO } else { 0 }
                | if i % 5 == 0 { tw::FLAG_RELATIVE } else { 0 },
            time_mode: i % 3,
            loops: [1, 2, 3, tw::LOOPS_INFINITE][(i % 4) as usize],
            duration: 0.2 + (i % 10) as f32 * 0.1,
            delay: (i % 4) as f32 * 0.05,
            speed: 1.0,
            from3: 1.0,
            to0: 1.0,
            to1: 2.0,
            to3: 1.0,
            ..TweenCreate::default()
        };
        handles.push(core.tween_create(&c.encode()));
    }
    // Clip timelines.
    let leaf = core.load_clip(&clip(2.0, &[], Some(0.5)));
    let other = core.load_clip(&clip(2.0, &[], None));
    let mid = core.load_clip(&clip(2.0, &[(0.0, 2.0, 0, 0.0, 0.0, 0.0)], Some(1.0)));
    let root = core.load_clip(&clip(
        4.0,
        &[(0.5, 3.0, 0, 0.0, 0.5, 0.5), (1.5, 4.0, 1, 0.0, 0.5, 0.0)],
        Some(1.0),
    ));
    let mut timelines = Vec::new();
    for (i, wrap) in [
        tl::WRAP_ONCE,
        tl::WRAP_HOLD,
        tl::WRAP_LOOP,
        tl::WRAP_PINGPONG,
    ]
    .into_iter()
    .enumerate()
    {
        let h = core.timeline_create(
            &TimelineCreate {
                world: 0,
                host_id: i as u32,
                clip: root,
                time_mode: 0,
                wrap,
                flags: tl::FLAG_PLAY,
                speed: 1.0,
                start: 0.0,
            }
            .encode(),
        );
        assert_ne!(h, 0);
        assert_eq!(core.timeline_bind(h, root, 0, mid), 0);
        assert_eq!(core.timeline_bind(h, root, 1, other), 0);
        assert_eq!(core.timeline_bind(h, mid, 0, leaf), 0);
        timelines.push(h);
    }
    // Sequences.
    let mut seqs = Vec::new();
    for wrap in [tl::WRAP_ONCE, tl::WRAP_LOOP, tl::WRAP_PINGPONG] {
        let mut bytes = SeqCreate {
            world: 0,
            host_id: 9,
            time_mode: 0,
            wrap,
            flags: tl::FLAG_PLAY,
            speed: 1.0,
            members: 3,
        }
        .encode();
        for k in 0..3 {
            bytes.extend(
                SeqMember {
                    host_id: k,
                    column: k,
                    width: 4,
                    value_kind: tw::KIND_QUAT_NLERP,
                    ease: 3 * k + 2,
                    offset: k as f32 * 0.4,
                    duration: 0.6,
                    to3: 1.0,
                    ..SeqMember::default()
                }
                .encode(),
            );
        }
        seqs.push(core.timeline_create_sequence(&bytes));
    }
    // Control records, encoded before counting.
    let tc = |handle, op| TweenControl { handle, op }.encode();
    let lc = |handle, op, value| TimelineControl { handle, op, value }.encode();
    let mut counted = 0usize;
    let mut changes = 0usize;
    for frame in 0..400u32 {
        // Between frames, outside the counted calls.
        match frame {
            20 => {
                for &h in &handles[..50] {
                    core.tween_control(&tc(h, tw::OP_KILL));
                }
                for &h in &handles[50..100] {
                    core.tween_control(&tc(h, tw::OP_DESTROYED));
                }
                for &h in &handles[100..150] {
                    core.tween_control(&tc(h, tw::OP_PAUSE));
                }
            }
            40 => {
                for &h in &handles[100..150] {
                    core.tween_control(&tc(h, tw::OP_RESUME));
                }
                core.timeline_control(&lc(timelines[1], tl::OP_SEEK, 3.0));
                core.timeline_control(&lc(timelines[2], tl::OP_STOP, 0.0));
            }
            60 => {
                core.timeline_control(&lc(timelines[2], tl::OP_PLAY, 0.0));
                core.timeline_control(&lc(timelines[3], tl::OP_SET_SPEED, -1.5));
                core.timeline_control(&lc(seqs[1], tl::OP_SEEK, 0.2));
            }
            120 => {
                core.timeline_control(&lc(timelines[2], tl::OP_KILL, 0.0));
                core.timeline_control(&lc(seqs[2], tl::OP_DESTROYED, 0.0));
            }
            _ => {}
        }
        let before = ALLOCS.load(Ordering::SeqCst);
        core.write_inputs(0);
        core.evaluate(0, PASS_NORMAL, 1.0 / 60.0, 1.0 / 60.0);
        core.evaluate(0, anim_wire::core::PASS_FIXED, 1.0 / 60.0, 1.0 / 60.0);
        counted += ALLOCS.load(Ordering::SeqCst) - before;
        changes += core.tweens().change_count() + core.timelines().change_count();
        // Reading the views is free of allocation too, but isn't counted here.
        assert!(core.tweens().rows() <= 1000);
    }
    assert_eq!(counted, 0, "write_inputs and evaluate allocated");
    assert!(
        changes > 100,
        "completions, loops, kills and finishes were reported"
    );
}
