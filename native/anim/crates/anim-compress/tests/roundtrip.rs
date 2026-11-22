//! Round trips over synthetic clips: the reported and the independently measured error stay
//! under the bound, the output is deterministic, sizes are sane.
//!
//! "Independently measured" decodes the written bytes with `anim-offline::sample` (bit by bit,
//! f64) and compares with the raw form in model space with the same virtual-vertex metric. Both
//! use f64 throughout, so the only slack allowed over the bound is f64 rounding (1e-12 m).

mod common;

use anim_compress::{compress, RootMotion, Settings, ROOT_ALL, ROOT_X, ROOT_Z};
use anim_format::clip::{
    Binding, ChannelMode, Clip, ClipView, RotationFormat, Track, TrackKind, CLIP_LOOP,
};
use anim_format::NONE;
use anim_offline::math::{local_to_model, Quat, Vec3};
use anim_offline::sample::{
    compressed_pose_at_frame, compressed_track_at_frame, raw_frame, raw_pose_at_frame,
    sample_compressed_pose, sample_raw_pose,
};
use common::*;

const F64_SLACK: f64 = 1e-12;

fn check_roundtrip(shape: Shape, seed: u64, looping: bool, settings: &Settings) -> anim_compress::Report {
    let mut rng = Rng::new(seed);
    let skel = skeleton(shape, &mut rng);
    let clip = clip(&skel, 2.0, looping, &mut rng);
    let out = compress(&clip, Some(&skel), settings).expect("compresses");
    let r = &out.report;
    let bound = settings.error as f64;
    assert!(r.within_bounds, "{shape:?} seed {seed}: {r:?}");
    assert!(r.max_error as f64 <= bound, "{shape:?} seed {seed}: reported {}", r.max_error);

    // Independent: decode the bytes, compare with the raw input frame by frame.
    let raw_bytes = clip.write().unwrap();
    let raw_view = ClipView::parse(&raw_bytes).unwrap();
    let view = ClipView::parse(&out.bytes).unwrap();
    assert_eq!(view.flags() & CLIP_LOOP != 0, looping);
    let (rest, parents) = rest_and_parents(&skel);
    let shells = shells(&skel);
    let mut worst = 0.0f64;
    for f in 0..clip.frame_count {
        let a = raw_pose_at_frame(&raw_view, &rest, f);
        let b = compressed_pose_at_frame(&view, &rest, f).unwrap();
        worst = worst.max(pose_error(&parents, &shells, &a, &b));
    }
    assert!(worst <= bound + F64_SLACK, "{shape:?} seed {seed}: measured {worst}");
    // The report is that same measurement.
    assert!(
        (worst - r.max_error as f64).abs() <= 1e-9,
        "{shape:?} seed {seed}: measured {worst}, reported {}",
        r.max_error
    );
    assert_eq!(view.compressed().unwrap().max_error(), r.max_error);

    // Between frames, both forms interpolate their own samples; the error stays near the bound
    // (model-space composition of interpolated locals isn't exactly convex): 2 % slack.
    for i in 0..40 {
        let t = clip.duration as f64 * i as f64 / 39.0 + if i % 2 == 1 { 0.0123 } else { 0.0 };
        let a = sample_raw_pose(&raw_view, &rest, t);
        let b = sample_compressed_pose(&view, &rest, t).unwrap();
        let e = pose_error(&parents, &shells, &a, &b);
        assert!(e <= bound * 1.02, "{shape:?} seed {seed} t {t}: {e}");
    }
    out.report
}

#[test]
fn roundtrips_meet_the_bound_on_every_skeleton() {
    let settings = Settings::default();
    for (i, shape) in [
        Shape::Single,
        Shape::Chain(5),
        Shape::Chain(24),
        Shape::Humanoid,
        Shape::Tree(80),
    ]
    .into_iter()
    .enumerate()
    {
        for seed in 0..2u64 {
            check_roundtrip(shape, 100 + i as u64 * 10 + seed, seed == 0, &settings);
        }
    }
}

