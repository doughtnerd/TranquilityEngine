//! The bake against `anim-offline::matching` (f64), and its determinism, exclusion, tags, tree.
//!
//! Tolerances: the bake samples and composes in f32 where the reference uses f64. Positions here
//! stay under ~4 m (f32 ulp 4.8e-7), and a feature is a few dozen rounded operations deep, so
//! positions, trajectory samples and facings are held to 2e-5. Velocities divide a difference
//! of two such positions by `h = 1/30 s`, multiplying the error by 30: 1e-3 m/s. Statistics
//! average those errors, so the same bounds apply to means and deviations.

mod common;

use anim_format::posedb::{FeatureKind, PoseDbView};
use anim_match::{
    bake, BakeClip, BakeError, BakeSettings, FeatureSpec, MatchDb, Normalization, TaggedRange,
};
use anim_offline::matching as reference;
use anim_sample::Form;
use common::*;

const POS_TOL: f64 = 2e-5;
const VEL_TOL: f64 = 1e-3;

fn tolerance(kind: FeatureKind) -> f64 {
    if kind == FeatureKind::BoneVelocity {
        VEL_TOL
    } else {
        POS_TOL
    }
}

#[test]
fn the_bake_is_deterministic() {
    let fx = fixture();
    let a = fx.bake(&schema(), &BakeSettings::default());
    let b = fixture().bake(&schema(), &BakeSettings::default());
    assert_eq!(a.bytes, b.bytes);
    // The file parses and loads for search (the tree passes the load's checks).
    let view = PoseDbView::parse(&a.bytes).unwrap();
    assert_eq!(view.dims(), 31);
    assert_eq!(view.row_stride(), 32);
    let db = MatchDb::new(&view).unwrap();
    assert!(db.has_kd_tree());
    assert_eq!(db.trajectory_offsets(), &[-0.33, 0.33, 0.66, 1.0]);
}

#[test]
fn features_and_statistics_match_the_reference() {
    let fx = fixture();
    let (skel, views) = fx.views();
    let features = schema();
    for norm in [Normalization::PerDimension, Normalization::PerFeature] {
        let settings = BakeSettings {
            normalization: norm,
            ..BakeSettings::default()
        };
        let baked = fx.bake(&features, &settings);
        let db = &baked.db;
        let refs: Vec<_> = views
            .iter()
            .map(|v| reference::RefClip::new(&skel, *v, None))
            .collect();
        let rows: Vec<Vec<f64>> = db
            .frames
            .iter()
            .map(|f| {
                reference::frame_features(
                    &refs[f.clip as usize],
                    &db.features,
                    f.time as f64,
                    RATE as f64,
                )
            })
            .collect();
        let dims = db.dims as usize;
        let kind_of = |d: usize| {
            db.features
                .iter()
                .find(|f| (f.first_dim as usize..(f.first_dim + f.dims as u32) as usize).contains(&d))
                .unwrap()
                .kind
        };
        // Raw features (row · std + mean) against the reference.
        for (i, r) in rows.iter().enumerate() {
            for d in 0..dims {
                let v = db.matrix[i * dims + d] as f64 * db.std[d] as f64 + db.mean[d] as f64;
                let tol = tolerance(kind_of(d)) + 1e-6 * db.std[d] as f64;
                assert!(
                    (v - r[d]).abs() <= tol,
                    "{norm:?} frame {i} ({:?}) dim {d}: {v} vs {}",
                    db.frames[i],
                    r[d]
                );
            }
        }
        let (mean, std) = reference::normalization(
            &rows,
            &db.features,
            norm == Normalization::PerFeature,
            settings.std_floor as f64,
        );
        for d in 0..dims {
            let tol = tolerance(kind_of(d));
            assert!((db.mean[d] as f64 - mean[d]).abs() <= tol, "mean {d}");
            assert!((db.std[d] as f64 - std[d]).abs() <= tol, "std {d}");
            // Normalised values, against the reference's own normalisation.
            for (i, r) in rows.iter().enumerate() {
                let n = reference::normalize(r, &mean, &std)[d];
                assert!(
                    (db.matrix[i * dims + d] as f64 - n).abs() <= 2.0 * tol / std[d],
                    "normalised {i} {d}"
                );
            }
        }
        if norm == Normalization::PerFeature {
            for f in &db.features {
                let s = &db.std[f.first_dim as usize..][..f.dims as usize];
                assert!(s.iter().all(|&x| x == s[0]), "per-feature std shared");
            }
        }
    }
}

#[test]
fn one_shot_frames_without_a_future_are_excluded() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let db = &baked.db;
    for (c, d) in fx.durations.iter().enumerate() {
        let times: Vec<f32> = db
            .frames
            .iter()
            .filter(|f| f.clip == c as u32)
            .map(|f| f.time)
            .collect();
        let looping = c < 4;
        let grid = (d * RATE).round() as usize;
        if looping {
            // Every grid frame before the end (the end repeats the start).
            assert_eq!(times.len(), grid, "clip {c}");
            assert!(times.iter().all(|&t| t < *d));
        } else {
            // Frames whose +1 s sample runs past the end are left out.
            assert!(times.iter().all(|&t| t + 1.0 <= d + 1e-4), "clip {c}");
            assert_eq!(times.len(), grid + 1 - 30, "clip {c}");
        }
    }
    assert_eq!(baked.excluded, 2 * 30);
}

