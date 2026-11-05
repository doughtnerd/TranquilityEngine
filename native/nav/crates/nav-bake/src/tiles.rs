//! The per-tile navmesh pipeline: `Tiles/NavTileBuilder.cs` (Rasterize, Publish, Build), `RasterizeTileJob.cs`,
//! `BuildProfilePolyMeshJob.cs`, the tile creation and task / cache logic of `NavigationBakingSystem.cs`.
//!
//! Stage order (`types::BakeStage`): Rasterize -> PolyMesh.
//! 1. [`create_tiles`] makes one [`BakeTile`] per tile of every active grid (bordered bounds, origin, slice of the
//!    triangle buckets).
//! 2. [`rasterize`] rasterizes a tile's triangles (in content order, `classify::tile_keys` sorts them) into its own
//!    bordered heightfield and flattens it; [`publish`] copies its interior columns into the grid-wide
//!    [`GridHeightfield`] that jump clearance and the flight volume read. [`rasterize_tiles`] runs both over every tile
//!    using the [`TileCache`].
//! 3. [`build`] turns one (profile, tile) into a polygon and detail mesh ([`BinPolyMesh`]): the profile's own areas,
//!    Recast filters, compact heightfield, modifier / gate marks, erosion, distance field, regions, contours, polygon
//!    mesh, detail mesh (all `nav-recast`). [`build_poly_meshes`] runs every task, reusing the [`BuildCache`].
//!
//! Parallel jobs become sequential loops over the same task order. The C# builds the not-cached tasks heaviest first
//! and any worker may take any task; every task only reads shared data, so the order cannot change a result, and the
//! sequential loop keeps that heaviest-first order anyway.
//!
//! # What the stitcher reads
//! [`BinPolyMesh`] is `BinPolyMesh` (`NavMeshStitcher.cs`): the bin, the polygon mesh in the bin's local frame exactly as
//! `build_poly_mesh` produced it, the bin-grid column of the mesh's voxel (0, 0) (`origin`), the detail mesh, and the
//! [`ChunkFaces`] of a ground-bin mesh of a chunk with bounds. [`ProfileTilePolyMesh`] adds the task
//! ((profile, tile, bin)); [`gather_meshes`] is `StitchProfileJob.GatherMeshes`: a profile's valid meshes in task
//! order (the order stitching and jump chunks use).
use std::collections::HashMap;
use std::sync::Arc;

use nav_format::{NavAreas, NavGates, NavTileAgent};
use nav_math::math::{self, Float3x3};
use nav_math::{Double3, Float3, Int2};
use nav_recast::areas::erode_walkable_area;
use nav_recast::compact::build_from_flat;
use nav_recast::contours::build_contours;
use nav_recast::flat_heightfield;
use nav_recast::mesh_details::build_poly_mesh_detail;
use nav_recast::meshes::build_poly_mesh;
use nav_recast::rasterization::{rasterize_triangle, HeightfieldSpanSink};
use nav_recast::regions::{build_distance_field, build_regions};
use nav_recast::{
    FFBounds, FlatSpan, Heightfield, RcCompactCell, RcCompactHeightfield, RcContourSet, RcPolyMeshStatus,
    SpanPool, NULL_SPAN,
};

use crate::bins::BinSetMetadata;
use crate::settings::{BakeProfile, Grids};
use crate::types::{
    BakeSteps, BinGrid, GateVolumeData, ModifierVolumeData, NavTile, NavTileHeightfield, PolyStep, ProfileTileTask, RasterStep, TaskSteps,
    TriangleData,
};

/// A triangle clipped by the box's six planes has at most 3 + 6 vertices.
const CLIP_CAPACITY: usize = 12;

// ---------------------------------------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------------------------------------

// The per-tile mesh the stitcher reads is the stitcher's type (`BinPolyMesh`, `ChunkFaces`, as in Foxfire's
// NavMeshStitcher.cs); the tile builder fills it.
pub use crate::stitcher::{BinPolyMesh, ChunkFaces};

/// A valid [`BinPolyMesh`] with the task that built it.
#[derive(Clone, Debug)]
pub struct ProfileTilePolyMesh {
    pub profile: i32,
    /// The tile's index in the bake's tile arrays (`BinGrid::first_tile + x + z * tiles_x`).
    pub tile: i32,
    pub bin: i32,
    pub mesh: Arc<BinPolyMesh>,
}

/// A tile and its heightfield descriptor / data (the C#'s tile entity: `NavTile` + `NavTileHeightfield`).
#[derive(Clone, Debug, Default)]
pub struct BakeTile {
    pub tile: NavTile,
    pub heightfield: NavTileHeightfield,
}

/// The grid-wide view of a grid's solid heightfield (`BinGrid.Heightfield`): the column heads of every tile's interior
/// columns, here with the spans copied into one pool (`publish`). Jump and fold clearance and the flight volume read it.
#[derive(Clone, Debug, Default)]
pub struct GridHeightfield {
    pub width: i32,
    pub height: i32,
    /// `width * height` column heads: the lowest span's index in `pool`, or `NULL_SPAN`.
    pub heads: Vec<u32>,
    pub pool: SpanPool,
}

impl GridHeightfield {
    /// An empty view of `grid`'s columns.
    pub fn new(grid: &BinGrid) -> Self {
        Self::with_size(grid.width, grid.height)
    }

    pub fn with_size(width: i32, height: i32) -> Self {
        Self { width, height, heads: vec![NULL_SPAN; (width.max(0) * height.max(0)) as usize], pool: SpanPool::new() }
    }

    /// The spans `(smin, smax)` of column `(x, z)`, bottom to top.
    pub fn column(&self, x: i32, z: i32) -> ColumnSpans<'_> {
        ColumnSpans { pool: &self.pool, next: self.heads[(x + z * self.width) as usize] }
    }
}

/// Iterator over one column's solid spans.
pub struct ColumnSpans<'a> {
    pool: &'a SpanPool,
    next: u32,
}

impl Iterator for ColumnSpans<'_> {
    type Item = (i32, i32);
    fn next(&mut self) -> Option<(i32, i32)> {
        if self.next == NULL_SPAN {
            return None;
        }
        let s = self.pool.get(self.next);
        self.next = s.next;
        Some((s.smin, s.smax))
    }
}

