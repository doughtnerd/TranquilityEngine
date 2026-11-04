//! Polygon mesh building (`RcMeshs`, ported from Foxfire's `RcMeshes.cs`, itself a port of DotRecast's
//! `RcMeshs`): triangulates and merges the contours into convex polygons, removes tile-border
//! vertices, and builds the mesh adjacency.
//!
//! The polygon lists are flat `i32` arrays exactly like Recast's: a polygon `i` occupies
//! `polys[i * nvp * 2 ..]` as `nvp` vertex indices (padded with [`RC_MESH_NULL_IDX`]) then `nvp`
//! neighbour indices. [`RcPolyMesh`]'s counts can be smaller than its list lengths.
use crate::constants::{RC_BORDER_VERTEX, RC_MESH_NULL_IDX, RC_MULTIPLE_REGS};
use crate::types::{RcContourSet, RcPolyMesh, RcPolyMeshStatus};
use nav_math::{Int3, Int4};

pub const MAX_MESH_VERTS_POLY: i32 = 0xffff;
pub const VERTEX_BUCKET_COUNT: i32 = 1 << 12;

const INDEX_MASK: i32 = 0x0fff_ffff;

#[derive(Clone, Copy, Default)]
struct RcEdge {
    #[allow(dead_code)] // written as in Recast's rcEdge; the adjacency pass only reads the other fields
    vert0: i32,
    vert1: i32,
    poly0: i32,
    poly1: i32,
    poly_edge0: i32,
    poly_edge1: i32,
}

// ------------------------------------------------------------------ helpers

fn fill_ints(list: &mut [i32], value: i32, start: usize, count: usize) {
    for i in 0..count {
        list[start + i] = value;
    }
}

/// Copies within one list (the ranges never overlap in the callers, and the C# copies forwards).
fn copy_ints_within(list: &mut [i32], src_index: usize, dst_index: usize, count: usize) {
    for i in 0..count {
        list[dst_index + i] = list[src_index + i];
    }
}

// ------------------------------------------------------------- adjacency

/// Builds the polygons' neighbour indices (the second `nvp` entries of each polygon).
fn build_mesh_adjacency(polys: &mut [i32], npolys: i32, nverts: i32, vertices_per_poly: i32) {
    // Based on code by Eric Lengyel from:
    // http://www.terathon.com/code/edges.php

    let max_edge_count = (npolys * vertices_per_poly) as usize;
    let nvp = vertices_per_poly as usize;
    let mut first_edge = vec![0i32; nverts as usize + max_edge_count];
    let next_edge = nverts as usize;
    let mut edge_count = 0usize;

    let mut edges = vec![RcEdge::default(); max_edge_count];

    for i in 0..nverts as usize {
        first_edge[i] = RC_MESH_NULL_IDX;
    }

    for i in 0..npolys as usize {
        let t = i * nvp * 2;
        for j in 0..nvp {
            if polys[t + j] == RC_MESH_NULL_IDX {
                break;
            }
            let v0 = polys[t + j];
            let v1 = if j + 1 >= nvp || polys[t + j + 1] == RC_MESH_NULL_IDX { polys[t] } else { polys[t + j + 1] };
            if v0 < v1 {
                edges[edge_count] = RcEdge {
                    vert0: v0,
                    vert1: v1,
                    poly0: i as i32,
                    poly_edge0: j as i32,
                    poly1: i as i32,
                    poly_edge1: 0,
                };

                // Insert edge
                first_edge[next_edge + edge_count] = first_edge[v0 as usize];
                first_edge[v0 as usize] = edge_count as i32;
                edge_count += 1;
            }
        }
    }

    for i in 0..npolys as usize {
        let t = i * nvp * 2;
        for j in 0..nvp {
            if polys[t + j] == RC_MESH_NULL_IDX {
                break;
            }
            let v0 = polys[t + j];
            let v1 = if j + 1 >= nvp || polys[t + j + 1] == RC_MESH_NULL_IDX { polys[t] } else { polys[t + j + 1] };
            if v0 > v1 {
                let mut e = first_edge[v1 as usize];
                while e != RC_MESH_NULL_IDX {
                    let edge = &mut edges[e as usize];
                    if edge.vert1 == v0 && edge.poly0 == edge.poly1 {
                        edge.poly1 = i as i32;
                        edge.poly_edge1 = j as i32;
                        break;
                    }
                    e = first_edge[next_edge + e as usize];
                }
            }
        }
    }

    // Store adjacency
    for i in 0..edge_count {
        let e = edges[i];
        if e.poly0 != e.poly1 {
            let p0 = e.poly0 as usize * nvp * 2;
            let p1 = e.poly1 as usize * nvp * 2;
            polys[p0 + nvp + e.poly_edge0 as usize] = e.poly1;
            polys[p1 + nvp + e.poly_edge1 as usize] = e.poly0;
        }
    }
}

fn compute_vertex_hash(x: i32, y: i32, z: i32) -> i32 {
    let h1: u32 = 0x8da6b343; // Large multiplicative constants;
    let h2: u32 = 0xd8163841; // here arbitrarily chosen primes
    let h3: u32 = 0xcb1ab31f;

    let n = h1
        .wrapping_mul(x as u32)
        .wrapping_add(h2.wrapping_mul(y as u32))
        .wrapping_add(h3.wrapping_mul(z as u32));
    (n & (VERTEX_BUCKET_COUNT as u32 - 1)) as i32
}

/// Finds the vertex at (x, y, z) (y within 2) or appends a new one; returns its index.
fn add_vertex(x: i32, y: i32, z: i32, verts: &mut [Int3], first_vert: &mut [i32], next_vert: &mut [i32], nv: &mut i32) -> i32 {
    let bucket = compute_vertex_hash(x, 0, z) as usize;
    let mut i = first_vert[bucket];

    while i != -1 {
        let v = verts[i as usize];
        if v.x == x && (v.y - y).abs() <= 2 && v.z == z {
            return i;
        }
        i = next_vert[i as usize]; // next
    }

    // Could not find, create new.
    i = *nv;
    *nv += 1;
    verts[i as usize] = Int3::new(x, y, z);
    next_vert[i as usize] = first_vert[bucket];
    first_vert[bucket] = i;

    i
}

// ------------------------------------------------------- polygon geometry

/// The previous index in a ring of `n`.
pub fn prev(i: i32, n: i32) -> i32 {
    if i - 1 >= 0 { i - 1 } else { n - 1 }
}

/// The next index in a ring of `n`.
pub fn next(i: i32, n: i32) -> i32 {
    if i + 1 < n { i + 1 } else { 0 }
}

// C# int arithmetic is unchecked: wrap like it.
fn area2(a: Int4, b: Int4, c: Int4) -> i32 {
    (b.x.wrapping_sub(a.x)).wrapping_mul(c.z.wrapping_sub(a.z)).wrapping_sub((c.x.wrapping_sub(a.x)).wrapping_mul(b.z.wrapping_sub(a.z)))
}

/// Returns true iff c is strictly to the left of the directed line through a to b.
pub fn left(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) < 0
}

/// Returns true iff c is left of or on the directed line through a to b.
pub fn left_on(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) <= 0
}

fn collinear(a: Int4, b: Int4, c: Int4) -> bool {
    area2(a, b, c) == 0
}

