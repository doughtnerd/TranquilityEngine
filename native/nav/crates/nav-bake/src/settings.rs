//! The bake's inputs as plain Rust structs, and the pure functions that derive per-profile bake parameters from
//! them. Ports of `Authoring/Baking/BakingComponents.cs` (`BakeProfile`, `BakeFlyer`, `NavMeshBuildSettings`,
//! `NavigationBakeSettings`, volumes), `Authoring/ScriptableObjects/NavigationSetup.cs` and `NavAgentSettings.cs`,
//! `NavChunkAuthoring`, and the grouping and grid layout code of `NavigationBakingSystem.cs`.
//!
//! No Unity types and no editor objects: the authoring layer (TypeScript in Myco) fills these structs and the bake
//! reads them. Only the fields the bake reads are kept; runtime movement fields (speed, steering, costs...) belong to
//! the query/crowd crates. Everything is `Clone + Debug + PartialEq` (serde is not a dependency of this crate yet;
//! the wasm boundary can serialise through its own DTOs).
//!
//! How the pieces fit together, in bake order:
//! 1. [`NavigationSetup`] (what navigation is in a world: agents, areas, surfaces, voxel rules, tile size, flight
//!    rules) plus [`ChunkSettings`] (bounds, overlay depths, skipped agents) and the volumes make a
//!    [`NavBakeSettings`].
//! 2. [`collect_agents`] resolves every listed agent type to a [`BakeProfile`] (walkers) and [`BakeFlyer`]
//!    (flyers): `NavigationSetup.ToBakeProfile` / `ToBakeFlyer`, voxel sizes included ([`auto_voxel_size`]).
//! 3. [`group_agents`] folds walking agent types that would bake the same navmesh into one *group*; a group's index
//!    is its **profile bit** in `TriangleData::walkable_for`, `FlatSpan::mask` and `ModifierVolumeData::profile_mask`.
//!    [`group_flyers`] does the same for flight volumes.
//! 4. [`build_tiers`] groups profiles with equal voxel size into resolution *tiers* (they share rasterization) and
//!    [`build_grids`] lays out one [`BinGrid`] per (tier, bin), split into tiles.
//! 5. [`gather_modifier_volumes`] / [`gather_gates`] resolve volumes into the per-tile builds' inputs.
use nav_format::{NavAreaInfo, NavAreas, NavGates, NavTileAgent};
use nav_math::hash::hash_value;
use nav_math::math::{self, Float4x4};
use nav_math::{Float2, Float3, Float4, Hash128};

use crate::bins::{Bin, BinSetMetadata, OrientationConfig, SurfaceRing};
use crate::types::{BinGrid, GateVolumeData, ModifierVolumeData};

// ---------------------------------------------------------------------------------------------------------
// Polygon build settings
// ---------------------------------------------------------------------------------------------------------

/// How a profile's walkable voxels become polygons (`NavMeshBuildSettings`): Recast's region, contour, polygon and
/// detail settings, in voxel units (cells are `cell_size` wide, cell heights `cell_height` tall).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavMeshBuildSettings {
    /// Walkable islands smaller than this many cells are dropped.
    pub min_region_area: i32,
    /// Regions smaller than this many cells merge into a neighbour where they can.
    pub merge_region_area: i32,
    /// How far, in cells, polygon outlines may stray from the voxel outline.
    pub max_simplification_error: f32,
    /// Longest polygon edge along the navmesh's outline, in cells; longer ones are split. 0 = no limit.
    pub max_edge_length: i32,
    /// Most vertices per polygon (3..=6).
    pub verts_per_poly: i32,
    /// Spacing of the height samples that fit the detail mesh to the surface, in cells. 0 = outline vertices only.
    pub detail_sample_distance: f32,
    /// How far the detail mesh may stray from the surface, in cell heights.
    pub detail_sample_max_error: f32,
}

impl NavMeshBuildSettings {
    /// `NavMeshBuildSettings.Default`.
    pub const DEFAULT: NavMeshBuildSettings = NavMeshBuildSettings {
        min_region_area: 2,
        merge_region_area: 8,
        max_simplification_error: 4.0,
        max_edge_length: 24,
        verts_per_poly: 6,
        detail_sample_distance: 2.0,
        detail_sample_max_error: 1.0,
    };

    /// Values clamped to what Recast supports.
    pub fn validated(self) -> Self {
        Self {
            min_region_area: math::max(0, self.min_region_area),
            merge_region_area: math::max(0, self.merge_region_area),
            max_simplification_error: math::max(0.0, self.max_simplification_error),
            max_edge_length: math::max(0, self.max_edge_length),
            verts_per_poly: math::clamp(self.verts_per_poly, 3, 6),
            detail_sample_distance: math::max(0.0, self.detail_sample_distance),
            detail_sample_max_error: math::max(0.0, self.detail_sample_max_error),
        }
    }
}

impl Default for NavMeshBuildSettings {
    fn default() -> Self {
        Self::DEFAULT
    }
}

// ---------------------------------------------------------------------------------------------------------
// Agents and setup (the settings assets)
// ---------------------------------------------------------------------------------------------------------

/// The walking half of an agent type (`NavMeshAgent`), bake-relevant fields only. Defaults are
/// `NavMeshAgent.Default()`. World units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WalkAgent {
    pub radius: f32,
    pub height: f32,
    pub step_height: f32,
    /// May use wall surfaces (45-135 degrees from up): the profile builds the side bins.
    pub can_climb_walls: bool,
    /// May use ceiling surfaces (more than 135 degrees from up): the profile builds the ceiling bin.
    pub can_walk_ceilings: bool,
    pub can_jump: bool,
    pub max_jump_up_height: f32,
    pub max_jump_distance: f32,
    pub max_fall_distance: f32,
    pub jump_arc_height: f32,
}

impl Default for WalkAgent {
    fn default() -> Self {
        Self {
            radius: 5.0,
            height: 10.0,
            step_height: 2.0,
            can_climb_walls: false,
            can_walk_ceilings: false,
            can_jump: false,
            max_jump_up_height: 50.0,
            max_jump_distance: 20.0,
            max_fall_distance: 100.0,
            jump_arc_height: 20.0,
        }
    }
}

/// The flying half of an agent type (`NavFlightAgent`), bake-relevant fields only.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlightAgent {
    /// Clearance from geometry (the volume is baked for it), world units; at least 0.01.
    pub radius: f32,
    /// Agents that also walk: the steepest floor they take off from or land on.
    pub max_landing_slope_deg: f32,
}

impl Default for FlightAgent {
    fn default() -> Self {
        Self { radius: 5.0, max_landing_slope_deg: 30.0 }
    }
}

/// One agent type (`NavAgentSettings`): whether it walks, flies or both, and the body for each. `id` is its stable
/// id (a GUID in Unity): the id of the navmesh and flight volume baked for it, what the baked agent table refers to,
/// and what mesh `walkable_for` lists and volume `affected_agents` lists name.
#[derive(Clone, Debug, PartialEq)]
pub struct NavAgentSettings {
    pub name: String,
    pub id: Hash128,
    pub can_walk: bool,
    pub walk: WalkAgent,
    pub can_fly: bool,
    pub flight: FlightAgent,
}

impl NavAgentSettings {
    /// `NavAgentSettings` defaults: walks, doesn't fly.
    pub fn new(name: &str, id: Hash128) -> Self {
        Self {
            name: name.to_string(),
            id,
            can_walk: true,
            walk: WalkAgent::default(),
            can_fly: false,
            flight: FlightAgent::default(),
        }
    }
}

/// An area type (`NavMeshArea` asset), as the bake reads it. Area id = `NavAreas::FIRST_CUSTOM` + its index in the
/// setup's list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavArea {
    pub id: Hash128,
    pub default_cost: f32,
    /// Debug colour (rgba).
    pub color: Float4,
}

/// `NavigationSetup.VoxelSizing`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum VoxelSizing {
    /// Derive each agent's voxel size from its radius and step height.
    #[default]
    Auto,
    /// Use the setup's cell size and cell height for every agent.
    Fixed,
}

/// `NavigationSetup.FlightAutoRefinement`: pinches get cells / 2^levels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FlightAutoRefinement {
    #[default]
    Off = 0,
    X2 = 1,
    X4 = 2,
    X8 = 3,
}

/// What navigation is in a world (`NavigationSetup`): agent types, areas, surface settings, and how navmeshes and
/// flight volumes are built. Every chunk references one, so chunks that must join agree by construction.
#[derive(Clone, Debug, PartialEq)]
pub struct NavigationSetup {
    pub agents: Vec<NavAgentSettings>,
    /// At most 62 (`NavAreas::MAX_CUSTOM`).
    pub areas: Vec<NavArea>,
    pub orientation: OrientationConfig,
    pub surface_rings: Vec<SurfaceRing>,
    pub voxels: VoxelSizing,
    /// Auto: voxels across an agent's radius (at least 0.5 when used). Recast suggests 2-3.
    pub cells_per_radius: f32,
    /// Fixed: voxel width in world units.
    pub cell_size: f32,
    /// Fixed: voxel height in world units.
    pub cell_height: f32,
    /// Columns per tile side (16..=256 in the authoring UI; the bake only clamps to at least 16).
    pub tile_size: i32,
    pub build: NavMeshBuildSettings,
    pub flight_voxels: VoxelSizing,
    /// Auto: flight cells across a flyer's radius (at least 0.25 when used).
    pub flight_cells_per_radius: f32,
    /// Fixed: flight cell size in world units.
    pub flight_cell_size: f32,
    /// Free air above the tallest geometry, in flyer radii. 0 = the volume ends at the top of the tallest object.
    pub flight_headroom_radii: f32,
    /// Only air connected to the top of the volume is flyable.
    pub flight_open_to_sky_only: bool,
    pub flight_auto_refine: FlightAutoRefinement,
    /// Auto refinement refines nothing where it would refine more flight cells than this. 0 = no limit.
    pub flight_auto_refine_max_cells: i32,
}

