//! `NavRuntime`: a World's navigation runtime ([`nav_crowd::Crowd`]) behind `wasm-bindgen`, plus one-shot queries
//! and debug geometry on its loaded chunks. See `src/engine/nav/runtime.ts` for the TypeScript side.
//!
//! Handles (agents, obstacles) cross as `f64`: `index + generation * 2^32` (exact while generations stay under
//! 2^21). The low 32 bits (`handle >>> 0` in JS) are the agent's row in the boundary buffers.
use crate::debug;
use crate::dto::{parse_id, AgentDescDto, AreaCostDto, NavigationSettingsDto, ObstacleDto, SurroundDto};
use crate::queries::{self, chunk_parts};
use nav_crowd::boundary::{AGENT_IN_STRIDE, AGENT_OUT_STRIDE, AGENT_STATE_STRIDE, OBSTACLE_IN_STRIDE};
use nav_crowd::commands::Command;
use nav_crowd::components::{NavFlowGoal, NavMeshAgentAreaCost};
use nav_crowd::ids::{AgentId, Handle, ObstacleId, TargetId, TargetRef};
use nav_crowd::settings::AgentTypeSettings;
use nav_crowd::world::{TargetInput, WorldInput};
use nav_crowd::Crowd;
use nav_math::{Float3, Hash128};
use nav_query::chunks::LoadedChunk;
use std::collections::BTreeMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const TWO_32: f64 = 4294967296.0;

pub fn pack(h: Handle) -> f64 {
    h.index as f64 + h.generation as f64 * TWO_32
}

pub fn unpack(v: f64) -> Handle {
    if v.is_nan() || v < 0.0 {
        return Handle::NONE;
    }
    let g = (v / TWO_32).floor();
    Handle::new((v - g * TWO_32) as u32, g as u32)
}

fn agent(h: f64) -> AgentId {
    AgentId(unpack(h))
}

fn f3(x: f32, y: f32, z: f32) -> Float3 {
    Float3::new(x, y, z)
}

