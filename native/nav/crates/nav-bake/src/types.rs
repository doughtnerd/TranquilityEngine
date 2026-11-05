//! Types shared by the bake stages: `Tiles/NavTileTypes.cs`, `Tiles/BakeSteps.cs`, the tile/task records of
//! `BakingComponents.cs`, and the `NavChunkBorder.cs` grid helpers.
//!
//! Pipeline role of each type:
//! * [`BinGrid`]: the voxel grid of one bin at one resolution tier (index = `tier * bin_count + bin`), split into
//!   `tile_size` x `tile_size` tiles. Built by `settings::build_grids`; read by classification bucketing
//!   (`classify.rs`), tile rasterization (`tiles.rs`), jump clearance (`clearance.rs`), the stitcher and the flight
//!   volume.
//! * [`NavTile`] / [`ProfileTileTask`]: one tile of a grid, and one (profile, tile) polymesh build.
//! * [`NavTileHeightfield`]: a tile's own solid heightfield (border included), filled by `tiles.rs`.
//! * [`TriangleData`] (reused from `nav-format`): one world-space triangle with its bin, the profiles it is walkable
//!   for (`walkable_for`, 0 = solid for every profile) and its navmesh area. Also what the chunk border keeps.
//! * [`ModifierVolumeData`] / [`GateVolumeData`]: volumes as the per-tile builds read them.
//! * [`BakeStage`], [`RasterStep`], [`PolyStep`], [`BakeSteps`]: stage ids and a thread-safe timing collector (the
//!   C# `Interlocked` counters), used for logs and tests, never for results.
//!
//! Reused unchanged from `nav-format` (re-exported): `TriangleData`, `NavTileAgent`, `NavBorderGrid`,
//! `NavBorderProfile`, `NavBorderAgent`, `NavChunkBorderData`, `OrientationBin`. `nav_format::FFBounds` and
//! `nav_recast::FFBounds` are the same layout; `BinGrid` uses Recast's (what the tile builder takes), with
//! [`to_format_bounds`] / [`from_format_bounds`] to convert.
use std::cmp::Ordering;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;

use nav_math::math::{Float3x3, Float4x4};
use nav_math::{Float3, Int2};
use nav_recast::{FlatSpan, Heightfield, RcCompactCell, SpanPool};

pub use nav_format::{
    NavBorderAgent, NavBorderGrid, NavBorderProfile, NavChunkBorderData, NavChunkFace, NavTileAgent, OrientationBin,
    TriangleData,
};
pub use nav_recast::FFBounds;

/// `nav_recast::FFBounds` to the baked blob's `nav_format::FFBounds`.
pub fn to_format_bounds(b: FFBounds) -> nav_format::FFBounds {
    nav_format::FFBounds { center: b.center, min: b.min, max: b.max }
}

/// `nav_format::FFBounds` to `nav_recast::FFBounds`.
pub fn from_format_bounds(b: nav_format::FFBounds) -> FFBounds {
    FFBounds { center: b.center, min: b.min, max: b.max }
}

