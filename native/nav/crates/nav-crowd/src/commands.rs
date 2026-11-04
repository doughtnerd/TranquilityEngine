//! The command queue: what the host asks of agents, obstacles, gates and targets between ticks, applied in order at
//! the start of the next tick ([`apply`]), after the agent buffers are read in.
//!
//! Commands naming a stale handle (a removed agent) are skipped and counted ([`CommandStats::ignored`]). Commands that
//! add things carry a handle reserved when they were queued ([`crate::Crowd::add_agent`]), so the host has it at once.
//!
//! What each does, from Foxfire's API it stands for:
//!
//! | command | Foxfire |
//! |---|---|
//! | `AddAgent` / `RemoveAgent` | instantiate / destroy an agent entity (and `NavGroups.Create*` for a group body) |
//! | `SetDestination` | enable `PathRequest { goal, StartFromCurrentPosition, Urgent }`, and stop any chase |
//! | `Chase` / `StopChase` | `NavChase.Start` / `Stop` |
//! | `Stop` | (new) drop the request, chase and path; the agent stands |
//! | `Warp` | (new) set the transform, re-derive the surface and chunk, path again to the same goal |
//! | `JoinGroup` / `LeaveGroup` | `NavGroups.Join` / `Leave` (with an optional goal) |
//! | `SetGroupJoining` | `NavGroups.SetJoining` (`NavGroupJoiner`) |
//! | `SetGroupMask` | `NavGroups.SetMask` (`NavGroupFormation`, formation `Mask`) |
//! | `SetGate` | `NavGate.Open` |
//! | `SetAreaCost` / `ClearAreaCosts` | the agent's `NavMeshAgentAreaCost` buffer |
//! | `SetWorldAreaCost` | (new, ADR 0065's `Navigation.setAreaCost`) an override every agent's filter takes before its own |
//! | `SetSpeed` | `NavMeshAgentConfig` / `NavFlightAgentConfig` speed and turn speed overrides |
//! | `AddObstacle` / `RemoveObstacle` | a `NavAvoidanceObstacle` entity |
//! | `SetTargetSurround` / `SetFlowGoal` / `RemoveTarget` | `NavSurround` / `NavFlowGoal` on a target entity; destroying it |
use crate::agents::{AgentDesc, AgentStore};
use crate::boundary::Boundary;
use crate::chase;
use crate::chunks::ChunkWorld;
use crate::components::{NavAvoidanceObstacle, NavFlowGoal, NavGroupMember, NavMeshAgentAreaCost, NavPathState, NavSurround, PathRequest};
use crate::ids::{AgentId, ObstacleId, TargetId, TargetRef};
use crate::settings::AgentTypes;
use crate::warnings::Warnings;
use crate::world::{Obstacles, Targets};
use nav_format::blob::NavFormationData;
use nav_math::{Float3, Hash128};
use std::sync::Arc;

/// A queued request (see the module doc).
#[derive(Clone, Debug)]
pub enum Command {
    AddAgent { id: AgentId, desc: Box<AgentDesc> },
    RemoveAgent(AgentId),
    SetDestination { agent: AgentId, point: Float3 },
    Chase { agent: AgentId, target: TargetRef, repath_distance: f32 },
    StopChase(AgentId),
    Stop(AgentId),
    Warp { agent: AgentId, point: Float3 },
    JoinGroup { agent: AgentId, group: AgentId },
    LeaveGroup { agent: AgentId, goal: Option<Float3> },
    SetGroupJoining { agent: AgentId, joining: bool },
    /// A group body's painted shape (`formations::create_mask`), its formation set to `Mask`; None drops the shape (the
    /// group then stands as its preset; set `formation` through a new body to change the preset).
    SetGroupMask { group: AgentId, mask: Option<Arc<NavFormationData>> },
    SetGate { id: Hash128, open: bool },
    /// `cost` < 0: the area's default cost.
    SetAreaCost { agent: AgentId, area: Hash128, cost: f32, excluded: bool },
    ClearAreaCosts(AgentId),
    SetWorldAreaCost { area: Hash128, cost: f32, excluded: bool },
    /// 0 = the type's.
    SetSpeed { agent: AgentId, speed: f32, turn_speed: f32 },
    AddObstacle { id: ObstacleId, obstacle: NavAvoidanceObstacle, position: Float3 },
    RemoveObstacle(ObstacleId),
    SetTargetSurround { target: TargetId, surround: Option<NavSurround> },
    SetFlowGoal { target: TargetId, goal: Option<NavFlowGoal> },
    RemoveTarget(TargetId),
}

