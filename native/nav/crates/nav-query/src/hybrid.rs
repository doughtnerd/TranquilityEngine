//! Routes for agents that walk and fly (Foxfire's `NavHybridPathfinding.cs` and `NavHybridChunkRouting.cs`).
//!
//! Within one chunk ([`find_route`]): one A* over a joint graph of navmesh polygons and flight volume leaves, joined
//! by takeoff/landing links. Walking costs what it costs on the navmesh (the same links, filter and costs as walking
//! pathfinding); flying costs distance times the leaf's area cost times `flight_cost_multiplier`; takeoffs and
//! landings add their flat costs. The flight budget (`max_flight_distance`) is carried on each search label as the
//! distance flown since the last takeoff; each leaf keeps up to [`LABELS_PER_LEAF`] labels that don't dominate each
//! other (with unlimited flight, one: plain A*). With a `takeoff_height`, takeoffs rise straight up from the link's
//! air point until that high above the ground (as far as the air is free), landings come down the same way, and
//! the search charges the climb and descent as flight.
//!
//! Across chunks ([`find_chunk_route`]): the same search over every graph and volume of the
//! [`RouteGraphs`], run by [`crate::route_search`]; fly-only agents (`air_only`) use it from and to the air.
//!
//! The result is legs: alternating walks and flights, each ending where the next one starts, or at the goal.
use crate::filter::NavMeshQueryFilter;
use crate::pathfinding::{find_nearest_poly, find_path, link_travel, poly_usable, travel_multiplier, try_link, NavMeshPathNode, NavPathStatus};
use crate::route_graph::RouteGraphs;
use crate::route_search::{self, NavChunkRouteEnd, NavRouteAStar, NavRouteLeg, NavRouteLegKind};
use crate::search::{NavRouteVia, SearchListStore, SearchNode, SearchOpen, SearchStore};
use crate::volume::{cell_size_at, leaf_at, LeafCosts, NavVolumeQueryFilter};
use nav_format::{NavLandingLink, NavLandingLinksData, NavMeshData, NavVolumeData};
use nav_math::math::min;
use nav_math::Float3;

/// How an agent that walks and flies weighs flying against walking (`NavHybridParams`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavHybridParams {
    /// Per unit of distance flown, times the leaf's area cost.
    pub flight_cost_multiplier: f32,
    /// Flat, per takeoff.
    pub takeoff_cost: f32,
    /// Flat, per landing.
    pub landing_cost: f32,
    /// Longest flight between takeoff and landing; 0 = unlimited.
    pub max_flight_distance: f32,
    /// Distance already flown, when the route starts in the air.
    pub flown_so_far: f32,
    /// Cos of the steepest floor the agent takes off from or lands on.
    pub min_landing_slope_cos: f32,
    /// Flights start and end this high above the ground, as far as the air is free.
    pub takeoff_height: f32,
    /// Search budget.
    pub max_nodes: i32,
    /// Fly-only agents (routes across chunks): no takeoffs or landings.
    pub air_only: bool,
    /// A Partial route ends on the ground nearest the goal (`LandWhenOutOfReach`).
    pub land_when_short: bool,
    /// Set by the nearest-landing searches: the route ends at the first ground reached, whatever the goal.
    pub nearest_landing: bool,
    /// Runtime cost volumes (ADR 0070): the cheapest leaf multiplier when below 1 (it lowers the air heuristic); None
    /// = 1.
    pub min_leaf_cost: Option<f32>,
}

impl NavHybridParams {
    /// What runtime cost volumes scale the air heuristic by.
    #[inline]
    pub fn leaf_cost_scale(&self) -> f32 {
        self.min_leaf_cost.map_or(1.0, |m| min(1.0, m))
    }
}

/// One end of a route within one chunk, on the navmesh, in the flight volume, or both: `poly` / `leaf` are -1 where
/// it isn't (`NavRouteEnd`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavRouteEnd {
    pub poly: i32,
    pub ground_pos: Float3,
    pub leaf: i32,
    pub air_pos: Float3,
}

