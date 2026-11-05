//! Runtime cost volumes (ADR 0070) in the searches: walking A* routes round a costly or excluded polygon set, a
//! multiplier below 1 keeps the heuristic admissible, flight A* (one-shot and sliced) prices leaves by them, and the
//! snapshot and route graphs carry the tables.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_bake::settings::ModifierTargets;
use nav_format::file::BakeFile;
use nav_format::NavMeshData;
use nav_math::{Float3, Hash128};
use nav_query::chunks::{LoadedChunk, NavChunks};
use nav_query::costs::{leaf_cost_table, min_cost, poly_cost_table, CostVolume, EXCLUDED};
use nav_query::filter::NavMeshQueryFilter;
use nav_query::pathfinding::{find_nearest_poly, find_path, travel_multiplier, NavPathStatus};
use nav_query::straight_path::straighten;
use nav_query::route_graph::build_route_graphs;
use nav_query::volume::{find_path_with, segment_clear, FlightPathStatus, LeafCosts, NavVolumeQueryFilter};
use std::sync::Arc;

const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);

/// A floor split by a wall along x = 0 with gaps at z in [-1, 1] (near) and [7, 9] (far).
fn two_gaps() -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    b.add_obstacle(v3(0.0, 1.0, -5.5), v3(0.5, 2.0, 9.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 4.0), v3(0.5, 2.0, 6.0), Rot::IDENTITY);
    b.add_obstacle(v3(0.0, 1.0, 14.5), v3(0.5, 2.0, 11.0), Rot::IDENTITY);
    b.bake();
    b
}

fn walk(nav: &NavMeshData, filter: &NavMeshQueryFilter, from: Float3, to: Float3) -> (NavPathStatus, Vec<Float3>) {
    let (sp, spos) = find_nearest_poly(nav, from, 2.0, filter).expect("start on the navmesh");
    let (gp, gpos) = find_nearest_poly(nav, to, 2.0, filter).expect("goal on the navmesh");
    let mut corridor = Vec::new();
    let status = find_path(nav, sp, spos, gp, gpos, filter, &mut corridor);
    let mut wps = Vec::new();
    straighten(nav, &corridor, spos, gpos, &mut wps);
    (status, wps.iter().map(|w| w.position).collect())
}

fn with_table<'a>(table: &'a [f32]) -> NavMeshQueryFilter<'a> {
    NavMeshQueryFilter { poly_costs: Some(table), min_poly_cost: min_cost(table), ..NavMeshQueryFilter::default_for(0.5) }
}

const FROM: Float3 = Float3::new(-8.0, 0.0, 0.0);
const TO: Float3 = Float3::new(8.0, 0.0, 0.0);

fn near_gap(cost: f32) -> CostVolume {
    CostVolume::aabb(v3(0.0, 0.0, 0.0), v3(3.0, 4.0, 3.0), cost)
}

/// True if the straightened path crosses the wall by the near gap.
fn through_near_gap(points: &[Float3]) -> bool {
    points.iter().all(|p| p.z.abs() < 2.0)
}

#[test]
fn walking_paths_go_round_costly_and_excluded_polygons() {
    let bake = two_gaps();
    let nav = bake.nav();
    let plain = NavMeshQueryFilter::default_for(0.5);
    let (status, corridor) = walk(nav, &plain, FROM, TO);
    assert_eq!(status, NavPathStatus::Success);
    assert!(through_near_gap(&corridor), "{corridor:?}");

    let costly = poly_cost_table(nav, &[near_gap(50.0)], WALKER).expect("touches the gap");
    let (status, corridor) = walk(nav, &with_table(&costly), FROM, TO);
    assert_eq!(status, NavPathStatus::Success);
    assert!(!through_near_gap(&corridor), "round by the far gap: {corridor:?}");

    let mut ex = near_gap(1.0);
    ex.excluded = true;
    let excluded = poly_cost_table(nav, &[ex], WALKER).unwrap();
    assert!(excluded.contains(&EXCLUDED));
    let (status, corridor) = walk(nav, &with_table(&excluded), FROM, TO);
    assert_eq!(status, NavPathStatus::Success);
    assert!(!through_near_gap(&corridor));

    // A slight multiplier isn't worth the detour.
    let slight = poly_cost_table(nav, &[near_gap(1.2)], WALKER).unwrap();
    assert!(through_near_gap(&walk(nav, &with_table(&slight), FROM, TO).1));
}

#[test]
fn a_cheap_volume_lowers_the_heuristic_and_the_travel_cost() {
    let bake = two_gaps();
    let nav = bake.nav();
    let cheap = poly_cost_table(nav, &[near_gap(0.05)], WALKER).unwrap();
    let f = with_table(&cheap);
    assert!((f.cheapest_travel() - 0.05).abs() < 1e-6, "the heuristic scales by the cheapest multiplier");
    let p = cheap.iter().position(|&c| c == 0.05).unwrap() as i32;
    assert!((travel_multiplier(nav, p, &f) - 0.05 * travel_multiplier(nav, p, &NavMeshQueryFilter::default_for(0.5))).abs() < 1e-6);
    // Still the shortest way (an admissible heuristic), through the now cheaper gap.
    let (status, path) = walk(nav, &f, FROM, TO);
    assert_eq!(status, NavPathStatus::Success);
    assert!(through_near_gap(&path));
}

