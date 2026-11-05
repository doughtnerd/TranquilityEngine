//! The route search of agents that walk and fly across loaded chunks (Foxfire's `NavRouteSearchCore.cs`), split so
//! it can run a slice at a time: [`begin`] sets it up, each [`step`] expands up to a number of nodes, [`finish`]
//! writes the legs. Its state between steps is a [`NavRouteAStar`] and a [`SearchStore`], so it can run over several
//! frames on a pooled store, or to the end at once ([`crate::hybrid::find_chunk_route`]).
//!
//! A joint A* over (graph, polygon) and (volume, leaf, label) nodes, in phases by node: on the ground it crosses
//! within a graph by the navmesh's links and between graphs by [`crate::route_graph::NavGraphLink`]s, in the air
//! between leaves and across seams by [`crate::route_graph::NavAirLink`]s; takeoffs and landings use each chunk's
//! landing links (and those moved onto overlays); a frontier node stands for unloaded space. Costs and the flight
//! budget's labels are [`crate::hybrid`]'s.
use crate::filter::NavMeshQueryFilter;
use crate::hybrid::{raised, NavHybridParams, LABELS_PER_LEAF};
use crate::pathfinding::{poly_usable, travel_multiplier, try_link, NavPathStatus};
use crate::route_graph::{key, RouteGraphs};
use crate::search::{NavRouteVia, SearchNode, SearchOpen, SearchStore};
use crate::volume::NavVolumeQueryFilter;
use nav_format::{NavLandingLink, NavMeshData, NavVolumeData};
use nav_math::math::{min, saturate};
use nav_math::{Float3, Hash128};

/// `NavRouteLegKind`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavRouteLegKind {
    #[default]
    Walk = 0,
    Fly = 1,
}

/// One leg of a route: a walk or a flight, ending at `end` (`NavRouteLeg`). A walk that ends at a takeoff is
/// followed by a rise to `next_start` (the takeoff link's raised air point); a flight that ends at a landing by a
/// descent to `next_start` (the landing link's ground point). The last leg ends at the goal.
///
/// Across chunks, a leg runs on chunk `chunk`'s navmesh (or its overlay's, `overlay`) or flight volume, and a leg
/// followed by one of the same kind ends where the route crosses into the next chunk: on the seam link
/// `exit_a`-`exit_b` (a polygon edge on the ground, a rectangle on the face in the air). `chunk` is unset on routes
/// within one chunk.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavRouteLeg {
    pub kind: NavRouteLegKind,
    pub end: Float3,
    /// Surface normal at `end` (walk), world up (flight).
    pub end_up: Float3,
    pub next_start: Float3,
    /// Surface normal at `next_start` (after a landing), world up (after a takeoff).
    pub next_up: Float3,
    pub chunk: Hash128,
    pub overlay: bool,
    pub exit_a: Float3,
    pub exit_b: Float3,
}

/// One end of a route across chunks for an agent that walks and flies: on a graph's polygon (`graph`, `poly`), in a
/// volume's leaf (`volume`, `leaf`), or both. `poly` / `leaf` are -1 where it isn't (`NavChunkRouteEnd`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavChunkRouteEnd {
    pub graph: i32,
    pub poly: i32,
    pub ground_pos: Float3,
    pub volume: i32,
    pub leaf: i32,
    pub air_pos: Float3,
}

impl Default for NavChunkRouteEnd {
    fn default() -> Self {
        Self::NONE
    }
}

impl NavChunkRouteEnd {
    pub const NONE: Self = Self { graph: -1, poly: -1, ground_pos: Float3::new(0.0, 0.0, 0.0), volume: -1, leaf: -1, air_pos: Float3::new(0.0, 0.0, 0.0) };

    #[inline]
    pub fn on_ground(&self) -> bool {
        self.poly >= 0
    }
    #[inline]
    pub fn in_air(&self) -> bool {
        self.leaf >= 0
    }
}

/// The frontier node's space.
pub const EDGE_SPACE: i32 = -1;
const HEURISTIC_SCALE: f32 = 0.999;

