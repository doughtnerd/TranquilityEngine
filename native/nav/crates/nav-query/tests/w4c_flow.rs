//! Flow fields on baked scenes: ports of the pure cases of Foxfire's `NavFlowFieldTests` (the field build against A*
//! paths, sliced against whole, across a chunk seam, joining a walk to a slot), plus what the Rust port runs without an
//! ECS around it: the incremental builders, rebuilds when the goal moves, eviction under a memory cap, determinism.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_format::{NavChunkFace, NavMeshData};
use nav_math::{Float3, Hash128};
use nav_query::chunks::{LoadedChunk, NavChunks};
use nav_query::filter::NavMeshQueryFilter;
use nav_query::flow::{self, *};
use nav_query::pathfinding::{find_nearest_poly, find_path, NavMeshPathNode, NavPathStatus};
use nav_query::straight_path::{straighten, NavMeshWaypoint};
use nav_query::surface::closest_point_on_poly;
use std::sync::{Arc, OnceLock};

const TYPE: Hash128 = Hash128 { x: 1, y: 0, z: 0, w: 0 }; // `flat_profile`'s id
const GOAL_POS: (f32, f32, f32) = (12.0, 0.0, 12.0);
const NO_EXITS: &[FlowExit] = &[];

fn goal() -> Float3 {
    v3(GOAL_POS.0, GOAL_POS.1, GOAL_POS.2)
}

fn agent() -> FlowAgent {
    FlowAgent::new(NavMeshQueryFilter::default_for(0.5), 0.5)
}

fn filter() -> NavMeshQueryFilter<'static> {
    NavMeshQueryFilter::default_for(0.5)
}

/// `BakeMaze`: a floor with a wall to go round (a gap at its south end) and a block in the east.
fn maze() -> &'static TestBake {
    static MAZE: OnceLock<TestBake> = OnceLock::new();
    MAZE.get_or_init(|| {
        let mut bake = TestBake::new(Some(flat_profile()));
        bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
        bake.add_obstacle(v3(0.0, 1.0, 3.0), v3(2.0, 2.0, 34.0), Rot::IDENTITY); // z -14 .. 20
        bake.add_obstacle(v3(9.0, 1.0, 2.0), v3(6.0, 2.0, 4.0), Rot::IDENTITY);
        bake.bake();
        bake
    })
}

fn one_graph(nav: &NavMeshData) -> FlowSnapshot {
    FlowSnapshot { graphs: vec![FlowGraph::new(Arc::new(nav.clone()), Hash128::default(), false)], ..FlowSnapshot::default() }
}

fn maze_snapshot() -> FlowSnapshot {
    one_graph(maze().nav())
}

fn build_maze(goal: Float3, slice: i32) -> (FlowSnapshot, FlowBuildState, Vec<FlowCell>) {
    let snap = maze_snapshot();
    let (state, cells) = build(&agent(), &snap, goal, slice);
    (snap, state, cells)
}

fn nearest(nav: &NavMeshData, p: Float3) -> (i32, Float3) {
    find_nearest_poly(nav, p, 2.0, &filter()).expect("on the navmesh")
}

fn walk_from(snap: &FlowSnapshot, cells: &[FlowCell], from: Float3, stop: i32, goal: Float3) -> (FlowWalkEnd, i32, Vec<NavMeshPathNode>) {
    let nav = &*snap.graphs[0].nav;
    let (poly, pos) = nearest(nav, from);
    let mut corridor = Vec::new();
    let (end, exit) = walk(nav, cells, &snap.exits, goal, &filter(), poly, pos, stop, 1000, &mut corridor, None);
    (end, exit, corridor)
}

fn length(nav: &NavMeshData, corridor: &[NavMeshPathNode], start: Float3, goal: Float3) -> f32 {
    let mut waypoints: Vec<NavMeshWaypoint> = Vec::new();
    straighten(nav, corridor, start, goal, &mut waypoints);
    waypoints.windows(2).map(|w| w[0].position.distance(w[1].position)).sum()
}

// ---------------------------------------------------------------- the build

#[test]
fn field_directions_agree_with_astar_paths() {
    let (snap, state, cells) = build_maze(goal(), i32::MAX);
    let nav = &*snap.graphs[0].nav;
    assert!(state.goal_poly >= 0, "the goal is on the navmesh");
    let (goal_poly, goal_pos) = nearest(nav, goal());
    assert_eq!(goal_poly, state.goal_poly);

    for from in [v3(-12.0, 0.0, 12.0), v3(-15.0, 0.0, -17.0), v3(16.0, 0.0, -12.0), v3(-5.0, 0.0, 18.0), v3(9.0, 0.0, -3.0)] {
        let (start_poly, start_pos) = nearest(nav, from);
        let mut corridor = Vec::new();
        let (end, _) = walk(nav, &cells, NO_EXITS, goal(), &filter(), start_poly, start_pos, goal_poly, 1000, &mut corridor, None);
        assert_eq!(end, FlowWalkEnd::Goal, "from {from:?} the field leads to the goal");
        let mut astar = Vec::new();
        let status = find_path(nav, start_poly, start_pos, goal_poly, goal_pos, &filter(), &mut astar);
        assert_eq!(status, NavPathStatus::Success);

        let field = length(nav, &corridor, start_pos, goal_pos);
        let searched = length(nav, &astar, start_pos, goal_pos);
        assert!(field <= searched * 1.1 + 1.0, "from {from:?}: the field's way ({field:.1} m) is about as short as A*'s ({searched:.1} m)");
    }
}

