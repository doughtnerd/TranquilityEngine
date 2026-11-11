// SPDX-License-Identifier: Apache-2.0 OR MIT
//! Ambisonic encoding and rotation (ADR 0162, api-and-models §5.1, architecture §3.5 and §4.2):
//! SN3D/ACN encode of a mono voice at orders 1 to 3 (into a 16-channel bed) and the
//! Ivanic–Ruedenberg rotation of a sound field of order up to 3 (the listener's orientation, a
//! clip's yaw). Myco's own code, not a port; the bed spike (`spikes/audio-spatial/bed/src/sh.rs`)
//! is the reference for the encode and the ramp. The baked 16 to 2 decode matrix is in
//! `bed_matrix.rs` (A3); the binaural decode is in `bed_decoder.rs`.
//!
//! **Conventions (AmbiX).** Channels in ACN order (`acn = l² + l + m`, [`CHANNELS`] = 16 at order 3),
//! SN3D normalisation (no Condon–Shortley phase; W = 1 for every direction), axes x front, y left,
//! z up. The engine's listener space (x right, y up, forward −z) converts with [`engine_to_ambix`]
//! (`(X, Y, Z)_ambix = (−z, −x, +y)_engine`, the LISTENER record's axis map).
//!
//! **Encode** ([`encode_gains`]): the 16 real harmonics of a unit direction are polynomials in its
//! components (no trigonometry), one `sqrt` to normalise. [`encode_ramp_add`] adds a mono quantum
//! into a bed with a per-channel linear coefficient ramp, `bed[c][i] += x[i] · (c0 + (c1 − c0)(i+1)/128)`,
//! so the last frame lands on `c1` (as `ramp::Ramp`); the caller keeps `c1` (gain × gains) for the
//! next quantum's `c0`, so a moving voice never steps at a quantum boundary.
//!
//! **Rotation** ([`ShRotation::from_mat3`]): for a 3×3 rotation `R` (AmbiX axes), the block-diagonal
//! matrix `M` with `Y(R d) = M Y(d)` for every direction `d`, so `M` applied to a field moves a
//! source at `d` to `R d`. Order 1 is `R` with its rows and columns reordered to (y, z, x); orders 2
//! and 3 follow from the order below by the recurrence of J. Ivanic and K. Ruedenberg, "Rotation
//! matrices for real spherical harmonics. Direct determination by recursion", J. Phys. Chem. 100
//! (1996) 6342–6347, with the corrections in J. Phys. Chem. A 102 (1998) 9099–9100 (the form
//! SAF and Politis' `getSHrotMtx` use). Normalisation doesn't enter: SN3D and N3D differ by one
//! factor per order, which a block within one order commutes with. The `u`, `v`, `w` coefficients
//! are compile-time tables ([`coefficient`]). [`rotate_ramp_add`] applies a rotation with a
//! per-sample ramp between two matrices (1 + 9 + 25 + 49 products a frame at order 3).
//!
//! Everything here is f32 except the constant tables; transcendentals (the yaw's sine and cosine)
//! go through `libm`, so native and wasm give bit-identical results. Nothing allocates.

/// Frames per quantum.
pub const QUANTUM: usize = 128;
/// The highest order supported.
pub const MAX_ORDER: usize = 3;
/// Channels of an order-3 field (and of a bed): `(MAX_ORDER + 1)²`.
pub const CHANNELS: usize = 16;

/// A 3×3 rotation, row-major: `v' = R v` with `v'[i] = Σ_j R[i][j] v[j]`.
pub type Mat3 = [[f32; 3]; 3];

/// The identity rotation.
pub const MAT3_IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Channels of a field of `order` (0..=3): `(order + 1)²`. Orders above 3 give 16.
pub const fn channels_for_order(order: usize) -> usize {
    let o = if order > MAX_ORDER { MAX_ORDER } else { order };
    (o + 1) * (o + 1)
}

/// The order (degree `l`) of ACN channel `acn` (0..16).
pub const fn order_of(acn: usize) -> usize {
    if acn == 0 {
        0
    } else if acn < 4 {
        1
    } else if acn < 9 {
        2
    } else {
        3
    }
}

/// An engine listener-space direction (x right, y up, z back) in AmbiX axes (x front, y left, z up).
#[inline]
pub fn engine_to_ambix(d: [f32; 3]) -> [f32; 3] {
    [-d[2], -d[0], d[1]]
}

/// An AmbiX direction in engine listener-space axes (the inverse of [`engine_to_ambix`]).
#[inline]
pub fn ambix_to_engine(d: [f32; 3]) -> [f32; 3] {
    [-d[1], d[2], -d[0]]
}

