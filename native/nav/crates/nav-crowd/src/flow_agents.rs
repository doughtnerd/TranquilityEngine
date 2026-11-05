//! Agents following flow fields (Foxfire's `NavFlowAgentSystem`, `NavFlowFollowing`, `NavFlowPathJob`). The fields
//! themselves are kept by `flow_fields.rs`.
//!
//! [`update`] is one pass over the walkers that may follow a field, in two parts:
//!
//! 1. **`NavFlowAgentSystem`.** Once any target has a `NavFlowGoal`, chasing walkers and group bodies (`kind` Walker
//!    with a chase) get a `NavFlowAgent` (off), so worlds without flow goals pay nothing.
//! 2. **`NavFlowFollowing.Update`**, which Foxfire runs inside the repath pass on each agent's turn (every
//!    [`CHECK_FRAMES`] ticks by row, or at once when [`urgent`]): the agent notes its field as wanted
//!    (`FlowFields::note_wanted`), turns following on while the field is ready and covers its navmesh (off, and asks for
//!    a path the ordinary way, otherwise), and, while on, asks for a new path when the field was rebuilt (spread over
//!    [`SPREAD`] ticks; kept when the corridor still goes the field's way), when it reaches the seam it ends at (it
//!    moves onto the chunk across), or near the end of a path that stops short of the goal.
//!
//! **`NavFlowPathJob`** ([`serve`]) runs inside `walkers::path_requests` (Foxfire's `NavPathRequestSystem`, after the
//! repaths and chunk routes): every following agent with a pending request (and not `searching`) is served from the
//!    field: [`FlowSet::walk`](nav_query::flow::FlowSet::walk) into a corridor, straightened into waypoints like a
//!    searched path ([`serve`]). A path the field can't give (the goal off the field's way and not joinable, nothing
//!    reachable, no start polygon) is left to an ordinary search near the goal: `searching` on, the request stays.
//!
//! A hand-off is queued as an ordinary search the same tick, as Foxfire's `NavFlowPathJob` adds it to the search tasks.
//!
//! Deviation: Foxfire runs `NavFlowFollowing.Update` inside `NavMeshRepathJob`, right after each agent's `Repath`; here
//! [`update`] runs as its own pass just before `walkers::repath` (same turns, same tests), so within one tick an agent's
//! following check sees the request state from before its repath rather than after.
//!
//! Foxfire reads the chase goal from the target's transform (and its surround slot); here from
//! [`crate::surround_slots::chase_goal`] over [`AgentStore::target_position`].
use crate::agents::{AgentData, AgentKind, AgentStore};
use crate::components::{target_key, NavFlowAgent, NavPathState, PathElement};
use crate::filters::{effective_area_costs, walk_filter};
use crate::ids::TargetRef;
use crate::settings::NavMeshAgent;
use crate::surround_slots;
use crate::tick::Frame;
use crate::walkers;
use crate::world::Targets;
use nav_math::math::{self, max};
use nav_math::{Float3, Hash128};
use nav_query::chunks::{ChunkEntry, NavChunks};
use nav_query::crossing;
use nav_query::filter::NavMeshQueryFilter;
use nav_query::flow::{self, FlowAgent, FlowFields, FlowSet, FlowWalkEnd};
use nav_query::pathfinding::{find_nearest_poly, find_nearest_poly_sided, NavMeshPathNode};
use nav_query::straight_path::{straighten, NavMeshWaypoint};
use std::collections::BTreeMap;
use std::sync::Arc;

/// `NavMeshRepathJob.CheckFrames`: an agent's full check runs every this many ticks, staggered by row.
pub const CHECK_FRAMES: u64 = 4;
/// `NavFlowFollowing.Spread`: ticks agents' requests are spread over when a field is finished.
pub const SPREAD: usize = 8;
/// `NavFlowFollowing.SpreadStep`: seconds per tick of the spread.
pub const SPREAD_STEP: f32 = 1.0 / 60.0;
/// `NavFlowPathJob.MaxCorridor`: most polygons a path from the field covers; the agent asks for more near its end.
pub const MAX_CORRIDOR: i32 = 128;

/// Why a request was left to an ordinary search (`NavPerfCounter.FlowHandoff*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandOff {
    NoField,
    NoStart,
    Unreached,
    GoalOffMesh,
    NoJoin,
}

