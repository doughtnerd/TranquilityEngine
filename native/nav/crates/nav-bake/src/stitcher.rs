//! The stitcher (Foxfire `Tiles/NavMeshStitcher.cs`, plus the stitch half of `Authoring/Baking/Jobs/StitchProfileJob.cs`):
//! every bin's tile poly meshes become one world-space navmesh with internal, seam, fold and jump links.
//!
//! Stages, as in `NavMeshStitcher.Stitch`:
//! 1. Convert every mesh to world space (polys, verts, detail), internal links from Recast neighbours, boundary edges
//!    (folds and jumps), tile-edge portal edges (seams) and chunk-face seam edges (`convert_meshes`).
//!    Seam links between neighbouring tiles of the same bin (`link_tile_seams`), and ledge edges where a tile edge has a
//!    tile across but nothing matching (`add_tile_ledge_edges`).
//! 2. A spatial hash of boundary edges, 3. fold candidates from the 27-cell neighbourhood (`try_match`, clearance),
//!    4. jump links (`generate_jump_links`), 5. flatten into the blob (`output::build_nav_mesh_data`).
//!
//! Determinism: every ordering is the C#'s. Foxfire's `NativeParallelMultiHashMap` visits a key's values newest first, so
//! [`MultiMap`] does too (it decides the order of fold links within a poly and of jump candidates). Jump links come out
//! in boundary-edge order; [`JumpLinkRecord::edge_order`] re-sorts chunked (parallel) results to that order.
//!
//! Inputs: [`BinPolyMesh`] per (profile, tile) and the bins, or a whole [`StitchInput`] for one profile
//! ([`stitch_profile`], `StitchProfileJob.Execute`).
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use nav_format::{
    NavAreaInfo, NavChunkFace, NavGates, NavLink, NavLinkKind, NavMeshData, NavPoly, NavSeamEdge, NavTileRange,
    OrientationBin,
};
use nav_math::{exact, math, Double2, Double3, Float3, Int2, Int3};
use nav_recast::{RcPolyMesh, RcPolyMeshDetail};

use crate::bins::{Bin, OrientationBinExt};
pub use crate::clearance::{FoldCandidate, FoldClearance, JumpClearance, NoFoldClearance, NoJumpClearance};
use crate::output::{build_nav_mesh_data, LinkRec, StitchedMesh};
use crate::settings::BakeProfile;
use crate::types::{timestamp, BinGrid, ProfileTileTask};

// =====================================================================================================================
// Bake-time inputs / settings
// =====================================================================================================================

/// `ChunkFaces`: where a ground-bin mesh's grid meets the Chunk Bounds side faces (see `BinGrid::faces`). The grid
/// starts at the box's corner, so column 0 is on the low faces; column `columns` lies within half a voxel of the high
/// faces. The stitcher moves vertices on those columns onto the faces exactly, so two chunks sharing a face put their
/// edges on the same line, and turns the polygon edges there into seam edges.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChunkFaces {
    pub enabled: bool,
    /// The grid's width and height in columns.
    pub columns: Int2,
    /// The box's world x and z.
    pub box_min: [f32; 2],
    pub box_max: [f32; 2],
}

/// `BinPolyMesh`: one tile's poly mesh of one bin, in the bin's local frame, as `BuildPolyMesh` produced it.
#[derive(Clone, Debug, Default)]
pub struct BinPolyMesh {
    pub bin: i32,
    pub mesh: RcPolyMesh,
    /// Tiled meshes: the bin-grid column (x, z) of the mesh's voxel (0, 0), i.e. of the tile's interior. Tile-edge
    /// (portal) edges are matched across seams in these integer coordinates.
    pub origin: Int2,
    /// Built from `mesh` with `BuildPolyMeshDetail` (submesh i == poly i), still in the bin's local frame. `None`
    /// skips it; queries then fall back to the polygon plane.
    pub detail: Option<RcPolyMeshDetail>,
    /// For a ground-bin mesh of a chunk with bounds.
    pub faces: ChunkFaces,
}

/// `StitchSettings`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StitchSettings {
    /// Max distance between matching boundary edges (world units).
    pub gap_tolerance: f32,
    /// Max angle between matching edges.
    pub parallel_tolerance_deg: f32,
    /// Reject overlaps shorter than this.
    pub min_portal_width: f32,
    /// Must be >= `gap_tolerance`.
    pub hash_cell_size: f32,
    /// Radians; folds whose `nav_fold_delta` is larger aren't linked.
    pub max_fold_angle: f32,
    /// Subtracted from detail vertices along the bin normal before rotating to world space: `ch` if the detail mesh
    /// still has Recast's "orig.y + ch" offset, 0 if removed.
    pub detail_height_offset: f32,
    /// Max height difference (along the bin normal) between two tiles' edges for a seam link. Keep it below the agent
    /// height: surfaces stacked above each other in one bin must not be linked. The agent's step height is a good value.
    pub seam_height_tolerance: f32,
}

impl StitchSettings {
    /// `StitchSettings.FromAgent`. Erosion leaves each side of a 90 degree fold about one agent radius from the corner,
    /// so the edges are roughly 1.41 * radius apart; voxel rounding and contour simplification add a few cells.
    pub fn from_agent(agent_radius: f32, cs: f32, ch: f32, max_simplification_error_voxels: f32) -> Self {
        let gap = 1.5 * agent_radius + 2.0 * cs + 2.0 * ch + max_simplification_error_voxels * cs;
        Self {
            gap_tolerance: gap,
            parallel_tolerance_deg: 15.0,
            min_portal_width: 2.0 * cs,
            hash_cell_size: math::max(gap, 0.25),
            max_fold_angle: 0.5 * math::PI, // every fold
            detail_height_offset: ch,
            seam_height_tolerance: ch,
        }
    }
}

/// `NavFold.Delta`: how sharp a fold is, 0-pi/2 radians: `min(angle, pi - angle)`.
pub fn nav_fold_delta(fold_angle: f32) -> f32 {
    math::min(fold_angle, math::PI - fold_angle)
}

/// `JumpSettings`: bake-time jump link generation. These limits are upper bounds: links are baked for the most capable
/// agent, and each agent's own limits filter them at query time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JumpSettings {
    pub enabled: bool,
    pub max_jump_up_height: f32,
    /// Horizontal, world units.
    pub max_jump_distance: f32,
    pub max_fall_distance: f32,
    /// Only polys within this of world up can take off / land (e.g. 45).
    pub max_surface_tilt_deg: f32,
    /// Take-off samples along each boundary edge (e.g. 2 * cs).
    pub sample_spacing: f32,
    /// Horizontal step when searching for a landing (e.g. cs).
    pub probe_step: f32,
    /// A landing closer than this...
    pub min_jump_gap: f32,
    /// ...and with less rise/drop than this is a step, not a jump.
    pub min_jump_rise: f32,
    /// Apex clearance above the higher end; keep equal to the agent's jump arc height.
    pub arc_height: f32,
}

impl JumpSettings {
    /// `JumpSettings.Default`.
    pub fn default_for(cs: f32, ch: f32, walkable_climb: i32) -> Self {
        Self {
            enabled: true,
            max_jump_up_height: 200.0,
            max_jump_distance: 300.0,
            max_fall_distance: 400.0,
            max_surface_tilt_deg: 45.0,
            sample_spacing: 2.0 * cs,
            probe_step: cs,
            min_jump_gap: 2.0 * cs,
            min_jump_rise: walkable_climb as f32 * ch,
            arc_height: 30.0,
        }
    }
}

