//! One occlusion view: clear, rasterise the occluder triangles under the conservativeness rules of ADR 0447 section 3,
//! build the coarse level and test the occludees.
//!
//! The rules (the "PROPOSED, errors x2" configuration of `spikes/occlusion-safety`, decided by the owner):
//! - **Stand-ins are trimmed at import** (`vis-trim`): triangles that close a hole never reach this module.
//! - **Errors are doubled by the caller** (at import): the `errors` passed in are the final per-triangle error E.
//! - **Depth push:** each triangle moves back by E / max(|cos|, 0.2), `cos` being the angle between its normal and the
//!   view ray to its centre (a grazing triangle's silhouette can shift further than its error).
//! - **Near rule, per triangle:** a triangle whose distance to the eye is at most `near + 2 E` is skipped (the real surface
//!   may lie on the camera's side of the stand-in). The spike's rule (a sum, not a max) is kept: it is the measured one and
//!   is never less safe than `max(near, 2 E)`.
//! - **Shrink at silhouettes only:** an edge is shrunk by max(0.5 px, E projected into buffer pixels) when it is a boundary
//!   edge, or its neighbour across it is not drawn this frame (facing away, skipped by the near rule, invalid or trimmed).
//!   Edges between two drawn triangles keep their coverage, which is what keeps tessellated stand-ins useful.
//! - **Occludee test:** the dilated (1 pixel) screen rect of the box against the coarse and fine levels.
//! - **Rejection:** non-finite triangles or errors are skipped, boxes with non-finite or inverted bounds stay visible.
use crate::buffer::{
    raster_scalar, raster_simd, rect_visible_fine, rect_visible_hier, DepthBuf, Tri,
};
use crate::geom::{dot, front_normal, sqrt, sub, tri_distance_sq};
use crate::setup::{load_cols, setup_poly, xform, xform_simd, TriAdjust};
use crate::view::View;
use alloc::vec::Vec;

/// "No neighbour" in an [`Occluders`] neighbour table: the edge is a boundary and is always a silhouette.
pub const NONE: u32 = u32::MAX;
/// The near rule skips a triangle within `near + NEAR_FACTOR * error` of the eye.
pub const NEAR_FACTOR: f32 = 2.0;
/// The shrink floor (the rasteriser's units: 0.5 = the whole pixel square lies inside the triangle).
pub const SHRINK_FLOOR: f32 = 0.5;
/// The smallest |cos| the depth push divides by.
pub const GRAZE_FLOOR: f32 = 0.2;
/// The occludee's screen rect grows by this many pixels on each side (makes centre sampling conservative).
pub const DILATE: i32 = 1;
/// An occludee is hidden only when its nearest depth is below the stored depth by this fraction.
pub const DEPTH_EPS: f32 = 1e-3;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// Use the 4-wide path. `false` is the scalar reference, which gives bit-identical depth and results (and is what
    /// targets without a 4-wide unit would run).
    pub simd: bool,
}

impl Default for Config {
    fn default() -> Config {
        Config { simd: true }
    }
}

/// The occluder triangles of one view, already chosen and budgeted by the caller.
#[derive(Clone, Copy)]
pub struct Occluders<'a> {
    /// World-space triangles, 9 floats each (x, y, z per vertex), in the engine's winding (`geom::front_normal`, ADR 0450):
    /// the outward normal `(c - a) x (b - a)` points toward a viewer in front.
    pub triangles: &'a [f32],
    /// Per triangle: its final error E in world units (the sampled error, doubled by the caller).
    pub errors: &'a [f32],
    /// Per triangle, 3 entries: the triangle across edge a to b, b to c, c to a (an index into this list), or [`NONE`].
    pub neighbors: &'a [u32],
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FrameError {
    /// `triangles`, `errors` and `neighbors` (or `boxes` and `hidden`) disagree in length.
    Lengths,
}

/// What one view did.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Stats {
    /// Triangles passed in.
    pub triangles: u32,
    /// Rejected: not finite, or a negative or non-finite error.
    pub invalid: u32,
    /// Skipped: facing away from the eye.
    pub facing_away: u32,
    /// Skipped by the near rule.
    pub near_skipped: u32,
    /// Triangles that needed clipping.
    pub clipped: u32,
    /// Triangles handed to the rasteriser (after clipping).
    pub rasterised: u32,
    pub tested: u32,
    /// Outside the frustum (left alone: the frustum culls them).
    pub outside: u32,
    /// Crossing the near plane (visible).
    pub near_visible: u32,
    /// Proven hidden: `hidden` was set for these.
    pub culled: u32,
}

