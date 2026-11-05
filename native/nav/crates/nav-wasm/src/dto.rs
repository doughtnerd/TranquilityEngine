//! JSON shapes the TypeScript side sends (`src/engine/nav/settings.ts` and the bake/agent descriptions), parsed
//! with serde into DTOs that convert to the `nav-bake` and `nav-crowd` types. Field names are those crates' field
//! names in camelCase; every field is optional (missing ones take the Rust defaults), so the TS schema and this file
//! stay in step by name alone.
//!
//! Ids (agent types, areas, gates, skipped agents) are strings: 32 hex digits are read as a `Hash128` as is, a
//! UUID's 32 hex digits likewise, anything else is hashed ([`parse_id`]).
use nav_bake::bake::{BakeMesh, MeshKind};
use nav_bake::bins::{OrientationConfig, SurfaceRing};
use nav_bake::settings::{
    ChunkSettings, FlightAgent, FlightAutoRefinement, GateVolume, ModifierTargets, ModifierVolume, NavAgentSettings, NavArea,
    NavBakeSettings, NavMeshBuildSettings, NavigationSetup, ResolutionVolume, VoxelSizing, WalkAgent,
};
use nav_crowd::agents::AgentDesc;
use nav_crowd::components::{NavAvoidanceObstacle, NavFormationPreset, NavGroup, NavGroupMode, NavMeshAgentAreaCost, NavSurround};
use nav_crowd::settings::{
    AgentTypeSettings, AgentTypes, CrowdSettings, NavAvoidance, NavEase, NavFlightAgent, NavMeshAgent, NavMotion,
    NavigationRuntimeSettings,
};
use nav_math::math::Float4x4;
use nav_math::{Float3, Float4, Hash128};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// A string id as a `Hash128`: 32 hex digits (a `Hash128::to_hex`) or a UUID (8-4-4-4-12) are read as their digits;
/// anything else is the XXH3-128 of its UTF-8 bytes. The empty string is the invalid (zero) id.
pub fn parse_id(s: &str) -> Hash128 {
    let s = s.trim();
    if s.is_empty() {
        return Hash128::default();
    }
    if let Some(h) = Hash128::from_hex(s) {
        return h;
    }
    if s.len() == 36 && s.as_bytes().iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() }) {
        let digits: String = s.chars().filter(|c| *c != '-').collect();
        if let Some(h) = Hash128::from_hex(&digits) {
            return h;
        }
    }
    Hash128::of_bytes(s.as_bytes())
}

fn ids(list: &[String]) -> Vec<Hash128> {
    list.iter().map(|s| parse_id(s)).filter(|h| h.is_valid()).collect()
}

fn v3(a: [f32; 3]) -> Float3 {
    Float3::new(a[0], a[1], a[2])
}

/// A column-major 4x4 (three.js `Matrix4.elements` order).
fn m4(e: &[f32; 16]) -> Float4x4 {
    Float4x4::new(
        Float4::new(e[0], e[1], e[2], e[3]),
        Float4::new(e[4], e[5], e[6], e[7]),
        Float4::new(e[8], e[9], e[10], e[11]),
        Float4::new(e[12], e[13], e[14], e[15]),
    )
}

