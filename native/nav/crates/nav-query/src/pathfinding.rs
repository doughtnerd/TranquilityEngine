//! Walking pathfinding (Foxfire's `NavMeshPathfinding.cs`): nearest polygon, and A* over polygons, run whole
//! ([`find_path`]) or sliced ([`begin`] / [`step`] / [`finish`]) with the nodes, open set and key table in a
//! [`SearchStore`]. Each polygon is visited at the midpoint of the portal it was entered through, like Detour.
use crate::filter::{nav_fold_delta, CongestionView, NavMeshQueryFilter};
use crate::index;
use crate::search::{SearchListStore, SearchNode, SearchOpen, SearchStore};
use crate::surface::closest_point_on_poly;
use nav_format::{NavLink, NavLinkKind, NavMeshData};
use nav_math::math::{self, max, min};
use nav_math::{Float3, Int3};

/// Slightly under-estimate to keep A* admissible with float error (the same trick as Detour).
const HEURISTIC_SCALE: f32 = 0.999;

/// `NavPathStatus`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavPathStatus {
    /// The corridor reaches the goal polygon.
    #[default]
    Success = 0,
    /// The goal is unreachable (or the node budget was hit): the corridor ends at the polygon closest to the goal.
    Partial = 1,
    /// The start or goal polygon is out of range or filtered out.
    InvalidInput = 2,
}

/// One corridor entry (`NavMeshPathNode`): the polygon, and the link (index into `NavMeshData::links`) used to enter it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavMeshPathNode {
    pub poly: i32,
    /// -1 for the start polygon.
    pub link: i32,
}

/// The state of one navmesh path search between steps (`NavMeshAStar`). Nodes, open set and key table live in a
/// store ([`crate::search::SearchBufferStore`] on a pooled search, [`SearchListStore`] for [`find_path`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavMeshAStar {
    pub goal_poly: i32,
    pub goal: Float3,
    pub h_scale: f32,
    pub max_nodes: i32,
    /// The goal's node once reached, -1 before.
    pub found: i32,
    /// The node nearest the goal so far (a partial corridor ends there).
    pub best_node: i32,
    pub best_h: f32,
    pub finished: bool,
    /// Heap entries popped, stale ones included (diagnostics: a slow step shows them).
    pub pops: i32,
}

// ---------------------------------------------------------------- nearest polygon

/// Best polygon on the preferred side, and best on the other side as a fallback (`NearestCandidates`).
struct NearestCandidates {
    pos: Float3,
    up: Float3,
    behind: f32,
    sided: bool,
    best: i32,
    /// Also the cull distance: nothing further than this can win.
    best_d2: f32,
    best_point: Float3,
    fallback: i32,
    fallback_d2: f32,
    fallback_point: Float3,
}

impl NearestCandidates {
    fn new(pos: Float3, max_distance: f32, up: Float3, behind_tolerance: f32) -> Self {
        Self {
            pos,
            up,
            behind: behind_tolerance,
            sided: up.length_sq() > 0.0 || math::isfinite(behind_tolerance),
            best: -1,
            fallback: -1,
            best_d2: max_distance * max_distance,
            fallback_d2: max_distance * max_distance,
            best_point: pos,
            fallback_point: pos,
        }
    }

    fn offer(&mut self, poly: i32, point: Float3, poly_normal: Float3) {
        let d2 = self.pos.distance_sq(point);
        let wrong_side =
            self.sided && (poly_normal.dot(self.up) < 0.0 || (self.pos - point).dot(poly_normal) < -self.behind);
        if !wrong_side {
            if d2 >= self.best_d2 {
                return;
            }
            self.best_d2 = d2;
            self.best = poly;
            self.best_point = point;
        } else if d2 < self.fallback_d2 {
            self.fallback_d2 = d2;
            self.fallback = poly;
            self.fallback_point = point;
        }
    }

    fn result(&self) -> Option<(i32, Float3)> {
        if self.best >= 0 {
            Some((self.best, self.best_point))
        } else if self.fallback < 0 {
            None
        } else {
            Some((self.fallback, self.fallback_point))
        }
    }
}

