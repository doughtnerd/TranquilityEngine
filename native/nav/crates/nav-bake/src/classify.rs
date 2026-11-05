//! Triangle classification and bucketing: `Authoring/Baking/Jobs/ClassifyTriangleJob.cs`,
//! `AssignTriangleToBinJob.cs`, `BucketTrianglesJob.cs`, `TileKeyJob.cs` and the pure helpers of
//! `MeshToTrianglesJob.cs`.
//!
//! Stage order (`types::BakeStage`): Triangles -> Classify -> Bucket.
//! 1. [`InputTriangle`]s (world space; the engine passes them in, Unity mesh access is not ported) get a [`Normal`].
//! 2. [`assign_triangles_to_bins`] picks each triangle's bin, [`classify_triangles`] marks it walkable in that bin or
//!    not, and [`build_triangle_data`] turns the three into the `TriangleData` the tile jobs read.
//!    [`classify`] runs all of it.
//! 3. [`bucket_triangles`] counts, then fills, the slice of every tile each triangle touches. The C#'s two passes
//!    used `Interlocked` slot allocation, so slot order within a slice depended on thread timing; here each slice is
//!    filled in ascending triangle index. [`tile_keys`] (`TileKeyJob`) then sorts every slice by triangle content
//!    and hashes everything rasterization reads into the tile's cache key. After the sort the slice order is the
//!    C#'s, whatever order the input came in, which is what makes the bake independent of scheduling and input order.
//!
//! All the maths mirrors the C# expression order (single floats; the tile range uses `1f / cs` and float floors).
use nav_math::hash::{hash_bytes, hash_value};
use nav_math::math;
use nav_math::{Float3, Hash128, Int4};

use crate::bins::BinSetMetadata;
use crate::settings::{all_profiles, group_bit, BakeProfile};
use crate::types::{triangle_content_cmp, BinGrid, NavTile, NavTileHeightfield, TriangleData};

// ---------------------------------------------------------------------------------------------------------
// Per-triangle components (BakingComponents.cs)
// ---------------------------------------------------------------------------------------------------------

/// A triangle's unit normal (`Normal`); zero and flagged degenerate if the triangle has no area.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Normal {
    pub value: Float3,
    pub is_degenerate: bool,
}

impl Normal {
    /// `FFMeshBlob.Build`'s face normal: `cross(b - a, c - a)` normalised, zero if the cross product's length is
    /// not above `1e-12`. Also returns that length (twice the area, the blob's `w`).
    pub fn from_triangle(a: Float3, b: Float3, c: Float3) -> (Self, f32) {
        let cross = (b - a).cross(c - a);
        let len = cross.length();
        let nrm = if len > 1e-12 { cross / len } else { Float3::default() };
        // `MeshToTrianglesJob`: `IsDegenerate = faceNormal.w <= 1e-12f`.
        (Self { value: nrm, is_degenerate: len <= 1e-12 }, len)
    }
}

/// The bin a triangle belongs to (`BinAssignment`): it is walkable only there; other bins rasterize it as solid.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BinAssignment {
    pub bin_index: i32,
    pub n: Float3,
}

/// `TriangleFlags`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TriangleFlags {
    /// Walkable in its assigned bin (slope and coverage); solid everywhere else.
    pub walkable: bool,
}

/// One world-space bake triangle before classification: `Vertices` + `Normal` + `ProfileMask` + `TriangleArea`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputTriangle {
    pub a: Float3,
    pub b: Float3,
    pub c: Float3,
    pub normal: Normal,
    /// Profiles (bits) whose navmesh this triangle's mesh is walkable for.
    pub profile_mask: u32,
    /// The navmesh area (`NavAreas`) of its walkable surface.
    pub area: i32,
}

impl InputTriangle {
    /// A triangle with its normal computed as the C# bake does.
    pub fn new(a: Float3, b: Float3, c: Float3, profile_mask: u32, area: i32) -> Self {
        let (normal, _) = Normal::from_triangle(a, b, c);
        Self { a, b, c, normal, profile_mask, area }
    }
}

/// `MeshToTrianglesJob.ComputeProfileMask`: the profiles listed in the mesh's walkable-agent list (the OR of each
/// listed agent's group bit), or every profile if it lists none.
pub fn compute_profile_mask(walkable_for: &[Hash128], agents: &[BakeProfile], agent_group: &[usize], profile_count: usize) -> u32 {
    if walkable_for.is_empty() {
        return all_profiles(profile_count);
    }
    let mut mask = 0u32;
    for id in walkable_for {
        mask |= group_bit(*id, agents, agent_group);
    }
    mask
}