/// The 16 SN3D real harmonics, ACN order, of the **unit** vector `(x, y, z)` (AmbiX axes):
/// polynomials only. A non-unit vector gives scaled, wrong values; [`encode_gains`] normalises.
#[inline]
pub fn sh_sn3d(x: f32, y: f32, z: f32) -> [f32; CHANNELS] {
    let (xx, yy, zz) = (x * x, y * y, z * z);
    [
        1.0,
        y,
        z,
        x,
        SQRT3 * x * y,
        SQRT3 * y * z,
        0.5 * (3.0 * zz - 1.0),
        SQRT3 * x * z,
        HALF_SQRT3 * (xx - yy),
        C3_3 * y * (3.0 * xx - yy),
        SQRT15 * x * y * z,
        C3_1 * y * (5.0 * zz - 1.0),
        0.5 * z * (5.0 * zz - 3.0),
        C3_1 * x * (5.0 * zz - 1.0),
        HALF_SQRT15 * z * (xx - yy),
        C3_3 * x * (xx - 3.0 * yy),
    ]
}

const SQRT3: f32 = 1.732_050_8; // √3
const HALF_SQRT3: f32 = 0.866_025_4; // √3 / 2
const SQRT15: f32 = 3.872_983_3; // √15
const HALF_SQRT15: f32 = 1.936_491_7; // √15 / 2
const C3_3: f32 = 0.790_569_4; // √(5/8)
const C3_1: f32 = 0.612_372_4; // √(3/8)

/// The SN3D encode gains of direction `dir` (AmbiX axes, any length) at `order` (0..=3; above 3
/// counts as 3): channels `0..channels_for_order(order)` hold the harmonics of `dir / |dir|`, the
/// rest are 0. A zero or non-finite direction (a source at the listener) encodes as W only (omni).
pub fn encode_gains(dir: [f32; 3], order: usize) -> [f32; CHANNELS] {
    let n2 = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
    let mut g = if n2 > 1e-12 && n2.is_finite() {
        let inv = 1.0 / libm::sqrtf(n2);
        sh_sn3d(dir[0] * inv, dir[1] * inv, dir[2] * inv)
    } else {
        let mut w = [0.0; CHANNELS];
        w[0] = 1.0;
        w
    };
    for v in g.iter_mut().skip(channels_for_order(order)) {
        *v = 0.0;
    }
    g
}

/// Adds the mono quantum `x` into `bed` (channel-major) with a linear per-channel coefficient ramp:
/// `bed[c][i] += x[i] · (c0[c] + (c1[c] − c0[c]) · (i + 1) / 128)` for `c < channels` (clamped to 16).
/// `c0` is the coefficient just before frame 0 (the previous quantum's `c1`), `c1` the one frame 127
/// lands on; both are gain × [`encode_gains`]. One pass, two products per channel-frame.
#[inline(never)]
pub fn encode_ramp_add(bed: &mut [[f32; QUANTUM]; CHANNELS], x: &[f32; QUANTUM], c0: &[f32; CHANNELS], c1: &[f32; CHANNELS], channels: usize) {
    let mut v = [0.0f32; QUANTUM];
    for (i, (v, x)) in v.iter_mut().zip(x).enumerate() {
        *v = x * ((i + 1) as f32 * (1.0 / QUANTUM as f32));
    }
    for c in 0..channels.min(CHANNELS) {
        let a = c0[c];
        let s = c1[c] - a;
        for ((o, x), v) in bed[c].iter_mut().zip(x).zip(&v) {
            *o += x * a + v * s;
        }
    }
}

/// `a · b` (apply `b` first, then `a`).
pub fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut r = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    r
}

/// The rotation of the quaternion `q = (x, y, z, w)` given in **engine** axes (`v' = q v q*`, as
/// the LISTENER record's world-to-listener rotation), expressed in **AmbiX** axes: for an engine
/// direction `d`, `result · engine_to_ambix(d) == engine_to_ambix(R_q d)`. `q` is normalised here;
/// `None` if it is zero or not finite (the core then keeps its previous rotation).
pub fn quat_to_ambix(q: [f32; 4]) -> Option<Mat3> {
    let n2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    if !(n2 > 1e-12 && n2.is_finite()) {
        return None;
    }
    let inv = 1.0 / libm::sqrtf(n2);
    let (x, y, z, w) = (q[0] * inv, q[1] * inv, q[2] * inv, q[3] * inv);
    let e = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ];
    // AmbiX axis i is engine axis AXIS[i] times SIGN[i]: A[i][j] = s_i s_j E[k_i][k_j].
    const AXIS: [usize; 3] = [2, 0, 1];
    const SIGN: [f32; 3] = [-1.0, -1.0, 1.0];
    let mut a = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            a[i][j] = SIGN[i] * SIGN[j] * e[AXIS[i]][AXIS[j]];
        }
    }
    Some(a)
}

/// A rotation by `yaw` radians about the vertical axis, in AmbiX axes: positive yaw turns the front
/// (+x) toward the left (+y), counter-clockwise seen from above. A clip's rotation is
/// `mat3_mul(&listener, &yaw_ambix(yaw))` (architecture §3.5: `R = R(q) × Rz(yaw)`).
pub fn yaw_ambix(yaw: f32) -> Mat3 {
    let (s, c) = (libm::sinf(yaw), libm::cosf(yaw));
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

/// The spherical-harmonic rotation of an order-3 field: block-diagonal, one block per order, row
/// and column `m + l` for `m = −l..=l` (ACN order within the order). `Y(R d) = M Y(d)`.
/// `b0` is the order-0 entry: 1 for a pure rotation; [`ShRotation::scaled`] folds a gain into it
/// and the other blocks, so a rotation and a gain ramp run in one pass.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShRotation {
    pub b0: f32,
    pub b1: [[f32; 3]; 3],
    pub b2: [[f32; 5]; 5],
    pub b3: [[f32; 7]; 7],
}