/// What [`apply`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CommandStats {
    pub applied: usize,
    /// Skipped: a stale handle, an unknown agent type, a join to something that isn't a group.
    pub ignored: usize,
}

/// What commands change besides agents.
pub struct CommandTargets<'a> {
    pub agents: &'a mut AgentStore,
    pub obstacles: &'a mut Obstacles,
    pub targets: &'a mut Targets,
    pub chunks: &'a mut ChunkWorld,
    pub boundary: &'a mut Boundary,
    pub types: &'a AgentTypes,
    pub world_area_costs: &'a mut Vec<NavMeshAgentAreaCost>,
    pub warnings: &'a mut Warnings,
}

/// Applies the queued commands in order.
pub fn apply(commands: Vec<Command>, t: &mut CommandTargets) -> CommandStats {
    let mut stats = CommandStats::default();
    for c in commands {
        if apply_one(c, t) {
            stats.applied += 1;
        } else {
            stats.ignored += 1;
        }
    }
    stats
}

fn upsert_cost(list: &mut Vec<NavMeshAgentAreaCost>, area: Hash128, cost: f32, excluded: bool) {
    match list.iter_mut().find(|c| c.area_id == area) {
        Some(c) => {
            c.cost = cost;
            c.excluded = excluded;
        }
        None => list.push(NavMeshAgentAreaCost { area_id: area, cost, excluded }),
    }
}

fn apply_one(c: Command, t: &mut CommandTargets) -> bool {
    let agents = &mut *t.agents;
    match c {
        Command::AddAgent { id, desc } => match agents.activate(id, &desc, t.types) {
            Ok(()) => {
                t.boundary.fit(agents.capacity(), t.obstacles.capacity());
                // The rotation as activated (a group body faces its forward, `NavGroups.InitBody`).
                t.boundary.write_agent_in(id.row(), desc.position, agents.rotation[id.row()], desc.up);
                true
            }
            Err(e) => {
                t.warnings.warn_text(format!("Navigation [{}]: agent not added: {e}", t.warnings.label()));
                false
            }
        },
        Command::RemoveAgent(id) => agents.remove(id),
        Command::SetDestination { agent, point } => {
            let Some(r) = agents.row(agent) else { return false };
            let d = &mut agents.data[r];
            chase::stop(d);
            d.path_request = PathRequest { start: Float3::default(), goal: point, urgent: true, start_from_current_position: true };
            d.path_request_enabled = true;
            true
        }
        Command::Chase { agent, target, repath_distance } => {
            let Some(r) = agents.row(agent) else { return false };
            chase::start(&mut agents.data[r], target, repath_distance);
            true
        }
        Command::StopChase(agent) => {
            let Some(r) = agents.row(agent) else { return false };
            chase::stop(&mut agents.data[r]);
            true
        }
        Command::Stop(agent) => {
            let Some(r) = agents.row(agent) else { return false };
            stop(agents, r);
            true
        }
        Command::Warp { agent, point } => {
            let Some(r) = agents.row(agent) else { return false };
            warp(agents, r, point);
            true
        }
        Command::JoinGroup { agent, group } => {
            let (Some(r), Some(g)) = (agents.row(agent), agents.row(group)) else { return false };
            if agents.data[g].group.is_none() || r == g {
                return false;
            }
            let d = &mut agents.data[r];
            d.group_member = Some(NavGroupMember { group, slot: -1, enabled: true });
            d.path_request_enabled = false; // the group plans; a goal left on it would send it off alone when it leaves
            true
        }
        Command::LeaveGroup { agent, goal } => {
            let Some(r) = agents.row(agent) else { return false };
            let d = &mut agents.data[r];
            let Some(m) = d.group_member.as_mut().filter(|m| m.enabled) else { return false };
            m.enabled = false;
            d.group_joiner = false; // doesn't walk straight back in
            // A member that fell behind may have asked for a way back to its slot: it mustn't go there on its own.
            d.path_request_enabled = false;
            if let Some(goal) = goal {
                d.path_request = PathRequest { start: Float3::default(), goal, urgent: false, start_from_current_position: true };
                d.path_request_enabled = true;
            }
            true
        }
        Command::SetGroupJoining { agent, joining } => {
            let Some(r) = agents.row(agent) else { return false };
            agents.data[r].group_joiner = joining;
            true
        }
        Command::SetGroupMask { group, mask } => {
            let Some(g) = agents.row(group) else { return false };
            let Some(gd) = agents.data[g].group.as_deref_mut() else { return false };
            if mask.is_some() {
                gd.group.formation = crate::components::NavFormationPreset::Mask;
            }
            gd.formation = mask;
            true
        }
        Command::SetGate { id, open } => {
            t.chunks.gates.set(id, open);
            true
        }
        Command::SetAreaCost { agent, area, cost, excluded } => {
            let Some(r) = agents.row(agent) else { return false };
            upsert_cost(&mut agents.data[r].area_costs, area, cost, excluded);
            true
        }
        Command::ClearAreaCosts(agent) => {
            let Some(r) = agents.row(agent) else { return false };
            agents.data[r].area_costs.clear();
            true
        }
        Command::SetWorldAreaCost { area, cost, excluded } => {
            upsert_cost(t.world_area_costs, area, cost, excluded);
            true
        }
        Command::SetSpeed { agent, speed, turn_speed } => {
            let Some(r) = agents.row(agent) else { return false };
            let d = &mut agents.data[r];
            if let Some(w) = &mut d.walk {
                w.speed_override = speed;
                w.turn_speed_override = turn_speed;
            }
            if let Some(f) = &mut d.flight {
                f.speed_override = speed;
                f.turn_speed_override = turn_speed;
            }
            true
        }
        Command::AddObstacle { id, obstacle, position } => {
            if !t.obstacles.activate(id, obstacle, position) {
                return false;
            }
            t.boundary.fit(agents.capacity(), t.obstacles.capacity());
            t.boundary.write_obstacle_in(id.row(), position, Float3::new(0.0, 1.0, 0.0));
            true
        }
        Command::RemoveObstacle(id) => t.obstacles.remove(id),
        Command::SetTargetSurround { target, surround } => {
            let tg = t.targets.entry(target);
            tg.surround = surround;
            if surround.is_none() {
                tg.holders.clear();
            }
            true
        }
        Command::SetFlowGoal { target, goal } => {
            t.targets.entry(target).flow_goal = goal;
            true
        }
        Command::RemoveTarget(target) => t.targets.remove(target),
    }
}

