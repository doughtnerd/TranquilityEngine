//! Workloads for the occlusion core's benches and smoke timer: a city grid and a dense forest, ported from
//! `spikes/occlusion-raster` (same generators and seeds), flattened into the core's inputs (world-space triangles,
//! errors, edge neighbours, occludee boxes) and a walking camera.
use vis_raster::frame::NONE;
use vis_raster::{Occluders, View};

/// SplitMix64: deterministic, platform independent.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn f(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    pub fn below(&mut self, n: u32) -> u32 {
        (self.next_u64() % n as u64) as u32
    }
}

type V3 = [f32; 3];

/// A mesh in local space, welded by index.
#[derive(Clone, Default)]
struct Mesh {
    verts: Vec<V3>,
    tris: Vec<[u32; 3]>,
}

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

impl Mesh {
    fn vert(&mut self, p: V3) -> u32 {
        self.verts.push(p);
        (self.verts.len() - 1) as u32
    }
    /// A triangle wound so its normal points away from `center` (valid for convex pieces).
    fn tri_out(&mut self, a: u32, b: u32, c: u32, center: V3) {
        let p = |m: &Mesh, i: u32| m.verts[i as usize];
        let (pa, pb, pc) = (p(self, a), p(self, b), p(self, c));
        let n = cross(sub(pb, pa), sub(pc, pa));
        let cen = [
            (pa[0] + pb[0] + pc[0]) / 3.0,
            (pa[1] + pb[1] + pc[1]) / 3.0,
            (pa[2] + pb[2] + pc[2]) / 3.0,
        ];
        if dot(n, sub(cen, center)) >= 0.0 {
            self.tris.push([a, b, c]);
        } else {
            self.tris.push([a, c, b]);
        }
    }
    fn add_box(&mut self, mn: V3, mx: V3) {
        let b = self.verts.len() as u32;
        for i in 0..8u32 {
            self.vert([
                if i & 1 == 0 { mn[0] } else { mx[0] },
                if i & 2 == 0 { mn[1] } else { mx[1] },
                if i & 4 == 0 { mn[2] } else { mx[2] },
            ]);
        }
        let c = [
            (mn[0] + mx[0]) * 0.5,
            (mn[1] + mx[1]) * 0.5,
            (mn[2] + mx[2]) * 0.5,
        ];
        for q in [
            [0, 2, 6, 4],
            [1, 3, 7, 5],
            [0, 1, 5, 4],
            [2, 3, 7, 6],
            [0, 1, 3, 2],
            [4, 5, 7, 6],
        ] {
            self.tri_out(b + q[0], b + q[1], b + q[2], c);
            self.tri_out(b + q[0], b + q[2], b + q[3], c);
        }
    }
    fn add_pyramid(&mut self, mn: V3, mx: V3, h: f32) {
        let b = self.verts.len() as u32;
        self.vert([mn[0], mn[1], mn[2]]);
        self.vert([mx[0], mn[1], mn[2]]);
        self.vert([mx[0], mn[1], mx[2]]);
        self.vert([mn[0], mn[1], mx[2]]);
        self.vert([(mn[0] + mx[0]) * 0.5, mn[1] + h, (mn[2] + mx[2]) * 0.5]);
        let c = [
            (mn[0] + mx[0]) * 0.5,
            mn[1] + h * 0.3,
            (mn[2] + mx[2]) * 0.5,
        ];
        for i in 0..4u32 {
            self.tri_out(b + i, b + (i + 1) % 4, b + 4, c);
        }
    }
    /// An n-sided tapered prism (y from 0 to h), side quads plus a top cap fan.
    fn add_prism(&mut self, n: u32, r0: f32, r1: f32, h: f32) {
        let b = self.verts.len() as u32;
        for i in 0..n {
            let a = i as f32 / n as f32 * core::f32::consts::TAU;
            self.vert([a.cos() * r0, 0.0, a.sin() * r0]);
        }
        for i in 0..n {
            let a = i as f32 / n as f32 * core::f32::consts::TAU;
            self.vert([a.cos() * r1, h, a.sin() * r1]);
        }
        let c = [0.0, h * 0.5, 0.0];
        for i in 0..n {
            let j = (i + 1) % n;
            self.tri_out(b + i, b + j, b + n + j, c);
            self.tri_out(b + i, b + n + j, b + n + i, c);
        }
        for i in 1..n - 1 {
            self.tri_out(b + n, b + n + i, b + n + i + 1, c);
        }
    }
    /// An icosahedron scaled per axis, centred at `c`.
    fn add_icosa(&mut self, c: V3, s: V3) {
        let t = (1.0 + 5f32.sqrt()) * 0.5;
        let raw = [
            [-1.0, t, 0.0],
            [1.0, t, 0.0],
            [-1.0, -t, 0.0],
            [1.0, -t, 0.0],
            [0.0, -1.0, t],
            [0.0, 1.0, t],
            [0.0, -1.0, -t],
            [0.0, 1.0, -t],
            [t, 0.0, -1.0],
            [t, 0.0, 1.0],
            [-t, 0.0, -1.0],
            [-t, 0.0, 1.0],
        ];
        let b = self.verts.len() as u32;
        let l = (1.0 + t * t).sqrt();
        for r in raw {
            self.vert([
                c[0] + r[0] / l * s[0],
                c[1] + r[1] / l * s[1],
                c[2] + r[2] / l * s[2],
            ]);
        }
        for f in [
            [0, 11, 5],
            [0, 5, 1],
            [0, 1, 7],
            [0, 7, 10],
            [0, 10, 11],
            [1, 5, 9],
            [5, 11, 4],
            [11, 10, 2],
            [10, 7, 6],
            [7, 1, 8],
            [3, 9, 4],
            [3, 4, 2],
            [3, 2, 6],
            [3, 6, 8],
            [3, 8, 9],
            [4, 9, 5],
            [2, 4, 11],
            [6, 2, 10],
            [8, 6, 7],
            [9, 8, 1],
        ] {
            self.tri_out(b + f[0], b + f[1], b + f[2], c);
        }
    }
}

