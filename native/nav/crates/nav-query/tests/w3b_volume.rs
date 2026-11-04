//! Flight-volume queries on baked flyer scenes: ports of the path-querying cases of Foxfire's
//! `FlightVolumeTests`, `FlightAreaTests` and `ResolutionRegionTests`.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_bake::settings::ModifierTargets;
use nav_format::{NavAreas, NavVolumeData};
use nav_math::Float3;
use nav_query::search::{SearchBufferStore, SearchListStore};
use nav_query::volume::*;
use nav_query::volume::find_path;

const CLEARANCE: f32 = 5.0;
const BOX_CENTER: (f32, f32, f32) = (0.0, 30.0, 0.0);
const BOX_SIZE: (f32, f32, f32) = (10.0, 6.0, 10.0);

fn p3(t: (f32, f32, f32)) -> Float3 {
    v3(t.0, t.1, t.2)
}

fn scene(floating_box: bool) -> &'static TestBake {
    // The big baked scenes are shared by the tests that only query them (a debug bake takes seconds).
    static WITH: std::sync::OnceLock<TestBake> = std::sync::OnceLock::new();
    static WITHOUT: std::sync::OnceLock<TestBake> = std::sync::OnceLock::new();
    if floating_box { WITH.get_or_init(|| bake_scene(true)) } else { WITHOUT.get_or_init(|| bake_scene(false)) }
}

fn bake_scene(floating_box: bool) -> TestBake {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_floor((-50.0, -50.0), (50.0, 50.0), 0.0, &[]);
    bake.add_obstacle(v3(46.0, 25.0, 46.0), v3(6.0, 50.0, 6.0), Rot::IDENTITY);
    if floating_box {
        bake.add_obstacle(p3(BOX_CENTER), p3(BOX_SIZE), Rot::IDENTITY);
    }
    bake.add_flyer(flyer());
    bake.bake();
    bake
}

fn dist(a: Float3, b: Float3) -> f32 {
    a.distance(b)
}

fn path_length(points: &[Float3]) -> f32 {
    points.windows(2).map(|w| dist(w[0], w[1])).sum()
}

fn find(v: &NavVolumeData, filter: &NavVolumeQueryFilter, a: Float3, b: Float3, snap: f32) -> (FlightPathStatus, Vec<Float3>) {
    let mut pts = Vec::new();
    let s = find_path(v, filter, a, b, snap, 1_000_000, &mut pts);
    (s, pts)
}

// ---- LeafAt, SnapToFree ------------------------------------------------------------------------------------

#[test]
fn leaf_at_is_blocked_near_a_wall_and_free_in_open_air() {
    let bake = scene(true);
    let v = bake.volume();
    assert!(leaf_at(v, p3(BOX_CENTER)) < 0, "inside the obstacle");
    assert!(leaf_at(v, v3(9.0, 30.0, 0.0)) < 0, "inside the clearance");
    assert!(leaf_at(v, v3(12.0, 30.0, 0.0)) >= 0, "clear of the padding");
    assert!(leaf_at(v, v3(-500.0, 30.0, 0.0)) < 0, "outside the volume");
    // The leaf holds the point.
    let l = leaf_at(v, v3(-30.0, 30.0, 0.0));
    let leaf = v.leaves[l as usize];
    let c = leaf_center(v, &leaf);
    let half = 0.5 * leaf.size as f32 * v.cell_size;
    assert!((c.x - -30.0).abs() <= half + 1e-3 && (c.y - 30.0).abs() <= half + 1e-3 && (c.z - 0.0).abs() <= half + 1e-3);
    assert_eq!(leaf_at(v, c), l, "its own centre");
}

