//! Navmesh flow fields (Foxfire's `NavFlowFields.cs`, `NavFlowFieldSystem` and the field-building jobs of
//! `NavFlowJobs.cs`; movement patterns D10, G9a): per polygon, the portal to leave by toward one goal, for
//! every loaded navmesh of an agent type at once.
//!
//! A field is built by a Dijkstra outward from the goal's polygon over the reverse links (a polygon is reached
//! from the polygons with a link into it), costed as path searches cost the forward way ([`try_link`]: across
//! a polygon from where the path enters it to where it leaves, times its surface and area cost, plus fold, jump
//! and gate rules and costs). Seams and overlay joins are links between graphs ([`FlowExit`]). Where a path
//! search leaves by a portal's middle, the field leaves by the point of a plain portal (or seam) nearest where
//! the way on enters the next polygon, kept the agent's radius from its ends ([`FlowAgent::portal_middles`]:
//! the middle, as before).
//!
//! The build is [`seed`] / [`step`] / [`finish`] over flat arrays ([`FlowBuildScratch`]), stepped a bounded
//! number of polygons per frame ([`BUILD_SLICE`] per builder). [`walk`] reads a finished field into an ordinary
//! polygon corridor, which the path straightener turns into waypoints.
//!
//! [`FlowFields`] is `NavFlowFieldSystem`: per (goal, agent type) a [`FlowSet`] holds the field over all the
//! type's loaded navmeshes and overlays; a pool of [`POOL_SIZE`] builders rebuilds sets that are wanted, whose
//! goal moved past its threshold, or whose navmeshes, overlays, seams or gates changed; finished fields are
//! swapped in whole; over a memory cap the least recently wanted fields are evicted.
//!
//! Not here (the runtime wave): the agent side, `NavFlowAgentSystem` and `NavFlowFollowing` inside the repath
//! pass (turning a walker's `NavFlowAgent` on and off, serving its path requests from the field with [`walk`] /
//! [`join_to_stop`], re-asking when the version changes or at the corridor horizon, handing agents across exits),
//! and `NavFlowSetWanted` bookkeeping, which here is [`FlowFields::note_wanted`].
use crate::chunks::NavChunks;
use crate::filter::{resolve_area_costs, AreaCostOverride, NavMeshQueryFilter};
use crate::pathfinding::{find_nearest_poly, poly_usable, travel_multiplier, try_link, NavMeshPathNode};
use crate::surface::closest_point_on_poly;
use nav_format::{NavLinkKind, NavMeshData};
use nav_math::math::{self, max};
use nav_math::{Float3, Hash128};
use std::collections::BTreeMap;
use std::sync::Arc;

/// `NavFlowCell.Next` of the goal's own polygon.
pub const GOAL: i32 = -2;
/// `NavFlowCell.Next` of a polygon the field doesn't cover (unusable for the agent type).
pub const UNREACHED: i32 = -1;
/// `NavFlowCell.Next` of the polygon nearest the goal in a region the goal can't be reached from: its agents stop
/// there, at its point nearest the goal (what a partial path search gives them).
pub const NEAREST: i32 = -3;
/// Cost per unit of straight-line distance to the goal of stopping short of it ([`NEAREST`]), against walking
/// there. Far above any detour a real way takes, so only regions the goal can't be reached from end short of it.
pub const UNREACHED_DETOUR: f32 = 10000.0;

/// Polygons each builder settles per frame (`NavFlowFieldSystem.BuildSlice`).
pub const BUILD_SLICE: i32 = 4096;
/// Flow fields building at once (`PoolSize`).
pub const POOL_SIZE: usize = 2;
/// Seconds without an agent wanting a set before it stops being rebuilt (`IdleSeconds`).
pub const IDLE_SECONDS: f64 = 5.0;
/// Seconds without an agent wanting a set before it may be evicted, over the memory cap (`EvictAfter`).
pub const EVICT_AFTER: f64 = 1.0;
/// The memory cap's default: `NavigationRuntimeSettings.FlowFieldMemoryMB` = 64.
pub const DEFAULT_MEMORY_BYTES: usize = 64 * 1024 * 1024;
/// `NavFlowGoal.DefaultMoveThreshold`.
pub const DEFAULT_MOVE_THRESHOLD: f32 = 2.0;

/// `NavFlowCell.Next` for leaving across exit (a [`FlowExit`] index).
#[inline]
pub fn exit_of(exit: i32) -> i32 {
    -4 - exit
}

#[inline]
pub fn is_exit(next: i32) -> bool {
    next <= -4
}

#[inline]
pub fn exit_index(next: i32) -> i32 {
    -4 - next
}

/// Bytes of heap memory a field of this many polygons and exits takes (its front buffers): 8 per cell, 96 per
/// exit and 64 per graph, as Foxfire counts (`NavFlowFields.Bytes`).
pub fn bytes(cells: usize, exits: usize, graphs: usize) -> usize {
    cells * 8 + exits * 96 + graphs * 64
}

// ---------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------

/// One polygon of a flow field (`NavFlowCell`, 8 bytes). `next`: the link (index into the navmesh's links) to leave
/// by toward the goal; [`GOAL`] for the goal's own polygon; [`NEAREST`] for the polygon nearest the goal of a region
/// the goal can't be reached from (agents there stop on it); [`UNREACHED`] if the polygon is unusable for the agent
/// type; or an exit across a seam or overlay join ([`exit_of`]). `cost`: from where it leaves (the portal) to the
/// goal, as path searches cost it; `f32::MAX` if unreached.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowCell {
    pub next: i32,
    pub cost: f32,
}

impl Default for FlowCell {
    fn default() -> Self {
        Self { next: UNREACHED, cost: f32::MAX }
    }
}

/// A seam or overlay join a flow field crosses (`NavFlowExit`): from `from_poly` of graph `from_graph` (a0-a1 on its
/// edge) to `to_poly` of graph `to_graph` (b0-b1), which is chunk `to_chunk`'s own navmesh or its overlay.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowExit {
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
    pub to_chunk: Hash128,
    pub from_graph: i32,
    pub from_poly: i32,
    pub to_graph: i32,
    pub to_poly: i32,
    pub to_overlay: bool,
}

/// One navmesh of a flow field (`NavFlowGraph`): chunk `chunk`'s own navmesh or its overlay's, and its polygons'
/// cells `[start, start + count)`. On a builder, also where its switched-off polygons and gate states are in the
/// snapshot's `masks` and `gates`.
#[derive(Clone, Debug)]
pub struct FlowGraph {
    pub nav: Arc<NavMeshData>,
    pub chunk: Hash128,
    pub start: usize,
    pub count: usize,
    pub mask_start: usize,
    /// 0: none switched off.
    pub mask_count: usize,
    /// Runtime cost volumes' table (ADR 0070): a range of [`FlowSnapshot::costs`]; count 0 = every polygon costs 1.
    pub cost_start: usize,
    pub cost_count: usize,
    pub gate_start: usize,
    /// 0: no gates.
    pub gate_count: usize,
    pub overlay: bool,
}

impl FlowGraph {
    /// A graph over one navmesh with no gates or masks (tests, tools).
    pub fn new(nav: Arc<NavMeshData>, chunk: Hash128, overlay: bool) -> Self {
        let count = nav.polys.len();
        Self { nav, chunk, start: 0, count, mask_start: 0, mask_count: 0, cost_start: 0, cost_count: 0, gate_start: 0, gate_count: 0, overlay }
    }
}