#[test]
fn field_costs_match_astar_path_lengths() {
    let (snap, _, cells) = build_maze(goal(), i32::MAX);
    let nav = &*snap.graphs[0].nav;
    let (goal_poly, goal_pos) = nearest(nav, goal());
    for from in [v3(-12.0, 0.0, 12.0), v3(-15.0, 0.0, -17.0), v3(16.0, 0.0, -12.0), v3(9.0, 0.0, -3.0)] {
        let (poly, pos) = nearest(nav, from);
        let mut astar = Vec::new();
        assert_eq!(find_path(nav, poly, pos, goal_poly, goal_pos, &filter(), &mut astar), NavPathStatus::Success);
        let searched = length(nav, &astar, pos, goal_pos);
        // What a walker standing at pos pays: across its polygon to where the field leaves it, then the field's cost.
        let cell = cells[poly as usize];
        let estimate = pos.distance(flow::leaves(nav, &cells, NO_EXITS, goal(), poly)) + cell.cost;
        assert!(estimate >= searched - 0.5, "from {from:?}: the field's cost ({estimate:.1}) is no shorter than the straight way ({searched:.1})");
        assert!(estimate <= searched * 1.3 + 2.0, "from {from:?}: the field's cost ({estimate:.1}) is about A*'s length ({searched:.1})");
    }
}

#[test]
fn every_reachable_polygon_leads_to_the_goal() {
    let (snap, _, cells) = build_maze(goal(), i32::MAX);
    let nav = &*snap.graphs[0].nav;
    let (goal_poly, goal_pos) = nearest(nav, goal());
    let mut reached = 0;
    for p in 0..nav.polys.len() as i32 {
        if cells[p as usize].next == UNREACHED {
            continue;
        }
        let mut corridor = Vec::new();
        let (end, _) = walk(nav, &cells, NO_EXITS, goal(), &filter(), p, nav.polys[p as usize].center, -1, nav.polys.len() as i32, &mut corridor, None);
        if end == FlowWalkEnd::Nearest {
            // Stopping short only where the goal really can't be reached.
            let mut astar = Vec::new();
            let status = find_path(nav, p, nav.polys[p as usize].center, goal_poly, goal_pos, &filter(), &mut astar);
            assert_ne!(status, NavPathStatus::Success, "polygon {p} stops short, but A* reaches the goal");
            continue;
        }
        reached += 1;
        assert_eq!(end, FlowWalkEnd::FieldGoal, "polygon {p} leads to the goal's polygon");
        // After the first step (chosen for where the agent stands), costs only fall.
        for i in 2..corridor.len() {
            assert!(cells[corridor[i].poly as usize].cost < cells[corridor[i - 1].poly as usize].cost + 1e-3, "costs fall along the way");
        }
    }
    assert!(reached > nav.polys.len() / 2, "most of the floor reaches the goal");
}

#[test]
fn field_around_an_obstacle_points_every_polygon_clear_of_it() {
    // The wall (x in -1..1, z -14..20) sits between the two halves; the goal is east of it.
    let (snap, _, cells) = build_maze(goal(), i32::MAX);
    let nav = &*snap.graphs[0].nav;
    for from in [v3(-12.0, 0.0, 12.0), v3(-6.0, 0.0, 0.0)] {
        let (_, _, corridor) = walk_from(&snap, &cells, from, -1, goal());
        let (_, start) = nearest(nav, from);
        let (_, goal_pos) = nearest(nav, goal());
        let mut waypoints: Vec<NavMeshWaypoint> = Vec::new();
        straighten(nav, &corridor, start, goal_pos, &mut waypoints);
        assert!(waypoints.iter().any(|w| w.position.z < -13.0), "from {from:?} the way goes round the wall's south end");
        for w in &waypoints {
            assert!(!(w.position.x.abs() < 1.0 && w.position.z > -14.0), "waypoint {:?} is not inside the wall", w.position);
        }
    }
}

