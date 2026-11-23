//! The matching controller: search interval, forced searches, continuation bias, the minimum
//! time between switches, skipping the playing neighbourhood, tag changes, running off a clip;
//! then a closed loop on the synthetic locomotion database (idle → walk → turn → stop).

mod common;

use anim_format::clip::ClipView;
use anim_format::posedb::{Feature, FeatureKind, FrameRef, PoseDb, PoseDbView};
use anim_format::NONE;
use anim_match::spring::{spring_damper, velocity_spring};
use anim_match::{
    build_query, BakeSettings, CharacterFrame, ControllerSettings, MatchController, MatchDb,
    PoseInput, SearchMode, TagFilter, TagMask, Trajectory, TrajectoryInput, TrajectoryPredictor,
    TrajectorySettings,
};
use anim_math::layout::{local_to_model, soa_len};
use anim_math::{AosQuat, AosTransform, AosVec3, F32x4, SoaTransform};
use anim_pose::root::RootDelta;
use anim_sample::{ClipSampler, Form};
use common::*;

/// Two clips of 30 frames at 30 Hz: dims `[pose x, y, z, trajectory x, z]`, mean 0, std 1,
/// weights 1. Clip 0 (tag 0) is all zeros except pose x = `i · ramp`; clip 1 (tag 1) has pose
/// x = 0.2.
fn tiny(ramp: f32) -> Vec<u8> {
    let features = vec![
        Feature {
            kind: FeatureKind::BonePosition,
            dims: 3,
            bone: 0,
            first_dim: 0,
            weight: 1.0,
            time_offset: 0.0,
            name: NONE,
        },
        Feature {
            kind: FeatureKind::TrajectoryPosition,
            dims: 2,
            bone: NONE,
            first_dim: 3,
            weight: 1.0,
            time_offset: 0.5,
            name: NONE,
        },
    ];
    let mut matrix = Vec::new();
    let mut frames = Vec::new();
    let mut tags = Vec::new();
    for c in 0..2u32 {
        for i in 0..30 {
            let x = if c == 0 { i as f32 * ramp } else { 0.2 };
            matrix.extend_from_slice(&[x, 0.0, 0.0, 0.0, 0.0]);
            frames.push(FrameRef {
                clip: c,
                time: i as f32 / 30.0,
            });
            tags.push(1 << c);
        }
    }
    PoseDb {
        sample_rate: 30.0,
        skeleton: NONE,
        strings: vec!["a".into(), "b".into(), "ta".into(), "tb".into()],
        dims: 5,
        features,
        mean: vec![0.0; 5],
        std: vec![1.0; 5],
        matrix,
        frames,
        clips: vec![0, 1],
        tag_names: vec![2, 3],
        tags,
        kd_tree: None,
        clip_flags: Vec::new(),
        mirror: Vec::new(),
    }
    .write()
    .unwrap()
}

fn q(pose_x: f32, traj_x: f32) -> Vec<F32x4> {
    vec![
        F32x4::new(pose_x, 0.0, 0.0, traj_x),
        F32x4::new(0.0, 0.0, 0.0, 0.0),
    ]
}

fn settings() -> ControllerSettings {
    ControllerSettings {
        search_interval: 1,
        force_threshold: 1e9,
        continuation_bias: 0.1,
        min_switch_interval: 0.0,
        ignore_neighbours: 0,
        mode: SearchMode::BruteForce,
    }
}

const DT: f32 = 0.0625;

#[test]
fn the_first_update_searches_and_switches() {
    let bytes = tiny(0.0);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    let mut c = MatchController::new(settings());
    assert_eq!(c.playing(), None);
    let out = c.update(&db, DT, &q(0.2, 0.0), &TagFilter::default());
    assert!(out.switched && out.searched);
    assert_eq!((out.clip, out.time, out.frame, out.cost), (1, 0.0, 30, 0.0));
    // Continuing advances the time and the frame.
    let out = c.update(&db, DT, &q(0.2, 0.0), &TagFilter::default());
    assert!(!out.switched);
    assert_eq!((out.clip, out.time, out.frame), (1, DT, 32));
}