/// `JumpLinkRecord`: a jump link computed ahead of stitching (`generate_jump_links_for_edge_range`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct JumpLinkRecord {
    /// Source poly, in the stitched mesh's poly numbering.
    pub from: i32,
    pub link: NavLink,
    /// Boundary edge it takes off from.
    pub edge: i32,
    /// Order among that edge's links.
    pub seq: i32,
}

impl JumpLinkRecord {
    /// `JumpLinkRecord.EdgeOrder`: stitch's own order, by edge, then the order the edge produced them. Chunks' outputs,
    /// concatenated in any order and sorted with this, equal what `stitch` generates itself.
    pub fn edge_order(a: &JumpLinkRecord, b: &JumpLinkRecord) -> Ordering {
        if a.edge != b.edge {
            a.edge.cmp(&b.edge)
        } else {
            a.seq.cmp(&b.seq)
        }
    }
}

/// `StitchStats`. Tick fields are `types::timestamp` nanoseconds (0 on wasm), diagnostics only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StitchStats {
    pub polys: i32,
    /// Directed.
    pub internal_links: i32,
    /// Directed, between polys in neighbouring tiles of the same bin.
    pub seam_links: i32,
    /// Edge pairs that passed geometry tests.
    pub fold_candidates: i32,
    /// Directed, after clearance.
    pub fold_links: i32,
    pub boundary_edges: i32,
    /// Directed (a jump up and the drop back are two links).
    pub jump_links: i32,
    /// Polygon edges on the Chunk Bounds side faces.
    pub seam_edges: i32,
    pub convert_ticks: u64,
    pub seam_ticks: u64,
    pub edge_hash_ticks: u64,
    pub fold_ticks: u64,
    pub jump_ticks: u64,
    pub blob_ticks: u64,
}

// =====================================================================================================================
// Internal records
// =====================================================================================================================

const RC_MESH_NULL_IDX: i32 = 0xffff;

#[derive(Clone, Copy, Debug, Default)]
struct BoundaryEdge {
    poly: i32,
    bin: i32,
    a: Float3,
    b: Float3,
    /// Into the edge-cell list.
    cell_start: usize,
    cell_count: usize,
}

/// A polygon edge on its tile's edge (Recast portal flag `0x8000 | side`). Side 0/2 = low/high x, 1/3 = high/low z.
/// `plane` and `t0`/`t1` are bin-grid voxel indices: the edge's plane, and its endpoints along the seam.
#[derive(Clone, Copy, Debug, Default)]
struct PortalEdge {
    poly: i32,
    bin: i32,
    side: i32,
    plane: i32,
    t0: i32,
    t1: i32,
    /// Bin-local positions of the endpoints.
    a: Float3,
    b: Float3,
}

/// A hash multimap whose per-key iteration is newest first, like `NativeParallelMultiHashMap`'s
/// `TryGetFirstValue` / `TryGetNextValue` (new entries go to the head of their bucket's chain).
struct MultiMap<K: Hash + Eq> {
    map: HashMap<K, Vec<i32>>,
}

impl<K: Hash + Eq> MultiMap<K> {
    fn new() -> Self {
        Self { map: HashMap::new() }
    }
    fn add(&mut self, key: K, value: i32) {
        self.map.entry(key).or_default().push(value);
    }
    /// The key's values, most recently added first.
    fn get(&self, key: &K) -> impl Iterator<Item = i32> + '_ {
        self.map.get(key).into_iter().flat_map(|v| v.iter().rev().copied())
    }
}

/// Everything step 1 produces (`ConvertMeshes`' output lists).
#[derive(Default)]
struct Converted {
    verts: Vec<Float3>,
    poly_verts: Vec<i32>,
    polys: Vec<NavPoly>,
    link_recs: Vec<LinkRec>,
    edges: Vec<BoundaryEdge>,
    portals: Vec<PortalEdge>,
    seams: Vec<NavSeamEdge>,
    tile_ranges: Vec<NavTileRange>,
    detail_verts: Vec<Float3>,
    detail_tris: Vec<nav_math::Int4>,
}

// =====================================================================================================================
// Stitch
// =====================================================================================================================

/// `NavMeshStitcher.Stitch`: the world-space navmesh from every bin's poly mesh (and optional detail mesh).
///
/// `adjacency[bin]` has bit j set if surfaces in bins `bin` and j may fold. `precomputed_jumps` (from
/// [`generate_jump_links_for_edge_range`], sorted with [`JumpLinkRecord::edge_order`]) replaces generating jump links
/// here, even if empty. `areas` is the table the blob carries (`None` = empty: every area costs 1).
#[allow(clippy::too_many_arguments)]
pub fn stitch<C: FoldClearance, J: JumpClearance>(
    meshes: &[BinPolyMesh],
    bins: &[OrientationBin],
    adjacency: &[u64],
    settings: &StitchSettings,
    clearance: &C,
    jump: &JumpSettings,
    jump_clearance: &J,
    precomputed_jumps: Option<&[JumpLinkRecord]>,
    areas: Option<&[NavAreaInfo]>,
) -> (NavMeshData, StitchStats) {
    let refs: Vec<&BinPolyMesh> = meshes.iter().collect();
    stitch_refs(&refs, bins, adjacency, settings, clearance, jump, jump_clearance, precomputed_jumps, areas)
}