#[test]
fn floor_without_obstacles_points_every_polygon_toward_the_goal() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.bake();
    let snap = one_graph(bake.nav());
    let nav = &*snap.graphs[0].nav;
    let target = v3(15.0, 0.0, 15.0);
    let (_, cells) = build(&agent(), &snap, target, i32::MAX);
    for p in 0..nav.polys.len() as i32 {
        let cell = cells[p as usize];
        assert!(cell.next != UNREACHED && cell.next != NEAREST, "polygon {p} reaches the goal");
        if cell.next == GOAL {
            assert_eq!(cell.cost, 0.0);
            continue;
        }
        // Each polygon's portal leads into a polygon nearer the goal by the field's own measure.
        assert!(cell.next >= 0, "polygon {p} leaves by a link");
        let to = nav.links[cell.next as usize].to_poly;
        assert!(cells[to as usize].cost <= cell.cost + 1e-3, "polygon {p} points toward the goal");
        assert!(cell.cost > 0.0);
        let mut corridor = Vec::new();
        let (end, _) = walk(nav, &cells, NO_EXITS, target, &filter(), p, nav.polys[p as usize].center, -1, 1000, &mut corridor, None);
        assert_eq!(end, FlowWalkEnd::FieldGoal, "polygon {p} leads to the goal's polygon");
    }
}

#[test]
fn goal_walkers_cant_reach_field_leads_to_the_nearest_point_they_can() {
    // A block 3 m tall with a walkable top: the agent steps 0.5 m and can't jump, so its top is an island.
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(10.0, 1.5, 10.0), v3(6.0, 3.0, 6.0), Rot::IDENTITY);
    bake.bake();
    let snap = one_graph(bake.nav());
    let nav = &*snap.graphs[0].nav;
    let top = v3(10.0, 3.0, 10.0);
    let (state, cells) = build(&agent(), &snap, top, i32::MAX);
    assert!(state.goal_poly >= 0, "setup: the goal is on the block's top");
    assert!(nav.polys[state.goal_poly as usize].center.y > 2.0, "setup: up there, not on the floor");

    let (poly, pos) = nearest(nav, v3(-15.0, 0.0, -15.0));
    let mut corridor = Vec::new();
    let (end, _) = walk(nav, &cells, NO_EXITS, top, &filter(), poly, pos, -1, 1000, &mut corridor, None);
    assert_eq!(end, FlowWalkEnd::Nearest, "the floor leads as near as it gets, not nowhere");
    let last = corridor.last().unwrap().poly;
    let near = closest_point_on_poly(nav, last, top).0;
    assert!(near.y < 1.0, "on the floor");
    assert!(near.xz().distance(top.xz()) <= 5.0, "beside the block (half its width, the radius and a cell)");
}

#[test]
fn goal_on_no_loaded_navmesh_field_leads_to_the_nearest_point() {
    // A goal in a chunk that isn't loaded yet: 40 m east of where this floor ends.
    let away = v3(60.0, 0.0, 2.0);
    let (snap, state, cells) = build_maze(away, i32::MAX);
    assert_eq!(state.goal_poly, -1, "setup: the goal is on no navmesh");
    let (end, _, corridor) = walk_from(&snap, &cells, v3(-12.0, 0.0, 12.0), -1, away);
    assert_eq!(end, FlowWalkEnd::Nearest, "it still leads somewhere");
    let near = closest_point_on_poly(&snap.graphs[0].nav, corridor.last().unwrap().poly, away).0;
    assert!(near.x > 18.0, "to the floor's east edge, nearest the goal");
}

#[test]
fn unusable_polygons_are_marked_unreached_and_cut_off_regions_stop_short() {
    // A strip with a gate across its middle.
    let build_strip = |open: bool| {
        let mut bake = TestBake::new(Some(flat_profile()));
        bake.add_floor((-20.0, -5.0), (20.0, 5.0), 0.0, &[]);
        bake.add_gate(v3(0.0, 1.0, 0.0), v3(2.0, 2.0, 10.0), open);
        bake.bake();
        bake
    };
    let target = v3(12.0, 0.0, 0.0);
    for open in [true, false] {
        let bake = build_strip(open);
        let mut snap = one_graph(bake.nav());
        let closed = bake.closed_gates().to_vec();
        assert_eq!(closed.iter().any(|&c| c), !open, "setup: the gate starts {}", if open { "open" } else { "closed" });
        snap.gates = closed.clone();
        snap.graphs[0].gate_count = closed.len();
        let nav = bake.nav();
        let (state, cells) = build(&agent(), &snap, target, i32::MAX);
        assert!(state.goal_poly >= 0);
        let unreached = cells.iter().filter(|c| c.next == UNREACHED).count();
        let gate_polys = nav.polys.iter().filter(|p| p.gate > 0).count();
        assert!(gate_polys > 0, "setup: the gate has polygons");
        let (poly, pos) = nearest(nav, v3(-12.0, 0.0, 0.0));
        let mut corridor = Vec::new();
        let (end, _) = walk(nav, &cells, NO_EXITS, target, &filter_with_gates(&closed), poly, pos, -1, 1000, &mut corridor, None);
        if open {
            assert_eq!(unreached, 0, "nothing is unusable with the gate open");
            assert_eq!(end, FlowWalkEnd::FieldGoal);
        } else {
            assert_eq!(unreached, gate_polys, "exactly the closed gate's polygons");
            assert_eq!(end, FlowWalkEnd::Nearest, "the far side stops at the gate");
            let last = corridor.last().unwrap().poly;
            assert!(closest_point_on_poly(nav, last, target).0.x < 0.0, "on the near side");
            // The goal's own side still reaches it.
            let (east_poly, east_pos) = nearest(nav, v3(6.0, 0.0, 0.0));
            let (end, _) = walk(nav, &cells, NO_EXITS, target, &filter_with_gates(&closed), east_poly, east_pos, -1, 1000, &mut corridor, None);
            assert_eq!(end, FlowWalkEnd::FieldGoal);
        }
    }
}

