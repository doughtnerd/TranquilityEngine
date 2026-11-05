//! The navigation runtime (ADR 0065's `nav-crowd`): Foxfire.Navigation's agents and per-frame systems as one
//! [`Crowd`] the host ticks.
//!
//! * **Storage** ([`agents`], [`components`], [`settings`], [`ids`]): agents in an index + generation slot table,
//!   hot per-frame fields as columns (structure of arrays), the rest of each agent's components in a per-row record;
//!   agent type settings shared as `Arc`s.
//! * **Boundary** ([`boundary`], [`commands`], [`world`]): flat transform buffers in and out (strides documented) that
//!   the TS side views directly, a command queue applied at the start of a tick, read-only per-agent state. Pure Rust;
//!   `nav-wasm` binds it.
//! * **The tick** ([`tick`]): Foxfire's system order: the chunk-level steps ([`chunks`], [`gates`], [`agent_chunk`],
//!   [`flow_fields`], [`warnings`]) and the per-agent ones ([`walkers`], [`motion`], [`flyers`], [`routes`],
//!   [`avoidance`], [`flow_agents`], [`groups`], [`surround`], [`chase`]).
//!
//! Single-threaded (ADR 0065: v1 has no WASM threads); Foxfire's parallel jobs run as loops in their fixed order.
pub mod agent_chunk;
pub mod agents;
pub mod avoidance;
pub mod boundary;
pub mod chase;
pub mod chunks;
pub mod commands;
pub mod components;
pub mod filters;
pub mod flow_agents;
pub mod flow_fields;
pub mod flyers;
pub mod formations;
pub mod gates;
pub mod groups;
pub mod ids;
pub mod motion;
pub mod pool;
pub mod routes;
pub mod settings;
pub mod surround;
pub mod surround_slots;
pub mod tick;
pub mod walkers;
pub mod warnings;
pub mod world;

use agent_chunk::AgentChunkState;
use agents::{AgentDesc, AgentStore};
use avoidance::AvoidanceSystems;
use boundary::{AgentState, Boundary, WAYPOINT_STRIDE};
use chunks::{ChunkUpdate, ChunkWorld};
use commands::{Command, CommandTargets};
use components::{NavAvoidanceObstacle, NavFlowGoal, NavMeshAgentAreaCost, NavSurround};
use flow_agents::FlowAgentSystems;
use flyers::FlyerSystems;
use groups::GroupSystems;
use ids::{AgentId, ObstacleId, TargetId, TargetRef};
use nav_math::{Float3, Float4, Hash128};
use nav_query::chunks::LoadedChunk;
use nav_query::flow::FlowFields;
use routes::RouteSystems;
use settings::{AgentTypes, CrowdSettings, NavigationRuntimeSettings};
use surround::SurroundSystems;
use tick::{Frame, TickStats};
use walkers::WalkerSystems;
use warnings::Warnings;
use world::{Obstacles, Targets, WorldInput};

pub use agents::AgentKind;
pub use components::{NavMotionMode, NavPathState};

/// One waypoint of an agent's current path ([`Crowd::path_waypoints`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Waypoint {
    pub position: Float3,
    /// The surface normal (walking), world up (flying).
    pub normal: Float3,
    /// `NavMeshWaypointFlags` bits (0 for flight points).
    pub flags: u8,
}

/// A world's navigation runtime: its agents, obstacles, targets, loaded chunks and the per-step state (see the crate
/// doc). Everything the host does goes through it; [`Crowd::tick`] advances it.
#[derive(Debug)]
pub struct Crowd {
    settings: CrowdSettings,
    agents: AgentStore,
    obstacles: Obstacles,
    targets: Targets,
    chunks: ChunkWorld,
    boundary: Boundary,
    commands: Vec<Command>,
    warnings: Warnings,
    flow: FlowFields,
    world_area_costs: Vec<NavMeshAgentAreaCost>,
    agent_chunk: AgentChunkState,
    walkers: WalkerSystems,
    flyers: FlyerSystems,
    routes: RouteSystems,
    avoidance: AvoidanceSystems,
    flow_agents: FlowAgentSystems,
    groups: GroupSystems,
    surround: SurroundSystems,
    tick: u64,
    time: f64,
    last: TickStats,
}

