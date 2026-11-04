//! Seams between loaded chunks (Foxfire's `Lib/NavSeams.cs` and the pure logic of `Systems/NavSeamSystem.cs`).
//!
//! Two chunks with Chunk Bounds join across a side face their boxes share. Their navmeshes join where their
//! seam edges overlap along the face at the same height (by the rule the bake uses between tiles); their flight
//! volumes join wherever a free leaf of one touches a free leaf of the other through the face.
//!
//! [`build_seams`] works out every seam of a [`NavChunks`] snapshot: one [`Seam`] per pair of bounded chunks with
//! the same agent type whose boxes share a face, `chunk_a` the lower chunk id, so a pair always comes out the same
//! way round and the result doesn't depend on the order scenes were loaded (ADR 0065). A chunk with an overlay
//! joins with its overlay's navmesh (`overlay_a` / `overlay_b`), whose polygons the links then index.
//!
//! [`seam_signature`] is the cheap change test: it only changes when the loaded set (ids, agent types, bounds,
//! seam edges, volumes, overlays) changes, so [`SeamSet::update`] only restitches then, and keeps the seams whose
//! inputs didn't change (`NavSeamSystem.Find`).
use crate::chunks::{ChunkEntry, NavChunks};
use crate::volume::leaf_at_cell;
use nav_format::blob::{NavChunkBorderData, NavChunkFace, NavMeshData, NavSeamEdge, NavVolumeData};
use nav_math::hash::{hash_array, hash_value};
use nav_math::math::{self, max, min, saturate};
use nav_math::{Float3, Hash128, Int3};
use std::collections::HashSet;

/// `NavSeams.Epsilon`: how close two coordinates must be to count as the same.
pub const EPSILON: f32 = 1e-3;

/// `NavSeamPolyLink`: polygon `poly_a` of chunk A's navmesh to `poly_b` of chunk B's, over the stretch of the
/// face where their seam edges overlap. `a0`-`a1` lie on A's edge, `b0`-`b1` on B's (`b0` pairs with `a0`);
/// both are on the face.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavSeamPolyLink {
    pub poly_a: i32,
    pub poly_b: i32,
    pub a0: Float3,
    pub a1: Float3,
    pub b0: Float3,
    pub b1: Float3,
}

/// `NavSeamLeafLink`: free leaf `leaf_a` of chunk A's flight volume to `leaf_b` of B's, through the rectangle
/// `min`-`max` on the face where their faces overlap (flat along the face's axis).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavSeamLeafLink {
    pub leaf_a: i32,
    pub leaf_b: i32,
    pub min: Float3,
    pub max: Float3,
}

/// The face of box A that box B lies across, with the part of it both share (`NavSeams.SharedFace`): the
/// region is flat along the face's axis. `None` if the boxes don't share a side face (a gap, a corner only).
pub fn shared_face(min_a: Float3, max_a: Float3, min_b: Float3, max_b: Float3) -> Option<(NavChunkFace, Float3, Float3)> {
    let mut region_min = min_a.max_v(min_b);
    let mut region_max = max_a.min_v(max_b);
    let mut axis = 0usize;
    while axis <= 2 {
        // side faces only: x, then z
        let other = 2 - axis;
        if region_max.y - region_min.y <= EPSILON || region_max[other] - region_min[other] <= EPSILON {
            axis += 2;
            continue;
        }
        if math::abs(max_a[axis] - min_b[axis]) <= EPSILON {
            let face = if axis == 0 { NavChunkFace::X_MAX } else { NavChunkFace::Z_MAX };
            region_min[axis] = max_a[axis];
            region_max[axis] = max_a[axis];
            return Some((face, region_min, region_max));
        }
        if math::abs(min_a[axis] - max_b[axis]) <= EPSILON {
            let face = if axis == 0 { NavChunkFace::X_MIN } else { NavChunkFace::Z_MIN };
            region_min[axis] = min_a[axis];
            region_max[axis] = min_a[axis];
            return Some((face, region_min, region_max));
        }
        axis += 2;
    }
    None
}

/// The face across from `face` (the neighbour's side of a shared face), `NavSeams.Opposite`.
pub fn opposite(face: NavChunkFace) -> NavChunkFace {
    NavChunkFace(face.0 ^ 2)
}

