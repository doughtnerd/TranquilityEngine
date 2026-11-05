//! Walking routes across chunks and fly-only flight routes (W4b) on real Chunk Bounds bakes: the route-search parts
//! of Foxfire's `NavChunkRouteTests`, the fly-only search parts of `NavHybridChunkRouteTests`, the graph cache and
//! load-order independence.
mod w4b_common;

use nav_math::Float3;
use nav_query::chunks::LoadedChunk;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::hybrid::face_point;
use nav_query::pathfinding::NavPathStatus;
use nav_query::route_graph::{affected, build_route_graphs, loaded as chunk_loaded, RouteGraphCache, RouteGraphs};
use nav_query::route_search::NavRouteLegKind;
use nav_query::routing::*;
use nav_query::volume::{leaf_at, snap_to_free};
use std::sync::OnceLock;
use w4b_common::*;

const MIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_A: Float3 = Float3::new(0.0, 6.0, 16.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_B: Float3 = Float3::new(40.0, 6.0, 16.0);
const MIN_C: Float3 = Float3::new(40.0, -1.0, -16.0);
const MAX_C: Float3 = Float3::new(80.0, 6.0, 16.0);

fn bake_a() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| walk_bake(MIN_A, MAX_A, (-40.0, -16.0), (0.0, 16.0)))
}
fn bake_b() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| walk_bake(MIN_B, MAX_B, (0.0, -16.0), (40.0, 16.0)))
}
fn bake_c() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| walk_bake(MIN_C, MAX_C, (40.0, -16.0), (80.0, 16.0)))
}

fn filter() -> NavMeshQueryFilter<'static> {
    NavMeshQueryFilter::default_for(0.5)
}

/// `NavChunkRouteTests.Route`: from `START` to `goal`, both located on any graph within 2 m.
fn route(graphs: &RouteGraphs, goal: Float3) -> (NavPathStatus, Vec<NavChunkRouteLeg>) {
    let f = filter();
    let (sg, sp, s_pos) = locate(graphs, &f, START, 2.0, Float3::default()).expect("start not on any graph");
    let (gg, gp, g_pos) = locate(graphs, &f, goal, 2.0, Float3::default()).expect("goal not on any graph");
    let mut legs = Vec::new();
    let status = find_route(graphs, &f, sg, sp, s_pos, gg, gp, g_pos, &mut legs);
    (status, legs)
}

// ---------------------------------------------------------------- NavChunkRouteTests

#[test]
fn floor_across_the_face_routes_in_two_legs() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b())], TYPE);
    assert!(!graphs.links.is_empty(), "the seam joins the navmeshes");
    let (status, legs) = route(&graphs, GOAL);
    assert_eq!(status, NavPathStatus::Success);
    assert_eq!(legs.len(), 2, "one leg per chunk");
    assert_eq!(graphs.graphs[legs[0].graph as usize].chunk, CHUNK_A);
    assert_eq!(graphs.graphs[legs[1].graph as usize].chunk, CHUNK_B);
    assert!((legs[0].end.x - 0.0).abs() < 1e-3, "the first leg ends on the shared face: {}", legs[0].end.x);
    assert!(legs[0].exit_link >= 0, "and crosses by a seam link");
    assert!((legs[1].start.x - 0.0).abs() < 1e-3, "the second starts there");
    assert_eq!(legs[1].exit_link, -1, "the last leg ends at the goal");
    assert!((legs[1].end.x - GOAL.x).abs() < 1e-3);
    // The legs join: the exit link's A side ends the first, its B side starts the second.
    let link = graphs.links[legs[0].exit_link as usize];
    assert_eq!(legs[0].end, (link.a0 + link.a1) * 0.5);
    assert_eq!(legs[1].start, (link.b0 + link.b1) * 0.5);
    assert_eq!((legs[0].end_poly, legs[1].start_poly), (link.from_poly, link.to_poly));
}