#[test]
fn the_continuation_bias_keeps_the_playing_clip() {
    let bytes = tiny(0.0);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    for (bias, switches) in [(0.1f32, false), (0.01, true)] {
        let mut c = MatchController::new(ControllerSettings {
            continuation_bias: bias,
            ..settings()
        });
        let out = c.update(&db, DT, &q(0.0, 0.0), &TagFilter::default());
        assert_eq!(out.clip, 0);
        // Clip 1 now costs 0.0025, the continuation 0.0225: 0.02 better.
        let mut switched = false;
        for _ in 0..10 {
            let out = c.update(&db, DT, &q(0.15, 0.0), &TagFilter::default());
            assert!(out.searched);
            switched |= out.switched;
        }
        assert_eq!(switched, switches, "bias {bias}");
        assert_eq!(c.playing().unwrap().0, if switches { 1 } else { 0 });
    }
}

#[test]
fn switches_wait_for_the_minimum_interval() {
    let bytes = tiny(0.0);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    let mut c = MatchController::new(ControllerSettings {
        continuation_bias: 0.0,
        min_switch_interval: 0.25,
        ..settings()
    });
    let filter = TagFilter::default();
    c.update(&db, DT, &q(0.2, 0.0), &filter);
    assert_eq!(c.playing().unwrap().0, 1);
    // Clip 0 is now better; the switch waits 0.25 s = 4 updates of 0.0625 s.
    for k in 1..=4 {
        let out = c.update(&db, DT, &q(0.0, 0.0), &filter);
        assert_eq!(out.switched, k == 4, "update {k}");
    }
    assert_eq!(c.playing().unwrap().0, 0);
}

#[test]
fn searches_run_every_interval_or_on_a_large_trajectory_change() {
    let bytes = tiny(0.0);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    let mut c = MatchController::new(ControllerSettings {
        search_interval: 4,
        force_threshold: 0.5,
        ..settings()
    });
    let filter = TagFilter::default();
    assert!(c.update(&db, DT, &q(0.0, 0.0), &filter).searched);
    let pattern: Vec<bool> = (0..8)
        .map(|_| c.update(&db, DT, &q(0.0, 0.0), &filter).searched)
        .collect();
    assert_eq!(
        pattern,
        [false, false, false, true, false, false, false, true]
    );
    // A trajectory 1 away from the continuation's (cost 1 > 0.5) searches at once.
    assert!(!c.update(&db, DT, &q(0.0, 0.5), &filter).searched);
    assert!(c.update(&db, DT, &q(0.0, 1.0), &filter).searched);
}

#[test]
fn a_search_skips_the_playing_neighbourhood() {
    // Clip 0 ramps, so the best frame for a query is the one that equals it.
    let bytes = tiny(0.01);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    let mut c = MatchController::new(ControllerSettings {
        continuation_bias: -10.0, // switch to whatever the search finds
        ignore_neighbours: 3,
        ..settings()
    });
    let filter = TagFilter {
        required: TagMask::EMPTY.with(0),
        ..TagFilter::default()
    };
    let out = c.update(&db, 0.0, &q(0.1, 0.0), &filter);
    assert_eq!(out.frame, 10);
    // Playing frame 10 (time 1/3 s): asking for it again picks a frame 4 away, not 7..=13.
    let out = c.update(&db, 0.0, &q(0.1, 0.0), &filter);
    assert!(out.switched);
    assert!(out.frame == 6 || out.frame == 14, "{}", out.frame);
}

