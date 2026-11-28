//! Occluder selection, vertex transform, clipping and triangle setup, and the occludee test.
use crate::f4::F4;
use crate::geom::{Camera, GUARD};
use crate::raster::{rect_visible_fine, rect_visible_hier, DepthBuf, Tri};

// Stats slots (u32 each).
pub const S_INST_TOTAL: usize = 0;
pub const S_INST_FRUSTUM: usize = 1;
pub const S_INST_SELECTED: usize = 2;
pub const S_TRIS_SRC: usize = 3; // triangles of the selected instances (after frustum culling of instances)
pub const S_TRIS_FRUSTUM: usize = 4; // not trivially outside the frustum
pub const S_TRIS_BACK: usize = 5; // rejected as back-facing (or degenerate)
pub const S_TRIS_CLIPPED: usize = 6;
pub const S_TRIS_RASTER: usize = 7; // triangles handed to the rasteriser
pub const S_OCC_TOTAL: usize = 8;
pub const S_OCC_OUTSIDE: usize = 9;
pub const S_OCC_NEAR: usize = 10;
pub const S_OCC_CULLED: usize = 11;
pub const S_OCC_VISIBLE: usize = 12;
pub const N_STATS: usize = 16;

#[derive(Clone, Copy)]
pub struct Config {
    /// Cap on source triangles of the selected occluder instances (0 = no cap).
    pub cap_tris: u32,
    /// Skip occluders whose bounding sphere covers less than this fraction of the screen (0 = keep all).
    pub min_area: f32,
    /// Pixels the occludee's rect is grown by on each side (1 makes sampling at pixel centres conservative).
    pub dilate: i32,
    pub simd: bool,
    /// Test through the coarse level (otherwise pixel by pixel).
    pub hier: bool,
    /// Occluded only when nearest < stored * (1 - eps).
    pub eps: f32,
    /// Coverage shrink as a fraction of the pixel: 0 = centre sampling, 0.5 = inner-conservative (the whole pixel square
    /// must lie inside the triangle), in between = at least that much of the pixel (for thin edge-on cases).
    pub inner: f32,
}

impl Default for Config {
    fn default() -> Config {
        Config { cap_tris: 0, min_area: 0.0, dilate: 1, simd: true, hier: true, eps: 1e-3, inner: 0.0 }
    }
}

/// Clip-space transform, canonical order ((c0*x + c1*y) + c2*z) + c3 in every path.
#[inline(always)]
pub fn xform_scalar(cols: &[[f32; 4]; 4], p: [f32; 3]) -> [f32; 4] {
    let mut o = [0f32; 4];
    for i in 0..4 {
        o[i] = ((cols[0][i] * p[0] + cols[1][i] * p[1]) + cols[2][i] * p[2]) + cols[3][i];
    }
    o
}

#[inline(always)]
pub fn xform_simd(c: &[F4; 4], p: [f32; 3]) -> [f32; 4] {
    c[0].mul(F4::splat(p[0])).add(c[1].mul(F4::splat(p[1]))).add(c[2].mul(F4::splat(p[2]))).add(c[3]).to_array()
}

pub fn load_cols(cols: &[[f32; 4]; 4]) -> [F4; 4] {
    unsafe { [F4::load(cols[0].as_ptr()), F4::load(cols[1].as_ptr()), F4::load(cols[2].as_ptr()), F4::load(cols[3].as_ptr())] }
}

// ---------------------------------------------------------------- selection

/// Screen fraction a bounding sphere covers (rect of its projection over the screen), clamped to 1.
pub fn sphere_screen_fraction(cam: &Camera, c: [f32; 3], r: f32) -> f32 {
    let w = if cam.persp { cam.rows[3][0] * c[0] + cam.rows[3][1] * c[1] + cam.rows[3][2] * c[2] + cam.rows[3][3] } else { 1.0 };
    if w <= r {
        return 1.0;
    }
    ((r * cam.sx / w) * (r * cam.sy / w)).min(1.0)
}

