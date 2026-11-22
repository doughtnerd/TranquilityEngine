//! Leaf L31a: a 2D blend space's geometry (ADR 0342, after audio Blend's rule): a Delaunay
//! triangulation of the sample points, built once when the program is built, and the weights of a
//! query point: barycentric inside a triangle, or the projection onto the nearest hull edge for a
//! point outside the hull.
//!
//! Pure functions, no state. [`triangulate`] allocates (load time); [`weights`] never does.
//!
//! # Triangulation
//!
//! Deterministic for a given input order:
//!
//! 1. Exact duplicates are dropped (the first copy of a point represents it; the others get no
//!    weight).
//! 2. The remaining points are inserted in lexicographic order (x, then y, then input index), each
//!    joined to every hull edge it sees (a sweep, so every point lands outside the hull built so
//!    far); a run of collinear leading points is fanned to the first point off their line.
//! 3. Lawson flips make it Delaunay: an interior edge is flipped while the opposite vertex lies
//!    strictly inside the other triangle's circumcircle (relative tolerance [`INCIRCLE_EPS`]), so
//!    co-circular points (a square grid) keep the sweep's diagonal rather than flipping forever.
//!
//! Arithmetic is plain `f64` `+ - × ÷` (no fused multiply-add), so every target builds the same
//! triangles. Triangles are counter-clockwise, rotated to start at their lowest index and sorted.
//! With fewer than three distinct points, or all of them collinear, there are no triangles and
//! the "hull" is the chain of segments between consecutive points along their line.
//!
//! # Weights
//!
//! [`weights`] works in `f32` (the runtime's arithmetic): the first triangle (in sorted order)
//! whose barycentric coordinates are all at least `-1e-6` contains the point, and its three
//! coordinates (clamped at 0 and renormalised) are the weights. Otherwise the point is projected
//! onto every hull edge and the nearest projection wins (the lowest edge index on a tie): its two
//! end points share the weight by the projection's parameter. A single distinct point gets weight 1.

/// The relative tolerance of the in-circle test (scaled by the squared extent of the points).
pub const INCIRCLE_EPS: f64 = 1e-12;

/// A triangulation: triangles and hull edges as indices into the caller's point list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Triangulation {
    /// Counter-clockwise triangles.
    pub triangles: Vec<[u32; 3]>,
    /// Hull edges (counter-clockwise around the hull), or the collinear chain's segments.
    pub hull: Vec<[u32; 2]>,
}

fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Positive when `d` is inside the circumcircle of the counter-clockwise triangle `a b c`.
fn incircle(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    let (adx, ady) = (a[0] - d[0], a[1] - d[1]);
    let (bdx, bdy) = (b[0] - d[0], b[1] - d[1]);
    let (cdx, cdy) = (c[0] - d[0], c[1] - d[1]);
    let ad = adx * adx + ady * ady;
    let bd = bdx * bdx + bdy * bdy;
    let cd = cdx * cdx + cdy * cdy;
    adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx)
}

