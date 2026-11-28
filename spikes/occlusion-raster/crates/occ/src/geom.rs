//! Vectors, cameras and mesh builders. World: x east, y up, z north. Camera view space: x right, y up, z forward.
//! Meshes are wound CCW seen from outside in the right-handed cross-product sense; with the camera above, a front
//! face then has NEGATIVE screen area (y up), which `cull::emit_tri` encodes.

pub type V3 = [f32; 3];

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt();
    scale(a, 1.0 / l)
}

/// Frustum guard band (in units of w) the clipper keeps, so screen coordinates stay a few viewports wide.
pub const GUARD: f32 = 1.5;

#[derive(Clone)]
pub struct Camera {
    /// Row-major clip matrix (clip = rows * (p,1)).
    pub rows: [[f32; 4]; 4],
    /// Columns of the same matrix: cols[j][i] = rows[i][j].
    pub cols: [[f32; 4]; 4],
    pub persp: bool,
    pub near: f32,
    pub far: f32,
    /// Clip x and y scale (cot(fov/2)/aspect and cot(fov/2) for perspective; 1/half extent for orthographic).
    pub sx: f32,
    pub sy: f32,
    pub eye: V3,
    pub right: V3,
    pub up: V3,
    pub fwd: V3,
    /// Normalised world-space frustum planes (a,b,c,d), inside is a*x+b*y+c*z+d >= 0: l, r, b, t, near, far.
    pub planes: [[f32; 4]; 6],
}

