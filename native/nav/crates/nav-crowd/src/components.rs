//! Foxfire's agent components (`Runtime/Components`), as plain Rust structs with the same fields (snake_case) and
//! meanings. What changes:
//!
//! * **Entities become handles.** `Entity` fields name an [`AgentId`] (agents, group bodies), a [`TargetRef`] (what is
//!   chased: an agent or a host target) or an index into a pool (search entities).
//! * **Blob references.** Settings blobs are `Arc`s shared per agent type ([`crate::settings`]). Baked-data blobs
//!   (`BlobAssetReference<NavMeshBlob>` on a path, a route, a search) become a [`DataKey`]: the identity of the
//!   navmesh or volume of a [`crate::chunks::ChunkWorld`] snapshot entry. Foxfire compares blob pointers to notice
//!   "rebaked or replaced"; a snapshot here is rebuilt from copies, so a content-derived key stands in.
//! * **Enableable components** become a `bool` beside the value (`*_enabled`), or an `Option` where the component is
//!   added and removed rather than toggled.
//! * **Dynamic buffers** become `Vec`s on the agent's record ([`crate::agents::AgentData`]).
//! * **Structure of arrays.** The components the per-frame loops stream through (transform, velocities, steering,
//!   the surface, the chunk) aren't here: they are columns of [`crate::agents::AgentStore`].
use crate::ids::{AgentId, TargetId, TargetRef};
use crate::settings::{NavAvoidance, NavFlightAgent, NavMeshAgent};
use nav_format::blob::NavFormationData;
use nav_math::{Float3, Hash128};
use nav_query::pathfinding::{NavMeshAStar, NavPathStatus};
use nav_query::route_search::{NavChunkRouteEnd, NavRouteAStar, NavRouteLeg};
use nav_query::straight_path::NavMeshWaypointFlags;
use nav_query::volume::{NavFlightAStar, NavVolumeQueryFilter};
use std::sync::Arc;

pub use nav_query::filter::AreaCostOverride as NavMeshAgentAreaCost;
pub use nav_query::route_search::NavRouteLegKind;
pub use nav_query::routing::NavChunkLeg;

/// The identity of the navmesh or flight volume something was computed on (stands in for a blob reference, see the
/// module doc). 0 = none. [`crate::chunks::ChunkWorld::nav_key`] / `volume_key` give an entry's current one.
pub type DataKey = u64;

// ---------------------------------------------------------------------------------------------------------------------
// What an agent is
// ---------------------------------------------------------------------------------------------------------------------

/// `NavMeshAgentConfig`: a walker's type settings and its own overrides.
#[derive(Clone, Debug)]
pub struct NavMeshAgentConfig {
    pub settings: Arc<NavMeshAgent>,
    /// 0 = the type's speed.
    pub speed_override: f32,
    /// 0 = the type's turn speed.
    pub turn_speed_override: f32,
}

impl NavMeshAgentConfig {
    pub fn new(settings: Arc<NavMeshAgent>) -> Self {
        Self { settings, speed_override: 0.0, turn_speed_override: 0.0 }
    }
    #[inline]
    pub fn speed(&self) -> f32 {
        if self.speed_override > 0.0 { self.speed_override } else { self.settings.speed }
    }
    #[inline]
    pub fn turn_speed(&self) -> f32 {
        if self.turn_speed_override > 0.0 { self.turn_speed_override } else { self.settings.turn_speed }
    }
}

/// `NavFlightAgentConfig`: a flyer's type settings and its own overrides.
#[derive(Clone, Debug)]
pub struct NavFlightAgentConfig {
    pub settings: Arc<NavFlightAgent>,
    pub speed_override: f32,
    pub turn_speed_override: f32,
}

impl NavFlightAgentConfig {
    pub fn new(settings: Arc<NavFlightAgent>) -> Self {
        Self { settings, speed_override: 0.0, turn_speed_override: 0.0 }
    }
    #[inline]
    pub fn speed(&self) -> f32 {
        if self.speed_override > 0.0 { self.speed_override } else { self.settings.speed }
    }
    #[inline]
    pub fn turn_speed(&self) -> f32 {
        if self.turn_speed_override > 0.0 { self.turn_speed_override } else { self.settings.turn_speed }
    }
    /// `Effective()`: the type's settings with this agent's overrides applied.
    pub fn effective(&self) -> NavFlightAgent {
        let mut s = *self.settings;
        s.speed = self.speed();
        s.turn_speed = self.turn_speed();
        s
    }
}

