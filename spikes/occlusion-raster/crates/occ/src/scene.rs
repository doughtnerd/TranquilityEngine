//! Deterministic workloads: a city grid (simple 12-tri or coarse ~100-tri building occluders) and a dense forest.
use crate::geom::{add, cross, norm, scale, sub, Camera, Mesh};
use crate::rng::Rng;

pub const SCENE_CITY_BOX: u32 = 0;
pub const SCENE_CITY_COARSE: u32 = 1;
pub const SCENE_FOREST: u32 = 2;
pub const SCENE_NAMES: [&str; 3] = ["city-box", "city-coarse", "forest"];
pub const PATH_FRAMES: u32 = 240;

pub struct Scene {
    pub id: u32,
    pub meshes: Vec<Mesh>,
    pub mesh_sphere: Vec<[f32; 4]>,
    pub mesh_tris: Vec<u32>,
    pub inst_mesh: Vec<u32>,
    /// 12 floats per instance, row-major 3x4 (r0: m0..m2,tx; r1; r2).
    pub inst_xf: Vec<f32>,
    /// 6 floats per occludee: min xyz, max xyz.
    pub aabbs: Vec<f32>,
}

fn xf(yaw: f32, s: f32, t: [f32; 3]) -> [f32; 12] {
    let (sn, cs) = yaw.sin_cos();
    [cs * s, 0.0, sn * s, t[0], 0.0, s, 0.0, t[1], -sn * s, 0.0, cs * s, t[2]]
}

impl Scene {
    fn push_mesh(&mut self, m: Mesh) -> u32 {
        let m = m.finish();
        self.mesh_sphere.push(m.sphere);
        self.mesh_tris.push(m.tris.len() as u32);
        self.meshes.push(m);
        (self.meshes.len() - 1) as u32
    }
    fn push_inst(&mut self, mesh: u32, x: [f32; 12]) {
        self.inst_mesh.push(mesh);
        self.inst_xf.extend_from_slice(&x);
    }
    fn push_box(&mut self, c: [f32; 3], half: [f32; 3]) {
        self.aabbs.extend_from_slice(&[c[0] - half[0], c[1] - half[1], c[2] - half[2], c[0] + half[0], c[1] + half[1], c[2] + half[2]]);
    }

    pub fn total_source_tris(&self) -> u32 {
        self.inst_mesh.iter().map(|&m| self.mesh_tris[m as usize]).sum()
    }

    pub fn build(id: u32) -> Scene {
        let mut s = Scene { id, meshes: vec![], mesh_sphere: vec![], mesh_tris: vec![], inst_mesh: vec![], inst_xf: vec![], aabbs: vec![] };
        match id {
            SCENE_CITY_BOX => s.city(false),
            SCENE_CITY_COARSE => s.city(true),
            _ => s.forest(),
        }
        s
    }