// ---------------------------------------------------------------------------------------------------------
// Bin assignment and classification
// ---------------------------------------------------------------------------------------------------------

/// `AssignTriangleToBinJob.Assign`: the bin index for a unit normal.
pub fn assign_bin(bins: &[crate::bins::Bin], meta: &BinSetMetadata, nrm: Float3) -> i32 {
    if nrm.y >= meta.ground_capture_cos {
        return 0;
    }

    if meta.ceiling_bin >= 0 && -nrm.y >= meta.ceiling_capture_cos {
        return meta.ceiling_bin;
    }

    let mut best = -1;
    let mut best_dot = f32::MIN;
    for k in meta.first_side_bin..meta.first_side_bin + meta.side_bin_count {
        let d = nrm.dot(bins[k as usize].n);
        if d > best_dot {
            best_dot = d;
            best = k;
        }
    }

    if best >= 0 {
        return best;
    }

    // No side bins configured: fall back to floor/ceiling; the coverage test rejects anything too steep.
    if meta.ceiling_bin >= 0 && nrm.y < 0.0 { meta.ceiling_bin } else { 0 }
}

/// `AssignTriangleToBinJob`: every triangle's [`BinAssignment`], in input order.
pub fn assign_triangles_to_bins(bins: &[crate::bins::Bin], meta: &BinSetMetadata, triangles: &[InputTriangle]) -> Vec<BinAssignment> {
    triangles
        .iter()
        .map(|t| {
            let k = assign_bin(bins, meta, t.normal.value);
            BinAssignment { bin_index: k, n: bins[k as usize].n }
        })
        .collect()
}

/// `ClassifyTriangle.Execute`: walkable when the triangle has area, its slope is within the maximum surface angle and
/// it lies within its bin's coverage cone.
pub fn classify_triangle(meta: &BinSetMetadata, normal: &Normal, bin: &BinAssignment) -> TriangleFlags {
    let nrm = normal.value;
    TriangleFlags { walkable: !normal.is_degenerate && nrm.y >= meta.max_surface_cos && nrm.dot(bin.n) > meta.coverage_cos }
}

/// `ClassifyTriangle` over every triangle.
pub fn classify_triangles(meta: &BinSetMetadata, triangles: &[InputTriangle], bins: &[BinAssignment]) -> Vec<TriangleFlags> {
    triangles.iter().zip(bins).map(|(t, b)| classify_triangle(meta, &t.normal, b)).collect()
}

/// The `TriangleData` of `CountTileTrianglesJob`: world vertices, bin, walkable-for mask (0 when not walkable) and
/// area, one per input triangle in input order.
pub fn build_triangle_data(triangles: &[InputTriangle], bins: &[BinAssignment], flags: &[TriangleFlags]) -> Vec<TriangleData> {
    (0..triangles.len())
        .map(|i| TriangleData {
            a: triangles[i].a,
            b: triangles[i].b,
            c: triangles[i].c,
            bin: bins[i].bin_index,
            walkable_for: if flags[i].walkable { triangles[i].profile_mask } else { 0 },
            area: triangles[i].area,
        })
        .collect()
}

/// Bin assignment, classification and `TriangleData` in one call.
pub fn classify(bins: &[crate::bins::Bin], meta: &BinSetMetadata, triangles: &[InputTriangle]) -> Vec<TriangleData> {
    let assignments = assign_triangles_to_bins(bins, meta, triangles);
    let flags = classify_triangles(meta, triangles, &assignments);
    build_triangle_data(triangles, &assignments, &flags)
}

// ---------------------------------------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------------------------------------

fn floor_div(a: i32, b: i32) -> i32 {
    if a >= 0 { a / b } else { -((-a + b - 1) / b) }
}

