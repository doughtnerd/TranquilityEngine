//! A query built at runtime from a clip's own pose and trajectory lands on that clip's frame:
//! the runtime's feature measurement (character-space pose over two frames, a root delta, a
//! trajectory) agrees with the bake's.
//!
//! Tolerance: the two paths compute the same quantities by different f32 routes (the bake
//! unwraps world positions and rotates their difference; the query removes the root delta), so
//! raw features differ by ~1e-6 m (positions) and ~3e-5 m/s (velocities, divided by 1/30 s).
//! Normalised by deviations ≥ 0.01 and squared, a frame's cost against its own query stays under
//! 1e-4.

mod common;

use anim_format::posedb::PoseDbView;
use anim_match::{
    build_query, BakeSettings, CharacterFrame, MatchDb, PoseInput, QueryError, SearchFilter,
    SearchMode, Trajectory,
};
use anim_math::layout::{local_to_model, soa_len};
use anim_math::{AosQuat, AosTransform, AosVec3, SoaTransform};
use anim_pose::root::RootDelta;
use anim_sample::{ClipSampler, Form};
use common::*;

#[test]
fn a_clip_frame_finds_itself() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let db = MatchDb::new(&PoseDbView::parse(&baked.bytes).unwrap()).unwrap();
    let (skel, views) = fx.views();
    let n = skel.bone_count();
    let mut rest = vec![AosTransform::identity(); n];
    anim_sample::rest_pose(&skel, &mut rest);
    let parents: Vec<u16> = (0..n)
        .map(|i| skel.parent(i).map_or(u16::MAX, |p| p as u16))
        .collect();
    let mut scratch = vec![AosTransform::identity(); 2 * n];
    let mut soa = vec![SoaTransform::identity(); soa_len(n)];
    let mut model = vec![AosTransform::identity(); n];
    let h = 1.0 / RATE;

    // (clip, time): walk, run and turn mid-clip, idle.
    for (clip, t) in [(1u32, 0.5f32), (2, 0.8), (3, 0.6), (0, 0.4)] {
        let sampler = ClipSampler::new(views[clip as usize], Form::Raw).unwrap();
        // Character frame and character-space pose at a time.
        let mut at = |time: f32, out: &mut [AosTransform]| -> CharacterFrame {
            sampler
                .sample_pose(time, &rest, &mut scratch, &mut soa, None)
                .unwrap();
            local_to_model(&parents, &soa, &mut model);
            let c = CharacterFrame::from_root(model[0], AosQuat::identity());
            for (o, m) in out.iter_mut().zip(&model) {
                *o = AosTransform::new(
                    c.point3_to_local(m.translation),
                    AosQuat::identity(),
                    AosVec3::one(),
                );
            }
            c
        };
        let mut cur = vec![AosTransform::identity(); n];
        let mut prev = vec![AosTransform::identity(); n];
        let c1 = at(t, &mut cur);
        let c0 = at(t - h, &mut prev);
        let step = c0.inverse().compose(&c1);
        let delta = RootDelta {
            translation: AosVec3::new(step.position[0], 0.0, step.position[1]),
            rotation: step.rotation(),
        };
        let mut traj = Trajectory::default();
        let mut scratch_pose = vec![AosTransform::identity(); n];
        for (i, &o) in db.trajectory_offsets().iter().enumerate() {
            let rel = c1.inverse().compose(&at(t + o, &mut scratch_pose));
            traj.offsets[i] = o;
            traj.positions[i] = rel.position;
            traj.directions[i] = rel.forward;
            traj.count = i + 1;
        }
        let pose = PoseInput {
            current: &cur,
            previous: &prev,
            delta,
            dt: h,
        };
        let mut query = db.new_query();
        build_query(&db, &pose, &traj, &mut query).unwrap();
        let frame = db.frame_at(clip, t).unwrap() as usize;
        assert!(
            db.cost(&query, frame) < 1e-4,
            "clip {clip}: {}",
            db.cost(&query, frame)
        );
        for mode in [SearchMode::BruteForce, SearchMode::KdTree] {
            let m = db.search(&query, &SearchFilter::default(), mode).unwrap();
            assert!(m.cost <= db.cost(&query, frame));
            assert!(
                m.clip == clip && (m.time - t).abs() < 1.5 * h,
                "clip {clip}: {m:?}"
            );
        }

        // Refusals: wrong length, a missing trajectory sample, a bone out of range.
        let mut short = vec![query[0]];
        assert_eq!(
            build_query(&db, &pose, &traj, &mut short),
            Err(QueryError::Length)
        );
        let empty = Trajectory::default();
        assert_eq!(
            build_query(&db, &pose, &empty, &mut query),
            Err(QueryError::Trajectory)
        );
        let few = PoseInput {
            current: &cur[..2],
            ..pose
        };
        assert_eq!(
            build_query(&db, &few, &traj, &mut query),
            Err(QueryError::Bone)
        );
    }
}