/// The state of one route search between steps (`NavRouteAStar`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavRouteAStar {
    pub settings: NavHybridParams,
    pub goal: NavChunkRouteEnd,
    /// `to_edge`: the goal in unloaded space.
    pub goal_pos: Float3,
    pub to_edge: bool,
    pub labels: i32,
    pub max_nodes: i32,
    pub h_scale: f32,
    /// The cheapest cost per metre anywhere: the straight line through unloaded space.
    pub cheapest: f32,
    pub start_on_ground: bool,
    /// The goal node once found (-1 before), whether it was a landing, the node nearest the goal so far.
    pub found: i32,
    pub landed: bool,
    pub finished: bool,
    pub best_node: i32,
    pub best_h: f32,
}

impl NavRouteAStar {
    pub fn is_goal(&self, ground: bool, space: i32, item: i32) -> bool {
        if space == EDGE_SPACE {
            return self.to_edge;
        }
        if self.to_edge {
            return false;
        }
        if ground {
            space == self.goal.graph && item == self.goal.poly
        } else {
            space == self.goal.volume && item == self.goal.leaf
        }
    }

    /// Straight-line distance to the goal (the nearer of its ends).
    pub fn goal_distance(&self, p: Float3) -> f32 {
        if self.to_edge {
            return p.distance(self.goal_pos);
        }
        let mut d = f32::MAX;
        if self.goal.on_ground() {
            d = p.distance(self.goal.ground_pos);
        }
        if self.goal.in_air() {
            d = min(d, p.distance(self.goal.air_pos));
        }
        d
    }

    /// Like `find_path`, entering the goal polygon costs the last stretch to the goal position.
    pub fn ground_goal_cost(&self, nav: &NavMeshData, graph: i32, poly: i32, land: Float3, filter: &NavMeshQueryFilter) -> f32 {
        if !self.is_goal(true, graph, poly) {
            return 0.0;
        }
        land.distance(self.goal.ground_pos) * travel_multiplier(nav, poly, filter)
    }

    pub fn heuristic(&self, ground: bool, space: i32, item: i32, pos: Float3) -> f32 {
        if self.is_goal(ground, space, item) {
            0.0
        } else {
            self.goal_distance(pos) * self.h_scale
        }
    }

    pub fn air_key(&self, volume: i32, leaf: i32, slot: i32) -> i64 {
        key(-2 - volume, leaf * self.labels + slot)
    }
}

/// Starts a search: empties the store and offers the start (`Begin`). False (`InvalidInput`) if `start` is nowhere,
/// or `goal` is nowhere and `to_edge` is false (and it isn't a nearest-landing search). For a
/// [`crate::search::SearchBufferStore`], call its `begin()` first so its key table's stamp is new.
#[allow(clippy::too_many_arguments)]
pub fn begin<S: SearchStore>(
    s: &mut NavRouteAStar,
    store: &mut S,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    settings: &NavHybridParams,
    start: &NavChunkRouteEnd,
    goal: &NavChunkRouteEnd,
    to_edge: bool,
    goal_pos: Float3,
) -> bool {
    store.clear();
    *s = NavRouteAStar { found: -1, finished: true, ..NavRouteAStar::default() };
    if !start.on_ground() && !start.in_air() {
        return false;
    }
    if !to_edge && !settings.nearest_landing && !goal.on_ground() && !goal.in_air() {
        return false;
    }

    let limited = settings.max_flight_distance > 0.0;
    let mut min_air = f32::MAX;
    for f in air_filters {
        min_air = min(min_air, if f.area_cost_count == 0 { 1.0 } else { f.min_area_cost });
    }
    if air_filters.is_empty() {
        min_air = 1.0;
    }
    let cheapest_air = settings.flight_cost_multiplier * min_air;

    s.settings = *settings;
    s.goal = *goal;
    s.goal_pos = goal_pos;
    s.to_edge = to_edge;
    s.labels = if limited { LABELS_PER_LEAF } else { 1 };
    s.max_nodes = settings.max_nodes.max(1);
    s.cheapest = if settings.air_only { cheapest_air } else { min(ground_filter.cheapest_travel(), cheapest_air) };
    s.h_scale = if settings.nearest_landing { 0.0 } else { HEURISTIC_SCALE * s.cheapest };
    s.start_on_ground = start.on_ground();
    s.finished = false;

    if start.on_ground() {
        offer(s, store, start.graph, start.poly, -1, NavRouteVia::Start, 0, 0.0, 0.0, start.ground_pos);
    } else {
        let air = if limited { settings.flown_so_far } else { 0.0 };
        offer_air(s, store, start.volume, start.leaf, -1, NavRouteVia::Start, 0, 0.0, 0.0, air, start.air_pos);
    }

    // Where a Partial route ends: the node nearest the goal (only on the ground with land_when_short, if any is).
    s.best_node = 0;
    s.best_h = if settings.land_when_short && !start.on_ground() { f32::MAX } else { s.goal_distance(store.get_node(0).pos) };
    true
}