/// Returns true iff ab properly intersects cd: they share a point interior to both segments.
fn intersect_prop(a: Int4, b: Int4, c: Int4, d: Int4) -> bool {
    // Eliminate improper cases.
    if collinear(a, b, c) || collinear(a, b, d) || collinear(c, d, a) || collinear(c, d, b) {
        return false;
    }

    // C#: `Left(a,b,c) ^ Left(a,b,d) && Left(c,d,a) ^ Left(c,d,b)` (^ binds tighter than &&).
    (left(a, b, c) ^ left(a, b, d)) && (left(c, d, a) ^ left(c, d, b))
}

/// Returns true iff (a,b,c) are collinear and point c lies on the closed segment ab.
fn between(a: Int4, b: Int4, c: Int4) -> bool {
    if !collinear(a, b, c) {
        return false;
    }

    // If ab not vertical, check betweenness on x; else on z.
    if a.x != b.x {
        return (a.x <= c.x && c.x <= b.x) || (a.x >= c.x && c.x >= b.x);
    }

    (a.z <= c.z && c.z <= b.z) || (a.z >= c.z && c.z >= b.z)
}

/// Returns true iff segments ab and cd intersect, properly or improperly.
pub fn intersect(a: Int4, b: Int4, c: Int4, d: Int4) -> bool {
    if intersect_prop(a, b, c, d) {
        return true;
    }

    between(a, b, c) || between(a, b, d) || between(c, d, a) || between(c, d, b)
}

/// Whether two points have the same x and z.
pub fn v_equal(a: Int4, b: Int4) -> bool {
    a.x == b.x && a.z == b.z
}

#[inline]
fn pt(verts: &[Int4], indices: &[i32], k: i32) -> Int4 {
    verts[(indices[k as usize] & INDEX_MASK) as usize]
}

/// Returns true iff (v_i, v_j) is a proper internal *or* external diagonal of P, ignoring edges incident to v_i and v_j.
fn diagonalie(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    let d0 = pt(verts, indices, i);
    let d1 = pt(verts, indices, j);

    // For each edge (k,k+1) of P
    for k in 0..n {
        let k1 = next(k, n);
        // Skip edges incident to i or j
        if !(k == i || k1 == i || k == j || k1 == j) {
            let p0 = pt(verts, indices, k);
            let p1 = pt(verts, indices, k1);

            if v_equal(d0, p0) || v_equal(d1, p0) || v_equal(d0, p1) || v_equal(d1, p1) {
                continue;
            }

            if intersect(d0, d1, p0, p1) {
                return false;
            }
        }
    }

    true
}

/// Returns true iff the diagonal (i,j) is strictly internal to the polygon P in the neighborhood of the i endpoint.
fn in_cone(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    let pi = pt(verts, indices, i);
    let pj = pt(verts, indices, j);
    let pi1 = pt(verts, indices, next(i, n));
    let pin1 = pt(verts, indices, prev(i, n));

    // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
    if left_on(pin1, pi, pi1) {
        return left(pi, pj, pin1) && left(pj, pi, pi1);
    }

    // Assume (i-1,i,i+1) not collinear.
    // else P[i] is reflex.
    !(left_on(pi, pj, pi1) && left_on(pj, pi, pin1))
}

fn diagonal(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    in_cone(i, j, n, verts, indices) && diagonalie(i, j, n, verts, indices)
}

fn diagonalie_loose(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    let d0 = pt(verts, indices, i);
    let d1 = pt(verts, indices, j);

    // For each edge (k,k+1) of P
    for k in 0..n {
        let k1 = next(k, n);
        // Skip edges incident to i or j
        if !(k == i || k1 == i || k == j || k1 == j) {
            let p0 = pt(verts, indices, k);
            let p1 = pt(verts, indices, k1);

            if v_equal(d0, p0) || v_equal(d1, p0) || v_equal(d0, p1) || v_equal(d1, p1) {
                continue;
            }

            if intersect_prop(d0, d1, p0, p1) {
                return false;
            }
        }
    }

    true
}

fn in_cone_loose(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    let pi = pt(verts, indices, i);
    let pj = pt(verts, indices, j);
    let pi1 = pt(verts, indices, next(i, n));
    let pin1 = pt(verts, indices, prev(i, n));

    // If P[i] is a convex vertex [ i+1 left or on (i-1,i) ].
    if left_on(pin1, pi, pi1) {
        return left_on(pi, pj, pin1) && left_on(pj, pi, pi1);
    }

    // Assume (i-1,i,i+1) not collinear.
    // else P[i] is reflex.
    !(left_on(pi, pj, pi1) && left_on(pj, pi, pin1))
}

fn diagonal_loose(i: i32, j: i32, n: i32, verts: &[Int4], indices: &[i32]) -> bool {
    in_cone_loose(i, j, n, verts, indices) && diagonalie_loose(i, j, n, verts, indices)
}

/// Triangulates a polygon given as indices into `verts`. The top bit of each index marks a removable
/// vertex. Returns the triangle count, or -(triangles so far) if the contour is degenerate.
///
/// Deviation: a polygon of fewer than 3 vertices returns 0 (the C# would read past the end of the
/// index list there).
fn triangulate(mut n: i32, verts: &[Int4], indices: &mut [i32], tris: &mut [i32]) -> i32 {
    let mut ntris: i32 = 0;

    // The last bit of the index is used to indicate if the vertex can be removed.
    for i in 0..n {
        let i1 = next(i, n);
        let i2 = next(i1, n);
        if diagonal(i, i2, n, verts, indices) {
            indices[i1 as usize] |= i32::MIN;
        }
    }

    while n > 3 {
        let mut min_len: i32 = -1;
        let mut mini: i32 = -1;
        for min_idx in 0..n {
            let next_idx1 = next(min_idx, n);
            if (indices[next_idx1 as usize] & i32::MIN) != 0 {
                let p0 = pt(verts, indices, min_idx);
                let p2 = pt(verts, indices, next(next_idx1, n));

                let dx = p2.x.wrapping_sub(p0.x);
                let dy = p2.z.wrapping_sub(p0.z);
                let len = dx.wrapping_mul(dx).wrapping_add(dy.wrapping_mul(dy));

                if min_len < 0 || len < min_len {
                    min_len = len;
                    mini = min_idx;
                }
            }
        }

        if mini == -1 {
            // We might get here because the contour has overlapping segments.
            // We'll try to recover by loosing up the inCone test a bit so that a diagonal
            // like A-B or C-D can be found and we can continue.
            min_len = -1;
            mini = -1;
            for min_idx in 0..n {
                let next_idx1 = next(min_idx, n);
                let next_idx2 = next(next_idx1, n);
                if diagonal_loose(min_idx, next_idx2, n, verts, indices) {
                    let p0 = pt(verts, indices, min_idx);
                    let p2 = pt(verts, indices, next(next_idx2, n));
                    let dx = p2.x.wrapping_sub(p0.x);
                    let dy = p2.z.wrapping_sub(p0.z);
                    let len = dx.wrapping_mul(dx).wrapping_add(dy.wrapping_mul(dy));

                    if min_len < 0 || len < min_len {
                        min_len = len;
                        mini = min_idx;
                    }
                }
            }

            if mini == -1 {
                // The contour is messed up. This sometimes happens
                // if the contour simplification is too aggressive.
                return -ntris;
            }
        }

        let mut i = mini;
        let mut i1 = next(i, n);
        let i2 = next(i1, n);

        tris[(ntris * 3) as usize] = indices[i as usize] & INDEX_MASK;
        tris[(ntris * 3 + 1) as usize] = indices[i1 as usize] & INDEX_MASK;
        tris[(ntris * 3 + 2) as usize] = indices[i2 as usize] & INDEX_MASK;
        ntris += 1;

        // Removes P[i1] by copying P[i+1]...P[n-1] left one index.
        n -= 1;
        for k in i1..n {
            indices[k as usize] = indices[(k + 1) as usize];
        }

        if i1 >= n {
            i1 = 0;
        }
        i = prev(i1, n);
        // Update diagonal flags.
        if diagonal(prev(i, n), i1, n, verts, indices) {
            indices[i as usize] |= i32::MIN;
        } else {
            indices[i as usize] &= INDEX_MASK;
        }

        if diagonal(i, next(i1, n), n, verts, indices) {
            indices[i1 as usize] |= i32::MIN;
        } else {
            indices[i1 as usize] &= INDEX_MASK;
        }
    }

    if n < 3 {
        return -ntris;
    }

    // Append the remaining triangle.
    tris[(ntris * 3) as usize] = indices[0] & INDEX_MASK;
    tris[(ntris * 3 + 1) as usize] = indices[1] & INDEX_MASK;
    tris[(ntris * 3 + 2) as usize] = indices[2] & INDEX_MASK;
    ntris += 1;

    ntris
}