/// A seam or overlay join between two loaded navmeshes, by (chunk, overlay) rather than graph index (what a
/// route-graph link names, resolved when a field's snapshot is taken).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowSeam {
    pub from_chunk: Hash128,
    pub from_overlay: bool,
    pub from_poly: i32,
    pub to_chunk: Hash128,
    pub to_overlay: bool,
    pub to_poly: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// An agent type's seams and overlay joins (`NavRouteGraphs` links), and the route graphs' version (it changes when
/// they do, so fields built on older ones are rebuilt).
#[derive(Clone, Debug, Default)]
pub struct FlowSeams {
    pub agent_type: Hash128,
    pub version: i32,
    pub links: Vec<FlowSeam>,
}

/// The agent type's settings a field is built for (the part of `NavMeshAgent` the build reads): its abilities and
/// area costs as a query filter (`NavMeshAgentUtility.ToFilter`), its radius and snap distance.
#[derive(Clone, Debug)]
pub struct FlowAgent {
    /// Abilities, fold and jump limits, surface multipliers. Gates, switched-off polygons and, where the navmesh
    /// has an area table, area costs are set per graph.
    pub filter: NavMeshQueryFilter<'static>,
    /// The agent's per-area overrides, applied to each navmesh's baked area table.
    pub area_overrides: Vec<AreaCostOverride>,
    pub radius: f32,
    /// `MaxSnapDistance`: how far from the navmesh a goal still snaps onto it.
    pub max_snap_distance: f32,
    /// `FlowFieldPortalMiddles`: leave and enter every portal at its middle, as path searches do.
    pub portal_middles: bool,
}

impl FlowAgent {
    pub fn new(filter: NavMeshQueryFilter<'static>, radius: f32) -> Self {
        Self { filter, area_overrides: Vec::new(), radius, max_snap_distance: 2.0, portal_middles: false }
    }

    /// The agent's query filter on graph `g` (`NavFlowFields.Filter`): its abilities and area costs, the graph's
    /// gates and switched-off polygons.
    pub fn graph_filter<'a>(&'a self, g: &FlowGraph, snap: &'a FlowSnapshot) -> NavMeshQueryFilter<'a> {
        let (masks, gates) = (&snap.masks, &snap.gates);
        let mut f: NavMeshQueryFilter<'a> = self.filter;
        if !g.nav.areas.is_empty() {
            f.area_costs.clear();
            let (mut excluded, mut min_cost) = (self.filter.excluded_areas, self.filter.min_area_cost);
            resolve_area_costs(&g.nav.areas, &self.area_overrides, &mut f.area_costs, &mut excluded, &mut min_cost);
            f.excluded_areas = excluded;
            f.min_area_cost = min_cost;
        }
        f.closed_gates = if g.gate_count > 0 { Some(&gates[g.gate_start..g.gate_start + g.gate_count]) } else { None };
        f.switched_off = if g.mask_count > 0 { Some(&masks[g.mask_start..g.mask_start + g.mask_count]) } else { None };
        f.poly_costs = if g.cost_count > 0 { Some(&snap.costs[g.cost_start..g.cost_start + g.cost_count]) } else { None };
        f.min_poly_cost = snap.min_cost;
        f
    }
}

/// What a build runs over (a builder's back-buffer snapshot of the loaded navmeshes): the graphs back to back by
/// `start`, their switched-off polygons and closed gates, and the exits between them.
#[derive(Clone, Debug, Default)]
pub struct FlowSnapshot {
    pub graphs: Vec<FlowGraph>,
    pub masks: Vec<bool>,
    pub gates: Vec<bool>,
    /// Runtime cost volumes' tables, back to back (ADR 0070), and their cheapest entry (at most 1).
    pub costs: Vec<f32>,
    pub min_cost: f32,
    pub exits: Vec<FlowExit>,
}

impl FlowSnapshot {
    /// The agent type's navmeshes back to back with their masks and gates, and the seams between them
    /// (`NavFlowPlanJob.Snapshot`). Seams naming a navmesh that isn't loaded are dropped.
    pub fn from_chunks(chunks: &NavChunks, agent_type: Hash128, seams: &[FlowSeam]) -> Self {
        let mut s = FlowSnapshot { min_cost: chunks.min_poly_cost.min(1.0), ..FlowSnapshot::default() };
        let mut start = 0;
        for (i, e) in chunks.entries.iter().enumerate() {
            let Some(nav) = &e.nav else { continue };
            if e.agent_type != agent_type {
                continue;
            }
            let mut g = FlowGraph::new(nav.clone(), e.chunk, e.overlay);
            g.start = start;
            if e.switched_off_count > 0 {
                g.mask_start = s.masks.len();
                g.mask_count = e.switched_off_count;
                s.masks.extend_from_slice(chunks.switched_off_of(i));
            }
            if e.gate_count > 0 {
                g.gate_start = s.gates.len();
                g.gate_count = e.gate_count;
                s.gates.extend_from_slice(chunks.gates_of(i));
            }
            if e.poly_cost_count > 0 {
                g.cost_start = s.costs.len();
                g.cost_count = e.poly_cost_count;
                s.costs.extend_from_slice(chunks.poly_costs_of(i));
            }
            start += g.count;
            s.graphs.push(g);
        }
        for l in seams {
            let (Some(from), Some(to)) = (s.find_graph(l.from_chunk, l.from_overlay), s.find_graph(l.to_chunk, l.to_overlay)) else {
                continue;
            };
            s.exits.push(FlowExit {
                a0: l.a0,
                a1: l.a1,
                b0: l.b0,
                b1: l.b1,
                to_chunk: s.graphs[to].chunk,
                from_graph: from as i32,
                from_poly: l.from_poly,
                to_graph: to as i32,
                to_poly: l.to_poly,
                to_overlay: s.graphs[to].overlay,
            });
        }
        s
    }

    /// The graph of chunk's own navmesh (or its overlay's), if loaded.
    pub fn find_graph(&self, chunk: Hash128, overlay: bool) -> Option<usize> {
        self.graphs.iter().position(|g| g.chunk == chunk && g.overlay == overlay)
    }

    /// Polygons over every graph.
    pub fn nodes(&self) -> usize {
        count_nodes(&self.graphs)
    }
}

/// The state of one flow field build between slices (`NavFlowBuildState`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowBuildState {
    /// Polygons over every graph.
    pub nodes: usize,
    pub edges: usize,
    pub open_count: usize,
    /// -1: the goal is on no loaded graph (every polygon leads to its region's point nearest it).
    pub goal_node: i32,
    pub goal_graph: i32,
    pub goal_poly: i32,
    pub settled: i32,
    pub pops: i32,
    pub finished: bool,
}

/// Per polygon of a build: best cost to the goal so far, where it leaves toward it, by which link
/// (`NavFlowBuildNode`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowBuildNode {
    pub pos: Float3,
    pub g: f32,
    pub next: i32,
    pub closed: bool,
}

impl Default for FlowBuildNode {
    fn default() -> Self {
        Self { pos: Float3::default(), g: f32::MAX, next: UNREACHED, closed: false }
    }
}

/// A link into a polygon, for the build's outward search (`NavFlowBuildEdge`): from node `from`, by link `link` of
/// its navmesh (0 or more) or across exit `-1 - link`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowBuildEdge {
    pub from: i32,
    pub link: i32,
}

/// An open-heap entry (`NavFlowBuildOpen`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlowBuildOpen {
    pub g: f32,
    pub node: i32,
}