#[test]
fn snap_to_free_moves_a_blocked_point_to_the_nearest_free_cell() {
    let bake = scene(true);
    let v = bake.volume();
    let inside = v3(9.0, 30.0, 0.0); // 1 m inside the padding's +x face (x = 10)
    assert!(leaf_at(v, inside) < 0);
    let (leaf, snapped) = snap_to_free(v, inside, 5.0);
    assert!(leaf >= 0);
    assert_eq!(leaf_at(v, snapped), leaf, "the snapped point is in the leaf");
    assert!(dist(snapped, inside) < 2.0 && snapped.x >= 9.9, "{snapped:?}");
    // Already free: itself.
    let free = v3(-30.0, 30.0, 0.0);
    let (l, s) = snap_to_free(v, free, 5.0);
    assert_eq!((l, s), (leaf_at(v, free), free));
    // Too far from any free air.
    assert_eq!(snap_to_free(v, p3(BOX_CENTER), 1.0).0, -1);
}

#[test]
fn snap_to_free_above_climbs_out_of_the_ground_clearance() {
    let bake = scene(false);
    let v = bake.volume();
    let on_floor = v3(-20.0, 0.0, -20.0); // the floor's padding blocks up to ~5.5 m
    assert!(leaf_at(v, on_floor) < 0);
    assert_eq!(snap_to_free(v, on_floor, 1.0).0, -1, "plain snap can't");
    let (leaf, snapped) = snap_to_free_above(v, on_floor, 1.0);
    assert!(leaf >= 0, "rises until there is free air");
    assert!(snapped.y > on_floor.y && snapped.y < 9.0, "{snapped:?}");
    // Past the rise limit: nothing.
    assert_eq!(snap_to_free_above(v, v3(-20.0, -200.0, -20.0), 1.0).0, -1);
}

// ---- SegmentClear and paths (FlightVolumeTests) -------------------------------------------------------------

#[test]
fn segment_clear_is_false_through_a_wall_and_true_in_open_air() {
    let bake = scene(true);
    let v = bake.volume();
    let (a, b) = (v3(-30.0, 30.0, 0.0), v3(30.0, 30.0, 0.0));
    assert!(!segment_clear(v, a, b), "through the floating box");
    assert!(segment_clear(v, a, v3(-30.0, 30.0, 30.0)));
    assert!(segment_clear(v, v3(-30.0, 20.0, -30.0), v3(30.0, 20.0, 30.0)), "open diagonal");
    assert!(!segment_clear(v, a, v3(-30.0, 3.0, 0.0)), "down into the floor's clearance");
    assert!(!segment_clear(v, a, v3(-500.0, 30.0, 0.0)), "out of the volume");
}