fn filter_with_gates(closed: &[bool]) -> NavMeshQueryFilter<'_> {
    NavMeshQueryFilter { closed_gates: Some(closed), ..NavMeshQueryFilter::default_for(0.5) }
}

#[test]
fn sliced_build_is_the_same_as_whole() {
    let (_, whole_state, whole) = build_maze(goal(), i32::MAX);
    for slice in [1, 3, 17, 4096] {
        let (_, state, sliced) = build_maze(goal(), slice);
        assert_eq!(whole.len(), sliced.len());
        for p in 0..whole.len() {
            assert_eq!(whole[p].next, sliced[p].next, "slice {slice}: polygon {p}'s portal");
            assert_eq!(whole[p].cost.to_bits(), sliced[p].cost.to_bits(), "slice {slice}: polygon {p}'s cost");
        }
        assert_eq!(state.settled, whole_state.settled);
    }
}

#[test]
fn builds_are_deterministic() {
    let (_, _, a) = build_maze(goal(), 5);
    let (_, _, b) = build_maze(goal(), i32::MAX);
    let (_, _, c) = build_maze(goal(), 5);
    let bits = |v: &[FlowCell]| v.iter().map(|c| (c.next, c.cost.to_bits())).collect::<Vec<_>>();
    assert_eq!(bits(&a), bits(&b));
    assert_eq!(bits(&a), bits(&c));
}

// ---------------------------------------------------------------- across a seam

const MIN_A: (f32, f32, f32) = (-40.0, -1.0, -16.0);
const MAX_A: (f32, f32, f32) = (0.0, 6.0, 16.0);
const MIN_B: (f32, f32, f32) = (0.0, -1.0, -16.0);
const MAX_B: (f32, f32, f32) = (40.0, 6.0, 16.0);

fn chunk_id(n: u32) -> Hash128 {
    Hash128::new(n, 10, 0, 0)
}

fn bake_chunk(min: (f32, f32, f32), max: (f32, f32, f32)) -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((min.0, min.2), (max.0, max.2), 0.0, &[]);
    bake.set_chunk_bounds(v3(min.0, min.1, min.2), v3(max.0, max.1, max.2), 1, 2);
    bake.bake();
    bake
}

/// The seams between two chunks side by side (A's east face, B's west face): a link each way for every pair of seam
/// edges that overlap along z (what the seam and route-graph systems make, in the one case the tests need).
fn seams_between(a: &TestBake, b: &TestBake) -> Vec<FlowSeam> {
    let mut links = Vec::new();
    let at = |e: &nav_format::NavSeamEdge, z: f32| {
        let t = (z - e.a.z) / (e.b.z - e.a.z);
        e.a.lerp(e.b, t)
    };
    for ea in a.nav().seam_edges.iter().filter(|e| e.face == NavChunkFace::X_MAX) {
        for eb in b.nav().seam_edges.iter().filter(|e| e.face == NavChunkFace::X_MIN) {
            let (a_lo, a_hi) = (ea.a.z.min(ea.b.z), ea.a.z.max(ea.b.z));
            let (b_lo, b_hi) = (eb.a.z.min(eb.b.z), eb.a.z.max(eb.b.z));
            let (lo, hi) = (a_lo.max(b_lo), a_hi.min(b_hi));
            if hi - lo < 0.05 || ea.a.z == ea.b.z || eb.a.z == eb.b.z {
                continue;
            }
            let (pa0, pa1, pb0, pb1) = (at(ea, lo), at(ea, hi), at(eb, lo), at(eb, hi));
            links.push(FlowSeam { from_chunk: chunk_id(1), to_chunk: chunk_id(2), from_poly: ea.poly, to_poly: eb.poly, a0: pa0, a1: pa1, b0: pb0, b1: pb1, ..FlowSeam::default() });
            links.push(FlowSeam { from_chunk: chunk_id(2), to_chunk: chunk_id(1), from_poly: eb.poly, to_poly: ea.poly, a0: pb0, a1: pb1, b0: pa0, b1: pa1, ..FlowSeam::default() });
        }
    }
    links
}

fn two_chunks() -> (TestBake, TestBake, NavChunks, Vec<FlowSeam>) {
    let a = bake_chunk(MIN_A, MAX_A);
    let b = bake_chunk(MIN_B, MAX_B);
    let load = |id: Hash128, bake: &TestBake| LoadedChunk::new(id, Arc::new(bake.out.file.clone()));
    let chunks = NavChunks::gather(&[load(chunk_id(1), &a), load(chunk_id(2), &b)], &|_| None, &[]);
    let seams = seams_between(&a, &b);
    (a, b, chunks, seams)
}