impl ShRotation {
    /// The identity (no rotation, gain 1).
    pub const IDENTITY: ShRotation = {
        let mut r = ShRotation { b0: 1.0, b1: [[0.0; 3]; 3], b2: [[0.0; 5]; 5], b3: [[0.0; 7]; 7] };
        let mut i = 0;
        while i < 7 {
            if i < 3 {
                r.b1[i][i] = 1.0;
            }
            if i < 5 {
                r.b2[i][i] = 1.0;
            }
            r.b3[i][i] = 1.0;
            i += 1;
        }
        r
    };

    /// The rotation of the 3×3 rotation `r` (AmbiX axes; orthonormal, determinant +1, which this
    /// doesn't check) by the Ivanic–Ruedenberg recurrence. About 200 multiply-adds; no
    /// transcendentals.
    pub fn from_mat3(r: &Mat3) -> ShRotation {
        // Order 1: the harmonics are (y, z, x) for m = −1, 0, 1, so R1[m][n] = R[ax(m)][ax(n)].
        const AX: [usize; 3] = [1, 2, 0];
        let mut b1 = [[0.0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                b1[i][j] = r[AX[i]][AX[j]];
            }
        }
        let mut b2 = [[0.0f32; 5]; 5];
        let mut b3 = [[0.0f32; 7]; 7];
        next_order(&b1, b1.as_flattened(), b2.as_flattened_mut(), 2);
        next_order(&b1, b2.as_flattened(), b3.as_flattened_mut(), 3);
        ShRotation { b0: 1.0, b1, b2, b3 }
    }

    /// This rotation with every entry times `g` (a rotation and a gain in one matrix).
    pub fn scaled(&self, g: f32) -> ShRotation {
        let mut s = *self;
        s.b0 *= g;
        s.b1.iter_mut().flatten().for_each(|v| *v *= g);
        s.b2.iter_mut().flatten().for_each(|v| *v *= g);
        s.b3.iter_mut().flatten().for_each(|v| *v *= g);
        s
    }

    /// The dense 16×16 matrix (tests and tools; the process path uses the blocks).
    pub fn dense(&self) -> [[f32; CHANNELS]; CHANNELS] {
        let mut m = [[0.0; CHANNELS]; CHANNELS];
        m[0][0] = self.b0;
        for i in 0..3 {
            for j in 0..3 {
                m[1 + i][1 + j] = self.b1[i][j];
            }
        }
        for i in 0..5 {
            for j in 0..5 {
                m[4 + i][4 + j] = self.b2[i][j];
            }
        }
        for i in 0..7 {
            for j in 0..7 {
                m[9 + i][9 + j] = self.b3[i][j];
            }
        }
        m
    }

    /// `M · v` for a 16-vector of harmonics (or gains).
    pub fn apply(&self, v: &[f32; CHANNELS]) -> [f32; CHANNELS] {
        let mut o = [0.0; CHANNELS];
        o[0] = self.b0 * v[0];
        for i in 0..3 {
            o[1 + i] = (0..3).map(|j| self.b1[i][j] * v[1 + j]).sum();
        }
        for i in 0..5 {
            o[4 + i] = (0..5).map(|j| self.b2[i][j] * v[4 + j]).sum();
        }
        for i in 0..7 {
            o[9 + i] = (0..7).map(|j| self.b3[i][j] * v[9 + j]).sum();
        }
        o
    }
}

