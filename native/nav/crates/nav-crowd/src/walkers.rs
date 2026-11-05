//! Walkers: setup, repath, path requests (sliced searches from a pool, congestion), following and the move. Ported
//! from Foxfire's `Runtime/Systems/NavMeshAgentSystems.cs` and `Systems/Jobs/` (`NavMeshRepathJob`,
//! `NavPathSearchJobs`, `NavSearchJobs`, `NavCongestionJobs` + `Lib/NavCongestion`, `NavMeshPathFollowJob`,
//! `NavMeshMoveJob`), plus `NavMeshAvoidance.MoveAlongSurface` / `LocatePoly`
//! ([`move_along_surface`], [`locate_poly`]) for the steps that keep agents on the mesh.
//!
//! * **[`setup`]: `NavMeshAgentSetupSystem`.** The structural part is done when the agent is added; the
//!   `InitAgentSurfaceJob` puts its contact `pivot_offset` below its transform. Myco addition: agents with
//!   `update_position` off take their contact from their transform every tick (the host moves them).
//! * **[`repath`]: `NavMeshRepathSystem` + `NavMeshRepathJob`** (walkers only: walk-fly agents' routes decide theirs).
//!   Full checks every [`CHECK_FRAMES`] ticks staggered by row, urgent ones every tick; chase targets (and surround
//!   slots, `surround_slots::chase_goal`), off-path, the timer, a navmesh change, a gate change; flow followers as in
//!   Foxfire (`flow_agents::following` / `stale`: no gate or timer repaths, no chase repath while their field is
//!   stale). `NavFlowFollowing` and `NavFlowPathJob` themselves are `flow_agents.rs`'s (step 7b).
//! * **[`path_requests`]: `NavPathRequestSystem`.** The congestion table ([`CongestionTable`]: `ReserveCorridorsJob`
//!   every [`RESERVE_FRAMES`] and on a new layout, `CongestionRepathJob` every tick), `GatherPathRequestsJob`,
//!   `NavFlowPathJob` (flow followers served from their field, `flow_agents::serve`; hand-offs become searches),
//!   `NavSearchAssign` (urgent, then oldest path, then row), `NavPathSearchStepJob` ([`SEARCH_SLICE`] polygons a search a
//!   tick), writing the path, waypoints and corridor and swapping reservations.
//! * **[`follow`]: `NavMeshPathFollowSystem`** (`NavMeshPathFollowJob` / `NavMeshPathFollowSteeringJob`): waypoints,
//!   arrival, stuck skipping, the easing (`motion::walker_motion`), and for agents with avoidance the desired velocity
//!   and `NavSteering`.
//! * **[`move_agents`]: `NavAgentMoveSystem`** (`NavMeshSteeredMoveJob`, `NavMeshMoveJob`): steered agents by
//!   `agents.steered`, the rest along their segment (jump arcs, fold hinges), body `pivot_offset` above the contact
//!   along the surface up, turning towards travel at `turn_speed`, `agents.velocity`.
//!
//! # Deviations
//!
//! * No `SlowPathStep` warning (no portable clock in WASM).
//! * Walkers without avoidance get `agents.desired` too (the velocity they'd walk at), for hosts that move them
//!   (`update_position` off); Foxfire's plain follow job leaves it.
//! * Group members (`NavGroupMember` on) aren't moved here: `NavGroupMemberMoveJob` is `groups.rs`'s.
//!
//! # Contract
//!
//! Every function: `(&mut WalkerSystems, &mut AgentStore, .., &Frame, ..)`. Rows ascending; skip `kind` without
//! `walks()`, paused agents (`chunk.entry < 0`) where Foxfire does, and walk-fly agents while `RouteData::flying`.
use crate::agents::{AgentData, AgentKind, AgentStore};
use crate::components::{NavCorridor, NavMeshAgentConfig, NavMeshAgentSurface, NavPath, NavPathProgress, NavPathSearch, NavPathState, PathElement, PathRequest};
use crate::filters::{effective_area_costs, quat_rotate, walk_filter};
use crate::flow_agents;
use crate::ids::AgentId;
use crate::motion;
use crate::pool::SearchPool;
use crate::settings::{NavEase, NavMeshAgent};
use crate::surround_slots;
use crate::tick::Frame;
use crate::warnings::{NavWarning, NavWarningKind, Warnings};
use crate::world::Targets;
use nav_format::consts::NavGates;
use nav_format::{NavLinkKind, NavMeshData, OrientationBin};
use nav_math::{Float2, Float3, Float4, Int4};
use nav_query::chunks::{ChunkEntry, NavChunks};
use nav_query::filter::{CongestionView, NavMeshQueryFilter};
use nav_query::flow::FlowFields;
use nav_query::pathfinding::{self, NavMeshPathNode, NavPathStatus};
use nav_query::straight_path::{self, NavMeshWaypoint, NavMeshWaypointFlags};
use nav_query::surface;
use std::sync::Arc;

/// `NavMeshRepathJob.CheckFrames`: ticks between an agent's full repath checks.
pub const CHECK_FRAMES: u32 = 4;
/// `NavPathRequestSystem.SearchSlice`: polygons each path search expands a tick.
pub const SEARCH_SLICE: i32 = 256;
/// `NavPathRequestSystem.ReserveFrames`: ticks between rebuilds of the reservation table.
pub const RESERVE_FRAMES: i32 = 4;
/// `NavPathRequestSystem.MaxCongestionSlots`.
pub const MAX_CONGESTION_SLOTS: i32 = 32;
/// `ReserveCorridorsJob.LookAhead`: corridor polygons searched past the cursor.
const LOOK_AHEAD: usize = 8;
/// `NavMeshPathFollowJob.MinProgress`: how much closer counts as progress.
const MIN_PROGRESS: f32 = 0.5;
/// `NavMeshPathFollowJob.LandingReach`: reach for fold exits and jump landings.
const LANDING_REACH: f32 = 0.05;

// ---------------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------------

/// The congestion reservation table (`NavCongestion`): per polygon of every loaded navmesh (by entry, back to back
/// from `offsets[entry]`), per time slot, the agents expected there.
#[derive(Clone, Debug, Default)]
pub struct CongestionTable {
    pub loads: Vec<i32>,
    pub offsets: Vec<usize>,
    /// Time slots per polygon (0: congestion off).
    pub slots: usize,
    /// The tick it was last rebuilt from scratch.
    pub built_tick: u64,
    /// Seconds per slot.
    pub bucket_seconds: f32,
    /// What it was built for (slots, the snapshot, its size).
    pub layout: u64,
    /// Ticks since the last rebuild.
    pub age: i32,
}

impl CongestionTable {
    /// `IsCreated`.
    pub fn is_created(&self) -> bool {
        !self.loads.is_empty() && self.slots > 0
    }

    /// An entry's slice as a search reads it (None: congestion off).
    pub fn view(&self, entry: usize) -> Option<CongestionView<'_>> {
        self.is_created().then(|| CongestionView { loads: &self.loads, offset: self.offsets[entry], buckets: self.slots as i32, bucket_seconds: self.bucket_seconds })
    }

    /// `BucketOf`: the time slot for a time from now, or -1 beyond the window.
    pub fn bucket_of(&self, seconds: f32) -> i32 {
        let b = (seconds.max(0.0) / self.bucket_seconds).floor() as i32;
        if b < self.slots as i32 {
            b
        } else {
            -1
        }
    }

    /// `Load`.
    pub fn load(&self, entry: usize, poly: i32, bucket: i32) -> i32 {
        self.loads[self.offsets[entry] + poly as usize * self.slots + bucket as usize]
    }

    fn add(&mut self, entry: usize, poly: i32, bucket: i32, amount: i32) {
        let i = self.offsets[entry] + poly as usize * self.slots + bucket as usize;
        self.loads[i] += amount;
    }

    /// `NavCongestion.Reserve`: adds (`sign` 1) or removes (-1) an agent's reservations, every slot its corridor passes
    /// through from the cursor on at its speed; an agent that will stop at its path's end (or has) holds the last
    /// polygon for the rest of the window.
    pub fn reserve(&mut self, entry: usize, corridor: &[NavCorridor], cursor: i32, state: NavPathState, speed: f32, sign: i32) {
        let count = corridor.len();
        if count == 0 || state == NavPathState::None || state == NavPathState::Failed {
            return;
        }
        let buckets = self.slots as i32;
        if state == NavPathState::Arrived {
            let last = corridor[count - 1].poly;
            for b in 0..buckets {
                self.add(entry, last, b, sign);
            }
            return;
        }
        let cursor = cursor.clamp(0, count as i32 - 1) as usize;
        let inv_speed = 1.0 / speed.max(1e-3);
        let origin = corridor[cursor].distance;
        for j in cursor..count {
            let b0 = self.bucket_of((corridor[j].distance - origin) * inv_speed);
            if b0 < 0 {
                break; // the rest is beyond the window
            }
            let mut b1 = buckets - 1; // the final polygon: held once the agent stops there
            if j + 1 < count {
                let exit = self.bucket_of((corridor[j + 1].distance - origin) * inv_speed);
                b1 = if exit < 0 { buckets - 1 } else { exit };
            }
            for b in b0..=b1 {
                self.add(entry, corridor[j].poly, b, sign);
            }
        }
    }
}

