//! Routes: walk-and-fly routes (hybrid legs), and routes across chunks for walkers and fly-only agents (Foxfire's
//! `NavRouteSystem.cs`, `NavChunkRouteSystem.cs`, `NavChunkFlightRouteSystem.cs`, `Systems/Jobs/NavRouteJob.cs`,
//! `NavRouteSearchJobs.cs`, `NavFlightRouteSearchJobs.cs`, `NavChunkRouteShareJobs.cs`). The planning itself is
//! `nav_query::{hybrid, routing, route_search, route_graph, crossing}`; this file is the agents' side of it.
//!
//! * [`update_routes`]: `NavRouteSystem`, per agent type: the route job per walk-fly agent (follow the leg, take off and
//!   land, ask for a search), the assign job (requests to the type's free searches, or share a finished search with
//!   the same key), the share job, the step job (a slice of every search in use, then the legs go into the agent).
//!   Types without route graphs search "within one chunk": one graph and volume per snapshot entry, no links.
//! * [`chunk_routes`]: `NavChunkRouteSystem` for walkers: requests to another navmesh get a route (searches shared by
//!   key within the tick), agents move from leg to leg at their exit portal.
//! * [`chunk_flight_routes`]: `NavChunkFlightRouteSystem` for fly-only agents: the same over volumes, with sliced
//!   searches on a pool per agent type, shared by key and ticket.
//!
//! Route outcome counters ([`RouteStats`]) are kept for the three kinds and reported as log lines every
//! [`REPORT_SECONDS`] while anything was planned (`NavRouteReport`).
use crate::agents::{AgentKind, AgentStore, ChunkRouteData, RouteData};
use crate::components::*;
use crate::filters::{effective_area_costs, flight_filter, quat_rotate, walk_filter};
use crate::flyers::is_member;
use crate::surround_slots;
use crate::walkers::{distance_to_segment, look_rotation_safe, slerp};
use crate::pool::{PooledSearch, SearchPool};
use crate::settings::{NavFlightAgent, NavMeshAgent};
use crate::tick::Frame;
use crate::warnings::{NavWarning, NavWarningKind, Warnings};
use crate::world::Targets;
use nav_format::{NavMeshData, NavVolumeData};
use nav_math::{Float3, Float4, Hash128};
use nav_query::crossing;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::hybrid::{face_point, walk_short_chunk_flights, NavHybridParams};
use nav_query::pathfinding::{find_nearest_poly, find_nearest_poly_sided, NavPathStatus};
use nav_query::route_graph::{self, NavRouteGraph, NavRouteVolume, RouteGraphs};
use nav_query::route_search::{self, NavChunkRouteEnd, NavRouteLeg, NavRouteLegKind};
use nav_query::routing::{self, FlightRouteEnds, RouteStats};
use nav_query::volume::{self, NavVolumeQueryFilter};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// `NavRouteSystem.SearchPoolSize`: walk-fly route searches running at once, per agent type.
pub const ROUTE_POOL_SIZE: usize = 32;
/// `NavRouteSystem.SearchSlice`: nodes each walk-fly route search expands per tick.
pub const ROUTE_SLICE: i32 = 128;
/// `NavChunkFlightRouteSystem.SearchPoolSize`.
pub const FLIGHT_ROUTE_POOL_SIZE: usize = 64;
/// `NavChunkFlightRouteSystem.SearchSlice`.
pub const FLIGHT_ROUTE_SLICE: i32 = 1024;
/// `NavChunkRouteKey.Cell`.
pub const CHUNK_ROUTE_CELL: f32 = 16.0;
/// `NavChunkRouteSearchJob.OverlayShortcut`: a way through a chunk's overlay is taken only if the way round costs more
/// than this times as much.
pub const OVERLAY_SHORTCUT: f32 = 1.1;
/// Seconds between route reports.
pub const REPORT_SECONDS: f64 = 10.0;

/// What walkers' chunk routes are shared by (`NavChunkRouteKey`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ChunkRouteKey {
    start_graph: i32,
    goal_graph: i32,
    goal_cell: [i32; 3],
    settings: i32,
}

/// A walker's route request (`NavChunkRouteAsk`).
#[derive(Clone, Debug)]
struct ChunkAsk {
    row: usize,
    key: ChunkRouteKey,
    settings: Arc<NavMeshAgent>,
    speed: f32,
    start_poly: i32,
    start_pos: Float3,
    goal_poly: i32,
    goal_pos: Float3,
    old_edge: Float3,
    reach: f32,
    to_edge: bool,
    waited: bool,
}

#[derive(Clone, Debug, Default)]
struct ChunkOutcome {
    legs: Vec<routing::NavChunkRouteLeg>,
    status: NavPathStatus,
    at_edge: bool,
}

/// A walk-fly agent given a finished search's route (`NavRouteShare`).
struct RouteShare {
    row: usize,
    search: usize,
    goal: Float3,
    status: NavPathStatus,
    at_edge: bool,
    nav: DataKey,
    volume: DataKey,
    version: i32,
}

/// A fly-only agent given a finished search's route (`NavFlightRouteShare`).
struct FlightShare {
    row: usize,
    search: usize,
    old_edge: Float3,
    status: NavPathStatus,
    at_edge: bool,
    waited: bool,
}

/// The graphs of an agent type without route graphs: one graph and one volume per snapshot entry (index = entry), no
/// links between them. Rebuilt when the snapshot is.
#[derive(Clone, Debug, Default)]
struct Within {
    graphs: RouteGraphs,
    snapshot_version: u32,
    /// The chunk world's `cost_version` the graphs' cost tables are from.
    cost_version: u32,
    built: bool,
}

/// Copies every snapshot entry's runtime cost tables into the within-one-chunk graphs (graph = volume = entry).
fn within_costs(g: &mut RouteGraphs, frame: &Frame) {
    let snap = frame.world.snapshot();
    g.poly_costs = (0..snap.entries.len()).map(|e| snap.poly_costs_of(e).to_vec()).collect();
    g.leaf_costs = (0..snap.entries.len()).map(|e| snap.leaf_costs_of(e).to_vec()).collect();
    g.min_poly_cost = snap.min_poly_cost.min(1.0);
    g.min_leaf_cost = snap.min_leaf_cost.min(1.0);
}

/// ADR 0070: this tick's cost volume change touched one of these chunks' entries for the agent type.
fn costs_changed_on(frame: &Frame, ty: Hash128, mut chunks: impl Iterator<Item = Hash128>) -> bool {
    if !frame.update.costs_changed {
        return false;
    }
    let snap = frame.world.snapshot();
    let changed: Vec<Hash128> = snap.entries.iter().filter(|e| e.agent_type == ty && e.last_cost_change == frame.time).map(|e| e.chunk).collect();
    !changed.is_empty() && chunks.any(|c| changed.contains(&c))
}

/// The route steps' state between ticks.
#[derive(Clone, Debug, Default)]
pub struct RouteSystems {
    /// `NavRouteSearch` entities, a pool per agent type.
    pub route_searches: BTreeMap<Hash128, SearchPool<NavRouteSearch>>,
    /// `NavFlightRouteSearch` entities, a pool per agent type.
    pub flight_route_searches: BTreeMap<Hash128, SearchPool<NavFlightRouteSearch>>,
    /// Route outcomes: walk-and-fly routes, walkers' chunk routes, fly-only chunk routes (`NavRouteStats`).
    pub route_stats: RouteStats,
    pub walk_stats: RouteStats,
    pub flight_stats: RouteStats,
    /// Route searches deferred for want of a free search, last tick (counters for tests).
    pub deferrals: usize,
    /// Routes given to agents by sharing a finished search, over the crowd's life.
    pub shared: usize,
    within: Within,
    next_report: f64,
    reported: [RouteStats; 3],
}

// ---------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------

fn content_hash<T: std::fmt::Debug>(t: &T) -> i32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in format!("{t:?}").bytes() {
        h = (h ^ b as u32).wrapping_mul(0x0100_0193);
    }
    h as i32
}

fn hash_code(h: Hash128) -> i32 {
    let mut x = h.x as i32;
    for v in [h.y, h.z, h.w] {
        x = x.wrapping_mul(397) ^ v as i32;
    }
    x
}

fn cell_of(p: Float3, size: f32) -> [i32; 3] {
    let c = (p / size).floor();
    [c.x as i32, c.y as i32, c.z as i32]
}

/// The point of seam / portal a-b nearest p, kept radius from its ends (its middle if narrower); fallback if unset.
fn seam_point(a: Float3, b: Float3, p: Float3, radius: f32, fallback: Float3) -> Float3 {
    let ab = b - a;
    let length = ab.length();
    if length < 1e-4 {
        return fallback;
    }
    if length <= 2.0 * radius {
        return a + ab * 0.5;
    }
    let inset = radius / length;
    let t = nav_math::math::clamp((p - a).dot(ab) / (length * length), inset, 1.0 - inset);
    a + ab * t
}

/// `NavRouteGraphCache.Affected` for a route on `legs_chunks` from the current leg.
fn route_affected(frame: &Frame, route_version: i32, short_of_goal: bool, to_edge: bool, own: Hash128, leg: i32, leg_chunks: &[Hash128]) -> bool {
    let from = (leg.max(0) as usize).min(leg_chunks.len());
    let g = &frame.world.graphs;
    route_graph::affected(route_version, g.version, short_of_goal, to_edge, own, &leg_chunks[from..], &g.changed, &g.changed_seams)
}

/// Moves the agent towards a take-off's or landing's end at `takeoff_speed`, turning its up towards `up`; true once
/// there (`NavRouteJob.Transition`).
pub(crate) fn transition(position: &mut Float3, rotation: &mut Float4, to: Float3, up: Float3, flyer: &NavFlightAgent, dt: f32) -> bool {
    let delta = to - *position;
    let dist = delta.length();
    let step = flyer.takeoff_speed * dt;
    *position = if dist <= step { to } else { *position + delta * (step / dist) };
    let mut forward = quat_rotate(*rotation, Float3::new(0.0, 0.0, 1.0));
    forward = forward - up * forward.dot(up);
    if forward.length_sq() > 1e-6 {
        let facing = look_rotation_safe(forward.normalize(), up);
        let blend = 1.0 - (-flyer.turn_speed * dt).exp();
        *rotation = slerp(*rotation, facing, blend);
    }
    dist <= step
}

/// Builds or refreshes the within-one-chunk graphs.
fn ensure_within(within: &mut Within, frame: &Frame) {
    let snap = frame.world.snapshot();
    if within.built && within.snapshot_version == frame.world.snapshot_version {
        if within.graphs.closed_gates != snap.closed_gates {
            within.graphs.closed_gates = snap.closed_gates.clone();
        }
        if within.cost_version != frame.world.cost_version {
            within_costs(&mut within.graphs, frame);
            within.cost_version = frame.world.cost_version;
        }
        return;
    }
    let mut g = RouteGraphs { switched_off: snap.switched_off.clone(), closed_gates: snap.closed_gates.clone(), ..RouteGraphs::default() };
    for (e, entry) in snap.entries.iter().enumerate() {
        let has_volume = entry.volume.is_some() && entry.links.is_some();
        let has_nav = entry.nav.is_some();
        let linked = if has_volume && has_nav { e as i32 } else { -1 };
        g.graphs.push(NavRouteGraph {
            nav: entry.nav.clone().unwrap_or_default(),
            chunk: entry.chunk,
            overlay: entry.overlay,
            switched_off_start: entry.switched_off_start,
            switched_off_count: entry.switched_off_count,
            gate_start: entry.gate_start,
            gate_count: entry.gate_count,
            volume: linked,
        });
        g.volumes.push(NavRouteVolume {
            volume: if has_volume { entry.volume.clone().unwrap_or_default() } else { Arc::new(NavVolumeData::default()) },
            links: if has_volume { entry.links.clone() } else { None },
            chunk: entry.chunk,
            graph: linked,
        });
    }
    within_costs(&mut g, frame);
    within.graphs = g;
    within.snapshot_version = frame.world.snapshot_version;
    within.cost_version = frame.world.cost_version;
    within.built = true;
}

fn same_key_mode(route: &NavRoute, key: &NavRouteKey) -> bool {
    route.mode as u8 == key.mode
}

// ---------------------------------------------------------------------------------------------------------------------
// NavRouteSystem: walk-and-fly agents
// ---------------------------------------------------------------------------------------------------------------------