impl Crowd {
    pub fn new(settings: CrowdSettings) -> Self {
        let warnings = Warnings::new(&settings.label);
        Self {
            settings: CrowdSettings { runtime: settings.runtime.validated(), ..settings },
            agents: AgentStore::new(),
            obstacles: Obstacles::default(),
            targets: Targets::default(),
            chunks: ChunkWorld::new(),
            boundary: Boundary::default(),
            commands: Vec::new(),
            warnings,
            flow: FlowFields::new(),
            world_area_costs: Vec::new(),
            agent_chunk: AgentChunkState::default(),
            walkers: WalkerSystems::default(),
            flyers: FlyerSystems::default(),
            routes: RouteSystems::default(),
            avoidance: AvoidanceSystems::default(),
            flow_agents: FlowAgentSystems::default(),
            groups: GroupSystems::default(),
            surround: SurroundSystems::default(),
            tick: 0,
            time: 0.0,
            last: TickStats::default(),
        }
    }

    // ------------------------------------------------------------------------------------------------- settings

    pub fn agent_types(&self) -> &AgentTypes {
        &self.settings.agent_types
    }

    /// Replaces the agent types (project settings changed). Agents keep the settings they were added with.
    pub fn set_agent_types(&mut self, types: AgentTypes) {
        self.settings.agent_types = types;
    }

    pub fn runtime_settings(&self) -> &NavigationRuntimeSettings {
        &self.settings.runtime
    }

    pub fn set_runtime_settings(&mut self, runtime: NavigationRuntimeSettings) {
        self.settings.runtime = runtime.validated();
    }

    // ------------------------------------------------------------------------------------------------- chunks

    /// A scene's bake loaded (or rebaked: same id). Seams, overlays and route graphs follow on the next tick.
    pub fn load_chunk(&mut self, chunk: LoadedChunk) {
        self.chunks.load(chunk);
    }

    /// A scene unloaded; false if its chunk wasn't loaded.
    pub fn unload_chunk(&mut self, id: Hash128) -> bool {
        self.chunks.unload(id)
    }

    /// Ids of the loaded chunks (`Navigation.loadedChunks`), sorted.
    pub fn loaded_chunks(&self) -> Vec<Hash128> {
        self.chunks.loaded().map(|c| c.id).collect()
    }

    /// The chunk world: snapshot, seams, overlays, route graphs, gates.
    pub fn chunks(&self) -> &ChunkWorld {
        &self.chunks
    }

    // ------------------------------------------------------------------------------------------------- commands

    /// Queues an agent; its handle is valid at once (for commands and its buffer rows), and it goes live at the start
    /// of the next tick.
    pub fn add_agent(&mut self, desc: AgentDesc) -> AgentId {
        let id = self.agents.reserve();
        self.boundary.fit(self.agents.capacity(), self.obstacles.capacity());
        self.boundary.write_agent_in(id.row(), desc.position, desc.rotation, desc.up);
        self.commands.push(Command::AddAgent { id, desc: Box::new(desc) });
        id
    }

    pub fn remove_agent(&mut self, id: AgentId) {
        self.commands.push(Command::RemoveAgent(id));
    }

    /// Queues an avoidance obstacle.
    pub fn add_obstacle(&mut self, obstacle: NavAvoidanceObstacle, position: Float3) -> ObstacleId {
        let id = self.obstacles.reserve();
        self.boundary.fit(self.agents.capacity(), self.obstacles.capacity());
        self.boundary.write_obstacle_in(id.row(), position, Float3::new(0.0, 1.0, 0.0));
        self.commands.push(Command::AddObstacle { id, obstacle, position });
        id
    }

    pub fn remove_obstacle(&mut self, id: ObstacleId) {
        self.commands.push(Command::RemoveObstacle(id));
    }

    /// Queues any command.
    pub fn push(&mut self, command: Command) {
        self.commands.push(command);
    }

    /// Commands waiting for the next tick.
    pub fn queued(&self) -> &[Command] {
        &self.commands
    }

    pub fn set_destination(&mut self, agent: AgentId, point: Float3) {
        self.push(Command::SetDestination { agent, point });
    }

