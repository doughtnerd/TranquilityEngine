//! Shared fixture for the W4b route tests: Chunk Bounds bakes from `nav-bake`'s test scenes (Foxfire's
//! `NavChunkRouteTests` / `NavHybridChunkRouteTests` setups: A is x in [-40, 0], B is x in [0, 40], both z in
//! [-16, 16]), loaded into a [`NavChunks`] snapshot with real seams ([`build_seams`]), and route graphs built from it.
#![allow(dead_code)]

#[path = "../../../nav-bake/tests/bake_common.rs"]
pub mod bake_common;

pub use bake_common::*;
use nav_math::{Float3, Hash128};
use nav_query::chunks::{LoadedChunk, NavChunks};
use nav_query::route_graph::{build_route_graphs, RouteGraphs, SeamInput};
use nav_query::route_search::{NavRouteLeg, NavRouteLegKind};
use nav_query::seams::build_seams;
use nav_query::volume::NavVolumeQueryFilter;
use std::sync::Arc;

pub const CHUNK_A: Hash128 = Hash128::new(1, 10, 0, 0);
pub const CHUNK_B: Hash128 = Hash128::new(2, 10, 0, 0);
pub const CHUNK_C: Hash128 = Hash128::new(3, 10, 0, 0);
/// The test walker's (and hybrid agent's) id.
pub const TYPE: Hash128 = Hash128::new(1, 0, 0, 0);
/// The test flyer's id.
pub const FLYER: Hash128 = Hash128::new(100, 0, 0, 0);

pub const START: Float3 = Float3::new(-30.0, 0.0, 2.0);
pub const GOAL: Float3 = Float3::new(30.0, 0.0, -3.0);

/// A walker-only Chunk Bounds bake of a floor (`NavChunkRouteTests.Bake`).
pub fn walk_bake(min: Float3, max: Float3, floor_min: (f32, f32), floor_max: (f32, f32)) -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor(floor_min, floor_max, 0.0, &[]);
    bake.set_chunk_bounds(min, max, 1, 2);
    bake.bake();
    bake
}

/// A hybrid (walk and fly, id 1) Chunk Bounds bake of a floor, with a 3 m wall across x in [-2, 2]
/// (`NavHybridChunkRouteTests.Bake`).
pub fn hybrid_bake(min: Float3, max: Float3, wall: bool, floor_min: (f32, f32), floor_max: (f32, f32)) -> TestBake {
    let (walker, flyer) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
    let mut bake = TestBake::new(None);
    bake.add_hybrid(walker, flyer);
    bake.add_floor(floor_min, floor_max, 0.0, &[]);
    if wall {
        bake.add_obstacle(v3(0.0, 1.5, 0.0), v3(4.0, 3.0, 40.0), Rot::IDENTITY);
    }
    bake.set_chunk_bounds(min, max, 1, 2);
    bake.bake();
    assert_eq!(bake.out.file.volumes.len(), 1, "setup: no flight volume");
    assert_eq!(bake.out.file.landing_links.len(), 1, "setup: no landing links");
    bake
}

/// A fly-only Chunk Bounds bake (radius 1 flyer, id 100) over a floor (`NavHybridChunkRouteTests.FlyerBake`).
pub fn flyer_bake(min: Float3, max: Float3) -> TestBake {
    let mut bake = TestBake::new(None);
    bake.add_floor((-40.0, -16.0), (40.0, 16.0), 0.0, &[]);
    bake.add_flyer(flyer_with(1.0, 0.5, 0.0));
    bake.set_chunk_bounds(min, max, 1, 2);
    bake.bake();
    assert_eq!(bake.out.file.volumes.len(), 1, "setup: no flight volume");
    bake
}

pub fn loaded(id: Hash128, bake: &TestBake) -> LoadedChunk {
    LoadedChunk::new(id, Arc::new(bake.out.file.clone()))
}

/// The snapshot of the loaded chunks (their baked gate states, no overlays).
pub fn snapshot(chunks: &[LoadedChunk]) -> NavChunks {
    NavChunks::gather(chunks, &|_| None, &[])
}