/// Everything `NavRouteJob.Run` reads and writes of one agent (copies; written back by the caller).
struct RouteAgent<'a> {
    route: NavRoute,
    legs: &'a mut Vec<NavRouteLeg>,
    request: PathRequest,
    request_enabled: bool,
    walking: bool,
    flying: bool,
    path: NavPath,
    fly_path: FlyPath,
    position: Float3,
    rotation: Float4,
    surface: NavMeshAgentSurface,
    chunk: NavAgentChunk,
    search_requested: bool,
    search_request: NavRouteSearchRequestData,
}

struct RouteCtx<'a> {
    frame: &'a Frame<'a>,
    across: bool,
    version: i32,
}

/// `NavRouteSystem`: per agent type, the route job, assign, share and step.
pub fn update_routes(sys: &mut RouteSystems, agents: &mut AgentStore, targets: &Targets, frame: &Frame, warnings: &mut Warnings) {
    for pool in sys.route_searches.values_mut() {
        pool.release_dead(|id| agents.is_live(id));
    }
    sys.deferrals = 0;
    let types: Vec<Hash128> = frame.world.snapshot().agent_types.clone();
    for ty in types {
        let rows: Vec<usize> = agents.active_rows().filter(|&r| agents.data[r].kind == AgentKind::WalkFly && agents.data[r].agent_type == ty).collect();
        if rows.is_empty() && !sys.route_searches.contains_key(&ty) {
            continue;
        }
        if !rows.is_empty() {
            sys.route_searches.entry(ty).or_default().ensure(ROUTE_POOL_SIZE);
        }
        let across = frame.world.route_graphs(ty).is_some();
        if !across {
            ensure_within(&mut sys.within, frame);
        }
        let graphs: &RouteGraphs = if across { frame.world.route_graphs(ty).expect("checked") } else { &sys.within.graphs };
        let cx = RouteCtx { frame, across, version: frame.world.graphs.version };

        // NavRouteJob.
        for &r in &rows {
            run_route_agent(&cx, &mut sys.route_stats, agents, targets, warnings, r, ty);
        }

        // NavRouteSearchAssignJob, NavRouteShareJob.
        let pool = sys.route_searches.entry(ty).or_default();
        let (shares, stepping, deferred) = assign_routes(&cx, pool, agents, ty);
        sys.deferrals += deferred;
        sys.shared += shares.len();
        share_routes(frame, pool, agents, &shares);

        // NavRouteSearchStepJob.
        for i in stepping {
            step_route_search(&cx, graphs, pool, i, &mut sys.route_stats, agents, frame, warnings);
        }
    }
    report(sys, frame, warnings);
}

/// The `NavRouteReport`: a log line with the outcome counters, while anything was planned since the last.
fn report(sys: &mut RouteSystems, frame: &Frame, warnings: &mut Warnings) {
    if frame.time < sys.next_report {
        return;
    }
    sys.next_report = frame.time + REPORT_SECONDS;
    let kinds = [("walk-and-fly routes", sys.route_stats, 0), ("walker chunk routes", sys.walk_stats, 1), ("flight chunk routes", sys.flight_stats, 2)];
    for (name, now, k) in kinds {
        let before = sys.reported[k];
        if now == before {
            continue;
        }
        let d = |i: usize| now.counts[i] - before.counts[i];
        if d(RouteStats::PLANNED) <= 0 {
            sys.reported[k] = now;
            continue;
        }
        let mut text = format!(
            "Navigation [{}]: {name}: {} planned ({} to the edge of loaded space, {} short of the goal, {} out of budget, {} failed)",
            warnings.label(),
            d(RouteStats::PLANNED),
            d(RouteStats::TO_EDGE),
            d(RouteStats::SHORT_OF_GOAL),
            d(RouteStats::OUT_OF_BUDGET),
            d(RouteStats::FAILED)
        );
        if d(RouteStats::LANDED) > 0 {
            text.push_str(&format!(", {} flights landed ({} over the limit, {} emergency landings)", d(RouteStats::LANDED), d(RouteStats::OVER_LIMIT), d(RouteStats::EMERGENCY_LANDINGS)));
        }
        text.push('.');
        warnings.log(text);
        sys.reported[k] = now;
    }
}

fn run_route_agent(cx: &RouteCtx, stats: &mut RouteStats, agents: &mut AgentStore, targets: &Targets, warnings: &mut Warnings, r: usize, ty: Hash128) {
    let _ = ty;
    if is_member(&agents.data[r]) {
        return; // a group member: its group plans for it
    }
    let (Some(walk), Some(flight)) = (agents.data[r].walk.clone(), agents.data[r].flight.clone()) else { return };
    let Some(mut rd) = agents.data[r].route.take() else { return };
    let Some(walker) = agents.data[r].walker.as_deref() else {
        agents.data[r].route = Some(rd);
        return;
    };
    let Some(flyer_data) = agents.data[r].flyer.as_deref() else {
        agents.data[r].route = Some(rd);
        return;
    };
    let chase = agents.data[r].goal_target.and_then(|g| {
        agents.target_position(g.target, targets).map(|tp| surround_slots::chase_goal(agents.data[r].surround_slot.as_ref(), &g, tp, targets))
    });
    let unique = if agents.data[r].area_costs.is_empty() { 0 } else { r as i32 + 1 };
    let mut a = RouteAgent {
        route: rd.route,
        legs: &mut rd.legs,
        request: agents.data[r].path_request,
        request_enabled: agents.data[r].path_request_enabled,
        walking: rd.walking,
        flying: rd.flying,
        path: walker.path,
        fly_path: flyer_data.path,
        position: agents.position[r],
        rotation: agents.rotation[r],
        surface: agents.surface[r],
        chunk: agents.chunk[r],
        search_requested: rd.search_requested,
        search_request: rd.request,
    };
    let flyer = flight.effective();
    route_job(cx, stats, warnings, &mut a, &walk.settings, &walk, &flight, &flyer, chase, unique);
    let RouteAgent { route, request, request_enabled, walking, flying, path, fly_path, position, rotation, surface, chunk, search_requested, search_request, .. } = a;
    rd.route = route;
    rd.walking = walking;
    rd.flying = flying;
    rd.search_requested = search_requested;
    rd.request = search_request;
    let d = &mut agents.data[r];
    d.path_request = request;
    d.path_request_enabled = request_enabled;
    if let Some(w) = d.walker.as_deref_mut() {
        w.path = path;
    }
    if let Some(f) = d.flyer.as_deref_mut() {
        f.path = fly_path;
    }
    d.route = Some(rd);
    agents.position[r] = position;
    agents.rotation[r] = rotation;
    agents.surface[r] = surface;
    agents.chunk[r] = chunk;
}

/// `NavRouteJob.Run`.
#[allow(clippy::too_many_arguments)]
fn route_job(
    cx: &RouteCtx,
    stats: &mut RouteStats,
    warnings: &mut Warnings,
    a: &mut RouteAgent,
    mesh: &NavMeshAgent,
    walk: &NavMeshAgentConfig,
    flight: &NavFlightAgentConfig,
    flyer: &NavFlightAgent,
    chase: Option<(Float3, f32)>,
    unique: i32,
) {
    let frame = cx.frame;
    let snap = frame.world.snapshot();
    let Some(chunk) = usize::try_from(a.chunk.entry).ok().and_then(|e| snap.entries.get(e)) else { return }; // paused
    if chunk.nav.is_none() {
        return;
    }
    if !cx.across && (chunk.volume.is_none() || chunk.links.is_none()) {
        return; // can't route here
    }
    let route = &mut a.route;
    // Off the ground (the climb and the descent too) counts against MaxFlightDistance.
    if route.mode != NavMotionMode::Walking {
        route.flown_since_takeoff += a.position.distance(route.last_position);
    }
    route.last_position = a.position;

    // Taking off or landing: finish that first, whatever else is asked for.
    if route.mode == NavMotionMode::TakingOff || route.mode == NavMotionMode::Landing {
        let landing = route.mode == NavMotionMode::Landing;
        let (to, up) = (route.transition_to, route.transition_up);
        let done = transition(&mut a.position, &mut a.rotation, to, up, flyer, frame.dt);
        a.route.flown_since_takeoff += a.position.distance(a.route.last_position);
        a.route.last_position = a.position;
        if done && landing {
            record_flight(stats, &a.route, flyer);
            a.route.replan_pending = true;
        }
        if done {
            let k = a.route.leg + 1;
            start_leg(cx, a, k, mesh, flyer);
        }
        return;
    }

    // A search wrote a new route: start it.
    if a.route.planned {
        a.route.planned = false;
        if a.route.state == NavRouteState::Failed {
            let mut w = NavWarning::new(NavWarningKind::RouteOffMesh);
            w.a = a.position;
            w.b = a.route.goal;
            warnings.add(&w);
            return;
        }
        start_leg(cx, a, 0, mesh, flyer);
        return;
    }

    if a.route.leg_requested && !a.request_enabled {
        a.route.leg_requested = false; // the leg's path is computed
    }
    let leg_end = a.legs.get(a.route.leg.max(0) as usize).filter(|_| a.route.leg >= 0).map_or(Float3::default(), |l| l.end);
    let own_request = a.route.leg_requested && a.request.goal == leg_end;
    let mut goal = a.route.goal;
    let mut replan = false;
    let mut new_goal = false; // the game or a chased target names the goal (over one being searched for)
    if a.request_enabled && !own_request {
        goal = a.request.goal; // the game asked for a route
        replan = true;
        new_goal = true;
        a.request_enabled = false;
        a.route.leg_requested = false;
    }

    // A search asked for or running: its goal is the one the agent heads for next.
    let searching = a.route.search.is_some() || a.search_requested;
    if let Some((target_pos, repath_distance)) = chase {
        let chased = if searching { a.search_request.goal } else { a.route.goal };
        if (a.route.state == NavRouteState::None && !searching) || target_pos.distance(chased) > repath_distance {
            goal = target_pos;
            replan = true;
            new_goal = true;
        }
    }

    if a.route.replan_pending && a.route.mode == NavMotionMode::Walking {
        a.route.replan_pending = false;
        replan = true;
    }

    let active = a.route.state == NavRouteState::Following || a.route.state == NavRouteState::Partial;
    let mut repath_leg = false;
    if a.route.state != NavRouteState::None && a.route.state != NavRouteState::Arrived {
        // Across chunks, a rebuild replans only routes it changed something on (or short of their goal).
        if cx.across && a.route.version != cx.version {
            let chunks: Vec<Hash128> = a.legs.iter().map(|l| l.chunk).collect();
            if !route_affected(frame, a.route.version, a.route.state == NavRouteState::Partial && !a.route.to_edge, a.route.to_edge, a.chunk.chunk, a.route.leg, &chunks) {
                a.route.version = cx.version;
            }
        }
        let stale = if cx.across {
            a.route.version != cx.version
        } else {
            a.route.nav != frame.world.nav_key(a.chunk.entry) || a.route.volume != frame.world.volume_key(a.chunk.entry)
        };
        if stale {
            replan = true;
        }
        // A runtime cost volume changed costs on a chunk the route still crosses (ADR 0070).
        let from = (a.route.leg.max(0) as usize).min(a.legs.len());
        if costs_changed_on(frame, chunk.agent_type, a.legs[from..].iter().map(|l| l.chunk).chain(std::iter::once(a.chunk.chunk))) {
            replan = true;
        }
        let interval = if a.route.mode == NavMotionMode::Flying { flyer.repath_interval } else { mesh.repath_interval };

        // On the timer: in flight the route is planned again; walking, only the current leg's path is.
        if interval > 0.0 && frame.time - a.route.computed_time >= interval as f64 {
            if a.route.mode == NavMotionMode::Flying || a.route.state == NavRouteState::Failed {
                replan = true;
            } else {
                repath_leg = true;
            }
        }
    }

    // Mid-fold or mid-jump the contact point is off the navmesh: no route can start there, nor a timer repath.
    let crossing = a.route.mode == NavMotionMode::Walking && a.path.state == NavPathState::Following && (a.path.is_fold_segment() || a.path.is_jump_segment());

    // Ask for a search (one already asked for or running covers anything but a new goal).
    if replan && (!searching || new_goal) {
        let mut waited = false;
        let old_edge = a.legs.last().map_or(Float3::default(), |l| l.end);
        if cx.across {
            let reach = if a.route.mode == NavMotionMode::Walking { mesh.arrival_distance.max(2.0 * mesh.radius) } else { flyer.crossing_reach().max(flyer.arrival_distance) };
            waited = a.route.to_edge && a.route.version != cx.version && !a.legs.is_empty() && RouteStats::waiting_at(a.position, old_edge, reach);
        }
        let key = NavRouteKey {
            mode: a.route.mode as u8,
            start_chunk: hash_code(chunk.chunk).wrapping_mul(2).wrapping_add(chunk.overlay as i32),
            start_cell: cell_of(a.position, NavRouteKey::START_CELL_SIZE),
            goal_cell: cell_of(goal, NavRouteKey::GOAL_CELL_SIZE),
            settings: content_hash(&*walk.settings).wrapping_mul(31).wrapping_add(content_hash(&*flight.settings)),
            flown: if flyer.max_flight_distance > 0.0 && a.route.mode != NavMotionMode::Walking { (a.route.flown_since_takeoff / NavRouteKey::FLOWN_STEP) as i32 } else { 0 },
            unique,
        };
        a.search_request = NavRouteSearchRequestData { key, goal, old_edge, waited, urgent: new_goal };
        a.search_requested = true;
    }

    if !active || a.route.leg as usize >= a.legs.len() {
        return;
    }

    // The current leg: done when its path has arrived, or (into the next chunk) once the agent is near its exit.
    let leg = a.legs[a.route.leg as usize];
    let (leg_path, leg_goal) = if leg.kind == NavRouteLegKind::Walk { (a.path.state, a.path.goal) } else { (a.fly_path.state, a.fly_path.goal) };
    if a.route.leg_requested && leg_path == NavPathState::None {
        return;
    }
    let stale_path = a.route.leg_requested && leg_goal.distance_sq(leg.end) > 1e-4;
    if repath_leg && !a.route.leg_requested && a.route.mode == NavMotionMode::Walking && leg.kind == NavRouteLegKind::Walk && !crossing && a.path.state != NavPathState::Arrived {
        a.route.computed_time = frame.time;
        a.request.start_from_current_position = true;
        a.request.start = a.position;
        a.request.goal = leg.end;
        a.request.urgent = false;
        a.request_enabled = true;
        a.route.leg_requested = true;
        return;
    }
    let state = leg_path;
    if state == NavPathState::Failed && !a.route.leg_requested {
        a.route.state = NavRouteState::Failed;
        return;
    }

    // Into the next chunk, same mode: done once near the seam.
    let into_next = (a.route.leg as usize) < a.legs.len() - 1 && a.legs[a.route.leg as usize + 1].kind == leg.kind;
    let mut at_seam = false;
    if into_next && leg.kind == NavRouteLegKind::Walk {
        at_seam = distance_to_segment(a.surface.surface_position, leg.exit_a, leg.exit_b) <= mesh.arrival_distance.max(2.0 * mesh.radius);
    } else if into_next {
        let p = a.position;
        at_seam = p.distance(p.clamp(leg.exit_a.min_v(leg.exit_b), leg.exit_a.max_v(leg.exit_b))) <= flyer.crossing_reach();
    }
    if (state != NavPathState::Arrived || stale_path) && !at_seam {
        return;
    }
    if a.route.leg as usize == a.legs.len() - 1 {
        if a.route.state == NavRouteState::Following {
            a.route.state = NavRouteState::Arrived;
        }
        return;
    }
    if into_next {
        let k = a.route.leg + 1;
        start_leg(cx, a, k, mesh, flyer);
        return;
    }

    // Take off or land: both mode tags on, so only this job moves the agent until it's done.
    a.walking = true;
    a.flying = true;
    if leg.kind == NavRouteLegKind::Walk {
        a.route.mode = NavMotionMode::TakingOff;
        a.route.flown_since_takeoff = 0.0;
        a.route.transition_to = leg.next_start;
        a.route.transition_up = leg.next_up;
    } else {
        a.route.mode = NavMotionMode::Landing;
        a.route.transition_to = leg.next_start + leg.next_up * mesh.pivot_offset;
        a.route.transition_up = leg.next_up;
    }
}