/// Expands up to `max_nodes` nodes (`Step`). True once the search is over: the goal (or the frontier, or the nearest
/// landing) is reached, or the open set is empty (the node budget ends it that way too).
pub fn step<S: SearchStore>(
    s: &mut NavRouteAStar,
    store: &mut S,
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    max_nodes: i32,
) -> bool {
    let mut expanded = 0;
    while !s.finished && expanded < max_nodes {
        if store.open_count() == 0 {
            s.finished = true;
            break;
        }

        let item = store.pop();
        let mut cur = store.get_node(item.node);
        if cur.closed() || item.f > cur.f {
            continue;
        }
        cur.set_closed(true);
        store.set_node(item.node, cur);
        expanded += 1;

        if s.settings.nearest_landing && cur.ground() {
            s.found = item.node; // the cheapest ground to reach (no heuristic: this is Dijkstra)
            s.landed = true;
            s.finished = true;
            break;
        }

        if s.is_goal(cur.ground(), cur.space, cur.item) {
            s.found = item.node;
            s.finished = true;
            break;
        }

        let h_cur = s.goal_distance(cur.pos);
        if h_cur < s.best_h && (cur.ground() || !s.settings.land_when_short) {
            s.best_h = h_cur;
            s.best_node = item.node;
        }

        if cur.ground() {
            expand_ground(s, store, graphs, ground_filter, air_filters, item.node);
        } else {
            expand_air(s, store, graphs, ground_filter, air_filters, item.node);
        }
    }
    s.finished
}

/// Writes the finished search's legs (cleared first) (`Finish`). Returns the status and whether the route ends at the
/// edge of loaded space. Success: it reached the goal. Partial: it ends where the search got closest, at the nearest
/// landing, or at the edge.
pub fn finish<S: SearchStore>(s: &NavRouteAStar, store: &S, graphs: &RouteGraphs, legs: &mut Vec<NavRouteLeg>) -> (NavPathStatus, bool) {
    legs.clear();
    let mut at_edge = false;
    let mut last = if s.found >= 0 { s.found } else { s.best_node };
    let reached = s.found >= 0 && !s.landed; // a landing ends at the node, not the goal
    let mut edge_point = Float3::default(); // the last leg is a walk or flight by the frontier node's parent
    if reached && s.to_edge {
        at_edge = true;
        edge_point = store.get_node(s.found).pos;
        last = store.get_node(s.found).parent; // the frontier node is no polygon: the route ends on its parent's
    }

    write_legs(graphs, store, last, reached, at_edge, edge_point, &s.goal, s.settings.takeoff_height, legs);
    let status = if reached && !s.to_edge { NavPathStatus::Success } else { NavPathStatus::Partial };
    (status, at_edge)
}

// ---------------------------------------------------------------- expansion