/// A build's working arrays: the reverse links (`edge_start` has one entry more than there are nodes), the
/// per-polygon search state, and the open heap (a binary heap, `open.len()` entries).
#[derive(Clone, Debug, Default)]
pub struct FlowBuildScratch {
    pub edge_start: Vec<i32>,
    pub edges: Vec<FlowBuildEdge>,
    pub nodes: Vec<FlowBuildNode>,
    pub open: Vec<FlowBuildOpen>,
}

impl FlowBuildScratch {
    /// Builds the reverse links and sizes the arrays for the snapshot (the first frame of a build).
    pub fn begin(&mut self, snap: &FlowSnapshot) -> FlowBuildState {
        let mut s = FlowBuildState { nodes: snap.nodes(), ..FlowBuildState::default() };
        self.edge_start.clear();
        self.edge_start.resize(s.nodes + 1, 0);
        s.edges = count_edges(&snap.graphs, &snap.exits, &mut self.edge_start);
        self.edges.clear();
        self.edges.resize(s.edges, FlowBuildEdge::default());
        fill_edges(&snap.graphs, &snap.exits, &self.edge_start, &mut self.edges);
        self.nodes.clear();
        self.nodes.resize(s.nodes, FlowBuildNode::default());
        self.open.clear();
        self.open.reserve(s.edges + s.nodes + 1); // every edge, and every polygon's stop-short seed
        s
    }

    /// Bytes the arrays take (`NavFlowMemoryJob`: 24 per node, 8 per edge, 8 per heap slot).
    pub fn bytes(&self) -> usize {
        self.nodes.len() * 24 + self.edges.len() * 8 + self.open.capacity() * 8
    }
}

// ---------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------

/// Polygons over every graph (each graph's `start` must be set: graphs back to back).
pub fn count_nodes(graphs: &[FlowGraph]) -> usize {
    graphs.iter().map(|g| g.count).sum()
}

/// Counts every node's incoming links (within its graph, and exits into it) and turns the counts into where each
/// node's edges start: `edge_start` has one entry more than there are nodes. Returns the number of edges.
pub fn count_edges(graphs: &[FlowGraph], exits: &[FlowExit], edge_start: &mut [i32]) -> usize {
    for e in edge_start.iter_mut() {
        *e = 0;
    }
    for g in graphs {
        for l in &g.nav.links {
            edge_start[g.start + l.to_poly as usize] += 1;
        }
    }
    for x in exits {
        edge_start[graphs[x.to_graph as usize].start + x.to_poly as usize] += 1;
    }
    let mut total = 0;
    for e in edge_start.iter_mut() {
        let count = *e;
        *e = total;
        total += count;
    }
    total as usize
}

/// Fills the edges, grouped by the node they enter ([`count_edges`] first).
pub fn fill_edges(graphs: &[FlowGraph], exits: &[FlowExit], edge_start: &[i32], edges: &mut [FlowBuildEdge]) {
    let mut cursor = edge_start.to_vec();
    for g in graphs {
        let nav = &*g.nav;
        for (p, poly) in nav.polys.iter().enumerate() {
            for l in poly.link_start..poly.link_start + poly.link_count {
                let to = g.start + nav.links[l as usize].to_poly as usize;
                edges[cursor[to] as usize] = FlowBuildEdge { from: (g.start + p) as i32, link: l };
                cursor[to] += 1;
            }
        }
    }
    for (x, exit) in exits.iter().enumerate() {
        let to = graphs[exit.to_graph as usize].start + exit.to_poly as usize;
        edges[cursor[to] as usize] =
            FlowBuildEdge { from: (graphs[exit.from_graph as usize].start + exit.from_poly as usize) as i32, link: -1 - x as i32 };
        cursor[to] += 1;
    }
}

/// Starts a build: the goal's polygon (the usable polygon nearest `goal` on any graph, within the agent's snap
/// distance) at cost 0, and every other usable polygon as a place to stop short of it ([`NEAREST`]) at
/// [`UNREACHED_DETOUR`] times its distance to the goal, so a region the goal can't be reached from leads to its
/// polygon nearest the goal instead of nowhere. Unusable polygons stay unreached. A goal on no loaded graph (in a
/// chunk not loaded yet, or off the navmesh) has no goal polygon: then every region leads to its point nearest
/// the goal, and walking there brings the agents (and the chunk streaming that follows them) toward it. False if
/// there's no usable polygon at all: the build is then finished.
pub fn seed(
    s: &mut FlowBuildState,
    agent: &FlowAgent,
    snap: &FlowSnapshot,
    goal: Float3,
    nodes: &mut [FlowBuildNode],
    open: &mut Vec<FlowBuildOpen>,
) -> bool {
    for n in nodes.iter_mut() {
        *n = FlowBuildNode::default();
    }
    open.clear();
    s.open_count = 0;
    s.settled = 0;
    s.pops = 0;
    s.goal_node = -1;
    s.goal_graph = -1;
    s.goal_poly = -1;
    s.finished = true;

    let snap_distance = max(agent.max_snap_distance, 0.5);
    let mut best_d2 = f32::MAX;
    let mut at = goal;
    for (g, graph) in snap.graphs.iter().enumerate() {
        let filter = agent.graph_filter(graph, snap);
        let Some((p, point)) = find_nearest_poly(&graph.nav, goal, snap_distance, &filter) else { continue };
        let d2 = goal.distance_sq(point);
        if d2 >= best_d2 {
            continue;
        }
        best_d2 = d2;
        s.goal_graph = g as i32;
        s.goal_poly = p;
        at = point;
    }

    if s.goal_graph >= 0 {
        s.goal_node = (snap.graphs[s.goal_graph as usize].start as i32) + s.goal_poly;
    }

    // Stopping short: a real way is always cheaper, so these only stand where the goal can't be reached.
    for graph in &snap.graphs {
        let filter = agent.graph_filter(graph, snap);
        for p in 0..graph.count {
            let node = (graph.start + p) as i32;
            if node == s.goal_node || !poly_usable(&graph.nav, p as i32, &filter) {
                continue;
            }
            let near = closest_point_on_poly(&graph.nav, p as i32, goal).0;
            let cost = UNREACHED_DETOUR * near.distance(goal);
            nodes[node as usize] = FlowBuildNode { g: cost, pos: near, next: NEAREST, closed: false };
            push(open, FlowBuildOpen { g: cost, node });
        }
    }

    if s.goal_node >= 0 {
        nodes[s.goal_node as usize] = FlowBuildNode { g: 0.0, pos: at, next: GOAL, closed: false };
        push(open, FlowBuildOpen { g: 0.0, node: s.goal_node });
    }

    s.open_count = open.len();
    s.finished = open.is_empty();
    !s.finished
}