/// Picks occluder instances: frustum cull, screen-size threshold, then (with a cap) greedily the biggest first until
/// the source-triangle budget is used. `xf` is 12 floats per instance (row-major 3x4), `mesh_of`/`spheres` per mesh.
pub fn select(
    cam: &Camera,
    xf: &[f32],
    mesh_of: &[u32],
    mesh_sphere: &[[f32; 4]],
    mesh_tris: &[u32],
    cfg: &Config,
    scratch: &mut Vec<(f32, u32)>,
    out: &mut Vec<u32>,
    st: &mut [u32; N_STATS],
) {
    scratch.clear();
    out.clear();
    let n = mesh_of.len();
    st[S_INST_TOTAL] = n as u32;
    let mut in_frustum = 0;
    for i in 0..n {
        let m = &xf[i * 12..i * 12 + 12];
        let ms = mesh_sphere[mesh_of[i] as usize];
        let c = [
            m[0] * ms[0] + m[1] * ms[1] + m[2] * ms[2] + m[3],
            m[4] * ms[0] + m[5] * ms[1] + m[6] * ms[2] + m[7],
            m[8] * ms[0] + m[9] * ms[1] + m[10] * ms[2] + m[11],
        ];
        // uniform scale assumed: the length of the first column
        let s = (m[0] * m[0] + m[4] * m[4] + m[8] * m[8]).sqrt();
        let r = ms[3] * s;
        if !cam.sphere_visible(c, r) {
            continue;
        }
        in_frustum += 1;
        let frac = sphere_screen_fraction(cam, c, r);
        if frac < cfg.min_area {
            continue;
        }
        scratch.push((frac, i as u32));
    }
    st[S_INST_FRUSTUM] = in_frustum;
    if cfg.cap_tris > 0 {
        scratch.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap().then(a.1.cmp(&b.1)));
        let mut used = 0u32;
        for &(_, i) in scratch.iter() {
            let t = mesh_tris[mesh_of[i as usize] as usize];
            if used + t <= cfg.cap_tris {
                used += t;
                out.push(i);
            }
        }
    } else {
        out.extend(scratch.iter().map(|&(_, i)| i));
    }
    st[S_INST_SELECTED] = out.len() as u32;
    st[S_TRIS_SRC] = out.iter().map(|&i| mesh_tris[mesh_of[i as usize] as usize]).sum();
}

// ---------------------------------------------------------------- setup


#[inline(always)]
fn plane_dist(cam: &Camera, k: usize, v: &[f32; 4]) -> f32 {
    match k {
        0 => {
            if cam.persp {
                v[3] - cam.near
            } else {
                v[2]
            }
        }
        1 => v[0] + GUARD * v[3],
        2 => GUARD * v[3] - v[0],
        3 => v[1] + GUARD * v[3],
        _ => GUARD * v[3] - v[1],
    }
}

#[inline(always)]
fn outcode(cam: &Camera, v: &[f32; 4]) -> u8 {
    let mut o = 0;
    for k in 0..5 {
        if plane_dist(cam, k, v) < 0.0 {
            o |= 1 << k;
        }
    }
    o
}

fn clip_poly(cam: &Camera, k: usize, inp: &[[f32; 4]], n: usize, out: &mut [[f32; 4]; 12]) -> usize {
    let mut m = 0;
    for i in 0..n {
        let a = inp[i];
        let b = inp[(i + 1) % n];
        let da = plane_dist(cam, k, &a);
        let db = plane_dist(cam, k, &b);
        if da >= 0.0 {
            out[m] = a;
            m += 1;
        }
        if (da >= 0.0) != (db >= 0.0) {
            let t = da / (da - db);
            out[m] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
            m += 1;
        }
    }
    m
}