#[test]
fn three_chunks_in_a_row_route_in_three_legs() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b()), loaded(CHUNK_C, bake_c())], TYPE);
    let goal = Float3::new(70.0, 0.0, 5.0);
    let (status, legs) = route(&graphs, goal);
    assert_eq!(status, NavPathStatus::Success);
    let chunks: Vec<_> = legs.iter().map(|l| graphs.graphs[l.graph as usize].chunk).collect();
    assert_eq!(chunks, vec![CHUNK_A, CHUNK_B, CHUNK_C]);
    assert!((legs[1].end.x - 40.0).abs() < 1e-3, "B's leg ends on B and C's face");
    assert_eq!(graphs.budget_scale(), 3);
}

#[test]
fn load_order_doesnt_change_the_graphs_or_the_route() {
    let (a, b, c) = (loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b()), loaded(CHUNK_C, bake_c()));
    let (_, one) = graphs_of(&[a.clone(), b.clone(), c.clone()], TYPE);
    let (_, two) = graphs_of(&[c, b, a], TYPE);
    assert_eq!(one.signature, two.signature);
    assert_eq!(one.links, two.links);
    assert_eq!(one.frontier, two.frontier);
    let goal = Float3::new(70.0, 0.0, 5.0);
    assert_eq!(route(&one, goal), route(&two, goal));
}

#[test]
fn goal_in_unloaded_space_routes_to_the_edge_nearest_it() {
    let (snap, graphs) = graphs_of(&[loaded(CHUNK_A, bake_a())], TYPE);
    assert!(!graphs.frontier.is_empty(), "A's faces open onto unloaded space");
    assert!(!chunk_loaded(&snap, TYPE, GOAL), "the goal is in unloaded space");

    let f = filter();
    let (sg, sp, s_pos) = locate(&graphs, &f, START, 2.0, Float3::default()).unwrap();
    let mut legs = Vec::new();
    let (status, at_edge) = find_route_to_edge(&graphs, &f, sg, sp, s_pos, GOAL, &mut legs);
    assert!(at_edge, "the route reaches the edge");
    assert_eq!(status, NavPathStatus::Partial);
    assert_eq!(legs.len(), 1, "one leg, on A");
    assert!((legs[0].end.x - 0.0).abs() < 1e-3, "it ends on the face toward the goal: {:?}", legs[0].end);
    assert!((legs[0].end.z - GOAL.z).abs() <= 3.0, "near the point of the face nearest the goal: {:?}", legs[0].end);
}

#[test]
fn waiting_at_the_edge_continues_when_the_next_chunk_loads() {
    // A alone: to the edge. With B loaded: through B to the goal.
    let (_, before) = graphs_of(&[loaded(CHUNK_A, bake_a())], TYPE);
    let f = filter();
    let (sg, sp, s_pos) = locate(&before, &f, START, 2.0, Float3::default()).unwrap();
    let mut legs = Vec::new();
    let (_, at_edge) = find_route_to_edge(&before, &f, sg, sp, s_pos, GOAL, &mut legs);
    assert!(at_edge);
    let edge = legs[0].end;

    let (_, after) = graphs_of(&[loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b())], TYPE);
    assert!(after.frontier.iter().all(|e| e.a.x != 0.0 || e.b.x != 0.0), "the shared face is no longer an opening");
    let (status, legs) = route(&after, GOAL);
    assert_eq!(status, NavPathStatus::Success, "to the goal now, not the edge");
    assert_eq!(legs.len(), 2);
    assert_eq!(after.graphs[legs[1].graph as usize].chunk, CHUNK_B);
    let mut stats = RouteStats::default();
    stats.edge_replan(edge, true, false, Float3::default(), RouteStats::near(legs[0].end, edge, 1.0), 1.0);
    assert_eq!((stats.counts[RouteStats::EDGE_REPLANS], stats.counts[RouteStats::DEAD_ENDS]), (1, 0), "through the opening it waited at");
}