    pub fn chase(&mut self, agent: AgentId, target: TargetRef, repath_distance: f32) {
        self.push(Command::Chase { agent, target, repath_distance });
    }

    pub fn stop_chase(&mut self, agent: AgentId) {
        self.push(Command::StopChase(agent));
    }

    pub fn stop(&mut self, agent: AgentId) {
        self.push(Command::Stop(agent));
    }

    pub fn warp(&mut self, agent: AgentId, point: Float3) {
        self.push(Command::Warp { agent, point });
    }

    pub fn join_group(&mut self, agent: AgentId, group: AgentId) {
        self.push(Command::JoinGroup { agent, group });
    }

    pub fn leave_group(&mut self, agent: AgentId, goal: Option<Float3>) {
        self.push(Command::LeaveGroup { agent, goal });
    }

    /// Gives a group body a painted shape from a `width` x `height` bit grid (`formations::create_mask`; row 0 the
    /// front) and sets its formation to `Mask` (`NavGroups.SetMask`).
    pub fn set_group_mask(&mut self, group: AgentId, bits: &[u64], width: i32, height: i32) {
        let mask = std::sync::Arc::new(formations::create_mask(bits, width, height));
        self.push(Command::SetGroupMask { group, mask: Some(mask) });
    }

    pub fn set_gate(&mut self, id: Hash128, open: bool) {
        self.push(Command::SetGate { id, open });
    }

    /// Myco: the host's latest state of a gate, counting `SetGate` commands not yet applied, so one-shot queries made
    /// between ticks see a gate the host just opened or closed. None if the host never set it.
    pub fn gate_state(&self, id: Hash128) -> Option<bool> {
        self.commands
            .iter()
            .rev()
            .find_map(|c| match c {
                Command::SetGate { id: g, open } if *g == id => Some(*open),
                _ => None,
            })
            .or_else(|| self.chunks.gates.gate(id))
    }

    /// Replaces the runtime cost volumes (ADR 0070): oriented boxes that multiply path costs (or exclude) inside them.
    /// Applied at once for one-shot queries; the tick's snapshot, agents' re-plans and route graphs follow on the
    /// next tick.
    pub fn set_cost_volumes(&mut self, volumes: Vec<nav_query::costs::CostVolume>) {
        self.chunks.set_cost_volumes(volumes);
    }

    pub fn set_area_cost(&mut self, agent: AgentId, area: Hash128, cost: f32, excluded: bool) {
        self.push(Command::SetAreaCost { agent, area, cost, excluded });
    }

    pub fn set_world_area_cost(&mut self, area: Hash128, cost: f32, excluded: bool) {
        self.push(Command::SetWorldAreaCost { area, cost, excluded });
    }

    pub fn set_target_surround(&mut self, target: TargetId, surround: Option<NavSurround>) {
        self.push(Command::SetTargetSurround { target, surround });
    }

    pub fn set_flow_goal(&mut self, target: TargetId, goal: Option<NavFlowGoal>) {
        self.push(Command::SetFlowGoal { target, goal });
    }

    pub fn remove_target(&mut self, target: TargetId) {
        self.push(Command::RemoveTarget(target));
    }

    // ------------------------------------------------------------------------------------------------- the tick