#[test]
fn path_goes_around_the_floating_obstacle() {
    let bake = scene(true);
    let v = bake.volume();
    let (start, goal) = (v3(-30.0, 30.0, 0.0), v3(30.0, 30.0, 0.0));
    let (status, pts) = find(v, &NavVolumeQueryFilter::default(), start, goal, 5.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert!(pts.len() > 2, "went straight through the obstacle");
    assert!(dist(start, pts[0]) <= 0.5 && dist(goal, *pts.last().unwrap()) <= 0.5);
    let (c, s) = (p3(BOX_CENTER), p3(BOX_SIZE));
    for (i, p) in pts.iter().enumerate() {
        let d = Float3::new((p.x - c.x).abs(), (p.y - c.y).abs(), (p.z - c.z).abs());
        let inside = d.x < 0.5 * s.x + CLEARANCE - 0.5 && d.y < 0.5 * s.y + CLEARANCE - 0.5 && d.z < 0.5 * s.z + CLEARANCE - 0.5;
        assert!(!inside, "point {i} {p:?} is inside the padded box");
        if i > 0 {
            assert!(segment_clear(v, pts[i - 1], *p), "segment {} crosses blocked space", i - 1);
        }
    }
    assert!(path_length(&pts) > dist(start, goal) + 1.0);
}

#[test]
fn path_in_open_air_is_one_straight_segment() {
    let bake = scene(false);
    let (start, goal) = (v3(-30.0, 20.0, -30.0), v3(30.0, 20.0, 30.0));
    let (status, pts) = find(bake.volume(), &NavVolumeQueryFilter::default(), start, goal, 5.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert_eq!(pts.len(), 2);
    assert!(dist(start, pts[0]) <= 0.5 && dist(goal, pts[1]) <= 0.5);
}

#[test]
fn a_one_leaf_path_is_start_to_goal_and_a_far_end_is_invalid() {
    let bake = scene(false);
    let v = bake.volume();
    let (s, pts) = find(v, &NavVolumeQueryFilter::default(), v3(-30.0, 20.0, -30.0), v3(-30.0, 20.5, -30.0), 5.0);
    assert_eq!(s, FlightPathStatus::Success);
    assert_eq!(pts.len(), 2);
    let (s, pts) = find(v, &NavVolumeQueryFilter::default(), v3(-30.0, 20.0, -30.0), v3(0.0, -300.0, 0.0), 5.0);
    assert_eq!(s, FlightPathStatus::InvalidInput);
    assert!(pts.is_empty());
}

#[test]
fn sliced_search_on_buffer_store_equals_the_one_shot_search_twice() {
    let bake = scene(true);
    let v = bake.volume();
    let (start, goal) = (v3(-30.0, 30.0, 0.0), v3(30.0, 30.0, 0.0));
    let filter = NavVolumeQueryFilter::default();
    let (whole_status, whole) = find(v, &filter, start, goal, 5.0);

    let mut store = SearchBufferStore::default();
    let mut search = NavFlightAStar::default();
    for _round in 0..2 {
        store.begin();
        assert!(begin(v, &filter, start, goal, 5.0, 100_000, &mut search, &mut store));
        let mut steps = 1;
        while !step(v, &filter, &mut search, &mut store, 1) {
            steps += 1;
        }
        let mut sliced = Vec::new();
        let status = finish(v, &filter, &search, &store, &mut sliced);
        assert!(steps > 10, "many steps");
        assert_eq!(status, whole_status);
        assert_eq!(whole.len(), sliced.len());
        for (a, b) in whole.iter().zip(&sliced) {
            assert_eq!(a, b, "bit-identical points");
        }
    }
    // And the list store, sliced.
    let mut list = SearchListStore::default();
    assert!(begin(v, &filter, start, goal, 5.0, 100_000, &mut search, &mut list));
    while !step(v, &filter, &mut search, &mut list, 7) {}
    let mut sliced = Vec::new();
    finish(v, &filter, &search, &list, &mut sliced);
    assert_eq!(whole, sliced);
}

#[test]
fn a_node_budget_ends_the_search_with_a_partial_path_towards_the_goal() {
    let bake = scene(true);
    let v = bake.volume();
    let (start, goal) = (v3(-30.0, 30.0, 0.0), v3(30.0, 30.0, 0.0));
    let mut pts = Vec::new();
    let (status, nodes) = find_path_counted(v, &NavVolumeQueryFilter::default(), start, goal, 5.0, 20, &mut pts);
    assert_eq!(status, FlightPathStatus::Partial);
    assert!(nodes <= 20);
    assert!(!pts.is_empty() && dist(pts[0], start) <= 0.5);
    assert!(pts.last().unwrap().x < 30.0);
}

#[test]
fn flying_over_void_leaves_the_air_underneath_free_and_reachable() {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_floor((-50.0, -50.0), (0.0, 50.0), 0.0, &[]);
    bake.add_obstacle(v3(30.0, 30.0, 0.0), p3(BOX_SIZE), Rot::IDENTITY);
    bake.add_flyer(flyer());
    bake.bake();
    let v = bake.volume();
    assert!(leaf_at(v, v3(30.0, 30.0, 0.0)) < 0);
    assert!(leaf_at(v, v3(30.0, 12.0, 0.0)) >= 0);
    let (s, pts) = find(v, &NavVolumeQueryFilter::default(), v3(30.0, 12.0, 0.0), v3(20.0, 12.0, 0.0), 5.0);
    assert_eq!(s, FlightPathStatus::Success);
    assert!(pts.len() >= 2);
}

// ---- Areas (FlightAreaTests) ---------------------------------------------------------------------------------

fn sky_scene(cost: f32, center: Float3, size: Float3, targets: u8) -> TestBake {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_floor((-50.0, -50.0), (50.0, 50.0), 0.0, &[]);
    bake.add_obstacle(v3(48.0, 15.0, 48.0), v3(2.0, 30.0, 2.0), Rot::IDENTITY);
    let area = bake.add_area(cost);
    bake.add_modifier_volume(center, size, area, targets, &[]);
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0));
    bake.bake();
    bake
}