#[test]
fn goal_off_the_navmesh_inside_a_loaded_chunk_is_no_edge_route() {
    // The floor covers half of A; the goal is in A's box, past it: loaded space, so an ordinary (partial) path.
    let a = walk_bake(MIN_A, MAX_A, (-40.0, -16.0), (-20.0, 16.0));
    let (snap, graphs) = graphs_of(&[loaded(CHUNK_A, &a)], TYPE);
    let goal = Float3::new(-5.0, 0.0, 0.0);
    assert!(chunk_loaded(&snap, TYPE, goal), "inside a loaded chunk: no route to the edge");
    assert!(locate(&graphs, &filter(), goal, 2.0, Float3::default()).is_none(), "and off every navmesh");
}

#[test]
fn route_through_one_graph_only_costs_more_or_fails() {
    let (_, graphs) = graphs_of(&[loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b())], TYPE);
    let f = filter();
    let (sg, sp, s_pos) = locate(&graphs, &f, START, 2.0, Float3::default()).unwrap();
    let (gg, gp, g_pos) = locate(&graphs, &f, GOAL, 2.0, Float3::default()).unwrap();
    let mut legs = Vec::new();
    let (through, cost) = find_route_on(&graphs, &f, sg, sp, s_pos, gg, gp, g_pos, &mut legs, -1);
    assert_eq!(through, NavPathStatus::Success);
    assert!(cost >= START.distance(GOAL) * 0.99 && cost < START.distance(GOAL) * 1.2, "about the straight line: {cost}");
    let (alone, stay) = find_route_on(&graphs, &f, sg, sp, s_pos, gg, gp, g_pos, &mut legs, sg);
    assert_eq!(alone, NavPathStatus::Partial, "B can't be reached without the seam");
    assert_eq!(stay, f32::MAX);
    assert_eq!(legs.len(), 1);
    let mut none = Vec::new();
    assert_eq!(find_route(&graphs, &f, sg, 1_000_000, s_pos, gg, gp, g_pos, &mut none), NavPathStatus::InvalidInput);
}

