//! Routes across loaded chunks and their overlays (Foxfire's `NavChunkRouting.cs`): A* over (graph, polygon) nodes,
//! crossing within a graph by its own links (the same costs and rules as walking pathfinding) and between graphs by
//! [`NavGraphLink`]s (seams and overlay joins, costed like internal links). Switched-off polygons (replaced by an
//! overlay) are never used. The result is legs split wherever the graph changes; each leg runs through the ordinary
//! navmesh path search on its graph. A goal in unloaded space is reached through a frontier edge.
//!
//! Also here: chunk flight routes for fly-only agents (`NavChunkFlightRouteSystem.PlanWith` and
//! `NavFlightRouteSearchJobs.Locate`: snap the ends, decide between an ordinary flight and a route, run the search
//! across volumes), and the route outcome counters (`NavRouteStats`).
use crate::chunks::NavChunks;
use crate::filter::NavMeshQueryFilter;
use crate::hybrid::NavHybridParams;
use crate::pathfinding::{find_nearest_poly_sided, poly_usable, travel_multiplier, try_link, NavPathStatus};
use crate::route_graph::{key, loaded, NavGraphLink, RouteGraphs};
use crate::route_search::{self, closest_on_segment, NavChunkRouteEnd, NavRouteAStar, NavRouteLeg};
use crate::search::{SearchListStore, SearchNode, SearchOpen, SearchStore};
use crate::volume::{snap_to_free, snap_to_free_above, NavVolumeQueryFilter};
use nav_math::{Float3, Hash128};

const HEURISTIC_SCALE: f32 = 0.999;

/// One leg of a cross-chunk walking route: a stretch on one graph, from `start` (on `start_poly`) to `end` (on
/// `end_poly`) (`NavChunkRouteLeg`). It ends where the route crosses to the next leg's graph (`exit_link`, into
/// [`RouteGraphs::links`]: `end` is the middle of its A side, the next leg starts at the middle of its B side), or at
/// the goal (`exit_link` -1).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavChunkRouteLeg {
    pub graph: i32,
    pub start_poly: i32,
    pub start: Float3,
    pub end_poly: i32,
    pub end: Float3,
    pub exit_link: i32,
}

/// The usable polygon nearest `pos` on any graph, within `max_distance`: `(graph, poly, nearest)`, or `None`
/// (`Locate`). A switched-off polygon is never the answer, so a point on a replaced tile lands on the overlay.
/// `prefer_up` as in [`find_nearest_poly_sided`] (zero for none).
pub fn locate(graphs: &RouteGraphs, filter: &NavMeshQueryFilter, pos: Float3, max_distance: f32, prefer_up: Float3) -> Option<(i32, i32, Float3)> {
    let mut best = None;
    let mut best_d2 = f32::MAX;
    for g in 0..graphs.graphs.len() as i32 {
        let graph_filter = graphs.filter_for(g, filter);
        let Some((p, point)) = find_nearest_poly_sided(&graphs.graphs[g as usize].nav, pos, max_distance, &graph_filter, prefer_up, f32::INFINITY) else { continue };
        let d2 = pos.distance_sq(point);
        if d2 >= best_d2 {
            continue;
        }
        best_d2 = d2;
        best = Some((g, p, point));
    }
    best
}

/// A route from (`start_graph`, `start_poly`, `start_pos`) to (`goal_graph`, `goal_poly`, `goal_pos`), as legs
/// (`FindRoute`). Success: it reaches the goal polygon. Partial: it ends where the search got closest (goal
/// unreachable, or the node budget ran out). InvalidInput: an end is out of range or unusable.
#[allow(clippy::too_many_arguments)]
pub fn find_route(
    graphs: &RouteGraphs,
    filter: &NavMeshQueryFilter,
    start_graph: i32,
    start_poly: i32,
    start_pos: Float3,
    goal_graph: i32,
    goal_poly: i32,
    goal_pos: Float3,
    legs: &mut Vec<NavChunkRouteLeg>,
) -> NavPathStatus {
    find_route_on(graphs, filter, start_graph, start_poly, start_pos, goal_graph, goal_poly, goal_pos, legs, -1).0
}

