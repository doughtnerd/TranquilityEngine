//! The flight volume (`Authoring/Baking/Lib/NavVolumeParallelBuilder.cs` and the flight-volume stage of
//! `NavigationBakingSystem.cs`): a sparse octree of free power-of-two cubes over a world-aligned solid heightfield.
//!
//! Steps, in the C#'s order (its parallel jobs run here one after another, in the same index order, so the output is
//! the same as the C#'s scheduling-independent result):
//! 1. blocked cells from the solid spans; 2. dilation by the agent radius, one axis at a time; 2a. auto refinement
//!    (pinches become one more resolution region); 2b. open-to-sky fill; 3. summed-volume table; 4. octree (a
//!    breadth-first frontier, then one depth-first subtree per frontier node, leaves appended in frontier order);
//!    4b. areas from Air modifier volumes; 5. cell -> leaf map; 5b. resolution regions and auto blocks (blocks of a
//!    two-level map); 6. face neighbours; 7. [`NavVolumeData`].
//!
//! Entry points: [`build_volume`] (one volume from a [`SolidHeightfield`]), [`build_flight_volumes`] (what
//! `ScheduleFlightVolumes` does: group flyers, one volume per group), [`bake_flight_volumes_from_triangles`]
//! (world triangles in, volumes out), and [`voxelize_triangles`] to build the heightfield.
use std::collections::VecDeque;

use nav_format::{NavAreaInfo, NavAreas, NavVolumeBlock, NavVolumeData, NavVolumeLeaf, TriangleData};
use nav_math::math::{self, ceilpow2, clamp, Float3x3, Float4x4};
use nav_math::{Float3, Int3};
use nav_recast::rasterization::{rasterize_triangle, HeightfieldSpanSink};
use nav_recast::types::{FlatSpan, Heightfield, RcCompactCell, SpanPool, NULL_SPAN};
use nav_recast::FFBounds;

use crate::settings::{
    area_index_or_walkable, group_flyers, named_by_for_flyers, region_level, BakeFlyer, Grouping, ModifierVolume,
    ResolutionBox, ResolutionVolume, MAX_REGION_LEVELS,
};

/// Mixed octree nodes to reach before going parallel in the C#: the frontier size (`FrontierTarget`).
const FRONTIER_TARGET: usize = 256;

/// Most resolution regions a volume takes (the owner map is a byte, auto refinement is one more).
const MAX_REGIONS: usize = 254;

// ---------------------------------------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------------------------------------

/// How to build one flight volume (`NavVolumeSettings`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VolumeSettings {
    pub enabled: bool,
    /// World units; a whole number of heightfield cells.
    pub cell_size: f32,
    /// Clearance from geometry: the flyer radius this volume is baked for.
    pub agent_radius: f32,
    /// Free space the open sky can't reach (closed meshes, undersides) counts as solid.
    pub open_to_sky_only: bool,
    /// Auto refinement: fine cells per base cell edge (2, 4 or 8); 0 = off.
    pub auto_refine_cells: i32,
    /// Auto refinement refines nothing if it would refine more base cells (0 = no cap).
    pub auto_refine_max_cells: i32,
}

/// A modifier volume set to apply to the air, as the volume builder reads it (`NavVolumeAreaBox`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VolumeAreaBox {
    /// The box is `[-0.5, 0.5]^3` in this frame.
    pub world_to_unit_box: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    /// `NavAreas` id; where boxes overlap, the higher id wins.
    pub area: u8,
    /// Bit g: applies to flight volume g of the bake.
    pub volume_mask: u64,
}

/// A resolution volume as the bake reads it (`NavVolumeResolutionBox`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VolumeResolutionBox {
    /// Maps `[-0.5, 0.5]^3` to world space.
    pub box_to_world: Float4x4,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    pub cell_size: f32,
    /// Bit g: applies to flight volume g.
    pub volume_mask: u64,
}

/// A resolution region resolved for one flight volume (`NavVolumeRegion`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VolumeRegion {
    pub center: Float3,
    /// The box's unit axes, world space.
    pub axes: Float3x3,
    /// Half extents along `axes`.
    pub half: Float3,
    pub aabb_min: Float3,
    pub aabb_max: Float3,
    /// Fine cells per base cell edge (2, 4 or 8).
    pub cells: i32,
}

/// The solid heightfield a volume is built from (the C#'s `UnsafePtrList<RcSpan>` of column heads, world aligned):
/// `width x height` columns of solid spans in heightfield cells (`smin..smax` of `ch` high, bottom to top), column
/// `x + z * width`, starting at the volume's `bmin`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SolidHeightfield {
    pub width: i32,
    pub height: i32,
    pub cs: f32,
    pub ch: f32,
    /// `width * height + 1` offsets into `spans`.
    pub col_start: Vec<u32>,
    /// `(smin, smax)` pairs.
    pub spans: Vec<[i32; 2]>,
}

impl SolidHeightfield {
    /// An empty heightfield (nothing solid).
    pub fn empty(width: i32, height: i32, cs: f32, ch: f32) -> Self {
        let columns = (width.max(0) * height.max(0)) as usize;
        Self { width, height, cs, ch, col_start: vec![0; columns + 1], spans: Vec::new() }
    }

    /// From a flattened heightfield (a tile's or the whole grid's `columns` / `spans`).
    pub fn from_flat(width: i32, height: i32, cs: f32, ch: f32, columns: &[RcCompactCell], spans: &[FlatSpan]) -> Self {
        let mut out = Self::empty(width, height, cs, ch);
        let n = (width.max(0) * height.max(0)) as usize;
        for c in 0..n {
            let column = columns[c];
            for i in column.index..column.index + column.count {
                let s = spans[i as usize];
                out.spans.push([s.smin, s.smax]);
            }
            out.col_start[c + 1] = out.spans.len() as u32;
        }
        out
    }

    /// From a linked-list heightfield.
    pub fn from_heightfield(hf: &Heightfield, pool: &SpanPool, width: i32, height: i32, cs: f32, ch: f32) -> Self {
        let mut out = Self::empty(width, height, cs, ch);
        let n = (width.max(0) * height.max(0)) as usize;
        for c in 0..n {
            let mut s = hf.spans[c];
            while s != NULL_SPAN {
                let span = pool.get(s);
                out.spans.push([span.smin, span.smax]);
                s = span.next;
            }
            out.col_start[c + 1] = out.spans.len() as u32;
        }
        out
    }

    /// Column `x + z * width`'s spans.
    #[inline]
    pub fn column(&self, x: i32, z: i32) -> &[[i32; 2]] {
        let c = (x + z * self.width) as usize;
        &self.spans[self.col_start[c] as usize..self.col_start[c + 1] as usize]
    }
}

/// Rasterizes world triangles (every one is solid for a flyer, whatever its walkability) into a world-aligned
/// [`SolidHeightfield`] over `bmin..bmax` with cells `cs` x `ch`. The grid is `(size / cs + 0.5)` columns, as
/// `settings::build_grids` sizes the ground grid.
pub fn voxelize_triangles(triangles: &[[Float3; 3]], bmin: Float3, bmax: Float3, cs: f32, ch: f32) -> SolidHeightfield {
    let size = bmax - bmin;
    let width = ((size.x / cs + 0.5) as i32).max(0);
    let height = ((size.z / cs + 0.5) as i32).max(0);
    let bounds = FFBounds { center: (bmin + bmax) * 0.5, min: bmin, max: bmax };
    let mut hf = Heightfield::new((width * height) as usize);
    let mut pool = SpanPool::new();
    {
        let mut sink = HeightfieldSpanSink {
            heightfield: &mut hf,
            pool: &mut pool,
            width,
            height,
            flag_merge_threshold: 0,
            areas_are_masks: false,
        };
        for t in triangles {
            rasterize_triangle(&mut sink, t[0].to_double(), t[1].to_double(), t[2].to_double(), cs, ch, width, height, 1, 1, &bounds);
        }
    }
    SolidHeightfield::from_heightfield(&hf, &pool, width, height, cs, ch)
}

/// [`voxelize_triangles`] over `TriangleData` (`a`, `b`, `c`).
pub fn voxelize_triangle_data(triangles: &[TriangleData], bmin: Float3, bmax: Float3, cs: f32, ch: f32) -> SolidHeightfield {
    let tris: Vec<[Float3; 3]> = triangles.iter().map(|t| [t.a, t.b, t.c]).collect();
    voxelize_triangles(&tris, bmin, bmax, cs, ch)
}

// ---------------------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------------------

#[inline]
fn bit(volume_index: i32) -> u64 {
    if (0..64).contains(&volume_index) {
        1u64 << volume_index
    } else {
        0
    }
}

/// `RegionsFor`: the resolution regions that apply to flight volume `volume_index`, with their cells resolved: each
/// asks for base / 2^k cells (k from its cell size, at most `MAX_REGION_LEVELS`), lowered until the fine cell is a
/// whole number of heightfield voxels. Regions left with k = 0 do nothing and are counted in the second result.
/// Sorted finest first (stable), the order they claim base cells in. At most 254.
pub fn regions_for(
    boxes: &[VolumeResolutionBox],
    volume_index: i32,
    cell_size: f32,
    voxel_size: f32,
) -> (Vec<VolumeRegion>, i32) {
    let mut ignored = 0;
    let voxels = math::max(1, math::round(cell_size / voxel_size) as i32);
    let mut list: Vec<VolumeRegion> = Vec::new();
    for b in boxes {
        if b.volume_mask & bit(volume_index) == 0 {
            continue;
        }
        let k = region_level(cell_size, b.cell_size, voxels);
        if k == 0 || list.len() == MAX_REGIONS {
            ignored += 1;
            continue;
        }

        let m = b.box_to_world;
        let c0 = Float3::new(m.c0.x, m.c0.y, m.c0.z);
        let c1 = Float3::new(m.c1.x, m.c1.y, m.c1.z);
        let c2 = Float3::new(m.c2.x, m.c2.y, m.c2.z);
        let lengths = Float3::new(c0.length(), c1.length(), c2.length());
        let region = VolumeRegion {
            center: Float3::new(m.c3.x, m.c3.y, m.c3.z),
            axes: Float3x3::new(c0 / lengths.x, c1 / lengths.y, c2 / lengths.z),
            half: lengths * 0.5,
            aabb_min: b.aabb_min,
            aabb_max: b.aabb_max,
            cells: 1 << k,
        };

        let mut i = list.len();
        list.push(region);
        while i > 0 && list[i - 1].cells < region.cells {
            list[i] = list[i - 1];
            i -= 1;
        }
        list[i] = region;
    }
    (list, ignored)
}