    /// One runtime tick (`engine.NavStep`): see [`tick`] for the order. `dt` in seconds, `time` the world's elapsed
    /// time (gate changes, path ages and warning budgets are measured against it).
    pub fn tick(&mut self, dt: f32, time: f64, input: &WorldInput) -> TickStats {
        self.tick += 1;
        self.time = time;
        let mut stats = TickStats { tick: self.tick, ..TickStats::default() };

        // 0. Buffers in, then commands (a warp wins over the transform), targets, obstacles.
        self.boundary.fit(self.agents.capacity(), self.obstacles.capacity());
        self.boundary.read_in(&mut self.agents, &mut self.obstacles);
        let commands = std::mem::take(&mut self.commands);
        stats.commands = commands::apply(
            commands,
            &mut CommandTargets {
                agents: &mut self.agents,
                obstacles: &mut self.obstacles,
                targets: &mut self.targets,
                chunks: &mut self.chunks,
                boundary: &mut self.boundary,
                types: &self.settings.agent_types,
                world_area_costs: &mut self.world_area_costs,
                warnings: &mut self.warnings,
            },
        );
        self.targets.apply_input(input.targets);
        self.obstacles.measure(dt);

        // 1. Gates, overlays, snapshot, seams.
        let mut update = self.chunks.update(time, &mut self.warnings);
        // 2. Agent chunks, agent-type check.
        agent_chunk::assign_chunks(&mut self.agent_chunk, &mut self.agents, &self.chunks);
        agent_chunk::check_agent_types(&mut self.agent_chunk, self.tick, &self.agents, &self.chunks, &self.settings.agent_types, &mut self.warnings);
        // 3. Route graphs.
        self.chunks.update_route_graphs(&mut update, &mut self.warnings);
        // 7a (needs the chunk world mutably, so before the frame borrows it). Flow fields: after the route graphs and
        // before the repaths in Foxfire; nothing between here and step 7 reads them.
        flow_fields::update_flow_fields(&mut self.flow, time, &self.targets, &mut self.chunks, &self.settings.runtime);
        stats.chunks = update;

        let frame = Frame {
            dt,
            time,
            tick: self.tick,
            world: &self.chunks,
            update,
            types: &self.settings.agent_types,
            runtime: &self.settings.runtime,
            world_area_costs: &self.world_area_costs,
        };
        let agents = &mut self.agents;
        let warnings = &mut self.warnings;

        // 4. Surround.
        surround::update(&mut self.surround, agents, &mut self.targets, &frame);
        // 5. Setup.
        walkers::setup(&mut self.walkers, agents, &frame);
        flyers::setup(&mut self.flyers, agents, &frame);
        // 6. Walk/fly routes; walk-fly group members.
        routes::update_routes(&mut self.routes, agents, &self.targets, &frame, warnings);
        groups::walk_fly_members(&mut self.groups, agents, &frame);
        // 7b. Flow agents.
        flow_agents::update(&mut self.flow_agents, agents, &mut self.flow, &self.targets, &frame);
        // 8. Walkers.
        walkers::repath(&mut self.walkers, agents, &self.targets, &self.flow, &frame, warnings);
        routes::chunk_routes(&mut self.routes, agents, &self.targets, &frame, warnings);
        walkers::path_requests(&mut self.walkers, agents, &self.flow, &mut self.flow_agents.stats, &frame, warnings);
        walkers::follow(&mut self.walkers, agents, &frame);
        // 9. Flyers.
        flyers::repath(&mut self.flyers, agents, &self.targets, &frame);
        routes::chunk_flight_routes(&mut self.routes, agents, &self.targets, &frame, warnings);
        flyers::path_requests(&mut self.flyers, agents, &frame, warnings);
        flyers::steering(&mut self.flyers, agents, &frame);
        // 10. Group member steering.
        groups::member_steering(&mut self.groups, agents, &self.targets, &frame);
        // 11-12. Neighbour grids, avoidance, flight separation.
        avoidance::neighbor_grids(&mut self.avoidance, agents, &self.obstacles, &frame);
        avoidance::avoid(&mut self.avoidance, agents, &self.obstacles, &frame);
        avoidance::separate(&mut self.avoidance, agents, &frame);
        // 13. Movement.
        // Foxfire schedules the member moves inside the two move systems, after the steered moves (`NavGroupMemberMoveJob`
        // in `NavAgentMoveSystem`, `NavGroupFlyerMoveJob` in `NavVolumeMoveSystem`); the movers skip members and the
        // member moves touch only members, so running both member moves after both movers is the same.
        walkers::move_agents(&mut self.walkers, agents, &frame);
        flyers::move_agents(&mut self.flyers, agents, &frame);
        groups::move_members(&mut self.groups, agents, &frame);
        // 14. Group pace, merge.
        groups::pace(&mut self.groups, agents, &frame);
        groups::merge_with_targets(&mut self.groups, agents, &self.targets, &frame);

        // 15. Warnings, buffers out.
        warnings.end_tick(time);
        self.boundary.write_out(agents);

        stats.agents = agents.len();
        stats.paused = agents.live_rows().filter(|&r| agents.chunk[r].entry < 0).count();
        self.last = stats;
        stats
    }