/// Settles up to `slice` polygons (nearest the goal first) and offers their neighbours. True once every reachable
/// polygon is settled.
#[allow(clippy::too_many_arguments)]
pub fn step(
    s: &mut FlowBuildState,
    agent: &FlowAgent,
    snap: &FlowSnapshot,
    edge_start: &[i32],
    edges: &[FlowBuildEdge],
    nodes: &mut [FlowBuildNode],
    open: &mut Vec<FlowBuildOpen>,
    slice: i32,
) -> bool {
    if s.finished {
        return true;
    }
    let graphs = &snap.graphs;
    let exits = &snap.exits;
    let filters: Vec<NavMeshQueryFilter> = graphs.iter().map(|g| agent.graph_filter(g, snap)).collect();

    let mut settled = 0;
    while settled < slice {
        if open.is_empty() {
            s.finished = true;
            break;
        }

        let item = pop(open);
        s.pops += 1;
        let q = item.node as usize;
        let mut cur = nodes[q];
        if cur.closed || item.g > cur.g {
            continue; // stale
        }
        cur.closed = true;
        nodes[q] = cur;
        settled += 1;

        let q_graph = graph_of(graphs, q);
        let q_poly = (q - graphs[q_graph].start) as i32;
        let q_nav = &*graphs[q_graph].nav;
        let q_filter = &filters[q_graph];
        let q_mul = travel_multiplier(q_nav, q_poly, q_filter);

        for e in edge_start[q]..edge_start[q + 1] {
            let edge = edges[e as usize];
            let p = edge.from as usize;
            if nodes[p].closed {
                continue;
            }

            let g;
            let pos;
            let next;
            if edge.link >= 0 {
                // Within the graph: leave p at the portal's middle, cross (fold, jump), then across q to where q leaves.
                let p_poly = (p - graphs[q_graph].start) as i32;
                if !poly_usable(q_nav, p_poly, q_filter) {
                    continue;
                }
                let link = &q_nav.links[edge.link as usize];
                let plain = link.kind == NavLinkKind::INTERNAL && !agent.portal_middles;
                pos = if plain { toward(link.portal_a, link.portal_b, cur.pos, agent.radius) } else { (link.portal_a + link.portal_b) * 0.5 };
                let Some((crossing, _, mut land)) = try_link(q_nav, edge.link, pos, 0.0, 0.0, q_filter, false, 0.0) else {
                    continue;
                };
                if plain {
                    land = pos; // a plain portal is entered where it's left
                }
                g = cur.g + land.distance(cur.pos) * q_mul + crossing;
                next = edge.link;
            } else {
                // Across a seam or overlay join: at its point nearest the way on (b0-b1 pairs with a0-a1), or its middle.
                let x = (-1 - edge.link) as usize;
                let exit = &exits[x];
                if !poly_usable(&graphs[exit.from_graph as usize].nav, exit.from_poly, &filters[exit.from_graph as usize]) {
                    continue;
                }
                let t = if agent.portal_middles { 0.5 } else { toward_t(exit.b0, exit.b1, cur.pos, agent.radius) };
                pos = exit.a0.lerp(exit.a1, t);
                g = cur.g + exit.b0.lerp(exit.b1, t).distance(cur.pos) * q_mul;
                next = exit_of(x as i32);
            }

            if g >= nodes[p].g {
                continue;
            }
            nodes[p] = FlowBuildNode { g, pos, next, closed: false };
            push(open, FlowBuildOpen { g, node: p as i32 });
        }
    }

    s.open_count = open.len();
    s.settled += settled;
    s.finished
}

/// The point of portal a-b nearest p, kept `radius` from its ends (its middle if it's narrower).
fn toward(a: Float3, b: Float3, p: Float3, radius: f32) -> Float3 {
    a.lerp(b, toward_t(a, b, p, radius))
}

/// [`toward`] as a fraction along a-b.
fn toward_t(a: Float3, b: Float3, p: Float3, radius: f32) -> f32 {
    let ab = b - a;
    let length = ab.length();
    if length <= 2.0 * radius || length < 1e-4 {
        return 0.5;
    }
    let inset = radius / length;
    math::clamp((p - a).dot(ab) / (length * length), inset, 1.0 - inset)
}

/// The field: each node's next portal and cost (`cells` as long as the nodes).
pub fn finish(nodes: &[FlowBuildNode], cells: &mut [FlowCell]) {
    for (i, n) in nodes.iter().enumerate() {
        cells[i] = FlowCell { next: if n.closed { n.next } else { UNREACHED }, cost: if n.closed { n.g } else { f32::MAX } };
    }
}

/// The graph node belongs to (graphs back to back by `start`).
pub fn graph_of(graphs: &[FlowGraph], node: usize) -> usize {
    for g in (1..graphs.len()).rev() {
        if node >= graphs[g].start {
            return g;
        }
    }
    0
}

fn push(heap: &mut Vec<FlowBuildOpen>, item: FlowBuildOpen) {
    let mut i = heap.len();
    heap.push(item);
    while i > 0 {
        let parent = (i - 1) >> 1;
        if heap[parent].g <= heap[i].g {
            break;
        }
        heap.swap(parent, i);
        i = parent;
    }
}

fn pop(heap: &mut Vec<FlowBuildOpen>) -> FlowBuildOpen {
    let top = heap[0];
    let last = heap.pop().expect("pop of an empty heap");
    let count = heap.len();
    if count > 0 {
        heap[0] = last;
    }
    let mut i = 0;
    loop {
        let (l, r) = (2 * i + 1, 2 * i + 2);
        let mut smallest = i;
        if l < count && heap[l].g < heap[smallest].g {
            smallest = l;
        }
        if r < count && heap[r].g < heap[smallest].g {
            smallest = r;
        }
        if smallest == i {
            break;
        }
        heap.swap(smallest, i);
        i = smallest;
    }
    top
}

/// Builds a whole field at once (or `slice` polygons at a time, with the same result), cells per node across the
/// graphs back to back (`NavFlowFields.Build`: tests, tools). Agents' fields are built a slice per frame on
/// builders instead ([`FlowFields`]).
pub fn build(agent: &FlowAgent, snap: &FlowSnapshot, goal: Float3, slice: i32) -> (FlowBuildState, Vec<FlowCell>) {
    let mut scratch = FlowBuildScratch::default();
    let mut s = scratch.begin(snap);
    seed(&mut s, agent, snap, goal, &mut scratch.nodes, &mut scratch.open);
    while !step(&mut s, agent, snap, &scratch.edge_start, &scratch.edges, &mut scratch.nodes, &mut scratch.open, slice) {}
    let mut cells = vec![FlowCell::default(); s.nodes];
    finish(&scratch.nodes, &mut cells);
    (s, cells)
}

// ---------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------

/// How a walk along a flow field ended (`NavFlowWalkEnd`).
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowWalkEnd {
    /// Reached the polygon asked for (the agent's own goal).
    Goal = 0,
    /// Reached the field's goal polygon without passing the one asked for.
    FieldGoal = 1,
    /// The field leads across a seam or overlay join here.
    Exit = 2,
    /// The goal can't be reached from here (or the start isn't on the field).
    Unreached = 3,
    /// Walked as far as allowed: the rest comes later.
    Horizon = 4,
    /// The goal can't be reached: this is the polygon of the agent's region nearest it (stop there).
    Nearest = 5,
}

/// The whole of a field, for a walk's first step to weigh its start polygon's exits too ([`walk`]): a walker
/// standing on a seam can step across it, instead of following its polygon's one way along the seam to another
/// exit (`NavFlowAcross`).
#[derive(Clone, Copy, Debug)]
pub struct FlowAcross<'a> {
    /// The field's graphs.
    pub graphs: &'a [FlowGraph],
    /// Every graph's cells, back to back.
    pub cells: &'a [FlowCell],
    /// By graph: its navmesh is still loaded. A field outlives an overlay rebuilt or a chunk unloaded until it's
    /// rebuilt: never step onto one that isn't.
    pub loaded: &'a [bool],
    /// The start's graph.
    pub graph: usize,
    /// The agent's: it crosses this far from a portal's ends.
    pub radius: f32,
}

/// Where the field's way leaves `poly`: the middle of the portal it leaves by, the exit's middle, the goal itself
/// for the goal's polygon, or the polygon's point nearest the goal where the field stops short of it. `cells` are
/// the polygon's graph's cells (`NavFlowFields.Leaves`).
pub fn leaves(nav: &NavMeshData, cells: &[FlowCell], exits: &[FlowExit], goal: Float3, poly: i32) -> Float3 {
    let next = cells[poly as usize].next;
    if next >= 0 {
        let l = &nav.links[next as usize];
        return (l.portal_a + l.portal_b) * 0.5;
    }
    if next == NEAREST {
        return closest_point_on_poly(nav, poly, goal).0;
    }
    if is_exit(next) {
        let exit = &exits[exit_index(next) as usize];
        return (exit.a0 + exit.a1) * 0.5;
    }
    goal
}