impl Default for NavRouteEnd {
    fn default() -> Self {
        Self::NONE
    }
}

impl NavRouteEnd {
    pub const NONE: Self = Self { poly: -1, ground_pos: Float3::new(0.0, 0.0, 0.0), leaf: -1, air_pos: Float3::new(0.0, 0.0, 0.0) };

    #[inline]
    pub fn on_ground(&self) -> bool {
        self.poly >= 0
    }
    #[inline]
    pub fn in_air(&self) -> bool {
        self.leaf >= 0
    }
}

pub const LABELS_PER_LEAF: i32 = 4;
const HEURISTIC_SCALE: f32 = 0.999;

// ---------------------------------------------------------------- within one chunk

/// The search state of [`find_route`] (`NavHybridPathfinding.Search`). Keys: polygon p is p; leaf l, label s is
/// `poly_count + l * labels + s`. A node's `item` holds its key.
struct Search {
    store: SearchListStore,
    poly_count: i32,
    labels: i32,
    max_nodes: i32,
    goal: NavRouteEnd,
    h_scale: f32,
}

impl Search {
    fn goal_distance(&self, p: Float3) -> f32 {
        let mut d = f32::MAX;
        if self.goal.on_ground() {
            d = p.distance(self.goal.ground_pos);
        }
        if self.goal.in_air() {
            d = min(d, p.distance(self.goal.air_pos));
        }
        d
    }

    fn heuristic(&self, key: i32, pos: Float3) -> f32 {
        let is_goal = if key < self.poly_count { key == self.goal.poly } else { (key - self.poly_count) / self.labels == self.goal.leaf };
        if is_goal {
            0.0
        } else {
            self.goal_distance(pos) * self.h_scale
        }
    }

    /// A label for polygon `key`: kept if it's cheaper than the polygon's current one.
    #[allow(clippy::too_many_arguments)]
    fn offer(&mut self, key: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, dist: f32, air: f32, pos: Float3) {
        let f = g + self.heuristic(key, pos);
        if let Some(ni) = self.store.try_get_node(key as i64) {
            if g >= self.store.get_node(ni).g {
                return;
            }
            self.replace(ni, parent, via, via_index, g, f, dist, air, pos);
            return;
        }
        self.add(key, parent, via, via_index, g, f, dist, air, pos);
    }

