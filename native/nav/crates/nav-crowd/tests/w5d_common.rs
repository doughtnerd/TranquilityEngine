//! Two test worlds for the group and surround steps (included by `w5d_groups.rs` and `w5d_surround.rs`).
//!
//! [`TickSim`] is the real thing: a `Crowd` ticked through `Crowd::tick` (bodies planned, followed and moved by the
//! walker steps, members steered through avoidance and moved by `groups::move_members`), the host's target positions
//! fed in each tick. The core group and surround cases run on it.
//!
//! [`Sim`] isolates the group and surround steps: real bakes, the real chunk steps, commands, and the group and
//! surround steps, with two stand-ins so a test can pin down one step's behaviour without the others': group bodies and lone chasers are moved straight at their goal by [`Sim::step`] (planning
//! is instant: a path request becomes the body's goal), and avoidance passes members' desired velocity through
//! (`steered = desired`). Tick order as `Crowd::tick`'s: surround, walk-fly members, member steering, avoidance,
//! movement (bodies, then `groups::move_members`), pace, merge.
#![allow(dead_code)]

use nav_crowd::agent_chunk::{self, AgentChunkState};
use nav_crowd::agents::{AgentDesc, AgentStore};
use nav_crowd::boundary::Boundary;
use nav_crowd::chunks::ChunkWorld;
use nav_crowd::commands::{self, Command, CommandTargets};
use nav_crowd::components::{NavPathState, PathRequest};
use nav_crowd::groups::{self, GroupSystems};
use nav_crowd::ids::AgentId;
use nav_crowd::settings::{AgentTypeSettings, AgentTypes, NavigationRuntimeSettings};
use nav_crowd::surround::{self, SurroundSystems};
use nav_crowd::surround_slots;
use nav_crowd::tick::Frame;
use nav_crowd::warnings::Warnings;
use nav_crowd::world::{Obstacles, TargetInput, Targets, WorldInput};
use nav_crowd::Crowd;
use nav_crowd::settings::CrowdSettings;
use nav_crowd::ids::TargetId;
use nav_format::file::BakeFile;
use nav_math::{Float3, Float4, Hash128};
use nav_query::chunks::LoadedChunk;
use std::collections::BTreeMap;
use std::sync::Arc;

pub const DT: f32 = 1.0 / 30.0;
pub const CHUNK: Hash128 = Hash128::new(7, 7, 0, 0);

pub struct Sim {
    pub agents: AgentStore,
    pub world: ChunkWorld,
    pub types: AgentTypes,
    pub runtime: NavigationRuntimeSettings,
    pub chunk_state: AgentChunkState,
    pub warnings: Warnings,
    pub groups: GroupSystems,
    pub surround: SurroundSystems,
    pub targets: Targets,
    pub time: f64,
    pub tick: u64,
    /// Bodies' and lone agents' goals (the stand-in planner's).
    pub goals: BTreeMap<usize, Float3>,
    /// Rows the stand-in mover leaves alone.
    pub frozen: Vec<usize>,
}

impl Sim {
    pub fn new(file: Arc<BakeFile>, types: Vec<AgentTypeSettings>) -> Self {
        let mut world = ChunkWorld::new();
        world.load(LoadedChunk::new(CHUNK, file));
        Self {
            agents: AgentStore::new(),
            world,
            types: AgentTypes::new(types),
            runtime: NavigationRuntimeSettings::default(),
            chunk_state: AgentChunkState::default(),
            warnings: Warnings::new("w5d"),
            groups: GroupSystems::default(),
            surround: SurroundSystems::default(),
            targets: Targets::default(),
            time: 0.0,
            tick: 0,
            goals: BTreeMap::new(),
            frozen: Vec::new(),
        }
    }

    pub fn add(&mut self, desc: AgentDesc) -> AgentId {
        let id = self.agents.reserve();
        self.agents.activate(id, &desc, &self.types).expect("agent added");
        id
    }

    pub fn row(&self, id: AgentId) -> usize {
        self.agents.row(id).expect("live")
    }

    /// Applies one command as the tick would.
    pub fn command(&mut self, c: Command) -> bool {
        let mut obstacles = Obstacles::default();
        let mut boundary = Boundary::default();
        let mut costs = Vec::new();
        let stats = commands::apply(
            vec![c],
            &mut CommandTargets {
                agents: &mut self.agents,
                obstacles: &mut obstacles,
                targets: &mut self.targets,
                chunks: &mut self.world,
                boundary: &mut boundary,
                types: &self.types,
                world_area_costs: &mut costs,
                warnings: &mut self.warnings,
            },
        );
        stats.applied == 1
    }

