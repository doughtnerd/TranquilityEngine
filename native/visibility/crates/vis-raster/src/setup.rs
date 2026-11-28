//! Triangle setup: transform, near and guard-band clipping, the conservative adjustments (depth push, edge shrink),
//! projection, back-face culling and edge-function setup. The geometry mirrors `spikes/occlusion-raster` and the
//! rules `spikes/occlusion-safety`, so with every adjustment off the depth buffer is the spike's, bit for bit.
use crate::buffer::Tri;
use crate::f4::F4;
use crate::geom::{ceil, floor};
use crate::view::View;
use alloc::vec::Vec;

pub type V4 = [f32; 4];

/// The clipper keeps this many w beyond the frustum in x and y, so screen coordinates stay a few viewports wide.
pub const GUARD: f32 = 1.5;

/// Clip-space transform, canonical order ((c0*x + c1*y) + c2*z) + c3 on every path (no FMA).
#[inline(always)]
pub fn xform(cols: &[[f32; 4]; 4], p: [f32; 3]) -> V4 {
    let mut o = [0f32; 4];
    for (i, v) in o.iter_mut().enumerate() {
        *v = ((cols[0][i] * p[0] + cols[1][i] * p[1]) + cols[2][i] * p[2]) + cols[3][i];
    }
    o
}

/// The same transform with the columns preloaded as 4-wide vectors; bit-identical to [`xform`].
#[inline(always)]
pub fn xform_simd(c: &[F4; 4], p: [f32; 3]) -> V4 {
    c[0].mul(F4::splat(p[0]))
        .add(c[1].mul(F4::splat(p[1])))
        .add(c[2].mul(F4::splat(p[2])))
        .add(c[3])
        .to_array()
}

/// Loads a view's matrix columns for [`xform_simd`].
pub fn load_cols(cols: &[[f32; 4]; 4]) -> [F4; 4] {
    unsafe {
        [
            F4::load(cols[0].as_ptr()),
            F4::load(cols[1].as_ptr()),
            F4::load(cols[2].as_ptr()),
            F4::load(cols[3].as_ptr()),
        ]
    }
}

/// How one triangle is made conservative (ADR 0447 section 3).
#[derive(Clone, Copy, Debug)]
pub struct TriAdjust {
    /// Depth push: the triangle moves this far (world units) away from the camera along each vertex's view ray.
    pub push: f32,
    /// The triangle's error (world units), whose projected size in buffer pixels is the shrink where it exceeds `floor`.
    pub err: f32,
    /// The shrink floor, in the rasteriser's units (0.5 = the whole pixel square must lie inside the triangle).
    pub floor: f32,
    /// Which edges (a to b, b to c, c to a) are shrunk: the silhouette edges.
    pub edges: [bool; 3],
}

/// No adjustment: exact coverage and depth (the reference rasteriser's input).
pub const EXACT: TriAdjust = TriAdjust {
    push: 0.0,
    err: 0.0,
    floor: 0.0,
    edges: [false; 3],
};

#[inline]
fn dist(view: &View, k: usize, v: &V4) -> f32 {
    match k {
        0 => v[3] - view.near,
        1 => v[0] + GUARD * v[3],
        2 => GUARD * v[3] - v[0],
        3 => v[1] + GUARD * v[3],
        _ => GUARD * v[3] - v[1],
    }
}

#[derive(Clone, Copy)]
struct Poly {
    v: [V4; 12],
    /// Per edge i (v[i] to v[i+1]): is it a piece of an edge the caller asked to shrink?
    f: [bool; 12],
    n: usize,
}

fn clip(view: &View, k: usize, p: &Poly) -> Poly {
    let mut o = Poly {
        v: [[0.0; 4]; 12],
        f: [false; 12],
        n: 0,
    };
    for i in 0..p.n {
        let (a, b) = (p.v[i], p.v[(i + 1) % p.n]);
        let (da, db) = (dist(view, k, &a), dist(view, k, &b));
        if da >= 0.0 {
            o.v[o.n] = a;
            o.f[o.n] = p.f[i];
            o.n += 1;
        }
        if (da >= 0.0) != (db >= 0.0) {
            let t = da / (da - db);
            o.v[o.n] = [
                a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t,
                a[3] + (b[3] - a[3]) * t,
            ];
            // Leaving the plane: the new edge runs along the clip plane, never along the surface. Entering: it is a piece of
            // the original edge.
            o.f[o.n] = da < 0.0 && p.f[i];
            o.n += 1;
        }
    }
    o
}

