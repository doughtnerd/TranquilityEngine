//! The budget scenarios' parts, natively (`cargo bench -p anim-bench --bench parts`): clip sampling
//! (60 and 80 bones; compressed with and without a segment cache or a frame cache, and raw; through the binding
//! table, as the core samples), the rig stack alone (100 instances of the reference pose under the
//! budget graph's grounder and look-at), matching search (KD-tree and brute force, one query near a
//! database frame), retargeting one pose, and skinning matrices (model space and the 3×4 matrices).

use anim_bench::common::{self, synth, Shape};
use anim_bench::rcommon;
use anim_bench::scenario::*;
use anim_compress::{compress, Settings};
use anim_format::clip::ClipView;
use anim_format::posedb::PoseDbView;
use anim_format::skeleton::SkeletonView;
use anim_match::{MatchDb, SearchFilter, SearchMode};
use anim_math::layout::soa_len;
use anim_math::{AosMat3x4, AosTransform, F32x4, SoaTransform};
use anim_sample::{rest_pose, ClipBindings, ClipSampler, Form, FrameCache, SegmentCache};
use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn sampling(c: &mut Criterion) {
    let mut g = c.benchmark_group("sample_pose");
    for bones in [60, 80] {
        let shape = if bones == 80 {
            Shape::Humanoid80
        } else {
            Shape::Humanoid
        };
        let (skel, skel_bytes) = common::skeleton(shape, 3);
        let sview = SkeletonView::parse(&skel_bytes).unwrap();
        let mut rest = vec![AosTransform::identity(); bones];
        rest_pose(&sview, &mut rest);
        let mut rng = synth::Rng::new(31);
        let clip = synth::clip(&skel, 2.0, true, &mut rng);
        let raw = clip.write().unwrap();
        let comp = compress(&clip, Some(&skel), &Settings::default())
            .unwrap()
            .bytes;
        let mut scratch = vec![AosTransform::identity(); 2 * bones];
        let mut out = vec![SoaTransform::identity(); soa_len(bones)];
        for (form, bytes) in [(Form::Compressed, &comp), (Form::Raw, &raw)] {
            let view = ClipView::parse(bytes).unwrap();
            let sampler = ClipSampler::new(view, form).unwrap();
            let table = ClipBindings::new(&sampler);
            let bound = table.bind(&sampler).unwrap();
            let mut ranges = vec![0.0f32; table.cache_len()];
            let caches: &[bool] = if form == Form::Compressed {
                &[false, true]
            } else {
                &[false]
            };
            for &cached in caches {
                let label = match (form, cached) {
                    (Form::Raw, _) => "raw",
                    (_, false) => "compressed_uncached",
                    (_, true) => "compressed_cached",
                };
                let mut cache = SegmentCache::new(&mut ranges);
                let mut t = 0.0f32;
                g.bench_function(format!("{label}/{bones}_bones"), |b| {
                    b.iter(|| {
                        // Sequential playback at 60 Hz, as a playing clip samples.
                        t = (t + DT) % 2.0;
                        let cache = cached.then_some(&mut cache);
                        bound
                            .sample_pose(t, &rest, &mut scratch, &mut out, cache)
                            .unwrap();
                        black_box(out[0].translation.x)
                    })
                });
            }
            if form == Form::Compressed {
                // T82r: a clip player's frame cache (decoded frames and segment ranges).
                let mut head = vec![0u32; FrameCache::header_len(bones)];
                let mut frames = vec![SoaTransform::identity(); FrameCache::frames_len(bones)];
                let mut t = 0.0f32;
                g.bench_function(format!("compressed_frame_cache/{bones}_bones"), |b| {
                    b.iter(|| {
                        t = (t + DT) % 2.0;
                        let mut cache = FrameCache::new(&mut head, &mut frames, 0);
                        bound
                            .sample_pose_cached(t, &rest, &mut scratch, &mut out, &mut cache)
                            .unwrap();
                        black_box(out[0].translation.x)
                    })
                });
            }
        }
    }
    g.finish();
}

fn rig_stack(c: &mut Criterion) {
    let h = humanoid(80);
    let mut s = Characters::new(&h, Crowd::RigOnly, CROWD);
    c.bench_function("rig_stack_100/80_bones", |b| {
        b.iter(|| {
            s.frame();
            black_box(s.core.matrices()[0])
        })
    });
}