impl NavigationSetup {
    pub const DEFAULT_CELLS_PER_RADIUS: f32 = 2.0;
    pub const DEFAULT_FLIGHT_CELLS_PER_RADIUS: f32 = 1.0;
    pub const DEFAULT_FLIGHT_HEADROOM_RADII: f32 = 4.0;
}

impl Default for NavigationSetup {
    fn default() -> Self {
        Self {
            agents: Vec::new(),
            areas: Vec::new(),
            orientation: OrientationConfig::DEFAULT,
            surface_rings: vec![SurfaceRing::DEFAULT],
            voxels: VoxelSizing::Auto,
            cells_per_radius: Self::DEFAULT_CELLS_PER_RADIUS,
            cell_size: 5.0 / 3.0,
            cell_height: 5.0,
            tile_size: NavigationBakeSettings::DEFAULT_TILE_SIZE,
            build: NavMeshBuildSettings::DEFAULT,
            flight_voxels: VoxelSizing::Auto,
            flight_cells_per_radius: Self::DEFAULT_FLIGHT_CELLS_PER_RADIUS,
            flight_cell_size: 10.0,
            flight_headroom_radii: Self::DEFAULT_FLIGHT_HEADROOM_RADII,
            flight_open_to_sky_only: true,
            flight_auto_refine: FlightAutoRefinement::Off,
            flight_auto_refine_max_cells: 20000,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Bake-wide and chunk settings
// ---------------------------------------------------------------------------------------------------------

/// Bake-wide settings that aren't per profile (`NavigationBakeSettings`): the setup's tile size and the bake options.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavigationBakeSettings {
    /// Columns per tile side.
    pub tile_size: i32,
    /// Worker threads the polymesh stage leaves free.
    pub thread_headroom: i32,
    /// Log per-profile statistics and stitch timings after each bake.
    pub log_details: bool,
}

impl NavigationBakeSettings {
    pub const DEFAULT_TILE_SIZE: i32 = 64;
    pub const DEFAULT_THREAD_HEADROOM: i32 = 4;

    /// Values clamped to what the bake supports.
    pub fn validated(self) -> Self {
        Self { tile_size: math::max(16, self.tile_size), thread_headroom: math::max(0, self.thread_headroom), ..self }
    }

    /// `NavChunkAuthoring.BakeSettings(setup)`.
    pub fn from_setup(setup: &NavigationSetup, thread_headroom: i32, log_details: bool) -> Self {
        Self { tile_size: setup.tile_size, thread_headroom, log_details }.validated()
    }
}

impl Default for NavigationBakeSettings {
    fn default() -> Self {
        Self {
            tile_size: Self::DEFAULT_TILE_SIZE,
            thread_headroom: Self::DEFAULT_THREAD_HEADROOM,
            log_details: false,
        }
    }
}

/// A chunk's resolved world box (`NavChunkBounds`): geometry is clipped to it, walkable ground isn't shrunk at its
/// side faces, the flight volume spans it, and the navmesh records its polygon edges on the side faces. The overlay
/// depths are in tiles.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NavChunkBounds {
    pub min: Float3,
    pub max: Float3,
    pub min_overlay_depth: i32,
    pub max_overlay_depth: i32,
}

/// `NavigationProjectSettings.DefaultChunkGrid`: chunk faces snap to this world grid (x and z).
pub const DEFAULT_CHUNK_GRID: f32 = 4.0;

/// `NavChunkAuthoring`'s bake-relevant settings.
#[derive(Clone, Debug, PartialEq)]
pub struct ChunkSettings {
    /// Bake only what lies inside a box (the box is `center`/`size`, world space, before snapping).
    pub use_chunk_bounds: bool,
    pub center: Float3,
    pub size: Float3,
    /// The chunk grid its faces snap to (`NavigationProjectSettings.ChunkGrid`); 0 = no snapping.
    pub chunk_grid: f32,
    pub min_overlay_depth: i32,
    pub max_overlay_depth: i32,
    /// Agent types (ids) that get no navmesh or flight volume in this chunk.
    pub skip_agents: Vec<Hash128>,
    pub thread_headroom: i32,
    pub log_bake_details: bool,
}

impl Default for ChunkSettings {
    fn default() -> Self {
        Self {
            use_chunk_bounds: false,
            center: Float3::default(),
            size: Float3::new(64.0, 32.0, 64.0),
            chunk_grid: DEFAULT_CHUNK_GRID,
            min_overlay_depth: 1,
            max_overlay_depth: 2,
            skip_agents: Vec::new(),
            thread_headroom: NavigationBakeSettings::DEFAULT_THREAD_HEADROOM,
            log_bake_details: false,
        }
    }
}

/// `NavigationProjectSettings.SnapChunkBounds`: x and z faces snap to `grid` (a box thinner than a step grows to
/// one). Goes through Unity's `Bounds` centre/extents form, as the C# does. Returns `(min, max)`.
pub fn snap_chunk_bounds(min: Float3, max: Float3, grid: f32) -> (Float3, Float3) {
    // `Bounds` stores centre and extents; its min/max are `centre -/+ extents`. The C# reads min/max out of one.
    let (mut min, mut max) = (min, max);
    #[allow(clippy::neg_cmp_op_on_partial_ord)] // NaN grid means no snapping, as in the C#
    let no_snap = !(grid > 0.0);
    if no_snap {
        return (min, max);
    }
    for axis in [0usize, 2] {
        let lo = math::round(min[axis] / grid);
        let mut hi = math::round(max[axis] / grid);
        if hi <= lo {
            hi = lo + 1.0;
        }
        min[axis] = lo * grid;
        max[axis] = hi * grid;
    }
    // Bounds.SetMinMax: extents = (max - min) * 0.5, center = min + extents; min/max read back as center -/+ extents.
    let extents = (max - min) * 0.5;
    let center = min + extents;
    (center - extents, center + extents)
}

impl ChunkSettings {
    /// `ChunkWorldBounds` through Unity's `Bounds(center, size)` (size clamped at zero), as `(min, max)`.
    pub fn world_bounds(&self) -> (Float3, Float3) {
        let size = self.size.max_v(Float3::default());
        let extents = size * 0.5;
        (self.center - extents, self.center + extents)
    }

    /// The baked box (`NavChunkBounds`), or `None` without chunk bounds, or when the snapped box has no volume
    /// (the C# baker warns and bakes without bounds).
    pub fn resolved_bounds(&self) -> Option<NavChunkBounds> {
        if !self.use_chunk_bounds {
            return None;
        }
        let (wmin, wmax) = self.world_bounds();
        let (min, max) = snap_chunk_bounds(wmin, wmax, self.chunk_grid);
        let size = max - min;
        if !(size.x > 0.0 && size.y > 0.0 && size.z > 0.0) {
            return None;
        }
        let lo = math::max(1, self.min_overlay_depth);
        Some(NavChunkBounds {
            min,
            max,
            min_overlay_depth: lo,
            max_overlay_depth: math::max(lo, self.max_overlay_depth),
        })
    }

    /// `NavChunkAuthoring.Bakes`: the agent is listed on the setup and not skipped here.
    pub fn bakes(&self, setup: &NavigationSetup, agent: &NavAgentSettings) -> bool {
        setup.agents.iter().any(|a| a.id == agent.id) && !self.skip_agents.contains(&agent.id)
    }
}

// ---------------------------------------------------------------------------------------------------------
// Volumes (modifier, gate, resolution)
// ---------------------------------------------------------------------------------------------------------

/// What a modifier volume changes (`ModifierTargets` flags).
pub struct ModifierTargets;
impl ModifierTargets {
    /// The walkable surface (navmesh polygons).
    pub const GROUND: u8 = 1;
    /// The flight space (flight volume cells).
    pub const AIR: u8 = 2;
}

/// The world AABB of an oriented unit box transformed by `box_to_world` (the 8 corners of `[-0.5, 0.5]^3`), as the
/// authoring baker computes it.
pub fn box_aabb(box_to_world: Float4x4) -> (Float3, Float3) {
    let mut min = Float3::splat(f32::MAX);
    let mut max = Float3::splat(f32::MIN);
    for i in 0..8 {
        let corner = Float3::new((i & 1) as f32 - 0.5, ((i >> 1) & 1) as f32 - 0.5, ((i >> 2) & 1) as f32 - 0.5);
        let world = box_to_world.transform_point(corner);
        min = min.min_v(world);
        max = max.max_v(world);
    }
    (min, max)
}

/// `NavMeshModifierVolume`, baked form (`ModifierVolume` + its `ModifierVolumeAgent` list): an oriented box that sets
/// the area of the walkable surface (Ground) and/or the flight cells (Air) inside it.
#[derive(Clone, Debug, PartialEq)]
pub struct ModifierVolume {
    /// Maps world space into the box's frame, where the box is `[-0.5, 0.5]` on every axis.
    pub world_to_unit_box: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    pub area_id: Hash128,
    /// `ModifierTargets` flags.
    pub applies_to: u8,
    /// Agent type ids it applies to. Empty = every agent type.
    pub affected_agents: Vec<Hash128>,
}

impl ModifierVolume {
    /// From the box's `BoxToWorld` matrix (`localToWorld * TRS(center, identity, size)`).
    pub fn from_box(box_to_world: Float4x4, area_id: Hash128, applies_to: u8, affected_agents: Vec<Hash128>) -> Self {
        let (aabb_min, aabb_max) = box_aabb(box_to_world);
        Self { world_to_unit_box: box_to_world.inverse(), aabb_min, aabb_max, area_id, applies_to, affected_agents }
    }
}

/// `NavMeshGate`, baked form (`GateVolume` + `NavGate.Open`).
#[derive(Clone, Debug, PartialEq)]
pub struct GateVolume {
    pub world_to_unit_box: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    pub id: Hash128,
    pub start_open: bool,
}

impl GateVolume {
    pub fn from_box(box_to_world: Float4x4, id: Hash128, start_open: bool) -> Self {
        let (aabb_min, aabb_max) = box_aabb(box_to_world);
        Self { world_to_unit_box: box_to_world.inverse(), aabb_min, aabb_max, id, start_open }
    }
}

/// `NavResolutionVolume`, baked form (`ResolutionVolume` + `ResolutionVolumeAgent`): an oriented box where flight
/// volumes use smaller cells (`cell_size`, world units; each volume rounds it to its own cell size / 2, 4 or 8,
/// never below the heightfield voxel).
#[derive(Clone, Debug, PartialEq)]
pub struct ResolutionVolume {
    pub world_to_unit_box: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    pub cell_size: f32,
    /// Flying agent type ids it applies to. Empty = every flying agent type.
    pub affected_agents: Vec<Hash128>,
}

impl ResolutionVolume {
    pub fn from_box(box_to_world: Float4x4, cell_size: f32, affected_agents: Vec<Hash128>) -> Self {
        let (aabb_min, aabb_max) = box_aabb(box_to_world);
        Self { world_to_unit_box: box_to_world.inverse(), aabb_min, aabb_max, cell_size, affected_agents }
    }
}

/// Everything the bake reads besides geometry: one chunk's setup, chunk settings and volumes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavBakeSettings {
    pub setup: NavigationSetup,
    pub chunk: ChunkSettings,
    pub modifier_volumes: Vec<ModifierVolume>,
    pub gates: Vec<GateVolume>,
    pub resolution_volumes: Vec<ResolutionVolume>,
}

