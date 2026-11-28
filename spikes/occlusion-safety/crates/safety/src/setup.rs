//! Occluder triangle setup with the ADR 0460 §3 conservativeness rules: depth pushed back by the error, coverage shrink,
//! the near-distance skip and the width test. Perspective cameras only. The geometry path mirrors `occ::cull::setup_tri`
//! (same clip order, same edge setup) so that with every rule off the depth buffer is bit-identical to the spike's.
use crate::data::{Occluder, Standin};
use occ::cull::xform_scalar;
use occ::geom::{Camera, GUARD};
use occ::raster::Tri;

pub type V4 = [f32; 4];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Shrink {
    None,
    /// A constant `s` on every triangle edge (the spike's `inner`).
    Floor(f32),
    /// max(floor, projected error in buffer pixels) on every triangle edge, interior edges included.
    ErrAll(f32),
    /// The same amount, but only on boundary and silhouette edges (interior edges between two front faces keep their coverage).
    ErrSil(f32),
}
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Near {
    None,
    /// Skip when the camera is within k x camera near of the occluder's bounds.
    Mult(f32),
    /// Skip when the camera is within r metres of the occluder's bounds.
    Radius(f32),
    /// Per triangle (not per bounds): skip a triangle whose distance to the camera is at most near + k x its own error, i.e.
    /// when the real surface could lie on the camera's side of the stand-in.
    TriErr(f32),
}
#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub name: &'static str,
    pub push: bool,
    /// Push by e / max(|cos|, 0.2) of the angle between the triangle normal and the view ray.
    pub graze: bool,
    pub shrink: Shrink,
    pub near: Near,
    pub width: bool,
    /// Drop stand-in triangles whose sampled error exceeds this fraction of the original's bbox diagonal (0 = off). Uses
    /// per-triangle errors for push and shrink instead of the stand-in's global error.
    pub trim: f32,
    /// Occludee rect dilation in buffer pixels (the spike's accuracy configuration uses 1).
    pub dilate: i32,
    /// Safety factor applied to every error (push and shrink).
    pub emul: f32,
}

pub const RULE_NONE: Rule = Rule { name: "none", push: false, graze: false, shrink: Shrink::None, near: Near::None, width: false, trim: 0.0, dilate: 1, emul: 1.0 };

#[inline]
fn dist(cam: &Camera, k: usize, v: &V4) -> f32 {
    match k {
        0 => v[3] - cam.near,
        1 => v[0] + GUARD * v[3],
        2 => GUARD * v[3] - v[0],
        3 => v[1] + GUARD * v[3],
        _ => GUARD * v[3] - v[1],
    }
}

#[derive(Clone, Copy)]
struct Poly {
    v: [V4; 12],
    f: [bool; 12],
    n: usize,
}

fn clip(cam: &Camera, k: usize, p: &Poly) -> Poly {
    let mut o = Poly { v: [[0.0; 4]; 12], f: [false; 12], n: 0 };
    for i in 0..p.n {
        let (a, b) = (p.v[i], p.v[(i + 1) % p.n]);
        let (da, db) = (dist(cam, k, &a), dist(cam, k, &b));
        if da >= 0.0 {
            o.v[o.n] = a;
            o.f[o.n] = p.f[i];
            o.n += 1;
        }
        if (da >= 0.0) != (db >= 0.0) {
            let t = da / (da - db);
            o.v[o.n] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
            // leaving: the new edge runs along the clip plane (never a surface edge); entering: it is a piece of the original edge
            o.f[o.n] = da < 0.0 && p.f[i];
            o.n += 1;
        }
    }
    o
}

#[inline]
fn project(w: usize, h: usize, v: V4) -> (f32, f32, f32) {
    let rw = 1.0 / v[3];
    ((v[0] * rw * 0.5 + 0.5) * w as f32, (v[1] * rw * 0.5 + 0.5) * h as f32, rw)
}

