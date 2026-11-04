//! Bake orchestration: one chunk's inputs to its `myco.nav@1` file. A port of Foxfire's `NavigationBakingSystem.OnUpdate`
//! (stage order and every decision), `NavigationBakingInitSystem` (bins from the geometry's or the chunk's bounds),
//! the assembly half of `NavBakeOutputSystem` (one navmesh per walker group, one flight volume per flyer group,
//! landing links per pair, gate table, chunk border, chunk id) and `NavBakeChangeSystem.InputSignature`.
//!
//! ```text
//! bake_chunk(&BakeInput, &mut BakeCaches) -> BakeOutput
//!   Setup       collect_agents, group_agents, bins, area table, volumes, gates, tiers, grids
//!   Triangles   BakeMesh -> InputTriangle (profile mask from the mesh's walkable-for list, area)
//!   Classify    classify::classify
//!   Bucket      bucket_triangles, create_tiles, tile_keys; the chunk border
//!   Rasterize   rasterize_tiles (TileCache: tiles with a known key reuse last bake's heightfield)
//!   PolyMesh    make_tasks, build_poly_meshes (BuildCache likewise)
//!   Jumps       per profile: jump links (edge order)
//!   Stitch      per profile: stitch_profile
//!   FlightVolumeWait  flight volumes from the finest tier's ground heightfield
//!   LandingLinks      per (navmesh group, volume group) pair
//!   Free        caches take this bake's tiles and builds
//! ```
//!
//! Parallel jobs are sequential loops here, in the C#'s index order, so the result is the C#'s scheduling-independent
//! result. Everything is deterministic: the same input (in any mesh order) gives the same file bytes.
//!
//! Incremental rebakes: keep one [`BakeCaches`] between calls. A tile whose key (the triangles it rasterizes, its
//! layout) is unchanged reuses its heightfield; a (profile, tile) build whose key is unchanged reuses its polygon and
//! detail mesh. The result is bit for bit a fresh bake's.
//!
//! Identity: a chunk is a scene node (ADR 0016). Its id comes from the scene's project path and the chunk node's id
//! ([`crate::output::chunk_id`]; use forward slashes, project-relative).
use nav_format::file::{LandingLinksSection, NavMeshSection, VolumeSection};
use nav_format::fingerprint::describe_volume;
use nav_format::{BakeFile, NavAgentEntry, NavAgentTableData, NavAreaInfo, NavGateTableData, NavMeshData, NavVolumeData};
use nav_math::hash::{hash_bytes, hash_value};
use nav_math::math::Float4x4;
use nav_math::{Float3, Hash128};
use nav_recast::FFBounds;

use crate::bins::{Bin, BinSetMetadata, OrientationBinSet};
use crate::border::{build_border, BorderInput};
use crate::classify::{bucket_triangles, classify, tile_keys, InputTriangle};
use crate::clearance::{HeightfieldFoldClearance, HeightfieldJumpClearance};
use crate::landing::{build_all_landing_links, landing_pairs, LandingHybrid};
use crate::output::{chunk_id, empty_navmesh_warning, fingerprint_line, group_name, nav_mesh_bounds};
use crate::settings::{
    area_index, build_area_table, build_grids, build_tiers, collect_agents, gather_gates, gather_modifier_volumes,
    group_agents, named_by_for_walkers, BakeFlyer, BakeProfile, NavBakeSettings, NavigationBakeSettings,
};
use crate::stitcher::{generate_jump_links_for_profile, stitch_profile, StitchInput, StitchStats};
use crate::tiles::{
    build_poly_meshes, create_tiles, gather_meshes, make_tasks, rasterize_tiles, BuildCache, GridHeightfield, TileCache,
};
use crate::types::{timestamp, BakeStage, BakeSteps, StageTime};
use crate::volume::{build_flight_volumes, flight_resolution_boxes, FlightVolumeInput, SolidHeightfield};

/// The package version written into every file's header and hashed into the input signature
/// (`NavPackageVersion`): bump it when a change to the bake would change its output.
pub const PACKAGE_VERSION: [u32; 3] = [1, 0, 0];

// ---------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------

/// What a mesh is to the bake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshKind {
    /// A navmesh surface (`NavMeshAuthoring`): walkable where its slope allows, for the agent types it lists.
    NavMesh,
    /// An obstacle (`NavMeshObstacleAuthoring`): solid for every agent type, never walkable; blocks flight cells.
    Obstacle,
}