/// Nearest usable polygon within `max_distance`, and the closest point on it (`FindNearestPoly`). Uses the
/// navmesh's polygon index to look only at polygons whose bounds come within `max_distance`; falls back to checking
/// every polygon for navmeshes baked without one, or for very large search distances. `None` if nothing is within
/// `max_distance`.
///
/// Side preference (for an agent's own position): with `prefer_up` set and/or a finite `behind_tolerance`, polygons
/// whose walkable side faces against `prefer_up`, or that `pos` is more than `behind_tolerance` behind, are only
/// used if no other polygon is in range. Without it, an agent under a thin floor or behind a thin wall would snap
/// to the surface on the other side and path straight through it.
pub fn find_nearest_poly_sided(
    nav: &NavMeshData,
    pos: Float3,
    max_distance: f32,
    filter: &NavMeshQueryFilter,
    prefer_up: Float3,
    behind_tolerance: f32,
) -> Option<(i32, Float3)> {
    let mut candidates = NearestCandidates::new(pos, max_distance, prefer_up, behind_tolerance);
    let cell_size = nav.index_cell_size;
    let mut indexed = false;
    if cell_size > 0.0 {
        let q0 = index::cell_of(pos - Float3::splat(max_distance), cell_size);
        let q1 = index::cell_of(pos + Float3::splat(max_distance), cell_size);
        indexed = index::can_query(nav, q0, q1);
        if indexed {
            find_nearest_poly_indexed(nav, filter, q0, q1, &mut candidates);
        }
    }
    if !indexed {
        find_nearest_poly_brute_force(nav, filter, &mut candidates);
    }
    candidates.result()
}

/// [`find_nearest_poly_sided`] without a side preference (`FindNearestPoly` with its default arguments).
pub fn find_nearest_poly(
    nav: &NavMeshData,
    pos: Float3,
    max_distance: f32,
    filter: &NavMeshQueryFilter,
) -> Option<(i32, Float3)> {
    find_nearest_poly_sided(nav, pos, max_distance, filter, Float3::splat(0.0), f32::INFINITY)
}

fn find_nearest_poly_indexed(
    nav: &NavMeshData,
    filter: &NavMeshQueryFilter,
    q0: Int3,
    q1: Int3,
    candidates: &mut NearestCandidates,
) {
    let pos = candidates.pos;
    for z in q0.z..=q1.z {
        for y in q0.y..=q1.y {
            for x in q0.x..=q1.x {
                let cell = Int3::new(x, y, z);
                let Some((start, end)) = index::try_get_cell(nav, index::cell_key(cell)) else {
                    continue;
                };
                for e in start..end {
                    let p = nav.index_polys[e];

                    // A polygon is listed in every cell its bounds touch: test it only in the first of those that
                    // this query visits.
                    if index::first_cell(nav, p, q0) != cell {
                        continue;
                    }

                    if index::bounds_distance_sq(nav, p, pos) > candidates.best_d2 {
                        continue;
                    }
                    if !poly_usable(nav, p, filter) {
                        continue;
                    }

                    let (cp, _) = closest_point_on_poly(nav, p, pos);
                    candidates.offer(p, cp, nav.polys[p as usize].normal);
                }
            }
        }
    }
}

fn find_nearest_poly_brute_force(nav: &NavMeshData, filter: &NavMeshQueryFilter, candidates: &mut NearestCandidates) {
    let pos = candidates.pos;
    for p in 0..nav.polys.len() as i32 {
        let poly = &nav.polys[p as usize];
        if !poly_usable(nav, p, filter) {
            continue;
        }

        // Cheap reject: bounding sphere around the polygon centre.
        let mut radius = 0.0f32;
        for i in 0..poly.vert_count {
            radius = max(
                radius,
                poly.center.distance_sq(nav.verts[nav.poly_verts[(poly.vert_start + i) as usize] as usize]),
            );
        }
        let reject = candidates.best_d2.sqrt() + radius.sqrt();
        if pos.distance_sq(poly.center) > reject * reject {
            continue;
        }

        let (cp, _) = closest_point_on_poly(nav, p, pos);
        candidates.offer(p, cp, poly.normal);
    }
}

// ---------------------------------------------------------------- A*

