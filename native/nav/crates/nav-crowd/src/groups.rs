//! Groups: formations and flocks, member steering, pace, joining and merging, walk-and-fly members
//! (`NavGroupSystems.cs`, `NavGroupMergeSystem.cs`, `Systems/Jobs/NavGroupJobs.cs`, `NavGroupMergeJobs.cs`; the slot
//! layout is [`crate::formations`]).
//!
//! A group body is an agent ([`crate::agents::AgentData::group`] set): a virtual walker, flyer or walk-fly agent of
//! its members' type with no avoidance, which the path, chase, route and move steps plan for and move like any agent
//! (its position, a walker's surface position, is the pivot). Members are agents with `NavGroupMember` on (`JoinGroup` /
//! `LeaveGroup` commands); the individual path steps skip them and they steer to their slot instead, through
//! avoidance and the movers like any steering agent.
//!
//! The steps, in tick order (Foxfire's parallel per-entity jobs are loops over rows, ascending):
//!
//! * [`walk_fly_members`] (`NavGroupWalkFlyMemberJob`, right after routes): walk-fly members take off and land with
//!   their group body.
//! * [`member_steering`] (`NavGroupMemberSteeringJob` then `NavGroupJoinJob`, after following and flight steering):
//!   each member's `agents.desired` towards its slot (or its surround slot), `agents.steering` on; members more than
//!   `slack` off their slot walk or fly back by a path of their own (`NavGroupWalk` / `NavGroupFlight` `Rejoin`); new
//!   members (slot -1) are taken in.
//! * [`pace`] (`NavGroupPaceJob`, `NavGroupFlyerPaceJob`, `NavGroupWalkFlyPaceJob`, after both movers): compact the
//!   member list, turn in place ([`crate::formations::turn`]), heading and velocity, the trail, swap slots
//!   ([`swap`]), squeeze ([`squeeze`]), and the body's speed override (slowest member, `slack`, `min_pace`).
//! * [`merge`] (`NavGroupMergeSystem`, after pace): every [`MERGE_INTERVAL`], joiners join and touching groups going to
//!   the same place merge; merged bodies are disabled at the start of the next tick's merge step.
//!
//! * [`move_members`] (`NavGroupMemberMoveJob`, `NavGroupFlyerMoveJob`, which Foxfire schedules inside
//!   `NavAgentMoveSystem` / `NavVolumeMoveSystem` after the steered moves): members move by `agents.steered`. The
//!   tick (`lib.rs`, step 13) calls it right after `walkers::move_agents` / `flyers::move_agents` (both skip members).
//!
//! # Interactions
//!
//! Members' `desired`/`steering` are consumed by avoidance (`avoidance.rs`); bodies are planned, followed and moved by
//! the walker, flyer and route steps (their `speed_override` is what [`pace`] writes). Shared helpers come from those
//! modules: `walkers::follow_path` (`NavMeshPathFollowJob.Follow`), `walkers::move_along_surface`,
//! `walkers::look_rotation_safe` / `slerp` / `place` (`NavMeshMoveJob.Place`), `flyers::advance` / `face` and
//! `routes::transition`.
use crate::agents::{AgentKind, AgentStore};
use crate::components::*;
use crate::filters::walk_filter;
use crate::formations::{self, trail, turn};
use crate::ids::{AgentId, TargetRef};
use crate::surround_slots;
use crate::tick::Frame;
use crate::world::Targets;
use nav_format::blob::NavFormationData;
use nav_format::{NavMeshData, NavVolumeData};
use nav_math::math;
use nav_math::{Float2, Float3, Hash128};
use nav_query::chunks::{ChunkEntry, NavChunks};
use nav_query::filter::NavMeshQueryFilter;
use nav_query::pathfinding::{find_nearest_poly, find_nearest_poly_sided};
use nav_query::volume::{leaf_at, segment_clear, snap_to_free};
use std::collections::BTreeMap;
use std::sync::Arc;

/// `NavGroupMergeSystem.Interval`: seconds between merge passes.
pub const MERGE_INTERVAL: f64 = 0.5;
/// `NavGroupPaceJob.Headroom`: the body moves at this share of its slowest member's speed.
pub const HEADROOM: f32 = 0.85;
/// `NavGroupFlight.RejoinInterval`: seconds between a member's path requests back to its slot.
pub const REJOIN_INTERVAL: f32 = 1.0;

const UP: Float3 = Float3::new(0.0, 1.0, 0.0);

/// The group steps' state between ticks.
#[derive(Clone, Debug, Default)]
pub struct GroupSystems {
    /// When the next merge pass runs.
    pub next_merge: f64,
    /// `_merged`: groups merged at the last pass (group, into), disabled at the start of the next merge step.
    pub merged: Vec<(AgentId, AgentId)>,
    /// `NavGroupJoin`s queued by member steering this tick (member, group).
    joins: Vec<(AgentId, AgentId)>,
}

// =====================================================================================================================
// Shared helpers
// =====================================================================================================================

fn mask_of(agents: &AgentStore, g: usize) -> Option<Arc<NavFormationData>> {
    agents.data[g].group.as_deref().and_then(|x| x.formation.clone())
}

fn entry_of(entries: &[ChunkEntry], entry: i32) -> Option<&ChunkEntry> {
    (entry >= 0).then(|| entries.get(entry as usize)).flatten()
}

fn surrounding(agents: &AgentStore, r: usize) -> bool {
    agents.data[r].surround_slot.is_some_and(|s| s.enabled)
}

fn in_box_xz(e: &ChunkEntry, p: Float3) -> bool {
    p.x >= e.bounds_min.x && p.x <= e.bounds_max.x && p.z >= e.bounds_min.z && p.z <= e.bounds_max.z
}

// =====================================================================================================================
// NavGroupFlight
// =====================================================================================================================

/// Flying members (`NavGroupFlight`): where they aim, how they find their way back, which of them the pace waits for.
pub mod flight {
    use super::*;

    /// `BoxHolding`: the entry of a loaded bounded chunk of `agent_type` whose box holds p (x and z), or -1.
    pub fn box_holding(entries: &[ChunkEntry], agent_type: Hash128, p: Float3) -> i32 {
        for (i, e) in entries.iter().enumerate() {
            if e.agent_type != agent_type || e.overlay || !e.bounded {
                continue;
            }
            if in_box_xz(e, p) {
                return i as i32;
            }
        }
        -1
    }

    /// `Home`: Some(home) if the flyer at p is outside every loaded chunk box of its type, home the nearest point a
    /// metre inside its own chunk's box. None inside a loaded box, or if its chunk has no box.
    pub fn home(entries: &[ChunkEntry], own: i32, p: Float3) -> Option<Float3> {
        let e = entry_of(entries, own)?;
        if !e.bounded || box_holding(entries, e.agent_type, p) >= 0 {
            return None;
        }
        let inset = math::min(1.0, 0.5 * (e.bounds_max - e.bounds_min).cmin());
        Some(p.clamp(e.bounds_min + Float3::splat(inset), e.bounds_max - Float3::splat(inset)))
    }

    /// `FlyHome`: if the flyer is outside every loaded chunk box of its type ([`home`]), moves it at `speed` toward
    /// home, facing it, and returns true; false (nothing done) in loaded space.
    pub fn fly_home(entries: &[ChunkEntry], own: i32, position: &mut Float3, rotation: &mut nav_math::Float4, speed: f32, turn_speed: f32, dt: f32) -> bool {
        let Some(home) = home(entries, own, *position) else { return false };
        let to = home - *position;
        let distance = to.length();
        if distance >= 1e-4 {
            let step = speed * dt;
            *position = if distance <= step { home } else { *position + to * (step / distance) };
            crate::flyers::face(rotation, to / distance, turn_speed, dt);
        }
        true
    }

    /// `VolumeEntryAt`: the entry whose flight volume has p in free space: own's, else (p past own's box) the bounded
    /// neighbour of the same agent type whose box holds p; -1 if neither.
    pub fn volume_entry_at(entries: &[ChunkEntry], own: i32, p: Float3) -> i32 {
        let Some(e) = entry_of(entries, own) else { return -1 };
        if e.volume.as_deref().is_some_and(|v| leaf_at(v, p) >= 0) {
            return own;
        }
        if !e.bounded || in_box_xz(e, p) {
            return -1;
        }
        for (i, n) in entries.iter().enumerate() {
            if i as i32 == own || n.overlay || !n.bounded || n.agent_type != e.agent_type {
                continue;
            }
            let Some(v) = n.volume.as_deref() else { continue };
            if !in_box_xz(n, p) {
                continue;
            }
            return if leaf_at(v, p) >= 0 { i as i32 } else { -1 };
        }
        -1
    }

    /// `Slot` (with chunks): the slot if it's in free space (own's volume or a neighbour's), else the free point of
    /// own's volume nearest it within spacing.
    pub fn slot_in(entries: &[ChunkEntry], own: i32, slot: Float3, spacing: f32) -> Float3 {
        if volume_entry_at(entries, own, slot) >= 0 {
            return slot;
        }
        slot_in_volume(entry_of(entries, own).and_then(|e| e.volume.as_deref()), slot, spacing)
    }

    /// `Slot` (volume): the slot, or the free point nearest it within spacing if it's in solid space.
    pub fn slot_in_volume(volume: Option<&NavVolumeData>, slot: Float3, spacing: f32) -> Float3 {
        let Some(v) = volume else { return slot };
        if leaf_at(v, slot) >= 0 {
            return slot;
        }
        let (leaf, free) = snap_to_free(v, slot, math::max(spacing, 1.0));
        if leaf >= 0 { free } else { slot }
    }

    /// `Behind`: how far a flying member is from its slot for the pace, or 0 if waiting for it wouldn't bring it
    /// closer.
    pub fn behind(entry: i32, path: Option<&FlyPath>, position: Float3, slot: Float3, spacing: f32, entries: &[ChunkEntry]) -> f32 {
        let Some(e) = entry_of(entries, entry) else { return slot.distance(position) };
        let Some(volume) = e.volume.as_deref() else { return slot.distance(position) };
        let slot = slot_in(entries, entry, slot, spacing);
        let slot_entry = volume_entry_at(entries, entry, slot);
        if slot_entry >= 0 && slot_entry != entry {
            return slot.distance(position); // across a chunk face: on its way
        }
        if let Some(path) = path {
            if path.state == NavPathState::Following {
                return slot.distance(position);
            }
            if matches!(path.state, NavPathState::Partial | NavPathState::Failed) {
                return 0.0;
            }
        }
        if segment_clear(volume, position, slot) { slot.distance(position) } else { 0.0 }
    }