/// The voxel grid of one bin at one resolution tier (`BinGrid`): index = `tier * bin_count + bin`. Split into
/// `tile_size` x `tile_size` tiles, each rasterized and built on its own with a `border` of extra columns around it.
/// Not every grid is active: a tier only rasterizes the bins one of its profiles builds, plus the ground bin (jump
/// clearance and the flight volume need it).
///
/// The C# also holds a `Heightfield*` here, a grid-wide view of the solid heightfield's column heads pointing into
/// the tiles' spans. That is not stored in this struct (it is runtime memory, not layout); `clearance.rs` and
/// `volume.rs` build their own whole-grid view from the published tiles.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BinGrid {
    pub tier: i32,
    pub bin: i32,
    pub active: bool,
    pub cs: f32,
    pub ch: f32,
    /// The bin's local bounds.
    pub bounds: FFBounds,
    pub world_to_local: Float3x3,
    pub width: i32,
    pub height: i32,
    /// Vertical cells.
    pub depth: i32,

    /// Profile bits rasterized into this grid.
    pub tier_mask: u32,
    /// Smallest walkable climb (voxels) among the tier's profiles.
    pub flag_merge_threshold: i32,

    /// Interior columns per tile side.
    pub tile_size: i32,
    /// Extra columns around each tile: the tier's largest walkable radius + 3, as Recast does.
    pub border: i32,

    pub tiles_x: i32,
    pub tiles_z: i32,
    /// Index of this grid's tile (0, 0) in the tile arrays; tile = `first_tile + x + z * tiles_x`.
    pub first_tile: i32,

    /// Chunk bounds (world space): triangles are clipped to the box before rasterizing.
    pub clip: bool,
    pub box_min: Float3,
    pub box_max: Float3,

    /// The ground grid of a chunk with bounds: the grid starts at the box's corner and its side edges are the box's
    /// side faces. The last tile in each direction is cut short at the grid's edge, so tile interiors cover the grid
    /// exactly, and border columns past the edge repeat the edge column (ground continues into the next chunk, so
    /// erosion doesn't eat into it). The navmesh's edges on the faces come out as tile-edge portals with no
    /// neighbouring tile: the chunk's seam edges.
    pub faces: bool,

    /// Overlays: side faces with a loaded neighbour, as bits by `NavChunkFace` (`1 << face`). Past an open face the
    /// real geometry (the neighbour's) is rasterized into the border columns: triangles aren't clipped there and
    /// edge columns aren't repeated. 0 in the bake.
    pub open_sides: i32,
}

impl BinGrid {
    /// Is the side face on this axis (0 = x, 2 = z) and end open (`open_sides`)?
    pub fn is_open(&self, axis: i32, high: bool) -> bool {
        // NavChunkFace: XMin 0, ZMax 1, XMax 2, ZMin 3
        let face = if axis == 0 {
            if high { 2 } else { 0 }
        } else if high {
            1
        } else {
            3
        };
        (self.open_sides & (1 << face)) != 0
    }

    /// Interior columns of tile `tx` (x) or `tz` (z): `tile_size`, except the last tile of a `faces` grid.
    pub fn tile_interior(&self, tx: i32, tz: i32) -> Int2 {
        if !self.faces {
            return Int2::splat(self.tile_size);
        }
        Int2::new(
            self.tile_size.min(self.width - tx * self.tile_size),
            self.tile_size.min(self.height - tz * self.tile_size),
        )
    }

    /// Tiles in this grid (0 if inactive).
    pub fn tile_count(&self) -> i32 {
        self.tiles_x * self.tiles_z
    }
}

/// `NavBorderGrid.From`: a ground grid's layout as baked, without its runtime memory.
pub fn border_grid_from(grid: &BinGrid) -> NavBorderGrid {
    NavBorderGrid {
        bounds: to_format_bounds(grid.bounds),
        cs: grid.cs,
        ch: grid.ch,
        width: grid.width,
        height: grid.height,
        depth: grid.depth,
        tier_mask: grid.tier_mask,
        flag_merge_threshold: grid.flag_merge_threshold,
        tile_size: grid.tile_size,
        border: grid.border,
        tiles_x: grid.tiles_x,
        tiles_z: grid.tiles_z,
    }
}

/// `NavBorderGrid.ToBinGrid`: the ground `BinGrid` a baked border grid was taken from (identity frame), for box
/// `box_min..box_max`. Enough to rebuild any of its tiles.
pub fn border_grid_to_bin_grid(grid: &NavBorderGrid, box_min: Float3, box_max: Float3) -> BinGrid {
    BinGrid {
        bin: 0,
        active: true,
        cs: grid.cs,
        ch: grid.ch,
        bounds: from_format_bounds(grid.bounds),
        world_to_local: Float3x3::IDENTITY,
        width: grid.width,
        height: grid.height,
        depth: grid.depth,
        tier_mask: grid.tier_mask,
        flag_merge_threshold: grid.flag_merge_threshold,
        tile_size: grid.tile_size,
        border: grid.border,
        tiles_x: grid.tiles_x,
        tiles_z: grid.tiles_z,
        clip: true,
        box_min,
        box_max,
        faces: true,
        ..BinGrid::default()
    }
}

