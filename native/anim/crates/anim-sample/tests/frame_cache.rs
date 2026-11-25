//! T82r: a `FrameCache` gives the same bits as sampling without one: sequential playback at
//! several speeds (forward, reverse, faster than the clip's rate), seeks, frames in two segments,
//! one cache handed between clips and rest poses, a changed tag, a cache too short, and the raw
//! form; and a masked sample gives those bits on every bone its mask keeps. No tolerance:
//! bit-for-bit equality.

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::{ClipView, RotationFormat};
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_sample::{rest_pose, BoundClip, ClipBindings, ClipSampler, Form, FrameCache};
use common::*;

fn bits(p: &[SoaTransform]) -> Vec<u32> {
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
            .into_iter()
            .flat_map(|v| v.to_array())
            .map(f32::to_bits)
        })
        .collect()
}

struct Fixture {
    rest: Vec<AosTransform>,
    identity: Vec<AosTransform>,
    clips: Vec<(Vec<u8>, Vec<u8>)>,
    duration: f32,
}

/// A skeleton of `shape` and two clips (compressed and raw bytes each).
fn fixture(shape: Shape, seed: u64) -> Fixture {
    fixture_with(shape, seed, &Settings::default())
}

/// [`fixture`] compressed with `settings`.
fn fixture_with(shape: Shape, seed: u64, settings: &Settings) -> Fixture {
    let mut rng = Rng::new(seed);
    let skel = skeleton(shape, &mut rng);
    let skel_bytes = skel.write().unwrap();
    let view = anim_format::skeleton::SkeletonView::parse(&skel_bytes).unwrap();
    let mut rest = vec![AosTransform::identity(); skel.bones.len()];
    assert!(rest_pose(&view, &mut rest));
    let clips: Vec<(Vec<u8>, Vec<u8>)> = (0..2)
        .map(|_| {
            let clip = clip(&skel, 2.0, true, &mut rng);
            let comp = compress(&clip, Some(&skel), settings).unwrap().bytes;
            (comp, clip.write().unwrap())
        })
        .collect();
    let duration = ClipView::parse(&clips[0].0).unwrap().duration();
    Fixture {
        identity: vec![AosTransform::identity(); rest.len()],
        rest,
        clips,
        duration,
    }
}

/// Samples `clip` at `t` with and without `cache` and checks the bits agree.
fn check(
    clip: &BoundClip<'_, '_>,
    t: f32,
    rest: &[AosTransform],
    cache: &mut FrameCache<'_>,
    what: &str,
) {
    let n = rest.len();
    let mut scratch = vec![AosTransform::default(); 2 * n];
    let mut a = vec![SoaTransform::default(); soa_len(n)];
    let mut b = vec![SoaTransform::default(); soa_len(n)];
    clip.sample_pose(t, rest, &mut scratch, &mut a, None)
        .unwrap();
    clip.sample_pose_cached(t, rest, &mut scratch, &mut b, cache)
        .unwrap();
    assert_eq!(bits(&a), bits(&b), "{what} t {t}");
}

