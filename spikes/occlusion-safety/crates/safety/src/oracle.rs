//! The 1080p reference: the ORIGINAL meshes rasterised exactly (centre sampling, no rules) and every occludee box tested by
//! rasterising its own front faces against that depth buffer, pixel by pixel. An occludee is visible iff some pixel of its
//! silhouette is nearer than the stored depth. This is stricter than the spike's rect oracle: no rect over-approximation.
use crate::data::Occluder;
use crate::setup::{setup_poly, TriAdjust, V4};
use occ::cull::xform_scalar;
use occ::geom::Camera;
use occ::raster::{raster_simd, DepthBuf, Tri};

pub const W: usize = 1920;
pub const H: usize = 1080;
pub const HIDDEN: u8 = 0;
pub const VISIBLE: u8 = 1;
pub const OUTSIDE: u8 = 2;

pub struct Oracle {
    pub vis: Vec<u8>,
    /// Visible silhouette pixels at 1080p (an upper bound: pixels on shared edges of two faces count twice); u32::MAX for boxes crossing the near plane.
    pub px: Vec<u32>,
}

const NO_ADJ: TriAdjust = TriAdjust { push: 0.0, shrink_err: 0.0, floor: 0.0, use_err: false, edge: [false; 3] };

fn corners(b: &[f32]) -> [[f32; 3]; 8] {
    let mut c = [[0.0; 3]; 8];
    for k in 0..8 {
        c[k] = [if k & 1 == 0 { b[0] } else { b[3] }, if k & 2 == 0 { b[1] } else { b[4] }, if k & 4 == 0 { b[2] } else { b[5] }];
    }
    c
}

/// (outside the frustum, crosses the near plane): the same rule as `occ::cull::test_occludees`.
pub fn classify(cam: &Camera, b: &[f32]) -> (bool, bool) {
    let mut all = 0xffu8;
    let mut near = false;
    for p in corners(b) {
        let v = xform_scalar(&cam.cols, p);
        let mut o = 0u8;
        if v[3] - cam.near < 0.0 {
            o |= 1;
            near = true;
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
        if v[3] > cam.far {
            o |= 32;
        }
        all &= o;
    }
    (all != 0, near)
}

const FACES: [[usize; 4]; 6] = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];

fn box_tris(cam: &Camera, b: &[f32], out: &mut Vec<Tri>) {
    let c = corners(b);
    let cen = [(b[0] + b[3]) * 0.5, (b[1] + b[4]) * 0.5, (b[2] + b[5]) * 0.5];
    let clip: Vec<V4> = c.iter().map(|p| xform_scalar(&cam.cols, *p)).collect();
    for f in FACES {
        // wind outward: normal must point away from the box centre
        let (p0, p1, p2) = (c[f[0]], c[f[1]], c[f[2]]);
        let (e1, e2) = ([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let flip = n[0] * (p0[0] - cen[0]) + n[1] * (p0[1] - cen[1]) + n[2] * (p0[2] - cen[2]) < 0.0;
        let q = if flip { [f[0], f[3], f[2], f[1]] } else { f };
        setup_poly(cam, W, H, [clip[q[0]], clip[q[1]], clip[q[2]]], &NO_ADJ, out);
        setup_poly(cam, W, H, [clip[q[0]], clip[q[2]], clip[q[3]]], &NO_ADJ, out);
    }
}

fn visible_px(buf: &DepthBuf, t: &Tri) -> u32 {
    let mut n = 0;
    for y in t.y0..=t.y1 {
        let py = y as f32 + 0.5;
        let r0 = t.e[0][1] * py + t.e[0][2];
        let r1 = t.e[1][1] * py + t.e[1][2];
        let r2 = t.e[2][1] * py + t.e[2][2];
        let rd = t.d[1] * py + t.d[2];
        for x in t.x0..=t.x1 {
            let px = x as f32 + 0.5;
            if t.e[0][0] * px + r0 >= 0.0 && t.e[1][0] * px + r1 >= 0.0 && t.e[2][0] * px + r2 >= 0.0 {
                let d = t.d[0] * px + rd;
                if d > buf.fine[y as usize * W + x as usize] {
                    n += 1;
                }
            }
        }
    }
    n
}

pub fn run(cam: &Camera, occs: &[Occluder], aabbs: &[f32], buf: &mut DepthBuf, tris: &mut Vec<Tri>) -> Oracle {
    buf.clear();
    tris.clear();
    let orig = crate::setup::RULE_NONE;
    for o in occs {
        crate::setup::setup_standin(cam, W, H, o, &o.types[0], &orig, tris);
    }
    for t in tris.iter() {
        raster_simd(buf, t);
    }
    let n = aabbs.len() / 6;
    let mut vis = vec![VISIBLE; n];
    let mut px = vec![0u32; n];
    let mut bt = vec![];
    for i in 0..n {
        let b = &aabbs[i * 6..i * 6 + 6];
        let (outside, near) = classify(cam, b);
        if outside {
            vis[i] = OUTSIDE;
            continue;
        }
        if near {
            px[i] = u32::MAX;
            continue;
        }
        bt.clear();
        box_tris(cam, b, &mut bt);
        let v: u32 = bt.iter().map(|t| visible_px(buf, t)).sum();
        px[i] = v;
        if v == 0 {
            vis[i] = HIDDEN;
        }
    }
    Oracle { vis, px }
}