#[test]
fn across_a_seam_the_field_leads_into_the_goals_chunk() {
    let (_a, _b, chunks, seams) = two_chunks();
    assert!(!seams.is_empty(), "setup: the seam joins the chunks");
    let snap = FlowSnapshot::from_chunks(&chunks, TYPE, &seams);
    assert_eq!(snap.graphs.len(), 2);
    assert_eq!(snap.exits.len(), seams.len());

    let target = v3(30.0, 0.0, -3.0);
    let (state, cells) = build(&agent(), &snap, target, i32::MAX);
    let goal_graph = snap.find_graph(chunk_id(2), false).unwrap();
    assert_eq!(state.goal_graph, goal_graph as i32, "the goal is in B");

    // From A: the field leads to a seam exit into B, then on to the goal.
    let a_graph = snap.find_graph(chunk_id(1), false).unwrap();
    let nav_a = &*snap.graphs[a_graph].nav;
    let (start_poly, start_pos) = nearest(nav_a, v3(-30.0, 0.0, 2.0));
    let a_cells = &cells[snap.graphs[a_graph].start..snap.graphs[a_graph].start + snap.graphs[a_graph].count];
    let mut corridor = Vec::new();
    let (end, exit) = walk(nav_a, a_cells, &snap.exits, target, &filter(), start_poly, start_pos, -1, 1000, &mut corridor, None);
    assert_eq!(end, FlowWalkEnd::Exit, "A's field leads to the seam");
    let x = snap.exits[exit as usize];
    assert_eq!(x.to_graph as usize, goal_graph, "into B");
    assert!((0.5 * (x.a0.x + x.a1.x)).abs() < 1e-2, "on the shared face");

    let nav_b = &*snap.graphs[goal_graph].nav;
    let b_cells = &cells[snap.graphs[goal_graph].start..snap.graphs[goal_graph].start + snap.graphs[goal_graph].count];
    let (end, _) = walk(nav_b, b_cells, &snap.exits, target, &filter(), x.to_poly, (x.b0 + x.b1) * 0.5, state.goal_poly, 1000, &mut corridor, None);
    assert_eq!(end, FlowWalkEnd::Goal, "and B's on to the goal");
}

#[test]
fn a_walker_on_a_seam_may_step_across_it_when_that_is_cheaper() {
    let (_a, _b, chunks, seams) = two_chunks();
    let snap = FlowSnapshot::from_chunks(&chunks, TYPE, &seams);
    let target = v3(30.0, 0.0, -3.0);
    let (_, cells) = build(&agent(), &snap, target, i32::MAX);
    let a_graph = snap.find_graph(chunk_id(1), false).unwrap();
    let nav_a = &*snap.graphs[a_graph].nav;
    let loaded = vec![true; snap.graphs.len()];
    // Along the seam, at z = 10: each walker on A's east edge crosses where it stands, not along it to the field's exit.
    let (poly, pos) = nearest(nav_a, v3(-0.4, 0.0, 10.0));
    let a_cells = &cells[snap.graphs[a_graph].start..snap.graphs[a_graph].start + snap.graphs[a_graph].count];
    let across = FlowAcross { graphs: &snap.graphs, cells: &cells, loaded: &loaded, graph: a_graph, radius: 0.5 };
    let mut corridor = Vec::new();
    let (end, exit) = walk(nav_a, a_cells, &snap.exits, target, &filter(), poly, pos, -1, 1000, &mut corridor, Some(&across));
    assert_eq!(end, FlowWalkEnd::Exit);
    let x = snap.exits[exit as usize];
    let crossing_z = (0.5 * (x.a0.z + x.a1.z) - pos.z).abs();
    let (end, exit2) = walk(nav_a, a_cells, &snap.exits, target, &filter(), poly, pos, -1, 1000, &mut corridor, None);
    assert_eq!(end, FlowWalkEnd::Exit);
    let plain_z = (0.5 * (snap.exits[exit2 as usize].a0.z + snap.exits[exit2 as usize].a1.z) - pos.z).abs();
    assert!(crossing_z <= plain_z + 1e-3, "with the exits weighed the walker crosses no further along the seam ({crossing_z} vs {plain_z})");

    // A graph that is no longer loaded isn't stepped onto.
    let none = vec![false; snap.graphs.len()];
    let across = FlowAcross { loaded: &none, ..across };
    let (end, exit3) = walk(nav_a, a_cells, &snap.exits, target, &filter(), poly, pos, -1, 1000, &mut corridor, Some(&across));
    assert_eq!(end, FlowWalkEnd::Exit);
    assert_eq!(exit3, exit2, "the field's own exit");
}

// ---------------------------------------------------------------- joining a walk to a slot