/// A DTO with exactly a Rust struct's fields (camelCase), its defaults, and conversions both ways.
macro_rules! mirror {
    ($dto:ident => $target:ty { $($f:ident : $t:ty),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        pub struct $dto { $(pub $f: $t),* }
        impl Default for $dto {
            fn default() -> Self { <$target>::default().into() }
        }
        impl From<$target> for $dto {
            fn from(v: $target) -> Self { Self { $($f: v.$f.into()),* } }
        }
        impl From<$dto> for $target {
            fn from(v: $dto) -> Self { Self { $($f: v.$f.into()),* } }
        }
    };
}

/// A C-like enum DTO (camelCase names) mapped onto a Rust enum.
macro_rules! enum_mirror {
    ($dto:ident => $target:ty { $($v:ident),* $(,)? }) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub enum $dto { #[default] $($v),* }
        impl From<$target> for $dto {
            fn from(v: $target) -> Self { match v { $(<$target>::$v => $dto::$v),* } }
        }
        impl From<$dto> for $target {
            fn from(v: $dto) -> Self { match v { $($dto::$v => <$target>::$v),* } }
        }
    };
}

// ---------------------------------------------------------------------------------------------------------
// Settings pieces that mirror one Rust struct
// ---------------------------------------------------------------------------------------------------------

enum_mirror!(EaseDto => NavEase {
    Constant, InSine, OutSine, InOutSine, InQuad, OutQuad, InOutQuad, InCubic, OutCubic, InOutCubic, InQuart, OutQuart, InOutQuart
});
enum_mirror!(VoxelSizingDto => VoxelSizing { Auto, Fixed });
enum_mirror!(FlightAutoRefineDto => FlightAutoRefinement { Off, X2, X4, X8 });
enum_mirror!(GroupModeDto => NavGroupMode { Formation, Flock });
enum_mirror!(FormationDto => NavFormationPreset { Box, Line, Column, Wedge, Circle, Mask });

mirror!(MotionDto => NavMotion { ease: EaseDto, ease_in_time: f32, ease_out_time: f32 });

mirror!(WalkDto => NavMeshAgent {
    radius: f32, height: f32, step_height: f32, pivot_offset: f32,
    speed: f32, turn_speed: f32, motion: MotionDto,
    can_climb_walls: bool, can_walk_ceilings: bool, max_fold_angle_deg: f32, wall_cost_multiplier: f32, ceiling_cost_multiplier: f32,
    can_jump: bool, max_jump_up_height: f32, max_jump_distance: f32, max_fall_distance: f32, jump_arc_height: f32,
    jump_cost: f32, jump_apex_speed: f32, jump_rise_gravity: f32, jump_fall_gravity: f32,
    waypoint_reached_distance: f32, arrival_distance: f32, max_snap_distance: f32, max_search_nodes: i32,
    stuck_skip_time: f32, flow_field_portal_middles: bool,
    repath_interval: f32, off_path_distance: f32, congestion_cost: f32,
});

mirror!(FlightDto => NavFlightAgent {
    radius: f32, speed: f32, turn_speed: f32, motion: MotionDto,
    waypoint_reached_distance: f32, arrival_distance: f32, max_snap_distance: f32, max_search_nodes: i32,
    repath_interval: f32, off_path_distance: f32,
    max_flight_distance: f32, land_when_out_of_reach: bool, hover_at_chunk_faces: bool, flight_cost_multiplier: f32,
    takeoff_cost: f32, landing_cost: f32, takeoff_speed: f32, max_landing_slope_deg: f32, takeoff_height: f32,
    walk_instead_ratio: f32,
    separation_strength: f32, separation_radius_scale: f32, max_separation_neighbors: i32,
    layers: u32, avoid_layers: u32,
});

mirror!(AvoidanceDto => NavAvoidance {
    radius: f32, neighbor_distance: f32, max_neighbors: i32, time_horizon: f32, obstacle_time_horizon: f32,
    priority: i32, layers: u32, avoid_layers: u32,
});

mirror!(OrientationDto => OrientationConfig {
    max_surface_deg: f32, ground_capture_deg: f32, ceiling_capture_deg: f32, coverage_deg: f32, max_fold_deg: f32,
});

mirror!(SurfaceRingDto => SurfaceRing { tilt_deg: f32, count: i32, azimuth_offset_deg: f32 });

mirror!(BuildDto => NavMeshBuildSettings {
    min_region_area: i32, merge_region_area: i32, max_simplification_error: f32, max_edge_length: i32,
    verts_per_poly: i32, detail_sample_distance: f32, detail_sample_max_error: f32,
});

mirror!(RuntimeDto => NavigationRuntimeSettings {
    max_paths_per_frame: i32, congestion_window: f32, congestion_slot: f32, congestion_repath_interval: f32,
    idle_agents_hold_ground: bool, flow_field_memory_mb: f32, avoidance_neighbor_refresh: i32,
});

mirror!(SurroundDto => NavSurround { radius: f32, spacing: f32, air_spacing: f32, claim_distance: f32, max_slots: i32 });

// ---------------------------------------------------------------------------------------------------------
// The navigation section of project settings
// ---------------------------------------------------------------------------------------------------------

/// A runtime cost volume (ADR 0070, `NavCostVolume`): the box `center` ± `halfSize` in the space `worldToLocal` (the
/// node's inverse world matrix, column-major like three.js) maps world points into.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CostVolumeDto {
    pub world_to_local: [f32; 16],
    pub center: [f32; 3],
    pub half_size: [f32; 3],
    pub cost: f32,
    pub excluded: bool,
    pub agents: Vec<String>,
    /// "ground", "air" or "both".
    pub domain: String,
}

impl Default for CostVolumeDto {
    fn default() -> Self {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        Self { world_to_local: m, center: [0.0; 3], half_size: [0.5; 3], cost: 4.0, excluded: false, agents: Vec::new(), domain: "both".into() }
    }
}

impl CostVolumeDto {
    /// A JSON array of volumes.
    pub fn parse_list(json: &str) -> Result<Vec<Self>, String> {
        serde_json::from_str(json).map_err(|e| format!("cost volumes: {e}"))
    }

