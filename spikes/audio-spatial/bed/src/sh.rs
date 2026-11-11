//! Real spherical harmonics, ACN order, SN3D normalisation (AmbiX), to 3rd order (16 channels);
//! the Lebedev-26 quadrature (a 7-design: exact for the degree <= 6 products of two 3rd-order
//! harmonics); and rotation of a 16-channel bed by a 3x3 rotation.
//!
//! Coordinates: AmbiX (x front, y left, z up). The engine's listener space (the HRTF panner's:
//! x right, y up, forward -z) converts with [`from_engine`].

pub const CH: usize = 16;
pub const Q: usize = 128;

/// Order (degree) of ACN channel `c`.
pub const fn order_of(c: usize) -> usize {
    if c == 0 { 0 } else if c < 4 { 1 } else if c < 9 { 2 } else { 3 }
}

macro_rules! sh_impl {
    ($name:ident, $t:ty) => {
        /// SN3D ACN gains of the unit vector (x, y, z) (AmbiX axes).
        #[inline]
        pub fn $name(x: $t, y: $t, z: $t) -> [$t; 16] {
            let (xx, yy, zz) = (x * x, y * y, z * z);
            [
                1.0,
                y,
                z,
                x,
                1.7320508075688772 * x * y,
                1.7320508075688772 * y * z,
                0.5 * (3.0 * zz - 1.0),
                1.7320508075688772 * x * z,
                0.8660254037844386 * (xx - yy),
                0.7905694150420949 * y * (3.0 * xx - yy),
                3.872983346207417 * x * y * z,
                0.6123724356957945 * y * (5.0 * zz - 1.0),
                0.5 * z * (5.0 * zz - 3.0),
                0.6123724356957945 * x * (5.0 * zz - 1.0),
                1.9364916731037085 * z * (xx - yy),
                0.7905694150420949 * x * (xx - 3.0 * yy),
            ]
        }
    };
}
sh_impl!(sh16, f32);
sh_impl!(sh16_f64, f64);

/// Engine listener-space direction (x right, y up, z back) to AmbiX (x front, y left, z up).
#[inline]
pub fn from_engine(d: [f32; 3]) -> [f32; 3] {
    [-d[2], -d[0], d[1]]
}
/// AmbiX to engine listener space.
#[inline]
pub fn to_engine(d: [f32; 3]) -> [f32; 3] {
    [-d[1], d[2], -d[0]]
}

/// Lebedev 26: (direction in AmbiX axes, weight); weights sum to 1.
pub fn lebedev26() -> Vec<([f64; 3], f64)> {
    let mut v = Vec::new();
    for a in 0..3 {
        for s in [-1.0, 1.0] {
            let mut p = [0.0; 3];
            p[a] = s;
            v.push((p, 1.0 / 21.0));
        }
    }
    let r2 = 1.0 / 2f64.sqrt();
    for (a, b) in [(0, 1), (0, 2), (1, 2)] {
        for sa in [-1.0, 1.0] {
            for sb in [-1.0, 1.0] {
                let mut p = [0.0; 3];
                p[a] = sa * r2;
                p[b] = sb * r2;
                v.push((p, 4.0 / 105.0));
            }
        }
    }
    let r3 = 1.0 / 3f64.sqrt();
    for sx in [-1.0, 1.0] {
        for sy in [-1.0, 1.0] {
            for sz in [-1.0, 1.0] {
                v.push(([sx * r3, sy * r3, sz * r3], 9.0 / 280.0));
            }
        }
    }
    v
}

pub type Mat3 = [[f64; 3]; 3];

pub fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            for k in 0..3 {
                r[i][j] += a[i][k] * b[k][j];
            }
        }
    }
    r
}
pub fn mat3_t(a: &Mat3) -> Mat3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[j][i];
        }
    }
    r
}