#[test]
fn a_slot_off_the_fields_way_is_reached_by_joining_a_walk_from_it() {
    let (snap, _, cells) = build_maze(goal(), i32::MAX);
    let nav = &*snap.graphs[0].nav;
    let (start_poly, start_pos) = nearest(nav, v3(-12.0, 0.0, 12.0));
    let mut joins = 0;
    let mut angle = 0.0f32;
    while angle < 6.2 {
        let slot = goal() + v3(angle.cos(), 0.0, angle.sin()) * 4.0;
        angle += 0.5;
        let Some((stop_poly, stop_pos)) = find_nearest_poly(nav, slot, 2.0, &filter()) else { continue };
        let mut corridor = Vec::new();
        let (end, _) = walk(nav, &cells, NO_EXITS, goal(), &filter(), start_poly, start_pos, stop_poly, 1000, &mut corridor, None);
        if end != FlowWalkEnd::FieldGoal {
            continue; // on the field's way already
        }
        joins += 1;
        assert!(join_to_stop(nav, &cells, NO_EXITS, goal(), &filter(), stop_poly, stop_pos, 1000, &mut corridor), "slot {slot:?} joined");
        assert_eq!(corridor[0].poly, start_poly, "from the start");
        assert_eq!(corridor.last().unwrap().poly, stop_poly, "to the slot's polygon");
        for i in 1..corridor.len() {
            let link = corridor[i].link;
            assert!(link >= 0, "every step by a link");
            assert_eq!(corridor[i].poly, nav.links[link as usize].to_poly, "into the next polygon");
            let from = &nav.polys[corridor[i - 1].poly as usize];
            assert!(link >= from.link_start && link < from.link_start + from.link_count, "out of the one before");
        }
    }
    assert!(joins > 0, "every slot was on the field's way");
}

// ---------------------------------------------------------------- the system

struct Rig {
    ff: FlowFields,
    chunks: NavChunks,
    seams: Vec<FlowSeams>,
    goals: Vec<FlowGoal>,
    agent: Arc<FlowAgent>,
    time: f64,
    cap: usize,
}

impl Rig {
    fn maze() -> Self {
        let chunk = LoadedChunk::new(chunk_id(5), Arc::new(maze().out.file.clone()));
        let chunks = NavChunks::gather(&[chunk], &|_| None, &[]);
        assert_eq!(chunks.agent_types, vec![TYPE]);
        Self { ff: FlowFields::new(), chunks, seams: Vec::new(), goals: Vec::new(), agent: Arc::new(agent()), time: 0.0, cap: DEFAULT_MEMORY_BYTES }
    }

    fn frame(&mut self, wanted: &[u64]) {
        self.time += 0.02;
        for &g in wanted {
            self.ff.note_wanted(g, TYPE, &self.agent, self.time);
        }
        self.ff.update(self.time, &self.goals, &self.chunks, &self.seams, self.cap);
    }

    fn run_until(&mut self, wanted: &[u64], frames: usize, what: &str, done: impl Fn(&FlowFields) -> bool) -> usize {
        for i in 0..frames {
            self.frame(wanted);
            if done(&self.ff) {
                return i + 1;
            }
        }
        panic!("not after {frames} frames: {what}");
    }

    fn set(&self, goal: u64) -> &FlowSet {
        self.ff.set(goal, TYPE).expect("a set")
    }

    fn move_goal(&mut self, goal: u64, to: Float3) {
        self.goals.iter_mut().find(|g| g.id == goal).unwrap().position = to;
    }
}

fn ready_version(goal: u64, version: i32) -> impl Fn(&FlowFields) -> bool {
    move |ff| ff.set(goal, TYPE).is_some_and(|s| s.is_ready() && s.version >= version && !s.building)
}

#[test]
fn builders_step_a_budgeted_slice_per_frame_and_equal_a_one_shot_build() {
    let (_, _, whole) = build_maze(goal(), i32::MAX);
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.ff.slice = 7; // a handful of polygons a frame: several steps
    let frames = rig.run_until(&[1], 2000, "the field is built", ready_version(1, 1));
    assert!(frames > 5, "built over several frames ({frames})");
    let set = rig.set(1);
    assert_eq!(set.version, 1);
    assert_eq!(set.cells.len(), whole.len());
    for p in 0..whole.len() {
        assert_eq!(set.cells[p].next, whole[p].next, "polygon {p}'s portal");
        assert_eq!(set.cells[p].cost.to_bits(), whole[p].cost.to_bits(), "polygon {p}'s cost");
    }
    assert_eq!(set.bytes, bytes(whole.len(), 0, 1));
    assert_eq!(rig.ff.stats.builds, 1);

    // The default slice does the same in a frame or two.
    let mut quick = Rig::maze();
    quick.goals.push(FlowGoal::new(1, goal()));
    let frames = quick.run_until(&[1], 20, "the field is built", ready_version(1, 1));
    assert!(frames <= 5, "{frames}");
    assert_eq!(quick.set(1).cells, rig.set(1).cells);
    assert_eq!(BUILD_SLICE, 4096);
}