/// Triangulates `points` (see the module docs). Allocates; load time only.
pub fn triangulate(points: &[[f32; 2]]) -> Triangulation {
    let p: Vec<[f64; 2]> = points.iter().map(|q| [q[0] as f64, q[1] as f64]).collect();
    // Distinct points, by first occurrence.
    let mut unique: Vec<u32> = Vec::new();
    for (i, q) in p.iter().enumerate() {
        if q[0].is_finite() && q[1].is_finite() && !unique.iter().any(|&u| p[u as usize] == *q) {
            unique.push(i as u32);
        }
    }
    sort_small(&mut unique, |&a, &b| {
        let (pa, pb) = (p[a as usize], p[b as usize]);
        pa[0]
            .total_cmp(&pb[0])
            .then(pa[1].total_cmp(&pb[1]))
            .then(a.cmp(&b))
            .is_lt()
    });
    let at = |i: u32| p[i as usize];
    let mut extent = 0.0f64;
    for &u in &unique {
        for &v in &unique {
            let (a, b) = (at(u), at(v));
            extent = extent.max((a[0] - b[0]).abs()).max((a[1] - b[1]).abs());
        }
    }
    let scale2 = (extent * extent).max(f64::MIN_POSITIVE);
    let collinear_eps = 1e-12 * scale2;

    // The first point off the line of the leading points.
    let k = (2..unique.len())
        .find(|&k| orient(at(unique[0]), at(unique[1]), at(unique[k])).abs() > collinear_eps);
    let Some(k) = k else {
        // Collinear (or fewer than three points): the chain along the sorted order.
        let hull = unique.windows(2).map(|w| [w[0], w[1]]).collect();
        return Triangulation {
            triangles: Vec::new(),
            hull,
        };
    };
    let mut tris: Vec<[u32; 3]> = Vec::new();
    let push = |tris: &mut Vec<[u32; 3]>, a: u32, b: u32, c: u32| {
        if orient(at(a), at(b), at(c)) > 0.0 {
            tris.push([a, b, c]);
        } else {
            tris.push([a, c, b]);
        }
    };
    let apex = unique[k];
    for w in unique[..k].windows(2) {
        push(&mut tris, w[0], w[1], apex);
    }
    for &q in &unique[k + 1..] {
        let edges = boundary(&tris);
        for [a, b] in edges {
            if orient(at(a), at(b), at(q)) < -collinear_eps {
                push(&mut tris, a, b, q);
            }
        }
    }

    // Lawson flips until locally Delaunay.
    let eps = INCIRCLE_EPS * scale2 * scale2;
    let mut guard = 0usize;
    'outer: loop {
        guard += 1;
        if guard > 64 * (tris.len() + 1) * (tris.len() + 1) {
            break;
        }
        for t in 0..tris.len() {
            for e in 0..3 {
                let (a, b, c) = (tris[t][e], tris[t][(e + 1) % 3], tris[t][(e + 2) % 3]);
                // The triangle across edge a→b holds b→a.
                let Some((u, d)) = tris.iter().enumerate().find_map(|(u, s)| {
                    (0..3).find_map(|f| {
                        (s[f] == b && s[(f + 1) % 3] == a).then_some((u, s[(f + 2) % 3]))
                    })
                }) else {
                    continue;
                };
                if incircle(at(a), at(b), at(c), at(d)) > eps
                    && orient(at(c), at(a), at(d)) > 0.0
                    && orient(at(d), at(b), at(c)) > 0.0
                {
                    tris[t] = [c, a, d];
                    tris[u] = [d, b, c];
                    continue 'outer;
                }
            }
        }
        break;
    }
    for t in tris.iter_mut() {
        let m = (0..3).min_by_key(|&i| t[i]).unwrap_or(0);
        *t = [t[m], t[(m + 1) % 3], t[(m + 2) % 3]];
    }
    sort_small(&mut tris, |a, b| a < b);
    let hull = boundary(&tris);
    Triangulation {
        triangles: tris,
        hull,
    }
}

/// Sorts a short list (load time) by `less`, stably: an insertion sort, so the module doesn't pull
/// a general-purpose sort into the wasm for lists of a few dozen entries.
pub fn sort_small<T: Copy>(v: &mut [T], less: impl Fn(&T, &T) -> bool) {
    for i in 1..v.len() {
        let x = v[i];
        let mut j = i;
        while j > 0 && less(&x, &v[j - 1]) {
            v[j] = v[j - 1];
            j -= 1;
        }
        v[j] = x;
    }
}

/// The edges that belong to exactly one triangle, in triangle order.
fn boundary(tris: &[[u32; 3]]) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    for t in tris {
        for e in 0..3 {
            let (a, b) = (t[e], t[(e + 1) % 3]);
            let shared = tris
                .iter()
                .any(|s| (0..3).any(|f| s[f] == b && s[(f + 1) % 3] == a));
            if !shared {
                out.push([a, b]);
            }
        }
    }
    out
}