    /// `Rejoin`: a flying member's flight back to its slot. Updates the path and asks for a new one through
    /// `request`/`requested`; Some(velocity along the path) while it follows one, None while it steers for its slot.
    #[allow(clippy::too_many_arguments)]
    pub fn rejoin(
        path: &mut FlyPath,
        points: &[Float3],
        request: &mut PathRequest,
        requested: &mut bool,
        flyer: &crate::settings::NavFlightAgent,
        volume: Option<&NavVolumeData>,
        searchable: bool,
        position: Float3,
        slot: Float3,
        slack: f32,
        time: f64,
        dt: f32,
    ) -> Option<Float3> {
        let distance = slot.distance(position);
        let mut following = matches!(path.state, NavPathState::Following | NavPathState::Partial);
        if (following || path.state == NavPathState::Arrived) && distance <= 0.5 * slack && volume.is_none_or(|v| segment_clear(v, position, slot)) {
            path.state = NavPathState::None; // back in its place
            following = false;
        }

        let due = time - path.computed_time >= REJOIN_INTERVAL as f64;
        if searchable && !*requested && due && distance > slack && (!following || path.goal.distance(slot) > slack) {
            *request = PathRequest { start: position, goal: slot, urgent: false, start_from_current_position: true };
            *requested = true;
        }

        if !following || !crate::flyers::advance(path, points, flyer, position) {
            return None;
        }
        let to_next = path.next - position;
        let dist = to_next.length();
        if dist < 1e-4 {
            return Some(Float3::default());
        }
        Some(to_next * (math::min(flyer.speed, dist / math::max(dt, 1e-5)) / dist))
    }
}

// =====================================================================================================================
// NavGroupWalk
// =====================================================================================================================

/// Walking members (`NavGroupWalk`): crossing chunk faces and overlays, walking back to their slot, the pace.
pub mod walk {
    use super::*;

    /// `OnNavmesh`: true if a path search on `nav` could place p (within `max_snap_distance` of a usable polygon).
    pub fn on_navmesh(nav: Option<&NavMeshData>, p: Float3, agent: &crate::settings::NavMeshAgent) -> bool {
        let Some(nav) = nav else { return false };
        let filter = walk_filter(agent, nav, &[]);
        find_nearest_poly(nav, p, agent.max_snap_distance, &filter).is_some()
    }

    /// `InBox`: p is inside the entry's box (x and z), or the entry has none.
    pub fn in_box(e: &ChunkEntry, p: Float3) -> bool {
        !e.bounded || in_box_xz(e, p)
    }

    /// `NeighbourEntry`: the bounded neighbour of own's agent type, with a navmesh, whose box holds p; -1 if none.
    pub fn neighbour_entry(entries: &[ChunkEntry], own: i32, p: Float3) -> i32 {
        let agent_type = entries[own as usize].agent_type;
        for (i, n) in entries.iter().enumerate() {
            if i as i32 == own || n.overlay || !n.bounded || n.nav.is_none() || n.agent_type != agent_type {
                continue;
            }
            if in_box(n, p) {
                return i as i32;
            }
        }
        -1
    }

    /// `OverlayEntry`: which of its chunk's navmeshes a walker at `entry` should be on for point p.
    pub fn overlay_entry(snapshot: &NavChunks, entry: i32, p: Float3, snap: f32) -> i32 {
        let entries = &snapshot.entries;
        let e = &entries[entry as usize];
        let own = if e.overlay { snapshot.find(e.chunk, e.agent_type, false).map_or(-1, |x| x as i32) } else { entry };
        if own < 0 || entries[own as usize].switched_off_count == 0 {
            return entry;
        }
        let Some(own_nav) = entries[own as usize].nav.as_deref() else { return entry };
        let overlay = if e.overlay { entry } else { snapshot.find(e.chunk, e.agent_type, true).map_or(-1, |x| x as i32) };
        if overlay < 0 {
            return entry;
        }
        let mut filter = NavMeshQueryFilter::zeroed();
        filter.allowed_bins = u64::MAX; // switched off or not: which polygon is it?
        let Some((poly, _)) = find_nearest_poly(own_nav, p, snap, &filter) else { return entry };
        if snapshot.switched_off[entries[own as usize].switched_off_start + poly as usize] { overlay } else { own }
    }

    /// `Behind`: how far a walking member is behind its slot for the pace: `gap`, or 0 if its path back can't get
    /// there.
    pub fn behind(path: Option<&NavPath>, gap: f32) -> f32 {
        if path.is_some_and(|p| matches!(p.state, NavPathState::Partial | NavPathState::Failed)) {
            return 0.0;
        }
        gap
    }

    /// `Rejoin`: a walking member's way back to its slot. Some(velocity along the path, in its surface plane) while it
    /// follows one, None while it steers for its slot.
    #[allow(clippy::too_many_arguments)]
    pub fn rejoin(
        w: &mut crate::agents::WalkerData,
        request: &mut PathRequest,
        requested: &mut bool,
        config: &NavMeshAgentConfig,
        surface: &NavMeshAgentSurface,
        searchable: bool,
        nav: Option<&NavMeshData>,
        slot: Float3,
        slack: f32,
        time: f64,
        dt: f32,
    ) -> Option<Float3> {
        let position = surface.surface_position;
        let distance = slot.distance(position);
        let path = &mut w.path;
        let mut following = matches!(path.state, NavPathState::Following | NavPathState::Partial);
        if (following || path.state == NavPathState::Arrived) && distance <= 0.5 * slack {
            path.state = NavPathState::None; // back in its place
            following = false;
        }

        // A path that failed for this slot fails again until the slot moves on.
        let due = time - path.computed_time >= REJOIN_INTERVAL as f64;
        let failed_here = path.state == NavPathState::Failed && path.goal.distance(slot) <= slack;
        if searchable
            && !*requested
            && due
            && distance > slack
            && !failed_here
            && (!following || path.goal.distance(slot) > slack)
            && on_navmesh(nav, slot, &config.settings)
        {
            *request = PathRequest { start: position, goal: slot, urgent: false, start_from_current_position: true };
            *requested = true;
        }

        if !following {
            return None;
        }
        crate::walkers::follow_path(&mut w.path, &mut w.progress, &w.elements, &config.settings, surface, dt);
        let path = &mut w.path;
        if !matches!(path.state, NavPathState::Following | NavPathState::Partial) {
            return None;
        }

        // At the end of a path that stops short: drop it and steer straight for the slot.
        if path.state == NavPathState::Partial && path.next_index >= path.count {
            path.state = NavPathState::None;
            return None;
        }

        // Aim a little way along the segment rather than at its end.
        let up = surface.up.normalize_safe(UP);
        let segment = path.next - path.prev;
        let length2 = segment.length_sq();
        let mut aim = path.next;
        if length2 > 1e-4 {
            let lookahead = math::max(1.0, 2.0 * config.settings.radius) / length2.sqrt();
            aim = path.prev + segment * math::saturate((position - path.prev).dot(segment) / length2 + lookahead);
        }

        let mut to_next = aim - position;
        to_next = to_next - up * to_next.dot(up);
        let dist = to_next.length();
        if dist < 1e-4 {
            return Some(Float3::default());
        }
        Some(to_next * (math::min(config.speed(), dist / math::max(dt, 1e-5)) / dist))
    }
}

// =====================================================================================================================
// NavGroupFlock
// =====================================================================================================================

/// `NavGroupFlock.Spread`: a flocking member's push away from members of its group closer than spacing (separation)
/// and drift toward the middle of those within twice spacing (cohesion). Measured across `up` (walkers) or in 3D.
pub fn flock_spread(group: &NavGroup, self_row: usize, position: Float3, up: Float3, speed: f32, members: &[AgentId], agents: &AgentStore) -> Float3 {
    let spacing = math::max(group.spacing, 0.1);
    let mut separation = Float3::default();
    let mut centre = Float3::default();
    let mut near = 0;
    for &other in members {
        let Some(o) = agents.row(other) else { continue };
        if o == self_row {
            continue;
        }
        let mut away = position - agents.position[o];
        away = away - up * away.dot(up);
        let d2 = away.length_sq();
        if d2 > 4.0 * spacing * spacing {
            continue;
        }
        centre += -away; // toward it, relative to this member
        near += 1;
        if d2 >= spacing * spacing {
            continue;
        }
        let d = d2.sqrt();
        // Exactly on top of each other: apart along the member's index order, so the two go different ways.
        let sign = if self_row < o { 1.0 } else { -1.0 };
        let dir = if d > 1e-4 { away / d } else { (up.cross(UP) * sign).normalize_safe(Float3::new(sign, 0.0, 0.0)) };
        separation += dir * (1.0 - d / spacing);
    }
    let mut spread = separation * (group.flock_separation * speed);
    if near > 0 {
        spread += centre / near as f32 * group.flock_cohesion;
    }
    spread
}

// =====================================================================================================================
// NavGroupWalkFlyMemberJob
// =====================================================================================================================