const CUSTOM: i32 = NavAreas::FIRST_CUSTOM;
const CLOUD_CENTER: (f32, f32, f32) = (0.0, 20.0, 0.0);
const CLOUD_SIZE: (f32, f32, f32) = (10.0, 10.0, 10.0);
const WALL_SIZE: (f32, f32, f32) = (10.0, 100.0, 200.0);

fn assert_no_sample_inside(points: &[Float3], center: Float3, size: Float3) {
    let half = size * 0.5 - Float3::splat(0.5);
    for (i, p) in points.iter().enumerate() {
        let steps = if i == 0 { 0 } else { ((p.distance(points[i - 1]) / 0.25).ceil() as i32).max(1) };
        for s in 0..=steps {
            let q = if steps == 0 { *p } else { points[i - 1].lerp(*p, s as f32 / steps as f32) };
            let d = Float3::new((q.x - center.x).abs(), (q.y - center.y).abs(), (q.z - center.z).abs());
            assert!(!(d.x < half.x && d.y < half.y && d.z < half.z), "the path enters the box at {q:?}");
        }
    }
}

#[test]
fn area_stamps_are_in_the_leaves_and_the_table() {
    let bake = sky_scene(10.0, p3(CLOUD_CENTER), p3(CLOUD_SIZE), ModifierTargets::AIR);
    let v = bake.volume();
    let inside = leaf_at(v, p3(CLOUD_CENTER));
    assert!(inside >= 0);
    assert_eq!(v.leaves[inside as usize].area as i32, CUSTOM);
    let f = NavVolumeQueryFilter::for_volume(v, &[]);
    assert_eq!(f.cost(CUSTOM), 10.0);
    assert_eq!(f.cost(NavAreas::WALKABLE), 1.0);
    let ex = NavVolumeQueryFilter::for_volume(v, &[CUSTOM]);
    assert!(ex.excluded(CUSTOM) && !ex.excluded(NavAreas::WALKABLE));
}