    fn city(&mut self, coarse: bool) {
        let mut rng = Rng::new(0xC17);
        const G: usize = 16;
        const PITCH: f32 = 60.0;
        // (centre x, centre z, half w, half d, height)
        let mut buildings: Vec<([f32; 3], f32, f32, f32)> = vec![];
        for bi in 0..G {
            for bj in 0..G {
                let ox = bi as f32 * PITCH + 10.0;
                let oz = bj as f32 * PITCH + 10.0;
                for li in 0..2 {
                    for lj in 0..2 {
                        let cx = ox + 10.0 + li as f32 * 20.0 + rng.range(-1.0, 1.0);
                        let cz = oz + 10.0 + lj as f32 * 20.0 + rng.range(-1.0, 1.0);
                        let (hw, hd) = (rng.range(7.0, 8.7), rng.range(7.0, 8.7));
                        let r = rng.f();
                        let h = if r < 0.15 { rng.range(8.0, 16.0) } else if r < 0.75 { rng.range(18.0, 50.0) } else { rng.range(50.0, 95.0) };
                        buildings.push(([cx, 0.0, cz], hw, hd, h));
                    }
                }
            }
        }
        for &(c, hw, hd, h) in &buildings {
            let mut m = Mesh::default();
            if !coarse {
                m.add_box([-hw, 0.0, -hd], [hw, h, hd]);
            } else {
                // 3 nested tiers (36) + 4 bays (48) + rooftop box (12) + pyramid (4) = 100 tris
                m.add_box([-hw, 0.0, -hd], [hw, h * 0.6, hd]);
                m.add_box([-hw * 0.8, h * 0.6, -hd * 0.8], [hw * 0.8, h * 0.85, hd * 0.8]);
                m.add_box([-hw * 0.6, h * 0.85, -hd * 0.6], [hw * 0.6, h, hd * 0.6]);
                let bw = hw * 0.35;
                m.add_box([-bw, h * 0.1, -hd - 0.8], [bw, h * 0.5, -hd]);
                m.add_box([-bw, h * 0.1, hd], [bw, h * 0.5, hd + 0.8]);
                m.add_box([-hw - 0.8, h * 0.1, -bw], [-hw, h * 0.5, bw]);
                m.add_box([hw, h * 0.1, -bw], [hw + 0.8, h * 0.5, bw]);
                m.add_box([-hw * 0.2, h, -hd * 0.2], [hw * 0.2, h + 2.0, hd * 0.2]);
                m.add_pyramid([-hw * 0.6, h + 2.0, -hd * 0.6], [hw * 0.6, h + 2.0, hd * 0.6], 3.0);
            }
            let mi = self.push_mesh(m);
            self.push_inst(mi, xf(0.0, 1.0, c));
        }
        // occludees: 1000 cars, 600 props, 1000 interior details, 400 rooftop objects
        let street = |rng: &mut Rng| -> ([f32; 3], bool) {
            // returns centre of a lane point and whether the street runs along z
            let along_z = rng.below(2) == 0;
            let line = rng.below(G as u32 + 1) as f32 * PITCH;
            let other = rng.range(0.0, G as f32 * PITCH);
            let off = if rng.below(2) == 0 { -4.0 } else { 4.0 } + rng.range(-1.0, 1.0);
            if along_z { ([line + off, 0.0, other], true) } else { ([other, 0.0, line + off], false) }
        };
        for _ in 0..1000 {
            let (p, z) = street(&mut rng);
            let (hw, hl) = (0.95, 2.25);
            let half = if z { [hw, 0.75, hl] } else { [hl, 0.75, hw] };
            self.push_box([p[0], 0.75, p[2]], half);
        }
        for _ in 0..600 {
            let (p, _) = street(&mut rng);
            let q = [p[0] + rng.range(-5.0, 5.0), 0.0, p[2] + rng.range(-5.0, 5.0)];
            let hh = rng.range(0.3, 3.0);
            let hs = rng.range(0.15, 0.6);
            self.push_box([q[0], hh, q[2]], [hs, hh, hs]);
        }
        for _ in 0..1000 {
            let &(c, hw, hd, h) = &buildings[rng.below(buildings.len() as u32) as usize];
            let (sx, sz) = (rng.range(0.5, 1.5), rng.range(0.5, 1.5));
            let px = c[0] + rng.range(-0.25, 0.25) * hw * 2.0;
            let pz = c[2] + rng.range(-0.25, 0.25) * hd * 2.0;
            let py = rng.range(1.0, h * 0.55 - 1.0).max(1.0);
            self.push_box([px, py, pz], [sx, 0.8, sz]);
        }
        for _ in 0..400 {
            let &(c, hw, hd, h) = &buildings[rng.below(buildings.len() as u32) as usize];
            let hh = rng.range(0.4, 1.6);
            let (sx, sz) = (rng.range(0.4, 1.6), rng.range(0.4, 1.6));
            let top = if coarse { h + 5.0 } else { h };
            let px = c[0] + rng.range(-0.4, 0.4) * hw * 2.0;
            let pz = c[2] + rng.range(-0.4, 0.4) * hd * 2.0;
            let _ = (sx, sz);
            self.push_box([px, top + hh + 0.01, pz], [sx, hh, sz]);
        }
    }