/// A tile of a [`BinGrid`] (`NavTile`): index in the tile arrays = `BinGrid::first_tile + x + z * tiles_x`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavTile {
    pub grid: i32,
    pub x: i32,
    pub z: i32,
}

/// One (profile, tile) unit of per-profile work: filter, compact, erode, regions, contours, polymesh
/// (`ProfileTileTask`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ProfileTileTask {
    pub profile: i32,
    pub tile: i32,
    pub bin: i32,
}

/// A tile's own solid heightfield, border included, in the bin's frame (`NavTileHeightfield`). Filled by the tile
/// builder's rasterize step from the triangles bucketed into it, then flattened for the per-profile builds.
///
/// The C# allocates `Heightfield`/`SpanPool` natively; here they are owned values, `None` until rasterized (or freed
/// after flattening). `columns[x + z * width]` indexes into `spans`, bottom to top.
#[derive(Clone, Debug, Default)]
pub struct NavTileHeightfield {
    /// Border included.
    pub bounds: FFBounds,
    /// Columns, border included.
    pub width: i32,
    pub height: i32,
    pub border: i32,
    /// Interior columns (`BinGrid::tile_interior`): `width = interior.x + 2 * border`.
    pub interior: Int2,
    /// Grid column of the tile's first (border) column; negative along the grid's low edges.
    pub origin_x: i32,
    pub origin_z: i32,
    /// Slice of the triangle buckets.
    pub triangle_start: i32,
    pub triangle_count: i32,
    pub heightfield: Option<Heightfield>,
    pub pool: Option<SpanPool>,
    /// Flattened: `columns[x + z * width]` indexes into `spans`, bottom to top.
    pub columns: Vec<RcCompactCell>,
    pub spans: Vec<FlatSpan>,
}

/// A modifier volume as the per-tile builds read it, with its area and profiles resolved (`ModifierVolumeData`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModifierVolumeData {
    /// The box is `[-0.5, 0.5]^3` in this frame.
    pub world_to_unit_box: Float4x4,
    /// World bounds.
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    /// `NavAreas` id.
    pub area: i32,
    /// Profiles it applies to.
    pub profile_mask: u32,
}

/// A gate's box as the per-tile builds read it, with its gate index resolved (`GateVolumeData`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateVolumeData {
    /// The box is `[-0.5, 0.5]^3` in this frame.
    pub world_to_unit_box: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    /// 1..=`NavGates::MAX`.
    pub gate: i32,
}

/// Orders two floats like C#'s `float.CompareTo`: NaN sorts first and equals itself, -0 equals +0.
pub fn compare_f32(a: f32, b: f32) -> Ordering {
    if a < b {
        Ordering::Less
    } else if a > b {
        Ordering::Greater
    } else if a == b {
        Ordering::Equal
    } else if a.is_nan() {
        if b.is_nan() {
            Ordering::Equal
        } else {
            Ordering::Less
        }
    } else {
        Ordering::Greater
    }
}

fn compare_float3(a: Float3, b: Float3) -> Ordering {
    compare_f32(a.x, b.x).then_with(|| compare_f32(a.y, b.y)).then_with(|| compare_f32(a.z, b.z))
}

/// `TriangleContentOrder`: orders triangles by their vertices, then bin, profile mask and area. Recast's span merging
/// depends on rasterization order, so triangle lists are sorted by this before rasterizing. `Equal` means the same
/// triangle twice, so their order can't matter.
pub fn triangle_content_cmp(a: &TriangleData, b: &TriangleData) -> Ordering {
    compare_float3(a.a, b.a)
        .then_with(|| compare_float3(a.b, b.b))
        .then_with(|| compare_float3(a.c, b.c))
        .then_with(|| a.bin.cmp(&b.bin))
        .then_with(|| a.walkable_for.cmp(&b.walkable_for))
        .then_with(|| a.area.cmp(&b.area))
}

