//! Routes for agents that walk and fly (W4b): Foxfire's `HybridRouteTests` route searches within one chunk
//! (`NavHybridPathfinding`), and the search parts of `NavHybridChunkRouteTests` across two chunks
//! (`NavHybridChunkRouting` over `NavRouteSearchCore`), on real bakes.
mod w4b_common;

use nav_math::Float3;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::hybrid::*;
use nav_query::pathfinding::{find_nearest_poly, NavPathStatus};
use nav_query::route_graph::RouteGraphs;
use nav_query::route_search::{self, NavChunkRouteEnd, NavRouteAStar, NavRouteLeg, NavRouteLegKind as K};
use nav_query::routing::locate;
use nav_query::search::{SearchBufferStore, SearchStore};
use nav_query::volume::{snap_to_free, NavVolumeQueryFilter};
use std::sync::OnceLock;
use w4b_common::*;

// ================================================================ HybridRouteTests (one chunk)

/// `HybridRouteTests.Scene`: the hybrid agent (radius 0.5 walker, radius 1 flyer, id 1, 10 m headroom) with the
/// given landing slope limit.
fn scene(max_landing_slope_deg: f32, build: impl Fn(&mut TestBake)) -> TestBake {
    let (walker, flyer) = hybrid(1.0, 0.5, 10.0, max_landing_slope_deg, 1, false);
    let mut bake = TestBake::new(None);
    bake.add_hybrid(walker, flyer);
    build(&mut bake);
    bake.bake();
    assert_eq!(bake.out.file.navmeshes.len(), 1, "no navmesh baked");
    assert_eq!(bake.out.file.volumes.len(), 1, "no flight volume baked");
    assert_eq!(bake.out.file.landing_links.len(), 1, "no landing links baked for the hybrid agent type");
    bake
}

/// Two islands (x -12..-4 and 4..12, z -4..4) with nothing between them, for a walker that can't jump.
fn chasm() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| {
        scene(30.0, |b| {
            b.add_floor((-12.0, -4.0), (-4.0, 4.0), 0.0, &[]);
            b.add_floor((4.0, -4.0), (12.0, 4.0), 0.0, &[]);
        })
    })
}

/// A 20 x 80 m floor split by a 3 m high wall with a 4 m opening at the far end.
fn wall_scene() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| {
        scene(30.0, |b| {
            b.add_floor((-10.0, -40.0), (10.0, 40.0), 0.0, &[]);
            b.add_obstacle(v3(0.0, 1.5, -2.0), v3(1.0, 3.0, 76.0), Rot::IDENTITY);
        })
    })
}

const CHASM_START: Float3 = Float3::new(-8.0, 0.0, 0.0);
const CHASM_GOAL: Float3 = Float3::new(8.0, 0.0, 0.0);

fn ground_filter() -> NavMeshQueryFilter<'static> {
    NavMeshQueryFilter::default_for(0.5)
}

/// Unlimited flight by default; costs of 1 per metre both ways, and 1 to take off and land.
fn settings() -> NavHybridParams {
    NavHybridParams {
        flight_cost_multiplier: 1.0,
        takeoff_cost: 1.0,
        landing_cost: 1.0,
        min_landing_slope_cos: 30.0f32.to_radians().cos(),
        max_nodes: 100_000,
        ..NavHybridParams::default()
    }
}

/// A route end on the navmesh only: the nearest polygon within 2 m.
fn ground_end(bake: &TestBake, p: Float3) -> NavRouteEnd {
    let (poly, nearest) = find_nearest_poly(bake.nav(), p, 2.0, &ground_filter()).unwrap_or_else(|| panic!("setup: {p:?} isn't on the navmesh"));
    NavRouteEnd { poly, ground_pos: nearest, leaf: -1, air_pos: Float3::default() }
}

fn goal_of(bake: &TestBake, p: Float3) -> Float3 {
    ground_end(bake, p).ground_pos
}

/// A route end in the flight volume only: the nearest free cell within 2 m.
fn air_end(bake: &TestBake, p: Float3) -> NavRouteEnd {
    let (leaf, snapped) = snap_to_free(bake.volume(), p, 2.0);
    assert!(leaf >= 0, "setup: {p:?} isn't in the flight volume");
    NavRouteEnd { poly: -1, ground_pos: Float3::default(), leaf, air_pos: snapped }
}