/// Counters for the recorder (`NavPerfCounter.Flow*`), last tick's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlowAgentStats {
    /// Agents on a field.
    pub following: usize,
    /// Paths served from fields.
    pub paths: usize,
    /// Paths kept across a rebuilt field (`FlowPathsKept`).
    pub kept: usize,
    pub handoffs: usize,
}

/// The flow agent step's state between ticks.
#[derive(Clone, Debug, Default)]
pub struct FlowAgentSystems {
    /// Per agent type: the settings fields are built with (`NavFlowSetWanted.Settings`), made once per type.
    pub agents: BTreeMap<Hash128, Arc<FlowAgent>>,
    /// The walk settings each of `agents` was made from (a changed type is made again).
    sources: BTreeMap<Hash128, Arc<NavMeshAgent>>,
    pub stats: FlowAgentStats,
}

impl FlowAgentSystems {
    /// The type's `FlowAgent`, made from its walk settings and the first navmesh loaded for it (the bins the filter
    /// allows are the type's, the same on every navmesh).
    fn agent_for(&mut self, ty: Hash128, walk: &Arc<NavMeshAgent>, snapshot: &NavChunks) -> Option<Arc<FlowAgent>> {
        if let (Some(a), Some(src)) = (self.agents.get(&ty), self.sources.get(&ty)) {
            if Arc::ptr_eq(src, walk) {
                return Some(a.clone());
            }
        }
        let nav = snapshot.entries.iter().find(|e| e.agent_type == ty && !e.overlay).and_then(|e| e.nav.as_deref())?;
        let mut agent = FlowAgent::new(walk_filter(walk, nav, &[]), walk.radius);
        agent.max_snap_distance = walk.max_snap_distance;
        agent.portal_middles = walk.flow_field_portal_middles;
        let agent = Arc::new(agent);
        self.agents.insert(ty, agent.clone());
        self.sources.insert(ty, walk.clone());
        Some(agent)
    }
}

/// True while the agent is on a field (`NavFlowAgent` on): its requests are served from it.
pub fn following(d: &AgentData) -> bool {
    d.flow_agent.is_some_and(|f| f.enabled)
}

/// `NavFlowFollowing.Leave`: off for an agent that joined a group (its group plans for it now).
pub fn leave(d: &mut AgentData) {
    if following(d) {
        d.flow_agent = Some(NavFlowAgent { exit: -1, ..NavFlowAgent::default() });
    }
}

fn off() -> NavFlowAgent {
    NavFlowAgent { exit: -1, ..NavFlowAgent::default() }
}

/// The index of the agent's navmesh among the set's graphs, or None: the entry's chunk and overlay, the same navmesh
/// (built on what's loaded now).
fn graph_of(set: &FlowSet, entry: &ChunkEntry) -> Option<usize> {
    let nav = entry.nav.as_ref()?;
    set.graphs.iter().position(|g| g.chunk == entry.chunk && g.overlay == entry.overlay && Arc::ptr_eq(&g.nav, nav))
}

/// `NavFlowFollowing.Stale`: true while the follower's field is out of date for where its goal is now (being rebuilt,
/// or the goal moved past its threshold). Its chase repath waits; the rebuilt field asks every follower again.
pub fn stale(agents: &AgentStore, row: usize, flow: &FlowFields, targets: &Targets) -> bool {
    let d = &agents.data[row];
    let Some(fa) = d.flow_agent.filter(|f| f.enabled) else { return false };
    let Some(chase) = d.goal_target else { return false };
    let Some(set) = flow.set(fa.goal, d.agent_type) else { return false };
    if target_key(chase.target) != set.goal {
        return false;
    }
    if set.building {
        return true;
    }
    let (TargetRef::Target(id), Some(pos)) = (chase.target, agents.target_position(chase.target, targets)) else { return false };
    targets.get(id).and_then(|t| t.flow_goal).is_some_and(|g| pos.distance(set.built_goal) > goal_threshold(g.move_threshold))
}

fn goal_threshold(move_threshold: f32) -> f32 {
    if move_threshold > 0.0 {
        move_threshold
    } else {
        flow::DEFAULT_MOVE_THRESHOLD
    }
}

/// `NavFlowFollowing.Request`: asks for a path to the goal from where the agent is; a request already pending stands.
fn request(d: &mut AgentData, has_goal: bool, goal: Float3, from: Float3) {
    if d.path_request_enabled || !has_goal {
        return;
    }
    d.path_request.goal = goal;
    d.path_request.start = from;
    d.path_request.start_from_current_position = true;
    d.path_request_enabled = true;
}

