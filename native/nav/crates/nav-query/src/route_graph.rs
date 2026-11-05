//! The graphs one agent type routes over across loaded chunks (Foxfire's `NavRouteGraphs` in `NavChunkRouting.cs`,
//! built as `Systems/NavRouteGraphsBuilder.cs` builds them): each chunk's navmesh (with its gates), each overlay as a
//! graph of its own (the base polygons it replaces switched off, its joins to the kept tiles as links), the seams'
//! polygon links across faces, the chunks' flight volumes with their landing links, the seams' leaf links between
//! volumes, landing links moved onto overlays, and the edges and leaf faces that open onto unloaded space (the
//! frontier, where routes to goals in unloaded space end).
//!
//! [`build_route_graphs`] is pure: it reads the [`NavChunks`] snapshot (sorted by chunk id, so independent of load
//! order), the seams' links ([`SeamInput`]) and the overlays' joins ([`OverlayJoins`]), and gives a [`RouteGraphs`]
//! with a content [`RouteGraphs::signature`]. [`RouteGraphCache`] keeps one per agent type that needs them, with a
//! version that counts rebuilds and the chunks each rebuild changed (`NavRouteGraphCache`), and [`affected`] says which
//! routes must be planned again after one.
//!
//! The seam and overlay inputs are plain structs here ([`SeamInput`] and [`OverlayJoins`], made from `seams::Seam` and
//! `overlay::OverlayRecord` with `From`), so
//! this module doesn't depend on how those are stored. Lookups by (graph, polygon) and (volume, leaf) give their
//! values in reverse order of insertion, as Unity's `NativeParallelMultiHashMap` does, so searches break ties the
//! way Foxfire's do.
use crate::chunks::NavChunks;
use crate::crossing::{fill_spans_faces, fill_spans_frontier, fill_spans_portals, FaceLink, FrontierRect, PortalLink};
use crate::overlay::OverlayRecord;
use crate::seams::Seam;
use crate::filter::NavMeshQueryFilter;
use crate::pathfinding::find_nearest_poly;
use nav_format::fingerprint::{hash_landing_links_with, hash_navmesh, hash_volume};
use nav_format::{NavChunkFace, NavLandingLinksData, NavMeshData, NavVolumeData, Xxh3};
use nav_math::hash::FingerprintHasher;
use nav_math::{Float3, Hash128};
use std::collections::HashMap;
use std::sync::Arc;

/// One navmesh the cross-chunk search may use: a chunk's own, or a chunk's overlay (`NavRouteGraph`).
#[derive(Clone, Debug)]
pub struct NavRouteGraph {
    pub nav: Arc<NavMeshData>,
    pub chunk: Hash128,
    pub overlay: bool,
    /// Slices of [`RouteGraphs::switched_off`] (by polygon: replaced by an overlay) and [`RouteGraphs::closed_gates`]
    /// (by gate id); count 0 = none.
    pub switched_off_start: usize,
    pub switched_off_count: usize,
    pub gate_start: usize,
    pub gate_count: usize,
    /// [`RouteGraphs::volumes`]: the chunk's flight volume and landing links, for a chunk's own navmesh; -1 for none
    /// and for overlays (landing links are on the chunk's own polygons).
    pub volume: i32,
}

/// The face rectangle `min`-`max` of a flight volume's leaf on a Chunk Bounds face whose outside no loaded chunk
/// covers: flights to goals in unloaded space end there and wait (`NavAirFrontier`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavAirFrontier {
    pub volume: i32,
    pub leaf: i32,
    pub face: NavChunkFace,
    pub min: Float3,
    pub max: Float3,
    /// The rectangles of the same volume and face that touch share it.
    pub span: i32,
}

/// One chunk's flight volume, with the landing links that join it to the chunk's own navmesh (graph `graph`), for
/// agents that walk and fly. Fly-only agent types have no navmesh: `graph` is -1 and `links` unset (`NavRouteVolume`).
#[derive(Clone, Debug)]
pub struct NavRouteVolume {
    pub volume: Arc<NavVolumeData>,
    pub links: Option<Arc<NavLandingLinksData>>,
    pub chunk: Hash128,
    pub graph: i32,
}

/// A takeoff/landing link of volume `volume` (its chunk's links, index `link`) whose polygon an overlay replaced,
/// moved onto the overlay: polygon `poly` of graph `graph`, at `ground` (`NavOverlayLanding`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavOverlayLanding {
    pub volume: i32,
    pub link: i32,
    pub graph: i32,
    pub poly: i32,
    pub ground: Float3,
}

/// A directed flight link across a seam: leaf `from_leaf` of volume `from_volume` to `to_leaf` of `to_volume`,
/// through the rectangle `min`-`max` on the shared face (`NavAirLink`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavAirLink {
    pub from_volume: i32,
    pub from_leaf: i32,
    pub to_volume: i32,
    pub to_leaf: i32,
    pub min: Float3,
    pub max: Float3,
    /// The links between the same two volumes whose rectangles touch share it.
    pub span: i32,
}

/// A directed link between two graphs' polygons: a seam across a chunk face, or an overlay's join to its chunk's
/// kept tiles. `a0`-`a1` lies on `from_poly`'s edge, `b0`-`b1` on `to_poly`'s (`b0` pairs with `a0`) (`NavGraphLink`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavGraphLink {
    pub from_graph: i32,
    pub from_poly: i32,
    pub to_graph: i32,
    pub to_poly: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
    /// The links between the same two graphs whose portals touch share it.
    pub span: i32,
    /// Bit 0: `a0` meets another portal of the span, bit 1: `a1` does.
    pub joined: u8,
}

