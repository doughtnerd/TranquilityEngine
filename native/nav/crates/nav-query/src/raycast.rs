//! A navmesh raycast along the walkable surface (new: Foxfire has no navmesh raycast; ADR 0065's
//! `Navigation.raycast`). It is a walking line-of-sight test: how far a straight walk from `start` towards
//! `end` goes before a wall.
//!
//! # Design
//! It follows Detour's `raycast`, generalised to surfaces that fold:
//! * The ray lives in 2D, in the *frame* of the current polygon's orientation bin (a polygon's vertices
//!   projected on the bin's `t` and `b` axes, like the straight-path funnel). Each stage clips the segment to
//!   the current polygon (convex in its frame), which gives the exit parameter and the exit edge.
//! * **Edge links.** The exit edge is matched to a link of the polygon whose portal lies on that edge and
//!   spans the exit point. An internal link crosses into the neighbour in the same frame, the segment
//!   unchanged. Jump links are never followed (a raycast tests walking line of sight).
//! * **Folds.** A fold link is crossed only if its polygon is usable and the fold is allowed
//!   (`NavFold.Delta(fold_angle) <= max_fold_angle`, as the A* decides). The next surface is *unfolded*: laid
//!   in the plane of the current one, its edge parallel to the source edge one gap-width further on, exactly
//!   as the straight-path funnel builds its portals. Then the ray is re-aimed from the crossing point at
//!   `end`'s position in the new polygon's frame ("retargeting"): when `end` lies on the straight unfolding of
//!   the walk this is the same as rotating the remaining ray into the next surface, and when it lies on a
//!   different surface than the one the walk started on (a point up a wall) it still arrives, which a plain
//!   rotation of the start-surface projection would not.
//! * **Walls.** The ray stops at an edge with no link across it, or whose link leads to a polygon that is not
//!   usable (bin not allowed, area excluded, closed gate) or across a fold that is not allowed. The hit is on
//!   that edge; its normal is the edge's outward normal in the polygon's plane.
//!
//! # Result
//! * `t`: 1 if reached; else the fraction of the walking distance done at the hit (distance along the unfolded
//!   walk, up to the stage's own target). In a single frame this is Detour's `t` exactly.
//! * `hit_point`: the end when reached, else the point on the wall edge (3D, interpolated along the edge).
//! * `hit_normal`: zero when reached, else the outward unit normal of the wall edge in the polygon's plane,
//!   pointing out of the walkable polygon, so it points along the ray, not back at it (Detour's convention;
//!   negate it for "back into walkable space").
//! * `polys`: the polygons walked, start first, the polygon the ray ended or hit in last.
//!
//! # Tolerances (documented epsilon rules)
//! * [`EDGE_EPS`] (1 mm): a start within it of a polygon's edge counts as inside (a start on an edge or vertex
//!   works); a start slightly *outside* across an edge, heading out, exits at t = 0 through that edge (into the
//!   neighbour, or a hit if there's none). A start farther than that outside `start_poly` returns `t = 0`,
//!   no polygons, not reached.
//! * A link covers the exit point if the point lies within [`EDGE_EPS`] of the link's portal span along the
//!   edge. A ray that passes exactly through a vertex follows the first edge the clip finds; grazing the corner
//!   of a hole counts as a hit.
//! * Edges and portals match if the portal's midpoint is within 1 mm of the edge.
//!
//! Pure and deterministic: no state, no randomness, ties break by edge and link order.
//!
//! The frame and unfolding code below duplicates the straight-path funnel's (`straight_path.rs`) and the
//! polygon helpers duplicate `surface.rs`; they are private here so this module stands alone. Merge later.
use nav_format::{NavLink, NavLinkKind, NavMeshData, NavPoly, OrientationBin};
use nav_math::{Float2, Float3};

/// Distance (world units) within which a point counts as on an edge (see the module docs).
pub const EDGE_EPS: f32 = 1e-3;

/// Which polygons and folds a ray may use (the `NavMeshQueryFilter` fields that decide walking).
#[derive(Clone, Copy, Debug)]
pub struct RaycastFilter<'a> {
    /// Bit k set => polygons in orientation bin k may be walked.
    pub allowed_bins: u64,
    /// Radians: folds whose `NavFold.Delta` is larger are not crossed.
    pub max_fold_angle: f32,
    /// Bit a set => polygons in area a are walls.
    pub excluded_areas: u64,
    /// Gate states by gate index (`NavPoly::gate`); shorter than a gate's index: that gate is open.
    pub closed_gates: &'a [bool],
}

