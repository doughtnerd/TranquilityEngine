//! `cargo run --release -p anim-sample --example pose_bench`: times 60-bone `sample_pose` (the
//! synthetic humanoid walk T11 measured) through the clip-record path and the binding-table path,
//! with and without a segment cache. Wall-clock numbers for the build log, not a test.

#[path = "../../anim-compress/tests/common/mod.rs"]
mod common;

use anim_compress::{compress, Settings};
use anim_format::clip::ClipView;
use anim_math::layout::soa_len;
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_sample::{ClipBindings, ClipSampler, Form, SegmentCache};
use common::*;
use std::hint::black_box;
use std::time::Instant;

const ITERS: usize = 200_000;

/// One sampling call: time, scratch, output.
type Sample<'f> = &'f mut dyn FnMut(f32, &mut [AosTransform], &mut [SoaTransform]);

fn main() {
    let mut rng = Rng::new(3);
    let skel = skeleton(Shape::Humanoid, &mut rng);
    let clip = clip(&skel, 2.0, true, &mut rng);
    let bytes = compress(&clip, Some(&skel), &Settings::default())
        .unwrap()
        .bytes;
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
    let sampler = ClipSampler::new(view, Form::Compressed).unwrap();
    let bindings = ClipBindings::new(&sampler);
    let bound = bindings.bind(&sampler).unwrap();
    let mut scratch = vec![AosTransform::default(); sampler.scratch_len()];
    let mut out = vec![SoaTransform::default(); soa_len(rest.len())];
    let mut mem = vec![0.0f32; sampler.cache_len()];
    let dt = 1.0 / 60.0;

    let mut run = |name: &str, f: Sample<'_>| {
        let mut t = 0.0f32;
        for _ in 0..1000 {
            f(t, &mut scratch, &mut out);
            t = (t + dt) % 2.0;
        }
        let start = Instant::now();
        let mut t = 0.0f32;
        for _ in 0..ITERS {
            f(black_box(t), &mut scratch, &mut out);
            black_box(&out);
            t = (t + dt) % 2.0;
        }
        let ns = start.elapsed().as_nanos() as f64 / ITERS as f64;
        println!("{name:<28} {:>8.3} µs per 60-bone pose", ns / 1000.0);
    };

    run("records, uncached", &mut |t, s, o| {
        sampler.sample_pose(t, &rest, s, o, None).unwrap()
    });
    {
        let mut cache = SegmentCache::new(&mut mem);
        run("records, cached", &mut |t, s, o| {
            sampler
                .sample_pose(t, &rest, s, o, Some(&mut cache))
                .unwrap()
        });
    }
    run("binding table, uncached", &mut |t, s, o| {
        bound.sample_pose(t, &rest, s, o, None).unwrap()
    });
    {
        let mut cache = SegmentCache::new(&mut mem);
        run("binding table, cached", &mut |t, s, o| {
            bound.sample_pose(t, &rest, s, o, Some(&mut cache)).unwrap()
        });
    }
}
