//! One-shot queries on a runtime's loaded chunks (`Navigation.findPath`, `nearestPoint`, `raycast`, `isReachable`):
//! whole searches on list stores, outside the crowd's sliced budgets.
//!
//! Walking paths cross chunks through the crowd's route graphs (built by its tick once chunks are loaded: legs, then
//! an ordinary A* and funnel per leg). Before the first tick after a load, or for an agent type without graphs, a
//! path stays on one chunk's navmesh. Flight and hybrid walk/fly paths are planned within one chunk (the one holding
//! the start); crossing chunks in the air is what agents do, not these queries (yet).
use nav_crowd::components::NavMeshAgentAreaCost;
use nav_crowd::filters::{flight_filter, walk_filter};
use nav_crowd::settings::{AgentTypeSettings, NavFlightAgent, NavMeshAgent};
use nav_crowd::Crowd;
use nav_format::{NavLandingLinksData, NavMeshData, NavVolumeData};
use nav_math::Float3;
use nav_query::chunks::LoadedChunk;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::hybrid::{self, NavHybridParams, NavRouteEnd};
use nav_query::pathfinding::{self, NavPathStatus};
use nav_query::raycast::{raycast as surface_raycast, RaycastFilter};
use nav_query::route_search::NavRouteLegKind;
use nav_query::routing::{self, NavChunkRouteLeg};
use nav_query::straight_path::{straighten, NavMeshWaypoint};
use nav_query::volume;
use std::sync::Arc;

/// Status codes in query results: a full path, a partial one (ends nearest the goal), or none.
pub const STATUS_SUCCESS: f32 = 0.0;
pub const STATUS_PARTIAL: f32 = 1.0;
pub const STATUS_INVALID: f32 = 2.0;

/// Waypoint flag (beyond `NavMeshWaypointFlags`' bits, which use the low 7) marking a flight point.
pub const FLAG_FLIGHT: u8 = 0x80;

/// A path: status and waypoints (position xyz, normal xyz, flags), flat.
#[derive(Debug, Default)]
pub struct PathOut {
    pub status: f32,
    pub points: Vec<f32>,
}

impl PathOut {
    fn invalid() -> Self {
        Self { status: STATUS_INVALID, points: Vec::new() }
    }

    fn push(&mut self, p: Float3, n: Float3, flags: u8) {
        if let Some(last) = self.points.len().checked_sub(7) {
            let q = Float3::new(self.points[last], self.points[last + 1], self.points[last + 2]);
            if q.distance_sq(p) < 1e-8 {
                return; // a leg's start repeats the previous leg's end
            }
        }
        self.points.extend_from_slice(&[p.x, p.y, p.z, n.x, n.y, n.z, flags as f32]);
    }

    fn worsen(&mut self, s: NavPathStatus) {
        let code = match s {
            NavPathStatus::Success => STATUS_SUCCESS,
            NavPathStatus::Partial => STATUS_PARTIAL,
            NavPathStatus::InvalidInput => STATUS_INVALID,
        };
        if code > self.status {
            self.status = code;
        }
    }

    /// Flat: status first, then the waypoints.
    pub fn into_flat(self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.points.len() + 1);
        out.push(self.status);
        out.extend(self.points);
        out
    }
}

/// A chunk's navmesh, flight volume and landing links for an agent type (any may be missing).
pub struct Parts<'a> {
    pub nav: Option<&'a Arc<NavMeshData>>,
    pub volume: Option<&'a Arc<NavVolumeData>>,
    pub links: Option<&'a Arc<NavLandingLinksData>>,
}