// ---------------------------------------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------------------------------------

#[inline]
fn index(dims: Int3, x: i32, y: i32, z: i32) -> usize {
    (x + dims.x * (y + dims.y * z)) as usize
}

#[inline]
fn index_v(dims: Int3, c: Int3) -> usize {
    index(dims, c.x, c.y, c.z)
}

/// The cell at position `i` along `axis` on line `line` (the line indexes the other two axes, u fastest).
#[inline]
fn line_cell(dims: Int3, axis: usize, line: i32, i: i32) -> Int3 {
    let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
    let mut c = Int3::default();
    c[axis] = i;
    c[u] = line % dims[u];
    c[v] = line / dims[u];
    c
}

fn to_int3(v: Float3) -> Int3 {
    Int3::new(v.x as i32, v.y as i32, v.z as i32)
}

fn any_ge(a: Int3, b: Int3) -> bool {
    a.x >= b.x || a.y >= b.y || a.z >= b.z
}

fn new_leaf(min: Int3, size: i32, area: u8) -> NavVolumeLeaf {
    NavVolumeLeaf { min, size, neighbor_start: 0, neighbor_count: 0, area, _pad: [0; 3] }
}

const WALKABLE: u8 = NavAreas::WALKABLE as u8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Blocked,
    Free,
    Mixed,
}

#[derive(Clone, Copy)]
struct Node {
    min: Int3,
    size: i32,
}

/// Same test as the serial builder; cells outside the grid count as blocked.
fn classify(prefix: &[i32], dims: Int3, node: Node) -> NodeKind {
    let a = node.min;
    let size = node.size;
    if any_ge(a, dims) {
        return NodeKind::Blocked;
    }

    let b = Int3::new(math::min(a.x + size, dims.x), math::min(a.y + size, dims.y), math::min(a.z + size, dims.z));
    let pd = Int3::new(dims.x + 1, dims.y + 1, dims.z + 1);
    let volume = size as i64 * size as i64 * size as i64;
    let inside = (b.x - a.x) as i64 * (b.y - a.y) as i64 * (b.z - a.z) as i64;
    let p = |x: i32, y: i32, z: i32| prefix[index(pd, x, y, z)] as i64;
    let blocked_count = p(b.x, b.y, b.z) - p(a.x, b.y, b.z) - p(b.x, a.y, b.z) - p(b.x, b.y, a.z)
        + p(a.x, a.y, b.z)
        + p(a.x, b.y, a.z)
        + p(b.x, a.y, a.z)
        - p(a.x, a.y, a.z)
        + (volume - inside);

    if blocked_count == volume {
        return NodeKind::Blocked;
    }
    if blocked_count == 0 {
        return NodeKind::Free;
    }
    if size == 1 {
        NodeKind::Blocked
    } else {
        NodeKind::Mixed // a mixed single cell can't happen; be safe
    }
}

fn child(node: Node, c: i32) -> Node {
    let h = node.size / 2;
    Node { min: node.min + Int3::new(c & 1, (c >> 1) & 1, (c >> 2) & 1) * h, size: h }
}

// ---------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------

/// Whether heightfield column `c` covers fine column `f` (`MarkBlockedJob.Covers` at the fine size).
fn fine_covers(c: i32, f: i32, dim: i32, cs: f32, fcs: f32) -> bool {
    let f0 = clamp(math::floor(c as f32 * cs / fcs) as i32, 0, dim - 1);
    let f1 = clamp(math::floor(((c + 1) as f32 * cs - 1e-3f32) / fcs) as i32, 0, dim - 1);
    f >= f0 && f <= f1
}

/// Marks the blocked cells of column `(lx, lz)` of a fine grid whose cell 0 is cell `offset` of the volume's fine
/// grid (`volume_dims` fine cells, `fcs` wide). Columns and spans outside the grid are skipped (`MarkFineColumn`).
/// With `offset` zero and `dims == volume_dims` it is `MarkBlockedJob`'s column.
#[allow(clippy::too_many_arguments)]
fn mark_fine_column(
    hf: &SolidHeightfield,
    fcs: f32,
    offset: Int3,
    dims: Int3,
    volume_dims: Int3,
    lx: i32,
    lz: i32,
    blocked: &mut [u8],
) {
    let (cs, ch) = (hf.cs, hf.ch);
    let gx = lx + offset.x;
    let gz = lz + offset.z;
    if gx < 0 || gz < 0 || gx >= volume_dims.x || gz >= volume_dims.z {
        return;
    }

    let x0 = math::max(0, math::floor(gx as f32 * fcs / cs) as i32 - 1);
    let x1 = math::min(hf.width - 1, math::ceil((gx + 1) as f32 * fcs / cs) as i32);
    let z0 = math::max(0, math::floor(gz as f32 * fcs / cs) as i32 - 1);
    let z1 = math::min(hf.height - 1, math::ceil((gz + 1) as f32 * fcs / cs) as i32);
    for z in z0..=z1 {
        if !fine_covers(z, gz, volume_dims.z, cs, fcs) {
            continue;
        }
        for x in x0..=x1 {
            if !fine_covers(x, gx, volume_dims.x, cs, fcs) {
                continue;
            }
            for span in hf.column(x, z) {
                let cy0 = clamp(math::floor(span[0] as f32 * ch / fcs) as i32, 0, volume_dims.y - 1) - offset.y;
                let cy1 = clamp(math::floor((span[1] as f32 * ch - 1e-3f32) / fcs) as i32, 0, volume_dims.y - 1) - offset.y;
                for cy in math::max(cy0, 0)..=math::min(cy1, dims.y - 1) {
                    blocked[index(dims, lx, cy, lz)] = 1;
                }
            }
        }
    }
}

/// `dst` = `src` dilated by `r` cells along `axis` (`DilateLine` over every line).
fn dilate(src: &[u8], dims: Int3, axis: usize, r: i32) -> Vec<u8> {
    let mut dst = vec![0u8; src.len()];
    let n = dims[axis];
    let lines = src.len() as i32 / n;
    for line in 0..lines {
        for i in 0..n {
            let (lo, hi) = (math::max(0, i - r), math::min(n - 1, i + r));
            let mut v = 0u8;
            let mut j = lo;
            while j <= hi && v == 0 {
                v = src[index_v(dims, line_cell(dims, axis, line, j))];
                j += 1;
            }
            dst[index_v(dims, line_cell(dims, axis, line, i))] = v;
        }
    }
    dst
}

/// Three dilation passes (x, y, z) by `r`.
fn dilate_all(src: Vec<u8>, dims: Int3, r: i32) -> Vec<u8> {
    let mut cur = src;
    for axis in 0..3 {
        cur = dilate(&cur, dims, axis, r);
    }
    cur
}

/// Which region (index + 1, 0 = none) owns each base cell: the first region, finest first, whose box overlaps the
/// cell (`OwnerJob`).
fn mark_owners(regions: &[VolumeRegion], origin: Float3, fcs: f32, dims: Int3, owner: &mut [u8]) {
    let h = 0.5f32 * fcs;
    let eps = 1e-4f32 * fcs;
    for column in 0..dims.x * dims.z {
        let x = column % dims.x;
        let z = column / dims.x;
        for y in 0..dims.y {
            let min = origin + Float3::new(x as f32, y as f32, z as f32) * fcs;
            let max = min + Float3::splat(fcs);
            for (r, region) in regions.iter().enumerate() {
                if max.le(region.aabb_min + Float3::splat(eps)).any() || min.ge(region.aabb_max - Float3::splat(eps)).any() {
                    continue;
                }
                if !overlaps(min + Float3::splat(h), h, region, eps) {
                    continue;
                }
                owner[index(dims, x, y, z)] = (r + 1) as u8;
                break;
            }
        }
    }
}

fn overlaps(center: Float3, h: f32, region: &VolumeRegion, eps: f32) -> bool {
    let d = center - region.center;
    let a = region.axes;
    let extent = a.c0.abs() * region.half.x + a.c1.abs() * region.half.y + a.c2.abs() * region.half.z;
    if d.abs().ge(Float3::splat(h) + extent - Float3::splat(eps)).any() {
        return false;
    }
    if math::abs(d.dot(a.c0)) >= region.half.x + h * a.c0.abs().csum() - eps {
        return false;
    }
    if math::abs(d.dot(a.c1)) >= region.half.y + h * a.c1.abs().csum() - eps {
        return false;
    }
    if math::abs(d.dot(a.c2)) >= region.half.z + h * a.c2.abs().csum() - eps {
        return false;
    }
    true
}

/// Cells holding `value` within `reach` of `c` on one side along `axis`.
fn near_one_side(dims: Int3, c: Int3, axis: usize, side: i32, reach: i32, cells: &[u8], value: u8) -> bool {
    for k in 1..=reach {
        let mut p = c;
        p[axis] += side * k;
        if p[axis] < 0 || p[axis] >= dims[axis] {
            return false;
        }
        if (cells[index_v(dims, p)] != 0) == (value != 0) {
            return true;
        }
    }
    false
}

fn near(dims: Int3, c: Int3, axis: usize, reach: i32, cells: &[u8], value: u8) -> bool {
    near_one_side(dims, c, axis, -1, reach, cells, value) && near_one_side(dims, c, axis, 1, reach, cells, value)
}

fn is_pinch(dims: Int3, c: Int3, squeeze: i32, reach: i32, raw: &[u8], padded: &[u8]) -> bool {
    for a in 0..3 {
        if !near(dims, c, a, squeeze, raw, 1) {
            continue;
        }
        for b in 0..3 {
            if b != a && near(dims, c, b, reach, padded, 0) {
                return true;
            }
        }
    }
    false
}

