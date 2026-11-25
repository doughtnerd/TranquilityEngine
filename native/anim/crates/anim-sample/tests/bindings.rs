//! The binding table gives the same bits as the clip-record path: `BoundClip::sample_pose` and
//! `sample_track` against `ClipSampler`'s own, both forms, with and without a segment cache, over
//! clips whose property tracks sit between bone tracks (so value channels interleave with bone
//! channels in the bitstream). No tolerance: bit-for-bit equality.

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ClipView, Track, TrackKind};
use anim_format::NONE;
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_sample::{ClipBindings, ClipSampler, Form, SegmentCache, TrackSample};
use common::*;

/// A clip over `shape` with a property track inserted after every fourth bone track.
fn mixed(shape: Shape, seed: u64, seconds: f64) -> (Vec<AosTransform>, Clip) {
    let mut rng = Rng::new(seed);
    let skel = skeleton(shape, &mut rng);
    let mut clip = clip(&skel, seconds, true, &mut rng);
    let frames = clip.frame_count;
    let kinds = [
        TrackKind::Float,
        TrackKind::Vec3,
        TrackKind::Quat,
        TrackKind::Color,
        TrackKind::Morph,
    ];
    let mut tracks = Vec::new();
    for (i, t) in clip.tracks.drain(..).enumerate() {
        tracks.push(t);
        if i % 4 == 3 {
            let kind = kinds[(i / 4) % kinds.len()];
            let w = kind.width() as usize;
            let mut raw = Vec::new();
            for f in 0..frames {
                let x = f as f64 / 30.0;
                if kind == TrackKind::Quat {
                    let q = anim_offline::math::Quat::from_axis_angle(
                        anim_offline::math::Vec3::new(0.0, 1.0, 0.0),
                        (x * 2.0 + i as f64).sin(),
                    );
                    raw.extend_from_slice(&[q.x as f32, q.y as f32, q.z as f32, q.w as f32]);
                } else {
                    for k in 0..w {
                        // Every eighth one constant, to cover constant value channels.
                        let v = if i % 32 == 31 {
                            0.25
                        } else {
                            (x * (1.0 + k as f64) + i as f64).sin()
                        };
                        raw.push(v as f32);
                    }
                }
            }
            tracks.push(Track {
                kind,
                flags: 0,
                subtype: (i % 2) as u8 * (kind == TrackKind::Quat) as u8,
                binding: Binding::property(0, NONE, NONE),
                raw,
                keys: Vec::new(),
            });
        }
    }
    clip.tracks = tracks;
    clip.strings = vec!["node".into()];
    let rest = skel
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
    let bytes = compress(
        &clip,
        Some(&skel),
        &Settings {
            keep_raw: true,
            ..Settings::default()
        },
    )
    .unwrap()
    .bytes;
    (rest, ClipView::parse(&bytes).unwrap().to_clip())
}

fn bits(out: &[SoaTransform]) -> Vec<u32> {
    out.iter()
        .flat_map(|g| {
            g.to_aos().into_iter().flat_map(|t| {
                [
                    t.translation.x,
                    t.translation.y,
                    t.translation.z,
                    t.rotation.x,
                    t.rotation.y,
                    t.rotation.z,
                    t.rotation.w,
                    t.scale.x,
                    t.scale.y,
                    t.scale.z,
                ]
            })
        })
        .map(f32::to_bits)
        .collect()
}

fn times(duration: f32) -> Vec<f32> {
    let mut ts = vec![-0.5, 0.0, duration, duration + 1.0, f32::NAN];
    let mut t = 0.0f32;
    while t <= duration {
        ts.push(t);
        t += 1.0 / 60.0;
    }
    while t >= 0.0 {
        ts.push(t);
        t -= 1.0 / 47.0;
    }
    // Every frame and every segment boundary exactly.
    for f in 0..=(duration * 30.0) as u32 {
        ts.push(f as f32 / 30.0);
    }
    ts
}

