//! Agent storage.
//!
//! # Layout
//!
//! Foxfire's agents are entities in archetype chunks, and its per-frame jobs stream through a few components of every
//! agent (transform, velocities, steering flags, surface, chunk entry). Here a [`AgentStore`] owns every agent:
//!
//! * **Rows.** An agent is a row: its [`AgentId`]'s slot index ([`crate::ids::SlotTable`]). Rows are stable for an
//!   agent's life (no swap-remove), so the host's per-agent buffers ([`crate::boundary`]) index by the same row, and a
//!   freed row is reused lowest first, keeping the arrays dense. Dead rows are skipped by `slots.row_live`.
//! * **Hot columns (structure of arrays).** What the per-frame loops read or write for every agent is a `Vec` per
//!   field: `position`, `rotation`, `up`, `velocity`, `desired` (`NavDesiredVelocity`), `steered`
//!   (`NavSteeredVelocity`), `steering` (`NavSteering`), `make_way` (`NavMakeWay`), `surface`
//!   (`NavMeshAgentSurface`), `motion` (`NavMotionState`), `chunk` (`NavAgentChunk`) and `chunk_pending`. The
//!   neighbour grid, avoidance and movement passes walk these columns linearly, as Foxfire's chunk iteration does, and
//!   the boundary copies are column-to-buffer loops.
//! * **Cold record.** Everything else an agent has is one [`AgentData`] per row: its configs (the `Arc`'d type
//!   settings), requests, and the variable-length buffers (path waypoints, corridor, fly path points, route legs,
//!   neighbours) as `Vec`s, with the kind-specific parts boxed ([`WalkerData`], [`FlyerData`], [`RouteData`],
//!   [`ChunkRouteData`], [`GroupData`]) so a walker doesn't carry a flyer's state. Vecs keep their capacity across
//!   repaths, so a path rewrite doesn't allocate once warmed up (Foxfire's capacity-0 heap buffers, same idea).
//!
//! Search entities (Foxfire's pooled `NavPathSearch` etc. entities) aren't agents: they live in the pools of the step
//! that runs them (`walkers.rs`, `flyers.rs`, `routes.rs`).
use crate::components::*;
use crate::ids::{AgentId, Handle, SlotState, SlotTable, TargetRef};
use crate::settings::{AgentTypeSettings, AgentTypes};
use nav_math::{Float3, Float4, Hash128};
use nav_query::route_search::NavRouteLeg;

/// What kind of agent a row is, from its type's abilities (and whether it's a group body).
#[repr(u8)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentKind {
    /// A free row.
    #[default]
    None = 0,
    /// Walks only (`NavMeshAgentConfig`).
    Walker = 1,
    /// Flies only (`NavFlightAgentConfig`).
    Flyer = 2,
    /// Walks and flies (`NavRoute`, hybrid routes).
    WalkFly = 3,
}

impl AgentKind {
    pub fn walks(self) -> bool {
        matches!(self, AgentKind::Walker | AgentKind::WalkFly)
    }
    pub fn flies(self) -> bool {
        matches!(self, AgentKind::Flyer | AgentKind::WalkFly)
    }
}

/// How the host adds an agent ([`crate::Crowd::add_agent`]).
#[derive(Clone, Debug)]
pub struct AgentDesc {
    pub agent_type: Hash128,
    pub position: Float3,
    /// Quaternion (x, y, z, w).
    pub rotation: Float4,
    pub up: Float3,
    /// `NavAgent.updatePosition`: the crowd writes the position back (off: the host moves the node from
    /// `desiredVelocity` itself).
    pub update_position: bool,
    /// `NavAgent.updateRotation`.
    pub update_rotation: bool,
    /// 0 = the type's.
    pub speed_override: f32,
    pub turn_speed_override: f32,
    /// Overrides the type's avoidance layer / mask / priority (None: the type's).
    pub avoidance_layers: Option<u32>,
    pub avoid_layers: Option<u32>,
    pub avoidance_priority: Option<i32>,
    pub area_costs: Vec<NavMeshAgentAreaCost>,
    /// Some: the agent is a group body ([`GroupData`]); its type gives the members' kind.
    pub group: Option<NavGroup>,
    /// A group body's painted shape (`NavGroups.SetMask`: `formations::create_mask`); its formation becomes `Mask`.
    pub group_mask: Option<std::sync::Arc<nav_format::blob::NavFormationData>>,
}

impl AgentDesc {
    pub fn new(agent_type: Hash128, position: Float3) -> Self {
        Self {
            agent_type,
            position,
            rotation: Float4::new(0.0, 0.0, 0.0, 1.0),
            up: Float3::new(0.0, 1.0, 0.0),
            update_position: true,
            update_rotation: true,
            speed_override: 0.0,
            turn_speed_override: 0.0,
            avoidance_layers: None,
            avoid_layers: None,
            avoidance_priority: None,
            area_costs: Vec::new(),
            group: None,
            group_mask: None,
        }
    }
}