fn sky(cloud_area_cost: f32) -> TestBake {
    // A baked area of cost 1 splits the leaves at the cloud's faces, so a runtime box over the same space holds whole
    // leaves (runtime volumes are per leaf: on open sky a leaf can be bigger than the box).
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_floor((-50.0, -50.0), (50.0, 50.0), 0.0, &[]);
    bake.add_obstacle(v3(48.0, 15.0, 48.0), v3(2.0, 30.0, 2.0), Rot::IDENTITY);
    let area = bake.add_area(cloud_area_cost);
    bake.add_modifier_volume(CLOUD, CLOUD_SIZE, area, ModifierTargets::AIR, &[]);
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0));
    bake.bake();
    bake
}

const CLOUD: Float3 = Float3::new(0.0, 20.0, 0.0);
const CLOUD_SIZE: Float3 = Float3::new(10.0, 10.0, 10.0);

fn inside_cloud(p: Float3) -> bool {
    let d = p - CLOUD;
    let h = CLOUD_SIZE * 0.5 - Float3::splat(0.5);
    d.x.abs() < h.x && d.y.abs() < h.y && d.z.abs() < h.z
}

fn samples(points: &[Float3]) -> Vec<Float3> {
    let mut out = Vec::new();
    for w in points.windows(2) {
        let n = ((w[0].distance(w[1]) / 0.25).ceil() as i32).max(1);
        for s in 0..=n {
            out.push(w[0].lerp(w[1], s as f32 / n as f32));
        }
    }
    out
}

#[test]
fn flights_go_round_costly_and_excluded_leaves() {
    let bake = sky(1.0);
    let v = bake.volume();
    let filter = NavVolumeQueryFilter::for_volume(v, &[]);
    let (start, goal) = (v3(-30.0, 20.0, 0.0), v3(30.0, 20.0, 0.0));
    let mut pts = Vec::new();
    assert_eq!(find_path_with(v, &filter, LeafCosts::NONE, start, goal, 5.0, 1_000_000, &mut pts), FlightPathStatus::Success);
    assert_eq!(pts.len(), 2, "straight through without a runtime volume");

    let mut cloud = CostVolume::aabb(CLOUD, CLOUD_SIZE, 10.0);
    cloud.ground = false;
    let table = leaf_cost_table(v, std::slice::from_ref(&cloud), WALKER).expect("touches leaves");
    assert!(poly_cost_table(bake.nav(), std::slice::from_ref(&cloud), WALKER).is_none(), "an air-only volume leaves the navmesh alone");
    let leaves = LeafCosts::new(Some(&table), min_cost(&table));
    assert_eq!(find_path_with(v, &filter, leaves, start, goal, 5.0, 1_000_000, &mut pts), FlightPathStatus::Success);
    assert!(pts.len() > 2, "round the costly leaves");
    assert!(samples(&pts).iter().all(|&p| !inside_cloud(p)), "{pts:?}");
    for w in pts.windows(2) {
        assert!(segment_clear(v, w[0], w[1]));
    }

    cloud.excluded = true;
    let table = leaf_cost_table(v, &[cloud], WALKER).unwrap();
    assert!(table.contains(&EXCLUDED));
    let leaves = LeafCosts::new(Some(&table), min_cost(&table));
    assert_eq!(find_path_with(v, &filter, leaves, start, goal, 5.0, 1_000_000, &mut pts), FlightPathStatus::Success);
    assert!(samples(&pts).iter().all(|&p| !inside_cloud(p)));
}

#[test]
fn the_snapshot_and_route_graphs_carry_the_tables() {
    let bake = two_gaps();
    let file: Arc<BakeFile> = Arc::new(bake.out.file.clone());
    let chunk = Hash128::new(9, 0, 0, 0);
    let loaded = [LoadedChunk::new(chunk, file)];
    let mut snap = NavChunks::gather(&loaded, &|_| None, &[]);
    assert_eq!(snap.min_poly_cost, 1.0);
    let change = snap.apply_cost_volumes(&[near_gap(0.5)], None, 2.0);
    assert!(change.any() && change.polys > 0 && change.leaves == 0);
    let e = snap.find(chunk, WALKER, false).unwrap();
    assert_eq!(snap.entries[e].last_cost_change, 2.0);
    assert_eq!(snap.min_poly_cost, 0.5);
    let changed: Vec<i32> = (0..snap.entries[e].nav.as_ref().unwrap().polys.len() as i32).filter(|&p| snap.poly_cost_changed(e, p)).collect();
    assert_eq!(changed.len(), change.polys);
    assert!(changed.iter().all(|&p| snap.poly_costs_of(e)[p as usize] == 0.5));

    // The same volumes again: nothing changed, and the change time stays.
    let again = snap.apply_cost_volumes(&[near_gap(0.5)], None, 3.0);
    assert!(!again.any());
    assert_eq!(snap.entries[e].last_cost_change, 2.0);
    assert!(!snap.poly_cost_changed(e, changed[0]));

    // A new gather compares with the previous snapshot.
    let mut next = NavChunks::gather(&loaded, &|_| None, &[]);
    assert!(!next.apply_cost_volumes(&[near_gap(0.5)], Some(&snap), 4.0).any());
    assert_eq!(next.entries[e].last_cost_change, 2.0);

    let graphs = build_route_graphs(&next, WALKER, &[], &[]);
    let f = graphs.filter_for(0, &NavMeshQueryFilter::default_for(0.5));
    assert_eq!(f.poly_costs, Some(next.poly_costs_of(e)));
    assert_eq!(f.min_poly_cost, 0.5);
    assert!(graphs.leaf_cost_min().is_none());
}