#[test]
fn a_load_elsewhere_leaves_routes_it_doesnt_touch() {
    // NavChunkRouteTests.ALoadElsewhere_LeavesRoutesItDoesntTouch, on the cache: a route A to B planned on version 1.
    let (a, b) = (loaded(CHUNK_A, bake_a()), loaded(CHUNK_B, bake_b()));
    let mut cache = RouteGraphCache::default();
    let snap = snapshot(&[a.clone(), b.clone()]);
    let seams = seams_of(&snap);
    assert!(cache.stale(&snap, &seams, &[]));
    cache.rebuild(&snap, &seams, &[]);
    assert!(!cache.stale(&snap, &seams, &[]));
    assert_eq!(cache.version, 1);
    assert!(cache.get(TYPE).is_some(), "two navmeshes: graphs");
    let planned = cache.version;
    let legs = [CHUNK_A, CHUNK_B];

    // C loads far from both: rebuilt, but nothing on this route changed.
    let far = walk_bake(Float3::new(200.0, -1.0, -16.0), Float3::new(240.0, 6.0, 16.0), (200.0, -16.0), (240.0, 16.0));
    let snap = snapshot(&[a.clone(), b.clone(), loaded(CHUNK_C, &far)]);
    let seams = seams_of(&snap);
    assert!(cache.stale(&snap, &seams, &[]));
    cache.rebuild(&snap, &seams, &[]);
    assert_eq!(cache.changed, vec![CHUNK_C]);
    assert!(!affected(planned, cache.version, false, false, CHUNK_A, &legs, &cache.changed, &cache.changed_seams), "not planned again");
    let planned = cache.version;

    // B rebaked with something new on it: the route goes through B, so it's planned again. (An identical rebake is
    // no change here: prints are content hashes, not blob pointers.)
    let mut b2 = TestBake::new(Some(flat_profile()));
    b2.add_floor((0.0, -16.0), (40.0, 16.0), 0.0, &[]);
    b2.add_obstacle(v3(20.0, 1.0, 10.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    b2.set_chunk_bounds(MIN_B, MAX_B, 1, 2);
    b2.bake();
    let snap = snapshot(&[a, loaded(CHUNK_B, &b2), loaded(CHUNK_C, &far)]);
    let seams = seams_of(&snap);
    cache.rebuild(&snap, &seams, &[]);
    assert!(cache.changed.contains(&CHUNK_B));
    assert!(affected(planned, cache.version, false, false, CHUNK_A, &legs, &cache.changed, &cache.changed_seams), "planned again");
}

#[test]
fn one_lone_navmesh_needs_no_graphs() {
    // An unbounded chunk: one navmesh and nothing unloaded around it (no seam edges, so no frontier).
    let mut lone = TestBake::new(Some(flat_profile()));
    lone.add_floor((-10.0, -10.0), (10.0, 10.0), 0.0, &[]);
    lone.bake();
    let snap = snapshot(&[loaded(CHUNK_A, &lone)]);
    let graphs = build_route_graphs(&snap, TYPE, &[], &[]);
    assert_eq!(graphs.graphs.len(), 1);
    assert!(!graphs.needed());
    let mut cache = RouteGraphCache::default();
    cache.rebuild(&snap, &[], &[]);
    assert!(cache.types().is_empty() && cache.get(TYPE).is_none());
    assert!(cache.describe("test").contains("No agent type"));
}

// ---------------------------------------------------------------- fly-only routes (NavHybridChunkRouteTests, M4.5)

const MIN_FA: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_FA: Float3 = Float3::new(0.0, 16.0, 16.0);
const MIN_FB: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_FB: Float3 = Float3::new(40.0, 16.0, 16.0);
const AIR_START: Float3 = Float3::new(-30.0, 5.0, 2.0);
const AIR_GOAL: Float3 = Float3::new(30.0, 5.0, -3.0);

fn flyer_a() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| flyer_bake(MIN_FA, MAX_FA))
}
fn flyer_b() -> &'static TestBake {
    static B: OnceLock<TestBake> = OnceLock::new();
    B.get_or_init(|| flyer_bake(MIN_FB, MAX_FB))
}

/// A fly-only bake has no chunk border, but its chunk info says it is bounded, so `loaded` is enough.
fn fly_a() -> LoadedChunk {
    loaded(CHUNK_A, flyer_a())
}
fn fly_b() -> LoadedChunk {
    loaded(CHUNK_B, flyer_b())
}

#[test]
fn fly_only_flies_from_as_volume_into_bs() {
    let (snap, graphs) = graphs_of(&[fly_a(), fly_b()], FLYER);
    assert_eq!(graphs.graphs.len(), 0, "fly-only: no navmeshes");
    assert_eq!(graphs.volumes.len(), 2);
    assert!(!graphs.air_links.is_empty(), "the volumes join across the face");

    let route = find_flight_route(&graphs, &snap, &air_filters(&graphs), CHUNK_A, AIR_START, AIR_GOAL, 2.0, 10_000).expect("a route");
    assert_eq!(route.status, NavPathStatus::Success, "{}", describe(&route.legs));
    assert_eq!(route.legs.len(), 2, "a flight in A, a flight in B: {}", describe(&route.legs));
    assert!(route.legs.iter().all(|l| l.kind == NavRouteLegKind::Fly));
    assert_eq!((route.legs[0].chunk, route.legs[1].chunk), (CHUNK_A, CHUNK_B));
    assert!((route.legs[0].end.x - 0.0).abs() < 1e-3, "the flight crosses on the face");
    assert!(route.leads_anywhere());
    let chunk_legs = route.chunk_legs();
    assert_eq!(chunk_legs[0].exit_a.x, 0.0, "the first leg leaves by a face rectangle");
    assert_eq!(chunk_legs[1].end, route.legs[1].end);
    assert!(route.nodes <= (10_000 * graphs.budget_scale()) as usize);
}