    /// A label for `leaf`: dropped if one of the leaf's labels is at least as cheap with at most as much flown;
    /// otherwise it replaces a label it beats on both, takes a free slot, or replaces the costliest label.
    #[allow(clippy::too_many_arguments)]
    fn offer_air(&mut self, leaf: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, dist: f32, air: f32, pos: Float3) {
        let base_key = self.poly_count + leaf * self.labels;
        let f = g + self.heuristic(base_key, pos);
        let mut free = -1;
        let mut beaten = -1;
        let mut costliest = -1;
        let mut costliest_g = f32::MIN;
        for s in 0..self.labels {
            let Some(ni) = self.store.try_get_node((base_key + s) as i64) else {
                if free < 0 {
                    free = s;
                }
                continue;
            };
            let n = self.store.get_node(ni);
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
            self.replace(beaten, parent, via, via_index, g, f, dist, air, pos);
        } else if free >= 0 {
            self.add(base_key + free, parent, via, via_index, g, f, dist, air, pos);
        } else if costliest_g > g {
            self.replace(costliest, parent, via, via_index, g, f, dist, air, pos);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, key: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, f: f32, dist: f32, air: f32, pos: Float3) {
        if self.store.node_count() >= self.max_nodes as usize {
            return;
        }
        let node = SearchNode { item: key, parent, via, via_index, g, f, dist, air, pos, ..SearchNode::default() };
        let idx = self.store.add_node(key as i64, node);
        self.store.push(SearchOpen { f, node: idx });
    }

    #[allow(clippy::too_many_arguments)]
    fn replace(&mut self, ni: i32, parent: i32, via: NavRouteVia, via_index: i32, g: f32, f: f32, dist: f32, air: f32, pos: Float3) {
        let mut n = self.store.get_node(ni);
        n.parent = parent;
        n.via = via;
        n.via_index = via_index;
        n.g = g;
        n.f = f;
        n.dist = dist;
        n.air = air;
        n.pos = pos;
        n.set_closed(false); // reopen: a cheaper (or less-flown) way here was found
        self.store.set_node(ni, n);
        self.store.push(SearchOpen { f, node: ni });
    }
}

/// Finds a route from `start` to `goal` (either end on the ground, in the air, or both) and writes its legs
/// (`FindRoute`). Returns the status and the nodes the search created. Success: the route reaches the goal. Partial:
/// it ends where the search got closest (on the ground with `land_when_short`, if it reached any). InvalidInput:
/// `start` or `goal` is on neither the navmesh nor in the flight volume.
#[allow(clippy::too_many_arguments)]
pub fn find_route(
    nav: &NavMeshData,
    ground_filter: &NavMeshQueryFilter,
    volume: &NavVolumeData,
    air_filter: &NavVolumeQueryFilter,
    links: &NavLandingLinksData,
    settings: &NavHybridParams,
    start: &NavRouteEnd,
    goal: &NavRouteEnd,
    legs: &mut Vec<NavRouteLeg>,
) -> (NavPathStatus, usize) {
    find_route_with(nav, ground_filter, volume, air_filter, LeafCosts::NONE, links, settings, start, goal, legs)
}

/// [`find_route`] with runtime cost volumes' leaf multipliers (ADR 0070); the polygons' come in `ground_filter`.
#[allow(clippy::too_many_arguments)]
pub fn find_route_with(
    nav: &NavMeshData,
    ground_filter: &NavMeshQueryFilter,
    volume: &NavVolumeData,
    air_filter: &NavVolumeQueryFilter,
    leaves: LeafCosts,
    links: &NavLandingLinksData,
    settings: &NavHybridParams,
    start: &NavRouteEnd,
    goal: &NavRouteEnd,
    legs: &mut Vec<NavRouteLeg>,
) -> (NavPathStatus, usize) {
    legs.clear();
    if !start.on_ground() && !start.in_air() {
        return (NavPathStatus::InvalidInput, 0);
    }
    if !settings.nearest_landing && !goal.on_ground() && !goal.in_air() {
        return (NavPathStatus::InvalidInput, 0);
    }

    let poly_count = nav.polys.len() as i32;
    let limited = settings.max_flight_distance > 0.0;
    let labels = if limited { LABELS_PER_LEAF } else { 1 };
    let h_scale = if settings.nearest_landing {
        0.0
    } else {
        HEURISTIC_SCALE
            * min(
                ground_filter.cheapest_travel(),
                settings.flight_cost_multiplier * (if air_filter.area_cost_count == 0 { 1.0 } else { air_filter.min_area_cost }) * leaves.scale(),
            )
    };

    let mut search = Search { store: SearchListStore::default(), poly_count, labels, max_nodes: settings.max_nodes.max(1), goal: *goal, h_scale };

    // Start: on the ground if the agent stands there, in the air if it flies.
    if start.on_ground() {
        search.offer(start.poly, -1, NavRouteVia::Start, 0, 0.0, 0.0, 0.0, start.ground_pos);
    } else {
        let air = if limited { settings.flown_so_far } else { 0.0 };
        search.offer_air(start.leaf, -1, NavRouteVia::Start, 0, 0.0, 0.0, air, start.air_pos);
    }

    // Where a Partial route ends: the node nearest the goal (only on the ground with land_when_short, if any is).
    let mut found = -1;
    let mut landed = false;
    let mut best_node = 0;
    let mut best_h = if settings.land_when_short && !start.on_ground() { f32::MAX } else { search.goal_distance(search.store.get_node(0).pos) };

    while search.store.open_count() > 0 {
        let item = search.store.pop();
        let mut cur = search.store.get_node(item.node);
        if cur.closed() || item.f > cur.f {
            continue;
        }
        cur.set_closed(true);
        search.store.set_node(item.node, cur);

        let ground = cur.item < poly_count;
        let poly = if ground { cur.item } else { -1 };
        let leaf = if ground { -1 } else { (cur.item - poly_count) / labels };
        if settings.nearest_landing && ground {
            found = item.node; // the cheapest ground to reach (no heuristic: this is Dijkstra)
            landed = true;
            break;
        }

        if (ground && poly == goal.poly) || (!ground && leaf == goal.leaf) {
            found = item.node;
            break;
        }

        let h_cur = search.goal_distance(cur.pos);
        if h_cur < best_h && (ground || !settings.land_when_short) {
            best_h = h_cur;
            best_node = item.node;
        }

        if ground {
            expand_ground(nav, ground_filter, volume, air_filter, leaves, links, settings, &mut search, item.node, poly);
        } else {
            expand_air(nav, ground_filter, volume, air_filter, leaves, links, settings, &mut search, item.node, leaf);
        }
    }

    let last = if found >= 0 { found } else { best_node };
    let reached = found >= 0 && !landed;
    write_legs(nav, volume, links, settings.takeoff_height, &search.store, last, reached, poly_count, goal, legs);
    let status = if reached { NavPathStatus::Success } else { NavPathStatus::Partial };
    (status, search.store.node_count())
}

/// A route from `start` (in the air) down to the nearest place it can land, ignoring `max_flight_distance` and any
/// goal: for an agent whose flight can't reach the ground within its limit (`LandWhenOutOfReach`). Partial, ending
/// on the ground; or where it is, if no landing link is reachable at all (`FindNearestLanding`).
#[allow(clippy::too_many_arguments)]
pub fn find_nearest_landing(
    nav: &NavMeshData,
    ground_filter: &NavMeshQueryFilter,
    volume: &NavVolumeData,
    air_filter: &NavVolumeQueryFilter,
    links: &NavLandingLinksData,
    settings: &NavHybridParams,
    start: &NavRouteEnd,
    legs: &mut Vec<NavRouteLeg>,
) -> NavPathStatus {
    let landing = NavHybridParams { max_flight_distance: 0.0, land_when_short: false, nearest_landing: true, ..*settings };
    find_route(nav, ground_filter, volume, air_filter, links, &landing, start, &NavRouteEnd::NONE, legs).0
}

#[allow(clippy::too_many_arguments)]
fn expand_ground(
    nav: &NavMeshData,
    ground_filter: &NavMeshQueryFilter,
    volume: &NavVolumeData,
    air_filter: &NavVolumeQueryFilter,
    leaves: LeafCosts,
    links: &NavLandingLinksData,
    settings: &NavHybridParams,
    search: &mut Search,
    node_index: i32,
    poly: i32,
) {
    let cur = search.store.get_node(node_index);
    let travel_mul = travel_multiplier(nav, poly, ground_filter);
    let p = nav.polys[poly as usize];

    // Navmesh links, priced exactly as walking pathfinding prices them (without congestion).
    for l in 0..p.link_count {
        let link_index = p.link_start + l;
        let Some((mut cost, dist, land)) = try_link(nav, link_index, cur.pos, cur.dist, travel_mul, ground_filter, false, 0.0) else { continue };
        let to = nav.links[link_index as usize].to_poly;
        if to == search.goal.poly {
            cost += land.distance(search.goal.ground_pos) * travel_multiplier(nav, to, ground_filter);
        }
        search.offer(to, node_index, NavRouteVia::NavLink, link_index, cur.g + cost, dist, 0.0, land);
    }

    // Takeoffs: walk to the link's ground point, rise to its air point.
    let limited = settings.max_flight_distance > 0.0;
    for i in links.poly_start[poly as usize]..links.poly_start[poly as usize + 1] {
        let link = &links.links[i as usize];
        if link.slope_cos < settings.min_landing_slope_cos {
            continue;
        }
        let area = volume.leaves[link.leaf as usize].area as i32;
        if air_filter.excluded(area) || leaves.excluded(link.leaf) {
            continue;
        }
        let area_cost = air_filter.cost(area) * leaves.cost(link.leaf);

        let walk = cur.pos.distance(link.ground);
        let rise = link.ground.distance(link.air) + lift(volume, link, settings.takeoff_height);
        let air = if limited { rise } else { 0.0 };
        if limited && air > settings.max_flight_distance {
            continue;
        }
        let mut cost = walk * travel_mul + settings.takeoff_cost + rise * area_cost * settings.flight_cost_multiplier;
        if link.leaf == search.goal.leaf {
            let last = link.air.distance(search.goal.air_pos);
            if limited && air + last > settings.max_flight_distance {
                continue;
            }
            cost += last * area_cost * settings.flight_cost_multiplier;
        }

        search.offer_air(link.leaf, node_index, NavRouteVia::Takeoff, i, cur.g + cost, cur.dist + walk + rise, air, link.air);
    }
}

#[allow(clippy::too_many_arguments)]
fn expand_air(
    nav: &NavMeshData,
    ground_filter: &NavMeshQueryFilter,
    volume: &NavVolumeData,
    air_filter: &NavVolumeQueryFilter,
    leaves: LeafCosts,
    links: &NavLandingLinksData,
    settings: &NavHybridParams,
    search: &mut Search,
    node_index: i32,
    leaf: i32,
) {
    let cur = search.store.get_node(node_index);
    let limited = settings.max_flight_distance > 0.0;
    let budget = settings.max_flight_distance;
    let leaf_data = volume.leaves[leaf as usize];
    let leaf_cost = air_filter.cost(leaf_data.area as i32) * leaves.cost(leaf) * settings.flight_cost_multiplier;

    // Neighbouring leaves, entered at their point nearest the current position (as flight pathfinding does).
    for k in 0..leaf_data.neighbor_count {
        let nl = volume.neighbors[(leaf_data.neighbor_start + k) as usize];
        let next = volume.leaves[nl as usize];
        if air_filter.excluded(next.area as i32) || leaves.excluded(nl) {
            continue;
        }

        let mn = volume.origin + Float3::new(next.min.x as f32, next.min.y as f32, next.min.z as f32) * volume.cell_size;
        let mx = mn + Float3::splat(next.size as f32 * volume.cell_size);
        let inset = 0.01 * volume.cell_size;
        let pos = cur.pos.clamp(mn + Float3::splat(inset), mx - Float3::splat(inset));
        let d = cur.pos.distance(pos);
        let mut air = if limited { cur.air + d } else { 0.0 };
        let mut cost = d * leaf_cost;
        if nl == search.goal.leaf {
            let last = pos.distance(search.goal.air_pos);
            air += if limited { last } else { 0.0 };
            cost += last * air_filter.cost(next.area as i32) * leaves.cost(nl) * settings.flight_cost_multiplier;
        }

        if limited && air > budget {
            continue;
        }
        search.offer_air(nl, node_index, NavRouteVia::Neighbor, 0, cur.g + cost, cur.dist + d, air, pos);
    }

    // Landings: fly to the link's air point (in this leaf), settle to its ground point.
    for j in links.leaf_start[leaf as usize]..links.leaf_start[leaf as usize + 1] {
        let i = links.by_leaf[j as usize];
        let link = &links.links[i as usize];
        if link.slope_cos < settings.min_landing_slope_cos {
            continue;
        }
        if !poly_usable(nav, link.poly, ground_filter) {
            continue;
        }

        let d = cur.pos.distance(link.air) + link.air.distance(link.ground) + lift(volume, link, settings.takeoff_height);
        if limited && cur.air + d > budget {
            continue;
        }
        let mut cost = d * leaf_cost + settings.landing_cost;
        if link.poly == search.goal.poly {
            cost += link.ground.distance(search.goal.ground_pos) * travel_multiplier(nav, link.poly, ground_filter);
        }
        search.offer(link.poly, node_index, NavRouteVia::Landing, i, cur.g + cost, cur.dist + d, 0.0, link.ground);
    }
}

/// Walks back from node `last` and splits the route into legs at its takeoffs and landings. The last leg ends at the
/// goal (its ground or air end, whichever was reached) if reached, else where the search got closest.
#[allow(clippy::too_many_arguments)]
fn write_legs(
    nav: &NavMeshData,
    volume: &NavVolumeData,
    links: &NavLandingLinksData,
    takeoff_height: f32,
    store: &SearchListStore,
    last: i32,
    reached: bool,
    poly_count: i32,
    goal: &NavRouteEnd,
    legs: &mut Vec<NavRouteLeg>,
) {
    let up = Float3::new(0.0, 1.0, 0.0);
    let mut chain = Vec::with_capacity(64);
    let mut n = last;
    while n >= 0 {
        chain.push(n);
        n = store.get_node(n).parent;
    }

    let mut walking = store.get_node(*chain.last().expect("a route has its start")).item < poly_count;
    for c in (0..chain.len().saturating_sub(1)).rev() {
        let node = store.get_node(chain[c]);
        if node.via == NavRouteVia::Takeoff {
            let link = &links.links[node.via_index as usize];
            legs.push(NavRouteLeg {
                kind: NavRouteLegKind::Walk,
                end: link.ground,
                end_up: nav.polys[link.poly as usize].normal,
                next_start: raised(volume, link, takeoff_height),
                next_up: up,
                ..NavRouteLeg::default()
            });
            walking = false;
        } else if node.via == NavRouteVia::Landing {
            let link = &links.links[node.via_index as usize];
            legs.push(NavRouteLeg {
                kind: NavRouteLegKind::Fly,
                end: raised(volume, link, takeoff_height),
                end_up: up,
                next_start: link.ground,
                next_up: nav.polys[link.poly as usize].normal,
                ..NavRouteLeg::default()
            });
            walking = true;
        }
    }

    let end = store.get_node(last);
    let end_pos = if !reached {
        end.pos
    } else if walking {
        goal.ground_pos
    } else {
        goal.air_pos
    };
    legs.push(NavRouteLeg {
        kind: if walking { NavRouteLegKind::Walk } else { NavRouteLegKind::Fly },
        end: end_pos,
        end_up: if walking { nav.polys[end.item as usize].normal } else { up },
        next_start: end_pos,
        next_up: up,
        ..NavRouteLeg::default()
    });
}

/// The point straight above a link's air point where flights start and end: up to `height` above the ground point,
/// as far as the air stays free (checked every half cell, at the cell size where it is) (`Raised`).
pub fn raised(volume: &NavVolumeData, link: &NavLandingLink, height: f32) -> Float3 {
    let top = link.ground.y + height;
    let mut p = link.air;
    let mut step = 0.5 * cell_size_at(volume, p);
    while p.y + step <= top {
        let next = p + Float3::new(0.0, step, 0.0);
        if leaf_at(volume, next) < 0 {
            break;
        }
        p = next;
        step = 0.5 * cell_size_at(volume, p);
    }
    p
}

/// How far [`raised`] lifts a link's air point.
fn lift(volume: &NavVolumeData, link: &NavLandingLink, height: f32) -> f32 {
    if height > 0.0 {
        raised(volume, link, height).y - link.air.y
    } else {
        0.0
    }
}

/// Walks flights the agent could as well walk (`WalkShortFlights`): each flight with walks on both sides whose
/// takeoff and landing ground points are joined on the navmesh by a walk at most `ratio` times the flight's length
/// (rise, flight and descent) is dropped, and the walks before and after it become one. Flights that start the route
/// (in the air) or end it (at an air goal) stay.
pub fn walk_short_flights(nav: &NavMeshData, ground_filter: &NavMeshQueryFilter, ratio: f32, snap_distance: f32, legs: &mut Vec<NavRouteLeg>) {
    if ratio <= 0.0 {
        return;
    }
    let mut corridor = Vec::with_capacity(64);
    let mut i = legs.len() as isize - 2;
    while i >= 1 {
        let u = i as usize;
        if legs[u].kind != NavRouteLegKind::Fly || legs[u - 1].kind != NavRouteLegKind::Walk || legs[u + 1].kind != NavRouteLegKind::Walk {
            i -= 1;
            continue;
        }

        let from = legs[u - 1].end; // takeoff ground point
        let to = legs[u].next_start; // landing ground point
        let flight = from.distance(legs[u - 1].next_start) + legs[u - 1].next_start.distance(legs[u].end) + legs[u].end.distance(to);
        if walkable_within(nav, ground_filter, from, to, ratio * flight, snap_distance, &mut corridor) {
            legs.drain(u - 1..u + 1); // the walk to the takeoff and the flight: the walk after them starts there
            i -= 1;
        }
        i -= 1;
    }
}

/// True if a walk on `nav` joins `from` and `to` (each snapped within `snap_distance`) and is at most `limit` long.
fn walkable_within(
    nav: &NavMeshData,
    filter: &NavMeshQueryFilter,
    from: Float3,
    to: Float3,
    limit: f32,
    snap_distance: f32,
    corridor: &mut Vec<NavMeshPathNode>,
) -> bool {
    let Some((a, start)) = find_nearest_poly(nav, from, snap_distance, filter) else { return false };
    let Some((b, end)) = find_nearest_poly(nav, to, snap_distance, filter) else { return false };
    if find_path(nav, a, start, b, end, filter, corridor) != NavPathStatus::Success {
        return false;
    }
    walk_length(nav, corridor, start, end) <= limit
}

/// A corridor's length, measured the way A* measures it (`link_travel`) (`WalkLength`).
pub fn walk_length(nav: &NavMeshData, corridor: &[NavMeshPathNode], start: Float3, end: Float3) -> f32 {
    let mut prev = start;
    let mut length = 0.0;
    for node in corridor.iter().skip(1) {
        let (walk, crossing, land) = link_travel(&nav.links[node.link as usize], prev);
        prev = land;
        length += walk + crossing;
    }
    length + prev.distance(end)
}

// ---------------------------------------------------------------- across chunks (NavHybridChunkRouting)

/// What a route search across chunks gave: its status, whether it ends at the edge of loaded space, and the nodes it
/// used (`settings.max_nodes`: it ran out of budget).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkRouteResult {
    pub status: NavPathStatus,
    pub at_edge: bool,
    pub nodes: usize,
}