/// `TileBucketing.TileRange`: the tile range `(x_min, z_min, x_max, z_max)` of `grid` whose bordered area overlaps the
/// triangle, or `None` if there is none.
pub fn tile_range(grid: &BinGrid, world_a: Float3, world_b: Float3, world_c: Float3) -> Option<Int4> {
    let a = grid.world_to_local.mul_vec(world_a);
    let b = grid.world_to_local.mul_vec(world_b);
    let c = grid.world_to_local.mul_vec(world_c);
    let bb_min = a.min_v(b).min_v(c);
    let bb_max = a.max_v(b).max_v(c);
    if !grid.bounds.overlaps(bb_min, bb_max) {
        return None;
    }

    // Columns the triangle covers, padded by one for the rasterizer's float error.
    let inv = 1.0f32 / grid.cs;
    let x0 = ((bb_min.x - grid.bounds.min.x) * inv).floor() as i32 - 1;
    let x1 = ((bb_max.x - grid.bounds.min.x) * inv).floor() as i32 + 1;
    let z0 = ((bb_min.z - grid.bounds.min.z) * inv).floor() as i32 - 1;
    let z1 = ((bb_max.z - grid.bounds.min.z) * inv).floor() as i32 + 1;

    // Tile t's bordered columns are [t * size - border, (t + 1) * size - 1 + border].
    let (tx_min, tx_max) = (floor_div(x0 - grid.border, grid.tile_size), floor_div(x1 + grid.border, grid.tile_size));
    let (tz_min, tz_max) = (floor_div(z0 - grid.border, grid.tile_size), floor_div(z1 + grid.border, grid.tile_size));
    if tx_max < 0 || tz_max < 0 || tx_min >= grid.tiles_x || tz_min >= grid.tiles_z {
        return None;
    }

    Some(Int4::new(
        math::max(tx_min, 0),
        math::max(tz_min, 0),
        math::min(tx_max, grid.tiles_x - 1),
        math::min(tz_max, grid.tiles_z - 1),
    ))
}

/// Each tile's triangles: `buckets[starts[t] .. starts[t] + counts[t]]` are indices into the triangle array.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TileBuckets {
    /// Per tile: the start of its slice.
    pub starts: Vec<i32>,
    /// Per tile: the triangle count.
    pub counts: Vec<i32>,
    /// All slices. Within a slice: ascending triangle index until [`tile_keys`] sorts it by content.
    pub buckets: Vec<i32>,
}

impl TileBuckets {
    /// Tile `t`'s triangle indices.
    pub fn slice(&self, t: usize) -> &[i32] {
        let s = self.starts[t] as usize;
        &self.buckets[s..s + self.counts[t] as usize]
    }
}

/// `CountTileTrianglesJob` + prefix sum + `ScatterTileTrianglesJob`, sequentially: pass 1 counts the triangles of every
/// tile (`tile_count` tiles over all active grids), pass 2 writes each triangle's index into the slice of every tile it
/// touches, triangles in ascending index so slots are deterministic.
pub fn bucket_triangles(grids: &[BinGrid], triangles: &[TriangleData], tile_count: i32) -> TileBuckets {
    let tile_count = tile_count.max(0) as usize;
    let mut counts = vec![0i32; tile_count];
    for tri in triangles {
        for grid in grids {
            if !grid.active {
                continue;
            }
            let Some(r) = tile_range(grid, tri.a, tri.b, tri.c) else { continue };
            for z in r.y..=r.w {
                for x in r.x..=r.z {
                    counts[(grid.first_tile + x + z * grid.tiles_x) as usize] += 1;
                }
            }
        }
    }

    let mut starts = vec![0i32; tile_count];
    let mut bucketed = 0i32;
    for i in 0..tile_count {
        starts[i] = bucketed;
        bucketed += counts[i];
    }

    // The C# allocates `max(bucketed, 1)`.
    let mut buckets = vec![0i32; bucketed.max(1) as usize];
    let mut cursors = vec![0i32; tile_count];
    for (index, tri) in triangles.iter().enumerate() {
        for grid in grids {
            if !grid.active {
                continue;
            }
            let Some(r) = tile_range(grid, tri.a, tri.b, tri.c) else { continue };
            for z in r.y..=r.w {
                for x in r.x..=r.z {
                    let tile = (grid.first_tile + x + z * grid.tiles_x) as usize;
                    let slot = cursors[tile];
                    cursors[tile] += 1;
                    buckets[(starts[tile] + slot) as usize] = index as i32;
                }
            }
        }
    }

    TileBuckets { starts, counts, buckets }
}

// ---------------------------------------------------------------------------------------------------------
// Tile keys
// ---------------------------------------------------------------------------------------------------------

/// The seed of `TileKeyJob`'s hash.
pub const TILE_KEY_SEED: u64 = 0x7113C4C4;