/// [`find_route`] that also gives the route's cost (`f32::MAX` if it didn't reach the goal), and with `only_graph` 0
/// or more stays on that graph (no seams or overlay joins): to compare a route through another graph with the best
/// way that stays on one.
#[allow(clippy::too_many_arguments)]
pub fn find_route_on(
    graphs: &RouteGraphs,
    filter: &NavMeshQueryFilter,
    start_graph: i32,
    start_poly: i32,
    start_pos: Float3,
    goal_graph: i32,
    goal_poly: i32,
    goal_pos: Float3,
    legs: &mut Vec<NavChunkRouteLeg>,
    only_graph: i32,
) -> (NavPathStatus, f32) {
    legs.clear();
    if !valid(graphs, filter, start_graph, start_poly) || !valid(graphs, filter, goal_graph, goal_poly) {
        return (NavPathStatus::InvalidInput, f32::MAX);
    }
    let r = search(graphs, filter, start_graph, start_poly, start_pos, goal_graph, goal_poly, goal_pos, legs, only_graph);
    (r.status, r.cost)
}

/// A route toward `goal_pos` in unloaded space (`FindRouteToEdge`): to the frontier edge that minimises the walk
/// there plus a straight line from it to the goal, which stands in for the unloaded chunks' unknown navmesh. The last
/// leg ends on that edge, at its point nearest the goal; the second value (at the edge) is then true. Partial either
/// way; with no frontier edge reachable, the route ends where the search got closest.
pub fn find_route_to_edge(
    graphs: &RouteGraphs,
    filter: &NavMeshQueryFilter,
    start_graph: i32,
    start_poly: i32,
    start_pos: Float3,
    goal_pos: Float3,
    legs: &mut Vec<NavChunkRouteLeg>,
) -> (NavPathStatus, bool) {
    legs.clear();
    if !valid(graphs, filter, start_graph, start_poly) {
        return (NavPathStatus::InvalidInput, false);
    }
    let r = search(graphs, filter, start_graph, start_poly, start_pos, -1, -1, goal_pos, legs, -1);
    (NavPathStatus::Partial, r.at_edge)
}

struct SearchResult {
    status: NavPathStatus,
    at_edge: bool,
    cost: f32,
}