impl Default for ShRotation {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// The recurrence's `(u, v, w)` for order `l` at `(m, n)` (Ivanic & Ruedenberg 1996, Table 1, as
/// corrected in 1998), with `d = δ(m, 0)`:
/// - denominator `(l + n)(l − n)` if `|n| < l`, else `2l (2l − 1)`;
/// - `u = √((l + m)(l − m) / den)`;
/// - `v = ½ √((1 + d)(l + |m| − 1)(l + |m|) / den) · (1 − 2d)`;
/// - `w = −½ √((l − |m| − 1)(l − |m|) / den) · (1 − d)`.
///
/// `const`, so the tables [`COEF2`] and [`COEF3`] are baked at compile time.
pub const fn coefficient(l: i32, m: i32, n: i32) -> [f32; 3] {
    let d = if m == 0 { 1.0 } else { 0.0 };
    let am = if m < 0 { -m } else { m };
    let an = if n < 0 { -n } else { n };
    let den = if an < l { ((l + n) * (l - n)) as f64 } else { (2 * l * (2 * l - 1)) as f64 };
    let u = const_sqrt(((l + m) * (l - m)) as f64 / den);
    let v = 0.5 * const_sqrt((1.0 + d) * ((l + am - 1) * (l + am)) as f64 / den) * (1.0 - 2.0 * d);
    let wp = (l - am - 1) * (l - am);
    let w = if wp > 0 { -0.5 * const_sqrt(wp as f64 / den) * (1.0 - d) } else { 0.0 };
    [u as f32, v as f32, w as f32]
}

/// [`coefficient`] at run time in f32 (`libm::sqrtf` of the exact integer ratios): within an ulp or
/// two of the baked tables, and no table in the binary.
fn coefficient_f32(l: i32, m: i32, n: i32) -> [f32; 3] {
    let (am, an) = (m.abs(), n.abs());
    let d = (m == 0) as i32;
    let den = if an < l { (l + n) * (l - n) } else { 2 * l * (2 * l - 1) } as f32;
    let root = |x: i32| libm::sqrtf(x as f32 / den);
    let u = root((l + m) * (l - m));
    let v = 0.5 * root((1 + d) * (l + am - 1) * (l + am)) * (1 - 2 * d) as f32;
    let w = -0.5 * root(((l - am - 1) * (l - am)).max(0)) * (1 - d) as f32;
    [u, v, w]
}

/// `√x` for `x ≥ 0` by Newton's iteration in f64 (for the compile-time tables only).
const fn const_sqrt(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut g = if x > 1.0 { x } else { 1.0 };
    let mut i = 0;
    while i < 64 {
        g = 0.5 * (g + x / g);
        i += 1;
    }
    g
}

const fn table<const N: usize>() -> [[[f32; 3]; N]; N] {
    let l = ((N - 1) / 2) as i32;
    let mut t = [[[0.0f32; 3]; N]; N];
    let mut i = 0;
    while i < N {
        let mut j = 0;
        while j < N {
            t[i][j] = coefficient(l, i as i32 - l, j as i32 - l);
            j += 1;
        }
        i += 1;
    }
    t
}

/// `(u, v, w)` for order 2, indexed `[m + 2][n + 2]`.
pub const COEF2: [[[f32; 3]; 5]; 5] = table::<5>();
/// `(u, v, w)` for order 3, indexed `[m + 3][n + 3]`.
pub const COEF3: [[[f32; 3]; 7]; 7] = table::<7>();

/// One step of the recurrence: the order-`l` block (`N = 2l + 1`) from order 1 (`r1`) and order
/// `l − 1` (`prev`, `NP = 2l − 1`). `R^l[m][n] = u·U + v·V + w·W`, terms with a zero coefficient
/// skipped (they would index outside `prev`). With `P(i, a, b)` (i ∈ {−1, 0, 1}, `R1[i][·]` the
/// order-1 block, `Rp` the previous block, indices relative to the centre):
/// - `P(i, a, b) = R1[i][1]·Rp[a][l−1] − R1[i][−1]·Rp[a][−l+1]` if `b = l`;
/// - `R1[i][1]·Rp[a][−l+1] + R1[i][−1]·Rp[a][l−1]` if `b = −l`; else `R1[i][0]·Rp[a][b]`;
/// - `U = P(0, m, n)`;
/// - `V = P(1, 1, n) + P(−1, −1, n)` if `m = 0`;
///   `P(1, m−1, n)·√(1 + δ(m,1)) − P(−1, −m+1, n)·(1 − δ(m,1))` if `m > 0`;
///   `P(1, m+1, n)·(1 − δ(m,−1)) + P(−1, −m−1, n)·√(1 + δ(m,−1))` if `m < 0`;
/// - `W = P(1, m+1, n) + P(−1, −m−1, n)` if `m > 0`; `P(1, m−1, n) − P(−1, −m+1, n)` if `m < 0`.
///
/// The blocks are row-major slices (`prev` `(2l − 1)²`, `out` `(2l + 1)²`), so one copy serves
/// both orders, and `(u, v, w)` come from [`coefficient_f32`] rather than [`COEF2`] / [`COEF3`] (the
/// mixer's size budget; ADR 0162 B3).
#[inline(never)]
fn next_order(r1: &[[f32; 3]; 3], prev: &[f32], out: &mut [f32], l: i32) {
    let (dim, np) = ((2 * l + 1) as usize, (2 * l - 1) as usize);
    let r1 = |i: i32, j: i32| r1[(i + 1) as usize][(j + 1) as usize];
    let rp = |a: i32, b: i32| prev[(a + l - 1) as usize * np + (b + l - 1) as usize];
    let p = |i: i32, a: i32, b: i32| -> f32 {
        if b == l {
            r1(i, 1) * rp(a, l - 1) - r1(i, -1) * rp(a, -l + 1)
        } else if b == -l {
            r1(i, 1) * rp(a, -l + 1) + r1(i, -1) * rp(a, l - 1)
        } else {
            r1(i, 0) * rp(a, b)
        }
    };
    for m in -l..=l {
        for n in -l..=l {
            let [u, v, w] = coefficient_f32(l, m, n);
            let mut acc = 0.0f32;
            if u != 0.0 {
                acc += u * p(0, m, n);
            }
            if v != 0.0 {
                let vv = if m == 0 {
                    p(1, 1, n) + p(-1, -1, n)
                } else if m > 0 {
                    if m == 1 {
                        p(1, 0, n) * core::f32::consts::SQRT_2
                    } else {
                        p(1, m - 1, n) - p(-1, -m + 1, n)
                    }
                } else if m == -1 {
                    p(-1, 0, n) * core::f32::consts::SQRT_2
                } else {
                    p(1, m + 1, n) + p(-1, -m - 1, n)
                };
                acc += v * vv;
            }
            if w != 0.0 {
                let ww = if m > 0 { p(1, m + 1, n) + p(-1, -m - 1, n) } else { p(1, m - 1, n) - p(-1, -m + 1, n) };
                acc += w * ww;
            }
            out[(m + l) as usize * dim + (n + l) as usize] = acc;
        }
    }
}

/// Adds `M(t) · input` into `out` for the first `channels` channels (4, 9 or 16; others round down
/// to the order below, at least 1), with `M(t)` ramped per sample from `m0` (just before frame 0)
/// to `m1` (frame 127): frame `i` uses `m0 + (m1 − m0)(i + 1)/128`. Block-diagonal, run as one
/// [`encode_ramp_add`] per input channel over the rows up to its block's end (1 + 12 + 45 + 112 row
/// passes at order 3, against the 84 a dedicated kernel needs: a smaller binary for ≈ 2× the work).
/// Fold a gain ramp in with [`ShRotation::scaled`].
pub fn rotate_ramp_add(input: &[[f32; QUANTUM]; CHANNELS], out: &mut [[f32; QUANTUM]; CHANNELS], channels: usize, m0: &ShRotation, m1: &ShRotation) {
    let blocks: [(usize, usize, &[f32], &[f32]); 4] = [
        (0, 1, core::slice::from_ref(&m0.b0), core::slice::from_ref(&m1.b0)),
        (1, 3, m0.b1.as_flattened(), m1.b1.as_flattened()),
        (4, 5, m0.b2.as_flattened(), m1.b2.as_flattened()),
        (9, 7, m0.b3.as_flattened(), m1.b3.as_flattened()),
    ];
    for (base, n, a, b) in blocks {
        if base + n > channels.max(1) {
            break;
        }
        rotate_block(input, out, base, n, a, b);
    }
}

/// One order's block of [`rotate_ramp_add`] (rows and columns `base..base + n`, `a` and `b` row-major):
/// input channel `base + j` feeds the block's rows with column `j` of each matrix through the
/// per-channel ramp of [`encode_ramp_add`] (one kernel for encode and rotation, ADR 0162 B3's size
/// budget; rows below the block take coefficient 0).
#[inline(never)]
fn rotate_block(input: &[[f32; QUANTUM]; CHANNELS], out: &mut [[f32; QUANTUM]; CHANNELS], base: usize, n: usize, a: &[f32], b: &[f32]) {
    for j in 0..n {
        let (mut c0, mut c1) = ([0.0f32; CHANNELS], [0.0f32; CHANNELS]);
        for i in 0..n {
            c0[base + i] = a[i * n + j];
            c1[base + i] = b[i * n + j];
        }
        encode_ramp_add(out, &input[base + j], &c0, &c1, base + n);
    }
}

#[cfg(test)]
mod tests {
    //! The §9 unit rows: "SN3D encode against analytic harmonics (64 directions per order)" and
    //! "Ivanic rotation equals rotating the direction then encoding (1e-5)".
    use super::*;