#[test]
fn looser_and_tighter_bounds() {
    for error in [1e-3f32, 1e-5] {
        let settings = Settings {
            error,
            ..Settings::default()
        };
        check_roundtrip(Shape::Humanoid, 7, true, &settings);
    }
}

#[test]
fn both_rotation_formats_meet_the_bound() {
    for f in [RotationFormat::QuatDropW, RotationFormat::QuatFull] {
        let settings = Settings {
            rotation_format: Some(f),
            ..Settings::default()
        };
        let r = check_roundtrip(Shape::Chain(8), 31, false, &settings);
        assert_eq!(r.rotation_format, f);
    }
}

#[test]
fn compression_is_deterministic() {
    let mut rng = Rng::new(5);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let a = compress(&clip, Some(&skel), &Settings::default()).unwrap();
    let b = compress(&clip, Some(&skel), &Settings::default()).unwrap();
    assert_eq!(a.bytes, b.bytes);
    assert_eq!(a.report, b.report);
}

/// A clip of rest-pose and constant channels: no bitstream at all.
#[test]
fn constant_clip_compresses_to_near_header_size() {
    let mut rng = Rng::new(9);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let mut clip = clip(&skel, 2.0, false, &mut rng);
    for (i, t) in clip.tracks.iter_mut().enumerate() {
        let first: Vec<f32> = t.raw[..10].to_vec();
        if i % 2 == 0 {
            // The rest pose.
            let b = &skel.bones[i];
            let rest = [
                b.translation[0], b.translation[1], b.translation[2], b.rotation[0],
                b.rotation[1], b.rotation[2], b.rotation[3], 1.0, 1.0, 1.0,
            ];
            for f in t.raw.chunks_mut(10) {
                f.copy_from_slice(&rest);
            }
        } else {
            for f in t.raw.chunks_mut(10) {
                f.copy_from_slice(&first);
            }
        }
    }
    let out = compress(&clip, Some(&skel), &Settings::default()).unwrap();
    let r = &out.report;
    assert_eq!(r.channels[2], 0, "no animated channels: {r:?}");
    assert_eq!(r.max_error, 0.0f32.max(r.max_error));
    let view = ClipView::parse(&out.bytes).unwrap();
    let c = view.compressed().unwrap();
    assert!(c.data().is_empty());
    // Header, channel table (16 B per channel) and the constants: nothing per frame.
    let constants = c.constants().len() * 4;
    let fixed = 32 + 16 * c.channel_count() + constants + 16 * c.segment_count();
    assert!(r.compressed_size <= fixed + 64, "{} vs {fixed}", r.compressed_size);
    assert!(r.ratio() > 10.0, "ratio {}", r.ratio());
    // Every even track is entirely default.
    for (i, t) in out.clip.tracks.iter().enumerate() {
        if i % 2 == 0 {
            assert_eq!(t.flags & anim_format::clip::TRACK_DEFAULT, anim_format::clip::TRACK_DEFAULT);
        }
    }
}

/// The walk the plan asks to measure: 60 bones, 2 s at 30 Hz.
#[test]
fn walk_60_bones_sizes() {
    let mut rng = Rng::new(60);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let out = compress(&clip, Some(&skel), &Settings::default()).unwrap();
    let r = &out.report;
    println!(
        "walk60: raw {} B, compressed {} B, file {} B, ratio {:.2}, max error {:.3e} m at {:?}, channels d/c/a {:?}, {:?}",
        r.raw_size, r.compressed_size, r.file_size, r.ratio(), r.max_error, r.worst_bone, r.channels, r.rotation_format
    );
    assert!(r.within_bounds);
    assert!(r.ratio() > 3.0, "ratio {}", r.ratio());
}