    pub fn to_volume(&self) -> nav_query::costs::CostVolume {
        let e = &self.world_to_local;
        let mut m = [0.0f32; 12];
        for row in 0..3 {
            for col in 0..4 {
                m[row * 4 + col] = e[col * 4 + row];
            }
        }
        nav_query::costs::CostVolume {
            world_to_local: m,
            center: v3(self.center),
            half_size: v3(self.half_size),
            cost: self.cost,
            excluded: self.excluded,
            agents: ids(&self.agents),
            ground: self.domain != "air",
            air: self.domain != "ground",
        }
    }
}

/// An area cost override (`NavMeshAgentAreaCost`): `cost` < 0 keeps the area's default cost.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AreaCostDto {
    pub area: String,
    pub cost: f32,
    pub excluded: bool,
}

impl Default for AreaCostDto {
    fn default() -> Self {
        Self { area: String::new(), cost: -1.0, excluded: false }
    }
}

impl AreaCostDto {
    pub fn to_override(&self) -> NavMeshAgentAreaCost {
        NavMeshAgentAreaCost { area_id: parse_id(&self.area), excluded: self.excluded, cost: self.cost }
    }
}

/// One agent type (`NavAgentSettings`): walking, flying and avoidance settings, and its default area costs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentTypeDto {
    pub id: String,
    pub name: String,
    pub can_walk: bool,
    pub walk: WalkDto,
    pub can_fly: bool,
    pub flight: FlightDto,
    /// `null`: the type doesn't avoid (ORCA off).
    pub avoidance: Option<AvoidanceDto>,
    pub join_groups: bool,
    /// Applied to every agent of the type (before the agent's own overrides).
    pub area_costs: Vec<AreaCostDto>,
}

impl Default for AgentTypeDto {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            can_walk: true,
            walk: WalkDto::default(),
            can_fly: false,
            flight: FlightDto::default(),
            avoidance: Some(AvoidanceDto::default()),
            join_groups: false,
            area_costs: Vec::new(),
        }
    }
}

impl AgentTypeDto {
    pub fn hash(&self) -> Hash128 {
        parse_id(&self.id)
    }

    /// The runtime's view (`nav_crowd::settings::AgentTypeSettings`).
    pub fn to_runtime(&self) -> AgentTypeSettings {
        let mut t = AgentTypeSettings {
            id: self.hash(),
            name: self.name.clone(),
            walk: self.can_walk.then(|| Arc::new(NavMeshAgent::from(self.walk.clone()))),
            flight: self.can_fly.then(|| Arc::new(NavFlightAgent::from(self.flight.clone()))),
            avoidance: None,
            join_groups: self.join_groups,
        };
        if let Some(a) = &self.avoidance {
            t = t.with_avoidance(a.clone().into());
        }
        t
    }

    /// The bake's view (`nav_bake::settings::NavAgentSettings`).
    pub fn to_bake(&self) -> NavAgentSettings {
        let w = &self.walk;
        let mut a = NavAgentSettings::new(&self.name, self.hash());
        a.can_walk = self.can_walk;
        a.walk = WalkAgent {
            radius: w.radius,
            height: w.height,
            step_height: w.step_height,
            can_climb_walls: w.can_climb_walls,
            can_walk_ceilings: w.can_walk_ceilings,
            can_jump: w.can_jump,
            max_jump_up_height: w.max_jump_up_height,
            max_jump_distance: w.max_jump_distance,
            max_fall_distance: w.max_fall_distance,
            jump_arc_height: w.jump_arc_height,
        };
        a.can_fly = self.can_fly;
        a.flight = FlightAgent { radius: self.flight.radius, max_landing_slope_deg: self.flight.max_landing_slope_deg };
        a
    }
}

/// An area type: `cost` is its default cost, `color` rgba 0-1 (debug drawing).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AreaDto {
    pub id: String,
    pub name: String,
    pub cost: f32,
    pub color: [f32; 4],
}

impl Default for AreaDto {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), cost: 1.0, color: [1.0, 1.0, 1.0, 1.0] }
    }
}

/// The `navigation` section of `project.json` (`NavigationSetup` + `NavigationRuntimeSettings` + the chunk grid).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NavigationSettingsDto {
    pub agent_types: Vec<AgentTypeDto>,
    pub areas: Vec<AreaDto>,
    pub orientation: OrientationDto,
    pub surface_rings: Vec<SurfaceRingDto>,
    pub voxels: VoxelSizingDto,
    pub cells_per_radius: f32,
    pub cell_size: f32,
    pub cell_height: f32,
    pub tile_size: i32,
    pub build: BuildDto,
    pub flight_voxels: VoxelSizingDto,
    pub flight_cells_per_radius: f32,
    pub flight_cell_size: f32,
    pub flight_headroom_radii: f32,
    pub flight_open_to_sky_only: bool,
    pub flight_auto_refine: FlightAutoRefineDto,
    pub flight_auto_refine_max_cells: i32,
    pub chunk_grid: f32,
    pub runtime: RuntimeDto,
}