// ---------------------------------------------------------------------------------------------------------
// BakeProfile / BakeFlyer and their derivation
// ---------------------------------------------------------------------------------------------------------

/// What to bake for one agent type (`BakeProfile`): its walking settings resolved with the Navigation Setup. After
/// [`group_agents`] each entry is one navmesh *group*; its index is its profile bit.
#[derive(Clone, Debug, PartialEq)]
pub struct BakeProfile {
    pub id: Hash128,
    /// At most 61 bytes (`FixedString64Bytes`).
    pub name: String,
    pub radius: f32,
    pub height: f32,
    pub step_height: f32,
    pub build_walls: bool,
    pub build_ceilings: bool,
    pub can_jump: bool,
    pub max_jump_up_height: f32,
    pub max_jump_distance: f32,
    pub max_fall_distance: f32,
    pub jump_arc_height: f32,
    /// Effective voxel size (the setup's fixed size, or derived from the agent). Profiles with equal values share
    /// rasterization (a tier).
    pub cell_size: f32,
    pub cell_height: f32,
    pub build: NavMeshBuildSettings,
}

/// At most 32 profiles (bits of a `u32` profile mask).
pub const MAX_PROFILES: usize = 32;

impl BakeProfile {
    /// An agent type in metres like Foxfire's `TestNavBake.Profile()`: radius 0.5, height 2, step 0.5, 0.25 x 0.2
    /// voxels (set by hand, not derived), floors only by default, jump limits 1 / 4 / 2 with a 1 m arc. For tests.
    pub fn test_profile(can_jump: bool, walls: bool, ceilings: bool, id: u32) -> Self {
        Self {
            id: Hash128::new(id, 0, 0, 0),
            name: "Test".to_string(),
            radius: 0.5,
            height: 2.0,
            step_height: 0.5,
            build_walls: walls,
            build_ceilings: ceilings,
            can_jump,
            max_jump_up_height: 1.0,
            max_jump_distance: 4.0,
            max_fall_distance: 2.0,
            jump_arc_height: 1.0,
            cell_size: 0.25,
            cell_height: 0.2,
            build: NavMeshBuildSettings::DEFAULT,
        }
    }

    /// `BuildProfilePolyMeshJob.TileAgent`: what the tile builder needs from a profile (also what the chunk border
    /// keeps).
    pub fn tile_agent(&self) -> NavTileAgent {
        let build = &self.build;
        NavTileAgent {
            radius: self.radius,
            height: self.height,
            step_height: self.step_height,
            min_region_area: build.min_region_area,
            merge_region_area: build.merge_region_area,
            max_simplification_error: build.max_simplification_error,
            max_edge_length: build.max_edge_length,
            verts_per_poly: build.verts_per_poly,
            detail_sample_distance: build.detail_sample_distance,
            detail_sample_max_error: build.detail_sample_max_error,
        }
    }

    /// Why this voxel size will break the navmesh up, or `None` (`BakeProfile.VoxelWarning`).
    pub fn voxel_warning(&self, orientation: &OrientationConfig) -> Option<String> {
        let climb = (self.step_height / self.cell_height).floor() * self.cell_height;
        if climb <= 0.0 {
            return Some(format!(
                "Step Height ({}) is below Cell Height ({}): no two voxel columns at different heights connect, so every \
                 surface that isn't exactly level in its bin breaks into strips with gaps. Use a Cell Height of Step \
                 Height / 2 or less.",
                self.step_height, self.cell_height
            ));
        }
        let max_tilt = (climb / self.cell_size).atan().to_degrees();
        if max_tilt < orientation.coverage_deg {
            return Some(format!(
                "Surfaces tilted more than ~{:.0} degrees from their bin's up break into strips with gaps (Step Height {} \
                 over Cell Size {}), but Coverage Deg lets a bin take surfaces up to {:.0} degrees off. Lower Cell Height \
                 or Cell Size, or lower Coverage Deg and add surface rings.",
                max_tilt, self.step_height, self.cell_size, orientation.coverage_deg
            ));
        }
        None
    }
}

/// What flight volume to bake for one flying agent type (`BakeFlyer`).
#[derive(Clone, Debug, PartialEq)]
pub struct BakeFlyer {
    pub id: Hash128,
    pub name: String,
    /// Clearance from geometry, world units.
    pub radius: f32,
    /// Requested flight cell size; 0 = `radius / cells_per_radius`. [`group_flyers`] snaps it to whole voxels.
    pub cell_size: f32,
    pub cells_per_radius: f32,
    /// Free air above the tallest geometry, world units.
    pub headroom: f32,
    pub open_to_sky_only: bool,
    /// Agents that also walk: the steepest floor they take off from or land on.
    pub max_landing_slope_deg: f32,
    /// Auto refinement: pinches get cells / 2^levels (0 = off, at most 3).
    pub auto_refine_levels: i32,
    /// Refine nothing if more base cells than this would be refined (0 = no cap).
    pub auto_refine_max_cells: i32,
}

impl BakeFlyer {
    /// Like Foxfire's `TestNavBake.Flyer()`: radius 5, 0.5 m cells, no headroom unless given. For tests.
    pub fn test_flyer(radius: f32, cell_size: f32, headroom: f32, id: u32, max_landing_slope_deg: f32) -> Self {
        Self {
            id: Hash128::new(id, 0, 0, 0),
            name: "Test flyer".to_string(),
            radius,
            cell_size,
            cells_per_radius: 1.0,
            headroom,
            open_to_sky_only: true,
            max_landing_slope_deg,
            auto_refine_levels: 0,
            auto_refine_max_cells: 0,
        }
    }

    /// The flight cell size a flyer asks for, before rounding to whole voxels (`RequestedFlightCellSize`).
    pub fn requested_cell_size(&self) -> f32 {
        if self.cell_size > 0.0 {
            self.cell_size
        } else {
            self.radius / math::max(self.cells_per_radius, 0.25)
        }
    }
}

/// Truncates to what a `FixedString64Bytes` holds (61 bytes of UTF-8), on a character boundary.
pub fn truncate_name(name: &str) -> String {
    const MAX: usize = 61;
    if name.len() <= MAX {
        return name.to_string();
    }
    let mut end = MAX;
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_string()
}

/// `Round3`: rounds to 3 significant digits, so agents of nearly equal size land in one resolution tier.
///
/// The C# uses `math.pow(10f, floor(log10(v)) - 2)`; here the power of ten is computed in `f64` and rounded to `f32`
/// once, which is the correctly rounded `10^e` (what `pow` gives for these exact cases).
fn round3(value: f32) -> f32 {
    let e = (value as f64).log10().floor() - 2.0;
    let scale = 10f64.powf(e) as f32;
    math::round(value / scale) * scale
}

/// `NavigationSetup.AutoVoxelSize`: Recast's rules of thumb: a cell a fraction of the agent's radius wide, and half
/// the step height tall so a step always spans at least two cells (at most half the cell width). Rounded to 3
/// significant digits. Returns `(cell_size, cell_height)`.
pub fn auto_voxel_size(radius: f32, step_height: f32, cells_per_radius: f32) -> (f32, f32) {
    let cell_size = round3(math::max(radius, 0.01) / math::max(cells_per_radius, 0.5));
    let cell_height = if step_height > 0.0 {
        round3(math::min(0.5 * cell_size, 0.5 * step_height))
    } else {
        round3(0.5 * cell_size)
    };
    (cell_size, cell_height)
}

/// `NavigationSetup.ToBakeProfile`: what to bake for one agent type with this setup (`None` = the defaults).
pub fn to_bake_profile(setup: Option<&NavigationSetup>, agent: &NavAgentSettings) -> BakeProfile {
    let config = &agent.walk;
    let build = setup.map_or(NavMeshBuildSettings::DEFAULT, |s| s.build).validated();
    let (cell_size, cell_height) = match setup {
        Some(s) if s.voxels == VoxelSizing::Fixed => (s.cell_size, s.cell_height),
        _ => auto_voxel_size(
            config.radius,
            config.step_height,
            setup.map_or(NavigationSetup::DEFAULT_CELLS_PER_RADIUS, |s| s.cells_per_radius),
        ),
    };
    BakeProfile {
        id: agent.id,
        name: truncate_name(&agent.name),
        radius: config.radius,
        height: config.height,
        step_height: config.step_height,
        build_walls: config.can_climb_walls,
        build_ceilings: config.can_walk_ceilings,
        can_jump: config.can_jump,
        max_jump_up_height: config.max_jump_up_height,
        max_jump_distance: config.max_jump_distance,
        max_fall_distance: config.max_fall_distance,
        jump_arc_height: config.jump_arc_height,
        cell_size,
        cell_height,
        build,
    }
}