/// A route from `start` to `goal` across the loaded graphs and volumes (`NavHybridChunkRouting.FindRoute`).
/// `air_filters` holds one filter per volume (`graphs.volumes`); `ground_filter` is shared by the graphs, each adding
/// its gates and switched-off polygons ([`RouteGraphs::filter_for`]). With `to_edge`, the goal is `goal_pos` in
/// unloaded space: the route ends on a frontier edge or air frontier rectangle (`at_edge`) and `goal` is ignored.
/// Runs [`route_search`] to the end at once on a list store.
#[allow(clippy::too_many_arguments)]
pub fn find_chunk_route(
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    settings: &NavHybridParams,
    start: &NavChunkRouteEnd,
    goal: &NavChunkRouteEnd,
    to_edge: bool,
    goal_pos: Float3,
    legs: &mut Vec<NavRouteLeg>,
) -> ChunkRouteResult {
    legs.clear();
    let mut store = SearchListStore::default();
    let mut search = NavRouteAStar::default();
    let mut result = ChunkRouteResult { status: NavPathStatus::InvalidInput, at_edge: false, nodes: 0 };
    if route_search::begin(&mut search, &mut store, ground_filter, air_filters, settings, start, goal, to_edge, goal_pos) {
        while !route_search::step(&mut search, &mut store, graphs, ground_filter, air_filters, i32::MAX) {}
        let (status, at_edge) = route_search::finish(&search, &store, graphs, legs);
        result = ChunkRouteResult { status, at_edge, nodes: store.node_count() };
    }
    result
}