/// `NavRouteJob.StartLeg`: switches the mode tags, clears the other mode's stale path and asks the leg's path system
/// for a path to the leg's end.
fn start_leg(cx: &RouteCtx, a: &mut RouteAgent, k: i32, mesh: &NavMeshAgent, flyer: &NavFlightAgent) {
    let snap = cx.frame.world.snapshot();
    if k < 0 || k as usize >= a.legs.len() {
        // Out of legs mid-takeoff or mid-landing: end in the mode it was going to.
        if a.route.mode == NavMotionMode::TakingOff {
            a.route.mode = NavMotionMode::Flying;
            a.walking = false;
            a.flying = true;
        } else if a.route.mode == NavMotionMode::Landing {
            a.surface.surface_position = a.position - a.route.transition_up * mesh.pivot_offset;
            a.surface.up = a.route.transition_up;
            a.surface.initialized = true;
            a.route.mode = NavMotionMode::Walking;
            a.walking = true;
            a.flying = false;
        }
        a.route.state = NavRouteState::Arrived;
        return;
    }
    let ku = k as usize;
    let mut leg = a.legs[ku];
    let fly = leg.kind == NavRouteLegKind::Fly;

    // Across chunks: on to the leg's chunk (its overlay's entry for a walk on the overlay).
    let mut moved = false;
    if leg.chunk != Hash128::default() && usize::try_from(a.chunk.entry).ok().is_some_and(|e| e < snap.entries.len()) {
        let agent_type = snap.entries[a.chunk.entry as usize].agent_type;
        if let Some(entry) = snap.find(leg.chunk, agent_type, leg.overlay && !fly) {
            moved = entry as i32 != a.chunk.entry;
            a.chunk.chunk = leg.chunk;
            a.chunk.entry = entry as i32;
        }
        if ku + 1 < a.legs.len() && a.legs[ku + 1].kind == leg.kind {
            leg.end = if fly {
                face_point(leg.exit_a, leg.exit_b, a.position, flyer.radius, leg.end)
            } else {
                seam_point(leg.exit_a, leg.exit_b, a.surface.surface_position, mesh.radius, leg.end)
            };
            a.legs[ku] = leg;
        }
    }
    if a.route.mode == NavMotionMode::Landing {
        // Down on the ground: the mover continues from the landing point, on its surface.
        a.surface.surface_position = a.position - a.route.transition_up * mesh.pivot_offset;
        a.surface.up = a.route.transition_up;
        a.surface.initialized = true;
    }

    if fly && a.route.mode == NavMotionMode::Walking {
        a.route.flown_since_takeoff = 0.0; // in the air without a takeoff
    }
    let mode = if fly { NavMotionMode::Flying } else { NavMotionMode::Walking };
    let switching = a.route.mode != mode;
    a.route.leg = k;
    a.route.mode = mode;
    a.walking = !fly;
    a.flying = fly;

    // The mode's path from an earlier leg is stale: drop it so its mover waits for the new one.
    if switching && fly {
        a.fly_path.state = NavPathState::None;
        a.fly_path.count = 0;
        a.fly_path.next_index = 0;
    } else if switching || (moved && !fly) {
        a.path.state = NavPathState::None;
        a.path.count = 0;
        a.path.next_index = 0;
    }

    // A flight that ends at a landing has to get close to the landing point; into the next chunk's volume it only has
    // to come within CrossingReach of the face.
    let crossing = ku + 1 < a.legs.len() && a.legs[ku + 1].kind == leg.kind;
    let last = ku == a.legs.len() - 1;
    a.fly_path.arrival_distance = if fly && !last {
        if crossing { flyer.crossing_reach() } else { flyer.waypoint_reached_distance }
    } else {
        0.0
    };

    a.request.start_from_current_position = true;
    a.request.start = a.position;
    a.request.goal = leg.end;
    a.request.urgent = k > 0 || moved || switching;
    a.request_enabled = true;
    a.route.leg_requested = true;
}

/// A flight just touched down: counted for the report.
fn record_flight(stats: &mut RouteStats, route: &NavRoute, flyer: &NavFlightAgent) {
    stats.add(RouteStats::LANDED);
    stats.max(RouteStats::LONGEST_FLIGHT, (route.flown_since_takeoff * 100.0) as i32);
    if flyer.max_flight_distance > 0.0 && route.flown_since_takeoff > flyer.max_flight_distance * 1.05 + 1.0 {
        stats.add(RouteStats::OVER_LIMIT);
    }
}

/// `NavRouteSearchAssignJob`: returns the shares, the searches to step (pool order) and how many requests waited.
fn assign_routes(cx: &RouteCtx, pool: &mut SearchPool<NavRouteSearch>, agents: &mut AgentStore, ty: Hash128) -> (Vec<RouteShare>, Vec<usize>, usize) {
    let mut shares = Vec::new();
    let n = pool.len();
    let mut free: Vec<usize> = Vec::with_capacity(n);
    let mut finished: Vec<(f64, usize)> = Vec::new();
    let mut running: HashMap<NavRouteKey, usize> = HashMap::new();
    let mut done: HashMap<NavRouteKey, usize> = HashMap::new();
    for i in (0..n).rev() {
        let e = &pool.entries[i];
        let s = &e.search;
        if e.active {
            if s.key.shareable() {
                running.entry(s.key).or_insert(i);
            }
        } else if cx.across && s.done && s.version == cx.version && s.key.shareable() && !done.contains_key(&s.key) {
            done.insert(s.key, i);
            finished.push((s.done_time, i));
        } else {
            free.push(i);
        }
    }
    finished.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)); // oldest first: the first to give up
    let mut evict = 0;

    // Requesters (the agents asking), urgent first.
    let mut order: Vec<usize> = agents
        .active_rows()
        .filter(|&r| {
            let d = &agents.data[r];
            d.kind == AgentKind::WalkFly && d.agent_type == ty && d.route.as_deref().is_some_and(|x| x.search_requested)
        })
        .collect();
    order.sort_by_key(|&r| !agents.data[r].route.as_deref().expect("route").request.urgent); // stable: row order within

    let mut waiting = 0;
    for r in order {
        let Some(id) = agents.id_of(r) else { continue };
        let (route, request, ready) = {
            let d = &agents.data[r];
            let rd = d.route.as_deref().expect("route");
            let ready = if rd.route.mode == NavMotionMode::TakingOff || rd.route.mode == NavMotionMode::Landing {
                false
            } else if rd.route.mode != NavMotionMode::Walking {
                true
            } else {
                match d.walker.as_deref() {
                    Some(w) => w.path.state != NavPathState::Following || !(w.path.is_fold_segment() || w.path.is_jump_segment()),
                    None => true,
                }
            };
            (rd.route, rd.request, ready)
        };
        if !ready {
            continue;
        }
        let key = request.key;

        // Another agent's finished search with its key, in the mode it asked in: that route.
        if key.shareable() && same_key_mode(&route, &key) {
            if let Some(&found) = done.get(&key) {
                let s = &pool.entries[found].search;
                shares.push(RouteShare { row: r, search: found, goal: request.goal, status: s.status, at_edge: s.at_edge, nav: s.nav, volume: s.volume, version: s.version });
                let rd = agents.data[r].route.as_deref_mut().expect("route");
                rd.search_requested = false;
                rd.route.search = None; // a search of its own still running stops
                continue;
            }
        }

        // Its running search starts over for the new goal; one of another agent with its key, it waits for; else a free
        // one, or the oldest finished one.
        let own = route.search.filter(|&s| (s as usize) < n && pool.entries[s as usize].active && pool.entries[s as usize].search.agent == id).map(|s| s as usize);
        let search = if let Some(s) = own {
            s
        } else if key.shareable() && cx.across && running.contains_key(&key) {
            continue; // next tick, or once it's done
        } else if let Some(f) = free.pop() {
            f
        } else if evict < finished.len() {
            let s = finished[evict].1;
            evict += 1;
            done.remove(&pool.entries[s].search.key);
            s
        } else {
            waiting += 1;
            continue;
        };
        {
            let e = &mut pool.entries[search];
            e.search.assign(id);
            e.search.key = key;
            e.search.phase = NavRouteSearchPhase::Locate;
            e.search.goal = request.goal;
            e.search.old_edge = request.old_edge;
            e.search.waited = request.waited;
            e.search.urgent = request.urgent;
            e.active = true;
        }
        let rd = agents.data[r].route.as_deref_mut().expect("route");
        rd.search_requested = false;
        rd.route.search = Some(search as u32);
        if key.shareable() && cx.across {
            running.entry(key).or_insert(search);
        }
    }
    let stepping = (0..n).filter(|&i| pool.entries[i].active).collect();
    (shares, stepping, waiting)
}