    const TOL: f64 = 1e-5;

    /// 64 directions spread over the sphere (a Fibonacci lattice), plus exact poles and axes mixed
    /// in, as unit f64 vectors (AmbiX).
    fn directions() -> Vec<[f64; 3]> {
        let n = 64;
        let ga = core::f64::consts::PI * (3.0 - 5f64.sqrt());
        let mut v: Vec<[f64; 3]> = (0..n)
            .map(|i| {
                let z = 1.0 - 2.0 * (i as f64 + 0.5) / n as f64;
                let r = (1.0 - z * z).sqrt();
                [r * (ga * i as f64).cos(), r * (ga * i as f64).sin(), z]
            })
            .collect();
        v[0] = [0.0, 0.0, 1.0];
        v[1] = [0.0, 0.0, -1.0];
        v[2] = [1.0, 0.0, 0.0];
        v[3] = [0.0, 1.0, 0.0];
        v
    }

    /// Associated Legendre `P_l^m(x)` without the Condon–Shortley phase, by the standard recurrence.
    fn legendre(l: usize, m: usize, x: f64) -> f64 {
        let s = (1.0 - x * x).max(0.0).sqrt();
        let mut pmm = 1.0;
        for k in 0..m {
            pmm *= (2 * k + 1) as f64 * s;
        }
        if l == m {
            return pmm;
        }
        let mut pm1 = x * (2 * m + 1) as f64 * pmm;
        if l == m + 1 {
            return pm1;
        }
        let mut pl = 0.0;
        for ll in (m + 2)..=l {
            pl = ((2 * ll - 1) as f64 * x * pm1 - (ll + m - 1) as f64 * pmm) / (ll - m) as f64;
            pmm = pm1;
            pm1 = pl;
        }
        pl
    }