// ---------------------------------------------------------------------------------------------------------
// Tile creation
// ---------------------------------------------------------------------------------------------------------

/// The tile creation of `NavigationBakingSystem.Bucket`: one [`BakeTile`] per tile of every active grid, indexed by
/// tile index (`first_tile + x + z * tiles_x`). `starts` / `counts` are the buckets' per-tile slices.
pub fn create_tiles(grids: &[BinGrid], tile_count: i32, starts: &[i32], counts: &[i32]) -> Vec<BakeTile> {
    let mut tiles = vec![BakeTile::default(); tile_count.max(0) as usize];
    for (g, grid) in grids.iter().enumerate() {
        if !grid.active {
            continue;
        }
        for z in 0..grid.tiles_z {
            for x in 0..grid.tiles_x {
                let index = (grid.first_tile + x + z * grid.tiles_x) as usize;
                let interior = grid.tile_interior(x, z);
                let bordered = Int2::new(interior.x + 2 * grid.border, interior.y + 2 * grid.border);
                let origin_x = x * grid.tile_size - grid.border;
                let origin_z = z * grid.tile_size - grid.border;
                let min = grid.bounds.min + Float3::new(origin_x as f32 * grid.cs, 0.0, origin_z as f32 * grid.cs);
                tiles[index] = BakeTile {
                    tile: NavTile { grid: g as i32, x, z },
                    heightfield: NavTileHeightfield {
                        bounds: FFBounds {
                            center: Float3::default(),
                            min,
                            max: Float3::new(
                                min.x + bordered.x as f32 * grid.cs,
                                grid.bounds.max.y,
                                min.z + bordered.y as f32 * grid.cs,
                            ),
                        },
                        width: bordered.x,
                        height: bordered.y,
                        border: grid.border,
                        interior,
                        origin_x,
                        origin_z,
                        triangle_start: starts[index],
                        triangle_count: counts[index],
                        ..NavTileHeightfield::default()
                    },
                };
            }
        }
    }
    tiles
}

// ---------------------------------------------------------------------------------------------------------
// Rasterize / Publish
// ---------------------------------------------------------------------------------------------------------

/// `math.mul(double3x3, double3)`: `c0 * v.x + c1 * v.y + c2 * v.z`, in doubles.
fn mul_double(m: &Float3x3, v: Double3) -> Double3 {
    m.c0.to_double() * v.x + m.c1.to_double() * v.y + m.c2.to_double() * v.z
}

/// The box test of `Rasterize`: is `p` inside the grid's Chunk Bounds box, ignoring open sides (top and bottom never open).
fn inside_box_grid(grid: &BinGrid, p: Double3) -> bool {
    for axis in 0..3usize {
        let ax = axis as i32;
        let mut side = axis == 1 || !grid.is_open(ax, false);
        if side && p[axis] < grid.box_min[axis] as f64 {
            return false;
        }
        side = axis == 1 || !grid.is_open(ax, true);
        if side && p[axis] > grid.box_max[axis] as f64 {
            return false;
        }
    }
    true
}

/// `math.lerp(double3, double3, double)`: `x + s * (y - x)`.
fn lerp_d(x: Double3, y: Double3, s: f64) -> Double3 {
    x + (y - x) * s
}

/// Triangle (a, b, c) clipped to the Chunk Bounds box (Sutherland-Hodgman, one plane at a time), in doubles. Returns
/// the polygon's vertex count in `output` (0 if nothing is inside); `scratch` is working space of the same capacity.
fn clip_to_box(grid: &BinGrid, a: Double3, b: Double3, c: Double3, output: &mut [Double3; CLIP_CAPACITY], scratch: &mut [Double3; CLIP_CAPACITY]) -> usize {
    output[0] = a;
    output[1] = b;
    output[2] = c;
    let mut count = 3usize;
    let mut plane = 0;
    while plane < 6 && count > 0 {
        let axis = plane >> 1;
        let max = (plane & 1) != 0;
        plane += 1;
        if axis != 1 && grid.is_open(axis as i32, max) {
            continue; // open side: geometry past it is kept
        }
        let limit = if max { grid.box_max[axis] as f64 } else { grid.box_min[axis] as f64 };
        let mut kept = 0usize;
        for i in 0..count {
            let p = output[i];
            let q = output[(i + 1) % count];
            // Signed distance inside the plane: positive inside.
            let dp = if max { limit - p[axis] } else { p[axis] - limit };
            let dq = if max { limit - q[axis] } else { q[axis] - limit };
            if dp >= 0.0 {
                scratch[kept] = p;
                kept += 1;
            }
            if (dp >= 0.0) != (dq >= 0.0) {
                let mut cut = lerp_d(p, q, dp / (dp - dq));
                cut[axis] = limit; // exactly on the plane
                scratch[kept] = cut;
                kept += 1;
            }
        }
        output[..kept].copy_from_slice(&scratch[..kept]);
        count = kept;
    }
    count
}

/// The column whose spans tile column `column` takes when flattened: itself, except past the side edges of a Faces grid
/// (Chunk Bounds), where it repeats the nearest edge column (`SourceColumn`).
fn source_column(grid: &BinGrid, tile: &NavTileHeightfield, column: i32) -> i32 {
    if !grid.faces {
        return column;
    }
    let x = column % tile.width;
    let z = column / tile.width;
    let mut gx = tile.origin_x + x;
    let mut gz = tile.origin_z + z;
    // Open sides (an overlay's loaded neighbours) keep their real columns.
    if gx < 0 && !grid.is_open(0, false) {
        gx = 0;
    }
    if gx >= grid.width && !grid.is_open(0, true) {
        gx = grid.width - 1;
    }
    if gz < 0 && !grid.is_open(2, false) {
        gz = 0;
    }
    if gz >= grid.height && !grid.is_open(2, true) {
        gz = grid.height - 1;
    }
    gx - tile.origin_x + (gz - tile.origin_z) * tile.width
}