fn push_f32(out: &mut Vec<u8>, v: f32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_f3(out: &mut Vec<u8>, v: Float3) {
    push_f32(out, v.x);
    push_f32(out, v.y);
    push_f32(out, v.z);
}

/// `TileKeyJob.Layout`, field by field in the C#'s order, every field 4 bytes: the grid and tile values
/// rasterization reads.
pub fn tile_layout_bytes(grid: &BinGrid, id: &NavTile, tile: &NavTileHeightfield) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 52);
    let m = grid.world_to_local;
    push_f3(&mut out, m.c0);
    push_f3(&mut out, m.c1);
    push_f3(&mut out, m.c2);
    push_f3(&mut out, grid.bounds.min);
    push_f3(&mut out, grid.bounds.max);
    push_f32(&mut out, grid.cs);
    push_f32(&mut out, grid.ch);
    push_i32(&mut out, grid.width);
    push_i32(&mut out, grid.height);
    push_i32(&mut out, grid.depth);
    push_u32(&mut out, grid.tier_mask);
    push_i32(&mut out, grid.flag_merge_threshold);
    push_i32(&mut out, grid.tile_size);
    push_i32(&mut out, grid.border);
    push_i32(&mut out, grid.bin);
    push_i32(&mut out, grid.clip as i32);
    push_i32(&mut out, grid.faces as i32);
    push_i32(&mut out, grid.open_sides);
    push_f3(&mut out, grid.box_min);
    push_f3(&mut out, grid.box_max);
    push_i32(&mut out, id.x);
    push_i32(&mut out, id.z);
    push_i32(&mut out, tile.interior.x);
    push_i32(&mut out, tile.interior.y);
    push_f3(&mut out, tile.bounds.min);
    push_f3(&mut out, tile.bounds.max);
    push_i32(&mut out, tile.width);
    push_i32(&mut out, tile.height);
    push_i32(&mut out, tile.origin_x);
    push_i32(&mut out, tile.origin_z);
    out
}

/// `TileKeyJob`, one tile: sorts the tile's slice of `buckets` by triangle content ([`triangle_content_cmp`]), then
/// hashes the layout, the triangle count and the triangles in that order. Equal keys rasterize to equal heightfields.
pub fn tile_key(grid: &BinGrid, id: &NavTile, tile: &NavTileHeightfield, triangles: &[TriangleData], buckets: &mut [i32]) -> u64 {
    let slice = &mut buckets[tile.triangle_start as usize..(tile.triangle_start + tile.triangle_count) as usize];
    // Content order; ties are the same triangle twice, so their order can't matter (the sort is stable anyway).
    slice.sort_by(|&x, &y| triangle_content_cmp(&triangles[x as usize], &triangles[y as usize]));

    let mut h = hash_bytes(&tile_layout_bytes(grid, id, tile), TILE_KEY_SEED);
    h = hash_value(slice.len() as i32, h);
    for &t in slice.iter() {
        h = hash_value(triangles[t as usize], h);
    }
    h
}