#[test]
fn looping_trajectories_continue_over_the_seam() {
    // The walk's last frame's +1 s trajectory lies 1.4 m ahead, as mid-clip.
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let db = &baked.db;
    let dims = db.dims as usize;
    let f = db.features.iter().find(|f| {
        f.kind == FeatureKind::TrajectoryPosition && f.time_offset == 1.0
    });
    let o = f.unwrap().first_dim as usize;
    for (i, fr) in db.frames.iter().enumerate().filter(|(_, f)| f.clip == 1) {
        let z = db.matrix[i * dims + o + 1] * db.std[o + 1] + db.mean[o + 1];
        assert!((z - 1.4).abs() < 0.02, "walk frame at {}: {z}", fr.time);
    }
}

#[test]
fn ranges_select_frames_and_union_their_tags() {
    let fx = fixture();
    let (skel, views) = fx.views();
    let ranges = [
        TaggedRange {
            start: 0.0,
            end: 1.0,
            tags: &["a"],
        },
        TaggedRange {
            start: 0.5,
            end: 1.5,
            tags: &["b", "a"],
        },
    ];
    let clips = [BakeClip {
        view: views[1],
        form: Form::Raw,
        asset: "walk.anim",
        ranges: &ranges,
    }];
    let baked = bake(&skel, &clips, &schema(), &BakeSettings::default()).unwrap();
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    assert_eq!(view.tag_count(), 2);
    assert_eq!(anim_match::tag_index(&view, "a"), Some(0));
    assert_eq!(anim_match::tag_index(&view, "b"), Some(1));
    assert_eq!(view.frame_count(), 46); // grid frames 0..=45 (t ≤ 1.5)
    for i in 0..view.frame_count() {
        let t = view.frame(i).unwrap().time;
        assert_eq!(view.has_tag(i, 0), t <= 1.0 || t >= 0.5, "a at {t}");
        assert_eq!(view.has_tag(i, 1), t >= 0.5, "b at {t}");
    }
    assert_eq!(view.strings().get(view.clips().get(0).unwrap()), Some("walk.anim"));
}

#[test]
fn the_tree_splits_on_the_median_with_small_leaves() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let kd = baked.db.kd_tree.as_ref().unwrap();
    let n = baked.db.frames.len();
    let mut seen = vec![false; n];
    for node in &kd.nodes {
        if let anim_format::posedb::KdNode::Leaf { first, count } = *node {
            assert!(count <= 16);
            let leaf = &kd.indices[first as usize..(first + count) as usize];
            assert!(leaf.windows(2).all(|w| w[0] < w[1]), "leaf in frame order");
            for &f in leaf {
                assert!(!std::mem::replace(&mut seen[f as usize], true));
            }
        }
    }
    assert!(seen.iter().all(|&s| s));
    // Without a tree: no KD sections.
    let flat = fx.bake(
        &schema(),
        &BakeSettings {
            kd_tree: false,
            ..BakeSettings::default()
        },
    );
    assert!(flat.db.kd_tree.is_none());
    assert!(!MatchDb::new(&PoseDbView::parse(&flat.bytes).unwrap())
        .unwrap()
        .has_kd_tree());
}

#[test]
fn bad_input_is_refused() {
    let fx = fixture();
    let (skel, views) = fx.views();
    let clips = [BakeClip {
        view: views[0],
        form: Form::Raw,
        asset: "idle.anim",
        ranges: &[],
    }];
    let s = BakeSettings::default();
    let custom = FeatureSpec {
        kind: FeatureKind::Custom,
        bone: 0,
        weight: 1.0,
        time_offset: 0.0,
    };
    assert_eq!(bake(&skel, &clips, &[], &s).unwrap_err(), BakeError::Feature(0));
    assert_eq!(
        bake(&skel, &clips, &[custom], &s).unwrap_err(),
        BakeError::Feature(0)
    );
    assert_eq!(
        bake(&skel, &clips, &[FeatureSpec::bone_position(99, 1.0)], &s).unwrap_err(),
        BakeError::Feature(0)
    );
    assert_eq!(
        bake(&skel, &clips, &[FeatureSpec::bone_position(0, -1.0)], &s).unwrap_err(),
        BakeError::Feature(0)
    );
    let bad = [TaggedRange {
        start: 1.0,
        end: 0.5,
        tags: &[],
    }];
    let reversed = [BakeClip {
        ranges: &bad,
        ..clips[0]
    }];
    assert_eq!(
        bake(&skel, &reversed, &schema(), &s).unwrap_err(),
        BakeError::Range { clip: 0, range: 0 }
    );
    let rate = BakeSettings {
        sample_rate: 0.0,
        ..s
    };
    assert_eq!(
        bake(&skel, &clips, &schema(), &rate).unwrap_err(),
        BakeError::Settings("sample_rate")
    );
    // A one-shot clip shorter than the future window leaves nothing.
    let short = [BakeClip {
        view: views[4],
        form: Form::Raw,
        asset: "start.anim",
        ranges: &[TaggedRange {
            start: 2.0,
            end: 2.5,
            tags: &[],
        }],
    }];
    assert_eq!(
        bake(&skel, &short, &schema(), &s).unwrap_err(),
        BakeError::NoFrames
    );
}