/// `NavGroupWalkFlyMemberSystem` + `NavGroupWalkFlyMemberJob`: walk-fly members take off when their body leaves the
/// ground and land when it lands (both mode flags on meanwhile, and only this step moves them, at the take-off speed).
pub fn walk_fly_members(_sys: &mut GroupSystems, agents: &mut AgentStore, frame: &Frame) {
    let entries = &frame.world.snapshot().entries;
    for r in agents.active_rows().collect::<Vec<_>>() {
        let d = &agents.data[r];
        let Some(member) = d.group_member.filter(|m| m.enabled) else { continue };
        if d.kind != AgentKind::WalkFly || d.route.is_none() {
            continue;
        }
        let entry = agents.chunk[r].entry;
        if member.slot < 0 || entry_of(entries, entry).is_none() {
            continue; // not in yet, or paused
        }
        let Some(g) = agents.row(member.group) else { continue };
        let (Some(group), Some(body_route)) = (agents.data[g].group.as_deref().map(|x| x.group), agents.data[g].route.as_deref().map(|x| x.route)) else {
            continue; // gone, or not a walk-and-fly group
        };
        let mask = mask_of(agents, g);
        let flyer = agents.data[r].flight.as_ref().unwrap().effective();
        let mesh = agents.data[r].walk.as_ref().unwrap().settings.clone();
        let offset = formations::rotate(formations::offset(&group, mask.as_deref(), member.slot, group.count), group.forward);
        let mut position = agents.position[r];
        let mut route = agents.data[r].route.as_deref().unwrap().route;
        let e = &entries[entry as usize];

        if matches!(route.mode, NavMotionMode::TakingOff | NavMotionMode::Landing) {
            let mut rotation = agents.rotation[r];
            let done = crate::routes::transition(&mut position, &mut rotation, route.transition_to, route.transition_up, &flyer, frame.dt);
            agents.rotation[r] = rotation;
            if !done {
                agents.position[r] = position;
                continue;
            }
            let landed = route.mode == NavMotionMode::Landing;
            if landed {
                // Down on the ground: the mover continues from the landing point, on its surface.
                agents.surface[r] = NavMeshAgentSurface { surface_position: position - route.transition_up * mesh.pivot_offset, up: route.transition_up, initialized: true };
                if let Some(w) = agents.data[r].walker.as_deref_mut() {
                    w.avoidance_state = NavAvoidanceState { poly: -1 };
                }
            }
            route.mode = if landed { NavMotionMode::Walking } else { NavMotionMode::Flying };
            let rd = agents.data[r].route.as_deref_mut().unwrap();
            rd.walking = landed;
            rd.flying = !landed;
        } else if route.mode == NavMotionMode::Walking {
            // Only a body leaving the ground lifts it: one still landing has members already down.
            if body_route.mode != NavMotionMode::TakingOff && body_route.mode != NavMotionMode::Flying {
                continue;
            }
            let air = if body_route.mode == NavMotionMode::TakingOff { body_route.transition_to } else { agents.position[g] };
            route.transition_to = air_point(e.volume.as_deref(), air, offset, position);
            route.transition_up = UP;
            start_transition(agents, r, &mut route, NavMotionMode::TakingOff);
        } else {
            if body_route.mode != NavMotionMode::Walking && body_route.mode != NavMotionMode::Landing {
                continue;
            }
            let (mut ground, up) = if body_route.mode == NavMotionMode::Landing {
                let up = body_route.transition_up;
                let body_pivot = agents.data[g].walk.as_ref().map_or(0.0, |w| w.settings.pivot_offset);
                (body_route.transition_to - up * body_pivot, up)
            } else {
                let s = agents.surface[g];
                (s.surface_position, s.up.normalize_safe(UP))
            };
            if let Some(nav) = e.nav.as_deref() {
                let mut filter = NavMeshQueryFilter::zeroed();
                filter.allowed_bins = u64::MAX;
                let reach = math::max(group.spacing, math::max(mesh.max_snap_distance, mesh.step_height));
                if let Some((_, nearest)) = find_nearest_poly_sided(nav, ground + offset, reach, &filter, up, f32::INFINITY) {
                    ground = nearest;
                }
            }
            route.transition_to = ground + up * mesh.pivot_offset;
            route.transition_up = up;
            start_transition(agents, r, &mut route, NavMotionMode::Landing);
        }

        agents.data[r].route.as_deref_mut().unwrap().route = route;
        agents.position[r] = position;
    }
}

/// `Start`: a takeoff or landing: both mode flags on; any legs left from before it joined are dropped.
fn start_transition(agents: &mut AgentStore, r: usize, route: &mut NavRoute, mode: NavMotionMode) {
    let rd = agents.data[r].route.as_deref_mut().unwrap();
    rd.legs.clear();
    route.leg = 0;
    route.state = NavRouteState::None;
    route.mode = mode;
    rd.walking = true;
    rd.flying = true;
}

/// `AirPoint`: where a member takes off to: its slot at the body's air point if free, else straight above it at that
/// height, else the air point itself.
pub fn air_point(volume: Option<&NavVolumeData>, air: Float3, offset: Float3, position: Float3) -> Float3 {
    let slot = air + offset;
    let Some(v) = volume else { return slot };
    if leaf_at(v, slot) >= 0 {
        return slot;
    }
    let above = Float3::new(position.x, air.y, position.z);
    if leaf_at(v, above) >= 0 { above } else { air }
}

// =====================================================================================================================
// NavGroupMemberSteeringJob + NavGroupJoinJob
// =====================================================================================================================

/// What member steering reads about a group body (copied once per tick: bodies aren't written while members steer).
struct GroupView {
    group: NavGroup,
    trail: Vec<Float3>,
    mask: Option<Arc<NavFormationData>>,
    members: Vec<AgentId>,
    walks: bool,
    /// Walker and flyer bodies keep a trail (`NavGroupTrailPoint`); walk-and-fly bodies have none.
    has_trail: bool,
    surface: NavMeshAgentSurface,
    position: Float3,
}

fn group_views(agents: &AgentStore) -> BTreeMap<usize, GroupView> {
    let mut views = BTreeMap::new();
    for g in agents.live_rows() {
        let d = &agents.data[g];
        let Some(gd) = d.group.as_deref() else { continue };
        views.insert(
            g,
            GroupView {
                group: gd.group,
                trail: gd.trail.clone(),
                mask: gd.formation.clone(),
                members: gd.members.clone(),
                walks: d.kind.walks(),
                has_trail: d.kind != AgentKind::WalkFly,
                surface: agents.surface[g],
                position: agents.position[g],
            },
        );
    }
    views
}

/// `NavGroupMemberSteeringSystem`: `NavGroupMemberSteeringJob` over members (on), then `NavGroupJoinJob`.
pub fn member_steering(sys: &mut GroupSystems, agents: &mut AgentStore, targets: &Targets, frame: &Frame) {
    let snapshot = frame.world.snapshot();
    let entries = &snapshot.entries;
    let views = group_views(agents);
    sys.joins.clear();

    for r in agents.active_rows().collect::<Vec<_>>() {
        let Some(member) = agents.data[r].group_member.filter(|m| m.enabled) else { continue };
        let kind = agents.data[r].kind;
        if !kind.walks() && !kind.flies() {
            continue;
        }
        let view = agents.row(member.group).and_then(|g| views.get(&g));
        let Some(view) = view else {
            // Its group is gone: on its own again.
            let d = &mut agents.data[r];
            if let Some(m) = d.group_member.as_mut() {
                m.enabled = false;
            }
            d.path_request_enabled = false; // a way back to its slot: no longer wanted
            agents.steering[r] = false;
            agents.desired[r] = Float3::default();
            agents.steered[r] = Float3::default();
            continue;
        };
        let group = view.group;

        let mut walkers = kind.walks();
        let mut lifting = false; // taking off or landing
        if kind == AgentKind::WalkFly {
            let rd = agents.data[r].route.as_deref();
            walkers = rd.is_some_and(|x| x.walking);
            lifting = walkers && rd.is_some_and(|x| x.flying);
        }

        let position = if walkers && !lifting { agents.surface[r].surface_position } else { agents.position[r] };
        let mut entry = agents.chunk[r].entry;
        if let Some(b) = entry_of(entries, entry).filter(|b| b.bounded) {
            // Only into a loaded box: outside every one it keeps its chunk.
            if !in_box_xz(b, position) && flight::box_holding(entries, b.agent_type, position) >= 0 {
                agents.chunk[r] = NavAgentChunk { chunk: Hash128::default(), entry: -1 }; // placed by its position next tick
                agents.chunk_pending[r] = true;
            }
        }

        // A walker group made this tick isn't on the navmesh yet: stand.
        let (pivot, placed) = if walkers && view.walks {
            (view.surface.surface_position, view.surface.initialized)
        } else if !walkers {
            (view.position, true)
        } else {
            (Float3::default(), false)
        };

        let mut want = Float3::default();
        if lifting {
            // walk_fly_members moves it.
        } else if member.slot < 0 {
            sys.joins.push((agents.id_of(r).unwrap(), member.group));
        } else if placed {
            let level = if walkers { agents.surface[r].up.normalize_safe(UP) } else { Float3::default() };
            let has_trail = view.has_trail;
            let mask = view.mask.as_deref();
            let trail_pts = &view.trail[..];
            let mut slot = formations::target_on_trail(&group, mask, pivot, member.slot, group.count, position, level, trail_pts, has_trail);

            // Arrived at a surround target: its surround slot instead, which moves with the target.
            let mut surrounding = false;
            if let Some(ss) = agents.data[r].surround_slot.filter(|s| s.enabled) {
                if let TargetRef::Target(id) = ss.target {
                    if let Some((surround, at)) = targets.get(id).and_then(|t| t.surround.map(|s| (s, t.position))) {
                        slot = at + surround_slots::offset(&surround, ss.air, ss.index as i32);
                        surrounding = true;
                    }
                }
            }

            if !walkers && entry_of(entries, entry).is_some() {
                slot = flight::slot_in(entries, entry, slot, group.spacing);
            }

            // A flocking flyer out of sight of the pivot (beyond two spacings) aims for the pivot instead.
            if !walkers && !surrounding && group.mode == NavGroupMode::Flock {
                if let Some(v) = entry_of(entries, entry).and_then(|e| e.volume.as_deref()) {
                    if position.distance_sq(pivot) > 4.0 * group.spacing * group.spacing && !segment_clear(v, position, pivot) {
                        slot = pivot;
                    }
                }
            }
            let mut gap = slot - position;
            let mut velocity = if surrounding { Float3::default() } else { group.velocity };
            if walkers {
                let up = agents.surface[r].up.normalize_safe(UP); // walkers: in their surface plane
                gap = gap - up * gap.dot(up);
                velocity = velocity - up * velocity.dot(up);
            }

            // Ahead of its place in a column that's lining up: it steps into the line where it is.
            let (waiting, in_line) = if surrounding {
                (false, position)
            } else {
                trail::waits_place(&group, mask, member.slot, group.count, pivot, position, gap, level, trail_pts, has_trail)
            };
            if waiting {
                gap = in_line - position;
                if walkers {
                    gap = gap - level * gap.dot(level);
                }
                velocity = Float3::default();
            }

            let mut pathing = false;
            let in_chunk = entry_of(entries, entry).is_some();
            let has_walker = agents.data[r].walker.is_some();
            let has_flyer = agents.data[r].flyer.is_some();

            // A walk-and-fly member's way back in the other mode is over.
            if has_flyer && walkers && agents.data[r].flyer.as_deref().unwrap().path.state != NavPathState::None {
                agents.data[r].flyer.as_deref_mut().unwrap().path.state = NavPathState::None;
            } else if has_walker && !walkers && agents.data[r].walker.as_deref().unwrap().path.state != NavPathState::None {
                agents.data[r].walker.as_deref_mut().unwrap().path.state = NavPathState::None;
            }

            if walkers && in_chunk && !walk::in_box(&entries[entry as usize], slot) {
                // Its slot is past its chunk's box: once a step ahead is too, onto the neighbour's navmesh.
                let mesh = agents.data[r].walk.as_ref().unwrap().settings.clone();
                let ahead = position + gap.normalize_safe(Float3::default()) * math::max(2.0 * mesh.radius, mesh.arrival_distance);
                let next = if walk::in_box(&entries[entry as usize], ahead) { -1 } else { walk::neighbour_entry(entries, entry, ahead) };
                if next >= 0 {
                    switch_entry(agents, r, entries, next);
                    entry = next;
                }
            }

            if walkers && in_chunk && entry_of(entries, entry).is_some() {
                // An overlay patch: onto the chunk's overlay where the step ahead is on a polygon it replaced.
                let mesh = agents.data[r].walk.as_ref().unwrap().settings.clone();
                let ahead = position + gap.normalize_safe(Float3::default()) * math::max(2.0 * mesh.radius, mesh.arrival_distance);
                let next = walk::overlay_entry(snapshot, entry, ahead, math::max(mesh.max_snap_distance, mesh.step_height));
                if next != entry {
                    switch_entry(agents, r, entries, next);
                    entry = next;
                }
            }

            if walkers && has_walker && in_chunk && !waiting {
                let surface = agents.surface[r];
                let nav = entry_of(entries, entry).and_then(|e| e.nav.clone());
                let searchable = entry_of(entries, entry).is_some_and(|e| walk::in_box(e, slot));
                let d = &mut agents.data[r];
                let config = d.walk.clone().unwrap();
                let mut requested = d.path_request_enabled;
                let asked = requested;
                let mut request = d.path_request;
                let w = d.walker.as_deref_mut().unwrap();
                let v = walk::rejoin(w, &mut request, &mut requested, &config, &surface, searchable, nav.as_deref(), slot, group.slack, frame.time, frame.dt);
                if let Some(v) = v {
                    want = v;
                    pathing = true;
                }
                if requested && !asked {
                    d.path_request = request;
                    d.path_request_enabled = true;
                }
            } else if !walkers && has_flyer && in_chunk && !waiting {
                let volume = entry_of(entries, entry).and_then(|e| e.volume.clone());
                let searchable = flight::volume_entry_at(entries, entry, slot) == entry;
                let d = &mut agents.data[r];
                let flyer = d.flight.as_ref().unwrap().effective();
                let mut requested = d.path_request_enabled;
                let asked = requested;
                let mut request = d.path_request;
                let f = d.flyer.as_deref_mut().unwrap();
                let v = flight::rejoin(&mut f.path, &f.points, &mut request, &mut requested, &flyer, volume.as_deref(), searchable, position, slot, group.slack, frame.time, frame.dt);
                if let Some(v) = v {
                    want = v;
                    pathing = true;
                }
                if requested && !asked {
                    d.path_request = request;
                    d.path_request_enabled = true;
                }
            }

            let flock = group.mode == NavGroupMode::Flock && !surrounding;
            if !pathing && (flock || gap.length_sq() > 0.0025 || velocity.length_sq() > 0.0025) {
                let d = &agents.data[r];
                let speed = if walkers { d.walk.as_ref().unwrap().speed() } else { d.flight.as_ref().unwrap().speed() };
                want = velocity + gap * group.catch_up;
                if flock {
                    want = velocity * group.flock_alignment + gap * group.catch_up + flock_spread(&group, r, agents.position[r], level, speed, &view.members, agents);
                    if walkers {
                        want = want - level * want.dot(level);
                    }
                    if want.length_sq() < 0.01 {
                        want = Float3::default(); // settled: no creeping about
                    }
                }
                let length = want.length();
                if length > speed {
                    want *= speed / length;
                }
            }
        }

        agents.desired[r] = want;
        if agents.steering[r] {
            continue; // steered is last tick's, which neighbours read
        }
        agents.steering[r] = true;
        agents.steered[r] = want; // just started: as it wants until avoidance runs
    }

    // NavGroupJoinJob: in a fixed order (group, then member).
    let mut joins = std::mem::take(&mut sys.joins);
    joins.sort_by(|a, b| a.1.index().cmp(&b.1.index()).then(a.0.index().cmp(&b.0.index())));
    for &(member, group) in &joins {
        let (Some(m), Some(g)) = (agents.row(member), agents.row(group)) else { continue };
        let Some(gd) = agents.data[g].group.as_deref_mut() else { continue };
        let slot = gd.members.len() as i32;
        gd.members.push(member);
        if let Some(mm) = agents.data[m].group_member.as_mut() {
            mm.group = group;
            mm.slot = slot;
        }
    }
    sys.joins = joins;
}