/// Row-major 3x4 instance transform: yaw, uniform scale, translation.
fn xf(yaw: f32, s: f32, t: V3) -> [f32; 12] {
    let (sn, cs) = yaw.sin_cos();
    [
        cs * s,
        0.0,
        sn * s,
        t[0],
        0.0,
        s,
        0.0,
        t[1],
        -sn * s,
        0.0,
        cs * s,
        t[2],
    ]
}

/// A workload: the occluder instances (flattened to world-space triangles each frame by [`Workload::occluders`]) and the
/// occludee boxes.
pub struct Workload {
    pub name: &'static str,
    meshes: Vec<Mesh>,
    /// Per mesh: its neighbour table (local triangle indices) and bounding radius about the origin.
    mesh_nb: Vec<Vec<u32>>,
    mesh_r: Vec<f32>,
    inst_mesh: Vec<u32>,
    inst_xf: Vec<[f32; 12]>,
    /// 6 floats per occludee.
    pub boxes: Vec<f32>,
    city: bool,
}

/// The inputs of one view in the core's layout.
#[derive(Default)]
pub struct Frame {
    pub triangles: Vec<f32>,
    pub errors: Vec<f32>,
    pub neighbors: Vec<u32>,
}

impl Frame {
    pub fn occluders(&self) -> Occluders<'_> {
        Occluders {
            triangles: &self.triangles,
            errors: &self.errors,
            neighbors: &self.neighbors,
        }
    }
}

impl Workload {
    fn new(name: &'static str, city: bool) -> Workload {
        Workload {
            name,
            meshes: vec![],
            mesh_nb: vec![],
            mesh_r: vec![],
            inst_mesh: vec![],
            inst_xf: vec![],
            boxes: vec![],
            city,
        }
    }
    fn mesh(&mut self, m: Mesh) -> u32 {
        let flat: Vec<f32> = m.verts.iter().flatten().copied().collect();
        let idx: Vec<u32> = m.tris.iter().flatten().copied().collect();
        self.mesh_nb.push(vis_trim::neighbors(&flat, &idx));
        self.mesh_r.push(
            m.verts
                .iter()
                .map(|p| dot(*p, *p))
                .fold(0.0, f32::max)
                .sqrt(),
        );
        self.meshes.push(m);
        (self.meshes.len() - 1) as u32
    }
    fn inst(&mut self, mesh: u32, x: [f32; 12]) {
        self.inst_mesh.push(mesh);
        self.inst_xf.push(x);
    }
    fn boxed(&mut self, c: V3, half: V3) {
        self.boxes.extend_from_slice(&[
            c[0] - half[0],
            c[1] - half[1],
            c[2] - half[2],
            c[0] + half[0],
            c[1] + half[1],
            c[2] + half[2],
        ]);
    }