pub fn chunk_parts(c: &LoadedChunk, agent_type: nav_math::Hash128) -> Parts<'_> {
    let mut parts = Parts { nav: None, volume: None, links: None };
    let Some(entry) = c.file.agent_table.as_ref().and_then(|t| t.entries.iter().find(|e| e.id == agent_type)) else { return parts };
    let s = &c.sections;
    if entry.walk_group >= 0 {
        parts.nav = s.navmeshes.iter().find(|n| n.0 as i32 == entry.walk_group).map(|n| &n.1);
    }
    if entry.fly_group >= 0 {
        parts.volume = s.volumes.iter().find(|v| v.0 as i32 == entry.fly_group).map(|v| &v.1);
    }
    if entry.walk_group >= 0 && entry.fly_group >= 0 {
        parts.links = s.landing_links.iter().find(|l| l.0 as i32 == entry.walk_group && l.1 as i32 == entry.fly_group).map(|l| &l.2);
    }
    parts
}

/// A chunk's gate states (closed, by gate index; entry 0 unused) as they are now: the bake's starting states, with
/// every gate the host has set, including `SetGate` commands the next tick hasn't applied yet. Read from the bake and
/// the host's gates rather than the tick's snapshot, so a gate toggled this frame, or a chunk loaded since the last
/// tick, is already right.
fn gates_of(crowd: &Crowd, c: &LoadedChunk) -> Vec<bool> {
    let Some(t) = c.file.gate_table.as_ref() else { return Vec::new() };
    let mut closed: Vec<bool> = t.closed.iter().map(|&x| x != 0).collect();
    for (i, &id) in t.ids.iter().enumerate().skip(1) {
        if let (Some(open), Some(slot)) = (crowd.gate_state(id), closed.get_mut(i)) {
            *slot = !open;
        }
    }
    closed
}

fn with_gates<'a>(mut f: NavMeshQueryFilter<'a>, gates: &'a [bool]) -> NavMeshQueryFilter<'a> {
    if !gates.is_empty() {
        f.closed_gates = Some(gates);
    }
    f
}

fn append_waypoints(out: &mut PathOut, wps: &[NavMeshWaypoint]) {
    for w in wps {
        out.push(w.position, w.normal, w.flags.0);
    }
}

fn snap_of(walk: &NavMeshAgent) -> f32 {
    walk.max_snap_distance.max(0.5)
}

/// The nearest point on any loaded navmesh of the type within `max_distance`: (chunk index, nav, poly, point).
fn locate_on_chunks<'a>(
    crowd: &'a Crowd,
    ty: &AgentTypeSettings,
    walk: &NavMeshAgent,
    costs: &[NavMeshAgentAreaCost],
    pos: Float3,
    max_distance: f32,
) -> Option<(&'a Arc<NavMeshData>, i32, Float3, Vec<bool>)> {
    let mut best: Option<(&Arc<NavMeshData>, i32, Float3, Vec<bool>)> = None;
    let mut best_d2 = f32::MAX;
    for c in crowd.chunks().loaded() {
        let Some(nav) = chunk_parts(c, ty.id).nav else { continue };
        let gates = gates_of(crowd, c);
        let filter = with_gates(walk_filter(walk, nav, costs), &gates);
        if let Some((poly, p)) = pathfinding::find_nearest_poly(nav, pos, max_distance, &filter) {
            let d2 = p.distance_sq(pos);
            if d2 < best_d2 {
                best_d2 = d2;
                best = Some((nav, poly, p, gates));
            }
        }
    }
    best
}

