//! One occlusion context: a scene, up to two cameras, the buffer and the per-stage entry points the benches time.
use crate::cull::*;
use crate::geom::Camera;
use crate::raster::{raster_scalar, raster_simd, DepthBuf, Tri};
use crate::scene::Scene;
use std::collections::HashMap;

pub const ORACLE_W: usize = 1920;
pub const ORACLE_H: usize = 1080;
/// Accuracy result slots: see `Ctx::compare`.
pub const N_ACC: usize = 8;

pub struct Ctx {
    pub scene: Scene,
    pub cfg: Config,
    pub cams: [Camera; 2],
    pub buf: DepthBuf,
    pub tris: Vec<Tri>,
    pub sel: Vec<u32>,
    pub sel_scratch: Vec<(f32, u32)>,
    pub vscratch: Vec<[f32; 4]>,
    pub stats: [u32; N_STATS],
    pub vis: [Vec<u8>; 2],
    pub oracle_vis: Vec<u8>,
    oracle_cache: HashMap<u32, Vec<u8>>,
    oracle_buf: Option<DepthBuf>,
    pub prev: DepthBuf,
    pub prev_cam: Camera,
    pub acc: [u32; N_ACC],
}

impl Ctx {
    pub fn new(scene_id: u32, w: usize, h: usize) -> Ctx {
        let scene = Scene::build(scene_id);
        let n = scene.aabbs.len() / 6;
        let cam = scene.camera(0, 0);
        Ctx {
            cams: [cam.clone(), cam.clone()],
            buf: DepthBuf::new(w, h),
            prev: DepthBuf::new(w, h),
            prev_cam: cam,
            scene,
            cfg: Config::default(),
            tris: Vec::with_capacity(1 << 16),
            sel: Vec::with_capacity(4096),
            sel_scratch: Vec::with_capacity(4096),
            vscratch: Vec::with_capacity(1024),
            stats: [0; N_STATS],
            vis: [vec![0; n], vec![0; n]],
            oracle_vis: vec![0; n],
            oracle_cache: HashMap::new(),
            oracle_buf: None,
            acc: [0; N_ACC],
        }
    }

    pub fn set_res(&mut self, w: usize, h: usize) {
        self.buf = DepthBuf::new(w, h);
        self.prev = DepthBuf::new(w, h);
    }
    pub fn set_cam(&mut self, slot: usize, kind: u32, frame: u32) {
        self.cams[slot] = self.scene.camera(kind, frame);
    }