fn expand_ground<S: SearchStore>(
    s: &mut NavRouteAStar,
    store: &mut S,
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    node_index: i32,
) {
    let cur = store.get_node(node_index);
    let settings = s.settings;
    let g = cur.space;
    let poly = cur.item;
    let graph = &graphs.graphs[g as usize];
    let nav = &*graph.nav;
    let filter = graphs.filter_for(g, ground_filter);
    let travel_mul = travel_multiplier(nav, poly, &filter);
    let p = nav.polys[poly as usize];

    // Navmesh links, priced as walking pathfinding prices them.
    for l in 0..p.link_count {
        let link_index = p.link_start + l;
        let Some((mut cost, dist, land)) = try_link(nav, link_index, cur.pos, cur.dist, travel_mul, &filter, false, 0.0) else { continue };
        let to = nav.links[link_index as usize].to_poly;
        cost += s.ground_goal_cost(nav, g, to, land, &filter);
        offer(s, store, g, to, node_index, NavRouteVia::NavLink, link_index, cur.g + cost, dist, land);
    }

    // Across graphs: seams and overlay joins, walked to the portal's middle.
    for &x in graphs.links_from.get(key(g, poly)) {
        let link = graphs.links[x as usize];
        let to_nav = &*graphs.graphs[link.to_graph as usize].nav;
        let to_filter = graphs.filter_for(link.to_graph, ground_filter);
        if !poly_usable(to_nav, link.to_poly, &to_filter) {
            continue;
        }
        let walk = cur.pos.distance((link.a0 + link.a1) * 0.5);
        let land = (link.b0 + link.b1) * 0.5;
        let cost = walk * travel_mul + s.ground_goal_cost(to_nav, link.to_graph, link.to_poly, land, &to_filter);
        offer(s, store, link.to_graph, link.to_poly, node_index, NavRouteVia::Cross, x, cur.g + cost, cur.dist + walk, land);
    }

    // Takeoffs: walk to the link's ground point, rise to its air point (the chunk's own navmesh only).
    let v = graph.volume;
    if v >= 0 && !settings.air_only {
        let rv = &graphs.volumes[v as usize];
        let volume = &*rv.volume;
        let links = rv.links.as_ref().expect("a graph's volume has landing links");
        let air_filter = air_filters[v as usize];
        let limited = settings.max_flight_distance > 0.0;
        for i in links.poly_start[poly as usize]..links.poly_start[poly as usize + 1] {
            let link = &links.links[i as usize];
            if link.slope_cos < settings.min_landing_slope_cos {
                continue;
            }
            let area = volume.leaves[link.leaf as usize].area as i32;
            if air_filter.excluded(area) {
                continue;
            }

            let walk = cur.pos.distance(link.ground);
            let rise = link.ground.distance(link.air) + lift(volume, link, settings.takeoff_height);
            let air = if limited { rise } else { 0.0 };
            if limited && air > settings.max_flight_distance {
                continue;
            }
            let mut cost = walk * travel_mul + settings.takeoff_cost + rise * air_filter.cost(area) * settings.flight_cost_multiplier;
            if s.is_goal(false, v, link.leaf) {
                let last = link.air.distance(s.goal.air_pos);
                if limited && air + last > settings.max_flight_distance {
                    continue;
                }
                cost += last * air_filter.cost(area) * settings.flight_cost_multiplier;
            }

            offer_air(s, store, v, link.leaf, node_index, NavRouteVia::Takeoff, i, cur.g + cost, cur.dist + walk + rise, air, link.air);
        }
    }

    // Takeoffs from an overlay: the chunk's links whose polygons it replaced, moved onto it.
    if graph.overlay {
        let limited = settings.max_flight_distance > 0.0;
        for &o in graphs.overlay_landings_by_poly.get(key(g, poly)) {
            let landing = graphs.overlay_landings[o as usize];
            let ov = landing.volume;
            let rv = &graphs.volumes[ov as usize];
            let volume = &*rv.volume;
            let link = &rv.links.as_ref().expect("overlay landings come from landing links").links[landing.link as usize];
            if link.slope_cos < settings.min_landing_slope_cos {
                continue;
            }
            let air_filter = air_filters[ov as usize];
            let area = volume.leaves[link.leaf as usize].area as i32;
            if air_filter.excluded(area) {
                continue;
            }

            let walk = cur.pos.distance(landing.ground);
            let rise = landing.ground.distance(link.air) + lift(volume, link, settings.takeoff_height);
            let air = if limited { rise } else { 0.0 };
            if limited && air > settings.max_flight_distance {
                continue;
            }
            let mut cost = walk * travel_mul + settings.takeoff_cost + rise * air_filter.cost(area) * settings.flight_cost_multiplier;
            if s.is_goal(false, ov, link.leaf) {
                let last = link.air.distance(s.goal.air_pos);
                if limited && air + last > settings.max_flight_distance {
                    continue;
                }
                cost += last * air_filter.cost(area) * settings.flight_cost_multiplier;
            }

            offer_air(s, store, ov, link.leaf, node_index, NavRouteVia::OverlayTakeoff, o, cur.g + cost, cur.dist + walk + rise, air, link.air);
        }
    }

    // Into unloaded space: walk to the frontier edge's point nearest the goal, then a straight line on.
    if s.to_edge {
        for &f in graphs.frontier_from.get(key(g, poly)) {
            let edge = graphs.frontier[f as usize];
            let exit = closest_on_segment(s.goal_pos, edge.a, edge.b);
            let walk = cur.pos.distance(exit);
            let cost = walk * travel_mul + exit.distance(s.goal_pos) * s.cheapest;
            offer_edge(s, store, node_index, cur.g + cost, cur.dist + walk, exit);
        }
    }
}