#[test]
fn poses_and_tracks_are_bit_identical() {
    for (shape, seed, seconds) in [
        (Shape::Humanoid, 31, 2.0),
        (Shape::Tree(37), 32, 1.3),
        (Shape::Chain(3), 33, 0.6),
        (Shape::Single, 34, 0.0),
    ] {
        let (rest, clip) = mixed(shape, seed, seconds);
        let bytes = clip.write().unwrap();
        let view = ClipView::parse(&bytes).unwrap();
        for form in [Form::Compressed, Form::Raw] {
            let sampler = ClipSampler::new(view, form).unwrap();
            let bindings = ClipBindings::new(&sampler);
            let bound = bindings.bind(&sampler).unwrap();
            assert_eq!(bindings.cache_len(), sampler.cache_len());
            let n = rest.len();
            let mut scratch = vec![AosTransform::default(); sampler.scratch_len()];
            let mut a = vec![SoaTransform::default(); soa_len(n)];
            let mut b = vec![SoaTransform::default(); soa_len(n)];
            let mut mem_a = vec![0.0f32; sampler.cache_len()];
            let mut mem_b = vec![0.0f32; sampler.cache_len()];
            let mut cache_a = SegmentCache::new(&mut mem_a);
            let mut cache_b = SegmentCache::new(&mut mem_b);
            for t in times(clip.duration) {
                sampler
                    .sample_pose(t, &rest, &mut scratch, &mut a, None)
                    .unwrap();
                bound
                    .sample_pose(t, &rest, &mut scratch, &mut b, None)
                    .unwrap();
                assert_eq!(bits(&a), bits(&b), "{shape:?} {form:?} t {t}");
                bound
                    .sample_pose(t, &rest, &mut scratch, &mut b, Some(&mut cache_b))
                    .unwrap();
                assert_eq!(bits(&a), bits(&b), "{shape:?} {form:?} cached t {t}");
                sampler
                    .sample_pose(t, &rest, &mut scratch, &mut a, Some(&mut cache_a))
                    .unwrap();
                assert_eq!(bits(&a), bits(&b), "{shape:?} {form:?} both cached t {t}");
                for track in 0..clip.tracks.len() + 1 {
                    let mut x = [7.0f32; 4];
                    let mut y = [7.0f32; 4];
                    let rx = sampler.sample_track(track, t, &mut x);
                    let ry = bound.sample_track(track, t, &mut y);
                    assert_eq!(rx, ry, "{shape:?} {form:?} track {track} t {t}");
                    assert_eq!(x.map(f32::to_bits), y.map(f32::to_bits));
                }
            }
            // One cache shared by the record path and the table path stays coherent.
            let mut mem = vec![0.0f32; sampler.cache_len()];
            let mut cache = SegmentCache::new(&mut mem);
            for t in times(clip.duration) {
                sampler
                    .sample_pose(t, &rest, &mut scratch, &mut a, Some(&mut cache))
                    .unwrap();
                bound
                    .sample_pose(t + 0.37, &rest, &mut scratch, &mut b, Some(&mut cache))
                    .unwrap();
                let mut c = vec![SoaTransform::default(); soa_len(n)];
                sampler
                    .sample_pose(t + 0.37, &rest, &mut scratch, &mut c, None)
                    .unwrap();
                assert_eq!(bits(&b), bits(&c), "{shape:?} {form:?} shared cache t {t}");
            }
        }
    }
}

#[test]
fn property_tracks_have_value_columns() {
    let (_, clip) = mixed(Shape::Chain(8), 35, 1.0);
    let bytes = clip.write().unwrap();
    let view = ClipView::parse(&bytes).unwrap();
    let sampler = ClipSampler::new(view, Form::Compressed).unwrap();
    let b = ClipBindings::new(&sampler);
    let bound = b.bind(&sampler).unwrap();
    let mut offset = 0;
    for (i, track) in clip.tracks.iter().enumerate() {
        match b.column(i) {
            None => assert_eq!(track.kind, TrackKind::Bone),
            Some(c) => {
                assert_eq!(c.offset, offset);
                assert_eq!(c.width, track.kind.width() as u32);
                offset += c.width;
            }
        }
    }
    assert_eq!(b.column_words(), offset as usize);
    let mut words = vec![0u32; b.column_words()];
    assert!(bound.sample_columns(0.4, false, &mut words));
    for c in b.columns() {
        let mut v = [0.0f32; 4];
        let r = bound.sample_track(c.track as usize, 0.4, &mut v);
        if c.default {
            assert_eq!(r, TrackSample::Default);
            continue;
        }
        for k in 0..c.width as usize {
            assert_eq!(words[c.offset as usize + k], v[k].to_bits());
        }
    }
}