/// `NavigationSetup.ToBakeFlyer`: what flight volume to bake for one flying agent type with this setup.
pub fn to_bake_flyer(setup: Option<&NavigationSetup>, agent: &NavAgentSettings) -> BakeFlyer {
    let radius = math::max(agent.flight.radius, 0.01);
    let fixed = setup.is_some_and(|s| s.flight_voxels == VoxelSizing::Fixed);
    BakeFlyer {
        id: agent.id,
        name: truncate_name(&agent.name),
        radius,
        cell_size: if fixed { setup.map_or(0.0, |s| s.flight_cell_size) } else { 0.0 },
        cells_per_radius: setup
            .map_or(NavigationSetup::DEFAULT_FLIGHT_CELLS_PER_RADIUS, |s| s.flight_cells_per_radius),
        headroom: radius * setup.map_or(NavigationSetup::DEFAULT_FLIGHT_HEADROOM_RADII, |s| s.flight_headroom_radii),
        open_to_sky_only: setup.is_none_or(|s| s.flight_open_to_sky_only),
        auto_refine_levels: setup.map_or(0, |s| s.flight_auto_refine as i32),
        auto_refine_max_cells: setup.map_or(0, |s| s.flight_auto_refine_max_cells),
        max_landing_slope_deg: agent.flight.max_landing_slope_deg,
    }
}

/// One `BakeProfile` per walking agent type and one `BakeFlyer` per flying one, as `NavChunkAuthoring`'s baker
/// collects them (before grouping).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CollectedAgents {
    pub profiles: Vec<BakeProfile>,
    pub flyers: Vec<BakeFlyer>,
    /// Warnings the C# logs (too many agent types, voxel-size warnings).
    pub warnings: Vec<String>,
}

/// The chunk baker's agent loop: setup agents in order, skipping those the chunk skips; flyers and walkers
/// deduplicated by id; at most [`MAX_PROFILES`] walkers.
pub fn collect_agents(setup: &NavigationSetup, chunk: &ChunkSettings) -> CollectedAgents {
    let mut out = CollectedAgents::default();
    for agent in &setup.agents {
        if !chunk.bakes(setup, agent) {
            continue;
        }
        if agent.can_fly {
            let flyer = to_bake_flyer(Some(setup), agent);
            if !out.flyers.iter().any(|o| o.id == flyer.id) {
                out.flyers.push(flyer);
            }
        }

        if !agent.can_walk {
            continue;
        }
        let walker = to_bake_profile(Some(setup), agent);
        if out.profiles.iter().any(|o| o.id == walker.id) {
            continue;
        }
        if out.profiles.len() == MAX_PROFILES {
            out.warnings.push(format!("more than {MAX_PROFILES} agent types; the rest get no navmesh."));
            break;
        }
        if let Some(w) = walker.voxel_warning(&setup.orientation) {
            out.warnings.push(format!("agent {}: {w}", agent.name));
        }
        out.profiles.push(walker);
    }
    out
}

/// The baked area table (`BuildAreaTable`), indexed by area id: 0 = not walkable, 1 = plain walkable (cost 1), then
/// the setup's areas in order (at most `NavAreas::MAX_CUSTOM`; the rest are dropped, as the baker does).
pub fn build_area_table(areas: &[NavArea]) -> Vec<NavAreaInfo> {
    let n = areas.len().min(NavAreas::MAX_CUSTOM as usize);
    let mut table = vec![NavAreaInfo::default(); NavAreas::FIRST_CUSTOM as usize + n];
    table[NavAreas::NULL as usize] = NavAreaInfo { cost: 1.0, ..NavAreaInfo::default() };
    table[NavAreas::WALKABLE as usize] = NavAreaInfo { cost: 1.0, color: Float4::splat(1.0), ..NavAreaInfo::default() };
    for (i, a) in areas.iter().take(n).enumerate() {
        table[NavAreas::FIRST_CUSTOM as usize + i] = NavAreaInfo { id: a.id, cost: a.default_cost, color: a.color };
    }
    table
}

/// `AreaIndex`: an area asset's id in the table, or `None` if the setup doesn't list it (the C# warns and bakes it as
/// plain walkable: use [`area_index_or_walkable`]).
pub fn area_index(table: &[NavAreaInfo], id: Hash128) -> Option<i32> {
    (NavAreas::FIRST_CUSTOM as usize..table.len()).find(|&a| table[a].id == id).map(|a| a as i32)
}

/// [`area_index`], or `NavAreas::WALKABLE` for an unlisted area.
pub fn area_index_or_walkable(table: &[NavAreaInfo], id: Hash128) -> i32 {
    area_index(table, id).unwrap_or(NavAreas::WALKABLE)
}

// ---------------------------------------------------------------------------------------------------------
// Grouping agent types into navmeshes ("profiles") and flight volumes
// ---------------------------------------------------------------------------------------------------------

/// A stable per-user hash standing in for `NavHash.Value(entity, salt)`: which mesh or volume names an agent type.
/// Only equality of the per-agent sums matters (agents named by different sets don't share a navmesh or volume).
pub fn named_by_hash(salt: u32, index: usize) -> u64 {
    hash_value(index as u32, salt as u64)
}

/// Which meshes and modifier volumes name each agent type, as an order-independent sum of hashes (`GroupAgents`'s
/// first half). `mesh_walkable_for[m]` is mesh m's `WalkableAgent` list (empty = walkable for all, names nobody);
/// volumes that don't touch the ground don't count. Salts match the C# (1 = mesh, 2 = volume).
pub fn named_by_for_walkers(
    agents: &[BakeProfile],
    mesh_walkable_for: &[Vec<Hash128>],
    volumes: &[ModifierVolume],
) -> Vec<u64> {
    let mut named = vec![0u64; agents.len()];
    let mut add = |id: Hash128, user: u64| {
        for (a, agent) in agents.iter().enumerate() {
            if agent.id == id {
                named[a] = named[a].wrapping_add(user);
            }
        }
    };
    for (m, list) in mesh_walkable_for.iter().enumerate() {
        for id in list {
            add(*id, named_by_hash(1, m));
        }
    }
    for (v, volume) in volumes.iter().enumerate() {
        // Air-only volumes don't touch the navmesh (flyers are grouped by them instead).
        if volume.applies_to & ModifierTargets::GROUND == 0 {
            continue;
        }
        for id in &volume.affected_agents {
            add(*id, named_by_hash(2, v));
        }
    }
    named
}

/// Whether two agent types (or a group and an agent type) build the same navmesh (`SameNavMesh`).
pub fn same_nav_mesh(a: &BakeProfile, b: &BakeProfile) -> bool {
    a.radius == b.radius
        && a.height == b.height
        && a.step_height == b.step_height
        && a.build_walls == b.build_walls
        && a.build_ceilings == b.build_ceilings
        && a.cell_size == b.cell_size
        && a.cell_height == b.cell_height
        && a.build == b.build
        // Jump links are checked for clearance along the arc, so jumpers must share one.
        && (!a.can_jump || !b.can_jump || a.jump_arc_height == b.jump_arc_height)
}

/// The result of grouping agent types.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grouping<T> {
    /// One entry per group, in order of each group's first member. A group's index is its profile (volume) bit.
    pub groups: Vec<T>,
    /// For each input agent, its group index.
    pub agent_group: Vec<usize>,
}

/// `GroupAgents`: groups the agent types that would bake the same navmesh: equal radius, height, step, surfaces,
/// voxel size and polygon settings, a compatible jump arc, and named by the same mesh `walkable_for` and modifier
/// volume lists (`named`, from [`named_by_for_walkers`]). A group bakes once, as one profile, with its most capable
/// member's jump limits (jump links are upper bounds each agent filters by its own limits at query time).
pub fn group_agents(agents: &[BakeProfile], named: &[u64]) -> Grouping<BakeProfile> {
    let mut list: Vec<BakeProfile> = Vec::with_capacity(agents.len());
    let mut list_named: Vec<u64> = Vec::with_capacity(agents.len());
    let mut agent_group = Vec::with_capacity(agents.len());
    for (a, agent) in agents.iter().enumerate() {
        let mut g = 0;
        while g < list.len() && (list_named[g] != named[a] || !same_nav_mesh(&list[g], agent)) {
            g += 1;
        }
        if g == list.len() {
            list.push(agent.clone());
            list_named.push(named[a]);
        } else if agent.can_jump {
            let group = &mut list[g];
            group.jump_arc_height = agent.jump_arc_height;
            group.max_jump_up_height =
                math::max(if group.can_jump { group.max_jump_up_height } else { 0.0 }, agent.max_jump_up_height);
            group.max_jump_distance =
                math::max(if group.can_jump { group.max_jump_distance } else { 0.0 }, agent.max_jump_distance);
            group.max_fall_distance =
                math::max(if group.can_jump { group.max_fall_distance } else { 0.0 }, agent.max_fall_distance);
            group.can_jump = true;
        }
        agent_group.push(g);
    }
    Grouping { groups: list, agent_group }
}

/// `AllProfiles`: every profile (group) bit.
pub fn all_profiles(count: usize) -> u32 {
    if count >= 32 {
        u32::MAX
    } else {
        (1u32 << count) - 1
    }
}