/// `NavRouteShareJob`: the routes the assign job gave out go into their agents.
fn share_routes(frame: &Frame, pool: &SearchPool<NavRouteSearch>, agents: &mut AgentStore, shares: &[RouteShare]) {
    for s in shares {
        let results = &pool.entries[s.search].search.legs;
        let Some(rd) = agents.data[s.row].route.as_deref_mut() else { continue };
        rd.legs.clear();
        rd.legs.extend_from_slice(results);
        if !s.at_edge && s.status == NavPathStatus::Success {
            if let Some(last) = rd.legs.last_mut() {
                last.end = s.goal; // its own goal, in the cell the route was found for
            }
        }
        let route = &mut rd.route;
        route.goal = s.goal;
        route.computed_time = frame.time;
        route.nav = s.nav;
        route.volume = s.volume;
        route.version = s.version;
        route.leg = 0;
        route.to_edge = s.at_edge;
        route.state = if rd.legs.is_empty() {
            NavRouteState::Failed
        } else if s.status == NavPathStatus::Success {
            NavRouteState::Following
        } else {
            NavRouteState::Partial
        };
        route.planned = true;
        route.search = None;
    }
}

/// The usable polygon nearest `p` within `max_distance`: on graph `own` only within one chunk, else on any graph.
fn locate_ground(cx: &RouteCtx, graphs: &RouteGraphs, ground: &NavMeshQueryFilter, own: i32, p: Float3, max_distance: f32, end: &mut NavChunkRouteEnd) {
    if cx.across {
        match routing::locate(graphs, ground, p, max_distance, Float3::default()) {
            Some((g, poly, pos)) => {
                end.graph = g;
                end.poly = poly;
                end.ground_pos = pos;
            }
            None => {
                end.graph = -1;
                end.poly = -1;
            }
        }
        return;
    }
    if own < 0 {
        return;
    }
    let filter = graphs.filter_for(own, ground);
    match find_nearest_poly(&graphs.graphs[own as usize].nav, p, max_distance, &filter) {
        Some((poly, pos)) => {
            end.poly = poly;
            end.ground_pos = pos;
            end.graph = own;
        }
        None => {
            end.poly = -1;
            end.graph = -1;
        }
    }
}