/// `StillOnTheField`: true if the agent's corridor, from the polygon it's in on, still goes the rebuilt field's way,
/// and its last polygon leads on or is the goal's (`at_goal`). Its first step is skipped: that one came from a local
/// refinement, not the cell. A corridor ending at a stop or an exit, or running past the goal, doesn't count.
fn still_on_the_field(d: &AgentData, set: &FlowSet, entry: &ChunkEntry) -> Option<bool> {
    let walker = d.walker.as_deref()?;
    let corridor = &walker.corridor;
    let g = graph_of(set, entry)?;
    let graph = &set.graphs[g];
    let last = corridor.len() as i32 - 1;
    let cursor = walker.cursor.index;
    if last < 1 || cursor < 0 || cursor > last {
        return None;
    }
    let nav = entry.nav.as_deref()?;
    let mut at_goal = false;
    for k in max(cursor, 1)..=last {
        let poly = corridor[k as usize].poly;
        if poly < 0 || poly as usize >= graph.count {
            return None;
        }
        let next = set.cells[graph.start + poly as usize].next;
        if next < 0 {
            if k < last || next != flow::GOAL {
                return None; // past the goal, or ends at a stop or an exit
            }
            at_goal = true;
            break;
        }
        if k < last && nav.links[next as usize].to_poly != corridor[(k + 1) as usize].poly {
            return None;
        }
    }
    Some(at_goal)
}

/// `NavFlowAgentSystem` + `NavFlowFollowing.Update` (see the module doc; serving is [`serve`], from `walkers::path_requests`).
pub fn update(sys: &mut FlowAgentSystems, agents: &mut AgentStore, flow: &mut FlowFields, targets: &Targets, frame: &Frame) {
    sys.stats = FlowAgentStats::default();
    let any_goal = targets.iter().any(|(_, t)| t.flow_goal.is_some());
    let snapshot = frame.world.snapshot();

    // 1. NavFlowAgentSystem: NavFlowAgent (off) on chasing walkers and group bodies.
    if any_goal {
        for r in agents.active_rows().collect::<Vec<_>>() {
            let d = &mut agents.data[r];
            if d.kind == AgentKind::Walker && d.walker.is_some() && d.goal_target.is_some() && d.flow_agent.is_none() {
                d.flow_agent = Some(off());
            }
        }
    }

    // 2. NavFlowFollowing.Update.
    let rows: Vec<usize> = agents.active_rows().filter(|&r| agents.data[r].flow_agent.is_some()).collect();
    for &r in &rows {
        let entry = agents.chunk[r].entry;
        let Some(walker) = agents.data[r].walker.as_deref() else { continue };
        if !(r as u64 + frame.tick).is_multiple_of(CHECK_FRAMES) && !walkers::urgent(&walker.path, entry, frame) {
            if following(&agents.data[r]) {
                sys.stats.following += 1;
            }
            continue;
        }
        if agents.data[r].group_member.is_some_and(|m| m.enabled) {
            leave(&mut agents.data[r]); // a group member: its group plans for it
            continue;
        }
        if entry < 0 || entry as usize >= snapshot.entries.len() || snapshot.entries[entry as usize].nav.is_none() {
            continue; // paused, or no navmesh for this agent type
        }
        if follow(sys, agents, r, flow, targets, frame) {
            sys.stats.following += 1;
        }
    }
}