/// `GroupBit`: the profile (group) bit of an agent type, or 0 if it isn't among `agents`.
pub fn group_bit(id: Hash128, agents: &[BakeProfile], agent_group: &[usize]) -> u32 {
    for (a, agent) in agents.iter().enumerate() {
        if agent.id == id {
            return 1u32 << agent_group[a];
        }
    }
    0
}

/// Whether two flying agent types bake the same flight volume (`SameVolume`).
pub fn same_volume(a: &BakeFlyer, b: &BakeFlyer) -> bool {
    a.radius == b.radius
        && a.cell_size == b.cell_size
        && a.headroom == b.headroom
        && a.open_to_sky_only == b.open_to_sky_only
        && a.auto_refine_levels == b.auto_refine_levels
        && a.auto_refine_max_cells == b.auto_refine_max_cells
}

/// A mask of the first `count` flyers (volume indices), at most 64.
pub fn all_flyers_mask(count: usize) -> u64 {
    if count >= 64 {
        u64::MAX
    } else {
        (1u64 << count) - 1
    }
}

/// Which Air modifier volumes and resolution volumes name each flyer, as a sum of hashes (`GatherAirVolumes`,
/// `GatherResolutionVolumes`' `namedBy`), plus each volume's flyer mask. Salts match the C# (3 = air modifier, 5 =
/// resolution). Returns `(air_masks, resolution_masks, named_by)`: `air_masks[v]` is `None` for modifier volumes that
/// don't apply to the Air (they're skipped); masks have bit f set for flyer f (the first 64 flyers).
#[allow(clippy::needless_range_loop)]
pub fn named_by_for_flyers(
    flyers: &[BakeFlyer],
    modifier_volumes: &[ModifierVolume],
    resolution_volumes: &[ResolutionVolume],
) -> (Vec<Option<u64>>, Vec<u64>, Vec<u64>) {
    let mut named = vec![0u64; flyers.len()];
    let all = all_flyers_mask(flyers.len());
    let mask_of = |ids: &[Hash128], empty_means_all: bool| {
        let mut mask = if ids.is_empty() && empty_means_all { all } else { 0u64 };
        for id in ids {
            for (f, flyer) in flyers.iter().enumerate().take(64) {
                if flyer.id == *id {
                    mask |= 1u64 << f;
                }
            }
        }
        mask
    };

    let mut air = Vec::with_capacity(modifier_volumes.len());
    for (v, volume) in modifier_volumes.iter().enumerate() {
        if volume.applies_to & ModifierTargets::AIR == 0 {
            air.push(None);
            continue;
        }
        let mask = mask_of(&volume.affected_agents, true);
        let hash = named_by_hash(3, v);
        for f in 0..flyers.len().min(64) {
            if mask & (1u64 << f) != 0 {
                named[f] = named[f].wrapping_add(hash);
            }
        }
        air.push(Some(mask));
    }

    let mut res = Vec::with_capacity(resolution_volumes.len());
    for (v, volume) in resolution_volumes.iter().enumerate() {
        let mask = mask_of(&volume.affected_agents, true);
        let hash = named_by_hash(5, v);
        for f in 0..flyers.len().min(64) {
            if mask & (1u64 << f) != 0 {
                named[f] = named[f].wrapping_add(hash);
            }
        }
        res.push(mask);
    }
    (air, res, named)
}

/// `GroupFlyers`: groups the flying agent types that would bake the same flight volume: equal radius, cell size
/// (resolved to whole voxels of the heightfield it's built from, `voxel_size`), headroom, sky rule, refinement, and
/// named by the same Air modifier volumes and resolution volumes (`named`, from [`named_by_for_flyers`]). Each
/// group's `cell_size` is the requested size rounded to whole voxels (at least one).
pub fn group_flyers(flyers: &[BakeFlyer], named: &[u64], voxel_size: f32) -> Grouping<BakeFlyer> {
    let mut list: Vec<BakeFlyer> = Vec::with_capacity(flyers.len());
    let mut list_named: Vec<u64> = Vec::with_capacity(flyers.len());
    let mut agent_group = Vec::with_capacity(flyers.len());
    for (f, flyer) in flyers.iter().enumerate() {
        let mut flyer = flyer.clone();
        flyer.cell_size = math::max(1.0, math::round(flyer.requested_cell_size() / voxel_size)) * voxel_size;
        let mut g = 0;
        while g < list.len() && (list_named[g] != named[f] || !same_volume(&list[g], &flyer)) {
            g += 1;
        }
        if g == list.len() {
            list.push(flyer);
            list_named.push(named[f]);
        }
        agent_group.push(g);
    }
    Grouping { groups: list, agent_group }
}

// ---------------------------------------------------------------------------------------------------------
// Volume gathering
// ---------------------------------------------------------------------------------------------------------

/// `GatherModifierVolumes`: every modifier volume with its area id and the profiles (groups) it applies to resolved.
/// Volumes that don't apply to the Ground get no profiles. `agents`/`agent_group` are the ungrouped walking agent
/// types and their groups (a [`Grouping`]'s `agent_group`); `profile_count` the number of groups.
pub fn gather_modifier_volumes(
    volumes: &[ModifierVolume],
    area_table: &[NavAreaInfo],
    agents: &[BakeProfile],
    agent_group: &[usize],
    profile_count: usize,
) -> Vec<ModifierVolumeData> {
    volumes
        .iter()
        .map(|v| {
            let mut mask = if v.affected_agents.is_empty() { all_profiles(profile_count) } else { 0u32 };
            for id in &v.affected_agents {
                mask |= group_bit(*id, agents, agent_group);
            }
            if v.applies_to & ModifierTargets::GROUND == 0 {
                mask = 0; // Air only: no navmesh profile
            }
            ModifierVolumeData {
                world_to_unit_box: v.world_to_unit_box,
                aabb_min: v.aabb_min,
                aabb_max: v.aabb_max,
                area: area_index_or_walkable(area_table, v.area_id),
                profile_mask: mask,
            }
        })
        .collect()
}

/// The gate table the bake produces (`GatherGates`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GateTable {
    /// One per gate, in gate-index order (gate index = position + 1).
    pub volumes: Vec<GateVolumeData>,
    /// `ids[i]` is gate index i's id; entry 0 is unused (no gate).
    pub ids: Vec<Hash128>,
    /// `closed[i]` is gate index i's starting state; entry 0 is unused.
    pub closed: Vec<bool>,
    /// More gates than `NavGates::MAX` were given; the rest are ignored.
    pub truncated: bool,
}

/// `GatherGates`: every gate, sorted by id so gate indices are stable from bake to bake; at most `NavGates::MAX`.
pub fn gather_gates(gates: &[GateVolume]) -> GateTable {
    let mut order: Vec<usize> = (0..gates.len()).collect();
    order.sort_by(|&a, &b| gates[a].id.cmp(&gates[b].id));

    let count = gates.len().min(NavGates::MAX as usize);
    let mut table = GateTable {
        volumes: Vec::with_capacity(count),
        ids: Vec::with_capacity(count + 1),
        closed: Vec::with_capacity(count + 1),
        truncated: gates.len() > NavGates::MAX as usize,
    };
    table.ids.push(Hash128::default());
    table.closed.push(false);
    for (g, &i) in order.iter().take(count).enumerate() {
        let gate = &gates[i];
        table.volumes.push(GateVolumeData {
            world_to_unit_box: gate.world_to_unit_box,
            aabb_min: gate.aabb_min,
            aabb_max: gate.aabb_max,
            gate: g as i32 + 1,
        });
        table.ids.push(gate.id);
        table.closed.push(!gate.start_open);
    }
    table
}

// ---------------------------------------------------------------------------------------------------------
// Resolution tiers and voxel grids
// ---------------------------------------------------------------------------------------------------------

/// Most finer levels a resolution region can ask for: cells of the base / 2^3 (`NavVolumeParallelBuilder.MaxRegionLevels`).
pub const MAX_REGION_LEVELS: i32 = 3;

/// `NavVolumeParallelBuilder.Level`: finer levels a region of `target` cell size gets in a volume of `cell_size`
/// (`voxels` voxels per cell). round(log2(ratio)) without log2, so every target agrees.
pub fn region_level(cell_size: f32, target: f32, voxels: i32) -> i32 {
    if target <= 0.0 {
        return 0;
    }
    let ratio = cell_size / target;
    let mut k = 0;
    while k < MAX_REGION_LEVELS && ratio >= core::f32::consts::SQRT_2 * (1 << k) as f32 {
        k += 1;
    }
    while k > 0 && voxels % (1 << k) != 0 {
        k -= 1;
    }
    k
}

/// A resolution volume as the tier computation reads it: its requested cell size and the flyers it applies to
/// (bit f = flyer f, before grouping).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResolutionBox {
    pub cell_size: f32,
    pub volume_mask: u64,
}

/// A resolution tier: profiles with the same cell size share rasterization (`BuildGrids`' tier lists).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tier {
    pub cs: f32,
    pub ch: f32,
    /// Profile bits rasterized into this tier's grids.
    pub mask: u32,
    /// Smallest walkable climb (voxels) among the tier's profiles.
    pub climb: i32,
    /// Any profile builds walls / ceilings.
    pub walls: bool,
    pub ceilings: bool,
    /// Largest walkable radius in voxels: sets the tile border.
    pub radius_cells: i32,
}

/// The tiers and each profile's tier.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tiers {
    pub tiers: Vec<Tier>,
    /// `profile_tier[p]` is profile (group) p's tier index.
    pub profile_tier: Vec<usize>,
}