// ---------------------------------------------------------------------------------------------------------
// Stages, steps and timing
// ---------------------------------------------------------------------------------------------------------

/// The bake stages, in order, as timed by the orchestrator (`BakeStage`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum BakeStage {
    Setup,
    Triangles,
    Classify,
    Bucket,
    Rasterize,
    PolyMesh,
    Jumps,
    Stitch,
    FlightVolumeWait,
    LandingLinks,
    Free,
}

impl BakeStage {
    pub const COUNT: usize = 11;
    pub const ALL: [BakeStage; Self::COUNT] = [
        BakeStage::Setup,
        BakeStage::Triangles,
        BakeStage::Classify,
        BakeStage::Bucket,
        BakeStage::Rasterize,
        BakeStage::PolyMesh,
        BakeStage::Jumps,
        BakeStage::Stitch,
        BakeStage::FlightVolumeWait,
        BakeStage::LandingLinks,
        BakeStage::Free,
    ];
}

/// The steps of one rasterize task (`RasterStep`), timed into [`BakeSteps`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum RasterStep {
    Alloc,
    Sort,
    Rasterize,
    Flatten,
    Publish,
}

impl RasterStep {
    /// `RasterStep.Count`.
    pub const COUNT: usize = 5;
}

/// The steps of one (profile, tile) polymesh task (`PolyStep`), timed into [`BakeSteps`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PolyStep {
    Areas,
    Filter,
    Compact,
    Marks,
    Erode,
    DistanceField,
    Regions,
    Contours,
    PolyMesh,
    Detail,
}

impl PolyStep {
    /// `PolyStep.Count`.
    pub const COUNT: usize = 10;
}

/// A monotonic timestamp in nanoseconds, or 0 on targets without a clock (`wasm32`: `Instant::now` would panic).
/// Timings are diagnostics only and never feed results.
#[inline]
pub fn timestamp() -> u64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::sync::OnceLock;
        use std::time::Instant;
        static START: OnceLock<Instant> = OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_nanos() as u64
    }
    #[cfg(target_arch = "wasm32")]
    {
        0
    }
}

/// One task's own step times, kept on the stack while it runs (`TaskSteps`; see [`BakeSteps::lap`] and
/// [`BakeSteps::task`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskSteps {
    pub ticks: [u64; TaskSteps::MAX_STEPS],
}

impl TaskSteps {
    pub const MAX_STEPS: usize = 16;
}

/// The slowest single task of a parallel stage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SlowestTask {
    pub ticks: u64,
    /// A caller-packed id (see [`BakeSteps::pack_tile`]).
    pub id: i64,
    pub size: i64,
    pub steps: TaskSteps,
}

/// CPU time per step of a parallel stage, summed over every task and thread, with how many tasks reached each step,
/// and the slowest single task (`BakeSteps`). Thread-safe: tasks add with atomics. Ticks are nanoseconds from
/// [`timestamp`]. A `BakeSteps::disabled()` ignores every call (the C#'s default struct: not timing).
#[derive(Debug, Default)]
pub struct BakeSteps {
    totals: Vec<AtomicU64>,
    counts: Vec<AtomicU64>,
    slowest: Mutex<SlowestTask>,
}

impl BakeSteps {
    /// A collector for `step_count` steps.
    pub fn new(step_count: usize) -> Self {
        Self {
            totals: (0..step_count).map(|_| AtomicU64::new(0)).collect(),
            counts: (0..step_count).map(|_| AtomicU64::new(0)).collect(),
            slowest: Mutex::new(SlowestTask::default()),
        }
    }

    /// Not timing: every method does nothing.
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn is_enabled(&self) -> bool {
        !self.totals.is_empty()
    }

    pub fn step_count(&self) -> usize {
        self.totals.len()
    }

    /// Adds the time since `*t` to `step` (in the totals and in this task's own), and moves `*t` to now.
    pub fn lap(&self, step: usize, t: &mut u64, task: &mut TaskSteps) {
        if !self.is_enabled() {
            return;
        }
        let now = timestamp();
        let dt = now.saturating_sub(*t);
        self.totals[step].fetch_add(dt, AtomicOrdering::Relaxed);
        self.counts[step].fetch_add(1, AtomicOrdering::Relaxed);
        task.ticks[step] += dt;
        *t = now;
    }