    fn factorial(n: usize) -> f64 {
        (1..=n).map(|k| k as f64).product()
    }

    /// The analytic SN3D harmonic `Y_l^m(azimuth, elevation)` (AmbiX: azimuth from +x toward +y,
    /// elevation from the horizontal plane toward +z).
    fn analytic(l: usize, m: i32, d: [f64; 3]) -> f64 {
        let az = d[1].atan2(d[0]);
        let el = d[2].clamp(-1.0, 1.0).asin();
        let am = m.unsigned_abs() as usize;
        let norm = ((if m == 0 { 1.0 } else { 2.0 }) * factorial(l - am) / factorial(l + am)).sqrt();
        let trig = if m >= 0 { (am as f64 * az).cos() } else { (am as f64 * az).sin() };
        norm * legendre(l, am, el.sin()) * trig
    }

    fn f32v(d: [f64; 3]) -> [f32; 3] {
        [d[0] as f32, d[1] as f32, d[2] as f32]
    }

    #[test]
    fn run_time_coefficients_match_the_tables() {
        for (l, n) in [(2i32, 5usize), (3, 7)] {
            for i in 0..n {
                for j in 0..n {
                    let (m, k) = (i as i32 - l, j as i32 - l);
                    let t = if l == 2 { COEF2[i][j] } else { COEF3[i][j] };
                    let r = coefficient_f32(l, m, k);
                    for c in 0..3 {
                        assert!((t[c] - r[c]).abs() <= 1e-6, "l {l} m {m} n {k}: {t:?} {r:?}");
                        assert_eq!(t[c] == 0.0, r[c] == 0.0);
                    }
                }
            }
        }
    }

    #[test]
    fn encode_matches_the_analytic_harmonics_at_64_directions_per_order() {
        let dirs = directions();
        assert_eq!(dirs.len(), 64);
        for order in 1..=MAX_ORDER {
            let mut worst = 0.0f64;
            for d in &dirs {
                let g = encode_gains(f32v(*d), order);
                for l in 0..=order {
                    for m in -(l as i32)..=(l as i32) {
                        let acn = (l * l) as i32 + l as i32 + m;
                        worst = worst.max((g[acn as usize] as f64 - analytic(l, m, *d)).abs());
                    }
                }
                for (c, &v) in g.iter().enumerate().skip(channels_for_order(order)) {
                    assert_eq!(v, 0.0, "order {order} channel {c} must be silent");
                }
            }
            assert!(worst < TOL, "order {order}: worst error {worst:e}");
        }
    }

    #[test]
    fn encode_normalises_and_handles_the_listener_position() {
        let a = encode_gains([3.0, -4.0, 12.0], 3);
        let b = encode_gains([3.0 / 13.0, -4.0 / 13.0, 12.0 / 13.0], 3);
        for (x, y) in a.iter().zip(&b) {
            assert!((x - y).abs() < 1e-6);
        }
        let w = encode_gains([0.0; 3], 3);
        assert_eq!(w[0], 1.0);
        assert!(w[1..].iter().all(|&v| v == 0.0));
        let nan = encode_gains([f32::NAN, 0.0, 1.0], 2);
        assert_eq!(nan[0], 1.0);
        assert!(nan[1..].iter().all(|&v| v == 0.0));
        // SN3D: each order's energy is 1 for every direction.
        for d in directions() {
            let g = encode_gains(f32v(d), 3);
            for l in 0..=3 {
                let e: f32 = (l * l..(l + 1) * (l + 1)).map(|c| g[c] * g[c]).sum();
                assert!((e - 1.0).abs() < 1e-5, "order {l} energy {e}");
            }
        }
    }

