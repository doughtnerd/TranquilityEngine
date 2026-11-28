//! The depth buffer, the triangle rasteriser (scalar reference and 4-wide), the coarse min level and rect tests.
use crate::f4::F4;

pub const TILE: usize = 8;

/// One setup triangle: inclusive pixel bbox, three edge functions (A,B,C: e = A*x + B*y + C, >= 0 inside, pixel
/// centres at +0.5) and the depth plane (d = gx*x + gy*y + c).
#[derive(Clone, Copy, Default)]
pub struct Tri {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub e: [[f32; 3]; 3],
    pub d: [f32; 3],
}

pub struct DepthBuf {
    pub w: usize,
    pub h: usize,
    /// Per-pixel nearest occluder depth (1/w; larger is nearer; 0 = empty).
    pub fine: Vec<f32>,
    pub tw: usize,
    pub th: usize,
    /// Per tile (8x8): the MIN of its pixels: the farthest occluder depth that covers the whole tile (0 if any pixel is empty).
    pub coarse: Vec<f32>,
    colmin: Vec<f32>,
}

impl DepthBuf {
    pub fn new(w: usize, h: usize) -> DepthBuf {
        assert!(w % 8 == 0, "width must be a multiple of 8");
        let (tw, th) = (w / TILE, (h + TILE - 1) / TILE);
        DepthBuf { w, h, fine: vec![0.0; w * h], tw, th, coarse: vec![0.0; tw * th], colmin: vec![0.0; w] }
    }

    pub fn clear(&mut self) {
        self.fine.fill(0.0);
    }

    /// Builds the coarse level. `simd` selects the 4-wide path; both give identical output.
    pub fn build_mip(&mut self, simd: bool) {
        let (w, h, tw) = (self.w, self.h, self.tw);
        for ty in 0..self.th {
            let r0 = ty * TILE;
            let r1 = (r0 + TILE).min(h);
            if simd {
                unsafe {
                    let cm = self.colmin.as_mut_ptr();
                    let base = self.fine.as_ptr();
                    let mut x = 0;
                    while x < w {
                        let mut acc = F4::load(base.add(r0 * w + x));
                        for r in r0 + 1..r1 {
                            acc = acc.min(F4::load(base.add(r * w + x)));
                        }
                        acc.store(cm.add(x));
                        x += 4;
                    }
                    for tx in 0..tw {
                        let a = F4::load(cm.add(tx * TILE));
                        let b = F4::load(cm.add(tx * TILE + 4));
                        self.coarse[ty * tw + tx] = a.min(b).hmin();
                    }
                }
            } else {
                for tx in 0..tw {
                    let mut m = f32::MAX;
                    for r in r0..r1 {
                        for x in tx * TILE..tx * TILE + TILE {
                            m = m.min(self.fine[r * w + x]);
                        }
                    }
                    self.coarse[ty * tw + tx] = m;
                }
            }
        }
    }
}

/// Reference rasteriser: every pixel centre of the aligned bbox, no early-outs.
pub fn raster_scalar(buf: &mut DepthBuf, t: &Tri) {
    let w = buf.w;
    let xs = (t.x0 & !3) as usize;
    let xe = (t.x1 | 3) as usize;
    for y in t.y0..=t.y1 {
        let py = y as f32 + 0.5;
        let r0 = t.e[0][1] * py + t.e[0][2];
        let r1 = t.e[1][1] * py + t.e[1][2];
        let r2 = t.e[2][1] * py + t.e[2][2];
        let rd = t.d[1] * py + t.d[2];
        let row = y as usize * w;
        for x in xs..=xe {
            let px = x as f32 + 0.5;
            let e0 = t.e[0][0] * px + r0;
            let e1 = t.e[1][0] * px + r1;
            let e2 = t.e[2][0] * px + r2;
            if e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0 {
                let d = t.d[0] * px + rd;
                let p = &mut buf.fine[row + x];
                if d > *p {
                    *p = d;
                }
            }
        }
    }
}

