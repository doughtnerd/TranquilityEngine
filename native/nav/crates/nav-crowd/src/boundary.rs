//! The WASM boundary's data side (designed here, bound with `wasm-bindgen` in `nav-wasm` later; ADR 0065's
//! *Boundary*: no per-agent call crosses it in the hot path).
//!
//! # Buffers
//!
//! Flat `f32`/`u8` buffers in the crowd's memory that the TS side views directly (`Float32Array` / `Uint8Array` over
//! WASM memory). Every per-agent buffer is indexed by **row** = the agent's slot index ([`crate::ids::AgentId::row`]),
//! times the stride; rows of free slots hold stale data and are ignored. Rows never move while an agent lives.
//!
//! | buffer | written by | stride | layout per row |
//! |---|---|---|---|
//! | [`Boundary::agents_in`] | host, before `tick` | [`AGENT_IN_STRIDE`] = 10 | position xyz, rotation quaternion xyzw, up xyz |
//! | [`Boundary::agents_out`] | crowd, end of `tick` | [`AGENT_OUT_STRIDE`] = 17 | position xyz, rotation xyzw, up xyz, velocity xyz, desired velocity xyz, remaining distance |
//! | [`Boundary::agent_state`] | crowd, end of `tick` | [`AGENT_STATE_STRIDE`] = 4 | path state ([`crate::components::NavPathState`]), mode ([`crate::components::NavMotionMode`]), flags ([`state_flags`]), kind ([`crate::agents::AgentKind`]) |
//! | [`Boundary::obstacles_in`] | host, before `tick` | [`OBSTACLE_IN_STRIDE`] = 6 | position xyz, up xyz |
//!
//! Each tick: the host writes `agents_in` for every live agent (its node's world transform; `engine.NavSync`) and
//! `obstacles_in`; `tick` reads them into the agent columns **before** applying commands (so `warp` wins over the
//! transform), runs, and writes `agents_out` and `agent_state` for every live agent; the host copies positions,
//! up-vectors and rotations back to nodes whose `updatePosition` / `updateRotation` are on (`engine.NavWriteBack`).
//! An agent's output position is its input position when the crowd didn't move it.
//!
//! The buffers grow when the slot tables do; [`Boundary::epoch`] changes then (and WASM memory growth detaches views
//! anyway), so the host re-creates its views when it sees a new epoch.
//!
//! # Commands and state
//!
//! Commands ([`crate::commands::Command`]) are queued by calls and applied in order at the start of the next tick.
//! Read-only state the API polls (`NavAgent.pathState`, `mode`, `remainingDistance`, `velocity`) is in the buffers
//! above; anything bigger is a call that returns into a scratch buffer: [`crate::Crowd::path_waypoints_flat`].
use crate::agents::{AgentKind, AgentStore};
use crate::components::{NavMotionMode, NavPathState, NavRouteState};
use crate::world::Obstacles;
use nav_math::{Float3, Float4};

pub const AGENT_IN_STRIDE: usize = 10;
pub const AGENT_OUT_STRIDE: usize = 17;
pub const AGENT_STATE_STRIDE: usize = 4;
pub const OBSTACLE_IN_STRIDE: usize = 6;
/// [`crate::Crowd::path_waypoints_flat`]: position xyz, normal xyz, flags (`NavMeshWaypointFlags` bits, as f32).
pub const WAYPOINT_STRIDE: usize = 7;

/// Bits of the flags byte in [`Boundary::agent_state`].
pub mod state_flags {
    /// `NavSteering` on: avoidance chose the velocity.
    pub const STEERING: u8 = 1 << 0;
    /// No chunk entry: the agent waits for its chunk (nothing runs for it).
    pub const PAUSED: u8 = 1 << 1;
    /// Chasing a target.
    pub const CHASING: u8 = 1 << 2;
    /// A group member (`NavGroupMember` on).
    pub const GROUP_MEMBER: u8 = 1 << 3;
    /// A path request is waiting to be served.
    pub const REQUEST_PENDING: u8 = 1 << 4;
    /// A group body.
    pub const GROUP_BODY: u8 = 1 << 5;
}