/// `NavTileBuilder.Rasterize`: rasterizes the tile's triangles (`order`: indices into `triangles`, in content order,
/// Recast's span merging depends on it) into a new heightfield, border included, then flattens it for [`build`]. Fills
/// the tile's `heightfield`, `pool`, `columns` and `spans`.
///
/// A triangle is walkable only in the bin it was assigned to, and only for the profiles in its mesh's mask; its span's
/// area is that profile bitmask. Everywhere else it's solid (0), so walls and intersecting geometry still cut and
/// erode walkable surfaces in neighbouring bins.
pub fn rasterize(
    grid: &BinGrid,
    tile: &mut NavTileHeightfield,
    triangles: &[TriangleData],
    order: &[i32],
    steps: &BakeSteps,
    task: &mut TaskSteps,
    t: &mut u64,
) {
    let mut heightfield = Heightfield::new((tile.width * tile.height) as usize);
    let mut pool = SpanPool::new();
    steps.lap(RasterStep::Alloc as usize, t, task);

    {
        let mut sink = HeightfieldSpanSink {
            heightfield: &mut heightfield,
            pool: &mut pool,
            width: tile.width,
            height: tile.height,
            flag_merge_threshold: grid.flag_merge_threshold,
            areas_are_masks: true,
        };

        // Into the bin frame in doubles (see `rasterize_triangle`).
        let mut clipped = [Double3::default(); CLIP_CAPACITY];
        let mut scratch = [Double3::default(); CLIP_CAPACITY];
        for &ti in order {
            let triangle = triangles[ti as usize];
            let area = if triangle.bin == grid.bin { triangle.walkable_for & grid.tier_mask } else { 0 };
            let area_id = if area != 0 { triangle.area } else { NavAreas::NULL };
            let (a, b, c) = (triangle.a.to_double(), triangle.b.to_double(), triangle.c.to_double());
            if !grid.clip || (inside_box_grid(grid, a) && inside_box_grid(grid, b) && inside_box_grid(grid, c)) {
                rasterize_triangle(
                    &mut sink,
                    mul_double(&grid.world_to_local, a),
                    mul_double(&grid.world_to_local, b),
                    mul_double(&grid.world_to_local, c),
                    grid.cs,
                    grid.ch,
                    tile.width,
                    tile.height,
                    area as i32,
                    area_id,
                    &tile.bounds,
                );
                continue;
            }

            // Chunk Bounds: only the part inside the box, as a fan.
            let count = clip_to_box(grid, a, b, c, &mut clipped, &mut scratch);
            let mut i = 1;
            while i + 1 < count {
                rasterize_triangle(
                    &mut sink,
                    mul_double(&grid.world_to_local, clipped[0]),
                    mul_double(&grid.world_to_local, clipped[i]),
                    mul_double(&grid.world_to_local, clipped[i + 1]),
                    grid.cs,
                    grid.ch,
                    tile.width,
                    tile.height,
                    area as i32,
                    area_id,
                    &tile.bounds,
                );
                i += 1;
            }
        }
    }
    steps.lap(RasterStep::Rasterize as usize, t, task);

    // Flatten for the per-profile stages.
    let column_count = (tile.width * tile.height) as usize;
    let mut columns: Vec<RcCompactCell> = Vec::with_capacity(column_count);
    let mut spans: Vec<FlatSpan> = Vec::with_capacity(column_count);
    for column in 0..column_count {
        let mut cell = RcCompactCell { index: spans.len() as i32, count: 0 };
        let mut s = heightfield.spans[source_column(grid, tile, column as i32) as usize];
        while s != NULL_SPAN {
            let sp = pool.get(s);
            spans.push(FlatSpan { smin: sp.smin, smax: sp.smax, mask: sp.area as u32, area: sp.area_id });
            cell.count += 1;
            s = sp.next;
        }
        columns.push(cell);
    }

    tile.heightfield = Some(heightfield);
    tile.pool = Some(pool);
    tile.columns = columns;
    tile.spans = spans;
    steps.lap(RasterStep::Flatten as usize, t, task);
}

/// `NavTileBuilder.Publish`: the tile's interior columns into the grid-wide view. Every grid column is in exactly one
/// tile's interior. The tile's spans are copied (the C# shares them by pointer).
pub fn publish(grid: &BinGrid, tile: &NavTileHeightfield, view: &mut GridHeightfield) {
    let (Some(hf), Some(pool)) = (tile.heightfield.as_ref(), tile.pool.as_ref()) else { return };
    for z in tile.border..tile.border + tile.interior.y {
        let gz = tile.origin_z + z;
        if gz >= grid.height {
            break;
        }
        for x in tile.border..tile.border + tile.interior.x {
            let gx = tile.origin_x + x;
            if gx >= grid.width {
                break;
            }
            // Copy the chain, keeping its bottom-to-top order.
            let mut head = NULL_SPAN;
            let mut last = NULL_SPAN;
            let mut s = hf.spans[(x + z * tile.width) as usize];
            while s != NULL_SPAN {
                let src = pool.get(s);
                let n = view.pool.alloc();
                let dst = view.pool.get_mut(n);
                dst.smin = src.smin;
                dst.smax = src.smax;
                dst.area = src.area;
                dst.area_id = src.area_id;
                if last == NULL_SPAN {
                    head = n;
                } else {
                    view.pool.get_mut(last).next = n;
                }
                last = n;
                s = src.next;
            }
            view.heads[(gx + gz * grid.width) as usize] = head;
        }
    }
}

/// The tile cache (`_tileCache`): tile key (`classify::tile_key`) -> the tile's rasterized and flattened heightfield
/// from the last bake. In memory only.
#[derive(Clone, Debug, Default)]
pub struct TileCache {
    map: HashMap<u64, NavTileHeightfield>,
}

impl TileCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn get(&self, key: u64) -> Option<&NavTileHeightfield> {
        self.map.get(&key)
    }
    /// `FreeBuildMemory`'s tile half: afterwards the cache holds exactly this bake's tile heightfields.
    pub fn replace_with(&mut self, keys: &[u64], tiles: &[BakeTile]) {
        self.map.clear();
        for (k, t) in keys.iter().zip(tiles) {
            self.map.entry(*k).or_insert_with(|| t.heightfield.clone());
        }
    }
}

/// What [`rasterize_tiles`] reports.
#[derive(Clone, Debug, Default)]
pub struct RasterizeResult {
    /// One grid-wide heightfield view per grid (empty for inactive grids), by grid index.
    pub views: Vec<GridHeightfield>,
    pub reused_tiles: i32,
}