/// The corridor (cleared first) from `start_poly` along the field, as a path search would write it: each polygon
/// with the link it's entered by. It stops at `stop_poly` (-1: none; the agent's own goal, which may be a surround
/// slot rather than the field's goal), at the field's goal polygon, at an exit (its index is the second value
/// returned, else -1), at the polygon nearest the goal of a region it can't be reached from ([`FlowWalkEnd::Nearest`]),
/// where the field doesn't reach, or after `max_polys` polygons. `cells` are the start's graph's cells;
/// `field_goal` the field's goal position (`NavFlowFields.Walk`).
///
/// The first step is chosen for where the agent stands in its polygon (the field's choice is for its portal's
/// middle): of the links out of it, the one with the least walk from `start_pos` plus the field's cost on from
/// there. With `across`, its exits too: on a coarse navmesh one polygon runs along a whole seam, its field way
/// leaves by one exit, and without them every walker standing on the seam walked along it to that exit.
#[allow(clippy::too_many_arguments)]
pub fn walk(
    nav: &NavMeshData,
    cells: &[FlowCell],
    exits: &[FlowExit],
    field_goal: Float3,
    filter: &NavMeshQueryFilter,
    start_poly: i32,
    start_pos: Float3,
    stop_poly: i32,
    max_polys: i32,
    corridor: &mut Vec<NavMeshPathNode>,
    across: Option<&FlowAcross>,
) -> (FlowWalkEnd, i32) {
    corridor.clear();
    if start_poly < 0 || start_poly as usize >= cells.len() {
        return (FlowWalkEnd::Unreached, -1);
    }
    corridor.push(NavMeshPathNode { poly: start_poly, link: -1 });
    if start_poly == stop_poly {
        return (FlowWalkEnd::Goal, -1);
    }
    if cells[start_poly as usize].next == UNREACHED {
        return (FlowWalkEnd::Unreached, -1);
    }

    let mut first = first_step(nav, cells, exits, field_goal, filter, start_poly, start_pos, across);
    let mut cur;
    let mut next = first;
    let mut steps = 0;
    while steps < max_polys {
        steps += 1;
        if next == GOAL {
            return (FlowWalkEnd::FieldGoal, -1);
        }
        if next == NEAREST {
            return (FlowWalkEnd::Nearest, -1);
        }
        if next == UNREACHED {
            return (FlowWalkEnd::Unreached, -1);
        }
        if is_exit(next) {
            return (FlowWalkEnd::Exit, exit_index(next));
        }

        let to = nav.links[next as usize].to_poly;
        if to == start_poly && first != cells[start_poly as usize].next {
            // The local first step led back round: walk the field's own way from the start instead.
            corridor.clear();
            corridor.push(NavMeshPathNode { poly: start_poly, link: -1 });
            first = cells[start_poly as usize].next;
            next = first;
            continue;
        }

        corridor.push(NavMeshPathNode { poly: to, link: next });
        cur = to;
        if cur == stop_poly {
            return (FlowWalkEnd::Goal, -1);
        }
        next = cells[cur as usize].next;
    }
    (FlowWalkEnd::Horizon, -1)
}

/// For a walk that reached the field's goal polygon without passing `stop_poly` (a surround slot beside the goal):
/// walks the field from `stop_poly` too (`stop_pos` on it) and joins the two where they first meet, the second
/// walked backwards, so the corridor ends on `stop_poly`. No search: both are walks down the field. False
/// (corridor unchanged) if the walk from `stop_poly` doesn't reach the goal polygon, or a step of it has no link
/// back (a one-way jump) (`NavFlowFields.JoinToStop`).
#[allow(clippy::too_many_arguments)]
pub fn join_to_stop(
    nav: &NavMeshData,
    cells: &[FlowCell],
    exits: &[FlowExit],
    field_goal: Float3,
    filter: &NavMeshQueryFilter,
    stop_poly: i32,
    stop_pos: Float3,
    max_polys: i32,
    corridor: &mut Vec<NavMeshPathNode>,
) -> bool {
    let mut back = Vec::with_capacity(16);
    let mut ok =
        walk(nav, cells, exits, field_goal, filter, stop_poly, stop_pos, -1, max_polys, &mut back, None).0 == FlowWalkEnd::FieldGoal;

    // Where the walk from the stop first meets the corridor (at the goal's polygon at the latest).
    let mut meet_corridor = usize::MAX;
    let mut meet_back = usize::MAX;
    if ok {
        'outer: for (j, b) in back.iter().enumerate() {
            for (i, c) in corridor.iter().enumerate() {
                if c.poly == b.poly {
                    meet_corridor = i;
                    meet_back = j;
                    break 'outer;
                }
            }
        }
    }

    ok &= meet_back != usize::MAX;
    let mut joined: Vec<NavMeshPathNode> = Vec::with_capacity(corridor.len() + 16);
    if ok {
        joined.extend_from_slice(&corridor[..=meet_corridor]);
        for k in (0..meet_back).rev() {
            let link = link_to(nav, back[k + 1].poly, back[k].poly);
            ok = link >= 0;
            if !ok {
                break;
            }
            joined.push(NavMeshPathNode { poly: back[k].poly, link });
        }
    }

    if ok {
        corridor.clear();
        corridor.extend_from_slice(&joined);
    }
    ok
}

/// A link from polygon `from` to polygon `to` (a walkable one first: not a jump), or -1.
fn link_to(nav: &NavMeshData, from: i32, to: i32) -> i32 {
    let poly = &nav.polys[from as usize];
    let mut jump = -1;
    for l in poly.link_start..poly.link_start + poly.link_count {
        if nav.links[l as usize].to_poly != to {
            continue;
        }
        if nav.links[l as usize].kind != NavLinkKind::JUMP {
            return l;
        }
        jump = l;
    }
    jump
}