impl Default for NavigationSettingsDto {
    fn default() -> Self {
        let s = NavigationSetup::default();
        Self {
            agent_types: Vec::new(),
            areas: Vec::new(),
            orientation: s.orientation.into(),
            surface_rings: s.surface_rings.into_iter().map(Into::into).collect(),
            voxels: s.voxels.into(),
            cells_per_radius: s.cells_per_radius,
            cell_size: s.cell_size,
            cell_height: s.cell_height,
            tile_size: s.tile_size,
            build: s.build.into(),
            flight_voxels: s.flight_voxels.into(),
            flight_cells_per_radius: s.flight_cells_per_radius,
            flight_cell_size: s.flight_cell_size,
            flight_headroom_radii: s.flight_headroom_radii,
            flight_open_to_sky_only: s.flight_open_to_sky_only,
            flight_auto_refine: s.flight_auto_refine.into(),
            flight_auto_refine_max_cells: s.flight_auto_refine_max_cells,
            chunk_grid: nav_bake::settings::DEFAULT_CHUNK_GRID,
            runtime: RuntimeDto::default(),
        }
    }
}

impl NavigationSettingsDto {
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(json).map_err(|e| format!("navigation settings: {e}"))
    }

    pub fn to_setup(&self) -> NavigationSetup {
        NavigationSetup {
            agents: self.agent_types.iter().map(AgentTypeDto::to_bake).collect(),
            areas: self
                .areas
                .iter()
                .map(|a| NavArea { id: parse_id(&a.id), default_cost: a.cost, color: Float4::new(a.color[0], a.color[1], a.color[2], a.color[3]) })
                .collect(),
            orientation: self.orientation.clone().into(),
            surface_rings: self.surface_rings.iter().cloned().map(Into::into).collect(),
            voxels: self.voxels.into(),
            cells_per_radius: self.cells_per_radius,
            cell_size: self.cell_size,
            cell_height: self.cell_height,
            tile_size: self.tile_size,
            build: self.build.clone().into(),
            flight_voxels: self.flight_voxels.into(),
            flight_cells_per_radius: self.flight_cells_per_radius,
            flight_cell_size: self.flight_cell_size,
            flight_headroom_radii: self.flight_headroom_radii,
            flight_open_to_sky_only: self.flight_open_to_sky_only,
            flight_auto_refine: self.flight_auto_refine.into(),
            flight_auto_refine_max_cells: self.flight_auto_refine_max_cells,
        }
    }

    pub fn to_crowd(&self, label: &str) -> CrowdSettings {
        CrowdSettings {
            agent_types: AgentTypes::new(self.agent_types.iter().map(AgentTypeDto::to_runtime).collect()),
            runtime: self.runtime.clone().into(),
            label: label.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Bake input
// ---------------------------------------------------------------------------------------------------------

/// `NavChunk`'s bake-relevant settings (`ChunkSettings`); the grid comes from the settings' `chunkGrid`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChunkDto {
    pub use_chunk_bounds: bool,
    pub center: [f32; 3],
    pub size: [f32; 3],
    pub min_overlay_depth: i32,
    pub max_overlay_depth: i32,
    pub skip_agents: Vec<String>,
}

impl Default for ChunkDto {
    fn default() -> Self {
        let c = ChunkSettings::default();
        Self {
            use_chunk_bounds: c.use_chunk_bounds,
            center: c.center.to_array(),
            size: c.size.to_array(),
            min_overlay_depth: c.min_overlay_depth,
            max_overlay_depth: c.max_overlay_depth,
            skip_agents: Vec::new(),
        }
    }
}

/// Where a modifier volume applies (`ModifierTargets`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppliesToDto {
    #[default]
    Ground,
    Air,
    Both,
}

impl AppliesToDto {
    fn flags(self) -> u8 {
        match self {
            AppliesToDto::Ground => ModifierTargets::GROUND,
            AppliesToDto::Air => ModifierTargets::AIR,
            AppliesToDto::Both => ModifierTargets::GROUND | ModifierTargets::AIR,
        }
    }
}

const IDENTITY: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

/// `NavModifierVolume`: `boxToWorld` maps the unit box `[-0.5, 0.5]^3` to world space (column-major).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModifierVolumeDto {
    pub box_to_world: [f32; 16],
    pub area: String,
    pub applies_to: AppliesToDto,
    pub affected_agents: Vec<String>,
}

impl Default for ModifierVolumeDto {
    fn default() -> Self {
        Self { box_to_world: IDENTITY, area: String::new(), applies_to: AppliesToDto::Ground, affected_agents: Vec::new() }
    }
}

/// `NavGate`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GateDto {
    pub box_to_world: [f32; 16],
    pub id: String,
    pub start_open: bool,
}