/// `NavAvoidanceConfig`: the type's avoidance settings; present = the walker avoids. Per-agent layer and priority
/// overrides (ADR 0065's `NavAgent` fields) replace the `Arc` with the agent's own copy.
#[derive(Clone, Debug)]
pub struct NavAvoidanceConfig {
    pub settings: Arc<NavAvoidance>,
}

/// `NavMeshAgentSurface`: where the walker touches the navmesh (its node sits `pivot_offset` above it along `up`).
/// A column of [`crate::agents::AgentStore`]; `NavMeshAgentSurfacePending` is `!initialized`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavMeshAgentSurface {
    pub surface_position: Float3,
    pub up: Float3,
    /// False: derived from the transform on the first update.
    pub initialized: bool,
}

/// `PathRequest` (enableable: [`crate::agents::AgentData::path_request_enabled`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PathRequest {
    pub start: Float3,
    pub goal: Float3,
    /// Served before other waiting requests when every search is busy.
    pub urgent: bool,
    /// Ignore `start` and use the agent's position.
    pub start_from_current_position: bool,
}

/// `PathGoalTarget`: chase a target; the goal follows it and the path is redone when it moves `repath_distance`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PathGoalTarget {
    pub target: TargetRef,
    pub repath_distance: f32,
}

/// `NavChase.DefaultRepathDistance`.
pub const DEFAULT_CHASE_REPATH_DISTANCE: f32 = 50.0;

/// `NavPathState`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavPathState {
    /// No path requested yet.
    #[default]
    None = 0,
    /// Full path to the goal.
    Following = 1,
    /// Goal unreachable; the path ends at the closest reachable point (retried on the repath interval).
    Partial = 2,
    Arrived = 3,
    /// Start or goal off the navmesh (retried on the repath interval).
    Failed = 4,
}

/// `NavPath`: a walker's current segment (prev -> next) and what the path was computed for. The full path is
/// [`crate::agents::WalkerData::elements`].
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavPath {
    pub computed_time: f64,
    /// The navmesh it was computed on (repath if it changes).
    pub nav: DataKey,
    pub next_index: i32,
    pub count: i32,
    pub prev: Float3,
    pub prev_normal: Float3,
    pub next: Float3,
    pub next_normal: Float3,
    /// `prev_flags` has `FOLD_OVER_EDGE`: the outside corner prev -> next pivots around.
    pub hinge: Float3,
    pub goal: Float3,
    pub state: NavPathState,
    pub prev_flags: NavMeshWaypointFlags,
    pub next_flags: NavMeshWaypointFlags,
}

impl NavPath {
    /// `NavMeshAgentUtility.SetSegment`: points the path at the segment ending at waypoint `next`.
    pub fn set_segment(&mut self, elements: &[PathElement], next: usize) {
        let n = elements[next];
        let p = elements[next.saturating_sub(1)];
        self.next_index = next as i32;
        self.prev = p.position;
        self.prev_normal = p.normal;
        self.prev_flags = p.flags;
        self.next = n.position;
        self.next_normal = n.normal;
        self.next_flags = n.flags;
        self.hinge = p.hinge;
    }

    /// `IsJumpSegment`.
    pub fn is_jump_segment(&self) -> bool {
        self.next_index < self.count
            && self.prev_flags.intersects(NavMeshWaypointFlags::JUMP_START)
            && self.next_flags.intersects(NavMeshWaypointFlags::JUMP_LAND)
    }

    /// `IsFoldSegment`.
    pub fn is_fold_segment(&self) -> bool {
        if self.next_index >= self.count || self.is_jump_segment() {
            return false;
        }
        let flagged = self.prev_flags.intersects(NavMeshWaypointFlags::FOLD_ENTER) && self.next_flags.intersects(NavMeshWaypointFlags::FOLD_EXIT);
        flagged || self.prev_normal.dot(self.next_normal) < 0.985
    }
}

/// `PathElement`: one waypoint of the straightened path (index 0 is the start).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PathElement {
    pub position: Float3,
    pub normal: Float3,
    pub poly: i32,
    pub flags: NavMeshWaypointFlags,
    pub hinge: Float3,
}