/// A route from `start` (in the air) down to the nearest place it can land on any loaded chunk, ignoring
/// `max_flight_distance` and any goal (`NavHybridChunkRouting.FindNearestLanding`).
pub fn find_chunk_nearest_landing(
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    air_filters: &[NavVolumeQueryFilter],
    settings: &NavHybridParams,
    start: &NavChunkRouteEnd,
    legs: &mut Vec<NavRouteLeg>,
) -> NavPathStatus {
    let landing = NavHybridParams { max_flight_distance: 0.0, land_when_short: false, nearest_landing: true, ..*settings };
    find_chunk_route(graphs, ground_filter, air_filters, &landing, start, &NavChunkRouteEnd::NONE, false, Float3::default(), legs).status
}

/// Where a flight into the next chunk aims (`FacePoint`): the point of seam rectangle `a`-`b` (flat on the face)
/// nearest `p`, kept `radius` in from its edges (its middle on an axis where it's narrower), and nudged a little off
/// the face toward `p`, so it lies inside the volume the flyer is in. `fallback` if the rectangle is unset.
pub fn face_point(a: Float3, b: Float3, p: Float3, radius: f32, fallback: Float3) -> Float3 {
    const NUDGE: f32 = 0.05;
    let lo = a.min_v(b);
    let hi = a.max_v(b);
    let size = hi - lo;
    if size.lt(Float3::splat(1e-4)).all() {
        return fallback;
    }
    let inset = Float3::splat(radius).min_v(size * 0.5);
    let mut point = p.clamp(lo + inset, hi - inset);
    for axis in [0, 2] {
        // the face is flat along x or z
        if size[axis] < 1e-4 {
            point[axis] += if p[axis] < lo[axis] { -NUDGE } else { NUDGE };
        }
    }
    point
}