#[test]
fn fly_only_goal_in_its_own_volume_is_an_ordinary_flight() {
    let (snap, graphs) = graphs_of(&[fly_a(), fly_b()], FLYER);
    let ends = locate_flight_route(&graphs, &snap, CHUNK_A, AIR_START, Float3::new(-10.0, 5.0, 0.0), 2.0);
    assert_eq!(ends, FlightRouteEnds::Ordinary { start_chunk: CHUNK_A, goal_placed: true });
    assert!(find_flight_route(&graphs, &snap, &air_filters(&graphs), CHUNK_A, AIR_START, Float3::new(-10.0, 5.0, 0.0), 2.0, 10_000).is_none());
    // Its chunk has no volume here: nothing to route.
    assert_eq!(locate_flight_route(&graphs, &snap, CHUNK_C, AIR_START, AIR_GOAL, 2.0), FlightRouteEnds::Nowhere);
}

#[test]
fn fly_only_agent_out_of_its_chunks_volume_takes_the_chunk_its_in() {
    // FlyOnlyAgent_OutOfItsChunksVolume_TakesTheChunkItsIn_AndRoutesFromThere: in B's air but still on A.
    let (snap, graphs) = graphs_of(&[fly_a(), fly_b()], FLYER);
    let in_b = Float3::new(10.0, 5.0, 0.0);
    match locate_flight_route(&graphs, &snap, CHUNK_A, in_b, AIR_START, 2.0) {
        FlightRouteEnds::Route { start, start_chunk, to_edge, .. } => {
            assert_eq!(start_chunk, CHUNK_B, "it takes B, the chunk of the volume it's in");
            assert_eq!(start.volume, graphs.volume_of(CHUNK_B));
            assert!(!to_edge);
        }
        other => panic!("expected a route from B back to A: {other:?}"),
    }
}

#[test]
fn fly_only_agent_with_the_goal_in_unloaded_space_routes_to_the_edge() {
    let (snap, graphs) = graphs_of(&[fly_a()], FLYER);
    assert!(!graphs.air_frontier.is_empty(), "A's faces open onto unloaded space");
    assert!(graphs.air_frontier.iter().all(|f| f.span >= 0));
    let route = find_flight_route(&graphs, &snap, &air_filters(&graphs), CHUNK_A, AIR_START, AIR_GOAL, 2.0, 10_000).expect("a route");
    assert!(route.to_edge && route.at_edge, "{:?} {}", route.status, describe(&route.legs));
    assert_eq!(route.status, NavPathStatus::Partial);
    let last = route.legs.last().unwrap();
    assert!((last.end.x - 0.0).abs() < 1e-3, "on A's face toward the goal: {:?}", last.end);
    assert!(route.leads_anywhere(), "to the edge: worth following even as one leg");

    // B loads: the same request is a route through B to the goal.
    let (snap, graphs) = graphs_of(&[fly_a(), fly_b()], FLYER);
    let route = find_flight_route(&graphs, &snap, &air_filters(&graphs), CHUNK_A, AIR_START, AIR_GOAL, 2.0, 10_000).unwrap();
    assert!(!route.to_edge && route.status == NavPathStatus::Success);
}

#[test]
fn fly_only_routes_dont_depend_on_load_order() {
    let (snap1, g1) = graphs_of(&[fly_a(), fly_b()], FLYER);
    let (snap2, g2) = graphs_of(&[fly_b(), fly_a()], FLYER);
    assert_eq!(g1.air_links, g2.air_links);
    let r1 = find_flight_route(&g1, &snap1, &air_filters(&g1), CHUNK_A, AIR_START, AIR_GOAL, 2.0, 10_000).unwrap();
    let r2 = find_flight_route(&g2, &snap2, &air_filters(&g2), CHUNK_A, AIR_START, AIR_GOAL, 2.0, 10_000).unwrap();
    assert_eq!(r1, r2);
}