/// An occlusion buffer and its scratch: one per view size, reused every frame.
pub struct Occlusion {
    cfg: Config,
    buf: DepthBuf,
    tris: Vec<Tri>,
    drawn: Vec<u8>,
}

impl Occlusion {
    pub fn new(w: usize, h: usize, cfg: Config) -> Occlusion {
        Occlusion {
            cfg,
            buf: DepthBuf::new(w, h),
            tris: Vec::with_capacity(16),
            drawn: Vec::new(),
        }
    }

    /// The depth buffer of the last view (1/w per pixel, 0 where nothing was drawn), for debug images.
    pub fn buffer(&self) -> &DepthBuf {
        &self.buf
    }

    /// Rasterises `occ` and sets `hidden[i] = 1` for every box proven hidden; other entries are untouched.
    /// `boxes` holds world AABBs, 6 floats each (min xyz, max xyz).
    pub fn occlude(
        &mut self,
        view: &View,
        occ: &Occluders,
        boxes: &[f32],
        hidden: &mut [u8],
    ) -> Result<Stats, FrameError> {
        let n = occ.triangles.len() / 9;
        let nb = boxes.len() / 6;
        if occ.triangles.len() != n * 9
            || occ.errors.len() != n
            || occ.neighbors.len() != n * 3
            || boxes.len() != nb * 6
            || hidden.len() < nb
        {
            return Err(FrameError::Lengths);
        }
        let mut st = Stats {
            triangles: n as u32,
            ..Stats::default()
        };
        self.buf.clear();
        self.classify(view, occ, n, &mut st);
        self.rasterise(view, occ, n, &mut st);
        self.buf.build_mip(self.cfg.simd);
        test_occludees(view, &self.buf, boxes, hidden, self.cfg.simd, &mut st);
        Ok(st)
    }

    /// Pass 1: which triangles are drawn (valid, facing the eye, outside the near rule's reach).
    fn classify(&mut self, view: &View, occ: &Occluders, n: usize, st: &mut Stats) {
        self.drawn.clear();
        self.drawn.resize(n, 0);
        let eye = view.eye;
        for i in 0..n {
            let t = &occ.triangles[i * 9..i * 9 + 9];
            let err = occ.errors[i];
            if !(t.iter().all(|v| v.is_finite()) && err.is_finite() && err >= 0.0) {
                st.invalid += 1;
                continue;
            }
            let (a, b, c) = ([t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]);
            let n3 = front_normal(a, b, c);
            let dp = dot(n3, sub(eye, a));
            if !(dp > 0.0) {
                st.facing_away += 1;
                continue;
            }
            let thr = view.near + NEAR_FACTOR * err;
            // The plane's distance bounds the triangle's from below: only a close plane needs the exact distance.
            let nn = dot(n3, n3);
            if !(dp * dp > thr * thr * nn) && tri_distance_sq(eye, a, b, c) <= thr * thr {
                st.near_skipped += 1;
                continue;
            }
            self.drawn[i] = 1;
        }
    }

    /// Pass 2: set up every drawn triangle with its adjustments and rasterise it.
    fn rasterise(&mut self, view: &View, occ: &Occluders, n: usize, st: &mut Stats) {
        let (w, h) = (self.buf.w, self.buf.h);
        let cols4 = load_cols(&view.cols);
        let eye = view.eye;
        for i in 0..n {
            if self.drawn[i] == 0 {
                continue;
            }
            let t = &occ.triangles[i * 9..i * 9 + 9];
            let err = occ.errors[i];
            let (a, b, c) = ([t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]);
            let mut edges = [true; 3];
            for (k, e) in edges.iter_mut().enumerate() {
                let o = occ.neighbors[i * 3 + k];
                *e = o == NONE || o as usize >= n || self.drawn[o as usize] == 0;
            }
            // push = E / max(|cos|, 0.2): the angle between the normal and the view ray to the centre
            let n3 = front_normal(a, b, c);
            let cen = [
                (a[0] + b[0] + c[0]) / 3.0,
                (a[1] + b[1] + c[1]) / 3.0,
                (a[2] + b[2] + c[2]) / 3.0,
            ];
            let ray = sub(cen, eye);
            let denom = sqrt(dot(n3, n3) * dot(ray, ray)).max(1e-20);
            let cos = (dot(n3, ray) / denom).abs();
            let push = err / cos.max(GRAZE_FLOOR);
            let adj = TriAdjust {
                push,
                err,
                floor: SHRINK_FLOOR,
                edges,
            };
            let v = if self.cfg.simd {
                [
                    xform_simd(&cols4, a),
                    xform_simd(&cols4, b),
                    xform_simd(&cols4, c),
                ]
            } else {
                [
                    xform(&view.cols, a),
                    xform(&view.cols, b),
                    xform(&view.cols, c),
                ]
            };
            self.tris.clear();
            if setup_poly(view, w, h, v, &adj, &mut self.tris) {
                st.clipped += 1;
            }
            st.rasterised += self.tris.len() as u32;
            if self.cfg.simd {
                for t in &self.tris {
                    raster_simd(&mut self.buf, t);
                }
            } else {
                for t in &self.tris {
                    raster_scalar(&mut self.buf, t);
                }
            }
        }
    }
}