    pub fn source_triangles(&self) -> usize {
        self.inst_mesh
            .iter()
            .map(|&m| self.meshes[m as usize].tris.len())
            .sum()
    }

    /// The city of the spike: 1024 buildings (`coarse` false: one box of 12 triangles; true: about 100), 3000 occludees.
    pub fn city(coarse: bool) -> Workload {
        let mut w = Workload::new(if coarse { "city-coarse" } else { "city-box" }, true);
        let mut rng = Rng::new(0xC17);
        const G: usize = 16;
        const PITCH: f32 = 60.0;
        let mut buildings: Vec<(V3, f32, f32, f32)> = vec![];
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
                        let h = if r < 0.15 {
                            rng.range(8.0, 16.0)
                        } else if r < 0.75 {
                            rng.range(18.0, 50.0)
                        } else {
                            rng.range(50.0, 95.0)
                        };
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
                m.add_box([-hw, 0.0, -hd], [hw, h * 0.6, hd]);
                m.add_box(
                    [-hw * 0.8, h * 0.6, -hd * 0.8],
                    [hw * 0.8, h * 0.85, hd * 0.8],
                );
                m.add_box([-hw * 0.6, h * 0.85, -hd * 0.6], [hw * 0.6, h, hd * 0.6]);
                let bw = hw * 0.35;
                m.add_box([-bw, h * 0.1, -hd - 0.8], [bw, h * 0.5, -hd]);
                m.add_box([-bw, h * 0.1, hd], [bw, h * 0.5, hd + 0.8]);
                m.add_box([-hw - 0.8, h * 0.1, -bw], [-hw, h * 0.5, bw]);
                m.add_box([hw, h * 0.1, -bw], [hw + 0.8, h * 0.5, bw]);
                m.add_box([-hw * 0.2, h, -hd * 0.2], [hw * 0.2, h + 2.0, hd * 0.2]);
                m.add_pyramid(
                    [-hw * 0.6, h + 2.0, -hd * 0.6],
                    [hw * 0.6, h + 2.0, hd * 0.6],
                    3.0,
                );
            }
            let mi = w.mesh(m);
            w.inst(mi, xf(0.0, 1.0, c));
        }
        let street = |rng: &mut Rng| -> (V3, bool) {
            let along_z = rng.below(2) == 0;
            let line = rng.below(G as u32 + 1) as f32 * PITCH;
            let other = rng.range(0.0, G as f32 * PITCH);
            let off = if rng.below(2) == 0 { -4.0 } else { 4.0 } + rng.range(-1.0, 1.0);
            if along_z {
                ([line + off, 0.0, other], true)
            } else {
                ([other, 0.0, line + off], false)
            }
        };
        for _ in 0..1000 {
            let (p, z) = street(&mut rng);
            let (hw, hl) = (0.95, 2.25);
            let half = if z { [hw, 0.75, hl] } else { [hl, 0.75, hw] };
            w.boxed([p[0], 0.75, p[2]], half);
        }
        for _ in 0..600 {
            let (p, _) = street(&mut rng);
            let q = [
                p[0] + rng.range(-5.0, 5.0),
                0.0,
                p[2] + rng.range(-5.0, 5.0),
            ];
            let hh = rng.range(0.3, 3.0);
            let hs = rng.range(0.15, 0.6);
            w.boxed([q[0], hh, q[2]], [hs, hh, hs]);
        }
        for _ in 0..1000 {
            let &(c, hw, hd, h) = &buildings[rng.below(buildings.len() as u32) as usize];
            let (sx, sz) = (rng.range(0.5, 1.5), rng.range(0.5, 1.5));
            let px = c[0] + rng.range(-0.25, 0.25) * hw * 2.0;
            let pz = c[2] + rng.range(-0.25, 0.25) * hd * 2.0;
            let py = rng.range(1.0, h * 0.55 - 1.0).max(1.0);
            w.boxed([px, py, pz], [sx, 0.8, sz]);
        }
        for _ in 0..400 {
            let &(c, hw, hd, h) = &buildings[rng.below(buildings.len() as u32) as usize];
            let hh = rng.range(0.4, 1.6);
            let (sx, sz) = (rng.range(0.4, 1.6), rng.range(0.4, 1.6));
            let top = if coarse { h + 5.0 } else { h };
            let px = c[0] + rng.range(-0.4, 0.4) * hw * 2.0;
            let pz = c[2] + rng.range(-0.4, 0.4) * hd * 2.0;
            w.boxed([px, top + hh + 0.01, pz], [sx, hh, sz]);
        }
        w
    }

    /// The forest of the spike: 2000 trunk and rock occluders, 10,000 occludees.
    pub fn forest() -> Workload {
        let mut w = Workload::new("forest", false);
        let mut rng = Rng::new(0xF0425);
        let mut trunk = vec![];
        for &n in &[6u32, 8, 12, 16] {
            for &r in &[0.18f32, 0.3, 0.5] {
                let mut m = Mesh::default();
                m.add_prism(n, r, r * 0.6, 11.0);
                trunk.push(w.mesh(m));
            }
        }
        let mut rocks = vec![];
        let mut m = Mesh::default();
        m.add_box([-1.0, 0.0, -0.8], [1.0, 1.2, 0.9]);
        rocks.push(w.mesh(m));
        let mut m = Mesh::default();
        m.add_icosa([0.0, 0.7, 0.0], [1.0, 0.8, 1.1]);
        rocks.push(w.mesh(m));
        let mut m = Mesh::default();
        m.add_icosa([0.0, 0.5, 0.0], [1.6, 0.6, 1.2]);
        rocks.push(w.mesh(m));
        let (xr, zr) = (100.0f32, (-20.0f32, 280.0f32));
        for i in 0..2000 {
            let (x, z) = (rng.range(-xr, xr), rng.range(zr.0, zr.1));
            if x.abs() < 1.5 && z.abs() < 3.0 {
                continue;
            }
            if i % 10 < 7 {
                let m = trunk[rng.below(trunk.len() as u32) as usize];
                let sc = rng.range(0.7, 1.5);
                w.inst(
                    m,
                    xf(rng.range(0.0, core::f32::consts::TAU), sc, [x, 0.0, z]),
                );
            } else {
                let m = rocks[rng.below(3) as usize];
                let sc = rng.range(0.6, 2.2);
                w.inst(
                    m,
                    xf(rng.range(0.0, core::f32::consts::TAU), sc, [x, 0.0, z]),
                );
            }
        }
        for _ in 0..6000 {
            let hh = rng.range(0.3, 1.0);
            w.boxed(
                [rng.range(-xr, xr), hh, rng.range(zr.0, zr.1)],
                [rng.range(0.3, 1.2), hh, rng.range(0.3, 1.2)],
            );
        }
        for _ in 0..2500 {
            let hh = rng.range(1.5, 2.5);
            w.boxed(
                [
                    rng.range(-xr, xr),
                    rng.range(8.0, 13.0),
                    rng.range(zr.0, zr.1),
                ],
                [rng.range(2.0, 3.5), hh, rng.range(2.0, 3.5)],
            );
        }
        for _ in 0..1500 {
            let hh = rng.range(0.1, 0.4);
            w.boxed(
                [rng.range(-xr, xr), hh, rng.range(zr.0, zr.1)],
                [rng.range(0.1, 0.4), hh, rng.range(0.1, 0.4)],
            );
        }
        w
    }

    /// Flattens every instance whose bounding sphere is in front of the eye into world-space triangles (exact meshes,
    /// error 0), the way the engine's selection step hands them to the core.
    pub fn frame(&self, view: &View) -> Frame {
        let mut f = Frame::default();
        let mut count = 0u32;
        // the four side planes and the near plane, as (normal, d) over world space, normalised
        let plane = |row: usize, s: f32| {
            let n = [
                view.cols[0][3] + s * view.cols[0][row],
                view.cols[1][3] + s * view.cols[1][row],
                view.cols[2][3] + s * view.cols[2][row],
            ];
            let d = view.cols[3][3] + s * view.cols[3][row];
            let l = dot(n, n).sqrt();
            ([n[0] / l, n[1] / l, n[2] / l], d / l)
        };
        let planes = [plane(0, 1.0), plane(0, -1.0), plane(1, 1.0), plane(1, -1.0)];
        for (i, &mi) in self.inst_mesh.iter().enumerate() {
            let m = &self.meshes[mi as usize];
            let x = &self.inst_xf[i];
            let c = [x[3], x[7], x[11]];
            // the mesh's bounding sphere is about its local origin
            let r =
                self.mesh_r[mi as usize] * (x[0] * x[0] + x[4] * x[4] + x[8] * x[8]).sqrt() * 1.001;
            if planes.iter().any(|(n, d)| dot(*n, c) + d < -r) {
                continue;
            }
            for v in &m.tris {
                for &k in v {
                    let p = m.verts[k as usize];
                    f.triangles.extend_from_slice(&[
                        x[0] * p[0] + x[1] * p[1] + x[2] * p[2] + x[3],
                        x[4] * p[0] + x[5] * p[1] + x[6] * p[2] + x[7],
                        x[8] * p[0] + x[9] * p[1] + x[10] * p[2] + x[11],
                    ]);
                }
            }
            f.errors.extend(std::iter::repeat_n(0.0, m.tris.len()));
            for &n in &self.mesh_nb[mi as usize] {
                f.neighbors.push(if n == NONE { NONE } else { n + count });
            }
            count += m.tris.len() as u32;
        }
        f
    }

    /// A walking camera for frame `frame` (240 frames per loop), as the spike's.
    pub fn view(&self, frame: u32) -> View {
        let f = (frame % 240) as f32;
        let (eye, target, far) = if self.city {
            let e = [480.0 + 1.0 * (f * 0.05).sin(), 1.7, 25.0 + f * 0.6];
            (e, [e[0] + 6.0 * (f * 0.07).sin(), 4.0, e[2] + 80.0], 1200.0)
        } else {
            let e = [3.0 * (f * 0.03).sin(), 1.7, 4.0 + f * 0.2];
            (e, [e[0] + 8.0 * (f * 0.04).sin(), 1.5, e[2] + 60.0], 220.0)
        };
        look_at(eye, target, 60.0, 16.0 / 9.0, 0.1, far)
    }
}