#[test]
fn face_point_is_nudged_off_the_face_into_the_flyers_volume() {
    let a = flyer_a();
    // A seam rectangle on A's high x face (x = 0), y 2..10, z -8..8; the flyer is in A (x < 0).
    let lo = Float3::new(0.0, 2.0, -8.0);
    let hi = Float3::new(0.0, 10.0, 8.0);
    let point = face_point(lo, hi, Float3::new(-20.0, 5.0, 3.0), 1.0, Float3::default());
    assert!(point.x < 0.0, "off the face, on A's side");
    assert!(point.x > -0.5, "only just");
    assert!((point.y - 5.0).abs() < 1e-4 && (point.z - 3.0).abs() < 1e-4);
    let (leaf, snapped) = snap_to_free(a.volume(), point, 10.0);
    assert!(leaf >= 0, "setup: free air at the face");
    assert_eq!(point, snapped, "the point is inside A's volume");
    assert_eq!(leaf_at(a.volume(), point), leaf);
    assert_eq!(face_point(lo, lo, point, 1.0, Float3::splat(7.0)), Float3::splat(7.0), "unset rectangle: the fallback");
}

// ---------------------------------------------------------------- overlays (NavChunkRouteTests, M4.1)

/// A's floor stops 3 m short of the face; B's reaches 6 m into A's box (`NavOverlayTests`' transition geometry).
fn transition() -> (LoadedChunk, LoadedChunk) {
    static A: OnceLock<TestBake> = OnceLock::new();
    static B: OnceLock<TestBake> = OnceLock::new();
    let a = A.get_or_init(|| walk_bake(MIN_A, MAX_A, (-40.0, -16.0), (-3.0, 16.0)));
    let b = B.get_or_init(|| walk_bake(MIN_B, MAX_B, (-6.0, -16.0), (40.0, 16.0)));
    (loaded(CHUNK_A, a), loaded(CHUNK_B, b))
}

#[test]
fn transition_geometry_overlays_make_the_route() {
    let (a, b) = transition();

    // Without overlays: A's own navmesh never reaches the face, so the route ends at A's edge.
    let (_, before) = graphs_of(&[a.clone(), b.clone()], TYPE);
    let (status, partial) = route(&before, GOAL);
    assert_eq!(status, NavPathStatus::Partial, "no way across without overlays");
    assert_eq!(before.graphs[partial.last().unwrap().graph as usize].chunk, CHUNK_A, "it ends in A");

    let (_, graphs, _) = graphs_with_overlays(&[a, b], TYPE);
    assert_eq!(graphs.graphs.len(), 4, "two chunks, two overlays");
    let (status, legs) = route(&graphs, GOAL);
    assert_eq!(status, NavPathStatus::Success);
    let on: Vec<_> = legs.iter().map(|l| (graphs.graphs[l.graph as usize].chunk, graphs.graphs[l.graph as usize].overlay)).collect();
    assert_eq!(on, vec![(CHUNK_A, false), (CHUNK_A, true), (CHUNK_B, true), (CHUNK_B, false)], "A, A's overlay, B's overlay, B");
    assert!(legs[1].end.x.abs() < 1e-3, "A's overlay reaches the face: {:?}", legs[1].end);
}

#[test]
fn point_on_a_replaced_tile_locates_on_the_overlay() {
    let (a, b) = transition();
    let (_, graphs, _) = graphs_with_overlays(&[a, b], TYPE);
    // x = -5 is on A's own floor, but in its last tile (x in [-8, 0]), which A's overlay replaces.
    let (graph, _, _) = locate(&graphs, &filter(), Float3::new(-5.0, 0.0, 0.0), 2.0, Float3::default()).expect("nothing found");
    assert!(graphs.graphs[graph as usize].overlay, "the replaced polygon is switched off; the overlay's is used");
    assert_eq!(graphs.graphs[graph as usize].chunk, CHUNK_A);
    let own = graphs.graph_of(CHUNK_A, false);
    assert!(graphs.graphs[own as usize].switched_off_count > 0, "A's graph has switched-off polygons");
    assert!(graphs.switched_off.iter().any(|&s| s));
}
