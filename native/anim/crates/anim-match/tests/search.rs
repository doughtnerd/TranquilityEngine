//! Search: the KD-tree and brute force return the same result (frame and cost bits) over many
//! random queries, filters and skips; both agree with `anim-offline`'s f64 brute force; tags gate.
//!
//! Tolerance against the reference: the runtime sums ~30 squared differences of f32 values in
//! f32 (relative error ≤ ~30 ulp ≈ 4e-6), the reference in f64 from the same f32 inputs, so costs
//! agree to `1e-5 · (1 + cost)`; a frame the runtime picks costs within that of the reference's.

mod common;

use anim_format::posedb::{Feature, FeatureKind, FrameRef, PoseDb, PoseDbView};
use anim_format::NONE;
use anim_match::kdtree;
use anim_match::{
    BakeSettings, FeatureSpec, MatchDb, SearchFilter, SearchMode, Skip, TagFilter, TagMask,
};
use anim_math::F32x4;
use anim_offline::matching as reference;
use common::*;

/// The query lanes for normalised values `v` (scaled by √weight, as the database's rows are).
fn query_from(features: &[Feature], v: &[f32], lanes: usize) -> Vec<F32x4> {
    let mut flat = vec![0.0f32; lanes * 4];
    for f in features {
        for d in f.first_dim as usize..(f.first_dim + f.dims as u32) as usize {
            flat[d] = v[d] * f.weight.sqrt();
        }
    }
    flat.as_chunks::<4>()
        .0
        .iter()
        .map(|c| F32x4::from_array(*c))
        .collect()
}

fn weighted_schema() -> Vec<FeatureSpec> {
    schema()
        .into_iter()
        .enumerate()
        .map(|(i, mut f)| {
            f.weight = [2.0, 1.5, 1.0, 0.5, 0.75, 1.0, 0.25, 3.0][i % 8];
            f
        })
        .collect()
}

fn random_filter(rng: &mut Rng, tags: usize, frames: u32) -> SearchFilter {
    let mut t = TagFilter::default();
    match rng.below(5) {
        0 => t.required = TagMask::EMPTY.with(rng.below(tags as u32) as usize),
        1 => t.excluded = TagMask::EMPTY.with(rng.below(tags as u32) as usize),
        2 => {
            t.any = TagMask::EMPTY
                .with(rng.below(tags as u32) as usize)
                .with(rng.below(tags as u32) as usize)
        }
        _ => {}
    }
    let skip = (rng.below(2) == 0).then(|| {
        let first = rng.below(frames);
        Skip {
            clip: rng.below(6),
            first,
            last: first + rng.below(40),
        }
    });
    SearchFilter { tags: t, skip }
}

fn assert_modes_agree(db: &MatchDb, q: &[F32x4], filter: &SearchFilter, what: &str) {
    let a = db.search(q, filter, SearchMode::BruteForce);
    let b = db.search(q, filter, SearchMode::KdTree);
    match (a, b) {
        (Some(a), Some(b)) => {
            assert_eq!(a.frame, b.frame, "{what}: frame");
            assert_eq!(a.cost.to_bits(), b.cost.to_bits(), "{what}: cost");
            assert_eq!((a.clip, a.time), (b.clip, b.time), "{what}");
        }
        (None, None) => {}
        _ => panic!("{what}: {a:?} vs {b:?}"),
    }
}

#[test]
fn kd_tree_and_brute_force_agree_on_the_locomotion_database() {
    let fx = fixture();
    let baked = fx.bake(&weighted_schema(), &BakeSettings::default());
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    let db = MatchDb::new(&view).unwrap();
    let dims = db.dims();
    let n = db.frame_count() as u32;
    let mut rng = Rng::new(7);
    for k in 0..3000 {
        let v: Vec<f32> = match k % 3 {
            // Anywhere.
            0 => (0..dims).map(|_| rng.f32(-3.0, 3.0)).collect(),
            // Near a frame.
            1 => {
                let f = rng.below(n) as usize;
                (0..dims)
                    .map(|d| baked.db.matrix[f * dims + d] + rng.f32(-0.2, 0.2))
                    .collect()
            }
            // On a frame.
            _ => {
                let f = rng.below(n) as usize;
                baked.db.matrix[f * dims..(f + 1) * dims].to_vec()
            }
        };
        let q = query_from(db.features(), &v, db.lanes());
        let filter = random_filter(&mut rng, 6, n);
        assert_modes_agree(&db, &q, &filter, &format!("query {k}"));
    }
}