/// A perspective view looking from `eye` at `target` (y up, x right, z forward), clip w = view-space depth. The z row is
/// the usual depth mapping, so the matrix is regular.
pub fn look_at(eye: V3, target: V3, fov_y_deg: f32, aspect: f32, near: f32, far: f32) -> View {
    let norm = |a: V3| {
        let l = dot(a, a).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let fwd = norm(sub(target, eye));
    let right = norm(cross([0.0, 1.0, 0.0], fwd));
    let up = cross(fwd, right);
    let t = (fov_y_deg.to_radians() * 0.5).tan();
    let (sx, sy) = (1.0 / (t * aspect), 1.0 / t);
    let (a, b) = (far / (far - near), -near * far / (far - near));
    // rows of V: right, up, fwd (with translation)
    let v = [
        [right[0], right[1], right[2], -dot(right, eye)],
        [up[0], up[1], up[2], -dot(up, eye)],
        [fwd[0], fwd[1], fwd[2], -dot(fwd, eye)],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let p = [
        [sx, 0.0, 0.0, 0.0],
        [0.0, sy, 0.0, 0.0],
        [0.0, 0.0, a, b],
        [0.0, 0.0, 1.0, 0.0],
    ];
    let mut m = [0f32; 16];
    for i in 0..4 {
        for j in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += p[i][k] * v[k][j];
            }
            m[j * 4 + i] = s; // column-major
        }
    }
    View::perspective(&m, eye, near, far, sx, sy).expect("a regular view")
}