fn route(bake: &TestBake, settings: NavHybridParams, start: NavRouteEnd, goal: NavRouteEnd) -> (NavPathStatus, Vec<NavRouteLeg>) {
    let mut legs = Vec::new();
    let links = &bake.out.file.landing_links[0].data;
    let (status, _) = find_route(bake.nav(), &ground_filter(), bake.volume(), &NavVolumeQueryFilter::default(), links, &settings, &start, &goal, &mut legs);
    (status, legs)
}

fn walk_short(bake: &TestBake, legs: &[NavRouteLeg], ratio: f32) -> Vec<NavRouteLeg> {
    let mut out = legs.to_vec();
    walk_short_flights(bake.nav(), &ground_filter(), ratio, 2.0, &mut out);
    out
}

fn flight_lengths_within(legs: &[NavRouteLeg], budget: f32) {
    for i in 1..legs.len() {
        if legs[i].kind == K::Fly {
            assert!(legs[i - 1].next_start.distance(legs[i].end) <= budget, "flight leg {i} is longer than the budget: {}", describe(legs));
        }
    }
}

#[test]
fn chasm_is_crossed_by_flying_walk_fly_walk() {
    let bake = chasm();
    let (status, legs) = route(bake, settings(), ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
    // Walk to a takeoff on island A, rise straight up.
    assert!(legs[0].end.x < -4.0, "the takeoff isn't on the start's island: {}", describe(&legs));
    assert!(legs[0].end.y.abs() <= 0.3);
    assert!((legs[0].end.x - legs[0].next_start.x).abs() <= 1e-4 && (legs[0].end.z - legs[0].next_start.z).abs() <= 1e-4);
    assert!(legs[0].next_start.y - legs[0].end.y >= 0.99, "the takeoff's air point is below the flyer's radius");
    // Fly to above island B, settle onto it.
    assert!(legs[1].end.x > 4.0, "the flight doesn't end over the goal's island: {}", describe(&legs));
    assert!(legs[1].end.y >= 0.99);
    assert!((legs[1].end.x - legs[1].next_start.x).abs() <= 1e-4);
    assert!(legs[1].next_start.y.abs() <= 0.3);
    // Walk to the goal.
    assert!(legs[2].end.distance(goal_of(bake, CHASM_GOAL)) <= 1e-3);
}

#[test]
fn chasm_with_a_short_flight_budget_is_partial_and_never_flies_farther_than_the_budget() {
    let bake = chasm();
    // 8 m is under the 9 m between the islands' walkable edges: no flight can span the chasm.
    let (limited, legs) = route(bake, NavHybridParams { max_flight_distance: 8.0, ..settings() }, ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(limited, NavPathStatus::Partial, "an 8 m flight crossed a 9 m chasm: {}", describe(&legs));
    assert!(!legs.is_empty());
    flight_lengths_within(&legs, 8.0);
    // A budget of 28 m: the longest crossing is 16 m plus two rises of up to 2.5 m.
    let (generous, legs) = route(bake, NavHybridParams { max_flight_distance: 28.0, ..settings() }, ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(generous, NavPathStatus::Success, "a 28 m flight can't cross: {}", describe(&legs));
}

#[test]
fn chasm_with_a_short_flight_budget_and_land_when_short_ends_on_the_ground() {
    let bake = chasm();
    let s = NavHybridParams { max_flight_distance: 8.0, land_when_short: true, ..settings() };
    let (status, legs) = route(bake, s, ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(status, NavPathStatus::Partial, "{}", describe(&legs));
    let last = legs.last().unwrap();
    assert_eq!(last.kind, K::Walk, "the route ends with a walk: {}", describe(&legs));
    assert!(last.end.y.abs() <= 0.3, "on the floor");
    assert!(last.end.x < 0.0, "on the start's island: {}", describe(&legs));
    assert!(last.end.x > CHASM_START.x, "toward the goal: {}", describe(&legs));
}

#[test]
fn out_of_flight_in_the_air_find_nearest_landing_lands_anyway() {
    let bake = chasm();
    // Over the chasm with the whole 8 m budget already flown: no landing fits, so the route ends in the air.
    let s = NavHybridParams { max_flight_distance: 8.0, flown_so_far: 8.0, land_when_short: true, ..settings() };
    let start = air_end(bake, Float3::new(0.0, 4.0, 0.0));
    let (stuck, legs) = route(bake, s, start, ground_end(bake, CHASM_GOAL));
    assert_eq!(stuck, NavPathStatus::Partial);
    assert_eq!(legs.last().unwrap().kind, K::Fly, "setup: the route ends in the air: {}", describe(&legs));

    // The nearest landing ignores the budget: fly down to one, then stand on the ground.
    let mut legs = Vec::new();
    let links = &bake.out.file.landing_links[0].data;
    let status = find_nearest_landing(bake.nav(), &ground_filter(), bake.volume(), &NavVolumeQueryFilter::default(), links, &s, &start, &mut legs);
    assert_eq!(status, NavPathStatus::Partial);
    assert_eq!(kinds(&legs), vec![K::Fly, K::Walk], "a flight down, then the ground: {}", describe(&legs));
    assert!(legs[1].end.y.abs() <= 0.3, "on the floor");
    assert!(legs[1].end.x.abs() > 4.0, "on one of the islands, not over the chasm");
}

#[test]
fn island_hop_the_budget_forces_a_landing_in_the_middle() {
    let bake = scene(30.0, |b| {
        b.add_floor((-12.0, -3.0), (-6.0, 3.0), 0.0, &[]);
        b.add_floor((-3.0, -3.0), (3.0, 3.0), 0.0, &[]);
        b.add_floor((6.0, -3.0), (12.0, 3.0), 0.0, &[]);
    });
    let start = ground_end(&bake, Float3::new(-9.0, 0.0, 0.0));
    let goal = ground_end(&bake, Float3::new(9.0, 0.0, 0.0));

    let (status, legs) = route(&bake, NavHybridParams { max_flight_distance: 15.0, ..settings() }, start, goal);
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.x < -6.0, "the first takeoff isn't on island A: {}", describe(&legs));
    assert!((-3.0..=3.0).contains(&legs[1].end.x), "the first flight doesn't land on island B: {}", describe(&legs));
    assert!((-3.0..=3.0).contains(&legs[2].end.x), "the second takeoff isn't on island B: {}", describe(&legs));
    assert!(legs[3].end.x > 6.0, "the second flight doesn't land on island C: {}", describe(&legs));
    assert!(legs[4].end.distance(goal_of(&bake, Float3::new(9.0, 0.0, 0.0))) <= 1e-3);
    flight_lengths_within(&legs, 15.0);

    // Unlimited: no reason to land, one flight over island B.
    let (status, legs) = route(&bake, settings(), start, goal);
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
}

#[test]
fn flyer_lands_to_reach_a_ground_goal_under_a_roof() {
    let bake = scene(30.0, |b| {
        b.add_floor((-10.0, -10.0), (10.0, 10.0), 0.0, &[]);
        b.add_obstacle(v3(5.0, 2.5, 0.0), v3(10.0, 0.2, 20.0), Rot::IDENTITY);
    });
    let start = air_end(&bake, Float3::new(-5.0, 6.0, 0.0));
    let goal = ground_end(&bake, Float3::new(7.0, 0.0, 0.0));
    let (status, legs) = route(&bake, settings(), start, goal);
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Fly, K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.x < 0.0, "the landing isn't on the open half: {}", describe(&legs));
    assert!(legs[0].end.y >= 0.99, "the flight ends on the ground");
    assert!(legs[0].next_start.y.abs() <= 0.3, "the landing doesn't settle on the floor");
    assert!(legs[1].end.distance(goal_of(&bake, Float3::new(7.0, 0.0, 0.0))) <= 1e-3);
}

#[test]
fn flight_is_chosen_only_when_it_is_cheaper() {
    let bake = wall_scene();
    let start = ground_end(bake, Float3::new(-5.0, 0.0, 0.0));
    let goal = ground_end(bake, Float3::new(5.0, 0.0, 0.0));

    let (cheap, legs) = route(bake, NavHybridParams { takeoff_cost: 0.0, landing_cost: 0.0, ..settings() }, start, goal);
    assert_eq!(cheap, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.x < 0.0, "the takeoff isn't on the start's side of the wall");
    assert!(legs[1].end.x > 0.0, "the flight doesn't land on the goal's side of the wall");

    let (costly, legs) = route(bake, NavHybridParams { takeoff_cost: 100.0, landing_cost: 100.0, ..settings() }, start, goal);
    assert_eq!(costly, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.distance(goal_of(bake, Float3::new(5.0, 0.0, 0.0))) <= 1e-3);

    let (expensive, legs) = route(bake, NavHybridParams { takeoff_cost: 0.0, landing_cost: 0.0, flight_cost_multiplier: 20.0, ..settings() }, start, goal);
    assert_eq!(expensive, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk], "{}", describe(&legs));
}

#[test]
fn takeoff_rises_to_the_takeoff_height_and_landing_comes_down_from_it() {
    let bake = chasm();
    let (status, legs) = route(bake, NavHybridParams { takeoff_height: 4.0, ..settings() }, ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
    assert!((legs[0].end.x - legs[0].next_start.x).abs() <= 1e-4 && (legs[0].end.z - legs[0].next_start.z).abs() <= 1e-4, "the takeoff doesn't rise straight up");
    assert!((legs[0].next_start.y - legs[0].end.y - 4.0).abs() <= 0.26, "the flight doesn't start at the takeoff height: {}", describe(&legs));
    assert!((legs[1].next_start.x - legs[1].end.x).abs() <= 1e-4, "the landing doesn't come straight down");
    assert!((legs[1].end.y - legs[1].next_start.y - 4.0).abs() <= 0.26, "the flight doesn't end at the takeoff height: {}", describe(&legs));
}

#[test]
fn flight_is_walked_instead_when_the_walk_is_no_longer_than_the_ratio_allows() {
    let bake = wall_scene();
    let start = ground_end(bake, Float3::new(-5.0, 0.0, 0.0));
    let goal = ground_end(bake, Float3::new(5.0, 0.0, 0.0));
    let (status, legs) = route(bake, NavHybridParams { takeoff_cost: 0.0, landing_cost: 0.0, ..settings() }, start, goal);
    assert_eq!(status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk]);

    assert_eq!(walk_short(bake, &legs, 0.0).len(), 3, "a ratio of 0 changed the route");
    assert_eq!(walk_short(bake, &legs, 1.5).len(), 3, "a 75 m walk replaced a much shorter flight");
    let walked = walk_short(bake, &legs, 10.0);
    assert_eq!(kinds(&walked), vec![K::Walk]);
    assert!(walked[0].end.distance(goal_of(bake, Float3::new(5.0, 0.0, 0.0))) <= 1e-3);
}

#[test]
fn flight_over_a_chasm_is_not_walked_instead() {
    let bake = chasm();
    let (_, legs) = route(bake, settings(), ground_end(bake, CHASM_START), ground_end(bake, CHASM_GOAL));
    assert_eq!(kinds(&walk_short(bake, &legs, 100.0)), vec![K::Walk, K::Fly, K::Walk]);
}

#[test]
fn airborne_start_counts_the_distance_already_flown() {
    let bake = scene(30.0, |b| {
        b.add_floor((-12.0, -3.0), (-6.0, 3.0), 0.0, &[]);
        b.add_floor((6.0, -3.0), (12.0, 3.0), 0.0, &[]);
    });
    let start = air_end(&bake, Float3::new(-9.0, 3.0, 0.0));
    let goal = ground_end(&bake, Float3::new(9.0, 0.0, 0.0));

    let (fresh, legs) = route(&bake, NavHybridParams { max_flight_distance: 26.0, ..settings() }, start, goal);
    assert_eq!(fresh, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Fly, K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.x > 6.0, "the flight doesn't land on island B: {}", describe(&legs));

    let (tired, legs) = route(&bake, NavHybridParams { max_flight_distance: 26.0, flown_so_far: 20.0, ..settings() }, start, goal);
    assert_eq!(tired, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Fly, K::Walk, K::Fly, K::Walk], "{}", describe(&legs));
    assert!(legs[0].end.x < -6.0, "the first landing isn't on island A: {}", describe(&legs));
    assert!(legs[2].end.x > 6.0, "the second flight doesn't land on island B: {}", describe(&legs));
    assert!(legs[3].end.distance(goal_of(&bake, Float3::new(9.0, 0.0, 0.0))) <= 1e-3);
    assert!(legs[1].next_start.distance(legs[2].end) <= 26.0, "the second flight is over budget");
}

