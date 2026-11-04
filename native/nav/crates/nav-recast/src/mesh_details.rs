//! Detail meshes (`RcMeshDetails`, ported from Foxfire's `RcMeshDetails.cs`, itself a port of DotRecast's
//! `RcMeshDetails`): samples a height patch under each polygon of a poly mesh from the compact
//! heightfield, tessellates the outline, and adds interior samples (Delaunay) until the mesh is within
//! `sample_max_error` of the heightfield.
//!
//! All internal arithmetic is done in doubles (inputs widened where read, results rounded to `f32`
//! only when stored into the vertex lists), exactly as in the C#: every intermediate is then an IEEE
//! double operation, so every target gets the same bits. Keep it that way.
use crate::constants::{RC_MESH_NULL_IDX, RC_MULTIPLE_REGS, RC_NOT_CONNECTED};
use crate::types::{RcCompactHeightfield, RcDetailStatus, RcHeightPatch, RcPolyMesh, RcPolyMeshDetail};
use nav_math::math::{self, clamp, max, min};
use nav_math::{Double3, Float3, Int3, Int4};
use std::collections::HashSet;

/// A height that hasn't been set yet (`RC_SPAN_MAX_HEIGHT`).
pub const RC_UNSET_HEIGHT: i32 = 0x1fff;
const EV_UNDEF: i32 = -1;
const EV_HULL: i32 = -2;

// ------------------------------------------------------------------ vector helpers

fn dist2_sqr(a: Double3, b: Double3) -> f64 {
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    dx * dx + dz * dz
}

fn dist2(a: Double3, b: Double3) -> f64 {
    dist2_sqr(a, b).sqrt()
}

fn dot2(a: Double3, b: Double3) -> f64 {
    a.x * b.x + a.z * b.z
}

fn cross2(p1: Double3, p2: Double3, p3: Double3) -> f64 {
    let u1 = p2.x - p1.x;
    let v1 = p2.z - p1.z;
    let u2 = p3.x - p1.x;
    let v2 = p3.z - p1.z;
    u1 * v2 - v1 * u2
}

fn remove_front(list: &mut Vec<i32>, count: usize) {
    list.drain(..count);
}

#[inline]
fn d3(v: Float3) -> Double3 {
    v.to_double()
}

// ------------------------------------------------------------------ geometry

/// The circumcircle of the triangle in the xz plane: its centre in `c` and radius in `r`; false (with
/// `c = p1`, `r = 0`) if the triangle is degenerate.
pub fn circum_circle(p1: Double3, p2: Double3, p3: Double3, c: &mut Double3, r: &mut f64) -> bool {
    const EPS: f64 = 1e-6;
    // Calculate the circle relative to p1, to avoid some precision issues.
    let v1 = Double3::new(0.0, 0.0, 0.0);
    let v2 = p2 - p1;
    let v3 = p3 - p1;

    let cp = cross2(v1, v2, v3);
    if cp.abs() > EPS {
        let v1_sq = dot2(v1, v1);
        let v2_sq = dot2(v2, v2);
        let v3_sq = dot2(v3, v3);
        c.x = (v1_sq * (v2.z - v3.z) + v2_sq * (v3.z - v1.z) + v3_sq * (v1.z - v2.z)) / (2.0 * cp);
        c.y = 0.0;
        c.z = (v1_sq * (v3.x - v2.x) + v2_sq * (v1.x - v3.x) + v3_sq * (v2.x - v1.x)) / (2.0 * cp);
        *r = dist2(*c, v1);
        *c = *c + p1;
        return true;
    }

    *c = p1;
    *r = 0.0;
    false
}

/// The vertical distance from `p` to triangle abc if p lies inside it in the xz plane, else `f64::MAX`.
pub fn dist_pt_tri(p: Double3, a: Double3, b: Double3, c: Double3) -> f64 {
    let v0 = c - a;
    let v1 = b - a;
    let v2 = p - a;

    let dot00 = dot2(v0, v0);
    let dot01 = dot2(v0, v1);
    let dot02 = dot2(v0, v2);
    let dot11 = dot2(v1, v1);
    let dot12 = dot2(v1, v2);

    // Compute barycentric coordinates
    let inv_denom = 1.0 / (dot00 * dot11 - dot01 * dot01);
    let u = (dot11 * dot02 - dot01 * dot12) * inv_denom;
    let v = (dot00 * dot12 - dot01 * dot02) * inv_denom;

    // If point lies inside the triangle, return interpolated y-coord.
    const EPS: f64 = 1e-4;
    if u >= -EPS && v >= -EPS && u + v <= 1.0 + EPS {
        let y = a.y + v0.y * u + v1.y * v;
        return (y - p.y).abs();
    }

    f64::MAX
}

/// Squared 3D distance from pt to segment pq.
pub fn distance_pt_seg(pt: Double3, p: Double3, q: Double3) -> f64 {
    let pq = q - p;
    let d3 = pt - p;
    let d = pq.dot(pq);
    let mut t = pq.dot(d3);
    if d > 0.0 {
        t /= d;
    }

    if t < 0.0 {
        t = 0.0;
    } else if t > 1.0 {
        t = 1.0;
    }

    let diff = p + pq * t - pt;
    diff.dot(diff)
}

/// Squared xz distance from pt to segment pq.
pub fn distance_pt_seg_2d(pt: Double3, p: Double3, q: Double3) -> f64 {
    let pqx = q.x - p.x;
    let pqz = q.z - p.z;
    let mut dx = pt.x - p.x;
    let mut dz = pt.z - p.z;
    let d = pqx * pqx + pqz * pqz;
    let mut t = pqx * dx + pqz * dz;
    if d > 0.0 {
        t /= d;
    }

    if t < 0.0 {
        t = 0.0;
    } else if t > 1.0 {
        t = 1.0;
    }

    dx = p.x + t * pqx - pt.x;
    dz = p.z + t * pqz - pt.z;

    dx * dx + dz * dz
}

/// The smallest vertical distance from `p` to the triangles of the mesh (`tris` = a, b, c, flags per
/// triangle), or -1 if no triangle holds it.
pub fn dist_to_tri_mesh(p: Double3, verts: &[Float3], _nverts: i32, tris: &[i32], ntris: i32) -> f64 {
    let mut dmin = f64::MAX;
    for i in 0..ntris as usize {
        let va = verts[tris[i * 4] as usize];
        let vb = verts[tris[i * 4 + 1] as usize];
        let vc = verts[tris[i * 4 + 2] as usize];
        let d = dist_pt_tri(p, d3(va), d3(vb), d3(vc));
        if d < dmin {
            dmin = d;
        }
    }

    if dmin == f64::MAX {
        return -1.0;
    }

    dmin
}

/// A height sample's error against the current detail mesh: its distance, or -1 if no triangle holds it.
fn sample_error(p: Double3, verts: &[Float3], nverts: i32, tris: &[i32]) -> f64 {
    if tris.is_empty() {
        -1.0
    } else {
        dist_to_tri_mesh(p, verts, nverts, tris, (tris.len() / 4) as i32)
    }
}

/// The signed squared distance from `p` to the polygon's outline in xz: negative inside.
pub fn dist_to_poly(nvert: i32, verts: &[Float3], p: Double3) -> f64 {
    let mut dmin = f64::MAX;
    let mut c = false;
    let mut i = 0i32;
    let mut j = nvert - 1;
    while i < nvert {
        let vi = d3(verts[i as usize]);
        let vj = d3(verts[j as usize]);
        if (vi.z > p.z) != (vj.z > p.z) && p.x < (vj.x - vi.x) * (p.z - vi.z) / (vj.z - vi.z) + vi.x {
            c = !c;
        }

        dmin = min(dmin, distance_pt_seg_2d(p, vj, vi));
        j = i;
        i += 1;
    }

    if c {
        -dmin
    } else {
        dmin
    }
}