fn count_poly_verts(p: &[i32], j: usize, nvp: i32) -> i32 {
    for i in 0..nvp {
        if p[i as usize + j] == RC_MESH_NULL_IDX {
            return i;
        }
    }
    nvp
}

fn uleft(a: Int3, b: Int3, c: Int3) -> bool {
    (b.x.wrapping_sub(a.x)).wrapping_mul(c.z.wrapping_sub(a.z)).wrapping_sub((c.x.wrapping_sub(a.x)).wrapping_mul(b.z.wrapping_sub(a.z))) < 0
}

/// The merge value (the squared length of the shared edge) of polygons `pa` and `pb`, or -1 if they
/// can't merge; plus the shared edge's indices in each: `(value, ea, eb)`.
fn get_poly_merge_value(polys: &[i32], pa: usize, pb: usize, verts: &[Int3], nvp: i32) -> (i32, i32, i32) {
    let na = count_poly_verts(polys, pa, nvp);
    let nb = count_poly_verts(polys, pb, nvp);

    // If the merged polygon would be too big, do not merge.
    if na + nb - 2 > nvp {
        return (-1, 0, 0);
    }

    let mut ea: i32 = -1;
    let mut eb: i32 = -1;

    // Check if the polygons share an edge.
    for i in 0..na {
        let mut va0 = polys[pa + i as usize];
        let mut va1 = polys[pa + ((i + 1) % na) as usize];
        if va0 > va1 {
            std::mem::swap(&mut va0, &mut va1);
        }

        for j in 0..nb {
            let mut vb0 = polys[pb + j as usize];
            let mut vb1 = polys[pb + ((j + 1) % nb) as usize];
            if vb0 > vb1 {
                std::mem::swap(&mut vb0, &mut vb1);
            }

            if va0 == vb0 && va1 == vb1 {
                ea = i;
                eb = j;
                break;
            }
        }
    }

    // No common edge, cannot merge.
    if ea == -1 || eb == -1 {
        return (-1, ea, eb);
    }

    // Check to see if the merged polygon would be convex.
    let mut va = polys[pa + ((ea + na - 1) % na) as usize];
    let mut vb = polys[pa + ea as usize];
    let mut vc = polys[pb + ((eb + 2) % nb) as usize];
    if !uleft(verts[va as usize], verts[vb as usize], verts[vc as usize]) {
        return (-1, ea, eb);
    }

    va = polys[pb + ((eb + nb - 1) % nb) as usize];
    vb = polys[pb + eb as usize];
    vc = polys[pa + ((ea + 2) % na) as usize];
    if !uleft(verts[va as usize], verts[vb as usize], verts[vc as usize]) {
        return (-1, ea, eb);
    }

    va = polys[pa + ea as usize];
    vb = polys[pa + ((ea + 1) % na) as usize];

    let dx = verts[va as usize].x.wrapping_sub(verts[vb as usize].x);
    let dy = verts[va as usize].z.wrapping_sub(verts[vb as usize].z);

    (dx.wrapping_mul(dx).wrapping_add(dy.wrapping_mul(dy)), ea, eb)
}

fn merge_poly_verts(polys: &mut [i32], pa: usize, pb: usize, ea: i32, eb: i32, tmp: usize, nvp: i32) {
    let na = count_poly_verts(polys, pa, nvp);
    let nb = count_poly_verts(polys, pb, nvp);

    // Merge polygons.
    fill_ints(polys, RC_MESH_NULL_IDX, tmp, nvp as usize);
    let mut n: usize = 0;

    // Add pa
    for i in 0..na - 1 {
        polys[tmp + n] = polys[pa + ((ea + 1 + i) % na) as usize];
        n += 1;
    }

    // Add pb
    for i in 0..nb - 1 {
        polys[tmp + n] = polys[pb + ((eb + 1 + i) % nb) as usize];
        n += 1;
    }

    copy_ints_within(polys, tmp, pa, nvp as usize);
}

fn push_front(v: i32, arr: &mut [i32], mut an: i32) -> i32 {
    an += 1;
    let mut i = an - 1;
    while i > 0 {
        arr[i as usize] = arr[(i - 1) as usize];
        i -= 1;
    }
    arr[0] = v;
    an
}

fn push_back(v: i32, arr: &mut [i32], mut an: i32) -> i32 {
    arr[an as usize] = v;
    an += 1;
    an
}

// -------------------------------------------------------- vertex removal

fn can_remove_vertex(mesh: &RcPolyMesh, rem: i32) -> bool {
    let nvp = mesh.nvp;

    // Count number of polygons to remove.
    let mut num_touched_verts = 0;
    let mut num_remaining_edges = 0;
    for i in 0..mesh.npolys as usize {
        let p = i * nvp as usize * 2;
        let nv = count_poly_verts(&mesh.polys, p, nvp);
        let mut num_removed = 0;
        let mut num_verts = 0;
        for j in 0..nv as usize {
            if mesh.polys[p + j] == rem {
                num_touched_verts += 1;
                num_removed += 1;
            }

            num_verts += 1;
        }

        if num_removed != 0 {
            num_remaining_edges += num_verts - (num_removed + 1);
        }
    }

    // There would be too few edges remaining to create a polygon.
    // This can happen for example when a tip of a triangle is marked
    // as deletion, but there are no other polys that share the vertex.
    // In this case, the vertex should not be removed.
    if num_remaining_edges <= 2 {
        return false;
    }

    // Find edges which share the removed vertex.
    let max_edges = num_touched_verts * 2;
    let mut nedges = 0usize;
    let mut edges = vec![0i32; (max_edges * 3) as usize];

    for i in 0..mesh.npolys as usize {
        let p = i * nvp as usize * 2;
        let nv = count_poly_verts(&mesh.polys, p, nvp) as usize;

        // Collect edges which touches the removed vertex.
        let mut j = 0usize;
        let mut k = nv.wrapping_sub(1);
        while j < nv {
            if mesh.polys[p + j] == rem || mesh.polys[p + k] == rem {
                // Arrange edge so that a=rem.
                let mut a = mesh.polys[p + j];
                let mut b = mesh.polys[p + k];
                if b == rem {
                    std::mem::swap(&mut a, &mut b);
                }

                // Check if the edge exists
                let mut exists = false;
                for m in 0..nedges {
                    let e = m * 3;
                    if edges[e + 1] == b {
                        // Exists, increment vertex share count.
                        edges[e + 2] += 1;
                        exists = true;
                    }
                }

                // Add new edge.
                if !exists {
                    let e = nedges * 3;
                    edges[e] = a;
                    edges[e + 1] = b;
                    edges[e + 2] = 1;
                    nedges += 1;
                }
            }
            k = j;
            j += 1;
        }
    }

    // There should be no more than 2 open edges.
    // This catches the case that two non-adjacent polygons
    // share the removed vertex. In that case, do not remove the vertex.
    let mut num_open_edges = 0;
    for i in 0..nedges {
        if edges[i * 3 + 2] < 2 {
            num_open_edges += 1;
        }
    }

    num_open_edges <= 2
}