impl Default for GateDto {
    fn default() -> Self {
        Self { box_to_world: IDENTITY, id: String::new(), start_open: true }
    }
}

/// `NavResolutionVolume`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResolutionVolumeDto {
    pub box_to_world: [f32; 16],
    pub cell_size: f32,
    pub affected_agents: Vec<String>,
}

impl Default for ResolutionVolumeDto {
    fn default() -> Self {
        Self { box_to_world: IDENTITY, cell_size: 1.0, affected_agents: Vec::new() }
    }
}

/// Everything a chunk's bake reads besides its triangles.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BakeInputDto {
    pub settings: NavigationSettingsDto,
    pub chunk: ChunkDto,
    pub modifier_volumes: Vec<ModifierVolumeDto>,
    pub gates: Vec<GateDto>,
    pub resolution_volumes: Vec<ResolutionVolumeDto>,
    pub scene_path: String,
    pub chunk_node_id: String,
}

impl BakeInputDto {
    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("bake input: {e}"))
    }

    pub fn to_settings(&self) -> NavBakeSettings {
        let c = &self.chunk;
        NavBakeSettings {
            setup: self.settings.to_setup(),
            chunk: ChunkSettings {
                use_chunk_bounds: c.use_chunk_bounds,
                center: v3(c.center),
                size: v3(c.size),
                chunk_grid: self.settings.chunk_grid,
                min_overlay_depth: c.min_overlay_depth,
                max_overlay_depth: c.max_overlay_depth,
                skip_agents: ids(&c.skip_agents),
                ..ChunkSettings::default()
            },
            modifier_volumes: self
                .modifier_volumes
                .iter()
                .map(|m| ModifierVolume::from_box(m4(&m.box_to_world), parse_id(&m.area), m.applies_to.flags(), ids(&m.affected_agents)))
                .collect(),
            gates: self.gates.iter().map(|g| GateVolume::from_box(m4(&g.box_to_world), parse_id(&g.id), g.start_open)).collect(),
            resolution_volumes: self
                .resolution_volumes
                .iter()
                .map(|r| ResolutionVolume::from_box(m4(&r.box_to_world), r.cell_size, ids(&r.affected_agents)))
                .collect(),
        }
    }
}

/// What a mesh is to the bake.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MeshKindDto {
    #[default]
    NavMesh,
    Obstacle,
}

/// One mesh's slice of the flat arrays: `vertexCount` vertices (xyz each) from vertex `vertexStart`, `indexCount`
/// indices from `indexStart`, the indices relative to the mesh's first vertex.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeshEntryDto {
    pub vertex_start: u32,
    pub vertex_count: u32,
    pub index_start: u32,
    pub index_count: u32,
    pub kind: MeshKindDto,
    pub area: Option<String>,
    pub walkable_for: Vec<String>,
}