/// [`stitch`] over borrowed meshes (what [`StitchInput`] gathers: the profile's meshes, in task order).
#[allow(clippy::too_many_arguments)]
pub fn stitch_refs<C: FoldClearance, J: JumpClearance>(
    meshes: &[&BinPolyMesh],
    bins: &[OrientationBin],
    adjacency: &[u64],
    settings: &StitchSettings,
    clearance: &C,
    jump: &JumpSettings,
    jump_clearance: &J,
    precomputed_jumps: Option<&[JumpLinkRecord]>,
    areas: Option<&[NavAreaInfo]>,
) -> (NavMeshData, StitchStats) {
    let mut stats = StitchStats::default();
    let mut t = timestamp();

    // 1) Convert every bin's poly mesh to world space; internal links from Recast neighbours.
    let mut c = Converted::default();
    convert_meshes(meshes, bins, settings, &mut c, &mut stats);
    stats.polys = c.polys.len() as i32;
    stats.boundary_edges = c.edges.len() as i32;
    stats.seam_edges = c.seams.len() as i32;
    stats.convert_ticks = lap(&mut t);

    // 1b) Seam links between neighbouring tiles of the same bin.
    let mut open_edges: Vec<NavSeamEdge> = Vec::with_capacity(16);
    stats.seam_links = link_tile_seams(&c.portals, bins, settings.seam_height_tolerance, &mut c.link_recs, &mut open_edges);
    c.portals = Vec::new();
    stats.seam_ticks = lap(&mut t);

    // 2) Spatial hash of boundary edges (cells touched by samples along each edge). A straight line never revisits a
    //    cell, so only consecutive duplicates need removing.
    let cell = math::max(settings.hash_cell_size, settings.gap_tolerance);
    let mut grid: MultiMap<(i32, i32, i32)> = MultiMap::new();
    let mut edge_cells: Vec<Int3> = Vec::with_capacity(1024);
    for e in 0..c.edges.len() {
        let mut edge = c.edges[e];
        let steps = math::max(1, math::ceil(edge.a.distance(edge.b) / (0.5 * cell)) as i32);
        edge.cell_start = edge_cells.len();

        let mut last: Option<Int3> = None;
        for s in 0..=steps {
            let p = edge.a.lerp(edge.b, s as f32 / steps as f32) / cell;
            let cc = Int3::new(math::floor(p.x) as i32, math::floor(p.y) as i32, math::floor(p.z) as i32);
            if last == Some(cc) {
                continue;
            }
            edge_cells.push(cc);
            grid.add((cc.x, cc.y, cc.z), e as i32);
            last = Some(cc);
        }

        edge.cell_count = edge_cells.len() - edge.cell_start;
        c.edges[e] = edge;
    }
    stats.edge_hash_ticks = lap(&mut t);

    // 3) Test candidate pairs from the 27-cell neighbourhood (covers anything within one cell >= gap).
    let cos_par = exact::cos(exact::radians(settings.parallel_tolerance_deg));
    let mut tested: HashSet<i64> = HashSet::with_capacity(c.edges.len() * 4);
    for i in 0..c.edges.len() {
        let ei = c.edges[i];
        let adj = adjacency[ei.bin as usize];

        for ci in 0..ei.cell_count {
            let cc = edge_cells[ei.cell_start + ci];
            for dz in -1..=1 {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let key = (cc.x + dx, cc.y + dy, cc.z + dz);
                        for j in grid.get(&key) {
                            if j as usize <= i {
                                continue;
                            }
                            let ej = c.edges[j as usize];
                            if ej.bin == ei.bin {
                                continue; // same bin: not a fold
                            }
                            if (adj & (1u64 << ej.bin)) == 0 {
                                continue; // these bins' surfaces never fold this little
                            }
                            if !tested.insert(((i as i64) << 32) | (j as u32 as i64)) {
                                continue;
                            }

                            let Some(cand) =
                                try_match(&ei, &ej, &c.polys[ei.poly as usize], &c.polys[ej.poly as usize], settings, cos_par)
                            else {
                                continue;
                            };
                            if nav_fold_delta(cand.fold_angle) > settings.max_fold_angle {
                                continue; // MaxFoldDeg rule
                            }

                            stats.fold_candidates += 1;
                            if !clearance.is_clear(&cand) {
                                continue;
                            }

                            let convex = cand.convex as u8;
                            let mut hinge_a = Float3::default();
                            let mut hinge_b = Float3::default();
                            if cand.convex {
                                let pa = &c.polys[ei.poly as usize];
                                let pb = &c.polys[ej.poly as usize];
                                let edge = exact::normalize(cand.portal_b - cand.portal_a);
                                if stacked(cand.portal_a, cand.dest_a, pa, pb, edge) {
                                    continue;
                                }
                                hinge_a = fold_hinge(cand.portal_a, cand.dest_a, pa, pb, edge, settings.gap_tolerance);
                                hinge_b = fold_hinge(cand.portal_b, cand.dest_b, pa, pb, edge, settings.gap_tolerance);
                            }

                            c.link_recs.push(LinkRec {
                                from: ei.poly,
                                link: NavLink {
                                    to_poly: ej.poly,
                                    kind: NavLinkKind::FOLD,
                                    convex,
                                    fold_angle: cand.fold_angle,
                                    portal_a: cand.portal_a,
                                    portal_b: cand.portal_b,
                                    dest_a: cand.dest_a,
                                    dest_b: cand.dest_b,
                                    hinge_a,
                                    hinge_b,
                                    ..NavLink::default()
                                },
                            });
                            c.link_recs.push(LinkRec {
                                from: ej.poly,
                                link: NavLink {
                                    to_poly: ei.poly,
                                    kind: NavLinkKind::FOLD,
                                    convex,
                                    fold_angle: cand.fold_angle,
                                    portal_a: cand.dest_a,
                                    portal_b: cand.dest_b,
                                    dest_a: cand.portal_a,
                                    dest_b: cand.portal_b,
                                    hinge_a,
                                    hinge_b,
                                    ..NavLink::default()
                                },
                            });
                            stats.fold_links += 2;
                        }
                    }
                }
            }
        }
    }
    stats.fold_ticks = lap(&mut t);

    // 4) Jump links between up-facing polygons: precomputed in parallel by the caller, or generated here.
    if let Some(pre) = precomputed_jumps {
        for r in pre {
            c.link_recs.push(LinkRec { from: r.from, link: r.link });
        }
        stats.jump_links = pre.len() as i32;
    } else if jump.enabled {
        stats.jump_links = generate_jump_links(
            &c.verts,
            &c.poly_verts,
            &c.polys,
            &c.edges,
            jump,
            jump_clearance,
            &mut c.link_recs,
            0,
            c.edges.len(),
            1,
            None,
        );
    }
    stats.jump_ticks = lap(&mut t);

    // 5) Flatten into a blob.
    let nav = build_nav_mesh_data(
        StitchedMesh {
            verts: c.verts,
            poly_verts: c.poly_verts,
            polys: c.polys,
            link_recs: c.link_recs,
            detail_verts: c.detail_verts,
            detail_tris: c.detail_tris,
            seams: c.seams,
            tile_ranges: c.tile_ranges,
            open_edges,
        },
        bins,
        adjacency,
        areas,
        settings.seam_height_tolerance,
    );
    stats.blob_ticks = lap(&mut t);
    (nav, stats)
}

/// Nanoseconds since `*t`, then resets `t` to now.
fn lap(t: &mut u64) -> u64 {
    let now = timestamp();
    let elapsed = now.saturating_sub(*t);
    *t = now;
    elapsed
}

/// `NavMeshStitcher.GenerateJumpLinksForEdgeRange`: jump links for one chunk of the boundary edges `stitch` would see
/// for these meshes: chunk c of `chunk_count` covers edges c, c + chunk_count, c + 2 * chunk_count, ... It rebuilds the
/// polys and edges with the same deterministic conversion, so chunks can run in parallel. All chunks' outputs, sorted
/// with [`JumpLinkRecord::edge_order`], equal what `stitch` generates itself; pass that as `precomputed_jumps`.
pub fn generate_jump_links_for_edge_range<J: JumpClearance>(
    meshes: &[&BinPolyMesh],
    bins: &[OrientationBin],
    settings: &StitchSettings,
    jump: &JumpSettings,
    jump_clearance: &J,
    chunk: i32,
    chunk_count: i32,
) -> Vec<JumpLinkRecord> {
    let mut output = Vec::new();
    if !jump.enabled {
        return output;
    }
    let mut c = Converted::default();
    let mut stats = StitchStats::default();
    convert_meshes(meshes, bins, settings, &mut c, &mut stats);

    // Edges dealt round-robin: neighbouring edges come from the same tile and poly and cost about the same, so
    // contiguous ranges would put the expensive ones in a few chunks.
    c.link_recs.clear(); // only this chunk's jump links from here on
    let mut link_edges: Vec<i32> = Vec::with_capacity(64);
    generate_jump_links(
        &c.verts,
        &c.poly_verts,
        &c.polys,
        &c.edges,
        jump,
        jump_clearance,
        &mut c.link_recs,
        chunk as usize,
        c.edges.len(),
        chunk_count as usize,
        Some(&mut link_edges),
    );

    // An edge's links are contiguous; `seq` keeps their order when the caller sorts by edge.
    let mut seq = 0;
    for i in 0..c.link_recs.len() {
        seq = if i > 0 && link_edges[i] == link_edges[i - 1] { seq + 1 } else { 0 };
        output.push(JumpLinkRecord { from: c.link_recs[i].from, link: c.link_recs[i].link, edge: link_edges[i], seq });
    }
    output
}

