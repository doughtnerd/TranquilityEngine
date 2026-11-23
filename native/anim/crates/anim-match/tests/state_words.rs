//! The runtime state as plain words (T42's node half keeps it in a graph instance's state blob):
//! a predictor and a controller written to words and read back continue exactly as the
//! originals, and any words read back give a usable state.

mod common;

use anim_format::posedb::PoseDbView;
use anim_match::{
    BakeSettings, ControllerSettings, MatchController, MatchDb, TagFilter, Trajectory,
    TrajectoryInput, TrajectoryPredictor, TrajectorySettings,
};
use anim_math::F32x4;
use common::*;

fn input(i: usize) -> TrajectoryInput {
    let t = i as f32 / 30.0;
    TrajectoryInput {
        position: [t * 1.1, t * 0.3],
        yaw: 0.2 * t,
        velocity: [1.1, 0.3],
        desired_velocity: [if i > 20 { 2.0 } else { 0.5 }, 0.0],
        desired_yaw: if i > 30 { 1.0 } else { 0.0 },
    }
}

#[test]
fn predictor_words_round_trip_exactly() {
    let settings = TrajectorySettings::default();
    let offsets = [-0.5, -0.2, 0.33, 0.66, 1.0];
    let mut a = TrajectoryPredictor::new();
    for i in 0..200 {
        a.update(1.0 / 30.0, &input(i), &settings);
    }
    let mut words = vec![0u32; TrajectoryPredictor::WORDS];
    a.write_words(&mut words);
    let mut b = TrajectoryPredictor::read_words(&words);
    let mut again = vec![0u32; TrajectoryPredictor::WORDS];
    b.write_words(&mut again);
    assert_eq!(words, again, "words → state → words is the identity");
    for i in 200..260 {
        a.update(1.0 / 30.0, &input(i), &settings);
        b.update(1.0 / 30.0, &input(i), &settings);
        let (mut ta, mut tb) = (Trajectory::default(), Trajectory::default());
        a.predict(&input(i), &settings, &offsets, &mut ta);
        b.predict(&input(i), &settings, &offsets, &mut tb);
        for k in 0..offsets.len() {
            for c in 0..2 {
                assert_eq!(ta.positions[k][c].to_bits(), tb.positions[k][c].to_bits());
                assert_eq!(ta.directions[k][c].to_bits(), tb.directions[k][c].to_bits());
            }
        }
    }
}

#[test]
fn any_words_read_as_a_usable_predictor() {
    let settings = TrajectorySettings::default();
    let words = vec![0xFFFF_FFFFu32; TrajectoryPredictor::WORDS];
    let mut p = TrajectoryPredictor::read_words(&words);
    p.update(1.0 / 30.0, &input(0), &settings);
    let mut t = Trajectory::default();
    p.predict(&input(0), &settings, &[-0.3, 0.5], &mut t);
    assert_eq!(t.count, 2);
    // Too short: a fresh predictor.
    let mut fresh = vec![0u32; TrajectoryPredictor::WORDS];
    TrajectoryPredictor::read_words(&[1, 2, 3]).write_words(&mut fresh);
    let mut new = vec![0u32; TrajectoryPredictor::WORDS];
    TrajectoryPredictor::new().write_words(&mut new);
    assert_eq!(fresh, new);
}

#[test]
fn controller_words_round_trip_exactly() {
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let db = MatchDb::new(&PoseDbView::parse(&baked.bytes).unwrap()).unwrap();
    let settings = ControllerSettings {
        search_interval: 3,
        ..ControllerSettings::default()
    };
    let mut rng = Rng::new(7);
    let mut queries = Vec::new();
    for _ in 0..80 {
        let q: Vec<F32x4> = (0..db.lanes())
            .map(|_| {
                F32x4::new(
                    rng.f32(-1.0, 1.0),
                    rng.f32(-1.0, 1.0),
                    rng.f32(-1.0, 1.0),
                    rng.f32(-1.0, 1.0),
                )
            })
            .collect();
        queries.push(q);
    }
    let tags = TagFilter::default();
    let mut a = MatchController::new(settings);
    for q in &queries[..40] {
        a.update(&db, 1.0 / 30.0, q, &tags);
    }
    let mut words = [0u32; MatchController::WORDS];
    a.write_words(&mut words);
    let mut b = MatchController::read_words(settings, &words);
    for q in &queries[40..] {
        assert_eq!(
            a.update(&db, 1.0 / 30.0, q, &tags),
            b.update(&db, 1.0 / 30.0, q, &tags)
        );
    }
    let short = MatchController::read_words(settings, &[1]);
    assert_eq!(short.playing(), None);
}
