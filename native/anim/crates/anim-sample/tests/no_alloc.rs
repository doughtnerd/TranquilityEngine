//! Sampling never allocates: a counting global allocator sees no allocation while poses and
//! property tracks are sampled, through the records and through the binding table, and while
//! track windows are evaluated (after setup).

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{
    Binding, ClipView, ControlKind, Key, KeyData, MarkerKind, Track, TrackKind,
};
use anim_format::NONE;
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_sample::{
    ClipBindings, ClipSampler, Form, SegmentCache, TrackRecord, Window, WINDOW_SEEK, WINDOW_START,
};
use common::*;
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

#[test]
fn sampling_does_not_allocate() {
    let mut rng = Rng::new(3);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let mut clip = clip(&skel, 2.0, true, &mut rng);
    let keyed = |kind, keys: Vec<(f32, f32, KeyData)>| Track {
        kind,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: keys
            .into_iter()
            .map(|(time, end, data)| Key { time, end, data })
            .collect(),
    };
    let event = |always| KeyData::Event {
        method: 0,
        args: NONE,
        threshold: 0.5,
        always,
    };
    clip.strings = vec!["a".into()];
    clip.tracks.extend([
        keyed(
            TrackKind::Event,
            vec![
                (0.0, 0.0, event(true)),
                (0.5, 0.5, event(false)),
                (0.6, 1.2, event(false)),
                (1.5, 2.0, event(true)),
            ],
        ),
        keyed(
            TrackKind::Marker,
            vec![
                (
                    0.25,
                    0.25,
                    KeyData::Marker {
                        kind: MarkerKind::Sync,
                        name: 0,
                    },
                ),
                (
                    1.25,
                    1.25,
                    KeyData::Marker {
                        kind: MarkerKind::Sync,
                        name: 0,
                    },
                ),
            ],
        ),
        keyed(
            TrackKind::Audio,
            vec![(
                0.3,
                0.8,
                KeyData::Audio {
                    asset: 0,
                    params: NONE,
                },
            )],
        ),
        keyed(
            TrackKind::Control,
            vec![(
                1.1,
                1.1,
                KeyData::Control {
                    kind: ControlKind::CameraCut,
                    target: 0,
                    payload: NONE,
                },
            )],
        ),
        keyed(
            TrackKind::Activation,
            vec![
                (0.2, 0.7, KeyData::Activation),
                (1.4, 2.0, KeyData::Activation),
            ],
        ),
        keyed(
            TrackKind::Discrete,
            vec![
                (0.1, 0.1, KeyData::Discrete { value: 0 }),
                (0.9, 0.9, KeyData::Discrete { value: 1 }),
            ],
        ),
        keyed(
            TrackKind::Subclip,
            vec![(
                0.5,
                1.5,
                KeyData::Subclip {
                    clip: 0,
                    offset: 0.0,
                    speed: 1.0,
                    blend_in: 0.1,
                    blend_out: 0.1,
                },
            )],
        ),
    ]);
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    let bytes = compress(&clip, Some(&skel), &settings).unwrap().bytes;
    let view = ClipView::parse(&bytes).unwrap();
    let rest: Vec<AosTransform> = skel
        .bones
        .iter()
        .map(|b| {
            let [tx, ty, tz] = b.translation;
            let [x, y, z, w] = b.rotation;
            AosTransform::new(
                AosVec3::new(tx, ty, tz),
                AosQuat::new(x, y, z, w),
                AosVec3::one(),
            )
        })
        .collect();
    let comp = ClipSampler::new(view, Form::Compressed).unwrap();
    let raw = ClipSampler::new(view, Form::Raw).unwrap();
    let mut scratch = vec![AosTransform::default(); comp.scratch_len()];
    let mut out = vec![SoaTransform::default(); soa_len(rest.len())];
    let mut mem = vec![0.0f32; comp.cache_len()];
    let mut cache = SegmentCache::new(&mut mem);
    let bindings = ClipBindings::new(&comp);
    let raw_bindings = ClipBindings::new(&raw);
    let bound = bindings.bind(&comp).unwrap();
    let raw_bound = raw_bindings.bind(&raw).unwrap();
    let mut open = vec![0u32; bindings.notify_words()];
    let mut columns = vec![0u32; bindings.column_words()];
    let mut records = 0usize;
    let mut value = [0.0f32; 4];

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut t = 0.0f32;
    while t < 2.0 {
        comp.sample_pose(t, &rest, &mut scratch, &mut out, Some(&mut cache))
            .unwrap();
        comp.sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        raw.sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        bound
            .sample_pose(t, &rest, &mut scratch, &mut out, Some(&mut cache))
            .unwrap();
        bound
            .sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        raw_bound
            .sample_pose(t, &rest, &mut scratch, &mut out, None)
            .unwrap();
        bound.sample_track(0, t, &mut value);
        t += 0.013;
    }
    // Track windows: forward, reverse, over the loop point, several cycles, seeks, interrupts.
    let mut sink = |_: TrackRecord| records += 1;
    let mut t = 0.0f32;
    for i in 0..400 {
        let delta = match i % 40 {
            0..=29 => 1.0 / 30.0,
            30..=37 => -1.0 / 20.0,
            38 => 5.0,
            _ => 0.0,
        };
        let flags = match i % 97 {
            0 => WINDOW_START,
            50 => WINDOW_SEEK,
            _ => 0,
        };
        let w = Window::new(t, delta, true).with(flags);
        t = bound.evaluate(
            &w,
            (i % 10) as f32 / 9.0,
            &mut open,
            &mut columns,
            &mut sink,
        );
        raw_bound.evaluate(&w.with(0), 1.0, &mut open, &mut columns, &mut sink);
        let _ = bindings.sync_phase(t, true);
        if i % 61 == 0 {
            bindings.end_notify_states(t, 1.0, &mut open, &mut sink);
        }
    }
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    assert!(records > 100, "windows produced records ({records})");
}