/// `NavFlowFollowing.Update` for one agent with a chase and a navmesh; true if it's on a field.
fn follow(sys: &mut FlowAgentSystems, agents: &mut AgentStore, r: usize, flow: &mut FlowFields, targets: &Targets, frame: &Frame) -> bool {
    let snapshot = frame.world.snapshot();
    let Some(chase) = agents.data[r].goal_target else { return false };
    let entry_ix = agents.chunk[r].entry as usize;
    let entry = &snapshot.entries[entry_ix];
    let ty = agents.data[r].agent_type;
    let (surface, speed, walk) = {
        let d = &agents.data[r];
        let Some(w) = d.walk.as_ref() else { return false };
        (agents.surface[r], w.speed(), w.settings.clone())
    };
    // Where it chases: the target, or its surround slot. hasGoal false if the target is gone.
    let target_pos = agents.target_position(chase.target, targets);
    let has_goal = target_pos.is_some();
    let chase_goal = target_pos.map(|p| surround_slots::chase_goal(agents.data[r].surround_slot.as_ref(), &chase, p, targets).0).unwrap_or_default();

    let key = target_key(chase.target);
    let mut fa = agents.data[r].flow_agent.unwrap_or_else(off);
    let following = fa.enabled;
    if fa.searching && !agents.data[r].path_request_enabled {
        fa.searching = false; // its last stretch was searched
    }

    // The target's set for this agent type: wanted, ready, covering the agent's navmesh.
    let mut ready = false;
    if let Some(fagent) = sys.agent_for(ty, &walk, snapshot) {
        flow.note_wanted(key, ty, &fagent, frame.time);
    }
    if let Some(s) = flow.set(key, ty) {
        ready = s.is_ready() && graph_of(s, entry).is_some(); // a goal on no navmesh still leads near it
    }

    let d = &mut agents.data[r];
    if !ready {
        if !following {
            d.flow_agent = Some(fa);
            return false;
        }
        d.flow_agent = Some(off()); // back to paths and routes
        request(d, has_goal, chase_goal, surface.surface_position);
        return false;
    }
    let s = flow.set(key, ty).expect("ready set");

    // Joining a field, or onto a rebuilt one: not all at once; each agent waits its turn (by row) over the next
    // SPREAD ticks, following its current path meanwhile.
    let due = frame.time - s.built_time >= ((r % SPREAD) as f32 * SPREAD_STEP) as f64;
    if !following || fa.goal != key {
        if !due {
            d.flow_agent = Some(fa);
            return false;
        }
        d.flow_agent = Some(NavFlowAgent { goal: key, exit: -1, enabled: true, ..NavFlowAgent::default() });
        request(d, has_goal, chase_goal, surface.surface_position);
        return true;
    }

    d.flow_agent = Some(fa);
    if d.path_request_enabled {
        return true; // served from the field this tick
    }
    let path = d.walker.as_deref().map(|w| w.path).unwrap_or_default();
    if fa.version != s.version {
        if !due {
            return true;
        }
        if path.state == NavPathState::Following {
            if let Some(at_goal) = still_on_the_field(d, s, entry) {
                // Its corridor still goes the new field's way: the path stands. One that now stops short of the new
                // end asks again near its end; one ending on the goal's polygon keeps what it had.
                fa.version = s.version;
                fa.short = fa.short || !at_goal;
                fa.exit = -1;
                d.flow_agent = Some(fa);
                sys.stats.kept += 1;
                return true;
            }
        }
        request(d, has_goal, chase_goal, surface.surface_position);
        return true;
    }

    if fa.exit >= 0 {
        if fa.exit as usize >= s.exits.len() {
            request(d, has_goal, chase_goal, surface.surface_position);
            return true;
        }
        // At the seam: onto the navmesh across. Close enough counts, as for route legs: a crowd heading for the same
        // crossing can't all reach its exact point.
        let exit = s.exits[fa.exit as usize];
        let reach = max(walk.arrival_distance, 2.0 * walk.radius);
        if path.state != NavPathState::Arrived && walkers::distance_to_segment(surface.surface_position, exit.a0, exit.a1) > reach {
            return true;
        }
        if let Some(next) = snapshot.find(exit.to_chunk, ty, exit.to_overlay) {
            agents.chunk[r] = crate::components::NavAgentChunk { chunk: exit.to_chunk, entry: next as i32 };
        }
        request(&mut agents.data[r], has_goal, chase_goal, surface.surface_position);
        return true;
    }

    if !fa.short {
        return true;
    }
    let lookahead = max(2.0 * walk.arrival_distance, 0.5 * speed);
    if path.state == NavPathState::Arrived
        || (path.next_index >= path.count - 1 && surface.surface_position.distance(path.next) <= lookahead)
    {
        request(d, has_goal, chase_goal, surface.surface_position);
    }
    true
}