/// `NavPathProgress`: progress towards the current waypoint, for skipping it when stuck.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavPathProgress {
    pub target: Float3,
    pub closest_distance: f32,
    /// Seconds without progress; -1 = start over on the next update.
    pub stuck_time: f32,
}

impl NavPathProgress {
    /// `Struggling`: stuck long enough that avoidance should head straight for the waypoint.
    pub fn struggling(&self, agent: &NavMeshAgent) -> bool {
        agent.stuck_skip_time > 0.0 && self.stuck_time >= 0.5 * agent.stuck_skip_time
    }
}

/// `NavCorridor`: one polygon of the path's corridor, the distance along it to where the path enters, and the lanes
/// of the portal it is entered by (congestion reservations).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavCorridor {
    pub poly: i32,
    pub distance: f32,
    pub lanes: f32,
}

/// `NavCorridorCursor`: the corridor index of the polygon the agent is in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavCorridorCursor {
    pub index: i32,
}

/// `NavMotionState`: where the agent is in its easing. A column of [`crate::agents::AgentStore`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavMotionState {
    pub elapsed: f32,
    pub scale: f32,
}

impl Default for NavMotionState {
    fn default() -> Self {
        Self { elapsed: 0.0, scale: 1.0 }
    }
}

/// `NavAvoidanceState`: the polygon under the agent, tracked while it steers (-1 until found).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavAvoidanceState {
    pub poly: i32,
}

impl Default for NavAvoidanceState {
    fn default() -> Self {
        Self { poly: -1 }
    }
}

/// `NavAvoidanceNeighbor`: an agent or obstacle found at the last full neighbour search (the Verlet list).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavAvoidanceNeighbor {
    Agent(AgentId),
    Obstacle(crate::ids::ObstacleId),
}

/// `NavAgentChunk`: the chunk an agent is on and its entry in this tick's snapshot (-1 while it has none: it pauses).
/// A column of [`crate::agents::AgentStore`]; `NavAgentChunkPending` is the `chunk_pending` column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavAgentChunk {
    pub chunk: Hash128,
    pub entry: i32,
}