/// Removes vertex `rem`, retriangulating the hole it leaves. Returns false if the polygon budget was exceeded.
fn remove_vertex(mesh: &mut RcPolyMesh, rem: i32, max_tris: i32) -> bool {
    let nvp = mesh.nvp;
    let nvpu = nvp as usize;

    // Count number of polygons to remove.
    let mut num_removed_verts: i32 = 0;
    for i in 0..mesh.npolys as usize {
        let p = i * nvpu * 2;
        let nv = count_poly_verts(&mesh.polys, p, nvp);
        for j in 0..nv as usize {
            if mesh.polys[p + j] == rem {
                num_removed_verts += 1;
            }
        }
    }

    let mut nedges: i32 = 0;
    let mut edges = vec![0i32; (num_removed_verts * nvp * 4) as usize];

    let mut nhole: i32 = 0;
    let mut hole = vec![0i32; (num_removed_verts * nvp) as usize];

    let mut nhreg: i32 = 0;
    let mut hreg = vec![0i32; (num_removed_verts * nvp) as usize];

    let mut nharea: i32 = 0;
    let mut harea = vec![0i32; (num_removed_verts * nvp) as usize];

    let mut i: i32 = 0;
    while i < mesh.npolys {
        let p = i as usize * nvpu * 2;
        let nv = count_poly_verts(&mesh.polys, p, nvp);
        let mut has_rem = false;
        for j in 0..nv as usize {
            if mesh.polys[p + j] == rem {
                has_rem = true;
            }
        }

        if has_rem {
            // Collect edges which does not touch the removed vertex.
            let mut j = 0i32;
            let mut k = nv - 1;
            while j < nv {
                if mesh.polys[p + j as usize] != rem && mesh.polys[p + k as usize] != rem {
                    let e = (nedges * 4) as usize;
                    edges[e] = mesh.polys[p + k as usize];
                    edges[e + 1] = mesh.polys[p + j as usize];
                    edges[e + 2] = mesh.regs[i as usize];
                    edges[e + 3] = mesh.areas[i as usize];
                    nedges += 1;
                }
                k = j;
                j += 1;
            }

            // Remove the polygon.
            let p2 = (mesh.npolys - 1) as usize * nvpu * 2;
            if p != p2 {
                copy_ints_within(&mut mesh.polys, p2, p, nvpu);
            }

            fill_ints(&mut mesh.polys, RC_MESH_NULL_IDX, p + nvpu, nvpu);
            mesh.regs[i as usize] = mesh.regs[(mesh.npolys - 1) as usize];
            mesh.areas[i as usize] = mesh.areas[(mesh.npolys - 1) as usize];
            mesh.npolys -= 1;
            i -= 1;
        }
        i += 1;
    }

    // Remove vertex.
    let mut i = rem;
    while i < mesh.nverts - 1 {
        mesh.verts[i as usize] = mesh.verts[(i + 1) as usize];
        i += 1;
    }

    mesh.nverts -= 1;

    // Adjust indices to match the removed vertex layout.
    for i in 0..mesh.npolys as usize {
        let p = i * nvpu * 2;
        let nv = count_poly_verts(&mesh.polys, p, nvp);
        for j in 0..nv as usize {
            if mesh.polys[p + j] > rem {
                mesh.polys[p + j] -= 1;
            }
        }
    }

    for i in 0..nedges as usize {
        if edges[i * 4] > rem {
            edges[i * 4] -= 1;
        }
        if edges[i * 4 + 1] > rem {
            edges[i * 4 + 1] -= 1;
        }
    }

    if nedges == 0 {
        return true;
    }

    // Start with one vertex, keep appending connected
    // segments to the start and end of the hole.
    nhole = push_back(edges[0], &mut hole, nhole);
    nhreg = push_back(edges[2], &mut hreg, nhreg);
    nharea = push_back(edges[3], &mut harea, nharea);

    while nedges != 0 {
        let mut matched = false;

        let mut i = 0i32;
        while i < nedges {
            let iu = i as usize;
            let ea = edges[iu * 4];
            let eb = edges[iu * 4 + 1];
            let r = edges[iu * 4 + 2];
            let a = edges[iu * 4 + 3];
            let mut add = false;
            if hole[0] == eb {
                // The segment matches the beginning of the hole boundary.
                nhole = push_front(ea, &mut hole, nhole);
                nhreg = push_front(r, &mut hreg, nhreg);
                nharea = push_front(a, &mut harea, nharea);
                add = true;
            } else if hole[(nhole - 1) as usize] == ea {
                // The segment matches the end of the hole boundary.
                nhole = push_back(eb, &mut hole, nhole);
                nhreg = push_back(r, &mut hreg, nhreg);
                nharea = push_back(a, &mut harea, nharea);
                add = true;
            }

            if add {
                // The edge segment was added, remove it.
                let last = (nedges - 1) as usize;
                edges[iu * 4] = edges[last * 4];
                edges[iu * 4 + 1] = edges[last * 4 + 1];
                edges[iu * 4 + 2] = edges[last * 4 + 2];
                edges[iu * 4 + 3] = edges[last * 4 + 3];
                nedges -= 1;
                matched = true;
                i -= 1;
            }
            i += 1;
        }

        if !matched {
            break;
        }
    }

    let mut tris = vec![0i32; (nhole * 3) as usize];
    let mut tverts = vec![Int4::default(); nhole as usize];
    let mut thole = vec![0i32; nhole as usize];

    // Generate temp vertex array for triangulation.
    for i in 0..nhole as usize {
        let v = mesh.verts[hole[i] as usize];
        tverts[i] = Int4::new(v.x, v.y, v.z, 0);
        thole[i] = i as i32;
    }

    // Triangulate the hole.
    let mut ntris = triangulate(nhole, &tverts, &mut thole, &mut tris);
    if ntris < 0 {
        ntris = -ntris;
        mesh.triangulation_warnings += 1; // "removeVertex: Triangulate() returned bad results."
    }

    // Merge the hole triangles back to polygons.
    let mut polys = vec![0i32; ((ntris + 1) * nvp) as usize];
    let mut pregs = vec![0i32; ntris as usize];
    let mut pareas = vec![0i32; ntris as usize];

    let tmp_poly = (ntris * nvp) as usize;

    // Build initial polygons.
    let mut npolys: i32 = 0;
    fill_ints(&mut polys, RC_MESH_NULL_IDX, 0, (ntris * nvp) as usize);
    for j in 0..ntris as usize {
        let t = j * 3;
        if tris[t] != tris[t + 1] && tris[t] != tris[t + 2] && tris[t + 1] != tris[t + 2] {
            let np = npolys as usize;
            polys[np * nvpu] = hole[tris[t] as usize];
            polys[np * nvpu + 1] = hole[tris[t + 1] as usize];
            polys[np * nvpu + 2] = hole[tris[t + 2] as usize];

            // If this polygon covers multiple region types then mark it as such
            if hreg[tris[t] as usize] != hreg[tris[t + 1] as usize] || hreg[tris[t + 1] as usize] != hreg[tris[t + 2] as usize] {
                pregs[np] = RC_MULTIPLE_REGS;
            } else {
                pregs[np] = hreg[tris[t] as usize];
            }

            pareas[np] = harea[tris[t] as usize];
            npolys += 1;
        }
    }

    let mut ok = true;

    if npolys > 0 {
        // Merge polygons.
        if nvp > 3 {
            loop {
                // Find best polygons to merge.
                let mut best_merge_val = 0;
                let (mut best_pa, mut best_pb, mut best_ea, mut best_eb) = (0usize, 0usize, 0i32, 0i32);

                for j in 0..(npolys - 1).max(0) as usize {
                    let pj = j * nvpu;
                    for k in j + 1..npolys as usize {
                        let pk = k * nvpu;
                        let (v, ea, eb) = get_poly_merge_value(&polys, pj, pk, &mesh.verts, nvp);
                        if v > best_merge_val {
                            best_merge_val = v;
                            best_pa = j;
                            best_pb = k;
                            best_ea = ea;
                            best_eb = eb;
                        }
                    }
                }

                if best_merge_val > 0 {
                    // Found best, merge.
                    let pa = best_pa * nvpu;
                    let pb = best_pb * nvpu;
                    merge_poly_verts(&mut polys, pa, pb, best_ea, best_eb, tmp_poly, nvp);
                    if pregs[best_pa] != pregs[best_pb] {
                        pregs[best_pa] = RC_MULTIPLE_REGS;
                    }
                    let last = (npolys - 1) as usize * nvpu;
                    if pb != last {
                        copy_ints_within(&mut polys, last, pb, nvpu);
                    }

                    pregs[best_pb] = pregs[(npolys - 1) as usize];
                    pareas[best_pb] = pareas[(npolys - 1) as usize];
                    npolys -= 1;
                } else {
                    // Could not merge any polygons, stop.
                    break;
                }
            }
        }

        // Store polygons.
        for i in 0..npolys as usize {
            if mesh.npolys >= max_tris {
                break;
            }
            let p = mesh.npolys as usize * nvpu * 2;
            fill_ints(&mut mesh.polys, RC_MESH_NULL_IDX, p, nvpu * 2);
            for j in 0..nvpu {
                mesh.polys[p + j] = polys[i * nvpu + j];
            }
            mesh.regs[mesh.npolys as usize] = pregs[i];
            mesh.areas[mesh.npolys as usize] = pareas[i];
            mesh.npolys += 1;
            if mesh.npolys > max_tris {
                ok = false; // "removeVertex: Too many polygons"
                break;
            }
        }
    }

    ok
}

