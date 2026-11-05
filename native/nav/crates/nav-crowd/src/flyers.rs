//! Flyers: repath, flight path requests (a sliced flight A* on a pool of searches), steering and the move (Foxfire's
//! `NavVolumeAgentSystems.cs`, `NavFlightSteeringSystems.cs` and `Systems/Jobs/NavVolume*Job.cs`,
//! `NavFlightSearchJobs.cs`, `NavFlightSteeringJobs.cs`, `NavMotionJobs.cs`' flyer part).
//!
//! * [`setup`]: `NavVolumeAgentSetupSystem`. Its structural part (`FlyPath`, `PathRequest`, `NavMotionState`) is done
//!   when the agent is added; nothing per tick.
//! * [`repath`]: `NavVolumeRepathSystem`: enables a flyer's `PathRequest` when its chase target moved, it strayed from
//!   its segment, the timer ran out or its volume changed.
//! * [`path_requests`]: `NavVolumePathRequestSystem`: gathers the requests (urgent first, then the oldest paths), gives
//!   them to the free searches of [`FlyerSystems::flight_searches`] ([`SEARCH_POOL_SIZE`]) and advances every search in
//!   use by [`SEARCH_SLICE`] leaves; a finished one writes the flyer's path.
//! * [`steering`]: `NavFlightSteeringSystem`: the motion easing, then `NavFlightFollowSteeringJob`: advance the
//!   waypoints, write `agents.desired`, turn `agents.steering` on or off. The separation itself is `avoidance.rs`'s.
//! * [`move_agents`]: `NavVolumeMoveSystem`: `NavVolumeSteeredMoveJob` and `NavVolumeMoveJob`.
//!
//! Walk-and-fly agents are driven here only while `RouteData::flying` and not `walking` (`routes.rs` plays the take-off
//! and landing with both on); group members (`NavGroupMember` on) are skipped in every step: their group's steps move
//! them. Fly-only agents are `AgentKind::Flyer`; the repath is theirs alone (a walk-fly agent's repaths come from its
//! route).
use crate::agents::{AgentData, AgentKind, AgentStore};
use crate::components::{FlyPath, NavFlightAgentConfig, NavFlightSearch, NavPathState, PathRequest};
use crate::filters::{effective_area_costs, flight_filter};
use crate::motion;
use crate::surround_slots;
use crate::walkers::{look_rotation_safe, slerp};
use crate::pool::{PooledSearch, SearchPool};
use crate::settings::{NavEase, NavFlightAgent};
use crate::tick::Frame;
use crate::warnings::{NavWarning, NavWarningKind, Warnings};
use crate::world::Targets;
use nav_math::{Float3, Float4};
use nav_query::pathfinding::NavPathStatus;
use nav_query::volume;
use nav_format::NavVolumeData;
use std::sync::Arc;

/// `NavVolumePathRequestSystem.SearchPoolSize`: flight searches running at once.
pub const SEARCH_POOL_SIZE: usize = 64;

/// `NavVolumePathRequestSystem.SearchSlice`: leaves each flight search expands per tick.
pub const SEARCH_SLICE: i32 = 256;

/// A flyer asking for a search (`NavSearchTask`).
#[derive(Clone, Copy, Debug)]
struct SearchTask {
    row: usize,
    computed_time: f64,
    urgent: bool,
}