/// Sets up one clip-space triangle: frustum reject, near/guard clip, project, cull (when `cull`), edge setup.
pub fn setup_tri(cam: &Camera, w: usize, h: usize, v: [[f32; 4]; 3], cull: bool, inner: f32, out: &mut Vec<Tri>, st: &mut [u32; N_STATS]) {
    let oc = [outcode(cam, &v[0]), outcode(cam, &v[1]), outcode(cam, &v[2])];
    if oc[0] & oc[1] & oc[2] != 0 {
        return;
    }
    st[S_TRIS_FRUSTUM] += 1;
    let any = oc[0] | oc[1] | oc[2];
    if any == 0 {
        emit_tri(cam, w, h, v[0], v[1], v[2], cull, inner, out, st);
        return;
    }
    st[S_TRIS_CLIPPED] += 1;
    let mut a = [[0f32; 4]; 12];
    let mut b = [[0f32; 4]; 12];
    a[..3].copy_from_slice(&v);
    let mut n = 3;
    for k in 0..5 {
        if any & (1 << k) != 0 {
            n = clip_poly(cam, k, &a.clone(), n, &mut b);
            if n < 3 {
                return;
            }
            a = b;
        }
    }
    for i in 1..n - 1 {
        emit_tri(cam, w, h, a[0], a[i], a[i + 1], cull, inner, out, st);
    }
}

#[inline(always)]
fn project(cam: &Camera, w: usize, h: usize, v: [f32; 4]) -> (f32, f32, f32) {
    let rw = 1.0 / v[3];
    let sx = (v[0] * rw * 0.5 + 0.5) * w as f32;
    let sy = (v[1] * rw * 0.5 + 0.5) * h as f32;
    let d = if cam.persp { rw } else { 2.0 - v[2] };
    (sx, sy, d)
}

fn emit_tri(cam: &Camera, w: usize, h: usize, a: [f32; 4], b: [f32; 4], c: [f32; 4], cull: bool, inner: f32, out: &mut Vec<Tri>, st: &mut [u32; N_STATS]) {
    let mut p = [project(cam, w, h, a), project(cam, w, h, b), project(cam, w, h, c)];
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
    // Front faces have negative area (y up, CCW-from-outside meshes). Make the stored triangle positive.
    if cull {
        if area >= 0.0 {
            st[S_TRIS_BACK] += 1;
            return;
        }
    } else if area == 0.0 {
        return;
    }
    if area < 0.0 {
        p.swap(1, 2);
    }
    let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
    if area < 1e-6 {
        st[S_TRIS_BACK] += 1;
        return;
    }
    let minx = p[0].0.min(p[1].0).min(p[2].0);
    let maxx = p[0].0.max(p[1].0).max(p[2].0);
    let miny = p[0].1.min(p[1].1).min(p[2].1);
    let maxy = p[0].1.max(p[1].1).max(p[2].1);
    // pixel centres x+0.5 inside [minx,maxx]
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
        let shrink = inner * (ea.abs() + eb.abs());
        t.e[i] = [ea, eb, -ea * pp.0 - eb * pp.1 - shrink];
    }
    let (d0, d1, d2) = (p[0].2, p[1].2, p[2].2);
    let gx = ((d1 - d0) * (p[2].1 - p[0].1) - (d2 - d0) * (p[1].1 - p[0].1)) / area;
    let gy = ((d2 - d0) * (p[1].0 - p[0].0) - (d1 - d0) * (p[2].0 - p[0].0)) / area;
    t.d = [gx, gy, d0 - gx * p[0].0 - gy * p[0].1];
    out.push(t);
    st[S_TRIS_RASTER] += 1;
}