/// One mesh in world space (`FFMeshFilterComponent` + its tags): the authoring layer flattens a node's mesh or collider
/// through its transform and hands it over.
#[derive(Clone, Debug, PartialEq)]
pub struct BakeMesh {
    pub positions: Vec<Float3>,
    /// Triangles: three indices into `positions` each, wound so the walkable side faces along
    /// `cross(b - a, c - a)`. A trailing partial triangle is dropped with a warning.
    pub indices: Vec<u32>,
    pub kind: MeshKind,
    /// The area of a navmesh surface (`MeshArea`): an id from the setup's areas. `None` = plain walkable.
    pub area_id: Option<Hash128>,
    /// Agent type ids it is walkable for (`WalkableAgent`). Empty = every agent type. Other agent types see it solid.
    pub walkable_for: Vec<Hash128>,
}

impl BakeMesh {
    /// A navmesh surface walkable for every agent type.
    pub fn nav_mesh(positions: Vec<Float3>, indices: Vec<u32>) -> Self {
        Self { positions, indices, kind: MeshKind::NavMesh, area_id: None, walkable_for: Vec::new() }
    }

    /// An obstacle.
    pub fn obstacle(positions: Vec<Float3>, indices: Vec<u32>) -> Self {
        Self { positions, indices, kind: MeshKind::Obstacle, area_id: None, walkable_for: Vec::new() }
    }

    pub fn with_area(mut self, area_id: Hash128) -> Self {
        self.area_id = Some(area_id);
        self
    }

    pub fn with_walkable_for(mut self, agents: Vec<Hash128>) -> Self {
        self.walkable_for = agents;
        self
    }

    fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// World min / max of the vertices (`FFMeshBlob.Bounds`).
    fn bounds(&self) -> Option<(Float3, Float3)> {
        let mut it = self.positions.iter();
        let first = *it.next()?;
        Some(it.fold((first, first), |(lo, hi), p| (lo.min_v(*p), hi.max_v(*p))))
    }
}

/// Everything one chunk's bake reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BakeInput {
    /// Navmesh and obstacle meshes, world space. The list's order doesn't change the result.
    pub meshes: Vec<BakeMesh>,
    /// Setup, chunk settings, and the modifier, gate and resolution volumes.
    pub settings: NavBakeSettings,
    /// The scene's project path (forward slashes) and the chunk node's id: together the chunk's identity.
    pub scene_path: String,
    pub chunk_node_id: String,
}

/// The tile and build caches an incremental rebake reuses (`_tileCache`, `_buildCache`). Keep one per chunk in an
/// editor session and pass it to every [`bake_chunk`]. After a bake they hold exactly what that bake used.
#[derive(Clone, Debug, Default)]
pub struct BakeCaches {
    pub tiles: TileCache,
    pub builds: BuildCache,
}

impl BakeCaches {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

// ---------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------

/// A listed agent type and the navmesh (or flight volume) group it shares (`NavBakeAgent`, `NavBakeFlyer`). The file
/// stores one section per group; this table says which agent types use which.
#[derive(Clone, Debug, PartialEq)]
pub struct GroupMember {
    pub id: Hash128,
    pub name: String,
    pub group: usize,
}

/// Sizes and timings of a bake (`NavBakePass`, `NavBakeStageTime`, `StitchStats`, the flight volume results).
#[derive(Clone, Debug, Default)]
pub struct BakeReport {
    pub triangles: i32,
    pub tiers: i32,
    pub tiles: i32,
    pub reused_tiles: i32,
    /// (profile, tile) builds, and how many of them have walkable area / came from the build cache.
    pub tasks: i32,
    pub built_tasks: i32,
    pub reused_tasks: i32,
    /// Per navmesh group.
    pub stitch: Vec<StitchStats>,
    /// Per flight volume group: free leaves, (resolution regions applied, ignored), (cells auto-refined, skipped).
    pub flight_leaves: Vec<i32>,
    pub flight_regions: Vec<(i32, i32)>,
    pub flight_auto: Vec<(i32, i32)>,
    /// Wall-clock per stage, in `types::timestamp` nanoseconds (0 on wasm, which has no clock).
    pub stage_times: Vec<StageTime>,
}

impl BakeReport {
    pub fn total_ms(&self) -> f64 {
        self.stage_times.iter().map(|s| s.ticks).sum::<u64>() as f64 / 1e6
    }

    pub fn stage_ms(&self, stage: BakeStage) -> f64 {
        self.stage_times.iter().filter(|s| s.stage == stage).map(|s| s.ticks).sum::<u64>() as f64 / 1e6
    }