fn json_strings(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// The runtime core, without `wasm-bindgen` types (Rust tests use it directly).
pub struct RuntimeCore {
    pub crowd: Crowd,
    /// Agent types' default area costs, by type id.
    type_costs: BTreeMap<Hash128, Vec<NavMeshAgentAreaCost>>,
    /// A copy of the world's area cost overrides (`setWorldAreaCost`), for queries.
    world_costs: Vec<NavMeshAgentAreaCost>,
    targets: Vec<TargetInput>,
    scratch: Vec<f32>,
}

impl RuntimeCore {
    pub fn new(settings_json: &str) -> Result<Self, String> {
        let s = NavigationSettingsDto::parse(settings_json)?;
        let mut core = Self {
            crowd: Crowd::new(s.to_crowd("World")),
            type_costs: BTreeMap::new(),
            world_costs: Vec::new(),
            targets: Vec::new(),
            scratch: Vec::new(),
        };
        core.take_type_costs(&s);
        Ok(core)
    }

    fn take_type_costs(&mut self, s: &NavigationSettingsDto) {
        self.type_costs = s.agent_types.iter().map(|t| (t.hash(), t.area_costs.iter().map(AreaCostDto::to_override).collect())).collect();
    }

    pub fn set_settings(&mut self, settings_json: &str) -> Result<(), String> {
        let s = NavigationSettingsDto::parse(settings_json)?;
        let c = s.to_crowd("World");
        self.crowd.set_agent_types(c.agent_types);
        self.crowd.set_runtime_settings(c.runtime);
        self.take_type_costs(&s);
        Ok(())
    }

    pub fn load_chunk(&mut self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let id = parse_id(id);
        if !id.is_valid() {
            return Err("loadChunk: the chunk id is empty".into());
        }
        let file = nav_format::read(bytes).map_err(|e| format!("loadChunk: {e}"))?;
        self.crowd.load_chunk(LoadedChunk::new(id, Arc::new(file)));
        Ok(())
    }

    pub fn add_agent(&mut self, desc_json: &str) -> Result<f64, String> {
        let d = AgentDescDto::parse(desc_json)?;
        let type_id = parse_id(&d.agent_type);
        let costs = self.type_costs.get(&type_id).cloned().unwrap_or_default();
        Ok(pack(self.crowd.add_agent(d.to_desc(&costs)).0))
    }

    fn type_of(&self, agent_type: &str) -> Option<&AgentTypeSettings> {
        self.crowd.agent_types().get(parse_id(agent_type))
    }

    /// The world's area costs, then the type's defaults (what a fresh agent of the type searches with).
    fn costs_for(&self, ty: &AgentTypeSettings) -> Vec<NavMeshAgentAreaCost> {
        let own = self.type_costs.get(&ty.id).map(Vec::as_slice).unwrap_or(&[]);
        nav_crowd::filters::effective_area_costs(&self.world_costs, own)
    }

    pub fn set_world_area_cost(&mut self, area: &str, cost: f32, excluded: bool) {
        let area = parse_id(area);
        self.world_costs.retain(|c| c.area_id != area);
        self.world_costs.push(NavMeshAgentAreaCost { area_id: area, excluded, cost });
        self.crowd.set_world_area_cost(area, cost, excluded);
    }

    pub fn tick(&mut self, dt: f32, time: f64) {
        let targets = std::mem::take(&mut self.targets);
        self.crowd.tick(dt, time, &WorldInput { targets: &targets });
    }

    pub fn find_path(&self, agent_type: &str, from: Float3, to: Float3) -> Vec<f32> {
        let Some(ty) = self.type_of(agent_type) else { return vec![queries::STATUS_INVALID] };
        queries::find_path(&self.crowd, ty, &self.costs_for(ty), from, to).into_flat()
    }

    pub fn nearest_point(&self, agent_type: &str, p: Float3, max_distance: f32) -> Vec<f32> {
        let Some(ty) = self.type_of(agent_type) else { return Vec::new() };
        queries::nearest_point(&self.crowd, ty, &self.costs_for(ty), p, max_distance)
    }

    pub fn raycast(&self, agent_type: &str, from: Float3, to: Float3) -> Vec<f32> {
        let Some(ty) = self.type_of(agent_type) else { return Vec::new() };
        queries::raycast(&self.crowd, ty, &self.costs_for(ty), from, to)
    }

    fn chunk(&self, id: &str) -> Option<&LoadedChunk> {
        let id = parse_id(id);
        self.crowd.chunks().loaded().find(|c| c.id == id)
    }
}

/// A World's navigation runtime (see the module doc and `runtime.ts`).
#[wasm_bindgen]
pub struct NavRuntime {
    core: RuntimeCore,
}

fn js(e: String) -> JsError {
    JsError::new(&e)
}

#[wasm_bindgen]
impl NavRuntime {
    /// `settings_json`: the `navigation` project settings section (agent types, areas, runtime budgets).
    #[wasm_bindgen(constructor)]
    pub fn new(settings_json: &str) -> Result<NavRuntime, JsError> {
        Ok(NavRuntime { core: RuntimeCore::new(settings_json).map_err(js)? })
    }

    /// Replaces the agent types and runtime budgets (agents keep the settings they were added with).
    #[wasm_bindgen(js_name = setSettings)]
    pub fn set_settings(&mut self, settings_json: &str) -> Result<(), JsError> {
        self.core.set_settings(settings_json).map_err(js)
    }

    // ------------------------------------------------------------------------------------------- chunks

    /// Loads (or replaces) a chunk from its `myco.nav@1` bytes; `id` is its chunk id (hex from `chunkId`).
    #[wasm_bindgen(js_name = loadChunk)]
    pub fn load_chunk(&mut self, id: &str, bytes: &[u8]) -> Result<(), JsError> {
        self.core.load_chunk(id, bytes).map_err(js)
    }

    #[wasm_bindgen(js_name = unloadChunk)]
    pub fn unload_chunk(&mut self, id: &str) -> bool {
        self.core.crowd.unload_chunk(parse_id(id))
    }

    /// The loaded chunks' ids (hex), as a JSON array.
    #[wasm_bindgen(js_name = loadedChunks)]
    pub fn loaded_chunks(&self) -> String {
        json_strings(&self.core.crowd.loaded_chunks().iter().map(|h| h.to_hex()).collect::<Vec<_>>())
    }

    // ------------------------------------------------------------------------------------------- agents

    /// Queues an agent (live from the next tick); returns its handle. `desc_json`: `AgentDescDto`.
    #[wasm_bindgen(js_name = addAgent)]
    pub fn add_agent(&mut self, desc_json: &str) -> Result<f64, JsError> {
        self.core.add_agent(desc_json).map_err(js)
    }

    #[wasm_bindgen(js_name = removeAgent)]
    pub fn remove_agent(&mut self, agent_handle: f64) {
        self.core.crowd.remove_agent(agent(agent_handle));
    }

    #[wasm_bindgen(js_name = isLive)]
    pub fn is_live(&self, agent_handle: f64) -> bool {
        self.core.crowd.is_live(agent(agent_handle))
    }

    /// Queues an avoidance obstacle at a position; returns its handle (its row in the obstacle buffer).
    #[wasm_bindgen(js_name = addObstacle)]
    pub fn add_obstacle(&mut self, desc_json: &str, x: f32, y: f32, z: f32) -> Result<f64, JsError> {
        let o: ObstacleDto = if desc_json.trim().is_empty() { ObstacleDto::default() } else { serde_json::from_str(desc_json).map_err(|e| JsError::new(&format!("obstacle: {e}")))? };
        Ok(pack(self.core.crowd.add_obstacle(o.into(), f3(x, y, z)).0))
    }

    #[wasm_bindgen(js_name = removeObstacle)]
    pub fn remove_obstacle(&mut self, obstacle_handle: f64) {
        self.core.crowd.remove_obstacle(ObstacleId(unpack(obstacle_handle)));
    }

    // ------------------------------------------------------------------------------------------- commands

    #[wasm_bindgen(js_name = setDestination)]
    pub fn set_destination(&mut self, agent_handle: f64, x: f32, y: f32, z: f32) {
        self.core.crowd.set_destination(agent(agent_handle), f3(x, y, z));
    }

    /// Chases another agent; `repath_distance` 0 = the default.
    #[wasm_bindgen(js_name = chaseAgent)]
    pub fn chase_agent(&mut self, agent_handle: f64, target_agent: f64, repath_distance: f32) {
        self.core.crowd.chase(agent(agent_handle), TargetRef::Agent(agent(target_agent)), repath_distance);
    }

    /// Chases a host target (positions from `setTargetPositions`).
    #[wasm_bindgen(js_name = chaseTarget)]
    pub fn chase_target(&mut self, agent_handle: f64, target_id: u32, repath_distance: f32) {
        self.core.crowd.chase(agent(agent_handle), TargetRef::Target(TargetId(target_id)), repath_distance);
    }

    #[wasm_bindgen(js_name = stopChase)]
    pub fn stop_chase(&mut self, agent_handle: f64) {
        self.core.crowd.stop_chase(agent(agent_handle));
    }

    pub fn stop(&mut self, agent_handle: f64) {
        self.core.crowd.stop(agent(agent_handle));
    }

    pub fn warp(&mut self, agent_handle: f64, x: f32, y: f32, z: f32) {
        self.core.crowd.warp(agent(agent_handle), f3(x, y, z));
    }

    #[wasm_bindgen(js_name = setSpeed)]
    pub fn set_speed(&mut self, agent_handle: f64, speed: f32, turn_speed: f32) {
        self.core.crowd.push(Command::SetSpeed { agent: agent(agent_handle), speed, turn_speed });
    }

    #[wasm_bindgen(js_name = joinGroup)]
    pub fn join_group(&mut self, agent_handle: f64, group_handle: f64) {
        self.core.crowd.join_group(agent(agent_handle), agent(group_handle));
    }

    /// Leaves its group; with `has_goal`, walks on to (x, y, z).
    #[wasm_bindgen(js_name = leaveGroup)]
    pub fn leave_group(&mut self, agent_handle: f64, has_goal: bool, x: f32, y: f32, z: f32) {
        self.core.crowd.leave_group(agent(agent_handle), has_goal.then(|| f3(x, y, z)));
    }

    #[wasm_bindgen(js_name = setGroupJoining)]
    pub fn set_group_joining(&mut self, agent_handle: f64, joining: bool) {
        self.core.crowd.push(Command::SetGroupJoining { agent: agent(agent_handle), joining });
    }

    /// A group body's painted shape: `width` x `height` bits, row 0 the front, 64 bits per word.
    #[wasm_bindgen(js_name = setGroupMask)]
    pub fn set_group_mask(&mut self, group_handle: f64, bits: &[u64], width: i32, height: i32) {
        if bits.is_empty() {
            self.core.crowd.push(Command::SetGroupMask { group: agent(group_handle), mask: None });
        } else {
            self.core.crowd.set_group_mask(agent(group_handle), bits, width, height);
        }
    }

    #[wasm_bindgen(js_name = setGate)]
    pub fn set_gate(&mut self, gate_id: &str, open: bool) {
        self.core.crowd.set_gate(parse_id(gate_id), open);
    }

    /// An agent's own area cost (`cost` < 0: the area's default).
    #[wasm_bindgen(js_name = setAreaCost)]
    pub fn set_area_cost(&mut self, agent_handle: f64, area: &str, cost: f32, excluded: bool) {
        self.core.crowd.set_area_cost(agent(agent_handle), parse_id(area), cost, excluded);
    }

    #[wasm_bindgen(js_name = clearAreaCosts)]
    pub fn clear_area_costs(&mut self, agent_handle: f64) {
        self.core.crowd.push(Command::ClearAreaCosts(agent(agent_handle)));
    }

    /// The World's override of an area's cost (`Navigation.setAreaCost`), under every agent's own.
    #[wasm_bindgen(js_name = setWorldAreaCost)]
    pub fn set_world_area_cost(&mut self, area: &str, cost: f32, excluded: bool) {
        self.core.set_world_area_cost(area, cost, excluded);
    }

    /// Surround slots on a host target (`NavSurround` JSON), or none with an empty string.
    #[wasm_bindgen(js_name = setTargetSurround)]
    pub fn set_target_surround(&mut self, target_id: u32, surround_json: &str) -> Result<(), JsError> {
        let surround = if surround_json.trim().is_empty() {
            None
        } else {
            let d: SurroundDto = serde_json::from_str(surround_json).map_err(|e| JsError::new(&format!("surround: {e}")))?;
            Some(d.into())
        };
        self.core.crowd.set_target_surround(TargetId(target_id), surround);
        Ok(())
    }

    /// A flow goal on a host target (`move_threshold` 0 = the default), or none with `enabled` false.
    #[wasm_bindgen(js_name = setFlowGoal)]
    pub fn set_flow_goal(&mut self, target_id: u32, enabled: bool, move_threshold: f32) {
        self.core.crowd.set_flow_goal(TargetId(target_id), enabled.then_some(NavFlowGoal { move_threshold }));
    }

    #[wasm_bindgen(js_name = removeTarget)]
    pub fn remove_target(&mut self, target_id: u32) {
        self.core.crowd.remove_target(TargetId(target_id));
    }

    /// Host targets' positions for the next tick: `ids[i]` at `positions[3i..3i+3]`. Unlisted targets keep theirs.
    #[wasm_bindgen(js_name = setTargetPositions)]
    pub fn set_target_positions(&mut self, ids: &[u32], positions: &[f32]) {
        for (i, id) in ids.iter().enumerate() {
            let Some(p) = positions.get(i * 3..i * 3 + 3) else { break };
            self.core.targets.retain(|t| t.id != TargetId(*id));
            self.core.targets.push(TargetInput { id: TargetId(*id), position: f3(p[0], p[1], p[2]) });
        }
    }

    // ------------------------------------------------------------------------------------------- the tick

    /// One runtime tick (`engine.NavStep`): reads `agentsIn` / `obstaclesIn`, applies the commands, writes
    /// `agentsOut` / `agentState`.
    pub fn tick(&mut self, dt: f32, time: f64) {
        self.core.tick(dt, time);
    }

    /// What the last tick did, as JSON (`tick`, `agents`, `paused`, `commands`, `chunks`).
    #[wasm_bindgen(js_name = tickStats)]
    pub fn tick_stats(&self) -> String {
        let s = self.core.crowd.last_tick();
        let c = s.chunks;
        serde_json::json!({
            "tick": s.tick,
            "agents": s.agents,
            "paused": s.paused,
            "commands": { "applied": s.commands.applied, "ignored": s.commands.ignored },
            "chunks": {
                "snapshotChanged": c.snapshot_changed, "gatesChanged": c.gates_changed,
                "overlaysBuilt": c.overlays_built, "overlaysRemoved": c.overlays_removed, "overlayFailures": c.overlay_failures,
                "seamsChanged": c.seams_changed, "graphsRebuilt": c.graphs_rebuilt, "gathers": c.gathers
            }
        })
        .to_string()
    }

    // ------------------------------------------------------------------------------------------- buffers

    /// Byte offsets of the boundary buffers in `memory()` (see `nav_crowd::boundary`); they move when `epoch` changes.
    #[wasm_bindgen(js_name = agentsInPtr)]
    pub fn agents_in_ptr(&self) -> u32 {
        self.core.crowd.boundary().agents_in.as_ptr() as usize as u32
    }
    #[wasm_bindgen(js_name = agentsOutPtr)]
    pub fn agents_out_ptr(&self) -> u32 {
        self.core.crowd.boundary().agents_out.as_ptr() as usize as u32
    }
    #[wasm_bindgen(js_name = agentStatePtr)]
    pub fn agent_state_ptr(&self) -> u32 {
        self.core.crowd.boundary().agent_state.as_ptr() as usize as u32
    }
    #[wasm_bindgen(js_name = obstaclesInPtr)]
    pub fn obstacles_in_ptr(&self) -> u32 {
        self.core.crowd.boundary().obstacles_in.as_ptr() as usize as u32
    }
    /// Rows in the agent buffers (agent slots ever made).
    #[wasm_bindgen(js_name = agentRows)]
    pub fn agent_rows(&self) -> u32 {
        (self.core.crowd.boundary().agents_in.len() / AGENT_IN_STRIDE) as u32
    }
    #[wasm_bindgen(js_name = obstacleRows)]
    pub fn obstacle_rows(&self) -> u32 {
        (self.core.crowd.boundary().obstacles_in.len() / OBSTACLE_IN_STRIDE) as u32
    }
    /// Changes whenever the buffers were reallocated (views must be rebuilt).
    pub fn epoch(&self) -> u32 {
        self.core.crowd.boundary().epoch
    }

    // ------------------------------------------------------------------------------------------- state

    /// `[kind, pathState, mode, flags, position xyz, rotation xyzw, up xyz, velocity xyz, desired xyz, remaining,
    /// chunk entry]` (22), or empty for a stale or not yet live handle.
    #[wasm_bindgen(js_name = agentState)]
    pub fn agent_state(&self, agent_handle: f64) -> Vec<f32> {
        let Some(s) = self.core.crowd.agent_state(agent(agent_handle)) else { return Vec::new() };
        let (p, q, u, v, d) = (s.position, s.rotation, s.up, s.velocity, s.desired_velocity);
        vec![
            s.kind as u8 as f32,
            s.path_state as u8 as f32,
            s.mode as u8 as f32,
            s.flags as f32,
            p.x, p.y, p.z, q.x, q.y, q.z, q.w, u.x, u.y, u.z, v.x, v.y, v.z, d.x, d.y, d.z,
            s.remaining_distance,
            s.entry as f32,
        ]
    }

    /// The agent's current path: position xyz, normal xyz, flags per waypoint (copied).
    #[wasm_bindgen(js_name = pathWaypoints)]
    pub fn path_waypoints(&mut self, agent_handle: f64) -> Vec<f32> {
        let mut out = std::mem::take(&mut self.core.scratch);
        self.core.crowd.path_waypoints_flat(agent(agent_handle), &mut out);
        let copy = out.clone();
        self.core.scratch = out;
        copy
    }

    /// Warnings since the last drain (JSON array of strings).
    #[wasm_bindgen(js_name = drainWarnings)]
    pub fn drain_warnings(&mut self) -> String {
        json_strings(&self.core.crowd.drain_warnings())
    }

    /// Log lines since the last drain (JSON array of strings).
    #[wasm_bindgen(js_name = drainLogs)]
    pub fn drain_logs(&mut self) -> String {
        json_strings(&self.core.crowd.drain_logs())
    }

    // ------------------------------------------------------------------------------------------- queries

    /// `[status, (x, y, z, nx, ny, nz, flags)...]`: status 0 full path, 1 partial, 2 none. Flags: waypoint flag bits,
    /// 0x80 on flight points.
    #[wasm_bindgen(js_name = findPath)]
    #[allow(clippy::too_many_arguments)]
    pub fn find_path(&self, agent_type: &str, fx: f32, fy: f32, fz: f32, tx: f32, ty: f32, tz: f32) -> Vec<f32> {
        self.core.find_path(agent_type, f3(fx, fy, fz), f3(tx, ty, tz))
    }

    /// True if a full path exists.
    #[wasm_bindgen(js_name = isReachable)]
    #[allow(clippy::too_many_arguments)]
    pub fn is_reachable(&self, agent_type: &str, fx: f32, fy: f32, fz: f32, tx: f32, ty: f32, tz: f32) -> bool {
        self.core.find_path(agent_type, f3(fx, fy, fz), f3(tx, ty, tz)).first() == Some(&queries::STATUS_SUCCESS)
    }

    /// `[x, y, z, nx, ny, nz]` or empty.
    #[wasm_bindgen(js_name = nearestPoint)]
    pub fn nearest_point(&self, agent_type: &str, x: f32, y: f32, z: f32, max_distance: f32) -> Vec<f32> {
        self.core.nearest_point(agent_type, f3(x, y, z), max_distance)
    }

    /// `[t, reached, x, y, z, nx, ny, nz]` or empty (start off the navmesh).
    #[allow(clippy::too_many_arguments)]
    pub fn raycast(&self, agent_type: &str, fx: f32, fy: f32, fz: f32, tx: f32, ty: f32, tz: f32) -> Vec<f32> {
        self.core.raycast(agent_type, f3(fx, fy, fz), f3(tx, ty, tz))
    }

    // ------------------------------------------------------------------------------------------- debug geometry

    /// A loaded chunk's navmesh for an agent type: segments, stride 7 (see `debug.rs`).
    #[wasm_bindgen(js_name = debugNavmeshLines)]
    pub fn debug_navmesh_lines(&self, chunk_id: &str, agent_type: &str) -> Vec<f32> {
        self.core.chunk(chunk_id).and_then(|c| chunk_parts(c, parse_id(agent_type)).nav.map(|n| debug::navmesh_lines(n))).unwrap_or_default()
    }

    /// A loaded chunk's navmesh polygons as triangles, stride 11 (a, b, c, bin, area).
    #[wasm_bindgen(js_name = debugNavmeshTriangles)]
    pub fn debug_navmesh_triangles(&self, chunk_id: &str, agent_type: &str) -> Vec<f32> {
        self.core.chunk(chunk_id).and_then(|c| chunk_parts(c, parse_id(agent_type)).nav.map(|n| debug::navmesh_triangles(n))).unwrap_or_default()
    }

    /// A loaded chunk's flight leaves for an agent type: stride 5 (min xyz, size, area).
    #[wasm_bindgen(js_name = debugVolumeLeaves)]
    pub fn debug_volume_leaves(&self, chunk_id: &str, agent_type: &str) -> Vec<f32> {
        self.core.chunk(chunk_id).and_then(|c| chunk_parts(c, parse_id(agent_type)).volume.map(|v| debug::volume_leaves(v))).unwrap_or_default()
    }

    /// A loaded chunk's landing links for an agent type: stride 6 (ground xyz, air xyz).
    #[wasm_bindgen(js_name = debugLandingLinks)]
    pub fn debug_landing_links(&self, chunk_id: &str, agent_type: &str) -> Vec<f32> {
        self.core.chunk(chunk_id).and_then(|c| chunk_parts(c, parse_id(agent_type)).links.map(|l| debug::landing_links(l))).unwrap_or_default()
    }

    /// The live seams' links: stride 7.
    #[wasm_bindgen(js_name = debugSeams)]
    pub fn debug_seams(&self) -> Vec<f32> {
        debug::seams(&self.core.crowd.chunks().seams.seams)
    }

    /// Every live agent's current path as segments: stride 7 (a xyz, b xyz, agent row).
    #[wasm_bindgen(js_name = debugAgentPaths)]
    pub fn debug_agent_paths(&self) -> Vec<f32> {
        let mut out = Vec::new();
        let agents = self.core.crowd.agents();
        for row in agents.live_rows() {
            let Some(id) = agents.id_of(row) else { continue };
            let wps = self.core.crowd.path_waypoints(id);
            for w in wps.windows(2) {
                let (a, b) = (w[0].position, w[1].position);
                out.extend_from_slice(&[a.x, a.y, a.z, b.x, b.y, b.z, row as f32]);
            }
        }
        out
    }
}

/// Strides of the boundary buffers: `[agentsIn, agentsOut, agentState, obstaclesIn, waypoint]`.
#[wasm_bindgen(js_name = bufferStrides)]
pub fn buffer_strides() -> Vec<u32> {
    vec![AGENT_IN_STRIDE as u32, AGENT_OUT_STRIDE as u32, AGENT_STATE_STRIDE as u32, OBSTACLE_IN_STRIDE as u32, nav_crowd::boundary::WAYPOINT_STRIDE as u32]
}

/// The module's memory, for typed-array views of the boundary buffers.
#[wasm_bindgen(js_name = wasmMemory)]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_round_trip_through_f64() {
        for h in [Handle::new(0, 1), Handle::new(7, 3), Handle::new(u32::MAX - 1, 1 << 20)] {
            assert_eq!(unpack(pack(h)), h);
        }
        assert_eq!(unpack(-1.0), Handle::NONE);
        assert_eq!(unpack(f64::NAN), Handle::NONE);
    }
}