/// The height at (fx, fz) from the patch, searching a spiral of up to `radius` cells for a valid one
/// if the cell is unset; `fy` picks the closest of the candidates.
#[allow(clippy::too_many_arguments)]
pub fn get_height(fx: f64, fy: f64, fz: f64, _cs: f64, ics: f64, ch: f64, radius: i32, hp: &RcHeightPatch) -> i32 {
    // C# `(int)double`: truncation toward zero (Rust `as` saturates; NaN becomes 0 where C# gives int.MinValue).
    let mut ix = math::floor_d(fx * ics + 0.01) as i32;
    let mut iz = math::floor_d(fz * ics + 0.01) as i32;
    ix = clamp(ix - hp.xmin, 0, hp.width - 1);
    iz = clamp(iz - hp.ymin, 0, hp.height - 1);
    let mut h = hp.data[(ix + iz * hp.width) as usize];
    if h == RC_UNSET_HEIGHT {
        // Special case when data might be bad.
        // Walk adjacent cells in a spiral up to 'radius', and look
        // for a pixel which has a valid height.
        let (mut x, mut z, mut dx, mut dz) = (1i32, 0i32, 1i32, 0i32);
        let max_size = radius * 2 + 1;
        let max_iter = max_size * max_size - 1;

        let mut next_ring_iter_start = 8;
        let mut next_ring_iters = 16;

        let mut dmin = f64::MAX;
        for i in 0..max_iter {
            let nx = ix + x;
            let nz = iz + z;

            if nx >= 0 && nz >= 0 && nx < hp.width && nz < hp.height {
                let nh = hp.data[(nx + nz * hp.width) as usize];
                if nh != RC_UNSET_HEIGHT {
                    let d = (nh as f64 * ch - fy).abs();
                    if d < dmin {
                        h = nh;
                        dmin = d;
                    }
                }
            }

            // We are searching in a ring pattern around the center cell: the first ring has 8 cells,
            // the next 16, and so on. If we find a height and are about to enter the next ring, stop.
            if i + 1 == next_ring_iter_start {
                if h != RC_UNSET_HEIGHT {
                    break;
                }

                next_ring_iter_start += next_ring_iters;
                next_ring_iters += 8;
            }

            if x == z || (x < 0 && x == -z) || (x > 0 && x == 1 - z) {
                let tmp = dx;
                dx = -dz;
                dz = tmp;
            }

            x += dx;
            z += dz;
        }
    }

    h
}

// ------------------------------------------------------------ delaunay

/// The edges at each point, as linked lists through the edge array, so finding edge (s, t) walks s's few edges
/// instead of all of them. Edges are unique (`add_edge` only adds one it can't find), so this finds exactly the
/// edge the linear scan did.
struct EdgeIndex {
    /// Per point: its most recently added edge, or -1.
    head: Vec<i32>,
    /// Per edge: the next edge at its first point, then at its second.
    next: Vec<i32>,
}

impl EdgeIndex {
    fn create(npts: i32) -> Self {
        Self { head: vec![-1; npts.max(0) as usize], next: Vec::with_capacity(64) }
    }

    fn find(&self, edges: &[i32], s: i32, t: i32) -> i32 {
        let mut e = self.head[s as usize];
        while e >= 0 {
            let eu = e as usize;
            let first = edges[eu * 4] == s;
            if (if first { edges[eu * 4 + 1] } else { edges[eu * 4] }) == t {
                return e;
            }
            e = self.next[eu * 2 + if first { 0 } else { 1 }];
        }

        EV_UNDEF
    }

    /// Records edge e, just appended to the edge array, between s and t.
    fn added(&mut self, e: i32, s: i32, t: i32) {
        self.next.push(self.head[s as usize]);
        self.next.push(self.head[t as usize]);
        self.head[s as usize] = e;
        self.head[t as usize] = e;
    }
}

/// Returns false if the edge budget was exceeded.
fn add_edge(edges: &mut Vec<i32>, index: &mut EdgeIndex, max_edges: i32, s: i32, t: i32, l: i32, r: i32) -> bool {
    if edges.len() as i32 / 4 >= max_edges {
        return false;
    }

    // Add edge if not already in the triangulation.
    let e = index.find(edges, s, t);
    if e == EV_UNDEF {
        index.added(edges.len() as i32 / 4, s, t);
        edges.push(s);
        edges.push(t);
        edges.push(l);
        edges.push(r);
    }

    true
}

/// `e` is the edge's offset (index * 4) in `edges`.
fn update_left_face(edges: &mut [i32], e: usize, s: i32, t: i32, f: i32) {
    if edges[e] == s && edges[e + 1] == t && edges[e + 2] == EV_UNDEF {
        edges[e + 2] = f;
    } else if edges[e + 1] == s && edges[e] == t && edges[e + 3] == EV_UNDEF {
        edges[e + 3] = f;
    }
}

fn overlap_seg_seg_2d(a: Double3, b: Double3, c: Double3, d: Double3) -> bool {
    let a1 = cross2(a, b, d);
    let a2 = cross2(a, b, c);
    if a1 * a2 < 0.0 {
        let a3 = cross2(c, d, a);
        let a4 = a3 + a2 - a1;
        if a3 * a4 < 0.0 {
            return true;
        }
    }

    false
}

fn overlap_edges(pts: &[Float3], edges: &[i32], s1: i32, t1: i32) -> bool {
    for i in 0..edges.len() / 4 {
        let s0 = edges[i * 4];
        let t0 = edges[i * 4 + 1];
        // Same or connected edges do not overlap.
        if s0 == s1 || s0 == t1 || t0 == s1 || t0 == t1 {
            continue;
        }

        if overlap_seg_seg_2d(d3(pts[s0 as usize]), d3(pts[t0 as usize]), d3(pts[s1 as usize]), d3(pts[t1 as usize])) {
            return true;
        }
    }

    false
}

/// Returns false if the edge budget was exceeded.
fn complete_facet(pts: &[Float3], npts: i32, edges: &mut Vec<i32>, index: &mut EdgeIndex, max_edges: i32, nfaces: &mut i32, mut e: i32) -> bool {
    const EPS: f64 = 1e-5;

    let edge = e as usize * 4;

    // Cache s and t.
    let (s, t);
    if edges[edge + 2] == EV_UNDEF {
        s = edges[edge];
        t = edges[edge + 1];
    } else if edges[edge + 3] == EV_UNDEF {
        s = edges[edge + 1];
        t = edges[edge];
    } else {
        // Edge already completed.
        return true;
    }

    // Find best point on left of edge.
    let mut pt = npts;
    let mut c = Double3::new(0.0, 0.0, 0.0);
    let mut r = -1.0f64;
    for u in 0..npts {
        if u == s || u == t {
            continue;
        }

        let vs = d3(pts[s as usize]);
        let vt = d3(pts[t as usize]);
        let vu = d3(pts[u as usize]);

        if cross2(vs, vt, vu) > EPS {
            if r < 0.0 {
                // The circle is not updated yet, do it now.
                pt = u;
                circum_circle(vs, vt, vu, &mut c, &mut r);
                continue;
            }

            let d = dist2(c, vu);
            let tol = 0.001;
            if d > r * (1.0 + tol) {
                // Outside current circumcircle, skip.
                continue;
            } else if d < r * (1.0 - tol) {
                // Inside safe circumcircle, update circle.
                pt = u;
                circum_circle(vs, vt, vu, &mut c, &mut r);
            } else {
                // Inside epsilon circum circle, do extra tests to make sure the edge is valid.
                // s-u and t-u cannot overlap with s-pt nor t-pt if they exists.
                if overlap_edges(pts, edges, s, u) {
                    continue;
                }

                if overlap_edges(pts, edges, t, u) {
                    continue;
                }

                // Edge is valid.
                pt = u;
                circum_circle(vs, vt, vu, &mut c, &mut r);
            }
        }
    }

    // Add new triangle or update edge info if s-t is on hull.
    if pt < npts {
        // Update face information of edge being completed.
        update_left_face(edges, e as usize * 4, s, t, *nfaces);

        // Add new edge or update face info of old edge.
        e = index.find(edges, pt, s);
        if e == EV_UNDEF {
            if !add_edge(edges, index, max_edges, pt, s, *nfaces, EV_UNDEF) {
                return false;
            }
        } else {
            update_left_face(edges, e as usize * 4, pt, s, *nfaces);
        }

        // Add new edge or update face info of old edge.
        e = index.find(edges, t, pt);
        if e == EV_UNDEF {
            if !add_edge(edges, index, max_edges, t, pt, *nfaces, EV_UNDEF) {
                return false;
            }
        } else {
            update_left_face(edges, e as usize * 4, t, pt, *nfaces);
        }

        *nfaces += 1;
    } else {
        update_left_face(edges, e as usize * 4, s, t, EV_HULL);
    }

    true
}