/// The world axis a face is perpendicular to: 0 (x) or 2 (z), `NavSeams.Axis`.
pub fn axis(face: NavChunkFace) -> usize {
    if face.0 & 1 == 0 {
        0
    } else {
        2
    }
}

/// The height two seam edges may differ by and still join: the larger of the two navmeshes' step tolerances. A
/// navmesh baked before the blob stored one (0) gets half a metre (`NavSeams.Tolerance`).
pub fn tolerance(a: &NavMeshData, b: &NavMeshData) -> f32 {
    let t = max(a.seam_height_tolerance, b.seam_height_tolerance);
    if t.is_finite() && t > 0.0 {
        t
    } else {
        0.5
    }
}

/// The point of `edge` at `s` along the face (`NavSeams.PointAt`).
fn point_at(edge: &NavSeamEdge, along: usize, s: f32) -> Float3 {
    let span = edge.b[along] - edge.a[along];
    let t = if math::abs(span) < 1e-6 { 0.0 } else { (s - edge.a[along]) / span };
    let mut p = edge.a.lerp(edge.b, saturate(t));
    p[along] = s;
    p
}

/// Navmesh links across a shared face: every overlap between A's seam edges on `face_a` and B's on the opposite
/// face, within the shared region, whose heights at both ends differ by no more than either navmesh's seam
/// tolerance (`NavSeams.MatchPolys`). Appends to `output`, in A's seam-edge order then B's.
pub fn match_polys(
    a: &NavMeshData,
    b: &NavMeshData,
    face_a: NavChunkFace,
    region_min: Float3,
    region_max: Float3,
    output: &mut Vec<NavSeamPolyLink>,
) {
    let face_b = opposite(face_a);
    let along = 2 - axis(face_a); // the horizontal axis along the face
    let tol = tolerance(a, b);
    for ea in &a.seam_edges {
        if ea.face != face_a {
            continue;
        }
        let (a0, a1) = (ea.a[along], ea.b[along]);
        for eb in &b.seam_edges {
            if eb.face != face_b {
                continue;
            }
            let (b0, b1) = (eb.a[along], eb.b[along]);
            let lo = max(max(min(a0, a1), min(b0, b1)), region_min[along]);
            let hi = min(min(max(a0, a1), max(b0, b1)), region_max[along]);
            if hi - lo <= EPSILON {
                continue;
            }
            let pa0 = point_at(ea, along, lo);
            let pa1 = point_at(ea, along, hi);
            let pb0 = point_at(eb, along, lo);
            let pb1 = point_at(eb, along, hi);
            // Stacked surfaces cross the same face at different heights and stay apart.
            if math::abs(pa0.y - pb0.y) > tol || math::abs(pa1.y - pb1.y) > tol {
                continue;
            }
            output.push(NavSeamPolyLink { poly_a: ea.poly, poly_b: eb.poly, a0: pa0, a1: pa1, b0: pb0, b1: pb1 });
        }
    }
}

/// Why [`match_polys`] found what it did, for the seam report (`NavSeams.DiagnosePolys`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolyDiagnosis {
    /// The seam edges A has on the shared face.
    pub edges_a: i32,
    /// The seam edges B has on it.
    pub edges_b: i32,
    /// How much of the face they overlap along, regardless of height.
    pub overlap: f32,
    /// The smallest height difference among those overlaps (`f32::MAX` if none).
    pub height_gap: f32,
}

pub fn diagnose_polys(a: &NavMeshData, b: &NavMeshData, face_a: NavChunkFace, region_min: Float3, region_max: Float3) -> PolyDiagnosis {
    let face_b = opposite(face_a);
    let along = 2 - axis(face_a);
    let mut d = PolyDiagnosis { edges_a: 0, edges_b: 0, overlap: 0.0, height_gap: f32::MAX };
    d.edges_b = b.seam_edges.iter().filter(|e| e.face == face_b).count() as i32;
    for ea in &a.seam_edges {
        if ea.face != face_a {
            continue;
        }
        d.edges_a += 1;
        for eb in &b.seam_edges {
            if eb.face != face_b {
                continue;
            }
            let lo = max(max(min(ea.a[along], ea.b[along]), min(eb.a[along], eb.b[along])), region_min[along]);
            let hi = min(min(max(ea.a[along], ea.b[along]), max(eb.a[along], eb.b[along])), region_max[along]);
            if hi - lo <= EPSILON {
                continue;
            }
            d.overlap += hi - lo;
            let dy = max(
                math::abs(point_at(ea, along, lo).y - point_at(eb, along, lo).y),
                math::abs(point_at(ea, along, hi).y - point_at(eb, along, hi).y),
            );
            d.height_gap = min(d.height_gap, dy);
        }
    }
    d
}