/// The weights of `p` (see the module docs): up to three point indices with their weights (unused
/// entries have weight 0). `points` is the list the triangulation was built from. Never allocates.
pub fn weights(
    points: &[[f32; 2]],
    triangles: &[[u32; 3]],
    hull: &[[u32; 2]],
    p: [f32; 2],
) -> ([u32; 3], [f32; 3]) {
    let get = |i: u32| points.get(i as usize).copied().unwrap_or([0.0, 0.0]);
    for t in triangles {
        let (a, b, c) = (get(t[0]), get(t[1]), get(t[2]));
        let d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if d == 0.0 {
            continue;
        }
        let wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
        let wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
        let wc = 1.0 - wa - wb;
        const TOL: f32 = -1e-6;
        if wa >= TOL && wb >= TOL && wc >= TOL {
            let (wa, wb, wc) = (wa.max(0.0), wb.max(0.0), wc.max(0.0));
            let s = wa + wb + wc;
            return if s > 0.0 {
                (*t, [wa / s, wb / s, wc / s])
            } else {
                (*t, [1.0, 0.0, 0.0])
            };
        }
    }
    let mut best: Option<(f32, [u32; 2], f32)> = None;
    for e in hull {
        let (a, b) = (get(e[0]), get(e[1]));
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let len2 = ex * ex + ey * ey;
        let t = if len2 > 0.0 {
            let t = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2;
            t.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (qx, qy) = (a[0] + ex * t - p[0], a[1] + ey * t - p[1]);
        let d2 = qx * qx + qy * qy;
        if best.is_none_or(|(bd, _, _)| d2 < bd) {
            best = Some((d2, *e, t));
        }
    }
    match best {
        Some((_, [a, b], t)) => ([a, b, a], [1.0 - t, t, 0.0]),
        None => {
            // One distinct point: the first finite point (or index 0).
            let first = points
                .iter()
                .position(|q| q[0].is_finite() && q[1].is_finite())
                .unwrap_or(0) as u32;
            ([first, first, first], [1.0, 0.0, 0.0])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(points: &[[f32; 2]], tris: &[[u32; 3]]) -> f64 {
        tris.iter()
            .map(|t| {
                let a = points[t[0] as usize].map(|v| v as f64);
                let b = points[t[1] as usize].map(|v| v as f64);
                let c = points[t[2] as usize].map(|v| v as f64);
                0.5 * orient(a, b, c)
            })
            .sum()
    }

    fn check_delaunay(points: &[[f32; 2]], tr: &Triangulation) {
        let p: Vec<[f64; 2]> = points.iter().map(|q| q.map(|v| v as f64)).collect();
        for t in &tr.triangles {
            assert!(orient(p[t[0] as usize], p[t[1] as usize], p[t[2] as usize]) > 0.0);
            for (i, q) in p.iter().enumerate() {
                if t.contains(&(i as u32)) {
                    continue;
                }
                let v = incircle(p[t[0] as usize], p[t[1] as usize], p[t[2] as usize], *q);
                assert!(v <= 1e-9, "point {i} inside the circumcircle of {t:?}");
            }
        }
    }

    #[test]
    fn a_square_is_two_triangles_and_four_hull_edges() {
        let pts = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let tr = triangulate(&pts);
        assert_eq!(tr.triangles.len(), 2);
        assert_eq!(tr.hull.len(), 4);
        assert!((area(&pts, &tr.triangles) - 1.0).abs() < 1e-12);
        // Deterministic: the same input gives the same triangles.
        assert_eq!(triangulate(&pts), tr);
    }

    #[test]
    fn a_grid_covers_its_hull_and_is_delaunay() {
        let mut pts = Vec::new();
        for y in 0..3 {
            for x in 0..3 {
                pts.push([x as f32 - 1.0, y as f32 - 1.0]);
            }
        }
        let tr = triangulate(&pts);
        assert_eq!(tr.triangles.len(), 8);
        assert_eq!(tr.hull.len(), 8);
        assert!((area(&pts, &tr.triangles) - 4.0).abs() < 1e-9);
        check_delaunay(&pts, &tr);
    }

    #[test]
    fn scattered_points_are_delaunay() {
        let mut s = 12345u32;
        let mut r = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s >> 8) as f32 / (1u32 << 24) as f32 * 4.0 - 2.0
        };
        let pts: Vec<[f32; 2]> = (0..24).map(|_| [r(), r()]).collect();
        let tr = triangulate(&pts);
        check_delaunay(&pts, &tr);
        // Euler: for n points with h on the hull, 2n - 2 - h triangles.
        assert_eq!(tr.triangles.len(), 2 * pts.len() - 2 - tr.hull.len());
    }

    #[test]
    fn duplicates_and_collinear_points() {
        let pts = [[0.0, 0.0], [1.0, 0.0], [0.0, 0.0], [2.0, 0.0]];
        let tr = triangulate(&pts);
        assert!(tr.triangles.is_empty());
        assert_eq!(tr.hull, vec![[0, 1], [1, 3]]);
        let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, [1.5, 3.0]);
        assert_eq!((idx[0], idx[1]), (1, 3));
        assert!((w[0] - 0.5).abs() < 1e-6 && (w[1] - 0.5).abs() < 1e-6);
        // Collinear leading points then one off the line: fanned.
        let pts = [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [1.0, 1.0]];
        let tr = triangulate(&pts);
        assert_eq!(tr.triangles.len(), 2);
        check_delaunay(&pts, &tr);
    }

    #[test]
    fn weights_reproduce_vertices_and_interpolate_linearly() {
        let pts = [[0.0, 0.0], [2.0, 0.0], [0.0, 2.0], [2.0, 2.0], [1.0, 1.2]];
        let tr = triangulate(&pts);
        for (i, p) in pts.iter().enumerate() {
            let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, *p);
            let total: f32 = (0..3).filter(|&k| idx[k] == i as u32).map(|k| w[k]).sum();
            assert!((total - 1.0).abs() < 1e-5, "vertex {i}: {idx:?} {w:?}");
        }
        // Linear precision: the weighted sum of the points is the query.
        for q in [[0.3, 0.4], [1.5, 1.7], [1.0, 0.1]] {
            let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, q);
            let s = (0..3).fold([0.0f32; 2], |s, k| {
                let p = pts[idx[k] as usize];
                [s[0] + w[k] * p[0], s[1] + w[k] * p[1]]
            });
            assert!((s[0] - q[0]).abs() < 1e-5 && (s[1] - q[1]).abs() < 1e-5);
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn outside_points_project_onto_the_nearest_hull_edge() {
        let pts = [[0.0, 0.0], [2.0, 0.0], [0.0, 2.0]];
        let tr = triangulate(&pts);
        // Below the bottom edge, a quarter of the way along.
        let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, [0.5, -3.0]);
        let get = |i: u32| (0..3).filter(|&k| idx[k] == i).map(|k| w[k]).sum::<f32>();
        assert!((get(0) - 0.75).abs() < 1e-6 && (get(1) - 0.25).abs() < 1e-6);
        assert_eq!(get(2), 0.0);
        // Past a corner: all weight on the corner.
        let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, [5.0, -1.0]);
        let get = |i: u32| (0..3).filter(|&k| idx[k] == i).map(|k| w[k]).sum::<f32>();
        assert!((get(1) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn one_point_takes_all_the_weight() {
        let pts = [[3.0, 4.0]];
        let tr = triangulate(&pts);
        assert!(tr.triangles.is_empty() && tr.hull.is_empty());
        let (idx, w) = weights(&pts, &tr.triangles, &tr.hull, [0.0, 0.0]);
        assert_eq!((idx[0], w[0]), (0, 1.0));
    }
}