    /// Rotations to test: the identity, the axes' quarter turns, and a spread of yaw/pitch/roll.
    fn rotations() -> Vec<Mat3> {
        let mut v = vec![MAT3_IDENTITY, yaw_ambix(core::f32::consts::FRAC_PI_2)];
        let rx = |a: f32| -> Mat3 { [[1.0, 0.0, 0.0], [0.0, a.cos(), -a.sin()], [0.0, a.sin(), a.cos()]] };
        let ry = |a: f32| -> Mat3 { [[a.cos(), 0.0, a.sin()], [0.0, 1.0, 0.0], [-a.sin(), 0.0, a.cos()]] };
        v.push(rx(core::f32::consts::FRAC_PI_2));
        v.push(ry(core::f32::consts::FRAC_PI_2));
        v.push(ry(core::f32::consts::PI));
        let mut s = 0x1234_5678u32;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s as f32 / u32::MAX as f32) * 2.0 * core::f32::consts::PI - core::f32::consts::PI
        };
        for _ in 0..16 {
            let (a, b, c) = (rnd(), rnd(), rnd());
            v.push(mat3_mul(&yaw_ambix(a), &mat3_mul(&ry(b), &rx(c))));
        }
        v
    }

    fn rotate(r: &Mat3, d: [f64; 3]) -> [f64; 3] {
        let mut o = [0.0; 3];
        for i in 0..3 {
            o[i] = (0..3).map(|j| r[i][j] as f64 * d[j]).sum();
        }
        o
    }

    #[test]
    fn rotation_equals_rotating_the_direction_then_encoding() {
        for r in rotations() {
            let m = ShRotation::from_mat3(&r);
            for order in 1..=MAX_ORDER {
                let n = channels_for_order(order);
                let mut worst = 0.0f64;
                for d in directions() {
                    let got = m.apply(&encode_gains(f32v(d), order));
                    let want = encode_gains(f32v(rotate(&r, d)), order);
                    for c in 0..n {
                        worst = worst.max((got[c] - want[c]).abs() as f64);
                    }
                }
                assert!(worst < TOL, "order {order}: worst error {worst:e} for {r:?}");
            }
        }
    }

    #[test]
    fn rotation_blocks_are_orthogonal_and_compose() {
        let rs = rotations();
        for (k, r) in rs.iter().enumerate() {
            let m = ShRotation::from_mat3(r).dense();
            for i in 0..16 {
                for j in 0..16 {
                    let dot: f32 = (0..16).map(|c| m[i][c] * m[j][c]).sum();
                    let want = if i == j { 1.0 } else { 0.0 };
                    assert!((dot - want).abs() < 1e-5, "M Mᵀ [{i}][{j}] = {dot}");
                }
            }
            let s = &rs[(k + 3) % rs.len()];
            let ab = ShRotation::from_mat3(&mat3_mul(r, s)).dense();
            let (a, b) = (ShRotation::from_mat3(r).dense(), ShRotation::from_mat3(s).dense());
            for i in 0..16 {
                for j in 0..16 {
                    let p: f32 = (0..16).map(|c| a[i][c] * b[c][j]).sum();
                    assert!((p - ab[i][j]).abs() < 1e-5);
                }
            }
        }
        assert_eq!(ShRotation::from_mat3(&MAT3_IDENTITY), ShRotation::IDENTITY);
    }

    #[test]
    fn quaternion_rotation_in_ambix_axes_matches_the_engine_rotation() {
        // A quarter turn about the engine's +y (up), counter-clockwise from above: forward (−z)
        // goes to left (−x), i.e. AmbiX front to AmbiX left.
        let h = core::f32::consts::FRAC_1_SQRT_2;
        let a = quat_to_ambix([0.0, h, 0.0, h]).unwrap();
        let left = mat3_mul(&a, &MAT3_IDENTITY);
        let front = [1.0f64, 0.0, 0.0];
        let moved = rotate(&left, front);
        assert!((moved[0]).abs() < 1e-6 && (moved[1] - 1.0).abs() < 1e-6 && moved[2].abs() < 1e-6, "{moved:?}");
        let y = yaw_ambix(core::f32::consts::FRAC_PI_2);
        for i in 0..3 {
            for j in 0..3 {
                assert!((a[i][j] - y[i][j]).abs() < 1e-6);
            }
        }
        // A general quaternion: A · ambix(d) == ambix(q d q*).
        let q = [0.3f32, -0.5, 0.2, 0.78];
        let a = quat_to_ambix(q).unwrap();
        let n = (q.iter().map(|v| v * v).sum::<f32>()).sqrt();
        let (x, yq, z, w) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
        let rot = |v: [f32; 3]| -> [f32; 3] {
            // v' = v + 2w (u × v) + 2 u × (u × v), u = (x, y, z)
            let u = [x, yq, z];
            let cr = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
            let t = cr(u, v);
            let t2 = cr(u, t);
            [v[0] + 2.0 * w * t[0] + 2.0 * t2[0], v[1] + 2.0 * w * t[1] + 2.0 * t2[1], v[2] + 2.0 * w * t[2] + 2.0 * t2[2]]
        };
        for d in directions() {
            let e = ambix_to_engine(f32v(d));
            let want = engine_to_ambix(rot(e));
            let got = rotate(&a, d);
            for i in 0..3 {
                assert!((got[i] - want[i] as f64).abs() < 1e-5);
            }
        }
        assert!(quat_to_ambix([0.0; 4]).is_none());
        assert!(quat_to_ambix([f32::NAN, 0.0, 0.0, 1.0]).is_none());
    }

    #[test]
    fn engine_axis_map_round_trips() {
        assert_eq!(engine_to_ambix([0.0, 0.0, -1.0]), [1.0, 0.0, 0.0]); // forward is front
        assert_eq!(engine_to_ambix([-1.0, 0.0, 0.0]), [0.0, 1.0, 0.0]); // left is left
        assert_eq!(engine_to_ambix([0.0, 1.0, 0.0]), [0.0, 0.0, 1.0]); // up is up
        for d in directions() {
            let v = f32v(d);
            assert_eq!(engine_to_ambix(ambix_to_engine(v)), v);
        }
    }

    fn noise_bed(seed: u32) -> [[f32; QUANTUM]; CHANNELS] {
        let mut s = seed | 1;
        let mut b = [[0.0; QUANTUM]; CHANNELS];
        for v in b.iter_mut().flatten() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            *v = (s as f32 / u32::MAX as f32) * 2.0 - 1.0;
        }
        b
    }

    #[test]
    fn ramped_rotation_lands_on_the_target_and_matches_the_matrix() {
        let x = noise_bed(7);
        let m0 = ShRotation::from_mat3(&yaw_ambix(0.3));
        let m1 = ShRotation::from_mat3(&mat3_mul(&yaw_ambix(0.5), &[[1.0, 0.0, 0.0], [0.0, 0.8, -0.6], [0.0, 0.6, 0.8]]));
        let mut out = [[0.0; QUANTUM]; CHANNELS];
        rotate_ramp_add(&x, &mut out, 16, &m0, &m1);
        let d1 = m1.dense();
        let d0 = m0.dense();
        for i in [0usize, 63, 127] {
            let t = (i + 1) as f32 / 128.0;
            for c in 0..16 {
                let want: f32 = (0..16).map(|j| (d0[c][j] + (d1[c][j] - d0[c][j]) * t) * x[j][i]).sum();
                assert!((out[c][i] - want).abs() < 1e-5, "frame {i} ch {c}");
            }
        }
        // A scaled rotation is the rotation times the gain.
        let mut g = [[0.0; QUANTUM]; CHANNELS];
        rotate_ramp_add(&x, &mut g, 16, &m1.scaled(0.5), &m1.scaled(0.5));
        let mut one = [[0.0; QUANTUM]; CHANNELS];
        rotate_ramp_add(&x, &mut one, 16, &m1, &m1);
        for (a, b) in g.iter().flatten().zip(one.iter().flatten()) {
            assert!((a - 0.5 * b).abs() < 1e-6);
        }
        // First order touches channels 0..4 only, and equals the full rotation's first four.
        let mut foa = [[0.0; QUANTUM]; CHANNELS];
        rotate_ramp_add(&x, &mut foa, 4, &m1, &m1);
        assert!(foa[4..].iter().flatten().all(|&v| v == 0.0));
        assert_eq!(foa[..4], one[..4]);
    }

    #[test]
    fn a_quarter_yaw_turns_a_front_source_into_a_left_source() {
        let m = ShRotation::from_mat3(&yaw_ambix(core::f32::consts::FRAC_PI_2));
        let got = m.apply(&encode_gains([1.0, 0.0, 0.0], 3));
        let want = encode_gains([0.0, 1.0, 0.0], 3);
        for c in 0..16 {
            assert!((got[c] - want[c]).abs() < 1e-6, "ch {c}: {} vs {}", got[c], want[c]);
        }
    }

    #[test]
    fn encode_ramp_lands_on_c1_and_starts_from_c0() {
        let x = [1.0f32; QUANTUM];
        let c0 = encode_gains([1.0, 0.0, 0.0], 3);
        let c1 = encode_gains([0.0, 1.0, 0.0], 3).map(|v| v * 0.5);
        let mut bed = [[0.0; QUANTUM]; CHANNELS];
        encode_ramp_add(&mut bed, &x, &c0, &c1, 16);
        for c in 0..16 {
            assert!((bed[c][127] - c1[c]).abs() < 1e-6);
            let first = c0[c] + (c1[c] - c0[c]) / 128.0;
            assert!((bed[c][0] - first).abs() < 1e-6);
        }
        let mut foa = [[0.0; QUANTUM]; CHANNELS];
        encode_ramp_add(&mut foa, &x, &c0, &c1, 4);
        assert!(foa[4..].iter().flatten().all(|&v| v == 0.0));
    }

    #[test]
    fn coefficient_tables_match_the_paper_at_spot_values() {
        // l = 2, m = 0, n = 0: den = 4; u = √(2·2/4) = 1; v = ½√(2·1·2/4)·(−1) = −0.5; w = 0 (1 − d = 0).
        let [u, v, w] = coefficient(2, 0, 0);
        assert!((u - 1.0).abs() < 1e-7);
        assert!((v + 0.5).abs() < 1e-7);
        assert_eq!(w, 0.0);
        // l = 3, m = 3, n = 3: den = 6·5 = 30; u = 0; v = ½√(1·5·6/30) = 0.5; w = 0.
        let [u, v, w] = coefficient(3, 3, 3);
        assert_eq!(u, 0.0);
        assert!((v - 0.5).abs() < 1e-7);
        assert_eq!(w, 0.0);
        // l = 3, m = 1, n = 0: den = 9; u = √(8/9); v = ½√(3·4/9); w = −½√(1·2/9).
        let [u, v, w] = coefficient(3, 1, 0);
        assert!((u - (8.0f32 / 9.0).sqrt()).abs() < 1e-7);
        assert!((v - 0.5 * (12.0f32 / 9.0).sqrt()).abs() < 1e-7);
        assert!((w + 0.5 * (2.0f32 / 9.0).sqrt()).abs() < 1e-7);
    }
}