/// Right-handed rotation Rz(yaw) Ry(pitch) Rx(roll) in AmbiX axes (yaw > 0 turns front toward left;
/// pitch > 0 dips the front; roll about the front axis).
pub fn euler(yaw: f64, pitch: f64, roll: f64) -> Mat3 {
    let (cy, sy) = (yaw.cos(), yaw.sin());
    let (cp, sp) = (pitch.cos(), pitch.sin());
    let (cr, sr) = (roll.cos(), roll.sin());
    let rz = [[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]];
    let ry = [[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]];
    let rx = [[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]];
    mat3_mul(&rz, &mat3_mul(&ry, &rx))
}

/// Block-diagonal SH rotation: the matrix M with `Y(R d) = M Y(d)` (orders 1, 2, 3; order 0 is 1).
#[derive(Clone, Copy)]
pub struct Rot {
    pub b1: [[f32; 3]; 3],
    pub b2: [[f32; 5]; 5],
    pub b3: [[f32; 7]; 7],
}

impl Rot {
    pub const IDENTITY: Rot = {
        let mut r = Rot { b1: [[0.0; 3]; 3], b2: [[0.0; 5]; 5], b3: [[0.0; 7]; 7] };
        let mut i = 0;
        while i < 3 { r.b1[i][i] = 1.0; i += 1; }
        i = 0;
        while i < 5 { r.b2[i][i] = 1.0; i += 1; }
        i = 0;
        while i < 7 { r.b3[i][i] = 1.0; i += 1; }
        r
    };

    /// The dense 16x16 matrix.
    pub fn dense(&self) -> [[f32; 16]; 16] {
        let mut m = [[0.0; 16]; 16];
        m[0][0] = 1.0;
        for i in 0..3 { for j in 0..3 { m[1 + i][1 + j] = self.b1[i][j]; } }
        for i in 0..5 { for j in 0..5 { m[4 + i][4 + j] = self.b2[i][j]; } }
        for i in 0..7 { for j in 0..7 { m[9 + i][9 + j] = self.b3[i][j]; } }
        m
    }
}

const S: usize = 9;

/// Precomputed pseudo-inverses of the harmonics at nine fixed directions, so a rotation matrix
/// costs nine harmonic evaluations and three small products (no trigonometry, no solve).
pub struct RotBuilder {
    dirs: [[f64; 3]; S],
    p1: [[f32; 3]; S],
    p2: [[f32; 5]; S],
    p3: [[f32; 7]; S],
}

fn pinv<const N: usize>(ys: &[[f64; S]; N]) -> [[f64; N]; S] {
    // (Ys Ys^T)^-1 by Gauss-Jordan, then Ys^T (...)
    let mut g = [[0.0f64; N]; N];
    for i in 0..N { for j in 0..N { for s in 0..S { g[i][j] += ys[i][s] * ys[j][s]; } } }
    let mut inv = [[0.0f64; N]; N];
    for i in 0..N { inv[i][i] = 1.0; }
    for c in 0..N {
        let mut piv = c;
        for r in c..N { if g[r][c].abs() > g[piv][c].abs() { piv = r; } }
        g.swap(c, piv);
        inv.swap(c, piv);
        let d = g[c][c];
        for j in 0..N { g[c][j] /= d; inv[c][j] /= d; }
        for r in 0..N {
            if r != c {
                let f = g[r][c];
                for j in 0..N { g[r][j] -= f * g[c][j]; inv[r][j] -= f * inv[c][j]; }
            }
        }
    }
    let mut p = [[0.0f64; N]; S];
    for s in 0..S { for j in 0..N { for k in 0..N { p[s][j] += ys[k][s] * inv[k][j]; } } }
    p
}