/// Pinches (`PinchJob`): cells blocked only by padding (not geometry, not a region's), with geometry within
/// `squeeze` cells on both sides along one axis and free space within `reach` cells on both sides along another.
fn pinches(raw: &[u8], padded: &[u8], owner: &[u8], dims: Int3, squeeze: i32, reach: i32) -> Vec<u8> {
    let mut out = vec![0u8; raw.len()];
    for column in 0..dims.x * dims.z {
        let x = column % dims.x;
        let z = column / dims.x;
        for y in 0..dims.y {
            let c = Int3::new(x, y, z);
            let i = index_v(dims, c);
            out[i] = (raw[i] == 0 && padded[i] != 0 && owner[i] == 0 && is_pinch(dims, c, squeeze, reach, raw, padded)) as u8;
        }
    }
    out
}

/// Sky fill (`SkyColumnsJob`, `SkyFrontierJob`, `SkyFillJob`, `SkyResolveJob`): cells are 0 free, 1 blocked, 2
/// reached from the sky; at the end reached cells are free and everything else blocked.
fn sky_fill(cells: &mut [u8], dims: Int3) {
    // Straight down from each column's open top.
    for column in 0..dims.x * dims.z {
        let x = column % dims.x;
        let z = column / dims.x;
        for y in (0..dims.y).rev() {
            let i = index(dims, x, y, z);
            if cells[i] != 0 {
                break;
            }
            cells[i] = 2;
        }
    }

    // The free, unreached cells next to a reached one.
    let stride_z = (dims.x * dims.y) as usize;
    let stride_y = dims.x as usize;
    let mut queue: VecDeque<usize> = VecDeque::new();
    for column in 0..dims.x * dims.z {
        let x = column % dims.x;
        let z = column / dims.x;
        for y in 0..dims.y {
            let i = index(dims, x, y, z);
            if cells[i] != 0 {
                continue;
            }
            if (x > 0 && cells[i - 1] == 2)
                || (x < dims.x - 1 && cells[i + 1] == 2)
                || (y > 0 && cells[i - stride_y] == 2)
                || (y < dims.y - 1 && cells[i + stride_y] == 2)
                || (z > 0 && cells[i - stride_z] == 2)
                || (z < dims.z - 1 && cells[i + stride_z] == 2)
            {
                queue.push_back(i);
            }
        }
    }

    // Breadth-first over free unreached cells.
    while let Some(i) = queue.pop_front() {
        if cells[i] != 0 {
            continue; // queued twice
        }
        cells[i] = 2;
        let x = i as i32 % dims.x;
        let y = i as i32 / dims.x % dims.y;
        let z = i as i32 / (dims.x * dims.y);
        if x > 0 && cells[i - 1] == 0 {
            queue.push_back(i - 1);
        }
        if x < dims.x - 1 && cells[i + 1] == 0 {
            queue.push_back(i + 1);
        }
        if y > 0 && cells[i - stride_y] == 0 {
            queue.push_back(i - stride_y);
        }
        if y < dims.y - 1 && cells[i + stride_y] == 0 {
            queue.push_back(i + stride_y);
        }
        if z > 0 && cells[i - stride_z] == 0 {
            queue.push_back(i - stride_z);
        }
        if z < dims.z - 1 && cells[i + stride_z] == 0 {
            queue.push_back(i + stride_z);
        }
    }

    for c in cells.iter_mut() {
        *c = if *c == 2 { 0 } else { 1 };
    }
}

/// The summed-volume table (`PrefixSumJob`): a running sum along x, then y, then z; dims + 1, zero planes at 0.
fn prefix_sums(blocked: &[u8], dims: Int3) -> Vec<i32> {
    let pd = Int3::new(dims.x + 1, dims.y + 1, dims.z + 1);
    let mut prefix = vec![0i32; (pd.x * pd.y * pd.z) as usize];
    for axis in 0..3 {
        let lines = (dims.x * dims.y * dims.z) / dims[axis];
        for line in 0..lines {
            let mut sum = 0i32;
            for i in 0..dims[axis] {
                let cell = line_cell(dims, axis, line, i);
                let p = index(pd, cell.x + 1, cell.y + 1, cell.z + 1);
                sum += if axis == 0 { blocked[index_v(dims, cell)] as i32 } else { prefix[p] };
                prefix[p] = sum;
            }
        }
    }
    prefix
}

/// The octree (`OctreeFrontierJob`, `OctreeSubtreeJob`, `CollectLeavesJob`): breadth-first to a frontier, then one
/// depth-first subtree per frontier node. Leaves above the frontier first, then each subtree's in frontier order;
/// within a subtree a node's children are visited last octant first (the C#'s stack pops the last pushed).
fn build_octree(prefix: &[i32], dims: Int3) -> Vec<NavVolumeLeaf> {
    let n = ceilpow2(dims.x.max(dims.y).max(dims.z));
    let mut leaves: Vec<NavVolumeLeaf> = Vec::new();
    let mut frontier = vec![Node { min: Int3::default(), size: n }];
    while !frontier.is_empty() && frontier.len() < FRONTIER_TARGET && frontier[0].size > 1 {
        let mut next: Vec<Node> = Vec::new();
        for &node in &frontier {
            match classify(prefix, dims, node) {
                NodeKind::Free => leaves.push(new_leaf(node.min, node.size, WALKABLE)),
                NodeKind::Mixed => {
                    for c in 0..8 {
                        next.push(child(node, c));
                    }
                }
                NodeKind::Blocked => {}
            }
        }
        frontier = next;
    }

    for &root in &frontier {
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            match classify(prefix, dims, node) {
                NodeKind::Free => leaves.push(new_leaf(node.min, node.size, WALKABLE)),
                NodeKind::Mixed => {
                    for c in 0..8 {
                        stack.push(child(node, c));
                    }
                }
                NodeKind::Blocked => {}
            }
        }
    }
    leaves
}

/// The highest area id among the boxes for this volume that contain `p`, else Walkable (`AreaAt`).
fn area_at(boxes: &[VolumeAreaBox], volume_bit: u64, p: Float3) -> u8 {
    let mut area = WALKABLE;
    for b in boxes {
        if b.volume_mask & volume_bit == 0 || b.area <= area {
            continue;
        }
        if p.lt(b.aabb_min).any() || p.gt(b.aabb_max).any() {
            continue;
        }
        let local = b.world_to_unit_box.transform_point(p);
        if local.abs().le(Float3::splat(0.5)).all() {
            area = b.area;
        }
    }
    area
}

/// Each flight cell's area (`MarkAreasJob`): the highest area among the boxes containing the cell's centre.
fn mark_areas(boxes: &[VolumeAreaBox], volume_bit: u64, origin: Float3, fcs: f32, dims: Int3) -> Vec<u8> {
    let mut areas = vec![0u8; (dims.x * dims.y * dims.z) as usize];
    for column in 0..dims.x * dims.z {
        let cx = column % dims.x;
        let cz = column / dims.x;
        for cy in 0..dims.y {
            let p = origin + (Float3::new(cx as f32, cy as f32, cz as f32) + Float3::splat(0.5)) * fcs;
            areas[index(dims, cx, cy, cz)] = area_at(boxes, volume_bit, p);
        }
    }
    areas
}

/// Gives each leaf its cells' area, splitting leaves that straddle an area boundary into octants until each holds one
/// area (`SplitLeavesByAreaJob`). Leaves keep their order (a split leaf's octants take its place, in octant order).
fn split_leaves_by_area(leaves: &mut Vec<NavVolumeLeaf>, areas: &[u8], dims: Int3) {
    let uniform = |node: Node| -> Option<u8> {
        let area = areas[index_v(dims, node.min)];
        for z in node.min.z..node.min.z + node.size {
            for y in node.min.y..node.min.y + node.size {
                for x in node.min.x..node.min.x + node.size {
                    if areas[index(dims, x, y, z)] != area {
                        return None;
                    }
                }
            }
        }
        Some(area)
    };

    let mut result: Vec<NavVolumeLeaf> = Vec::with_capacity(leaves.len());
    let mut stack: Vec<Node> = Vec::new();
    for leaf in leaves.iter() {
        stack.push(Node { min: leaf.min, size: leaf.size });
        while let Some(node) = stack.pop() {
            if let Some(area) = uniform(node) {
                result.push(new_leaf(node.min, node.size, area));
                continue;
            }
            for c in (0..8).rev() {
                stack.push(child(node, c)); // popped in octant order 0..7
            }
        }
    }
    *leaves = result;
}

/// Writes each leaf's index into the cells it covers (`CellLeafJob`); other cells -1.
fn cell_leaf_map(leaves: &[NavVolumeLeaf], dims: Int3) -> Vec<i32> {
    let mut cell_leaf = vec![-1i32; (dims.x * dims.y * dims.z) as usize];
    for (l, leaf) in leaves.iter().enumerate() {
        for z in leaf.min.z..leaf.min.z + leaf.size {
            for y in leaf.min.y..leaf.min.y + leaf.size {
                for x in leaf.min.x..leaf.min.x + leaf.size {
                    cell_leaf[index(dims, x, y, z)] = l as i32;
                }
            }
        }
    }
    cell_leaf
}

/// Face neighbours of leaf `leaf` on a plain grid (`NeighborJob`): a neighbour cube meets exactly one face, in one
/// axis-aligned rectangle of cells, so it's listed once, at that rectangle's min corner.
fn plain_neighbors(leaf: &NavVolumeLeaf, cell_leaf: &[i32], dims: Int3) -> Vec<i32> {
    let mut out = Vec::new();
    let at = |axis: usize, u: usize, v: usize, c: i32, iu: i32, iv: i32| -> i32 {
        let mut cell = Int3::default();
        cell[axis] = c;
        cell[u] = iu;
        cell[v] = iv;
        cell_leaf[index_v(dims, cell)]
    };

    for axis in 0..3usize {
        let mut side = -1;
        while side <= 1 {
            let c = if side < 0 { leaf.min[axis] - 1 } else { leaf.min[axis] + leaf.size };
            side += 2;
            if c < 0 || c >= dims[axis] {
                continue;
            }

            let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
            for iu in leaf.min[u]..leaf.min[u] + leaf.size {
                for iv in leaf.min[v]..leaf.min[v] + leaf.size {
                    let other = at(axis, u, v, c, iu, iv);
                    if other < 0 {
                        continue;
                    }
                    if iu > leaf.min[u] && at(axis, u, v, c, iu - 1, iv) == other {
                        continue;
                    }
                    if iv > leaf.min[v] && at(axis, u, v, c, iu, iv - 1) == other {
                        continue;
                    }
                    out.push(other);
                }
            }
        }
    }
    out
}