/// `NavigationBakingSystem.RasterizeTiles` + `RasterizeTileJob` over every tile in tile order: a tile whose key the
/// cache has takes the cached heightfield and is only published; the others rasterize (their triangles are
/// `buckets.slice(tile)`, already content-sorted by `tile_keys`) and are published.
#[allow(clippy::too_many_arguments)]
pub fn rasterize_tiles(
    grids: &[BinGrid],
    tiles: &mut [BakeTile],
    triangles: &[TriangleData],
    buckets: &[i32],
    tile_keys: &[u64],
    cache: &TileCache,
    steps: &BakeSteps,
) -> RasterizeResult {
    let mut views: Vec<GridHeightfield> =
        grids.iter().map(|g| if g.active { GridHeightfield::new(g) } else { GridHeightfield::default() }).collect();
    let mut reused_tiles = 0;
    for (i, bt) in tiles.iter_mut().enumerate() {
        let grid = &grids[bt.tile.grid as usize];
        let start = crate::types::timestamp();
        let mut t = start;
        let mut task = TaskSteps::default();
        if let Some(cached) = cache.get(tile_keys[i]) {
            let hf = &mut bt.heightfield;
            hf.heightfield = cached.heightfield.clone();
            hf.pool = cached.pool.clone();
            hf.columns = cached.columns.clone();
            hf.spans = cached.spans.clone();
            reused_tiles += 1;
            publish(grid, &bt.heightfield, &mut views[bt.tile.grid as usize]);
            steps.lap(RasterStep::Publish as usize, &mut t, &mut task);
            continue;
        }

        let s = bt.heightfield.triangle_start as usize;
        let order = &buckets[s..s + bt.heightfield.triangle_count as usize];
        rasterize(grid, &mut bt.heightfield, triangles, order, steps, &mut task, &mut t);
        publish(grid, &bt.heightfield, &mut views[bt.tile.grid as usize]);
        steps.lap(RasterStep::Publish as usize, &mut t, &mut task);
        steps.task(
            start,
            BakeSteps::pack_tile(bt.tile.grid, bt.tile.x, bt.tile.z, 0),
            bt.heightfield.spans.len() as i64,
            &task,
        );
    }
    RasterizeResult { views, reused_tiles }
}

// ---------------------------------------------------------------------------------------------------------
// Build (one profile, one tile)
// ---------------------------------------------------------------------------------------------------------

/// World-space bounds of a tile (border included), from its bin-local bounds (`TileWorldBounds`).
pub fn tile_world_bounds(grid: &BinGrid, tile: &NavTileHeightfield) -> (Float3, Float3) {
    let to_world = grid.world_to_local.transpose();
    let mut min = Float3::splat(f32::MAX);
    let mut max = Float3::splat(f32::MIN);
    for c in 0..8 {
        let local = Float3::new(
            if c & 1 != 0 { tile.bounds.max.x } else { tile.bounds.min.x },
            if c & 2 != 0 { tile.bounds.max.y } else { tile.bounds.min.y },
            if c & 4 != 0 { tile.bounds.max.z } else { tile.bounds.min.z },
        );
        let world = to_world.mul_vec(local);
        min = min.min_v(world);
        max = max.max_v(world);
    }
    (min, max)
}

/// World position of span `i`'s floor, at the centre of its column `(x, z)` (`SpanFloorPoint`).
fn span_floor_point(chf: &RcCompactHeightfield, x: i32, z: i32, i: usize, to_world: &Float3x3) -> Float3 {
    let local = Float3::new(
        chf.bmin.x + (x as f32 + 0.5) * chf.cs,
        chf.bmin.y + chf.spans[i].y as f32 * chf.ch,
        chf.bmin.z + (z as f32 + 0.5) * chf.cs,
    );
    to_world.mul_vec(local)
}

/// True if world point `p` is inside the box whose world-to-unit-cube transform is `world_to_unit_box`.
fn inside_unit_box(world_to_unit_box: &nav_math::math::Float4x4, p: Float3) -> bool {
    world_to_unit_box.transform_point(p).abs().le(Float3::splat(0.5)).all()
}

/// Gives every walkable span whose floor point is inside a modifier volume (that applies to this profile) the volume's
/// area. Where volumes overlap, the highest area id wins (`MarkModifierVolumes`).
#[allow(clippy::needless_range_loop)]
fn mark_modifier_volumes(chf: &mut RcCompactHeightfield, grid: &BinGrid, tile: &NavTileHeightfield, profile: i32, volumes: &[ModifierVolumeData]) {
    if volumes.is_empty() {
        return;
    }
    let to_world = grid.world_to_local.transpose(); // the bin frame is orthonormal
    let (tile_min, tile_max) = tile_world_bounds(grid, tile); // to skip volumes that can't touch it

    let bit = 1u32 << profile;
    let mut overrides: Option<Vec<i32>> = None;
    for volume in volumes {
        if volume.profile_mask & bit == 0 {
            continue;
        }
        if volume.aabb_min.gt(tile_max).any() || volume.aabb_max.lt(tile_min).any() {
            continue;
        }
        let ov = overrides.get_or_insert_with(|| vec![0; chf.span_count as usize]);

        for z in 0..chf.height {
            for x in 0..chf.width {
                let cell = chf.cells[(x + z * chf.width) as usize];
                for i in cell.index..cell.index + cell.count {
                    let i = i as usize;
                    if chf.areas[i] == RcCompactHeightfield::RC_NULL_AREA {
                        continue;
                    }
                    if inside_unit_box(&volume.world_to_unit_box, span_floor_point(chf, x, z, i, &to_world)) {
                        ov[i] = math::max(ov[i], volume.area);
                    }
                }
            }
        }
    }

    if let Some(ov) = overrides {
        for i in 0..chf.span_count as usize {
            if ov[i] > 0 {
                chf.areas[i] = ov[i];
            }
        }
    }
}