// ================================================================ NavHybridChunkRouteTests (across chunks)

const MIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_A: Float3 = Float3::new(0.0, 16.0, 16.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_B: Float3 = Float3::new(40.0, 16.0, 16.0);

fn wall_a() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| hybrid_bake(MIN_A, MAX_A, true, (-40.0, -16.0), (40.0, 16.0)))
}
fn wall_b() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| hybrid_bake(MIN_B, MAX_B, true, (-40.0, -16.0), (40.0, 16.0)))
}
fn floor_a() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| hybrid_bake(MIN_A, MAX_A, false, (-40.0, -16.0), (40.0, 16.0)))
}
fn floor_b() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| hybrid_bake(MIN_B, MAX_B, false, (-40.0, -16.0), (40.0, 16.0)))
}

/// `NavHybridChunkRouteTests.Params`: `NavFlightAgent.Default()`'s costs (flight 1, takeoff and landing 20, 30
/// degree landing slope, 20 m takeoff height), 20000 nodes.
fn params() -> NavHybridParams {
    NavHybridParams {
        flight_cost_multiplier: 1.0,
        takeoff_cost: 20.0,
        landing_cost: 20.0,
        min_landing_slope_cos: 30.0f32.to_radians().cos(),
        takeoff_height: 20.0,
        max_nodes: 20_000,
        ..NavHybridParams::default()
    }
}