#[test]
fn a_set_is_built_only_while_an_agent_wants_it() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    for _ in 0..10 {
        rig.frame(&[]); // nobody wants it yet: no settings, no build
    }
    assert!(!rig.set(1).is_ready());
    rig.run_until(&[1], 20, "built once wanted", ready_version(1, 1));

    // Idle past IDLE_SECONDS: a far move isn't followed.
    rig.time += IDLE_SECONDS + 1.0;
    rig.move_goal(1, v3(-12.0, 0.0, -12.0));
    for _ in 0..10 {
        rig.frame(&[]);
    }
    assert_eq!(rig.set(1).version, 1, "an idle field is left alone");
    rig.run_until(&[1], 20, "rebuilt once wanted again", ready_version(1, 2));
}

#[test]
fn goal_moving_below_the_threshold_keeps_the_field_and_above_it_rebuilds() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.run_until(&[1], 20, "built", ready_version(1, 1));
    let built = rig.set(1).clone();
    assert_eq!(built.built_goal, goal());

    // 1 m: under the default 2 m threshold.
    rig.move_goal(1, goal() + v3(1.0, 0.0, 0.0));
    for _ in 0..10 {
        rig.frame(&[1]);
    }
    let kept = rig.set(1);
    assert_eq!((kept.version, kept.built_goal, kept.building), (1, goal(), false), "no rebuild");
    assert_eq!(kept.cells, built.cells);

    // Far: rebuilt for the new goal.
    let far = v3(-12.0, 0.0, -12.0);
    rig.move_goal(1, far);
    rig.run_until(&[1], 20, "rebuilt for the far goal", ready_version(1, 2));
    let rebuilt = rig.set(1);
    assert_eq!(rebuilt.built_goal, far);
    assert_ne!(rebuilt.goal_poly, built.goal_poly);
    assert_ne!(rebuilt.cells, built.cells, "a different field");
    assert_eq!(rig.ff.stats.builds, 2);
}

#[test]
fn goal_moving_within_its_polygon_past_the_threshold_keeps_the_field() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal { move_threshold: 0.5, ..FlowGoal::new(1, goal()) }); // under the polygon's size
    rig.run_until(&[1], 20, "built", ready_version(1, 1));
    let built = rig.set(1).clone();

    // A spot over the threshold away on the same polygon: toward its farthest vertex (polygons are convex).
    let nav = maze().nav();
    let poly = &nav.polys[built.goal_poly as usize];
    let (mut near, mut far) = (Float3::default(), 0.0f32);
    for v in 0..poly.vert_count {
        let vertex = nav.verts[nav.poly_verts[(poly.vert_start + v) as usize] as usize];
        let p = built.built_goal.lerp(vertex, 0.8);
        let d = p.xz().distance(built.built_goal.xz());
        if d > far {
            far = d;
            near = v3(p.x, goal().y, p.z);
        }
    }
    assert!(far > 0.6, "the goal's polygon is too small to move in ({far})");
    rig.move_goal(1, near);
    for _ in 0..4 {
        rig.frame(&[1]);
    }
    let kept = rig.set(1);
    assert_eq!(kept.version, built.version, "the same field");
    assert_eq!(kept.built_goal.x, near.x, "now for the new spot");
    assert_eq!(rig.ff.stats.skips, 1);
    assert_eq!(kept.cells, built.cells);

    rig.move_goal(1, v3(-12.0, 0.0, -12.0));
    rig.run_until(&[1], 20, "rebuilt for the far spot", ready_version(1, 2));
}

#[test]
fn changed_navmeshes_rebuild_the_field_the_same_way() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.run_until(&[1], 20, "built", ready_version(1, 1));
    let before = rig.set(1).cells.clone();
    // As if a gate or an overlay elsewhere changed: the entries' gate-change time moves, the field is rebuilt.
    for e in &mut rig.chunks.entries {
        e.last_gate_change = 3.0;
    }
    rig.run_until(&[1], 20, "rebuilt on the changed navmeshes", ready_version(1, 2));
    assert_eq!(rig.set(1).cells, before, "and comes out the same");
}

#[test]
fn a_goal_that_goes_away_takes_its_sets_with_it() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.goals.push(FlowGoal::new(2, v3(-12.0, 0.0, -12.0)));
    rig.run_until(&[1, 2], 20, "both built", |ff| ff.sets().all(|s| s.is_ready() && !s.building));
    assert_eq!(rig.ff.set_count(), 2);
    rig.goals.remove(0);
    rig.frame(&[2]);
    assert_eq!(rig.ff.set_count(), 1);
    assert!(rig.ff.set(1, TYPE).is_none());
    assert!(rig.set(2).is_ready());
}

#[test]
fn only_a_few_fields_build_at_once() {
    let mut rig = Rig::maze();
    rig.ff.slice = 3;
    for i in 0..5u64 {
        rig.goals.push(FlowGoal::new(i + 1, v3(-15.0 + 6.0 * i as f32, 0.0, 10.0)));
    }
    let wanted = [1, 2, 3, 4, 5];
    let mut most = 0;
    for _ in 0..4000 {
        rig.frame(&wanted);
        most = most.max(rig.ff.active_builders());
        if rig.ff.sets().all(|s| s.is_ready() && !s.building) {
            break;
        }
    }
    assert!(rig.ff.sets().all(|s| s.is_ready()), "every field gets built in the end");
    assert_eq!(most, POOL_SIZE, "two at a time");
}