/// The free air nearest `p` within `max_distance`: in `prefer` if it has some, else (across chunks) in the nearest
/// volume.
fn snap_air_pref(cx: &RouteCtx, graphs: &RouteGraphs, prefer: i32, p: Float3, max_distance: f32, end: &mut NavChunkRouteEnd) {
    if prefer >= 0 && (prefer as usize) < graphs.volumes.len() {
        let (leaf, pos) = volume::snap_to_free(&graphs.volumes[prefer as usize].volume, p, max_distance);
        end.leaf = leaf;
        end.air_pos = pos;
        if leaf >= 0 {
            end.volume = prefer;
            return;
        }
    }
    if !cx.across {
        return;
    }
    let mut best = f32::MAX;
    for (v, rv) in graphs.volumes.iter().enumerate() {
        let (leaf, pos) = volume::snap_to_free(&rv.volume, p, max_distance);
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

/// Frees the search, keeping its stamp; nothing shared.
fn free_route_search(e: &mut PooledSearch<NavRouteSearch>) {
    e.search.done = false;
    e.active = false;
}

/// The search can't finish usefully: its agent asks again for the same goal, and the search is freed.
fn requeue(e: &mut PooledSearch<NavRouteSearch>, rd: &mut RouteData) {
    let s = &e.search;
    rd.request = NavRouteSearchRequestData { key: s.key, goal: s.goal, old_edge: s.old_edge, waited: s.waited, urgent: s.urgent };
    rd.search_requested = true;
    rd.route.search = None;
    free_route_search(e);
}

/// `NavRouteSearchStepJob.Execute` for the search at pool index `i`.
#[allow(clippy::too_many_arguments)]
fn step_route_search(cx: &RouteCtx, graphs: &RouteGraphs, pool: &mut SearchPool<NavRouteSearch>, i: usize, stats: &mut RouteStats, agents: &mut AgentStore, frame: &Frame, _warnings: &mut Warnings) {
    let e = &mut pool.entries[i];
    let Some(r) = agents.row(e.search.agent) else {
        free_route_search(e); // the agent is gone
        return;
    };
    let across = cx.across;
    let mut rd = match agents.data[r].route.take() {
        Some(rd) => rd,
        None => {
            free_route_search(e);
            return;
        }
    };
    step_route_search_inner(cx, graphs, e, i, stats, agents, r, &mut rd, frame, across);
    agents.data[r].route = Some(rd);
}

#[allow(clippy::too_many_arguments)]
fn step_route_search_inner(
    cx: &RouteCtx,
    graphs: &RouteGraphs,
    e: &mut PooledSearch<NavRouteSearch>,
    i: usize,
    stats: &mut RouteStats,
    agents: &AgentStore,
    r: usize,
    rd: &mut RouteData,
    frame: &Frame,
    across: bool,
) {
    if rd.route.search != Some(i as u32) || rd.search_requested {
        // The agent asked again since: this result would be stale.
        if rd.route.search == Some(i as u32) {
            rd.route.search = None;
        }
        free_route_search(e);
        return;
    }
    let d = &agents.data[r];
    let (Some(walk), Some(flight)) = (d.walk.as_ref(), d.flight.as_ref()) else {
        free_route_search(e);
        return;
    };
    let mesh = walk.settings.clone();
    let flyer = flight.effective();
    let costs = effective_area_costs(frame.world_area_costs, &d.area_costs);
    let PooledSearch { search, store, .. } = &mut *e;
    let mut legs: Vec<NavRouteLeg> = Vec::new();

    if search.phase == NavRouteSearchPhase::Locate {
        let located = locate_route(cx, graphs, search, store, agents, r, rd, &mesh, &flyer, &costs, frame);
        if !located {
            requeue(e, rd);
            return;
        }
        if search.state.finished {
            // Nowhere to start, or no goal: InvalidInput.
            if across {
                stats.record(NavPathStatus::InvalidInput, false, 0, search.state.max_nodes.max(0) as usize, false);
            }
            apply_route(e, rd, &legs, NavPathStatus::InvalidInput, false, &mesh, &flyer, stats, across, frame);
            return;
        }
    } else if !still_valid(cx, graphs, search, frame) {
        requeue(e, rd); // the graphs it was searching changed: search again on the new ones
        return;
    }

    let Some(nav) = ground_nav(graphs, search, agents, r, frame) else {
        requeue(e, rd);
        return;
    };
    let ground = walk_filter(&mesh, &nav, &costs);
    search.frames += 1;
    if !route_search::step(&mut search.state, store, graphs, &ground, &search.air_filters, ROUTE_SLICE) {
        return; // more next tick
    }

    let (status, at_edge) = route_search::finish(&search.state, store, graphs, &mut legs);
    if search.phase == NavRouteSearchPhase::Search {
        if across {
            stats.record(status, at_edge, store.nodes.len(), search.state.max_nodes.max(0) as usize, search.state.settings.max_flight_distance > 0.0);
        }
        // Out of flight in the air (no ground within the limit): land at the nearest place, however far. So does an
        // agent that starts in the air without having taken off.
        if flyer.land_when_out_of_reach
            && (search.mode == NavMotionMode::Flying || !search.start.on_ground())
            && status == NavPathStatus::Partial
            && !at_edge
            && legs.last().is_some_and(|l| l.kind == NavRouteLegKind::Fly)
        {
            stats.add(RouteStats::EMERGENCY_LANDINGS);
            let mut landing = search.state.settings;
            landing.max_flight_distance = 0.0;
            landing.land_when_short = false;
            landing.nearest_landing = true;
            store.begin();
            search.stamp = store.stamp;
            route_search::begin(&mut search.state, store, &ground, &search.air_filters, &landing, &search.start, &NavChunkRouteEnd::NONE, false, Float3::default());
            search.phase = NavRouteSearchPhase::Landing;
            return; // on next tick
        }
    }

    walk_short_chunk_flights(graphs, &ground, flyer.walk_instead_ratio, mesh.max_snap_distance, &mut legs, if across { -1 } else { search.own_graph });
    apply_route(e, rd, &legs, status, at_edge, &mesh, &flyer, stats, across, frame);
}

/// The navmesh the search's agent is on: its own graph's, else its entry's.
fn ground_nav(graphs: &RouteGraphs, search: &NavRouteSearch, agents: &AgentStore, r: usize, frame: &Frame) -> Option<Arc<NavMeshData>> {
    if search.own_graph >= 0 && (search.own_graph as usize) < graphs.graphs.len() {
        return Some(graphs.graphs[search.own_graph as usize].nav.clone());
    }
    usize::try_from(agents.chunk[r].entry).ok().and_then(|e| frame.world.snapshot().entries.get(e)).and_then(|e| e.nav.clone())
}

/// The graphs the search runs on are the ones it started on: same version across chunks; within one chunk, its graph
/// (its entry) still holds the navmesh and volume it located on.
fn still_valid(cx: &RouteCtx, graphs: &RouteGraphs, search: &NavRouteSearch, frame: &Frame) -> bool {
    if !search.within {
        return cx.across && search.version == cx.version;
    }
    let g = search.own_graph;
    !cx.across && g >= 0 && (g as usize) < graphs.graphs.len() && frame.world.nav_key(g) == search.nav && frame.world.volume_key(g) == search.volume
}

/// `NavRouteSearchStepJob.Locate`: finds the route's ends from where the agent is (walking or flying), makes the flight
/// filters and starts the A*. False if the agent has no chunk to route on right now.
#[allow(clippy::too_many_arguments)]
fn locate_route(
    cx: &RouteCtx,
    graphs: &RouteGraphs,
    search: &mut NavRouteSearch,
    store: &mut nav_query::search::SearchBufferStore,
    agents: &AgentStore,
    r: usize,
    rd: &RouteData,
    mesh: &NavMeshAgent,
    flyer: &NavFlightAgent,
    costs: &[NavMeshAgentAreaCost],
    frame: &Frame,
) -> bool {
    let snap = frame.world.snapshot();
    let ac = agents.chunk[r];
    let Some(chunk) = usize::try_from(ac.entry).ok().and_then(|e| snap.entries.get(e)) else { return false };
    let Some(chunk_nav) = chunk.nav.clone() else { return false };
    if !cx.across && (chunk.volume.is_none() || chunk.links.is_none()) {
        return false;
    }
    let own = if cx.across { graphs.graph_of(chunk.chunk, chunk.overlay) } else { ac.entry };
    let position = agents.position[r];
    let surface = agents.surface[r];
    let route = &rd.route;
    let ground = walk_filter(mesh, &chunk_nav, costs);
    search.air_filters.clear();
    for rv in &graphs.volumes {
        search.air_filters.push(if rv.volume.leaves.is_empty() && rv.links.is_none() { NavVolumeQueryFilter::default() } else { flight_filter(&rv.volume, costs) });
    }

    // Start: in the air if flying, else on the ground; on the agent's own graph or volume first.
    let mut own_volume = if own >= 0 && (own as usize) < graphs.graphs.len() { graphs.graphs[own as usize].volume } else { -1 };
    if !cx.across {
        own_volume = own;
    }
    let mut start = NavChunkRouteEnd::NONE;
    let tolerance = 0.5 * mesh.step_height.max(1e-3);
    if route.mode == NavMotionMode::Flying {
        snap_air_pref(cx, graphs, own_volume, position, flyer.max_snap_distance, &mut start);
    } else {
        if own >= 0 && (own as usize) < graphs.graphs.len() {
            let own_filter = graphs.filter_for(own, &ground);
            if let Some((poly, pos)) = find_nearest_poly_sided(&graphs.graphs[own as usize].nav, surface.surface_position, mesh.max_snap_distance, &own_filter, surface.up, tolerance) {
                start.poly = poly;
                start.ground_pos = pos;
                start.graph = own;
            }
            // The same chunk's other graph (its overlay, or the chunk under the overlay) if the agent stands nearer to it.
            let other = if cx.across { graphs.graph_of(chunk.chunk, !chunk.overlay) } else { -1 };
            if other >= 0 {
                let other_filter = graphs.filter_for(other, &ground);
                if let Some((poly, point)) = find_nearest_poly_sided(&graphs.graphs[other as usize].nav, surface.surface_position, mesh.max_snap_distance, &other_filter, surface.up, tolerance) {
                    if start.poly < 0 || point.distance_sq(surface.surface_position) < start.ground_pos.distance_sq(surface.surface_position) {
                        start.graph = other;
                        start.poly = poly;
                        start.ground_pos = point;
                    }
                }
            }
        }
        if start.poly < 0 && cx.across {
            if let Some((g, poly, pos)) = routing::locate(graphs, &ground, surface.surface_position, mesh.max_snap_distance, surface.up) {
                start.graph = g;
                start.poly = poly;
                start.ground_pos = pos;
            }
        }
    }

    // Not where its mode says: start from the other one.
    if !start.on_ground() && !start.in_air() {
        if route.mode == NavMotionMode::Flying {
            locate_ground(cx, graphs, &ground, own, position, mesh.max_snap_distance + mesh.pivot_offset, &mut start);
        } else {
            snap_air_pref(cx, graphs, own_volume, position, flyer.max_snap_distance, &mut start);
        }
    }

    // Goal: in unloaded space, the edge; else on the ground, in the air, or both.
    let goal = search.goal;
    let to_edge = cx.across && (!graphs.frontier.is_empty() || !graphs.air_frontier.is_empty()) && !route_graph::loaded(snap, chunk.agent_type, goal);
    let mut end = NavChunkRouteEnd::NONE;
    if !to_edge {
        locate_ground(cx, graphs, &ground, own, goal, mesh.max_snap_distance, &mut end);
        snap_air_pref(cx, graphs, if cx.across { -1 } else { own_volume }, goal, if end.on_ground() { 0.0 } else { flyer.max_snap_distance }, &mut end);
    }

    let settings = NavHybridParams {
        flight_cost_multiplier: flyer.flight_cost_multiplier,
        takeoff_cost: flyer.takeoff_cost,
        landing_cost: flyer.landing_cost,
        max_flight_distance: flyer.max_flight_distance,
        land_when_short: flyer.land_when_out_of_reach,
        flown_so_far: if route.mode == NavMotionMode::Flying { route.flown_since_takeoff } else { 0.0 },
        min_landing_slope_cos: nav_math::math::radians(flyer.max_landing_slope_deg).cos(),
        takeoff_height: flyer.takeoff_height,
        max_nodes: (mesh.max_search_nodes + flyer.max_search_nodes) * if cx.across { graphs.budget_scale() } else { 1 },
        min_leaf_cost: graphs.leaf_cost_min(),
        ..NavHybridParams::default()
    };

    search.within = !cx.across;
    search.version = cx.version;
    search.own_graph = own;
    search.nav = frame.world.nav_key(ac.entry);
    search.volume = frame.world.volume_key(ac.entry);
    search.mode = route.mode;
    search.start = start;
    search.phase = NavRouteSearchPhase::Search;
    store.begin();
    search.stamp = store.stamp;
    route_search::begin(&mut search.state, store, &ground, &search.air_filters, &settings, &start, &end, to_edge, goal);
    true
}

/// `NavRouteSearchStepJob.Apply`: writes the finished search into its agent's route and frees the search.
#[allow(clippy::too_many_arguments)]
fn apply_route(
    e: &mut PooledSearch<NavRouteSearch>,
    rd: &mut RouteData,
    legs: &[NavRouteLeg],
    status: NavPathStatus,
    at_edge: bool,
    mesh: &NavMeshAgent,
    flyer: &NavFlightAgent,
    stats: &mut RouteStats,
    across: bool,
    frame: &Frame,
) {
    let _ = across;
    if e.search.phase != NavRouteSearchPhase::Locate && rd.route.mode != e.search.mode {
        requeue(e, rd); // the agent took off or landed on its old route: the route starts somewhere it no longer is
        return;
    }
    let search = &mut e.search;
    rd.legs.clear();
    rd.legs.extend_from_slice(legs);
    let route = &mut rd.route;
    route.goal = search.goal;
    route.computed_time = frame.time;
    route.nav = search.nav;
    route.volume = search.volume;
    if !search.within {
        route.version = search.version;
    }
    route.leg = 0;
    route.to_edge = at_edge;
    route.state = if status == NavPathStatus::InvalidInput || legs.is_empty() {
        NavRouteState::Failed
    } else if status == NavPathStatus::Success {
        NavRouteState::Following
    } else {
        NavRouteState::Partial
    };
    route.planned = true;
    route.search = None;

    // It waited at an opening onto unloaded space and was planned anew after a load: the dead-end count.
    if search.waited && !search.within {
        let reach = if search.mode == NavMotionMode::Walking { mesh.arrival_distance.max(2.0 * mesh.radius) } else { flyer.crossing_reach().max(flyer.arrival_distance) };
        let planned = route.state != NavRouteState::Failed;
        let through = planned && legs.iter().any(|l| RouteStats::near(l.end, search.old_edge, reach));
        stats.edge_replan(search.old_edge, planned, at_edge, if planned { legs[legs.len() - 1].end } else { Float3::default() }, through, reach);
    }

    // Across chunks, the legs stay for the agents asking with its key (`assign_routes` shares them).
    search.legs.clear();
    search.legs.extend_from_slice(legs);
    // Shared only if it reaches the goal (or the edge of loaded space).
    search.done = !search.within && (status == NavPathStatus::Success || at_edge);
    search.status = status;
    search.at_edge = at_edge;
    search.done_time = frame.time;
    e.active = false;
}

// ---------------------------------------------------------------------------------------------------------------------
// NavChunkRouteSystem: walkers
// ---------------------------------------------------------------------------------------------------------------------

/// `NavChunkRoute.Target`: where the current leg goes: its end, or on the last leg the goal (or the edge it waits at).
fn chunk_target(route: &NavChunkRoute, legs: &[NavChunkLeg]) -> Float3 {
    if (route.leg as usize) + 1 < legs.len() {
        return legs[route.leg.max(0) as usize].end;
    }
    if route.to_edge { legs.last().map_or(Float3::default(), |l| l.end) } else { route.goal }
}

fn through(legs: &[NavChunkLeg], edge: Float3, reach: f32) -> bool {
    legs.iter().any(|l| RouteStats::near(l.end, edge, reach))
}

/// `NavChunkRouteSystem`: walkers' routes across chunks and overlays.
pub fn chunk_routes(sys: &mut RouteSystems, agents: &mut AgentStore, _targets: &Targets, frame: &Frame, _warnings: &mut Warnings) {
    let types: Vec<Hash128> = frame.world.snapshot().agent_types.clone();
    for ty in types {
        let Some(graphs) = frame.world.route_graphs(ty) else { continue }; // one navmesh: ordinary paths do
        let rows: Vec<usize> = agents
            .active_rows()
            .filter(|&r| {
                let d = &agents.data[r];
                d.agent_type == ty && d.route.is_none() && d.walk.is_some() && d.walker.is_some() && d.chunk_route.is_some()
            })
            .collect();
        let mut asks: Vec<ChunkAsk> = Vec::new();
        for &r in &rows {
            chunk_route_job(frame, graphs, ty, agents, r, &mut sys.walk_stats, &mut asks);
        }

        // NavChunkRouteKeysJob: one search per distinct key.
        let mut by_key: HashMap<ChunkRouteKey, usize> = HashMap::new();
        let mut searches: Vec<usize> = Vec::new(); // the ask each search runs for
        let mut ask_search: Vec<usize> = Vec::with_capacity(asks.len());
        for (i, ask) in asks.iter().enumerate() {
            let s = *by_key.entry(ask.key).or_insert_with(|| {
                searches.push(i);
                searches.len() - 1
            });
            ask_search.push(s);
        }
        sys.shared += asks.len() - searches.len();
        // NavChunkRouteSearchJob.
        let outcomes: Vec<ChunkOutcome> = searches.iter().map(|&i| chunk_route_search(graphs, &asks[i])).collect();

        // NavChunkRouteApplyJob.
        for (i, ask) in asks.iter().enumerate() {
            let s = ask_search[i];
            let mut outcome = outcomes[s].clone();
            if outcome.status != NavPathStatus::Success && !outcome.at_edge && searches[s] != i {
                outcome = chunk_route_search(graphs, ask); // a route short of the goal is the searching walker's alone
                sys.shared = sys.shared.saturating_sub(1);
            }
            apply_chunk_route(graphs, agents, ask, &outcome, &mut sys.walk_stats);
        }
    }
}

/// `NavChunkRouteJob.Execute` for one walker.
fn chunk_route_job(frame: &Frame, graphs: &RouteGraphs, ty: Hash128, agents: &mut AgentStore, r: usize, stats: &mut RouteStats, asks: &mut Vec<ChunkAsk>) {
    if is_member(&agents.data[r]) {
        return;
    }
    let Some(mut cd) = agents.data[r].chunk_route.take() else { return };
    chunk_route_job_inner(frame, graphs, ty, agents, r, stats, asks, &mut cd);
    agents.data[r].chunk_route = Some(cd);
}

#[allow(clippy::too_many_arguments)]
fn chunk_route_job_inner(frame: &Frame, graphs: &RouteGraphs, ty: Hash128, agents: &mut AgentStore, r: usize, stats: &mut RouteStats, asks: &mut Vec<ChunkAsk>, cd: &mut ChunkRouteData) {
    let version = frame.world.graphs.version;
    let snap = frame.world.snapshot();
    let d = &agents.data[r];
    if d.flow_agent.is_some_and(|f| f.enabled) {
        cd.route.active = false; // on a flow field; planned afresh if it leaves it
        cd.route.goal = Float3::splat(f32::NAN);
        cd.legs.clear();
        return;
    }
    let Some(entry) = usize::try_from(agents.chunk[r].entry).ok().and_then(|e| snap.entries.get(e)) else { return }; // paused
    if entry.nav.is_none() {
        return;
    }
    let Some(walk) = d.walk.clone() else { return };
    let config = walk;
    let agent = config.settings.clone();
    let surface = agents.surface[r];
    let path = d.walker.as_deref().map(|w| w.path).unwrap_or_default();
    let mut request = d.path_request;
    let mut requested = d.path_request_enabled;
    let mut ac = agents.chunk[r];
    let route = &mut cd.route;
    let legs = &mut cd.legs;
    let costs = effective_area_costs(frame.world_area_costs, &d.area_costs);
    let nav = entry.nav.clone().expect("checked");

    let plan = |route: &mut NavChunkRoute, legs: &mut Vec<NavChunkLeg>, request: &PathRequest, waited: bool, old_edge: Float3, reach: f32, asks: &mut Vec<ChunkAsk>| -> bool {
        plan_chunk_route(frame, graphs, ty, route, legs, request, entry, &nav, &config, &agent, &surface, &costs, r, waited, old_edge, reach, asks)
    };

    let write_back = |agents: &mut AgentStore, request: PathRequest, requested: bool, ac: NavAgentChunk| {
        let d = &mut agents.data[r];
        d.path_request = request;
        d.path_request_enabled = requested;
        agents.chunk[r] = ac;
    };

    // A runtime cost volume changed costs on a chunk the route still crosses (ADR 0070): plan again.
    let from = (route.leg.max(0) as usize).min(legs.len());
    let cost_stale = route.active && costs_changed_on(frame, ty, legs[from..].iter().map(|l| l.chunk));
    // Planned on graphs that have since changed: plan again if it changed on its way, else keep it.
    if route.active && route.version != version {
        let chunks: Vec<Hash128> = legs.iter().map(|l| l.chunk).collect();
        if !route_affected(frame, route.version, route.status == NavPathStatus::Partial && !route.to_edge, route.to_edge, ac.chunk, route.leg, &chunks) {
            route.version = version;
        }
    }
    if route.active && (route.version != version || cost_stale) {
        let reach = agent.arrival_distance.max(2.0 * agent.radius);
        let old_edge = legs.last().map_or(Float3::default(), |l| l.end);
        let waited = route.to_edge && RouteStats::waiting_at(surface.surface_position, old_edge, reach);
        route.active = false;
        if !requested {
            request.start_from_current_position = true;
            request.start = surface.surface_position;
            request.goal = route.goal;
            requested = true;
        } else if request.goal.distance_sq(chunk_target(route, legs)) < 1e-4 {
            request.goal = route.goal; // a leg's repath
        }
        let asked = plan(route, legs, &request, waited, old_edge, reach, asks);
        if waited && !asked {
            stats.edge_replan(old_edge, route.active, route.to_edge, if route.active { legs[legs.len() - 1].end } else { Float3::default() }, through(legs, old_edge, reach), reach);
        }
        write_back(agents, request, requested, ac);
        return;
    }

    // At a leg's exit portal: on to the next leg's navmesh.
    if route.active && (route.leg as usize) + 1 < legs.len() && at_exit(route, legs, &path, &agent, &surface, requested) {
        route.leg += 1;
        let mut leg = legs[route.leg as usize];
        let Some(next) = snap.find(leg.chunk, ty, leg.overlay) else {
            route.active = false; // that navmesh is gone: plan again from here
            request.start_from_current_position = true;
            request.start = surface.surface_position;
            request.goal = route.goal;
            requested = true;
            plan(route, legs, &request, false, Float3::default(), 0.0, asks);
            write_back(agents, request, requested, ac);
            return;
        };
        if (route.leg as usize) + 1 < legs.len() {
            // Across the seam where its way on is straightest, not all at the route's one portal.
            let radius = agent.radius;
            let ends: Vec<Float3> = legs.iter().map(|l| l.end).collect();
            let aim = crossing::aim(&ends, route.leg as usize + 1, route.to_edge, route.goal);
            let from = crossing::graph_of(graphs.graphs.iter().map(|g| (g.chunk, g.overlay)), leg.chunk, leg.overlay).map_or(-1, |g| g as i32);
            let nl = legs[route.leg as usize + 1];
            let to = crossing::graph_of(graphs.graphs.iter().map(|g| (g.chunk, g.overlay)), nl.chunk, nl.overlay).map_or(-1, |g| g as i32);
            let (mut ea, mut eb, mut ee) = (leg.exit_a, leg.exit_b, leg.end);
            if crossing::best_portal(&graphs.links, from, to, surface.surface_position, aim, radius, &mut ea, &mut eb, &mut ee) {
                leg.exit_a = ea;
                leg.exit_b = eb;
                leg.end = ee;
            } else {
                leg.end = seam_point(leg.exit_a, leg.exit_b, surface.surface_position, radius, leg.end);
            }
            legs[route.leg as usize] = leg;
        }
        ac.chunk = leg.chunk;
        ac.entry = next as i32;
        request.start_from_current_position = true;
        request.start = surface.surface_position;
        request.goal = chunk_target(route, legs);
        requested = true;
        request.urgent = true; // it stops at the portal until this path comes: ahead of timer repaths
        write_back(agents, request, requested, ac);
        return;
    }

    if !requested {
        return;
    }

    // A repath of an ordinary path already checked against these graphs, from this navmesh: still not a route.
    if !route.active && route.version == version && route.checked_on_overlay == entry.overlay && request.goal.distance_sq(route.goal) < 1e-4 {
        return;
    }
    // The current leg's own repath: leave it to the path request.
    if route.active && (route.leg as usize) < legs.len() && request.goal.distance_sq(chunk_target(route, legs)) < 1e-4 {
        return;
    }
    plan(route, legs, &request, false, Float3::default(), 0.0, asks);
    write_back(agents, request, requested, ac);
}

/// True once the agent is at the current leg's exit: within reach of the exit portal, or arrived at the leg's end.
fn at_exit(route: &NavChunkRoute, legs: &[NavChunkLeg], path: &NavPath, agent: &NavMeshAgent, surface: &NavMeshAgentSurface, requested: bool) -> bool {
    let leg = legs[route.leg as usize];
    let reach = agent.arrival_distance.max(2.0 * agent.radius);
    if distance_to_segment(surface.surface_position, leg.exit_a, leg.exit_b) <= reach {
        return true;
    }
    !requested && path.state == NavPathState::Arrived && path.goal.distance_sq(leg.end) < 1e-4
}

/// `NavChunkRouteJob.Plan`: a route if the goal is on another navmesh (or past the chunk's overlay by way of it),
/// else an ordinary path. Asks for the (shared) search and returns true.
#[allow(clippy::too_many_arguments)]
fn plan_chunk_route(
    frame: &Frame,
    graphs: &RouteGraphs,
    ty: Hash128,
    route: &mut NavChunkRoute,
    legs: &mut Vec<NavChunkLeg>,
    request: &PathRequest,
    entry: &nav_query::chunks::ChunkEntry,
    nav: &Arc<NavMeshData>,
    config: &NavMeshAgentConfig,
    agent: &NavMeshAgent,
    surface: &NavMeshAgentSurface,
    costs: &[NavMeshAgentAreaCost],
    row: usize,
    waited: bool,
    old_edge: Float3,
    reach: f32,
    asks: &mut Vec<ChunkAsk>,
) -> bool {
    let version = frame.world.graphs.version;
    route.active = false;
    route.to_edge = false;
    legs.clear();
    let Some(start_graph) = graphs.graphs.iter().rposition(|g| g.chunk == entry.chunk && g.overlay == entry.overlay) else { return false };
    let start_graph = start_graph as i32;
    let mut filter = walk_filter(agent, nav, costs);
    filter.agent_speed = config.speed();
    filter.agent_radius = agent.radius;
    let snap = agent.max_snap_distance.max(0.5);
    let to_edge = !graphs.frontier.is_empty() && !route_graph::loaded(frame.world.snapshot(), ty, request.goal);
    let mut goal_graph = -1;
    let mut goal_poly = -1;
    let mut goal_pos = request.goal;
    let from = if request.start_from_current_position { surface.surface_position } else { request.start };
    if !to_edge {
        let Some((g, poly, pos)) = routing::locate(graphs, &filter, request.goal, snap, Float3::default()) else { return false }; // nowhere (yet)
        goal_graph = g;
        goal_poly = poly;
        goal_pos = pos;
        // On the agent's own navmesh: an ordinary path, unless the way there may lead through the chunk's overlay.
        if goal_graph == start_graph && !across_overlay(graphs, start_graph, from, goal_pos, agent.radius) {
            route.goal = request.goal; // remembered, so repaths of an ordinary path skip this
            route.version = version;
            route.checked_on_overlay = entry.overlay;
            return false;
        }
    }

    // Remembered as checked only once both ends are placed.
    let start_filter = graphs.filter_for(start_graph, &filter);
    let Some((start_poly, start_pos)) = find_nearest_poly(&graphs.graphs[start_graph as usize].nav, from, snap, &start_filter) else { return false };
    route.goal = request.goal;
    route.version = version;
    route.checked_on_overlay = entry.overlay;

    asks.push(ChunkAsk {
        row,
        key: ChunkRouteKey {
            start_graph,
            goal_graph: if to_edge { -1 } else { goal_graph },
            goal_cell: cell_of(request.goal, CHUNK_ROUTE_CELL),
            settings: content_hash(&*config.settings),
        },
        settings: config.settings.clone(),
        speed: config.speed(),
        start_poly,
        start_pos,
        goal_poly,
        goal_pos,
        old_edge,
        reach,
        to_edge,
        waited,
    });
    true
}

/// `NavChunkRouteJob.AcrossOverlay`: true if the level line a-b crosses the bounds (widened by radius) of the other
/// navmesh of graph's chunk (its overlay, or the chunk's own polygons the overlay kept).
fn across_overlay(graphs: &RouteGraphs, graph: i32, a: Float3, b: Float3, radius: f32) -> bool {
    let this = &graphs.graphs[graph as usize];
    let overlay = this.overlay;
    if !overlay && this.switched_off_count == 0 {
        return false;
    }
    for (g, other) in graphs.graphs.iter().enumerate() {
        if g as i32 == graph || other.overlay == overlay || other.chunk != this.chunk {
            continue;
        }
        let nav = &other.nav;
        let (mut min, mut max) = ((f32::MAX, f32::MAX), (f32::MIN, f32::MIN));
        for p in 0..nav.poly_min.len() {
            // The chunk's own navmesh: only the polygons the overlay didn't replace.
            if overlay && p < other.switched_off_count && graphs.switched_off[other.switched_off_start + p] {
                continue;
            }
            min = (nav_math::math::min(min.0, nav.poly_min[p].x), nav_math::math::min(min.1, nav.poly_min[p].z));
            max = (nav_math::math::max(max.0, nav.poly_max[p].x), nav_math::math::max(max.1, nav.poly_max[p].z));
        }
        if min.0 <= max.0 && min.1 <= max.1 && segment_hits_box((a.x, a.z), (b.x, b.z), (min.0 - radius, min.1 - radius), (max.0 + radius, max.1 + radius)) {
            return true;
        }
    }
    false
}

fn segment_hits_box(a: (f32, f32), b: (f32, f32), min: (f32, f32), max: (f32, f32)) -> bool {
    let d = [b.0 - a.0, b.1 - a.1];
    let (a, min, max) = ([a.0, a.1], [min.0, min.1], [max.0, max.1]);
    let (mut t0, mut t1) = (0.0f32, 1.0f32);
    for axis in 0..2 {
        if d[axis].abs() < 1e-6 {
            if a[axis] < min[axis] || a[axis] > max[axis] {
                return false;
            }
            continue;
        }
        let u = (min[axis] - a[axis]) / d[axis];
        let v = (max[axis] - a[axis]) / d[axis];
        t0 = nav_math::math::max(t0, nav_math::math::min(u, v));
        t1 = nav_math::math::min(t1, nav_math::math::max(u, v));
        if t0 > t1 {
            return false;
        }
    }
    true
}

/// `NavChunkRouteSearchJob.Search`.
fn chunk_route_search(graphs: &RouteGraphs, ask: &ChunkAsk) -> ChunkOutcome {
    let agent = &*ask.settings;
    let start = ask.key.start_graph;
    let nav = &graphs.graphs[start as usize].nav;
    let mut filter = walk_filter(agent, nav, &[]);
    filter.agent_speed = ask.speed;
    filter.agent_radius = agent.radius;
    let mut out = ChunkOutcome::default();
    if ask.to_edge {
        let (status, at_edge) = routing::find_route_to_edge(graphs, &filter, start, ask.start_poly, ask.start_pos, ask.goal_pos, &mut out.legs);
        out.status = status;
        out.at_edge = at_edge;
    } else if ask.key.goal_graph != start {
        out.status = routing::find_route(graphs, &filter, start, ask.start_poly, ask.start_pos, ask.key.goal_graph, ask.goal_poly, ask.goal_pos, &mut out.legs);
    } else {
        // On its own navmesh, past the overlay: a route only if going through the overlay is clearly shorter than the
        // best way that stays on its own navmesh.
        let (status, through) = routing::find_route_on(graphs, &filter, start, ask.start_poly, ask.start_pos, start, ask.goal_poly, ask.goal_pos, &mut out.legs, -1);
        out.status = status;
        if out.legs.len() > 1 {
            let mut stay = Vec::new();
            let (alone, own) = routing::find_route_on(graphs, &filter, start, ask.start_poly, ask.start_pos, start, ask.goal_poly, ask.goal_pos, &mut stay, start);
            if alone == NavPathStatus::Success && own <= through * OVERLAY_SHORTCUT + agent.radius {
                out.legs.clear();
            }
        }
    }
    out
}

/// `NavChunkRouteApplyJob.Execute` for one ask.
fn apply_chunk_route(graphs: &RouteGraphs, agents: &mut AgentStore, ask: &ChunkAsk, outcome: &ChunkOutcome, stats: &mut RouteStats) {
    stats.record(outcome.status, outcome.at_edge, 0, usize::MAX, false);
    let d = &mut agents.data[ask.row];
    let Some(cd) = d.chunk_route.as_deref_mut() else { return };
    let count = outcome.legs.len();
    if outcome.status != NavPathStatus::InvalidInput && (if outcome.at_edge { count > 0 } else { count > 1 }) {
        cd.legs.clear();
        for leg in &outcome.legs {
            let g = &graphs.graphs[leg.graph as usize];
            let mut add = NavChunkLeg { chunk: g.chunk, overlay: g.overlay, end: leg.end, ..NavChunkLeg::default() };
            if leg.exit_link >= 0 {
                add.exit_a = graphs.links[leg.exit_link as usize].a0;
                add.exit_b = graphs.links[leg.exit_link as usize].a1;
            }
            cd.legs.push(add);
        }
        // Each walker crosses the seam where its own way on is straightest, not all at one portal.
        let mut first = cd.legs[0];
        let radius = ask.settings.radius;
        let ends: Vec<Float3> = cd.legs.iter().map(|l| l.end).collect();
        let (mut ea, mut eb, mut ee) = (first.exit_a, first.exit_b, first.end);
        let ok = count >= 2 && {
            let aim = crossing::aim(&ends, 1, outcome.at_edge, ask.goal_pos);
            crossing::best_portal(&graphs.links, outcome.legs[0].graph, outcome.legs[1].graph, ask.start_pos, aim, radius, &mut ea, &mut eb, &mut ee)
        };
        if ok {
            first.exit_a = ea;
            first.exit_b = eb;
            first.end = ee;
        } else {
            first.end = seam_point(first.exit_a, first.exit_b, ask.start_pos, radius, first.end);
        }
        cd.legs[0] = first;
        cd.route.active = true;
        cd.route.to_edge = outcome.at_edge;
        cd.route.leg = 0;
        cd.route.status = outcome.status;
        d.path_request.goal = chunk_target(&cd.route, &cd.legs); // the first leg; the walker is on its navmesh already
    }
    if ask.waited {
        let cd = d.chunk_route.as_deref().expect("chunk route");
        stats.edge_replan(ask.old_edge, cd.route.active, cd.route.to_edge, if cd.route.active { cd.legs[cd.legs.len() - 1].end } else { Float3::default() }, through(&cd.legs, ask.old_edge, ask.reach), ask.reach);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// NavChunkFlightRouteSystem: fly-only agents
// ---------------------------------------------------------------------------------------------------------------------

/// `NavChunkFlightRouteJob.LegArrival`.
fn leg_arrival(route: &NavChunkRoute, legs: &[NavChunkLeg], flyer: &NavFlightAgent) -> f32 {
    if (route.leg as usize) + 1 < legs.len() || route.to_edge { flyer.crossing_reach() } else { 0.0 }
}

/// `NavFlightRouteWriter.Apply`: writes a fly-only route into a flyer. A route that doesn't lead anywhere leaves the
/// agent's ordinary flight as it is.
#[allow(clippy::too_many_arguments)]
fn write_flight_route(graphs: &RouteGraphs, agents: &mut AgentStore, row: usize, result: &[NavRouteLeg], status: NavPathStatus, at_edge: bool, waited: bool, old_edge: Float3, stats: &mut RouteStats) {
    let Some(flight) = agents.data[row].flight.clone() else { return };
    let flyer = flight.effective();
    let position = agents.position[row];
    let d = &mut agents.data[row];
    let (Some(cd), Some(f)) = (d.chunk_route.as_deref_mut(), d.flyer.as_deref_mut()) else { return };
    let short_of_goal = !at_edge && status == NavPathStatus::Partial;
    if status != NavPathStatus::InvalidInput && !result.is_empty() && (at_edge || short_of_goal || result.len() > 1) {
        cd.legs.clear();
        for l in result {
            cd.legs.push(NavChunkLeg { chunk: l.chunk, overlay: false, end: l.end, exit_a: l.exit_a, exit_b: l.exit_b });
        }
        // Each flyer crosses the face where its own way on is straightest, not all at one point.
        let vol_of = |chunk: Hash128| crossing::volume_of(graphs.volumes.iter().map(|v| v.chunk), chunk).map_or(-1, |v| v as i32);
        if cd.legs.len() > 1 {
            let mut first = cd.legs[0];
            let ends: Vec<Float3> = cd.legs.iter().map(|l| l.end).collect();
            let aim = crossing::aim(&ends, 1, at_edge || short_of_goal, cd.route.goal);
            let (from, to) = (vol_of(cd.legs[0].chunk), vol_of(cd.legs[1].chunk));
            let (mut lo, mut hi, mut point) = (first.exit_a, first.exit_b, first.end);
            if crossing::best_face(&graphs.air_links, from, to, position, aim, flyer.radius, &mut lo, &mut hi, &mut point) {
                first.exit_a = lo;
                first.exit_b = hi;
                first.end = point;
            } else {
                first.end = face_point(first.exit_a, first.exit_b, position, flyer.radius, first.end);
            }
            cd.legs[0] = first;
        }
        // To the edge of loaded space: each waits at the edge where it's nearest.
        if at_edge {
            let n = cd.legs.len() - 1;
            let last = cd.legs[n];
            cd.legs[n].end = crossing::edge_wait(&graphs.air_frontier, vol_of(last.chunk), last.end, position, flyer.radius);
        }
        cd.route.active = true;
        cd.route.to_edge = at_edge || short_of_goal;
        cd.route.leg = 0;
        cd.route.status = status;
        d.path_request.start_from_current_position = true;
        d.path_request.start = position;
        d.path_request.goal = chunk_target(&cd.route, &cd.legs);
        d.path_request_enabled = true;
        f.path.arrival_distance = leg_arrival(&cd.route, &cd.legs, &flyer);
    }
    if !waited {
        return;
    }
    let reach = flyer.crossing_reach().max(flyer.arrival_distance);
    stats.edge_replan(old_edge, cd.route.active, cd.route.to_edge, if cd.route.active { cd.legs[cd.legs.len() - 1].end } else { Float3::default() }, through(&cd.legs, old_edge, reach), reach);
}

/// `NavChunkFlightRouteSystem`: fly-only agents' routes across chunks.
pub fn chunk_flight_routes(sys: &mut RouteSystems, agents: &mut AgentStore, _targets: &Targets, frame: &Frame, _warnings: &mut Warnings) {
    for pool in sys.flight_route_searches.values_mut() {
        pool.release_dead(|id| agents.is_live(id));
    }
    let types: Vec<Hash128> = frame.world.snapshot().agent_types.clone();
    for ty in types {
        let Some(graphs) = frame.world.route_graphs(ty) else { continue }; // one volume: ordinary flights do
        if graphs.volumes.is_empty() {
            continue;
        }
        let rows: Vec<usize> = agents
            .active_rows()
            .filter(|&r| {
                let d = &agents.data[r];
                d.agent_type == ty && d.kind == AgentKind::Flyer && d.flyer.is_some() && d.chunk_route.is_some()
            })
            .collect();
        if !rows.is_empty() {
            sys.flight_route_searches.entry(ty).or_default().ensure(FLIGHT_ROUTE_POOL_SIZE);
        }
        for &r in &rows {
            flight_route_job(frame, graphs, ty, agents, r, &mut sys.flight_stats);
        }
        let Some(pool) = sys.flight_route_searches.get_mut(&ty) else { continue };

        // NavFlightRouteSearchAssignJob.
        let version = frame.world.graphs.version;
        let n = pool.len();
        let mut free: Vec<usize> = Vec::new();
        let mut finished: Vec<(f64, usize)> = Vec::new();
        let mut running: HashMap<NavFlightRouteKey, usize> = HashMap::new();
        let mut done: HashMap<NavFlightRouteKey, usize> = HashMap::new();
        for i in (0..n).rev() {
            let e = &pool.entries[i];
            if e.active {
                running.entry(e.search.key).or_insert(i);
            } else if e.search.done && e.search.version == version && !done.contains_key(&e.search.key) {
                done.insert(e.search.key, i);
                finished.push((e.search.done_time, i));
            } else {
                free.push(i);
            }
        }
        finished.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut evict = 0;
        let mut shares: Vec<FlightShare> = Vec::new();
        let mut waiting = 0;
        let requesters: Vec<usize> = rows.iter().copied().filter(|&r| agents.data[r].chunk_route.as_deref().is_some_and(|c| c.flight_search_requested)).collect();
        for r in requesters {
            let Some(id) = agents.id_of(r) else { continue };
            let request = agents.data[r].chunk_route.as_deref().expect("chunk route").flight_request;
            if let Some(&found) = done.get(&request.key) {
                let s = &pool.entries[found].search;
                shares.push(FlightShare { row: r, search: found, old_edge: request.old_edge, status: s.status, at_edge: s.at_edge, waited: request.waited });
                agents.data[r].chunk_route.as_deref_mut().expect("chunk route").flight_search_requested = false;
                continue;
            }
            if running.contains_key(&request.key) {
                continue; // its route is being searched: next tick
            }
            let slot = if let Some(f) = free.pop() {
                f
            } else if evict < finished.len() {
                let s = finished[evict].1;
                evict += 1;
                done.remove(&pool.entries[s].search.key);
                s
            } else {
                waiting += 1;
                continue;
            };
            let e = &mut pool.entries[slot];
            e.search.assign(id);
            e.search.ticket = request.ticket;
            e.search.key = request.key;
            e.search.goal = request.goal;
            e.search.old_edge = request.old_edge;
            e.search.waited = request.waited;
            e.active = true;
            agents.data[r].chunk_route.as_deref_mut().expect("chunk route").flight_search_requested = false;
            running.entry(request.key).or_insert(slot);
        }
        sys.deferrals += waiting;
        sys.shared += shares.len();

        // NavFlightRouteShareJob.
        for s in &shares {
            let result = pool.entries[s.search].search.legs.clone();
            write_flight_route(graphs, agents, s.row, &result, s.status, s.at_edge, s.waited, s.old_edge, &mut sys.flight_stats);
        }

        // NavFlightRouteSearchStepJob.
        for i in 0..n {
            if pool.entries[i].active {
                step_flight_route_search(graphs, &mut pool.entries[i], agents, frame, ty, &mut sys.flight_stats);
            }
        }
    }
}

/// `NavFlightRouteSearchStepJob.Execute` for one search.
fn step_flight_route_search(graphs: &RouteGraphs, e: &mut PooledSearch<NavFlightRouteSearch>, agents: &mut AgentStore, frame: &Frame, _ty: Hash128, stats: &mut RouteStats) {
    let version = frame.world.graphs.version;
    let PooledSearch { search, store, active } = e;
    let row = agents.row(search.agent);
    // Its agent's still waiting for this search (it didn't plan again since): it gets the route too.
    let for_agent = row.is_some_and(|r| {
        agents.data[r].chunk_route.as_deref().is_some_and(|c| c.flight_request.ticket == search.ticket && !c.flight_search_requested)
    });
    if !search.located && row.is_none() {
        search.done = false;
        *active = false; // nothing to locate from: the flyers sharing its key start another
        return;
    }
    if !search.located {
        let r = row.expect("checked");
        let ok = locate_flight_search(graphs, search, store, agents, r, frame);
        if !ok {
            // Nothing to search from where it is: its route is "no route", the ordinary flight the route job asked for.
            if for_agent {
                write_flight_route(graphs, agents, r, &[], NavPathStatus::InvalidInput, false, search.waited, search.old_edge, stats);
            }
            search.done = false;
            *active = false;
            return;
        }
    } else if search.version != version {
        // The graphs it was searching changed: its agent asks again, on the new ones.
        if for_agent {
            if let Some(c) = row.and_then(|r| agents.data[r].chunk_route.as_deref_mut()) {
                c.flight_search_requested = true;
            }
        }
        search.done = false;
        *active = false;
        return;
    }
    search.frames += 1;
    let ground = NavMeshQueryFilter::zeroed();
    let filters = air_filters(graphs, agents, row, frame);
    let finished = route_search::step(&mut search.state, store, graphs, &ground, &filters, FLIGHT_ROUTE_SLICE);
    if !finished {
        return; // more next tick
    }
    let mut legs = Vec::new();
    let (status, at_edge) = route_search::finish(&search.state, store, graphs, &mut legs);
    stats.record(status, at_edge, store.nodes.len(), search.state.max_nodes.max(0) as usize, false);
    search.legs.clear();
    search.legs.extend_from_slice(&legs);
    // Shared only if it reaches the goal (or the edge of loaded space toward it).
    search.done = status == NavPathStatus::Success || at_edge;
    search.status = status;
    search.at_edge = at_edge;
    search.done_time = frame.time;
    if for_agent {
        if let Some(r) = row {
            write_flight_route(graphs, agents, r, &legs, status, at_edge, search.waited, search.old_edge, stats);
        }
    }
    *active = false;
}

/// The flight filters of every volume of the graphs, with the agent's own area costs (`NavSearchAirFilter`).
fn air_filters(graphs: &RouteGraphs, agents: &AgentStore, row: Option<usize>, frame: &Frame) -> Vec<NavVolumeQueryFilter> {
    let own: &[NavMeshAgentAreaCost] = row.map_or(&[], |r| &agents.data[r].area_costs);
    let costs = effective_area_costs(frame.world_area_costs, own);
    graphs.volumes.iter().map(|v| flight_filter(&v.volume, &costs)).collect()
}

/// `NavFlightRouteSearchStepJob.Locate`: finds the route's ends from where the agent is now, makes the flight filters
/// and starts the A*. False if there's nothing to search.
fn locate_flight_search(graphs: &RouteGraphs, search: &mut NavFlightRouteSearch, store: &mut nav_query::search::SearchBufferStore, agents: &AgentStore, r: usize, frame: &Frame) -> bool {
    let d = &agents.data[r];
    let Some(flight) = d.flight.as_ref() else { return false };
    let flyer = flight.effective();
    let own_chunk = agents.chunk[r].chunk;
    let from = agents.position[r];
    let FlightRouteEnds::Route { start, goal, to_edge, .. } = routing::locate_flight_route(graphs, frame.world.snapshot(), own_chunk, from, search.goal, flyer.max_snap_distance) else {
        return false;
    };
    let filters = air_filters(graphs, agents, Some(r), frame);
    let settings = routing::flight_route_params(flyer.max_search_nodes, graphs);
    search.located = true;
    search.version = frame.world.graphs.version;
    search.start = start;
    store.begin();
    search.stamp = store.stamp;
    let ground = NavMeshQueryFilter::zeroed();
    route_search::begin(&mut search.state, store, &ground, &filters, &settings, &start, &goal, to_edge, search.goal)
}

/// `NavChunkFlightRouteJob.Execute` for one fly-only agent.
fn flight_route_job(frame: &Frame, graphs: &RouteGraphs, ty: Hash128, agents: &mut AgentStore, r: usize, stats: &mut RouteStats) {
    if is_member(&agents.data[r]) {
        return;
    }
    let Some(flight) = agents.data[r].flight.clone() else { return };
    let flyer = flight.effective();
    let snap = frame.world.snapshot();
    let version = frame.world.graphs.version;
    let Some(entry) = usize::try_from(agents.chunk[r].entry).ok().and_then(|e| snap.entries.get(e)) else { return };
    if entry.volume.is_none() {
        return;
    }
    let Some(mut cd) = agents.data[r].chunk_route.take() else { return };
    let position = agents.position[r];
    let mut request = agents.data[r].path_request;
    let mut requested = agents.data[r].path_request_enabled;
    let mut ac = agents.chunk[r];
    let mut path = agents.data[r].flyer.as_deref().map(|f| f.path).unwrap_or_default();
    let mut entry = FlightEntry::of(entry);

    // (Reborrow-free helper closures can't hold `agents`; the steps below work on copies and write back at the end.)
    let finish = |agents: &mut AgentStore, cd: Box<ChunkRouteData>, request: PathRequest, requested: bool, ac: NavAgentChunk, path: FlyPath| {
        let d = &mut agents.data[r];
        d.chunk_route = Some(cd);
        d.path_request = request;
        d.path_request_enabled = requested;
        if let Some(f) = d.flyer.as_deref_mut() {
            f.path = path;
        }
        agents.chunk[r] = ac;
    };

    macro_rules! plan {
        ($waited:expr, $old_edge:expr) => {
            plan_flight_route(frame, graphs, ty, &mut cd, &request, &mut path, &mut ac, &entry, &flyer, position, $waited, $old_edge)
        };
    }

    // A runtime cost volume changed costs on a chunk the route still crosses (ADR 0070): plan again.
    let from = (cd.route.leg.max(0) as usize).min(cd.legs.len());
    let cost_stale = cd.route.active && costs_changed_on(frame, ty, cd.legs[from..].iter().map(|l| l.chunk));
    // Planned on graphs that have since changed: plan again if it changed on its way, else keep it.
    if cd.route.active && cd.route.version != version {
        let chunks: Vec<Hash128> = cd.legs.iter().map(|l| l.chunk).collect();
        if !route_affected(frame, cd.route.version, cd.route.status == NavPathStatus::Partial && !cd.route.to_edge, cd.route.to_edge, ac.chunk, cd.route.leg, &chunks) {
            cd.route.version = version;
        }
    }
    if cd.route.active && (cd.route.version != version || cost_stale) {
        let reach = flyer.crossing_reach().max(flyer.arrival_distance);
        let old_edge = cd.legs.last().map_or(Float3::default(), |l| l.end);
        let waited = cd.route.to_edge && RouteStats::waiting_at(position, old_edge, reach);
        cd.route.active = false;
        if !requested {
            request.start_from_current_position = true;
            request.start = position;
            request.goal = cd.route.goal;
            requested = true;
        } else if request.goal.distance_sq(chunk_target(&cd.route, &cd.legs)) < 1e-4 {
            request.goal = cd.route.goal;
        }
        let searching = plan!(waited, old_edge);
        if waited && !searching {
            stats.edge_replan(old_edge, cd.route.active, cd.route.to_edge, if cd.route.active { cd.legs[cd.legs.len() - 1].end } else { Float3::default() }, through(&cd.legs, old_edge, reach), reach);
        }
        finish(agents, cd, request, requested, ac, path);
        return;
    }

    // Drifted out of its chunk: it takes the loaded chunk it's in and plans again from there.
    let outside = if entry.bounded {
        nav_math::math::max(
            nav_math::math::max(entry.bounds_min.x - position.x, position.x - entry.bounds_max.x),
            nav_math::math::max(entry.bounds_min.z - position.z, position.z - entry.bounds_max.z),
        )
    } else {
        f32::MIN
    };
    let home = if entry.bounded && outside > (2.0 * flyer.crossing_reach()).max(0.5 * flyer.max_snap_distance) {
        snap.entries.iter().position(|e| {
            e.agent_type == ty && !e.overlay && e.bounded && e.volume.is_some() && position.x >= e.bounds_min.x && position.z >= e.bounds_min.z && position.x <= e.bounds_max.x && position.z <= e.bounds_max.z
        })
    } else {
        None
    };
    if let Some(home) = home {
        let goal = if cd.route.active { cd.route.goal } else if requested { request.goal } else { path.goal };
        let going = cd.route.active || requested || path.state != NavPathState::None;
        ac.chunk = snap.entries[home].chunk;
        ac.entry = home as i32;
        entry = FlightEntry::of(&snap.entries[home]);
        cd.route.active = false;
        if !going {
            finish(agents, cd, request, requested, ac, path);
            return;
        }
        request.start_from_current_position = true;
        request.start = position;
        request.goal = goal;
        requested = true;
        plan!(false, Float3::default());
        finish(agents, cd, request, requested, ac, path);
        return;
    }

    // At the face its leg leaves by: on to the next chunk's volume.
    if cd.route.active && (cd.route.leg as usize) + 1 < cd.legs.len() && flight_at_exit(&cd.route, &cd.legs, &path, &flyer, position, requested) {
        cd.route.leg += 1;
        let k = cd.route.leg as usize;
        let mut leg = cd.legs[k];
        let Some(next) = snap.find(leg.chunk, ty, false) else {
            cd.route.active = false; // that chunk is gone: plan again from here
            request.start_from_current_position = true;
            request.start = position;
            request.goal = cd.route.goal;
            requested = true;
            plan!(false, Float3::default());
            finish(agents, cd, request, requested, ac, path);
            return;
        };
        let vol_of = |chunk: Hash128| crossing::volume_of(graphs.volumes.iter().map(|v| v.chunk), chunk).map_or(-1, |v| v as i32);
        if k + 1 < cd.legs.len() {
            let ends: Vec<Float3> = cd.legs.iter().map(|l| l.end).collect();
            let aim = crossing::aim(&ends, k + 1, cd.route.to_edge, cd.route.goal);
            let (from, to) = (vol_of(leg.chunk), vol_of(cd.legs[k + 1].chunk));
            let (mut lo, mut hi, mut point) = (leg.exit_a, leg.exit_b, leg.end);
            if crossing::best_face(&graphs.air_links, from, to, position, aim, flyer.radius, &mut lo, &mut hi, &mut point) {
                leg.exit_a = lo;
                leg.exit_b = hi;
                leg.end = point;
            } else {
                leg.end = face_point(leg.exit_a, leg.exit_b, position, flyer.radius, leg.end);
            }
            cd.legs[k] = leg;
        } else if cd.route.to_edge {
            // Into the last leg, to the edge of loaded space: wait where the edge is nearest it, from here.
            leg.end = crossing::edge_wait(&graphs.air_frontier, vol_of(leg.chunk), leg.end, position, flyer.radius);
            cd.legs[k] = leg;
        }
        ac.chunk = leg.chunk;
        ac.entry = next as i32;
        let target = chunk_target(&cd.route, &cd.legs);
        request.start_from_current_position = true;
        request.start = position;
        request.goal = target;
        requested = true;
        path.arrival_distance = leg_arrival(&cd.route, &cd.legs, &flyer);
        if !flyer.hover_at_chunk_faces && path.count > 0 && path.state != NavPathState::Failed {
            if let Some(next_point) = crossing::carry_on_next(position, target, path.arrival_distance, flyer.arrival_distance, flyer.speed) {
                path.next_index = path.count - 1;
                path.prev = position;
                path.next = next_point;
                path.state = NavPathState::Following;
            }
        }
        finish(agents, cd, request, requested, ac, path);
        return;
    }

    // The leg's flight path failed: counted once, for the report.
    if cd.route.active && !requested && path.state == NavPathState::Failed && cd.route.status != NavPathStatus::InvalidInput {
        cd.route.status = NavPathStatus::InvalidInput;
        stats.add(RouteStats::LEG_FAILED);
    }
    if !requested {
        finish(agents, cd, request, requested, ac, path);
        return;
    }
    // A repath of an ordinary flight already checked against these graphs: still not a route.
    if !cd.route.active && cd.route.version == version && request.goal.distance_sq(cd.route.goal) < 1e-4 {
        finish(agents, cd, request, requested, ac, path);
        return;
    }
    // The current leg's own repath: leave it to the flight path request.
    if cd.route.active && (cd.route.leg as usize) < cd.legs.len() && request.goal.distance_sq(chunk_target(&cd.route, &cd.legs)) < 1e-4 {
        finish(agents, cd, request, requested, ac, path);
        return;
    }
    plan!(false, Float3::default());
    finish(agents, cd, request, requested, ac, path);
}

/// True once the flyer is within CrossingReach of the face rectangle its leg leaves by, or its flight to the leg's end
/// has arrived (it can't get closer).
fn flight_at_exit(route: &NavChunkRoute, legs: &[NavChunkLeg], path: &FlyPath, flyer: &NavFlightAgent, position: Float3, requested: bool) -> bool {
    let leg = legs[route.leg as usize];
    let nearest = position.clamp(leg.exit_a.min_v(leg.exit_b), leg.exit_a.max_v(leg.exit_b));
    if position.distance(nearest) <= flyer.crossing_reach() {
        return true;
    }
    !requested && path.state == NavPathState::Arrived && path.goal.distance_sq(leg.end) < 1e-4
}

/// `NavChunkFlightRouteJob.Plan`: a route if the goal is in another chunk's volume (or unloaded space), else an
/// ordinary flight. Asks for the search and returns true.
#[allow(clippy::too_many_arguments)]
fn plan_flight_route(
    frame: &Frame,
    graphs: &RouteGraphs,
    ty: Hash128,
    cd: &mut ChunkRouteData,
    request: &PathRequest,
    path: &mut FlyPath,
    ac: &mut NavAgentChunk,
    entry: &FlightEntry,
    flyer: &NavFlightAgent,
    position: Float3,
    waited: bool,
    old_edge: Float3,
) -> bool {
    let _ = ty;
    let version = frame.world.graphs.version;
    cd.flight_request.ticket = cd.flight_request.ticket.wrapping_add(1);
    cd.flight_search_requested = false;
    cd.route.active = false;
    cd.route.to_edge = false;
    cd.legs.clear();
    path.arrival_distance = 0.0; // an ordinary flight arrives at the flyer's own ArrivalDistance
    let from = if request.start_from_current_position { position } else { request.start };
    let snap = frame.world.snapshot();
    match routing::locate_flight_route(graphs, snap, entry.chunk, from, request.goal, flyer.max_snap_distance) {
        FlightRouteEnds::Nowhere => false,
        FlightRouteEnds::Ordinary { start_chunk, goal_placed } => {
            if start_chunk != entry.chunk {
                if let Some(home) = snap.find(start_chunk, entry.agent_type, false) {
                    ac.chunk = start_chunk;
                    ac.entry = home as i32;
                }
            }
            if goal_placed {
                cd.route.goal = request.goal; // in its own volume: an ordinary flight
                cd.route.version = version;
            }
            false
        }
        FlightRouteEnds::Route { start, goal, to_edge, start_chunk } => {
            if start_chunk != entry.chunk {
                if let Some(home) = snap.find(start_chunk, entry.agent_type, false) {
                    ac.chunk = start_chunk;
                    ac.entry = home as i32;
                }
            }
            cd.route.goal = request.goal;
            cd.route.version = version;
            cd.flight_request.key = NavFlightRouteKey::of(start.volume, if to_edge { -1 } else { goal.volume }, request.goal);
            cd.flight_request.goal = request.goal;
            cd.flight_request.waited = waited;
            cd.flight_request.old_edge = old_edge;
            cd.flight_search_requested = true;
            true
        }
    }
}

/// What the flight route job needs of the agent's chunk entry (a copy, since it can change mid-job).
#[derive(Clone, Copy, Debug)]
struct FlightEntry {
    chunk: Hash128,
    agent_type: Hash128,
    bounded: bool,
    bounds_min: Float3,
    bounds_max: Float3,
}

impl FlightEntry {
    fn of(e: &nav_query::chunks::ChunkEntry) -> Self {
        Self { chunk: e.chunk, agent_type: e.agent_type, bounded: e.bounded, bounds_min: e.bounds_min, bounds_max: e.bounds_max }
    }
}