/// The link (or the field's own `next`) to leave the start polygon by, for an agent standing at `start_pos`.
#[allow(clippy::too_many_arguments)]
fn first_step(
    nav: &NavMeshData,
    cells: &[FlowCell],
    exits: &[FlowExit],
    field_goal: Float3,
    filter: &NavMeshQueryFilter,
    start_poly: i32,
    start_pos: Float3,
    across: Option<&FlowAcross>,
) -> i32 {
    let own = cells[start_poly as usize];
    let mul = travel_multiplier(nav, start_poly, filter);
    let mut best = own.next;
    let mut best_cost = start_pos.distance(leaves(nav, cells, exits, field_goal, start_poly)) * mul + own.cost;
    let poly = &nav.polys[start_poly as usize];
    for l in poly.link_start..poly.link_start + poly.link_count {
        if l == own.next {
            continue;
        }
        let to = nav.links[l as usize].to_poly;
        let cell = cells[to as usize];
        if cell.next == UNREACHED {
            continue;
        }
        if cell.next >= 0 && nav.links[cell.next as usize].to_poly == start_poly {
            continue; // straight back
        }
        let Some((cost, _, land)) = try_link(nav, l, start_pos, 0.0, mul, filter, false, 0.0) else { continue };
        let to_mul = travel_multiplier(nav, to, filter);
        let total = cost + land.distance(leaves(nav, cells, exits, field_goal, to)) * to_mul + cell.cost;
        if total >= best_cost {
            continue;
        }
        best_cost = total;
        best = l;
    }

    let Some(across) = across else { return best };
    for (x, exit) in exits.iter().enumerate() {
        let x = x as i32;
        if exit.from_graph as usize != across.graph || exit.from_poly != start_poly || exit_of(x) == own.next {
            continue;
        }
        if (exit.to_graph as usize) >= across.graphs.len() || !across.loaded[exit.to_graph as usize] {
            continue;
        }
        let to = &across.graphs[exit.to_graph as usize];
        if (exit.to_poly as usize) >= to.count {
            continue;
        }
        let to_cells = &across.cells[to.start..to.start + to.count];
        let cell = to_cells[exit.to_poly as usize];
        if cell.next == UNREACHED {
            continue;
        }
        if is_exit(cell.next) {
            let back = &exits[exit_index(cell.next) as usize];
            if back.to_graph as usize == across.graph && back.to_poly == start_poly {
                continue; // straight back
            }
        }

        let t = toward_t(exit.a0, exit.a1, start_pos, across.radius);
        let total = start_pos.distance(exit.a0.lerp(exit.a1, t)) * mul
            + exit.b0.lerp(exit.b1, t).distance(leaves(&to.nav, to_cells, exits, field_goal, exit.to_poly))
            + cell.cost;
        if total >= best_cost {
            continue;
        }
        best_cost = total;
        best = exit_of(x);
    }
    best
}

// ---------------------------------------------------------------------------------------------------------
// The system: sets, builders, eviction
// ---------------------------------------------------------------------------------------------------------

/// A flow goal this frame (`NavFlowGoal` on an entity with a position): `id` is the runtime's own handle for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlowGoal {
    pub id: u64,
    pub position: Float3,
    /// The field is rebuilt once the goal is this far from where it was built for (and on another polygon).
    /// 0: [`DEFAULT_MOVE_THRESHOLD`].
    pub move_threshold: f32,
}

impl FlowGoal {
    pub fn new(id: u64, position: Float3) -> Self {
        Self { id, position, move_threshold: 0.0 }
    }
    /// `NavFlowGoal.Threshold`.
    pub fn threshold(&self) -> f32 {
        if self.move_threshold > 0.0 {
            self.move_threshold
        } else {
            DEFAULT_MOVE_THRESHOLD
        }
    }
}

/// `NavFlowStatus`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FlowStatus {
    /// No field yet, or evicted.
    #[default]
    None = 0,
    /// The front buffers hold a field (a rebuild may be running: they stay valid until it's copied in).
    Ready = 1,
}

/// One goal's flow field for one agent type, over every loaded navmesh of the type (`NavFlowSet`). The field is in
/// `graphs`, `cells` and `exits`; they're written only when a build finishes (a whole new field is swapped in), so
/// agents never read a half-built one. `version` counts finished builds: agents redo their path when it changes.
#[derive(Clone, Debug, Default)]
pub struct FlowSet {
    pub goal: u64,
    pub agent_type: Hash128,
    /// The type's settings, from the agents wanting it.
    pub agent: Option<Arc<FlowAgent>>,
    /// Last time an agent wanted it (LRU, and idle sets aren't rebuilt).
    pub last_wanted: f64,
    /// When the current field was finished.
    pub built_time: f64,
    /// The navmeshes, overlays, seams and gate states it was built on.
    pub signature: u64,
    /// ... the running build is on.
    pub pending_signature: u64,
    /// The goal position the current field was built for.
    pub built_goal: Float3,
    /// ... the running build is for.
    pub pending_goal: Float3,
    /// Where that goal is: chunk, overlay and polygon (moved within one polygon: no rebuild).
    pub goal_chunk: Hash128,
    pub goal_poly: i32,
    pub goal_overlay: bool,
    /// The builder on it while `building`.
    pub builder: Option<usize>,
    /// Finished builds.
    pub version: i32,
    /// Front buffers' heap memory.
    pub bytes: usize,
    pub status: FlowStatus,
    pub building: bool,
    pub graphs: Vec<FlowGraph>,
    pub cells: Vec<FlowCell>,
    pub exits: Vec<FlowExit>,
}

impl FlowSet {
    pub fn is_ready(&self) -> bool {
        self.status == FlowStatus::Ready
    }

    /// The graph of chunk's own navmesh (or its overlay's) in this field.
    pub fn graph_of(&self, chunk: Hash128, overlay: bool) -> Option<usize> {
        self.graphs.iter().position(|g| g.chunk == chunk && g.overlay == overlay)
    }

    /// A graph's cells (empty if there is no such graph).
    pub fn cells_of(&self, graph: usize) -> &[FlowCell] {
        match self.graphs.get(graph) {
            Some(g) => &self.cells[g.start..g.start + g.count],
            None => &[],
        }
    }

    /// The cell of a polygon, or None where the field doesn't cover it.
    pub fn cell(&self, graph: usize, poly: i32) -> Option<FlowCell> {
        let c = self.cells_of(graph).get(usize::try_from(poly).ok()?).copied()?;
        (c.next != UNREACHED).then_some(c)
    }

    /// By graph: its navmesh is still the loaded one (a field outlives an overlay rebuilt or a chunk unloaded until
    /// it's rebuilt; the arguments of [`FlowAcross`]).
    pub fn loaded(&self, chunks: &NavChunks) -> Vec<bool> {
        self.graphs
            .iter()
            .map(|g| {
                chunks
                    .find(g.chunk, self.agent_type, g.overlay)
                    .and_then(|i| chunks.entries[i].nav.as_ref())
                    .is_some_and(|nav| Arc::ptr_eq(nav, &g.nav))
            })
            .collect()
    }

    /// Where the field's way leaves the polygon (the portal's middle, the exit's middle, the goal, or the point
    /// nearest the goal where it stops short), or None where the field doesn't cover it.
    pub fn leaves(&self, graph: usize, poly: i32) -> Option<Float3> {
        self.cell(graph, poly)?;
        Some(leaves(&self.graphs[graph].nav, self.cells_of(graph), &self.exits, self.built_goal, poly))
    }

    /// The unit direction from `pos` toward where the field's way leaves `poly` (zero when there already, `None`
    /// where the field doesn't cover the polygon): the read an agent makes each frame without building a corridor.
    pub fn direction(&self, graph: usize, poly: i32, pos: Float3) -> Option<Float3> {
        let to = self.leaves(graph, poly)?;
        Some((to - pos).normalize_safe(Float3::default()))
    }

    /// [`walk`] on this field's graph `graph` (`loaded` as [`FlowSet::loaded`]; None: no crossing of exits in the
    /// first step).
    #[allow(clippy::too_many_arguments)]
    pub fn walk(
        &self,
        graph: usize,
        filter: &NavMeshQueryFilter,
        start_poly: i32,
        start_pos: Float3,
        stop_poly: i32,
        max_polys: i32,
        corridor: &mut Vec<NavMeshPathNode>,
        loaded: Option<(&[bool], f32)>,
    ) -> (FlowWalkEnd, i32) {
        let across = loaded.map(|(loaded, radius)| FlowAcross { graphs: &self.graphs, cells: &self.cells, loaded, graph, radius });
        walk(
            &self.graphs[graph].nav,
            self.cells_of(graph),
            &self.exits,
            self.built_goal,
            filter,
            start_poly,
            start_pos,
            stop_poly,
            max_polys,
            corridor,
            across.as_ref(),
        )
    }
}