/// Triangulates the hull plus interior points; `tris` = (a, b, c, 0) per triangle. Returns false if the
/// edge budget was exceeded.
fn delaunay_hull(npts: i32, pts: &[Float3], nhull: i32, hull: &[i32], tris: &mut Vec<i32>, warnings: &mut i32) -> bool {
    let mut nfaces: i32 = 0;
    let max_edges = npts * 10;
    let mut edges: Vec<i32> = Vec::with_capacity(64);
    let mut index = EdgeIndex::create(npts);
    let mut i = 0i32;
    let mut j = nhull - 1;
    while i < nhull {
        if !add_edge(&mut edges, &mut index, max_edges, hull[j as usize], hull[i as usize], EV_HULL, EV_UNDEF) {
            return false;
        }
        j = i;
        i += 1;
    }

    let mut current_edge: i32 = 0;
    while (current_edge as usize) < edges.len() / 4 {
        if edges[current_edge as usize * 4 + 2] == EV_UNDEF && !complete_facet(pts, npts, &mut edges, &mut index, max_edges, &mut nfaces, current_edge) {
            return false;
        }

        if edges[current_edge as usize * 4 + 3] == EV_UNDEF && !complete_facet(pts, npts, &mut edges, &mut index, max_edges, &mut nfaces, current_edge) {
            return false;
        }

        current_edge += 1;
    }

    // Create tris
    tris.clear();
    for _ in 0..nfaces * 4 {
        tris.push(-1);
    }

    for i in 0..edges.len() / 4 {
        let e = i * 4;
        if edges[e + 3] >= 0 {
            // Left face
            let t = edges[e + 3] as usize * 4;
            if tris[t] == -1 {
                tris[t] = edges[e];
                tris[t + 1] = edges[e + 1];
            } else if tris[t] == edges[e + 1] {
                tris[t + 2] = edges[e];
            } else if tris[t + 1] == edges[e] {
                tris[t + 2] = edges[e + 1];
            }
        }

        if edges[e + 2] >= 0 {
            // Right
            let t = edges[e + 2] as usize * 4;
            if tris[t] == -1 {
                tris[t] = edges[e + 1];
                tris[t + 1] = edges[e];
            } else if tris[t] == edges[e] {
                tris[t + 2] = edges[e + 1];
            } else if tris[t + 1] == edges[e + 1] {
                tris[t + 2] = edges[e];
            }
        }
    }

    let mut i = 0i32;
    while (i as usize) < tris.len() / 4 {
        let t = i as usize * 4;
        if tris[t] == -1 || tris[t + 1] == -1 || tris[t + 2] == -1 {
            *warnings += 1; // "delaunayHull: Removing dangling face"
            let len = tris.len();
            tris[t] = tris[len - 4];
            tris[t + 1] = tris[len - 3];
            tris[t + 2] = tris[len - 2];
            tris[t + 3] = tris[len - 1];
            tris.truncate(len - 4);
            i -= 1;
        }
        i += 1;
    }

    true
}

// Calculate minimum extend of the polygon.
fn poly_min_extent(verts: &[Float3], nverts: i32) -> f64 {
    let mut min_dist = f64::MAX;
    for i in 0..nverts {
        let ni = (i + 1) % nverts;
        let p1 = d3(verts[i as usize]);
        let p2 = d3(verts[ni as usize]);
        let mut max_edge_dist = 0.0f64;
        for j in 0..nverts {
            if j == i || j == ni {
                continue;
            }

            let d = distance_pt_seg_2d(d3(verts[j as usize]), p1, p2);
            max_edge_dist = max(max_edge_dist, d);
        }

        min_dist = min(min_dist, max_edge_dist);
    }

    min_dist.sqrt()
}

fn triangulate_hull(_nverts: i32, verts: &[Float3], nhull: i32, hull: &[i32], nin: i32, tris: &mut Vec<i32>) {
    let (mut start, mut left, mut right) = (0i32, 1i32, nhull - 1);

    // Start from an ear with shortest perimeter.
    // This tends to favor well formed triangles as starting point.
    let mut dmin = f64::MAX;
    for i in 0..nhull {
        if hull[i as usize] >= nin {
            continue; // Ears are triangles with original vertices as middle vertex while others are actually line segments on edges
        }

        let pi = crate::meshes::prev(i, nhull);
        let ni = crate::meshes::next(i, nhull);
        let pv = d3(verts[hull[pi as usize] as usize]);
        let cv = d3(verts[hull[i as usize] as usize]);
        let nv = d3(verts[hull[ni as usize] as usize]);
        let d = dist2(pv, cv) + dist2(cv, nv) + dist2(nv, pv);
        if d < dmin {
            start = i;
            left = ni;
            right = pi;
            dmin = d;
        }
    }

    // Add first triangle
    tris.push(hull[start as usize]);
    tris.push(hull[left as usize]);
    tris.push(hull[right as usize]);
    tris.push(0);

    // Triangulate the polygon by moving left or right,
    // depending on which triangle has shorter perimeter.
    // This heuristic was chose empirically, since it seems
    // handle tessellated straight edges well.
    while crate::meshes::next(left, nhull) != right {
        // Check to see if se should advance left or right.
        let nleft = crate::meshes::next(left, nhull);
        let nright = crate::meshes::prev(right, nhull);

        let cvleft = d3(verts[hull[left as usize] as usize]);
        let nvleft = d3(verts[hull[nleft as usize] as usize]);
        let cvright = d3(verts[hull[right as usize] as usize]);
        let nvright = d3(verts[hull[nright as usize] as usize]);
        let dleft = dist2(cvleft, nvleft) + dist2(nvleft, cvright);
        let dright = dist2(cvright, nvright) + dist2(cvleft, nvright);

        if dleft < dright {
            tris.push(hull[left as usize]);
            tris.push(hull[nleft as usize]);
            tris.push(hull[right as usize]);
            tris.push(0);
            left = nleft;
        } else {
            tris.push(hull[left as usize]);
            tris.push(hull[nright as usize]);
            tris.push(hull[right as usize]);
            tris.push(0);
            right = nright;
        }
    }
}

fn get_jitter_x(i: i32) -> f64 {
    (((i as u32).wrapping_mul(0x8da6b343u32)) & 0xffff) as f64 / 65535.0 * 2.0 - 1.0
}

fn get_jitter_y(i: i32) -> f64 {
    (((i as u32).wrapping_mul(0xd8163841u32)) & 0xffff) as f64 / 65535.0 * 2.0 - 1.0
}

fn on_hull(a: i32, b: i32, nhull: i32, hull: &[i32]) -> bool {
    // All internal sampled points come after the hull so we can early out for those.
    if a >= nhull || b >= nhull {
        return false;
    }

    let mut j = nhull - 1;
    let mut i = 0;
    while i < nhull {
        if a == hull[j as usize] && b == hull[i as usize] {
            return true;
        }
        j = i;
        i += 1;
    }

    false
}