/// `Stop`: no request, no chase, no path; the agent stands where it is.
fn stop(agents: &mut AgentStore, r: usize) {
    let d = &mut agents.data[r];
    chase::stop(d);
    d.path_request_enabled = false;
    if let Some(w) = d.walker.as_deref_mut() {
        w.path.count = 0;
        w.path.next_index = 0;
        w.path.state = NavPathState::None;
        w.elements.clear();
        w.corridor.clear();
    }
    if let Some(f) = d.flyer.as_deref_mut() {
        f.path.count = 0;
        f.path.next_index = 0;
        f.path.state = NavPathState::None;
        f.points.clear();
    }
    if let Some(route) = d.route.as_deref_mut() {
        route.legs.clear();
        route.route.leg = 0;
        route.route.state = Default::default();
        route.search_requested = false;
    }
    if let Some(cr) = d.chunk_route.as_deref_mut() {
        cr.route.active = false;
        cr.legs.clear();
        cr.flight_search_requested = false;
    }
    agents.velocity[r] = Float3::default();
    agents.desired[r] = Float3::default();
    agents.steered[r] = Float3::default();
    agents.steering[r] = false;
}

/// `Warp`: moves the agent; its surface and chunk are worked out again, and an agent that had somewhere to go asks for
/// a path there from its new place.
fn warp(agents: &mut AgentStore, r: usize, point: Float3) {
    agents.position[r] = point;
    agents.surface[r].initialized = false;
    agents.chunk[r] = Default::default();
    agents.chunk_pending[r] = true;
    agents.velocity[r] = Float3::default();
    let d = &mut agents.data[r];
    let goal = match (d.walker.as_deref(), d.flyer.as_deref()) {
        (Some(w), _) if matches!(w.path.state, NavPathState::Following | NavPathState::Partial) => Some(w.path.goal),
        (_, Some(f)) if matches!(f.path.state, NavPathState::Following | NavPathState::Partial) => Some(f.path.goal),
        _ => None,
    };
    if let Some(w) = d.walker.as_deref_mut() {
        w.path.count = 0;
        w.path.next_index = 0;
        w.elements.clear();
        w.corridor.clear();
        w.progress.stuck_time = -1.0;
    }
    if let Some(f) = d.flyer.as_deref_mut() {
        f.path.count = 0;
        f.path.next_index = 0;
        f.points.clear();
    }
    if let (Some(goal), None) = (goal, d.goal_target) {
        if !d.path_request_enabled {
            d.path_request = PathRequest { start: Float3::default(), goal, urgent: true, start_from_current_position: true };
            d.path_request_enabled = true;
        }
    }
}