/// How far two boxes are from sharing a side face, for boxes that overlap in height and along the face but
/// whose faces don't coincide: the gap (positive) or overlap (negative) along the closest axis, and that axis (0
/// or 2). `None` if they share a face, or aren't close on any axis (`NavSeams.NearMiss`).
pub fn near_miss(min_a: Float3, max_a: Float3, min_b: Float3, max_b: Float3, within: f32) -> Option<(f32, usize)> {
    if shared_face(min_a, max_a, min_b, max_b).is_some() {
        return None;
    }
    let region_min = min_a.max_v(min_b);
    let region_max = max_a.min_v(max_b);
    let mut gap = f32::MAX;
    let mut found: Option<usize> = None;
    let mut ax = 0usize;
    while ax <= 2 {
        let other = 2 - ax;
        if region_max.y - region_min.y <= EPSILON || region_max[other] - region_min[other] <= EPSILON {
            ax += 2;
            continue;
        }
        // Distance between the nearest faces: positive apart, negative overlapping.
        let d = if math::abs(min_b[ax] - max_a[ax]) < math::abs(min_a[ax] - max_b[ax]) { min_b[ax] - max_a[ax] } else { min_a[ax] - max_b[ax] };
        if math::abs(d) <= within && math::abs(d) < math::abs(gap) {
            gap = d;
            found = Some(ax);
        }
        ax += 2;
    }
    found.map(|a| (gap, a))
}

/// The first cell past a blocked cell's run along `along`: the end of its base cell, or of its block cell.
fn blocked_run_end(v: &NavVolumeData, cell: Int3, along: usize) -> i32 {
    let b = cell / v.base_scale;
    let entry = v.base_leaf[(b.x + v.base_dims.x * (b.y + v.base_dims.y * b.z)) as usize];
    let scale = if entry == -1 { v.base_scale } else { v.blocks[(-2 - entry) as usize].scale };
    (cell[along] / scale + 1) * scale
}