// Find edges that lie on hull and mark them as such.
fn set_tri_flags(tris: &mut [i32], nhull: i32, hull: &[i32]) {
    // Matches DT_DETAIL_EDGE_BOUNDARY
    const DETAIL_EDGE_BOUNDARY: i32 = 0x1;

    let mut i = 0;
    while i < tris.len() {
        let a = tris[i];
        let b = tris[i + 1];
        let c = tris[i + 2];
        let mut flags = 0;
        flags |= (if on_hull(a, b, nhull, hull) { DETAIL_EDGE_BOUNDARY } else { 0 }) << 0;
        flags |= (if on_hull(b, c, nhull, hull) { DETAIL_EDGE_BOUNDARY } else { 0 }) << 2;
        flags |= (if on_hull(c, a, nhull, hull) { DETAIL_EDGE_BOUNDARY } else { 0 }) << 4;
        tris[i + 3] = flags;
        i += 4;
    }
}

/// Builds the detail triangulation of one polygon (`inp`, `nin` vertices in local world units):
/// vertices land in `verts` (the polygon's own first, then tessellation and sample points), triangles in
/// `tris`. Returns the status and the vertex count.
#[allow(clippy::too_many_arguments)]
fn build_poly_detail(
    inp: &[Float3],
    nin: i32,
    sample_dist: f64,
    sample_max_error: f64,
    height_search_radius: i32,
    chf: &RcCompactHeightfield,
    hp: &RcHeightPatch,
    verts: &mut [Float3],
    tris: &mut Vec<i32>,
    edges: &mut Vec<i32>,
    samples: &mut Vec<i32>,
    warnings: &mut i32,
) -> (RcDetailStatus, i32) {
    const MAX_VERTS: i32 = 127;
    const MAX_TRIS: i32 = 255; // Max tris for delaunay is 2n-2-k (n=num verts, k=num hull verts).
    const MAX_VERTS_PER_EDGE: i32 = 32;

    let mut edge = vec![Double3::default(); (MAX_VERTS_PER_EDGE + 1) as usize];
    let mut hull = vec![0i32; MAX_VERTS as usize];
    let mut idx = vec![0i32; (MAX_VERTS_PER_EDGE + 1) as usize];
    let mut nhull: i32 = 0;

    let mut nverts = nin;

    for i in 0..nin as usize {
        verts[i] = inp[i];
    }

    edges.clear();
    tris.clear();

    let cs = chf.cs as f64;
    let ch = chf.ch as f64;
    let ics = 1.0 / cs;

    // Calculate minimum extents of the polygon based on input data.
    let min_extent = poly_min_extent(verts, nverts);

    // Tessellate outlines.
    // This is done in separate pass in order to ensure
    // seamless height values across the ply boundaries.
    if sample_dist > 0.0 {
        let mut i = 0i32;
        let mut j = nin - 1;
        while i < nin {
            let mut vj = j;
            let mut vi = i;
            let mut swapped = false;
            // Make sure the segments are always handled in same order
            // using lexological sort or else there will be seams.
            if (inp[vj as usize].x as f64 - inp[vi as usize].x as f64).abs() < 1e-6 {
                if inp[vj as usize].z > inp[vi as usize].z {
                    std::mem::swap(&mut vi, &mut vj);
                    swapped = true;
                }
            } else if inp[vj as usize].x > inp[vi as usize].x {
                std::mem::swap(&mut vi, &mut vj);
                swapped = true;
            }

            // Create samples along the edge.
            let pj = d3(inp[vj as usize]);
            let dv = d3(inp[vi as usize]) - pj;
            let d = (dv.x * dv.x + dv.z * dv.z).sqrt();
            let mut nn = 1 + math::floor_d(d / sample_dist) as i32;
            if nn >= MAX_VERTS_PER_EDGE {
                nn = MAX_VERTS_PER_EDGE - 1;
            }

            if nverts + nn >= MAX_VERTS {
                nn = MAX_VERTS - 1 - nverts;
            }

            for k in 0..=nn {
                let u = k as f64 / nn as f64;
                let mut pos = pj + dv * u;
                pos.y = get_height(pos.x, pos.y, pos.z, cs, ics, ch, height_search_radius, hp) as f64 * ch;
                edge[k as usize] = pos;
            }

            // Simplify samples.
            idx[0] = 0;
            idx[1] = nn;
            let mut nidx = 2i32;
            let mut k = 0i32;
            while k < nidx - 1 {
                let a = idx[k as usize];
                let b = idx[(k + 1) as usize];
                let va = edge[a as usize];
                let vb = edge[b as usize];
                // Find maximum deviation along the segment.
                let mut maxd = 0.0f64;
                let mut maxi = -1i32;
                for m in a + 1..b {
                    let dev = distance_pt_seg(edge[m as usize], va, vb);
                    if dev > maxd {
                        maxd = dev;
                        maxi = m;
                    }
                }

                // If the max deviation is larger than accepted error,
                // add new point, else continue to next segment.
                if maxi != -1 && maxd > sample_max_error * sample_max_error {
                    let mut m = nidx;
                    while m > k {
                        idx[m as usize] = idx[(m - 1) as usize];
                        m -= 1;
                    }

                    idx[(k + 1) as usize] = maxi;
                    nidx += 1;
                } else {
                    k += 1;
                }
            }

            hull[nhull as usize] = j;
            nhull += 1;
            // Add new vertices.
            if swapped {
                let mut k = nidx - 2;
                while k > 0 {
                    verts[nverts as usize] = edge[idx[k as usize] as usize].to_float();
                    hull[nhull as usize] = nverts;
                    nhull += 1;
                    nverts += 1;
                    k -= 1;
                }
            } else {
                for k in 1..nidx - 1 {
                    verts[nverts as usize] = edge[idx[k as usize] as usize].to_float();
                    hull[nhull as usize] = nverts;
                    nhull += 1;
                    nverts += 1;
                }
            }

            j = i;
            i += 1;
        }
    } else {
        // Deviation: with no tessellation the C# leaves the hull empty (and then reads hull[-1]); the
        // hull is the polygon's own outline, which is what a zero sample distance asks for.
        for i in 0..nin {
            hull[nhull as usize] = i;
            nhull += 1;
        }
    }

    let mut status = RcDetailStatus::Success;

    // If the polygon minimum extent is small (sliver or small triangle), do not try to add internal points.
    if min_extent < sample_dist * 2.0 {
        triangulate_hull(nverts, verts, nhull, &hull, nin, tris);
        set_tri_flags(tris, nhull, &hull);
    } else {
        // Tessellate the base mesh.
        // We're using the triangulateHull instead of delaunayHull as it tends to
        // create a bit better triangulation for long thin triangles when there
        // are no internal points.
        triangulate_hull(nverts, verts, nhull, &hull, nin, tris);

        if tris.is_empty() {
            // Could not triangulate the poly, make sure there is some valid data there.
            status = RcDetailStatus::CouldNotTriangulate;
        } else {
            if sample_dist > 0.0 {
                // Create sample locations in a grid.
                let mut bmin = d3(inp[0]);
                let mut bmax = d3(inp[0]);
                for i in 1..nin as usize {
                    bmin = bmin.zip(d3(inp[i]), min);
                    bmax = bmax.zip(d3(inp[i]), max);
                }

                let x0 = math::floor_d(bmin.x / sample_dist) as i32;
                let x1 = (bmax.x / sample_dist).ceil() as i32;
                let z0 = math::floor_d(bmin.z / sample_dist) as i32;
                let z1 = (bmax.z / sample_dist).ceil() as i32;
                samples.clear();
                for z in z0..z1 {
                    for x in x0..x1 {
                        let pt = Double3::new(x as f64 * sample_dist, (bmax.y + bmin.y) * 0.5, z as f64 * sample_dist);

                        // Make sure the samples are not too close to the edges.
                        if dist_to_poly(nin, inp, pt) > -sample_dist / 2.0 {
                            continue;
                        }

                        samples.push(x);
                        samples.push(get_height(pt.x, pt.y, pt.z, cs, ics, ch, height_search_radius, hp));
                        samples.push(z);
                        samples.push(0); // Not added
                    }
                }

                // Add the samples starting from the one that has the most
                // error. The procedure stops when all samples are added
                // or when the max error is within treshold.
                //
                // Each sample's error (its distance to the current detail mesh) is kept between rounds and
                // recomputed only near triangles the last rebuild created: elsewhere the mesh, and so the
                // error, is exactly what it was. Same values in the same order as recomputing everything, so
                // the same samples are added, at a fraction of the cost on bumpy polygons.
                let nsamples = samples.len() / 4;
                let mut points: Vec<Double3> = Vec::with_capacity(nsamples.max(1));
                let mut errors: Vec<f64> = Vec::with_capacity(nsamples.max(1));
                for i in 0..nsamples {
                    let s = i * 4;
                    // The sample location is jittered to get rid of some bad triangulations
                    // which are cause by symmetrical data from the grid structure.
                    let pt = Double3::new(
                        samples[s] as f64 * sample_dist + get_jitter_x(i as i32) * cs * 0.1,
                        samples[s + 1] as f64 * ch,
                        samples[s + 2] as f64 * sample_dist + get_jitter_y(i as i32) * cs * 0.1,
                    );
                    points.push(pt);
                    errors.push(sample_error(pt, verts, nverts, tris));
                }

                // Points within this of a changed triangle may be affected by it (dist_pt_tri's barycentric
                // tolerance reaches past a triangle's edges by a fraction of its size).
                let b = bmax - bmin;
                let margin = 1e-3 * max(b.x, b.z) + 1e-6;
                let mut previous: HashSet<(i32, i32, i32)> = HashSet::with_capacity(64);
                let mut changed: Vec<[f64; 4]> = Vec::with_capacity(16); // xz boxes of new triangles
                for _iter in 0..nsamples {
                    if nverts >= MAX_VERTS {
                        break;
                    }

                    // Find sample with most error.
                    let mut bestpt = Double3::new(0.0, 0.0, 0.0);
                    let mut bestd = 0.0f64;
                    let mut besti = -1i32;
                    for i in 0..nsamples {
                        if samples[i * 4 + 3] != 0 {
                            continue; // skip added.
                        }

                        let d = errors[i];
                        if d < 0.0 {
                            continue; // did not hit the mesh.
                        }

                        if d > bestd {
                            bestd = d;
                            besti = i as i32;
                            bestpt = points[i];
                        }
                    }

                    // If the max error is within accepted threshold, stop tesselating.
                    if bestd <= sample_max_error || besti == -1 {
                        break;
                    }

                    // Mark sample as added.
                    samples[besti as usize * 4 + 3] = 1;
                    // Add the new sample point.
                    verts[nverts as usize] = bestpt.to_float();
                    nverts += 1;

                    previous.clear();
                    let mut t = 0;
                    while t < tris.len() {
                        previous.insert((tris[t], tris[t + 1], tris[t + 2]));
                        t += 4;
                    }

                    // Create new triangulation.
                    // TODO: Incremental add instead of full rebuild.
                    if !delaunay_hull(nverts, verts, nhull, &hull, tris, warnings) {
                        status = RcDetailStatus::TooManyEdges;
                        break;
                    }

                    // No mesh left: no sample hits it, so the next round would add nothing and stop.
                    if tris.is_empty() {
                        break;
                    }

                    // Triangles the rebuild created (any not in the previous mesh exactly as stored) cover
                    // the area of those it removed; only samples near them can have a new error.
                    changed.clear();
                    let mut t = 0;
                    while t < tris.len() {
                        if previous.contains(&(tris[t], tris[t + 1], tris[t + 2])) {
                            t += 4;
                            continue;
                        }
                        let a = d3(verts[tris[t] as usize]);
                        let b = d3(verts[tris[t + 1] as usize]);
                        let c = d3(verts[tris[t + 2] as usize]);
                        // math.min(math.min(a, b), c).xz - margin; math.max(...).xz + margin
                        let lo_x = min(min(a.x, b.x), c.x) - margin;
                        let lo_z = min(min(a.z, b.z), c.z) - margin;
                        let hi_x = max(max(a.x, b.x), c.x) + margin;
                        let hi_z = max(max(a.z, b.z), c.z) + margin;
                        changed.push([lo_x, lo_z, hi_x, hi_z]);
                        t += 4;
                    }

                    for i in 0..nsamples {
                        if samples[i * 4 + 3] != 0 {
                            continue;
                        }
                        let (px, py) = (points[i].x, points[i].z);
                        for bx in &changed {
                            if px < bx[0] || py < bx[1] || px > bx[2] || py > bx[3] {
                                continue;
                            }
                            errors[i] = sample_error(points[i], verts, nverts, tris);
                            break;
                        }
                    }
                }
            }

            if status == RcDetailStatus::Success {
                let ntris = (tris.len() / 4) as i32;
                if ntris > MAX_TRIS {
                    // "rcBuildPolyMeshDetail: Shrinking triangle count from ntris to max MAX_TRIS"
                    tris.truncate((MAX_TRIS * 4) as usize);
                    *warnings += 1;
                }

                set_tri_flags(tris, nhull, &hull);
            }
        }
    }

    (status, nverts)
}

