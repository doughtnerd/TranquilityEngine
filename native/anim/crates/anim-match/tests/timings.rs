//! Native search timings on a synthetic 30-minute database (54,000 frames at 30 Hz, the default
//! schema), printed, not asserted (budgets are `anim-bench`'s job, T82r; 0350's tripwire is 20
//! characters ≤ 0.6 ms per frame). The database is generated here, never committed.
//!
//! Run with `cargo test --release -p anim-match --test timings -- --ignored --nocapture`.

#![cfg(not(target_arch = "wasm32"))]

mod common;

use anim_format::clip::ClipView;
use anim_format::posedb::PoseDbView;
use anim_match::{
    bake, BakeClip, BakeSettings, MatchDb, SearchFilter, SearchMode, TagFilter, TagMask,
    TaggedRange,
};
use anim_math::F32x4;
use anim_sample::Form;
use common::*;
use std::hint::black_box;
use std::time::Instant;

#[test]
#[ignore]
fn search_timings_on_a_30_minute_database() {
    // 180 looping clips of 10 s with random speeds, turn rates and strides: 54,000 frames.
    let mut rng = Rng::new(42);
    let tags: [&[&str]; 4] = [&["idle"], &["walk"], &["run"], &["turn"]];
    let mut bytes = Vec::new();
    let mut kinds = Vec::new();
    for _ in 0..180 {
        let kind = rng.below(4) as usize;
        let speed = match kind {
            0 => 0.0,
            1 => rng.f32(0.8, 1.8),
            2 => rng.f32(2.5, 4.5),
            _ => rng.f32(0.8, 2.0),
        };
        let yaw_rate = if kind == 3 { rng.f32(-1.5, 1.5) } else { 0.0 };
        let strides = 4 + rng.below(12);
        let g = Gait {
            speed: Speed::constant(speed),
            yaw_rate,
            cycle: 10.0 / strides as f32,
            duration: 10.0,
            looping: true,
        };
        bytes.push(clip(g).write().unwrap());
        kinds.push(kind);
    }
    let skel_bytes = skeleton().write().unwrap();
    let skel = anim_format::skeleton::SkeletonView::parse(&skel_bytes).unwrap();
    let views: Vec<ClipView<'_>> = bytes.iter().map(|b| ClipView::parse(b).unwrap()).collect();
    let ranges: Vec<[TaggedRange<'_>; 1]> = kinds
        .iter()
        .map(|&k| {
            [TaggedRange {
                start: 0.0,
                end: 10.0,
                tags: tags[k],
            }]
        })
        .collect();
    let names: Vec<String> = (0..views.len()).map(|i| format!("clip{i}.anim")).collect();
    let clips: Vec<BakeClip<'_>> = views
        .iter()
        .zip(&ranges)
        .zip(&names)
        .map(|((v, r), n)| BakeClip {
            view: *v,
            form: Form::Raw,
            asset: n,
            ranges: r,
        })
        .collect();

    for past in [false, true] {
        let schema = anim_match::default_schema(LEFT_FOOT, RIGHT_FOOT, HIPS, past);
        let t = Instant::now();
        let baked = bake(&skel, &clips, &schema, &BakeSettings::default()).unwrap();
        let bake_ms = t.elapsed().as_secs_f64() * 1e3;
        let view = PoseDbView::parse(&baked.bytes).unwrap();
        let t = Instant::now();
        let db = MatchDb::new(&view).unwrap();
        let load_ms = t.elapsed().as_secs_f64() * 1e3;
        let dims = db.dims();
        let n = db.frame_count();
        eprintln!(
            "schema {} dims, {n} frames ({:.1} min), file {:.1} MB: bake {bake_ms:.0} ms, load {load_ms:.1} ms, {} KD nodes",
            dims,
            n as f32 / RATE / 60.0,
            baked.bytes.len() as f64 / 1e6,
            view.kd_node_count()
        );

        // Queries near database frames (as a playing character's are) and anywhere.
        let make = |rng: &mut Rng, near: bool| -> Vec<F32x4> {
            let f = rng.below(n as u32) as usize;
            let v: Vec<f32> = (0..db.lanes() * 4)
                .map(|d| {
                    if d >= dims {
                        0.0
                    } else if near {
                        baked.db.matrix[f * dims + d] + rng.f32(-0.3, 0.3)
                    } else {
                        rng.f32(-2.0, 2.0)
                    }
                })
                .collect();
            v.as_chunks::<4>()
                .0
                .iter()
                .map(|c| F32x4::from_array(*c))
                .collect()
        };
        for (label, near) in [("near a frame", true), ("random", false)] {
            let queries: Vec<Vec<F32x4>> = (0..400).map(|_| make(&mut rng, near)).collect();
            for (filter_label, filter) in [
                ("no filter", SearchFilter::default()),
                (
                    "exclude idle",
                    SearchFilter {
                        tags: TagFilter {
                            excluded: TagMask::EMPTY.with(0),
                            ..TagFilter::default()
                        },
                        skip: None,
                    },
                ),
            ] {
                let mut per = [0.0f64; 2];
                for (m, mode) in [SearchMode::BruteForce, SearchMode::KdTree]
                    .iter()
                    .enumerate()
                {
                    for q in queries.iter().take(40) {
                        black_box(db.search(q, &filter, *mode));
                    }
                    let t = Instant::now();
                    for q in &queries {
                        black_box(db.search(q, &filter, *mode));
                    }
                    per[m] = t.elapsed().as_secs_f64() * 1e6 / queries.len() as f64;
                }
                eprintln!(
                    "  {label:<13} {filter_label:<13} brute force {:>8.1} µs   KD-tree {:>8.1} µs   (20 characters, search every 6 frames: {:.3} / {:.3} ms per frame)",
                    per[0],
                    per[1],
                    per[0] * 20.0 / 6.0 / 1e3,
                    per[1] * 20.0 / 6.0 / 1e3
                );
            }
        }
    }
}