/// The search behind both. `goal_graph` -1: the goal is in unloaded space, reached through a frontier edge (a node of
/// its own, graph -1, entered from a polygon with frontier edges at the walk there plus the straight line on). Nodes:
/// `space` = graph, `item` = polygon, `via_index` = the [`NavGraphLink`] used to enter (-1 within the graph).
#[allow(clippy::too_many_arguments)]
fn search(
    graphs: &RouteGraphs,
    filter: &NavMeshQueryFilter,
    start_graph: i32,
    start_poly: i32,
    start_pos: Float3,
    goal_graph: i32,
    goal_poly: i32,
    goal_pos: Float3,
    legs: &mut Vec<NavChunkRouteLeg>,
    only_graph: i32,
) -> SearchResult {
    let to_edge = goal_graph < 0;
    let h_scale = HEURISTIC_SCALE * filter.cheapest_travel();
    let mut store = SearchListStore::default();

    let h0 = start_pos.distance(goal_pos) * h_scale;
    let n0 = store.add_node(key(start_graph, start_poly), SearchNode { space: start_graph, item: start_poly, parent: -1, via_index: -1, f: h0, pos: start_pos, ..SearchNode::default() });
    store.push(SearchOpen { f: h0, node: n0 });

    let mut found = -1;
    let mut best_node = 0;
    let mut best_h = start_pos.distance(goal_pos);
    let max_nodes = filter.max_nodes.max(1) as usize;
    let goal = Goal { graph: goal_graph, poly: goal_poly, pos: goal_pos, h_scale };

    while store.open_count() > 0 {
        let item = store.pop();
        let mut cur = store.get_node(item.node);
        if cur.closed() || item.f > cur.f {
            continue;
        }
        cur.set_closed(true);
        store.set_node(item.node, cur);

        if cur.space == goal_graph && cur.item == goal_poly {
            found = item.node;
            break;
        }

        let h_cur = cur.pos.distance(goal_pos);
        if h_cur < best_h {
            best_h = h_cur;
            best_node = item.node;
        }

        let nav = &*graphs.graphs[cur.space as usize].nav;
        let graph_filter = graphs.filter_for(cur.space, filter);
        let travel_mul = travel_multiplier(nav, cur.item, &graph_filter);

        // Into unloaded space: walk to the frontier edge's point nearest the goal, then a straight line on.
        if to_edge {
            for &f in graphs.frontier_from.get(key(cur.space, cur.item)) {
                let edge = graphs.frontier[f as usize];
                let exit = closest_on_segment(goal_pos, edge.a, edge.b);
                let walk = cur.pos.distance(exit);
                let g = cur.g + walk * travel_mul + exit.distance(goal_pos) * h_scale / HEURISTIC_SCALE;
                relax(&mut store, max_nodes, item.node, -1, -1, -1, g, cur.dist + walk, exit, &goal, graphs, filter);
            }
        }

        // Within the graph.
        let poly = nav.polys[cur.item as usize];
        for l in 0..poly.link_count {
            let link_index = poly.link_start + l;
            let Some((link_cost, dist, land)) = try_link(nav, link_index, cur.pos, cur.dist, travel_mul, &graph_filter, false, 0.0) else { continue };
            let to = nav.links[link_index as usize].to_poly;
            relax(&mut store, max_nodes, item.node, cur.space, to, -1, cur.g + link_cost, dist, land, &goal, graphs, filter);
        }

        // Across graphs: seams and overlay joins, costed like internal links (walk to the portal's middle).
        if only_graph >= 0 {
            continue;
        }
        for &x in graphs.links_from.get(key(cur.space, cur.item)) {
            let link = graphs.links[x as usize];
            let to_filter = graphs.filter_for(link.to_graph, filter);
            if !poly_usable(&graphs.graphs[link.to_graph as usize].nav, link.to_poly, &to_filter) {
                continue;
            }
            let exit = (link.a0 + link.a1) * 0.5;
            let walk = cur.pos.distance(exit);
            let land = (link.b0 + link.b1) * 0.5;
            relax(&mut store, max_nodes, item.node, link.to_graph, link.to_poly, x, cur.g + walk * travel_mul, cur.dist + walk, land, &goal, graphs, filter);
        }
    }

    let cost = if found >= 0 { store.get_node(found).g } else { f32::MAX };
    let mut at_edge = false;
    let mut last = if found >= 0 { found } else { best_node };
    let mut end = if found >= 0 { goal_pos } else { store.get_node(last).pos };
    if found >= 0 && to_edge {
        at_edge = true;
        end = store.get_node(found).pos; // on the frontier edge
        last = store.get_node(found).parent; // the frontier node is no polygon: the route ends on its parent's
    }

    write_legs(graphs, &store, last, end, legs);
    SearchResult { status: if found >= 0 { NavPathStatus::Success } else { NavPathStatus::Partial }, at_edge, cost }
}

struct Goal {
    graph: i32,
    poly: i32,
    pos: Float3,
    h_scale: f32,
}

fn valid(graphs: &RouteGraphs, filter: &NavMeshQueryFilter, graph: i32, poly: i32) -> bool {
    if graph < 0 || graph as usize >= graphs.graphs.len() {
        return false;
    }
    let nav = &*graphs.graphs[graph as usize].nav;
    if poly < 0 || poly as usize >= nav.polys.len() {
        return false;
    }
    poly_usable(nav, poly, &graphs.filter_for(graph, filter))
}