/// The meshes of a bake from the flat arrays and their table.
pub fn bake_meshes(positions: &[f32], indices: &[u32], table_json: &str) -> Result<Vec<BakeMesh>, String> {
    let table: Vec<MeshEntryDto> = serde_json::from_str(table_json).map_err(|e| format!("mesh table: {e}"))?;
    let mut out = Vec::with_capacity(table.len());
    for (i, m) in table.iter().enumerate() {
        let v0 = m.vertex_start as usize * 3;
        let v1 = v0 + m.vertex_count as usize * 3;
        let i0 = m.index_start as usize;
        let i1 = i0 + m.index_count as usize;
        let (Some(vs), Some(is)) = (positions.get(v0..v1), indices.get(i0..i1)) else {
            return Err(format!("mesh {i}: its vertex or index range is outside the arrays"));
        };
        let positions: Vec<Float3> = vs.as_chunks::<3>().0.iter().map(|p| Float3::new(p[0], p[1], p[2])).collect();
        let area = m.area.as_deref().map(parse_id).filter(|h| h.is_valid());
        out.push(BakeMesh {
            positions,
            indices: is.to_vec(),
            kind: if m.kind == MeshKindDto::Obstacle { MeshKind::Obstacle } else { MeshKind::NavMesh },
            area_id: area,
            walkable_for: ids(&m.walkable_for),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------
// Runtime descriptions
// ---------------------------------------------------------------------------------------------------------

/// `NavGroup`'s settings (the state fields the group steps keep aren't settable).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupDto {
    pub mode: GroupModeDto,
    pub formation: FormationDto,
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
}

impl Default for GroupDto {
    fn default() -> Self {
        let g = NavGroup::default();
        Self {
            mode: g.mode.into(),
            formation: g.formation.into(),
            spacing: g.spacing,
            slack: g.slack,
            catch_up: g.catch_up,
            member_priority: g.member_priority,
            min_pace: g.min_pace,
            layers: g.layers,
            layer_spacing: g.layer_spacing,
            flock_radius: g.flock_radius,
            flock_separation: g.flock_separation,
            flock_alignment: g.flock_alignment,
            flock_cohesion: g.flock_cohesion,
            surround: g.surround,
            squeeze: g.squeeze,
            swap_slots: g.swap_slots,
            bend_columns: g.bend_columns,
            turn_in_place: g.turn_in_place,
            pass_through_each_other: g.pass_through_each_other,
            accept_joiners: g.accept_joiners,
            join_distance: g.join_distance,
            same_goal_distance: g.same_goal_distance,
            max_members: g.max_members,
            merge: g.merge,
            merge_priority: g.merge_priority,
        }
    }
}

impl GroupDto {
    pub fn to_group(&self) -> NavGroup {
        NavGroup {
            mode: self.mode.into(),
            formation: self.formation.into(),
            spacing: self.spacing,
            slack: self.slack,
            catch_up: self.catch_up,
            member_priority: self.member_priority,
            min_pace: self.min_pace,
            layers: self.layers,
            layer_spacing: self.layer_spacing,
            flock_radius: self.flock_radius,
            flock_separation: self.flock_separation,
            flock_alignment: self.flock_alignment,
            flock_cohesion: self.flock_cohesion,
            surround: self.surround,
            squeeze: self.squeeze,
            swap_slots: self.swap_slots,
            bend_columns: self.bend_columns,
            turn_in_place: self.turn_in_place,
            pass_through_each_other: self.pass_through_each_other,
            accept_joiners: self.accept_joiners,
            join_distance: self.join_distance,
            same_goal_distance: self.same_goal_distance,
            max_members: self.max_members,
            merge: self.merge,
            merge_priority: self.merge_priority,
            ..NavGroup::default()
        }
    }
}

/// How an agent is added (`AgentDesc`); `group` makes it a group body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentDescDto {
    pub agent_type: String,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub up: [f32; 3],
    pub update_position: bool,
    pub update_rotation: bool,
    pub speed_override: f32,
    pub turn_speed_override: f32,
    pub avoidance_layers: Option<u32>,
    pub avoid_layers: Option<u32>,
    pub avoidance_priority: Option<i32>,
    pub area_costs: Vec<AreaCostDto>,
    pub group: Option<GroupDto>,
}

impl Default for AgentDescDto {
    fn default() -> Self {
        Self {
            agent_type: String::new(),
            position: [0.0; 3],
            rotation: [0.0, 0.0, 0.0, 1.0],
            up: [0.0, 1.0, 0.0],
            update_position: true,
            update_rotation: true,
            speed_override: 0.0,
            turn_speed_override: 0.0,
            avoidance_layers: None,
            avoid_layers: None,
            avoidance_priority: None,
            area_costs: Vec::new(),
            group: None,
        }
    }
}

impl AgentDescDto {
    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("agent: {e}"))
    }

    /// The crowd's description; `type_costs` (the type's default area costs) come before the agent's own.
    pub fn to_desc(&self, type_costs: &[NavMeshAgentAreaCost]) -> AgentDesc {
        let mut d = AgentDesc::new(parse_id(&self.agent_type), v3(self.position));
        let r = self.rotation;
        d.rotation = Float4::new(r[0], r[1], r[2], r[3]);
        d.up = v3(self.up);
        d.update_position = self.update_position;
        d.update_rotation = self.update_rotation;
        d.speed_override = self.speed_override;
        d.turn_speed_override = self.turn_speed_override;
        d.avoidance_layers = self.avoidance_layers;
        d.avoid_layers = self.avoid_layers;
        d.avoidance_priority = self.avoidance_priority;
        let own: Vec<NavMeshAgentAreaCost> = self.area_costs.iter().map(AreaCostDto::to_override).collect();
        d.area_costs = nav_crowd::filters::effective_area_costs(type_costs, &own);
        d.group = self.group.as_ref().map(GroupDto::to_group);
        d
    }
}

/// An avoidance obstacle (`NavAvoidanceObstacle`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObstacleDto {
    pub radius: f32,
    pub height: f32,
    pub layers: u32,
}

impl Default for ObstacleDto {
    fn default() -> Self {
        Self { radius: 0.5, height: 2.0, layers: 1 }
    }
}