/// A* over polygons. Fills `corridor` with the polygon corridor from start to goal, each entry tagged with the
/// link used to enter it (`FindPath`). Runs [`begin`] / [`step`] / [`finish`] to the end with a temporary
/// [`SearchListStore`]. Agents search on pooled stores instead, a slice per frame.
pub fn find_path(
    nav: &NavMeshData,
    start_poly: i32,
    start_pos: Float3,
    goal_poly: i32,
    goal_pos: Float3,
    filter: &NavMeshQueryFilter,
    corridor: &mut Vec<NavMeshPathNode>,
) -> NavPathStatus {
    corridor.clear();
    let mut store = SearchListStore::default();
    let mut search = NavMeshAStar::default();
    let mut status = NavPathStatus::InvalidInput;
    if begin(nav, start_poly, start_pos, goal_poly, goal_pos, filter, &mut search, &mut store) {
        while !step(nav, filter, &mut search, &mut store, i32::MAX) {}
        status = finish(&search, &store, corridor);
    }
    status
}

/// Starts a path search: checks the ends and offers the start (`Begin`). False (`InvalidInput`) if either polygon is
/// out of range or unusable. The store is cleared with [`SearchStore::clear`]: for a
/// [`crate::search::SearchBufferStore`], call its `begin()` first so the key table's stamp is new.
#[allow(clippy::too_many_arguments)]
pub fn begin<S: SearchStore>(
    nav: &NavMeshData,
    start_poly: i32,
    start_pos: Float3,
    goal_poly: i32,
    goal_pos: Float3,
    filter: &NavMeshQueryFilter,
    s: &mut NavMeshAStar,
    store: &mut S,
) -> bool {
    store.clear();
    *s = NavMeshAStar::default();
    s.found = -1;
    s.finished = true;
    let count = nav.polys.len() as i32;
    if start_poly < 0
        || start_poly >= count
        || goal_poly < 0
        || goal_poly >= count
        || !poly_usable(nav, start_poly, filter)
        || !poly_usable(nav, goal_poly, filter)
    {
        return false;
    }

    // Never overestimate: scale by the cheapest surface and the cheapest area the agent can use (`CheapestTravel`,
    // spelled out to keep the float operations in this order).
    s.h_scale = HEURISTIC_SCALE
        * min(1.0, min(filter.wall_cost_multiplier, filter.ceiling_cost_multiplier))
        * (if filter.area_costs.is_empty() { 1.0 } else { min(1.0, filter.min_area_cost) })
        * filter.poly_cost_scale();
    s.goal_poly = goal_poly;
    s.goal = goal_pos;
    s.max_nodes = filter.max_nodes;
    let h0 = start_pos.distance(goal_pos) * s.h_scale;
    s.best_h = h0;
    store.add_node(
        start_poly as i64,
        SearchNode { item: start_poly, parent: -1, via_index: -1, g: 0.0, f: h0, pos: start_pos, ..SearchNode::default() },
    );
    if start_poly == goal_poly {
        s.found = 0; // one polygon: straight there
        return true;
    }

    store.push(SearchOpen { f: h0, node: 0 });
    s.finished = false;
    true
}