/// `NavFlowPathJob.Execute` for one agent on a field with a pending request: walks the field from the agent's polygon
/// into a corridor of up to [`MAX_CORRIDOR`] polygons, straightens it into waypoints like a searched path and writes
/// the agent's path, waypoints and corridor, disabling the request. `Err` if the request is left to an ordinary search
/// (`searching` set, the request stays on).
pub fn serve(agents: &mut AgentStore, r: usize, flow: &FlowFields, frame: &Frame) -> Result<(), HandOff> {
    let snapshot = frame.world.snapshot();
    let entry_ix = agents.chunk[r].entry as usize;
    let entry = &snapshot.entries[entry_ix];
    let nav = entry.nav.as_deref().expect("a navmesh");
    let surface = agents.surface[r];
    let d = &mut agents.data[r];
    let ty = d.agent_type;
    let (Some(mut fa), Some(config)) = (d.flow_agent, d.walk.clone()) else { return Err(HandOff::NoField) };
    let walk = config.settings.clone();
    let request = d.path_request;
    let hand_off = |d: &mut AgentData, fa: &mut NavFlowAgent, version: i32, cause: HandOff| {
        fa.searching = true;
        fa.version = version;
        fa.exit = -1;
        fa.short = false;
        d.flow_agent = Some(*fa);
        Err(cause)
    };

    let Some(s) = flow.set(fa.goal, ty).filter(|s| s.is_ready()) else {
        let version = flow.set(fa.goal, ty).map_or(0, |s| s.version);
        return hand_off(d, &mut fa, version, HandOff::NoField);
    };
    let mut graph = None;
    if let Some(n) = entry.nav.as_ref() {
        for (g, gr) in s.graphs.iter().enumerate() {
            if gr.chunk == entry.chunk && gr.overlay == entry.overlay && Arc::ptr_eq(&gr.nav, n) {
                graph = Some(g);
            }
        }
    }
    let Some(graph) = graph else { return hand_off(d, &mut fa, s.version, HandOff::NoField) };

    // The agent's query filter: abilities and area costs, its chunk's gates and switched-off polygons (no congestion).
    let costs = effective_area_costs(frame.world_area_costs, &d.area_costs);
    let mut filter: NavMeshQueryFilter<'_> = walk_filter(&walk, nav, &costs);
    filter.closed_gates = Some(snapshot.gates_of(entry_ix));
    filter.switched_off = Some(snapshot.switched_off_of(entry_ix));
    filter.poly_costs = snapshot.poly_costs_for(entry_ix);
    filter.min_poly_cost = snapshot.min_poly_cost;
    filter.agent_speed = config.speed();
    filter.agent_radius = walk.radius;

    // The start as a path search places it: the agent's side of the surface first, else the waypoint it was heading for.
    let path = d.walker.as_deref().map(|w| w.path).unwrap_or_default();
    let from = if request.start_from_current_position { surface.surface_position } else { request.start };
    let mut start_poly = -1;
    let mut start = Float3::default();
    if let Some((p, pt)) = find_nearest_poly_sided(nav, from, walk.max_snap_distance, &filter, surface.up, 0.5 * max(walk.step_height, 1e-3)) {
        (start_poly, start) = (p, pt);
    }
    if start_poly < 0 && path.count > 0 && path.next_index < path.count {
        if let Some((p, pt)) = find_nearest_poly(nav, path.next, walk.max_snap_distance, &filter) {
            (start_poly, start) = (p, pt);
        }
    }

    // The agent's own goal ends the corridor if it's on the field's goal navmesh (a surround slot may be off the
    // field's way).
    let mut stop_poly = -1;
    let mut goal = request.goal;
    if s.goal_chunk == entry.chunk && s.goal_overlay == entry.overlay {
        if let Some((p, pt)) = find_nearest_poly(nav, request.goal, walk.max_snap_distance, &filter) {
            (stop_poly, goal) = (p, pt);
        }
    }

    let loaded = s.loaded(snapshot);
    let mut corridor: Vec<NavMeshPathNode> = Vec::with_capacity(MAX_CORRIDOR as usize + 1);
    let (mut end, exit) = s.walk(graph, &filter, start_poly, start, stop_poly, MAX_CORRIDOR, &mut corridor, Some((loaded.as_slice(), walk.radius)));
    let cells = s.cells_of(graph);

    // A slot beside the goal's polygon, off the field's way: join a walk from the slot onto this one. No search.
    if end == FlowWalkEnd::FieldGoal && stop_poly >= 0 && flow::join_to_stop(nav, cells, &s.exits, s.built_goal, &filter, stop_poly, goal, MAX_CORRIDOR, &mut corridor) {
        end = FlowWalkEnd::Goal;
    }
    // At the field's goal, but the agent's own goal is off this navmesh: it stays as near as this navmesh gets.
    if end == FlowWalkEnd::FieldGoal && stop_poly < 0 {
        end = FlowWalkEnd::Nearest;
    }
    if end == FlowWalkEnd::Unreached || (end == FlowWalkEnd::FieldGoal && corridor.len() <= 2) {
        let cause = if start_poly < 0 {
            HandOff::NoStart
        } else if end == FlowWalkEnd::Unreached {
            HandOff::Unreached
        } else if stop_poly < 0 {
            HandOff::GoalOffMesh
        } else {
            HandOff::NoJoin
        };
        return hand_off(d, &mut fa, s.version, cause);
    }

    let last = corridor[corridor.len() - 1].poly;
    let end_pos = match end {
        FlowWalkEnd::Goal => goal,
        FlowWalkEnd::Exit => exit_point(s, &loaded, exit, start, walk.radius),
        FlowWalkEnd::FieldGoal | FlowWalkEnd::Nearest => s.built_goal,
        _ => flow::leaves(nav, cells, &s.exits, s.built_goal, last),
    };

    write_path(d, nav, frame.world.nav_key(entry_ix as i32), frame.time, &corridor, start, end_pos, walk.radius);
    fa.version = s.version;
    fa.exit = if end == FlowWalkEnd::Exit { exit } else { -1 };
    fa.short = end != FlowWalkEnd::Goal && end != FlowWalkEnd::Nearest;
    fa.searching = false;
    d.flow_agent = Some(fa);
    Ok(())
}