// ------------------------------------------------------------ height data

fn seed_offset(k: i32) -> (i32, i32) {
    match k {
        0 => (0, 0),
        1 => (-1, -1),
        2 => (0, -1),
        3 => (1, -1),
        4 => (1, 0),
        5 => (1, 1),
        6 => (0, 1),
        7 => (-1, 1),
        _ => (-1, 0),
    }
}

// dirs = { 3, 0, -1, 2, 1 }[((z + 1) << 1) + x]
fn get_dir_for_offset(offset_x: i32, offset_z: i32) -> i32 {
    match ((offset_z + 1) << 1) + offset_x {
        0 => 3,
        1 => 0,
        2 => -1,
        3 => 2,
        _ => 1,
    }
}

fn push3(queue: &mut Vec<i32>, v1: i32, v2: i32, v3: i32) {
    queue.push(v1);
    queue.push(v2);
    queue.push(v3);
}

fn hp_len(hp: &RcHeightPatch) -> usize {
    (hp.width * hp.height).max(0) as usize
}

/// Finds a seed near the polygon's centre by walking the compact heightfield from the cell nearest one
/// of the polygon's vertices; the seed goes in `array` and the patch is reset to unset heights.
///
/// Deviation: a start cell that was never found (`startSpanIndex` -1, where the C# would read span -1)
/// ends the walk with a warning and leaves a seed with span -1, which the flood skips.
#[allow(clippy::too_many_arguments)]
fn seed_array_with_poly_center(
    chf: &RcCompactHeightfield,
    meshpoly: &[i32],
    poly: usize,
    npoly: i32,
    verts: &[Int3],
    bs: i32,
    hp: &mut RcHeightPatch,
    array: &mut Vec<i32>,
    warnings: &mut i32,
) {
    // Note: Reads to the compact heightfield are offset by border size (bs)
    // since border size offset is already removed from the polymesh vertices.

    // Find cell closest to a poly vertex
    let (mut start_cell_x, mut start_cell_y, mut start_span_index) = (0i32, 0i32, -1i32);
    let mut dmin = RC_UNSET_HEIGHT;
    let mut j = 0;
    while j < npoly && dmin > 0 {
        let pv = verts[meshpoly[poly + j as usize] as usize];
        let mut k = 0;
        while k < 9 && dmin > 0 {
            let off = seed_offset(k);
            k += 1;
            let ax = pv.x + off.0;
            let ay = pv.y;
            let az = pv.z + off.1;
            if ax < hp.xmin || ax >= hp.xmin + hp.width || az < hp.ymin || az >= hp.ymin + hp.height {
                continue;
            }

            let c = chf.cells[(ax + bs + (az + bs) * chf.width) as usize];
            let mut i = c.index;
            let ni = c.index + c.count;
            while i < ni && dmin > 0 {
                let s = chf.spans[i as usize];
                let d = (ay - s.y).abs();
                if d < dmin {
                    start_cell_x = ax;
                    start_cell_y = az;
                    start_span_index = i;
                    dmin = d;
                }
                i += 1;
            }
        }
        j += 1;
    }

    // Find center of the polygon
    let (mut pcx, mut pcy) = (0i32, 0i32);
    for j in 0..npoly {
        let pv = verts[meshpoly[poly + j as usize] as usize];
        pcx += pv.x;
        pcy += pv.z;
    }

    pcx /= npoly;
    pcy /= npoly;

    array.clear();
    array.push(start_cell_x);
    array.push(start_cell_y);
    array.push(start_span_index);
    let mut dirs: [i32; 4] = [0, 1, 2, 3];
    for i in 0..hp_len(hp) {
        hp.data[i] = 0;
    }

    // DFS to move to the center. Note that we need a DFS here and can not just move
    // directly towards the center without recording intermediate nodes, even though the polygons
    // are convex. In very rare we can get stuck due to contour simplification if we do not
    // record nodes.
    let (mut cx, mut cy, mut ci) = (-1i32, -1i32, -1i32);
    loop {
        if array.len() < 3 {
            *warnings += 1; // "Walk towards polygon center failed to reach center"
            break;
        }

        ci = array.pop().unwrap();
        cy = array.pop().unwrap();
        cx = array.pop().unwrap();

        // Check if close to center of the polygon.
        if cx == pcx && cy == pcy {
            break;
        }

        if ci < 0 {
            *warnings += 1; // deviation: the C# would read span -1 here
            break;
        }

        // If we are already at the correct X-position, prefer direction
        // directly towards the center in the Y-axis; otherwise prefer
        // direction in the X-axis
        let direct_dir = if cx == pcx {
            get_dir_for_offset(0, if pcy > cy { 1 } else { -1 })
        } else {
            get_dir_for_offset(if pcx > cx { 1 } else { -1 }, 0)
        };

        // Push the direct dir last so we start with this on next iteration
        dirs.swap(3, direct_dir as usize);

        let cs = chf.spans[ci as usize];

        for i in 0..4 {
            let dir = dirs[i];
            let con = RcCompactHeightfield::get_con(&cs, dir);
            if con == RC_NOT_CONNECTED {
                continue;
            }

            let new_x = cx + RcCompactHeightfield::dir_offset_x(dir);
            let new_y = cy + RcCompactHeightfield::dir_offset_y(dir);

            let hpx = new_x - hp.xmin;
            let hpy = new_y - hp.ymin;
            if hpx < 0 || hpx >= hp.width || hpy < 0 || hpy >= hp.height {
                continue;
            }

            if hp.data[(hpx + hpy * hp.width) as usize] != 0 {
                continue;
            }

            hp.data[(hpx + hpy * hp.width) as usize] = 1;

            array.push(new_x);
            array.push(new_y);
            array.push(chf.cells[(new_x + bs + (new_y + bs) * chf.width) as usize].index + con);
        }

        dirs.swap(3, direct_dir as usize);
    }

    array.clear();
    // getHeightData seeds are given in coordinates with borders
    array.push(cx + bs);
    array.push(cy + bs);
    array.push(ci);
    for i in 0..hp_len(hp) {
        hp.data[i] = RC_UNSET_HEIGHT;
    }

    if ci >= 0 {
        let cs2 = chf.spans[ci as usize];
        hp.data[(cx - hp.xmin + (cy - hp.ymin) * hp.width) as usize] = cs2.y;
    }
}