/// Same arithmetic as `occ::cull::emit_tri` (cull = true) with a per-edge shrink in the spike's units. `s` is indexed like the
/// input triangle's edges (a to b, b to c, c to a).
fn emit(w: usize, h: usize, a: V4, b: V4, c: V4, s: [f32; 3], out: &mut Vec<Tri>) {
    let mut p = [project(w, h, a), project(w, h, b), project(w, h, c)];
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
    if area >= 0.0 {
        return;
    }
    p.swap(1, 2);
    // after the swap the edges are a to c, c to b, b to a
    let sh = [s[2], s[1], s[0]];
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
    if area < 1e-6 {
        return;
    }
    let minx = p[0].0.min(p[1].0).min(p[2].0);
    let maxx = p[0].0.max(p[1].0).max(p[2].0);
    let miny = p[0].1.min(p[1].1).min(p[2].1);
    let maxy = p[0].1.max(p[1].1).max(p[2].1);
    let x0 = ((minx - 0.5).ceil().max(0.0)) as i32;
    let x1 = ((maxx - 0.5).floor().min(w as f32 - 1.0)) as i32;
    let y0 = ((miny - 0.5).ceil().max(0.0)) as i32;
    let y1 = ((maxy - 0.5).floor().min(h as f32 - 1.0)) as i32;
    if x0 > x1 || y0 > y1 {
        return;
    }
    let mut t = Tri { x0, y0, x1, y1, ..Default::default() };
    for i in 0..3 {
        let (pp, q) = (p[i], p[(i + 1) % 3]);
        let ea = pp.1 - q.1;
        let eb = q.0 - pp.0;
        let shrink = sh[i] * (ea.abs() + eb.abs());
        t.e[i] = [ea, eb, -ea * pp.0 - eb * pp.1 - shrink];
    }
    let (d0, d1, d2) = (p[0].2, p[1].2, p[2].2);
    let gx = ((d1 - d0) * (p[2].1 - p[0].1) - (d2 - d0) * (p[1].1 - p[0].1)) / area;
    let gy = ((d2 - d0) * (p[1].0 - p[0].0) - (d1 - d0) * (p[2].0 - p[0].0)) / area;
    t.d = [gx, gy, d0 - gx * p[0].0 - gy * p[0].1];
    out.push(t);
}

/// How one triangle is conservatively adjusted.
pub struct TriAdjust {
    /// Depth push (world units, along the view ray).
    pub push: f32,
    /// Error used for the shrink (world units); 0 with `floor` only.
    pub shrink_err: f32,
    /// The constant floor of the shrink (spike units).
    pub floor: f32,
    /// Apply the projected-error term.
    pub use_err: bool,
    /// Which edges (a to b, b to c, c to a) are shrunk.
    pub edge: [bool; 3],
}