/// A walker's path state and buffers (`NavPath`, `PathElement`, `NavPathProgress`, `NavCorridor`,
/// `NavCorridorCursor`).
#[derive(Clone, Debug, Default)]
pub struct WalkerData {
    pub path: NavPath,
    pub elements: Vec<PathElement>,
    pub progress: NavPathProgress,
    pub corridor: Vec<NavCorridor>,
    pub cursor: NavCorridorCursor,
    /// `NavAvoidanceState`.
    pub avoidance_state: NavAvoidanceState,
}

/// A flyer's path state (`FlyPath`, `FlyPathPoint`).
#[derive(Clone, Debug, Default)]
pub struct FlyerData {
    pub path: FlyPath,
    pub points: Vec<Float3>,
}

/// A walk-and-fly agent's route (`NavRoute`, `NavRouteLeg`, `NavWalking`, `NavFlying`, `NavRouteSearchRequest` and
/// its data).
#[derive(Clone, Debug, Default)]
pub struct RouteData {
    pub route: NavRoute,
    pub legs: Vec<NavRouteLeg>,
    /// `NavWalking` enabled.
    pub walking: bool,
    /// `NavFlying` enabled.
    pub flying: bool,
    /// `NavRouteSearchRequest` enabled.
    pub search_requested: bool,
    pub request: NavRouteSearchRequestData,
}

/// A walker's or fly-only agent's route across chunks (`NavChunkRoute`, `NavChunkLeg`, and for flyers
/// `NavFlightRouteSearchRequest` with its data).
#[derive(Clone, Debug, Default)]
pub struct ChunkRouteData {
    pub route: NavChunkRoute,
    pub legs: Vec<NavChunkLeg>,
    pub flight_search_requested: bool,
    pub flight_request: NavFlightRouteSearchRequestData,
}

/// Everything an agent has that the hot columns don't (see the module doc). `Default` is a free row.
#[derive(Clone, Debug, Default)]
pub struct AgentData {
    pub kind: AgentKind,
    /// `NavAgentTypeId`.
    pub agent_type: Hash128,
    pub update_position: bool,
    pub update_rotation: bool,
    /// Set while the agent is disabled (a merged group's body): no step touches it.
    pub disabled: bool,
    pub walk: Option<NavMeshAgentConfig>,
    pub flight: Option<NavFlightAgentConfig>,
    pub avoidance: Option<NavAvoidanceConfig>,
    /// `NavMeshAgentAreaCost`.
    pub area_costs: Vec<NavMeshAgentAreaCost>,
    pub path_request: PathRequest,
    pub path_request_enabled: bool,
    pub walker: Option<Box<WalkerData>>,
    pub flyer: Option<Box<FlyerData>>,
    pub route: Option<Box<RouteData>>,
    pub chunk_route: Option<Box<ChunkRouteData>>,
    /// `NavAvoidanceNeighbor`: the Verlet list.
    pub neighbours: Vec<NavAvoidanceNeighbor>,
    /// `PathGoalTarget`: chasing.
    pub goal_target: Option<PathGoalTarget>,
    /// `NavSurroundSlot`: added (off) by the first chase.
    pub surround_slot: Option<NavSurroundSlot>,
    /// `NavFlowAgent`: added (off) to chasing walkers and group bodies once any flow goal exists.
    pub flow_agent: Option<NavFlowAgent>,
    /// `NavGroupMember`.
    pub group_member: Option<NavGroupMember>,
    /// `NavGroupJoiner` enabled.
    pub group_joiner: bool,
    /// A group body's `NavGroup` and buffers.
    pub group: Option<Box<GroupData>>,
}

/// Every agent (see the module doc for the layout).
#[derive(Clone, Debug, Default)]
pub struct AgentStore {
    pub slots: SlotTable,
    // Hot columns, by row.
    pub position: Vec<Float3>,
    /// Quaternion (x, y, z, w).
    pub rotation: Vec<Float4>,
    pub up: Vec<Float3>,
    /// The velocity the agent moved by this tick (what `NavAgent.velocity` reads).
    pub velocity: Vec<Float3>,
    /// `NavDesiredVelocity`.
    pub desired: Vec<Float3>,
    /// `NavSteeredVelocity`.
    pub steered: Vec<Float3>,
    /// `NavSteering` enabled.
    pub steering: Vec<bool>,
    /// `NavMakeWay` enabled.
    pub make_way: Vec<bool>,
    pub surface: Vec<NavMeshAgentSurface>,
    pub motion: Vec<NavMotionState>,
    pub chunk: Vec<NavAgentChunk>,
    /// `NavAgentChunkPending` enabled.
    pub chunk_pending: Vec<bool>,
    /// The cold records.
    pub data: Vec<AgentData>,
    /// Bumped whenever the columns grow (the host's views of the boundary buffers must be renewed).
    pub capacity_epoch: u32,
}