/// A member moved onto another snapshot entry: its avoidance polygon is found again, a path on the navmesh it left is
/// dropped.
fn switch_entry(agents: &mut AgentStore, r: usize, entries: &[ChunkEntry], next: i32) {
    agents.chunk[r] = NavAgentChunk { chunk: entries[next as usize].chunk, entry: next };
    if let Some(w) = agents.data[r].walker.as_deref_mut() {
        w.avoidance_state = NavAvoidanceState { poly: -1 };
        if w.path.state != NavPathState::None {
            w.path.state = NavPathState::None;
        }
    }
}

// =====================================================================================================================
// NavGroupSwap
// =====================================================================================================================

/// Slot swapping (`NavGroupSwap`): a few times a second each group in formation mode lets pairs of members trade
/// slots when that brings them closer to their slots, by more than a tenth of a spacing squared. A column instead
/// takes its members in order along it ([`swap::pass`]'s `InOrder`).
pub mod swap {
    use super::*;

    pub const INTERVAL: f32 = 0.25;
    /// At most this many passes over the members per measure.
    pub const PASSES: i32 = 3;

    /// `Due`: formation mode, two members or more, `swap_slots` on, the interval since last time.
    pub fn due(group: &mut NavGroup, members: i32, time: f64) -> bool {
        if !group.swap_slots || members < 2 || group.mode == NavGroupMode::Flock || time < group.next_swap {
            return false;
        }
        group.next_swap = time + INTERVAL as f64;
        true
    }

    fn is_nan3(p: Float3) -> bool {
        p.x.is_nan() || p.y.is_nan() || p.z.is_nan()
    }

    fn distance(a: Float3, b: Float3, up: Float3) -> f32 {
        let d = b - a;
        let d = d - up * d.dot(up);
        d.length_sq()
    }

    /// `Pass`: trades over the group's first `kept` members. `positions[i]` is slot i's member's position, NaN for
    /// one that keeps its slot. Rewrites `buffer` (the slots are given back by the caller: `reslot`); returns the
    /// number of trades.
    #[allow(clippy::too_many_arguments)]
    pub fn pass(buffer: &mut [AgentId], group: &NavGroup, mask: Option<&NavFormationData>, kept: i32, pivot: Float3, positions: &mut [Float3], up: Float3, trail_pts: &[Float3], has_trail: bool) -> i32 {
        let slots: Vec<Float3> = (0..kept).map(|i| formations::slot_on_trail(group, mask, pivot, i, kept, trail_pts, has_trail)).collect();
        let margin = 0.1 * group.spacing * group.spacing;
        let mut trades = 0;
        if in_order(buffer, group, kept, pivot, positions, up, &slots, margin, trail_pts, has_trail, &mut trades) {
            return trades;
        }

        // Each member trades with whoever it gains most with; passes repeat while any trade is made, up to PASSES.
        let kept = kept as usize;
        for _ in 0..PASSES {
            let mut traded = false;
            for i in 0..kept {
                if is_nan3(positions[i]) {
                    continue;
                }
                let mut best: i32 = -1;
                let mut best_gain = margin;
                for j in 0..kept {
                    if j == i || is_nan3(positions[j]) {
                        continue;
                    }
                    let gain = distance(positions[i], slots[i], up) + distance(positions[j], slots[j], up) - distance(positions[i], slots[j], up) - distance(positions[j], slots[i], up);
                    if gain <= best_gain {
                        continue;
                    }
                    best_gain = gain;
                    best = j as i32;
                }
                if best < 0 {
                    continue;
                }
                positions.swap(i, best as usize);
                buffer.swap(i, best as usize);
                trades += 1;
                traded = true;
            }
            if !traded {
                break;
            }
        }
        trades
    }

    /// `InOrder`: a column (one layer, nobody keeping its slot): members sorted by how far back along the column they
    /// stand, a row at a time, each row's members left to right onto its slots left to right, applied only when that
    /// brings them nearer their slots by more than `margin`. False if the group isn't such a column.
    #[allow(clippy::too_many_arguments)]
    fn in_order(
        buffer: &mut [AgentId],
        group: &NavGroup,
        kept: i32,
        pivot: Float3,
        positions: &mut [Float3],
        up: Float3,
        slots: &[Float3],
        margin: f32,
        trail_pts: &[Float3],
        has_trail: bool,
        trades: &mut i32,
    ) -> bool {
        if !trail::columnar(group) || group.layers.max(1) > 1 {
            return false;
        }
        let kept = kept as usize;
        if positions[..kept].iter().any(|&p| is_nan3(p)) {
            return false;
        }

        let bends = has_trail && trail::bends(group);
        let mut keys: Vec<f32> = (0..kept).map(|i| trail::back(trail_pts, bends, pivot, group.forward, positions[i], up)).collect();
        let mut order: Vec<usize> = (0..kept).collect();
        let by_key = |keys: &[f32], a: usize, b: usize| keys[a].partial_cmp(&keys[b]).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b));
        order.sort_by(|&a, &b| by_key(&keys, a, b));

        // Row by row: its members (the next ones along) left to right onto its slots left to right.
        let columns = if group.columns > 0 { group.columns as usize } else { 1 };
        let mut assigned = vec![0usize; kept]; // slot -> member (old slot)
        let mut side = vec![0.0f32; kept];
        let mut start = 0;
        while start < kept {
            let end = (start + columns).min(kept);
            let mut heading = group.forward;
            if bends {
                heading = trail::at(trail_pts, pivot, keys[order[start]], group.forward).1;
            }
            let right = Float3::new(heading.z, 0.0, -heading.x).normalize_safe(Float3::default());
            let mut row_slots: Vec<usize> = Vec::with_capacity(columns);
            let mut row_members: Vec<usize> = Vec::with_capacity(columns);
            for k in start..end {
                row_slots.push(k);
                row_members.push(order[k]);
                side[k] = (slots[k] - pivot).dot(right); // the slot's place across the row
            }
            for k in start..end {
                keys[order[k]] = (positions[order[k]] - pivot).dot(right); // reused: across the row
            }
            row_slots.sort_by(|&a, &b| by_key(&side, a, b));
            row_members.sort_by(|&a, &b| by_key(&keys, a, b));
            for j in 0..row_slots.len() {
                assigned[row_slots[j]] = row_members[j];
            }
            start += columns;
        }

        // Only if it helps (by more than margin).
        let (mut now, mut sorted) = (0.0f32, 0.0f32);
        for i in 0..kept {
            now += distance(positions[i], slots[i], up);
            sorted += distance(positions[assigned[i]], slots[i], up);
        }
        if sorted < now - margin {
            let entities: Vec<AgentId> = (0..kept).map(|i| buffer[assigned[i]]).collect();
            let moved: Vec<Float3> = (0..kept).map(|i| positions[assigned[i]]).collect();
            *trades += assigned[..kept].iter().enumerate().filter(|&(i, &a)| a != i).count() as i32;
            buffer[..kept].copy_from_slice(&entities);
            positions[..kept].copy_from_slice(&moved);
        }
        true
    }
}