/// `TileKeyJob` over every tile (`tiles[i]` = its `NavTile` and heightfield descriptor, in tile-index order): sorts
/// each tile's bucket slice by content in place and returns the tile keys.
pub fn tile_keys(grids: &[BinGrid], tiles: &[(NavTile, NavTileHeightfield)], triangles: &[TriangleData], buckets: &mut [i32]) -> Vec<u64> {
    tiles.iter().map(|(id, hf)| tile_key(&grids[id.grid as usize], id, hf, triangles, buckets)).collect()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::bins::{OrientationBinSet, OrientationConfig, SurfaceRing};
    use nav_math::math::Float3x3;
    use nav_recast::FFBounds;

    fn setup() -> (Vec<crate::bins::Bin>, BinSetMetadata) {
        let cfg = OrientationConfig::DEFAULT;
        let set = OrientationBinSet::create(&cfg, &[SurfaceRing::DEFAULT]).unwrap();
        let bins = set.bake_bins(Float3::new(-10.0, -10.0, -10.0), Float3::new(10.0, 10.0, 10.0));
        (bins, BinSetMetadata::new(&set, &cfg))
    }

    fn tri(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> InputTriangle {
        InputTriangle::new(Float3::new(a[0], a[1], a[2]), Float3::new(b[0], b[1], b[2]), Float3::new(c[0], c[1], c[2]), 1, 1)
    }

    #[test]
    fn floor_wall_and_ceiling_land_in_their_bins() {
        let (bins, meta) = setup();
        // Winding so normals are +y, wall (+x facing) and -y.
        let floor = tri([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]);
        let ceiling = tri([0.0, 3.0, 0.0], [1.0, 3.0, 0.0], [0.0, 3.0, 1.0]);
        let wall = tri([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]); // normal: cross((0,1,0),(0,0,1)) = +x
        assert!((floor.normal.value.y - 1.0).abs() < 1e-6);
        assert!((ceiling.normal.value.y + 1.0).abs() < 1e-6);
        assert!((wall.normal.value.x - 1.0).abs() < 1e-6);

        let out = classify(&bins, &meta, &[floor, wall, ceiling]);
        assert_eq!(out[0].bin, 0);
        assert_eq!(out[2].bin, meta.ceiling_bin);
        assert!(out[1].bin >= meta.first_side_bin && out[1].bin < meta.first_side_bin + meta.side_bin_count);
        // The side bin facing +x has n.x ~ 1.
        assert!(bins[out[1].bin as usize].n.x > 0.99);
        // All three are within their bin's coverage and the default max surface angle (180).
        assert!(out.iter().all(|t| t.walkable_for == 1 && t.area == 1));
    }

    #[test]
    fn degenerate_and_too_steep_triangles_are_solid() {
        let (bins, meta) = setup();
        let degenerate = tri([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]);
        assert!(degenerate.normal.is_degenerate);
        // A floors-and-walls config: ceilings are beyond the max surface angle.
        let cfg = OrientationConfig { max_surface_deg: 92.0, ..OrientationConfig::DEFAULT };
        let set = OrientationBinSet::create(&cfg, &[SurfaceRing::DEFAULT]).unwrap();
        let bins2 = set.bake_bins(Float3::splat(-10.0), Float3::splat(10.0));
        let meta2 = BinSetMetadata::new(&set, &cfg);
        let ceiling = tri([0.0, 3.0, 0.0], [1.0, 3.0, 0.0], [0.0, 3.0, 1.0]);
        let out = classify(&bins2, &meta2, &[degenerate, ceiling]);
        assert_eq!(out[0].walkable_for, 0);
        assert_eq!(out[1].walkable_for, 0); // -y normal fails nrm.y >= max_surface_cos
        let _ = (bins, meta);
    }

    #[test]
    fn profile_mask_defaults_to_every_profile() {
        assert_eq!(compute_profile_mask(&[], &[], &[], 3), 0b111);
        let mut a = BakeProfile::test_profile(false, false, false, 7);
        a.id = Hash128::new(7, 0, 0, 0);
        assert_eq!(compute_profile_mask(&[a.id], &[a], &[2], 3), 0b100);
    }

    fn grid(width: i32, height: i32, tile_size: i32, first_tile: i32) -> BinGrid {
        let cs = 1.0;
        BinGrid {
            tier: 0,
            bin: 0,
            active: true,
            cs,
            ch: 0.5,
            bounds: FFBounds { center: Float3::default(), min: Float3::new(0.0, 0.0, 0.0), max: Float3::new(width as f32, 4.0, height as f32) },
            world_to_local: Float3x3::IDENTITY,
            width,
            height,
            depth: 8,
            tier_mask: 1,
            flag_merge_threshold: 1,
            tile_size,
            border: 2,
            tiles_x: (width + tile_size - 1) / tile_size,
            tiles_z: (height + tile_size - 1) / tile_size,
            first_tile,
            ..BinGrid::default()
        }
    }

    fn scattered(n: usize) -> Vec<TriangleData> {
        // A deterministic scatter of floor triangles over a 16 x 16 grid, with a duplicate or two.
        let mut v = Vec::new();
        let mut s = 12345u32;
        let mut next = move || {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            (s >> 8) as f32 / (1u32 << 24) as f32
        };
        for _ in 0..n {
            let (x, z) = (next() * 15.0, next() * 15.0);
            v.push(TriangleData {
                a: Float3::new(x, 0.5, z),
                b: Float3::new(x, 0.5, z + 1.0),
                c: Float3::new(x + 1.0, 0.5, z),
                bin: 0,
                walkable_for: 1,
                area: 1,
            });
        }
        v.push(v[0]);
        v
    }

    fn tiles_for(g: &BinGrid, buckets: &TileBuckets) -> Vec<(NavTile, NavTileHeightfield)> {
        let mut out = Vec::new();
        for z in 0..g.tiles_z {
            for x in 0..g.tiles_x {
                let index = (g.first_tile + x + z * g.tiles_x) as usize;
                out.push((
                    NavTile { grid: 0, x, z },
                    NavTileHeightfield {
                        width: g.tile_size + 2 * g.border,
                        height: g.tile_size + 2 * g.border,
                        border: g.border,
                        origin_x: x * g.tile_size - g.border,
                        origin_z: z * g.tile_size - g.border,
                        triangle_start: buckets.starts[index],
                        triangle_count: buckets.counts[index],
                        ..NavTileHeightfield::default()
                    },
                ));
            }
        }
        out
    }

    #[test]
    fn tile_range_pads_and_clips() {
        let g = grid(16, 16, 8, 0);
        let r = tile_range(&g, Float3::new(1.0, 0.0, 1.0), Float3::new(2.0, 0.0, 1.0), Float3::new(1.0, 0.0, 2.0)).unwrap();
        // Columns 0..3 plus border 2 reach tile 0 only on the low side, tile 0 on the high side (3 + 2 = 5 < 8).
        assert_eq!((r.x, r.y, r.z, r.w), (0, 0, 0, 0));
        // Near the tile seam both tiles are touched (7 + 1 + 2 = 10 >= 8).
        let r = tile_range(&g, Float3::new(7.0, 0.0, 1.0), Float3::new(7.5, 0.0, 1.0), Float3::new(7.0, 0.0, 1.5)).unwrap();
        assert_eq!((r.x, r.z), (0, 1));
        // Outside the bounds.
        assert!(tile_range(&g, Float3::new(50.0, 0.0, 1.0), Float3::new(51.0, 0.0, 1.0), Float3::new(50.0, 0.0, 2.0)).is_none());
    }

    #[test]
    fn bucketing_is_deterministic_and_input_order_independent() {
        let g = grid(16, 16, 8, 0);
        let tris = scattered(60);
        let tile_count = g.tile_count();

        let mut b1 = bucket_triangles(&[g], &tris, tile_count);
        assert_eq!(b1, bucket_triangles(&[g], &tris, tile_count), "repeated bucketing differs");
        let tiles = tiles_for(&g, &b1);
        let k1 = tile_keys(&[g], &tiles, &tris, &mut b1.buckets);

        // Shuffle the input (a fixed permutation) and bucket again.
        let n = tris.len();
        let perm: Vec<usize> = (0..n).map(|i| (i * 37 + 11) % n).collect();
        assert_eq!({ let mut s = perm.clone(); s.sort(); s }, (0..n).collect::<Vec<_>>());
        let shuffled: Vec<TriangleData> = perm.iter().map(|&i| tris[i]).collect();
        let mut b2 = bucket_triangles(&[g], &shuffled, tile_count);
        let tiles2 = tiles_for(&g, &b2);
        let k2 = tile_keys(&[g], &tiles2, &shuffled, &mut b2.buckets);

        assert_eq!(b1.counts, b2.counts);
        assert_eq!(k1, k2, "tile keys depend on input order");
        for t in 0..tile_count as usize {
            let a: Vec<TriangleData> = b1.slice(t).iter().map(|&i| tris[i as usize]).collect();
            let b: Vec<TriangleData> = b2.slice(t).iter().map(|&i| shuffled[i as usize]).collect();
            assert_eq!(a, b, "tile {t} slice differs after the content sort");
            assert!(a.windows(2).all(|w| triangle_content_cmp(&w[0], &w[1]) != std::cmp::Ordering::Greater));
        }
        // Every triangle lands somewhere.
        assert!(b1.counts.iter().sum::<i32>() as usize >= tris.len());
    }

    #[test]
    fn tile_key_changes_with_content() {
        let g = grid(8, 8, 8, 0);
        let mut tris = scattered(5);
        let mut b = bucket_triangles(&[g], &tris, 1);
        let tiles = tiles_for(&g, &b);
        let k = tile_keys(&[g], &tiles, &tris, &mut b.buckets);
        tris[0].area = 9;
        let mut b = bucket_triangles(&[g], &tris, 1);
        let tiles = tiles_for(&g, &b);
        assert_ne!(k, tile_keys(&[g], &tiles, &tris, &mut b.buckets));
    }
}