/// The snapshot's seams, as the route graphs take them.
pub fn seams_of(chunks: &NavChunks) -> Vec<SeamInput> {
    build_seams(chunks).iter().map(SeamInput::from).collect()
}

/// The route graphs of `agent_type` over these chunks, with their seams.
pub fn graphs_of(chunks: &[LoadedChunk], agent_type: Hash128) -> (NavChunks, RouteGraphs) {
    let snap = snapshot(chunks);
    let seams = seams_of(&snap);
    let graphs = build_route_graphs(&snap, agent_type, &seams, &[]);
    (snap, graphs)
}

/// One flight filter per volume, priced as each volume's bake says (`NavFlightAgent.ToFilter` without overrides).
pub fn air_filters(graphs: &RouteGraphs) -> Vec<NavVolumeQueryFilter> {
    graphs.volumes.iter().map(|v| NavVolumeQueryFilter::for_volume(&v.volume, &[])).collect()
}

pub fn describe(legs: &[NavRouteLeg]) -> String {
    legs.iter()
        .map(|l| {
            let c = if l.chunk == CHUNK_A {
                "A"
            } else if l.chunk == CHUNK_B {
                "B"
            } else if l.chunk == CHUNK_C {
                "C"
            } else {
                "-"
            };
            format!("[{:?} {c}{} to ({:.2}, {:.2}, {:.2}) then ({:.2}, {:.2}, {:.2})]", l.kind, if l.overlay { "o" } else { "" }, l.end.x, l.end.y, l.end.z, l.next_start.x, l.next_start.y, l.next_start.z)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn kinds(legs: &[NavRouteLeg]) -> Vec<NavRouteLegKind> {
    legs.iter().map(|l| l.kind).collect()
}

/// The route graphs with overlays, as the runtime makes them (`RunUntilOverlays`): plan the overlays the loaded
/// chunks call for, build each (`nav_bake::overlay::build_overlay`), gather the snapshot again with them, stitch the
/// seams (which pick the overlays up) and build the graphs with the overlays' joins.
pub fn graphs_with_overlays(chunks: &[LoadedChunk], agent_type: Hash128) -> (NavChunks, RouteGraphs, nav_query::overlay::OverlayManager) {
    use nav_bake::overlay::{build_overlay, OverlayInput, OverlayNeighbour};
    use nav_query::overlay::{NavOverlayLink, OverlayBuilt, OverlayManager};
    use nav_query::route_graph::OverlayJoins;

    let plain = snapshot(chunks);
    let mut manager = OverlayManager::new();
    let planning = manager.plan(&plain);
    for plan in &planning.schedule {
        let entry = &plain.entries[plan.entry];
        let base = entry.nav.as_deref().expect("planned with a navmesh");
        let neighbours: Vec<OverlayNeighbour> = plan
            .neighbours
            .iter()
            .map(|n| OverlayNeighbour { border: plain.entries[n.entry].border.as_deref().expect("a border"), face: n.face, profile: n.profile })
            .collect();
        let input = OverlayInput { border: entry.border.as_deref().expect("a border"), profile: plan.profile, base, neighbours: &neighbours };
        let out = build_overlay(&input).expect("the overlay builds");
        let built = OverlayBuilt {
            nav: out.nav,
            tile_origins: out.tile_origins,
            links: out.links.iter().map(|l| NavOverlayLink { base_poly: l.base_poly, overlay_poly: l.overlay_poly, a0: l.a0, a1: l.a1, b0: l.b0, b1: l.b1 }).collect(),
            open_sides: out.open_sides,
        };
        assert!(manager.collect(plan, built, base, 0.0));
    }
    let snap = NavChunks::gather(chunks, &|_| None, &manager.inputs());
    let seams = seams_of(&snap);
    let joins: Vec<OverlayJoins> = manager.overlays.iter().map(OverlayJoins::from).collect();
    let graphs = build_route_graphs(&snap, agent_type, &seams, &joins);
    (snap, graphs, manager)
}
