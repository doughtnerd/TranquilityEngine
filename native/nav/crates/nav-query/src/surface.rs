//! Surface queries on a navmesh (Foxfire's `NavMeshSurface.cs`). "Height" means distance along the polygon's bin
//! normal, so the same code works on floors, walls and ceilings. 2D tests happen in the bin's (t, b) plane.
use nav_format::{NavLink, NavMeshData, OrientationBin};
use nav_math::math::{self, max, saturate};
use nav_math::{Float2, Float3};

/// Point on a jump arc at `t` in [0, 1] (`NavMeshSurface.JumpArc`). Horizontal motion is linear; the apex (t = 0.5)
/// is `arc_height` above the higher of the two ends. The bake-time clearance test, the mover and the debug draws
/// all use it, so they agree on the trajectory.
pub fn jump_arc(from: Float3, to: Float3, arc_height: f32, t: f32) -> Float3 {
    let mut p = from.lerp(to, t);
    let k = arc_height + 0.5 * math::abs(to.y - from.y);
    p.y += 4.0 * k * t * (1.0 - t);
    p
}

/// `p` in the bin's (t, b) plane.
#[inline]
pub fn to_plane(bin: &OrientationBin, p: Float3) -> Float2 {
    Float2::new(p.dot(bin.t), p.dot(bin.b))
}

#[inline]
fn cross2(a: Float2, b: Float2) -> f32 {
    a.x * b.y - a.y * b.x
}

#[inline]
fn poly_vert(nav: &NavMeshData, vert_start: i32, i: i32) -> Float3 {
    nav.verts[nav.poly_verts[(vert_start + i) as usize] as usize]
}

/// True if `pos`, projected along the bin normal, lies inside the (convex) polygon.
pub fn point_in_poly(nav: &NavMeshData, poly: i32, pos: Float3) -> bool {
    let p = &nav.polys[poly as usize];
    let bin = nav.bins[p.bin as usize];
    let q = to_plane(&bin, pos);

    let (mut any_pos, mut any_neg) = (false, false);
    for i in 0..p.vert_count {
        let a = to_plane(&bin, poly_vert(nav, p.vert_start, i));
        let b = to_plane(&bin, poly_vert(nav, p.vert_start, (i + 1) % p.vert_count));
        let c = cross2(b - a, q - a);
        if c > 1e-6 {
            any_pos = true;
        } else if c < -1e-6 {
            any_neg = true;
        }
        if any_pos && any_neg {
            return false; // works for either winding
        }
    }
    true
}

/// Projects `pos` onto the polygon's surface along its bin normal: `(point, normal)`, or `None` if `pos` is outside
/// the polygon. Uses the detail mesh when present, otherwise the polygon's plane.
pub fn try_get_surface_point(nav: &NavMeshData, poly: i32, pos: Float3) -> Option<(Float3, Float3)> {
    let p = &nav.polys[poly as usize];
    let bin = nav.bins[p.bin as usize];

    if p.detail_tri_count == 0 {
        if !point_in_poly(nav, poly, pos) {
            return None;
        }
        let denom = bin.n.dot(p.normal);
        if math::abs(denom) < 1e-6 {
            return None;
        }
        let point = pos + bin.n * ((p.center - pos).dot(p.normal) / denom);
        return Some((point, p.normal));
    }

    let q = to_plane(&bin, pos);
    let h_pos = pos.dot(bin.n);

    for t in 0..p.detail_tri_count {
        let tri = nav.detail_tris[(p.detail_tri_start + t) as usize];
        let a = nav.detail_verts[(p.detail_vert_start + tri.x) as usize];
        let b = nav.detail_verts[(p.detail_vert_start + tri.y) as usize];
        let c = nav.detail_verts[(p.detail_vert_start + tri.z) as usize];

        // Same barycentric test as Detour's dtClosestHeightPointTriangle, in the bin plane.
        let a2 = to_plane(&bin, a);
        let v0 = to_plane(&bin, c) - a2;
        let v1 = to_plane(&bin, b) - a2;
        let v2 = q - a2;

        let mut d = cross2(v0, v1);
        if math::abs(d) < 1e-12 {
            continue;
        }
        let mut u = cross2(v2, v1); // weight of (c - a)
        let mut v = cross2(v0, v2); // weight of (b - a)
        if d < 0.0 {
            d = -d;
            u = -u;
            v = -v;
        }

        let eps = 1e-4 * d;
        if u >= -eps && v >= -eps && u + v <= d + eps {
            let ha = a.dot(bin.n);
            let h = ha + ((c.dot(bin.n) - ha) * u + (b.dot(bin.n) - ha) * v) / d;
            let point = pos + bin.n * (h - h_pos);

            let mut normal = (b - a).cross(c - a).normalize_safe(bin.n);
            if normal.dot(bin.n) < 0.0 {
                normal = -normal;
            }
            return Some((point, normal));
        }
    }
    None
}