impl RotBuilder {
    pub fn new() -> Self {
        let mut dirs = [[0.0; 3]; S];
        let ga = std::f64::consts::PI * (3.0 - 5f64.sqrt());
        for (i, d) in dirs.iter_mut().enumerate() {
            let z = 1.0 - 2.0 * (i as f64 + 0.5) / S as f64;
            let r = (1.0 - z * z).sqrt();
            *d = [r * (ga * i as f64).cos(), r * (ga * i as f64).sin(), z];
        }
        let mut y1 = [[0.0; S]; 3];
        let mut y2 = [[0.0; S]; 5];
        let mut y3 = [[0.0; S]; 7];
        for (s, d) in dirs.iter().enumerate() {
            let y = sh16_f64(d[0], d[1], d[2]);
            for i in 0..3 { y1[i][s] = y[1 + i]; }
            for i in 0..5 { y2[i][s] = y[4 + i]; }
            for i in 0..7 { y3[i][s] = y[9 + i]; }
        }
        let (a, b, c) = (pinv(&y1), pinv(&y2), pinv(&y3));
        let mut rb = RotBuilder { dirs, p1: [[0.0; 3]; S], p2: [[0.0; 5]; S], p3: [[0.0; 7]; S] };
        for s in 0..S {
            for j in 0..3 { rb.p1[s][j] = a[s][j] as f32; }
            for j in 0..5 { rb.p2[s][j] = b[s][j] as f32; }
            for j in 0..7 { rb.p3[s][j] = c[s][j] as f32; }
        }
        rb
    }

    /// The SH rotation of the 3x3 rotation `r` (AmbiX axes): sources at `d` move to `r d`.
    pub fn build(&self, r: &Mat3) -> Rot {
        let mut yr = [[0.0f32; 16]; S];
        for (s, d) in self.dirs.iter().enumerate() {
            let x = (r[0][0] * d[0] + r[0][1] * d[1] + r[0][2] * d[2]) as f32;
            let y = (r[1][0] * d[0] + r[1][1] * d[1] + r[1][2] * d[2]) as f32;
            let z = (r[2][0] * d[0] + r[2][1] * d[1] + r[2][2] * d[2]) as f32;
            yr[s] = sh16(x, y, z);
        }
        let mut out = Rot::IDENTITY;
        for i in 0..3 { for j in 0..3 { let mut a = 0.0; for s in 0..S { a += yr[s][1 + i] * self.p1[s][j]; } out.b1[i][j] = a; } }
        for i in 0..5 { for j in 0..5 { let mut a = 0.0; for s in 0..S { a += yr[s][4 + i] * self.p2[s][j]; } out.b2[i][j] = a; } }
        for i in 0..7 { for j in 0..7 { let mut a = 0.0; for s in 0..S { a += yr[s][9 + i] * self.p3[s][j]; } out.b3[i][j] = a; } }
        out
    }
}

/// `out = (m0 + (m1 - m0) t_i) * input` per frame, `t_i = (i + 1) / 128`, for the first `n_ch`
/// channels (4 = FOA, 16 = 3rd order). Block-diagonal, so 1 + 9 + 25 + 49 products a frame.
pub fn apply_rot_ramp(inp: &[&[f32]], out: &mut [[f32; Q]], n_ch: usize, m0: &Rot, m1: &Rot) {
    out[0].copy_from_slice(&inp[0][..Q]);
    macro_rules! block {
        ($base:expr, $n:expr, $a:ident) => {
            for i in 0..$n {
                let mut acc = [0.0f32; Q];
                let mut dif = [0.0f32; Q];
                for j in 0..$n {
                    let a = m0.$a[i][j];
                    let d = m1.$a[i][j] - a;
                    let x = &inp[$base + j][..Q];
                    for k in 0..Q {
                        acc[k] += a * x[k];
                        dif[k] += d * x[k];
                    }
                }
                let o = &mut out[$base + i];
                for k in 0..Q {
                    o[k] = acc[k] + dif[k] * ((k + 1) as f32 * (1.0 / Q as f32));
                }
            }
        };
    }
    block!(1, 3, b1);
    if n_ch >= 9 { block!(4, 5, b2); }
    if n_ch >= 16 { block!(9, 7, b3); }
}