#[test]
fn a_filtered_out_or_finished_continuation_switches_at_once() {
    let bytes = tiny(0.0);
    let db = MatchDb::new(&PoseDbView::parse(&bytes).unwrap()).unwrap();
    let mut c = MatchController::new(ControllerSettings {
        min_switch_interval: 100.0,
        search_interval: 1000,
        ..settings()
    });
    let only = |t: usize| TagFilter {
        required: TagMask::EMPTY.with(t),
        ..TagFilter::default()
    };
    c.update(&db, DT, &q(0.0, 0.0), &only(0));
    assert_eq!(c.playing().unwrap().0, 0);
    // The tags change: clip 0 no longer passes, so the switch ignores the interval.
    let out = c.update(&db, DT, &q(0.0, 0.0), &only(1));
    assert!(out.switched && out.clip == 1);
    // Clip 1 runs out after its 30 frames (29/30 s plus half a frame).
    let mut finished = None;
    for k in 0..20 {
        let out = c.update(&db, DT, &q(0.2, 0.0), &only(1));
        if out.switched {
            finished = Some((k, out.time));
            break;
        }
    }
    let (k, time) = finished.expect("switched when the clip ran out");
    assert_eq!(time, 0.0);
    assert!((k + 2) as f32 * DT > 29.5 / 30.0, "{k}");
}

// ---------------------------------------------------------------------------------------------
// Closed loop
// ---------------------------------------------------------------------------------------------

/// Samples clip `clip` at `t` into character-space transforms (translations only matter).
struct Poser<'a> {
    clips: Vec<ClipSampler<'a>>,
    parents: Vec<u16>,
    rest: Vec<AosTransform>,
    scratch: Vec<AosTransform>,
    soa: Vec<SoaTransform>,
    model: Vec<AosTransform>,
}

impl<'a> Poser<'a> {
    fn new(views: &[ClipView<'a>], skel: &anim_format::skeleton::SkeletonView<'_>) -> Self {
        let n = skel.bone_count();
        let mut rest = vec![AosTransform::identity(); n];
        anim_sample::rest_pose(skel, &mut rest);
        Poser {
            clips: views
                .iter()
                .map(|v| ClipSampler::new(*v, Form::Raw).unwrap())
                .collect(),
            parents: (0..n)
                .map(|i| skel.parent(i).map_or(u16::MAX, |p| p as u16))
                .collect(),
            rest,
            scratch: vec![AosTransform::identity(); 2 * n],
            soa: vec![SoaTransform::identity(); soa_len(n)],
            model: vec![AosTransform::identity(); n],
        }
    }

    fn pose(&mut self, clip: u32, t: f32, out: &mut [AosTransform]) {
        self.clips[clip as usize]
            .sample_pose(t, &self.rest, &mut self.scratch, &mut self.soa, None)
            .unwrap();
        local_to_model(&self.parents, &self.soa, &mut self.model);
        let frame = CharacterFrame::from_root(self.model[0], AosQuat::identity());
        for (o, m) in out.iter_mut().zip(&self.model) {
            *o = AosTransform::new(
                frame.point3_to_local(m.translation),
                AosQuat::identity(),
                AosVec3::one(),
            );
        }
    }
}

#[test]
fn closed_loop_locomotion_picks_the_matching_clips() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    let db = MatchDb::new(&view).unwrap();
    let (skel, views) = fx.views();
    let mut poser = Poser::new(&views, &skel);
    let tag = |name| anim_match::tag_index(&view, name).unwrap();
    let (idle, walk, turn, stop) = (tag("idle"), tag("walk"), tag("turn"), tag("stop"));

    let traj_settings = TrajectorySettings::default();
    let mut predictor = TrajectoryPredictor::new();
    let mut controller = MatchController::new(ControllerSettings::default());
    let mut trajectory = Trajectory::default();
    let mut query = db.new_query();
    let n = skel.bone_count();
    let (mut cur, mut prev) = (
        vec![AosTransform::identity(); n],
        vec![AosTransform::identity(); n],
    );