/// A flow field builder (pooled, `NavFlowBuilder`): the Dijkstra's state for the set it's building, stepped a
/// slice per frame. Its snapshot is the back buffer.
#[derive(Clone, Debug, Default)]
struct FlowBuilder {
    set: Option<(u64, Hash128)>,
    active: bool,
    agent: Option<Arc<FlowAgent>>,
    goal: Float3,
    signature: u64,
    state: FlowBuildState,
    frames: i32,
    begun: bool,
    snap: FlowSnapshot,
    scratch: FlowBuildScratch,
}

/// Counters for the recorder (`NavPerfCounter.FlowField*`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlowStats {
    pub builds: u64,
    pub nodes: u64,
    pub skips: u64,
    pub evictions: u64,
    /// Heap bytes of every set and builder at the last update.
    pub bytes: u64,
}

/// Keeps the flow fields of every flow goal (`NavFlowFieldSystem`). Per (goal, walking agent type) a [`FlowSet`]
/// holds the field over all the type's loaded navmeshes and overlays. Each [`update`](FlowFields::update):
/// 1. Sets for new goals and agent types are created; sets whose goal is gone are destroyed.
/// 2. Per agent type, a set wanted by an agent within [`IDLE_SECONDS`] is rebuilt when it has no field, its goal
///    moved more than its threshold, or the type's navmeshes, overlays, seams or gates changed. It takes a free
///    builder, which snapshots the navmeshes and the seams between them.
/// 3. Each builder in use: the first frame builds the reverse links and seeds the goal; then [`BUILD_SLICE`]
///    polygons per frame; finished, the whole field is copied into the set at once. A goal that moved but stayed
///    on its polygon, with nothing else changed, keeps its field.
/// 4. Counts the fields' memory and drops the least recently wanted ones over the cap.
///
/// Frame cost: at most [`POOL_SIZE`] builders times [`BUILD_SLICE`] polygons. Sets and builders are visited in a
/// fixed order (set key order, builder index), so results don't depend on anything but the inputs.
#[derive(Debug)]
pub struct FlowFields {
    sets: BTreeMap<(u64, Hash128), FlowSet>,
    builders: Vec<FlowBuilder>,
    pub slice: i32,
    pub stats: FlowStats,
}

impl Default for FlowFields {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowFields {
    pub fn new() -> Self {
        Self { sets: BTreeMap::new(), builders: Vec::new(), slice: BUILD_SLICE, stats: FlowStats::default() }
    }

    /// The field of goal for an agent type, if it has a set (check [`FlowSet::is_ready`]).
    pub fn set(&self, goal: u64, agent_type: Hash128) -> Option<&FlowSet> {
        self.sets.get(&(goal, agent_type))
    }

    /// Every set, in key order.
    pub fn sets(&self) -> impl Iterator<Item = &FlowSet> {
        self.sets.values()
    }

    pub fn set_count(&self) -> usize {
        self.sets.len()
    }

    /// Builders working right now.
    pub fn active_builders(&self) -> usize {
        self.builders.iter().filter(|b| b.active).count()
    }

    /// An agent wants this set (`NavFlowSetWanted`): idle sets stop being rebuilt and can be evicted, least
    /// recently wanted first, over the memory cap. `agent` is the type's settings the field is built with.
    pub fn note_wanted(&mut self, goal: u64, agent_type: Hash128, agent: &Arc<FlowAgent>, time: f64) {
        let Some(s) = self.sets.get_mut(&(goal, agent_type)) else { return };
        let changed = !s.agent.as_ref().is_some_and(|a| Arc::ptr_eq(a, agent));
        if time > s.last_wanted || changed {
            s.last_wanted = time;
            s.agent = Some(agent.clone());
        }
    }

    /// One frame (`NavFlowFieldSystem.OnUpdate`). `goals`: every flow goal and where it is; `seams`: the route
    /// graphs' links per agent type; `memory_cap`: most heap bytes the fields may take together
    /// ([`DEFAULT_MEMORY_BYTES`]).
    pub fn update(&mut self, time: f64, goals: &[FlowGoal], chunks: &NavChunks, seams: &[FlowSeams], memory_cap: usize) {
        if goals.is_empty() && self.sets.is_empty() {
            return;
        }
        self.update_sets(goals, chunks);
        if !self.sets.is_empty() {
            while self.builders.len() < POOL_SIZE {
                self.builders.push(FlowBuilder::default());
            }
        }

        for &agent_type in &chunks.agent_types {
            let keys: Vec<(u64, Hash128)> = self.sets.keys().filter(|k| k.1 == agent_type).copied().collect();
            if keys.is_empty() {
                continue;
            }
            let type_seams = seams.iter().find(|s| s.agent_type == agent_type);
            let signature = signature(chunks, agent_type, type_seams.map_or(0, |s| s.version));
            self.plan(time, &keys, goals, chunks, type_seams, signature);
        }

        for i in 0..self.builders.len() {
            self.step_builder(i, time);
        }
        self.memory(time, memory_cap);
    }

    /// Destroys sets whose goal is gone, and creates one per (goal, walking agent type) missing.
    fn update_sets(&mut self, goals: &[FlowGoal], chunks: &NavChunks) {
        self.sets.retain(|k, _| goals.iter().any(|g| g.id == k.0));
        for g in goals {
            for &t in &chunks.agent_types {
                if self.sets.contains_key(&(g.id, t)) || !walks(chunks, t) {
                    continue;
                }
                self.sets.insert((g.id, t), FlowSet { goal: g.id, agent_type: t, goal_poly: -1, ..FlowSet::default() });
            }
        }
    }

    /// `NavFlowPlanJob`: decides which of the type's sets to rebuild and hands them to free builders.
    fn plan(&mut self, time: f64, keys: &[(u64, Hash128)], goals: &[FlowGoal], chunks: &NavChunks, seams: Option<&FlowSeams>, signature: u64) {
        for &key in keys {
            let Some(goal) = goals.iter().find(|g| g.id == key.0) else { continue };
            let (builder_ix, building) = {
                let s = &self.sets[&key];
                (s.builder, s.building)
            };
            if building {
                if let Some(b) = builder_ix.filter(|&b| self.builders[b].set == Some(key) && self.builders[b].active) {
                    if self.builders[b].signature == signature {
                        continue;
                    }
                    // The navmeshes changed under the build: start over on the new ones, for where the goal is now.
                    self.assign(b, key, goal.position, signature, chunks, seams);
                    continue;
                }
                self.sets.get_mut(&key).unwrap().building = false; // lost its builder
            }

            let s = &self.sets[&key];
            if s.agent.is_none() || time - s.last_wanted > IDLE_SECONDS {
                continue;
            }
            let due = s.status == FlowStatus::None || s.signature != signature || goal.position.distance(s.built_goal) > goal.threshold();
            if !due {
                continue;
            }
            let Some(b) = self.builders.iter().position(|b| !b.active) else { continue }; // all busy: next frame
            self.assign(b, key, goal.position, signature, chunks, seams);
        }
    }

    fn assign(&mut self, b: usize, key: (u64, Hash128), goal: Float3, signature: u64, chunks: &NavChunks, seams: Option<&FlowSeams>) {
        let s = self.sets.get_mut(&key).unwrap();
        let builder = &mut self.builders[b];
        builder.set = Some(key);
        builder.active = true;
        builder.agent = s.agent.clone();
        builder.goal = goal;
        builder.signature = signature;
        builder.state = FlowBuildState::default();
        builder.frames = 0;
        builder.begun = false;
        builder.snap = FlowSnapshot::from_chunks(chunks, key.1, seams.map_or(&[][..], |s| &s.links));
        s.building = true;
        s.builder = Some(b);
        s.pending_goal = goal;
        s.pending_signature = signature;
    }