/// Clips, adjusts and sets up one world-space triangle's clip-space vertices.
pub fn setup_poly(cam: &Camera, w: usize, h: usize, v: [V4; 3], adj: &TriAdjust, out: &mut Vec<Tri>) {
    let mut p = Poly { v: [[0.0; 4]; 12], f: [false; 12], n: 3 };
    p.v[..3].copy_from_slice(&v);
    p.f[..3].copy_from_slice(&adj.edge);
    if v.iter().any(|x| dist(cam, 0, x) < 0.0) {
        p = clip(cam, 0, &p);
        if p.n < 3 {
            return;
        }
    }
    let mut wmin = f32::MAX;
    for i in 0..p.n {
        wmin = wmin.min(p.v[i][3]);
    }
    if adj.push > 0.0 {
        for i in 0..p.n {
            let k = 1.0 + adj.push / p.v[i][3];
            for c in 0..4 {
                p.v[i][c] *= k;
            }
        }
    }
    for k in 1..5 {
        if (0..p.n).any(|i| dist(cam, k, &p.v[i]) < 0.0) {
            p = clip(cam, k, &p);
            if p.n < 3 {
                return;
            }
        }
    }
    let mut s = adj.floor;
    if adj.use_err && adj.shrink_err > 0.0 {
        let scale = ((w as f32) * 0.5 * cam.sx).max((h as f32) * 0.5 * cam.sy);
        s = s.max(adj.shrink_err * scale / wmin);
    }
    for i in 1..p.n - 1 {
        let sh = |flag: bool| if flag { s } else { 0.0 };
        let (f0, f1, f2) = (if i == 1 { p.f[0] } else { false }, p.f[i], if i + 1 == p.n - 1 { p.f[p.n - 1] } else { false });
        emit(w, h, p.v[0], p.v[i], p.v[i + 1], [sh(f0), sh(f1), sh(f2)], out);
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Sets up all of one stand-in's triangles for `cam` under `rule`.
pub fn setup_standin(cam: &Camera, w: usize, h: usize, occ: &Occluder, st: &Standin, rule: &Rule, out: &mut Vec<Tri>) {
    let clip_v: Vec<V4> = occ.verts.iter().map(|p| xform_scalar(&cam.cols, *p)).collect();
    let eye = cam.eye;
    let front: Vec<bool> = st
        .tris
        .iter()
        .map(|t| {
            let (a, b, c) = (occ.verts[t[0] as usize], occ.verts[t[1] as usize], occ.verts[t[2] as usize]);
            dot(cross(sub(b, a), sub(c, a)), sub(eye, a)) > 0.0
        })
        .collect();
    let per_tri = rule.trim > 0.0;
    let tau = rule.trim * occ.diag;
    let (floor, use_err, sil) = match rule.shrink {
        Shrink::None => (0.0, false, false),
        Shrink::Floor(f) => (f, false, false),
        Shrink::ErrAll(f) => (f, true, false),
        Shrink::ErrSil(f) => (f, true, true),
    };
    for (ti, t) in st.tris.iter().enumerate() {
        if !front[ti] || (per_tri && st.tri_err[ti] > tau) {
            continue;
        }
        let e = rule.emul * if per_tri { st.tri_err[ti] } else { st.err };
        if let Near::TriErr(k) = rule.near {
            let (a, b, c) = (occ.verts[t[0] as usize], occ.verts[t[1] as usize], occ.verts[t[2] as usize]);
            if tri_distance(eye, a, b, c) <= cam.near + k * e {
                continue;
            }
        }
        let mut push = 0.0;
        if rule.push {
            push = e;
            if rule.graze {
                let (a, b, c) = (occ.verts[t[0] as usize], occ.verts[t[1] as usize], occ.verts[t[2] as usize]);
                let n = cross(sub(b, a), sub(c, a));
                let cen = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0];
                let v = sub(cen, eye);
                let cos = (dot(n, v) / (dot(n, n).sqrt() * dot(v, v).sqrt()).max(1e-20)).abs();
                push = e / cos.max(0.2);
            }
        }
        let mut edge = [true; 3];
        if sil {
            for k in 0..3 {
                let cnt = st.edge_cnt[ti][k];
                edge[k] = cnt == 1 || cnt > 3 || st.edge_adj[ti][k].iter().any(|&o| o != u32::MAX && !front[o as usize]);
            }
        }
        let adj = TriAdjust { push, shrink_err: e, floor, use_err, edge };
        setup_poly(cam, w, h, [clip_v[t[0] as usize], clip_v[t[1] as usize], clip_v[t[2] as usize]], &adj, out);
    }
}

/// Distance from the camera to the occluder's bounds (0 inside).
pub fn bounds_distance(cam: &Camera, mn: [f32; 3], mx: [f32; 3]) -> f32 {
    let mut d2 = 0.0;
    for k in 0..3 {
        let d = (mn[k] - cam.eye[k]).max(0.0).max(cam.eye[k] - mx[k]);
        d2 += d * d;
    }
    d2.sqrt()
}

/// Projected minimum width, in buffer pixels, of the bounds (min of the screen rect's width and height; a corner behind the
/// near plane counts as wide).
pub fn projected_min_width(cam: &Camera, w: usize, h: usize, mn: [f32; 3], mx: [f32; 3]) -> f32 {
    let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for k in 0..8 {
        let p = [if k & 1 == 0 { mn[0] } else { mx[0] }, if k & 2 == 0 { mn[1] } else { mx[1] }, if k & 4 == 0 { mn[2] } else { mx[2] }];
        let c = xform_scalar(&cam.cols, p);
        if c[3] < cam.near {
            return f32::MAX;
        }
        let (sx, sy, _) = project(w, h, c);
        x0 = x0.min(sx);
        x1 = x1.max(sx);
        y0 = y0.min(sy);
        y1 = y1.max(sy);
    }
    (x1 - x0).min(y1 - y0)
}

/// Distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
pub fn tri_distance(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let cp = |q: [f32; 3]| dot(sub(p, q), sub(p, q)).sqrt();
    if d1 <= 0.0 && d2 <= 0.0 {
        return cp(a);
    }
    let bp = sub(p, b);
    let (d3, d4) = (dot(ab, bp), dot(ac, bp));
    if d3 >= 0.0 && d4 <= d3 {
        return cp(b);
    }
    let vc = d1 * d4 - d3 * d2;
    let at = |t: f32, from: [f32; 3], dir: [f32; 3]| cp([from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t]);
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return at(d1 / (d1 - d3), a, ab);
    }
    let cpv = sub(p, c);
    let (d5, d6) = (dot(ab, cpv), dot(ac, cpv));
    if d6 >= 0.0 && d5 <= d6 {
        return cp(c);
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return at(d2 / (d2 - d6), a, ac);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return at(w, b, sub(c, b));
    }
    let n = cross(ab, ac);
    (dot(n, ap) / dot(n, n).sqrt().max(1e-20)).abs()
}