/// The tier computation of `BuildGrids`: profiles with equal `(cell_size, cell_height)` share a tier, in order of
/// first appearance. With no walking profile (flyers only) there is one tier for the flight volumes: two voxels
/// across the smallest flight cell, or as small as the finest resolution region asks for.
pub fn build_tiers(profiles: &[BakeProfile], flyers: &[BakeFlyer], resolution_boxes: &[ResolutionBox]) -> Tiers {
    let mut tiers: Vec<Tier> = Vec::new();
    let mut profile_tier = Vec::with_capacity(profiles.len());
    for (p, profile) in profiles.iter().enumerate() {
        let mut t = 0;
        while t < tiers.len() && !(tiers[t].cs == profile.cell_size && tiers[t].ch == profile.cell_height) {
            t += 1;
        }
        if t == tiers.len() {
            tiers.push(Tier {
                cs: profile.cell_size,
                ch: profile.cell_height,
                mask: 0,
                climb: i32::MAX,
                walls: false,
                ceilings: false,
                radius_cells: 0,
            });
        }
        profile_tier.push(t);
        let tier = &mut tiers[t];
        tier.mask |= 1u32 << p;
        tier.climb = tier.climb.min((profile.step_height / profile.cell_height).floor() as i32);
        tier.walls |= profile.build_walls;
        tier.ceilings |= profile.build_ceilings;
        tier.radius_cells = tier.radius_cells.max((profile.radius / profile.cell_size).ceil() as i32);
    }

    // Only flyers: one rasterization tier for the flight volumes.
    if tiers.is_empty() {
        let mut cs = f32::MAX;
        for (f, flyer) in flyers.iter().enumerate() {
            let requested = flyer.requested_cell_size();
            cs = math::min(cs, 0.5 * requested);
            cs = math::min(cs, requested / (1 << math::clamp(flyer.auto_refine_levels, 0, MAX_REGION_LEVELS)) as f32);
            for b in resolution_boxes {
                if f < 64 && b.volume_mask & (1u64 << f) != 0 {
                    cs = math::min(cs, requested / (1 << region_level(requested, b.cell_size, 1 << MAX_REGION_LEVELS)) as f32);
                }
            }
        }
        tiers.push(Tier {
            cs,
            ch: 0.5 * cs,
            mask: 0,
            climb: i32::MAX,
            walls: false,
            ceilings: false,
            radius_cells: 0,
        });
    }
    Tiers { tiers, profile_tier }
}

/// The voxel grids of a bake: `grids[tier * bin_count + bin]`, and the total tile count.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grids {
    pub grids: Vec<BinGrid>,
    pub bin_count: usize,
    pub tile_count: i32,
}

impl Grids {
    /// The grid of (tier, bin).
    pub fn get(&self, tier: usize, bin: usize) -> &BinGrid {
        &self.grids[tier * self.bin_count + bin]
    }
}

/// The grid layout of `BuildGrids`: one voxel grid per (tier, bin). Only bins some profile in the tier builds are
/// active (the ground bin always is); each active grid is split into `tile_size` x `tile_size` tiles whose indices
/// follow in grid order (`first_tile`). The per-grid column heads (`Heightfield`) are not allocated here.
pub fn build_grids(
    tiers: &Tiers,
    bins: &[Bin],
    meta: &BinSetMetadata,
    tile_size: i32,
    chunk: Option<&NavChunkBounds>,
) -> Grids {
    let bin_count = bins.len();
    let bounded = chunk.is_some();
    let (box_min, box_max) = chunk.map_or((Float3::default(), Float3::default()), |c| (c.min, c.max));
    let mut grids = Vec::with_capacity(tiers.tiers.len() * bin_count);
    let mut tile_count = 0i32;
    for (t, tier) in tiers.tiers.iter().enumerate() {
        for (k, bin) in bins.iter().enumerate() {
            let (cs, ch) = (tier.cs, tier.ch);
            let size = bin.bounds.max - bin.bounds.min;
            let mut grid = BinGrid {
                tier: t as i32,
                bin: k as i32,
                // The ground bin is always needed: jump clearance and the flight volume use it.
                active: k == 0 || meta.bin_needed(k as i32, tier.walls, tier.ceilings),
                cs,
                ch,
                bounds: bin.bounds,
                world_to_local: bin.world_to_local,
                width: (size.x / cs + 0.5) as i32,
                height: (size.z / cs + 0.5) as i32,
                depth: (size.y / ch + 0.5) as i32,
                tier_mask: tier.mask,
                flag_merge_threshold: tier.climb,
                tile_size,
                border: tier.radius_cells + 3,
                tiles_x: 0,
                tiles_z: 0,
                first_tile: 0,
                clip: bounded,
                box_min,
                box_max,
                faces: bounded && k == 0, // the ground bin's frame is the identity: its grid is the box
                open_sides: 0,
            };

            if grid.active {
                grid.tiles_x = math::max(1, (grid.width + tile_size - 1) / tile_size);
                grid.tiles_z = math::max(1, (grid.height + tile_size - 1) / tile_size);
                grid.first_tile = tile_count;
                tile_count += grid.tiles_x * grid.tiles_z;
            }
            grids.push(grid);
        }
    }
    Grids { grids, bin_count, tile_count }
}