/// `NavCongestion.Lanes`: agents that fit side by side through a portal (at least 1).
pub fn lanes(portal_width: f32, agent_radius: f32) -> f32 {
    CongestionView::lanes(portal_width, agent_radius)
}

/// Counters over the crowd's life (tests, the debug panel; Foxfire's `NavPerf` counters).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WalkerStats {
    pub repaths: u64,
    pub congestion_repaths: u64,
    pub path_requests: u64,
    pub path_failures: u64,
    /// Requests left waiting for a free search (`PathDeferrals`).
    pub deferrals: u64,
}

/// The walker steps' state between ticks.
#[derive(Clone, Debug, Default)]
pub struct WalkerSystems {
    /// `NavPathSearch` entities.
    pub path_searches: SearchPool<NavPathSearch>,
    pub congestion: CongestionTable,
    /// `NavMeshRepathSystem._frame`: whose turn for a full check.
    pub repath_frame: u32,
    pub stats: WalkerStats,
    corridor: Vec<NavMeshPathNode>,
    waypoints: Vec<NavMeshWaypoint>,
}

#[inline]
fn moving(state: NavPathState) -> bool {
    state == NavPathState::Following || state == NavPathState::Partial
}

#[inline]
fn flying(d: &AgentData) -> bool {
    d.route.as_deref().is_some_and(|r| r.flying)
}

#[inline]
fn member(d: &AgentData) -> bool {
    d.group_member.is_some_and(|m| m.enabled)
}

/// The agent's entry, if it has one with a navmesh.
fn entry_nav(chunks: &NavChunks, entry: i32) -> Option<(usize, &ChunkEntry, &Arc<NavMeshData>)> {
    let e = usize::try_from(entry).ok().filter(|&e| e < chunks.entries.len())?;
    let ce = &chunks.entries[e];
    ce.nav.as_ref().map(|n| (e, ce, n))
}