/// The buffers (see the module doc).
#[derive(Clone, Debug, Default)]
pub struct Boundary {
    pub agents_in: Vec<f32>,
    pub agents_out: Vec<f32>,
    pub agent_state: Vec<u8>,
    pub obstacles_in: Vec<f32>,
    pub epoch: u32,
}

/// One agent's read-only state, for the API ([`crate::Crowd::agent_state`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AgentState {
    pub kind: AgentKind,
    pub path_state: NavPathState,
    pub mode: NavMotionMode,
    pub flags: u8,
    pub position: Float3,
    pub rotation: Float4,
    pub up: Float3,
    pub velocity: Float3,
    pub desired_velocity: Float3,
    pub remaining_distance: f32,
    /// The chunk it is on (invalid while it has none) and its entry (-1: paused).
    pub chunk: nav_math::Hash128,
    pub entry: i32,
}

impl Boundary {
    /// Grows the buffers to the slot tables' capacities; bumps the epoch if anything grew.
    pub fn fit(&mut self, agents: usize, obstacles: usize) {
        let mut grew = false;
        if self.agents_in.len() < agents * AGENT_IN_STRIDE {
            let old = self.agents_in.len() / AGENT_IN_STRIDE;
            self.agents_in.resize(agents * AGENT_IN_STRIDE, 0.0);
            for r in old..agents {
                self.agents_in[r * AGENT_IN_STRIDE + 6] = 1.0; // identity rotation
                self.agents_in[r * AGENT_IN_STRIDE + 8] = 1.0; // up = +y
            }
            self.agents_out.resize(agents * AGENT_OUT_STRIDE, 0.0);
            self.agent_state.resize(agents * AGENT_STATE_STRIDE, 0);
            grew = true;
        }
        if self.obstacles_in.len() < obstacles * OBSTACLE_IN_STRIDE {
            self.obstacles_in.resize(obstacles * OBSTACLE_IN_STRIDE, 0.0);
            grew = true;
        }
        if grew {
            self.epoch = self.epoch.wrapping_add(1);
        }
    }

    /// Writes one agent's input row (what the host does through its view; also used when an agent is added, so its
    /// first tick reads the position it was added at).
    pub fn write_agent_in(&mut self, row: usize, position: Float3, rotation: Float4, up: Float3) {
        let o = row * AGENT_IN_STRIDE;
        let b = &mut self.agents_in[o..o + AGENT_IN_STRIDE];
        b.copy_from_slice(&[position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, up.x, up.y, up.z]);
    }

    /// Writes one obstacle's input row.
    pub fn write_obstacle_in(&mut self, row: usize, position: Float3, up: Float3) {
        let o = row * OBSTACLE_IN_STRIDE;
        self.obstacles_in[o..o + OBSTACLE_IN_STRIDE].copy_from_slice(&[position.x, position.y, position.z, up.x, up.y, up.z]);
    }

    /// Start of a tick: live agents' transforms and obstacles' positions into the columns.
    pub fn read_in(&self, agents: &mut AgentStore, obstacles: &mut Obstacles) {
        for r in agents.live_rows().collect::<Vec<_>>() {
            let o = r * AGENT_IN_STRIDE;
            let Some(b) = self.agents_in.get(o..o + AGENT_IN_STRIDE) else { continue };
            agents.position[r] = Float3::new(b[0], b[1], b[2]);
            agents.rotation[r] = Float4::new(b[3], b[4], b[5], b[6]);
            agents.up[r] = Float3::new(b[7], b[8], b[9]);
        }
        for r in obstacles.live_rows().collect::<Vec<_>>() {
            let o = r * OBSTACLE_IN_STRIDE;
            let Some(b) = self.obstacles_in.get(o..o + OBSTACLE_IN_STRIDE) else { continue };
            obstacles.position[r] = Float3::new(b[0], b[1], b[2]);
            obstacles.up[r] = Float3::new(b[3], b[4], b[5]);
        }
    }