    /// A whole task's time (since `start`): kept, with its id, size and steps, if it's the slowest so far.
    pub fn task(&self, start: u64, id: i64, size: i64, task: &TaskSteps) {
        if !self.is_enabled() {
            return;
        }
        let ticks = timestamp().saturating_sub(start);
        let mut slowest = self.slowest.lock().unwrap_or_else(|e| e.into_inner());
        if ticks > slowest.ticks {
            *slowest = SlowestTask { ticks, id, size, steps: *task };
        }
    }

    /// Total ticks of a step.
    pub fn total_ticks(&self, step: usize) -> u64 {
        self.totals.get(step).map_or(0, |a| a.load(AtomicOrdering::Relaxed))
    }

    /// How many tasks reached a step.
    pub fn count(&self, step: usize) -> u64 {
        self.counts.get(step).map_or(0, |a| a.load(AtomicOrdering::Relaxed))
    }

    pub fn slowest(&self) -> SlowestTask {
        *self.slowest.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A tile's id for [`task`](Self::task): profile, grid, x and z packed (see [`unpack_tile`](Self::unpack_tile)).
    pub fn pack_tile(grid: i32, x: i32, z: i32, profile: i32) -> i64 {
        ((profile as i64) << 48) | ((grid as i64) << 32) | (((x & 0xFFFF) as i64) << 16) | ((z & 0xFFFF) as i64)
    }

    /// Returns `(profile, grid, x, z)`.
    pub fn unpack_tile(id: i64) -> (i32, i32, i32, i32) {
        ((id >> 48) as i32, ((id >> 32) & 0xFFFF) as i32, ((id >> 16) & 0xFFFF) as i32, (id & 0xFFFF) as i32)
    }
}

/// Wall-clock time of one bake stage (`NavBakeStageTime`), in [`timestamp`] ticks (nanoseconds).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StageTime {
    pub stage: BakeStage,
    pub ticks: u64,
}

/// Sizes of a bake pass, for the log (`NavBakePass`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BakePassStats {
    pub triangles: i32,
    pub tiers: i32,
    pub tiles: i32,
    /// (profile, tile) builds.
    pub tasks: i32,
    /// Of those, the ones with walkable area.
    pub built_tasks: i32,
}

/// Per-stage timings and sizes of a whole bake, filled by the orchestrator (`bake.rs`).
#[derive(Debug, Default)]
pub struct BakeStats {
    pub pass: BakePassStats,
    pub stage_times: Vec<StageTime>,
}