    /// Sends an agent (a group body, or a lone agent) to `goal`: its path request, served by the stand-in planner.
    pub fn send(&mut self, id: AgentId, goal: Float3) {
        let r = self.row(id);
        let d = &mut self.agents.data[r];
        d.path_request = PathRequest { start: Float3::default(), goal, urgent: true, start_from_current_position: true };
        d.path_request_enabled = true;
    }

    pub fn group(&self, id: AgentId) -> nav_crowd::components::NavGroup {
        self.agents.data[self.row(id)].group.as_deref().unwrap().group
    }

    pub fn members(&self, id: AgentId) -> Vec<AgentId> {
        self.agents.data[self.row(id)].group.as_deref().unwrap().members.clone()
    }

    pub fn slot_of(&self, id: AgentId) -> i32 {
        self.agents.data[self.row(id)].group_member.map_or(-2, |m| if m.enabled { m.slot } else { -2 })
    }

    /// Where a walker stands (its surface contact).
    pub fn at(&self, id: AgentId) -> Float3 {
        let r = self.row(id);
        if self.agents.data[r].walk.is_some() && self.agents.surface[r].initialized && !self.agents.data[r].route.as_deref().is_some_and(|x| x.flying) {
            self.agents.surface[r].surface_position
        } else {
            self.agents.position[r]
        }
    }

    pub fn run(&mut self, ticks: usize) {
        for _ in 0..ticks {
            self.step();
        }
    }

    pub fn run_seconds(&mut self, seconds: f32) {
        self.run((seconds / DT).round() as usize);
    }

    pub fn step(&mut self) {
        self.tick += 1;
        self.time += DT as f64;
        let time = self.time;
        let Sim { agents, world, types, runtime, chunk_state, warnings, groups: gs, surround: ss, targets, goals, frozen, tick, .. } = self;
        let update = world.update(time, warnings);
        agent_chunk::assign_chunks(chunk_state, agents, world);

        // The walkers' first-update surface (InitAgentSurfaceJob: pivot offset 0 in these types).
        for r in agents.active_rows().collect::<Vec<_>>() {
            if agents.data[r].walk.is_some() && !agents.surface[r].initialized {
                agents.surface[r].surface_position = agents.position[r];
                agents.surface[r].up = Float3::new(0.0, 1.0, 0.0);
                agents.surface[r].initialized = true;
            }
        }

        let costs = Vec::new();
        let frame = Frame { dt: DT, time, tick: *tick, world, update, types, runtime, world_area_costs: &costs };

        surround::update(ss, agents, targets, &frame);
        groups::walk_fly_members(gs, agents, &frame);
        plan(agents, goals, time);
        groups::member_steering(gs, agents, targets, &frame);
        for r in agents.active_rows().collect::<Vec<_>>() {
            if agents.steering[r] {
                agents.steered[r] = agents.desired[r]; // avoidance with nobody to avoid
            }
        }
        move_bodies(agents, goals, targets, frozen, DT);
        groups::move_members(gs, agents, &frame);
        groups::pace(gs, agents, &frame);
        groups::merge_with_targets(gs, agents, targets, &frame);
    }
}

/// The stand-in planner: a body's (or lone agent's) path request becomes its goal at once, its path Following.
fn plan(agents: &mut AgentStore, goals: &mut BTreeMap<usize, Float3>, time: f64) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        let d = &mut agents.data[r];
        if !d.path_request_enabled || d.group_member.is_some_and(|m| m.enabled) {
            continue;
        }
        if d.group.is_none() && d.group_joiner {
            continue; // lone joiners keep their request (their destination) in these tests
        }
        d.path_request_enabled = false;
        goals.insert(r, d.path_request.goal);
        if let Some(w) = d.walker.as_deref_mut() {
            w.path.goal = d.path_request.goal;
            w.path.state = NavPathState::Following;
            w.path.computed_time = time;
        }
        if let Some(f) = d.flyer.as_deref_mut() {
            f.path.goal = d.path_request.goal;
            f.path.state = NavPathState::Following;
            f.path.computed_time = time;
        }
    }
}

