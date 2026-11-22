//! The f64 reference for 2D blend-space weights (T31, leaf L31a's check): Delaunay triangles by the
//! empty-circumcircle definition (every non-degenerate triple whose circumcircle holds no other
//! point), and a query's weights by barycentric coordinates inside a triangle or by projection onto
//! the nearest hull edge outside. A different model from the runtime's sweep-and-flip: for points
//! in general position (no four co-circular) both give the same triangles.

/// The Delaunay triangles of `points` (counter-clockwise, rotated to start at their lowest index,
/// sorted), for points in general position.
pub fn delaunay(points: &[[f64; 2]]) -> Vec<[u32; 3]> {
    let n = points.len();
    let mut out = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            for k in j + 1..n {
                let (a, b, c) = (points[i], points[j], points[k]);
                let o = orient(a, b, c);
                if o.abs() < 1e-12 {
                    continue;
                }
                let (b2, c2, jj, kk) = if o > 0.0 { (b, c, j, k) } else { (c, b, k, j) };
                let empty = (0..n)
                    .filter(|&m| m != i && m != j && m != k)
                    .all(|m| incircle(a, b2, c2, points[m]) <= 0.0);
                if empty {
                    out.push([i as u32, jj as u32, kk as u32]);
                }
            }
        }
    }
    out.sort();
    out
}

/// The edges of `triangles` that belong to one triangle only.
pub fn hull(triangles: &[[u32; 3]]) -> Vec<[u32; 2]> {
    let mut out = Vec::new();
    for t in triangles {
        for e in 0..3 {
            let (a, b) = (t[e], t[(e + 1) % 3]);
            if !triangles
                .iter()
                .any(|s| (0..3).any(|f| s[f] == b && s[(f + 1) % 3] == a))
            {
                out.push([a, b]);
            }
        }
    }
    out
}

/// The weight of every point for query `p` (one per point).
pub fn weights(points: &[[f64; 2]], triangles: &[[u32; 3]], p: [f64; 2]) -> Vec<f64> {
    let mut w = vec![0.0; points.len()];
    for t in triangles {
        let (a, b, c) = (
            points[t[0] as usize],
            points[t[1] as usize],
            points[t[2] as usize],
        );
        let d = orient(a, b, c);
        let wa = orient(p, b, c) / d;
        let wb = orient(a, p, c) / d;
        let wc = 1.0 - wa - wb;
        if wa >= -1e-9 && wb >= -1e-9 && wc >= -1e-9 {
            w[t[0] as usize] = wa.max(0.0);
            w[t[1] as usize] = wb.max(0.0);
            w[t[2] as usize] = wc.max(0.0);
            let s: f64 = w.iter().sum();
            w.iter_mut().for_each(|x| *x /= s);
            return w;
        }
    }
    let mut best = (f64::INFINITY, 0usize, 0usize, 0.0);
    for e in hull(triangles) {
        let (a, b) = (points[e[0] as usize], points[e[1] as usize]);
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let t = (((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
        let (qx, qy) = (a[0] + ex * t - p[0], a[1] + ey * t - p[1]);
        let d = qx * qx + qy * qy;
        if d < best.0 {
            best = (d, e[0] as usize, e[1] as usize, t);
        }
    }
    w[best.1] += 1.0 - best.3;
    w[best.2] += best.3;
    w
}

fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn incircle(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    let (adx, ady) = (a[0] - d[0], a[1] - d[1]);
    let (bdx, bdy) = (b[0] - d[0], b[1] - d[1]);
    let (cdx, cdy) = (c[0] - d[0], c[1] - d[1]);
    let ad = adx * adx + ady * ady;
    let bd = bdx * bdx + bdy * bdy;
    let cd = cdx * cdx + cdy * cdy;
    adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx)
}