/// A walking path (see the module doc).
pub fn walk_path(crowd: &Crowd, ty: &AgentTypeSettings, walk: &NavMeshAgent, costs: &[NavMeshAgentAreaCost], from: Float3, to: Float3) -> PathOut {
    let snap = snap_of(walk);
    let mut out = PathOut::default();
    if let Some(graphs) = crowd.chunks().route_graphs(ty.id).filter(|g| !g.graphs.is_empty()) {
        let base = walk_filter(walk, &graphs.graphs[0].nav, costs);
        let Some((sg, sp, spos)) = routing::locate(graphs, &base, from, snap, Float3::default()) else { return PathOut::invalid() };
        let Some((gg, gp, gpos)) = routing::locate(graphs, &base, to, snap, Float3::default()) else { return PathOut::invalid() };
        let mut legs: Vec<NavChunkRouteLeg> = Vec::new();
        if sg == gg {
            legs.push(NavChunkRouteLeg { graph: sg, start_poly: sp, start: spos, end_poly: gp, end: gpos, exit_link: -1 });
        } else {
            let status = routing::find_route(graphs, &base, sg, sp, spos, gg, gp, gpos, &mut legs);
            out.worsen(status);
            if status == NavPathStatus::InvalidInput {
                return PathOut::invalid();
            }
        }
        let mut corridor = Vec::new();
        let mut wps = Vec::new();
        for leg in &legs {
            let graph = &graphs.graphs[leg.graph as usize];
            let nav = &graph.nav;
            // The graphs' gate states are as of the last tick: a chunk's own navmesh takes the live ones (overlays,
            // rebaked across edges, keep theirs).
            let live = if graph.overlay { Vec::new() } else { crowd.chunks().loaded().find(|c| c.id == graph.chunk).map(|c| gates_of(crowd, c)).unwrap_or_default() };
            let filter = with_gates(graphs.filter_for(leg.graph, &base), &live);
            let status = pathfinding::find_path(nav, leg.start_poly, leg.start, leg.end_poly, leg.end, &filter, &mut corridor);
            out.worsen(status);
            if status == NavPathStatus::InvalidInput {
                break;
            }
            straighten(nav, &corridor, leg.start, leg.end, &mut wps);
            append_waypoints(&mut out, &wps);
            if status == NavPathStatus::Partial {
                break;
            }
        }
        return out;
    }

    // No route graphs yet: one chunk's navmesh.
    let Some((nav, sp, spos, gates)) = locate_on_chunks(crowd, ty, walk, costs, from, snap) else { return PathOut::invalid() };
    let filter = with_gates(walk_filter(walk, nav, costs), &gates);
    let Some((gp, gpos)) = pathfinding::find_nearest_poly(nav, to, snap, &filter) else { return PathOut::invalid() };
    let mut corridor = Vec::new();
    let status = pathfinding::find_path(nav, sp, spos, gp, gpos, &filter, &mut corridor);
    out.worsen(status);
    if status != NavPathStatus::InvalidInput {
        let mut wps = Vec::new();
        straighten(nav, &corridor, spos, gpos, &mut wps);
        append_waypoints(&mut out, &wps);
    }
    out
}

fn up() -> Float3 {
    Float3::new(0.0, 1.0, 0.0)
}

/// The loaded flight volume of the type holding `pos` (or nearest free air within `snap`).
fn volume_at<'a>(crowd: &'a Crowd, ty: &AgentTypeSettings, pos: Float3, snap: f32) -> Option<(&'a LoadedChunk, &'a Arc<NavVolumeData>)> {
    for c in crowd.chunks().loaded() {
        let Some(v) = chunk_parts(c, ty.id).volume else { continue };
        if volume::snap_to_free(v, pos, snap).0 >= 0 {
            return Some((c, v));
        }
    }
    None
}

/// A flight path within the volume holding the start.
pub fn fly_path(crowd: &Crowd, ty: &AgentTypeSettings, fly: &NavFlightAgent, costs: &[NavMeshAgentAreaCost], from: Float3, to: Float3) -> PathOut {
    let snap = fly.max_snap_distance.max(0.5);
    let Some((_, v)) = volume_at(crowd, ty, from, snap) else { return PathOut::invalid() };
    let filter = flight_filter(v, costs);
    let mut points = Vec::new();
    let status = volume::find_path(v, &filter, from, to, snap, fly.max_search_nodes, &mut points);
    let mut out = PathOut::default();
    out.worsen(status);
    for p in points {
        out.push(p, up(), FLAG_FLIGHT);
    }
    out
}