/// Convenience: `Float2(cs, ch)` of a tier, the key profiles are tiered by.
pub fn tier_cells(tier: &Tier) -> Float2 {
    Float2::new(tier.cs, tier.ch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bins::OrientationBinSet;

    fn agent(name: &str, id: u32, radius: f32, height: f32, step: f32) -> NavAgentSettings {
        let mut a = NavAgentSettings::new(name, Hash128::new(id, 0, 0, 0));
        a.walk.radius = radius;
        a.walk.height = height;
        a.walk.step_height = step;
        a
    }

    #[test]
    fn defaults_match_the_csharp() {
        let s = NavigationSetup::default();
        assert_eq!(s.voxels, VoxelSizing::Auto);
        assert_eq!(s.cells_per_radius, 2.0);
        assert_eq!(s.tile_size, 64);
        assert_eq!(s.cell_size, 5.0 / 3.0);
        assert_eq!(s.cell_height, 5.0);
        assert_eq!(s.build, NavMeshBuildSettings::DEFAULT);
        assert_eq!(s.build.verts_per_poly, 6);
        assert_eq!(s.flight_cells_per_radius, 1.0);
        assert_eq!(s.flight_headroom_radii, 4.0);
        assert!(s.flight_open_to_sky_only);
        assert_eq!(s.flight_auto_refine, FlightAutoRefinement::Off);
        assert_eq!(s.flight_auto_refine_max_cells, 20000);
        assert_eq!(s.surface_rings, vec![SurfaceRing::DEFAULT]);
        assert_eq!(WalkAgent::default().radius, 5.0);
        assert_eq!(WalkAgent::default().step_height, 2.0);
    }

    #[test]
    fn build_settings_validate() {
        let s = NavMeshBuildSettings { verts_per_poly: 9, min_region_area: -3, max_simplification_error: -1.0, ..Default::default() };
        let v = s.validated();
        assert_eq!((v.verts_per_poly, v.min_region_area, v.max_simplification_error), (6, 0, 0.0));
        assert_eq!(NavMeshBuildSettings { verts_per_poly: 1, ..Default::default() }.validated().verts_per_poly, 3);
    }

    #[test]
    fn auto_voxel_size_rules() {
        // radius 0.5, cells per radius 2 -> 0.25; step 0.5 -> half the step (0.25) vs half the cell (0.125) -> 0.125.
        assert_eq!(auto_voxel_size(0.5, 0.5, 2.0), (0.25, 0.125));
        // Default agent: radius 5, step 2 -> cell 2.5, height min(1.25, 1.0) = 1.
        assert_eq!(auto_voxel_size(5.0, 2.0, 2.0), (2.5, 1.0));
        // No step height: half the cell.
        assert_eq!(auto_voxel_size(5.0, 0.0, 2.0), (2.5, 1.25));
        // Rounded to 3 significant digits.
        let (cs, _) = auto_voxel_size(1.0, 1.0, 3.0);
        assert_eq!(cs, 0.333);
        let (cs, _) = auto_voxel_size(0.0, 1.0, 2.0); // radius clamped to 0.01
        assert_eq!(cs, 0.005);
    }

    #[test]
    fn profile_from_setup_auto_and_fixed() {
        let a = agent("Walker", 1, 0.5, 2.0, 0.5);
        let mut setup = NavigationSetup { agents: vec![a.clone()], ..Default::default() };
        let p = to_bake_profile(Some(&setup), &a);
        assert_eq!((p.cell_size, p.cell_height), (0.25, 0.125));
        assert_eq!((p.radius, p.height, p.step_height), (0.5, 2.0, 0.5));
        assert_eq!(p.name, "Walker");
        setup.voxels = VoxelSizing::Fixed;
        setup.cell_size = 0.25;
        setup.cell_height = 0.2;
        let p = to_bake_profile(Some(&setup), &a);
        assert_eq!((p.cell_size, p.cell_height), (0.25, 0.2));
        // No setup: the defaults.
        let p = to_bake_profile(None, &a);
        assert_eq!(p.cell_size, 0.25);
        assert_eq!(p.build, NavMeshBuildSettings::DEFAULT);
    }

    #[test]
    fn test_profile_matches_foxfire_test_bake() {
        let p = BakeProfile::test_profile(false, false, false, 1);
        assert_eq!((p.radius, p.height, p.step_height), (0.5, 2.0, 0.5));
        assert_eq!((p.cell_size, p.cell_height), (0.25, 0.2));
        // climb = floor(0.5 / 0.2) = 2 voxels; border = ceil(0.5 / 0.25) + 3 = 5.
        let t = build_tiers(std::slice::from_ref(&p), &[], &[]);
        assert_eq!(t.tiers.len(), 1);
        assert_eq!(t.tiers[0].climb, 2);
        assert_eq!(t.tiers[0].radius_cells, 2);
        assert_eq!(t.tiers[0].mask, 1);
        // atan(0.4 / 0.25) = 58 degrees: under the default coverage (60) the bake warns, under 45 it doesn't.
        assert!(p.voxel_warning(&OrientationConfig::DEFAULT).is_some());
        assert!(p.voxel_warning(&OrientationConfig { coverage_deg: 45.0, ..OrientationConfig::DEFAULT }).is_none());
        assert_eq!(p.tile_agent().verts_per_poly, 6);
        assert_eq!(p.tile_agent().radius, 0.5);
    }

    #[test]
    fn flyer_derivation() {
        let mut a = NavAgentSettings::new("Bird", Hash128::new(7, 0, 0, 0));
        a.can_fly = true;
        a.flight.radius = 2.0;
        let mut setup = NavigationSetup { agents: vec![a.clone()], ..Default::default() };
        let f = to_bake_flyer(Some(&setup), &a);
        assert_eq!(f.radius, 2.0);
        assert_eq!(f.cell_size, 0.0);
        assert_eq!(f.headroom, 8.0);
        assert_eq!(f.requested_cell_size(), 2.0);
        assert!(f.open_to_sky_only);
        setup.flight_voxels = VoxelSizing::Fixed;
        setup.flight_cell_size = 3.0;
        setup.flight_auto_refine = FlightAutoRefinement::X4;
        let f = to_bake_flyer(Some(&setup), &a);
        assert_eq!((f.cell_size, f.auto_refine_levels), (3.0, 2));
        assert_eq!(to_bake_flyer(None, &a).headroom, 8.0);
        let tiny = NavAgentSettings { flight: FlightAgent { radius: 0.0, ..Default::default() }, ..a.clone() };
        assert_eq!(to_bake_flyer(None, &tiny).radius, 0.01);
    }

    #[test]
    fn collect_skips_dedupes_and_warns() {
        let a = agent("A", 1, 0.5, 2.0, 0.5);
        let b = agent("B", 2, 0.5, 2.0, 0.5);
        let setup = NavigationSetup { agents: vec![a.clone(), a.clone(), b.clone()], ..Default::default() };
        let chunk = ChunkSettings { skip_agents: vec![b.id], ..Default::default() };
        let c = collect_agents(&setup, &chunk);
        assert_eq!(c.profiles.len(), 1);
        assert_eq!(c.profiles[0].id, a.id);
        assert!(c.flyers.is_empty());

        let many = NavigationSetup {
            agents: (1..=40).map(|i| agent("x", i, 0.5, 2.0, 0.5)).collect(),
            ..Default::default()
        };
        let c = collect_agents(&many, &ChunkSettings::default());
        assert_eq!(c.profiles.len(), MAX_PROFILES);
        assert!(c.warnings.iter().any(|w| w.contains("more than 32")));
    }

    #[test]
    fn identical_agents_group_into_one_profile() {
        let a = BakeProfile::test_profile(false, false, false, 1);
        let b = BakeProfile::test_profile(false, false, false, 2);
        let mut c = BakeProfile::test_profile(false, false, false, 3);
        c.radius = 1.0;
        let g = group_agents(&[a.clone(), b.clone(), c.clone()], &[0, 0, 0]);
        assert_eq!(g.groups.len(), 2);
        assert_eq!(g.agent_group, vec![0, 0, 1]);
        assert_eq!(g.groups[0].id, a.id);
        // Named by different sets: not grouped.
        let g = group_agents(&[a.clone(), b.clone()], &[5, 6]);
        assert_eq!(g.groups.len(), 2);
        // Group bits.
        let agents = [a.clone(), b.clone(), c.clone()];
        let gg = group_agents(&agents, &[0, 0, 0]);
        assert_eq!(group_bit(b.id, &agents, &gg.agent_group), 1);
        assert_eq!(group_bit(c.id, &agents, &gg.agent_group), 2);
        assert_eq!(group_bit(Hash128::new(9, 9, 9, 9), &agents, &gg.agent_group), 0);
        assert_eq!(all_profiles(2), 3);
        assert_eq!(all_profiles(32), u32::MAX);
    }

    #[test]
    fn grouped_jumpers_take_the_most_capable_limits() {
        let mut a = BakeProfile::test_profile(false, false, false, 1);
        let mut b = BakeProfile::test_profile(true, false, false, 2);
        b.max_jump_up_height = 3.0;
        b.max_jump_distance = 9.0;
        let mut c = BakeProfile::test_profile(true, false, false, 3);
        c.max_jump_up_height = 2.0;
        c.max_fall_distance = 8.0;
        a.max_jump_up_height = 100.0; // a doesn't jump: its limits don't count
        let g = group_agents(&[a, b, c], &[0, 0, 0]);
        assert_eq!(g.groups.len(), 1);
        let p = &g.groups[0];
        assert!(p.can_jump);
        assert_eq!((p.max_jump_up_height, p.max_jump_distance, p.max_fall_distance), (3.0, 9.0, 8.0));
        // Different jump arcs between two jumpers keep them apart.
        let j1 = BakeProfile::test_profile(true, false, false, 1);
        let mut j2 = BakeProfile::test_profile(true, false, false, 2);
        j2.jump_arc_height = 2.0;
        assert_eq!(group_agents(&[j1, j2], &[0, 0]).groups.len(), 2);
    }

    #[test]
    fn named_by_mesh_and_volume_lists() {
        let a = BakeProfile::test_profile(false, false, false, 1);
        let b = BakeProfile::test_profile(false, false, false, 2);
        // Mesh 0 is walkable only for a: a and b no longer bake the same navmesh.
        let named = named_by_for_walkers(&[a.clone(), b.clone()], &[vec![a.id]], &[]);
        assert_ne!(named[0], named[1]);
        assert_eq!(group_agents(&[a.clone(), b.clone()], &named).groups.len(), 2);
        // An Air-only volume naming a doesn't split the navmesh.
        let air = ModifierVolume {
            world_to_unit_box: Float4x4::IDENTITY,
            aabb_min: Float3::default(),
            aabb_max: Float3::default(),
            area_id: Hash128::default(),
            applies_to: ModifierTargets::AIR,
            affected_agents: vec![a.id],
        };
        assert_eq!(named_by_for_walkers(&[a, b], &[], &[air]), vec![0, 0]);
    }

    #[test]
    fn flyer_grouping_snaps_to_voxels() {
        let f1 = BakeFlyer::test_flyer(5.0, 0.5, 0.0, 100, 30.0);
        let mut f2 = f1.clone();
        f2.id = Hash128::new(101, 0, 0, 0);
        f2.cell_size = 0.52; // rounds to the same 2 voxels of 0.25
        let g = group_flyers(&[f1.clone(), f2], &[0, 0], 0.25);
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].cell_size, 0.5);
        let mut f3 = f1.clone();
        f3.radius = 3.0;
        assert_eq!(group_flyers(&[f1, f3], &[0, 0], 0.25).groups.len(), 2);
        // Never below one voxel.
        let mut tiny = BakeFlyer::test_flyer(5.0, 0.01, 0.0, 1, 30.0);
        assert_eq!(group_flyers(&[tiny.clone()], &[0], 0.25).groups[0].cell_size, 0.25);
        tiny.cell_size = 0.0; // radius / cells_per_radius = 5
        assert_eq!(group_flyers(&[tiny], &[0], 0.25).groups[0].cell_size, 5.0);
    }

    #[test]
    fn flyer_masks_and_names() {
        let f = [BakeFlyer::test_flyer(5.0, 0.5, 0.0, 100, 30.0), BakeFlyer::test_flyer(5.0, 0.5, 0.0, 101, 30.0)];
        let mk = |agents: Vec<Hash128>, applies| ModifierVolume {
            world_to_unit_box: Float4x4::IDENTITY,
            aabb_min: Float3::default(),
            aabb_max: Float3::default(),
            area_id: Hash128::default(),
            applies_to: applies,
            affected_agents: agents,
        };
        let vols = [mk(vec![], ModifierTargets::AIR), mk(vec![f[1].id], ModifierTargets::AIR | ModifierTargets::GROUND), mk(vec![], ModifierTargets::GROUND)];
        let (air, res, named) = named_by_for_flyers(&f, &vols, &[]);
        assert_eq!(air, vec![Some(3), Some(2), None]);
        assert!(res.is_empty());
        assert_ne!(named[0], named[1]);
    }

    #[test]
    fn modifier_volume_resolution() {
        let a = BakeProfile::test_profile(false, false, false, 1);
        let b = BakeProfile::test_profile(false, false, false, 2);
        let mut c = BakeProfile::test_profile(false, false, false, 3);
        c.radius = 1.0;
        let agents = [a.clone(), b.clone(), c.clone()];
        let g = group_agents(&agents, &[0, 0, 0]);
        let table = build_area_table(&[NavArea { id: Hash128::new(5, 0, 0, 0), default_cost: 3.0, color: Float4::splat(0.5) }]);
        assert_eq!(table.len(), 3);
        assert_eq!(table[1].cost, 1.0);
        assert_eq!(table[2].cost, 3.0);
        let mk = |agents: Vec<Hash128>, area, applies| ModifierVolume {
            world_to_unit_box: Float4x4::IDENTITY,
            aabb_min: Float3::default(),
            aabb_max: Float3::default(),
            area_id: area,
            applies_to: applies,
            affected_agents: agents,
        };
        let vols = [
            mk(vec![], Hash128::new(5, 0, 0, 0), ModifierTargets::GROUND),
            mk(vec![c.id], Hash128::new(5, 0, 0, 0), ModifierTargets::GROUND),
            mk(vec![], Hash128::new(5, 0, 0, 0), ModifierTargets::AIR),
            mk(vec![], Hash128::new(6, 0, 0, 0), ModifierTargets::GROUND), // unlisted area
        ];
        let data = gather_modifier_volumes(&vols, &table, &agents, &g.agent_group, g.groups.len());
        assert_eq!(data[0].profile_mask, 3);
        assert_eq!(data[0].area, 2);
        assert_eq!(data[1].profile_mask, 2);
        assert_eq!(data[2].profile_mask, 0);
        assert_eq!(data[3].area, NavAreas::WALKABLE);
        assert_eq!(area_index(&table, Hash128::new(6, 0, 0, 0)), None);
    }

    #[test]
    fn gates_sort_by_id() {
        let mk = |id: u32, open| GateVolume {
            world_to_unit_box: Float4x4::IDENTITY,
            aabb_min: Float3::default(),
            aabb_max: Float3::default(),
            id: Hash128::new(id, 0, 0, 0),
            start_open: open,
        };
        let t = gather_gates(&[mk(9, true), mk(3, false), mk(5, true)]);
        assert_eq!(t.ids[1..], [Hash128::new(3, 0, 0, 0), Hash128::new(5, 0, 0, 0), Hash128::new(9, 0, 0, 0)]);
        assert_eq!(t.closed, vec![false, true, false, false]);
        assert_eq!(t.volumes.iter().map(|v| v.gate).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(!t.truncated);
    }

    #[test]
    fn chunk_bounds_snap() {
        let chunk = ChunkSettings {
            use_chunk_bounds: true,
            center: Float3::new(1.0, 5.0, 1.0),
            size: Float3::new(61.0, 10.0, 62.0),
            ..Default::default()
        };
        let b = chunk.resolved_bounds().unwrap();
        // x: -29.5..31.5 -> /4 round -> -7..8 -> -28..32 ; z: -30..32 -> round(-7.5) = -8, round(8)=8 -> -32..32
        assert_eq!((b.min.x, b.max.x), (-28.0, 32.0));
        assert_eq!((b.min.z, b.max.z), (-32.0, 32.0));
        assert_eq!((b.min.y, b.max.y), (0.0, 10.0));
        assert_eq!((b.min_overlay_depth, b.max_overlay_depth), (1, 2));
        // A box thinner than the grid grows to one step.
        let thin = ChunkSettings { use_chunk_bounds: true, size: Float3::new(0.5, 4.0, 0.5), ..Default::default() };
        let b = thin.resolved_bounds().unwrap();
        assert_eq!(b.max.x - b.min.x, 4.0);
        // Flat boxes bake without bounds.
        let flat = ChunkSettings { use_chunk_bounds: true, size: Float3::new(8.0, 0.0, 8.0), ..Default::default() };
        assert!(flat.resolved_bounds().is_none());
        assert!(ChunkSettings::default().resolved_bounds().is_none());
        // Overlay depths: max never below min.
        let deep = ChunkSettings { use_chunk_bounds: true, min_overlay_depth: 5, max_overlay_depth: 2, ..Default::default() };
        let b = deep.resolved_bounds().unwrap();
        assert_eq!((b.min_overlay_depth, b.max_overlay_depth), (5, 5));
    }

    #[test]
    fn bake_settings_clamp() {
        let s = NavigationBakeSettings { tile_size: 4, thread_headroom: -2, log_details: false }.validated();
        assert_eq!((s.tile_size, s.thread_headroom), (16, 0));
        assert_eq!(NavigationBakeSettings::default().tile_size, 64);
    }

    #[test]
    fn box_aabb_of_translated_scaled_box() {
        // BoxToWorld = TRS(centre (10, 0, 0), identity, size (2, 4, 6)).
        let m = Float4x4::new(
            Float4::new(2.0, 0.0, 0.0, 0.0),
            Float4::new(0.0, 4.0, 0.0, 0.0),
            Float4::new(0.0, 0.0, 6.0, 0.0),
            Float4::new(10.0, 0.0, 0.0, 1.0),
        );
        let (lo, hi) = box_aabb(m);
        assert_eq!((lo, hi), (Float3::new(9.0, -2.0, -3.0), Float3::new(11.0, 2.0, 3.0)));
        let v = ModifierVolume::from_box(m, Hash128::default(), ModifierTargets::GROUND, vec![]);
        let inside = v.world_to_unit_box.transform_point(Float3::new(10.0, 0.0, 0.0));
        assert_eq!(inside, Float3::default());
        let corner = v.world_to_unit_box.transform_point(Float3::new(11.0, 2.0, 3.0));
        assert!((corner.x - 0.5).abs() < 1e-6 && (corner.y - 0.5).abs() < 1e-6 && (corner.z - 0.5).abs() < 1e-6);
    }

    #[test]
    fn tiers_share_equal_voxel_sizes() {
        let a = BakeProfile::test_profile(false, false, false, 1);
        let mut b = BakeProfile::test_profile(false, true, false, 2);
        b.radius = 1.0; // ceil(1 / 0.25) = 4 cells
        let mut c = BakeProfile::test_profile(false, false, true, 3);
        c.cell_size = 0.5;
        c.step_height = 1.0;
        let t = build_tiers(&[a, b, c], &[], &[]);
        assert_eq!(t.tiers.len(), 2);
        assert_eq!(t.profile_tier, vec![0, 0, 1]);
        assert_eq!(t.tiers[0].mask, 0b011);
        assert_eq!(t.tiers[0].radius_cells, 4);
        assert!(t.tiers[0].walls && !t.tiers[0].ceilings);
        assert!(t.tiers[1].ceilings);
        assert_eq!(t.tiers[1].climb, 5); // floor(1.0 / 0.2)
        assert_eq!(tier_cells(&t.tiers[1]), Float2::new(0.5, 0.2));
    }

    #[test]
    fn flyers_only_tier_is_two_voxels_per_smallest_cell() {
        let f = BakeFlyer::test_flyer(5.0, 0.5, 0.0, 100, 30.0);
        let t = build_tiers(&[], std::slice::from_ref(&f), &[]);
        assert_eq!(t.tiers.len(), 1);
        assert_eq!((t.tiers[0].cs, t.tiers[0].ch), (0.25, 0.125));
        // A resolution region asking 0.125 cells in a 0.5-cell volume: 2 levels finer.
        let boxes = [ResolutionBox { cell_size: 0.125, volume_mask: 1 }];
        let t = build_tiers(&[], std::slice::from_ref(&f), &boxes);
        assert_eq!(t.tiers[0].cs, 0.125); // level 2: 0.5 / 4
        // Auto refine levels count too.
        let mut r = f;
        r.auto_refine_levels = 3;
        assert_eq!(build_tiers(&[], &[r], &[]).tiers[0].cs, 0.0625);
        assert_eq!(region_level(0.5, 0.25, 8), 1);
        assert_eq!(region_level(0.5, 0.0, 8), 0);
        assert_eq!(region_level(0.5, 0.01, 8), 3);
        assert_eq!(region_level(0.5, 0.01, 4), 2); // 4 voxels per cell: at most 2 levels
    }

    #[test]
    fn grids_layout_unbounded() {
        let cfg = OrientationConfig::DEFAULT;
        let set = OrientationBinSet::create(&cfg, &[SurfaceRing::DEFAULT]).unwrap();
        let meta = BinSetMetadata::new(&set, &cfg);
        let bins = set.bake_bins(Float3::new(0.0, 0.0, 0.0), Float3::new(40.0, 10.0, 20.0));
        let profile = BakeProfile::test_profile(false, false, false, 1);
        let tiers = build_tiers(&[profile], &[], &[]);
        let g = build_grids(&tiers, &bins, &meta, 64, None);
        assert_eq!(g.grids.len(), 6);
        // Floors only: the ground bin is active, wall and ceiling bins are not.
        assert!(g.get(0, 0).active);
        assert!(g.grids[1..].iter().all(|x| !x.active));
        let ground = g.get(0, 0);
        assert_eq!((ground.width, ground.height, ground.depth), (160, 80, 50));
        assert_eq!((ground.tiles_x, ground.tiles_z), (3, 2));
        assert_eq!(g.tile_count, 6);
        assert_eq!(ground.border, 5);
        assert_eq!(ground.flag_merge_threshold, 2);
        assert!(!ground.clip && !ground.faces);
        // Walls on: the four side bins activate and tiles continue after the ground grid's.
        let walls = BakeProfile::test_profile(false, true, false, 1);
        let g = build_grids(&build_tiers(&[walls], &[], &[]), &bins, &meta, 64, None);
        assert!(g.get(0, 1).active && !g.get(0, 5).active);
        assert_eq!(g.get(0, 1).first_tile, 6);
    }

    #[test]
    fn grids_layout_bounded_faces() {
        let cfg = OrientationConfig::DEFAULT;
        let set = OrientationBinSet::create(&cfg, &[]).unwrap();
        let meta = BinSetMetadata::new(&set, &cfg);
        let chunk = NavChunkBounds { min: Float3::new(0.0, 0.0, 0.0), max: Float3::new(16.0, 8.0, 16.0), min_overlay_depth: 1, max_overlay_depth: 2 };
        let bins = set.bake_bins(chunk.min, chunk.max);
        let tiers = build_tiers(&[BakeProfile::test_profile(false, false, false, 1)], &[], &[]);
        let g = build_grids(&tiers, &bins, &meta, 32, Some(&chunk));
        let ground = g.get(0, 0);
        assert!(ground.clip && ground.faces);
        assert_eq!((ground.box_min, ground.box_max), (chunk.min, chunk.max));
        assert_eq!((ground.width, ground.height), (64, 64));
        assert_eq!((ground.tiles_x, ground.tiles_z), (2, 2));
    }

    #[test]
    fn deterministic_derivation() {
        let a = agent("A", 1, 0.37, 1.9, 0.45);
        let p1 = to_bake_profile(None, &a);
        let p2 = to_bake_profile(None, &a);
        assert_eq!(p1, p2);
        assert_eq!(p1.cell_size.to_bits(), p2.cell_size.to_bits());
    }

    #[test]
    fn name_truncation() {
        assert_eq!(truncate_name(&"a".repeat(100)).len(), 61);
        let s = format!("{}é", "a".repeat(60)); // 'é' straddles byte 61
        assert_eq!(truncate_name(&s).len(), 60);
    }
}