fn search(c: &mut Criterion) {
    let set = match_set();
    let view = PoseDbView::parse(&set.db).unwrap();
    let db = MatchDb::new(&view).unwrap();
    let dims = db.dims();
    let frames = db.frame_count();
    // 400 queries near database frames (as a playing character's are): a frame's normalized
    // features plus noise (`anim-match/tests/timings.rs`'s queries).
    let mut rng = anim_bench::mcommon::Rng::new(7);
    let queries: Vec<Vec<F32x4>> = (0..400)
        .map(|_| {
            let f = rng.below(frames as u32) as usize;
            let mut q = db.new_query();
            let mut v = vec![0.0f32; q.len() * 4];
            for (d, x) in v.iter_mut().enumerate().take(dims) {
                *x = set.matrix[f * dims + d] + rng.f32(-0.3, 0.3);
            }
            for (o, c) in q.iter_mut().zip(v.as_chunks::<4>().0) {
                *o = F32x4::from_array(*c);
            }
            q
        })
        .collect();
    let mut g = c.benchmark_group("match_search_54000_frames");
    for (label, mode) in [
        ("kd_tree", SearchMode::KdTree),
        ("brute_force", SearchMode::BruteForce),
    ] {
        let mut i = 0;
        g.bench_function(label, |b| {
            b.iter(|| {
                i = (i + 1) % queries.len();
                black_box(db.search(&queries[i], &SearchFilter::default(), mode))
            })
        });
    }
    g.finish();
}

fn retarget(c: &mut Criterion) {
    use anim_retarget::{MapSettings, Profile, RetargetMap, RetargetOptions, RootAxis};
    use rcommon::{humanoid, random_pose, soa, Axes, Build, Rng};
    let src = humanoid(Build {
        axes: Axes::YAlong,
        ..Build::default()
    });
    let tgt = humanoid(Build {
        axes: Axes::XAlong,
        leg: 1.3,
        arm_drop: 0.6,
        spine: 5,
        ..Build::default()
    });
    let p = Profile::humanoid();
    let map = RetargetMap::new(src.side(&p), tgt.side(&p), &MapSettings::default()).unwrap();
    let mut scratch = map.scratch();
    let poses: Vec<_> = (0..8)
        .map(|s| soa(&random_pose(&src, &mut Rng::new(s), 1.0)))
        .collect();
    let mut out = soa(&tgt.rest);
    let weights = [1.0, 1.0, 1.0, 1.0];
    let opts = RetargetOptions {
        root_axes: [RootAxis::Scaled, RootAxis::Unscaled, RootAxis::Scaled],
        ik_weights: &weights,
    };
    let mut i = 0;
    c.bench_function(
        &format!(
            "retarget_pose/{}_to_{}_bones",
            map.source_bone_count(),
            map.target_bone_count()
        ),
        |b| {
            b.iter(|| {
                i = (i + 1) % poses.len();
                map.retarget(&poses[i], &opts, &mut scratch, &mut out)
                    .unwrap();
                black_box(out[0].translation.x)
            })
        },
    );
}

fn skinning(c: &mut Criterion) {
    let mut g = c.benchmark_group("skinning_matrices");
    for bones in [60, 80] {
        let shape = if bones == 80 {
            Shape::Humanoid80
        } else {
            Shape::Humanoid
        };
        let (skel, skel_bytes) = common::skeleton(shape, 3);
        let sview = SkeletonView::parse(&skel_bytes).unwrap();
        let parents: Vec<u16> = skel.bones.iter().map(|b| b.parent).collect();
        let inverse: Vec<AosMat3x4> = skel
            .bones
            .iter()
            .map(|b| AosMat3x4::from_rows(b.inverse_bind))
            .collect();
        let mut rest = vec![AosTransform::identity(); bones];
        rest_pose(&sview, &mut rest);
        let local = soa(&rest);
        let mut model = vec![AosTransform::identity(); bones];
        let mut out = vec![0.0f32; 12 * bones];
        g.bench_function(format!("model_space/{bones}_bones"), |b| {
            b.iter(|| {
                anim_pose::model::model_space(&parents, black_box(&local), &mut model);
                black_box(model[bones - 1].translation.x)
            })
        });
        g.bench_function(format!("skinning_from_model/{bones}_bones"), |b| {
            b.iter(|| {
                anim_pose::model::skinning_from_model(black_box(&model), &inverse, &mut out);
                black_box(out[12 * bones - 1])
            })
        });
    }
    g.finish();
}

/// AoS transforms to a SoA pose (spare lanes identity).
fn soa(p: &[AosTransform]) -> Vec<SoaTransform> {
    rcommon::soa(p)
}

criterion_group!(benches, sampling, rig_stack, search, retarget, skinning);
criterion_main!(benches);