/// [`walk_short_flights`] for routes across chunks (`NavHybridChunkRouting.WalkShortFlights`): a flight within one
/// chunk, between walks on that chunk's own navmesh, is dropped when walking between its takeoff and landing is at
/// most `ratio` times as long. `only_graph`: the graph every leg is on (a route within one chunk); -1 to find it by
/// the leg's chunk.
pub fn walk_short_chunk_flights(
    graphs: &RouteGraphs,
    ground_filter: &NavMeshQueryFilter,
    ratio: f32,
    snap_distance: f32,
    legs: &mut Vec<NavRouteLeg>,
    only_graph: i32,
) {
    if ratio <= 0.0 {
        return;
    }
    let mut corridor = Vec::with_capacity(64);
    let mut i = legs.len() as isize - 2;
    while i >= 1 {
        let u = i as usize;
        let (before, flight, after) = (legs[u - 1], legs[u], legs[u + 1]);
        let candidate = flight.kind == NavRouteLegKind::Fly
            && before.kind == NavRouteLegKind::Walk
            && after.kind == NavRouteLegKind::Walk
            && before.chunk == flight.chunk
            && after.chunk == flight.chunk
            && !before.overlay
            && !after.overlay;
        let g = if !candidate {
            -1
        } else if only_graph >= 0 {
            only_graph
        } else {
            graphs.graph_of(flight.chunk, false)
        };
        if g >= 0 {
            let nav = &*graphs.graphs[g as usize].nav;
            let filter = graphs.filter_for(g, ground_filter);
            let from = before.end;
            let to = flight.next_start;
            let length = from.distance(before.next_start) + before.next_start.distance(flight.end) + flight.end.distance(to);
            if walkable_within(nav, &filter, from, to, ratio * length, snap_distance, &mut corridor) {
                legs.drain(u - 1..u + 1);
                i -= 1;
            }
        }
        i -= 1;
    }
}