impl Default for NavAgentChunk {
    fn default() -> Self {
        Self { chunk: Hash128::default(), entry: -1 }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Flyers
// ---------------------------------------------------------------------------------------------------------------------

/// `FlyPath`: a flyer's path state; the points are [`crate::agents::FlyerData::points`] (`FlyPathPoint`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FlyPath {
    pub computed_time: f64,
    /// The volume it was computed on (repath if it changes).
    pub volume: DataKey,
    pub next_index: i32,
    pub count: i32,
    /// > 0: overrides the type's arrival distance for this path (set by routes).
    pub arrival_distance: f32,
    pub goal: Float3,
    pub prev: Float3,
    pub next: Float3,
    pub state: NavPathState,
}

impl FlyPath {
    /// `SetSegment`.
    pub fn set_segment(&mut self, points: &[Float3], next: usize) {
        self.next_index = next as i32;
        self.prev = points[next.saturating_sub(1)];
        self.next = points[next];
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes (walk and fly; across chunks)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavRouteState`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavRouteState {
    #[default]
    None,
    Following,
    Partial,
    Arrived,
    Failed,
}

/// `NavMotionMode`: what a walk-and-fly agent is doing.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavMotionMode {
    #[default]
    Walking = 0,
    TakingOff = 1,
    Flying = 2,
    Landing = 3,
}

/// `NavRoute`: a walk-and-fly agent's route; its legs are [`crate::agents::RouteData::legs`] (`NavRouteLeg`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavRoute {
    pub computed_time: f64,
    pub nav: DataKey,
    pub volume: DataKey,
    /// The route search in progress (an index into the route search pool), if any.
    pub search: Option<u32>,
    pub leg: i32,
    /// The route graphs it was planned on.
    pub version: i32,
    pub flown_since_takeoff: f32,
    pub goal: Float3,
    pub last_position: Float3,
    pub transition_to: Float3,
    pub transition_up: Float3,
    pub state: NavRouteState,
    pub mode: NavMotionMode,
    pub leg_requested: bool,
    pub replan_pending: bool,
    pub to_edge: bool,
    pub planned: bool,
}

/// `NavRouteKey`: what walk-and-fly route searches are shared by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavRouteKey {
    /// Cells as (x, y, z) (`int3`; an array so the key hashes).
    pub start_cell: [i32; 3],
    pub goal_cell: [i32; 3],
    pub start_chunk: i32,
    pub settings: i32,
    pub flown: i32,
    /// Its agent's row + 1 when it has area costs of its own, else 0.
    pub unique: i32,
    pub mode: u8,
}

impl NavRouteKey {
    pub const START_CELL_SIZE: f32 = 32.0;
    pub const GOAL_CELL_SIZE: f32 = 16.0;
    pub const FLOWN_STEP: f32 = 10.0;

    pub fn shareable(&self) -> bool {
        self.unique == 0
    }
}

/// `NavRouteSearchRequestData` (its enabled bit: [`crate::agents::RouteData::search_requested`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavRouteSearchRequestData {
    pub key: NavRouteKey,
    pub goal: Float3,
    pub old_edge: Float3,
    pub waited: bool,
    pub urgent: bool,
}

/// `NavFlightRouteKey`: what fly-only route searches are shared by.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavFlightRouteKey {
    pub start_volume: i32,
    /// -1: the goal is in unloaded space.
    pub goal_volume: i32,
    pub goal_cell: [i32; 3],
}

impl NavFlightRouteKey {
    pub const CELL: f32 = 16.0;

    /// `Of`.
    pub fn of(start_volume: i32, goal_volume: i32, goal: Float3) -> Self {
        let c = Self::CELL;
        Self {
            start_volume,
            goal_volume,
            goal_cell: [(goal.x / c).floor() as i32, (goal.y / c).floor() as i32, (goal.z / c).floor() as i32],
        }
    }
}

/// `NavFlightRouteSearchRequestData` (its enabled bit: [`crate::agents::ChunkRouteData::flight_search_requested`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFlightRouteSearchRequestData {
    pub key: NavFlightRouteKey,
    pub goal: Float3,
    pub old_edge: Float3,
    pub ticket: u32,
    pub waited: bool,
}

/// `NavChunkRoute`: a walker's (or fly-only agent's) route across chunks; legs in
/// [`crate::agents::ChunkRouteData::legs`] (`NavChunkLeg`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavChunkRoute {
    pub leg: i32,
    pub version: i32,
    pub goal: Float3,
    pub active: bool,
    pub status: NavPathStatus,
    pub to_edge: bool,
    pub checked_on_overlay: bool,
}

// ---------------------------------------------------------------------------------------------------------------------
// Search entities (pooled; see crate::pool)
// ---------------------------------------------------------------------------------------------------------------------

/// `INavSearch`: a pooled search: whom it serves, and resetting it for a new agent (keeping its key-table stamp).
pub trait NavSearch: Default {
    fn agent(&self) -> AgentId;
    fn assign(&mut self, agent: AgentId);
}

/// `NavPathSearch`: a walker's navmesh search in progress.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavPathSearch {
    pub agent: AgentId,
    /// False: snap the ends and begin on the next step.
    pub located: bool,
    pub request_goal: Float3,
    pub request_start: Float3,
    pub from_current: bool,
    /// The navmesh it runs on (the agent's entry's), and the snapped ends.
    pub nav: DataKey,
    pub entry: i32,
    pub start_poly: i32,
    pub start: Float3,
    pub goal_poly: i32,
    pub goal: Float3,
    pub state: NavMeshAStar,
    pub stamp: u32,
    pub frames: i32,
}

impl NavSearch for NavPathSearch {
    fn agent(&self) -> AgentId {
        self.agent
    }
    fn assign(&mut self, agent: AgentId) {
        *self = Self { agent, stamp: self.stamp, ..Self::default() };
    }
}

/// `NavFlightSearch`: a flyer's volume search in progress.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFlightSearch {
    pub agent: AgentId,
    pub located: bool,
    /// The goal was under the free air: the search heads for the free air above it.
    pub below: bool,
    pub request_goal: Float3,
    pub request_start: Float3,
    pub from_current: bool,
    pub volume: DataKey,
    pub entry: i32,
    pub filter: NavVolumeQueryFilter,
    pub state: NavFlightAStar,
    pub stamp: u32,
    pub frames: i32,
}

impl NavSearch for NavFlightSearch {
    fn agent(&self) -> AgentId {
        self.agent
    }
    fn assign(&mut self, agent: AgentId) {
        *self = Self { agent, stamp: self.stamp, ..Self::default() };
    }
}

/// `NavRouteSearchPhase`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavRouteSearchPhase {
    #[default]
    Locate,
    Search,
    Landing,
}

/// `NavRouteSearch`: a walk-and-fly route search (per agent type pool); finished legs in `legs`, shared by `key`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavRouteSearch {
    pub agent: AgentId,
    pub key: NavRouteKey,
    pub phase: NavRouteSearchPhase,
    pub goal: Float3,
    pub old_edge: Float3,
    pub waited: bool,
    pub urgent: bool,
    /// The agent type has no route graphs: one chunk's navmesh, volume and links.
    pub within: bool,
    pub version: i32,
    pub own_graph: i32,
    pub nav: DataKey,
    pub volume: DataKey,
    pub mode: NavMotionMode,
    pub start: NavChunkRouteEnd,
    pub state: NavRouteAStar,
    pub stamp: u32,
    pub frames: i32,
    pub done: bool,
    pub status: NavPathStatus,
    pub at_edge: bool,
    pub done_time: f64,
    /// `NavRouteSearchLeg`.
    pub legs: Vec<NavRouteLeg>,
    /// `NavSearchAirFilter`: per volume of the graphs.
    pub air_filters: Vec<NavVolumeQueryFilter>,
}

impl NavSearch for NavRouteSearch {
    fn agent(&self) -> AgentId {
        self.agent
    }
    fn assign(&mut self, agent: AgentId) {
        let (stamp, mut legs, mut air) = (self.stamp, std::mem::take(&mut self.legs), std::mem::take(&mut self.air_filters));
        legs.clear();
        air.clear();
        *self = Self { agent, stamp, legs, air_filters: air, ..Self::default() };
    }
}

/// `NavFlightRouteSearch`: a fly-only route search across chunks; finished legs in `legs`, shared by `key`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavFlightRouteSearch {
    pub agent: AgentId,
    pub ticket: u32,
    pub key: NavFlightRouteKey,
    pub goal: Float3,
    pub old_edge: Float3,
    pub waited: bool,
    pub done: bool,
    pub status: NavPathStatus,
    pub at_edge: bool,
    pub done_time: f64,
    pub located: bool,
    pub version: i32,
    pub start: NavChunkRouteEnd,
    pub state: NavRouteAStar,
    pub stamp: u32,
    pub frames: i32,
    /// `NavFlightRouteSearchLeg`.
    pub legs: Vec<NavRouteLeg>,
}

impl NavSearch for NavFlightRouteSearch {
    fn agent(&self) -> AgentId {
        self.agent
    }
    fn assign(&mut self, agent: AgentId) {
        let (stamp, mut legs) = (self.stamp, std::mem::take(&mut self.legs));
        legs.clear();
        *self = Self { agent, stamp, legs, ..Self::default() };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------------------------------

/// `NavFormationPreset`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavFormationPreset {
    #[default]
    Box,
    Line,
    Column,
    Wedge,
    Circle,
    /// A painted shape: [`GroupData::formation`].
    Mask,
}

/// `NavGroupMode`.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NavGroupMode {
    #[default]
    Formation,
    Flock,
}

/// `NavGroup`: a group body's settings and the state its members steer by (the last block is written by the pace
/// step each tick).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavGroup {
    pub mode: NavGroupMode,
    pub formation: NavFormationPreset,
    pub spacing: f32,
    pub slack: f32,
    pub catch_up: f32,
    pub member_priority: i32,
    pub min_pace: f32,
    pub layers: i32,
    pub layer_spacing: f32,
    pub flock_radius: f32,
    pub flock_separation: f32,
    pub flock_alignment: f32,
    pub flock_cohesion: f32,
    pub surround: bool,
    pub squeeze: bool,
    pub swap_slots: bool,
    pub bend_columns: bool,
    pub turn_in_place: bool,
    pub pass_through_each_other: bool,
    pub accept_joiners: bool,
    pub join_distance: f32,
    pub same_goal_distance: f32,
    pub max_members: i32,
    pub merge: bool,
    pub merge_priority: i32,
    // Kept by the group steps.
    pub forward: Float3,
    pub velocity: Float3,
    pub previous_position: Float3,
    pub count: i32,
    pub columns: i32,
    pub shift: f32,
    pub next_squeeze: f64,
    pub next_swap: f64,
    pub turned_at: f64,
    pub cleared: f32,
}

impl Default for NavGroup {
    /// `NavGroup.Default()`.
    fn default() -> Self {
        Self {
            mode: NavGroupMode::Formation,
            formation: NavFormationPreset::Box,
            spacing: 3.0,
            slack: 4.0,
            catch_up: 2.0,
            member_priority: 20,
            min_pace: 0.25,
            layers: 1,
            layer_spacing: 0.0,
            flock_radius: 0.0,
            flock_separation: 1.5,
            flock_alignment: 1.0,
            flock_cohesion: 0.5,
            surround: true,
            squeeze: true,
            swap_slots: true,
            bend_columns: true,
            turn_in_place: true,
            pass_through_each_other: false,
            accept_joiners: true,
            join_distance: 4.0,
            same_goal_distance: 5.0,
            max_members: 100,
            merge: true,
            merge_priority: 50,
            forward: Float3::new(0.0, 0.0, 1.0),
            velocity: Float3::default(),
            previous_position: Float3::default(),
            count: 0,
            columns: 0,
            shift: 0.0,
            next_squeeze: 0.0,
            next_swap: 0.0,
            turned_at: 0.0,
            cleared: 0.0,
        }
    }
}

/// What a group body carries besides the walker/flyer components (`NavGroup` plus its buffers).
#[derive(Clone, Debug, Default)]
pub struct GroupData {
    pub group: NavGroup,
    /// `NavGroupMemberElement`: members in slot order.
    pub members: Vec<AgentId>,
    /// `NavGroupTrailPoint`: where the pivot has been, oldest first.
    pub trail: Vec<Float3>,
    /// `NavGroupFormation`: the painted shape (formation `Mask`).
    pub formation: Option<Arc<NavFormationData>>,
    /// `NavGroupMerged`: merged into this group (the body is then disabled).
    pub merged_into: Option<AgentId>,
}

/// `NavGroupMember` (enableable: `enabled`). Slot -1 until the group takes it in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavGroupMember {
    pub group: AgentId,
    pub slot: i32,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------------------------------------------------
// Surround, flow, obstacles, gates (on targets and the world)
// ---------------------------------------------------------------------------------------------------------------------

/// `NavSurround`: on a target, agents chasing it take slots around it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavSurround {
    pub radius: f32,
    pub spacing: f32,
    /// 0 = spacing.
    pub air_spacing: f32,
    pub claim_distance: f32,
    /// 1-1024 ground slots, and as many air slots.
    pub max_slots: i32,
}

impl Default for NavSurround {
    fn default() -> Self {
        Self { radius: 3.0, spacing: 3.0, air_spacing: 0.0, claim_distance: 30.0, max_slots: 64 }
    }
}

/// `NavSurroundSlot` (enableable: `enabled`): the slot an agent holds at a surround target.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavSurroundSlot {
    pub target: TargetRef,
    /// Within the ground or air slots.
    pub index: i16,
    pub air: bool,
    pub enabled: bool,
}

/// `NavFlowGoal`: on a target, agents chasing it follow one shared flow field per agent type.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFlowGoal {
    /// 0 = 2.
    pub move_threshold: f32,
}

/// `NavFlowAgent` (enableable: `enabled`): following a flow field.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavFlowAgent {
    /// The field: its goal's [`TargetRef`] key and agent type (`nav_query::flow::FlowFields::set`).
    pub goal: u64,
    pub version: i32,
    /// -1: its path doesn't end at an exit of the field.
    pub exit: i32,
    pub short: bool,
    pub searching: bool,
    pub enabled: bool,
}

/// `NavAvoidanceObstacle`: a cylinder avoiding agents steer around (centred on its position, along its up).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavAvoidanceObstacle {
    pub radius: f32,
    pub height: f32,
    pub layers: u32,
}

/// `NavAvoidanceObstacleState`: measured motion.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavAvoidanceObstacleState {
    pub previous_position: Float3,
    pub velocity: Float3,
    pub initialized: bool,
}

/// `NavGate`: a gate id and whether it is open (world state, see [`crate::gates`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavGate {
    pub id: Hash128,
    pub open: bool,
}

/// A target's key for the flow fields (`FlowGoal::id`): host targets and agents never collide.
pub fn target_key(t: TargetRef) -> u64 {
    match t {
        TargetRef::Target(TargetId(id)) => id as u64,
        TargetRef::Agent(a) => (1u64 << 63) | a.to_bits(),
    }
}