/// `NeighborRangesJob` and the fill: ranges per leaf in leaf order, `neighbors` their concatenation.
fn assign_neighbor_ranges(leaves: &mut [NavVolumeLeaf], lists: Vec<Vec<i32>>) -> Vec<i32> {
    let mut neighbors = Vec::new();
    let mut start = 0;
    for (leaf, list) in leaves.iter_mut().zip(lists) {
        leaf.neighbor_start = start;
        leaf.neighbor_count = list.len() as i32;
        start += leaf.neighbor_count;
        neighbors.extend(list);
    }
    neighbors
}

/// Everything about the two-level cell map (base cells, blocks of refined ones).
struct TwoLevel<'a> {
    base_leaf: &'a [i32],
    blocks: &'a [NavVolumeBlock],
    block_leaf: &'a [i32],
    base_dims: Int3,
    base_scale: i32,
    /// Finest cells per axis.
    units: Int3,
}

/// Face neighbours of one leaf on the two-level map (`TwoLevelNeighborJob`): each face is walked per base cell where
/// it borders base cells, per block cell inside refined ones. Neighbours are listed once each (a scanned list).
fn two_level_neighbors(leaf: &NavVolumeLeaf, m: &TwoLevel) -> Vec<i32> {
    let mut found: Vec<i32> = Vec::with_capacity(16);
    let add = |leaf: i32, found: &mut Vec<i32>| {
        if !found.contains(&leaf) {
            found.push(leaf);
        }
    };
    let scale = m.base_scale;

    for axis in 0..3usize {
        let mut side = -1;
        while side <= 1 {
            let c = if side < 0 { leaf.min[axis] - 1 } else { leaf.min[axis] + leaf.size };
            side += 2;
            if c < 0 || c >= m.units[axis] {
                continue;
            }

            let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
            let (u0, v0) = (leaf.min[u], leaf.min[v]);
            let (u1, v1) = (u0 + leaf.size, v0 + leaf.size);
            for bu in u0 / scale..=(u1 - 1) / scale {
                for bv in v0 / scale..=(v1 - 1) / scale {
                    let mut b = Int3::default();
                    b[axis] = c / scale;
                    b[u] = bu;
                    b[v] = bv;
                    let entry = m.base_leaf[index_v(m.base_dims, b)];
                    if entry == -1 {
                        continue;
                    }
                    if entry >= 0 {
                        add(entry, &mut found);
                        continue;
                    }

                    let block = m.blocks[(-2 - entry) as usize];
                    let s = block.scale;
                    let n = scale / s;
                    let mut f = Int3::default();
                    f[axis] = (c - b[axis] * scale) / s;
                    let fu0 = (math::max(u0, bu * scale) - bu * scale) / s;
                    let fu1 = (math::min(u1, (bu + 1) * scale) - 1 - bu * scale) / s;
                    let fv0 = (math::max(v0, bv * scale) - bv * scale) / s;
                    let fv1 = (math::min(v1, (bv + 1) * scale) - 1 - bv * scale) / s;
                    for fu in fu0..=fu1 {
                        for fv in fv0..=fv1 {
                            f[u] = fu;
                            f[v] = fv;
                            let other = m.block_leaf[(block.start + f.x + n * (f.y + n * f.z)) as usize];
                            if other >= 0 {
                                add(other, &mut found);
                            }
                        }
                    }
                }
            }
        }
    }
    found
}