// =====================================================================================================================
// Step 1: world space
// =====================================================================================================================

/// Step 1 of stitching: every bin's poly mesh to world space (polys, verts, detail), internal links from Recast
/// neighbours, boundary edges for folds and jumps, and tile-edge portal edges for seams. Deterministic, so separate
/// callers (`stitch`, the jump-link chunks) get the same poly and edge numbering.
fn convert_meshes(
    meshes: &[&BinPolyMesh],
    bins: &[OrientationBin],
    settings: &StitchSettings,
    out: &mut Converted,
    stats: &mut StitchStats,
) {
    for bm in meshes {
        let bin = &bins[bm.bin as usize];
        let m = &bm.mesh;
        let to_world = bin.local_to_world();
        let vert_base = out.verts.len() as i32;
        let poly_base = out.polys.len() as i32;

        let faces = &bm.faces;
        if faces.enabled {
            // A ground tile of a chunk with bounds: overlays switch tiles off by these ranges.
            out.tile_ranges.push(NavTileRange { origin: bm.origin, poly_start: poly_base, poly_count: m.npolys });
        }
        for i in 0..m.nverts as usize {
            let v = m.verts[i];
            // Same as Detour's dtCreateNavMeshData: y = bmin.y + v.y * ch.
            let local = m.bmin + Float3::new(v.x as f32 * m.cs, v.y as f32 * m.ch, v.z as f32 * m.cs);
            let mut world = to_world.mul_vec(local);
            if faces.enabled {
                world = onto_faces(world, Int2::new(bm.origin.x + v.x, bm.origin.y + v.z), faces);
            }
            out.verts.push(world);
        }

        let nvp = m.nvp as usize;
        for p in 0..m.npolys as usize {
            let p_base = p * nvp * 2;
            let mut nv = 0usize;
            while nv < nvp && m.polys[p_base + nv] != RC_MESH_NULL_IDX {
                nv += 1;
            }
            if nv < 3 {
                out.polys.push(NavPoly::default()); // keep poly indices aligned with the Recast mesh
                continue;
            }

            // Centre and normal in doubles, rounded once: the same bits on every target (see NavExactMath).
            let vert_start = out.poly_verts.len();
            let mut center_sum = Double3::default();
            for j in 0..nv {
                let vi = vert_base + m.polys[p_base + j];
                out.poly_verts.push(vi);
                center_sum += out.verts[vi as usize].to_double();
            }

            let nvd = nv as f64;
            let center =
                Double3::new(center_sum.x / nvd, center_sum.y / nvd, center_sum.z / nvd).to_float();

            let mut normal = newell_normal(&out.verts, &out.poly_verts, vert_start, nv);
            if normal.dot(bin.n) < 0.0 {
                normal = -normal; // agree with the bin, whatever the winding
            }

            // Detail submesh p belongs to poly p. Convert its verts from the bin frame to world space.
            let d_vert_start = out.detail_verts.len() as i32;
            let d_tri_start = out.detail_tris.len() as i32;
            let (mut d_vert_count, mut d_tri_count) = (0, 0);
            if let Some(d) = &bm.detail {
                if p < d.nmeshes() {
                    let sub = d.meshes[p]; // (baseVert, vertCount, baseTri, triCount)
                    for k in 0..sub.y {
                        let mut local = d.verts[(sub.x + k) as usize];
                        local.y -= settings.detail_height_offset;
                        let mut world = to_world.mul_vec(local);
                        if faces.enabled {
                            world = detail_onto_faces(world, m.cs, faces);
                        }
                        out.detail_verts.push(world);
                    }
                    for k in 0..sub.w {
                        out.detail_tris.push(d.tris[(sub.z + k) as usize]); // indices stay relative to the submesh
                    }
                    d_vert_count = sub.y;
                    d_tri_count = sub.w;
                }
            }

            let this = poly_base + p as i32;
            out.polys.push(NavPoly {
                vert_start: vert_start as i32,
                vert_count: nv as i32,
                bin: bm.bin,
                // The bake packs a gate index above the area id (see NavGates).
                area: m.areas[p] & NavGates::AREA_MASK,
                gate: m.areas[p] >> NavGates::SHIFT,
                flags: m.flags[p],
                center,
                normal,
                detail_vert_start: d_vert_start,
                detail_vert_count: d_vert_count,
                detail_tri_start: d_tri_start,
                detail_tri_count: d_tri_count,
                ..NavPoly::default()
            });

            for j in 0..nv {
                let a = out.verts[out.poly_verts[vert_start + j] as usize];
                let b = out.verts[out.poly_verts[vert_start + (j + 1) % nv] as usize];
                let nei = m.polys[p_base + nvp + j]; // neighbour across edge (j, j+1)

                if (nei & 0x8000) == 0 {
                    // A real neighbour (0xffff and 0x8000|dir portals have this bit).
                    out.link_recs.push(LinkRec {
                        from: this,
                        link: NavLink {
                            to_poly: poly_base + nei,
                            kind: NavLinkKind::INTERNAL,
                            portal_a: a,
                            portal_b: b,
                            dest_a: a,
                            dest_b: b,
                            ..NavLink::default()
                        },
                    });
                    stats.internal_links += 1;
                } else if nei != RC_MESH_NULL_IDX {
                    // On the tile's edge: linked to the neighbouring tile below, never a boundary edge (it would
                    // otherwise seed folds and jumps across every tile seam).
                    let side = nei & 0xf;
                    let va = m.verts[m.polys[p_base + j] as usize];
                    let vb = m.verts[m.polys[p_base + (j + 1) % nv] as usize];
                    let x_plane = (side & 1) == 0;
                    let plane = if x_plane { bm.origin.x + va.x } else { bm.origin.y + va.z };
                    if faces.enabled && on_face(side, plane, faces) {
                        // On a Chunk Bounds face: no tile across it, the neighbouring chunk is.
                        out.seams.push(NavSeamEdge { poly: this, face: NavChunkFace(side), a, b });
                        continue;
                    }

                    out.portals.push(PortalEdge {
                        poly: this,
                        bin: bm.bin,
                        side,
                        plane,
                        t0: if x_plane { bm.origin.y + va.z } else { bm.origin.x + va.x },
                        t1: if x_plane { bm.origin.y + vb.z } else { bm.origin.x + vb.x },
                        a: m.bmin + Float3::new(va.x as f32 * m.cs, va.y as f32 * m.ch, va.z as f32 * m.cs),
                        b: m.bmin + Float3::new(vb.x as f32 * m.cs, vb.y as f32 * m.ch, vb.z as f32 * m.cs),
                    });
                } else {
                    out.edges.push(BoundaryEdge { poly: this, bin: bm.bin, a, b, cell_start: 0, cell_count: 0 });
                }
            }
        }
    }

    add_tile_ledge_edges(meshes, bins, &out.portals, settings.seam_height_tolerance, &mut out.edges);
}

fn newell_normal(verts: &[Float3], poly_verts: &[i32], start: usize, count: usize) -> Float3 {
    let mut n = Double3::default(); // in doubles, rounded once (see the poly centre)
    for i in 0..count {
        let a = verts[poly_verts[start + i] as usize].to_double();
        let b = verts[poly_verts[start + (i + 1) % count] as usize].to_double();
        n += Double3::new((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y));
    }
    let len = n.dot(n).sqrt();
    if len > 1e-12 {
        Double3::new(n.x / len, n.y / len, n.z / len).to_float()
    } else {
        Float3::new(0.0, 1.0, 0.0)
    }
}