    pub fn st_clear(&mut self) {
        self.buf.clear();
    }
    pub fn st_select(&mut self, slot: usize) {
        let s = &self.scene;
        select(&self.cams[slot], &s.inst_xf, &s.inst_mesh, &s.mesh_sphere, &s.mesh_tris, &self.cfg, &mut self.sel_scratch, &mut self.sel, &mut self.stats);
    }
    pub fn st_setup(&mut self, slot: usize) {
        let s = &self.scene;
        setup_instances(&self.cams[slot], self.buf.w, self.buf.h, &s.inst_xf, &s.inst_mesh, &s.meshes, &self.sel, self.cfg.simd, self.cfg.inner, &mut self.vscratch, &mut self.tris, &mut self.stats);
    }
    pub fn st_raster(&mut self) {
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
    pub fn st_mip(&mut self) {
        self.buf.build_mip(self.cfg.simd);
    }
    pub fn st_test(&mut self, slot: usize) {
        test_occludees(&self.cams[slot], &self.buf, &self.scene.aabbs, &mut self.vis[slot], &self.cfg, &mut self.stats);
    }
    pub fn frame(&mut self, slot: usize) {
        self.st_clear();
        self.st_select(slot);
        self.st_setup(slot);
        self.st_raster();
        self.st_mip();
        self.st_test(slot);
    }

    /// Exact oracle for the camera in `slot`: every occluder in the frustum at 1920x1080, scalar rasteriser, every
    /// occludee's rect tested pixel by pixel with no dilation or epsilon. Cached by `key` (>= 0) per context.
    pub fn oracle(&mut self, slot: usize, key: i32) {
        if key >= 0 {
            if let Some(v) = self.oracle_cache.get(&(key as u32)) {
                self.oracle_vis.copy_from_slice(v);
                return;
            }
        }
        let cfg = Config { cap_tris: 0, min_area: 0.0, dilate: 0, simd: false, hier: false, eps: 0.0, inner: 0.0 };
        let mut buf = self.oracle_buf.take().unwrap_or_else(|| DepthBuf::new(ORACLE_W, ORACLE_H));
        buf.clear();
        let s = &self.scene;
        let mut st = [0u32; N_STATS];
        let (mut sel, mut sc, mut vs, mut tris) = (vec![], vec![], vec![], vec![]);
        select(&self.cams[slot], &s.inst_xf, &s.inst_mesh, &s.mesh_sphere, &s.mesh_tris, &cfg, &mut sc, &mut sel, &mut st);
        setup_instances(&self.cams[slot], ORACLE_W, ORACLE_H, &s.inst_xf, &s.inst_mesh, &s.meshes, &sel, false, 0.0, &mut vs, &mut tris, &mut st);
        for t in &tris {
            raster_scalar(&mut buf, t);
        }
        test_occludees(&self.cams[slot], &buf, &s.aabbs, &mut self.oracle_vis, &cfg, &mut st);
        self.oracle_buf = Some(buf);
        if key >= 0 {
            self.oracle_cache.insert(key as u32, self.oracle_vis.clone());
        }
    }

    /// Compares `vis[slot]` with the oracle into `acc`:
    /// [in frustum, oracle culled, buffer culled, lost culls (oracle culled, buffer visible),
    ///  false occluded (buffer culled, oracle visible), outside (both agree), 0, 0].
    pub fn compare(&mut self, slot: usize) {
        let mut a = [0u32; N_ACC];
        for (&v, &o) in self.vis[slot].iter().zip(self.oracle_vis.iter()) {
            if v == VIS_OUTSIDE || o == VIS_OUTSIDE {
                a[5] += (v == o) as u32;
                continue;
            }
            a[0] += 1;
            a[1] += (o == VIS_OCCLUDED) as u32;
            a[2] += (v == VIS_OCCLUDED) as u32;
            a[3] += (o == VIS_OCCLUDED && v != VIS_OCCLUDED) as u32;
            a[4] += (v == VIS_OCCLUDED && o != VIS_OCCLUDED) as u32;
        }
        self.acc = a;
    }

    pub fn vis_hash(&self, slot: usize) -> u32 {
        let mut h = 0x811c9dc5u32;
        for &b in &self.vis[slot] {
            h = (h ^ b as u32).wrapping_mul(0x0100_0193);
        }
        h
    }

    pub fn depth_hash(&self) -> u32 {
        let mut h = 0x811c9dc5u32;
        for &v in &self.buf.fine {
            h = (h ^ v.to_bits()).wrapping_mul(0x0100_0193);
        }
        h
    }

    // ------------------------------------------------------------ temporal

    /// Keeps this frame's buffer and camera as "last frame".
    pub fn save_prev(&mut self, slot: usize) {
        self.prev.fine.copy_from_slice(&self.buf.fine);
        self.prev.coarse.copy_from_slice(&self.buf.coarse);
        self.prev_cam = self.cams[slot].clone();
    }
    /// Clears the buffer and draws last frame's tiles into it for the camera in `slot`; then mip.
    pub fn st_reproject(&mut self, slot: usize) {
        self.buf.clear();
        reproject_tiles(&self.prev, &self.prev_cam, &self.cams[slot], self.buf.w, self.buf.h, self.cfg.inner, &mut self.tris, &mut self.stats);
        self.st_raster();
        self.st_mip();
    }
    /// Stale test: current camera against `prev` as is (no reprojection).
    pub fn test_stale(&mut self, slot: usize) {
        std::mem::swap(&mut self.buf, &mut self.prev);
        self.st_test(slot);
        std::mem::swap(&mut self.buf, &mut self.prev);
    }
}