/// A seam edge of a loaded graph that faces unloaded space: the polygon edge `a`-`b` on a Chunk Bounds face whose
/// outside no loaded chunk covers. Routes to goals in unloaded space end at one of these (`NavFrontierEdge`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFrontierEdge {
    pub graph: i32,
    pub poly: i32,
    pub face: NavChunkFace,
    pub a: Float3,
    pub b: Float3,
}

// ---------------------------------------------------------------- inputs from the seam and overlay modules

/// A seam's link between two polygons across a face (`NavSeamPolyLink`): `a0`-`a1` on `poly_a`'s edge, `b0`-`b1` on
/// `poly_b`'s, `b0` paired with `a0`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SeamPolyLinkInput {
    pub poly_a: i32,
    pub poly_b: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// A seam's link between two leaves across a face (`NavSeamLeafLink`), through the rectangle `min`-`max` on it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SeamLeafLinkInput {
    pub leaf_a: i32,
    pub leaf_b: i32,
    pub min: Float3,
    pub max: Float3,
}

/// One seam (`NavSeam` with its link buffers), as the route graphs consume it: chunk A's navmesh (its overlay's
/// with `overlay_a`) joined to chunk B's, and A's flight volume to B's.
#[derive(Clone, Debug, Default)]
pub struct SeamInput {
    pub agent_type: Hash128,
    pub chunk_a: Hash128,
    pub overlay_a: bool,
    pub chunk_b: Hash128,
    pub overlay_b: bool,
    pub poly_links: Vec<SeamPolyLinkInput>,
    pub leaf_links: Vec<SeamLeafLinkInput>,
}

/// An overlay's join to a polygon of its chunk's kept tiles (`NavOverlayLink`): `a0`-`a1` on the base polygon's
/// edge, `b0`-`b1` on the overlay polygon's.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OverlayJoin {
    pub base_poly: i32,
    pub overlay_poly: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// The joins of the overlay of `chunk` for `agent_type` (its navmesh and switched-off polygons are in the
/// [`NavChunks`] snapshot).
#[derive(Clone, Debug, Default)]
pub struct OverlayJoins {
    pub chunk: Hash128,
    pub agent_type: Hash128,
    pub joins: Vec<OverlayJoin>,
}

// ---------------------------------------------------------------- the graphs

/// Lookup from a (graph, polygon) or (volume, leaf) key to indices, each key's values in reverse order of insertion
/// (as `NativeParallelMultiHashMap.TryGetFirstValue` / `TryGetNextValue` give them).
#[derive(Clone, Debug, Default)]
pub struct MultiIndex {
    map: HashMap<i64, Vec<i32>>,
}

impl MultiIndex {
    fn add(&mut self, key: i64, value: i32) {
        self.map.entry(key).or_default().insert(0, value);
    }

    /// The key's values, newest first; empty if none.
    #[inline]
    pub fn get(&self, key: i64) -> &[i32] {
        self.map.get(&key).map(|v| v.as_slice()).unwrap_or(&[])
    }