/// Closest point on the polygon's surface, and the surface normal there. Inside: projected along the bin normal.
/// Outside: the nearest point on any detail triangle (or the polygon boundary if there is no detail mesh).
pub fn closest_point_on_poly(nav: &NavMeshData, poly: i32, pos: Float3) -> (Float3, Float3) {
    if let Some(r) = try_get_surface_point(nav, poly, pos) {
        return r;
    }

    let p = &nav.polys[poly as usize];
    let mut best = f32::MAX;
    let mut best_point = p.center;
    let mut normal = p.normal;

    if p.detail_tri_count > 0 {
        for t in 0..p.detail_tri_count {
            let tri = nav.detail_tris[(p.detail_tri_start + t) as usize];
            let a = nav.detail_verts[(p.detail_vert_start + tri.x) as usize];
            let b = nav.detail_verts[(p.detail_vert_start + tri.y) as usize];
            let c = nav.detail_verts[(p.detail_vert_start + tri.z) as usize];
            let cp = closest_point_on_triangle(pos, a, b, c);
            let d2 = pos.distance_sq(cp);
            if d2 < best {
                best = d2;
                best_point = cp;
                normal = (b - a).cross(c - a).normalize_safe(p.normal);
            }
        }
        if normal.dot(p.normal) < 0.0 {
            normal = -normal;
        }
        return (best_point, normal);
    }

    for i in 0..p.vert_count {
        let a = poly_vert(nav, p.vert_start, i);
        let b = poly_vert(nav, p.vert_start, (i + 1) % p.vert_count);
        let ab = b - a;
        let s = saturate((pos - a).dot(ab) / max(ab.length_sq(), 1e-12));
        let cp = a + ab * s;
        let d2 = pos.distance_sq(cp);
        if d2 < best {
            best = d2;
            best_point = cp;
        }
    }
    (best_point, normal)
}

/// Ericson, Real-Time Collision Detection, 5.1.5.
pub fn closest_point_on_triangle(p: Float3, a: Float3, b: Float3, c: Float3) -> Float3 {
    let (ab, ac, ap) = (b - a, c - a, p - a);
    let (d1, d2) = (ab.dot(ap), ac.dot(ap));
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = p - b;
    let (d3, d4) = (ab.dot(bp), ac.dot(bp));
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return a + ab * (d1 / (d1 - d3));
    }

    let cp = p - c;
    let (d5, d6) = (ab.dot(cp), ac.dot(cp));
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return a + ac * (d2 / (d2 - d6));
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return b + (c - b) * ((d4 - d3) / (d4 - d3 + (d5 - d6)));
    }

    let denom = 1.0 / (va + vb + vc);
    a + ab * (vb * denom) + ac * (vc * denom)
}

/// `NavLink.HingeAt`: the hinge for a crossing at point `p` of the source portal (`p`'s position along
/// `portal_a`..`portal_b`).
pub fn link_hinge_at(link: &NavLink, p: Float3) -> Float3 {
    let edge = link.portal_b - link.portal_a;
    let t = saturate((p - link.portal_a).dot(edge) / max(edge.length_sq(), 1e-12));
    link.hinge_a.lerp(link.hinge_b, t)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(x: f32, y: f32, z: f32) -> Float3 {
        Float3::new(x, y, z)
    }

    #[test]
    fn jump_arc_peaks_above_the_higher_end() {
        let (a, b) = (v(0.0, 0.0, 0.0), v(4.0, 1.0, 0.0));
        assert_eq!(jump_arc(a, b, 1.0, 0.0), a);
        assert_eq!(jump_arc(a, b, 1.0, 1.0), b);
        let mid = jump_arc(a, b, 1.0, 0.5);
        assert_eq!(mid.x, 2.0);
        assert_eq!(mid.y, 0.5 + 1.0 * (1.0 + 0.5)); // lerp 0.5, + 4 * 1.5 * 0.25
    }

    #[test]
    fn closest_point_on_triangle_regions() {
        let (a, b, c) = (v(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0), v(0.0, 0.0, 1.0));
        assert_eq!(closest_point_on_triangle(v(-1.0, 0.0, -1.0), a, b, c), a); // vertex
        assert_eq!(closest_point_on_triangle(v(0.5, 3.0, 0.25), a, b, c), v(0.5, 0.0, 0.25)); // inside
        assert_eq!(closest_point_on_triangle(v(0.5, 0.0, -1.0), a, b, c), v(0.5, 0.0, 0.0)); // edge ab
        assert_eq!(closest_point_on_triangle(v(2.0, 0.0, 2.0), a, b, c), v(0.5, 0.0, 0.5)); // hypotenuse
    }
}