/// `Reslot`: members whose slot changed get it (group, slot i).
fn reslot(agents: &mut AgentStore, group: AgentId, buffer: &[AgentId]) {
    for (i, &member) in buffer.iter().enumerate() {
        let Some(m) = agents.row(member) else { continue };
        if let Some(mm) = agents.data[m].group_member.as_mut() {
            if mm.slot != i as i32 {
                mm.group = group;
                mm.slot = i as i32;
            }
        }
    }
}

// =====================================================================================================================
// NavGroupSqueeze
// =====================================================================================================================

/// Squeeze and reform (`NavGroupSqueeze`): a few times a second each group measures the room left and right of its
/// pivot, there and a spacing ahead, and stands in rows as many abreast as fit (`columns`, `shift`) where the room is
/// narrower than its own shape reaches (plus half a spacing each side). It narrows at once, but widens only once
/// there's half a spacing to spare each side and the rear is through (`cleared`).
pub mod squeeze {
    use super::*;

    pub const INTERVAL: f32 = 0.25;

    /// `Due`: whether to measure now; a group with squeezing off, or of one member, stands as its own shape.
    pub fn due(group: &mut NavGroup, members: i32, time: f64) -> bool {
        if !group.squeeze || members < 2 || group.mode == NavGroupMode::Flock {
            group.columns = 0;
            return false;
        }
        if time < group.next_squeeze {
            return false;
        }
        group.next_squeeze = time + INTERVAL as f64;
        true
    }

    /// `OnNavMesh`: measures the room on the navmesh round `pivot` (the body's surface position) and squeezes to it.
    #[allow(clippy::too_many_arguments)]
    pub fn on_navmesh(group: &mut NavGroup, mask: Option<&NavFormationData>, members: i32, pivot: Float3, body: &crate::settings::NavMeshAgent, snapshot: &NavChunks, entry: i32, settled: bool) {
        if let Some((room, _)) = room_on_navmesh(group, mask, members, pivot, body, snapshot, entry) {
            apply(group, mask, members, room, travelled(group), settled);
        }
    }

    /// `RoomOnNavMesh`: the room (free metres left, right) round pivot on the navmesh, there and a spacing ahead, and
    /// the point ahead.
    pub fn room_on_navmesh(group: &NavGroup, mask: Option<&NavFormationData>, members: i32, pivot: Float3, agent: &crate::settings::NavMeshAgent, snapshot: &NavChunks, entry: i32) -> Option<(Float2, Float3)> {
        let e = entry_of(&snapshot.entries, entry)?;
        let nav = e.nav.as_deref()?;
        let gates = snapshot.gates_of(entry as usize);
        let mut filter = NavMeshQueryFilter::zeroed();
        filter.allowed_bins = u64::MAX;
        let (poly, _) = find_nearest_poly(nav, pivot, math::max(agent.max_snap_distance, agent.step_height), &filter)?;

        let reach = probe(group, mask, members);
        let forward = Float3::new(group.forward.x, 0.0, group.forward.z).normalize_safe(Float3::new(0.0, 0.0, 1.0));
        let right = Float3::new(forward.z, 0.0, -forward.x);
        let mut room = room_at(nav, e, poly, pivot, right, reach, gates);
        let (_, ahead, ahead_poly) = walk_free(nav, e, poly, pivot, forward, group.spacing, gates);
        let r2 = room_at(nav, e, ahead_poly, ahead, right, reach, gates);
        room = Float2::new(math::min(room.x, r2.x), math::min(room.y, r2.y));
        Some((room, ahead))
    }

    /// About how far the pivot went since the last measurement: its speed over one interval.
    fn travelled(group: &NavGroup) -> f32 {
        Float2::new(group.velocity.x, group.velocity.z).length() * INTERVAL
    }

    /// `InVolume`: measures the room in flight space round `pivot` and squeezes to it.
    pub fn in_volume(group: &mut NavGroup, mask: Option<&NavFormationData>, members: i32, pivot: Float3, entries: &[ChunkEntry], entry: i32, settled: bool) {
        if entry_of(entries, entry).and_then(|e| e.volume.as_ref()).is_none() {
            return;
        }
        let reach = probe(group, mask, members);
        let forward = Float3::new(group.forward.x, 0.0, group.forward.z).normalize_safe(Float3::new(0.0, 0.0, 1.0));
        let right = Float3::new(forward.z, 0.0, -forward.x);
        let step = 0.5 * math::max(group.spacing, 0.1);
        let mut room = Float2::new(free(entries, entry, pivot, -right, reach.x, step), free(entries, entry, pivot, right, reach.y, step));
        let ahead = pivot + forward * group.spacing;
        if flight::volume_entry_at(entries, entry, ahead) >= 0 {
            room = Float2::new(math::min(room.x, free(entries, entry, ahead, -right, reach.x, step)), math::min(room.y, free(entries, entry, ahead, right, reach.y, step)));
        }
        apply(group, mask, members, room, travelled(group), settled);
    }

    /// `Apply`: squeezes the group to `room` (free metres left, right of the pivot), or lets it take its own shape
    /// again.
    pub fn apply(group: &mut NavGroup, mask: Option<&NavFormationData>, members: i32, room: Float2, travelled: f32, settled: bool) {
        let spacing = math::max(group.spacing, 0.1);
        let margin = 0.5 * spacing;
        let r = formations::reach(group, mask, members);
        let need = Float2::new(r.x + margin, r.y + margin);
        let squeezed = group.columns > 0;
        let mut columns = 0;
        let mut shift = 0.0;
        let fits = if squeezed {
            room.x >= need.x + margin && room.y >= need.y + margin
        } else {
            room.x >= need.x - 1e-3 && room.y >= need.y - 1e-3
        };
        if !fits {
            // As many abreast as fit between the walls, no more than the shape has; widening takes half a spacing more.
            let widest = math::round((need.x + need.y - 2.0 * margin) / spacing) as i32 + 1;
            let width = room.x + room.y - 2.0 * margin;
            columns = abreast(width, spacing, widest);
            if squeezed && columns > group.columns {
                columns = group.columns.max(abreast(width - margin, spacing, widest));
            }
            shift = 0.5 * (room.y - room.x); // the middle of the room
        }

        if !squeezed || (columns != 0 && columns <= group.columns) {
            group.columns = columns; // narrower, or as narrow: at once
            group.shift = shift;
            group.cleared = 0.0;
            return;
        }

        // Wider: once the rear of the column has come through what squeezed it, or the group has stopped with
        // everyone in their slots.
        group.cleared += travelled;
        let layers = group.layers.max(1);
        let rows = (members + layers * group.columns - 1) / (layers * group.columns);
        if group.cleared < rows as f32 * spacing && !(settled && travelled < 0.1 * spacing) {
            return;
        }
        group.columns = columns;
        group.shift = shift;
        group.cleared = 0.0;
    }

    fn abreast(width: f32, spacing: f32, widest: i32) -> i32 {
        ((math::max(width, 0.0) / spacing + 1e-3).floor() as i32 + 1).clamp(1, widest.max(1))
    }

    /// How far to look each side: the shape's reach plus a spacing.
    fn probe(group: &NavGroup, mask: Option<&NavFormationData>, members: i32) -> Float2 {
        let r = formations::reach(group, mask, members);
        let s = math::max(group.spacing, 0.1);
        Float2::new(r.x + s, r.y + s)
    }

    fn room_at(nav: &NavMeshData, e: &ChunkEntry, poly: i32, p: Float3, right: Float3, reach: Float2, gates: &[bool]) -> Float2 {
        Float2::new(walk_free(nav, e, poly, p, -right, reach.x, gates).0, walk_free(nav, e, poly, p, right, reach.y, gates).0)
    }

    /// `Walk`: free metres from p along `direction` on the navmesh, up to `reach`, in half-metre steps until a step
    /// ends more than 10 cm from where it aimed. Returns (free, end, end poly).
    fn walk_free(nav: &NavMeshData, e: &ChunkEntry, poly: i32, p: Float3, direction: Float3, reach: f32, gates: &[bool]) -> (f32, Float3, i32) {
        const STEP: f32 = 0.5;
        let mut end = p;
        let mut end_poly = poly;
        let mut free = 0.0f32;
        if reach.is_nan() || reach <= 0.0 {
            return (0.0, end, end_poly);
        }
        let capped = math::min(reach, 1000.0);
        let steps = (capped / STEP).ceil() as i32;
        for s in 0..steps {
            let d = if s + 1 < steps { STEP } else { capped - s as f32 * STEP };
            let target = end + direction * d;
            let (next, next_poly) = crate::walkers::move_along_surface(nav, end_poly, end, target, gates);
            if at_face(e, next) {
                return (reach, end, end_poly);
            }
            let gained = math::max((next - end).dot(direction), 0.0);
            let miss = next - target;
            if Float2::new(miss.x, miss.z).length_sq() > 0.01 {
                return (free + gained, end, end_poly); // held back or deflected: a wall
            }
            free += gained;
            end = next;
            end_poly = next_poly;
        }
        (reach, end, end_poly)
    }

    /// Stopped at the chunk's box, not a wall: the neighbouring chunk carries on.
    fn at_face(e: &ChunkEntry, p: Float3) -> bool {
        const NEAR: f32 = 0.5;
        e.bounded && (p.x <= e.bounds_min.x + NEAR || p.x >= e.bounds_max.x - NEAR || p.z <= e.bounds_min.z + NEAR || p.z >= e.bounds_max.z - NEAR)
    }

    /// Free metres from p along `direction`, up to `reach`, in steps: own chunk's volume or a neighbour's.
    fn free(entries: &[ChunkEntry], own: i32, p: Float3, direction: Float3, reach: f32, step: f32) -> f32 {
        if reach.is_nan() || reach <= 0.0 || step.is_nan() || step <= 0.0 {
            return 0.0;
        }
        let steps = (math::min(reach, 1000.0) / step).ceil() as i32;
        for s in 1..=steps {
            let at = math::min(s as f32 * step, reach);
            if flight::volume_entry_at(entries, own, p + direction * at) < 0 {
                return (s - 1) as f32 * step;
            }
        }
        reach
    }
}

// =====================================================================================================================
// NavGroupPaceJob, NavGroupFlyerPaceJob, NavGroupWalkFlyPaceJob
// =====================================================================================================================

/// `Stays`: the member is live, its `NavGroupMember` on and naming this group.
fn stays(agents: &AgentStore, member: AgentId, group: AgentId) -> bool {
    agents.row(member).is_some_and(|m| agents.data[m].group_member.is_some_and(|x| x.enabled && x.group == group))
}