impl From<ObstacleDto> for NavAvoidanceObstacle {
    fn from(o: ObstacleDto) -> Self {
        NavAvoidanceObstacle { radius: o.radius, height: o.height, layers: o.layers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_parse_hex_uuids_and_names() {
        let h = Hash128::new(1, 2, 3, 4);
        assert_eq!(parse_id(&h.to_hex()), h);
        assert_eq!(parse_id("00000001-0000-0002-0000-000300000004"), h);
        assert_eq!(parse_id("walker"), Hash128::of_bytes(b"walker"));
        assert_ne!(parse_id("walker"), parse_id("flyer"));
        assert!(!parse_id("").is_valid());
    }

    #[test]
    fn empty_json_takes_the_rust_defaults() {
        let s = NavigationSettingsDto::parse("{}").unwrap();
        assert_eq!(s.to_setup(), NavigationSetup::default());
        assert_eq!(NavigationSettingsDto::parse("").unwrap(), NavigationSettingsDto::default());
        let a: AgentTypeDto = serde_json::from_str(r#"{"id":"w"}"#).unwrap();
        let r = a.to_runtime();
        assert_eq!(*r.walk.unwrap(), NavMeshAgent::default());
        assert!(r.flight.is_none());
        assert_eq!(*r.avoidance.unwrap(), NavAvoidance::default());
        let rt: NavigationRuntimeSettings = RuntimeDto::default().into();
        assert_eq!(rt, NavigationRuntimeSettings::default());
    }

    #[test]
    fn camel_case_fields_reach_the_rust_structs() {
        let json = r#"{
            "agentTypes": [{
                "id": "hybrid", "name": "Hybrid", "canWalk": true, "canFly": true,
                "walk": { "radius": 0.4, "stepHeight": 0.3, "canClimbWalls": true, "motion": { "ease": "inOutSine", "easeInTime": 0.5 } },
                "flight": { "radius": 0.8, "takeoffCost": 3, "maxLandingSlopeDeg": 20 },
                "avoidance": { "priority": 10, "layers": 2, "avoidLayers": 6 },
                "areaCosts": [{ "area": "mud", "cost": 4 }]
            }, { "id": "plain", "avoidance": null }],
            "areas": [{ "id": "mud", "cost": 3, "color": [0.5, 0.4, 0.1, 1] }],
            "voxels": "fixed", "cellSize": 0.2, "cellHeight": 0.1, "tileSize": 32,
            "orientation": { "maxFoldDeg": 60 },
            "surfaceRings": [{ "tiltDeg": 90, "count": 8 }],
            "flightAutoRefine": "x4", "chunkGrid": 8,
            "runtime": { "maxPathsPerFrame": 4, "idleAgentsHoldGround": true }
        }"#;
        let s = NavigationSettingsDto::parse(json).unwrap();
        let setup = s.to_setup();
        assert_eq!(setup.voxels, VoxelSizing::Fixed);
        assert_eq!((setup.cell_size, setup.cell_height, setup.tile_size), (0.2, 0.1, 32));
        assert_eq!(setup.orientation.max_fold_deg, 60.0);
        assert_eq!(setup.orientation.coverage_deg, OrientationConfig::DEFAULT.coverage_deg);
        assert_eq!(setup.surface_rings, vec![SurfaceRing { tilt_deg: 90.0, count: 8, azimuth_offset_deg: 0.0 }]);
        assert_eq!(setup.flight_auto_refine, FlightAutoRefinement::X4);
        assert_eq!(setup.areas[0].id, parse_id("mud"));
        assert_eq!(setup.areas[0].default_cost, 3.0);
        let bake = &setup.agents[0];
        assert!(bake.can_walk && bake.can_fly && bake.walk.can_climb_walls);
        assert_eq!((bake.walk.radius, bake.walk.step_height, bake.flight.radius, bake.flight.max_landing_slope_deg), (0.4, 0.3, 0.8, 20.0));

        let crowd = s.to_crowd("t");
        assert_eq!(crowd.runtime.max_paths_per_frame, 4);
        assert!(crowd.runtime.idle_agents_hold_ground);
        let t = crowd.agent_types.get(parse_id("hybrid")).unwrap();
        let w = t.walk.as_ref().unwrap();
        assert_eq!(w.motion.ease, NavEase::InOutSine);
        assert_eq!(w.motion.ease_in_time, 0.5);
        assert_eq!(w.motion.ease_out_time, NavMotion::default().ease_out_time);
        let f = t.flight.as_ref().unwrap();
        assert_eq!(f.takeoff_cost, 3.0);
        assert_eq!((f.layers, f.avoid_layers), (2, 6), "flyers take their layers from the avoidance settings");
        assert_eq!(t.avoidance.as_ref().unwrap().priority, 10);
        assert!(crowd.agent_types.get(parse_id("plain")).unwrap().avoidance.is_none());
        assert_eq!(s.agent_types[0].area_costs[0].to_override().area_id, parse_id("mud"));
    }

    #[test]
    fn bake_input_and_mesh_table_convert() {
        let json = r#"{
            "settings": { "chunkGrid": 2 },
            "chunk": { "useChunkBounds": true, "center": [0, 1, 0], "size": [10, 4, 10], "skipAgents": ["x"] },
            "gates": [{ "id": "door", "startOpen": false, "boxToWorld": [2,0,0,0, 0,2,0,0, 0,0,2,0, 5,0,0,1] }],
            "modifierVolumes": [{ "area": "mud", "appliesTo": "both" }],
            "scenePath": "scenes/a.scene.json", "chunkNodeId": "n1"
        }"#;
        let input = BakeInputDto::parse(json).unwrap();
        let s = input.to_settings();
        assert!(s.chunk.use_chunk_bounds);
        assert_eq!(s.chunk.chunk_grid, 2.0);
        assert_eq!(s.chunk.skip_agents, vec![parse_id("x")]);
        assert_eq!(s.gates[0].id, parse_id("door"));
        assert!(!s.gates[0].start_open);
        assert_eq!(s.gates[0].aabb_min, Float3::new(4.0, -1.0, -1.0));
        assert_eq!(s.gates[0].aabb_max, Float3::new(6.0, 1.0, 1.0));
        assert_eq!(s.modifier_volumes[0].applies_to, ModifierTargets::GROUND | ModifierTargets::AIR);

        let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 5.0, 5.0, 5.0];
        let indices = [0, 2, 1, 0, 0, 0];
        let table = r#"[{ "vertexStart": 0, "vertexCount": 3, "indexStart": 0, "indexCount": 3, "walkableFor": ["w"] },
                        { "vertexStart": 3, "vertexCount": 1, "indexStart": 3, "indexCount": 3, "kind": "obstacle", "area": "mud" }]"#;
        let meshes = bake_meshes(&positions, &indices, table).unwrap();
        assert_eq!(meshes.len(), 2);
        assert_eq!(meshes[0].positions[2], Float3::new(1.0, 0.0, 1.0));
        assert_eq!(meshes[0].indices, vec![0, 2, 1]);
        assert_eq!(meshes[0].kind, MeshKind::NavMesh);
        assert_eq!(meshes[0].walkable_for, vec![parse_id("w")]);
        assert_eq!(meshes[1].kind, MeshKind::Obstacle);
        assert_eq!(meshes[1].area_id, Some(parse_id("mud")));
        assert!(bake_meshes(&positions, &indices, r#"[{ "vertexStart": 3, "vertexCount": 2 }]"#).is_err());
    }

    #[test]
    fn agent_descs_merge_type_costs_under_their_own() {
        let d = AgentDescDto::parse(r#"{ "agentType": "w", "position": [1, 2, 3], "areaCosts": [{ "area": "mud", "excluded": true }], "group": { "formation": "wedge", "spacing": 2 } }"#).unwrap();
        let type_costs = [
            NavMeshAgentAreaCost { area_id: parse_id("mud"), excluded: false, cost: 5.0 },
            NavMeshAgentAreaCost { area_id: parse_id("road"), excluded: false, cost: 0.5 },
        ];
        let desc = d.to_desc(&type_costs);
        assert_eq!(desc.agent_type, parse_id("w"));
        assert_eq!(desc.position, Float3::new(1.0, 2.0, 3.0));
        assert_eq!(desc.rotation, Float4::new(0.0, 0.0, 0.0, 1.0));
        assert_eq!(desc.area_costs.len(), 2);
        assert!(desc.area_costs.iter().any(|c| c.area_id == parse_id("mud") && c.excluded));
        let g = desc.group.unwrap();
        assert_eq!(g.formation, NavFormationPreset::Wedge);
        assert_eq!(g.spacing, 2.0);
        assert_eq!(g.slack, NavGroup::default().slack);
    }

    #[test]
    fn cost_volumes_read_their_inverse_matrix_column_major() {
        // A node at x = 10 (world-to-local translates by -10), domain air, one agent type.
        let json = r#"[{"worldToLocal":[1,0,0,0, 0,1,0,0, 0,0,1,0, -10,0,0,1],"center":[0,0,0],"halfSize":[1,1,1],"cost":3,"agents":["w"],"domain":"air"},
                       {"excluded":true,"domain":"ground"}]"#;
        let list = CostVolumeDto::parse_list(json).unwrap();
        let v = list[0].to_volume();
        assert!(v.contains(Float3::new(10.5, 0.0, 0.0)) && !v.contains(Float3::new(0.0, 0.0, 0.0)));
        assert_eq!(v.cost, 3.0);
        assert!(v.air && !v.ground && v.agents == vec![parse_id("w")]);
        let d = list[1].to_volume();
        assert!(d.excluded && d.ground && !d.air && d.agents.is_empty() && d.cost == 4.0, "defaults: cost 4, half size 0.5");
        assert!(d.contains(Float3::new(0.4, -0.4, 0.4)) && !d.contains(Float3::new(0.6, 0.0, 0.0)));
        assert!(CostVolumeDto::parse_list("{").is_err());
    }
}