fn expand_air<S: SearchStore>(
    s: &mut NavRouteAStar,
    store: &mut S,
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    node_index: i32,
) {
    let cur = store.get_node(node_index);
    let settings = s.settings;
    let v = cur.space;
    let leaf = cur.item;
    let rv = &graphs.volumes[v as usize];
    let volume = &*rv.volume;
    let air_filter = air_filters[v as usize];
    let limited = settings.max_flight_distance > 0.0;
    let budget = settings.max_flight_distance;
    let leaf_data = volume.leaves[leaf as usize];
    let leaf_cost = air_filter.cost(leaf_data.area as i32) * settings.flight_cost_multiplier;

    // Neighbouring leaves, entered at their point nearest the current position.
    for k in 0..leaf_data.neighbor_count {
        let nl = volume.neighbors[(leaf_data.neighbor_start + k) as usize];
        let next = volume.leaves[nl as usize];
        if air_filter.excluded(next.area as i32) {
            continue;
        }

        let mn = volume.origin + Float3::new(next.min.x as f32, next.min.y as f32, next.min.z as f32) * volume.cell_size;
        let mx = mn + Float3::splat(next.size as f32 * volume.cell_size);
        let inset = 0.01 * volume.cell_size;
        let pos = cur.pos.clamp(mn + Float3::splat(inset), mx - Float3::splat(inset));
        let d = cur.pos.distance(pos);
        let mut air = if limited { cur.air + d } else { 0.0 };
        let mut cost = d * leaf_cost;
        if s.is_goal(false, v, nl) {
            let last = pos.distance(s.goal.air_pos);
            air += if limited { last } else { 0.0 };
            cost += last * air_filter.cost(next.area as i32) * settings.flight_cost_multiplier;
        }

        if limited && air > budget {
            continue;
        }
        offer_air(s, store, v, nl, node_index, NavRouteVia::Neighbor, 0, cur.g + cost, cur.dist + d, air, pos);
    }

    // Across seams into the next chunk's volume, through the link's rectangle on the face.
    for &x in graphs.air_links_from.get(key(v, leaf)) {
        let link = graphs.air_links[x as usize];
        let to_volume = &*graphs.volumes[link.to_volume as usize].volume;
        let to_filter = air_filters[link.to_volume as usize];
        let to_area = to_volume.leaves[link.to_leaf as usize].area as i32;
        if to_filter.excluded(to_area) {
            continue;
        }

        let pos = cur.pos.clamp(link.min, link.max);
        let d = cur.pos.distance(pos);
        let mut air = if limited { cur.air + d } else { 0.0 };
        let mut cost = d * leaf_cost;
        if s.is_goal(false, link.to_volume, link.to_leaf) {
            let last = pos.distance(s.goal.air_pos);
            air += if limited { last } else { 0.0 };
            cost += last * to_filter.cost(to_area) * settings.flight_cost_multiplier;
        }

        if limited && air > budget {
            continue;
        }
        offer_air(s, store, link.to_volume, link.to_leaf, node_index, NavRouteVia::AirCross, x, cur.g + cost, cur.dist + d, air, pos);
    }

    // Into unloaded space: fly to the leaf's face rectangle at its point nearest the goal, then a straight line on.
    if s.to_edge {
        for &f in graphs.air_frontier_from.get(key(v, leaf)) {
            let edge = graphs.air_frontier[f as usize];
            let exit = s.goal_pos.clamp(edge.min, edge.max);
            let d = cur.pos.distance(exit);
            if limited && cur.air + d > budget {
                continue;
            }
            let cost = d * leaf_cost + exit.distance(s.goal_pos) * s.cheapest;
            offer_edge(s, store, node_index, cur.g + cost, cur.dist + d, exit);
        }
    }

    // Landings: fly to the link's air point, settle to its ground point on the chunk's own navmesh.
    let g = rv.graph;
    if settings.air_only || g < 0 {
        return; // fly-only, or no navmesh to land on
    }
    let nav = &*graphs.graphs[g as usize].nav;
    let filter = graphs.filter_for(g, ground_filter);
    let links = rv.links.as_ref().expect("a volume with a graph has landing links");
    for j in links.leaf_start[leaf as usize]..links.leaf_start[leaf as usize + 1] {
        let i = links.by_leaf[j as usize];
        let link = &links.links[i as usize];
        if link.slope_cos < settings.min_landing_slope_cos {
            continue;
        }
        if !poly_usable(nav, link.poly, &filter) {
            continue; // switched off: an overlay's tile
        }

        let d = cur.pos.distance(link.air) + link.air.distance(link.ground) + lift(volume, link, settings.takeoff_height);
        if limited && cur.air + d > budget {
            continue;
        }
        let cost = d * leaf_cost + settings.landing_cost + s.ground_goal_cost(nav, g, link.poly, link.ground, &filter);
        offer(s, store, g, link.poly, node_index, NavRouteVia::Landing, i, cur.g + cost, cur.dist + d, link.ground);
    }

    // Landings on an overlay: the chunk's links whose polygons it replaced, moved onto it.
    for &o in graphs.overlay_landings_by_leaf.get(key(v, leaf)) {
        let landing = graphs.overlay_landings[o as usize];
        let link = &links.links[landing.link as usize];
        if link.slope_cos < settings.min_landing_slope_cos {
            continue;
        }
        let overlay_nav = &*graphs.graphs[landing.graph as usize].nav;
        let overlay_filter = graphs.filter_for(landing.graph, ground_filter);
        if !poly_usable(overlay_nav, landing.poly, &overlay_filter) {
            continue;
        }

        let d = cur.pos.distance(link.air) + link.air.distance(landing.ground) + lift(volume, link, settings.takeoff_height);
        if limited && cur.air + d > budget {
            continue;
        }
        let cost = d * leaf_cost + settings.landing_cost + s.ground_goal_cost(overlay_nav, landing.graph, landing.poly, landing.ground, &overlay_filter);
        offer(s, store, landing.graph, landing.poly, node_index, NavRouteVia::OverlayLanding, o, cur.g + cost, cur.dist + d, landing.ground);
    }
}