// ------------------------------------------------------------ mesh building

/// Port of rcBuildPolyMesh. `nvp` must be at most DT_VERTS_PER_POLYGON if the mesh feeds Detour.
/// On failure the returned mesh is the default (empty) one.
pub fn build_poly_mesh(cset: &RcContourSet, nvp: i32) -> (RcPolyMeshStatus, RcPolyMesh) {
    let mut mesh = RcPolyMesh {
        bmin: cset.bmin,
        bmax: cset.bmax,
        cs: cset.cs,
        ch: cset.ch,
        border_size: cset.border_size,
        max_edge_error: cset.max_error,
        ..RcPolyMesh::default()
    };

    let mut max_vertices: i32 = 0;
    let mut max_tris: i32 = 0;
    let mut max_verts_per_cont: i32 = 0;
    for cont in &cset.conts {
        let cn = cont.nverts() as i32;

        // Skip null contours.
        if cn < 3 {
            continue;
        }
        max_vertices += cn;
        max_tris += cn - 2;
        max_verts_per_cont = max_verts_per_cont.max(cn);
    }

    if max_vertices >= 0xfffe {
        return (RcPolyMeshStatus::TooManyContourVertices, RcPolyMesh::default());
    }

    let nvpu = nvp as usize;
    let mut vflags = vec![0i32; max_vertices as usize];

    mesh.verts = vec![Int3::default(); max_vertices as usize];
    mesh.polys = vec![RC_MESH_NULL_IDX; (max_tris * nvp * 2) as usize];
    mesh.regs = vec![0i32; max_tris as usize];
    mesh.areas = vec![0i32; max_tris as usize];

    mesh.nverts = 0;
    mesh.npolys = 0;
    mesh.nvp = nvp;
    mesh.maxpolys = max_tris;

    let mut next_vert = vec![0i32; max_vertices as usize];

    let mut first_vert = vec![-1i32; VERTEX_BUCKET_COUNT as usize];

    let mut indices = vec![0i32; max_verts_per_cont as usize];
    let mut tris = vec![0i32; (max_verts_per_cont * 3) as usize];
    let mut polys = vec![0i32; ((max_verts_per_cont + 1) * nvp) as usize];

    let tmp_poly = (max_verts_per_cont * nvp) as usize;

    let mut status = RcPolyMeshStatus::Success;

    let mut i = 0usize;
    while i < cset.conts.len() && status == RcPolyMeshStatus::Success {
        let cont = &cset.conts[i];
        i += 1;
        let cn = cont.nverts() as i32;

        // Skip null contours.
        if cn < 3 {
            continue;
        }

        // Triangulate contour
        for j in 0..cn {
            indices[j as usize] = j;
        }

        let mut ntris = triangulate(cn, &cont.verts, &mut indices, &mut tris);
        if ntris <= 0 {
            // Bad triangulation, should not happen.
            mesh.triangulation_warnings += 1; // "BuildPolyMesh: Bad triangulation Contour {i}."
            ntris = -ntris;
        }

        // Add and merge vertices.
        for j in 0..cn as usize {
            let v = cont.verts[j];
            indices[j] = add_vertex(v.x, v.y, v.z, &mut mesh.verts, &mut first_vert, &mut next_vert, &mut mesh.nverts);

            if (v.w & RC_BORDER_VERTEX) != 0 {
                // This vertex should be removed.
                vflags[indices[j] as usize] = 1;
            }
        }

        // Build initial polygons.
        let mut npolys: i32 = 0;
        let polys_len = polys.len();
        fill_ints(&mut polys, RC_MESH_NULL_IDX, 0, polys_len);
        for j in 0..ntris as usize {
            let t = j * 3;
            if tris[t] != tris[t + 1] && tris[t] != tris[t + 2] && tris[t + 1] != tris[t + 2] {
                let np = npolys as usize;
                polys[np * nvpu] = indices[tris[t] as usize];
                polys[np * nvpu + 1] = indices[tris[t + 1] as usize];
                polys[np * nvpu + 2] = indices[tris[t + 2] as usize];
                npolys += 1;
            }
        }

        if npolys == 0 {
            continue;
        }

        // Merge polygons.
        if nvp > 3 {
            loop {
                // Find best polygons to merge.
                let mut best_merge_val = 0;
                let (mut best_pa, mut best_pb, mut best_ea, mut best_eb) = (0usize, 0usize, 0i32, 0i32);

                for j in 0..(npolys - 1).max(0) as usize {
                    let pj = j * nvpu;
                    for k in j + 1..npolys as usize {
                        let pk = k * nvpu;
                        let (v, ea, eb) = get_poly_merge_value(&polys, pj, pk, &mesh.verts, nvp);
                        if v > best_merge_val {
                            best_merge_val = v;
                            best_pa = j;
                            best_pb = k;
                            best_ea = ea;
                            best_eb = eb;
                        }
                    }
                }

                if best_merge_val > 0 {
                    // Found best, merge.
                    let pa = best_pa * nvpu;
                    let pb = best_pb * nvpu;
                    merge_poly_verts(&mut polys, pa, pb, best_ea, best_eb, tmp_poly, nvp);
                    let last_poly = (npolys - 1) as usize * nvpu;
                    if pb != last_poly {
                        copy_ints_within(&mut polys, last_poly, pb, nvpu);
                    }

                    npolys -= 1;
                } else {
                    // Could not merge any polygons, stop.
                    break;
                }
            }
        }

        // Store polygons.
        for j in 0..npolys as usize {
            if mesh.npolys >= max_tris {
                status = RcPolyMeshStatus::TooManyPolygons; // "Too many polygons (max:maxTris)"
                break;
            }

            let p = mesh.npolys as usize * nvpu * 2;
            let q = j * nvpu;
            for k in 0..nvpu {
                mesh.polys[p + k] = polys[q + k];
            }
            mesh.regs[mesh.npolys as usize] = cont.reg;
            mesh.areas[mesh.npolys as usize] = cont.area;
            mesh.npolys += 1;
        }
    }

    // Remove edge vertices.
    let mut i: i32 = 0;
    while i < mesh.nverts && status == RcPolyMeshStatus::Success {
        if vflags[i as usize] != 0 {
            if !can_remove_vertex(&mesh, i) {
                i += 1;
                continue;
            }

            if !remove_vertex(&mut mesh, i, max_tris) {
                status = RcPolyMeshStatus::TooManyPolygons;
                break;
            }

            // Remove vertex
            // Note: mesh.nverts is already decremented inside RemoveVertex()!
            // Fixup vertex flags
            for j in i..mesh.nverts {
                vflags[j as usize] = vflags[(j + 1) as usize];
            }
            i -= 1;
        }
        i += 1;
    }

    if status != RcPolyMeshStatus::Success {
        return (status, RcPolyMesh::default());
    }

    // Calculate adjacency.
    build_mesh_adjacency(&mut mesh.polys, mesh.npolys, mesh.nverts, nvp);

    // Find portal edges
    if mesh.border_size > 0 {
        let w = cset.width;
        let h = cset.height;
        for i in 0..mesh.npolys as usize {
            let p = i * 2 * nvpu;
            for j in 0..nvpu {
                if mesh.polys[p + j] == RC_MESH_NULL_IDX {
                    break;
                }
                // Skip connected edges.
                if mesh.polys[p + nvpu + j] != RC_MESH_NULL_IDX {
                    continue;
                }
                let mut nj = j + 1;
                if nj >= nvpu || mesh.polys[p + nj] == RC_MESH_NULL_IDX {
                    nj = 0;
                }
                let va = mesh.verts[mesh.polys[p + j] as usize];
                let vb = mesh.verts[mesh.polys[p + nj] as usize];

                if va.x == 0 && vb.x == 0 {
                    mesh.polys[p + nvpu + j] = 0x8000;
                } else if va.z == h && vb.z == h {
                    mesh.polys[p + nvpu + j] = 0x8000 | 1;
                } else if va.x == w && vb.x == w {
                    mesh.polys[p + nvpu + j] = 0x8000 | 2;
                } else if va.z == 0 && vb.z == 0 {
                    mesh.polys[p + nvpu + j] = 0x8000 | 3;
                }
            }
        }
    }

    // Just allocate the mesh flags array. The user is resposible to fill it.
    mesh.flags = vec![0i32; mesh.npolys as usize];

    if mesh.nverts > MAX_MESH_VERTS_POLY {
        return (RcPolyMeshStatus::TooManyMeshVertices, RcPolyMesh::default());
    }

    if mesh.npolys > MAX_MESH_VERTS_POLY {
        return (RcPolyMeshStatus::TooManyMeshPolygons, RcPolyMesh::default());
    }

    (RcPolyMeshStatus::Success, mesh)
}

