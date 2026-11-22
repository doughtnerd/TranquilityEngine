//! The runtime never allocates: a counting global allocator sees no allocation while the
//! predictor, the query builder, both searches and the controller run (after the database is
//! loaded and the buffers are made).

mod common;

use anim_format::posedb::PoseDbView;
use anim_match::{
    build_query, BakeSettings, ControllerSettings, MatchController, MatchDb, PoseInput,
    SearchFilter, SearchMode, TagFilter, TagMask, Trajectory, TrajectoryInput, TrajectoryPredictor,
    TrajectorySettings,
};
use anim_math::{AosTransform, AosVec3};
use anim_pose::root::RootDelta;
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::SeqCst);
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn the_runtime_does_not_allocate() {
    // Setup (allocates).
    let fx = fixture();
    let baked = fx.bake(&schema(), &BakeSettings::default());
    let view = PoseDbView::parse(&baked.bytes).unwrap();
    let db = MatchDb::new(&view).unwrap();
    let mut query = db.new_query();
    let n = 8;
    let cur: Vec<AosTransform> = (0..n)
        .map(|i| {
            let mut t = AosTransform::identity();
            t.translation = AosVec3::new(0.1 * i as f32, 1.0 - 0.1 * i as f32, 0.05);
            t
        })
        .collect();
    let prev = cur.clone();
    let settings = TrajectorySettings::default();
    let tags = TagFilter {
        excluded: TagMask::EMPTY.with(2),
        ..TagFilter::default()
    };

    let before = ALLOCS.load(Ordering::SeqCst);
    let mut predictor = TrajectoryPredictor::new();
    let mut controller = MatchController::new(ControllerSettings {
        search_interval: 3,
        ..ControllerSettings::default()
    });
    let mut traj = Trajectory::default();
    let mut found = 0u32;
    for step in 0..200 {
        let t = step as f32 / 60.0;
        let input = TrajectoryInput {
            position: [0.0, 1.4 * t],
            yaw: 0.0,
            velocity: [0.0, 1.4],
            desired_velocity: [0.3 * (step % 7) as f32, 1.4],
            desired_yaw: 0.1 * (step % 5) as f32,
        };
        predictor.update(1.0 / 60.0, &input, &settings);
        predictor.predict(&input, &settings, db.trajectory_offsets(), &mut traj);
        let pose = PoseInput {
            current: &cur,
            previous: &prev,
            delta: RootDelta::identity(),
            dt: 1.0 / 60.0,
        };
        build_query(&db, &pose, &traj, &mut query).unwrap();
        let out = controller.update(&db, 1.0 / 60.0, &query, &tags);
        found += out.searched as u32;
        for mode in [SearchMode::BruteForce, SearchMode::KdTree] {
            let filter = SearchFilter { tags, skip: None };
            found += db.search(&query, &filter, mode).is_some() as u32;
        }
        found += (db.cost(&query, 3) >= 0.0) as u32;
    }
    let after = ALLOCS.load(Ordering::SeqCst);
    assert_eq!(after - before, 0, "allocations in the runtime");
    assert!(found > 600);
}