/// `Compact`: drops members that left or are gone; with k of n gone, the members at the rear fill the holes in front,
/// each hole (front first) taking the one whose slot was nearest it; sets `count`. Returns the kept count.
pub fn compact(agents: &mut AgentStore, g: usize) -> i32 {
    let entity = agents.id_of(g).unwrap();
    let mask = mask_of(agents, g);
    let mut buffer = std::mem::take(&mut agents.data[g].group.as_deref_mut().unwrap().members);
    let mut group = agents.data[g].group.as_deref().unwrap().group;
    let n = buffer.len();
    let kept = buffer.iter().filter(|&&m| stays(agents, m, entity)).count();

    if kept < n {
        let mut taken = vec![false; n];
        for hole in 0..kept {
            if !taken[hole] && stays(agents, buffer[hole], entity) {
                continue;
            }
            let at = formations::offset(&group, mask.as_deref(), hole as i32, n as i32);
            let mut best: Option<usize> = None;
            let mut best_d2 = f32::MAX;
            for j in kept..n {
                if taken[j] || !stays(agents, buffer[j], entity) {
                    continue;
                }
                let d2 = formations::offset(&group, mask.as_deref(), j as i32, n as i32).distance_sq(at);
                if d2 >= best_d2 {
                    continue;
                }
                best_d2 = d2;
                best = Some(j);
            }
            let best = best.expect("as many stay at the rear as there are holes in front");
            buffer[hole] = buffer[best];
            taken[hole] = false;
            taken[best] = true; // taken
        }
        buffer.truncate(kept);
    }

    reslot(agents, entity, &buffer);
    group.count = kept as i32;
    let gd = agents.data[g].group.as_deref_mut().unwrap();
    gd.members = buffer;
    gd.group.count = group.count;
    kept as i32
}

/// `Follow` (pace): velocity, and the level heading, from where the pivot went since last tick.
pub fn follow_pivot(group: &mut NavGroup, pivot: Float3, dt: f32) {
    let moved = pivot - group.previous_position;
    group.velocity = if dt > 0.0 { moved / dt } else { Float3::default() };
    group.previous_position = pivot;
    let level = Float3::new(moved.x, 0.0, moved.z);
    if level.length_sq() > 1e-8 {
        group.forward = level.normalize();
    }
}

/// `Pace`: the body's speed override: [`HEADROOM`] x the slowest member's speed, full up to `slack` behind and down to
/// `min_pace` at twice `slack`. 0 with no members (the type's own speed); never quite 0 otherwise.
pub fn pace_speed(group: &NavGroup, members: i32, slowest: f32, behind: f32) -> f32 {
    if members == 0 {
        return 0.0;
    }
    let slack = math::max(group.slack, 0.1);
    let pace = math::max(math::saturate(2.0 - behind / slack), math::saturate(group.min_pace));
    math::max(HEADROOM * slowest * pace, 1e-3)
}

/// `NavGroupTurnBody.Replan`: a path request from `at` to the body's goal (its chunk route's when active).
fn replan(agents: &mut AgentStore, g: usize, at: Float3, goal: Float3) {
    let d = &mut agents.data[g];
    let goal = match d.chunk_route.as_deref() {
        Some(cr) if cr.route.active => cr.route.goal,
        _ => goal,
    };
    d.path_request = PathRequest { goal, start: at, urgent: false, start_from_current_position: true };
    d.path_request_enabled = true;
}

/// The body moved out of its chunk's box (turning in place): it drops its chunk and is placed by its position next
/// tick.
fn drop_chunk_if_outside(agents: &mut AgentStore, g: usize, entries: &[ChunkEntry], front: Float3) {
    if let Some(e) = entry_of(entries, agents.chunk[g].entry) {
        if !walk::in_box(e, front) {
            agents.chunk[g] = NavAgentChunk { chunk: Hash128::default(), entry: -1 };
            agents.chunk_pending[g] = true;
        }
    }
}

/// Positions for a swap pass (NaN for members keeping their slot), by the given position source.
fn swap_positions(agents: &AgentStore, buffer: &[AgentId], kept: usize, surface: bool) -> Vec<Float3> {
    (0..kept)
        .map(|i| {
            let nan = Float3::splat(f32::NAN);
            let Some(m) = agents.row(buffer[i]) else { return nan };
            if surrounding(agents, m) {
                return nan;
            }
            if surface {
                if agents.data[m].walk.is_some() && agents.surface[m].initialized { agents.surface[m].surface_position } else { nan }
            } else {
                agents.position[m]
            }
        })
        .collect()
}

/// Runs a swap pass over the body's members and gives them their slots.
#[allow(clippy::too_many_arguments)]
fn run_swap(agents: &mut AgentStore, g: usize, group: &NavGroup, mask: Option<&NavFormationData>, kept: i32, pivot: Float3, up: Float3, surface: bool, use_trail: bool) {
    let entity = agents.id_of(g).unwrap();
    let gd = agents.data[g].group.as_deref_mut().unwrap();
    let mut buffer = std::mem::take(&mut gd.members);
    let trail_pts = if use_trail { gd.trail.clone() } else { Vec::new() };
    let mut positions = swap_positions(agents, &buffer, kept as usize, surface);
    let trades = swap::pass(&mut buffer, group, mask, kept, pivot, &mut positions, up, &trail_pts, use_trail);
    if trades > 0 {
        reslot(agents, entity, &buffer[..kept as usize]);
    }
    agents.data[g].group.as_deref_mut().unwrap().members = buffer;
}

/// `NavGroupPaceSystem`: per group body (walker groups, then flyer groups, then walk-and-fly groups), ascending rows.
pub fn pace(_sys: &mut GroupSystems, agents: &mut AgentStore, frame: &Frame) {
    let snapshot = frame.world.snapshot();
    let rows: Vec<usize> = agents.active_rows().filter(|&g| agents.data[g].group.is_some()).collect();
    for &g in &rows {
        if agents.data[g].kind == AgentKind::Walker {
            pace_walkers(agents, g, frame, snapshot);
        }
    }
    for &g in &rows {
        if agents.data[g].kind == AgentKind::Flyer {
            pace_flyers(agents, g, frame, snapshot);
        }
    }
    for &g in &rows {
        if agents.data[g].kind == AgentKind::WalkFly {
            pace_walk_fly(agents, g, frame, snapshot);
        }
    }
}

/// The group's members' rows (live), in slot order, for the first `kept`.
fn member_rows(agents: &AgentStore, g: usize, kept: i32) -> Vec<Option<usize>> {
    let gd = agents.data[g].group.as_deref().unwrap();
    gd.members.iter().take(kept as usize).map(|&m| agents.row(m)).collect()
}

/// `NavGroupPaceJob` (walker groups).
fn pace_walkers(agents: &mut AgentStore, g: usize, frame: &Frame, snapshot: &NavChunks) {
    let entries = &snapshot.entries;
    let mask = mask_of(agents, g);
    let mask = mask.as_deref();
    let kept = compact(agents, g);
    let mut group = agents.data[g].group.as_deref().unwrap().group;

    // Heading and velocity from where the body went this tick (once it's on the navmesh).
    let mut pivot = agents.surface[g];
    if !pivot.initialized {
        agents.data[g].group.as_deref_mut().unwrap().group.velocity = Float3::default();
        return;
    }

    let planned = agents.data[g].walker.as_deref().map_or(f64::MIN, |w| w.path.computed_time);
    let mut trail_pts = std::mem::take(&mut agents.data[g].group.as_deref_mut().unwrap().trail);
    let rows = member_rows(agents, g, kept);
    let mut front = None;
    if turn::turning(&group, kept, pivot.surface_position, frame.time, planned) {
        // As far back as its rearmost member stands, along the trail.
        let mut reach = 0.0f32;
        for m in rows.iter().flatten().copied() {
            if agents.data[m].walk.is_some() && !surrounding(agents, m) {
                reach = math::max(reach, trail::back(&trail_pts, true, group.previous_position, group.forward, agents.surface[m].surface_position, UP));
            }
        }
        front = turn::check(&mut group, &mut trail_pts, mask, kept, reach, frame.time);
    }

    if let Some(front) = front {
        // Turned in place: the body to the rear, which is its front now, and on from there.
        agents.position[g] = front + (agents.position[g] - pivot.surface_position); // as high above its surface
        agents.rotation[g] = crate::walkers::look_rotation_safe(group.forward, UP);
        pivot.surface_position = front;
        agents.surface[g] = pivot;
        let mut goal = front;
        if let Some(w) = agents.data[g].walker.as_deref_mut() {
            goal = w.path.goal;
            w.path.state = NavPathState::None; // stands until its new path
        }
        replan(agents, g, front, goal);
        drop_chunk_if_outside(agents, g, entries, front);
    }

    follow_pivot(&mut group, pivot.surface_position, frame.dt);
    trail::record(&mut trail_pts, pivot.surface_position, &group, kept);
    {
        let gd = agents.data[g].group.as_deref_mut().unwrap();
        gd.trail = trail_pts;
        gd.group = group;
    }

    if swap::due(&mut group, kept, frame.time) {
        agents.data[g].group.as_deref_mut().unwrap().group = group;
        run_swap(agents, g, &group, mask, kept, pivot.surface_position, pivot.up.normalize_safe(UP), true, true);
    }

    // Pace: the slowest member, slowed for the one furthest behind.
    let rows = member_rows(agents, g, kept);
    let trail_pts = agents.data[g].group.as_deref().unwrap().trail.clone();
    let mut slowest = f32::MAX;
    let mut behind = 0.0f32;
    for (i, m) in rows.iter().enumerate() {
        let Some(m) = *m else { continue };
        let d = &agents.data[m];
        if let Some(c) = &d.walk {
            slowest = math::min(slowest, c.speed());
        }
        if d.walk.is_none() {
            continue; // no surface
        }
        if surrounding(agents, m) {
            continue; // gone to the surround: not behind
        }
        let surface = agents.surface[m];
        let up = surface.up.normalize_safe(UP);
        let slot = formations::target_on_trail(&group, mask, pivot.surface_position, i as i32, kept, surface.surface_position, up, &trail_pts, true);
        let gap = slot - surface.surface_position;
        if trail::waits(&group, mask, i as i32, kept, pivot.surface_position, surface.surface_position, gap, up, &trail_pts, true) {
            continue; // falling in: not behind
        }
        behind = math::max(behind, walk::behind(d.walker.as_deref().map(|w| &w.path), Float3::new(gap.x, 0.0, gap.z).length()));
    }

    if squeeze::due(&mut group, kept, frame.time) {
        let body = agents.data[g].walk.as_ref().unwrap().settings.clone();
        let settled = behind <= group.slack;
        squeeze::on_navmesh(&mut group, mask, kept, pivot.surface_position, &body, snapshot, agents.chunk[g].entry, settled);
    }
    let speed = pace_speed(&group, kept, slowest, behind);
    let d = &mut agents.data[g];
    d.group.as_deref_mut().unwrap().group = group;
    if let Some(w) = d.walk.as_mut() {
        w.speed_override = speed;
    }
}