/// Packs the gate index above the area id (`area | gate << NavGates::SHIFT`) of every walkable span whose floor point
/// is inside a gate's box. Overlapping gates resolve to the highest index (`MarkGates`).
#[allow(clippy::needless_range_loop)]
fn mark_gates(chf: &mut RcCompactHeightfield, grid: &BinGrid, tile: &NavTileHeightfield, gates: &[GateVolumeData]) {
    if gates.is_empty() {
        return;
    }
    let to_world = grid.world_to_local.transpose();
    let (tile_min, tile_max) = tile_world_bounds(grid, tile);
    let mut gate_of: Option<Vec<i32>> = None;
    for gate in gates {
        if gate.aabb_min.gt(tile_max).any() || gate.aabb_max.lt(tile_min).any() {
            continue;
        }
        let go = gate_of.get_or_insert_with(|| vec![0; chf.span_count as usize]);

        for z in 0..chf.height {
            for x in 0..chf.width {
                let cell = chf.cells[(x + z * chf.width) as usize];
                for i in cell.index..cell.index + cell.count {
                    let i = i as usize;
                    if chf.areas[i] == RcCompactHeightfield::RC_NULL_AREA {
                        continue;
                    }
                    if inside_unit_box(&gate.world_to_unit_box, span_floor_point(chf, x, z, i, &to_world)) {
                        go[i] = math::max(go[i], gate.gate);
                    }
                }
            }
        }
    }

    if let Some(go) = gate_of {
        for i in 0..chf.span_count as usize {
            if go[i] > 0 {
                chf.areas[i] |= go[i] << NavGates::SHIFT;
            }
        }
    }
}

/// `NavTileBuilder.Build`: one agent type's navmesh for a tile. Filters the tile's flattened heightfield into this
/// profile's own areas (profile = its bit in the span masks), then runs the Recast pipeline with the agent's size:
/// compact heightfield, area and gate marks, erosion, regions, contours, polygon mesh and detail mesh. The tile's border
/// keeps erosion and regions consistent across tile edges; the polygon mesh comes out cropped to the tile's interior,
/// with its tile-edge edges flagged as portals for the stitcher. `None` if nothing walkable is left.
#[allow(clippy::too_many_arguments)]
pub fn build(
    grid: &BinGrid,
    tile: &NavTileHeightfield,
    agent: &NavTileAgent,
    profile: i32,
    bin: i32,
    volumes: &[ModifierVolumeData],
    gates: &[GateVolumeData],
    steps: &BakeSteps,
    task: &mut TaskSteps,
    t: &mut u64,
) -> Option<BinPolyMesh> {
    const CONTOUR_BUILD_FLAGS: i32 = 1;

    let cs = grid.cs;
    let ch = grid.ch;
    let walkable_height = (agent.height / ch).ceil() as i32;
    let walkable_climb = (agent.step_height / ch).floor() as i32;
    let walkable_radius = (agent.radius / cs).ceil() as i32;

    let mut areas = vec![0i32; tile.spans.len()];
    let walkable = flat_heightfield::init_areas(&tile.spans, profile, &mut areas);
    steps.lap(PolyStep::Areas as usize, t, task);
    if walkable == 0 {
        return None; // nothing walkable for this profile here
    }

    flat_heightfield::filter(&tile.columns, &tile.spans, &mut areas, tile.width, tile.height, walkable_height, walkable_climb);
    steps.lap(PolyStep::Filter as usize, t, task);

    let built = build_from_flat(
        &tile.columns,
        &tile.spans,
        &areas,
        tile.width,
        tile.height,
        walkable_height,
        walkable_climb,
        tile.border,
        tile.bounds.min,
        tile.bounds.max,
        cs,
        ch,
    );
    steps.lap(PolyStep::Compact as usize, t, task);

    let mut chf = built?;
    if chf.span_count == 0 {
        return None;
    }

    // Area overrides before erosion: erosion only eats into walkable space from non-walkable edges, so changing one
    // walkable area to another doesn't erode.
    mark_modifier_volumes(&mut chf, grid, tile, profile, volumes);
    mark_gates(&mut chf, grid, tile, gates);
    steps.lap(PolyStep::Marks as usize, t, task);
    erode_walkable_area(walkable_radius, &mut chf);
    steps.lap(PolyStep::Erode as usize, t, task);
    build_distance_field(&mut chf);
    steps.lap(PolyStep::DistanceField as usize, t, task);
    build_regions(&mut chf, agent.min_region_area, agent.merge_region_area);
    steps.lap(PolyStep::Regions as usize, t, task);
    let mut contours = RcContourSet::default();
    build_contours(&chf, agent.max_simplification_error, agent.max_edge_length, CONTOUR_BUILD_FLAGS, &mut contours);
    steps.lap(PolyStep::Contours as usize, t, task);

    let (mesh_status, mesh) = build_poly_mesh(&contours, agent.verts_per_poly);
    steps.lap(PolyStep::PolyMesh as usize, t, task);

    if mesh_status != RcPolyMeshStatus::Success || mesh.npolys == 0 {
        return None;
    }

    let sample_dist = agent.detail_sample_distance * cs;
    let sample_max_error = agent.detail_sample_max_error * ch;
    let (_, d_mesh) = build_poly_mesh_detail(&mesh, &chf, sample_dist, sample_max_error);
    steps.lap(PolyStep::Detail as usize, t, task);

    Some(BinPolyMesh {
        bin,
        mesh,
        detail: Some(d_mesh),
        // The interior's first column.
        origin: Int2::new(tile.origin_x + tile.border, tile.origin_z + tile.border),
        faces: if grid.faces {
            ChunkFaces {
                enabled: true,
                columns: Int2::new(grid.width, grid.height),
                box_min: [grid.box_min.x, grid.box_min.z],
                box_max: [grid.box_max.x, grid.box_max.z],
            }
        } else {
            ChunkFaces::default()
        },
    })
}

// ---------------------------------------------------------------------------------------------------------
// (profile, tile) tasks and the build cache
// ---------------------------------------------------------------------------------------------------------

/// The (profile, tile) tasks of `BuildPolyMeshes`: for every profile, every bin it builds (`BinSetMetadata::bin_needed`),
/// every tile of that bin's grid in its profile's tier, in that order (profile, bin, tile). This is the task order that
/// `gather_meshes` and the stitcher / jump chunks rely on.
pub fn make_tasks(profiles: &[BakeProfile], profile_tier: &[usize], grids: &Grids, meta: &BinSetMetadata) -> Vec<ProfileTileTask> {
    let mut tasks = Vec::new();
    for (p, profile) in profiles.iter().enumerate() {
        for k in 0..grids.bin_count {
            if !meta.bin_needed(k as i32, profile.build_walls, profile.build_ceilings) {
                continue;
            }
            let grid = grids.get(profile_tier[p], k);
            for i in 0..grid.tiles_x * grid.tiles_z {
                tasks.push(ProfileTileTask { profile: p as i32, tile: grid.first_tile + i, bin: k as i32 });
            }
        }
    }
    tasks
}