#[test]
fn cached_samples_match_uncached_bit_for_bit() {
    for (shape, seed) in [
        (Shape::Humanoid, 3),
        (Shape::Tree(37), 8),
        (Shape::Single, 2),
    ] {
        let fx = fixture(shape, seed);
        let n = fx.rest.len();
        let tables: Vec<(ClipSampler<'_>, ClipBindings)> = fx
            .clips
            .iter()
            .map(|(comp, _)| {
                let s = ClipSampler::new(ClipView::parse(comp).unwrap(), Form::Compressed).unwrap();
                (s, ClipBindings::new(&s))
            })
            .collect();
        let bound: Vec<BoundClip<'_, '_>> =
            tables.iter().map(|(s, b)| b.bind(s).unwrap()).collect();
        let mut head = vec![0u32; FrameCache::header_len(n)];
        let mut mem = vec![SoaTransform::default(); FrameCache::frames_len(n)];
        // Playback at 60 Hz: half, normal, 1.5x, 2x, 3x speed, and reverse; through the loop.
        for speed in [0.5f32, 1.0, 1.5, 2.0, 3.0, -1.0] {
            let mut cache = FrameCache::new(&mut head, &mut mem, 1);
            let mut t = 0.0f32;
            for _ in 0..200 {
                t = (t + speed / 60.0).rem_euclid(fx.duration);
                check(
                    &bound[0],
                    t,
                    &fx.rest,
                    &mut cache,
                    &format!("{shape:?} speed {speed}"),
                );
            }
        }
        // Seeks, and the clip's last frame (f0 == f1).
        let mut cache = FrameCache::new(&mut head, &mut mem, 1);
        for t in [
            0.0,
            1.9,
            0.53,
            0.54,
            1.0,
            fx.duration,
            fx.duration + 1.0,
            0.02,
            -0.5,
        ] {
            check(
                &bound[0],
                t,
                &fx.rest,
                &mut cache,
                &format!("{shape:?} seek"),
            );
        }
        // One cache handed between two clips, two rest poses and two tags.
        let mut t = 0.0f32;
        for i in 0..120 {
            t += 1.0 / 60.0;
            let mut cache = FrameCache::new(&mut head, &mut mem, (i / 7) as u32);
            let rest = if i % 5 == 0 { &fx.identity } else { &fx.rest };
            check(
                &bound[i % 2],
                t,
                rest,
                &mut cache,
                &format!("{shape:?} shared"),
            );
        }
        // Too short: samples without it.
        let mut short = vec![SoaTransform::default(); FrameCache::frames_len(n) - 1];
        let mut cache = FrameCache::new(&mut head, &mut short, 1);
        check(&bound[0], 0.3, &fx.rest, &mut cache, "short");
        let mut cache = FrameCache::new(&mut head[..1], &mut mem, 1);
        check(&bound[0], 0.3, &fx.rest, &mut cache, "short header");
        // Cleared: refilled.
        let mut cache = FrameCache::new(&mut head, &mut mem, 1);
        check(&bound[1], 0.3, &fx.rest, &mut cache, "before clear");
        cache.clear();
        check(&bound[1], 0.31, &fx.rest, &mut cache, "after clear");
    }
}

/// Full rotations decode channel by channel (not by group): the same bits either way.
#[test]
fn full_rotations_match_uncached_bit_for_bit() {
    let full = Settings {
        rotation_format: Some(RotationFormat::QuatFull),
        ..Settings::default()
    };
    for (fx, what) in [
        (fixture_with(Shape::Humanoid, 4, &full), "full rotations"),
        (fixture(Shape::Humanoid, 6), "w dropped"),
    ] {
        let n = fx.rest.len();
        let s =
            ClipSampler::new(ClipView::parse(&fx.clips[0].0).unwrap(), Form::Compressed).unwrap();
        let table = ClipBindings::new(&s);
        let bound = table.bind(&s).unwrap();
        let mut head = vec![0u32; FrameCache::header_len(n)];
        let mut mem = vec![SoaTransform::default(); FrameCache::frames_len(n)];
        let mut cache = FrameCache::new(&mut head, &mut mem, 1);
        let mut t = 0.0f32;
        for _ in 0..90 {
            t = (t + 1.3 / 60.0).rem_euclid(fx.duration);
            check(&bound, t, &fx.rest, &mut cache, what);
        }
    }
}

#[test]
fn the_raw_form_samples_as_without_a_cache() {
    let fx = fixture(Shape::Humanoid, 5);
    let s = ClipSampler::new(ClipView::parse(&fx.clips[0].1).unwrap(), Form::Raw).unwrap();
    let table = ClipBindings::new(&s);
    let bound = table.bind(&s).unwrap();
    let mut head = vec![0u32; FrameCache::header_len(fx.rest.len())];
    let mut mem = vec![SoaTransform::default(); FrameCache::frames_len(fx.rest.len())];
    let mut cache = FrameCache::new(&mut head, &mut mem, 0);
    let mut t = 0.0;
    for _ in 0..30 {
        t += 1.0 / 60.0;
        check(&bound, t, &fx.rest, &mut cache, "raw");
    }
}

/// A sample through a bone mask gives the unmasked bits on every bone whose weight is above 0
/// (whatever the output held before), while one cache moves between masks, no mask and another
/// clip: grouped (w-dropped) and channel-by-channel (full rotation) clips.
#[test]
fn masked_samples_match_on_the_bones_the_mask_keeps() {
    let full = Settings {
        rotation_format: Some(RotationFormat::QuatFull),
        ..Settings::default()
    };
    for (fx, what) in [
        (fixture(Shape::Humanoid, 9), "w dropped"),
        (fixture_with(Shape::Humanoid, 10, &full), "full rotations"),
        (fixture(Shape::Tree(37), 11), "tree"),
    ] {
        let n = fx.rest.len();
        let g = soa_len(n);
        let tables: Vec<(ClipSampler<'_>, ClipBindings)> = fx
            .clips
            .iter()
            .map(|(comp, _)| {
                let s = ClipSampler::new(ClipView::parse(comp).unwrap(), Form::Compressed).unwrap();
                (s, ClipBindings::new(&s))
            })
            .collect();
        let bound: Vec<BoundClip<'_, '_>> =
            tables.iter().map(|(s, b)| b.bind(s).unwrap()).collect();
        // An upper-body-like run of bones, a scattered mask (partial groups, a negative and a NaN
        // weight, which keep nothing), and nothing kept.
        let upper: Vec<f32> = (0..n)
            .map(|i| if (3..n / 2).contains(&i) { 1.0 } else { 0.0 })
            .collect();
        let scattered: Vec<f32> = (0..n)
            .map(|i| match i % 7 {
                0 => 0.25,
                3 => -1.0,
                5 => f32::NAN,
                _ => 0.0,
            })
            .collect();
        let none = vec![0.0f32; n];
        let masks = [pack(&upper), pack(&scattered), pack(&none)];
        let poison = SoaTransform::from_aos(
            &[AosTransform::new(
                AosVec3::new(f32::NAN, 1e30, -0.0),
                AosQuat::new(f32::NAN, 0.0, 0.0, 0.0),
                AosVec3::new(f32::INFINITY, 0.0, 0.0),
            ); 4],
        );
        let mut head = vec![0u32; FrameCache::header_len(n)];
        let mut mem = vec![SoaTransform::default(); FrameCache::frames_len(n)];
        {
            let mut t = 0.0f32;
            for i in 0..240 {
                t = (t + 1.3 / 60.0).rem_euclid(fx.duration);
                let mut cache = FrameCache::new(&mut head, &mut mem, 1);
                // One mask for runs of frames (held frames reused), sometimes no mask, and the
                // other clip every 50 frames.
                let clip = &bound[(i / 50) % 2];
                let mut scratch = vec![AosTransform::default(); 2 * n];
                let mut a = vec![SoaTransform::default(); g];
                clip.sample_pose(t, &fx.rest, &mut scratch, &mut a, None)
                    .unwrap();
                let mut b = vec![poison; g];
                if i % 13 == 6 {
                    clip.sample_pose_cached(t, &fx.rest, &mut scratch, &mut b, &mut cache)
                        .unwrap();
                    assert_eq!(bits(&a), bits(&b), "{what} unmasked, t {t}");
                    continue;
                }
                let m = &masks[(i / 20) % masks.len()];
                clip.sample_pose_masked(t, &fx.rest, &mut scratch, &mut b, &mut cache, m)
                    .unwrap();
                for (k, (x, y)) in bits(&a).iter().zip(&bits(&b)).enumerate() {
                    let (group, lane) = (k / 40, k % 4);
                    if m[group].to_array()[lane] > 0.0 {
                        assert_eq!(x, y, "{what} masked, t {t}, bone {}", 4 * group + lane);
                    }
                }
            }
        }
    }
}

/// Per-bone weights packed four lanes a group (spare lanes 0), as the core packs a mask asset.
fn pack(per_bone: &[f32]) -> Vec<F32x4> {
    (0..soa_len(per_bone.len()))
        .map(|g| {
            let at = |l: usize| per_bone.get(4 * g + l).copied().unwrap_or(0.0);
            F32x4::new(at(0), at(1), at(2), at(3))
        })
        .collect()
}