/// 4 pixels per step. Same expressions, same rounding, as `raster_scalar`; once a row's covered span ends the row
/// is abandoned (each edge function is monotone in x, so the covered span of a row is contiguous).
pub fn raster_simd(buf: &mut DepthBuf, t: &Tri) {
    let w = buf.w;
    let xs = (t.x0 & !3) as usize;
    let xe = (t.x1 | 3) as usize;
    let (a0, a1, a2, ad) = (F4::splat(t.e[0][0]), F4::splat(t.e[1][0]), F4::splat(t.e[2][0]), F4::splat(t.d[0]));
    let zero = F4::splat(0.0);
    let lane = F4::new(0.5, 1.5, 2.5, 3.5);
    for y in t.y0..=t.y1 {
        let py = y as f32 + 0.5;
        let r0 = F4::splat(t.e[0][1] * py + t.e[0][2]);
        let r1 = F4::splat(t.e[1][1] * py + t.e[1][2]);
        let r2 = F4::splat(t.e[2][1] * py + t.e[2][2]);
        let rd = F4::splat(t.d[1] * py + t.d[2]);
        let row = y as usize * w;
        let mut seen = false;
        let mut x = xs;
        unsafe {
            let base = buf.fine.as_mut_ptr().add(row);
            while x <= xe {
                let px = F4::splat(x as f32).add(lane);
                let m = a0.mul(px).add(r0).ge(zero).and(a1.mul(px).add(r1).ge(zero)).and(a2.mul(px).add(r2).ge(zero));
                if m.any() {
                    seen = true;
                    let d = ad.mul(px).add(rd);
                    let old = F4::load(base.add(x));
                    F4::select(m, old.max(d), old).store(base.add(x));
                } else if seen {
                    break;
                }
                x += 4;
            }
        }
    }
}

#[inline(always)]
fn seg_min_scalar(p: &[f32]) -> f32 {
    let mut m = f32::MAX;
    for &v in p {
        m = m.min(v);
    }
    m
}

#[inline(always)]
fn seg_min(p: &[f32], simd: bool) -> f32 {
    if simd && p.len() >= 4 {
        unsafe {
            let b = p.as_ptr();
            let n = p.len();
            let mut acc = F4::load(b);
            let mut i = 4;
            while i + 4 <= n {
                acc = acc.min(F4::load(b.add(i)));
                i += 4;
            }
            if i < n {
                acc = acc.min(F4::load(b.add(n - 4)));
            }
            acc.hmin()
        }
    } else {
        seg_min_scalar(p)
    }
}

/// Pixel-exact: is any pixel of the inclusive rect at or below `thr` (so the occludee may be visible)?
pub fn rect_visible_fine(buf: &DepthBuf, x0: usize, y0: usize, x1: usize, y1: usize, thr: f32) -> bool {
    for y in y0..=y1 {
        let row = &buf.fine[y * buf.w + x0..y * buf.w + x1 + 1];
        if seg_min_scalar(row) <= thr {
            return true;
        }
    }
    false
}

/// Same answer as `rect_visible_fine`, reading whole 8x8 tiles from the coarse level where the rect covers them.
pub fn rect_visible_hier(buf: &DepthBuf, x0: usize, y0: usize, x1: usize, y1: usize, thr: f32, simd: bool) -> bool {
    let w = buf.w;
    for ty in y0 / TILE..=y1 / TILE {
        let ry0 = y0.max(ty * TILE);
        let ry1 = y1.min(ty * TILE + TILE - 1);
        let full_rows = ry0 == ty * TILE && ry1 == ty * TILE + TILE - 1;
        for tx in x0 / TILE..=x1 / TILE {
            let cx0 = x0.max(tx * TILE);
            let cx1 = x1.min(tx * TILE + TILE - 1);
            if full_rows && cx0 == tx * TILE && cx1 == tx * TILE + TILE - 1 {
                if buf.coarse[ty * buf.tw + tx] <= thr {
                    return true;
                }
            } else {
                for y in ry0..=ry1 {
                    if seg_min(&buf.fine[y * w + cx0..y * w + cx1 + 1], simd) <= thr {
                        return true;
                    }
                }
            }
        }
    }
    false
}