fn lift(volume: &NavVolumeData, link: &NavLandingLink, height: f32) -> f32 {
    if height > 0.0 {
        raised(volume, link, height).y - link.air.y
    } else {
        0.0
    }
}

pub(crate) fn closest_on_segment(p: Float3, a: Float3, b: Float3) -> Float3 {
    let ab = b - a;
    let t = saturate((p - a).dot(ab) / ab.length_sq().max(1e-6));
    a + ab * t
}

// ---------------------------------------------------------------- labels

#[allow(clippy::too_many_arguments)]
fn offer<S: SearchStore>(s: &NavRouteAStar, store: &mut S, graph: i32, poly: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, dist: f32, pos: Float3) {
    let k = key(graph, poly);
    let f = g + s.heuristic(true, graph, poly, pos);
    if let Some(ni) = store.try_get_node(k) {
        if g >= store.get_node(ni).g {
            return;
        }
        replace(store, ni, parent, via, via_index, g, f, dist, 0.0, pos);
        return;
    }
    let node = SearchNode { flags: SearchNode::GROUND_FLAG, space: graph, item: poly, ..SearchNode::default() };
    add(s, store, k, node, parent, via, via_index, g, f, dist, 0.0, pos);
}

fn offer_edge<S: SearchStore>(s: &NavRouteAStar, store: &mut S, parent: i32, g: f32, dist: f32, pos: Float3) {
    let k = key(EDGE_SPACE, -1);
    if let Some(ni) = store.try_get_node(k) {
        if g >= store.get_node(ni).g {
            return;
        }
        replace(store, ni, parent, NavRouteVia::Edge, 0, g, g, dist, 0.0, pos);
        return;
    }
    let node = SearchNode { flags: SearchNode::GROUND_FLAG, space: EDGE_SPACE, item: -1, ..SearchNode::default() };
    add(s, store, k, node, parent, NavRouteVia::Edge, 0, g, g, dist, 0.0, pos);
}