/// Offers a node; like `find_path`, the goal node's cost includes the last stretch to the goal position (`Relax`).
#[allow(clippy::too_many_arguments)]
fn relax(
    store: &mut SearchListStore,
    max_nodes: usize,
    parent: i32,
    graph: i32,
    poly: i32,
    cross: i32,
    mut g: f32,
    dist: f32,
    land: Float3,
    goal: &Goal,
    graphs: &RouteGraphs,
    filter: &NavMeshQueryFilter,
) {
    let h = if graph < 0 {
        0.0 // the frontier node: g already includes the straight line to the goal
    } else if graph == goal.graph && poly == goal.poly {
        let nav = &*graphs.graphs[graph as usize].nav;
        g += land.distance(goal.pos) * travel_multiplier(nav, poly, &graphs.filter_for(graph, filter));
        0.0
    } else {
        land.distance(goal.pos) * goal.h_scale
    };

    let k = key(graph, poly);
    if let Some(ni) = store.try_get_node(k) {
        let mut n = store.get_node(ni);
        if g >= n.g {
            return;
        }
        n.parent = parent;
        n.via_index = cross;
        n.g = g;
        n.f = g + h;
        n.dist = dist;
        n.pos = land;
        n.set_closed(false);
        store.set_node(ni, n);
        store.push(SearchOpen { f: n.f, node: ni });
        return;
    }

    if store.node_count() >= max_nodes {
        return;
    }
    let idx = store.add_node(k, SearchNode { space: graph, item: poly, parent, via_index: cross, g, f: g + h, dist, pos: land, ..SearchNode::default() });
    store.push(SearchOpen { f: g + h, node: idx });
}

/// Walks back from node `last` and writes the legs, one per run of nodes on the same graph (`WriteLegs`).
fn write_legs(graphs: &RouteGraphs, store: &SearchListStore, last: i32, end: Float3, legs: &mut Vec<NavChunkRouteLeg>) {
    let mut path = Vec::with_capacity(64);
    let mut n = last;
    while n >= 0 {
        path.push(n);
        n = store.get_node(n).parent;
    }

    // path is goal-to-start: a leg starts at the start, or at a node entered across graphs.
    let mut leg_end = end;
    let mut leg_end_poly = store.get_node(path[0]).item;
    let mut exit_link = -1;
    for &p in &path {
        let node = store.get_node(p);
        let starts_leg = node.via_index >= 0 || node.parent < 0;
        if !starts_leg {
            continue;
        }
        legs.push(NavChunkRouteLeg { graph: node.space, start_poly: node.item, start: node.pos, end_poly: leg_end_poly, end: leg_end, exit_link });
        if node.via_index < 0 {
            break;
        }
        let link: NavGraphLink = graphs.links[node.via_index as usize];
        leg_end = (link.a0 + link.a1) * 0.5;
        leg_end_poly = link.from_poly;
        exit_link = node.via_index;
    }

    // Written goal-first: reverse into start-first.
    legs.reverse();
}

// ---------------------------------------------------------------- chunk flight routes (fly-only agents)

/// One leg of a fly-only agent's route across chunks (`NavChunkLeg`): a flight in chunk `chunk`'s volume to `end`,
/// leaving by the face rectangle `exit_a`-`exit_b` (unset on the last leg).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavChunkLeg {
    pub chunk: Hash128,
    pub overlay: bool,
    pub end: Float3,
    pub exit_a: Float3,
    pub exit_b: Float3,
}

/// The free air nearest `p` within `max_distance`, over every volume; with `rise`, a `p` under the free air (a goal on
/// the ground) takes the free air above it (`NavChunkFlightRouteJob.SnapAir`). Updates `end`'s volume, leaf and air
/// position if found.
pub fn snap_air(graphs: &RouteGraphs, p: Float3, max_distance: f32, end: &mut NavChunkRouteEnd, rise: bool) {
    let mut best = f32::MAX;
    for (v, rv) in graphs.volumes.iter().enumerate() {
        let (mut leaf, mut pos) = snap_to_free(&rv.volume, p, max_distance);
        if leaf < 0 && rise {
            (leaf, pos) = snap_to_free_above(&rv.volume, p, max_distance);
        }
        if leaf < 0 {
            continue;
        }
        let d = p.distance_sq(pos);
        if d >= best {
            continue;
        }
        best = d;
        end.volume = v as i32;
        end.leaf = leaf;
        end.air_pos = pos;
    }
}