/// `TaskKey`'s hash seed.
pub const TASK_KEY_SEED: u64 = 0xB11D;

fn push(out: &mut Vec<u8>, v: &[u8]) {
    out.extend_from_slice(v);
}

/// The bytes a profile contributes to a task key: every field (id, name, sizes, jump limits, voxel size, build
/// settings). Not Unity's struct bytes, so keys are not comparable with Foxfire's; they only need to be stable.
pub fn profile_key_bytes(p: &BakeProfile) -> Vec<u8> {
    let mut o = Vec::with_capacity(128);
    for w in p.id.to_array() {
        push(&mut o, &w.to_le_bytes());
    }
    push(&mut o, &(p.name.len() as i32).to_le_bytes());
    push(&mut o, p.name.as_bytes());
    for f in [p.radius, p.height, p.step_height] {
        push(&mut o, &f.to_le_bytes());
    }
    push(&mut o, &[p.build_walls as u8, p.build_ceilings as u8, p.can_jump as u8]);
    for f in [p.max_jump_up_height, p.max_jump_distance, p.max_fall_distance, p.jump_arc_height, p.cell_size, p.cell_height] {
        push(&mut o, &f.to_le_bytes());
    }
    let b = &p.build;
    for i in [b.min_region_area, b.merge_region_area] {
        push(&mut o, &i.to_le_bytes());
    }
    push(&mut o, &b.max_simplification_error.to_le_bytes());
    for i in [b.max_edge_length, b.verts_per_poly] {
        push(&mut o, &i.to_le_bytes());
    }
    push(&mut o, &b.detail_sample_distance.to_le_bytes());
    push(&mut o, &b.detail_sample_max_error.to_le_bytes());
    o
}

fn push_m4(o: &mut Vec<u8>, m: &nav_math::math::Float4x4) {
    for c in [m.c0, m.c1, m.c2, m.c3] {
        for f in [c.x, c.y, c.z, c.w] {
            push(o, &f.to_le_bytes());
        }
    }
}

fn push_f3(o: &mut Vec<u8>, v: Float3) {
    for f in [v.x, v.y, v.z] {
        push(o, &f.to_le_bytes());
    }
}

/// `TaskKey`: a (profile, tile) build's cache key: the tile's key, the profile's index and settings, and the modifier
/// volumes and gates whose boxes reach the tile (only they can mark its spans), in list order.
#[allow(clippy::too_many_arguments)]
pub fn task_key(
    task: &ProfileTileTask,
    tile_key: u64,
    profile: &BakeProfile,
    grid: &BinGrid,
    tile: &NavTileHeightfield,
    volumes: &[ModifierVolumeData],
    gates: &[GateVolumeData],
) -> u64 {
    let mut inputs = Vec::with_capacity(16);
    push(&mut inputs, &tile_key.to_le_bytes());
    push(&mut inputs, &task.profile.to_le_bytes());
    push(&mut inputs, &task.bin.to_le_bytes());
    let mut h = nav_math::hash::hash_bytes(&inputs, TASK_KEY_SEED);
    h = nav_math::hash::hash_bytes(&profile_key_bytes(profile), h);
    if volumes.is_empty() && gates.is_empty() {
        return h;
    }

    let (min, max) = tile_world_bounds(grid, tile);
    let bit = 1u32 << task.profile;
    for v in volumes {
        if v.profile_mask & bit != 0 && v.aabb_min.le(max).all() && v.aabb_max.ge(min).all() {
            let mut o = Vec::with_capacity(96);
            push_m4(&mut o, &v.world_to_unit_box);
            push_f3(&mut o, v.aabb_min);
            push_f3(&mut o, v.aabb_max);
            push(&mut o, &v.area.to_le_bytes());
            push(&mut o, &v.profile_mask.to_le_bytes());
            h = nav_math::hash::hash_bytes(&o, h);
        }
    }
    for g in gates {
        if g.aabb_min.le(max).all() && g.aabb_max.ge(min).all() {
            let mut o = Vec::with_capacity(96);
            push_m4(&mut o, &g.world_to_unit_box);
            push_f3(&mut o, g.aabb_min);
            push_f3(&mut o, g.aabb_max);
            push(&mut o, &g.gate.to_le_bytes());
            h = nav_math::hash::hash_bytes(&o, h);
        }
    }
    h
}

/// The build cache (`_buildCache`): task key -> the build's polygon and detail mesh (`None` = nothing walkable) from the
/// last bake. In memory only; meshes are shared with the results by `Arc`.
#[derive(Clone, Debug, Default)]
pub struct BuildCache {
    map: HashMap<u64, Option<Arc<BinPolyMesh>>>,
}

impl BuildCache {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    pub fn get(&self, key: u64) -> Option<&Option<Arc<BinPolyMesh>>> {
        self.map.get(&key)
    }
    /// `FreeBuildMemory`'s build half: afterwards the cache holds exactly this bake's builds.
    pub fn replace_with(&mut self, keys: &[u64], meshes: &[Option<Arc<BinPolyMesh>>]) {
        self.map.clear();
        for (k, m) in keys.iter().zip(meshes) {
            self.map.entry(*k).or_insert_with(|| m.clone());
        }
    }
}

/// What [`build_poly_meshes`] reports.
#[derive(Clone, Debug, Default)]
pub struct PolyMeshBuild {
    pub tasks: Vec<ProfileTileTask>,
    /// Per task: the mesh, or `None` when the profile has nothing walkable in that tile (`Valid` false).
    pub meshes: Vec<Option<Arc<BinPolyMesh>>>,
    /// Per task: its cache key.
    pub task_keys: Vec<u64>,
    pub reused_tasks: i32,
}

