//! A small harness the `w5c_*` tests share: the front half of `Crowd::tick` (chunk steps, flow fields) and the avoidance
//! and flow agent steps (following, then the path requests that serve followers from their field) called directly, with a test-side mover standing in for the walkers' follow and move (those
//! are other modules'): every tick the harness sets each agent's desired velocity and steering flag as path follow
//! would, runs the step under test, and integrates by `steered`.
#![allow(dead_code)]
#[path = "../../nav-bake/tests/bake_common.rs"]
pub mod bake_common;

use bake_common::*;
use nav_crowd::agent_chunk::{assign_chunks, AgentChunkState};
use nav_crowd::agents::{AgentDesc, AgentStore};
use nav_crowd::avoidance::{self, AvoidanceSystems};
use nav_crowd::chunks::{ChunkUpdate, ChunkWorld};
use nav_crowd::components::{NavAvoidanceObstacle, NavMeshAgentAreaCost, NavMeshAgentSurface};
use nav_crowd::flow_agents::{self, FlowAgentSystems};
use nav_crowd::flow_fields;
use nav_crowd::ids::ObstacleId;
use nav_crowd::settings::{AgentTypes, NavigationRuntimeSettings};
use nav_crowd::tick::Frame;
use nav_crowd::walkers::{self, WalkerSystems};
use nav_crowd::warnings::Warnings;
use nav_crowd::world::{Obstacles, Targets};
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use nav_query::flow::FlowFields;
use std::sync::Arc;

pub const WALKER: Hash128 = Hash128::new(1, 0, 0, 0);
pub const UP: Float3 = Float3::new(0.0, 1.0, 0.0);
pub const DT: f32 = 1.0 / 60.0;

pub struct Sim {
    pub chunks: ChunkWorld,
    pub agents: AgentStore,
    pub obstacles: Obstacles,
    pub targets: Targets,
    pub types: AgentTypes,
    pub runtime: NavigationRuntimeSettings,
    pub warnings: Warnings,
    pub flow: FlowFields,
    pub avoid: AvoidanceSystems,
    pub flow_agents: FlowAgentSystems,
    pub walkers: WalkerSystems,
    pub world_costs: Vec<NavMeshAgentAreaCost>,
    acs: AgentChunkState,
    update: ChunkUpdate,
    pub tick: u64,
    pub time: f64,
}

impl Sim {
    pub fn new(chunks: Vec<LoadedChunk>, types: AgentTypes) -> Self {
        let mut world = ChunkWorld::new();
        for c in chunks {
            world.load(c);
        }
        Self {
            chunks: world,
            agents: AgentStore::new(),
            obstacles: Obstacles::default(),
            targets: Targets::default(),
            types,
            runtime: NavigationRuntimeSettings::default(),
            warnings: Warnings::new("test"),
            flow: FlowFields::new(),
            avoid: AvoidanceSystems::default(),
            flow_agents: FlowAgentSystems::default(),
            walkers: WalkerSystems::default(),
            world_costs: Vec::new(),
            acs: AgentChunkState::default(),
            update: ChunkUpdate::default(),
            tick: 0,
            time: 0.0,
        }
    }

    /// The chunk steps and the flow fields (the front half of a tick): after it the snapshot is current.
    pub fn begin(&mut self) {
        self.tick += 1;
        self.time += DT as f64;
        self.obstacles.measure(DT);
        let mut update = self.chunks.update(self.time, &mut self.warnings);
        assign_chunks(&mut self.acs, &mut self.agents, &self.chunks);
        self.chunks.update_route_graphs(&mut update, &mut self.warnings);
        flow_fields::update_flow_fields(&mut self.flow, self.time, &self.targets, &mut self.chunks, &self.runtime);
        self.update = update;
    }

    /// `Frame` is built per step: it borrows the chunk world while the step borrows the other fields mutably.
    pub fn neighbor_grids_and_avoid(&mut self) {
        let frame = Frame {
            dt: DT,
            time: self.time,
            tick: self.tick,
            world: &self.chunks,
            update: self.update,
            types: &self.types,
            runtime: &self.runtime,
            world_area_costs: &self.world_costs,
        };
        avoidance::neighbor_grids(&mut self.avoid, &self.agents, &self.obstacles, &frame);
        avoidance::avoid(&mut self.avoid, &mut self.agents, &self.obstacles, &frame);
        avoidance::separate(&mut self.avoid, &mut self.agents, &frame);
    }