/// Transforms and sets up the selected instances' triangles into `out`.
#[allow(clippy::too_many_arguments)]
pub fn setup_instances(
    cam: &Camera,
    w: usize,
    h: usize,
    xf: &[f32],
    mesh_of: &[u32],
    meshes: &[crate::geom::Mesh],
    sel: &[u32],
    simd: bool,
    inner: f32,
    scratch: &mut Vec<[f32; 4]>,
    out: &mut Vec<Tri>,
    st: &mut [u32; N_STATS],
) {
    out.clear();
    st[S_TRIS_FRUSTUM] = 0;
    st[S_TRIS_BACK] = 0;
    st[S_TRIS_CLIPPED] = 0;
    st[S_TRIS_RASTER] = 0;
    for &i in sel {
        let i = i as usize;
        let m = &xf[i * 12..i * 12 + 12];
        let mesh = &meshes[mesh_of[i] as usize];
        // MVP columns = VP * model columns, canonical order.
        let mc = [[m[0], m[4], m[8], 0.0], [m[1], m[5], m[9], 0.0], [m[2], m[6], m[10], 0.0], [m[3], m[7], m[11], 1.0]];
        let mut mvp = [[0f32; 4]; 4];
        for j in 0..4 {
            for r in 0..4 {
                mvp[j][r] = ((cam.cols[0][r] * mc[j][0] + cam.cols[1][r] * mc[j][1]) + cam.cols[2][r] * mc[j][2]) + cam.cols[3][r] * mc[j][3];
            }
        }
        scratch.clear();
        if simd {
            let c = load_cols(&mvp);
            for v in &mesh.verts {
                scratch.push(xform_simd(&c, [v[0], v[1], v[2]]));
            }
        } else {
            for v in &mesh.verts {
                scratch.push(xform_scalar(&mvp, [v[0], v[1], v[2]]));
            }
        }
        for t in &mesh.tris {
            setup_tri(cam, w, h, [scratch[t[0] as usize], scratch[t[1] as usize], scratch[t[2] as usize]], true, inner, out, st);
        }
    }
}

// ---------------------------------------------------------------- occludee test

pub const VIS_OCCLUDED: u8 = 0;
pub const VIS_VISIBLE: u8 = 1;
pub const VIS_OUTSIDE: u8 = 2;

/// Tests world AABBs (6 floats each: min xyz, max xyz) against the buffer. Boxes crossing the near plane are visible;
/// boxes fully outside one frustum plane are reported `VIS_OUTSIDE`.
pub fn test_occludees(cam: &Camera, buf: &DepthBuf, aabbs: &[f32], vis: &mut [u8], cfg: &Config, st: &mut [u32; N_STATS]) {
    let n = aabbs.len() / 6;
    let (w, h) = (buf.w, buf.h);
    let cols4 = if cfg.simd { Some(load_cols(&cam.cols)) } else { None };
    let (mut outside, mut near, mut culled, mut visible) = (0, 0, 0, 0);
    st[S_OCC_TOTAL] = n as u32;
    for i in 0..n {
        let b = &aabbs[i * 6..i * 6 + 6];
        let mut cl = [[0f32; 4]; 8];
        for k in 0..8 {
            let p = [if k & 1 == 0 { b[0] } else { b[3] }, if k & 2 == 0 { b[1] } else { b[4] }, if k & 4 == 0 { b[2] } else { b[5] }];
            cl[k] = match &cols4 {
                Some(c) => xform_simd(c, p),
                None => xform_scalar(&cam.cols, p),
            };
        }
        // exact frustum (guard 1) outcodes, plus far
        let mut all = 0xffu8;
        let mut any_near = false;
        for v in &cl {
            let mut o = 0u8;
            if (if cam.persp { v[3] - cam.near } else { v[2] }) < 0.0 {
                o |= 1;
                any_near = true;
            }
            if v[0] < -v[3] {
                o |= 2;
            }
            if v[0] > v[3] {
                o |= 4;
            }
            if v[1] < -v[3] {
                o |= 8;
            }
            if v[1] > v[3] {
                o |= 16;
            }
            let beyond = if cam.persp { v[3] > cam.far } else { v[2] > 1.0 };
            if beyond {
                o |= 32;
            }
            all &= o;
        }
        if all != 0 {
            vis[i] = VIS_OUTSIDE;
            outside += 1;
            continue;
        }
        if any_near {
            vis[i] = VIS_VISIBLE;
            near += 1;
            visible += 1;
            continue;
        }
        let (mut minx, mut maxx, mut miny, mut maxy, mut dmax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN, f32::MIN);
        for v in &cl {
            let (sx, sy, d) = project(cam, w, h, *v);
            minx = minx.min(sx);
            maxx = maxx.max(sx);
            miny = miny.min(sy);
            maxy = maxy.max(sy);
            dmax = dmax.max(d);
        }
        let dil = cfg.dilate as f32;
        let x0 = ((minx.floor() - dil).max(0.0)) as usize;
        let y0 = ((miny.floor() - dil).max(0.0)) as usize;
        let x1 = (((maxx.ceil() - 1.0).max(minx.floor()) + dil).min(w as f32 - 1.0)) as usize;
        let y1 = (((maxy.ceil() - 1.0).max(miny.floor()) + dil).min(h as f32 - 1.0)) as usize;
        let (x0, y0) = (x0.min(x1), y0.min(y1));
        let thr = dmax / (1.0 - cfg.eps);
        let vis_px = if cfg.hier { rect_visible_hier(buf, x0, y0, x1, y1, thr, cfg.simd) } else { rect_visible_fine(buf, x0, y0, x1, y1, thr) };
        if vis_px {
            vis[i] = VIS_VISIBLE;
            visible += 1;
        } else {
            vis[i] = VIS_OCCLUDED;
            culled += 1;
        }
    }
    st[S_OCC_OUTSIDE] = outside;
    st[S_OCC_NEAR] = near;
    st[S_OCC_CULLED] = culled;
    st[S_OCC_VISIBLE] = visible;
}