// ---------------------------------------------------------------------------------------------------------
// Chunk faces
// ---------------------------------------------------------------------------------------------------------

/// Is a portal on side `side` at grid column `plane` on a Chunk Bounds face (the grid's outer edge)?
fn on_face(side: i32, plane: i32, faces: &ChunkFaces) -> bool {
    match side {
        0 => plane == 0,
        1 => plane == faces.columns.y,
        2 => plane == faces.columns.x,
        _ => plane == 0,
    }
}

/// A ground-bin vertex at grid column `column` (x, z), moved onto the faces it lies on.
fn onto_faces(mut world: Float3, column: Int2, faces: &ChunkFaces) -> Float3 {
    if column.x == 0 {
        world.x = faces.box_min[0];
    } else if column.x == faces.columns.x {
        world.x = faces.box_max[0];
    }
    if column.y == 0 {
        world.z = faces.box_min[1];
    } else if column.y == faces.columns.y {
        world.z = faces.box_max[1];
    }
    world
}

/// A ground-bin detail vertex moved onto the faces it lies on, as `onto_faces` moves the polygon vertices. Detail
/// vertices on a face edge sit on its grid line (they're the polygon's vertices and samples along its edges).
fn detail_onto_faces(mut world: Float3, cs: f32, faces: &ChunkFaces) -> Float3 {
    let near = 0.01 * cs;
    let high = [faces.box_min[0] + faces.columns.x as f32 * cs, faces.box_min[1] + faces.columns.y as f32 * cs]; // the high faces' grid lines
    if math::abs(world.x - faces.box_min[0]) <= near {
        world.x = faces.box_min[0];
    } else if math::abs(world.x - high[0]) <= near {
        world.x = faces.box_max[0];
    }
    if math::abs(world.z - faces.box_min[1]) <= near {
        world.z = faces.box_min[1];
    } else if math::abs(world.z - high[1]) <= near {
        world.z = faces.box_max[1];
    }
    world
}

// ---------------------------------------------------------------------------------------------------------
// Tile seams
// ---------------------------------------------------------------------------------------------------------

/// Tile-edge stretches nothing across the seam matches, where there is a tile across: a ledge that happens to end on a
/// tile edge. They become boundary edges, as they would be anywhere else in a tile, so folds and jumps start from them
/// too. Matching is `link_tile_seams`' (same bin and plane, opposite side, heights within tolerance). Stretches with no
/// tile across (an overlay's inner line) stay portals only.
fn add_tile_ledge_edges(
    meshes: &[&BinPolyMesh],
    bins: &[OrientationBin],
    portals: &[PortalEdge],
    height_tolerance: f32,
    edges: &mut Vec<BoundaryEdge>,
) {
    if portals.is_empty() {
        return;
    }

    let mut seams: MultiMap<(i32, i32, i32)> = MultiMap::new();
    for (i, p) in portals.iter().enumerate() {
        seams.add((p.bin, p.side & 1, p.plane), i as i32);
    }

    let mut covered: Vec<Int2> = Vec::with_capacity(8);
    for p in portals {
        let t0 = math::min(p.t0, p.t1);
        let t1 = math::max(p.t0, p.t1);
        if t1 <= t0 {
            continue;
        }

        // The stretches of p that a portal across matches.
        covered.clear();
        for j in seams.get(&(p.bin, p.side & 1, p.plane)) {
            let q = &portals[j as usize];
            if q.side != (p.side ^ 2) || q.poly == p.poly {
                continue;
            }
            let lo = math::max(t0, math::min(q.t0, q.t1));
            let hi = math::min(t1, math::max(q.t0, q.t1));
            if hi <= lo {
                continue;
            }
            if math::abs(point_on_portal(p, lo).y - point_on_portal(q, lo).y) > height_tolerance
                || math::abs(point_on_portal(p, hi).y - point_on_portal(q, hi).y) > height_tolerance
            {
                continue;
            }
            covered.push(Int2::new(lo, hi));
        }

        // Sorted by start (few per portal): the gaps between them are the ledge.
        for a in 1..covered.len() {
            let mut b = a;
            while b > 0 && covered[b].x < covered[b - 1].x {
                covered.swap(b, b - 1);
                b -= 1;
            }
        }

        let mut from = t0;
        for c in 0..=covered.len() {
            let to = if c < covered.len() { covered[c].x } else { t1 };
            if to > from && tile_across(meshes, p, (from + to) / 2) {
                // Along the portal's own direction, so the edge winds as the polygon's other edges do.
                let (e0, e1) = if p.t0 <= p.t1 { (from, to) } else { (to, from) };
                let to_world = bins[p.bin as usize].local_to_world();
                edges.push(BoundaryEdge {
                    poly: p.poly,
                    bin: p.bin,
                    a: to_world.mul_vec(point_on_portal(p, e0)),
                    b: to_world.mul_vec(point_on_portal(p, e1)),
                    cell_start: 0,
                    cell_count: 0,
                });
            }

            if c < covered.len() {
                from = math::max(from, covered[c].y);
            }
        }
    }
}

/// Is there a tile of p's bin across p's seam at seam coordinate `t` (bin-grid columns)?
fn tile_across(meshes: &[&BinPolyMesh], p: &PortalEdge, t: i32) -> bool {
    // The column just across the plane: low sides (0 low x, 3 low z) look below it, high sides at it.
    let across = if p.side == 0 || p.side == 3 { p.plane - 1 } else { p.plane };
    let column = if (p.side & 1) == 0 { Int2::new(across, t) } else { Int2::new(t, across) };
    for bm in meshes {
        if bm.bin != p.bin {
            continue;
        }
        let m = &bm.mesh;
        // The mesh's bounds are its tile's interior (Recast strips the border), `origin` its first column.
        let size = Int2::new(
            math::round((m.bmax.x - m.bmin.x) / m.cs) as i32,
            math::round((m.bmax.z - m.bmin.z) / m.cs) as i32,
        );
        let lo = bm.origin;
        if column.x >= lo.x && column.y >= lo.y && column.x < lo.x + size.x && column.y < lo.y + size.y {
            return true;
        }
    }
    false
}

/// Links portal edges on opposite sides of the same tile seam (same bin, same plane, opposite sides) wherever they
/// overlap along it and sit at the same height, both directions, as internal links. Matching along the seam is exact in
/// voxel indices. Heights are compared at both ends of the overlap (bin-local y): stacked surfaces in one bin cross the
/// same seam at different heights and must stay apart. A small mismatch within the tolerance shows up as
/// portal != dest.
fn link_tile_seams(
    portals: &[PortalEdge],
    bins: &[OrientationBin],
    height_tolerance: f32,
    link_recs: &mut Vec<LinkRec>,
    open_edges: &mut Vec<NavSeamEdge>,
) -> i32 {
    let mut matched = vec![false; portals.len()];
    let mut seams: MultiMap<(i32, i32, i32)> = MultiMap::new();
    for (i, p) in portals.iter().enumerate() {
        seams.add((p.bin, p.side & 1, p.plane), i as i32);
    }

    let mut added = 0;
    for i in 0..portals.len() {
        let p = &portals[i];
        for j in seams.get(&(p.bin, p.side & 1, p.plane)) {
            if j as usize <= i {
                continue; // each pair once
            }
            let q = &portals[j as usize];
            if q.side != (p.side ^ 2) || q.poly == p.poly {
                continue;
            }

            let lo = math::max(math::min(p.t0, p.t1), math::min(q.t0, q.t1));
            let hi = math::min(math::max(p.t0, p.t1), math::max(q.t0, q.t1));
            if hi <= lo {
                continue;
            }

            // Same surface? Different layers (floor vs. the top of an obstacle over it) differ by at least the
            // agent's height here.
            if math::abs(point_on_portal(p, lo).y - point_on_portal(q, lo).y) > height_tolerance
                || math::abs(point_on_portal(p, hi).y - point_on_portal(q, hi).y) > height_tolerance
            {
                continue;
            }

            let to_world = bins[p.bin as usize].local_to_world();
            add_seam_link(p, q, lo, hi, &to_world, link_recs);
            add_seam_link(q, p, lo, hi, &to_world, link_recs);
            added += 2;
            matched[i] = true;
            matched[j as usize] = true;
        }
    }

    // Portals no tile across matched: an overlay's edges on its inner line (where it meets the chunk's interior).
    for (i, p) in portals.iter().enumerate() {
        if matched[i] {
            continue;
        }
        let to_world = bins[p.bin as usize].local_to_world();
        open_edges.push(NavSeamEdge {
            poly: p.poly,
            face: NavChunkFace(p.side),
            a: to_world.mul_vec(p.a),
            b: to_world.mul_vec(p.b),
        });
    }

    added
}