    /// What the last tick did.
    pub fn last_tick(&self) -> &TickStats {
        &self.last
    }

    /// What the last tick's chunk steps did.
    pub fn last_chunk_update(&self) -> ChunkUpdate {
        self.last.chunks
    }

    // ------------------------------------------------------------------------------------------------- state

    /// The boundary buffers (see [`boundary`]).
    pub fn boundary(&self) -> &Boundary {
        &self.boundary
    }

    /// The boundary buffers, for the host to write `agents_in` / `obstacles_in`.
    pub fn boundary_mut(&mut self) -> &mut Boundary {
        &mut self.boundary
    }

    /// Writes an agent's input transform (what the host does through its view of `agents_in`). False for a stale id.
    pub fn write_agent_transform(&mut self, id: AgentId, position: Float3, rotation: Float4, up: Float3) -> bool {
        if self.agents.slots.state(id.0).is_none() {
            return false;
        }
        self.boundary.write_agent_in(id.row(), position, rotation, up);
        true
    }

    /// The agents (read-only).
    pub fn agents(&self) -> &AgentStore {
        &self.agents
    }

    pub fn is_live(&self, id: AgentId) -> bool {
        self.agents.is_live(id)
    }

    /// An agent's read-only state as of the last tick (None for a stale or not yet added handle).
    pub fn agent_state(&self, id: AgentId) -> Option<AgentState> {
        self.agents.row(id).map(|r| boundary::agent_state(&self.agents, r))
    }

    /// An agent's current path, waypoint by waypoint (`NavAgent.path`): a walker's straightened path with normals and
    /// flags, a flyer's points with world up; a walk-fly agent's current leg's.
    pub fn path_waypoints(&self, id: AgentId) -> Vec<Waypoint> {
        let Some(r) = self.agents.row(id) else { return Vec::new() };
        let d = &self.agents.data[r];
        let flying = d.route.as_deref().map_or(d.kind == AgentKind::Flyer, |x| x.flying);
        if flying {
            let Some(f) = d.flyer.as_deref() else { return Vec::new() };
            let n = (f.path.count.max(0) as usize).min(f.points.len());
            return f.points[..n].iter().map(|&p| Waypoint { position: p, normal: Float3::new(0.0, 1.0, 0.0), flags: 0 }).collect();
        }
        let Some(w) = d.walker.as_deref() else { return Vec::new() };
        let n = (w.path.count.max(0) as usize).min(w.elements.len());
        w.elements[..n].iter().map(|e| Waypoint { position: e.position, normal: e.normal, flags: e.flags.0 }).collect()
    }

    /// [`Crowd::path_waypoints`] into a flat scratch buffer ([`WAYPOINT_STRIDE`] floats each), for the boundary.
    pub fn path_waypoints_flat(&self, id: AgentId, out: &mut Vec<f32>) {
        out.clear();
        for w in self.path_waypoints(id) {
            out.extend_from_slice(&[w.position.x, w.position.y, w.position.z, w.normal.x, w.normal.y, w.normal.z, w.flags as f32]);
        }
        debug_assert_eq!(out.len() % WAYPOINT_STRIDE, 0);
    }

    /// The host's targets.
    pub fn targets(&self) -> &Targets {
        &self.targets
    }

    /// The obstacles.
    pub fn obstacles(&self) -> &Obstacles {
        &self.obstacles
    }

    /// The flow fields.
    pub fn flow_fields(&self) -> &FlowFields {
        &self.flow
    }

    /// Warnings since the last drain, for the console.
    pub fn drain_warnings(&mut self) -> Vec<String> {
        self.warnings.drain_warnings()
    }

    /// Log lines since the last drain (route graphs rebuilt, seams, overlays).
    pub fn drain_logs(&mut self) -> Vec<String> {
        self.warnings.drain_logs()
    }

    /// The warning queue itself (tests; steps push to it during the tick).
    pub fn warnings_mut(&mut self) -> &mut Warnings {
        &mut self.warnings
    }

    /// Ticks so far.
    pub fn ticks(&self) -> u64 {
        self.tick
    }
}