/// The occludee test: tests world AABBs against a built buffer (`build_mip` done). Boxes outside the frustum or crossing the near plane are left alone (the
/// first by design, the second visible); boxes with non-finite or inverted bounds stay visible.
pub fn test_occludees(
    view: &View,
    buf: &DepthBuf,
    boxes: &[f32],
    hidden: &mut [u8],
    simd: bool,
    st: &mut Stats,
) {
    let n = boxes.len() / 6;
    let (w, h) = (buf.w, buf.h);
    let cols4 = load_cols(&view.cols);
    for i in 0..n {
        let b = &boxes[i * 6..i * 6 + 6];
        st.tested += 1;
        if !(b.iter().all(|v| v.is_finite()) && b[0] <= b[3] && b[1] <= b[4] && b[2] <= b[5]) {
            continue;
        }
        let mut cl = [[0f32; 4]; 8];
        for (k, c) in cl.iter_mut().enumerate() {
            let p = [
                if k & 1 == 0 { b[0] } else { b[3] },
                if k & 2 == 0 { b[1] } else { b[4] },
                if k & 4 == 0 { b[2] } else { b[5] },
            ];
            *c = if simd {
                xform_simd(&cols4, p)
            } else {
                xform(&view.cols, p)
            };
        }
        // exact frustum outcodes (plus far)
        let mut all = 0xffu8;
        let mut any_near = false;
        let mut finite = true;
        for v in &cl {
            finite &= v.iter().all(|x| x.is_finite());
            let mut o = 0u8;
            if v[3] - view.near < 0.0 {
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
            if v[3] > view.far {
                o |= 32;
            }
            all &= o;
        }
        if !finite {
            continue;
        }
        if all != 0 {
            st.outside += 1;
            continue;
        }
        if any_near {
            st.near_visible += 1;
            continue;
        }
        let (mut minx, mut maxx, mut miny, mut maxy, mut dmax) =
            (f32::MAX, f32::MIN, f32::MAX, f32::MIN, f32::MIN);
        for v in &cl {
            let rw = 1.0 / v[3];
            let sx = (v[0] * rw * 0.5 + 0.5) * w as f32;
            let sy = (v[1] * rw * 0.5 + 0.5) * h as f32;
            minx = minx.min(sx);
            maxx = maxx.max(sx);
            miny = miny.min(sy);
            maxy = maxy.max(sy);
            dmax = dmax.max(rw);
        }
        let dil = DILATE as f32;
        let (fx, fy) = (crate::geom::floor(minx), crate::geom::floor(miny));
        let x0 = (fx - dil).max(0.0) as usize;
        let y0 = (fy - dil).max(0.0) as usize;
        let x1 = ((crate::geom::ceil(maxx) - 1.0).max(fx) + dil).min(w as f32 - 1.0) as usize;
        let y1 = ((crate::geom::ceil(maxy) - 1.0).max(fy) + dil).min(h as f32 - 1.0) as usize;
        let (x0, y0) = (x0.min(x1), y0.min(y1));
        let thr = dmax / (1.0 - DEPTH_EPS);
        let visible = if simd {
            rect_visible_hier(buf, x0, y0, x1, y1, thr, true)
        } else {
            rect_visible_fine(buf, x0, y0, x1, y1, thr)
        };
        if !visible {
            hidden[i] = 1;
            st.culled += 1;
        }
    }
}
