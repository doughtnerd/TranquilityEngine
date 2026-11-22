//! `anim-sample` against `anim-offline::sample` (f64) and against the compressor's bound.
//!
//! Tolerances: the runtime decodes and interpolates in f32 where the reference uses f64, so
//! like-for-like comparisons allow 1e-5 (absolute; values here stay under ~5, whose f32 ulp is
//! 4.8e-7, and a decode is a handful of rounded operations). Compressed-vs-raw comparisons allow
//! the compressor's bound plus 2 % between frames (model-space composition of interpolated locals
//! isn't exactly convex) plus 1e-6 m for f32 rounding.

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{Binding, Clip, ClipView, Key, KeyData, Track, TrackKind};
use anim_format::NONE;
use anim_math::layout::{soa_len, unpack_pose};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_offline::math::{Quat, Transform, Vec3};
use anim_offline::sample as reference;
use anim_sample::{ClipSampler, Form, SampleError, SegmentCache, TrackSample};
use common::*;

const F32_TOL: f64 = 1e-5;

fn to_f64(t: &AosTransform) -> Transform {
    Transform {
        translation: Vec3::new(
            t.translation.x as f64,
            t.translation.y as f64,
            t.translation.z as f64,
        ),
        rotation: Quat::new(
            t.rotation.x as f64,
            t.rotation.y as f64,
            t.rotation.z as f64,
            t.rotation.w as f64,
        ),
        scale: Vec3::new(t.scale.x as f64, t.scale.y as f64, t.scale.z as f64),
    }
}

fn rest_aos(rest: &[Transform]) -> Vec<AosTransform> {
    rest.iter()
        .map(|t| {
            AosTransform::new(
                AosVec3::new(
                    t.translation.x as f32,
                    t.translation.y as f32,
                    t.translation.z as f32,
                ),
                AosQuat::new(
                    t.rotation.x as f32,
                    t.rotation.y as f32,
                    t.rotation.z as f32,
                    t.rotation.w as f32,
                ),
                AosVec3::new(t.scale.x as f32, t.scale.y as f32, t.scale.z as f32),
            )
        })
        .collect()
}

struct Runner<'a> {
    sampler: ClipSampler<'a>,
    rest: Vec<AosTransform>,
    scratch: Vec<AosTransform>,
    soa: Vec<SoaTransform>,
}

impl<'a> Runner<'a> {
    fn new(view: ClipView<'a>, form: Form, rest: &[Transform]) -> Self {
        let sampler = ClipSampler::new(view, form).unwrap();
        let n = rest.len();
        Runner {
            sampler,
            rest: rest_aos(rest),
            scratch: vec![AosTransform::default(); sampler.scratch_len()],
            soa: vec![SoaTransform::default(); soa_len(n)],
        }
    }
    fn pose(&mut self, t: f32, cache: Option<&mut SegmentCache<'_>>) -> Vec<Transform> {
        self.sampler
            .sample_pose(t, &self.rest, &mut self.scratch, &mut self.soa, cache)
            .unwrap();
        let mut aos = vec![AosTransform::default(); self.rest.len()];
        unpack_pose(&self.soa, &mut aos);
        aos.iter().map(to_f64).collect()
    }
}

fn assert_close(a: &[Transform], b: &[Transform], tol: f64, what: &str) {
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        let dt = (x.translation - y.translation).length();
        let ds = (x.scale - y.scale).length();
        let q = if x.rotation.dot(y.rotation) < 0.0 {
            -y.rotation
        } else {
            y.rotation
        };
        let dq = Quat::new(
            x.rotation.x - q.x,
            x.rotation.y - q.y,
            x.rotation.z - q.z,
            x.rotation.w - q.w,
        )
        .length();
        assert!(
            dt <= tol && ds <= tol && dq <= tol,
            "{what}: bone {i}: {dt} {dq} {ds}"
        );
    }
}

/// Times: 0, the duration, every frame time and random times between.
fn times(clip: &Clip, rng: &mut Rng) -> Vec<f32> {
    let mut t = vec![0.0, clip.duration];
    t.extend((0..clip.frame_count).map(|f| f as f32 / clip.sample_rate));
    t.extend((0..30).map(|_| rng.f64(0.0, clip.duration as f64) as f32));
    t
}

fn fixture(shape: Shape, seed: u64) -> (anim_format::skeleton::Skeleton, Clip, Vec<u8>) {
    let mut rng = Rng::new(seed);
    let skel = skeleton(shape, &mut rng);
    let clip = clip(&skel, 2.0, seed.is_multiple_of(2), &mut rng);
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    let out = compress(&clip, Some(&skel), &settings).unwrap();
    (skel, clip, out.bytes)
}