fn ground_at(graphs: &RouteGraphs, p: Float3) -> NavChunkRouteEnd {
    let (graph, poly, ground_pos) = locate(graphs, &ground_filter(), p, 2.0, Float3::default()).unwrap_or_else(|| panic!("{p:?} not on any graph"));
    NavChunkRouteEnd { graph, poly, ground_pos, ..NavChunkRouteEnd::NONE }
}

fn chunk_route(graphs: &RouteGraphs) -> (ChunkRouteResult, Vec<NavRouteLeg>) {
    let mut legs = Vec::new();
    let r = find_chunk_route(graphs, &ground_filter(), &air_filters(graphs), &params(), &ground_at(graphs, START), &ground_at(graphs, GOAL), false, GOAL, &mut legs);
    (r, legs)
}

fn expect(leg: &NavRouteLeg, kind: K, chunk: nav_math::Hash128) {
    assert_eq!((leg.kind, leg.chunk), (kind, chunk));
}

#[test]
fn wall_across_the_face_flies_from_a_into_b() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, wall_a()), loaded(CHUNK_B, wall_b())], TYPE);
    assert_eq!(graphs.volumes.len(), 2, "both chunks' flight volumes");
    assert!(!graphs.air_links.is_empty(), "the volumes join across the face");
    let (r, legs) = chunk_route(&graphs);
    assert_eq!(r.status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(legs.len(), 4, "walk in A, fly in A, fly in B, walk in B: {}", describe(&legs));
    expect(&legs[0], K::Walk, CHUNK_A);
    expect(&legs[1], K::Fly, CHUNK_A);
    expect(&legs[2], K::Fly, CHUNK_B);
    expect(&legs[3], K::Walk, CHUNK_B);
    assert!(legs[1].end.x.abs() < 1e-3, "the flight crosses on the face: {}", describe(&legs));
    assert!(legs[1].exit_a.x == 0.0 && legs[1].exit_b.x == 0.0, "by a face rectangle");
    assert!((legs[3].end.x - GOAL.x).abs() < 1e-2, "and ends at the goal");
}