    /// End of a tick: every live agent's output row and state bytes. The input row gets the output transform too, so
    /// a host that doesn't rewrite an agent's input (its node didn't move otherwise) feeds back what the crowd wrote.
    pub fn write_out(&mut self, agents: &AgentStore) {
        for r in agents.live_rows() {
            let s = agent_state(agents, r);
            let o = r * AGENT_OUT_STRIDE;
            let (p, q, u, v, d) = (s.position, s.rotation, s.up, s.velocity, s.desired_velocity);
            self.agents_out[o..o + AGENT_OUT_STRIDE].copy_from_slice(&[
                p.x,
                p.y,
                p.z,
                q.x,
                q.y,
                q.z,
                q.w,
                u.x,
                u.y,
                u.z,
                v.x,
                v.y,
                v.z,
                d.x,
                d.y,
                d.z,
                s.remaining_distance,
            ]);
            let o = r * AGENT_STATE_STRIDE;
            self.agent_state[o..o + AGENT_STATE_STRIDE].copy_from_slice(&[s.path_state as u8, s.mode as u8, s.flags, s.kind as u8]);
            self.write_agent_in(r, p, q, u);
        }
    }
}

/// An agent's read-only state from its columns and record (see [`AgentState`]). `row` must be live.
pub fn agent_state(agents: &AgentStore, r: usize) -> AgentState {
    let d = &agents.data[r];
    let (path_state, mode) = match d.kind {
        AgentKind::WalkFly => {
            let route = d.route.as_deref().map(|x| x.route).unwrap_or_default();
            let state = match route.state {
                NavRouteState::None => NavPathState::None,
                NavRouteState::Following => NavPathState::Following,
                NavRouteState::Partial => NavPathState::Partial,
                NavRouteState::Arrived => NavPathState::Arrived,
                NavRouteState::Failed => NavPathState::Failed,
            };
            (state, route.mode)
        }
        AgentKind::Flyer => (d.flyer.as_deref().map_or(NavPathState::None, |f| f.path.state), NavMotionMode::Flying),
        _ => (d.walker.as_deref().map_or(NavPathState::None, |w| w.path.state), NavMotionMode::Walking),
    };
    let chunk = agents.chunk[r];
    let mut flags = 0u8;
    if agents.steering[r] {
        flags |= state_flags::STEERING;
    }
    if chunk.entry < 0 {
        flags |= state_flags::PAUSED;
    }
    if d.goal_target.is_some() {
        flags |= state_flags::CHASING;
    }
    if d.group_member.is_some_and(|m| m.enabled) {
        flags |= state_flags::GROUP_MEMBER;
    }
    if d.path_request_enabled {
        flags |= state_flags::REQUEST_PENDING;
    }
    if d.group.is_some() {
        flags |= state_flags::GROUP_BODY;
    }
    AgentState {
        kind: d.kind,
        path_state,
        mode,
        flags,
        position: agents.position[r],
        rotation: agents.rotation[r],
        up: agents.up[r],
        velocity: agents.velocity[r],
        desired_velocity: agents.desired[r],
        remaining_distance: remaining_distance(agents, r, mode),
        chunk: chunk.chunk,
        entry: chunk.entry,
    }
}

/// Distance left along the current path: to the next waypoint, then waypoint to waypoint to the end (0 with no path).
/// Walk-and-fly agents: along the current leg's path only (the route's later legs aren't counted).
pub fn remaining_distance(agents: &AgentStore, r: usize, mode: NavMotionMode) -> f32 {
    let d = &agents.data[r];
    let p = agents.position[r];
    let flying = matches!(mode, NavMotionMode::Flying | NavMotionMode::TakingOff | NavMotionMode::Landing) && d.kind.flies();
    if flying || d.kind == AgentKind::Flyer {
        let Some(f) = d.flyer.as_deref() else { return 0.0 };
        let (next, count) = (f.path.next_index.max(0) as usize, (f.path.count.max(0) as usize).min(f.points.len()));
        if next >= count {
            return 0.0;
        }
        let mut total = (f.points[next] - p).length();
        for i in next + 1..count {
            total += (f.points[i] - f.points[i - 1]).length();
        }
        return total;
    }
    let Some(w) = d.walker.as_deref() else { return 0.0 };
    let (next, count) = (w.path.next_index.max(0) as usize, (w.path.count.max(0) as usize).min(w.elements.len()));
    if next >= count {
        return 0.0;
    }
    let from = if agents.surface[r].initialized { agents.surface[r].surface_position } else { p };
    let mut total = (w.elements[next].position - from).length();
    for i in next + 1..count {
        total += (w.elements[i].position - w.elements[i - 1].position).length();
    }
    total
}