    /// `NavFlowBuildStepJob.Execute` for builder `index`.
    fn step_builder(&mut self, index: usize, time: f64) {
        let slice = self.slice;
        let b = &mut self.builders[index];
        if !b.active {
            return;
        }
        let Some(key) = b.set else {
            b.active = false;
            return;
        };
        let Some(s) = self.sets.get_mut(&key) else {
            b.active = false;
            return;
        };
        let Some(agent) = b.agent.clone() else {
            s.building = false;
            b.active = false;
            return;
        };
        b.frames += 1;

        if !b.begun {
            b.begun = true;
            b.frames = 1;
            b.state = b.scratch.begin(&b.snap);
            let scratch = &mut b.scratch;
            seed(&mut b.state, &agent, &b.snap, b.goal, &mut scratch.nodes, &mut scratch.open);

            // Moved within the polygon its field was built for, nothing else changed: the field stands.
            let st = b.state;
            if s.status == FlowStatus::Ready
                && s.signature == b.signature
                && st.goal_graph >= 0
                && st.goal_poly == s.goal_poly
                && b.snap.graphs[st.goal_graph as usize].chunk == s.goal_chunk
                && b.snap.graphs[st.goal_graph as usize].overlay == s.goal_overlay
            {
                s.built_goal = b.goal;
                done(b, s);
                self.stats.skips += 1;
            }
            return; // the links took this frame's share
        }

        let scratch = &mut b.scratch;
        let finished = step(&mut b.state, &agent, &b.snap, &scratch.edge_start, &scratch.edges, &mut scratch.nodes, &mut scratch.open, slice);
        if finished {
            let st = b.state;
            s.version += 1;
            s.status = FlowStatus::Ready;
            s.built_goal = b.goal;
            s.built_time = time;
            s.signature = b.signature;
            s.goal_poly = st.goal_poly;
            s.goal_chunk = if st.goal_graph >= 0 { b.snap.graphs[st.goal_graph as usize].chunk } else { Hash128::default() };
            s.goal_overlay = st.goal_graph >= 0 && b.snap.graphs[st.goal_graph as usize].overlay;

            // The whole field into the set at once: agents read it only between updates.
            s.graphs.clone_from(&b.snap.graphs);
            s.exits.clone_from(&b.snap.exits);
            s.cells.clear();
            s.cells.resize(st.nodes, FlowCell::default());
            finish(&b.scratch.nodes, &mut s.cells);
            s.bytes = bytes(s.cells.len(), s.exits.len(), s.graphs.len());
            done(b, s);
            self.stats.builds += 1;
            self.stats.nodes += st.settled as u64;
        }
    }

    /// `NavFlowMemoryJob`: counts every set's and builder's heap bytes, frees builders whose set is gone, and over
    /// the cap drops the fields nobody wanted for [`EVICT_AFTER`] seconds, least recently wanted first (their
    /// buffers are freed; agents on them go back to paths until one is wanted and built again).
    fn memory(&mut self, time: f64, cap: usize) {
        let mut total: usize = self.sets.values().map(|s| s.bytes).sum();
        for b in &mut self.builders {
            total += b.scratch.bytes();
            if b.active && !b.set.is_some_and(|k| self.sets.contains_key(&k)) {
                b.active = false;
            }
        }
        self.stats.bytes = total as u64;
        while total > cap {
            let mut oldest: Option<(u64, Hash128)> = None;
            let mut oldest_time = f64::MAX;
            for (k, s) in &self.sets {
                if s.status != FlowStatus::Ready || s.building || time - s.last_wanted < EVICT_AFTER {
                    continue;
                }
                if s.last_wanted >= oldest_time {
                    continue;
                }
                oldest_time = s.last_wanted;
                oldest = Some(*k);
            }
            let Some(k) = oldest else { break }; // everything left is in use
            let evict = self.sets.get_mut(&k).unwrap();
            total -= evict.bytes;
            evict.bytes = 0;
            evict.status = FlowStatus::None;
            free(&mut evict.graphs);
            free(&mut evict.cells);
            free(&mut evict.exits);
            self.stats.evictions += 1;
        }
    }
}

fn done(b: &mut FlowBuilder, s: &mut FlowSet) {
    s.building = false;
    s.builder = None;
    b.active = false;
}

fn free<T>(v: &mut Vec<T>) {
    v.clear();
    v.shrink_to_fit();
}

/// True if the agent type has a loaded navmesh (fly-only types have none: no fields, G10).
fn walks(chunks: &NavChunks, agent_type: Hash128) -> bool {
    chunks.entries.iter().any(|e| e.agent_type == agent_type && e.nav.is_some())
}

#[inline]
fn mix(h: u64, v: u64) -> u64 {
    let h = (h ^ v).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^ (h >> 32)
}

/// What a field of this type is built on: its navmeshes and overlays (by identity), their gate states and
/// switched-off polygons, and the seams (the route graphs' version) (`NavFlowPlanJob.Signature`). Only compared
/// within a run (navmeshes are hashed by address).
fn signature(chunks: &NavChunks, agent_type: Hash128, route_version: i32) -> u64 {
    let mut h = mix(17, route_version as u32 as u64);
    for e in &chunks.entries {
        let Some(nav) = &e.nav else { continue };
        if e.agent_type != agent_type {
            continue;
        }
        h = mix(h, e.chunk.x as u64 | (e.chunk.y as u64) << 32);
        h = mix(h, e.chunk.z as u64 | (e.chunk.w as u64) << 32);
        h = mix(h, e.overlay as u64);
        h = mix(h, Arc::as_ptr(nav) as usize as u64);
        h = mix(h, e.last_gate_change.to_bits());
        h = mix(h, e.switched_off_count as u64);
        h = mix(h, e.last_cost_change.to_bits());
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heap_pops_in_order_and_keeps_ties_stable_per_the_c_sharp_sift() {
        let mut heap = Vec::new();
        for (i, g) in [5.0f32, 1.0, 3.0, 1.0, 4.0, 2.0].iter().enumerate() {
            push(&mut heap, FlowBuildOpen { g: *g, node: i as i32 });
        }
        let order: Vec<f32> = std::iter::from_fn(|| (!heap.is_empty()).then(|| pop(&mut heap).g)).collect();
        assert_eq!(order, vec![1.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn exit_codes_round_trip_and_clear_the_special_values() {
        for x in [0, 1, 7] {
            assert!(is_exit(exit_of(x)));
            assert_eq!(exit_index(exit_of(x)), x);
        }
        assert!(!is_exit(GOAL) && !is_exit(UNREACHED) && !is_exit(NEAREST));
        assert_eq!(std::mem::size_of::<FlowCell>(), 8);
        assert_eq!(bytes(10, 2, 1), 80 + 192 + 64);
    }

    #[test]
    fn toward_keeps_the_radius_from_the_ends_and_centres_narrow_portals() {
        let (a, b) = (Float3::new(0.0, 0.0, 0.0), Float3::new(10.0, 0.0, 0.0));
        assert_eq!(toward_t(a, b, Float3::new(-3.0, 0.0, 1.0), 0.5), 0.05);
        assert_eq!(toward_t(a, b, Float3::new(20.0, 0.0, 1.0), 0.5), 0.95);
        assert_eq!(toward_t(a, b, Float3::new(5.0, 0.0, 1.0), 0.5), 0.5);
        assert_eq!(toward_t(a, b, Float3::new(1.0, 0.0, 0.0), 6.0), 0.5);
    }
}