/// The stand-in mover: bodies and lone chasers straight at their goal (a chaser at its surround slot or the target) at
/// their speed (a body's is the pace's speed override).
fn move_bodies(agents: &mut AgentStore, goals: &mut BTreeMap<usize, Float3>, targets: &Targets, frozen: &[usize], dt: f32) {
    for r in agents.active_rows().collect::<Vec<_>>() {
        if frozen.contains(&r) || agents.data[r].group_member.is_some_and(|m| m.enabled) {
            continue;
        }
        let d = &agents.data[r];
        let chase = d.goal_target.and_then(|c| agents.target_position(c.target, targets).map(|p| (c, p)));
        let goal = match chase {
            Some((c, p)) => Some(surround_slots::chase_goal(d.surround_slot.as_ref(), &c, p, targets).0),
            None => goals.get(&r).copied(),
        };
        let Some(goal) = goal else {
            agents.velocity[r] = Float3::default();
            continue;
        };
        let flying = d.kind == nav_crowd::AgentKind::Flyer;
        let speed = if flying { d.flight.as_ref().unwrap().speed() } else { d.walk.as_ref().unwrap().speed() };
        let from = if flying { agents.position[r] } else { agents.surface[r].surface_position };
        let mut to = goal - from;
        if !flying {
            to.y = 0.0;
        }
        let dist = to.length();
        let step = speed * dt;
        let next = if dist <= step { from + to } else { from + to * (step / dist) };
        if dist <= step && chase.is_none() {
            goals.remove(&r);
            if let Some(w) = agents.data[r].walker.as_deref_mut() {
                w.path.state = NavPathState::Arrived;
            }
        }
        if flying {
            agents.position[r] = next;
        } else {
            agents.surface[r].surface_position = next;
            agents.position[r] = next;
        }
        agents.velocity[r] = (next - from) / dt;
    }
}

pub fn identity() -> Float4 {
    Float4::new(0.0, 0.0, 0.0, 1.0)
}

/// The real tick (see the module doc): the same calls as [`Sim`] where they make sense, through a `Crowd`. Commands
/// are queued and applied at the start of the next tick, as the host's are.
pub struct TickSim {
    pub c: Crowd,
    pub time: f64,
    pub targets: Vec<TargetInput>,
}

impl TickSim {
    pub fn new(file: Arc<BakeFile>, types: Vec<AgentTypeSettings>) -> Self {
        let mut c = Crowd::new(CrowdSettings { agent_types: AgentTypes::new(types), label: "w5d-tick".into(), ..CrowdSettings::default() });
        c.load_chunk(LoadedChunk::new(CHUNK, file));
        Self { c, time: 0.0, targets: Vec::new() }
    }

    pub fn add(&mut self, desc: AgentDesc) -> AgentId {
        self.c.add_agent(desc)
    }

    pub fn row(&self, id: AgentId) -> usize {
        self.c.agents().row(id).expect("live")
    }

    pub fn agents(&self) -> &AgentStore {
        self.c.agents()
    }

    /// Queues a command (applied at the start of the next tick); true, for symmetry with [`Sim::command`].
    pub fn command(&mut self, c: Command) -> bool {
        self.c.push(c);
        true
    }

    /// Sends an agent (a group body, or a lone agent) to `goal` (`set_destination`).
    pub fn send(&mut self, id: AgentId, goal: Float3) {
        self.c.set_destination(id, goal);
    }

    pub fn set_target(&mut self, id: TargetId, at: Float3) {
        match self.targets.iter_mut().find(|t| t.id == id) {
            Some(t) => t.position = at,
            None => self.targets.push(TargetInput { id, position: at }),
        }
    }

    pub fn group(&self, id: AgentId) -> nav_crowd::components::NavGroup {
        self.agents().data[self.row(id)].group.as_deref().unwrap().group
    }

    pub fn members(&self, id: AgentId) -> Vec<AgentId> {
        self.agents().data[self.row(id)].group.as_deref().unwrap().members.clone()
    }

    pub fn slot_of(&self, id: AgentId) -> i32 {
        self.agents().data[self.row(id)].group_member.map_or(-2, |m| if m.enabled { m.slot } else { -2 })
    }

    /// Where a walker stands (its surface contact), else its position.
    pub fn at(&self, id: AgentId) -> Float3 {
        let a = self.agents();
        let r = self.row(id);
        if a.data[r].walk.is_some() && a.surface[r].initialized && !a.data[r].route.as_deref().is_some_and(|x| x.flying) {
            a.surface[r].surface_position
        } else {
            a.position[r]
        }
    }

    pub fn step(&mut self) {
        self.time += DT as f64;
        let targets = self.targets.clone();
        self.c.tick(DT, self.time, &WorldInput { targets: &targets });
    }

    pub fn run(&mut self, ticks: usize) {
        for _ in 0..ticks {
            self.step();
        }
    }

    pub fn run_seconds(&mut self, seconds: f32) {
        self.run((seconds / DT).round() as usize);
    }
}