/// `NavGroupFlyerPaceJob` (flyer groups: the body's transform is the pivot).
fn pace_flyers(agents: &mut AgentStore, g: usize, frame: &Frame, snapshot: &NavChunks) {
    let entries = &snapshot.entries;
    let mask = mask_of(agents, g);
    let mask = mask.as_deref();
    let kept = compact(agents, g);
    let mut group = agents.data[g].group.as_deref().unwrap().group;
    let planned = agents.data[g].flyer.as_deref().map_or(f64::MIN, |f| f.path.computed_time);
    let mut trail_pts = std::mem::take(&mut agents.data[g].group.as_deref_mut().unwrap().trail);
    let rows = member_rows(agents, g, kept);
    let mut pivot = agents.position[g];
    let mut front = None;
    if turn::turning(&group, kept, pivot, frame.time, planned) {
        let mut reach = 0.0f32;
        for m in rows.iter().flatten().copied() {
            if !surrounding(agents, m) {
                reach = math::max(reach, trail::back(&trail_pts, true, group.previous_position, group.forward, agents.position[m], Float3::default()));
            }
        }
        front = turn::check(&mut group, &mut trail_pts, mask, kept, reach, frame.time);
    }

    if let Some(front) = front {
        pivot = front;
        agents.position[g] = front;
        agents.rotation[g] = crate::walkers::look_rotation_safe(group.forward, UP);
        let mut goal = front;
        if let Some(f) = agents.data[g].flyer.as_deref_mut() {
            goal = f.path.goal;
            f.path.state = NavPathState::None; // holds until its new path
        }
        replan(agents, g, front, goal);
        drop_chunk_if_outside(agents, g, entries, front);
    }

    follow_pivot(&mut group, pivot, frame.dt);
    trail::record(&mut trail_pts, pivot, &group, kept);
    {
        let gd = agents.data[g].group.as_deref_mut().unwrap();
        gd.trail = trail_pts;
        gd.group = group;
    }
    if swap::due(&mut group, kept, frame.time) {
        agents.data[g].group.as_deref_mut().unwrap().group = group;
        run_swap(agents, g, &group, mask, kept, pivot, Float3::default(), false, true);
    }

    let rows = member_rows(agents, g, kept);
    let trail_pts = agents.data[g].group.as_deref().unwrap().trail.clone();
    let mut slowest = f32::MAX;
    let mut behind = 0.0f32;
    for (i, m) in rows.iter().enumerate() {
        let Some(m) = *m else { continue };
        let d = &agents.data[m];
        if let Some(c) = &d.flight {
            slowest = math::min(slowest, c.speed());
        }
        if surrounding(agents, m) {
            continue;
        }
        let p = agents.position[m];
        let slot = formations::target_on_trail(&group, mask, pivot, i as i32, kept, p, Float3::default(), &trail_pts, true);
        if trail::waits(&group, mask, i as i32, kept, pivot, p, slot - p, Float3::default(), &trail_pts, true) {
            continue;
        }
        behind = math::max(behind, flight::behind(agents.chunk[m].entry, d.flyer.as_deref().map(|f| &f.path), p, slot, group.spacing, entries));
    }

    if squeeze::due(&mut group, kept, frame.time) {
        let settled = behind <= group.slack;
        squeeze::in_volume(&mut group, mask, kept, pivot, entries, agents.chunk[g].entry, settled);
    }
    let speed = pace_speed(&group, kept, slowest, behind);
    let d = &mut agents.data[g];
    d.group.as_deref_mut().unwrap().group = group;
    if let Some(f) = d.flight.as_mut() {
        f.speed_override = speed;
    }
}

/// `NavGroupWalkFlyPaceJob` (walk-and-fly groups: the transform is the pivot; both speeds paced).
fn pace_walk_fly(agents: &mut AgentStore, g: usize, frame: &Frame, snapshot: &NavChunks) {
    let entries = &snapshot.entries;
    let mask = mask_of(agents, g);
    let mask = mask.as_deref();
    let kept = compact(agents, g);
    let mut group = agents.data[g].group.as_deref().unwrap().group;
    let pivot = agents.position[g];
    follow_pivot(&mut group, pivot, frame.dt);
    agents.data[g].group.as_deref_mut().unwrap().group = group;

    let route = agents.data[g].route.as_deref().map(|x| x.route).unwrap_or_default();
    let walking = route.mode == NavMotionMode::Walking;
    if swap::due(&mut group, kept, frame.time) {
        // Level while the body walks, in 3D while it flies.
        agents.data[g].group.as_deref_mut().unwrap().group = group;
        run_swap(agents, g, &group, mask, kept, pivot, if walking { UP } else { Float3::default() }, false, false);
    }

    let rows = member_rows(agents, g, kept);
    let (mut slowest_walk, mut slowest_fly) = (f32::MAX, f32::MAX);
    let mut behind = 0.0f32;
    for (i, m) in rows.iter().enumerate() {
        let Some(m) = *m else { continue };
        let d = &agents.data[m];
        if let Some(c) = &d.walk {
            slowest_walk = math::min(slowest_walk, c.speed());
        }
        if let Some(c) = &d.flight {
            slowest_fly = math::min(slowest_fly, c.speed());
        }
        if surrounding(agents, m) {
            continue;
        }
        let p = agents.position[m];
        let slot = formations::target(&group, mask, pivot, i as i32, kept, p, Float3::default());
        let gap = slot - p;
        let flying = d.route.as_deref().is_some_and(|x| x.route.mode == NavMotionMode::Flying);
        if walking {
            behind = math::max(behind, walk::behind(d.walker.as_deref().map(|w| &w.path), Float3::new(gap.x, 0.0, gap.z).length()));
        } else if flying {
            behind = math::max(behind, flight::behind(agents.chunk[m].entry, d.flyer.as_deref().map(|f| &f.path), p, slot, group.spacing, entries));
        } else {
            behind = math::max(behind, gap.length()); // taking off or landing: on its way
        }
    }

    if squeeze::due(&mut group, kept, frame.time) {
        let settled = behind <= group.slack;
        let entry = agents.chunk[g].entry;
        let surface = agents.surface[g];
        if walking && surface.initialized {
            let body = agents.data[g].walk.as_ref().unwrap().settings.clone();
            squeeze::on_navmesh(&mut group, mask, kept, surface.surface_position, &body, snapshot, entry, settled);
        } else if route.mode == NavMotionMode::Flying {
            squeeze::in_volume(&mut group, mask, kept, pivot, entries, entry, settled);
        }
    }
    let (walk_speed, fly_speed) = (pace_speed(&group, kept, slowest_walk, behind), pace_speed(&group, kept, slowest_fly, behind));
    let d = &mut agents.data[g];
    d.group.as_deref_mut().unwrap().group = group;
    if let Some(w) = d.walk.as_mut() {
        w.speed_override = walk_speed;
    }
    if let Some(f) = d.flight.as_mut() {
        f.speed_override = fly_speed;
    }
}

// =====================================================================================================================
// NavGroupMergeSystem
// =====================================================================================================================

/// `NavGroupInfo`: a group as the merge pass sees it.
#[derive(Clone, Copy, Debug)]
pub struct GroupInfo {
    pub entity: AgentId,
    pub pivot: Float3,
    pub goal: Float3,
    pub target: Option<TargetRef>,
    pub radius: f32,
    pub join_distance: f32,
    pub same_goal_distance: f32,
    pub agent_type: Hash128,
    pub count: i32,
    pub max_members: i32,
    pub merge_priority: i32,
    pub has_goal: bool,
    pub accept_joiners: bool,
    pub merge: bool,
}

/// `NavGroupDestinations.Of`: where an agent or body is going: what it chases, else its route's goal, else its chunk
/// route's, else its waiting request's, else its path's. None if nowhere.
pub fn destination(agents: &AgentStore, r: usize, targets: &Targets) -> Option<(Float3, Option<TargetRef>)> {
    let d = &agents.data[r];
    if let Some(chase) = d.goal_target {
        if let Some(at) = agents.target_position(chase.target, targets) {
            return Some((at, Some(chase.target)));
        }
    }
    if let Some(route) = d.route.as_deref().filter(|x| x.route.state != NavRouteState::None) {
        return Some((route.route.goal, None));
    }
    if let Some(cr) = d.chunk_route.as_deref().filter(|x| x.route.active) {
        return Some((cr.route.goal, None));
    }
    if d.path_request_enabled {
        return Some((d.path_request.goal, None));
    }
    if let Some(w) = d.walker.as_deref().filter(|w| w.path.state != NavPathState::None) {
        return Some((w.path.goal, None));
    }
    if let Some(f) = d.flyer.as_deref().filter(|f| f.path.state != NavPathState::None) {
        return Some((f.path.goal, None));
    }
    None
}

/// `NavGroupDestinations.Same`: the same target, or goals within `distance`.
pub fn same_place(goal: Float3, target: Option<TargetRef>, other_goal: Float3, other_target: Option<TargetRef>, distance: f32) -> bool {
    if target.is_some() && target == other_target {
        return true;
    }
    goal.distance_sq(other_goal) <= distance * distance
}

/// `NavGroupDestinations.Footprint`: how far a group's members reach round its pivot.
pub fn footprint(group: &NavGroup, mask: Option<&NavFormationData>, count: i32) -> f32 {
    let margin = 0.5 * group.spacing;
    if group.mode == NavGroupMode::Flock {
        return formations::leash(group, count) + margin;
    }
    let mut reach = 0.0f32;
    for i in 0..count {
        reach = math::max(reach, formations::offset(group, mask, i, count).length_sq());
    }
    reach.sqrt() + margin
}

/// Agents that can steer as members (Foxfire's `NavSteering` present): walkers with avoidance, flyers with separation.
fn can_steer(agents: &AgentStore, r: usize) -> bool {
    let d = &agents.data[r];
    (d.kind.walks() && d.avoidance.is_some()) || (d.kind.flies() && d.flight.as_ref().is_some_and(|f| f.settings.separation_strength > 0.0))
}

/// `NavGroupMergeSystem` without host targets (a chase of a host target counts as no destination); the tick calls
/// [`merge_with_targets`].
pub fn merge(sys: &mut GroupSystems, agents: &mut AgentStore, frame: &Frame) {
    merge_with_targets(sys, agents, &Targets::default(), frame);
}