/// Where a walk that ends at an exit crosses it: the point of the exit's portal toward where the field goes on past
/// it (`OnPortalToward` at the onward weight), not the point nearest the agent's start (that was the portal's end
/// for every agent coming from that side, and they filed along the border to it).
fn exit_point(s: &FlowSet, loaded: &[bool], exit: i32, start: Float3, radius: f32) -> Float3 {
    let e = &s.exits[exit as usize];
    let mut on = (e.b0 + e.b1) * 0.5;
    if e.to_graph >= 0 && (e.to_graph as usize) < s.graphs.len() && loaded[e.to_graph as usize] && e.to_poly >= 0 && (e.to_poly as usize) < s.graphs[e.to_graph as usize].count {
        let to = &s.graphs[e.to_graph as usize];
        on = flow::leaves(&to.nav, s.cells_of(e.to_graph as usize), &s.exits, s.built_goal, e.to_poly);
    }
    crossing::on_portal_toward(e.a0, e.a1, start, on, radius, crossing::ONWARD)
}

/// The agent's new path from the corridor, as a search writes one (`NavFlowPathJob.Write`): waypoints, the corridor
/// with distances and lanes, the segment, the state; the request is served.
#[allow(clippy::too_many_arguments)]
fn write_path(
    d: &mut AgentData,
    nav: &nav_format::NavMeshData,
    nav_key: u64,
    time: f64,
    corridor: &[NavMeshPathNode],
    start: Float3,
    end: Float3,
    radius: f32,
) {
    let request = d.path_request;
    d.path_request_enabled = false;
    if request.urgent {
        d.path_request.urgent = false;
    }
    let walker = d.walker.as_deref_mut().expect("a walker");
    walker.elements.clear();
    walker.path.goal = request.goal;
    walker.path.computed_time = time;
    walker.path.nav = nav_key;
    walker.path.next_index = 0;
    walker.path.count = 0;

    let mut waypoints: Vec<NavMeshWaypoint> = Vec::with_capacity(32);
    straighten(nav, corridor, start, end, &mut waypoints);
    walker
        .elements
        .extend(waypoints.iter().map(|w| PathElement { position: w.position, normal: w.normal, poly: w.poly, flags: w.flags, hinge: w.hinge }));
    walkers::fill_corridor(nav, corridor, start, radius, &mut walker.corridor);
    walker.cursor = Default::default();

    walker.path.count = walker.elements.len() as i32;
    if walker.elements.is_empty() {
        walker.path.state = NavPathState::Failed;
        return;
    }
    walker.path.state = NavPathState::Following;
    let next = math::min(1, walker.elements.len() as i32 - 1) as usize;
    walker.path.set_segment(&walker.elements, next);
    if walker.elements.len() == 1 {
        walker.path.state = NavPathState::Arrived;
    }
}