#[test]
fn kd_tree_and_brute_force_agree_with_ties_and_depth() {
    // 6000 random frames, values quantised to quarters so many costs tie exactly.
    let mut rng = Rng::new(11);
    let dims = 10usize;
    let n = 6000usize;
    let features: Vec<Feature> = (0..5)
        .map(|i| Feature {
            kind: FeatureKind::TrajectoryPosition,
            dims: 2,
            bone: NONE,
            first_dim: 2 * i,
            weight: [1.0, 0.5, 2.0, 1.0, 4.0][i as usize],
            time_offset: 0.1 * (i + 1) as f32,
            name: NONE,
        })
        .collect();
    let matrix: Vec<f32> = (0..n * dims)
        .map(|_| (rng.f32(-2.0, 2.0) * 4.0).round() / 4.0)
        .collect();
    let scale: Vec<f32> = (0..dims).map(|d| features[d / 2].weight.sqrt()).collect();
    for leaf in [1, 4, 16] {
        let db = PoseDb {
            sample_rate: 30.0,
            skeleton: NONE,
            strings: vec!["c".into(), "t0".into(), "t1".into()],
            dims: dims as u32,
            features: features.clone(),
            mean: vec![0.0; dims],
            std: vec![1.0; dims],
            matrix: matrix.clone(),
            frames: (0..n)
                .map(|i| FrameRef {
                    clip: 0,
                    time: i as f32 / 30.0,
                })
                .collect(),
            clips: vec![0],
            tag_names: vec![1, 2],
            tags: (0..n).map(|i| (i % 4) as u32).collect(),
            kd_tree: Some(kdtree::build(&matrix, dims, &scale, leaf)),
        };
        let bytes = db.write().unwrap();
        let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
        for k in 0..1500 {
            let v: Vec<f32> = (0..dims)
                .map(|_| (rng.f32(-2.5, 2.5) * 4.0).round() / 4.0)
                .collect();
            let q = query_from(db.features(), &v, db.lanes());
            let filter = random_filter(&mut rng, 2, n as u32);
            let filter = SearchFilter {
                skip: filter.skip.map(|s| Skip { clip: 0, ..s }),
                ..filter
            };
            assert_modes_agree(&db, &q, &filter, &format!("leaf {leaf} query {k}"));
        }
    }
}

#[test]
fn search_matches_the_reference_and_tags_gate() {
    let fx = fixture();
    let baked = fx.bake(&weighted_schema(), &BakeSettings::default());
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    let db = MatchDb::new(&view).unwrap();
    let dims = db.dims();
    let rows: Vec<Vec<f64>> = baked
        .db
        .matrix
        .chunks_exact(dims)
        .map(|r| r.iter().map(|&x| x as f64).collect())
        .collect();
    let weights = reference::dim_weights(db.features());
    let tag = |name| anim_match::tag_index(&view, name).unwrap();
    let (walk, run, idle) = (tag("walk"), tag("run"), tag("idle"));
    let filters = [
        TagFilter::default(),
        TagFilter {
            required: TagMask::EMPTY.with(walk),
            ..TagFilter::default()
        },
        TagFilter {
            excluded: TagMask::EMPTY.with(walk).with(idle),
            ..TagFilter::default()
        },
        TagFilter {
            any: TagMask::EMPTY.with(run).with(idle),
            ..TagFilter::default()
        },
        // Nothing has both.
        TagFilter {
            required: TagMask::EMPTY.with(run).with(idle),
            ..TagFilter::default()
        },
    ];
    let passes = |i: usize, f: &TagFilter| {
        let has = |t: usize| view.has_tag(i, t);
        (0..6).all(|t| !(f.required.0[0] >> t & 1 == 1) || has(t))
            && (0..6).all(|t| !(f.excluded.0[0] >> t & 1 == 1) || !has(t))
            && (f.any.is_empty() || (0..6).any(|t| f.any.0[0] >> t & 1 == 1 && has(t)))
    };
    let mut rng = Rng::new(3);
    for k in 0..400 {
        let f = rng.below(db.frame_count() as u32) as usize;
        let v: Vec<f32> = (0..dims)
            .map(|d| baked.db.matrix[f * dims + d] + rng.f32(-0.5, 0.5))
            .collect();
        let q = query_from(db.features(), &v, db.lanes());
        let q64: Vec<f64> = v.iter().map(|&x| x as f64).collect();
        let tags = &filters[k % filters.len()];
        let filter = SearchFilter {
            tags: *tags,
            skip: None,
        };
        let got = db.search(&q, &filter, SearchMode::KdTree);
        let want = reference::nearest(&rows, &weights, &q64, |i| passes(i, tags));
        match (got, want) {
            (None, None) => assert_eq!(k % filters.len(), 4),
            (Some(g), Some((_, best))) => {
                assert!(passes(g.frame as usize, tags), "query {k}: filter");
                let mine = reference::cost(&q64, &rows[g.frame as usize], &weights);
                let tol = 1e-5 * (1.0 + best);
                assert!((g.cost as f64 - mine).abs() <= tol, "query {k}: cost");
                assert!(mine - best <= tol, "query {k}: {mine} vs best {best}");
            }
            _ => panic!("query {k}: {got:?} vs {want:?}"),
        }
    }
}

#[test]
fn a_frame_finds_itself_at_zero_cost_unless_skipped() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let db = MatchDb::new(&PoseDbView::parse(&baked.bytes).unwrap()).unwrap();
    let dims = db.dims();
    for f in [0usize, 17, 100, db.frame_count() - 1] {
        let q = query_from(
            db.features(),
            &baked.db.matrix[f * dims..(f + 1) * dims],
            db.lanes(),
        );
        for mode in [SearchMode::BruteForce, SearchMode::KdTree] {
            let m = db.search(&q, &SearchFilter::default(), mode).unwrap();
            assert_eq!((m.frame as usize, m.cost), (f, 0.0));
            assert_eq!(db.cost(&q, f), 0.0);
            let clip = db.frame(f).unwrap().clip;
            let skip = SearchFilter {
                skip: Some(Skip {
                    clip,
                    first: f.saturating_sub(3) as u32,
                    last: f as u32 + 3,
                }),
                ..SearchFilter::default()
            };
            let m = db.search(&q, &skip, mode).unwrap();
            assert!((m.frame as usize).abs_diff(f) > 3 || m.clip != clip);
            assert!(m.cost > 0.0);
        }
    }
    // A query of the wrong length finds nothing.
    assert!(db
        .search(
            &[F32x4::splat(0.0)],
            &SearchFilter::default(),
            SearchMode::KdTree
        )
        .is_none());
}