    // The simulated character: spring-driven, as a character controller would be.
    let dt = 1.0 / 60.0;
    let (mut x, mut v, mut a) = ([0.0f32; 2], [0.0f32; 2], [0.0f32; 2]);
    let (mut yaw, mut yaw_rate) = (0.0f32, 0.0f32);
    let mut last = (x, yaw);
    let mut seen: Vec<(f32, usize)> = Vec::new();
    let steps = (13.0 / dt) as usize;
    for step in 0..steps {
        let t = step as f32 * dt;
        // Desire: idle 0–2 s, walk ahead 2–6 s, turn 6–10 s at the turn clip's 1.2 rad/s, stop.
        let (desired, desired_yaw) = if t < 2.0 {
            ([0.0, 0.0], 0.0)
        } else if t < 6.0 {
            ([0.0, 1.4], 0.0)
        } else if t < 10.0 {
            let d = 1.2 * (t - 6.0);
            ([1.4 * d.sin(), 1.4 * d.cos()], d)
        } else {
            ([0.0, 0.0], 1.2 * 4.0)
        };
        for k in 0..2 {
            (x[k], v[k], a[k]) = velocity_spring(
                x[k],
                v[k],
                a[k],
                desired[k],
                traj_settings.velocity_half_life,
                dt,
            );
        }
        (yaw, yaw_rate) = spring_damper(
            yaw,
            yaw_rate,
            desired_yaw,
            traj_settings.facing_half_life,
            dt,
        );

        let input = TrajectoryInput {
            position: x,
            yaw,
            velocity: v,
            desired_velocity: desired,
            desired_yaw,
        };
        predictor.update(dt, &input, &traj_settings);
        predictor.predict(
            &input,
            &traj_settings,
            db.trajectory_offsets(),
            &mut trajectory,
        );

        // The displayed pose: the clip the controller plays (last frame's choice, advanced).
        std::mem::swap(&mut cur, &mut prev);
        if let Some((clip, time)) = controller.playing() {
            poser.pose(clip, time + dt, &mut cur);
        } else {
            poser.pose(0, 0.0, &mut cur);
        }
        let last_frame = CharacterFrame::new(last.0, [last.1.sin(), last.1.cos()]);
        let d = last_frame.vector_to_local([x[0] - last.0[0], x[1] - last.0[1]]);
        let half = 0.5 * (yaw - last.1);
        let delta = RootDelta {
            translation: AosVec3::new(d[0], 0.0, d[1]),
            rotation: AosQuat::new(0.0, half.sin(), 0.0, half.cos()),
        };
        last = (x, yaw);
        let pose = PoseInput {
            current: &cur,
            previous: if step == 0 { &cur } else { &prev },
            delta,
            dt,
        };
        build_query(&db, &pose, &trajectory, &mut query).unwrap();
        let out = controller.update(&db, dt, &query, &TagFilter::default());
        assert!(out.frame != NONE, "step {step}: something plays");
        seen.push((t, out.frame as usize));
    }

    let tag_at = |t0: f32, t1: f32, tag: usize| {
        let frames: Vec<_> = seen.iter().filter(|(t, _)| *t >= t0 && *t < t1).collect();
        frames.iter().filter(|(_, f)| db.has_tag(*f, tag)).count() as f32 / frames.len() as f32
    };
    let report = |name: &str, share: f32| eprintln!("{name}: {:.0} %", share * 100.0);
    let idle_share = tag_at(0.5, 2.0, idle);
    let walk_share = tag_at(4.0, 6.0, walk);
    let turn_share = tag_at(8.0, 10.0, turn);
    let stop_share = tag_at(10.0, 11.2, stop);
    let rest_share = tag_at(12.0, 13.0, idle);
    let gait_after_stop =
        tag_at(10.5, 13.0, walk) + tag_at(10.5, 13.0, turn) + tag_at(10.5, 13.0, tag("run"));
    report("idle 0.5–2 s", idle_share);
    report("walk 4–6 s", walk_share);
    report("turn 8–10 s", turn_share);
    report("stop 10–11.2 s", stop_share);
    report("steady gaits 10.5–13 s", gait_after_stop);
    report("idle 12–13 s", rest_share);
    assert!(idle_share >= 0.9);
    assert!(walk_share >= 0.9);
    assert!(turn_share >= 0.9);
    // Braking plays the stop clip, or the start clip's middle (the same speeds, mirrored in
    // time), never a steady gait.
    assert!(stop_share >= 0.3);
    assert_eq!(gait_after_stop, 0.0);
    assert!(rest_share >= 0.9);
}