/// `CLIP_SLERP` clips interpolate rotations with slerp in both forms (one case per option; the
/// nlerp default is every other test).
#[test]
fn slerp_clips_match_the_reference() {
    let mut rng = Rng::new(17);
    let skel = skeleton(Shape::Chain(6), &mut rng);
    let mut clip = clip(&skel, 2.0, false, &mut rng);
    clip.flags |= anim_format::clip::CLIP_SLERP;
    let settings = Settings {
        keep_raw: true,
        ..Settings::default()
    };
    let bytes = compress(&clip, Some(&skel), &settings).unwrap().bytes;
    let view = ClipView::parse(&bytes).unwrap();
    let (rest, _) = rest_and_parents(&skel);
    let mut c = Runner::new(view, Form::Compressed, &rest);
    let mut r = Runner::new(view, Form::Raw, &rest);
    for t in times(&clip, &mut rng) {
        let rc = reference::sample_compressed_pose(&view, &rest, t as f64).unwrap();
        assert_close(
            &c.pose(t, None),
            &rc,
            F32_TOL,
            &format!("slerp compressed t {t}"),
        );
        let rr = reference::sample_raw_pose(&view, &rest, t as f64);
        assert_close(&r.pose(t, None), &rr, F32_TOL, &format!("slerp raw t {t}"));
    }
}

#[test]
fn raw_form_matches_the_reference() {
    for (shape, seed) in [
        (Shape::Humanoid, 1),
        (Shape::Chain(5), 2),
        (Shape::Single, 3),
    ] {
        let (skel, clip, bytes) = fixture(shape, seed);
        let view = ClipView::parse(&bytes).unwrap();
        let (rest, _) = rest_and_parents(&skel);
        let mut r = Runner::new(view, Form::Raw, &rest);
        let mut rng = Rng::new(seed);
        for t in times(&clip, &mut rng) {
            let a = r.pose(t, None);
            let b = reference::sample_raw_pose(&view, &rest, t as f64);
            assert_close(&a, &b, F32_TOL, &format!("{shape:?} raw t {t}"));
        }
    }
}

#[test]
fn compressed_form_matches_the_reference_decode() {
    for (shape, seed) in [
        (Shape::Humanoid, 4),
        (Shape::Tree(80), 5),
        (Shape::Chain(3), 6),
    ] {
        let (skel, clip, bytes) = fixture(shape, seed);
        let view = ClipView::parse(&bytes).unwrap();
        let (rest, _) = rest_and_parents(&skel);
        let mut r = Runner::new(view, Form::Compressed, &rest);
        let mut rng = Rng::new(seed);
        for t in times(&clip, &mut rng) {
            let a = r.pose(t, None);
            let b = reference::sample_compressed_pose(&view, &rest, t as f64).unwrap();
            assert_close(&a, &b, F32_TOL, &format!("{shape:?} compressed t {t}"));
        }
    }
}

#[test]
fn compressed_stays_within_the_bound_of_raw() {
    let bound = Settings::default().error as f64;
    for (shape, seed) in [
        (Shape::Humanoid, 8),
        (Shape::Tree(80), 9),
        (Shape::Chain(12), 10),
    ] {
        let (skel, clip, bytes) = fixture(shape, seed);
        let view = ClipView::parse(&bytes).unwrap();
        let (rest, parents) = rest_and_parents(&skel);
        let sh = shells(&skel);
        let mut c = Runner::new(view, Form::Compressed, &rest);
        let mut r = Runner::new(view, Form::Raw, &rest);
        let mut rng = Rng::new(seed);
        for t in times(&clip, &mut rng) {
            let e = pose_error(&parents, &sh, &c.pose(t, None), &r.pose(t, None));
            assert!(e <= bound * 1.02 + 1e-6, "{shape:?} t {t}: {e}");
        }
    }
}