/// Expands up to `max_nodes` polygons (`Step`). True once the search is over: the goal polygon is reached or the
/// open set is empty (the filter's node budget, `max_nodes`, ends it that way too). The filter may change between
/// steps (its congestion table is rebuilt every frame).
pub fn step<S: SearchStore>(
    nav: &NavMeshData,
    filter: &NavMeshQueryFilter,
    s: &mut NavMeshAStar,
    store: &mut S,
    max_nodes: i32,
) -> bool {
    let congestion = filter.congestion.is_some_and(|c| c.is_created()) && filter.congestion_cost > 0.0 && filter.agent_speed > 0.0;
    let inv_speed = 1.0 / max(filter.agent_speed, 1e-3);
    let goal_poly = s.goal_poly;
    let goal_pos = s.goal;
    let mut expanded = 0;
    while !s.finished && expanded < max_nodes {
        if store.open_count() == 0 {
            s.finished = true;
            break;
        }

        let item = store.pop();
        s.pops += 1;
        let mut cur = store.get_node(item.node);
        if cur.closed() || item.f > cur.f {
            continue; // stale heap entry
        }
        cur.set_closed(true);
        store.set_node(item.node, cur);
        expanded += 1;

        if cur.item == goal_poly {
            s.found = item.node;
            s.finished = true;
            break;
        }

        let h_cur = cur.pos.distance(goal_pos);
        if h_cur < s.best_h {
            s.best_h = h_cur;
            s.best_node = item.node;
        }

        let p = &nav.polys[cur.item as usize];
        let travel_mul = travel_multiplier(nav, cur.item, filter);

        for l in 0..p.link_count {
            let link_index = p.link_start + l;
            let Some((mut cost, dist, land)) =
                try_link(nav, link_index, cur.pos, cur.dist, travel_mul, filter, congestion, inv_speed)
            else {
                continue;
            };
            let link = &nav.links[link_index as usize];

            let h;
            if link.to_poly == goal_poly {
                // Like Detour: the goal node's cost includes the final leg to the goal position.
                cost += land.distance(goal_pos) * travel_multiplier(nav, link.to_poly, filter);
                h = 0.0;
            } else {
                h = land.distance(goal_pos) * s.h_scale;
            }

            let g = cur.g + cost;

            if let Some(ni) = store.try_get_node(link.to_poly as i64) {
                let mut n = store.get_node(ni);
                if g >= n.g {
                    continue;
                }

                n.parent = item.node;
                n.via_index = link_index;
                n.g = g;
                n.f = g + h;
                n.dist = dist;
                n.pos = land;
                n.set_closed(false); // reopen if a cheaper route was found
                store.set_node(ni, n);
                store.push(SearchOpen { f: n.f, node: ni });
            } else {
                if store.node_count() as i32 >= s.max_nodes {
                    continue;
                }
                let idx = store.add_node(
                    link.to_poly as i64,
                    SearchNode {
                        item: link.to_poly,
                        parent: item.node,
                        via_index: link_index,
                        g,
                        f: g + h,
                        dist,
                        pos: land,
                        ..SearchNode::default()
                    },
                );
                store.push(SearchOpen { f: g + h, node: idx });
            }
        }
    }

    s.finished
}

/// Writes the finished search's corridor (cleared first): to the goal (`Success`), or to the polygon that got
/// closest to it (`Partial`: the goal is unreachable or the node budget ran out) (`Finish`).
pub fn finish<S: SearchStore>(s: &NavMeshAStar, store: &S, corridor: &mut Vec<NavMeshPathNode>) -> NavPathStatus {
    corridor.clear();
    let last = if s.found >= 0 { s.found } else { s.best_node };
    let mut n = last;
    while n >= 0 {
        let node = store.get_node(n);
        corridor.push(NavMeshPathNode { poly: node.item, link: node.via_index });
        n = node.parent;
    }
    corridor.reverse();
    if s.found >= 0 {
        NavPathStatus::Success
    } else {
        NavPathStatus::Partial
    }
}

// ---------------------------------------------------------------- helpers

/// Cost per unit of distance across a polygon: its surface (floor, wall, ceiling) times its area, times the runtime
/// cost volumes over it (ADR 0070).
#[inline]
pub fn travel_multiplier(nav: &NavMeshData, poly: i32, filter: &NavMeshQueryFilter) -> f32 {
    let p = &nav.polys[poly as usize];
    let m = surface_multiplier(nav, p.bin, filter) * filter.area_costs.cost(p.area);
    match filter.poly_costs {
        Some(_) => m * filter.poly_cost(poly),
        None => m,
    }
}