impl BakeStats {
    /// Records the time `stage` took, from `start` (a [`timestamp`]) to now.
    pub fn record_stage(&mut self, stage: BakeStage, start: u64) {
        self.stage_times.push(StageTime { stage, ticks: timestamp().saturating_sub(start) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(faces: bool) -> BinGrid {
        BinGrid { width: 100, height: 70, tile_size: 64, faces, tiles_x: 2, tiles_z: 2, ..BinGrid::default() }
    }

    #[test]
    fn tile_interior_is_cut_short_on_face_grids() {
        assert_eq!(grid(false).tile_interior(1, 1), Int2::new(64, 64));
        let g = grid(true);
        assert_eq!(g.tile_interior(0, 0), Int2::new(64, 64));
        assert_eq!(g.tile_interior(1, 1), Int2::new(36, 6));
        assert_eq!(g.tile_count(), 4);
    }

    #[test]
    fn open_sides_follow_nav_chunk_face_bits() {
        let mut g = grid(true);
        g.open_sides = 1 << 2; // XMax
        assert!(g.is_open(0, true));
        assert!(!g.is_open(0, false));
        g.open_sides = (1 << 1) | (1 << 3); // ZMax, ZMin
        assert!(g.is_open(2, true) && g.is_open(2, false));
        assert!(!g.is_open(0, true));
    }

    #[test]
    fn border_grid_round_trip() {
        let g = BinGrid {
            bin: 0,
            active: true,
            cs: 0.25,
            ch: 0.2,
            bounds: FFBounds { center: Float3::new(1.0, 2.0, 3.0), min: Float3::new(0.0, 0.0, 0.0), max: Float3::new(2.0, 4.0, 6.0) },
            world_to_local: Float3x3::IDENTITY,
            width: 8,
            height: 24,
            depth: 20,
            tier_mask: 3,
            flag_merge_threshold: 2,
            tile_size: 64,
            border: 5,
            tiles_x: 1,
            tiles_z: 1,
            clip: true,
            box_min: Float3::new(0.0, 0.0, 0.0),
            box_max: Float3::new(2.0, 4.0, 6.0),
            faces: true,
            ..BinGrid::default()
        };
        let b = border_grid_from(&g);
        assert_eq!(b.width, 8);
        assert_eq!(b.bounds.max, Float3::new(2.0, 4.0, 6.0));
        let back = border_grid_to_bin_grid(&b, g.box_min, g.box_max);
        assert_eq!(back, g);
    }

    #[test]
    fn triangle_order_is_by_vertices_then_bin_mask_area() {
        let t = |ax: f32, bin: i32, mask: u32, area: i32| TriangleData {
            a: Float3::new(ax, 0.0, 0.0),
            bin,
            walkable_for: mask,
            area,
            ..TriangleData::default()
        };
        let mut v = vec![t(2.0, 0, 0, 0), t(1.0, 1, 0, 0), t(1.0, 0, 5, 0), t(1.0, 0, 1, 9), t(1.0, 0, 1, 2)];
        v.sort_by(triangle_content_cmp);
        let keys: Vec<_> = v.iter().map(|x| (x.a.x as i32, x.bin, x.walkable_for, x.area)).collect();
        assert_eq!(keys, vec![(1, 0, 1, 2), (1, 0, 1, 9), (1, 0, 5, 0), (1, 1, 0, 0), (2, 0, 0, 0)]);
        assert_eq!(triangle_content_cmp(&v[0], &v[0]), Ordering::Equal);
        assert_eq!(compare_f32(f32::NAN, 1.0), Ordering::Less);
        assert_eq!(compare_f32(1.0, f32::NAN), Ordering::Greater);
        assert_eq!(compare_f32(0.0, -0.0), Ordering::Equal);
    }

    #[test]
    fn tile_ids_pack_and_unpack() {
        let id = BakeSteps::pack_tile(3, 12, 65535, 7);
        assert_eq!(BakeSteps::unpack_tile(id), (7, 3, 12, 65535));
    }

    #[test]
    fn bake_steps_accumulate_across_threads() {
        let steps = BakeSteps::new(PolyStep::COUNT);
        std::thread::scope(|s| {
            for i in 0..4 {
                let steps = &steps;
                s.spawn(move || {
                    let start = timestamp();
                    let mut t = start;
                    let mut own = TaskSteps::default();
                    steps.lap(PolyStep::Areas as usize, &mut t, &mut own);
                    steps.lap(PolyStep::Filter as usize, &mut t, &mut own);
                    steps.task(start, i, 10, &own);
                });
            }
        });
        assert_eq!(steps.count(PolyStep::Areas as usize), 4);
        assert_eq!(steps.count(PolyStep::Filter as usize), 4);
        assert_eq!(steps.count(PolyStep::Detail as usize), 0);
        assert!(steps.slowest().size == 10 || steps.slowest().ticks == 0);
        let off = BakeSteps::disabled();
        let (mut t, mut own) = (0, TaskSteps::default());
        off.lap(0, &mut t, &mut own); // no-op, no panic
        assert!(!off.is_enabled());
    }

    #[test]
    fn stage_order() {
        assert_eq!(BakeStage::ALL.len(), BakeStage::COUNT);
        assert!(BakeStage::Setup < BakeStage::Free);
        assert_eq!(BakeStage::LandingLinks as u8, 9);
    }
}