// ---------------------------------------------------------------- temporal reprojection

/// Re-draws a previous perspective buffer's 8x8 tiles (as quads at each tile's farthest-covering depth) into the
/// current camera. Smoke-level temporal option.
pub fn reproject_tiles(prev: &DepthBuf, prev_cam: &Camera, cam: &Camera, w: usize, h: usize, inner: f32, out: &mut Vec<Tri>, st: &mut [u32; N_STATS]) {
    out.clear();
    st[S_TRIS_RASTER] = 0;
    let unproject = |px: f32, py: f32, d: f32| -> [f32; 4] {
        let wv = 1.0 / d;
        let nx = px / prev.w as f32 * 2.0 - 1.0;
        let ny = py / prev.h as f32 * 2.0 - 1.0;
        let xv = nx * wv / prev_cam.sx;
        let yv = ny * wv / prev_cam.sy;
        let p = [
            prev_cam.eye[0] + prev_cam.right[0] * xv + prev_cam.up[0] * yv + prev_cam.fwd[0] * wv,
            prev_cam.eye[1] + prev_cam.right[1] * xv + prev_cam.up[1] * yv + prev_cam.fwd[1] * wv,
            prev_cam.eye[2] + prev_cam.right[2] * xv + prev_cam.up[2] * yv + prev_cam.fwd[2] * wv,
        ];
        xform_scalar(&cam.cols, p)
    };
    for ty in 0..prev.th {
        for tx in 0..prev.tw {
            let d = prev.coarse[ty * prev.tw + tx];
            if d <= 0.0 {
                continue;
            }
            let (x0, x1) = ((tx * 8) as f32, (tx * 8 + 8) as f32);
            let (y0, y1) = ((ty * 8) as f32, ((ty * 8 + 8).min(prev.h)) as f32);
            let c = [unproject(x0, y0, d), unproject(x1, y0, d), unproject(x1, y1, d), unproject(x0, y1, d)];
            setup_tri(cam, w, h, [c[0], c[1], c[2]], false, inner, out, st);
            setup_tri(cam, w, h, [c[0], c[2], c[3]], false, inner, out, st);
        }
    }
}