/// The flyer steps' state between ticks.
#[derive(Clone, Debug, Default)]
pub struct FlyerSystems {
    /// `NavFlightSearch` entities.
    pub flight_searches: SearchPool<NavFlightSearch>,
    tasks: Vec<SearchTask>,
    scratch: Vec<Float3>,
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers (also used by routes.rs and groups.rs). Easing is motion.rs's (`NavMotionStep`), quaternions
// walkers.rs's, the surround chase goal surround_slots.rs's, FlyHome groups.rs's (`NavGroupFlight`).
// ---------------------------------------------------------------------------------------------------------------------

/// `NavGroupMember` on.
#[inline]
pub(crate) fn is_member(d: &AgentData) -> bool {
    d.group_member.is_some_and(|m| m.enabled)
}

/// `NavWalking` enabled: the flight steps skip the agent.
#[inline]
pub(crate) fn is_walking(d: &AgentData) -> bool {
    d.route.as_deref().is_some_and(|r| r.walking)
}

/// The volume a flyer's path was computed on: its own entry's if that is the one, else any entry's with that key.
fn volume_by_key(frame: &Frame, own_entry: i32, key: u64) -> Option<Arc<NavVolumeData>> {
    if key == 0 {
        return None;
    }
    let entries = &frame.world.snapshot().entries;
    if own_entry >= 0 && frame.world.volume_key(own_entry) == key {
        return entries.get(own_entry as usize).and_then(|e| e.volume.clone());
    }
    (0..entries.len()).find(|&i| frame.world.volume_key(i as i32) == key).and_then(|i| entries[i].volume.clone())
}

/// `NavVolumeMoveJob.Face`: turns towards `direction` (unit), smoothed by `turn_speed`.
pub(crate) fn face(rotation: &mut Float4, direction: Float3, turn_speed: f32, dt: f32) {
    let target = look_rotation_safe(direction, Float3::new(0.0, 1.0, 0.0));
    let blend = 1.0 - (-turn_speed * dt).exp();
    *rotation = slerp(*rotation, target, blend);
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------------

/// `NavVolumeAgentSetupSystem` (nothing per tick: its components are made when the agent is added).
pub fn setup(_sys: &mut FlyerSystems, _agents: &mut AgentStore, _frame: &Frame) {}

/// `NavVolumeRepathSystem` + `NavVolumeRepathJob`: fly-only agents (walk-fly agents repath through their routes).
pub fn repath(_sys: &mut FlyerSystems, agents: &mut AgentStore, targets: &Targets, frame: &Frame) {
    let rows: Vec<usize> = agents.active_rows().collect();
    for r in rows {
        let d = &agents.data[r];
        if d.kind != AgentKind::Flyer || is_member(d) {
            continue;
        }
        let Some(flight) = d.flight.as_ref() else { continue };
        let Some(f) = d.flyer.as_deref() else { continue };
        let flyer = flight.effective();
        let entry = agents.chunk[r].entry;
        let Some(e) = usize::try_from(entry).ok().and_then(|e| frame.world.snapshot().entries.get(e)) else { continue };
        if e.volume.is_none() || d.path_request_enabled {
            continue;
        }
        let path = f.path;
        let mut goal = path.goal;
        let mut repath = false;
        if let Some(chase) = d.goal_target {
            if let Some(tp) = agents.target_position(chase.target, targets) {
                let (target_pos, repath_distance) = surround_slots::chase_goal(d.surround_slot.as_ref(), &chase, tp, targets);
                let chased = match d.chunk_route.as_deref() {
                    Some(c) if c.route.active => c.route.goal,
                    _ => path.goal,
                };
                if path.state == NavPathState::None || target_pos.distance(chased) > repath_distance {
                    goal = target_pos;
                    repath = true;
                }
            }
        }
        if path.state == NavPathState::None && !repath {
            continue;
        }
        if path.volume != frame.world.volume_key(entry) {
            repath = true;
        }
        let position = agents.position[r];
        let moving = path.state == NavPathState::Following || path.state == NavPathState::Partial;
        // A runtime cost volume changed a leaf's cost in its volume this tick (ADR 0070).
        if moving && frame.update.costs_changed && e.leaf_costs_changed && path.computed_time < e.last_cost_change {
            repath = true;
        }
        if moving && flyer.off_path_distance > 0.0 && path.next_index > 0 && (path.next_index as usize) < f.points.len() {
            let (a, b) = (path.prev, path.next);
            let ab = b - a;
            let t = nav_math::math::saturate((position - a).dot(ab) / ab.length_sq().max(1e-6));
            if position.distance(a + ab * t) > flyer.off_path_distance {
                repath = true;
            }
        }
        if flyer.repath_interval > 0.0 && path.state != NavPathState::Arrived && frame.time - path.computed_time >= flyer.repath_interval as f64 {
            repath = true;
        }
        if !repath {
            continue;
        }
        let d = &mut agents.data[r];
        d.path_request.start_from_current_position = true;
        d.path_request.start = position;
        d.path_request.goal = goal;
        d.path_request_enabled = true;
    }
}

/// `NavVolumePathRequestSystem`: `GatherFlightRequestsJob`, `NavFlightSearchAssignJob`, `NavFlightSearchStepJob`.
pub fn path_requests(sys: &mut FlyerSystems, agents: &mut AgentStore, frame: &Frame, warnings: &mut Warnings) {
    if agents.active_rows().any(|r| agents.data[r].kind.flies()) {
        sys.flight_searches.ensure(SEARCH_POOL_SIZE);
    }
    sys.flight_searches.release_dead(|id| agents.is_live(id));
    if sys.flight_searches.is_empty() {
        return;
    }
    let FlyerSystems { flight_searches, tasks, scratch } = sys;

    // Gather: the flyers asking (no entry, or no volume in it: the request waits).
    tasks.clear();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if !d.kind.flies() || !d.path_request_enabled || is_walking(d) {
            continue;
        }
        let Some(f) = d.flyer.as_deref() else { continue };
        let entry = agents.chunk[r].entry;
        let Some(e) = usize::try_from(entry).ok().and_then(|e| frame.world.snapshot().entries.get(e)) else { continue };
        if e.volume.is_none() {
            continue;
        }
        tasks.push(SearchTask { row: r, computed_time: f.path.computed_time, urgent: d.path_request.urgent });
    }

    // Assign: urgent first, then the oldest paths (ties by row, as the entity index).
    tasks.sort_by(|a, b| {
        if a.urgent != b.urgent {
            return if a.urgent { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.computed_time.partial_cmp(&b.computed_time).unwrap_or(std::cmp::Ordering::Equal).then(a.row.cmp(&b.row))
    });
    for t in tasks.iter() {
        let Some(id) = agents.id_of(t.row) else { continue };
        if flight_searches.find(id).is_some() {
            continue; // its search is running (the step restarts it if the request changed)
        }
        if flight_searches.assign(id).is_none() {
            break; // none free: the rest wait, enabled, with their current paths
        }
    }

    // Step every search in use, in pool order.
    for i in 0..flight_searches.len() {
        if flight_searches.entries[i].active {
            step_search(&mut flight_searches.entries[i], scratch, agents, frame, warnings);
        }
    }
}

/// The runtime cost volumes' leaf multipliers of an entry's flight volume (ADR 0070).
fn leaf_costs<'a>(frame: &'a Frame, entry: i32) -> volume::LeafCosts<'a> {
    let chunks = frame.world.snapshot();
    let table = usize::try_from(entry).ok().filter(|&e| e < chunks.entries.len()).and_then(|e| chunks.leaf_costs_for(e));
    volume::LeafCosts::new(table, chunks.min_leaf_cost)
}

fn same_request(search: &NavFlightSearch, request: &PathRequest) -> bool {
    search.request_goal == request.goal
        && search.from_current == request.start_from_current_position
        && (request.start_from_current_position || search.request_start == request.start)
}

/// `NavFlightSearchStepJob.Execute` for one search.
fn step_search(entry: &mut PooledSearch<NavFlightSearch>, scratch: &mut Vec<Float3>, agents: &mut AgentStore, frame: &Frame, warnings: &mut Warnings) {
    let PooledSearch { search, store, active } = entry;
    // Nothing to search for any more: the request was withdrawn or met elsewhere, the agent walks, or it's gone.
    let Some(r) = agents.row(search.agent) else {
        *active = false;
        return;
    };
    {
        let d = &agents.data[r];
        if !d.path_request_enabled || is_walking(d) || d.flyer.is_none() || d.flight.is_none() {
            *active = false;
            return;
        }
    }
    // No volume to fly in right now: the request waits for one.
    let chunk_entry = agents.chunk[r].entry;
    let Some(volume) = usize::try_from(chunk_entry).ok().and_then(|e| frame.world.snapshot().entries.get(e)).and_then(|e| e.volume.clone()) else {
        *active = false;
        return;
    };
    let volume_key = frame.world.volume_key(chunk_entry);
    let request = agents.data[r].path_request;
    let flyer = agents.data[r].flight.as_ref().map(NavFlightAgentConfig::effective).unwrap_or_default();
    let start_now = if request.start_from_current_position { agents.position[r] } else { request.start };

    // Asked something else since, or onto another volume: start over.
    if search.located && (volume_key != search.volume || !same_request(search, &request)) {
        search.located = false;
    }
    let mut valid = true;
    if !search.located {
        // Locate: snap the ends (a goal under the free air: the free air above it), make the filter, begin.
        search.located = true;
        search.volume = volume_key;
        search.entry = chunk_entry;
        search.request_goal = request.goal;
        search.request_start = request.start;
        search.from_current = request.start_from_current_position;
        let costs = effective_area_costs(frame.world_area_costs, &agents.data[r].area_costs);
        search.filter = flight_filter(&volume, &costs);
        search.below = false;
        store.begin();
        search.stamp = store.stamp;
        let mut goal = request.goal;
        if volume::snap_to_free(&volume, goal, flyer.max_snap_distance).0 < 0 && volume::snap_to_free(&volume, start_now, flyer.max_snap_distance).0 >= 0 {
            let (leaf, above) = volume::snap_to_free_above(&volume, goal, flyer.max_snap_distance);
            if leaf >= 0 {
                search.below = true;
                goal = above;
            }
        }
        valid = volume::begin_with(&volume, &search.filter, leaf_costs(frame, chunk_entry), start_now, goal, flyer.max_snap_distance, flyer.max_search_nodes, &mut search.state, store);
    }
    search.frames += 1;
    if valid && !volume::step_with(&volume, &search.filter, leaf_costs(frame, chunk_entry), &mut search.state, store, SEARCH_SLICE) {
        return; // more next tick
    }
    scratch.clear();
    let status = if valid { volume::finish_with(&volume, &search.filter, leaf_costs(frame, chunk_entry), &search.state, store, scratch) } else { NavPathStatus::InvalidInput };

    // Apply: the flyer's new path (or Failed); its request is met.
    let d = &mut agents.data[r];
    d.path_request_enabled = false;
    let f = d.flyer.as_deref_mut().expect("checked above");
    f.points.clear();
    f.path.goal = request.goal;
    f.path.computed_time = frame.time;
    f.path.volume = search.volume;
    f.path.next_index = 0;
    f.path.count = 0;
    if status == NavPathStatus::InvalidInput || scratch.is_empty() {
        let mut w = NavWarning::new(NavWarningKind::FlightOffVolume);
        w.a = start_now;
        w.b = request.goal;
        w.f.x = flyer.max_snap_distance;
        warnings.add(&w);
        f.path.state = NavPathState::Failed;
    } else {
        f.points.extend_from_slice(scratch);
        f.path.count = f.points.len() as i32;
        let n = f.points.len();
        let next = 1.min(n - 1);
        f.path.set_segment(&f.points, next);
        f.path.state = if n <= 1 {
            NavPathState::Arrived
        } else if status == NavPathStatus::Success && !search.below {
            NavPathState::Following
        } else {
            NavPathState::Partial
        };
    }
    *active = false; // its stamp stays: the next search on this entry must not see this one's keys
}

/// `NavVolumeMoveJob.ArrivalDistance`.
pub(crate) fn arrival_distance(path: &FlyPath, flyer: &NavFlightAgent) -> f32 {
    if path.arrival_distance > 0.0 { path.arrival_distance } else { flyer.arrival_distance }
}

/// `NavVolumeMoveJob.Advance`: moves past every point the flyer is within reach of (its waypoint distance, or its
/// arrival distance for the last). True if there's a point left to fly to; false at the end, where a Following path
/// becomes Arrived. Call only while Following or Partial.
pub(crate) fn advance(path: &mut FlyPath, points: &[Float3], flyer: &NavFlightAgent, position: Float3) -> bool {
    let count = points.len() as i32;
    while path.next_index < count {
        let reach = if path.next_index == count - 1 { arrival_distance(path, flyer) } else { flyer.waypoint_reached_distance };
        if position.distance(path.next) > reach {
            break;
        }
        path.next_index += 1;
        if path.next_index < count {
            path.set_segment(points, path.next_index as usize);
        }
    }
    if path.next_index < count {
        return true;
    }
    if path.state == NavPathState::Following {
        path.state = NavPathState::Arrived;
    }
    false
}

/// `NavFlightFollowSteeringJob.Toward`: full speed (eased by `scale`) at the next point, never past it this tick;
/// without an ease out it slows over the last two arrival distances.
fn toward(path: &FlyPath, flyer: &NavFlightAgent, scale: f32, count: usize, position: Float3, dt: f32) -> Float3 {
    let to_next = path.next - position;
    let dist = to_next.length();
    if dist < 1e-4 {
        return Float3::default();
    }
    let mut speed = flyer.speed * scale;
    if path.next_index as usize == count - 1 && path.arrival_distance <= 0.0 && !motion::eases_out(flyer.motion.ease) {
        let brake = 2.0 * flyer.arrival_distance.max(flyer.radius);
        speed *= nav_math::math::clamp(dist / brake, 0.1, 1.0);
    }
    speed = speed.min(dist / dt.max(1e-5));
    to_next * (speed / dist)
}

/// `NavFlightSteeringSystem`: `NavVolumeMotionJob`, then `NavFlightFollowSteeringJob`, for the flyers that are flying.
pub fn steering(_sys: &mut FlyerSystems, agents: &mut AgentStore, frame: &Frame) {
    let rows: Vec<usize> = agents.active_rows().collect();
    for r in rows {
        let d = &agents.data[r];
        if !d.kind.flies() || is_walking(d) || is_member(d) {
            continue;
        }
        let (Some(flight), Some(f)) = (d.flight.as_ref(), d.flyer.as_deref()) else { continue };
        let flyer = flight.effective();
        let position = agents.position[r];
        let loaded = agents.chunk[r].entry >= 0;

        // Motion easing (NavVolumeMotionJob): skipped for types that don't ease.
        if flyer.motion.ease != NavEase::Constant {
            let path = f.path;
            let goal = motion::journey_goal(path.goal, d.chunk_route.as_deref().map(|c| &c.route), d.route.as_deref().map(|x| &x.route));
            let phase = motion::phase_of(path.state, path.next_index, path.count, loaded, path.goal, goal, flyer.arrival_distance + 0.5);
            let mut state = agents.motion[r];
            if motion::start(&mut state, &flyer.motion, phase, frame.dt) {
                let speed = flight.speed();
                let stop = motion::stop_distance(&flyer.motion, speed);
                let near = stop + flyer.arrival_distance + flyer.max_snap_distance;
                if position.distance_sq(goal) < near * near {
                    let count = (path.count.max(0) as usize).min(f.points.len());
                    let mut remaining = position.distance(path.next);
                    let mut p = path.next_index.max(0) as usize + 1;
                    while p < count && remaining < near {
                        remaining += f.points[p - 1].distance(f.points[p]);
                        p += 1;
                    }
                    if path.goal.distance_sq(goal) > 1e-4 && count > 0 {
                        remaining += f.points[count - 1].distance(goal);
                    }
                    motion::apply_stop(&mut state, &flyer.motion, speed, remaining - flyer.arrival_distance);
                }
            }
            agents.motion[r] = state;
        }

        // Follow steering.
        let scale = agents.motion[r].scale;
        let d = &mut agents.data[r];
        let f = d.flyer.as_deref_mut().expect("checked above");
        let mut steer = false;
        let mut want = Float3::default();
        if flyer.separation_strength > 0.0 && loaded {
            let flying = f.path.state == NavPathState::Following || f.path.state == NavPathState::Partial;
            if flying && advance(&mut f.path, &f.points, &flyer, position) {
                want = toward(&f.path, &flyer, scale, f.points.len(), position, frame.dt);
            }
            steer = flying || f.path.state == NavPathState::Arrived; // arrived or at a Partial path's end: hover
        }
        agents.desired[r] = want;
        let was = agents.steering[r];
        if steer && was {
            continue; // still steering: `steered` is last tick's, which neighbours read
        }
        agents.steering[r] = steer;
        agents.steered[r] = want; // just started: steer as it wants until separation runs; stopped: zero
    }
}

/// `NavVolumeMoveSystem`: the steered flyers by `agents.steered` (`NavVolumeSteeredMoveJob`), the rest along their path
/// (`NavVolumeMoveJob`).
pub fn move_agents(_sys: &mut FlyerSystems, agents: &mut AgentStore, frame: &Frame) {
    let rows: Vec<usize> = agents.active_rows().collect();
    let dt = frame.dt;
    for r in rows {
        let d = &agents.data[r];
        if !d.kind.flies() || is_walking(d) || is_member(d) {
            continue;
        }
        let Some(flight) = d.flight.as_ref() else { continue };
        let Some(f) = d.flyer.as_deref() else { continue };
        let flyer = flight.effective();
        let entry = agents.chunk[r].entry;
        if entry < 0 {
            agents.velocity[r] = Float3::default(); // its chunk isn't loaded: paused
            continue;
        }
        let before = agents.position[r];
        let mut position = before;
        let mut rotation = agents.rotation[r];
        if crate::groups::flight::fly_home(&frame.world.snapshot().entries, entry, &mut position, &mut rotation, flyer.speed, flyer.turn_speed, dt) {
            agents.position[r] = position;
            agents.rotation[r] = rotation;
            agents.velocity[r] = if dt > 0.0 { (position - before) / dt } else { Float3::default() };
            continue;
        }

        if agents.steering[r] {
            // NavVolumeSteeredMoveJob: by the steered velocity, or if that would leave free space, the desired one.
            let desired = agents.desired[r];
            let mut velocity = agents.steered[r];
            let mut next = position + velocity * dt;
            let differs = velocity.x != desired.x || velocity.y != desired.y || velocity.z != desired.z;
            if differs {
                if let Some(v) = volume_by_key(frame, entry, f.path.volume) {
                    if volume::leaf_at(&v, next) < 0 {
                        velocity = desired;
                        next = position + velocity * dt;
                    }
                }
            }
            position = next;
            let speed = velocity.length();
            if speed > 0.1 * flight.speed() {
                face(&mut rotation, velocity / speed, flight.turn_speed(), dt);
            }
        } else {
            // NavVolumeMoveJob.
            let mut path = f.path;
            let moving = path.state == NavPathState::Following || path.state == NavPathState::Partial;
            if moving && advance(&mut path, &f.points, &flyer, position) {
                let to_next = path.next - position;
                let dist = to_next.length();
                let step = flyer.speed * agents.motion[r].scale * dt;
                position = if dist <= step { path.next } else { position + to_next * (step / dist) };
                if dist > 1e-4 {
                    face(&mut rotation, to_next / dist, flyer.turn_speed, dt);
                }
            }
            if moving {
                agents.data[r].flyer.as_deref_mut().expect("flyer").path = path;
            }
        }
        agents.position[r] = position;
        agents.rotation[r] = rotation;
        agents.velocity[r] = if dt > 0.0 { (position - before) / dt } else { Float3::default() };
    }
}