/// A label for a leaf: dropped if one of the leaf's labels is at least as cheap with at most as much flown; otherwise
/// it replaces a label it beats on both, takes a free slot, or replaces the costliest label.
#[allow(clippy::too_many_arguments)]
fn offer_air<S: SearchStore>(
    s: &NavRouteAStar,
    store: &mut S,
    volume: i32,
    leaf: i32,
    parent: i32,
    via: NavRouteVia,
    via_index: i32,
    g: f32,
    dist: f32,
    air: f32,
    pos: Float3,
) {
    let f = g + s.heuristic(false, volume, leaf, pos);
    let mut free = -1;
    let mut beaten = -1;
    let mut costliest = -1;
    let mut costliest_g = f32::MIN;
    for slot in 0..s.labels {
        let Some(ni) = store.try_get_node(s.air_key(volume, leaf, slot)) else {
            if free < 0 {
                free = slot;
            }
            continue;
        };
        let n = store.get_node(ni);
        if n.g <= g && n.air <= air {
            return; // dominated
        }
        if beaten < 0 && n.g >= g && n.air >= air {
            beaten = ni;
        }
        if n.g > costliest_g {
            costliest_g = n.g;
            costliest = ni;
        }
    }

    if beaten >= 0 {
        replace(store, beaten, parent, via, via_index, g, f, dist, air, pos);
    } else if free >= 0 {
        let node = SearchNode { space: volume, item: leaf, slot: free as u8, ..SearchNode::default() };
        add(s, store, s.air_key(volume, leaf, free), node, parent, via, via_index, g, f, dist, air, pos);
    } else if costliest_g > g {
        replace(store, costliest, parent, via, via_index, g, f, dist, air, pos);
    }
}

#[allow(clippy::too_many_arguments)]
fn add<S: SearchStore>(
    s: &NavRouteAStar,
    store: &mut S,
    k: i64,
    mut node: SearchNode,
    parent: i32,
    via: NavRouteVia,
    via_index: i32,
    g: f32,
    f: f32,
    dist: f32,
    air: f32,
    pos: Float3,
) {
    if store.node_count() >= s.max_nodes as usize {
        return;
    }
    node.parent = parent;
    node.via = via;
    node.via_index = via_index;
    node.g = g;
    node.f = f;
    node.dist = dist;
    node.air = air;
    node.pos = pos;
    let idx = store.add_node(k, node);
    store.push(SearchOpen { f, node: idx });
}

#[allow(clippy::too_many_arguments)]
fn replace<S: SearchStore>(store: &mut S, ni: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, f: f32, dist: f32, air: f32, pos: Float3) {
    let mut n = store.get_node(ni);
    n.parent = parent;
    n.via = via;
    n.via_index = via_index;
    n.g = g;
    n.f = f;
    n.dist = dist;
    n.air = air;
    n.pos = pos;
    n.set_closed(false); // reopen: a cheaper (or less-flown) way here was found
    store.set_node(ni, n);
    store.push(SearchOpen { f, node: ni });
}

// ---------------------------------------------------------------- result