impl AgentStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rows the columns have (live or not).
    pub fn capacity(&self) -> usize {
        self.slots.capacity()
    }

    /// Live agents.
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// True if `id` names a live agent.
    #[inline]
    pub fn is_live(&self, id: AgentId) -> bool {
        self.slots.is_live(id.0)
    }

    /// The live agent's row, or None for a stale or reserved handle.
    #[inline]
    pub fn row(&self, id: AgentId) -> Option<usize> {
        self.is_live(id).then(|| id.row())
    }

    /// The current handle of a live row.
    pub fn id_of(&self, row: usize) -> Option<AgentId> {
        self.slots.handle_of(row).map(AgentId)
    }

    /// Live rows, ascending.
    pub fn live_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.live_rows()
    }

    /// Live rows that aren't disabled, ascending (what the steps iterate).
    pub fn active_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.slots.live_rows().filter(move |&r| !self.data[r].disabled)
    }

    /// Hands out a row for an agent to be added (`Reserved`: live once [`AgentStore::activate`] runs, at the start
    /// of the next tick). Grows the columns if needed.
    pub fn reserve(&mut self) -> AgentId {
        let (h, grew) = self.slots.reserve();
        if grew {
            self.grow(self.slots.capacity());
        }
        AgentId(h)
    }

    fn grow(&mut self, n: usize) {
        self.position.resize(n, Float3::default());
        self.rotation.resize(n, Float4::new(0.0, 0.0, 0.0, 1.0));
        self.up.resize(n, Float3::new(0.0, 1.0, 0.0));
        self.velocity.resize(n, Float3::default());
        self.desired.resize(n, Float3::default());
        self.steered.resize(n, Float3::default());
        self.steering.resize(n, false);
        self.make_way.resize(n, false);
        self.surface.resize(n, NavMeshAgentSurface::default());
        self.motion.resize(n, NavMotionState::default());
        self.chunk.resize(n, NavAgentChunk::default());
        self.chunk_pending.resize(n, false);
        self.data.resize_with(n, AgentData::default);
        self.capacity_epoch = self.capacity_epoch.wrapping_add(1);
    }

    /// Makes a reserved row a live agent of `desc`'s type. Errors: stale/not reserved handle, unknown agent type, or a
    /// type that neither walks nor flies.
    pub fn activate(&mut self, id: AgentId, desc: &AgentDesc, types: &AgentTypes) -> Result<(), String> {
        if self.slots.state(id.0) != Some(SlotState::Reserved) {
            return Err(format!("{id} isn't waiting to be added"));
        }
        let Some(t) = types.get(desc.agent_type) else {
            self.slots.free(id.0);
            return Err(format!("{id}: unknown agent type {}", desc.agent_type));
        };
        let data = Self::make_data(desc, t)?;
        self.slots.activate(id.0);
        let r = id.row();
        self.position[r] = desc.position;
        // `NavGroups.InitBody`: a group body faces its group's level forward.
        self.rotation[r] = match data.group.as_deref() {
            Some(g) => crate::walkers::look_rotation_safe(g.group.forward, Float3::new(0.0, 1.0, 0.0)),
            None => desc.rotation,
        };
        self.up[r] = desc.up;
        self.velocity[r] = Float3::default();
        self.desired[r] = Float3::default();
        self.steered[r] = Float3::default();
        self.steering[r] = false;
        self.make_way[r] = false;
        self.surface[r] = NavMeshAgentSurface::default();
        self.motion[r] = NavMotionState::default();
        self.chunk[r] = NavAgentChunk::default();
        self.chunk_pending[r] = true;
        self.data[r] = data;
        Ok(())
    }

    fn make_data(desc: &AgentDesc, t: &AgentTypeSettings) -> Result<AgentData, String> {
        let kind = match (t.walk.is_some(), t.flight.is_some()) {
            (true, false) => AgentKind::Walker,
            (false, true) => AgentKind::Flyer,
            (true, true) => AgentKind::WalkFly,
            (false, false) => return Err(format!("agent type {} ({}) neither walks nor flies", t.name, t.id)),
        };
        let walk = t.walk.as_ref().map(|w| NavMeshAgentConfig {
            settings: w.clone(),
            speed_override: desc.speed_override,
            turn_speed_override: desc.turn_speed_override,
        });
        let flight = t.flight.as_ref().map(|f| {
            let mut settings = f.clone();
            if desc.avoidance_layers.is_some() || desc.avoid_layers.is_some() {
                let mut own = **f;
                own.layers = desc.avoidance_layers.unwrap_or(own.layers);
                own.avoid_layers = desc.avoid_layers.unwrap_or(own.avoid_layers);
                settings = std::sync::Arc::new(own);
            }
            NavFlightAgentConfig { settings, speed_override: desc.speed_override, turn_speed_override: desc.turn_speed_override }
        });
        // Group bodies carry no avoidance (members avoid; the body is virtual).
        let avoidance = if desc.group.is_some() {
            None
        } else {
            t.avoidance.as_ref().map(|a| {
                if desc.avoidance_layers.is_none() && desc.avoid_layers.is_none() && desc.avoidance_priority.is_none() {
                    return NavAvoidanceConfig { settings: a.clone() };
                }
                let mut own = **a;
                own.layers = desc.avoidance_layers.unwrap_or(own.layers);
                own.avoid_layers = desc.avoid_layers.unwrap_or(own.avoid_layers);
                own.priority = desc.avoidance_priority.unwrap_or(own.priority);
                NavAvoidanceConfig { settings: std::sync::Arc::new(own) }
            })
        };
        Ok(AgentData {
            kind,
            agent_type: t.id,
            update_position: desc.update_position,
            update_rotation: desc.update_rotation,
            walk,
            flight,
            avoidance,
            area_costs: desc.area_costs.clone(),
            group_joiner: t.join_groups && desc.group.is_none(),
            group: desc.group.map(|g| Box::new(init_body(g, desc))),
            // The structural part of Foxfire's setup systems (they add these on an agent's first update): a walker's
            // path components, a flyer's, a walk-and-fly agent's route (on the ground), and the cross-chunk route of
            // agents that only walk or only fly.
            walker: kind.walks().then(|| Box::new(WalkerData { progress: NavPathProgress { stuck_time: -1.0, ..Default::default() }, ..Default::default() })),
            flyer: kind.flies().then(Box::default),
            route: (kind == AgentKind::WalkFly).then(|| Box::new(RouteData { walking: true, ..Default::default() })),
            chunk_route: (kind != AgentKind::WalkFly).then(Box::default),
            ..AgentData::default()
        })
    }

    /// Frees an agent's row (reserved or live): every handle to it goes stale. Returns false if it was stale already.
    /// Doesn't touch other agents that name it (a member's group, a chaser's target): the steps treat stale handles as
    /// gone, as Foxfire's systems treat destroyed entities.
    pub fn remove(&mut self, id: AgentId) -> bool {
        if !self.slots.free(id.0) {
            return false;
        }
        let r = id.row();
        self.data[r] = AgentData::default();
        self.steering[r] = false;
        self.make_way[r] = false;
        self.chunk[r] = NavAgentChunk::default();
        self.chunk_pending[r] = false;
        self.velocity[r] = Float3::default();
        self.desired[r] = Float3::default();
        self.steered[r] = Float3::default();
        true
    }

    /// The position of what an agent chases, if it still exists: another agent's position, or a host target's.
    pub fn target_position(&self, target: TargetRef, targets: &crate::world::Targets) -> Option<Float3> {
        match target {
            TargetRef::Agent(a) => self.row(a).map(|r| self.position[r]),
            TargetRef::Target(t) => targets.get(t).map(|t| t.position),
        }
    }

    /// Handles of every live agent (for tests and the host).
    pub fn ids(&self) -> Vec<AgentId> {
        self.live_rows().map(|r| AgentId(Handle::new(r as u32, self.slots_generation(r)))).collect()
    }

    fn slots_generation(&self, row: usize) -> u32 {
        self.slots.handle_of(row).map_or(0, |h| h.generation)
    }
}

/// `NavGroups.InitBody`: the state every group body starts with: at its position, facing the group's level forward
/// (+z if it has none), not moving, nobody in it yet; with a painted shape, formation `Mask` (`NavGroups.SetMask`).
fn init_body(group: NavGroup, desc: &AgentDesc) -> GroupData {
    let mut g = group;
    g.previous_position = desc.position;
    g.forward = Float3::new(g.forward.x, 0.0, g.forward.z).normalize_safe(Float3::new(0.0, 0.0, 1.0));
    g.velocity = Float3::default();
    g.count = 0;
    if desc.group_mask.is_some() {
        g.formation = crate::components::NavFormationPreset::Mask;
    }
    GroupData { group: g, formation: desc.group_mask.clone(), ..GroupData::default() }
}