impl Default for RaycastFilter<'_> {
    /// Every bin, every fold, nothing excluded, no gates (`NavMeshQueryFilter.Default`).
    fn default() -> Self {
        Self { allowed_bins: u64::MAX, max_fold_angle: std::f32::consts::PI, excluded_areas: 0, closed_gates: &[] }
    }
}

impl RaycastFilter<'_> {
    fn poly_usable(&self, poly: &NavPoly) -> bool {
        if poly.vert_count < 3 {
            return false;
        }
        if self.allowed_bins & (1u64 << (poly.bin & 63)) == 0 {
            return false;
        }
        if self.excluded_areas & (1u64 << (poly.area & 63)) != 0 {
            return false;
        }
        let g = poly.gate;
        !(g > 0 && (g as usize) < self.closed_gates.len() && self.closed_gates[g as usize])
    }
}

/// What a raycast found (see the module docs).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RaycastHit {
    pub t: f32,
    pub hit_point: Float3,
    pub hit_normal: Float3,
    pub polys: Vec<i32>,
    pub reached: bool,
}

/// `NavFold.Delta`: `min(angle, pi - angle)`.
fn fold_delta(fold_angle: f32) -> f32 {
    let a = fold_angle;
    let b = std::f32::consts::PI - fold_angle;
    if b < a {
        b
    } else {
        a
    }
}

/// A bin's frame laid in the plane: rotation and offset (the funnel's `Unfold`).
#[derive(Clone, Copy)]
struct Frame {
    bin: usize,
    cos: f32,
    sin: f32,
    offset: Float2,
}

impl Frame {
    fn identity(bin: usize) -> Self {
        Self { bin, cos: 1.0, sin: 0.0, offset: Float2::default() }
    }

    fn apply(&self, b: &OrientationBin, p: Float3) -> Float2 {
        let q = Float2::new(p.dot(b.t), p.dot(b.b));
        Float2::new(self.cos * q.x - self.sin * q.y, self.sin * q.x + self.cos * q.y) + self.offset
    }
}

fn cross2(a: Float2, b: Float2) -> f32 {
    a.x * b.y - a.y * b.x
}

fn poly_verts<'a>(nav: &'a NavMeshData, poly: &NavPoly) -> impl Iterator<Item = Float3> + 'a {
    let (start, count) = (poly.vert_start as usize, poly.vert_count as usize);
    nav.poly_verts[start..start + count].iter().map(move |&i| nav.verts[i as usize])
}

fn poly_verts_2d(nav: &NavMeshData, poly: &NavPoly, frame: &Frame) -> Vec<Float2> {
    let bin = &nav.bins[frame.bin];
    poly_verts(nav, poly).map(|v| frame.apply(bin, v)).collect()
}