#[test]
fn a_costly_cloud_is_flown_around() {
    let bake = sky_scene(10.0, p3(CLOUD_CENTER), p3(CLOUD_SIZE), ModifierTargets::AIR);
    let v = bake.volume();
    let filter = NavVolumeQueryFilter::for_volume(v, &[]);
    let (start, goal) = (v3(-30.0, 20.0, 0.0), v3(30.0, 20.0, 0.0));
    let (status, pts) = find(v, &filter, start, goal, 5.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert!(pts.len() > 2, "went straight through the cloud");
    assert!(dist(start, pts[0]) <= 0.5 && dist(goal, *pts.last().unwrap()) <= 0.5);
    assert_no_sample_inside(&pts, p3(CLOUD_CENTER), p3(CLOUD_SIZE));
    assert!(path_length(&pts) > dist(start, goal) + 0.5);
    // The same trip with every area costing 1 goes through it.
    let (_, straight) = find(v, &NavVolumeQueryFilter::default(), start, goal, 5.0);
    assert_eq!(straight.len(), 2);
}

#[test]
fn a_cheap_wall_cloud_is_flown_through_when_it_is_the_only_way() {
    let bake = sky_scene(1.5, p3(CLOUD_CENTER), p3(WALL_SIZE), ModifierTargets::AIR);
    let v = bake.volume();
    let filter = NavVolumeQueryFilter::for_volume(v, &[]);
    let wall = leaf_at(v, p3(CLOUD_CENTER));
    assert_eq!(v.leaves[wall as usize].area as i32, CUSTOM);
    let (start, goal) = (v3(-30.0, 20.0, 0.0), v3(30.0, 20.0, 0.0));
    let (status, pts) = find(v, &filter, start, goal, 5.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert_eq!(pts.len(), 2, "one straight segment through the wall");
}

#[test]
fn an_excluded_area_is_never_entered() {
    let bake = sky_scene(1.0, p3(CLOUD_CENTER), p3(WALL_SIZE), ModifierTargets::AIR);
    let v = bake.volume();
    let (start, goal) = (v3(-30.0, 20.0, 0.0), v3(30.0, 20.0, 0.0));
    let excluded = NavVolumeQueryFilter::for_volume(v, &[CUSTOM]);
    let (status, pts) = find(v, &excluded, start, goal, 5.0);
    assert_eq!(status, FlightPathStatus::Partial);
    assert!(!pts.is_empty());
    assert_no_sample_inside(&pts, p3(CLOUD_CENTER), p3(WALL_SIZE));
    assert!(pts.last().unwrap().x < 0.0, "stopped on the start's side of the wall");
    let allowed = NavVolumeQueryFilter::for_volume(v, &[]);
    assert_eq!(find(v, &allowed, start, goal, 5.0).0, FlightPathStatus::Success);
}

#[test]
fn segment_clear_with_a_filter_refuses_costlier_and_excluded_areas() {
    let bake = sky_scene(5.0, p3(CLOUD_CENTER), p3(CLOUD_SIZE), ModifierTargets::AIR);
    let v = bake.volume();
    let f = NavVolumeQueryFilter::for_volume(v, &[]);
    let (a, b) = (v3(-30.0, 20.0, 0.0), v3(30.0, 20.0, 0.0));
    assert!(segment_clear_filtered(v, &f, a, b, 5.0));
    assert!(!segment_clear_filtered(v, &f, a, b, 1.0), "the cloud costs 5");
    let ex = NavVolumeQueryFilter::for_volume(v, &[CUSTOM]);
    assert!(!segment_clear_filtered(v, &ex, a, b, 100.0));
}

// ---- Resolution regions (ResolutionRegionTests) --------------------------------------------------------------

const WALL_FACE: f32 = 1.375;
const WALL_END: f32 = 13.0;
const WALL_HEIGHT: f32 = 10.0;
const HEADROOM: f32 = 5.0;
const START: (f32, f32, f32) = (0.1, 5.0, -8.0);
const GOAL: (f32, f32, f32) = (0.1, 5.0, 8.0);

fn add_wall(bake: &mut TestBake, side: f32) {
    let len = WALL_END - WALL_FACE;
    bake.add_obstacle(v3(side * 0.5 * (WALL_END + WALL_FACE), 0.5 * WALL_HEIGHT, 0.0), v3(len, WALL_HEIGHT, 2.0), Rot::IDENTITY);
}

fn gap_scene(setup: impl Fn(&mut TestBake), flyer: Option<nav_bake::settings::BakeFlyer>) -> TestBake {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    add_wall(&mut bake, -1.0);
    add_wall(&mut bake, 1.0);
    bake.add_obstacle(v3(12.5, 0.5 * WALL_HEIGHT, 10.5), v3(1.0, WALL_HEIGHT, 1.0), Rot::IDENTITY);
    bake.add_obstacle(v3(12.5, 0.5 * WALL_HEIGHT, -10.5), v3(1.0, WALL_HEIGHT, 1.0), Rot::IDENTITY);
    setup(&mut bake);
    bake.add_flyer(flyer.unwrap_or_else(|| flyer_with(1.0, 1.0, HEADROOM)));
    bake.bake();
    bake
}

fn gap_region(bake: &mut TestBake) {
    let top = WALL_HEIGHT + HEADROOM;
    bake.add_resolution_volume(v3(0.0, 0.5 * top, 0.0), v3(6.0, top, 10.0), 0.25, &[]);
}

#[test]
fn a_gap_closed_at_the_base_cell_size_forces_a_detour_over_the_walls() {
    let bake = gap_scene(|_| {}, None);
    let v = bake.volume();
    assert!(v.blocks.is_empty());
    assert!(leaf_at(v, v3(0.1, 7.0, 0.0)) < 0, "the gap is closed");
    assert!(!segment_clear(v, p3(START), p3(GOAL)));
    let (status, pts) = find(v, &NavVolumeQueryFilter::default(), p3(START), p3(GOAL), 2.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert!(pts.len() > 2);
    assert!(path_length(&pts) > dist(p3(START), p3(GOAL)) + 3.0, "a detour");
}

fn free_near(v: &NavVolumeData, p: Float3) -> bool {
    (0..8).any(|i| {
        let s = |bit: i32| if i & bit == 0 { -0.02 } else { 0.02 };
        leaf_at(v, p + v3(s(1), s(2), s(4))) >= 0
    })
}

fn assert_straight_path(bake: &TestBake) {
    let v = bake.volume();
    let (status, pts) = find(v, &NavVolumeQueryFilter::default(), p3(START), p3(GOAL), 2.0);
    assert_eq!(status, FlightPathStatus::Success);
    assert!(dist(p3(START), pts[0]) <= 0.5 && dist(p3(GOAL), *pts.last().unwrap()) <= 0.5);
    for (i, p) in pts.iter().enumerate() {
        assert!(free_near(v, *p), "point {i} {p:?} is blocked");
        if i > 0 {
            assert!(segment_clear(v, pts[i - 1], *p), "segment {} crosses blocked space", i - 1);
        }
    }
    assert!(path_length(&pts) <= 1.13 * dist(p3(START), p3(GOAL)), "not close to straight: {}", path_length(&pts));
}

#[test]
fn a_resolution_region_opens_the_gap_and_the_block_walk_sees_thin_walls() {
    let bake = gap_scene(gap_region, None);
    let v = bake.volume();
    assert!(!v.blocks.is_empty());
    assert!(leaf_at(v, v3(0.1, 7.0, 0.0)) >= 0 && leaf_at(v, v3(-0.1, 7.0, 0.0)) >= 0);
    assert_straight_path(&bake);
    assert!(!segment_clear(v, v3(5.0, 5.0, -8.0), v3(5.0, 5.0, 8.0)), "through the +x wall");
    assert!(segment_clear(v, v3(0.1, 5.0, -4.0), v3(0.1, 5.0, 4.0)), "down the gap");
    assert!(!segment_clear(v, v3(0.1, 5.0, 0.0), v3(0.1, 5.0, -400.0)), "out of the volume");
}

#[test]
fn auto_refinement_opens_the_gap() {
    let bake = gap_scene(|b| b.settings.setup.flight_auto_refine = nav_bake::settings::FlightAutoRefinement::X4, None);
    assert!(!bake.volume().blocks.is_empty());
    assert_straight_path(&bake);
}

#[test]
fn snap_to_free_looks_inside_refined_cells() {
    let bake = gap_scene(gap_region, None);
    let v = bake.volume();
    let p = v3(0.6, 7.0, 0.0);
    if leaf_at(v, p) < 0 {
        let (leaf, snapped) = snap_to_free(v, p, 1.0);
        assert!(leaf >= 0, "a free fine cell is within a metre");
        assert_eq!(leaf_at(v, snapped), leaf);
        assert!(dist(snapped, p) <= 1.0);
    }
    assert!(cell_size_at(v, v3(0.1, 7.0, 0.0)) < base_cell_size(v) + 1e-6);
    assert_eq!(cell_size_at(v, v3(10.0, 7.0, -9.0)), base_cell_size(v));
}

// ---- Determinism ---------------------------------------------------------------------------------------------

#[test]
fn queries_are_repeatable() {
    let bake = scene(true);
    let v = bake.volume();
    let (start, goal) = (v3(-30.0, 30.0, 0.0), v3(30.0, 30.0, 0.0));
    let a = find(v, &NavVolumeQueryFilter::default(), start, goal, 5.0);
    let b = find(v, &NavVolumeQueryFilter::default(), start, goal, 5.0);
    assert_eq!(a, b);
}