#[test]
fn property_tracks_meet_their_absolute_bounds() {
    let frames = 61u32;
    let mut rng = Rng::new(77);
    let mut tracks = Vec::new();
    let kinds = [
        TrackKind::Float,
        TrackKind::Vec2,
        TrackKind::Vec3,
        TrackKind::Vec4,
        TrackKind::Color,
        TrackKind::Quat,
        TrackKind::Morph,
        TrackKind::Curve,
        TrackKind::Float, // constant
        TrackKind::Vec3,  // equal to its default
    ];
    for (i, &kind) in kinds.iter().enumerate() {
        let w = kind.width() as usize;
        let mut raw = Vec::new();
        let axis = rng.unit();
        for f in 0..frames {
            let t = f as f64 / 30.0;
            if kind == TrackKind::Quat {
                let q = Quat::from_axis_angle(axis, (t * 2.0).sin() * 2.5);
                raw.extend_from_slice(&[q.x as f32, q.y as f32, q.z as f32, q.w as f32]);
                continue;
            }
            for k in 0..w {
                let v = match i {
                    8 => 3.25,
                    9 => [0.5, -1.0, 2.0][k],
                    _ => (t * (1.0 + k as f64) + i as f64).sin() * 10.0 + rng.f64(-0.01, 0.01),
                };
                raw.push(v as f32);
            }
        }
        tracks.push(Track {
            kind,
            flags: 0,
            subtype: 0,
            binding: Binding::property(0, 1, 2),
            raw,
            keys: Vec::new(),
        });
    }
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 2.0,
        sample_rate: 30.0,
        frame_count: frames,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["node".into(), "engine.Thing".into(), "field".into()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    let settings = Settings {
        property_error: 1e-3,
        track_errors: vec![(1, 1e-5), (4, 1.0 / 255.0)],
        property_defaults: vec![(9, vec![0.5, -1.0, 2.0])],
        ..Settings::default()
    };
    let out = compress(&clip, None, &settings).unwrap();
    let r = &out.report;
    assert!(r.within_bounds, "{r:?}");
    assert_eq!(r.tracks.len(), kinds.len());
    let view = ClipView::parse(&out.bytes).unwrap();
    let raw_bytes = clip.write().unwrap();
    let raw_view = ClipView::parse(&raw_bytes).unwrap();
    for te in &r.tracks {
        let track = te.track as usize;
        let bound = match track {
            1 => 1e-5,
            4 => 1.0 / 255.0,
            _ => 1e-3,
        } as f32;
        assert_eq!(te.bound, bound);
        assert!(te.error <= te.bound, "{te:?}");
        // Independent decode against the raw form.
        let w = clip.tracks[track].kind.width() as usize;
        let mut worst = 0.0f64;
        for f in 0..frames {
            let raw = raw_frame(&raw_view, track, f).unwrap();
            let Some(dec) = compressed_track_at_frame(&view, track, f) else {
                // Default channel: the field default.
                assert_eq!(track, 9);
                continue;
            };
            let mut raw64: Vec<f64> = raw.iter().map(|&x| x as f64).collect();
            if clip.tracks[track].kind == TrackKind::Quat {
                let q = Quat::new(raw64[0], raw64[1], raw64[2], raw64[3]);
                let d = Quat::new(dec[0], dec[1], dec[2], dec[3]);
                if q.dot(d) < 0.0 {
                    raw64.iter_mut().for_each(|x| *x = -*x);
                }
            }
            for k in 0..w {
                worst = worst.max((raw64[k] - dec[k]).abs());
            }
        }
        assert!(worst <= bound as f64 + F64_SLACK, "track {track}: {worst}");
    }
    let c = view.compressed().unwrap();
    let mode = |track: u32| {
        (0..c.channel_count())
            .map(|i| c.channel(i).unwrap())
            .find(|ch| ch.track == track)
            .unwrap()
            .mode
    };
    assert_eq!(mode(8), ChannelMode::Constant);
    assert_eq!(mode(9), ChannelMode::Default);
    assert_eq!(mode(0), ChannelMode::Animated);
}

#[test]
fn root_curve_matches_the_raw_root_bone() {
    let mut rng = Rng::new(42);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, false, &mut rng);
    for axes in [ROOT_ALL, ROOT_X | ROOT_Z] {
        let settings = Settings {
            root_motion: Some(RootMotion { bone: 0, axes }),
            ..Settings::default()
        };
        let out = compress(&clip, Some(&skel), &settings).unwrap();
        let view = ClipView::parse(&out.bytes).unwrap();
        assert_eq!(view.root_bone(), 0);
        let raw_bytes = clip.write().unwrap();
        let raw_view = ClipView::parse(&raw_bytes).unwrap();
        let (rest, parents) = rest_and_parents(&skel);
        let model = |f: u32| local_to_model(&parents, &raw_pose_at_frame(&raw_view, &rest, f))[0];
        let m0 = model(0);
        let yaw = |q: Quat| {
            let q = if q.w < 0.0 { -q } else { q };
            2.0 * q.y.atan2(q.w)
        };
        for f in 0..clip.frame_count {
            let m = model(f);
            let rc = view.root_frame(f as usize).unwrap();
            let d = m.translation - m0.translation;
            let expect = [
                if axes & ROOT_X != 0 { d.x } else { 0.0 },
                if axes & 2 != 0 { d.y } else { 0.0 },
                if axes & ROOT_Z != 0 { d.z } else { 0.0 },
            ];
            for k in 0..3 {
                assert!((rc[k] as f64 - expect[k]).abs() < 1e-5, "frame {f} axis {k}");
            }
            // The root turns 0.4 rad/s about +Y on top of a wobble: within the unwrapped range.
            if axes == ROOT_ALL {
                let mut y = yaw(m.rotation) - yaw(m0.rotation);
                while y - rc[3] as f64 > std::f64::consts::PI {
                    y -= std::f64::consts::TAU;
                }
                while y - (rc[3] as f64) < -std::f64::consts::PI {
                    y += std::f64::consts::TAU;
                }
                assert!((rc[3] as f64 - y).abs() < 1e-5, "frame {f} yaw {} vs {y}", rc[3]);
            } else {
                assert_eq!(rc[3], 0.0);
            }
        }
    }
}