/// Port of rcMergePolyMeshes: merges the first `nmeshes` meshes into one, welding shared vertices and
/// rebuilding adjacency (portal edges survive only on the merged mesh's outer border).
pub fn merge_poly_meshes(meshes: &[RcPolyMesh], nmeshes: usize) -> (RcPolyMeshStatus, RcPolyMesh) {
    if nmeshes == 0 || meshes.len() < nmeshes {
        return (RcPolyMeshStatus::NoMeshes, RcPolyMesh::default());
    }

    let mut mesh = RcPolyMesh {
        nvp: meshes[0].nvp,
        cs: meshes[0].cs,
        ch: meshes[0].ch,
        bmin: meshes[0].bmin,
        bmax: meshes[0].bmax,
        ..RcPolyMesh::default()
    };

    let mut max_verts: i32 = 0;
    let mut max_polys: i32 = 0;
    let mut max_verts_per_mesh: i32 = 0;
    for m in &meshes[..nmeshes] {
        mesh.bmin = mesh.bmin.min_v(m.bmin);
        mesh.bmax = mesh.bmax.max_v(m.bmax);
        max_verts_per_mesh = max_verts_per_mesh.max(m.nverts);
        max_verts += m.nverts;
        max_polys += m.npolys;
    }

    let nvp = mesh.nvp;
    let nvpu = nvp as usize;

    mesh.nverts = 0;
    mesh.verts = vec![Int3::default(); max_verts as usize];

    mesh.npolys = 0;
    mesh.polys = vec![RC_MESH_NULL_IDX; (max_polys * 2 * nvp) as usize];
    mesh.regs = vec![0i32; max_polys as usize];
    mesh.areas = vec![0i32; max_polys as usize];
    mesh.flags = vec![0i32; max_polys as usize];

    let mut next_vert = vec![0i32; max_verts as usize];

    let mut first_vert = vec![-1i32; VERTEX_BUCKET_COUNT as usize];

    let mut vremap = vec![0i32; max_verts_per_mesh as usize];

    for pmesh in &meshes[..nmeshes] {
        let ox = nav_math::math::floor((pmesh.bmin.x - mesh.bmin.x) / mesh.cs + 0.5f32) as i32;
        let oz = nav_math::math::floor((pmesh.bmin.z - mesh.bmin.z) / mesh.cs + 0.5f32) as i32;

        let is_min_x = ox == 0;
        let is_min_z = oz == 0;
        let is_max_x = nav_math::math::floor((mesh.bmax.x - pmesh.bmax.x) / mesh.cs + 0.5f32) == 0.0;
        let is_max_z = nav_math::math::floor((mesh.bmax.z - pmesh.bmax.z) / mesh.cs + 0.5f32) == 0.0;
        let is_on_border = is_min_x || is_min_z || is_max_x || is_max_z;

        for j in 0..pmesh.nverts as usize {
            let v = pmesh.verts[j];
            vremap[j] = add_vertex(v.x + ox, v.y, v.z + oz, &mut mesh.verts, &mut first_vert, &mut next_vert, &mut mesh.nverts);
        }

        for j in 0..pmesh.npolys as usize {
            let tgt = mesh.npolys as usize * 2 * nvpu;
            let src = j * 2 * nvpu;
            mesh.regs[mesh.npolys as usize] = pmesh.regs[j];
            mesh.areas[mesh.npolys as usize] = pmesh.areas[j];
            mesh.flags[mesh.npolys as usize] = pmesh.flags[j];
            mesh.npolys += 1;
            for k in 0..nvpu {
                if pmesh.polys[src + k] == RC_MESH_NULL_IDX {
                    break;
                }
                mesh.polys[tgt + k] = vremap[pmesh.polys[src + k] as usize];
            }

            if is_on_border {
                for k in nvpu..nvpu * 2 {
                    if (pmesh.polys[src + k] & 0x8000) != 0 && pmesh.polys[src + k] != 0xffff {
                        let dir = pmesh.polys[src + k] & 0xf;
                        match dir {
                            0 => {
                                // Portal x-
                                if is_min_x {
                                    mesh.polys[tgt + k] = pmesh.polys[src + k];
                                }
                            }
                            1 => {
                                // Portal z+
                                if is_max_z {
                                    mesh.polys[tgt + k] = pmesh.polys[src + k];
                                }
                            }
                            2 => {
                                // Portal x+
                                if is_max_x {
                                    mesh.polys[tgt + k] = pmesh.polys[src + k];
                                }
                            }
                            3 => {
                                // Portal z-
                                if is_min_z {
                                    mesh.polys[tgt + k] = pmesh.polys[src + k];
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    // Calculate adjacency.
    build_mesh_adjacency(&mut mesh.polys, mesh.npolys, mesh.nverts, nvp);

    if mesh.nverts > MAX_MESH_VERTS_POLY {
        return (RcPolyMeshStatus::TooManyMeshVertices, RcPolyMesh::default());
    }

    if mesh.npolys > MAX_MESH_VERTS_POLY {
        return (RcPolyMeshStatus::TooManyMeshPolygons, RcPolyMesh::default());
    }

    (RcPolyMeshStatus::Success, mesh)
}

/// Port of CopyPolyMesh. The copy is trimmed to the used counts.
pub fn copy_poly_mesh(src: &RcPolyMesh) -> RcPolyMesh {
    let mut dst = RcPolyMesh {
        nverts: src.nverts,
        npolys: src.npolys,
        maxpolys: src.npolys,
        nvp: src.nvp,
        bmin: src.bmin,
        bmax: src.bmax,
        cs: src.cs,
        ch: src.ch,
        border_size: src.border_size,
        max_edge_error: src.max_edge_error,
        ..RcPolyMesh::default()
    };

    dst.verts = src.verts[..src.nverts as usize].to_vec();

    let poly_count = (src.npolys * 2 * src.nvp) as usize;
    dst.polys = src.polys[..poly_count].to_vec();

    let n = src.npolys as usize;
    dst.regs = src.regs[..n].to_vec();
    dst.areas = src.areas[..n].to_vec();
    dst.flags = src.flags[..n].to_vec();

    dst
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::types::RcContour;
    use nav_math::Float3;

    /// A contour of (x, z) points at height y (counter-clockwise as Recast emits: area2 < 0 is left).
    pub(crate) fn contour(reg: i32, pts: &[(i32, i32)], y: i32) -> RcContour {
        RcContour { reg, area: 63, verts: pts.iter().map(|&(x, z)| Int4::new(x, y, z, 0)).collect(), rverts: Vec::new() }
    }

    pub(crate) fn cset_of(conts: Vec<RcContour>, w: i32, h: i32) -> RcContourSet {
        RcContourSet {
            conts,
            bmin: Float3::new(0.0, 0.0, 0.0),
            bmax: Float3::new(w as f32, 10.0, h as f32),
            cs: 1.0,
            ch: 0.5,
            width: w,
            height: h,
            border_size: 0,
            max_error: 1.3,
            merge_hole_failures: 0,
        }
    }

    /// Recast contours wind so that the interior is on the right in (x, z): clockwise seen with x right, z up.
    const SQUARE: [(i32, i32); 4] = [(0, 0), (0, 4), (4, 4), (4, 0)];

    fn poly_verts(mesh: &RcPolyMesh, i: usize) -> Vec<i32> {
        let nvp = mesh.nvp as usize;
        mesh.polys[i * nvp * 2..i * nvp * 2 + nvp].iter().cloned().take_while(|&v| v != RC_MESH_NULL_IDX).collect()
    }

    fn poly_area2(mesh: &RcPolyMesh, i: usize) -> i32 {
        let pv = poly_verts(mesh, i);
        let mut a = 0;
        for k in 0..pv.len() {
            let p = mesh.verts[pv[k] as usize];
            let q = mesh.verts[pv[(k + 1) % pv.len()] as usize];
            a += p.x * q.z - q.x * p.z;
        }
        a
    }

    #[test]
    fn convex_contour_is_one_polygon() {
        let cset = cset_of(vec![contour(1, &SQUARE, 2)], 8, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(mesh.npolys, 1);
        assert_eq!(mesh.nverts, 4);
        assert_eq!(poly_verts(&mesh, 0).len(), 4);
        assert_eq!(mesh.regs[0], 1);
        assert_eq!(mesh.areas[0], 63);
        assert_eq!(mesh.flags.len(), 1);
        // No neighbours.
        assert!(mesh.polys[6..12].iter().all(|&n| n == RC_MESH_NULL_IDX));
        assert_eq!(mesh.triangulation_warnings, 0);
    }

    #[test]
    fn nvp3_keeps_triangles() {
        let cset = cset_of(vec![contour(1, &SQUARE, 2)], 8, 8);
        let (status, mesh) = build_poly_mesh(&cset, 3);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(mesh.npolys, 2);
        // The two triangles are neighbours across the diagonal.
        let nvp = 3usize;
        let n0: Vec<i32> = mesh.polys[nvp..nvp * 2].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        let n1: Vec<i32> = mesh.polys[nvp * 3..nvp * 4].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        assert_eq!(n0, vec![1]);
        assert_eq!(n1, vec![0]);
    }

    #[test]
    fn concave_l_triangulates_and_merges() {
        // L shape: 6 vertices, concave at (2,2).
        let l = [(0, 0), (0, 4), (2, 4), (2, 2), (4, 2), (4, 0)];
        let cset = cset_of(vec![contour(1, &l, 2)], 8, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(mesh.nverts, 6);
        // 4 triangles merge into convex pieces: at least 2 polygons (concave), fewer than 4 triangles.
        assert!(mesh.npolys >= 2 && mesh.npolys < 4, "npolys {}", mesh.npolys);
        let mut total = 0;
        for i in 0..mesh.npolys as usize {
            assert!(poly_verts(&mesh, i).len() <= 6);
            total += poly_area2(&mesh, i).abs();
        }
        // Area of the L is 12, so twice that.
        assert_eq!(total, 24);
        // Adjacent pieces know each other.
        let nvp = 6usize;
        assert!(mesh.polys[nvp..nvp * 2].iter().any(|&n| n != RC_MESH_NULL_IDX));
        assert_eq!(mesh.triangulation_warnings, 0);
    }

    #[test]
    fn l_with_nvp3_has_four_triangles() {
        let l = [(0, 0), (0, 4), (2, 4), (2, 2), (4, 2), (4, 0)];
        let cset = cset_of(vec![contour(1, &l, 2)], 8, 8);
        let (_, mesh) = build_poly_mesh(&cset, 3);
        assert_eq!(mesh.npolys, 4);
        for i in 0..4 {
            assert_eq!(poly_verts(&mesh, i).len(), 3);
        }
    }

    #[test]
    fn border_vertex_removal_merges_hole() {
        // A square whose edge midpoint vertex (4,2) is flagged as a tile-border vertex: it is removed and
        // the hole is retriangulated, merging back to a single quad.
        let mut c = contour(1, &[(0, 0), (0, 4), (4, 4), (4, 2), (4, 0)], 2);
        c.verts[3].w = RC_BORDER_VERTEX;
        let cset = cset_of(vec![c], 8, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(mesh.nverts, 4);
        assert_eq!(mesh.npolys, 1);
        assert_eq!(poly_verts(&mesh, 0).len(), 4);
        assert_eq!(poly_area2(&mesh, 0).abs(), 32);
    }

    #[test]
    fn border_vertex_shared_by_two_contours_is_removed_and_polys_merge() {
        // Two squares side by side sharing the edge x=4 with a flagged vertex (4,2) in both.
        let mut a = contour(1, &[(0, 0), (0, 4), (4, 4), (4, 2), (4, 0)], 2);
        a.verts[3].w = RC_BORDER_VERTEX;
        let mut b = contour(2, &[(4, 0), (4, 2), (4, 4), (8, 4), (8, 0)], 2);
        b.verts[1].w = RC_BORDER_VERTEX;
        let cset = cset_of(vec![a, b], 12, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        // (4,2) is gone.
        assert_eq!(mesh.nverts, 6);
        assert!((0..mesh.nverts as usize).all(|i| !(mesh.verts[i].x == 4 && mesh.verts[i].z == 2)));
        // The area is conserved (twice 16, doubled).
        let total: i32 = (0..mesh.npolys as usize).map(|i| poly_area2(&mesh, i).abs()).sum();
        assert_eq!(total, 64);
    }

    #[test]
    fn adjacency_across_two_contours() {
        let a = contour(1, &[(0, 0), (0, 4), (4, 4), (4, 0)], 2);
        let b = contour(2, &[(4, 0), (4, 4), (8, 4), (8, 0)], 2);
        let cset = cset_of(vec![a, b], 12, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(mesh.npolys, 2);
        assert_eq!(mesh.nverts, 6);
        let nvp = 6usize;
        let n0: Vec<i32> = mesh.polys[nvp..nvp * 2].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        let n1: Vec<i32> = mesh.polys[nvp * 3..nvp * 4].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        assert_eq!(n0, vec![1]);
        assert_eq!(n1, vec![0]);
        assert_eq!(&mesh.regs[..2], &[1, 2]);
    }

    #[test]
    fn portal_edges_on_border_size() {
        let mut cset = cset_of(vec![contour(1, &SQUARE, 2)], 4, 4);
        cset.border_size = 1;
        let (_, mesh) = build_poly_mesh(&cset, 6);
        let nvp = 6usize;
        let mut portals: Vec<i32> = mesh.polys[nvp..nvp * 2].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        portals.sort();
        assert_eq!(portals, vec![0x8000, 0x8001, 0x8002, 0x8003]);
    }

    #[test]
    fn notched_contour_conserves_area() {
        // An outer square and an inner (reversed) hole are separate contours in Recast only when the
        // contour builder failed to merge them; BuildPolyMesh just triangulates each. Here the "hole" is
        // a notch: the outer contour already carries it as a bridge, so check the area is conserved.
        let outer = [(0, 0), (0, 6), (6, 6), (6, 3), (3, 3), (3, 2), (6, 2), (6, 0)];
        let cset = cset_of(vec![contour(1, &outer, 2)], 8, 8);
        let (status, mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
        let mut total = 0;
        for i in 0..mesh.npolys as usize {
            total += poly_area2(&mesh, i).abs();
        }
        // 36 - 3*1 = 33, doubled.
        assert_eq!(total, 66);
    }

    #[test]
    fn merge_two_meshes_sharing_an_edge() {
        let mut ca = cset_of(vec![contour(1, &[(0, 0), (0, 4), (4, 4), (4, 0)], 2)], 4, 4);
        ca.bmin = Float3::new(0.0, 0.0, 0.0);
        ca.bmax = Float3::new(4.0, 10.0, 4.0);
        let mut cb = cset_of(vec![contour(2, &[(0, 0), (0, 4), (4, 4), (4, 0)], 2)], 4, 4);
        cb.bmin = Float3::new(4.0, 0.0, 0.0);
        cb.bmax = Float3::new(8.0, 10.0, 4.0);
        let (sa, ma) = build_poly_mesh(&ca, 6);
        let (sb, mb) = build_poly_mesh(&cb, 6);
        assert_eq!((sa, sb), (RcPolyMeshStatus::Success, RcPolyMeshStatus::Success));
        let (status, merged) = merge_poly_meshes(&[ma, mb], 2);
        assert_eq!(status, RcPolyMeshStatus::Success);
        assert_eq!(merged.nverts, 6, "shared edge vertices welded");
        assert_eq!(merged.npolys, 2);
        assert_eq!(merged.bmin.x, 0.0);
        assert_eq!(merged.bmax.x, 8.0);
        let nvp = 6usize;
        let n0: Vec<i32> = merged.polys[nvp..nvp * 2].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        let n1: Vec<i32> = merged.polys[nvp * 3..nvp * 4].iter().cloned().filter(|&n| n != RC_MESH_NULL_IDX).collect();
        assert_eq!(n0, vec![1]);
        assert_eq!(n1, vec![0]);
        assert_eq!(merged.flags.len(), 2);

        // Nothing to merge.
        assert_eq!(merge_poly_meshes(&[], 0).0, RcPolyMeshStatus::NoMeshes);
    }

    #[test]
    fn copy_poly_mesh_trims() {
        let cset = cset_of(vec![contour(1, &SQUARE, 2)], 8, 8);
        let (_, mesh) = build_poly_mesh(&cset, 6);
        let copy = copy_poly_mesh(&mesh);
        assert_eq!(copy.verts.len(), 4);
        assert_eq!(copy.polys.len(), 12);
        assert_eq!(copy.npolys, 1);
        assert_eq!(copy.maxpolys, 1);
    }

    #[test]
    fn too_many_vertices_status() {
        let big: Vec<(i32, i32)> = (0..0xfffe).map(|i| (i, 0)).collect();
        let cset = cset_of(vec![contour(1, &big, 0)], 8, 8);
        assert_eq!(build_poly_mesh(&cset, 6).0, RcPolyMeshStatus::TooManyContourVertices);
    }

    #[test]
    fn degenerate_contours_are_skipped_without_panics() {
        let cset = cset_of(vec![contour(1, &[(0, 0), (1, 1)], 0), contour(2, &[(0, 0), (4, 0), (8, 0)], 0)], 8, 8);
        let (status, _mesh) = build_poly_mesh(&cset, 6);
        assert_eq!(status, RcPolyMeshStatus::Success);
    }

    #[test]
    fn deterministic() {
        let l = [(0, 0), (0, 4), (2, 4), (2, 2), (4, 2), (4, 0)];
        let cset = cset_of(vec![contour(1, &l, 2), contour(2, &[(4, 0), (4, 4), (8, 4), (8, 0)], 2)], 12, 8);
        let (_, a) = build_poly_mesh(&cset, 6);
        let (_, b) = build_poly_mesh(&cset, 6);
        assert_eq!(a.polys, b.polys);
        assert_eq!(a.verts, b.verts);
        assert_eq!(a.regs, b.regs);
        assert_eq!(a.areas, b.areas);
        assert_eq!((a.nverts, a.npolys), (b.nverts, b.npolys));
    }
}