/// `BuildPolyMeshes` + `BuildProfilePolyMeshJob`: builds every task the build cache didn't have, heaviest tile first
/// (by solid span count, ties by task index), sequentially.
#[allow(clippy::too_many_arguments)]
pub fn build_poly_meshes(
    tasks: Vec<ProfileTileTask>,
    profiles: &[BakeProfile],
    grids: &[BinGrid],
    tiles: &[BakeTile],
    tile_keys: &[u64],
    volumes: &[ModifierVolumeData],
    gates: &[GateVolumeData],
    cache: &BuildCache,
    steps: &BakeSteps,
) -> PolyMeshBuild {
    let n = tasks.len();
    let mut meshes: Vec<Option<Arc<BinPolyMesh>>> = vec![None; n];
    let mut task_keys = vec![0u64; n];
    let mut to_build: Vec<usize> = Vec::with_capacity(n);
    let mut reused = 0;
    for (i, task) in tasks.iter().enumerate() {
        let bt = &tiles[task.tile as usize];
        let key = task_key(
            task,
            tile_keys[task.tile as usize],
            &profiles[task.profile as usize],
            &grids[bt.tile.grid as usize],
            &bt.heightfield,
            volumes,
            gates,
        );
        task_keys[i] = key;
        if let Some(cached) = cache.get(key) {
            meshes[i] = cached.clone();
            reused += 1;
            continue;
        }
        to_build.push(i);
    }

    // Heaviest first; stable, so ties keep task order (any order gives the same meshes).
    to_build.sort_by(|&a, &b| {
        let ca = tiles[tasks[a].tile as usize].heightfield.spans.len();
        let cb = tiles[tasks[b].tile as usize].heightfield.spans.len();
        cb.cmp(&ca)
    });

    for index in to_build {
        let start = crate::types::timestamp();
        let mut t = start;
        let mut own = TaskSteps::default();
        let task = tasks[index];
        let bt = &tiles[task.tile as usize];
        let agent = profiles[task.profile as usize].tile_agent();
        let mesh = build(
            &grids[bt.tile.grid as usize],
            &bt.heightfield,
            &agent,
            task.profile,
            task.bin,
            volumes,
            gates,
            steps,
            &mut own,
            &mut t,
        );
        meshes[index] = mesh.map(Arc::new);
        steps.task(
            start,
            BakeSteps::pack_tile(bt.tile.grid, bt.tile.x, bt.tile.z, task.profile),
            bt.heightfield.spans.len() as i64,
            &own,
        );
    }

    PolyMeshBuild { tasks, meshes, task_keys, reused_tasks: reused }
}