/// A walk/fly path within one chunk (legs of walking and flight, each expanded into waypoints). Falls back to walking
/// when no loaded chunk has the type's navmesh, volume and landing links together.
pub fn hybrid_path(
    crowd: &Crowd,
    ty: &AgentTypeSettings,
    walk: &NavMeshAgent,
    fly: &NavFlightAgent,
    costs: &[NavMeshAgentAreaCost],
    from: Float3,
    to: Float3,
) -> PathOut {
    let wsnap = snap_of(walk);
    let fsnap = fly.max_snap_distance.max(0.5);
    for c in crowd.chunks().loaded() {
        let parts = chunk_parts(c, ty.id);
        let (Some(nav), Some(vol), Some(links)) = (parts.nav, parts.volume, parts.links) else { continue };
        let gates = gates_of(crowd, c);
        let ground = with_gates(walk_filter(walk, nav, costs), &gates);
        let air = flight_filter(vol, costs);
        let end_at = |p: Float3| {
            let mut e = NavRouteEnd::NONE;
            if let Some((poly, gp)) = pathfinding::find_nearest_poly(nav, p, wsnap, &ground) {
                e.poly = poly;
                e.ground_pos = gp;
            } else {
                let (leaf, ap) = volume::snap_to_free(vol, p, fsnap);
                e.leaf = leaf;
                e.air_pos = ap;
            }
            e
        };
        let start = end_at(from);
        if !start.on_ground() && !start.in_air() {
            continue;
        }
        let goal = end_at(to);
        let params = NavHybridParams {
            flight_cost_multiplier: fly.flight_cost_multiplier,
            takeoff_cost: fly.takeoff_cost,
            landing_cost: fly.landing_cost,
            max_flight_distance: fly.max_flight_distance,
            land_when_short: fly.land_when_out_of_reach,
            min_landing_slope_cos: nav_math::math::radians(fly.max_landing_slope_deg).cos(),
            takeoff_height: fly.takeoff_height,
            max_nodes: walk.max_search_nodes + fly.max_search_nodes,
            ..NavHybridParams::default()
        };
        let mut legs = Vec::new();
        let (status, _) = hybrid::find_route(nav, &ground, vol, &air, links, &params, &start, &goal, &mut legs);
        let mut out = PathOut::default();
        out.worsen(status);
        if status == NavPathStatus::InvalidInput {
            return out;
        }
        hybrid::walk_short_flights(nav, &ground, fly.walk_instead_ratio, walk.max_snap_distance, &mut legs);
        let mut cur = if start.on_ground() { start.ground_pos } else { start.air_pos };
        let mut corridor = Vec::new();
        let mut wps = Vec::new();
        let mut points = Vec::new();
        for leg in &legs {
            match leg.kind {
                NavRouteLegKind::Walk => {
                    let s = pathfinding::find_nearest_poly(nav, cur, wsnap, &ground);
                    let e = pathfinding::find_nearest_poly(nav, leg.end, wsnap, &ground);
                    if let (Some((sp, spos)), Some((ep, epos))) = (s, e) {
                        let st = pathfinding::find_path(nav, sp, spos, ep, epos, &ground, &mut corridor);
                        out.worsen(if st == NavPathStatus::InvalidInput { NavPathStatus::Partial } else { st });
                        straighten(nav, &corridor, spos, epos, &mut wps);
                        append_waypoints(&mut out, &wps);
                    } else {
                        out.push(leg.end, leg.end_up, 0);
                    }
                }
                NavRouteLegKind::Fly => {
                    let st = volume::find_path(vol, &air, cur, leg.end, fsnap, fly.max_search_nodes, &mut points);
                    if st == NavPathStatus::InvalidInput || points.is_empty() {
                        out.push(cur, up(), FLAG_FLIGHT);
                        out.push(leg.end, up(), FLAG_FLIGHT);
                    } else {
                        for &p in &points {
                            out.push(p, up(), FLAG_FLIGHT);
                        }
                    }
                }
            }
            // The rise after a takeoff / the descent after a landing.
            let next_flags = if leg.kind == NavRouteLegKind::Walk { FLAG_FLIGHT } else { 0 };
            out.push(leg.next_start, leg.next_up, next_flags);
            cur = leg.next_start;
        }
        return out;
    }
    walk_path(crowd, ty, walk, costs, from, to)
}