    fn forest(&mut self) {
        let mut rng = Rng::new(0xF0425);
        // trunk variants: sides 6/8/12/16 x (slender, medium, thick); rocks: box, icosa, flat icosa
        let mut trunk = vec![];
        for &n in &[6u32, 8, 12, 16] {
            for &r in &[0.18f32, 0.3, 0.5] {
                let mut m = Mesh::default();
                m.add_prism(n, r, r * 0.6, 11.0);
                trunk.push(self.push_mesh(m));
            }
        }
        let mut rocks = vec![];
        {
            let mut m = Mesh::default();
            m.add_box([-1.0, 0.0, -0.8], [1.0, 1.2, 0.9]);
            rocks.push(self.push_mesh(m));
            let mut m = Mesh::default();
            m.add_icosa([0.0, 0.7, 0.0], [1.0, 0.8, 1.1]);
            rocks.push(self.push_mesh(m));
            let mut m = Mesh::default();
            m.add_icosa([0.0, 0.5, 0.0], [1.6, 0.6, 1.2]);
            rocks.push(self.push_mesh(m));
        }
        let (xr, zr) = (100.0f32, (-20.0f32, 280.0f32));
        for i in 0..2000 {
            let (x, z) = (rng.range(-xr, xr), rng.range(zr.0, zr.1));
            if x.abs() < 1.5 && z.abs() < 3.0 {
                continue;
            }
            if i % 10 < 7 {
                let m = trunk[rng.below(trunk.len() as u32) as usize];
                let sc = rng.range(0.7, 1.5);
                self.push_inst(m, xf(rng.range(0.0, 6.28), sc, [x, 0.0, z]));
            } else {
                let m = rocks[rng.below(3) as usize];
                let sc = rng.range(0.6, 2.2);
                self.push_inst(m, xf(rng.range(0.0, 6.28), sc, [x, 0.0, z]));
            }
        }
        // occludees: 6000 undergrowth, 2500 canopies, 1500 small things
        for _ in 0..6000 {
            let hh = rng.range(0.3, 1.0);
            self.push_box([rng.range(-xr, xr), hh, rng.range(zr.0, zr.1)], [rng.range(0.3, 1.2), hh, rng.range(0.3, 1.2)]);
        }
        for _ in 0..2500 {
            let hh = rng.range(1.5, 2.5);
            self.push_box([rng.range(-xr, xr), rng.range(8.0, 13.0), rng.range(zr.0, zr.1)], [rng.range(2.0, 3.5), hh, rng.range(2.0, 3.5)]);
        }
        for _ in 0..1500 {
            let hh = rng.range(0.1, 0.4);
            self.push_box([rng.range(-xr, xr), hh, rng.range(zr.0, zr.1)], [rng.range(0.1, 0.4), hh, rng.range(0.1, 0.4)]);
        }
    }

    /// Camera for path frame `frame`. kind 0: the main camera; 1: a second perspective viewport looking sideways;
    /// 2: an orthographic shadow-cascade camera along a sun direction covering a slice of the main frustum.
    pub fn camera(&self, kind: u32, frame: u32) -> Camera {
        let f = (frame % PATH_FRAMES) as f32;
        let aspect = 16.0 / 9.0;
        let city = self.id != SCENE_FOREST;
        let (eye, target, far) = if city {
            let e = [480.0 + 1.0 * (f * 0.05).sin(), 1.7, 25.0 + f * 0.6];
            (e, [e[0] + 6.0 * (f * 0.07).sin(), 4.0, e[2] + 80.0], 1200.0)
        } else {
            let e = [3.0 * (f * 0.03).sin(), 1.7, 4.0 + f * 0.2];
            (e, [e[0] + 8.0 * (f * 0.04).sin(), 1.5, e[2] + 60.0], 220.0)
        };
        let main = Camera::perspective(eye, target, 60.0, aspect, 0.1, far);
        match kind {
            0 => main,
            1 => {
                let t = [eye[0] + 80.0, eye[1] + 1.0, eye[2] + 10.0];
                Camera::perspective(eye, t, 60.0, aspect, 0.1, far)
            }
            _ => {
                let dir = norm([0.35, -0.8, 0.45]);
                let slice = if city { 70.0 } else { 50.0 };
                let centre = add(eye, scale(main.fwd, slice));
                let e = sub(centre, scale(dir, 400.0));
                let half = if city { 90.0 } else { 70.0 };
                let _ = cross;
                Camera::ortho(e, dir, half, half, 0.0, 800.0)
            }
        }
    }
}