/// Fills the height patch `hp` for a polygon: the region's own span heights, flood-filled outwards from
/// the region border (or from the polygon's centre for multi-region polygons).
#[allow(clippy::too_many_arguments)]
fn get_height_data(
    chf: &RcCompactHeightfield,
    meshpolys: &[i32],
    poly: usize,
    npoly: i32,
    verts: &[Int3],
    bs: i32,
    hp: &mut RcHeightPatch,
    queue: &mut Vec<i32>,
    region: i32,
    warnings: &mut i32,
) {
    // Note: Reads to the compact heightfield are offset by border size (bs)
    // since border size offset is already removed from the polymesh vertices.

    queue.clear();
    // Set all heights to RC_UNSET_HEIGHT.
    for i in 0..hp_len(hp) {
        hp.data[i] = RC_UNSET_HEIGHT;
    }

    let mut empty = true;

    // We cannot sample from this poly if it was created from polys
    // of different regions. If it was then it could potentially be overlapping
    // with polys of that region and the heights sampled here could be wrong.
    if region != RC_MULTIPLE_REGS {
        // Copy the height from the same region, and mark region borders
        // as seed points to fill the rest.
        for hy in 0..hp.height {
            let y = hp.ymin + hy + bs;
            for hx in 0..hp.width {
                let x = hp.xmin + hx + bs;
                let c = chf.cells[(x + y * chf.width) as usize];
                let mut i = c.index;
                let ni = c.index + c.count;
                while i < ni {
                    let s = chf.spans[i as usize];
                    if s.reg == region {
                        // Store height
                        hp.data[(hx + hy * hp.width) as usize] = s.y;
                        empty = false;

                        // If any of the neighbours is not in same region,
                        // add the current location as flood fill start
                        let mut border = false;
                        for dir in 0..4 {
                            let con = RcCompactHeightfield::get_con(&s, dir);
                            if con != RC_NOT_CONNECTED {
                                let ax = x + RcCompactHeightfield::dir_offset_x(dir);
                                let ay = y + RcCompactHeightfield::dir_offset_y(dir);
                                let ai = chf.cells[(ax + ay * chf.width) as usize].index + con;
                                if chf.spans[ai as usize].reg != region {
                                    border = true;
                                    break;
                                }
                            }
                        }

                        if border {
                            push3(queue, x, y, i);
                        }

                        break;
                    }
                    i += 1;
                }
            }
        }
    }

    // if the polygon does not contain any points from the current region (rare, but happens)
    // or if it could potentially be overlapping polygons of the same region,
    // then use the center as the seed point.
    if empty {
        seed_array_with_poly_center(chf, meshpolys, poly, npoly, verts, bs, hp, queue, warnings);
    }

    const RETRACT_SIZE: usize = 256;
    let mut head: usize = 0;

    // We assume the seed is centered in the polygon, so a BFS to collect
    // height data will ensure we do not move onto overlapping polygons and
    // sample wrong heights.
    while head * 3 < queue.len() {
        let cx = queue[head * 3];
        let cy = queue[head * 3 + 1];
        let ci = queue[head * 3 + 2];
        head += 1;
        if head >= RETRACT_SIZE {
            head = 0;
            remove_front(queue, RETRACT_SIZE * 3);
        }

        if ci < 0 {
            continue; // deviation: the C# would read span -1 (only after a failed seed search)
        }

        let cs = chf.spans[ci as usize];
        for dir in 0..4 {
            let con = RcCompactHeightfield::get_con(&cs, dir);
            if con == RC_NOT_CONNECTED {
                continue;
            }

            let ax = cx + RcCompactHeightfield::dir_offset_x(dir);
            let ay = cy + RcCompactHeightfield::dir_offset_y(dir);
            let hx = ax - hp.xmin - bs;
            let hy = ay - hp.ymin - bs;

            if hx < 0 || hx >= hp.width || hy < 0 || hy >= hp.height {
                continue;
            }

            if hp.data[(hx + hy * hp.width) as usize] != RC_UNSET_HEIGHT {
                continue;
            }

            let ai = chf.cells[(ax + ay * chf.width) as usize].index + con;
            let a_span = chf.spans[ai as usize];

            hp.data[(hx + hy * hp.width) as usize] = a_span.y;
            push3(queue, ax, ay, ai);
        }
    }
}

// ------------------------------------------------------------ top level