/// Link from `from` to `to` over seam range [lo, hi], with the portal ordered along from's edge.
fn add_seam_link(
    from: &PortalEdge,
    to: &PortalEdge,
    lo: i32,
    hi: i32,
    to_world: &nav_math::math::Float3x3,
    link_recs: &mut Vec<LinkRec>,
) {
    let (s0, s1) = if from.t0 <= from.t1 { (lo, hi) } else { (hi, lo) };
    link_recs.push(LinkRec {
        from: from.poly,
        link: NavLink {
            to_poly: to.poly,
            kind: NavLinkKind::INTERNAL,
            portal_a: to_world.mul_vec(point_on_portal(from, s0)),
            portal_b: to_world.mul_vec(point_on_portal(from, s1)),
            dest_a: to_world.mul_vec(point_on_portal(to, s0)),
            dest_b: to_world.mul_vec(point_on_portal(to, s1)),
            ..NavLink::default()
        },
    });
}

/// Bin-local point on a portal edge at seam coordinate `s` (voxel index along the seam).
fn point_on_portal(e: &PortalEdge, s: i32) -> Float3 {
    // In doubles, rounded once (see NavExactMath).
    let t = if e.t1 == e.t0 { 0.0 } else { (s - e.t0) as f64 / (e.t1 - e.t0) as f64 };
    lerp_d(e.a.to_double(), e.b.to_double(), t).to_float()
}

/// `math.lerp(double3, double3, double)`: `x + s * (y - x)`.
fn lerp_d(x: Double3, y: Double3, s: f64) -> Double3 {
    x + (y - x) * s
}

// =====================================================================================================================
// Jump links
// =====================================================================================================================

#[derive(Clone, Copy)]
struct JumpCandidate {
    to_poly: i32,
    cost: f64,
    /// Doubles until stored (see the jump search).
    from: Double3,
    to: Double3,
}

/// For each boundary edge of an up-facing polygon, samples take-off points along the edge and probes outward
/// (horizontally, away from the polygon) for landing spots on other up-facing polygons within the bake limits. The
/// cheapest clear landing per (edge, destination polygon) becomes a jump link. Jump-ups and drops between the same two
/// polygons come from probing each side, so both directions exist. `link_edges`, if given, gets the boundary edge of
/// each link added.
#[allow(clippy::too_many_arguments)]
fn generate_jump_links<J: JumpClearance>(
    verts: &[Float3],
    poly_verts: &[i32],
    polys: &[NavPoly],
    edges: &[BoundaryEdge],
    jump: &JumpSettings,
    clearance: &J,
    link_recs: &mut Vec<LinkRec>,
    edge_start: usize,
    edge_end: usize,
    edge_stride: usize,
    mut link_edges: Option<&mut Vec<i32>>,
) -> i32 {
    let up_cos = exact::cos(exact::radians(jump.max_surface_tilt_deg));
    let step = math::max(jump.probe_step, 1e-3);

    // XZ grid of up-facing polygons, for landing lookups.
    let cell = math::max(jump.max_jump_distance * 0.25, step * 4.0);
    let mut grid: MultiMap<(i32, i32)> = MultiMap::new();
    for (p, poly) in polys.iter().enumerate() {
        if poly.vert_count < 3 || poly.normal.y < up_cos {
            continue;
        }

        let (mut mn_x, mut mn_z) = (f32::MAX, f32::MAX);
        let (mut mx_x, mut mx_z) = (f32::MIN, f32::MIN);
        for i in 0..poly.vert_count {
            let v = verts[poly_verts[(poly.vert_start + i) as usize] as usize];
            mn_x = math::min(mn_x, v.x);
            mn_z = math::min(mn_z, v.z);
            mx_x = math::max(mx_x, v.x);
            mx_z = math::max(mx_z, v.z);
        }

        let c0 = (math::floor(mn_x / cell) as i32, math::floor(mn_z / cell) as i32);
        let c1 = (math::floor(mx_x / cell) as i32, math::floor(mx_z / cell) as i32);
        for z in c0.1..=c1.1 {
            for x in c0.0..=c1.0 {
                grid.add((x, z), p as i32);
            }
        }
    }

    let mut best: Vec<JumpCandidate> = Vec::with_capacity(8);
    let mut added = 0;

    // The search runs in doubles and rounds once when a link is stored: take-off and landing points, heights and the
    // reach and clearance tests must come out the same on every target (see NavExactMath).
    let mut e = edge_start;
    while e < edge_end {
        let edge = edges[e];
        e += edge_stride;
        let e_index = (e - edge_stride) as i32;
        let src = &polys[edge.poly as usize];
        if src.normal.y < up_cos {
            continue;
        }

        let edge_a = edge.a.to_double();
        let edge_b = edge.b.to_double();
        let ed = Double2::new(edge_b.x - edge_a.x, edge_b.z - edge_a.z);
        let len = (ed.x * ed.x + ed.y * ed.y).sqrt();
        if len < 1e-4 {
            continue;
        }

        // Horizontal outward direction: perpendicular to the edge, away from the polygon.
        let mut outward = Double2::new(ed.y / len, -ed.x / len);
        let mid = Double2::new(0.5 * (edge_a.x + edge_b.x), 0.5 * (edge_a.z + edge_b.z));
        let center = src.center.to_double();
        if outward.x * (mid.x - center.x) + outward.y * (mid.y - center.z) < 0.0 {
            outward = Double2::new(-outward.x, -outward.y);
        }

        best.clear();
        let samples = math::max(1, (len / math::max(jump.sample_spacing, 1e-3) as f64).ceil() as i32);
        let probes = math::floor(jump.max_jump_distance / step) as i32;

        for si in 0..samples {
            let from = lerp_d(edge_a, edge_b, (si as f64 + 0.5) / samples as f64);

            for pi in 1..=probes {
                let dist = pi as f64 * step as f64;
                let probe = Double2::new(from.x + outward.x * dist, from.z + outward.y * dist);
                let key = ((probe.x / cell as f64).floor() as i32, (probe.y / cell as f64).floor() as i32);

                for q in grid.get(&key) {
                    if q == edge.poly {
                        continue;
                    }
                    let dst = &polys[q as usize];
                    if !point_in_poly_xz(verts, poly_verts, dst, probe) {
                        continue;
                    }

                    // Height of the destination polygon's plane at the probe.
                    let dc = dst.center.to_double();
                    let dn = dst.normal.to_double();
                    let y = dc.y - (dn.x * (probe.x - dc.x) + dn.z * (probe.y - dc.z)) / dn.y;
                    let rise = y - from.y;

                    if rise > jump.max_jump_up_height as f64 || -rise > jump.max_fall_distance as f64 {
                        continue;
                    }
                    if dist <= jump.min_jump_gap as f64 && rise.abs() <= jump.min_jump_rise as f64 {
                        continue; // a step, not a jump
                    }

                    let cost = dist + rise.abs();
                    let slot = best.iter().position(|b| b.to_poly == q);

                    if let Some(s) = slot {
                        if best[s].cost <= cost {
                            continue;
                        }
                    }

                    let to = Double3::new(probe.x, y, probe.y);
                    if !clearance.is_clear(from, to, jump.arc_height as f64) {
                        continue;
                    }

                    let cand = JumpCandidate { to_poly: q, cost, from, to };
                    match slot {
                        Some(s) => best[s] = cand,
                        None => best.push(cand),
                    }
                }
            }
        }

        for cnd in &best {
            let dx = cnd.to.x - cnd.from.x;
            let dz = cnd.to.z - cnd.from.z;
            link_recs.push(LinkRec {
                from: edge.poly,
                link: NavLink {
                    to_poly: cnd.to_poly,
                    kind: NavLinkKind::JUMP,
                    portal_a: cnd.from.to_float(),
                    portal_b: cnd.from.to_float(),
                    dest_a: cnd.to.to_float(),
                    dest_b: cnd.to.to_float(),
                    jump_rise: (cnd.to.y - cnd.from.y) as f32,
                    jump_distance: (dx * dx + dz * dz).sqrt() as f32,
                    ..NavLink::default()
                },
            });
            if let Some(le) = link_edges.as_deref_mut() {
                le.push(e_index);
            }
            added += 1;
        }
    }

    added
}