/// Where a fly-only agent's route goes, once its ends are placed (`PlanWith` / `Locate`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FlightRouteEnds {
    /// Nothing to route: the agent's chunk has no volume here, or it couldn't be placed in any volume. Try again on
    /// the next repath.
    Nowhere,
    /// An ordinary flight: the goal is in the volume the agent is in, or nowhere yet (`goal_placed` false: try again on
    /// the next repath). `start_chunk` is the chunk of the volume the agent is in.
    Ordinary { start_chunk: Hash128, goal_placed: bool },
    /// A route: from `start` (its volume's chunk may differ from the agent's, if it was pushed over a face) to `goal`
    /// (unset with `to_edge`: the goal is in unloaded space).
    Route { start: NavChunkRouteEnd, goal: NavChunkRouteEnd, to_edge: bool, start_chunk: Hash128 },
}

/// Places a fly-only agent's route ends (`NavChunkFlightRouteJob.PlanWith`): the start in its chunk's volume, else
/// the volume it's in now; toward the edge if the goal is outside every loaded chunk (and there is an air frontier);
/// else the goal in free air (or the free air above it, for a goal on the ground).
pub fn locate_flight_route(
    graphs: &RouteGraphs,
    chunks: &NavChunks,
    own_chunk: Hash128,
    from: Float3,
    goal_pos: Float3,
    max_snap_distance: f32,
) -> FlightRouteEnds {
    let mut own = graphs.volume_of(own_chunk);
    if own < 0 {
        return FlightRouteEnds::Nowhere;
    }
    let mut start = NavChunkRouteEnd::NONE;
    (start.leaf, start.air_pos) = snap_to_free(&graphs.volumes[own as usize].volume, from, max_snap_distance);
    start.volume = own;
    if start.leaf < 0 {
        // Out of its chunk's volume: pushed over a face by the crowd, or back over it after handing off. It takes the
        // chunk of the volume it's in now.
        start = NavChunkRouteEnd::NONE;
        snap_air(graphs, from, max_snap_distance, &mut start, false);
        if !start.in_air() {
            return FlightRouteEnds::Nowhere;
        }
        if chunks.find(graphs.volumes[start.volume as usize].chunk, graphs.agent_type, false).is_none() {
            return FlightRouteEnds::Nowhere;
        }
        own = start.volume;
    }
    let start_chunk = graphs.volumes[own as usize].chunk;

    // Outside every loaded chunk: toward the edge. Else in a loaded volume: a route if it's another chunk's.
    let to_edge = !graphs.air_frontier.is_empty() && !loaded(chunks, graphs.agent_type, goal_pos);
    let mut goal = NavChunkRouteEnd::NONE;
    if !to_edge {
        snap_air(graphs, goal_pos, max_snap_distance, &mut goal, false);
        if !goal.in_air() {
            snap_air(graphs, goal_pos, max_snap_distance, &mut goal, true); // on the ground: above it
        }
        if !goal.in_air() {
            return FlightRouteEnds::Ordinary { start_chunk, goal_placed: false };
        }
        if goal.volume == own {
            return FlightRouteEnds::Ordinary { start_chunk, goal_placed: true };
        }
    }
    FlightRouteEnds::Route { start, goal, to_edge, start_chunk }
}

/// The settings of a fly-only route search (`Locate`): unit flight cost, the agent's node budget once per chunk.
pub fn flight_route_params(max_search_nodes: i32, graphs: &RouteGraphs) -> NavHybridParams {
    NavHybridParams {
        flight_cost_multiplier: 1.0,
        max_nodes: max_search_nodes * graphs.budget_scale(),
        air_only: true,
        min_leaf_cost: graphs.leaf_cost_min(),
        ..NavHybridParams::default()
    }
}