/// `NavGroupMergeSystem`: groups merged at the last pass are disabled; then every [`MERGE_INTERVAL`], gather, joiners,
/// merges (`NavGroupGatherJob`, `NavGroupJoinerJob`, `NavGroupMergeJob`).
pub fn merge_with_targets(sys: &mut GroupSystems, agents: &mut AgentStore, targets: &Targets, frame: &Frame) {
    for (group, into) in std::mem::take(&mut sys.merged) {
        let Some(g) = agents.row(group) else { continue };
        // Members on their way in when it merged took a slot in it since: on to the group it went into too.
        let buffer = std::mem::take(&mut agents.data[g].group.as_deref_mut().unwrap().members);
        for member in buffer {
            let Some(m) = agents.row(member) else { continue };
            if let Some(mm) = agents.data[m].group_member.as_mut().filter(|x| x.group == group) {
                mm.group = into;
                mm.slot = -1;
            }
        }
        let gd = agents.data[g].group.as_deref_mut().unwrap();
        gd.merged_into = Some(into);
        agents.data[g].disabled = true;
    }

    if !agents.active_rows().any(|g| agents.data[g].group.is_some()) {
        return; // RequireForUpdate(_groups)
    }
    if frame.time < sys.next_merge {
        return;
    }
    sys.next_merge = frame.time + MERGE_INTERVAL;

    // NavGroupGatherJob.
    let mut groups: Vec<GroupInfo> = Vec::new();
    for g in agents.active_rows() {
        let d = &agents.data[g];
        let Some(gd) = d.group.as_deref() else { continue };
        let count = gd.members.len() as i32;
        let dest = destination(agents, g, targets);
        groups.push(GroupInfo {
            entity: agents.id_of(g).unwrap(),
            pivot: agents.position[g],
            goal: dest.map_or(Float3::default(), |x| x.0),
            target: dest.and_then(|x| x.1),
            radius: footprint(&gd.group, gd.formation.as_deref(), count),
            join_distance: gd.group.join_distance,
            same_goal_distance: gd.group.same_goal_distance,
            agent_type: d.agent_type,
            count,
            max_members: gd.group.max_members,
            merge_priority: gd.group.merge_priority,
            has_goal: dest.is_some(),
            accept_joiners: gd.group.accept_joiners,
            merge: gd.group.merge,
        });
    }

    // NavGroupJoinerJob.
    let mut joins: Vec<(AgentId, AgentId, f32)> = Vec::new();
    for r in agents.active_rows() {
        let d = &agents.data[r];
        if !d.group_joiner || d.group.is_some() || !can_steer(agents, r) || d.group_member.is_some_and(|m| m.enabled) {
            continue;
        }
        let Some((goal, target)) = destination(agents, r, targets) else { continue };
        let position = agents.position[r];
        let mut best: Option<usize> = None;
        let mut best_distance = f32::MAX;
        for (gi, group) in groups.iter().enumerate() {
            if group.agent_type != d.agent_type || !group.accept_joiners || !group.has_goal {
                continue;
            }
            if group.max_members > 0 && group.count >= group.max_members {
                continue;
            }
            let distance = position.distance(group.pivot);
            if distance > group.radius + group.join_distance || distance >= best_distance {
                continue;
            }
            if !same_place(goal, target, group.goal, group.target, group.same_goal_distance) {
                continue;
            }
            best = Some(gi);
            best_distance = distance;
        }
        if let Some(b) = best {
            joins.push((agents.id_of(r).unwrap(), groups[b].entity, best_distance));
        }
    }

    // NavGroupMergeJob.
    groups.sort_by_key(|g| g.entity.index());
    let n = groups.len();
    let mut root: Vec<usize> = (0..n).collect();
    let mut count: Vec<i32> = groups.iter().map(|g| g.count).collect();
    let find = |root: &[usize], mut i: usize| {
        while root[i] != i {
            i = root[i];
        }
        i
    };
    let wins = |a: &GroupInfo, count_a: i32, b: &GroupInfo, count_b: i32| {
        if a.merge_priority != b.merge_priority {
            return a.merge_priority < b.merge_priority;
        }
        if count_a != count_b {
            return count_a > count_b;
        }
        a.entity.index() < b.entity.index()
    };
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (&groups[i], &groups[j]);
            if !a.merge || !b.merge || a.agent_type != b.agent_type || !a.has_goal || !b.has_goal {
                continue;
            }
            if a.pivot.distance(b.pivot) > a.radius + b.radius {
                continue;
            }
            if !same_place(a.goal, a.target, b.goal, b.target, math::min(a.same_goal_distance, b.same_goal_distance)) {
                continue;
            }
            let (ri, rj) = (find(&root, i), find(&root, j));
            if ri == rj {
                continue;
            }
            let winner = if wins(&groups[ri], count[ri], &groups[rj], count[rj]) { ri } else { rj };
            let loser = if winner == ri { rj } else { ri };
            let max = groups[winner].max_members;
            if max > 0 && count[ri] + count[rj] > max {
                continue;
            }
            root[loser] = winner;
            count[winner] += count[loser];
        }
    }

    for i in 0..n {
        let r = find(&root, i);
        if r == i {
            continue;
        }
        let into = groups[r].entity;
        let from = groups[i].entity;
        if let Some(g) = agents.row(from) {
            let buffer = agents.data[g].group.as_deref().map(|x| x.members.clone()).unwrap_or_default();
            for member in buffer {
                let Some(m) = agents.row(member) else { continue };
                if let Some(mm) = agents.data[m].group_member.as_mut().filter(|x| x.enabled && x.group == from) {
                    mm.group = into;
                    mm.slot = -1;
                }
            }
        }
        sys.merged.push((from, into));
    }

    joins.sort_by(|a, b| a.1.index().cmp(&b.1.index()).then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal)).then(a.0.index().cmp(&b.0.index())));
    for (agent, group, _) in joins {
        let Some(gi) = groups.iter().position(|x| x.entity == group) else { continue };
        let gi = find(&root, gi);
        let info = groups[gi];
        if !info.accept_joiners || (info.max_members > 0 && count[gi] >= info.max_members) {
            continue;
        }
        let Some(a) = agents.row(agent) else { continue };
        let d = &mut agents.data[a];
        d.group_member = Some(NavGroupMember { group: info.entity, slot: -1, enabled: true });
        d.path_request_enabled = false; // the group plans now
        count[gi] += 1;
    }
}

// =====================================================================================================================
// NavGroupMemberMoveJob, NavGroupFlyerMoveJob
// =====================================================================================================================

/// Steering stage 3 for group members with `steering` on: walkers (`NavGroupMemberMoveJob`) move their contact by
/// `agents.steered` (avoidance kept it on the navmesh) and face their travel; flyers (`NavGroupFlyerMoveJob`) move by
/// `steered`, or by `desired` (sliding along what blocks it) if the steered move would leave free flight space, and
/// fly straight home when pushed out of loaded space. `agents.velocity` is what they moved by.
pub fn move_members(_sys: &mut GroupSystems, agents: &mut AgentStore, frame: &Frame) {
    let entries = &frame.world.snapshot().entries;
    let dt = frame.dt;
    for r in agents.active_rows().collect::<Vec<_>>() {
        let d = &agents.data[r];
        if !d.group_member.is_some_and(|m| m.enabled) || !agents.steering[r] {
            continue;
        }
        let (walking, flying) = match d.route.as_deref() {
            Some(x) => (x.walking, x.flying),
            None => (d.kind.walks(), d.kind.flies()),
        };
        if d.kind.walks() && !flying {
            // NavGroupMemberMoveJob.
            let Some(config) = d.walk.clone() else { continue };
            if agents.chunk[r].entry < 0 {
                continue; // its chunk isn't loaded: paused
            }
            let old = agents.surface[r].surface_position;
            let steered = agents.steered[r];
            let contact = old + steered * dt;
            let travel = if steered.length_sq() > 1e-4 { steered } else { crate::filters::quat_rotate(agents.rotation[r], Float3::new(0.0, 0.0, 1.0)) };
            let up = agents.surface[r].up;
            crate::walkers::place(agents, r, contact, up, travel, &config, dt);
            agents.velocity[r] = if dt > 0.0 { (contact - old) / dt } else { Float3::default() };
        } else if d.kind.flies() && !walking {
            // NavGroupFlyerMoveJob.
            let (Some(flight), Some(f)) = (d.flight.as_ref(), d.flyer.as_deref()) else { continue };
            let own = agents.chunk[r].entry;
            if entry_of(entries, own).is_none() {
                continue; // its chunk isn't loaded: paused
            }
            let flyer = flight.effective();
            let (base_speed, base_turn) = (flight.speed(), flight.turn_speed());
            let path_state = f.path.state;
            let old = agents.position[r];
            let mut position = old;
            let mut rotation = agents.rotation[r];
            if flight::fly_home(entries, own, &mut position, &mut rotation, flyer.speed, flyer.turn_speed, dt) {
                // Out of loaded space: back in.
            } else {
                let mut velocity = agents.steered[r];
                let reach = math::max(flyer.crossing_reach(), flyer.max_snap_distance);
                if entries[own as usize].volume.is_some() && !free_move(entries, own, position, velocity, reach, dt) {
                    let pathing = matches!(path_state, NavPathState::Following | NavPathState::Partial);
                    velocity = if pathing { agents.desired[r] } else { slide(entries, own, position, agents.desired[r], reach, dt) };
                }
                position += velocity * dt;
                let speed = velocity.length();
                if speed > 0.1 * base_speed {
                    crate::flyers::face(&mut rotation, velocity / speed, base_turn, dt);
                }
            }
            if agents.data[r].update_position {
                agents.position[r] = position;
            }
            if agents.data[r].update_rotation {
                agents.rotation[r] = rotation;
            }
            agents.velocity[r] = if dt > 0.0 { (position - old) / dt } else { Float3::default() };
        }
    }
}

/// `NavGroupFlyerMoveJob.Free`: this tick's move stays in free space (own volume or a neighbour's past its box), or
/// crosses the padding gap at a chunk face into a neighbour's free space within `reach`.
fn free_move(entries: &[ChunkEntry], own: i32, position: Float3, velocity: Float3, reach: f32, dt: f32) -> bool {
    if flight::volume_entry_at(entries, own, position + velocity * dt) >= 0 {
        return true;
    }
    let speed = velocity.length();
    if speed < 1e-4 || !entries[own as usize].bounded {
        return false;
    }
    let direction = velocity / speed;
    let mut d = 1.0f32;
    while d <= reach {
        let probe = position + direction * d;
        if !walk::in_box(&entries[own as usize], probe) && flight::volume_entry_at(entries, own, probe) >= 0 {
            return true;
        }
        d += 1.0;
    }
    false
}

/// `NavGroupFlyerMoveJob.Slide`: the velocity, or its first part whose move stays free: without its vertical, without
/// x, without z; zero if none.
fn slide(entries: &[ChunkEntry], own: i32, position: Float3, velocity: Float3, reach: f32, dt: f32) -> Float3 {
    if free_move(entries, own, position, velocity, reach, dt) {
        return velocity;
    }
    let level = Float3::new(velocity.x, 0.0, velocity.z);
    if free_move(entries, own, position, level, reach, dt) {
        return level;
    }
    let along_z = Float3::new(0.0, velocity.y, velocity.z);
    if free_move(entries, own, position, along_z, reach, dt) {
        return along_z;
    }
    let along_x = Float3::new(velocity.x, velocity.y, 0.0);
    if free_move(entries, own, position, along_x, reach, dt) { along_x } else { Float3::default() }
}
