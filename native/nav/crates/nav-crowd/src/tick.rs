//! The tick: Foxfire's per-frame system order, as one function ([`crate::Crowd::tick`]).
//!
//! The order comes from the C# `UpdateInGroup` / `UpdateAfter` / `UpdateBefore` attributes (all systems are in the
//! `SimulationSystemGroup`; `OrderFirst` ones first, `NavWarningSystem` last):
//!
//! | # | step | C# systems | module |
//! |---|---|---|---|
//! | 0 | read the buffers, apply commands, target and obstacle input | `engine.NavSync` (ADR 0065), `NavChase`, `NavGroups`, `NavGate` writes | [`crate::commands`] |
//! | 1 | gates, overlays, snapshot, seams | `NavGateSystem` (moved first, see `gates.rs`), `NavOverlaySystem` < `NavSeamSystem` (OrderFirst) | [`crate::chunks`] |
//! | 2 | agent chunks, agent-type check | `NavAgentChunkSystem` (OrderFirst, after seams), `NavAgentTypeCheckSystem` | [`crate::agent_chunk`] |
//! | 3 | route graphs | `NavRouteGraphSystem` (< `NavRouteSystem`) | [`crate::chunks`] |
//! | 4 | surround | `NavSurroundSystem` (< routes, < repath) | [`crate::surround`] |
//! | 5 | setup | `NavMeshAgentSetupSystem`, `NavVolumeAgentSetupSystem` (< repath) | [`crate::walkers`], [`crate::flyers`] |
//! | 6 | walk/fly routes; walk-fly group members | `NavRouteSystem` (after graphs, < both repaths); `NavGroupWalkFlyMemberSystem` (after routes) | [`crate::routes`], [`crate::groups`] |
//! | 7 | flow fields; flow agents | `NavFlowFieldSystem` (after graphs, < repath); `NavFlowAgentSystem` | [`crate::flow_fields`], [`crate::flow_agents`] |
//! | 8 | walkers: repath, chunk routes, path requests (flow followers served from their field), follow | `NavMeshRepathSystem` < `NavChunkRouteSystem` < `NavPathRequestSystem` (`NavFlowPathJob`) < `NavMeshPathFollowSystem` | [`crate::walkers`], [`crate::routes`], [`crate::flow_agents`] |
//! | 9 | flyers: repath, chunk flight routes, path requests, steering | `NavVolumeRepathSystem` < `NavChunkFlightRouteSystem` < `NavVolumePathRequestSystem` < `NavFlightSteeringSystem` | [`crate::flyers`], [`crate::routes`] |
//! | 10 | group member steering | `NavGroupMemberSteeringSystem` (after follow and flight steering, < neighbour grid) | [`crate::groups`] |
//! | 11 | neighbour grids | `NavNeighborGridSystem`, `NavFlightNeighborGridSystem` | [`crate::avoidance`] |
//! | 12 | avoidance, make way, flight separation | `NavAvoidanceSystem` (< move), `NavFlightSeparationSystem` | [`crate::avoidance`] |
//! | 13 | movement; group members' moves | `NavAgentMoveSystem`, `NavVolumeMoveSystem` (with `NavGroupMemberMoveJob`, `NavGroupFlyerMoveJob`) | [`crate::walkers`], [`crate::flyers`], [`crate::groups`] |
//! | 14 | group pace, merge | `NavGroupPaceSystem` (after both moves) < `NavGroupMergeSystem` | [`crate::groups`] |
//! | 15 | warnings, write the buffers | `NavWarningSystem` (OrderLast), `engine.NavWriteBack` | [`crate::warnings`], [`crate::boundary`] |
//!
//! Foxfire's gate system has no place relative to the chunk systems; it runs in step 1 here so a gate set this tick is
//! in this tick's snapshot. Easing (`NavMotionJobs`, `motion.rs`) runs inside following and flight steering, as in
//! Foxfire. `NavFlowFollowing.Update` runs as its own pass (step 7) rather than inside the repath job; see
//! `flow_agents.rs`.
use crate::chunks::{ChunkUpdate, ChunkWorld};
use crate::commands::CommandStats;
use crate::components::NavMeshAgentAreaCost;
use crate::settings::{AgentTypes, NavigationRuntimeSettings};

/// What every per-agent step reads about the tick and the world (immutable; each step gets its own mutable state,
/// the agents, and the warnings beside it).
pub struct Frame<'a> {
    pub dt: f32,
    pub time: f64,
    /// Ticks since the crowd was made (1 on the first).
    pub tick: u64,
    /// The snapshot (`world.snapshot()`), data keys, route graphs, seams, overlays and gates.
    pub world: &'a ChunkWorld,
    /// What the chunk steps did this tick.
    pub update: ChunkUpdate,
    pub types: &'a AgentTypes,
    pub runtime: &'a NavigationRuntimeSettings,
    /// World area cost overrides (`Navigation.setAreaCost`): every agent's filter takes these, then its own.
    pub world_area_costs: &'a [NavMeshAgentAreaCost],
}

/// What a tick did, for tests and the debug panel.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TickStats {
    pub tick: u64,
    pub commands: CommandStats,
    pub chunks: ChunkUpdate,
    pub agents: usize,
    /// Agents with no chunk entry (paused).
    pub paused: usize,
}