/// +1 for a counter-clockwise polygon in its frame, -1 for clockwise.
fn winding(verts: &[Float2]) -> f32 {
    let mut area2 = 0.0f32;
    for i in 0..verts.len() {
        area2 += cross2(verts[i], verts[(i + 1) % verts.len()]);
    }
    if area2 >= 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// True if `p` is inside the polygon or within `eps` of its edges.
fn inside_poly(verts: &[Float2], p: Float2, eps: f32) -> bool {
    let sgn = winding(verts);
    for i in 0..verts.len() {
        let a = verts[i];
        let e = verts[(i + 1) % verts.len()] - a;
        let len = e.length();
        if len < 1e-9 {
            continue;
        }
        if sgn * cross2(e, p - a) / len < -eps {
            return false;
        }
    }
    true
}

/// Clips the segment p0-p1 to a convex polygon: (entry parameter, exit parameter, exit edge or -1 if the
/// segment ends inside), or `None` if it misses (`dtIntersectSegmentPoly2D`).
fn clip_segment(verts: &[Float2], p0: Float2, p1: Float2) -> Option<(f32, f32, i32)> {
    let n = verts.len();
    let sgn = winding(verts);
    let d = p1 - p0;
    let (mut tmin, mut tmax, mut exit) = (0.0f32, 1.0f32, -1i32);
    for i in 0..n {
        let a = verts[i];
        let e = verts[(i + 1) % n] - a;
        let len = e.length();
        if len < 1e-9 {
            continue;
        }
        // Signed distances: positive is inside.
        let num = sgn * cross2(e, p0 - a) / len;
        let den = sgn * cross2(e, d) / len;
        if den.abs() < 1e-9 {
            if num < -EDGE_EPS {
                return None; // parallel and outside
            }
            continue;
        }
        if den < 0.0 {
            // Leaving through this edge.
            if num < -EDGE_EPS {
                return None; // already outside and heading out
            }
            let t = (-num / den).max(0.0);
            if t < tmax {
                tmax = t;
                exit = i as i32;
            }
        } else {
            let t = -num / den;
            if t > tmin {
                tmin = t;
            }
        }
    }
    if tmin > tmax {
        return None;
    }
    Some((tmin, tmax, exit))
}

/// A navmesh edge's outward unit normal in the polygon's plane (zero for a degenerate edge).
fn edge_outward_normal(nav: &NavMeshData, poly: &NavPoly, edge: usize) -> Float3 {
    let (a, b) = edge_ends(nav, poly, edge);
    let mut out = (b - a).cross(poly.normal);
    let mid = (a + b) * 0.5;
    if out.dot(mid - poly.center) < 0.0 {
        out = -out;
    }
    out.normalize_safe(Float3::default())
}

fn edge_ends(nav: &NavMeshData, poly: &NavPoly, edge: usize) -> (Float3, Float3) {
    let n = poly.vert_count as usize;
    let s = poly.vert_start as usize;
    let a = nav.verts[nav.poly_verts[s + edge] as usize];
    let b = nav.verts[nav.poly_verts[s + (edge + 1) % n] as usize];
    (a, b)
}

/// The link crossing edge `edge` of `poly` at `u` (fraction along the 3D edge), if any. Jump links never.
fn link_at(nav: &NavMeshData, poly: &NavPoly, edge: usize, u: f32) -> Option<usize> {
    let (a, b) = edge_ends(nav, poly, edge);
    let e = b - a;
    let len2 = e.length_sq();
    if len2 < 1e-12 {
        return None;
    }
    let len = len2.sqrt();
    let eps_u = EDGE_EPS / len;
    for k in 0..poly.link_count {
        let li = (poly.link_start + k) as usize;
        let link: &NavLink = &nav.links[li];
        if link.kind == NavLinkKind::JUMP {
            continue;
        }
        // The portal lies on this edge?
        let mid = (link.portal_a + link.portal_b) * 0.5;
        let tm = ((mid - a).dot(e) / len2).clamp(0.0, 1.0);
        if mid.distance(a + e * tm) > EDGE_EPS {
            continue;
        }
        let ua = (link.portal_a - a).dot(e) / len2;
        let ub = (link.portal_b - a).dot(e) / len2;
        let (lo, hi) = if ua <= ub { (ua, ub) } else { (ub, ua) };
        if u >= lo - eps_u && u <= hi + eps_u {
            return Some(li);
        }
    }
    None
}

/// The unfolding of the polygon across a fold link into the plane of the frame the ray is in
/// (`NavMeshStraightPath.BuildPortals`' fold branch).
fn unfold_across(nav: &NavMeshData, cur: &NavPoly, frame: &Frame, link: &NavLink, new_bin: usize) -> Frame {
    let bin = &nav.bins[frame.bin];
    let a2 = frame.apply(bin, link.portal_a);
    let b2 = frame.apply(bin, link.portal_b);
    let prev_center = frame.apply(bin, cur.center);

    // The portal's unit normal pointing away from the polygon we come from.
    let e = b2 - a2;
    let mut fwd = Float2::new(-e.y, e.x).normalize_safe(Float2::default());
    if fwd.dot((a2 + b2) * 0.5 - prev_center) < 0.0 {
        fwd = -fwd;
    }

    let gap = 0.5 * (link.portal_a.distance(link.dest_a) + link.portal_b.distance(link.dest_b));
    let target_a = a2 + fwd * gap;
    let target_b = b2 + fwd * gap;

    let nb = &nav.bins[new_bin];
    let raw_a = Float2::new(link.dest_a.dot(nb.t), link.dest_a.dot(nb.b));
    let raw_b = Float2::new(link.dest_b.dot(nb.t), link.dest_b.dot(nb.b));
    let from = raw_b - raw_a;
    let to = target_b - target_a;
    let ang = cross2(from, to).atan2(from.dot(to));
    let (cos, sin) = (ang.cos(), ang.sin());
    let raw_mid = (raw_a + raw_b) * 0.5;
    let rotated_mid = Float2::new(cos * raw_mid.x - sin * raw_mid.y, sin * raw_mid.x + cos * raw_mid.y);
    Frame { bin: new_bin, cos, sin, offset: (target_a + target_b) * 0.5 - rotated_mid }
}

/// Walks the surface from `start` (on `start_poly`) towards `end` and reports how far it gets (see the module
/// docs).
pub fn raycast(nav: &NavMeshData, filter: &RaycastFilter, start_poly: i32, start: Float3, end: Float3) -> RaycastHit {
    let mut hit = RaycastHit { t: 0.0, hit_point: start, hit_normal: Float3::default(), polys: Vec::new(), reached: false };
    if start_poly < 0 || start_poly as usize >= nav.polys.len() {
        return hit;
    }
    let first = &nav.polys[start_poly as usize];
    if !filter.poly_usable(first) {
        return hit;
    }

    let mut cur = start_poly;
    let mut frame = Frame::identity(first.bin as usize);
    let mut o = frame.apply(&nav.bins[frame.bin], start);
    let mut e = frame.apply(&nav.bins[frame.bin], end);
    if !inside_poly(&poly_verts_2d(nav, first, &frame), o, EDGE_EPS) {
        return hit;
    }
    let mut base = 0.0f32; // distance walked in earlier stages
    let cap = nav.polys.len() * 2 + 16;
    // Where the last crossing was, for a hit on a miss of the next polygon.
    let mut last_exit: Option<(f32, Float3, Float3)> = None;
    hit.polys.push(start_poly);

    loop {
        let poly = &nav.polys[cur as usize];
        let verts = poly_verts_2d(nav, poly, &frame);
        let stage_len = (e - o).length();
        let Some((_tmin, tmax, exit)) = clip_segment(&verts, o, e) else {
            // Missed the polygon it was crossing into (slipped past a fold's corner): stop at the last crossing.
            if let Some((t, p, n)) = last_exit {
                hit.t = t;
                hit.hit_point = p;
                hit.hit_normal = n;
            }
            return hit;
        };

        if exit < 0 {
            hit.t = 1.0;
            hit.hit_point = end;
            hit.hit_normal = Float3::default();
            hit.reached = true;
            return hit;
        }
        let exit = exit as usize;

        // Where the segment leaves, in 2D and along the 3D edge.
        let x2 = o + (e - o) * tmax;
        let (v0, v1) = (verts[exit], verts[(exit + 1) % verts.len()]);
        let e2 = v1 - v0;
        let len2 = e2.dot(e2);
        let u = if len2 > 1e-12 { ((x2 - v0).dot(e2) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let (ea, eb) = edge_ends(nav, poly, exit);
        let exit_point = ea + (eb - ea) * u;
        let arc = base + tmax * stage_len;
        let total = base + stage_len;
        let t_here = if total > 1e-9 { (arc / total).clamp(0.0, 1.0) } else { 0.0 };
        let normal = edge_outward_normal(nav, poly, exit);

        let wall = |hit: &mut RaycastHit| {
            hit.t = t_here;
            hit.hit_point = exit_point;
            hit.hit_normal = normal;
        };

        let Some(li) = link_at(nav, poly, exit, u) else {
            wall(&mut hit);
            return hit;
        };
        let link = &nav.links[li];
        let next = link.to_poly;
        if next < 0 || next as usize >= nav.polys.len() || !filter.poly_usable(&nav.polys[next as usize]) {
            wall(&mut hit);
            return hit;
        }
        if hit.polys.len() >= cap {
            wall(&mut hit);
            return hit;
        }

        if link.kind == NavLinkKind::FOLD {
            if fold_delta(link.fold_angle) > filter.max_fold_angle {
                wall(&mut hit);
                return hit;
            }
            let next_poly = &nav.polys[next as usize];
            let new_frame = unfold_across(nav, poly, &frame, link, next_poly.bin as usize);
            // Retarget: from the crossing point at `end` as the new surface sees it.
            base += (x2 - o).length();
            o = x2;
            e = new_frame.apply(&nav.bins[new_frame.bin], end);
            frame = new_frame;
        }
        // An internal link keeps the frame and the segment.

        last_exit = Some((t_here, exit_point, normal));
        cur = next;
        hit.polys.push(cur);
    }
}