/// Taking link `link_index` from `from` (where the path entered the link's source polygon, `from_dist` along it):
/// `None` if the filter forbids it; otherwise `(cost, dist, land)`: its cost (`travel_mul` = the source polygon's
/// [`travel_multiplier`]), the distance travelled when landing, and where the path enters the destination polygon
/// (`TryLink`).
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn try_link(
    nav: &NavMeshData,
    link_index: i32,
    from: Float3,
    from_dist: f32,
    travel_mul: f32,
    filter: &NavMeshQueryFilter,
    congestion: bool,
    inv_speed: f32,
) -> Option<(f32, f32, Float3)> {
    let link = &nav.links[link_index as usize];
    if !poly_usable(nav, link.to_poly, filter) {
        return None;
    }

    let fold = link.kind == NavLinkKind::FOLD;
    let jump = link.kind == NavLinkKind::JUMP;
    if fold && nav_fold_delta(link.fold_angle) > filter.max_fold_angle {
        return None;
    }
    if jump && !jump_allowed(link, filter) {
        return None;
    }

    // Travel across the current polygon to the portal, then across the fold gap or the jump.
    let (walk, crossing, land) = link_travel(link, from);
    let mut cost = walk * travel_mul;
    let mut dist = from_dist + walk;
    dist += crossing;
    if fold {
        cost += crossing;
        cost += link.fold_angle * filter.fold_cost_per_radian;
        if link.convex != 0 {
            cost += filter.convex_fold_extra_cost;
        }
    } else if jump {
        cost += crossing + filter.jump_cost;
    }

    if congestion {
        cost += congestion_penalty(link, dist * inv_speed, filter);
    }
    Some((cost, dist, land))
}

/// How far the path travels through a link, starting from `from` (where it entered the current polygon):
/// `(walk, crossing, land)`. `walk` = across the polygon to the portal's midpoint; `crossing` = the fold gap, or
/// the jump (horizontal distance plus height change), 0 for internal links; `land` = where it enters the next
/// polygon. A*, congestion arrival times and agents' corridors all measure distance this way (`LinkTravel`).
#[inline]
pub fn link_travel(link: &NavLink, from: Float3) -> (f32, f32, Float3) {
    let mid = (link.portal_a + link.portal_b) * 0.5;
    let walk = from.distance(mid);
    match link.kind {
        NavLinkKind::FOLD => {
            let land = (link.dest_a + link.dest_b) * 0.5;
            (walk, mid.distance(land), land)
        }
        // dest_a == dest_b: the landing point.
        NavLinkKind::JUMP => (walk, link.jump_distance + math::abs(link.jump_rise), (link.dest_a + link.dest_b) * 0.5),
        _ => (walk, 0.0, mid),
    }
}

/// Extra cost for entering `link.to_poly` `arrival` seconds from now: free while the agents other paths expect
/// there then still fit through the entry portal side by side, `congestion_cost` per agent over that.
#[inline]
fn congestion_penalty(link: &NavLink, arrival: f32, filter: &NavMeshQueryFilter) -> f32 {
    let Some(c) = filter.congestion else { return 0.0 };
    let bucket = c.bucket_of(arrival);
    if bucket < 0 {
        return 0.0;
    }
    let lanes = CongestionView::lanes(link.portal_a.distance(link.portal_b), filter.agent_radius);
    let over = c.load(link.to_poly, bucket) as f32 - lanes + 1.0;
    if over > 0.0 {
        over * filter.congestion_cost
    } else {
        0.0
    }
}

#[inline]
fn jump_allowed(link: &NavLink, filter: &NavMeshQueryFilter) -> bool {
    if !filter.can_jump {
        return false;
    }
    if link.jump_distance > filter.max_jump_distance {
        return false;
    }
    if link.jump_rise >= 0.0 {
        link.jump_rise <= filter.max_jump_up_height
    } else {
        -link.jump_rise <= filter.max_fall_distance
    }
}

/// `PolyAllowed`, not switched off (an overlay replaced it) and not excluded by a runtime cost volume (ADR 0070)
/// (`PolyUsable`).
#[inline]
pub fn poly_usable(nav: &NavMeshData, poly: i32, filter: &NavMeshQueryFilter) -> bool {
    filter.poly_allowed(&nav.polys[poly as usize]) && !filter.is_switched_off(poly) && !filter.is_poly_excluded(poly)
}

/// Floor (tilt < 45 degrees) = 1, ceiling (tilt > 135) and walls use the filter's multipliers.
#[inline]
pub fn surface_multiplier(nav: &NavMeshData, bin: i32, filter: &NavMeshQueryFilter) -> f32 {
    let tilt = nav.bins[bin as usize].tilt_deg;
    if tilt < 45.0 {
        return 1.0;
    }
    if tilt > 135.0 {
        return filter.ceiling_cost_multiplier;
    }
    filter.wall_cost_multiplier
}