pub(crate) fn distance_to_segment(p: Float3, a: Float3, b: Float3) -> f32 {
    let ab = b - a;
    let t = ((p - a).dot(ab) / ab.length_sq().max(1e-6)).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

// ---------------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------------

/// `NavMeshAgentSetupSystem`: `InitAgentSurfaceJob` (an agent's first update puts its contact point `pivot_offset`
/// below its transform, along its rotation's up). Agents the host moves (`update_position` off) take their contact
/// from their transform every tick, along the surface's up.
pub fn setup(_sys: &mut WalkerSystems, agents: &mut AgentStore, _frame: &Frame) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        let Some(walk) = &agents.data[r].walk else { continue };
        let pivot = walk.settings.pivot_offset;
        if agents.surface[r].initialized {
            if !agents.data[r].update_position && !flying(&agents.data[r]) {
                let up = agents.surface[r].up;
                agents.surface[r].surface_position = agents.position[r] - up * pivot;
            }
            continue;
        }
        let up = quat_rotate(agents.rotation[r], Float3::new(0.0, 1.0, 0.0));
        let s = &mut agents.surface[r];
        s.surface_position = agents.position[r] - up * pivot;
        s.up = up;
        s.initialized = true;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Repath (NavMeshRepathJob + NavFlowFollowing)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavMeshRepathJob.Urgent`: checked every tick (no path yet, its last segment, its navmesh rebuilt, a gate changed).
pub(crate) fn urgent(path: &NavPath, entry: i32, frame: &Frame) -> bool {
    if path.state == NavPathState::None {
        return true;
    }
    let mv = moving(path.state);
    if mv && path.next_index >= path.count - 1 {
        return true;
    }
    let chunks = frame.world.snapshot();
    let Ok(e) = usize::try_from(entry) else { return false };
    let Some(ce) = chunks.entries.get(e) else { return false };
    path.nav != frame.world.nav_key(entry) || (mv && path.computed_time < ce.last_gate_change)
}

/// ADR 0070: this tick's cost volume change touched a polygon of the walker's corridor ahead of it.
pub(crate) fn corridor_costs_changed(w: &crate::agents::WalkerData, entry: i32, frame: &Frame) -> bool {
    if !frame.update.costs_changed || !moving(w.path.state) {
        return false;
    }
    let chunks = frame.world.snapshot();
    let Ok(e) = usize::try_from(entry) else { return false };
    let Some(ce) = chunks.entries.get(e) else { return false };
    if ce.cost_changed_count == 0 || w.path.computed_time >= ce.last_cost_change {
        return false;
    }
    let from = (w.cursor.index.max(0) as usize).min(w.corridor.len());
    w.corridor[from..].iter().any(|c| chunks.poly_cost_changed(e, c.poly))
}

/// Enables the agent's request from where it stands (`Repath`'s and `NavFlowFollowing.Request`'s tail).
fn request_path(d: &mut AgentData, surface: &NavMeshAgentSurface, goal: Float3) {
    d.path_request.start_from_current_position = true;
    d.path_request.start = surface.surface_position;
    d.path_request.goal = goal;
    d.path_request_enabled = true;
}

/// `NavMeshRepathSystem` + `NavMeshRepathJob` (see the module doc).
pub fn repath(sys: &mut WalkerSystems, agents: &mut AgentStore, targets: &Targets, flow: &FlowFields, frame: &Frame, _warnings: &mut Warnings) {
    sys.repath_frame = sys.repath_frame.wrapping_add(1);
    let chunks = frame.world.snapshot();
    let rows: Vec<usize> = agents.active_rows().collect();
    for &r in &rows {
        let d = &agents.data[r];
        if d.kind != AgentKind::Walker {
            continue; // agents that walk and fly: their route decides when they repath
        }
        let (Some(walk), Some(w)) = (&d.walk, d.walker.as_deref()) else { continue };
        let entry = agents.chunk[r].entry;
        let costs_hit = corridor_costs_changed(w, entry, frame);
        if !(r as u32).wrapping_add(sys.repath_frame).is_multiple_of(CHECK_FRAMES) && !urgent(&w.path, entry, frame) && !costs_hit {
            continue;
        }
        if member(d) {
            flow_agents::leave(&mut agents.data[r]); // a group member: its group plans for it
            continue;
        }
        let Some((_, ce, _)) = entry_nav(chunks, entry) else { continue };
        let walk = walk.clone();

        // Chasing a target: where to (the target, or its surround slot).
        let chased = d.goal_target.and_then(|t| agents.target_position(t.target, targets).map(|p| (t, p)));
        let chasing = chased.is_some();
        let (mut target_pos, mut repath_distance, mut field_stale) = (Float3::default(), 0.0, false);
        if let Some((chase, chased)) = chased {
            (target_pos, repath_distance) = surround_slots::chase_goal(d.surround_slot.as_ref(), &chase, chased, targets);
            field_stale = flow_agents::stale(agents, r, flow, targets);
        }
        let following = flow_agents::following(d);
        let surface = agents.surface[r];
        let nav_key = frame.world.nav_key(entry);
        let last_gate_change = ce.last_gate_change;
        if repath_one(&mut agents.data[r], &walk, &surface, nav_key, last_gate_change, costs_hit, frame.time, chasing, target_pos, repath_distance, following, field_stale) {
            sys.stats.repaths += 1;
        }
    }
}

/// `NavMeshRepathJob.Repath`: re-enables the request when a new path is due. True if it did.
#[allow(clippy::too_many_arguments)]
fn repath_one(
    d: &mut AgentData,
    config: &NavMeshAgentConfig,
    surface: &NavMeshAgentSurface,
    nav_key: u64,
    last_gate_change: f64,
    costs_hit: bool,
    time: f64,
    chasing: bool,
    target_pos: Float3,
    repath_distance: f32,
    following: bool,
    field_stale: bool,
) -> bool {
    let agent = &*config.settings;
    if d.path_request_enabled {
        return false; // a request is already pending
    }
    let Some(w) = d.walker.as_deref() else { return false };
    let path = w.path;
    let mut goal = path.goal;
    let mut repath = false;

    // Chasing a target: follow it, and start chasing even if no path was requested yet.
    if chasing {
        let chased = match d.chunk_route.as_deref() {
            Some(cr) if cr.route.active => cr.route.goal,
            _ => path.goal,
        };
        if path.state == NavPathState::None || (!field_stale && target_pos.distance(chased) > repath_distance) {
            goal = target_pos;
            repath = true;
        }
    }
    if path.state == NavPathState::None && !repath {
        return false; // nothing requested yet
    }

    // Navmesh rebuilt since this path was computed: repath now, even mid-fold.
    let nav_changed = path.nav != nav_key;
    let mv = moving(path.state);
    // Mid-fold or mid-jump the contact is off the navmesh: wait until it's done.
    let crossing_fold = mv && (path.is_fold_segment() || path.is_jump_segment());
    if crossing_fold && !nav_changed {
        return false;
    }
    if nav_changed {
        repath = true;
    }
    // A gate of its chunk opened or closed since this path was computed.
    if !following && path.state != NavPathState::Arrived && path.computed_time < last_gate_change {
        repath = true;
    }
    // A runtime cost volume changed the cost of a polygon ahead on its corridor (ADR 0070).
    if !following && costs_hit {
        repath = true;
    }
    // Pushed off the current segment.
    if mv && agent.off_path_distance > 0.0 && path.next_index < path.count && distance_to_segment(surface.surface_position, path.prev, path.next) > agent.off_path_distance
    {
        repath = true;
    }
    // Timer: picks up moved obstacles once the navmesh reflects them, and retries Partial/Failed paths.
    let held = following && mv;
    if agent.repath_interval > 0.0 && path.state != NavPathState::Arrived && !held && time - path.computed_time >= agent.repath_interval as f64 {
        repath = true;
    }
    if !repath {
        return false;
    }
    request_path(d, surface, goal);
    true
}

// ---------------------------------------------------------------------------------------------------------------------
// Path requests (NavPathRequestSystem)
// ---------------------------------------------------------------------------------------------------------------------

/// An agent asking for a search this tick (`NavSearchTask`).
#[derive(Clone, Copy, Debug)]
struct SearchTask {
    row: usize,
    agent: AgentId,
    computed_time: f64,
    urgent: bool,
}

/// `NavPathRequestSystem.OnUpdate`: congestion, then gather, assign and step the searches (see the module doc).
pub fn path_requests(
    sys: &mut WalkerSystems,
    agents: &mut AgentStore,
    flow: &FlowFields,
    flow_stats: &mut flow_agents::FlowAgentStats,
    frame: &Frame,
    warnings: &mut Warnings,
) {
    if agents.active_rows().any(|r| agents.data[r].kind.walks()) {
        sys.path_searches.ensure(frame.runtime.path_searches());
    }
    sys.path_searches.release_dead(|id| agents.is_live(id));
    let chunks = frame.world.snapshot();

    // The reservation table: polygons x time slots per entry's navmesh, back to back.
    let rt = frame.runtime;
    let buckets = if rt.congestion_window > 0.0 { ((rt.congestion_window / rt.congestion_slot).ceil() as i32).clamp(1, MAX_CONGESTION_SLOTS) } else { 0 };
    let t = &mut sys.congestion;
    t.offsets.clear();
    let mut size = 0usize;
    let mut layout = (buckets as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for (i, e) in chunks.entries.iter().enumerate() {
        t.offsets.push(size);
        layout = (layout ^ frame.world.nav_key(i as i32) ^ ((size as u64) << 32)).wrapping_mul(0x0000_0100_0000_01B3);
        if let Some(nav) = &e.nav {
            size += nav.polys.len() * buckets as usize;
        }
    }
    let mut rebuild = layout != t.layout || {
        t.age += 1;
        t.age >= RESERVE_FRAMES
    };
    if t.loads.len() != size {
        t.loads = vec![0; size];
        rebuild = true;
    } else if rebuild && buckets > 0 {
        t.loads.iter_mut().for_each(|l| *l = 0);
    }
    if rebuild {
        t.layout = layout;
        t.age = 0;
        t.built_tick = frame.tick;
    }
    t.slots = buckets as usize;
    t.bucket_seconds = rt.congestion_slot;
    if buckets > 0 {
        if rebuild {
            reserve_corridors(sys, agents, frame);
        }
        congestion_repath(sys, agents, frame);
    }

    // GatherPathRequestsJob.
    let mut tasks: Vec<SearchTask> = Vec::new();
    let mut flow_tasks: Vec<usize> = Vec::new();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if !d.kind.walks() || flying(d) || !d.path_request_enabled {
            continue;
        }
        if entry_nav(chunks, agents.chunk[r].entry).is_none() {
            continue; // paused, or its chunk has no navmesh for this type: its request waits
        }
        if d.flow_agent.is_some_and(|f| f.enabled && !f.searching) {
            flow_tasks.push(r); // served from its field (NavFlowPathJob, below)
            continue;
        }
        let Some(w) = d.walker.as_deref() else { continue };
        let Some(agent) = agents.id_of(r) else { continue };
        tasks.push(SearchTask { row: r, agent, computed_time: w.path.computed_time, urgent: d.path_request.urgent });
    }

    // NavFlowPathJob: agents on flow fields get their path from the field, no search; one the field can't serve is
    // handed to an ordinary search this tick.
    for r in flow_tasks {
        match flow_agents::serve(agents, r, flow, frame) {
            Ok(()) => flow_stats.paths += 1,
            Err(_) => {
                flow_stats.handoffs += 1;
                let d = &agents.data[r];
                let (Some(w), Some(agent)) = (d.walker.as_deref(), agents.id_of(r)) else { continue };
                tasks.push(SearchTask { row: r, agent, computed_time: w.path.computed_time, urgent: d.path_request.urgent });
            }
        }
    }

    // NavSearchAssign: urgent first, then the oldest paths (then row: deterministic).
    tasks.sort_by(|a, b| b.urgent.cmp(&a.urgent).then(a.computed_time.total_cmp(&b.computed_time)).then(a.row.cmp(&b.row)));
    let busy: Vec<AgentId> = sys.path_searches.entries.iter().filter(|e| e.active).map(|e| e.search.agent).collect();
    for t in &tasks {
        if busy.contains(&t.agent) {
            continue;
        }
        if sys.path_searches.assign(t.agent).is_none() {
            sys.stats.deferrals += 1;
        }
    }

    // NavPathSearchStepJob, in pool order.
    for i in 0..sys.path_searches.entries.len() {
        if sys.path_searches.entries[i].active {
            step_search(sys, i, agents, frame, warnings);
        }
    }
}

/// `ReserveCorridorsJob`: moves each agent's corridor cursor to the polygon it is in, then reserves the rest of its
/// corridor.
pub fn reserve_corridors(sys: &mut WalkerSystems, agents: &mut AgentStore, frame: &Frame) {
    let chunks = frame.world.snapshot();
    for r in agents.active_rows().collect::<Vec<_>>() {
        let steering = agents.steering[r];
        let d = &mut agents.data[r];
        if !d.kind.walks() || flying(d) || member(d) {
            continue;
        }
        let Some((e, _, nav)) = entry_nav(chunks, agents.chunk[r].entry) else { continue };
        let speed = d.walk.as_ref().map_or(1.0, |w| w.speed());
        let tracked = d.avoidance.is_some() && steering;
        let Some(w) = d.walker.as_deref_mut() else { continue };
        if w.path.nav != frame.world.nav_key(e as i32) || w.corridor.is_empty() {
            continue;
        }
        if moving(w.path.state) {
            let poly = if tracked { w.avoidance_state.poly } else { -1 };
            w.cursor.index = advance_cursor(nav, w.cursor.index, &w.corridor, agents.surface[r].surface_position, poly);
        }
        sys.congestion.reserve(e, &w.corridor, w.cursor.index, w.path.state, speed, 1);
    }
}

/// `ReserveCorridorsJob.Advance`: the furthest corridor polygon within `LookAhead` of the cursor that the agent is in.
fn advance_cursor(nav: &NavMeshData, index: i32, corridor: &[NavCorridor], pos: Float3, poly: i32) -> i32 {
    let index = index.clamp(0, corridor.len() as i32 - 1) as usize;
    let last = (corridor.len() - 1).min(index + LOOK_AHEAD);
    if poly >= 0 {
        return (index + 1..=last).rev().find(|&j| corridor[j].poly == poly).unwrap_or(index) as i32;
    }
    (index + 1..=last).rev().find(|&j| surface::point_in_poly(nav, corridor[j].poly, pos)).unwrap_or(index) as i32
}

/// `CongestionRepathJob`: requests a new path for agents whose upcoming corridor has a full polygon when they'd get
/// there; at most once per `congestion_repath_interval`, never mid-fold or mid-jump.
pub fn congestion_repath(sys: &mut WalkerSystems, agents: &mut AgentStore, frame: &Frame) {
    let chunks = frame.world.snapshot();
    let t = &sys.congestion;
    for r in agents.active_rows().collect::<Vec<_>>() {
        let surface = agents.surface[r];
        let d = &mut agents.data[r];
        if d.kind != AgentKind::Walker || member(d) || flow_agents::following(d) {
            continue;
        }
        let Some((e, _, _)) = entry_nav(chunks, agents.chunk[r].entry) else { continue };
        let Some(walk) = &d.walk else { continue };
        let Some(w) = d.walker.as_deref() else { continue };
        if d.path_request_enabled || walk.settings.congestion_cost <= 0.0 || w.path.nav != frame.world.nav_key(e as i32) {
            continue;
        }
        if !moving(w.path.state) || frame.time - w.path.computed_time < frame.runtime.congestion_repath_interval as f64 {
            continue;
        }
        if w.path.is_fold_segment() || w.path.is_jump_segment() {
            continue;
        }
        let count = w.corridor.len();
        if count == 0 {
            continue;
        }
        let start = (w.cursor.index.clamp(0, count as i32 - 1)) as usize;
        let inv_speed = 1.0 / walk.speed().max(1e-3);
        let origin = w.corridor[start].distance;
        let mut congested = false;
        let mut j = start + 1;
        while j + 1 < count && !congested {
            let bucket = t.bucket_of((w.corridor[j].distance - origin) * inv_speed);
            if bucket < 0 {
                break;
            }
            let others = t.load(e, w.corridor[j].poly, bucket) - 1; // minus this agent's own reservation
            congested = others as f32 >= w.corridor[j].lanes;
            j += 1;
        }
        if !congested {
            continue;
        }
        let goal = w.path.goal;
        request_path(d, &surface, goal);
        sys.stats.congestion_repaths += 1;
    }
}

/// The agent's query filter: its abilities and area costs, its chunk's gates and switched-off polygons, and the tick's
/// reservations (`NavPathSearchStepJob.BuildFilter`).
fn build_filter<'a>(d: &AgentData, config: &NavMeshAgentConfig, nav: &NavMeshData, chunks: &'a NavChunks, e: usize, frame: &Frame, congestion: Option<CongestionView<'a>>) -> NavMeshQueryFilter<'a> {
    let agent = &*config.settings;
    let costs = effective_area_costs(frame.world_area_costs, &d.area_costs);
    let mut f: NavMeshQueryFilter<'a> = walk_filter(agent, nav, &costs);
    f.closed_gates = Some(chunks.gates_of(e));
    f.switched_off = Some(chunks.switched_off_of(e));
    f.poly_costs = chunks.poly_costs_for(e);
    f.min_poly_cost = chunks.min_poly_cost;
    f.congestion = congestion;
    f.congestion_cost = agent.congestion_cost;
    f.agent_speed = config.speed();
    f.agent_radius = agent.radius;
    f
}

/// `NavPathSearchStepJob.Execute` for pool entry `i`.
fn step_search(sys: &mut WalkerSystems, i: usize, agents: &mut AgentStore, frame: &Frame, warnings: &mut Warnings) {
    let chunks = frame.world.snapshot();
    let agent_id = sys.path_searches.entries[i].search.agent;
    // Nothing to search for any more: the request was withdrawn or met elsewhere, the agent flies, or it's gone.
    let Some(r) = agents.row(agent_id).filter(|&r| agents.data[r].path_request_enabled && !flying(&agents.data[r])) else {
        sys.path_searches.release(i);
        return;
    };
    // No navmesh to walk on right now: the request waits for one.
    let Some((e, _, nav)) = entry_nav(chunks, agents.chunk[r].entry) else {
        sys.path_searches.release(i);
        return;
    };
    let nav = nav.clone();
    let Some(config) = agents.data[r].walk.clone() else {
        sys.path_searches.release(i);
        return;
    };
    let nav_key = frame.world.nav_key(e as i32);
    let request = agents.data[r].path_request;

    let WalkerSystems { path_searches, congestion, corridor, waypoints, stats, .. } = sys;
    let pooled = &mut path_searches.entries[i];
    let (search, store) = (&mut pooled.search, &mut pooled.store);
    let finished;
    let valid;
    {
        let filter = build_filter(&agents.data[r], &config, &nav, chunks, e, frame, congestion.view(e));
        // Asked something else since, or onto another navmesh: start over.
        if search.located && (nav_key != search.nav || !same_request(search, &request)) {
            search.located = false;
        }
        valid = if search.located { true } else { locate(search, store, &nav, nav_key, e, &request, &config, &filter, &agents.surface[r], &agents.data[r], warnings, stats) };
        search.frames += 1;
        finished = !valid || pathfinding::step(&nav, &filter, &mut search.state, store, SEARCH_SLICE);
    }
    if finished {
        apply(search, store, r, valid, &request, &config, &nav, e, agents, frame, congestion, corridor, waypoints, warnings, stats);
        path_searches.release(i);
    }
}

/// `SameRequest`.
fn same_request(search: &NavPathSearch, request: &PathRequest) -> bool {
    search.request_goal == request.goal
        && search.from_current == request.start_from_current_position
        && (request.start_from_current_position || search.request_start == request.start)
}

/// `NavPathSearchStepJob.Locate`: snaps the ends and begins. False: an end can't be snapped, or the search rejects them.
#[allow(clippy::too_many_arguments)]
fn locate(
    search: &mut NavPathSearch,
    store: &mut nav_query::search::SearchBufferStore,
    nav: &NavMeshData,
    nav_key: u64,
    entry: usize,
    request: &PathRequest,
    config: &NavMeshAgentConfig,
    filter: &NavMeshQueryFilter,
    surface: &NavMeshAgentSurface,
    d: &AgentData,
    warnings: &mut Warnings,
    stats: &mut WalkerStats,
) -> bool {
    let agent = &*config.settings;
    search.located = true;
    search.nav = nav_key;
    search.entry = entry as i32;
    search.request_goal = request.goal;
    search.request_start = request.start;
    search.from_current = request.start_from_current_position;
    store.begin();
    search.stamp = store.stamp;

    let from = if request.start_from_current_position { surface.surface_position } else { request.start };
    let from_agent = request.start_from_current_position;
    let mut start = if from_agent {
        pathfinding::find_nearest_poly_sided(nav, from, agent.max_snap_distance, filter, surface.up, 0.5 * agent.step_height.max(1e-3))
    } else {
        pathfinding::find_nearest_poly(nav, from, agent.max_snap_distance, filter)
    };
    // Fallback if the agent is off the navmesh (mid-fold when the navmesh was rebuilt): the waypoint it was heading for.
    if start.is_none() {
        if let Some(w) = d.walker.as_deref() {
            if w.path.count > 0 && w.path.next_index < w.path.count {
                start = pathfinding::find_nearest_poly(nav, w.path.next, agent.max_snap_distance, filter);
            }
        }
    }
    let goal = pathfinding::find_nearest_poly(nav, request.goal, agent.max_snap_distance, filter);
    (search.start_poly, search.start) = start.unwrap_or((-1, Float3::default()));
    (search.goal_poly, search.goal) = goal.unwrap_or((-1, Float3::default()));
    if search.start_poly < 0 || search.goal_poly < 0 {
        stats.path_failures += 1;
    }
    if search.start_poly < 0 {
        let mut w = NavWarning::new(NavWarningKind::PathStartOffMesh);
        w.a = from;
        w.f.x = agent.max_snap_distance;
        warnings.add(&w);
        return false;
    }
    if search.goal_poly < 0 {
        let mut w = NavWarning::new(NavWarningKind::PathGoalOffMesh);
        w.a = request.goal;
        w.f.x = agent.max_snap_distance;
        warnings.add(&w);
        return false;
    }
    pathfinding::begin(nav, search.start_poly, search.start, search.goal_poly, search.goal, filter, &mut search.state, store)
}

/// `NavPathSearchStepJob.Apply`: writes the agent's new path, swaps its reservations, disables its request.
#[allow(clippy::too_many_arguments)]
fn apply(
    search: &NavPathSearch,
    store: &nav_query::search::SearchBufferStore,
    r: usize,
    valid: bool,
    request: &PathRequest,
    config: &NavMeshAgentConfig,
    nav: &NavMeshData,
    e: usize,
    agents: &mut AgentStore,
    frame: &Frame,
    congestion: &mut CongestionTable,
    corridor: &mut Vec<NavMeshPathNode>,
    waypoints: &mut Vec<NavMeshWaypoint>,
    warnings: &mut Warnings,
    stats: &mut WalkerStats,
) {
    stats.path_requests += 1;
    let agent = &*config.settings;
    let d = &mut agents.data[r];
    d.path_request_enabled = false;
    d.path_request.urgent = false;
    let Some(w) = d.walker.as_deref_mut() else { return };

    // The agent drops its old corridor's reservations, so it doesn't route around itself next time.
    if congestion.is_created() && w.path.nav == search.nav {
        congestion.reserve(e, &w.corridor, w.cursor.index, w.path.state, config.speed(), -1);
    }
    w.corridor.clear();
    w.cursor.index = 0;

    w.elements.clear();
    w.path.goal = request.goal;
    w.path.computed_time = frame.time;
    w.path.nav = search.nav;
    w.path.next_index = 0;
    w.path.count = 0;
    if !valid {
        w.path.state = NavPathState::Failed;
        return;
    }

    let status = pathfinding::finish(&search.state, store, corridor);
    straight_path::straighten(nav, corridor, search.start, search.goal, waypoints);
    fill_corridor(nav, corridor, search.start, agent.radius, &mut w.corridor);
    write_waypoints(&mut w.elements, waypoints);

    w.path.count = w.elements.len() as i32;
    if w.elements.is_empty() {
        let mut warning = NavWarning::new(NavWarningKind::PathRejected);
        warning.n = Int4::new(search.start_poly, search.goal_poly, status as i32, 0);
        warnings.add(&warning);
        w.path.state = NavPathState::Failed;
        return;
    }
    w.path.state = if status == NavPathStatus::Success { NavPathState::Following } else { NavPathState::Partial };
    w.path.set_segment(&w.elements, 1.min(w.elements.len() - 1));
    if w.elements.len() == 1 {
        w.path.state = NavPathState::Arrived; // already at the goal
    }
    // Reserve the new route now, so paths written after this one (even this tick) see it.
    if congestion.is_created() {
        congestion.reserve(e, &w.corridor, 0, w.path.state, config.speed(), 1);
    }
}

/// `WriteWaypoints`.
fn write_waypoints(elements: &mut Vec<PathElement>, waypoints: &[NavMeshWaypoint]) {
    elements.clear();
    elements.extend(waypoints.iter().map(|w| PathElement { position: w.position, normal: w.normal, poly: w.poly, flags: w.flags, hinge: w.hinge }));
}

/// `FillCorridor`: corridor polygons with the distance to where the path enters each (as A* measures it), and the lanes
/// of the portal each is entered by.
pub(crate) fn fill_corridor(nav: &NavMeshData, nodes: &[NavMeshPathNode], start: Float3, radius: f32, corridor: &mut Vec<NavCorridor>) {
    corridor.clear();
    let mut prev = start;
    let mut dist = 0.0f32;
    for node in nodes {
        let mut lanes = 1.0;
        if node.link >= 0 {
            let link = &nav.links[node.link as usize];
            let (walk, crossing, land) = pathfinding::link_travel(link, prev);
            prev = land;
            dist += walk;
            dist += crossing;
            lanes = CongestionView::lanes(link.portal_a.distance(link.portal_b), radius);
        }
        corridor.push(NavCorridor { poly: node.poly, distance: dist, lanes });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Following (NavMeshPathFollowJob, NavMeshPathFollowSteeringJob)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavMeshPathFollowSystem`: advances every walker's path, its easing, and for agents with avoidance its desired
/// velocity and `NavSteering`.
pub fn follow(_sys: &mut WalkerSystems, agents: &mut AgentStore, frame: &Frame) {
    let dt = frame.dt;
    let rows: Vec<usize> = agents.active_rows().collect();
    let AgentStore { data, surface, motion: motions, desired, steered, steering, chunk, .. } = agents;
    for r in rows {
        let d = &mut data[r];
        if !d.kind.walks() || flying(d) || member(d) {
            continue;
        }
        let Some(config) = d.walk.clone() else { continue };
        let agent = &*config.settings;
        let avoids = d.avoidance.is_some();
        let (chunk_route, route) = (d.chunk_route.as_deref().map(|c| c.route), d.route.as_deref().map(|x| x.route));
        let Some(w) = d.walker.as_deref_mut() else { continue };
        let loaded = chunk[r].entry >= 0; // else paused
        let s = surface[r];
        if loaded {
            follow_path(&mut w.path, &mut w.progress, &w.elements, agent, &s, dt);
        }
        motion::walker_motion(&mut motions[r], agent, config.speed(), &w.path, &w.elements, chunk_route.as_ref(), route.as_ref(), s.surface_position, loaded, dt);
        let scale = if agent.motion.ease == NavEase::Constant { 1.0 } else { motions[r].scale };

        let up = s.up.normalize_safe(Float3::new(0.0, 1.0, 0.0));
        let mut v = desired[r];
        let steers = loaded && steerable(&w.path, w.elements.len(), dt) && try_preferred_velocity(&w.path, &config, scale, s.surface_position, up, dt, &mut v);
        if !avoids {
            // Not Foxfire's: the velocity it walks at, for hosts that move it themselves.
            desired[r] = if steers { v } else { Float3::default() };
            steering[r] = false;
            continue;
        }
        desired[r] = v;
        if steers && steering[r] {
            continue; // still steering: avoidance writes the steered velocity
        }
        steering[r] = steers;
        if steers {
            steered[r] = v; // just started: avoidance starts from what it wants
        } else {
            desired[r] = Float3::default();
            steered[r] = Float3::default();
        }
    }
}

/// `NavMeshPathFollowJob.Follow`: advances the path past the waypoints the agent has reached (or passed), and skips one
/// it's stuck on.
pub fn follow_path(path: &mut NavPath, progress: &mut NavPathProgress, elements: &[PathElement], agent: &NavMeshAgent, surface: &NavMeshAgentSurface, dt: f32) {
    if !moving(path.state) {
        return;
    }
    let count = elements.len();
    let mut next = path.next_index.max(0) as usize;
    while next < count {
        let mut reach = if next == count - 1 { agent.arrival_distance } else { agent.waypoint_reached_distance };
        // Fold exits and jump landings must actually be reached (the mover lands exactly on them).
        let landing = NavMeshWaypointFlags(NavMeshWaypointFlags::FOLD_EXIT.0 | NavMeshWaypointFlags::JUMP_LAND.0);
        if next < count - 1 && elements[next].flags.intersects(landing) {
            reach = reach.min(LANDING_REACH);
        }
        if surface.surface_position.distance(elements[next].position) > reach && !passed_corner(elements, next, surface.surface_position, reach + 2.0 * agent.radius) {
            break;
        }
        next += 1;
    }
    if next >= count {
        if count > 0 {
            path.set_segment(elements, count - 1);
        }
        path.next_index = count as i32;
        if path.state == NavPathState::Following {
            path.state = NavPathState::Arrived;
        }
        // A Partial path stops here; the repath retries it on its timer.
        return;
    }
    if next as i32 != path.next_index {
        path.set_segment(elements, next);
    }
    if skip_if_stuck(progress, path, agent, surface, dt) && next < count - 1 {
        path.set_segment(elements, next + 1);
    }
}

/// `SkipIfStuck`: true if the agent has gone `stuck_skip_time` without getting `MinProgress` closer to its waypoint.
fn skip_if_stuck(progress: &mut NavPathProgress, path: &NavPath, agent: &NavMeshAgent, surface: &NavMeshAgentSurface, dt: f32) -> bool {
    let distance = surface.surface_position.distance(path.next);
    let same_target = progress.target.distance(path.next) <= agent.waypoint_reached_distance.max(1.0);
    if !same_target || progress.stuck_time < 0.0 {
        *progress = NavPathProgress { target: path.next, closest_distance: distance, stuck_time: 0.0 };
        return false;
    }
    if agent.stuck_skip_time <= 0.0 {
        return false;
    }
    if distance < progress.closest_distance - MIN_PROGRESS {
        progress.closest_distance = distance;
        progress.stuck_time = 0.0;
        return false;
    }
    progress.stuck_time += dt;
    if progress.stuck_time < agent.stuck_skip_time {
        return false;
    }
    progress.stuck_time = -1.0; // restart on the next waypoint
    true
}

/// `PassedCorner`: past plain intermediate waypoint `next` (beyond the line through it, square to its segment), within
/// `lateral` of that line.
fn passed_corner(elements: &[PathElement], next: usize, pos: Float3, lateral: f32) -> bool {
    if next == 0 || next >= elements.len() - 1 {
        return false;
    }
    let n = elements[next];
    let special = NavMeshWaypointFlags(
        NavMeshWaypointFlags::FOLD_ENTER.0 | NavMeshWaypointFlags::FOLD_EXIT.0 | NavMeshWaypointFlags::JUMP_START.0 | NavMeshWaypointFlags::JUMP_LAND.0,
    );
    if n.flags.intersects(special) {
        return false;
    }
    let dir = (n.position - elements[next - 1].position).normalize_safe(Float3::default());
    if dir.length_sq() < 0.5 {
        return false;
    }
    let offset = pos - n.position;
    let along = offset.dot(dir);
    along >= 0.0 && (offset - dir * along).length_sq() <= lateral * lateral
}

/// `Steerable`: avoidance only steers agents walking a surface segment.
fn steerable(path: &NavPath, waypoint_count: usize, dt: f32) -> bool {
    let mv = moving(path.state) && path.next_index < path.count && (path.next_index as usize) < waypoint_count;
    mv && dt > 0.0 && !path.is_jump_segment() && !path.is_fold_segment()
}

/// `TryPreferredVelocity`: towards the next waypoint in the surface plane at full speed (eased by `scale`) without
/// overshooting it. False for a segment that mostly leaves the surface plane.
fn try_preferred_velocity(path: &NavPath, config: &NavMeshAgentConfig, scale: f32, pos: Float3, up: Float3, dt: f32, desired: &mut Float3) -> bool {
    let agent = &*config.settings;
    let mut to_next = path.next - pos;
    let dist3 = to_next.length();
    to_next -= up * to_next.dot(up);
    let dist = to_next.length();
    *desired = Float3::default();
    if dist < 0.7 * dist3 && dist3 > agent.waypoint_reached_distance {
        return false;
    }
    *desired = if dist > 1e-5 { to_next * ((config.speed() * scale).min(dist / dt) / dist) } else { Float3::default() };
    true
}

// ---------------------------------------------------------------------------------------------------------------------
// Movement (NavMeshSteeredMoveJob, NavMeshMoveJob)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavAgentMoveSystem`: steering walkers move by `agents.steered`, the rest along their path.
pub fn move_agents(_sys: &mut WalkerSystems, agents: &mut AgentStore, frame: &Frame) {
    let dt = frame.dt;
    for r in agents.active_rows().collect::<Vec<_>>() {
        let d = &agents.data[r];
        if !d.kind.walks() || flying(d) || member(d) {
            continue;
        }
        let (Some(config), Some(w)) = (d.walk.clone(), d.walker.as_deref()) else { continue };
        let path = w.path;
        let old = agents.surface[r].surface_position;
        let (contact, up, travel) = if agents.steering[r] {
            // NavMeshSteeredMoveJob: avoidance already kept it on the navmesh.
            let v = agents.steered[r];
            let contact = old + v * dt;
            let travel = if v.length_sq() > 1e-6 { v } else { path.next - contact };
            (contact, path.prev_normal, travel)
        } else {
            if agents.chunk[r].entry < 0 {
                agents.velocity[r] = Float3::default();
                continue; // its chunk isn't loaded: paused
            }
            if !(moving(path.state) && path.next_index < path.count) {
                agents.velocity[r] = Float3::default();
                continue; // leave idle agents alone so other systems can move them
            }
            let scale = if config.settings.motion.ease == NavEase::Constant { 1.0 } else { agents.motion[r].scale };
            let mut contact = old;
            if path.is_jump_segment() {
                let (up, travel) = move_along_jump(&path, &config.settings, dt, &mut contact);
                (contact, up, travel)
            } else if path.is_fold_segment() {
                let (up, travel) = move_across_fold(&path, config.speed() * scale * dt, &mut contact);
                (contact, up, travel)
            } else {
                let to_next = path.next - contact;
                let dist = to_next.length();
                let step = config.speed() * scale * dt; // eased; jumps keep their own timing
                contact = if dist <= step { path.next } else { contact + to_next * (step / dist.max(1e-6)) };
                (contact, path.prev_normal, to_next)
            }
        };
        place(agents, r, contact, up, travel, &config, dt);
        agents.velocity[r] = if dt > 0.0 { (contact - old) / dt } else { Float3::default() };
    }
}

/// `NavMeshMoveJob.Place`: the contact on a surface facing `up`, the body `pivot_offset` above it, turning towards
/// `travel` (projected onto the surface) at the agent's turn speed. Position and rotation are written only for agents
/// whose `update_position` / `update_rotation` are on (the host moves the rest).
pub(crate) fn place(agents: &mut AgentStore, r: usize, contact: Float3, up: Float3, travel: Float3, config: &NavMeshAgentConfig, dt: f32) {
    agents.surface[r].surface_position = contact;
    agents.surface[r].up = up;
    let (update_position, update_rotation) = (agents.data[r].update_position, agents.data[r].update_rotation);
    if update_position {
        // Body placement uses the target up, not the (lagging) rotation, so the body is always clear of the surface.
        agents.position[r] = contact + up * config.settings.pivot_offset;
        agents.up[r] = up;
    }
    if !update_rotation {
        return;
    }
    let rotation = agents.rotation[r];
    let mut forward = travel - up * travel.dot(up);
    if forward.length_sq() < 1e-6 {
        let current = quat_rotate(rotation, Float3::new(0.0, 0.0, 1.0));
        forward = current - up * current.dot(up);
    }
    if forward.length_sq() < 1e-6 {
        return;
    }
    let target = look_rotation_safe(forward.normalize(), up);
    let blend = 1.0 - (-config.turn_speed() * dt).exp();
    agents.rotation[r] = slerp(rotation, target, blend);
}

/// `MoveAlongJump`: the jump segment along `jump_arc` (the arc the bake checked), timed by gravity: speed along the arc =
/// apex speed + sqrt(2 g (apex height - height)), rise gravity before the apex, fall gravity after. Up blends from the
/// take-off normal to the landing's. Returns (up, travel direction).
fn move_along_jump(path: &NavPath, agent: &NavMeshAgent, dt: f32, contact: &mut Float3) -> (Float3, Float3) {
    let (a, b) = (path.prev, path.next);
    let h = (b - a).xz();
    let h2 = h.length_sq();
    let dy = b.y - a.y;
    let k = agent.jump_arc_height + 0.5 * dy.abs(); // same k as JumpArc

    // Progress from the contact's horizontal position (horizontal motion along the arc is linear); a vertical drop
    // has no horizontal extent, so height progress there.
    let mut t = if h2 > 1e-4 {
        ((*contact - a).xz().dot(h) / h2).clamp(0.0, 1.0)
    } else {
        ((contact.y - a.y).abs() / dy.abs().max(1e-4)).clamp(0.0, 1.0)
    };
    let t_apex = if k > 1e-4 { (0.5 + dy / (8.0 * k)).clamp(0.0, 1.0) } else { 1.0 };
    let apex_y = a.y + dy * t_apex + 4.0 * k * t_apex * (1.0 - t_apex);
    let apex_speed = agent.jump_apex_speed.max(1.0); // never stall at the top

    // Integrate in a few substeps: speed varies quickly near take-off and landing.
    const SUBSTEPS: i32 = 4;
    let sdt = dt / SUBSTEPS as f32;
    let mut i = 0;
    while i < SUBSTEPS && t < 1.0 {
        let y = a.y + dy * t + 4.0 * k * t * (1.0 - t);
        let g = if t < t_apex { agent.jump_rise_gravity } else { agent.jump_fall_gravity };
        let speed = apex_speed + (2.0 * g.max(0.0) * (apex_y - y).max(0.0)).sqrt();
        let vy = dy + 4.0 * k * (1.0 - 2.0 * t);
        let dsdt = (h2 + vy * vy).sqrt().max(1e-4);
        t = (t + speed * sdt / dsdt).clamp(0.0, 1.0);
        i += 1;
    }
    *contact = if t >= 1.0 { b } else { surface::jump_arc(a, b, agent.jump_arc_height, t) };
    let up = path.prev_normal.lerp(path.next_normal, t).normalize_safe(path.next_normal);
    (up, Float3::new(h.x, 0.0, h.y))
}

/// `MoveAcrossFold`: inside corners take the chord; outside corners (`FOLD_OVER_EDGE`) go prev -> hinge -> next. Up
/// blends by progress. Returns (up, travel direction).
fn move_across_fold(path: &NavPath, step: f32, contact: &mut Float3) -> (Float3, Float3) {
    let (n_a, n_b) = (path.prev_normal, path.next_normal);
    let (a, b) = (path.prev, path.next);
    let convex = path.prev_flags.intersects(NavMeshWaypointFlags::FOLD_OVER_EDGE);
    let hinge = if convex { path.hinge } else { (a + b) * 0.5 };
    let len_a = if convex { a.distance(hinge) } else { a.distance(b) };
    let len_b = if convex { hinge.distance(b) } else { 0.0 };
    let total = (len_a + len_b).max(1e-4);

    let mut s = if !convex {
        (*contact - a).dot(b - a) / total
    } else if (*contact - hinge).dot(n_a) > -1e-3 && contact.distance_sq(a) <= len_a * len_a + 1e-3 {
        a.distance(*contact) // still on the first leg (old surface)
    } else {
        len_a + hinge.distance(*contact) // on the second leg (new surface)
    };
    s = (s + step).clamp(0.0, total);

    let travel = if !convex {
        *contact = a.lerp(b, s / total);
        b - a
    } else if s <= len_a {
        *contact = a.lerp(hinge, if len_a > 1e-4 { s / len_a } else { 1.0 });
        hinge - a
    } else {
        *contact = hinge.lerp(b, if len_b > 1e-4 { (s - len_a) / len_b } else { 1.0 });
        b - hinge
    };
    let t = s / total;
    (n_a.lerp(n_b, t).normalize_safe(n_b), travel)
}

// ---------------------------------------------------------------------------------------------------------------------
// Quaternions (Unity.Mathematics' LookRotationSafe and slerp)
// ---------------------------------------------------------------------------------------------------------------------

/// `quaternion.LookRotationSafe`: identity if `forward` and `up` are degenerate.
pub fn look_rotation_safe(forward: Float3, up: Float3) -> Float4 {
    let fl = forward.dot(forward);
    let ul = up.dot(up);
    let f = forward * (1.0 / fl.sqrt());
    let u = up * (1.0 / ul.sqrt());
    let t = u.cross(f);
    let tl = t.dot(t);
    let t = t * (1.0 / tl.sqrt());
    let u = f.cross(t);
    let mn = fl.min(ul).min(tl);
    let mx = fl.max(ul).max(tl);
    let accept = mn > 1e-35 && mx < 1e35 && fl.is_finite() && ul.is_finite() && tl.is_finite();
    if !accept {
        return Float4::new(0.0, 0.0, 0.0, 1.0);
    }
    quat_from_basis(t, u, f)
}

/// The rotation whose columns are `x`, `y`, `z` (orthonormal).
fn quat_from_basis(x: Float3, y: Float3, z: Float3) -> Float4 {
    let (m00, m01, m02) = (x.x, y.x, z.x);
    let (m10, m11, m12) = (x.y, y.y, z.y);
    let (m20, m21, m22) = (x.z, y.z, z.z);
    let trace = m00 + m11 + m22;
    let q = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        Float4::new((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s)
    } else if m00 > m11 && m00 > m22 {
        let s = (1.0 + m00 - m11 - m22).sqrt() * 2.0;
        Float4::new(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s)
    } else if m11 > m22 {
        let s = (1.0 + m11 - m00 - m22).sqrt() * 2.0;
        Float4::new((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s)
    } else {
        let s = (1.0 + m22 - m00 - m11).sqrt() * 2.0;
        Float4::new((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s)
    };
    let n = (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).sqrt();
    q / n
}

/// `math.slerp`.
pub fn slerp(q1: Float4, q2: Float4, t: f32) -> Float4 {
    let mut dt = q1.x * q2.x + q1.y * q2.y + q1.z * q2.z + q1.w * q2.w;
    let mut q2 = q2;
    if dt < 0.0 {
        dt = -dt;
        q2 = -q2;
    }
    if dt < 0.9995 {
        let angle = dt.acos();
        let s = 1.0 / (1.0 - dt * dt).sqrt();
        let w1 = (angle * (1.0 - t)).sin() * s;
        let w2 = (angle * t).sin() * s;
        q1 * w1 + q2 * w2
    } else {
        let q = q1 + (q2 - q1) * t;
        let n = (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).sqrt();
        q / n
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Staying on the navmesh (NavMeshAvoidance.MoveAlongSurface / LocatePoly)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavMeshAvoidance.MoveAlongSurface`: moves from `start` (on `start_poly`) towards `end` without leaving the navmesh,
/// like Detour's moveAlongSurface: searches the polygons around the move through internal links (never into a closed
/// gate) and returns the point on them nearest `end`, projected onto the surface, with its polygon. Blocked moves
/// slide along walls.
pub fn move_along_surface(nav: &NavMeshData, start_poly: i32, start: Float3, end: Float3, closed_gates: &[bool]) -> (Float3, i32) {
    const MAX_VISITED: usize = 16;
    let mut visited: Vec<i32> = Vec::with_capacity(MAX_VISITED);
    visited.push(start_poly);
    let search_pos = (start + end) * 0.5;
    let search_radius = 0.5 * start.distance(end) + 1e-3;
    let mut best = start;
    let mut best_d2 = f32::MAX;
    let mut end_poly = start_poly;
    let mut v = 0;
    while v < visited.len() {
        let poly = visited[v];
        v += 1;
        if let Some((on_surface, _)) = surface::try_get_surface_point(nav, poly, end) {
            return (on_surface, poly); // end is on this polygon
        }
        if surface::point_in_poly(nav, poly, end) {
            // Inside the polygon but between its detail triangles: project onto the polygon's plane instead.
            return (project_onto_poly_plane(nav, poly, end), poly);
        }
        let (cp, _) = surface::closest_point_on_poly(nav, poly, end);
        let d2 = cp.distance_sq(end);
        if d2 < best_d2 {
            best_d2 = d2;
            best = cp;
            end_poly = poly;
        }
        let p = &nav.polys[poly as usize];
        for l in 0..p.link_count {
            let link = &nav.links[(p.link_start + l) as usize];
            if link.kind != NavLinkKind::INTERNAL {
                continue;
            }
            if visited.len() >= MAX_VISITED {
                break;
            }
            if visited.contains(&link.to_poly) {
                continue;
            }
            if distance_to_segment_sq_2d(&nav.bins[p.bin as usize], search_pos, link.portal_a, link.portal_b) > search_radius * search_radius {
                continue;
            }
            if NavGates::is_closed(nav.polys[link.to_poly as usize].gate, closed_gates) {
                continue;
            }
            visited.push(link.to_poly);
        }
    }
    (best, end_poly)
}

/// `NavMeshAvoidance.LocatePoly`: the polygon under `pos` on the surface facing `up` (within 60 degrees): `hint` if it
/// contains it, else one of its neighbours, else either fallback, else (only with a hint) the nearest such polygon
/// within `max_distance`. -1 if none.
pub fn locate_poly(nav: &NavMeshData, pos: Float3, up: Float3, hint: i32, fallback_a: i32, fallback_b: i32, max_distance: f32) -> i32 {
    if contains(nav, hint, pos, up, max_distance) {
        return hint;
    }
    if hint >= 0 && (hint as usize) < nav.polys.len() {
        let p = &nav.polys[hint as usize];
        for l in 0..p.link_count {
            let link = &nav.links[(p.link_start + l) as usize];
            if link.kind != NavLinkKind::INTERNAL {
                continue;
            }
            if contains(nav, link.to_poly, pos, up, max_distance) {
                return link.to_poly;
            }
        }
    }
    if contains(nav, fallback_a, pos, up, max_distance) {
        return fallback_a;
    }
    if contains(nav, fallback_b, pos, up, max_distance) {
        return fallback_b;
    }
    if hint < 0 {
        return -1;
    }
    let mut filter = NavMeshQueryFilter::zeroed();
    filter.allowed_bins = bins_facing(nav, up);
    pathfinding::find_nearest_poly(nav, pos, max_distance, &filter).map_or(-1, |(p, _)| p)
}

/// `NavMeshAvoidance.Faces`: the polygon is on the surface facing `up` (within 60 degrees).
pub fn faces(nav: &NavMeshData, poly: i32, up: Float3) -> bool {
    poly >= 0 && (poly as usize) < nav.polys.len() && nav.polys[poly as usize].normal.dot(up) >= 0.5
}

fn contains(nav: &NavMeshData, poly: i32, pos: Float3, up: Float3, max_distance: f32) -> bool {
    faces(nav, poly, up) && surface::point_in_poly(nav, poly, pos) && near_surface(nav, poly, pos, max_distance)
}

fn bins_facing(nav: &NavMeshData, up: Float3) -> u64 {
    let mut mask = 0u64;
    for (b, bin) in nav.bins.iter().enumerate().take(64) {
        if bin.n.dot(up) >= 0.5 {
            mask |= 1u64 << b;
        }
    }
    mask
}

fn near_surface(nav: &NavMeshData, poly: i32, pos: Float3, max_distance: f32) -> bool {
    surface::try_get_surface_point(nav, poly, pos).is_some_and(|(p, _)| p.distance_sq(pos) <= max_distance * max_distance)
}

fn project_onto_poly_plane(nav: &NavMeshData, poly: i32, p: Float3) -> Float3 {
    let pp = &nav.polys[poly as usize];
    let n = nav.bins[pp.bin as usize].n;
    let denom = n.dot(pp.normal);
    if denom.abs() < 1e-6 {
        p
    } else {
        p + n * ((pp.center - p).dot(pp.normal) / denom)
    }
}

fn distance_to_segment_sq_2d(bin: &OrientationBin, p: Float3, a: Float3, b: Float3) -> f32 {
    let p2 = Float2::new(p.dot(bin.t), p.dot(bin.b));
    let a2 = Float2::new(a.dot(bin.t), a.dot(bin.b));
    let ab = Float2::new(b.dot(bin.t), b.dot(bin.b)) - a2;
    let t = ((p2 - a2).dot(ab) / ab.length_sq().max(1e-12)).clamp(0.0, 1.0);
    let q = a2 + ab * t;
    (p2 - q).length_sq()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Handle;

    /// Foxfire's `NavChunkRouteTests.PathSearches_GoToUrgentRequestsFirst_ThenOldestPaths`: a pool of 3 and 11
    /// requests: the urgent one first (though its path is newest), then the two oldest; the next tick, with every
    /// search still running, nobody else gets one and the running ones aren't doubled.
    #[test]
    fn path_searches_go_to_urgent_requests_first_then_oldest_paths() {
        let mut pool: SearchPool<NavPathSearch> = SearchPool::default();
        pool.ensure(3);
        let mut tasks: Vec<SearchTask> = (0..10).map(|i| SearchTask { row: i, agent: AgentId(Handle::new(i as u32, 1)), computed_time: i as f64, urgent: false }).collect();
        tasks.push(SearchTask { row: 100, agent: AgentId(Handle::new(100, 1)), computed_time: 50.0, urgent: true });
        let run = |pool: &mut SearchPool<NavPathSearch>, tasks: &mut Vec<SearchTask>| {
            tasks.sort_by(|a, b| b.urgent.cmp(&a.urgent).then(a.computed_time.total_cmp(&b.computed_time)).then(a.row.cmp(&b.row)));
            let busy: Vec<AgentId> = pool.entries.iter().filter(|e| e.active).map(|e| e.search.agent).collect();
            for t in tasks.iter() {
                if !busy.contains(&t.agent) {
                    pool.assign(t.agent);
                }
            }
            let mut served: Vec<u32> = pool.entries.iter().filter(|e| e.active).map(|e| e.search.agent.row() as u32).collect();
            served.sort();
            served
        };
        assert_eq!(run(&mut pool, &mut tasks), vec![0, 1, 100], "the urgent request, then the two oldest paths");
        assert_eq!(pool.active_count(), 3, "every search in use");
        assert_eq!(run(&mut pool, &mut tasks), vec![0, 1, 100], "still the same three");
    }

    #[test]
    fn reservations_undo_exactly_and_hold_the_last_polygon_on_arrival() {
        let mut t = CongestionTable { loads: vec![0; 4 * 8], offsets: vec![0], slots: 8, bucket_seconds: 0.5, ..Default::default() };
        let corridor: Vec<NavCorridor> = (0..4).map(|i| NavCorridor { poly: i, distance: 1.0 * i as f32, lanes: 1.0 }).collect();
        t.reserve(0, &corridor, 0, NavPathState::Following, 1.0, 1);
        assert_eq!(t.load(0, 0, 0), 1);
        assert_eq!(t.load(0, 1, 2), 1, "poly 1 from 1 s (slot 2) to its exit at 2 s (slot 4)");
        assert_eq!(t.load(0, 1, 4), 1);
        assert_eq!(t.load(0, 1, 5), 0);
        assert_eq!(t.load(0, 3, 7), 1, "the final polygon is held to the window's end");
        t.reserve(0, &corridor, 0, NavPathState::Following, 1.0, -1);
        assert!(t.loads.iter().all(|&l| l == 0), "removing with the same inputs undoes adding");
        t.reserve(0, &corridor, 2, NavPathState::Arrived, 1.0, 1);
        assert_eq!((0..8).map(|b| t.load(0, 3, b)).sum::<i32>(), 8);
        t.reserve(0, &corridor, 0, NavPathState::Failed, 1.0, 1);
        assert_eq!(t.loads.iter().sum::<i32>(), 8, "failed paths reserve nothing");
    }

    #[test]
    fn look_rotation_faces_forward_with_up() {
        let q = look_rotation_safe(Float3::new(1.0, 0.0, 0.0), Float3::new(0.0, 1.0, 0.0));
        let f = quat_rotate(q, Float3::new(0.0, 0.0, 1.0));
        let u = quat_rotate(q, Float3::new(0.0, 1.0, 0.0));
        assert!((f - Float3::new(1.0, 0.0, 0.0)).length() < 1e-5, "{f:?}");
        assert!((u - Float3::new(0.0, 1.0, 0.0)).length() < 1e-5, "{u:?}");
        let q = look_rotation_safe(Float3::new(0.0, 1.0, 0.0), Float3::new(-1.0, 0.0, 0.0));
        assert!((quat_rotate(q, Float3::new(0.0, 1.0, 0.0)) - Float3::new(-1.0, 0.0, 0.0)).length() < 1e-5, "up on a wall");
        assert_eq!(look_rotation_safe(Float3::default(), Float3::new(0.0, 1.0, 0.0)), Float4::new(0.0, 0.0, 0.0, 1.0));
        let half = slerp(Float4::new(0.0, 0.0, 0.0, 1.0), q, 1.0);
        assert!((half.w - q.w).abs() < 1e-5 || (half.w + q.w).abs() < 1e-5);
    }
}