/// A fly-only agent's route across volumes, searched whole.
#[derive(Clone, Debug, PartialEq)]
pub struct FlightRoute {
    pub status: NavPathStatus,
    pub at_edge: bool,
    pub to_edge: bool,
    pub nodes: usize,
    pub start_chunk: Hash128,
    pub legs: Vec<NavRouteLeg>,
}

impl FlightRoute {
    /// A route that leads somewhere (`NavFlightRouteWriter.Apply`'s test): legs, and more than one, or to the edge, or
    /// short of the goal. Otherwise the agent's ordinary flight stays as it is.
    pub fn leads_anywhere(&self) -> bool {
        let short_of_goal = !self.at_edge && self.status == NavPathStatus::Partial;
        self.status != NavPathStatus::InvalidInput && !self.legs.is_empty() && (self.at_edge || short_of_goal || self.legs.len() > 1)
    }

    /// The route's legs as the agent keeps them (`NavChunkLeg`). Each flyer then picks its own crossing of the first
    /// face and its own waiting point at the edge (the crossing module's `BestFace` / `EdgeWait`).
    pub fn chunk_legs(&self) -> Vec<NavChunkLeg> {
        self.legs.iter().map(|l| NavChunkLeg { chunk: l.chunk, overlay: false, end: l.end, exit_a: l.exit_a, exit_b: l.exit_b }).collect()
    }
}

/// Plans a fly-only agent's route across chunks at once ([`locate_flight_route`], then the route search with
/// [`flight_route_params`] and no ground filter). `None` for an ordinary flight or nothing to route (see
/// [`FlightRouteEnds`]); the runtime searches a slice per frame with [`route_search`] instead.
#[allow(clippy::too_many_arguments)]
pub fn find_flight_route(
    graphs: &RouteGraphs,
    chunks: &NavChunks,
    air_filters: &[NavVolumeQueryFilter],
    own_chunk: Hash128,
    from: Float3,
    goal_pos: Float3,
    max_snap_distance: f32,
    max_search_nodes: i32,
) -> Option<FlightRoute> {
    let FlightRouteEnds::Route { start, goal, to_edge, start_chunk } = locate_flight_route(graphs, chunks, own_chunk, from, goal_pos, max_snap_distance) else {
        return None;
    };
    let settings = flight_route_params(max_search_nodes, graphs);
    let ground = NavMeshQueryFilter::zeroed();
    let mut store = SearchListStore::default();
    let mut search = NavRouteAStar::default();
    let mut legs = Vec::new();
    if !route_search::begin(&mut search, &mut store, &ground, air_filters, &settings, &start, &goal, to_edge, goal_pos) {
        return Some(FlightRoute { status: NavPathStatus::InvalidInput, at_edge: false, to_edge, nodes: 0, start_chunk, legs });
    }
    while !route_search::step(&mut search, &mut store, graphs, &ground, air_filters, i32::MAX) {}
    let (status, at_edge) = route_search::finish(&search, &store, graphs, &mut legs);
    Some(FlightRoute { status, at_edge, to_edge, nodes: store.node_count(), start_chunk, legs })
}

// ---------------------------------------------------------------- route outcomes (NavRouteStats)

/// How route plans went, for the console report (`NavRouteStats`): counters indexed by the constants.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteStats {
    pub counts: [i32; RouteStats::COUNT],
}

impl RouteStats {
    pub const PLANNED: usize = 0;
    pub const TO_EDGE: usize = 1;
    pub const SHORT_OF_GOAL: usize = 2;
    pub const OUT_OF_BUDGET: usize = 3;
    pub const FAILED: usize = 4;
    pub const LEG_FAILED: usize = 5;
    pub const FLIGHT_LIMITED: usize = 6;
    pub const LANDED: usize = 7;
    pub const OVER_LIMIT: usize = 8;
    pub const LONGEST_FLIGHT: usize = 9;
    pub const EMERGENCY_LANDINGS: usize = 10;
    pub const EDGE_REPLANS: usize = 11;
    pub const DEAD_ENDS: usize = 12;
    pub const COUNT: usize = 13;