#[test]
fn the_segment_cache_is_bit_identical() {
    let (skel, clip, bytes) = fixture(Shape::Humanoid, 12);
    let (skel2, _, bytes2) = fixture(Shape::Humanoid, 13);
    let view = ClipView::parse(&bytes).unwrap();
    let view2 = ClipView::parse(&bytes2).unwrap();
    let (rest, _) = rest_and_parents(&skel);
    let (rest2, _) = rest_and_parents(&skel2);
    let mut a = Runner::new(view, Form::Compressed, &rest);
    let mut b = Runner::new(view2, Form::Compressed, &rest2);
    let mut mem = vec![0.0f32; a.sampler.cache_len().max(b.sampler.cache_len())];
    let mut cache = SegmentCache::new(&mut mem);
    let bits = |p: &[Transform]| -> Vec<u64> {
        p.iter()
            .flat_map(|t| {
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
            .map(f64::to_bits)
            .collect()
    };
    // Sequential playback at 60 Hz through every segment, forward then backward.
    let mut t = 0.0f32;
    while t <= clip.duration {
        assert_eq!(
            bits(&a.pose(t, Some(&mut cache))),
            bits(&a.pose(t, None)),
            "t {t}"
        );
        t += 1.0 / 60.0;
    }
    while t >= 0.0 {
        assert_eq!(
            bits(&a.pose(t, Some(&mut cache))),
            bits(&a.pose(t, None)),
            "t {t}"
        );
        t -= 1.0 / 45.0;
    }
    // Alternating clips through one cache (it must notice the other clip).
    let mut t = 0.0f32;
    while t <= clip.duration {
        let x = a.pose(t, Some(&mut cache));
        assert_eq!(bits(&x), bits(&a.pose(t, None)), "t {t}");
        let y = b.pose(t, Some(&mut cache));
        assert_eq!(bits(&y), bits(&b.pose(t, None)), "t {t}");
        t += 1.0 / 60.0;
    }
    // A cache too short is ignored.
    let mut small = [0.0f32; 2];
    let mut cache = SegmentCache::new(&mut small);
    let x = a.pose(0.5, Some(&mut cache));
    assert_eq!(bits(&x), bits(&a.pose(0.5, None)));
}

#[test]
fn padding_lanes_are_identity_and_time_clamps() {
    let (skel, clip, bytes) = fixture(Shape::Chain(5), 14);
    let view = ClipView::parse(&bytes).unwrap();
    let (rest, _) = rest_and_parents(&skel);
    let mut r = Runner::new(view, Form::Compressed, &rest);
    r.pose(0.3, None);
    let lanes = r.soa[1].to_aos();
    for l in &lanes[1..] {
        assert_eq!(l.translation.x, 0.0);
        assert_eq!(l.rotation.w, 1.0);
        assert_eq!(l.scale.y, 1.0);
    }
    let end = r.pose(clip.duration, None);
    assert_close(
        &r.pose(clip.duration + 5.0, None),
        &end,
        0.0,
        "past the end",
    );
    let start = r.pose(0.0, None);
    assert_close(&r.pose(-1.0, None), &start, 0.0, "before the start");
    assert_close(&r.pose(f32::NAN, None), &start, 0.0, "NaN time");
}

#[test]
fn refuses_wrong_lengths_and_missing_forms() {
    let (skel, _, bytes) = fixture(Shape::Chain(5), 15);
    let view = ClipView::parse(&bytes).unwrap();
    let (rest, _) = rest_and_parents(&skel);
    let s = ClipSampler::new(view, Form::Compressed).unwrap();
    let rest = rest_aos(&rest);
    let mut scratch = vec![AosTransform::default(); s.scratch_len()];
    let mut out = vec![SoaTransform::default(); 2];
    assert_eq!(
        s.sample_pose(0.0, &rest[..4], &mut scratch, &mut out, None),
        Err(SampleError::RestLength)
    );
    assert_eq!(
        s.sample_pose(0.0, &rest, &mut scratch[..3], &mut out, None),
        Err(SampleError::ScratchLength)
    );
    assert_eq!(
        s.sample_pose(0.0, &rest, &mut scratch, &mut out[..1], None),
        Err(SampleError::OutLength)
    );
    // A compressed-only clip has no raw form to read.
    let mut rng = Rng::new(15);
    let skel = skeleton(Shape::Chain(2), &mut rng);
    let c = clip(&skel, 1.0, false, &mut rng);
    let only = compress(&c, Some(&skel), &Settings::default())
        .unwrap()
        .bytes;
    let view = ClipView::parse(&only).unwrap();
    assert!(matches!(
        ClipSampler::new(view, Form::Raw),
        Err(SampleError::MissingForm)
    ));
    let raw_only = c.write().unwrap();
    let view = ClipView::parse(&raw_only).unwrap();
    assert!(matches!(
        ClipSampler::new(view, Form::Compressed),
        Err(SampleError::MissingForm)
    ));
}

/// A clip with every sampled property kind, a default one, a keyed one and a bone track.
pub fn property_clip() -> (Clip, Settings) {
    let frames = 46u32;
    let mut rng = Rng::new(21);
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
        TrackKind::Vec2,  // default
    ];
    let mut tracks = Vec::new();
    for (i, &kind) in kinds.iter().enumerate() {
        let w = kind.width() as usize;
        let mut raw = Vec::new();
        let axis = rng.unit();
        for f in 0..frames {
            let t = f as f64 / 30.0;
            if kind == TrackKind::Quat {
                let q = Quat::from_axis_angle(axis, (t * 3.0).sin() * 2.0);
                raw.extend_from_slice(&[q.x as f32, q.y as f32, q.z as f32, q.w as f32]);
                continue;
            }
            for k in 0..w {
                raw.push(match i {
                    8 => -2.5,
                    9 => [1.0, 2.0][k],
                    _ => ((t * (2.0 + k as f64) + i as f64).sin() * 4.0) as f32,
                });
            }
        }
        tracks.push(Track {
            kind,
            flags: 0,
            subtype: if kind == TrackKind::Quat && i % 2 == 1 {
                1
            } else {
                0
            },
            binding: Binding::property(0, NONE, NONE),
            raw,
            keys: Vec::new(),
        });
    }
    tracks.push(Track {
        kind: TrackKind::Marker,
        flags: 0,
        subtype: 0,
        binding: Binding::none(),
        raw: Vec::new(),
        keys: vec![Key {
            time: 0.5,
            end: 0.5,
            data: KeyData::Marker {
                kind: anim_format::clip::MarkerKind::Cue,
                name: NONE,
            },
        }],
    });
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 1.5,
        sample_rate: 30.0,
        frame_count: frames,
        bone_count: 0,
        root_bone: NONE,
        strings: vec!["node".into()],
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    let settings = Settings {
        property_error: 1e-3,
        track_errors: vec![(2, 1e-5)],
        property_defaults: vec![(9, vec![1.0, 2.0])],
        keep_raw: true,
        ..Settings::default()
    };
    (clip, settings)
}

#[test]
fn property_tracks_from_both_forms() {
    let (clip, settings) = property_clip();
    let out = compress(&clip, None, &settings).unwrap();
    assert!(out.report.within_bounds, "{:?}", out.report);
    let view = ClipView::parse(&out.bytes).unwrap();
    let comp = ClipSampler::new(view, Form::Compressed).unwrap();
    let raw = ClipSampler::new(view, Form::Raw).unwrap();
    let mut rng = Rng::new(22);
    for t in times(&clip, &mut rng) {
        for (i, track) in clip.tracks.iter().enumerate() {
            let w = track.kind.width() as usize;
            let mut a = [9.0f32; 4];
            let mut b = [9.0f32; 4];
            if track.kind.is_keyed() {
                assert_eq!(comp.sample_track(i, t, &mut a), TrackSample::Skipped);
                continue;
            }
            let ra = comp.sample_track(i, t, &mut a);
            assert_eq!(raw.sample_track(i, t, &mut b), TrackSample::Written);
            if i == 9 {
                assert_eq!(ra, TrackSample::Default);
                assert_eq!(a, [9.0; 4], "a default channel leaves out untouched");
                continue;
            }
            assert_eq!(ra, TrackSample::Written);
            // Against the reference decode and the reference raw sampler.
            let ref_c = reference::sample_compressed_track(&view, i, t as f64).unwrap();
            let ref_r = reference::sample_raw_track(&view, i, t as f64).unwrap();
            let bound = if i == 2 { 1e-5 } else { 1e-3 };
            for k in 0..w {
                assert!((a[k] as f64 - ref_c[k]).abs() <= F32_TOL, "track {i} t {t}");
                assert!((b[k] as f64 - ref_r[k]).abs() <= F32_TOL, "track {i} t {t}");
                // Quaternions: an interpolated rotation's components move by at most the
                // components' error (both normalised), plus f32 rounding.
                assert!(
                    (a[k] as f64 - b[k] as f64).abs() <= bound * 1.02 + 2e-6,
                    "track {i} t {t}: {} vs {}",
                    a[k],
                    b[k]
                );
            }
        }
    }
    let mut short = [0.0f32; 1];
    assert_eq!(comp.sample_track(2, 0.0, &mut short), TrackSample::Skipped);
    assert_eq!(comp.sample_track(99, 0.0, &mut short), TrackSample::Skipped);
}