/// `StitchProfileJob.GatherMeshes`: profile `profile`'s valid meshes in task order, with their tasks.
pub fn gather_meshes(profile: i32, tasks: &[ProfileTileTask], meshes: &[Option<Arc<BinPolyMesh>>]) -> Vec<ProfileTilePolyMesh> {
    let mut result = Vec::new();
    for (t, task) in tasks.iter().enumerate() {
        if task.profile == profile {
            if let Some(m) = &meshes[t] {
                result.push(ProfileTilePolyMesh { profile, tile: task.tile, bin: task.bin, mesh: Arc::clone(m) });
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bins::{OrientationBinSet, OrientationConfig, SurfaceRing};
    use crate::classify::{bucket_triangles, classify, tile_keys, InputTriangle};
    use crate::settings::{build_grids, build_tiers};
    use nav_math::Float3;

    /// A flat quad (two triangles) covering `[x0, x1] x [z0, z1]` at height `y`, facing up.
    fn quad(x0: f32, z0: f32, x1: f32, z1: f32, y: f32) -> Vec<InputTriangle> {
        let p = |x: f32, z: f32| Float3::new(x, y, z);
        vec![InputTriangle::new(p(x0, z0), p(x0, z1), p(x1, z0), 1, 1), InputTriangle::new(p(x1, z0), p(x0, z1), p(x1, z1), 1, 1)]
    }

    struct Baked {
        profiles: Vec<BakeProfile>,
        grids: Grids,
        tiles: Vec<BakeTile>,
        keys: Vec<u64>,
        build: PolyMeshBuild,
        views: Vec<GridHeightfield>,
    }

    fn bake(tris: &[InputTriangle], min: Float3, max: Float3, tile_size: i32) -> Baked {
        let cfg = OrientationConfig { max_surface_deg: 92.0, ..OrientationConfig::DEFAULT };
        let set = OrientationBinSet::create(&cfg, &[SurfaceRing::DEFAULT]).unwrap();
        let bins = set.bake_bins(min, max);
        let meta = BinSetMetadata::new(&set, &cfg);
        let profiles = vec![BakeProfile::test_profile(false, false, false, 1)];
        let tiers = build_tiers(&profiles, &[], &[]);
        let grids = build_grids(&tiers, &bins, &meta, tile_size, None);
        let data = classify(&bins, &meta, tris);
        let mut buckets = bucket_triangles(&grids.grids, &data, grids.tile_count);
        let mut tiles = create_tiles(&grids.grids, grids.tile_count, &buckets.starts, &buckets.counts);
        let pairs: Vec<_> = tiles.iter().map(|t| (t.tile, t.heightfield.clone())).collect();
        let keys = tile_keys(&grids.grids, &pairs, &data, &mut buckets.buckets);
        let steps = BakeSteps::disabled();
        let r = rasterize_tiles(&grids.grids, &mut tiles, &data, &buckets.buckets, &keys, &TileCache::new(), &steps);
        let tasks = make_tasks(&profiles, &tiers.profile_tier, &grids, &meta);
        let build = build_poly_meshes(tasks, &profiles, &grids.grids, &tiles, &keys, &[], &[], &BuildCache::new(), &steps);
        Baked { profiles, grids, tiles, keys, build, views: r.views }
    }

    fn poly_area(m: &BinPolyMesh) -> f32 {
        // Sum of polygon areas in the xz plane (voxel units * cs^2).
        let mesh = &m.mesh;
        let nvp = mesh.nvp as usize;
        let mut total = 0.0f64;
        for p in 0..mesh.npolys as usize {
            let poly = &mesh.polys[p * nvp * 2..p * nvp * 2 + nvp];
            let n = poly.iter().take_while(|&&v| v != 0xffff).count();
            let mut a = 0.0f64;
            for i in 0..n {
                let (v0, v1) = (mesh.verts[poly[i] as usize], mesh.verts[poly[(i + 1) % n] as usize]);
                a += (v0.x as f64) * (v1.z as f64) - (v1.x as f64) * (v0.z as f64);
            }
            total += a.abs() * 0.5;
        }
        (total * (mesh.cs as f64) * (mesh.cs as f64)) as f32
    }

    #[test]
    fn single_tile_floor_bakes_to_a_poly_mesh() {
        let b = bake(&quad(0.0, 0.0, 10.0, 10.0, 0.0), Float3::new(0.0, -1.0, 0.0), Float3::new(10.0, 3.0, 10.0), 64);
        assert_eq!(b.grids.tile_count, 1);
        assert_eq!(b.build.tasks.len(), 1);
        let m = b.build.meshes[0].as_ref().expect("the floor has a navmesh");
        assert_eq!(m.bin, 0);
        assert!(m.mesh.npolys >= 1);
        assert_eq!(m.detail.as_ref().unwrap().nmeshes() as i32, m.mesh.npolys);
        assert_eq!(m.origin, Int2::new(0, 0));
        assert!(!m.faces.enabled);
        // A 10 x 10 floor eroded by the 0.5 radius agent: about 9 x 9 = 81 (voxel rounding allows slack).
        let area = poly_area(m);
        assert!(area > 60.0 && area < 90.0, "area {area}");
        // The published whole-grid view holds the floor's solid spans.
        let g = b.grids.get(0, 0);
        let view = &b.views[0];
        assert_eq!((view.width, view.height), (g.width, g.height));
        assert!(view.column(g.width / 2, g.height / 2).next().is_some());
        // gather_meshes returns the profile's valid meshes in task order.
        let gathered = gather_meshes(0, &b.build.tasks, &b.build.meshes);
        assert_eq!(gathered.len(), 1);
        assert_eq!((gathered[0].profile, gathered[0].bin, gathered[0].tile), (0, 0, 0));
        let _ = b.profiles;
    }

    #[test]
    fn two_tiles_share_an_edge() {
        // 24 m x 8 m floor at 0.25 voxels with 64-voxel (16 m) tiles: two tiles along x.
        let b = bake(&quad(0.0, 0.0, 24.0, 8.0, 0.0), Float3::new(0.0, -1.0, 0.0), Float3::new(24.0, 3.0, 8.0), 64);
        assert_eq!(b.grids.get(0, 0).tiles_x, 2);
        assert_eq!(b.build.tasks.len(), 2);
        let meshes: Vec<_> = b.build.meshes.iter().map(|m| m.as_ref().expect("both tiles have a floor")).collect();
        // The seam is at grid column 64: tile 1's interior starts there, tile 0's ends there.
        assert_eq!(meshes[0].origin.x, 0);
        assert_eq!(meshes[1].origin.x, 64);
        // Each mesh has vertices exactly on the shared column (portal edges): tile 0's max x, tile 1's min x.
        let max_x0 = (0..meshes[0].mesh.nverts as usize).map(|i| meshes[0].mesh.verts[i].x).max().unwrap();
        let min_x1 = (0..meshes[1].mesh.nverts as usize).map(|i| meshes[1].mesh.verts[i].x).min().unwrap();
        assert_eq!(max_x0, 64);
        assert_eq!(min_x1, 0);
        // Total area is one continuous floor's (the seam loses nothing).
        let total = poly_area(meshes[0]) + poly_area(meshes[1]);
        assert!(total > 140.0 && total < 150.0, "area {total}"); // (24 - 1.5) x (8 - 1.5): erosion takes ~3 cells per side
        // The grid-wide view has every column of the grid filled (every column is in one tile's interior).
        let g = b.grids.get(0, 0);
        for x in [0, 63, 64, g.width - 1] {
            assert!(b.views[0].column(x, 4).next().is_some(), "column {x} missing");
        }
        assert_eq!(b.tiles.len(), 2);
    }

    #[test]
    fn baking_is_deterministic_and_caches_hit() {
        let tris = quad(0.0, 0.0, 24.0, 8.0, 0.0);
        let min = Float3::new(0.0, -1.0, 0.0);
        let max = Float3::new(24.0, 3.0, 8.0);
        let a = bake(&tris, min, max, 64);
        let mut reversed = tris.clone();
        reversed.reverse();
        let b = bake(&reversed, min, max, 64);
        assert_eq!(a.keys, b.keys);
        assert_eq!(a.build.task_keys, b.build.task_keys);
        for (x, y) in a.build.meshes.iter().zip(&b.build.meshes) {
            let (x, y) = (x.as_ref().unwrap(), y.as_ref().unwrap());
            assert_eq!(x.mesh.verts[..x.mesh.nverts as usize], y.mesh.verts[..y.mesh.nverts as usize]);
            assert_eq!(x.mesh.polys, y.mesh.polys);
            assert_eq!(x.detail.as_ref().unwrap().verts, y.detail.as_ref().unwrap().verts);
            assert_eq!(x.detail.as_ref().unwrap().tris, y.detail.as_ref().unwrap().tris);
        }

        // A second bake with warm caches reuses everything.
        let mut tile_cache = TileCache::new();
        tile_cache.replace_with(&a.keys, &a.tiles);
        assert_eq!(tile_cache.len(), a.tiles.len());
        let mut build_cache = BuildCache::new();
        build_cache.replace_with(&a.build.task_keys, &a.build.meshes);
        let again = build_poly_meshes(
            a.build.tasks.clone(),
            &a.profiles,
            &a.grids.grids,
            &a.tiles,
            &a.keys,
            &[],
            &[],
            &build_cache,
            &BakeSteps::disabled(),
        );
        assert_eq!(again.reused_tasks as usize, a.build.tasks.len());
        for (x, y) in again.meshes.iter().zip(&a.build.meshes) {
            assert!(Arc::ptr_eq(x.as_ref().unwrap(), y.as_ref().unwrap()));
        }
    }

    #[test]
    fn a_profile_with_nothing_walkable_builds_nothing() {
        // A single wall triangle only (side bin), floors-only profile: no navmesh for the floor bin.
        let p = |x: f32, y: f32, z: f32| Float3::new(x, y, z);
        let wall = vec![InputTriangle::new(p(0.0, 0.0, 0.0), p(0.0, 2.0, 0.0), p(0.0, 0.0, 2.0), 1, 1)];
        let b = bake(&wall, Float3::new(-1.0, -1.0, -1.0), Float3::new(3.0, 3.0, 3.0), 64);
        assert!(b.build.meshes.iter().all(|m| m.is_none()));
    }
}