    pub fn add(&mut self, counter: usize) {
        self.counts[counter] += 1;
    }

    /// Raises a counter to `value` if it's lower.
    pub fn max(&mut self, counter: usize, value: i32) {
        self.counts[counter] = self.counts[counter].max(value);
    }

    /// True if `p` is within twice the reach (at least 20 m) of an opening at `edge`.
    pub fn near(p: Float3, edge: Float3, reach: f32) -> bool {
        p.distance(edge) <= (2.0 * reach).max(20.0)
    }

    /// True if the agent (at `p`) waits at its route's opening onto unloaded space (`edge`), within reach of it.
    pub fn waiting_at(p: Float3, edge: Float3, reach: f32) -> bool {
        Self::near(p, edge, reach)
    }

    /// A route that waited at an opening (`old_edge`) and was planned again after a load (`EdgeReplan`). Unchanged
    /// (still waiting at the same opening) counts nothing; otherwise it's an edge replan, and a dead end unless the new
    /// route goes through the opening (`through_opening`). `new_route` false: no route now, only a replan.
    pub fn edge_replan(&mut self, old_edge: Float3, new_route: bool, still_to_edge: bool, new_edge: Float3, through_opening: bool, reach: f32) {
        if new_route && still_to_edge && Self::near(new_edge, old_edge, reach) {
            return;
        }
        self.add(Self::EDGE_REPLANS);
        if new_route && !through_opening {
            self.add(Self::DEAD_ENDS);
        }
    }

    /// Counts one route search's outcome (`limited_flight`: the agent has a max flight distance) (`Record`).
    pub fn record(&mut self, status: NavPathStatus, at_edge: bool, nodes: usize, max_nodes: usize, limited_flight: bool) {
        self.add(Self::PLANNED);
        if status == NavPathStatus::InvalidInput {
            self.add(Self::FAILED);
        } else if at_edge {
            self.add(Self::TO_EDGE);
        } else if status == NavPathStatus::Partial {
            self.add(Self::SHORT_OF_GOAL);
            if nodes >= max_nodes {
                self.add(Self::OUT_OF_BUDGET);
            } else if limited_flight {
                self.add(Self::FLIGHT_LIMITED);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `NavChunkRouteTests.EdgeReplan_CountsReplansAndDeadEnds`.
    #[test]
    fn edge_replan_counts_replans_and_dead_ends() {
        let mut stats = RouteStats::default();
        let edge = Float3::new(0.0, 0.0, 0.0);

        stats.edge_replan(edge, true, true, Float3::new(3.0, 0.0, 0.0), true, 5.0);
        assert_eq!(stats.counts[RouteStats::EDGE_REPLANS], 0, "still waiting at the same opening");

        stats.edge_replan(edge, true, false, Float3::default(), true, 5.0);
        assert_eq!(stats.counts[RouteStats::EDGE_REPLANS], 1);
        assert_eq!(stats.counts[RouteStats::DEAD_ENDS], 0, "through the opening");

        stats.edge_replan(edge, true, false, Float3::default(), false, 5.0);
        assert_eq!(stats.counts[RouteStats::EDGE_REPLANS], 2);
        assert_eq!(stats.counts[RouteStats::DEAD_ENDS], 1, "elsewhere: a dead end");

        stats.edge_replan(edge, false, false, Float3::default(), false, 5.0);
        assert_eq!(stats.counts[RouteStats::EDGE_REPLANS], 3);
        assert_eq!(stats.counts[RouteStats::DEAD_ENDS], 1, "no route now: a replan only");

        assert!(RouteStats::waiting_at(Float3::new(15.0, 0.0, 0.0), edge, 5.0), "within 20 m (the minimum)");
        assert!(!RouteStats::waiting_at(Float3::new(25.0, 0.0, 0.0), edge, 5.0));
    }
}