#[test]
fn fields_over_the_memory_cap_are_evicted_least_recently_wanted_first() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.goals.push(FlowGoal::new(2, v3(-12.0, 0.0, -12.0)));
    rig.cap = 1; // about a byte: kept while wanted, cap or not
    rig.run_until(&[1, 2], 20, "both built", |ff| ff.sets().all(|s| s.is_ready() && !s.building));
    for _ in 0..5 {
        rig.frame(&[1, 2]);
    }
    assert!(rig.set(1).is_ready() && rig.set(2).is_ready(), "wanted sets stay, over the cap");
    assert_eq!(rig.ff.stats.evictions, 0);

    // 1 is wanted last at time T, 2 at T + 0.5; then both sit idle past EVICT_AFTER.
    rig.frame(&[1]);
    rig.time += 0.5;
    rig.frame(&[2]);
    rig.time += 2.0;
    let total = rig.ff.stats.bytes as usize;
    let one = rig.set(1).bytes;
    rig.cap = total - one / 2; // evicting one set is enough
    rig.frame(&[]);
    assert_eq!(rig.ff.stats.evictions, 1);
    assert_eq!(rig.set(1).status, FlowStatus::None, "the least recently wanted goes first");
    assert!(rig.set(1).cells.capacity() == 0 && rig.set(1).bytes == 0, "its memory freed");
    assert!(rig.set(2).is_ready());

    rig.cap = 1;
    rig.frame(&[]);
    assert_eq!(rig.set(2).status, FlowStatus::None, "then the other");
    assert_eq!(rig.ff.stats.evictions, 2);

    // Wanted again: built again, as a new version.
    rig.cap = DEFAULT_MEMORY_BYTES;
    rig.run_until(&[1], 20, "rebuilt after eviction", ready_version(1, 2));
}

#[test]
fn the_same_inputs_give_the_same_fields_and_versions() {
    let run = || {
        let mut rig = Rig::maze();
        rig.ff.slice = 11;
        rig.goals.push(FlowGoal::new(1, goal()));
        rig.goals.push(FlowGoal::new(2, v3(-12.0, 0.0, -12.0)));
        for i in 0..400 {
            if i == 100 {
                rig.move_goal(1, v3(15.0, 0.0, -15.0));
            }
            rig.frame(&[1, 2]);
        }
        rig.ff.sets().map(|s| (s.goal, s.version, s.cells.iter().map(|c| (c.next, c.cost.to_bits())).collect::<Vec<_>>())).collect::<Vec<_>>()
    };
    let (a, b) = (run(), run());
    assert_eq!(a, b);
    assert!(a.iter().all(|s| s.1 >= 1));
    assert!(a.iter().any(|s| s.1 >= 2), "a goal moved: its field was rebuilt");
}

#[test]
fn a_fields_read_side_gives_the_next_portal_and_the_direction_from_a_polygon() {
    let mut rig = Rig::maze();
    rig.goals.push(FlowGoal::new(1, goal()));
    rig.run_until(&[1], 20, "built", ready_version(1, 1));
    let set = rig.set(1);
    let graph = set.graph_of(chunk_id(5), false).expect("the chunk's graph");
    let nav = &*set.graphs[graph].nav;
    assert!(Arc::ptr_eq(&set.graphs[graph].nav, rig.chunks.entries[0].nav.as_ref().unwrap()));
    assert_eq!(set.loaded(&rig.chunks), vec![true]);

    let (poly, pos) = nearest(nav, v3(-12.0, 0.0, 12.0));
    let cell = set.cell(graph, poly).expect("covered");
    assert!(cell.next >= 0, "an ordinary polygon leaves by a link");
    let leaves_at = set.leaves(graph, poly).unwrap();
    let link = &nav.links[cell.next as usize];
    assert_eq!(leaves_at, (link.portal_a + link.portal_b) * 0.5);
    let dir = set.direction(graph, poly, pos).unwrap();
    assert!((dir.length() - 1.0).abs() < 1e-4, "a unit vector");
    assert!(dir.dot((leaves_at - pos).normalize()) > 0.999);

    // The goal's own polygon leaves for the goal itself.
    let goal_poly = set.goal_poly;
    assert_eq!(set.cell(graph, goal_poly).unwrap().next, GOAL);
    assert_eq!(set.leaves(graph, goal_poly), Some(goal()));
    assert_eq!(set.direction(graph, goal_poly, goal()), Some(Float3::default()));

    // And walking through the set's own helper matches walking the cells.
    let mut corridor = Vec::new();
    let (end, _) = set.walk(graph, &filter(), poly, pos, goal_poly, 1000, &mut corridor, Some((&[true], 0.5)));
    assert_eq!(end, FlowWalkEnd::Goal);
    assert_eq!(corridor.last().unwrap().poly, goal_poly);
}