impl Camera {
    fn build(eye: V3, right: V3, up: V3, fwd: V3, persp: bool, sx: f32, sy: f32, near: f32, far: f32) -> Camera {
        let v = [
            [right[0], right[1], right[2], -dot(right, eye)],
            [up[0], up[1], up[2], -dot(up, eye)],
            [fwd[0], fwd[1], fwd[2], -dot(fwd, eye)],
            [0.0, 0.0, 0.0, 1.0],
        ];
        let p = if persp {
            [[sx, 0.0, 0.0, 0.0], [0.0, sy, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
        } else {
            let k = 1.0 / (far - near);
            [[sx, 0.0, 0.0, 0.0], [0.0, sy, 0.0, 0.0], [0.0, 0.0, k, -near * k], [0.0, 0.0, 0.0, 1.0]]
        };
        let mut rows = [[0f32; 4]; 4];
        for i in 0..4 {
            for j in 0..4 {
                let mut s = 0.0;
                for k in 0..4 {
                    s += p[i][k] * v[k][j];
                }
                rows[i][j] = s;
            }
        }
        let mut cols = [[0f32; 4]; 4];
        for i in 0..4 {
            for j in 0..4 {
                cols[j][i] = rows[i][j];
            }
        }
        let comb = |a: [f32; 4], b: [f32; 4], s: f32| [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
        let mut planes = [
            comb(rows[3], rows[0], 1.0),
            comb(rows[3], rows[0], -1.0),
            comb(rows[3], rows[1], 1.0),
            comb(rows[3], rows[1], -1.0),
            if persp { comb(rows[3], [0.0, 0.0, 0.0, 1.0], -near) } else { rows[2] },
            if persp { [-rows[3][0], -rows[3][1], -rows[3][2], far - rows[3][3]] } else { comb(rows[3], rows[2], -1.0) },
        ];
        for pl in planes.iter_mut() {
            let l = (pl[0] * pl[0] + pl[1] * pl[1] + pl[2] * pl[2]).sqrt();
            for c in pl.iter_mut() {
                *c /= l;
            }
        }
        Camera { rows, cols, persp, near, far, sx, sy, eye, right, up, fwd, planes }
    }

    pub fn perspective(eye: V3, target: V3, fov_y_deg: f32, aspect: f32, near: f32, far: f32) -> Camera {
        let fwd = norm(sub(target, eye));
        let right = norm(cross([0.0, 1.0, 0.0], fwd));
        let up = cross(fwd, right);
        let t = (fov_y_deg.to_radians() * 0.5).tan();
        Camera::build(eye, right, up, fwd, true, 1.0 / (t * aspect), 1.0 / t, near, far)
    }

    /// Orthographic camera looking along `dir` (a sun/light direction), half extents in world units.
    pub fn ortho(eye: V3, dir: V3, half_w: f32, half_h: f32, near: f32, far: f32) -> Camera {
        let fwd = norm(dir);
        let right = norm(cross([0.0, 1.0, 0.0], fwd));
        let up = cross(fwd, right);
        Camera::build(eye, right, up, fwd, false, 1.0 / half_w, 1.0 / half_h, near, far)
    }

    /// Sphere vs the six frustum planes (conservative).
    pub fn sphere_visible(&self, c: V3, r: f32) -> bool {
        for p in &self.planes {
            if p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Default)]
pub struct Mesh {
    pub verts: Vec<[f32; 4]>,
    pub tris: Vec<[u32; 3]>,
    /// Local bounding sphere: centre and radius.
    pub sphere: [f32; 4],
}

impl Mesh {
    pub fn push_vert(&mut self, p: V3) -> u32 {
        self.verts.push([p[0], p[1], p[2], 1.0]);
        (self.verts.len() - 1) as u32
    }
    /// Adds a triangle wound so its normal points away from `center` (valid for convex pieces).
    pub fn tri_out(&mut self, a: u32, b: u32, c: u32, center: V3) {
        let p = |i: u32| {
            let v = self.verts[i as usize];
            [v[0], v[1], v[2]]
        };
        let (pa, pb, pc) = (p(a), p(b), p(c));
        let n = cross(sub(pb, pa), sub(pc, pa));
        let cen = scale(add(add(pa, pb), pc), 1.0 / 3.0);
        if dot(n, sub(cen, center)) >= 0.0 {
            self.tris.push([a, b, c]);
        } else {
            self.tris.push([a, c, b]);
        }
    }
    pub fn add_box(&mut self, mn: V3, mx: V3) {
        let b = self.verts.len() as u32;
        for i in 0..8u32 {
            self.push_vert([
                if i & 1 == 0 { mn[0] } else { mx[0] },
                if i & 2 == 0 { mn[1] } else { mx[1] },
                if i & 4 == 0 { mn[2] } else { mx[2] },
            ]);
        }
        let c = scale(add(mn, mx), 0.5);
        for q in [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]] {
            self.tri_out(b + q[0], b + q[1], b + q[2], c);
            self.tri_out(b + q[0], b + q[2], b + q[3], c);
        }
    }
    /// n-sided tapered prism (y from 0 to h), side quads plus a top cap fan; no bottom cap.
    pub fn add_prism(&mut self, n: u32, r0: f32, r1: f32, h: f32) {
        let b = self.verts.len() as u32;
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            self.push_vert([a.cos() * r0, 0.0, a.sin() * r0]);
        }
        for i in 0..n {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            self.push_vert([a.cos() * r1, h, a.sin() * r1]);
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
    /// Icosahedron (20 tris) scaled per axis, centred at `c`.
    pub fn add_icosa(&mut self, c: V3, s: V3) {
        let t = (1.0 + 5f32.sqrt()) * 0.5;
        let raw = [
            [-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0],
            [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t],
            [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0],
        ];
        let b = self.verts.len() as u32;
        let l = (1.0 + t * t).sqrt();
        for r in raw {
            self.push_vert([c[0] + r[0] / l * s[0], c[1] + r[1] / l * s[1], c[2] + r[2] / l * s[2]]);
        }
        for f in [
            [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
        ] {
            self.tri_out(b + f[0], b + f[1], b + f[2], c);
        }
    }
    /// Square pyramid roof (4 tris, no base) over [mn,mx] in x/z at height y0, apex height `h` above.
    pub fn add_pyramid(&mut self, mn: V3, mx: V3, h: f32) {
        let b = self.verts.len() as u32;
        self.push_vert([mn[0], mn[1], mn[2]]);
        self.push_vert([mx[0], mn[1], mn[2]]);
        self.push_vert([mx[0], mn[1], mx[2]]);
        self.push_vert([mn[0], mn[1], mx[2]]);
        self.push_vert([(mn[0] + mx[0]) * 0.5, mn[1] + h, (mn[2] + mx[2]) * 0.5]);
        let c = [(mn[0] + mx[0]) * 0.5, mn[1] + h * 0.3, (mn[2] + mx[2]) * 0.5];
        for i in 0..4u32 {
            self.tri_out(b + i, b + (i + 1) % 4, b + 4, c);
        }
    }
    pub fn finish(mut self) -> Mesh {
        let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
        for v in &self.verts {
            for k in 0..3 {
                mn[k] = mn[k].min(v[k]);
                mx[k] = mx[k].max(v[k]);
            }
        }
        let c = [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5, (mn[2] + mx[2]) * 0.5];
        let mut r2 = 0f32;
        for v in &self.verts {
            r2 = r2.max((v[0] - c[0]).powi(2) + (v[1] - c[1]).powi(2) + (v[2] - c[2]).powi(2));
        }
        self.sphere = [c[0], c[1], c[2], r2.sqrt() * 1.0001];
        self
    }
}