#[test]
fn floor_across_the_face_walks() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, floor_a()), loaded(CHUNK_B, floor_b())], TYPE);
    let (r, legs) = chunk_route(&graphs);
    assert_eq!(r.status, NavPathStatus::Success);
    assert_eq!(legs.len(), 2, "walk in A, walk in B: {}", describe(&legs));
    expect(&legs[0], K::Walk, CHUNK_A);
    expect(&legs[1], K::Walk, CHUNK_B);
    assert!(legs[0].end.x.abs() < 1e-3, "the walk crosses on the face");
    assert_ne!(legs[0].exit_a, legs[0].exit_b, "with the seam link as its exit");
}

#[test]
fn goal_in_unloaded_space_routes_to_the_edge() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, floor_a())], TYPE);
    let mut legs = Vec::new();
    let r = find_chunk_route(&graphs, &ground_filter(), &air_filters(&graphs), &params(), &ground_at(&graphs, START), &NavChunkRouteEnd::NONE, true, GOAL, &mut legs);
    assert!(r.at_edge, "the route reaches the edge: {}", describe(&legs));
    assert_eq!(r.status, NavPathStatus::Partial);
    assert_eq!(legs.last().unwrap().kind, K::Walk);
    assert!(legs.last().unwrap().end.x.abs() < 1e-3, "on A's face toward the goal: {}", describe(&legs));
}