fn point_in_poly_xz(verts: &[Float3], poly_verts: &[i32], poly: &NavPoly, q: Double2) -> bool {
    let (mut any_pos, mut any_neg) = (false, false);
    let n = poly.vert_count;
    for i in 0..n {
        let a = verts[poly_verts[(poly.vert_start + i) as usize] as usize];
        let b = verts[poly_verts[(poly.vert_start + (i + 1) % n) as usize] as usize];
        // `double2 ab = b - a` subtracts the float2s first (in float), then widens; `q - a` is in doubles.
        let ab = Double2::new((b.x - a.x) as f64, (b.z - a.z) as f64);
        let aq = Double2::new(q.x - a.x as f64, q.y - a.z as f64);
        let c = ab.x * aq.y - ab.y * aq.x;
        if c > 1e-6 {
            any_pos = true;
        } else if c < -1e-6 {
            any_neg = true;
        }
        if any_pos && any_neg {
            return false;
        }
    }
    true
}

// =====================================================================================================================
// Folds
// =====================================================================================================================

/// Geometry test for one pair of boundary edges from different bins: nearly parallel, overlapping by at least
/// `min_portal_width`, within `gap_tolerance` along the whole overlap, and arranged like a real fold (each poly on the
/// same side of the other's plane).
fn try_match(
    ei: &BoundaryEdge,
    ej: &BoundaryEdge,
    pa: &NavPoly,
    pb: &NavPoly,
    s: &StitchSettings,
    cos_par: f32,
) -> Option<FoldCandidate> {
    // In doubles, rounded once where stored: every threshold here decides whether a fold exists, and must come out the
    // same on every target (see NavExactMath).
    let ei_a = ei.a.to_double();
    let ej_a = ej.a.to_double();
    let da = ei.b.to_double() - ei_a;
    let la = da.dot(da).sqrt();
    let db = ej.b.to_double() - ej_a;
    let lb = dd_len(db);
    if la < 1e-5 || lb < 1e-5 {
        return None;
    }

    let u = da / la;
    if (u.dot(db / lb)).abs() < cos_par as f64 {
        return None;
    }

    // Project ej onto ei's line and intersect the parameter ranges.
    let s0 = (ej_a - ei_a).dot(u);
    let s1 = (ej.b.to_double() - ei_a).dot(u);
    let lo = math::max(0.0, math::min(s0, s1));
    let hi = math::min(la, math::max(s0, s1));
    if hi - lo < s.min_portal_width as f64 {
        return None;
    }

    // |s1 - s0| >= lb * cosPar > 0, so this division is safe.
    let t_lo = (lo - s0) / (s1 - s0);
    let t_hi = (hi - s0) / (s1 - s0);

    let p_lo_d = ei_a + u * lo;
    let p_hi_d = ei_a + u * hi;
    let q_lo_d = ej_a + db * t_lo;
    let q_hi_d = ej_a + db * t_hi;

    if dist_d(p_lo_d, q_lo_d) > s.gap_tolerance as f64 || dist_d(p_hi_d, q_hi_d) > s.gap_tolerance as f64 {
        return None;
    }

    // Sidedness: at an inside corner each poly lies in front of the other's plane; at an outside corner each lies
    // behind. Mixed signs mean unrelated surfaces (e.g. opposite sides of a thin wall).
    let mid = (p_lo_d + p_hi_d + q_lo_d + q_hi_d) * 0.25;
    let sa = pa.normal.to_double().dot(pb.center.to_double() - mid);
    let sb = pb.normal.to_double().dot(pa.center.to_double() - mid);
    const EPS: f64 = 1e-4;
    let concave = sa > EPS && sb > EPS;
    let convex = sa < -EPS && sb < -EPS;
    if !concave && !convex {
        return None;
    }

    Some(FoldCandidate {
        from_poly: ei.poly,
        to_poly: ej.poly,
        from_bin: ei.bin,
        to_bin: ej.bin,
        portal_a: p_lo_d.to_float(),
        portal_b: p_hi_d.to_float(),
        dest_a: q_lo_d.to_float(),
        dest_b: q_hi_d.to_float(),
        from_normal: pa.normal,
        to_normal: pb.normal,
        from_center: pa.center,
        to_center: pb.center,
        convex,
        fold_angle: exact::acos_d(pa.normal.to_double().dot(pb.normal.to_double())) as f32,
    })
}

fn dd_len(v: Double3) -> f64 {
    v.dot(v).sqrt()
}

/// `math.distance(double3, double3)`.
fn dist_d(a: Double3, b: Double3) -> f64 {
    dd_len(b - a)
}