/// Port of rcBuildPolyMeshDetail. Vertex positions come out in world space. On failure (including an
/// empty mesh) the returned detail mesh is the default (empty) one.
pub fn build_poly_mesh_detail(mesh: &RcPolyMesh, chf: &RcCompactHeightfield, sample_dist: f32, sample_max_error: f32) -> (RcDetailStatus, RcPolyMeshDetail) {
    if mesh.nverts == 0 || mesh.npolys == 0 {
        return (RcDetailStatus::EmptyMesh, RcPolyMeshDetail::default());
    }

    let nvp = mesh.nvp;
    let cs = mesh.cs;
    let ch = mesh.ch;
    let orig = mesh.bmin;
    let border_size = mesh.border_size;
    // math.max(1, math.ceil(maxEdgeError)) in float, then truncated.
    let height_search_radius = max(1.0f32, mesh.max_edge_error.ceil()) as i32;

    let mut edges: Vec<i32> = Vec::with_capacity(64);
    let mut tris: Vec<i32> = Vec::with_capacity(512);
    let mut arr: Vec<i32> = Vec::with_capacity(512);
    let mut samples: Vec<i32> = Vec::with_capacity(512);
    let mut verts = vec![Float3::default(); 256];

    let mut hp = RcHeightPatch::default();
    let mut n_poly_verts: i32 = 0;
    let (mut maxhw, mut maxhh) = (0i32, 0i32);

    let mut bounds = vec![Int4::default(); mesh.npolys as usize];
    let mut poly = vec![Float3::default(); nvp.max(0) as usize];

    // Find max size for a polygon area.
    for i in 0..mesh.npolys as usize {
        let p = i * nvp as usize * 2;
        let mut b = Int4::new(chf.width, 0, chf.height, 0);
        for j in 0..nvp as usize {
            if mesh.polys[p + j] == RC_MESH_NULL_IDX {
                break;
            }

            let v = mesh.verts[mesh.polys[p + j] as usize];
            b.x = min(b.x, v.x);
            b.y = max(b.y, v.x);
            b.z = min(b.z, v.z);
            b.w = max(b.w, v.z);
            n_poly_verts += 1;
        }

        b.x = max(0, b.x - 1);
        b.y = min(chf.width, b.y + 1);
        b.z = max(0, b.z - 1);
        b.w = min(chf.height, b.w + 1);
        bounds[i] = b;
        if b.x >= b.y || b.z >= b.w {
            continue;
        }

        maxhw = max(maxhw, b.y - b.x);
        maxhh = max(maxhh, b.w - b.z);
    }

    hp.data = vec![0i32; (maxhw * maxhh).max(0) as usize];

    let vcap = n_poly_verts + n_poly_verts / 2;
    let tcap = vcap * 2;

    let mut dmesh = RcPolyMeshDetail {
        meshes: Vec::with_capacity(mesh.npolys as usize),
        verts: Vec::with_capacity(vcap.max(1) as usize),
        tris: Vec::with_capacity(tcap.max(1) as usize),
        warnings: 0,
    };

    let mut status = RcDetailStatus::Success;
    let mut warnings: i32 = 0;

    let mut i = 0usize;
    while i < mesh.npolys as usize && status == RcDetailStatus::Success {
        let p = i * nvp as usize * 2;

        // Store polygon vertices for processing.
        let mut npoly: i32 = 0;
        for j in 0..nvp as usize {
            if mesh.polys[p + j] == RC_MESH_NULL_IDX {
                break;
            }

            let v = mesh.verts[mesh.polys[p + j] as usize];
            poly[j] = Double3::new(v.x as f64 * cs as f64, v.y as f64 * ch as f64, v.z as f64 * cs as f64).to_float();
            npoly += 1;
        }

        // Get the height data from the area of the polygon.
        let bb = bounds[i];
        hp.xmin = bb.x;
        hp.ymin = bb.z;
        hp.width = bb.y - bb.x;
        hp.height = bb.w - bb.z;
        get_height_data(chf, &mesh.polys, p, npoly, &mesh.verts, border_size, &mut hp, &mut arr, mesh.regs[i], &mut warnings);

        // Build detail mesh.
        let (st, nverts) = build_poly_detail(
            &poly,
            npoly,
            sample_dist as f64,
            sample_max_error as f64,
            height_search_radius,
            chf,
            &hp,
            &mut verts,
            &mut tris,
            &mut edges,
            &mut samples,
            &mut warnings,
        );
        status = st;
        if status != RcDetailStatus::Success {
            break;
        }

        // Move detail verts to world space.
        let world_offset = Double3::new(orig.x as f64, orig.y as f64 + chf.ch as f64, orig.z as f64); // Is this offset necessary? (as in DotRecast)
        for j in 0..nverts as usize {
            verts[j] = (d3(verts[j]) + world_offset).to_float();
        }

        // Store detail submesh.
        let ntris = (tris.len() / 4) as i32;

        dmesh.meshes.push(Int4::new(dmesh.verts.len() as i32, nverts, dmesh.tris.len() as i32, ntris));

        for j in 0..nverts as usize {
            dmesh.verts.push(verts[j]);
        }

        for j in 0..ntris as usize {
            let t = j * 4;
            dmesh.tris.push(Int4::new(tris[t], tris[t + 1], tris[t + 2], tris[t + 3]));
        }

        i += 1;
    }

    dmesh.warnings = warnings;

    if status != RcDetailStatus::Success {
        return (status, RcPolyMeshDetail::default());
    }

    (status, dmesh)
}