    pub fn len(&self) -> usize {
        self.map.values().map(|v| v.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// The graphs one agent type can route over, and the links between them (`NavRouteGraphs`).
#[derive(Clone, Debug, Default)]
pub struct RouteGraphs {
    pub agent_type: Hash128,
    pub graphs: Vec<NavRouteGraph>,
    pub links: Vec<NavGraphLink>,
    /// [`RouteGraphs::links`] by [`key`]`(from_graph, from_poly)`.
    pub links_from: MultiIndex,
    pub switched_off: Vec<bool>,
    pub closed_gates: Vec<bool>,
    /// Runtime cost volumes' tables (ADR 0070): by graph (by polygon) and by volume (by leaf); empty = every polygon
    /// or leaf costs 1. Copied from the snapshot by [`RouteGraphs::refresh_costs`].
    pub poly_costs: Vec<Vec<f32>>,
    pub leaf_costs: Vec<Vec<f32>>,
    pub min_poly_cost: f32,
    pub min_leaf_cost: f32,
    /// Edges facing unloaded space, by `key(graph, poly)` in `frontier_from`.
    pub frontier: Vec<NavFrontierEdge>,
    pub frontier_from: MultiIndex,
    /// Flight volumes, the seam links between them (by `key(volume, leaf)` in `air_links_from`).
    pub volumes: Vec<NavRouteVolume>,
    pub air_links: Vec<NavAirLink>,
    pub air_links_from: MultiIndex,
    /// Volume leaves facing unloaded space, by `key(volume, leaf)`.
    pub air_frontier: Vec<NavAirFrontier>,
    pub air_frontier_from: MultiIndex,
    /// Landing links moved onto overlays, by `key(volume, leaf)` for landings and `key(graph, poly)` for takeoffs.
    pub overlay_landings: Vec<NavOverlayLanding>,
    pub overlay_landings_by_leaf: MultiIndex,
    pub overlay_landings_by_poly: MultiIndex,
    /// What the graphs were built from: equal inputs, equal signature ([`route_signature`]).
    pub signature: u64,
}

/// `NavRouteGraphs.Key`: a (graph, polygon) or (volume, leaf) pair as one key.
#[inline]
pub fn key(graph: i32, poly: i32) -> i64 {
    ((graph as i64) << 32) | (poly as u32 as i64)
}

/// A route across graphs gets the agent's search budget once per chunk, up to this many times.
pub const MAX_BUDGET_CHUNKS: usize = 4;

impl RouteGraphs {
    /// The filter with this graph's gates and switched-off polygons, and no congestion (per chunk, and only meaningful
    /// within one graph) (`FilterFor`).
    pub fn filter_for<'b>(&'b self, graph: i32, filter: &NavMeshQueryFilter<'_>) -> NavMeshQueryFilter<'b> {
        let g = &self.graphs[graph as usize];
        let f = filter;
        NavMeshQueryFilter {
            allowed_bins: f.allowed_bins,
            max_fold_angle: f.max_fold_angle,
            fold_cost_per_radian: f.fold_cost_per_radian,
            convex_fold_extra_cost: f.convex_fold_extra_cost,
            wall_cost_multiplier: f.wall_cost_multiplier,
            ceiling_cost_multiplier: f.ceiling_cost_multiplier,
            max_nodes: f.max_nodes,
            can_jump: f.can_jump,
            max_jump_up_height: f.max_jump_up_height,
            max_jump_distance: f.max_jump_distance,
            max_fall_distance: f.max_fall_distance,
            jump_cost: f.jump_cost,
            area_costs: f.area_costs,
            excluded_areas: f.excluded_areas,
            min_area_cost: f.min_area_cost,
            closed_gates: (g.gate_count > 0).then(|| &self.closed_gates[g.gate_start..g.gate_start + g.gate_count]),
            switched_off: (g.switched_off_count > 0)
                .then(|| &self.switched_off[g.switched_off_start..g.switched_off_start + g.switched_off_count]),
            poly_costs: self.poly_costs.get(graph as usize).filter(|t| !t.is_empty()).map(|t| t.as_slice()),
            min_poly_cost: self.min_poly_cost,
            congestion: None,
            congestion_cost: f.congestion_cost,
            agent_speed: f.agent_speed,
            agent_radius: f.agent_radius,
        }
    }

    /// The graph of `chunk`'s own navmesh (`overlay` false) or its overlay's; -1 if not loaded (`GraphOf`).
    pub fn graph_of(&self, chunk: Hash128, overlay: bool) -> i32 {
        self.graphs.iter().position(|g| g.chunk == chunk && g.overlay == overlay).map_or(-1, |g| g as i32)
    }

    /// The flight volume of `chunk`; -1 if it has none loaded (`VolumeOf`).
    pub fn volume_of(&self, chunk: Hash128) -> i32 {
        self.volumes.iter().position(|v| v.chunk == chunk).map_or(-1, |v| v as i32)
    }

    /// How many chunks the graphs span (their own navmeshes or volumes), 1 to [`MAX_BUDGET_CHUNKS`] (`BudgetScale`).
    pub fn budget_scale(&self) -> i32 {
        let navmeshes = self.graphs.iter().filter(|g| !g.overlay).count();
        navmeshes.max(self.volumes.len()).clamp(1, MAX_BUDGET_CHUNKS) as i32
    }

    /// True if routing needs these graphs: more than one navmesh or volume, or unloaded space around them
    /// (`NavRouteGraphCache.Rebuild`'s test). Otherwise ordinary paths and flights do.
    pub fn needed(&self) -> bool {
        self.graphs.len() > 1 || !self.frontier.is_empty() || self.volumes.len() > 1 || !self.air_frontier.is_empty()
    }

    /// Copies the chunks' current gate states into the graphs (same chunks as the build). Foxfire copies them only
    /// when the graphs are rebuilt; this lets a gate change reach routes without a rebuild (and without a new version).
    pub fn refresh_gates(&mut self, chunks: &NavChunks) {
        for g in 0..self.graphs.len() {
            let graph = &self.graphs[g];
            if graph.overlay || graph.gate_count == 0 {
                continue;
            }
            let Some(e) = chunks.find(graph.chunk, self.agent_type, false) else { continue };
            let gates = chunks.gates_of(e);
            let n = gates.len().min(graph.gate_count);
            let start = graph.gate_start;
            self.closed_gates[start..start + n].copy_from_slice(&gates[..n]);
        }
    }

    /// A volume's runtime cost table by leaf for flight searches (None: every leaf costs 1).
    pub fn leaf_costs_for(&self, volume: i32) -> Option<&[f32]> {
        usize::try_from(volume).ok().and_then(|v| self.leaf_costs.get(v)).filter(|t| !t.is_empty()).map(|t| t.as_slice())
    }

    /// The cheapest leaf multiplier of the runtime cost volumes, when any volume has a table (for
    /// `NavHybridParams::min_leaf_cost`).
    pub fn leaf_cost_min(&self) -> Option<f32> {
        self.leaf_costs.iter().any(|t| !t.is_empty()).then_some(self.min_leaf_cost)
    }

    /// Copies the snapshot's runtime cost tables (ADR 0070) into the graphs (same chunks as the build).
    pub fn refresh_costs(&mut self, chunks: &NavChunks) {
        let agent_type = self.agent_type;
        self.poly_costs = self
            .graphs
            .iter()
            .map(|g| chunks.find(g.chunk, agent_type, g.overlay).map(|e| chunks.poly_costs_of(e).to_vec()).unwrap_or_default())
            .collect();
        self.leaf_costs = self
            .volumes
            .iter()
            .map(|v| chunks.find(v.chunk, agent_type, false).map(|e| chunks.leaf_costs_of(e).to_vec()).unwrap_or_default())
            .collect();
        self.min_poly_cost = chunks.min_poly_cost.min(1.0);
        self.min_leaf_cost = chunks.min_leaf_cost.min(1.0);
    }

    /// A line for logs: what routes can use (`NavRouteGraphCache.Describe`'s per-type line).
    pub fn describe(&self) -> String {
        let overlays = self.graphs.iter().filter(|g| g.overlay).count();
        format!(
            "Agent type {}: {} navmeshes, {} overlays, {} flight volumes; {} navmesh links and {} flight links between them; {} ground and {} air openings onto unloaded space; {} landing links moved onto overlays.",
            self.agent_type,
            self.graphs.len() - overlays,
            overlays,
            self.volumes.len(),
            self.links.len() / 2,
            self.air_links.len() / 2,
            self.frontier.len(),
            self.air_frontier.len(),
            self.overlay_landings.len()
        )
    }
}

// ---------------------------------------------------------------- build

/// How far past a face to look for a loaded chunk.
const PROBE: f32 = 0.25;
/// How far from a landing link's ground point an overlay polygon may be to take it (`OverlayLandingReach`).
const OVERLAY_LANDING_REACH: f32 = 1.0;

/// Builds the graphs `agent_type` routes over from what's loaded (`NavRouteGraphsBuilder.Build`): the chunks' own
/// navmeshes, the overlays, the flight volumes, the seams' links, overlay landings, and the frontier on the ground and
/// in the air. Seams of other agent types, and seams or joins whose graphs or volumes aren't loaded, are skipped.
pub fn build_route_graphs(chunks: &NavChunks, agent_type: Hash128, seams: &[SeamInput], overlays: &[OverlayJoins]) -> RouteGraphs {
    let mut graphs: Vec<NavRouteGraph> = Vec::new();
    let mut links: Vec<NavGraphLink> = Vec::new();
    let mut switched_off: Vec<bool> = Vec::new();
    let mut gates: Vec<bool> = Vec::new();

    // Chunks' own navmeshes.
    for (i, entry) in chunks.entries.iter().enumerate() {
        if entry.overlay || entry.agent_type != agent_type {
            continue;
        }
        let Some(nav) = &entry.nav else { continue };
        let mut graph = NavRouteGraph {
            nav: nav.clone(),
            chunk: entry.chunk,
            overlay: false,
            switched_off_start: 0,
            switched_off_count: 0,
            gate_start: 0,
            gate_count: 0,
            volume: -1,
        };
        if entry.gate_count > 0 {
            graph.gate_start = gates.len();
            graph.gate_count = entry.gate_count;
            gates.extend_from_slice(chunks.gates_of(i));
        }
        graphs.push(graph);
    }

    // Overlays: a graph each; the polygons of the tiles they replace are switched off in their chunk's graph.
    for entry in &chunks.entries {
        if !entry.overlay || entry.agent_type != agent_type {
            continue;
        }
        let Some(nav) = &entry.nav else { continue };
        let base_graph = find_graph(&graphs, entry.chunk, false);
        if base_graph < 0 {
            continue;
        }
        let Some(base_entry) = chunks.find(entry.chunk, agent_type, false) else { continue };

        let overlay_graph = graphs.len() as i32;
        graphs.push(NavRouteGraph {
            nav: nav.clone(),
            chunk: entry.chunk,
            overlay: true,
            switched_off_start: 0,
            switched_off_count: 0,
            gate_start: 0,
            gate_count: 0,
            volume: -1,
        });

        let g = &mut graphs[base_graph as usize];
        let poly_count = g.nav.polys.len();
        let mask = chunks.switched_off_of(base_entry);
        g.switched_off_start = switched_off.len();
        g.switched_off_count = poly_count;
        for p in 0..poly_count {
            switched_off.push(mask.get(p).copied().unwrap_or(false));
        }

        if let Some(o) = overlays.iter().find(|o| o.chunk == entry.chunk && o.agent_type == agent_type) {
            for join in &o.joins {
                add_both(&mut links, base_graph, join.base_poly, overlay_graph, join.overlay_poly, join.a0, join.a1, join.b0, join.b1);
            }
        }
    }

    // Flight volumes: with landing links on their chunks' own navmeshes (agents that walk and fly), or alone
    // (fly-only agent types, which have no navmesh).
    let mut volumes: Vec<NavRouteVolume> = Vec::new();
    for entry in &chunks.entries {
        if entry.overlay || entry.agent_type != agent_type {
            continue;
        }
        let Some(volume) = &entry.volume else { continue };
        let g = if entry.nav.is_some() && entry.links.is_some() { find_graph(&graphs, entry.chunk, false) } else { -1 };
        if g >= 0 {
            graphs[g as usize].volume = volumes.len() as i32;
        }
        volumes.push(NavRouteVolume {
            volume: volume.clone(),
            links: if g >= 0 { entry.links.clone() } else { None },
            chunk: entry.chunk,
            graph: g,
        });
    }

    // Seams across faces, between the navmeshes and volumes they were stitched from. Taken in (chunk, overlay) order,
    // whatever order they came in.
    let mut seam_order: Vec<&SeamInput> = seams.iter().filter(|s| s.agent_type == agent_type).collect();
    seam_order.sort_by_key(|s| (s.chunk_a, s.overlay_a, s.chunk_b, s.overlay_b));
    let mut air_links: Vec<NavAirLink> = Vec::new();
    for seam in seam_order {
        let a = find_graph(&graphs, seam.chunk_a, seam.overlay_a);
        let b = find_graph(&graphs, seam.chunk_b, seam.overlay_b);
        if a >= 0 && b >= 0 {
            for link in &seam.poly_links {
                add_both(&mut links, a, link.poly_a, b, link.poly_b, link.a0, link.a1, link.b0, link.b1);
            }
        }

        let va = find_volume(&volumes, seam.chunk_a);
        let vb = find_volume(&volumes, seam.chunk_b);
        if va < 0 || vb < 0 {
            continue;
        }
        for link in &seam.leaf_links {
            air_links.push(NavAirLink { from_volume: va, from_leaf: link.leaf_a, to_volume: vb, to_leaf: link.leaf_b, min: link.min, max: link.max, span: 0 });
            air_links.push(NavAirLink { from_volume: vb, from_leaf: link.leaf_b, to_volume: va, to_leaf: link.leaf_a, min: link.min, max: link.max, span: 0 });
        }
    }

    let overlay_landings = add_overlay_landings(&graphs, &switched_off, &volumes);
    let frontier = add_frontier(chunks, agent_type, &graphs, &switched_off);
    let air_frontier = add_air_frontier(chunks, agent_type, &volumes);

    let mut result = RouteGraphs {
        agent_type,
        graphs,
        links,
        switched_off,
        closed_gates: gates,
        frontier,
        volumes,
        air_links,
        air_frontier,
        overlay_landings,
        signature: route_signature(chunks, agent_type, seams, overlays),
        ..RouteGraphs::default()
    };
    fill_maps(&mut result);
    result.refresh_costs(chunks);
    result
}

/// The lookups of the graphs (`links_from`, `frontier_from`, ...), from its arrays, and the spans (`FillMaps`).
fn fill_maps(g: &mut RouteGraphs) {
    fill_spans_portals(&mut g.links);
    fill_spans_faces(&mut g.air_links);
    fill_spans_frontier(&mut g.air_frontier);
    for (i, l) in g.links.iter().enumerate() {
        g.links_from.add(key(l.from_graph, l.from_poly), i as i32);
    }
    for (i, f) in g.frontier.iter().enumerate() {
        g.frontier_from.add(key(f.graph, f.poly), i as i32);
    }
    for (i, l) in g.air_links.iter().enumerate() {
        g.air_links_from.add(key(l.from_volume, l.from_leaf), i as i32);
    }
    for (i, f) in g.air_frontier.iter().enumerate() {
        g.air_frontier_from.add(key(f.volume, f.leaf), i as i32);
    }
    for (i, landing) in g.overlay_landings.iter().enumerate() {
        let links = g.volumes[landing.volume as usize].links.as_ref().expect("overlay landings come from landing links");
        let leaf = links.links[landing.link as usize].leaf;
        g.overlay_landings_by_leaf.add(key(landing.volume, leaf), i as i32);
        g.overlay_landings_by_poly.add(key(landing.graph, landing.poly), i as i32);
    }
}

/// Moves each landing link whose polygon an overlay replaced onto the overlay's polygon under its ground point
/// (within `OVERLAY_LANDING_REACH`), so agents that walk and fly land on and take off from overlays too
/// (`AddOverlayLandings`).
fn add_overlay_landings(graphs: &[NavRouteGraph], switched_off: &[bool], volumes: &[NavRouteVolume]) -> Vec<NavOverlayLanding> {
    let mut result = Vec::new();
    for (v, rv) in volumes.iter().enumerate() {
        let g = rv.graph;
        let Some(links) = &rv.links else { continue };
        if g < 0 || graphs[g as usize].switched_off_count == 0 {
            continue;
        }
        let base = &graphs[g as usize];
        let mut overlay = -1;
        for (o, graph) in graphs.iter().enumerate() {
            if graph.overlay && graph.chunk == base.chunk {
                overlay = o as i32;
            }
        }
        if overlay < 0 {
            continue;
        }

        let overlay_nav = &graphs[overlay as usize].nav;
        let filter = NavMeshQueryFilter::default_for(0.0);
        for (i, link) in links.links.iter().enumerate() {
            if !switched_off[base.switched_off_start + link.poly as usize] {
                continue;
            }
            // None: the overlay has no ground there (an obstacle was added).
            let Some((poly, ground)) = find_nearest_poly(overlay_nav, link.ground, OVERLAY_LANDING_REACH, &filter) else { continue };
            result.push(NavOverlayLanding { volume: v as i32, link: i as i32, graph: overlay, poly, ground });
        }
    }
    result
}

/// Every graph's seam edges (on its chunk's Chunk Bounds faces) whose outside isn't inside any loaded chunk of this
/// type: past them is unloaded space. Edges of switched-off polygons are skipped; the overlay has its own
/// (`AddFrontier`).
fn add_frontier(chunks: &NavChunks, agent_type: Hash128, graphs: &[NavRouteGraph], switched_off: &[bool]) -> Vec<NavFrontierEdge> {
    let mut frontier = Vec::new();
    for (g, graph) in graphs.iter().enumerate() {
        for edge in &graph.nav.seam_edges {
            if graph.switched_off_count > 0 && switched_off[graph.switched_off_start + edge.poly as usize] {
                continue;
            }
            let outside = (edge.a + edge.b) * 0.5 + outward(edge.face) * PROBE;
            if loaded(chunks, agent_type, outside) {
                continue;
            }
            frontier.push(NavFrontierEdge { graph: g as i32, poly: edge.poly, face: edge.face, a: edge.a, b: edge.b });
        }
    }
    frontier
}

/// Every Chunk Bounds volume's leaves on a side face of its box (the grid spans the box) whose outside isn't inside
/// any loaded chunk of this type, with their rectangle on that face (`AddAirFrontier`).
fn add_air_frontier(chunks: &NavChunks, agent_type: Hash128, volumes: &[NavRouteVolume]) -> Vec<NavAirFrontier> {
    let mut frontier = Vec::new();
    for (v, rv) in volumes.iter().enumerate() {
        let mut bounded = false;
        for e in &chunks.entries {
            if !e.overlay && e.agent_type == agent_type && e.chunk == rv.chunk {
                bounded = e.bounded;
            }
        }
        if !bounded {
            continue;
        }

        let volume = &*rv.volume;
        let dims = [volume.dims.x, volume.dims.y, volume.dims.z];
        for (l, leaf) in volume.leaves.iter().enumerate() {
            let lo = volume.origin + Float3::new(leaf.min.x as f32, leaf.min.y as f32, leaf.min.z as f32) * volume.cell_size;
            let hi = lo + Float3::splat(leaf.size as f32 * volume.cell_size);
            let leaf_min = [leaf.min.x, leaf.min.y, leaf.min.z];
            for f in 0..4 {
                let face = NavChunkFace(f);
                let axis = if face == NavChunkFace::X_MIN || face == NavChunkFace::X_MAX { 0 } else { 2 };
                let high = face == NavChunkFace::X_MAX || face == NavChunkFace::Z_MAX;
                let on_face = if high { leaf_min[axis] + leaf.size >= dims[axis] } else { leaf_min[axis] == 0 };
                if !on_face {
                    continue;
                }

                let mut min = lo;
                let mut max = hi;
                let at = if high { hi[axis] } else { lo[axis] };
                min[axis] = at;
                max[axis] = at;
                let outside = (min + max) * 0.5 + outward(face) * PROBE;
                if loaded(chunks, agent_type, outside) {
                    continue;
                }
                frontier.push(NavAirFrontier { volume: v as i32, leaf: l as i32, face, min, max, span: 0 });
            }
        }
    }
    frontier
}

/// True if `p` (x and z) is inside a loaded chunk of this type (its navmesh or flight volume) (`Loaded`).
pub fn loaded(chunks: &NavChunks, agent_type: Hash128, p: Float3) -> bool {
    chunks.entries.iter().any(|e| {
        !e.overlay
            && e.agent_type == agent_type
            && (e.nav.is_some() || e.volume.is_some())
            && p.x >= e.bounds_min.x
            && p.x <= e.bounds_max.x
            && p.z >= e.bounds_min.z
            && p.z <= e.bounds_max.z
    })
}

/// The unit vector out of the box through `face`.
pub fn outward(face: NavChunkFace) -> Float3 {
    match face {
        NavChunkFace::X_MIN => Float3::new(-1.0, 0.0, 0.0),
        NavChunkFace::X_MAX => Float3::new(1.0, 0.0, 0.0),
        NavChunkFace::Z_MIN => Float3::new(0.0, 0.0, -1.0),
        _ => Float3::new(0.0, 0.0, 1.0),
    }
}

fn find_graph(graphs: &[NavRouteGraph], chunk: Hash128, overlay: bool) -> i32 {
    graphs.iter().position(|g| g.chunk == chunk && g.overlay == overlay).map_or(-1, |g| g as i32)
}

fn find_volume(volumes: &[NavRouteVolume], chunk: Hash128) -> i32 {
    volumes.iter().position(|v| v.chunk == chunk).map_or(-1, |v| v as i32)
}

#[allow(clippy::too_many_arguments)]
fn add_both(links: &mut Vec<NavGraphLink>, ga: i32, pa: i32, gb: i32, pb: i32, a0: Float3, a1: Float3, b0: Float3, b1: Float3) {
    links.push(NavGraphLink { from_graph: ga, from_poly: pa, to_graph: gb, to_poly: pb, a0, a1, b0, b1, span: 0, joined: 0 });
    links.push(NavGraphLink { from_graph: gb, from_poly: pb, to_graph: ga, to_poly: pa, a0: b0, a1: b1, b0: a0, b1: a1, span: 0, joined: 0 });
}

// ---------------------------------------------------------------- spans (the crossing module's FillSpans)

impl PortalLink for NavGraphLink {
    fn from_graph(&self) -> i32 {
        self.from_graph
    }
    fn to_graph(&self) -> i32 {
        self.to_graph
    }
    fn a0(&self) -> Float3 {
        self.a0
    }
    fn a1(&self) -> Float3 {
        self.a1
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
    fn joined(&self) -> u8 {
        self.joined
    }
    fn set_joined(&mut self, joined: u8) {
        self.joined = joined;
    }
}

impl FaceLink for NavAirLink {
    fn from_volume(&self) -> i32 {
        self.from_volume
    }
    fn to_volume(&self) -> i32 {
        self.to_volume
    }
    fn min(&self) -> Float3 {
        self.min
    }
    fn max(&self) -> Float3 {
        self.max
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
}

impl FrontierRect for NavAirFrontier {
    fn volume(&self) -> i32 {
        self.volume
    }
    fn face(&self) -> i32 {
        self.face.0
    }
    fn min(&self) -> Float3 {
        self.min
    }
    fn max(&self) -> Float3 {
        self.max
    }
    fn span(&self) -> i32 {
        self.span
    }
    fn set_span(&mut self, span: i32) {
        self.span = span;
    }
}

impl From<&Seam> for SeamInput {
    fn from(s: &Seam) -> Self {
        SeamInput {
            agent_type: s.agent_type,
            chunk_a: s.chunk_a,
            overlay_a: s.overlay_a,
            chunk_b: s.chunk_b,
            overlay_b: s.overlay_b,
            poly_links: s.poly_links.iter().map(|l| SeamPolyLinkInput { poly_a: l.poly_a, poly_b: l.poly_b, a0: l.a0, a1: l.a1, b0: l.b0, b1: l.b1 }).collect(),
            leaf_links: s.leaf_links.iter().map(|l| SeamLeafLinkInput { leaf_a: l.leaf_a, leaf_b: l.leaf_b, min: l.min, max: l.max }).collect(),
        }
    }
}

impl From<&OverlayRecord> for OverlayJoins {
    fn from(o: &OverlayRecord) -> Self {
        OverlayJoins {
            chunk: o.chunk,
            agent_type: o.agent_type,
            joins: o.links.iter().map(|l| OverlayJoin { base_poly: l.base_poly, overlay_poly: l.overlay_poly, a0: l.a0, a1: l.a1, b0: l.b0, b1: l.b1 }).collect(),
        }
    }
}

// ---------------------------------------------------------------- signature, cache, affected

fn print_of(nav: &Option<Arc<NavMeshData>>, volume: &Option<Arc<NavVolumeData>>, links: &Option<Arc<NavLandingLinksData>>) -> [u64; 3] {
    [
        nav.as_ref().map_or(0, |n| hash_navmesh(n) | 1),
        volume.as_ref().map_or(0, |v| hash_volume(v) | 1),
        links.as_ref().map_or(0, |l| hash_landing_links_with(&Xxh3, l) | 1),
    ]
}

/// What a set of route graphs is built from, hashed: every entry's chunk, agent type, overlay flag and the content
/// of its navmesh, volume and landing links, its gate count and switched-off polygons, and the seams and overlay
/// joins of `agent_type` (Foxfire's `Signature` plus the order versions of the seam and overlay components; content
/// hashes here, since a snapshot's data is copied on every gather). Gate states aren't in it: see
/// [`RouteGraphs::refresh_gates`].
pub fn route_signature(chunks: &NavChunks, agent_type: Hash128, seams: &[SeamInput], overlays: &[OverlayJoins]) -> u64 {
    let mut h = FingerprintHasher::new();
    h.value(chunks.entries.len() as u64);
    for (i, e) in chunks.entries.iter().enumerate() {
        h.value(e.chunk).value(e.agent_type).value(e.overlay as u8).value(e.bounded as u8);
        h.value(e.bounds_min).value(e.bounds_max);
        h.array(&print_of(&e.nav, &e.volume, &e.links));
        h.value(e.gate_count as u64);
        let mask: Vec<u8> = chunks.switched_off_of(i).iter().map(|&b| b as u8).collect();
        h.array(&mask);
    }
    let mut seam_order: Vec<&SeamInput> = seams.iter().filter(|s| s.agent_type == agent_type).collect();
    seam_order.sort_by_key(|s| (s.chunk_a, s.overlay_a, s.chunk_b, s.overlay_b));
    h.value(seam_order.len() as u64);
    for s in seam_order {
        h.value(s.chunk_a).value(s.overlay_a as u8).value(s.chunk_b).value(s.overlay_b as u8);
        h.value(s.poly_links.len() as u64);
        for l in &s.poly_links {
            h.value(l.poly_a).value(l.poly_b).value(l.a0).value(l.a1).value(l.b0).value(l.b1);
        }
        h.value(s.leaf_links.len() as u64);
        for l in &s.leaf_links {
            h.value(l.leaf_a).value(l.leaf_b).value(l.min).value(l.max);
        }
    }
    for o in overlays.iter().filter(|o| o.agent_type == agent_type) {
        h.value(o.chunk).value(o.joins.len() as u64);
        for j in &o.joins {
            h.value(j.base_poly).value(j.overlay_poly).value(j.a0).value(j.a1).value(j.b0).value(j.b1);
        }
    }
    h.finish()
}

/// The route graphs of every agent type that needs them ([`RouteGraphs::needed`]), rebuilt when what's loaded
/// changes (`NavRouteGraphCache`). `version` counts the rebuilds: routes planned on an older one are replanned unless
/// [`affected`] says the change doesn't touch them.
#[derive(Clone, Debug, Default)]
pub struct RouteGraphCache {
    types: Vec<Hash128>,
    graphs: Vec<RouteGraphs>,
    signature: u64,
    built: bool,
    /// Per chunk: what its navmeshes, volumes, links and overlays were; and the seams touching it.
    prints: HashMap<Hash128, u64>,
    seam_prints: HashMap<Hash128, u64>,
    pub version: i32,
    /// What the last rebuild changed, by chunk: its navmesh, volume, landing links or overlay differ, or it came or
    /// went (`changed`); only the seams touching it differ (`changed_seams`). Sorted by chunk id.
    pub changed: Vec<Hash128>,
    pub changed_seams: Vec<Hash128>,
}

impl RouteGraphCache {
    fn signature_of(chunks: &NavChunks, seams: &[SeamInput], overlays: &[OverlayJoins]) -> u64 {
        let mut h = FingerprintHasher::new();
        for &t in &chunks.agent_types {
            h.value(route_signature(chunks, t, seams, overlays));
        }
        h.value(chunks.agent_types.len() as u64);
        h.finish()
    }

    /// True until the graphs are built, and whenever what's loaded changed since (`Stale`).
    pub fn stale(&self, chunks: &NavChunks, seams: &[SeamInput], overlays: &[OverlayJoins]) -> bool {
        !self.built || Self::signature_of(chunks, seams, overlays) != self.signature
    }

    /// Rebuilds the graphs from what's loaded, bumps the version and finds what changed (`Rebuild`).
    pub fn rebuild(&mut self, chunks: &NavChunks, seams: &[SeamInput], overlays: &[OverlayJoins]) {
        self.signature = Self::signature_of(chunks, seams, overlays);
        self.types.clear();
        self.graphs.clear();
        for &t in &chunks.agent_types {
            let graphs = build_route_graphs(chunks, t, seams, overlays);
            if graphs.needed() {
                self.types.push(t);
                self.graphs.push(graphs);
            }
        }
        self.built = true;
        self.version += 1;
        self.find_changed(chunks, seams);
    }

    /// The agent type's graphs, if it has any.
    pub fn get(&self, agent_type: Hash128) -> Option<&RouteGraphs> {
        self.types.iter().position(|&t| t == agent_type).map(|i| &self.graphs[i])
    }

    /// Mutable, for [`RouteGraphs::refresh_gates`].
    pub fn get_mut(&mut self, agent_type: Hash128) -> Option<&mut RouteGraphs> {
        self.types.iter().position(|&t| t == agent_type).map(move |i| &mut self.graphs[i])
    }

    /// The agent types with graphs.
    pub fn types(&self) -> &[Hash128] {
        &self.types
    }

    /// For the console when the graphs are rebuilt (`Describe`).
    pub fn describe(&self, label: &str) -> String {
        let mut text = format!("{label}: route graphs rebuilt (version {}).", self.version);
        for g in &self.graphs {
            text.push_str("\n  ");
            text.push_str(&g.describe());
        }
        if self.types.is_empty() {
            text.push_str(" No agent type has more than one navmesh or volume loaded.");
        }
        text
    }

    /// `changed` and `changed_seams`: the chunks whose prints differ from the last rebuild's (`FindChanged`).
    fn find_changed(&mut self, chunks: &NavChunks, seams: &[SeamInput]) {
        let mut prints: HashMap<Hash128, u64> = HashMap::new();
        for e in &chunks.entries {
            let h = prints.get(&e.chunk).copied().unwrap_or(0);
            let mut x = FingerprintHasher::with_seed(h);
            x.value(e.agent_type).value(e.overlay as u8).array(&print_of(&e.nav, &e.volume, &e.links));
            prints.insert(e.chunk, x.finish());
        }
        let mut seam_prints: HashMap<Hash128, u64> = HashMap::new();
        for seam in seams {
            let mut x = FingerprintHasher::new();
            x.value(seam.chunk_a).value(seam.chunk_b).value(seam.agent_type);
            x.value(seam.overlay_a as u8).value(seam.overlay_b as u8).value(seam.poly_links.len() as u64).value(seam.leaf_links.len() as u64);
            let h = x.finish();
            *seam_prints.entry(seam.chunk_a).or_insert(0) ^= h;
            *seam_prints.entry(seam.chunk_b).or_insert(0) ^= h;
        }

        self.changed.clear();
        self.changed_seams.clear();
        for (chunk, print) in &prints {
            if self.prints.get(chunk) != Some(print) {
                self.changed.push(*chunk);
            } else if seam_prints.get(chunk).copied().unwrap_or(0) != self.seam_prints.get(chunk).copied().unwrap_or(0) {
                self.changed_seams.push(*chunk);
            }
        }
        for chunk in self.prints.keys() {
            if !prints.contains_key(chunk) {
                self.changed.push(*chunk); // unloaded
            }
        }
        self.changed.sort();
        self.changed_seams.sort();
        self.prints = prints;
        self.seam_prints = seam_prints;
    }
}

/// Whether a route must be planned again after a rebuild, given the chunks it's on (the agent's own, then its legs'
/// from the current one): planned before the previous version (it missed a change set); short of its goal (the change
/// may open a way); a chunk it's on or enters changed; a chunk it enters got or lost seams; or it goes to the edge of
/// loaded space and any chunk loaded, unloaded or changed anywhere (`NavRouteGraphCache.Affected`).
#[allow(clippy::too_many_arguments)]
pub fn affected(
    route_version: i32,
    version: i32,
    short_of_goal: bool,
    to_edge: bool,
    own: Hash128,
    leg_chunks: &[Hash128],
    changed: &[Hash128],
    changed_seams: &[Hash128],
) -> bool {
    if route_version != version - 1 || short_of_goal {
        return true;
    }
    if to_edge && !changed.is_empty() {
        return true;
    }
    if changed.contains(&own) {
        return true;
    }
    for &chunk in leg_chunks {
        if changed.contains(&chunk) {
            return true;
        }
        if chunk != own && changed_seams.contains(&chunk) {
            return true;
        }
    }
    let last = leg_chunks.last().copied().unwrap_or(own);
    to_edge && changed_seams.contains(&last)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(fg: i32, tg: i32, a0: Float3, a1: Float3) -> NavGraphLink {
        NavGraphLink { from_graph: fg, to_graph: tg, a0, a1, b0: a0, b1: a1, ..NavGraphLink::default() }
    }

    #[test]
    fn touching_portals_share_a_span_and_mark_their_joined_ends() {
        let z = |z: f32| Float3::new(0.0, 0.0, z);
        let mut links = vec![link(0, 1, z(0.0), z(2.0)), link(0, 1, z(2.0), z(4.0)), link(0, 1, z(6.0), z(8.0)), link(1, 0, z(0.0), z(2.0))];
        fill_spans_portals(&mut links);
        assert_eq!(links[0].span, links[1].span);
        assert_ne!(links[0].span, links[2].span);
        assert_eq!(links[3].span, 3, "another pair of graphs");
        assert_eq!(links[0].joined, 2, "a1 meets the next portal");
        assert_eq!(links[1].joined, 1);
        assert_eq!(links[2].joined, 0);
    }

    #[test]
    fn multi_index_gives_values_newest_first() {
        let mut m = MultiIndex::default();
        m.add(key(1, 2), 5);
        m.add(key(1, 2), 7);
        m.add(key(-2, 3), 1);
        assert_eq!(m.get(key(1, 2)), &[7, 5]);
        assert_eq!(m.get(key(-2, 3)), &[1]);
        assert!(m.get(key(2, 1)).is_empty());
    }

    /// `NavRouteAffectedTests.RouteToTheEdge_PlansAgain_WhenAChunkLoadsAnywhere`.
    #[test]
    fn route_to_the_edge_plans_again_when_a_chunk_loads_anywhere() {
        let own = Hash128::new(1, 0, 0, 0);
        let far = Hash128::new(9, 0, 0, 0);
        let legs = [own];
        assert!(affected(4, 5, false, true, own, &legs, &[far], &[]), "waiting at the edge: any load may be the one");
        assert!(!affected(4, 5, false, false, own, &legs, &[far], &[]), "a route to a loaded goal isn't touched by it");
        assert!(!affected(4, 5, false, true, own, &legs, &[], &[]), "nothing changed");
        assert!(affected(3, 5, false, false, own, &legs, &[], &[]), "planned before the previous version");
        assert!(affected(4, 5, true, false, own, &legs, &[], &[]), "short of its goal");
        assert!(affected(4, 5, false, false, own, &[own, far], &[], &[far]), "a chunk it enters got seams");
        assert!(!affected(4, 5, false, false, own, &[own, far], &[], &[own]), "seams of the chunk it walks through");
    }
}