/// The corner an outside fold pivots around, for the crossing from `p` (on polygon `a`'s edge) to `q` (on `b`'s). In the
/// cross-section across the edge, each surface continues from its edge away from its own polygon; the corner is where
/// those two rays meet. That's only trusted within `reach` (the gap tolerance, which bounds how far the bake let the
/// edges be from the real corner): surfaces that run nearly parallel meet far away or never. Then the route turns
/// around just past both edges instead.
pub fn fold_hinge(p: Float3, q: Float3, a: &NavPoly, b: &NavPoly, edge: Float3, reach: f32) -> Float3 {
    // In doubles, rounded once (see NavExactMath).
    let (pd, qd, e) = (p.to_double(), q.to_double(), edge.to_double());
    let reach = reach as f64;
    let mut out_a = unit_or_zero(e.cross(a.normal.to_double()));
    if out_a.dot(pd - a.center.to_double()) < 0.0 {
        out_a = -out_a;
    }
    let mut out_b = unit_or_zero(e.cross(b.normal.to_double()));
    if out_b.dot(qd - b.center.to_double()) < 0.0 {
        out_b = -out_b;
    }

    // Closest points of the rays p + s * outA and q + u * outB (both unit length).
    let cos = out_a.dot(out_b);
    let w = pd - qd;
    let den = 1.0 - cos * cos;
    if den > 1e-4 {
        let s = (cos * out_b.dot(w) - out_a.dot(w)) / den;
        let u = (out_b.dot(w) - cos * out_a.dot(w)) / den;
        if s >= 0.0 && u >= 0.0 && s <= reach && u <= reach {
            return ((pd + out_a * s + qd + out_b * u) * 0.5).to_float();
        }
    }

    let around = math::min(reach, math::max(dist_d(pd, qd), 1e-3));
    ((pd + out_a * around + qd + out_b * around) * 0.5).to_float()
}

/// True if the two surfaces of an outside-fold candidate lie over each other rather than turning round an edge: each
/// one's outward direction from its edge (as in [`fold_hinge`]) points back over the other, as a box's underside does
/// over the floor it stands on. Round a real outside corner the outward directions are about square or the same way; a
/// crossing between stacked surfaces would go through one of them.
pub fn stacked(p: Float3, q: Float3, a: &NavPoly, b: &NavPoly, edge: Float3) -> bool {
    let (pd, qd, e) = (p.to_double(), q.to_double(), edge.to_double());
    let mut out_a = unit_or_zero(e.cross(a.normal.to_double()));
    if out_a.dot(pd - a.center.to_double()) < 0.0 {
        out_a = -out_a;
    }
    let mut out_b = unit_or_zero(e.cross(b.normal.to_double()));
    if out_b.dot(qd - b.center.to_double()) < 0.0 {
        out_b = -out_b;
    }
    out_a.dot(out_b) < -0.5
}

fn unit_or_zero(v: Double3) -> Double3 {
    let length_sq = v.dot(v);
    if length_sq > 1e-38 {
        let l = length_sq.sqrt();
        Double3::new(v.x / l, v.y / l, v.z / l)
    } else {
        Double3::default()
    }
}

// =====================================================================================================================
// StitchProfileJob
// =====================================================================================================================

/// What `StitchProfileJob.Execute` reads for one profile. The orchestrator builds it from the tile builder's output
/// (`ProfileTileTask`s with their `BinPolyMesh`es) and the bake's bins and grids.
#[derive(Clone)]
pub struct StitchInput<'a> {
    /// The profile (navmesh group) being stitched.
    pub profile: &'a BakeProfile,
    /// The profile's tier's ground grid (bin 0 of tier `profile_tier * bin_count`): voxel size for the settings.
    pub ground: &'a BinGrid,
    /// Every bin (`Bins`): frames and adjacency masks.
    pub bins: &'a [Bin],
    /// The profile's built tile meshes, in task order (see [`gather_meshes`]).
    pub meshes: Vec<&'a BinPolyMesh>,
    /// This profile's jump links, sorted with [`JumpLinkRecord::edge_order`] (`JumpLinks[JumpRanges[index]]`).
    /// `None` makes `stitch` generate them itself.
    pub jump_links: Option<&'a [JumpLinkRecord]>,
    /// The area table every navmesh carries.
    pub areas: &'a [NavAreaInfo],
    /// `OrientationConfig::max_fold_deg`.
    pub max_fold_deg: f32,
}

/// `StitchProfileJob.Setup` without the clearance object: the stitch and jump settings for a profile. Shared with the
/// jump-link generation, so the precomputed jump links match what `stitch` would generate itself.
pub fn stitch_setup(profile: &BakeProfile, ground: &BinGrid) -> (StitchSettings, JumpSettings) {
    let cs = ground.cs;
    let ch = ground.ch;
    let walkable_climb = (profile.step_height / ch) as i32;

    let mut jump = JumpSettings::default_for(cs, ch, walkable_climb);
    jump.enabled = profile.can_jump;
    jump.max_jump_up_height = profile.max_jump_up_height;
    jump.max_jump_distance = profile.max_jump_distance;
    jump.max_fall_distance = profile.max_fall_distance;
    jump.arc_height = profile.jump_arc_height;

    let mut settings = StitchSettings::from_agent(profile.radius, cs, ch, profile.build.max_simplification_error);
    // Two tiles' edges at one seam belong to the same surface if they're within a step of each other; stacked surfaces
    // are at least the agent's height apart.
    settings.seam_height_tolerance = math::max(walkable_climb, 1) as f32 * ch;
    (settings, jump)
}

/// `StitchProfileJob.Orientations`: the bins as the stitcher reads them, frames and fold adjacency.
pub fn orientations(bins: &[Bin]) -> (Vec<OrientationBin>, Vec<u64>) {
    (bins.iter().map(|b| b.to_orientation()).collect(), bins.iter().map(|b| b.adjacency_mask).collect())
}

/// `StitchProfileJob.GatherMeshes`: the profile's built tile meshes, in task order (the order both stitching and the
/// jump chunks use). `meshes[t]` and `valid[t]` belong to `tasks[t]`.
pub fn gather_meshes<'a>(
    profile: i32,
    tasks: &[ProfileTileTask],
    meshes: &'a [BinPolyMesh],
    valid: &[bool],
) -> Vec<&'a BinPolyMesh> {
    let mut result = Vec::with_capacity(tasks.len());
    for (t, task) in tasks.iter().enumerate() {
        if task.profile == profile && valid[t] {
            result.push(&meshes[t]);
        }
    }
    result
}

/// `StitchProfileJob.Execute`: stitches one profile. `fold_clearance` is the profile's fold test (the C# builds
/// `HeightfieldFoldClearance` from the ground heightfield and the profile radius), `jump_clearance` its jump test.
pub fn stitch_profile<C: FoldClearance, J: JumpClearance>(
    input: &StitchInput,
    fold_clearance: &C,
    jump_clearance: &J,
) -> (NavMeshData, StitchStats) {
    let (mut settings, jump) = stitch_setup(input.profile, input.ground);
    settings.max_fold_angle = math::radians(input.max_fold_deg);
    let (o_bins, adjacency) = orientations(input.bins);
    stitch_refs(
        &input.meshes,
        &o_bins,
        &adjacency,
        &settings,
        fold_clearance,
        &jump,
        jump_clearance,
        input.jump_links,
        Some(input.areas),
    )
}

/// `JumpLinksJob` for one profile, sequentially: every chunk's links, merged in [`JumpLinkRecord::edge_order`]. The
/// orchestrator may instead run `chunk_count` calls of [`generate_jump_links_for_edge_range`] in parallel and sort the
/// concatenation. `chunk_count` only changes how the work splits, never the result.
pub fn generate_jump_links_for_profile<J: JumpClearance>(
    input: &StitchInput,
    jump_clearance: &J,
    chunk_count: i32,
) -> Vec<JumpLinkRecord> {
    let (settings, jump) = stitch_setup(input.profile, input.ground);
    let (o_bins, _) = orientations(input.bins);
    let mut all = Vec::new();
    for chunk in 0..chunk_count.max(1) {
        all.extend(generate_jump_links_for_edge_range(
            &input.meshes,
            &o_bins,
            &settings,
            &jump,
            jump_clearance,
            chunk,
            chunk_count.max(1),
        ));
    }
    all.sort_by(JumpLinkRecord::edge_order);
    all
}