/// Open to sky, with regions (`LeafSkyJob`): breadth-first over leaves from those touching the top; the rest are
/// dropped, and leaf indices, neighbour lists and the two-level map are compacted to match.
fn leaf_sky(
    leaves: &mut Vec<NavVolumeLeaf>,
    neighbors: &mut Vec<i32>,
    base_leaf: &mut [i32],
    block_leaf: &mut [i32],
    top: i32,
) {
    let count = leaves.len();
    let mut remap = vec![0i32; count]; // 1 = reached
    let mut queue: Vec<usize> = Vec::with_capacity(count);
    for (l, leaf) in leaves.iter().enumerate() {
        if leaf.min.y + leaf.size >= top {
            remap[l] = 1;
            queue.push(l);
        }
    }

    let mut head = 0;
    while head < queue.len() {
        let leaf = leaves[queue[head]];
        head += 1;
        for k in 0..leaf.neighbor_count {
            let other = neighbors[(leaf.neighbor_start + k) as usize] as usize;
            if remap[other] != 0 {
                continue;
            }
            remap[other] = 1;
            queue.push(other);
        }
    }

    let mut kept = 0;
    for r in remap.iter_mut() {
        *r = if *r != 0 {
            kept += 1;
            kept - 1
        } else {
            -1
        };
    }
    if kept as usize == count {
        return;
    }

    let mut new_leaves: Vec<NavVolumeLeaf> = Vec::with_capacity(kept as usize);
    let mut new_neighbors: Vec<i32> = Vec::with_capacity(neighbors.len());
    for l in 0..count {
        if remap[l] < 0 {
            continue;
        }
        let mut leaf = leaves[l];
        let start = new_neighbors.len() as i32;
        for k in 0..leaf.neighbor_count {
            let other = remap[neighbors[(leaf.neighbor_start + k) as usize] as usize];
            if other >= 0 {
                new_neighbors.push(other);
            }
        }
        leaf.neighbor_start = start;
        leaf.neighbor_count = new_neighbors.len() as i32 - start;
        new_leaves.push(leaf);
    }

    *leaves = new_leaves;
    *neighbors = new_neighbors;
    for v in base_leaf.iter_mut() {
        if *v >= 0 {
            *v = remap[*v as usize];
        }
    }
    for v in block_leaf.iter_mut() {
        if *v >= 0 {
            *v = remap[*v as usize];
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// One volume
// ---------------------------------------------------------------------------------------------------------

/// A finished flight volume and what the bake logs about it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VolumeBuild {
    pub data: NavVolumeData,
    pub leaf_count: i32,
    /// Auto refinement: (base cells refined, base cells skipped over the cap).
    pub auto_stats: (i32, i32),
}

/// Builds one flight volume (`NavVolumeParallelBuilder.Schedule`) from the solid heightfield `hf` (world aligned,
/// column 0 at `bmin`), over `bmin..bmax`. `area_boxes` are the Air modifier volumes (masked by `volume_index`),
/// `area_table` goes into the blob, `regions` come from [`regions_for`].
#[allow(clippy::too_many_arguments)]
pub fn build_volume(
    hf: &SolidHeightfield,
    bmin: Float3,
    bmax: Float3,
    settings: &VolumeSettings,
    area_boxes: &[VolumeAreaBox],
    volume_index: i32,
    area_table: &[NavAreaInfo],
    regions: &[VolumeRegion],
) -> VolumeBuild {
    let fcs = settings.cell_size;
    let size = (bmax - bmin) / fcs;
    let dims = Int3::new(
        math::max(1, size.x.ceil() as i32),
        math::max(1, size.y.ceil() as i32),
        math::max(1, size.z.ceil() as i32),
    );
    let total = (dims.x * dims.y * dims.z) as usize;
    let volume_bit = bit(volume_index);

    // Resolution regions and auto refinement (one more region, index regions.len()): finest cells per base cell
    // edge, and which region owns each base cell.
    let auto_cells = if settings.auto_refine_cells > 1 { settings.auto_refine_cells } else { 0 };
    let has_regions = !regions.is_empty() || auto_cells > 0;
    let mut base_scale = math::max(1, auto_cells);
    for region in regions {
        base_scale = math::max(base_scale, region.cells);
    }
    let mut owner = vec![0u8; if has_regions { total } else { 0 }];
    let mut blocks: Vec<NavVolumeBlock> = Vec::new();
    let mut block_leaf: Vec<i32> = Vec::new();
    let mut auto_list: Vec<i32> = Vec::new();
    let mut auto_stats = (0, 0);

    // 1) Solid spans -> blocked flight cells.
    let mut blocked = vec![0u8; total];
    for index_ in 0..dims.x * dims.z {
        mark_fine_column(hf, fcs, Int3::default(), dims, dims, index_ % dims.x, index_ / dims.x, &mut blocked);
    }
    if !regions.is_empty() {
        mark_owners(regions, bmin, fcs, dims, &mut owner);
    }
    let raw = if auto_cells > 0 { blocked.clone() } else { Vec::new() };

    // 2) Pad obstacles by the agent radius, one axis at a time.
    let r = math::ceil(settings.agent_radius / fcs) as i32;
    let mut padded = if r > 0 { dilate_all(blocked, dims, r) } else { blocked };

    // 2a) Auto refinement: pinches, grown by the padding's reach, become the auto region's cells.
    if auto_cells > 0 {
        let squeeze = math::max(1, r) + 1;
        let pinch = pinches(&raw, &padded, &owner, dims, squeeze, 2 * squeeze + 1);
        let grown = dilate_all(pinch, dims, squeeze);
        let region = (regions.len() + 1) as u8;
        for i in 0..grown.len() {
            if grown[i] != 0 && padded[i] != 0 && owner[i] == 0 {
                auto_list.push(i as i32);
            }
        }
        if settings.auto_refine_max_cells > 0 && auto_list.len() > settings.auto_refine_max_cells as usize {
            auto_stats = (0, auto_list.len() as i32);
            auto_list.clear();
        } else {
            for &i in &auto_list {
                owner[i as usize] = region;
            }
            auto_stats = (auto_list.len() as i32, 0);
        }
    }

    // 2b) Only air the sky reaches. Region cells count as open here (their fine grids decide later, and the leaf fill
    // corrects what this over-reaches), then as blocked for the base octree: their leaves come from the regions.
    if has_regions && settings.open_to_sky_only {
        for i in 0..total {
            if owner[i] != 0 {
                padded[i] = 0;
            }
        }
    }
    if settings.open_to_sky_only {
        sky_fill(&mut padded, dims);
    }
    if has_regions {
        for i in 0..total {
            if owner[i] != 0 {
                padded[i] = 1;
            }
        }
    }

    // 3) Summed-volume table, 4) octree.
    let prefix = prefix_sums(&padded, dims);
    let mut leaves = build_octree(&prefix, dims);

    // 4b) Areas, only if some Air modifier volume applies to this volume (otherwise every leaf is Walkable).
    let applies = area_boxes.iter().any(|b| b.volume_mask & volume_bit != 0);
    if applies {
        let cell_areas = mark_areas(area_boxes, volume_bit, bmin, fcs, dims);
        split_leaves_by_area(&mut leaves, &cell_areas, dims);
    }

    // 5) Cell -> leaf map.
    let mut cell_leaf = cell_leaf_map(&leaves, dims);

    let neighbors: Vec<i32>;
    if has_regions {
        // 5b) Regions: blocks for the owned base cells, base leaves in finest cells, then each region's leaves.
        let mut region_cells: Vec<i32> = regions.iter().map(|r| r.cells).collect();
        region_cells.push(math::max(1, auto_cells));
        for i in 0..owner.len() {
            if owner[i] == 0 {
                continue;
            }
            let n = region_cells[owner[i] as usize - 1];
            cell_leaf[i] = -2 - blocks.len() as i32;
            blocks.push(NavVolumeBlock { scale: base_scale / n, start: block_leaf.len() as i32 });
            for _ in 0..n * n * n {
                block_leaf.push(-1); // merging fills in the free cells
            }
        }
        for leaf in leaves.iter_mut() {
            leaf.min *= base_scale;
            leaf.size *= base_scale;
        }

        for (ri, region) in regions.iter().enumerate() {
            build_region(
                hf,
                bmin,
                fcs,
                settings,
                dims,
                base_scale,
                region,
                ri,
                &owner,
                if applies { area_boxes } else { &[] },
                volume_bit,
                &cell_leaf,
                &blocks,
                &mut block_leaf,
                &mut leaves,
            );
        }

        if auto_cells > 0 {
            build_auto_blocks(
                hf,
                bmin,
                fcs,
                settings,
                dims,
                base_scale,
                auto_cells,
                &auto_list,
                area_boxes,
                applies,
                volume_bit,
                &cell_leaf,
                &blocks,
                &mut block_leaf,
                &mut leaves,
            );
        }

        // 6) Face adjacency across sizes, then (open to sky) the leaf fill.
        let units = dims * base_scale;
        let lists: Vec<Vec<i32>> = {
            let m = TwoLevel {
                base_leaf: &cell_leaf,
                blocks: &blocks,
                block_leaf: &block_leaf,
                base_dims: dims,
                base_scale,
                units,
            };
            leaves.iter().map(|leaf| two_level_neighbors(leaf, &m)).collect()
        };
        let mut n = assign_neighbor_ranges(&mut leaves, lists);
        if settings.open_to_sky_only {
            leaf_sky(&mut leaves, &mut n, &mut cell_leaf, &mut block_leaf, units.y);
        }
        neighbors = n;
    } else {
        // 6) Face adjacency: per leaf, in leaf order.
        let lists: Vec<Vec<i32>> = leaves.iter().map(|leaf| plain_neighbors(leaf, &cell_leaf, dims)).collect();
        neighbors = assign_neighbor_ranges(&mut leaves, lists);
    }

    // 7) Blob.
    let leaf_count = leaves.len() as i32;
    let data = NavVolumeData {
        origin: bmin,
        cell_size: fcs / base_scale as f32,
        dims: dims * base_scale,
        agent_radius: settings.agent_radius,
        base_scale,
        base_dims: dims,
        base_leaf: cell_leaf,
        blocks,
        block_leaf,
        leaves,
        neighbors,
        areas: area_table.to_vec(),
    };
    VolumeBuild { data, leaf_count, auto_stats }
}

/// One region's fine grid (`ScheduleRegion`): marked from the heightfield over the base cells its box covers plus a
/// padding margin, padded, cropped to the cells it owns (the rest blocked), octree, areas; then merged
/// (`MergeRegionJob`).
#[allow(clippy::too_many_arguments)]
fn build_region(
    hf: &SolidHeightfield,
    bmin: Float3,
    fcs: f32,
    settings: &VolumeSettings,
    dims: Int3,
    base_scale: i32,
    region: &VolumeRegion,
    index_: usize,
    owner: &[u8],
    area_boxes: &[VolumeAreaBox],
    volume_bit: u64,
    base_leaf: &[i32],
    blocks: &[NavVolumeBlock],
    block_leaf: &mut [i32],
    leaves: &mut Vec<NavVolumeLeaf>,
) {
    let n = region.cells;
    let clamp3 = |v: Int3| Int3::new(clamp(v.x, 0, dims.x), clamp(v.y, 0, dims.y), clamp(v.z, 0, dims.z));
    let b0 = clamp3(to_int3(((region.aabb_min - bmin) / fcs).floor()));
    let b1 = clamp3(to_int3(((region.aabb_max - bmin) / fcs).ceil()));
    if b1.x <= b0.x || b1.y <= b0.y || b1.z <= b0.z {
        return; // outside the volume: owns nothing
    }

    let ffcs = fcs / n as f32;
    let d = (b1 - b0) * n; // the cropped grid: the covered base cells, in fine cells
    let margin = math::ceil(settings.agent_radius / ffcs) as i32;
    let g = d + Int3::splat(2 * margin); // plus the padding's reach, so geometry just outside still pads inside
    let d_total = (d.x * d.y * d.z) as usize;
    let region_id = (index_ + 1) as u8;

    let mut marked = vec![0u8; (g.x * g.y * g.z) as usize];
    let offset = b0 * n - Int3::splat(margin);
    let volume_dims = dims * n;
    for index in 0..g.x * g.z {
        mark_fine_column(hf, ffcs, offset, g, volume_dims, index % g.x, index / g.x, &mut marked);
    }
    let padded = if margin > 0 { dilate_all(marked, g, margin) } else { marked };

    // Crop: the region's padded cells inside its covered base cells; cells of base cells it doesn't own are blocked.
    let mut cropped = vec![0u8; d_total];
    for (i, dst) in cropped.iter_mut().enumerate() {
        let i = i as i32;
        let c = Int3::new(i % d.x, i / d.x % d.y, i / (d.x * d.y));
        let owned = owner[index_v(dims, b0 + c / n)] == region_id;
        *dst = if owned { padded[index_v(g, c + Int3::splat(margin))] } else { 1 };
    }

    let prefix = prefix_sums(&cropped, d);
    let mut region_leaves = build_octree(&prefix, d);
    if !area_boxes.is_empty() {
        let origin = bmin + Float3::new(b0.x as f32, b0.y as f32, b0.z as f32) * fcs;
        let cell_areas = mark_areas(area_boxes, volume_bit, origin, ffcs, d);
        split_leaves_by_area(&mut region_leaves, &cell_areas, d);
    }
    let region_cells = cell_leaf_map(&region_leaves, d);

    // Merge: the region's leaves (in finest cells), then its owned base cells' blocks.
    let scale = base_scale / n;
    let start = leaves.len() as i32;
    for leaf in &region_leaves {
        let mut l = *leaf;
        l.min = (b0 * n + leaf.min) * scale;
        l.size = leaf.size * scale;
        leaves.push(l);
    }
    for z in b0.z..b1.z {
        for y in b0.y..b1.y {
            for x in b0.x..b1.x {
                let b = Int3::new(x, y, z);
                let bi = index_v(dims, b);
                if owner[bi] != region_id {
                    continue;
                }
                let block = blocks[(-2 - base_leaf[bi]) as usize];
                let local = (b - b0) * n;
                for i in 0..n * n * n {
                    let f = Int3::new(i % n, i / n % n, i / (n * n));
                    let l = region_cells[index_v(d, local + f)];
                    block_leaf[(block.start + i) as usize] = if l >= 0 { l + start } else { -1 };
                }
            }
        }
    }
}

/// The auto region (`AutoBlockJob`, `MergeAutoJob`): one auto-refined base cell at a time, in base cell order: its
/// fine cells marked from the heightfield (with a padding margin), padded, areas, then an octree over the cell
/// (leaves of one area); merged as leaves in finest cells and the cell's block.
#[allow(clippy::too_many_arguments)]
fn build_auto_blocks(
    hf: &SolidHeightfield,
    bmin: Float3,
    base_fcs: f32,
    settings: &VolumeSettings,
    base_dims: Int3,
    base_scale: i32,
    cells: i32,
    auto_list: &[i32],
    area_boxes: &[VolumeAreaBox],
    applies: bool,
    volume_bit: u64,
    base_leaf: &[i32],
    blocks: &[NavVolumeBlock],
    block_leaf: &mut [i32],
    leaves: &mut Vec<NavVolumeLeaf>,
) {
    let n = cells;
    let fcs = base_fcs / cells as f32;
    let margin = math::ceil(settings.agent_radius / fcs) as i32;
    let scale = base_scale / cells;
    for &b in auto_list {
        let bc = Int3::new(b % base_dims.x, b / base_dims.x % base_dims.y, b / (base_dims.x * base_dims.y));
        let g = Int3::splat(n + 2 * margin);
        let g_total = (g.x * g.y * g.z) as usize;
        let mut marked = vec![0u8; g_total];
        let offset = bc * n - Int3::splat(margin);
        for lz in 0..g.z {
            for lx in 0..g.x {
                mark_fine_column(hf, fcs, offset, g, base_dims * n, lx, lz, &mut marked);
            }
        }
        let src = if margin > 0 { dilate_all(marked, g, margin) } else { marked };

        // The base cell's own fine cells: blocked, and area.
        let cell_count = (n * n * n) as usize;
        let mut blocked = vec![0u8; cell_count];
        let mut areas = vec![0u8; cell_count];
        let cell_min = bmin + Float3::new(bc.x as f32, bc.y as f32, bc.z as f32) * (fcs * n as f32);
        for i in 0..cell_count {
            let i32_ = i as i32;
            let f = Int3::new(i32_ % n, i32_ / n % n, i32_ / (n * n));
            blocked[i] = src[index_v(g, f + Int3::splat(margin))];
            areas[i] = if applies {
                area_at(
                    area_boxes,
                    volume_bit,
                    cell_min + (Float3::new(f.x as f32, f.y as f32, f.z as f32) + Float3::splat(0.5)) * fcs,
                )
            } else {
                WALKABLE
            };
        }

        // Octree over the cell: a node is a leaf when it's all free and of one area.
        let mut cell_leaves: Vec<NavVolumeLeaf> = Vec::new();
        let mut stack = vec![Node { min: Int3::default(), size: n }];
        while let Some(node) = stack.pop() {
            let mut any_free = false;
            let mut any_blocked = false;
            let area = areas[(node.min.x + n * (node.min.y + n * node.min.z)) as usize];
            let mut uniform = true;
            for z in node.min.z..node.min.z + node.size {
                for y in node.min.y..node.min.y + node.size {
                    for x in node.min.x..node.min.x + node.size {
                        let i = (x + n * (y + n * z)) as usize;
                        if blocked[i] != 0 {
                            any_blocked = true;
                        } else {
                            any_free = true;
                        }
                        uniform &= areas[i] == area;
                    }
                }
            }

            if !any_free {
                continue;
            }
            if !any_blocked && uniform {
                cell_leaves.push(new_leaf(node.min, node.size, area));
                continue;
            }
            for c in (0..8).rev() {
                stack.push(child(node, c)); // popped in octant order 0..7
            }
        }

        let mut cell_leaf = vec![-1i32; cell_count];
        for (l, leaf) in cell_leaves.iter().enumerate() {
            for z in leaf.min.z..leaf.min.z + leaf.size {
                for y in leaf.min.y..leaf.min.y + leaf.size {
                    for x in leaf.min.x..leaf.min.x + leaf.size {
                        cell_leaf[(x + n * (y + n * z)) as usize] = l as i32;
                    }
                }
            }
        }

        // Merge.
        let start = leaves.len() as i32;
        for leaf in &cell_leaves {
            let mut l = *leaf;
            l.min = (bc * n + leaf.min) * scale;
            l.size = leaf.size * scale;
            leaves.push(l);
        }
        let block = blocks[(-2 - base_leaf[b as usize]) as usize];
        for i in 0..cell_count {
            let l = cell_leaf[i];
            block_leaf[block.start as usize + i] = if l >= 0 { l + start } else { -1 };
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Flight volumes of a bake
// ---------------------------------------------------------------------------------------------------------

/// What the flight-volume stage reads besides the heightfield: the flyers and the volumes that name them.
#[derive(Clone, Copy, Debug)]
pub struct FlightVolumeInput<'a> {
    /// One per flying agent type (`BakeFlyer`), before grouping.
    pub flyers: &'a [BakeFlyer],
    pub modifier_volumes: &'a [ModifierVolume],
    pub resolution_volumes: &'a [ResolutionVolume],
    /// The baked area table (`settings::build_area_table`).
    pub area_table: &'a [NavAreaInfo],
    /// The chunk has bounds: the volume spans the box exactly, no headroom above it.
    pub bounded: bool,
}

/// The flight volumes of a bake (`BakeContext.FlightGroups`, `FlyerGroup`, `FlightVolumes`, `FlightLeaves`,
/// `FlightRegions`, `FlightAuto`).
#[derive(Clone, Debug, PartialEq)]
pub struct FlightVolumes {
    /// One entry per volume (group), in order of each group's first flyer; `agent_group` maps flyer -> group.
    pub grouping: Grouping<BakeFlyer>,
    pub volumes: Vec<NavVolumeData>,
    pub leaf_counts: Vec<i32>,
    /// Per volume: (resolution regions applied, ignored).
    pub regions: Vec<(i32, i32)>,
    /// Per volume: (base cells auto refinement refined, skipped over the cap).
    pub auto_stats: Vec<(i32, i32)>,
}

/// The resolution volumes as the tier computation reads them (`build_tiers`' `resolution_boxes`): requested cell
/// size and the flyers each applies to.
pub fn flight_resolution_boxes(
    flyers: &[BakeFlyer],
    modifier_volumes: &[ModifierVolume],
    resolution_volumes: &[ResolutionVolume],
) -> Vec<ResolutionBox> {
    let (_, res_masks, _) = named_by_for_flyers(flyers, modifier_volumes, resolution_volumes);
    resolution_volumes
        .iter()
        .zip(res_masks)
        .map(|(v, mask)| ResolutionBox { cell_size: v.cell_size, volume_mask: mask })
        .collect()
}

/// Flyer bits (indices) to the bits of the volumes (groups) those flyers got (`GroupMask`).
fn group_mask(flyers: u64, flyer_count: usize, flyer_group: &[usize]) -> u64 {
    let mut groups = 0u64;
    for f in 0..flyer_count.min(64) {
        if flyers & (1u64 << f) != 0 && flyer_group[f] < 64 {
            groups |= 1u64 << flyer_group[f];
        }
    }
    groups
}

/// `ScheduleFlightVolumes`: one flight volume per group of flyers that would build the same one (`group_flyers`),
/// each from the ground heightfield `hf` (identity frame, so world space), whose bounds are `ground_min..ground_max`
/// (the ground bin's bounds). The volume spans the bounds, plus the group's headroom above them unless the chunk has
/// bounds (`input.bounded`). Air modifier volumes and resolution volumes are turned from flyer bits into group bits.
pub fn build_flight_volumes(
    hf: &SolidHeightfield,
    ground_min: Float3,
    ground_max: Float3,
    input: &FlightVolumeInput,
) -> FlightVolumes {
    let flyers = input.flyers;
    let (air_masks, res_masks, named) = named_by_for_flyers(flyers, input.modifier_volumes, input.resolution_volumes);
    let grouping = group_flyers(flyers, &named, hf.cs);

    let mut air_boxes: Vec<VolumeAreaBox> = Vec::new();
    for (v, volume) in input.modifier_volumes.iter().enumerate() {
        let Some(mask) = air_masks[v] else { continue };
        air_boxes.push(VolumeAreaBox {
            world_to_unit_box: volume.world_to_unit_box,
            aabb_min: volume.aabb_min,
            aabb_max: volume.aabb_max,
            area: area_index_or_walkable(input.area_table, volume.area_id) as u8,
            volume_mask: group_mask(mask, flyers.len(), &grouping.agent_group),
        });
    }
    let res_boxes: Vec<VolumeResolutionBox> = input
        .resolution_volumes
        .iter()
        .zip(&res_masks)
        .map(|(v, &mask)| VolumeResolutionBox {
            box_to_world: v.world_to_unit_box.inverse(),
            aabb_min: v.aabb_min,
            aabb_max: v.aabb_max,
            cell_size: v.cell_size,
            volume_mask: group_mask(mask, flyers.len(), &grouping.agent_group),
        })
        .collect();

    let mut out = FlightVolumes {
        grouping,
        volumes: Vec::new(),
        leaf_counts: Vec::new(),
        regions: Vec::new(),
        auto_stats: Vec::new(),
    };
    for (g, group) in out.grouping.groups.iter().enumerate() {
        let settings = VolumeSettings {
            enabled: true,
            cell_size: group.cell_size,
            agent_radius: group.radius,
            open_to_sky_only: group.open_to_sky_only,
            auto_refine_cells: 1
                << region_level(
                    group.cell_size,
                    group.cell_size / (1 << clamp(group.auto_refine_levels, 0, MAX_REGION_LEVELS)) as f32,
                    math::max(1, math::round(group.cell_size / hf.cs) as i32),
                ),
            auto_refine_max_cells: group.auto_refine_max_cells,
        };
        let (regions, ignored) = regions_for(&res_boxes, g as i32, group.cell_size, hf.cs);
        // With chunk bounds the volume spans the box exactly: its top is the box's, no headroom above it.
        let top = ground_max + Float3::new(0.0, if input.bounded { 0.0 } else { group.headroom }, 0.0);
        let built = build_volume(hf, ground_min, top, &settings, &air_boxes, g as i32, input.area_table, &regions);
        out.regions.push((regions.len() as i32, ignored));
        out.auto_stats.push(built.auto_stats);
        out.leaf_counts.push(built.leaf_count);
        out.volumes.push(built.data);
    }
    out
}

/// World triangles in, flight volumes out, for a bake with no walking agent types (or a test): picks the voxel size
/// the flyers-only tier would (`build_tiers`: two voxels across the smallest flight cell, or as small as the finest
/// resolution region asks for), rasterizes every triangle as solid over `bmin..bmax`, and builds the volumes. A bake
/// with walkers rasterizes the ground grid at its tier's cell size instead; call [`build_flight_volumes`] with that
/// heightfield.
pub fn bake_flight_volumes_from_triangles(
    triangles: &[[Float3; 3]],
    bmin: Float3,
    bmax: Float3,
    input: &FlightVolumeInput,
) -> FlightVolumes {
    let res = flight_resolution_boxes(input.flyers, input.modifier_volumes, input.resolution_volumes);
    let tiers = crate::settings::build_tiers(&[], input.flyers, &res);
    let tier = tiers.tiers[0];
    let hf = voxelize_triangles(triangles, bmin, bmax, tier.cs, tier.ch);
    build_flight_volumes(&hf, bmin, bmax, input)
}

// ---------------------------------------------------------------------------------------------------------
// Queries the bake needs (NavVolumePathfinding.LeafAt and friends)
// ---------------------------------------------------------------------------------------------------------

/// The free leaf containing finest cell `c`, or -1 (blocked or outside the volume) (`LeafAtCell`).
pub fn leaf_at_cell(v: &NavVolumeData, c: Int3) -> i32 {
    if c.x < 0 || c.y < 0 || c.z < 0 || any_ge(c, v.dims) {
        return -1;
    }
    let b = c / v.base_scale;
    let entry = v.base_leaf[(b.x + v.base_dims.x * (b.y + v.base_dims.y * b.z)) as usize];
    if entry >= -1 {
        return entry;
    }

    let block = v.blocks[(-2 - entry) as usize];
    let n = v.base_scale / block.scale;
    let f = (c - b * v.base_scale) / block.scale;
    v.block_leaf[(block.start + f.x + n * (f.y + n * f.z)) as usize]
}

/// The free leaf containing `p`, or -1 (blocked or outside the volume) (`LeafAt`).
pub fn leaf_at(v: &NavVolumeData, p: Float3) -> i32 {
    leaf_at_cell(v, to_int3(((p - v.origin) / v.cell_size).floor()))
}

/// Edge of a base cell, world units (`BaseCellSize`).
pub fn base_cell_size(v: &NavVolumeData) -> f32 {
    v.cell_size * v.base_scale as f32
}

/// Edge of the grid cell at `p`, world units: a refined block's cell inside a resolution region, else a base cell
/// (`CellSizeAt`).
pub fn cell_size_at(v: &NavVolumeData, p: Float3) -> f32 {
    if v.blocks.is_empty() {
        return base_cell_size(v);
    }
    let c = to_int3(((p - v.origin) / v.cell_size).floor());
    if c.x < 0 || c.y < 0 || c.z < 0 || any_ge(c, v.dims) {
        return base_cell_size(v);
    }
    let b = c / v.base_scale;
    let entry = v.base_leaf[(b.x + v.base_dims.x * (b.y + v.base_dims.y * b.z)) as usize];
    if entry >= -1 {
        base_cell_size(v)
    } else {
        v.blocks[(-2 - entry) as usize].scale as f32 * v.cell_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{build_area_table, ModifierTargets, NavArea};
    use Float4x4;
    use nav_math::{Float4, Hash128};

    type Tri = [Float3; 3];

    fn f3(x: f32, y: f32, z: f32) -> Float3 {
        Float3::new(x, y, z)
    }

    /// The 12 triangles of an axis-aligned box.
    pub(crate) fn boxed(min: Float3, max: Float3) -> Vec<Tri> {
        let p = |x: bool, y: bool, z: bool| {
            f3(if x { max.x } else { min.x }, if y { max.y } else { min.y }, if z { max.z } else { min.z })
        };
        let face = |a: Float3, b: Float3, c: Float3, d: Float3| [[a, b, c], [a, c, d]];
        let mut t = Vec::new();
        t.extend(face(p(false, true, false), p(false, true, true), p(true, true, true), p(true, true, false)));
        t.extend(face(p(false, false, false), p(true, false, false), p(true, false, true), p(false, false, true)));
        t.extend(face(p(false, false, false), p(false, false, true), p(false, true, true), p(false, true, false)));
        t.extend(face(p(true, false, false), p(true, true, false), p(true, true, true), p(true, false, true)));
        t.extend(face(p(false, false, false), p(false, true, false), p(true, true, false), p(true, false, false)));
        t.extend(face(p(false, false, true), p(true, false, true), p(true, true, true), p(false, true, true)));
        t
    }

    fn flyer(radius: f32, cell: f32, headroom: f32) -> BakeFlyer {
        BakeFlyer::test_flyer(radius, cell, headroom, 100, 30.0)
    }

    fn run(tris: &[Tri], bmin: Float3, bmax: Float3, flyers: &[BakeFlyer], bounded: bool) -> FlightVolumes {
        let input = FlightVolumeInput {
            flyers,
            modifier_volumes: &[],
            resolution_volumes: &[],
            area_table: &build_area_table(&[]),
            bounded,
        };
        bake_flight_volumes_from_triangles(tris, bmin, bmax, &input)
    }

    /// Leaf indices reachable from `start` over the neighbour lists.
    fn reach(v: &NavVolumeData, start: i32) -> Vec<bool> {
        let mut seen = vec![false; v.leaves.len()];
        let mut stack = vec![start];
        seen[start as usize] = true;
        while let Some(l) = stack.pop() {
            let leaf = v.leaves[l as usize];
            for k in 0..leaf.neighbor_count {
                let o = v.neighbors[(leaf.neighbor_start + k) as usize];
                if !seen[o as usize] {
                    seen[o as usize] = true;
                    stack.push(o);
                }
            }
        }
        seen
    }

    #[test]
    fn empty_box_of_air_is_one_big_leaf() {
        let out = run(&[], f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &[flyer(0.5, 1.0, 0.0)], false);
        let v = &out.volumes[0];
        assert_eq!(v.dims, Int3::new(16, 16, 16));
        assert_eq!(v.leaves.len(), 1);
        assert_eq!(v.leaves[0].size, 16);
        assert!(v.neighbors.is_empty());
        assert_eq!(out.leaf_counts[0], 1);
        assert_eq!(leaf_at(v, f3(8.0, 8.0, 8.0)), 0);
        assert_eq!(leaf_at(v, f3(-1.0, 8.0, 8.0)), -1);
    }

    #[test]
    fn a_wall_splits_the_volume() {
        // A full-height, full-depth wall at x = 8: no neighbour path from one side to the other.
        let tris = boxed(f3(7.5, 0.0, 0.0), f3(8.5, 16.0, 16.0));
        let out = run(&tris, f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &[flyer(0.5, 1.0, 0.0)], false);
        let v = &out.volumes[0];
        let left = leaf_at(v, f3(3.5, 8.5, 8.5));
        let right = leaf_at(v, f3(12.5, 8.5, 8.5));
        assert!(left >= 0 && right >= 0);
        assert_eq!(leaf_at(v, f3(8.0, 8.5, 8.5)), -1);
        let seen = reach(v, left);
        assert!(!seen[right as usize]);
        for (l, leaf) in v.leaves.iter().enumerate() {
            if seen[l] {
                assert!(leaf.min.x + leaf.size <= 8, "left side leaf {l} reaches the wall");
            }
        }
        // And without the wall the two points connect.
        let open = run(&[], f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &[flyer(0.5, 1.0, 0.0)], false);
        assert_eq!(leaf_at(&open.volumes[0], f3(3.5, 8.5, 8.5)), leaf_at(&open.volumes[0], f3(12.5, 8.5, 8.5)));
    }

    #[test]
    fn headroom_extends_the_volume_above_the_geometry() {
        let tris = boxed(f3(0.0, 0.0, 0.0), f3(8.0, 1.0, 8.0));
        let (bmin, bmax) = (f3(0.0, 0.0, 0.0), f3(8.0, 4.0, 8.0));
        let with = run(&tris, bmin, bmax, &[flyer(0.5, 1.0, 3.0)], false);
        let v = &with.volumes[0];
        assert_eq!(v.dims.y, 7);
        assert!(leaf_at(v, f3(4.0, 6.5, 4.0)) >= 0);
        // Triangles are surfaces: the floor's top (y = 1, a span 1.0..1.25) blocks cell 1; the radius pads it to cell 2.
        assert_eq!(leaf_at(v, f3(4.5, 1.5, 4.5)), -1);
        assert_eq!(leaf_at(v, f3(4.5, 2.5, 4.5)), -1);
        assert!(leaf_at(v, f3(4.5, 3.5, 4.5)) >= 0);
        let bounded = run(&tris, bmin, bmax, &[flyer(0.5, 1.0, 3.0)], true);
        assert_eq!(bounded.volumes[0].dims.y, 4); // chunk bounds: no headroom
    }

    #[test]
    fn open_to_sky_only_drops_sealed_air() {
        // A sealed hollow room: slabs 1 thick around (4..12)^3.
        let mut tris = Vec::new();
        tris.extend(boxed(f3(3.0, 3.0, 3.0), f3(13.0, 4.0, 13.0))); // floor
        tris.extend(boxed(f3(3.0, 12.0, 3.0), f3(13.0, 13.0, 13.0))); // roof
        tris.extend(boxed(f3(3.0, 3.0, 3.0), f3(4.0, 13.0, 13.0)));
        tris.extend(boxed(f3(12.0, 3.0, 3.0), f3(13.0, 13.0, 13.0)));
        tris.extend(boxed(f3(3.0, 3.0, 3.0), f3(13.0, 13.0, 4.0)));
        tris.extend(boxed(f3(3.0, 3.0, 12.0), f3(13.0, 13.0, 13.0)));
        let (bmin, bmax) = (f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0));
        let inside = f3(8.5, 8.5, 8.5);

        let sky = run(&tris, bmin, bmax, &[flyer(0.5, 1.0, 0.0)], false);
        assert_eq!(leaf_at(&sky.volumes[0], inside), -1);
        assert!(leaf_at(&sky.volumes[0], f3(1.5, 8.5, 8.5)) >= 0);

        let mut anywhere = flyer(0.5, 1.0, 0.0);
        anywhere.open_to_sky_only = false;
        let any = run(&tris, bmin, bmax, &[anywhere], false);
        assert!(leaf_at(&any.volumes[0], inside) >= 0);
    }

    fn region_box(min: Float3, max: Float3) -> Float4x4 {
        let s = max - min;
        let c = (min + max) * 0.5;
        Float4x4::new(
            Float4::new(s.x, 0.0, 0.0, 0.0),
            Float4::new(0.0, s.y, 0.0, 0.0),
            Float4::new(0.0, 0.0, s.z, 0.0),
            Float4::new(c.x, c.y, c.z, 1.0),
        )
    }

    #[test]
    fn a_resolution_region_refines_the_cells_inside_it() {
        let pole = boxed(f3(5.8, 4.0, 5.8), f3(6.2, 8.0, 6.2));
        let flyers = [flyer(0.5, 1.0, 0.0)];
        let res = [ResolutionVolume::from_box(region_box(f3(4.0, 4.0, 4.0), f3(8.0, 8.0, 8.0)), 0.5, vec![])];
        let input = FlightVolumeInput {
            flyers: &flyers,
            modifier_volumes: &[],
            resolution_volumes: &res,
            area_table: &build_area_table(&[]),
            bounded: false,
        };
        let out = bake_flight_volumes_from_triangles(&pole, f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &input);
        assert_eq!(out.regions[0], (1, 0));
        let v = &out.volumes[0];
        assert_eq!(v.base_scale, 2);
        assert_eq!(v.cell_size, 0.5);
        assert_eq!(v.dims, Int3::new(32, 32, 32));
        assert_eq!(v.base_dims, Int3::new(16, 16, 16));
        assert_eq!(v.blocks.len(), 64);
        assert!(v.blocks.iter().all(|b| b.scale == 1));
        assert_eq!(v.block_leaf.len(), 64 * 8);
        // Inside: -2 - block; outside: a leaf index.
        let inside = v.base_leaf[(5 + 16 * (5 + 16 * 5)) as usize];
        assert!(inside <= -2);
        let outside = v.base_leaf[(12 + 16 * (12 + 16 * 12)) as usize];
        assert!(outside >= 0);
        // The pole blocks fine cells inside the region (and only blocks cells there at this resolution).
        assert_eq!(leaf_at(v, f3(6.0, 6.0, 6.0)), -1);
        assert!(v.block_leaf.contains(&-1));
        assert!(v.block_leaf.iter().any(|&l| l >= 0));
        assert!(leaf_at(v, f3(4.25, 4.25, 4.25)) >= 0);
        assert_eq!(cell_size_at(v, f3(6.0, 6.0, 6.0)), 0.5);
        assert_eq!(cell_size_at(v, f3(12.0, 12.0, 12.0)), 1.0);
        // The leaves of both levels are consistent: every neighbour link is mutual.
        for (l, leaf) in v.leaves.iter().enumerate() {
            for k in 0..leaf.neighbor_count {
                let o = v.neighbors[(leaf.neighbor_start + k) as usize] as usize;
                let other = v.leaves[o];
                let back = (0..other.neighbor_count).any(|j| v.neighbors[(other.neighbor_start + j) as usize] == l as i32);
                assert!(back, "link {l} -> {o} is not mutual");
            }
        }
    }

    /// Two short walls with a one-cell... gap: padding blocks the gap, auto refinement opens it.
    fn pinch_tris() -> Vec<Tri> {
        let mut t = boxed(f3(5.0, 0.0, 6.0), f3(7.0, 16.0, 10.0));
        t.extend(boxed(f3(9.0, 0.0, 6.0), f3(11.0, 16.0, 10.0)));
        t
    }

    fn auto_flyer(max_cells: i32) -> BakeFlyer {
        let mut f = flyer(0.5, 1.0, 0.0);
        f.auto_refine_levels = 1;
        f.auto_refine_max_cells = max_cells;
        f
    }

    #[test]
    fn auto_refine_refines_pinches_and_respects_the_cap() {
        let (bmin, bmax) = (f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0));
        let tris = pinch_tris();
        let coarse = run(&tris, bmin, bmax, &[flyer(0.5, 1.0, 0.0)], false);
        assert_eq!(leaf_at(&coarse.volumes[0], f3(8.0, 8.0, 8.0)), -1); // padding closes the gap

        let out = run(&tris, bmin, bmax, &[auto_flyer(0)], false);
        let (refined, skipped) = out.auto_stats[0];
        assert!(refined > 0 && skipped == 0, "{refined} {skipped}");
        let v = &out.volumes[0];
        assert_eq!(v.base_scale, 2);
        assert_eq!(v.blocks.len() as i32, refined);
        assert_eq!(v.cell_size, 0.5);
        // The refined gap is open at fine resolution.
        assert!(leaf_at(v, f3(8.0, 8.0, 8.0)) >= 0);

        // A cap below the count refines nothing.
        let capped = run(&tris, bmin, bmax, &[auto_flyer(refined - 1)], false);
        assert_eq!(capped.auto_stats[0], (0, refined));
        assert!(capped.volumes[0].blocks.is_empty());
        assert_eq!(capped.volumes[0].base_scale, 2);
        assert_eq!(leaf_at(&capped.volumes[0], f3(8.0, 8.0, 8.0)), -1);
        // Exactly the count is allowed.
        let exact = run(&tris, bmin, bmax, &[auto_flyer(refined)], false);
        assert_eq!(exact.auto_stats[0], (refined, 0));
        assert_eq!(exact.volumes[0], out.volumes[0]);
    }

    #[test]
    fn modifier_volume_sets_leaf_areas() {
        let area = NavArea { id: Hash128::new(7, 0, 0, 0), default_cost: 3.0, color: Float4::splat(1.0) };
        let table = build_area_table(&[area]);
        let flyers = [flyer(0.5, 1.0, 0.0)];
        // Air only, the x < 8 half.
        let modifier = ModifierVolume::from_box(
            region_box(f3(-2.0, -2.0, -2.0), f3(8.0, 18.0, 18.0)),
            area.id,
            ModifierTargets::AIR,
            vec![],
        );
        let ground_only = ModifierVolume::from_box(
            region_box(f3(8.0, -2.0, -2.0), f3(18.0, 18.0, 18.0)),
            area.id,
            ModifierTargets::GROUND,
            vec![],
        );
        let mods = [modifier, ground_only];
        let input = FlightVolumeInput {
            flyers: &flyers,
            modifier_volumes: &mods,
            resolution_volumes: &[],
            area_table: &table,
            bounded: false,
        };
        let out = bake_flight_volumes_from_triangles(&[], f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &input);
        let v = &out.volumes[0];
        let lo = leaf_at(v, f3(3.5, 8.5, 8.5));
        let hi = leaf_at(v, f3(12.5, 8.5, 8.5));
        assert!(lo >= 0 && hi >= 0 && lo != hi);
        assert_eq!(v.leaves[lo as usize].area, 2);
        assert_eq!(v.leaves[hi as usize].area, 1);
        assert!(v.leaves.iter().all(|l| l.area == 1 || l.area == 2));
        assert_eq!(v.areas.len(), 3);
        // The two halves are neighbours somewhere across x = 8.
        assert!(reach(v, lo)[hi as usize]);
        // A leaf never straddles the boundary.
        assert!(v.leaves.iter().all(|l| l.min.x + l.size <= 8 || l.min.x >= 8));
    }

    #[test]
    fn regions_for_sorts_finest_first_and_counts_ignored() {
        let b = |cell: f32| VolumeResolutionBox {
            box_to_world: region_box(f3(0.0, 0.0, 0.0), f3(4.0, 4.0, 4.0)),
            aabb_min: f3(0.0, 0.0, 0.0),
            aabb_max: f3(4.0, 4.0, 4.0),
            cell_size: cell,
            volume_mask: 1,
        };
        let boxes = [b(0.5), b(0.25), b(1.0), b(0.5)];
        let (regions, ignored) = regions_for(&boxes, 0, 1.0, 0.125);
        assert_eq!(ignored, 1); // cell 1.0: no finer level
        assert_eq!(regions.iter().map(|r| r.cells).collect::<Vec<_>>(), vec![4, 2, 2]);
        let (none, ignored) = regions_for(&boxes, 1, 1.0, 0.125);
        assert!(none.is_empty() && ignored == 0); // names another volume
        // Whole voxels only: 1.0 / 0.5 = 2 voxels per cell cannot hold 4 fine cells.
        let (regions, _) = regions_for(&boxes[1..2], 0, 1.0, 0.5);
        assert_eq!(regions[0].cells, 2);
    }

    #[test]
    fn deterministic_and_triangle_order_independent() {
        let mut tris = pinch_tris();
        tris.extend(boxed(f3(1.0, 0.0, 1.0), f3(3.0, 5.0, 3.0)));
        let (bmin, bmax) = (f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0));
        let flyers = [auto_flyer(0)];
        let a = run(&tris, bmin, bmax, &flyers, false);
        assert_eq!(a, run(&tris, bmin, bmax, &flyers, false));
        let mut rev = tris.clone();
        rev.reverse();
        assert_eq!(a, run(&rev, bmin, bmax, &flyers, false));
        let mut rot = tris.clone();
        rot.rotate_left(7);
        assert_eq!(a, run(&rot, bmin, bmax, &flyers, false));
    }

    #[test]
    fn flyers_with_equal_settings_share_a_volume() {
        let mut other = flyer(0.5, 1.0, 0.0);
        other.id = Hash128::new(101, 0, 0, 0);
        let fatter = flyer(1.0, 1.0, 0.0);
        let flyers = [flyer(0.5, 1.0, 0.0), other, fatter];
        let out = run(&[], f3(0.0, 0.0, 0.0), f3(8.0, 8.0, 8.0), &flyers, false);
        assert_eq!(out.volumes.len(), 2);
        assert_eq!(out.grouping.agent_group, vec![0, 0, 1]);
        assert_eq!(out.volumes[1].agent_radius, 1.0);
    }

    #[test]
    fn neighbour_lists_match_a_brute_force_adjacency() {
        let mut tris = boxed(f3(2.0, 0.0, 2.0), f3(5.0, 9.0, 5.0));
        tris.extend(boxed(f3(9.0, 4.0, 9.0), f3(14.0, 6.0, 14.0)));
        let out = run(&tris, f3(0.0, 0.0, 0.0), f3(16.0, 16.0, 16.0), &[flyer(0.5, 1.0, 0.0)], false);
        let v = &out.volumes[0];
        let touches = |a: &NavVolumeLeaf, b: &NavVolumeLeaf| {
            let mut face = false;
            for axis in 0..3 {
                let (a0, a1, b0, b1) = (a.min[axis], a.min[axis] + a.size, b.min[axis], b.min[axis] + b.size);
                let overlap = a0 < b1 && b0 < a1;
                let abut = a1 == b0 || b1 == a0;
                let others = (0..3).filter(|&k| k != axis).all(|k| {
                    a.min[k] < b.min[k] + b.size && b.min[k] < a.min[k] + a.size
                });
                if abut && others {
                    face = true;
                }
                let _ = overlap;
            }
            face
        };
        for (i, a) in v.leaves.iter().enumerate() {
            let mut expect: Vec<i32> = (0..v.leaves.len())
                .filter(|&j| j != i && touches(a, &v.leaves[j]))
                .map(|j| j as i32)
                .collect();
            let mut got: Vec<i32> =
                (0..a.neighbor_count).map(|k| v.neighbors[(a.neighbor_start + k) as usize]).collect();
            expect.sort_unstable();
            got.sort_unstable();
            assert_eq!(got, expect, "leaf {i}");
        }
    }
}