    pub fn flow_update(&mut self) {
        let frame = Frame {
            dt: DT,
            time: self.time,
            tick: self.tick,
            world: &self.chunks,
            update: self.update,
            types: &self.types,
            runtime: &self.runtime,
            world_area_costs: &self.world_costs,
        };
        flow_agents::update(&mut self.flow_agents, &mut self.agents, &mut self.flow, &self.targets, &frame);
        // NavFlowPathJob runs inside the path requests (Foxfire's NavPathRequestSystem).
        walkers::path_requests(&mut self.walkers, &mut self.agents, &self.flow, &mut self.flow_agents.stats, &frame, &mut self.warnings);
    }

    /// An agent of `ty` at `pos` (the first `begin` finds its chunk); `tweak` edits its description.
    pub fn add_agent(&mut self, ty: Hash128, pos: Float3, tweak: impl FnOnce(&mut AgentDesc)) -> usize {
        let mut desc = AgentDesc::new(ty, pos);
        tweak(&mut desc);
        let id = self.agents.reserve();
        self.agents.activate(id, &desc, &self.types).expect("agent added");
        let r = id.row();
        self.agents.surface[r] = NavMeshAgentSurface { surface_position: pos, up: UP, initialized: true };
        r
    }

    pub fn add_obstacle(&mut self, radius: f32, height: f32, layers: u32, position: Float3) -> ObstacleId {
        let id = self.obstacles.reserve();
        assert!(self.obstacles.activate(id, NavAvoidanceObstacle { radius, height, layers }, position));
        id
    }

    /// The nearest polygon of a walker's chunk, as the avoidance step would find it (so the navmesh clip is on).
    pub fn seed_poly(&mut self, r: usize) {
        let entry = self.agents.chunk[r].entry;
        assert!(entry >= 0, "agent has no chunk yet");
        let nav = self.chunks.snapshot().entries[entry as usize].nav.clone().unwrap();
        let p = self.agents.surface[r].surface_position;
        let poly = avoidance::clip::nearest_poly_any(&nav, p, 2.0);
        self.agents.data[r].walker.as_deref_mut().unwrap().avoidance_state.poly = poly;
    }

    /// `x`-`z` distance between two agents.
    pub fn distance(&self, a: usize, b: usize) -> f32 {
        (self.agents.position[a] - self.agents.position[b]).length()
    }

    /// Moves every steering agent by its steered velocity (`NavAgentMoveSystem` for steering agents).
    pub fn integrate(&mut self) {
        for r in self.agents.active_rows().collect::<Vec<_>>() {
            if !self.agents.steering[r] {
                self.agents.velocity[r] = Float3::default();
                continue;
            }
            let v = self.agents.steered[r];
            self.agents.position[r] += v * DT;
            self.agents.surface[r].surface_position = self.agents.position[r];
            self.agents.velocity[r] = v;
        }
    }

    /// Points a walker at `goal` at its speed, steering on while it is further than `stop` from it (what path follow
    /// writes); a steering agent that wasn't steering starts with steered = desired.
    pub fn head_for(&mut self, r: usize, goal: Float3, stop: f32) {
        let pos = self.agents.surface[r].surface_position;
        let speed = self.agents.data[r].walk.as_ref().unwrap().speed();
        let to = goal - pos;
        let moving = to.length() > stop;
        let desired = if moving { to.normalize_safe(Float3::default()) * speed } else { Float3::default() };
        self.agents.desired[r] = desired;
        if moving && !self.agents.steering[r] {
            self.agents.steered[r] = desired;
        }
        self.agents.steering[r] = moving;
    }
}

/// A flat floor `[-half, half]^2` baked for the test walker, loaded as one chunk; `wall` pieces as obstacles.
pub fn floor_chunk(half: f32, walls: &[(Float3, Float3)]) -> LoadedChunk {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-half, -half), (half, half), 0.0, &[]);
    for &(c, s) in walls {
        bake.add_obstacle(c, s, Rot::IDENTITY);
    }
    bake.bake();
    LoadedChunk::new(Hash128::new(7, 7, 0, 0), Arc::new(bake.out.file.clone()))
}