#[inline]
fn project(w: usize, h: usize, v: V4) -> (f32, f32, f32) {
    let rw = 1.0 / v[3];
    (
        (v[0] * rw * 0.5 + 0.5) * w as f32,
        (v[1] * rw * 0.5 + 0.5) * h as f32,
        rw,
    )
}

/// Sets up one triangle already in the screen's units. `s` shrinks the edges a to b, b to c, c to a. In the engine's
/// winding (`geom::front_normal`), front faces have positive screen area (y up); others are dropped.
fn emit(w: usize, h: usize, a: V4, b: V4, c: V4, s: [f32; 3], out: &mut Vec<Tri>) {
    let p = [project(w, h, a), project(w, h, b), project(w, h, c)];
    let sh = s;
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
    if !(area.is_finite() && area >= 1e-6) {
        return;
    }
    let minx = p[0].0.min(p[1].0).min(p[2].0);
    let maxx = p[0].0.max(p[1].0).max(p[2].0);
    let miny = p[0].1.min(p[1].1).min(p[2].1);
    let maxy = p[0].1.max(p[1].1).max(p[2].1);
    // pixel centres x + 0.5 inside [minx, maxx]
    let x0 = ceil(minx - 0.5).max(0.0) as i32;
    let x1 = floor(maxx - 0.5).min(w as f32 - 1.0) as i32;
    let y0 = ceil(miny - 0.5).max(0.0) as i32;
    let y1 = floor(maxy - 0.5).min(h as f32 - 1.0) as i32;
    if x0 > x1 || y0 > y1 {
        return;
    }
    let mut t = Tri {
        x0,
        y0,
        x1,
        y1,
        ..Default::default()
    };
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
    if !(gx.is_finite() && gy.is_finite()) {
        return;
    }
    t.d = [gx, gy, d0 - gx * p[0].0 - gy * p[0].1];
    out.push(t);
}

/// Clips, adjusts and sets up one triangle given by its clip-space vertices, pushing the resulting rasteriser triangles
/// (up to 7 after clipping) onto `out`. Returns whether any clipping happened. A vertex that is not finite refuses the
/// triangle (nothing is pushed).
pub fn setup_poly(
    view: &View,
    w: usize,
    h: usize,
    v: [V4; 3],
    adj: &TriAdjust,
    out: &mut Vec<Tri>,
) -> bool {
    if v.iter()
        .any(|x| !(x[0].is_finite() && x[1].is_finite() && x[2].is_finite() && x[3].is_finite()))
    {
        return false;
    }
    let mut p = Poly {
        v: [[0.0; 4]; 12],
        f: [false; 12],
        n: 3,
    };
    p.v[..3].copy_from_slice(&v);
    p.f[..3].copy_from_slice(&adj.edges);
    let mut clipped = false;
    if v.iter().any(|x| dist(view, 0, x) < 0.0) {
        clipped = true;
        p = clip(view, 0, &p);
        if p.n < 3 {
            return clipped;
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
        if (0..p.n).any(|i| dist(view, k, &p.v[i]) < 0.0) {
            clipped = true;
            p = clip(view, k, &p);
            if p.n < 3 {
                return clipped;
            }
        }
    }
    let mut s = adj.floor;
    if adj.err > 0.0 {
        s = s.max(adj.err * view.pixel_scale(w, h) / wmin);
    }
    for i in 1..p.n - 1 {
        let sh = |flag: bool| if flag { s } else { 0.0 };
        let (f0, f1, f2) = (
            if i == 1 { p.f[0] } else { false },
            p.f[i],
            if i + 1 == p.n - 1 {
                p.f[p.n - 1]
            } else {
                false
            },
        );
        emit(
            w,
            h,
            p.v[0],
            p.v[i],
            p.v[i + 1],
            [sh(f0), sh(f1), sh(f2)],
            out,
        );
    }
    clipped
}