    /// `NavBakeOutputSystem.Summary`'s line.
    pub fn summary(&self, agent_types: usize, navmeshes: usize) -> String {
        let mut s = format!(
            "NavBake timings ({} triangles, {} agent types, {} navmeshes, {} tiers, {} tiles ({} reused), {} navmesh/tile builds ({} reused)): ",
            self.triangles, agent_types, navmeshes, self.tiers, self.tiles, self.reused_tiles, self.tasks, self.reused_tasks
        );
        for t in &self.stage_times {
            s.push_str(&format!("{:?} {:.1} ms | ", t.stage, t.ticks as f64 / 1e6));
        }
        s.push_str(&format!("total {:.1} ms", self.total_ms()));
        s
    }
}

/// A bake's results.
#[derive(Clone, Debug, Default)]
pub struct BakeOutput {
    /// Ready for `nav_format::write`: a navmesh per walker group (section `group` = group index, even if empty), a
    /// flight volume per flyer group, landing links per (navmesh group, volume group) pair (`group`, `group2`), the
    /// gate table (when there are gates) and the chunk border (with chunk bounds). Its `signature` is
    /// [`input_signature`].
    pub file: BakeFile,
    /// The chunk's identity (scene path + chunk node), the same in every bake.
    pub chunk_id: Hash128,
    /// The chunk's snapped box, with chunk bounds.
    pub chunk_bounds: Option<(Float3, Float3)>,
    /// Per navmesh section: its vertices' world bounds (`NavMeshBounds`); the chunk's box if it has one.
    pub navmesh_bounds: Vec<(Float3, Float3)>,
    /// The listed walking agent types and their navmesh group (`NavBakeAgent`). Not in the file.
    pub agents: Vec<GroupMember>,
    /// What each navmesh group was baked for (agent types sharing it bake its most capable member's jump limits).
    pub profiles: Vec<BakeProfile>,
    /// The listed flying agent types and their flight volume group (`NavBakeFlyer`).
    pub flyers: Vec<GroupMember>,
    /// Agent types that walk and fly, and the landing-links pair index (into `file.landing_links`'s source pairs
    /// as built: `pairs[hybrid.pair]`).
    pub hybrids: Vec<LandingHybrid>,
    /// The (navmesh group, volume group) pairs links were built for, in `hybrids[..].pair` order.
    pub landing_pairs: Vec<(i32, i32)>,
    /// The gates' starting states by gate index (index 0 unused). Runtime state, not in the file.
    pub gates_closed: Vec<bool>,
    /// "NavBake fingerprint: ..." lines, navmeshes then flight volumes (`NavMeshFingerprint.Describe`).
    pub fingerprints: Vec<String>,
    /// The landing link counts and (with details) the C#'s other log lines.
    pub details: Vec<String>,
    pub report: BakeReport,
    /// Everything the C# logs a warning for: nothing walkable, voxel size, unlisted areas, ignored regions...
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------------------------------------
// Input signature (NavBakeChangeSystem.InputSignature)
// ---------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Bytes(Vec<u8>);

impl Bytes {
    fn f32(&mut self, v: f32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn i32(&mut self, v: i32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn bool(&mut self, v: bool) -> &mut Self {
        self.0.push(v as u8);
        self
    }
    fn f3(&mut self, v: Float3) -> &mut Self {
        self.f32(v.x).f32(v.y).f32(v.z)
    }
    fn h128(&mut self, v: Hash128) -> &mut Self {
        self.u32(v.x).u32(v.y).u32(v.z).u32(v.w)
    }
    fn m4(&mut self, m: &Float4x4) -> &mut Self {
        for c in [m.c0, m.c1, m.c2, m.c3] {
            self.f32(c.x).f32(c.y).f32(c.z).f32(c.w);
        }
        self
    }
    fn ids(&mut self, ids: &[Hash128]) -> &mut Self {
        self.i32(ids.len() as i32);
        for id in ids {
            self.h128(*id);
        }
        self
    }
    fn hash(&self, seed: u64) -> u64 {
        hash_bytes(&self.0, seed)
    }
}

fn hash_profile(b: &mut Bytes, p: &BakeProfile) {
    b.h128(p.id).f32(p.radius).f32(p.height).f32(p.step_height).bool(p.build_walls).bool(p.build_ceilings);
    b.bool(p.can_jump).f32(p.max_jump_up_height).f32(p.max_jump_distance).f32(p.max_fall_distance);
    b.f32(p.jump_arc_height).f32(p.cell_size).f32(p.cell_height);
    let s = &p.build;
    b.i32(s.min_region_area).i32(s.merge_region_area).f32(s.max_simplification_error).i32(s.max_edge_length);
    b.i32(s.verts_per_poly).f32(s.detail_sample_distance).f32(s.detail_sample_max_error);
}

fn hash_flyer(b: &mut Bytes, f: &BakeFlyer) {
    b.h128(f.id).f32(f.radius).f32(f.cell_size).f32(f.cells_per_radius).f32(f.headroom).bool(f.open_to_sky_only);
    b.f32(f.max_landing_slope_deg).i32(f.auto_refine_levels).i32(f.auto_refine_max_cells);
}

/// `NavBakeChangeSystem.InputSignature`: a content hash of everything the bake reads, so equal inputs have equal
/// signatures: the meshes (world-space vertices and indices, kind, area, walkable-for), gates (box, id, start state),
/// modifier and resolution volumes, the agent profiles and flyers the setup resolves to, areas, surface rings,
/// orientation settings, tile size, the resolved chunk box, and [`PACKAGE_VERSION`]. Sets of meshes and volumes are
/// combined order-independently (a sum of element hashes), the lists the bake itself keeps in order (agents, areas,
/// rings) are chained. Settings the bake doesn't read (log flags, thread headroom, the chunk's identity) don't count.
pub fn input_signature(input: &BakeInput) -> Hash128 {
    let setup = &input.settings.setup;
    let chunk = &input.settings.chunk;
    let mut h = 0x9E3779B97F4A7C15u64;
    let mut v = Bytes::default();
    for n in PACKAGE_VERSION {
        v.u32(n);
    }
    h = hash_bytes(&v.0, h);

    let mut set = input.meshes.len() as u64;
    for m in &input.meshes {
        let mut b = Bytes::default();
        b.i32(m.positions.len() as i32);
        for p in &m.positions {
            b.f3(*p);
        }
        b.i32(m.indices.len() as i32);
        for i in &m.indices {
            b.u32(*i);
        }
        b.i32(if m.kind == MeshKind::Obstacle { 1 } else { 2 });
        b.bool(m.area_id.is_some()).h128(m.area_id.unwrap_or_default());
        b.ids(&m.walkable_for);
        set = set.wrapping_add(b.hash(1));
    }
    h = hash_bytes(&set.to_le_bytes(), h);

    let mut set = input.settings.gates.len() as u64;
    for g in &input.settings.gates {
        let mut b = Bytes::default();
        b.m4(&g.world_to_unit_box).f3(g.aabb_min).f3(g.aabb_max).h128(g.id).bool(g.start_open);
        set = set.wrapping_add(b.hash(2));
    }
    h = hash_bytes(&set.to_le_bytes(), h);

    let mut set = input.settings.modifier_volumes.len() as u64;
    for m in &input.settings.modifier_volumes {
        let mut b = Bytes::default();
        b.m4(&m.world_to_unit_box).f3(m.aabb_min).f3(m.aabb_max).h128(m.area_id).u32(m.applies_to as u32);
        b.ids(&m.affected_agents);
        set = set.wrapping_add(b.hash(3));
    }
    h = hash_bytes(&set.to_le_bytes(), h);

    let mut set = input.settings.resolution_volumes.len() as u64;
    for r in &input.settings.resolution_volumes {
        let mut b = Bytes::default();
        b.m4(&r.world_to_unit_box).f3(r.aabb_min).f3(r.aabb_max).f32(r.cell_size).ids(&r.affected_agents);
        set = set.wrapping_add(b.hash(6));
    }
    h = hash_bytes(&set.to_le_bytes(), h);

    let collected = collect_agents(setup, chunk);
    let mut b = Bytes::default();
    b.i32(collected.profiles.len() as i32);
    for p in &collected.profiles {
        hash_profile(&mut b, p);
    }
    b.i32(collected.flyers.len() as i32);
    for f in &collected.flyers {
        hash_flyer(&mut b, f);
    }
    b.i32(setup.areas.len() as i32);
    for a in &setup.areas {
        b.h128(a.id).f32(a.default_cost).f32(a.color.x).f32(a.color.y).f32(a.color.z).f32(a.color.w);
    }
    b.i32(setup.surface_rings.len() as i32);
    for r in &setup.surface_rings {
        b.f32(r.tilt_deg).i32(r.count).f32(r.azimuth_offset_deg);
    }
    let o = &setup.orientation;
    b.f32(o.max_surface_deg).f32(o.ground_capture_deg).f32(o.ceiling_capture_deg).f32(o.coverage_deg).f32(o.max_fold_deg);
    b.i32(NavigationBakeSettings::from_setup(setup, 0, false).tile_size);
    match chunk.resolved_bounds() {
        Some(c) => {
            b.bool(true).f3(c.min).f3(c.max).i32(c.min_overlay_depth).i32(c.max_overlay_depth);
        }
        None => {
            b.bool(false);
        }
    }
    h = hash_bytes(&b.0, h);
    let h1 = hash_value(h, 0x5EC7);
    Hash128::from_u64_pair(h, h1)
}

// ---------------------------------------------------------------------------------------------------------
// The bake
// ---------------------------------------------------------------------------------------------------------

/// Wall-clock per stage (`StageClock`).
struct Clock {
    times: Vec<StageTime>,
    running: Option<(BakeStage, u64)>,
}

impl Clock {
    fn begin(&mut self, stage: BakeStage) {
        self.end();
        self.running = Some((stage, timestamp()));
    }
    fn end(&mut self) {
        if let Some((stage, start)) = self.running.take() {
            self.times.push(StageTime { stage, ticks: timestamp().saturating_sub(start) });
        }
    }
}

/// `ComputeBounds`: the meshes' bounds, starting from the origin (`new FFBounds()` encapsulates onto zeroes).
fn geometry_bounds(meshes: &[BakeMesh]) -> (Float3, Float3) {
    let mut b = FFBounds::default();
    for m in meshes {
        if let Some((lo, hi)) = m.bounds() {
            b.encapsulate(&FFBounds { center: (lo + hi) * 0.5, min: lo, max: hi });
        }
    }
    (b.min, b.max)
}

/// A grid-wide heightfield view as the flight volume reads it (the `Heightfield*` of the ground grid): every column's
/// solid spans, tile borders already dropped by `publish`.
fn flatten(view: &GridHeightfield, cs: f32, ch: f32) -> SolidHeightfield {
    let mut out = SolidHeightfield::empty(view.width, view.height, cs, ch);
    for z in 0..view.height {
        for x in 0..view.width {
            for (smin, smax) in view.column(x, z) {
                out.spans.push([smin, smax]);
            }
            out.col_start[(x + z * view.width + 1) as usize] = out.spans.len() as u32;
        }
    }
    out
}

/// An empty bake with only a signature (nothing to bake).
fn nothing_baked(input: &BakeInput, sig: Hash128, mut warnings: Vec<String>, reason: &str) -> BakeOutput {
    warnings.push(reason.to_string());
    BakeOutput {
        file: BakeFile { package_version: PACKAGE_VERSION, signature: sig, ..BakeFile::default() },
        chunk_id: chunk_id(&input.scene_path, &input.chunk_node_id),
        warnings,
        ..BakeOutput::default()
    }
}

/// Bakes one chunk (`NavigationBakingSystem.OnUpdate` and `NavBakeOutputSystem.OnUpdate`): every stage in the C#'s order,
/// returning the file and what the bake logs. `caches` makes a rebake incremental (see the module docs).
pub fn bake_chunk(input: &BakeInput, caches: &mut BakeCaches) -> BakeOutput {
    let mut clock = Clock { times: Vec::new(), running: None };
    let setup = &input.settings.setup;
    let sig = input_signature(input);
    let mut warnings: Vec<String> = Vec::new();

    // ---- Setup: agents, groups, bins, areas, volumes, gates, tiers, grids -------------------------------
    clock.begin(BakeStage::Setup);
    let collected = collect_agents(setup, &input.settings.chunk);
    warnings.extend(collected.warnings.iter().cloned());
    let agents = collected.profiles;
    let flyers = collected.flyers;
    if agents.is_empty() && flyers.is_empty() {
        return nothing_baked(
            input,
            sig,
            warnings,
            "NavigationBakingSystem: the chunk's Navigation Setup lists no agent types that walk or fly (or Skip Agents skips them all); nothing baked.",
        );
    }

    let mesh_walkable_for: Vec<Vec<Hash128>> = input.meshes.iter().map(|m| m.walkable_for.clone()).collect();
    let named = named_by_for_walkers(&agents, &mesh_walkable_for, &input.settings.modifier_volumes);
    let grouping = group_agents(&agents, &named);
    let profiles = &grouping.groups;
    let agent_group = &grouping.agent_group;

    let area_table: Vec<NavAreaInfo> = build_area_table(&setup.areas);
    if setup.areas.len() > nav_format::NavAreas::MAX_CUSTOM as usize {
        warnings.push(format!("more than {} areas; the rest are dropped.", nav_format::NavAreas::MAX_CUSTOM));
    }

    let chunk = input.settings.chunk.resolved_bounds();
    if input.settings.chunk.use_chunk_bounds && chunk.is_none() {
        warnings.push("the chunk's bounds have no volume after snapping to the chunk grid; baking without chunk bounds.".to_string());
    }

    // The bins' extent: the box exactly with chunk bounds, else the geometry's bounds.
    let (bmin, bmax) = match &chunk {
        Some(c) => (c.min, c.max),
        None => geometry_bounds(&input.meshes),
    };
    let set = match OrientationBinSet::create(&setup.orientation, &setup.surface_rings) {
        Ok(s) => s,
        Err(e) => return nothing_baked(input, sig, warnings, &format!("NavigationBakingSystem: orientation bins: {e}")),
    };
    let bins: Vec<Bin> = set.bake_bins(bmin, bmax);
    let meta = BinSetMetadata::new(&set, &setup.orientation);

    let modifier_data = gather_modifier_volumes(&input.settings.modifier_volumes, &area_table, &agents, agent_group, profiles.len());
    for v in &input.settings.modifier_volumes {
        if area_index(&area_table, v.area_id).is_none() {
            warnings.push("NavigationBakingSystem: a modifier volume uses an area that isn't listed on the Navigation Setup; it's baked as plain walkable.".to_string());
        }
    }
    let gates = gather_gates(&input.settings.gates);
    if gates.truncated {
        warnings.push(format!("NavigationBakingSystem: more than {} navmesh gates; the rest are ignored.", nav_format::NavGates::MAX));
    }

    let res_boxes = flight_resolution_boxes(&flyers, &input.settings.modifier_volumes, &input.settings.resolution_volumes);
    let tiers = build_tiers(profiles, &flyers, &res_boxes);
    let tile_size = NavigationBakeSettings::from_setup(setup, 0, false).tile_size;
    let grids = build_grids(&tiers, &bins, &meta, tile_size, chunk.as_ref());
    let bin_count = grids.bin_count;

    // ---- Triangles: meshes to world triangles with their profile mask and area ---------------------------
    clock.begin(BakeStage::Triangles);
    let mut triangles: Vec<InputTriangle> = Vec::new();
    for (m, mesh) in input.meshes.iter().enumerate() {
        let obstacle = mesh.kind == MeshKind::Obstacle;
        let mask = if obstacle {
            0
        } else {
            crate::classify::compute_profile_mask(&mesh.walkable_for, &agents, agent_group, profiles.len())
        };
        let area = match mesh.area_id {
            Some(id) => {
                let a = area_index(&area_table, id);
                if a.is_none() {
                    warnings.push(format!(
                        "NavigationBakingSystem: mesh {m} uses an area that isn't listed on the Navigation Setup; it's baked as plain walkable."
                    ));
                }
                a.unwrap_or(nav_format::NavAreas::WALKABLE)
            }
            None => nav_format::NavAreas::WALKABLE,
        };
        if mesh.indices.len() % 3 != 0 {
            warnings.push(format!("mesh {m}: {} indices aren't a whole number of triangles; the rest are ignored.", mesh.indices.len()));
        }
        triangles.reserve(mesh.triangle_count());
        #[allow(clippy::chunks_exact_to_as_chunks)]
        for t in mesh.indices.chunks_exact(3) {
            let vertex = |i: u32| mesh.positions.get(i as usize).copied();
            match (vertex(t[0]), vertex(t[1]), vertex(t[2])) {
                (Some(a), Some(b), Some(c)) => triangles.push(InputTriangle::new(a, b, c, mask, area)),
                _ => warnings.push(format!("mesh {m}: a triangle indexes a vertex that doesn't exist; skipped.")),
            }
        }
    }

    // ---- Classify, bucket ---------------------------------------------------------------------------------
    clock.begin(BakeStage::Classify);
    let data = classify(&bins, &meta, &triangles);

    clock.begin(BakeStage::Bucket);
    let mut buckets = bucket_triangles(&grids.grids, &data, grids.tile_count);
    let mut tiles = create_tiles(&grids.grids, grids.tile_count, &buckets.starts, &buckets.counts);
    let pairs: Vec<_> = tiles.iter().map(|t| (t.tile, t.heightfield.clone())).collect();
    let keys = tile_keys(&grids.grids, &pairs, &data, &mut buckets.buckets);
    drop(pairs);
    let border = chunk.as_ref().and_then(|c| {
        build_border(&BorderInput {
            chunk: c,
            triangles: &data,
            profiles,
            profile_tier: &tiers.profile_tier,
            grids: &grids,
            agents: &agents,
            agent_group,
            area_table: &area_table,
        })
    });

    // ---- Rasterize, polymesh ------------------------------------------------------------------------------
    clock.begin(BakeStage::Rasterize);
    let steps = BakeSteps::disabled();
    let raster = rasterize_tiles(&grids.grids, &mut tiles, &data, &buckets.buckets, &keys, &caches.tiles, &steps);
    let triangle_count = data.len() as i32;
    drop(buckets);

    clock.begin(BakeStage::PolyMesh);
    let tasks = make_tasks(profiles, &tiers.profile_tier, &grids, &meta);
    let poly = build_poly_meshes(
        tasks,
        profiles,
        &grids.grids,
        &tiles,
        &keys,
        &modifier_data,
        &gates.volumes,
        &caches.builds,
        &steps,
    );
    let built_tasks = poly.meshes.iter().filter(|m| m.is_some()).count() as i32;

    // ---- Jumps and stitch, per profile --------------------------------------------------------------------
    let mut jump_links = Vec::with_capacity(profiles.len());
    clock.begin(BakeStage::Jumps);
    let mut clearances = Vec::with_capacity(profiles.len());
    for (p, profile) in profiles.iter().enumerate() {
        let ground = grids.get(tiers.profile_tier[p], 0);
        clearances.push(HeightfieldJumpClearance::from_ground(
            ground,
            &raster.views[tiers.profile_tier[p] * bin_count],
            profile.height,
        ));
    }
    let gathered: Vec<_> = (0..profiles.len()).map(|p| gather_meshes(p as i32, &poly.tasks, &poly.meshes)).collect();
    for (p, profile) in profiles.iter().enumerate() {
        let ground = grids.get(tiers.profile_tier[p], 0);
        let input = StitchInput {
            profile,
            ground,
            bins: &bins,
            meshes: gathered[p].iter().map(|g| g.mesh.as_ref()).collect(),
            jump_links: None,
            areas: &area_table,
            max_fold_deg: meta.max_fold_deg,
        };
        jump_links.push(generate_jump_links_for_profile(&input, &clearances[p], 1));
    }

    clock.begin(BakeStage::Stitch);
    let mut navs: Vec<NavMeshData> = Vec::with_capacity(profiles.len());
    let mut stitch_stats: Vec<StitchStats> = Vec::with_capacity(profiles.len());
    for (p, profile) in profiles.iter().enumerate() {
        let ground = grids.get(tiers.profile_tier[p], 0);
        let stitch_input = StitchInput {
            profile,
            ground,
            bins: &bins,
            meshes: gathered[p].iter().map(|g| g.mesh.as_ref()).collect(),
            jump_links: Some(&jump_links[p]),
            areas: &area_table,
            max_fold_deg: meta.max_fold_deg,
        };
        let fold = HeightfieldFoldClearance { heightfield: clearances[p], radius: profile.radius };
        let (nav, stats) = stitch_profile(&stitch_input, &fold, &clearances[p]);
        navs.push(nav);
        stitch_stats.push(stats);
    }

    // ---- Flight volumes ------------------------------------------------------------------------------------
    clock.begin(BakeStage::FlightVolumeWait);
    let mut flight = None;
    if !flyers.is_empty() {
        // The finest tier's ground heightfield (identity frame, so world space).
        let mut ground_index = 0usize;
        for t in 1..tiers.tiers.len() {
            if grids.grids[t * bin_count].cs < grids.grids[ground_index].cs {
                ground_index = t * bin_count;
            }
        }
        let ground = &grids.grids[ground_index];
        let hf = flatten(&raster.views[ground_index], ground.cs, ground.ch);
        let result = build_flight_volumes(
            &hf,
            ground.bounds.min,
            ground.bounds.max,
            &FlightVolumeInput {
                flyers: &flyers,
                modifier_volumes: &input.settings.modifier_volumes,
                resolution_volumes: &input.settings.resolution_volumes,
                area_table: &area_table,
                bounded: chunk.is_some(),
            },
        );
        flight = Some(result);
    }

    // ---- Landing links -------------------------------------------------------------------------------------
    clock.begin(BakeStage::LandingLinks);
    let (pairs, links) = match &flight {
        Some(f) => {
            let pairs = landing_pairs(&agents, &flyers, agent_group, &f.grouping.agent_group);
            let nav_refs: Vec<Option<&NavMeshData>> = navs.iter().map(Some).collect();
            let vol_refs: Vec<Option<&NavVolumeData>> = f.volumes.iter().map(Some).collect();
            let links = build_all_landing_links(&nav_refs, &vol_refs, &pairs);
            (pairs, links)
        }
        None => (Default::default(), Vec::new()),
    };

    // ---- Free: the caches take this bake's tiles and builds ------------------------------------------------
    clock.begin(BakeStage::Free);
    caches.builds.replace_with(&poly.task_keys, &poly.meshes);
    caches.tiles.replace_with(&keys, &tiles);
    let (reused_tiles, reused_tasks, task_count) = (raster.reused_tiles, poly.reused_tasks, poly.tasks.len() as i32);
    clock.end();

    // ---- Output: file, fingerprints, warnings ---------------------------------------------------------------
    let agent_names = || agents.iter().enumerate().map(|(a, p)| (agent_group[a] as i32, p.name.as_str()));
    let mut fingerprints = Vec::new();
    let mut navmesh_bounds = Vec::new();
    let mut file = BakeFile { package_version: PACKAGE_VERSION, signature: sig, ..BakeFile::default() };
    for (g, nav) in navs.iter().enumerate() {
        let name = group_name(g as i32, agent_names());
        fingerprints.push(fingerprint_line(&name, nav));
        if let Some(w) = empty_navmesh_warning(&name, nav) {
            warnings.push(w);
        }
        navmesh_bounds.push(match &chunk {
            Some(c) => (c.min, c.max),
            None => nav_mesh_bounds(nav),
        });
        file.navmeshes.push(NavMeshSection { group: g as u32, data: nav.clone() });
    }

    let mut flyer_members = Vec::new();
    let mut flight_leaves = Vec::new();
    let mut flight_regions = Vec::new();
    let mut flight_auto = Vec::new();
    if let Some(f) = &flight {
        let flyer_names = || flyers.iter().enumerate().map(|(i, p)| (f.grouping.agent_group[i] as i32, p.name.as_str()));
        for (g, volume) in f.volumes.iter().enumerate() {
            let name = group_name(g as i32, flyer_names());
            fingerprints.push(format!("NavBake fingerprint: flight volume {} {}", name, describe_volume(volume)));
            if f.regions[g].1 > 0 {
                warnings.push(format!(
                    "NavBake flight volume [{name}]: {} resolution region(s) do nothing here: their Cell Size isn't at most half of {}, or that cell size doesn't halve into whole voxels.",
                    f.regions[g].1, f.grouping.groups[g].cell_size
                ));
            }
            if f.auto_stats[g].1 > 0 {
                warnings.push(format!(
                    "NavBake flight volume [{name}]: auto refinement found {} cells to refine, over the profile's Flight Auto Refine Max Cells, so it refined none.",
                    f.auto_stats[g].1
                ));
            }
            file.volumes.push(VolumeSection { group: g as u32, data: volume.clone() });
        }
        for (i, flyer) in flyers.iter().enumerate() {
            flyer_members.push(GroupMember { id: flyer.id, name: flyer.name.clone(), group: f.grouping.agent_group[i] });
        }
        flight_leaves = f.leaf_counts.clone();
        flight_regions = f.regions.clone();
        flight_auto = f.auto_stats.clone();
    }

    let mut details = Vec::new();
    for (pair, l) in pairs.pairs.iter().zip(&links) {
        if let Some(l) = l {
            details.push(format!("NavBake landing links: navmesh {} / flight volume {}: {} links", pair.0, pair.1, l.links.len()));
            file.landing_links.push(LandingLinksSection { ground_group: pair.0 as u32, air_group: pair.1 as u32, data: l.clone() });
        }
    }

    if gates.ids.len() > 1 {
        file.gate_table = Some(NavGateTableData { ids: gates.ids.clone(), closed: gates.closed.iter().map(|&c| c as u8).collect() });
    }
    // Agent types by id: the navmesh group each walks on and the flight volume group each flies in.
    let mut entries: Vec<NavAgentEntry> = Vec::new();
    for (a, p) in agents.iter().enumerate() {
        entries.push(NavAgentEntry { id: p.id, walk_group: agent_group[a] as i32, fly_group: -1, pad: [0; 2] });
    }
    for m in &flyer_members {
        match entries.iter_mut().find(|e| e.id == m.id) {
            Some(e) => e.fly_group = m.group as i32,
            None => entries.push(NavAgentEntry { id: m.id, walk_group: -1, fly_group: m.group as i32, pad: [0; 2] }),
        }
    }
    if !entries.is_empty() {
        file.agent_table = Some(NavAgentTableData { entries });
    }
    file.chunk_border = border;

    let report = BakeReport {
        triangles: triangle_count,
        tiers: tiers.tiers.len() as i32,
        tiles: grids.tile_count,
        reused_tiles,
        tasks: task_count,
        built_tasks,
        reused_tasks,
        stitch: stitch_stats,
        flight_leaves,
        flight_regions,
        flight_auto,
        stage_times: clock.times,
    };
    BakeOutput {
        file,
        chunk_id: chunk_id(&input.scene_path, &input.chunk_node_id),
        chunk_bounds: chunk.as_ref().map(|c| (c.min, c.max)),
        navmesh_bounds,
        agents: agents.iter().enumerate().map(|(a, p)| GroupMember { id: p.id, name: p.name.clone(), group: agent_group[a] }).collect(),
        profiles: profiles.clone(),
        flyers: flyer_members,
        hybrids: pairs.hybrids.clone(),
        landing_pairs: pairs.pairs.clone(),
        gates_closed: gates.closed.clone(),
        fingerprints,
        details,
        report,
        warnings,
    }
}