/// Port of rcMergePolyMeshDetails: concatenates the first `nmeshes` detail meshes. Entries that were
/// never built (no sub-meshes) are skipped.
pub fn merge_poly_mesh_details(meshes: &[RcPolyMeshDetail], nmeshes: usize) -> (RcDetailStatus, RcPolyMeshDetail) {
    let nmeshes = nmeshes.min(meshes.len());
    let mut max_verts = 0usize;
    let mut max_tris = 0usize;
    let mut max_meshes = 0usize;

    for dm in &meshes[..nmeshes] {
        if dm.meshes.is_empty() {
            continue;
        }

        max_verts += dm.nverts();
        max_tris += dm.ntris();
        max_meshes += dm.nmeshes();
    }

    let mut mesh = RcPolyMeshDetail {
        meshes: Vec::with_capacity(max_meshes.max(1)),
        tris: Vec::with_capacity(max_tris.max(1)),
        verts: Vec::with_capacity(max_verts.max(1)),
        warnings: 0,
    };

    // Merge datas.
    for dm in &meshes[..nmeshes] {
        if dm.meshes.is_empty() {
            continue;
        }

        let vert_base = mesh.verts.len() as i32;
        let tri_base = mesh.tris.len() as i32;

        for src in &dm.meshes {
            mesh.meshes.push(Int4::new(vert_base + src.x, src.y, tri_base + src.z, src.w));
        }

        mesh.verts.extend_from_slice(&dm.verts);
        mesh.tris.extend_from_slice(&dm.tris);

        mesh.warnings += dm.warnings;
    }

    (RcDetailStatus::Success, mesh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RcCompactCell, RcCompactSpan};

    /// A grid of one-span columns, all four-connected, with floor height `y(x, z)` and region `reg`.
    fn chf_grid(w: i32, h: i32, reg: i32, y: impl Fn(i32, i32) -> i32) -> RcCompactHeightfield {
        let mut chf = RcCompactHeightfield {
            width: w,
            height: h,
            span_count: w * h,
            cs: 1.0,
            ch: 0.5,
            ..RcCompactHeightfield::default()
        };
        for z in 0..h {
            for x in 0..w {
                let idx = x + z * w;
                chf.cells.push(RcCompactCell { index: idx, count: 1 });
                let mut s = RcCompactSpan { y: y(x, z), reg, con: 0, h: 10 };
                for dir in 0..4 {
                    let nx = x + RcCompactHeightfield::dir_offset_x(dir);
                    let nz = z + RcCompactHeightfield::dir_offset_y(dir);
                    let con = if nx >= 0 && nz >= 0 && nx < w && nz < h { 0 } else { RC_NOT_CONNECTED };
                    RcCompactHeightfield::set_con(&mut s, dir, con);
                }
                chf.spans.push(s);
                chf.areas.push(63);
            }
        }
        chf
    }

    /// A poly mesh of one polygon at the given cell corners, vertex height `vy` (cells of ch 0.5).
    fn square_mesh(x0: i32, z0: i32, x1: i32, z1: i32, vy: i32, reg: i32) -> RcPolyMesh {
        let nvp = 6usize;
        let mut polys = vec![RC_MESH_NULL_IDX; nvp * 2];
        for (i, v) in [0, 1, 2, 3].iter().enumerate() {
            polys[i] = *v;
        }
        RcPolyMesh {
            verts: vec![Int3::new(x0, vy, z0), Int3::new(x0, vy, z1), Int3::new(x1, vy, z1), Int3::new(x1, vy, z0)],
            polys,
            regs: vec![reg],
            flags: vec![0],
            areas: vec![63],
            nverts: 4,
            npolys: 1,
            maxpolys: 1,
            nvp: nvp as i32,
            bmin: Float3::new(0.0, 0.0, 0.0),
            bmax: Float3::new(x1 as f32, 10.0, z1 as f32),
            cs: 1.0,
            ch: 0.5,
            border_size: 0,
            max_edge_error: 1.3,
            triangulation_warnings: 0,
        }
    }

    #[test]
    fn empty_mesh_status() {
        let chf = chf_grid(4, 4, 1, |_, _| 0);
        let (status, dmesh) = build_poly_mesh_detail(&RcPolyMesh::default(), &chf, 6.0, 1.0);
        assert_eq!(status, RcDetailStatus::EmptyMesh);
        assert_eq!(dmesh.nmeshes(), 0);
    }

    #[test]
    fn flat_polygon_adds_no_vertices() {
        let chf = chf_grid(10, 10, 1, |_, _| 4);
        let mesh = square_mesh(1, 1, 9, 9, 4, 1);
        let (status, d) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        assert_eq!(status, RcDetailStatus::Success);
        assert_eq!(d.nmeshes(), 1);
        assert_eq!(d.meshes[0].y, 4, "only the polygon's own vertices");
        assert_eq!(d.ntris(), 2);
        assert_eq!(d.warnings, 0);
        // Heights: 4 * ch = 2.0, plus the world offset ch (orig.y 0 + 0.5).
        assert!(d.verts.iter().all(|v| v.y == 2.5));
        // Every edge of the quad is a boundary edge: both triangles carry boundary flags.
        assert!(d.tris.iter().all(|t| t.w != 0));
    }

    #[test]
    fn sloped_planar_polygon_adds_no_interior_vertices() {
        let chf = chf_grid(10, 10, 1, |x, _| 4 + x);
        let mut mesh = square_mesh(1, 1, 9, 9, 4, 1);
        // The corners follow the plane: y = 4 + x.
        mesh.verts[2].y = 4 + 9;
        mesh.verts[3].y = 4 + 9;
        mesh.verts[0].y = 4 + 1;
        mesh.verts[1].y = 4 + 1;
        let (status, d) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        assert_eq!(status, RcDetailStatus::Success);
        assert_eq!(d.meshes[0].y, 4);
    }

    #[test]
    fn bumpy_patch_adds_samples_within_error() {
        // A flat polygon over a 3x3 bump of +6 cells (3 world units).
        let bump = |x: i32, z: i32| if (4..=6).contains(&x) && (4..=6).contains(&z) { 10 } else { 4 };
        let chf = chf_grid(12, 12, 1, bump);
        let mesh = square_mesh(1, 1, 11, 11, 4, 1);
        let max_error = 0.5f32;
        let (status, d) = build_poly_mesh_detail(&mesh, &chf, 2.0, max_error);
        assert_eq!(status, RcDetailStatus::Success);
        assert!(d.meshes[0].y > 4, "samples were added: {}", d.meshes[0].y);
        assert!(d.meshes[0].y <= 127);
        assert!(d.ntris() >= 2);
        // The bump's top is reached by some vertex.
        assert!(d.verts.iter().any(|v| v.y > 4.0));
        // The bump is represented: the detail mesh is much closer to the bump's centre than the flat
        // hull-only mesh would be (3 world units off).
        let sub = d.meshes[0];
        let verts: Vec<Float3> = d.verts[sub.x as usize..(sub.x + sub.y) as usize].to_vec();
        let tris: Vec<i32> = d.tris[sub.z as usize..(sub.z + sub.w) as usize].iter().flat_map(|t| [t.x, t.y, t.z, t.w]).collect();
        let p = Double3::new(5.5, 10.0 * 0.5 + 0.5, 5.5);
        let err = dist_to_tri_mesh(p, &verts, sub.y, &tris, sub.w);
        assert!(err >= 0.0 && err < 2.0, "error {err}");
    }

    #[test]
    fn multi_region_polygon_seeds_from_the_centre() {
        let chf = chf_grid(10, 10, 1, |_, _| 4);
        let mesh = square_mesh(1, 1, 9, 9, 4, RC_MULTIPLE_REGS);
        let (status, d) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        assert_eq!(status, RcDetailStatus::Success);
        assert_eq!(d.meshes[0].y, 4);
        assert!(d.verts.iter().all(|v| v.y == 2.5));
        assert_eq!(d.warnings, 0);
    }

    #[test]
    fn zero_sample_dist_triangulates_the_hull_only() {
        let chf = chf_grid(10, 10, 1, |_, _| 4);
        let mesh = square_mesh(1, 1, 9, 9, 4, 1);
        let (status, d) = build_poly_mesh_detail(&mesh, &chf, 0.0, 0.0);
        assert_eq!(status, RcDetailStatus::Success);
        assert_eq!(d.meshes[0].y, 4);
        assert_eq!(d.ntris(), 2);
    }

    #[test]
    fn deterministic() {
        let bump = |x: i32, z: i32| if (4..=6).contains(&x) && (4..=6).contains(&z) { 10 } else { 4 };
        let chf = chf_grid(12, 12, 1, bump);
        let mesh = square_mesh(1, 1, 11, 11, 4, 1);
        let (_, a) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        let (_, b) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        assert_eq!(a.meshes, b.meshes);
        assert_eq!(a.tris, b.tris);
        assert_eq!(a.verts.len(), b.verts.len());
        for (x, y) in a.verts.iter().zip(b.verts.iter()) {
            assert_eq!((x.x.to_bits(), x.y.to_bits(), x.z.to_bits()), (y.x.to_bits(), y.y.to_bits(), y.z.to_bits()));
        }
        assert_eq!(a.warnings, b.warnings);
    }

    #[test]
    fn merge_details_offsets_bases() {
        let chf = chf_grid(10, 10, 1, |_, _| 4);
        let mesh = square_mesh(1, 1, 9, 9, 4, 1);
        let (_, a) = build_poly_mesh_detail(&mesh, &chf, 2.0, 0.5);
        let (status, m) = merge_poly_mesh_details(&[a.clone(), RcPolyMeshDetail::default(), a.clone()], 3);
        assert_eq!(status, RcDetailStatus::Success);
        assert_eq!(m.nmeshes(), 2);
        assert_eq!(m.meshes[1].x, a.nverts() as i32);
        assert_eq!(m.meshes[1].z, a.ntris() as i32);
        assert_eq!(m.nverts(), a.nverts() * 2);
    }

    #[test]
    fn geometry_helpers() {
        let a = Double3::new(0.0, 0.0, 0.0);
        let b = Double3::new(4.0, 0.0, 0.0);
        let c = Double3::new(0.0, 0.0, 4.0);
        let mut cc = Double3::default();
        let mut r = 0.0;
        assert!(circum_circle(a, b, c, &mut cc, &mut r));
        assert!((cc.x - 2.0).abs() < 1e-12 && (cc.z - 2.0).abs() < 1e-12);
        assert!((r - 8.0f64.sqrt()).abs() < 1e-12);
        assert!(!circum_circle(a, b, Double3::new(8.0, 0.0, 0.0), &mut cc, &mut r));
        assert_eq!(dist_pt_tri(Double3::new(1.0, 3.0, 1.0), a, b, c), 3.0);
        assert_eq!(dist_pt_tri(Double3::new(9.0, 0.0, 9.0), a, b, c), f64::MAX);
    }
}