#[test]
fn route_search_sliced_over_many_steps_finds_the_same_route() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, wall_a()), loaded(CHUNK_B, wall_b())], TYPE);
    let (whole_r, whole) = chunk_route(&graphs);

    let f = ground_filter();
    let airs = air_filters(&graphs);
    let (start, goal) = (ground_at(&graphs, START), ground_at(&graphs, GOAL));
    let mut store = SearchBufferStore::default();
    let mut search = NavRouteAStar::default();
    let mut sliced = Vec::new();
    for _round in 0..2 {
        // Twice: the second search reuses the buffers and key table (a new stamp).
        store.begin();
        assert!(route_search::begin(&mut search, &mut store, &f, &airs, &params(), &start, &goal, false, GOAL));
        let mut steps = 1;
        while !route_search::step(&mut search, &mut store, &graphs, &f, &airs, 1) {
            steps += 1;
        }
        let (status, at_edge) = route_search::finish(&search, &store, &graphs, &mut sliced);
        assert!(steps > 10, "many steps");
        assert_eq!(status, whole_r.status);
        assert!(!at_edge);
        assert_eq!(store.node_count(), whole_r.nodes, "the same search");
        assert_eq!(sliced, whole, "{} vs {}", describe(&whole), describe(&sliced));
    }
}

#[test]
fn hybrid_routes_dont_depend_on_load_order() {
    let (_, one) = graphs_of(&[loaded(CHUNK_A, wall_a()), loaded(CHUNK_B, wall_b())], TYPE);
    let (_, two) = graphs_of(&[loaded(CHUNK_B, wall_b()), loaded(CHUNK_A, wall_a())], TYPE);
    assert_eq!(one.signature, two.signature);
    assert_eq!(one.air_links, two.air_links);
    assert_eq!(one.air_frontier, two.air_frontier);
    let (r1, l1) = chunk_route(&one);
    let (r2, l2) = chunk_route(&two);
    assert_eq!((r1, &l1), (r2, &l2));
}

#[test]
fn out_of_flight_over_a_chunk_find_nearest_landing_lands_on_it() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, floor_a()), loaded(CHUNK_B, floor_b())], TYPE);
    let v = graphs.volume_of(CHUNK_B);
    let (leaf, air_pos) = snap_to_free(&graphs.volumes[v as usize].volume, Float3::new(20.0, 8.0, 0.0), 2.0);
    assert!(leaf >= 0, "setup: free air above B");
    let start = NavChunkRouteEnd { volume: v, leaf, air_pos, ..NavChunkRouteEnd::NONE };
    let mut legs = Vec::new();
    let status = find_chunk_nearest_landing(&graphs, &ground_filter(), &air_filters(&graphs), &params(), &start, &mut legs);
    assert_eq!(status, NavPathStatus::Partial);
    assert_eq!(kinds(&legs), vec![K::Fly, K::Walk], "{}", describe(&legs));
    expect(&legs[1], K::Walk, CHUNK_B);
    assert!(legs[1].end.y.abs() <= 0.3 && legs[1].end.x > 10.0, "on B's floor below: {}", describe(&legs));
}