/// Walks back from node `last` and splits the route into legs at takeoffs, landings and chunk crossings. The last
/// leg ends at the goal if reached, on the frontier edge (`at_edge`), or where the search got closest.
#[allow(clippy::too_many_arguments)]
fn write_legs<S: SearchStore>(
    graphs: &RouteGraphs,
    store: &S,
    last: i32,
    reached: bool,
    at_edge: bool,
    edge_point: Float3,
    goal: &NavChunkRouteEnd,
    takeoff_height: f32,
    legs: &mut Vec<NavRouteLeg>,
) {
    let up = Float3::new(0.0, 1.0, 0.0);
    let mut chain = Vec::with_capacity(64);
    let mut n = last;
    while n >= 0 {
        chain.push(n);
        n = store.get_node(n).parent;
    }

    let first = store.get_node(*chain.last().expect("a route has its start"));
    let mut walking = first.ground();
    let mut space = first.space; // graph while walking, volume while flying
    let normal = |graph: i32, poly: i32| graphs.graphs[graph as usize].nav.polys[poly as usize].normal;
    let landing_link = |volume: i32, link: i32| graphs.volumes[volume as usize].links.as_ref().expect("landing links").links[link as usize];
    for c in (0..chain.len().saturating_sub(1)).rev() {
        let node = store.get_node(chain[c]);
        match node.via {
            NavRouteVia::Takeoff => {
                let rv = &graphs.volumes[node.space as usize];
                let link = landing_link(node.space, node.via_index);
                let mut leg = walk_leg(graphs, space, link.ground, normal(space, link.poly));
                leg.next_start = raised(&rv.volume, &link, takeoff_height);
                leg.next_up = up;
                legs.push(leg);
                walking = false;
                space = node.space;
            }
            NavRouteVia::Landing => {
                let rv = &graphs.volumes[space as usize];
                let link = landing_link(space, node.via_index);
                let mut leg = fly_leg(graphs, space, raised(&rv.volume, &link, takeoff_height));
                leg.next_start = link.ground;
                leg.next_up = normal(node.space, link.poly);
                legs.push(leg);
                walking = true;
                space = node.space;
            }
            NavRouteVia::OverlayTakeoff => {
                let landing = graphs.overlay_landings[node.via_index as usize];
                let rv = &graphs.volumes[node.space as usize];
                let link = landing_link(node.space, landing.link);
                let mut leg = walk_leg(graphs, space, landing.ground, normal(space, landing.poly));
                leg.next_start = raised(&rv.volume, &link, takeoff_height);
                leg.next_up = up;
                legs.push(leg);
                walking = false;
                space = node.space;
            }
            NavRouteVia::OverlayLanding => {
                let landing = graphs.overlay_landings[node.via_index as usize];
                let rv = &graphs.volumes[space as usize];
                let link = landing_link(space, landing.link);
                let mut leg = fly_leg(graphs, space, raised(&rv.volume, &link, takeoff_height));
                leg.next_start = landing.ground;
                leg.next_up = normal(node.space, landing.poly);
                legs.push(leg);
                walking = true;
                space = node.space;
            }
            NavRouteVia::Cross => {
                let link = graphs.links[node.via_index as usize];
                let mut leg = walk_leg(graphs, space, (link.a0 + link.a1) * 0.5, normal(space, link.from_poly));
                leg.next_start = (link.b0 + link.b1) * 0.5;
                leg.next_up = normal(link.to_graph, link.to_poly);
                leg.exit_a = link.a0;
                leg.exit_b = link.a1;
                legs.push(leg);
                space = node.space;
            }
            NavRouteVia::AirCross => {
                let link = graphs.air_links[node.via_index as usize];
                let mut leg = fly_leg(graphs, space, node.pos);
                leg.next_start = node.pos;
                leg.next_up = up;
                leg.exit_a = link.min;
                leg.exit_b = link.max;
                legs.push(leg);
                space = node.space;
            }
            _ => {}
        }
    }

    let end = store.get_node(last);
    let end_pos = if at_edge {
        edge_point
    } else if !reached {
        end.pos
    } else if walking {
        goal.ground_pos
    } else {
        goal.air_pos
    };
    let mut last_leg = if walking { walk_leg(graphs, space, end_pos, normal(space, end.item)) } else { fly_leg(graphs, space, end_pos) };
    last_leg.next_start = end_pos;
    last_leg.next_up = up;
    legs.push(last_leg);
}

fn walk_leg(graphs: &RouteGraphs, graph: i32, end: Float3, end_up: Float3) -> NavRouteLeg {
    let g = &graphs.graphs[graph as usize];
    NavRouteLeg { kind: NavRouteLegKind::Walk, end, end_up, chunk: g.chunk, overlay: g.overlay, ..NavRouteLeg::default() }
}

fn fly_leg(graphs: &RouteGraphs, volume: i32, end: Float3) -> NavRouteLeg {
    NavRouteLeg {
        kind: NavRouteLegKind::Fly,
        end,
        end_up: Float3::new(0.0, 1.0, 0.0),
        chunk: graphs.volumes[volume as usize].chunk,
        ..NavRouteLeg::default()
    }
}