#[test]
fn resamples_to_another_rate() {
    let mut rng = Rng::new(3);
    let skel = skeleton(Shape::Chain(6), &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let settings = Settings {
        sample_rate: Some(20.0),
        keep_raw: true,
        ..Settings::default()
    };
    let out = compress(&clip, Some(&skel), &settings).unwrap();
    let view = ClipView::parse(&out.bytes).unwrap();
    assert_eq!(view.sample_rate(), 20.0);
    assert_eq!(view.frame_count(), 41);
    assert!(view.raw().is_some());
    assert!(out.report.within_bounds);
    // The kept raw form at 20 Hz is the 30 Hz source sampled at those times.
    let raw_bytes = clip.write().unwrap();
    let src = ClipView::parse(&raw_bytes).unwrap();
    let (rest, parents) = rest_and_parents(&skel);
    let sh = shells(&skel);
    for f in 0..41 {
        let t = f as f64 / 20.0;
        let a = sample_raw_pose(&src, &rest, t);
        let b = raw_pose_at_frame(&view, &rest, f);
        assert!(pose_error(&parents, &sh, &a, &b) < 1e-5);
    }
}

#[test]
fn refuses_bad_inputs() {
    let mut rng = Rng::new(1);
    let skel = skeleton(Shape::Chain(3), &mut rng);
    let clip = clip(&skel, 1.0, false, &mut rng);
    assert!(compress(&clip, None, &Settings::default()).is_err());
    let other = skeleton(Shape::Chain(4), &mut rng);
    assert!(compress(&clip, Some(&other), &Settings::default()).is_err());
    let bad = Settings {
        error: 0.0,
        ..Settings::default()
    };
    assert!(compress(&clip, Some(&skel), &bad).is_err());
    let bad = Settings {
        max_bit_rate: 17,
        ..Settings::default()
    };
    assert!(compress(&clip, Some(&skel), &bad).is_err());
    let mut no_raw = clip.clone();
    no_raw.has_raw = false;
    no_raw.tracks.iter_mut().for_each(|t| t.raw.clear());
    assert!(compress(&no_raw, Some(&skel), &Settings::default()).is_err());
    let _ = Vec3::ZERO;
}