/// Flight links across a shared face: each free leaf of A on `face_a`, paired with every free leaf of B its face
/// rectangle touches through the face, with the rectangle they share (within the shared region). B is read cell
/// by cell along its face, a leaf or a blocked run at a time (`NavSeams.MatchLeaves`).
pub fn match_leaves(
    a: &NavVolumeData,
    b: &NavVolumeData,
    face_a: NavChunkFace,
    region_min: Float3,
    region_max: Float3,
    output: &mut Vec<NavSeamLeafLink>,
) {
    let ax = axis(face_a);
    let along = 2 - ax;
    let a_high = face_a == NavChunkFace::X_MAX || face_a == NavChunkFace::Z_MAX;
    let b_cell = if a_high { 0 } else { b.dims[ax] - 1 }; // B's cells on the face
    let plane = region_min[ax];
    let mut pairs: HashSet<(i32, i32)> = HashSet::with_capacity(64);

    for (la, leaf) in a.leaves.iter().enumerate() {
        let on_face = if a_high { leaf.min[ax] + leaf.size >= a.dims[ax] } else { leaf.min[ax] == 0 };
        if !on_face {
            continue;
        }

        // The leaf's face rectangle (y and the axis along the face), within the shared region.
        let lo = a.origin + Float3::new(leaf.min.x as f32, leaf.min.y as f32, leaf.min.z as f32) * a.cell_size;
        let hi = lo + Float3::splat(leaf.size as f32 * a.cell_size);
        let r_lo = (max(lo.y, region_min.y), max(lo[along], region_min[along]));
        let r_hi = (min(hi.y, region_max.y), min(hi[along], region_max[along]));
        if r_hi.0 - r_lo.0 <= EPSILON || r_hi.1 - r_lo.1 <= EPSILON {
            continue;
        }

        // B's cells under that rectangle.
        let origin = (b.origin.y, b.origin[along]);
        let dims = (b.dims.y, b.dims[along]);
        let c0 = (
            math::clamp(((r_lo.0 - origin.0) / b.cell_size).floor() as i32, 0, dims.0),
            math::clamp(((r_lo.1 - origin.1) / b.cell_size).floor() as i32, 0, dims.1),
        );
        let c1 = (
            math::clamp(((r_hi.0 - origin.0) / b.cell_size).ceil() as i32, 0, dims.0),
            math::clamp(((r_hi.1 - origin.1) / b.cell_size).ceil() as i32, 0, dims.1),
        );
        for y in c0.0..c1.0 {
            let mut w = c0.1;
            while w < c1.1 {
                let mut cell = Int3::new(0, 0, 0);
                cell[ax] = b_cell;
                cell.y = y;
                cell[along] = w;
                let lb = leaf_at_cell(b, cell);
                if lb < 0 {
                    w = blocked_run_end(b, cell, along);
                    continue;
                }

                let other = &b.leaves[lb as usize];
                w = other.min[along] + other.size;
                if !pairs.insert((la as i32, lb)) {
                    continue;
                }

                let o_lo = b.origin + Float3::new(other.min.x as f32, other.min.y as f32, other.min.z as f32) * b.cell_size;
                let o_hi = o_lo + Float3::splat(other.size as f32 * b.cell_size);
                let mut mn = Float3::splat(plane);
                let mut mx = Float3::splat(plane);
                mn.y = max(r_lo.0, o_lo.y);
                mx.y = min(r_hi.0, o_hi.y);
                mn[along] = max(r_lo.1, o_lo[along]);
                mx[along] = min(r_hi.1, o_hi[along]);
                if mx.y - mn.y <= EPSILON || mx[along] - mn[along] <= EPSILON {
                    continue;
                }
                output.push(NavSeamLeafLink { leaf_a: la as i32, leaf_b: lb, min: mn, max: mx });
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Which pairs get seams (NavSeamSystem)
// ---------------------------------------------------------------------------------------------------------

/// `NavSeam` plus its link buffers: where two loaded chunks with Chunk Bounds meet, for one agent type.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Seam {
    /// The lower chunk id: a pair always gets the same order.
    pub chunk_a: Hash128,
    pub chunk_b: Hash128,
    pub agent_type: Hash128,
    /// A's face; B's is the opposite one.
    pub face_a: NavChunkFace,
    /// The part of the face both boxes share (flat along the face's axis).
    pub min: Float3,
    pub max: Float3,
    /// The navmesh each side joined with is its overlay's (and `poly_a` / `poly_b` index the overlay's
    /// polygons), else the chunk's own.
    pub overlay_a: bool,
    pub overlay_b: bool,
    /// Indices into the [`NavChunks`] the seam was built from: the entry whose navmesh the poly links index (the
    /// overlay's entry if `overlay_*`), and the chunk's base entry (whose volume the leaf links index).
    pub nav_entry_a: usize,
    pub nav_entry_b: usize,
    pub base_entry_a: usize,
    pub base_entry_b: usize,
    /// A hash of what the seam was stitched from; equal keys, equal links (`NavSeamSystem.Find`).
    pub source_key: u64,
    pub poly_links: Vec<NavSeamPolyLink>,
    pub leaf_links: Vec<NavSeamLeafLink>,
}

// Seeds of the identity hashes below (arbitrary, fixed).
const NAV_SEED: u64 = 0x5EA3_0001;
const VOLUME_SEED: u64 = 0x5EA3_0002;
const BORDER_SEED: u64 = 0x5EA3_0003;
const ENTRY_SEED: u64 = 0x5EA3_0004;
const PAIR_SEED: u64 = 0x5EA3_0005;

/// What identifies a navmesh to the seams: its seam edges and tolerance, and its size. (Foxfire compares blob
/// pointers; a loaded snapshot has no stable pointers here, so equal content is equal.)
pub fn nav_identity(nav: &NavMeshData) -> u64 {
    let mut h = hash_value(nav.polys.len() as i32, NAV_SEED);
    h = hash_value(nav.verts.len() as i32, h);
    h = hash_value(nav.links.len() as i32, h);
    h = hash_value(nav.seam_height_tolerance, h);
    h = hash_array(&nav.seam_edges, h);
    hash_array(&nav.tile_ranges, h)
}

/// What identifies a flight volume to the seams: its layout and leaves.
pub fn volume_identity(v: &NavVolumeData) -> u64 {
    let mut h = hash_value(v.origin, VOLUME_SEED);
    h = hash_value(v.cell_size, h);
    h = hash_value(v.dims, h);
    h = hash_value(v.base_scale, h);
    h = hash_array(&v.base_leaf, h);
    h = hash_array(&v.blocks, h);
    h = hash_array(&v.block_leaf, h);
    hash_array(&v.leaves, h)
}

/// What identifies a chunk border to the overlays: its box, reach, depths, triangles, profiles and agents.
pub fn border_identity(b: &NavChunkBorderData) -> u64 {
    let mut h = hash_value(b.box_min, BORDER_SEED);
    h = hash_value(b.box_max, h);
    h = hash_value(b.overhang, h);
    h = hash_value(b.min_depth, h);
    h = hash_value(b.max_depth, h);
    h = hash_array(&b.triangles, h);
    h = hash_array(&b.profiles, h);
    h = hash_array(&b.agents, h);
    hash_array(&b.areas, h)
}

/// An entry's contribution to the seam signature: anything that changes its seams.
fn entry_identity(e: &ChunkEntry) -> u64 {
    let mut h = hash_value(e.chunk, ENTRY_SEED);
    h = hash_value(e.agent_type, h);
    h = hash_value(e.bounds_min, h);
    h = hash_value(e.bounds_max, h);
    h = hash_value(e.bounded as i32 | (e.overlay as i32) << 1, h);
    h = hash_value(e.nav.as_deref().map(nav_identity).unwrap_or(0), h);
    hash_value(e.volume.as_deref().map(volume_identity).unwrap_or(0), h)
}

/// The signature of what seams depend on: the entries (ids, agent types, bounds, navmeshes, volumes) and the
/// overlays among them (`NavSeamSystem.Signature`). It doesn't depend on the order of the entries, and only
/// changes when the loaded set changes.
pub fn seam_signature(chunks: &NavChunks) -> u64 {
    let mut h = chunks.len() as u64;
    // Commutative: any order of entries gives the same signature.
    for e in &chunks.entries {
        h = h.wrapping_add(entry_identity(e));
    }
    h
}

/// The seams `chunks` calls for, sorted by (chunk_a, chunk_b, agent type). Entries of the same chunk, entries
/// without Chunk Bounds and overlay entries don't pair; two chunks of different agent types don't either.
pub fn build_seams(chunks: &NavChunks) -> Vec<Seam> {
    let (seams, _) = build_seams_reported(chunks);
    seams
}

/// [`build_seams`] with a report of why pairs didn't join (boxes that almost meet, seam edges at different
/// heights), one line each, as the C# logs.
pub fn build_seams_reported(chunks: &NavChunks) -> (Vec<Seam>, Vec<String>) {
    let (seams, report, _) = stitch_pairs(chunks, &[]);
    (seams, report)
}

fn name(id: Hash128) -> String {
    format!("chunk {}", &id.to_hex()[..8])
}

/// Entry order for pairing: by (chunk, agent type, overlay), as `NavChunks::gather` makes it, however the
/// snapshot was built.
fn base_entries_sorted(chunks: &NavChunks) -> Vec<usize> {
    let mut v: Vec<usize> = (0..chunks.entries.len()).filter(|&i| !chunks.entries[i].overlay).collect();
    v.sort_by_key(|&i| (chunks.entries[i].chunk, chunks.entries[i].agent_type));
    v
}

/// The entry whose navmesh a chunk joins with across faces: its overlay's for the agent type if it has one.
fn seam_nav_entry(chunks: &NavChunks, base: usize) -> (usize, bool) {
    let e = &chunks.entries[base];
    match chunks.find(e.chunk, e.agent_type, true) {
        Some(o) if chunks.entries[o].nav.is_some() => (o, true),
        _ => (base, false),
    }
}

/// Stitches every pair; `keep` seams (from an earlier build) are reused when their `source_key` matches.
/// Returns the seams, the report, and how many were reused.
fn stitch_pairs(chunks: &NavChunks, keep: &[Seam]) -> (Vec<Seam>, Vec<String>, usize) {
    let order = base_entries_sorted(chunks);
    let mut seams = Vec::new();
    let mut report = Vec::new();
    let mut kept = 0usize;
    for (n, &i) in order.iter().enumerate() {
        for &j in &order[n + 1..] {
            let (mut ia, mut ib) = (i, j);
            let (a, b) = (&chunks.entries[ia], &chunks.entries[ib]);
            if !a.bounded || !b.bounded || a.chunk == b.chunk {
                continue;
            }
            if a.agent_type != b.agent_type {
                report.push(format!(
                    "{} and {}: different agent types ({}, {}); seams join one agent type.",
                    name(a.chunk),
                    name(b.chunk),
                    name(a.agent_type),
                    name(b.agent_type)
                ));
                continue;
            }
            if b.chunk < a.chunk {
                std::mem::swap(&mut ia, &mut ib); // A is the lower id
            }
            let (a, b) = (&chunks.entries[ia], &chunks.entries[ib]);
            let (nav_a, overlay_a) = seam_nav_entry(chunks, ia);
            let (nav_b, overlay_b) = seam_nav_entry(chunks, ib);
            let Some((face, min, max)) = shared_face(a.bounds_min, a.bounds_max, b.bounds_min, b.bounds_max) else {
                match near_miss(a.bounds_min, a.bounds_max, b.bounds_min, b.bounds_max, f32::MAX) {
                    Some((gap, ax)) => report.push(format!(
                        "{} and {}: boxes {} {:.3} m {}along {}; faces must coincide (within 1 mm) to join.",
                        name(a.chunk),
                        name(b.chunk),
                        if gap > 0.0 { "are" } else { "overlap by" },
                        math::abs(gap),
                        if gap > 0.0 { "apart " } else { "" },
                        if ax == 0 { "x" } else { "z" }
                    )),
                    None => report.push(format!("{} and {}: boxes don't line up on any side face (no shared height and width).", name(a.chunk), name(b.chunk))),
                }
                continue;
            };

            let na = chunks.entries[nav_a].nav.as_deref();
            let nb = chunks.entries[nav_b].nav.as_deref();
            let va = a.volume.as_deref();
            let vb = b.volume.as_deref();
            let mut key = hash_value(a.chunk, PAIR_SEED);
            key = hash_value(b.chunk, key);
            key = hash_value(a.agent_type, key);
            key = hash_value(face.0, key);
            key = hash_value(min, key);
            key = hash_value(max, key);
            key = hash_value(overlay_a as i32 | (overlay_b as i32) << 1, key);
            for nav in [na, nb] {
                key = hash_value(nav.map(nav_identity).unwrap_or(0), key);
            }
            for vol in [va, vb] {
                key = hash_value(vol.map(volume_identity).unwrap_or(0), key);
            }

            if let Some(old) = keep.iter().find(|s| s.source_key == key && s.chunk_a == a.chunk && s.chunk_b == b.chunk && s.agent_type == a.agent_type) {
                let mut s = old.clone();
                s.nav_entry_a = nav_a;
                s.nav_entry_b = nav_b;
                s.base_entry_a = ia;
                s.base_entry_b = ib;
                seams.push(s);
                kept += 1;
                continue;
            }

            let mut poly_links = Vec::new();
            let mut leaf_links = Vec::new();
            if let (Some(na), Some(nb)) = (na, nb) {
                match_polys(na, nb, face, min, max, &mut poly_links);
            }
            if let (Some(va), Some(vb)) = (va, vb) {
                match_leaves(va, vb, face, min, max, &mut leaf_links);
            }
            report.push(format!(
                "{} {} {:?} | {}: {} navmesh links, {} flight links",
                name(a.chunk),
                a.bounds_text(),
                face,
                name(b.chunk),
                poly_links.len(),
                leaf_links.len()
            ));
            if poly_links.is_empty() {
                if let (Some(na), Some(nb)) = (na, nb) {
                    report.push(why_no_poly_links(na, nb, face, min, max));
                }
            }
            seams.push(Seam {
                chunk_a: a.chunk,
                chunk_b: b.chunk,
                agent_type: a.agent_type,
                face_a: face,
                min,
                max,
                overlay_a,
                overlay_b,
                nav_entry_a: nav_a,
                nav_entry_b: nav_b,
                base_entry_a: ia,
                base_entry_b: ib,
                source_key: key,
                poly_links,
                leaf_links,
            });
        }
    }
    seams.sort_by(|x, y| (x.chunk_a, x.chunk_b, x.agent_type).cmp(&(y.chunk_a, y.chunk_b, y.agent_type)));
    (seams, report, kept)
}

/// Why two navmeshes sharing a face got no links: no seam edges there, none overlapping, or heights apart
/// (`NavSeamSystem.WhyNoPolyLinks`).
pub fn why_no_poly_links(a: &NavMeshData, b: &NavMeshData, face: NavChunkFace, min: Float3, max: Float3) -> String {
    let d = diagnose_polys(a, b, face, min, max);
    if d.edges_a == 0 || d.edges_b == 0 {
        return format!(" (seam edges on the face: {} in A, {} in B; rebake a chunk with none, or check walkable ground reaches its face)", d.edges_a, d.edges_b);
    }
    if d.overlap <= 0.0 {
        return format!(" ({} and {} seam edges, but none overlap along the face)", d.edges_a, d.edges_b);
    }
    format!(" (edges overlap for {:.2} m, but their heights differ by at least {:.3} m; tolerance {:.3} m)", d.overlap, d.height_gap, tolerance(a, b))
}

/// What one [`SeamSet::update`] did (`NavSeamSystem`'s counters).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SeamUpdate {
    /// False if the signature hadn't changed: nothing was touched.
    pub changed: bool,
    pub built: usize,
    pub kept: usize,
    pub removed: usize,
    pub poly_links: usize,
    pub leaf_links: usize,
}

/// The live seams of a world: rebuilt only when the loaded-chunk signature changes, keeping seams whose inputs
/// didn't (`NavSeamSystem`).
#[derive(Clone, Debug, Default)]
pub struct SeamSet {
    pub seams: Vec<Seam>,
    pub report: Vec<String>,
    signature: Option<u64>,
}

impl SeamSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// The signature of the snapshot the seams were last built for.
    pub fn signature(&self) -> Option<u64> {
        self.signature
    }

    /// Brings the seams up to date with `chunks`; does nothing if its signature is the one already built.
    pub fn update(&mut self, chunks: &NavChunks) -> SeamUpdate {
        let signature = seam_signature(chunks);
        if self.signature == Some(signature) {
            return SeamUpdate::default();
        }
        self.signature = Some(signature);
        let (seams, report, kept) = stitch_pairs(chunks, &self.seams);
        let built = seams.len() - kept;
        let removed = self.seams.iter().filter(|o| !seams.iter().any(|s| s.source_key == o.source_key && s.chunk_a == o.chunk_a && s.chunk_b == o.chunk_b && s.agent_type == o.agent_type)).count();
        let poly_links = seams.iter().map(|s| s.poly_links.len()).sum();
        let leaf_links = seams.iter().map(|s| s.leaf_links.len()).sum();
        self.seams = seams;
        self.report = report;
        SeamUpdate { changed: true, built, kept, removed, poly_links, leaf_links }
    }

    /// The seam of a chunk pair (either order) for an agent type.
    pub fn find(&self, chunk_a: Hash128, chunk_b: Hash128, agent_type: Hash128) -> Option<&Seam> {
        let (lo, hi) = if chunk_b < chunk_a { (chunk_b, chunk_a) } else { (chunk_a, chunk_b) };
        self.seams.iter().find(|s| s.chunk_a == lo && s.chunk_b == hi && s.agent_type == agent_type)
    }
}