/// `Navigation.findPath`: walking, flying or hybrid by the type's abilities.
pub fn find_path(crowd: &Crowd, ty: &AgentTypeSettings, costs: &[NavMeshAgentAreaCost], from: Float3, to: Float3) -> PathOut {
    match (ty.walk.as_deref(), ty.flight.as_deref()) {
        (Some(w), None) => walk_path(crowd, ty, w, costs, from, to),
        (None, Some(f)) => fly_path(crowd, ty, f, costs, from, to),
        (Some(w), Some(f)) => hybrid_path(crowd, ty, w, f, costs, from, to),
        (None, None) => PathOut::invalid(),
    }
}

/// `Navigation.nearestPoint`: `[x, y, z, nx, ny, nz]` on the nearest walkable surface (walkers) or free air
/// (fly-only types) within `max_distance`, or empty.
pub fn nearest_point(crowd: &Crowd, ty: &AgentTypeSettings, costs: &[NavMeshAgentAreaCost], pos: Float3, max_distance: f32) -> Vec<f32> {
    if let Some(walk) = ty.walk.as_deref() {
        if let Some((nav, poly, p, _)) = locate_on_chunks(crowd, ty, walk, costs, pos, max_distance) {
            let n = nav.polys[poly as usize].normal;
            let (sp, sn) = nav_query::surface::try_get_surface_point(nav, poly, p).unwrap_or((p, n));
            return vec![sp.x, sp.y, sp.z, sn.x, sn.y, sn.z];
        }
        return Vec::new();
    }
    if ty.flight.is_some() {
        for c in crowd.chunks().loaded() {
            let Some(v) = chunk_parts(c, ty.id).volume else { continue };
            let (leaf, p) = volume::snap_to_free(v, pos, max_distance);
            if leaf >= 0 {
                return vec![p.x, p.y, p.z, 0.0, 1.0, 0.0];
            }
        }
    }
    Vec::new()
}

/// `Navigation.raycast`: walks the surface from `from` towards `to` (walkers). `[t, reached, x, y, z, nx, ny, nz]`:
/// `t` the fraction travelled, `reached` 1 if nothing blocked it, the stop point and (on a hit) the blocking edge's
/// outward normal. Fly-only types test the segment against their volume's free air (`t` 0 or 1). Empty when the
/// start isn't on navigation.
pub fn raycast(crowd: &Crowd, ty: &AgentTypeSettings, costs: &[NavMeshAgentAreaCost], from: Float3, to: Float3) -> Vec<f32> {
    if let Some(walk) = ty.walk.as_deref() {
        let Some((nav, poly, p, gates)) = locate_on_chunks(crowd, ty, walk, costs, from, snap_of(walk)) else { return Vec::new() };
        let f: NavMeshQueryFilter = walk_filter(walk, nav, costs);
        let filter = RaycastFilter { allowed_bins: f.allowed_bins, max_fold_angle: f.max_fold_angle, excluded_areas: f.excluded_areas, closed_gates: &gates };
        let hit = surface_raycast(nav, &filter, poly, p, to);
        let (h, n) = (hit.hit_point, hit.hit_normal);
        return vec![hit.t, if hit.reached { 1.0 } else { 0.0 }, h.x, h.y, h.z, n.x, n.y, n.z];
    }
    if let Some(fly) = ty.flight.as_deref() {
        if let Some((_, v)) = volume_at(crowd, ty, from, fly.max_snap_distance.max(0.5)) {
            let clear = volume::segment_clear(v, from, to);
            let e = if clear { to } else { from };
            return vec![if clear { 1.0 } else { 0.0 }, if clear { 1.0 } else { 0.0 }, e.x, e.y, e.z, 0.0, 0.0, 0.0];
        }
    }
    Vec::new()
}