#[test]
fn a_short_flight_within_one_chunk_is_walked_across_chunks_too() {
    // Floors across the face, a route that flies within A (cheap takeoffs), and a generous ratio: walked instead.
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, floor_a()), loaded(CHUNK_B, floor_b())], TYPE);
    let s = NavHybridParams { takeoff_cost: 0.0, landing_cost: 0.0, takeoff_height: 0.0, flight_cost_multiplier: 0.2, ..params() };
    let start = ground_at(&graphs, Float3::new(-35.0, 0.0, 10.0));
    let goal = ground_at(&graphs, Float3::new(-5.0, 0.0, -10.0));
    let mut legs = Vec::new();
    let r = find_chunk_route(&graphs, &ground_filter(), &air_filters(&graphs), &s, &start, &goal, false, goal.ground_pos, &mut legs);
    assert_eq!(r.status, NavPathStatus::Success);
    assert_eq!(kinds(&legs), vec![K::Walk, K::Fly, K::Walk], "flying is cheaper here: {}", describe(&legs));
    let mut walked = legs.clone();
    walk_short_chunk_flights(&graphs, &ground_filter(), 1.5, 2.0, &mut walked, -1);
    assert_eq!(kinds(&walked), vec![K::Walk], "the walk is about as long as the flight: {}", describe(&walked));
    let mut kept = legs.clone();
    walk_short_chunk_flights(&graphs, &ground_filter(), 0.0, 2.0, &mut kept, -1);
    assert_eq!(kept, legs, "a ratio of 0 is off");
}

#[test]
fn fly_only_settings_route_from_air_to_air_without_landing() {
    // An agent that walks and flies, routed as fly-only (air_only): no takeoffs or landings, flights across volumes.
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, wall_a()), loaded(CHUNK_B, wall_b())], TYPE);
    let snap = |chunk, p| {
        let v = graphs.volume_of(chunk);
        let (leaf, air_pos) = snap_to_free(&graphs.volumes[v as usize].volume, p, 2.0);
        NavChunkRouteEnd { volume: v, leaf, air_pos, ..NavChunkRouteEnd::NONE }
    };
    let start = snap(CHUNK_A, Float3::new(-30.0, 8.0, 2.0));
    let goal = snap(CHUNK_B, Float3::new(30.0, 8.0, -3.0));
    let s = NavHybridParams { air_only: true, ..params() };
    let mut legs = Vec::new();
    let r = find_chunk_route(&graphs, &NavMeshQueryFilter::zeroed(), &air_filters(&graphs), &s, &start, &goal, false, goal.air_pos, &mut legs);
    assert_eq!(r.status, NavPathStatus::Success, "{}", describe(&legs));
    assert_eq!(kinds(&legs), vec![K::Fly, K::Fly], "{}", describe(&legs));
    assert_eq!(legs[1].end, goal.air_pos);
}

#[test]
fn landing_links_under_an_overlay_move_onto_it_and_the_nearest_landing_uses_them() {
    // A's floor stops 3 m short of the face; B's reaches 6 m into A's box. A's overlay replaces its last tile
    // (x in [-8, 0]) and the landing links on it.
    let a = hybrid_bake(MIN_A, MAX_A, false, (-40.0, -16.0), (-3.0, 16.0));
    let b = hybrid_bake(MIN_B, MAX_B, false, (-6.0, -16.0), (40.0, 16.0));
    let (_, graphs, _) = graphs_with_overlays(&[loaded(CHUNK_A, &a), loaded(CHUNK_B, &b)], TYPE);

    assert!(!graphs.overlay_landings.is_empty(), "landing links on replaced polygons move onto the overlay");
    assert!(graphs.overlay_landings.iter().all(|l| graphs.graphs[l.graph as usize].overlay), "onto an overlay's polygon");

    // Above the replaced tile, out of flight: it comes down onto the overlay right there.
    let v = graphs.volume_of(CHUNK_A);
    let (leaf, air_pos) = snap_to_free(&graphs.volumes[v as usize].volume, Float3::new(-5.0, 8.0, 0.0), 2.0);
    assert!(leaf >= 0, "setup: free air above the tile");
    let start = NavChunkRouteEnd { volume: v, leaf, air_pos, ..NavChunkRouteEnd::NONE };
    let mut legs = Vec::new();
    let status = find_chunk_nearest_landing(&graphs, &ground_filter(), &air_filters(&graphs), &params(), &start, &mut legs);
    assert_eq!(status, NavPathStatus::Partial);
    let last = legs.last().unwrap();
    assert_eq!(last.kind, K::Walk, "{}", describe(&legs));
    assert!(last.overlay, "landed on the overlay: {}", describe(&legs));
    assert!(last.end.x > -8.0, "in the replaced tile: {}", describe(&legs));
}
