//! Reference area `math`: f64 scalar vectors, quaternions and transforms, the reference for
//! `anim-math`'s SoA SIMD maths.
//!
//! Plain structs and the textbook formulas, written for clarity, not speed, and where possible by
//! a different route than `anim-math` (rotation as `q·v·q*`, matrices from rotated basis vectors,
//! slerp through `acos`, libm trigonometry), so a shared mistake is unlikely.
//!
//! Conventions match `anim-math`: quaternions are `(x, y, z, w)`, Hamilton product, `a * b`
//! applies `b` first; a transform maps `p` to `r·(s ⊙ p) + t`; `parent.compose(child)` applies
//! `child` first; matrices are row-major 3×4 (`m[4·row + col]`, column 3 the translation).

use std::ops::{Add, Mul, Neg, Sub};

/// A 3-vector.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);
    pub const ONE: Vec3 = Vec3::new(1.0, 1.0, 1.0);
    pub const X: Vec3 = Vec3::new(1.0, 0.0, 0.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn scale(self, s: f64) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }

    pub fn dot(self, o: Self) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    /// The unit vector, or `fallback` when the length is at most `1e-12`.
    pub fn normalize_or(self, fallback: Self) -> Self {
        let len = self.length();
        if len > 1e-12 {
            self.scale(1.0 / len)
        } else {
            fallback
        }
    }

    pub fn lerp(self, o: Self, t: f64) -> Self {
        self + (o - self).scale(t)
    }
}

impl Add for Vec3 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for Vec3 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
/// Component-wise product.
impl Mul for Vec3 {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        Self::new(self.x * o.x, self.y * o.y, self.z * o.z)
    }
}
impl Neg for Vec3 {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }
}

/// A quaternion `(x, y, z, w)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quat {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl Quat {
    pub const IDENTITY: Quat = Quat::new(0.0, 0.0, 0.0, 1.0);

    pub const fn new(x: f64, y: f64, z: f64, w: f64) -> Self {
        Self { x, y, z, w }
    }

    pub fn dot(self, o: Self) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z + self.w * o.w
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn conjugate(self) -> Self {
        Self::new(-self.x, -self.y, -self.z, self.w)
    }

    pub fn scale(self, s: f64) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s, self.w * s)
    }

    /// The unit quaternion, or identity when the length is at most `1e-12`.
    pub fn normalize_or_identity(self) -> Self {
        let len = self.length();
        if len > 1e-12 {
            self.scale(1.0 / len)
        } else {
            Self::IDENTITY
        }
    }

    /// Normalised lerp on the shortest path.
    pub fn nlerp(self, b: Self, t: f64) -> Self {
        let b = if self.dot(b) < 0.0 { -b } else { b };
        (self.scale(1.0 - t) + b.scale(t)).normalize_or_identity()
    }

    /// Slerp on the shortest path, through `acos`.
    pub fn slerp(self, b: Self, t: f64) -> Self {
        let mut d = self.dot(b);
        let b = if d < 0.0 {
            d = -d;
            -b
        } else {
            b
        };
        let theta = d.min(1.0).acos();
        let s = theta.sin();
        if s < 1e-12 {
            return self.scale(1.0 - t) + b.scale(t);
        }
        self.scale(((1.0 - t) * theta).sin() / s) + b.scale((t * theta).sin() / s)
    }

    /// Rotates `v` as `q · (v, 0) · q*`.
    pub fn rotate(self, v: Vec3) -> Vec3 {
        let p = self * Quat::new(v.x, v.y, v.z, 0.0) * self.conjugate();
        Vec3::new(p.x, p.y, p.z)
    }

    /// Rotation of `angle` radians about the unit `axis`.
    pub fn from_axis_angle(axis: Vec3, angle: f64) -> Self {
        let (s, c) = (angle * 0.5).sin_cos();
        Self::new(axis.x * s, axis.y * s, axis.z * s, c)
    }

    /// Unit axis and angle in [0, π]; `+X` and 0 for identity.
    pub fn to_axis_angle(self) -> (Vec3, f64) {
        let q = if self.w < 0.0 { -self } else { self };
        let v = Vec3::new(q.x, q.y, q.z);
        let angle = 2.0 * v.length().atan2(q.w);
        (v.normalize_or(Vec3::X), angle)
    }
}

impl Mul for Quat {
    type Output = Self;
    fn mul(self, b: Self) -> Self {
        // (s1, v1)(s2, v2) = (s1 s2 − v1·v2, s1 v2 + s2 v1 + v1 × v2)
        let a = self;
        let (va, vb) = (Vec3::new(a.x, a.y, a.z), Vec3::new(b.x, b.y, b.z));
        let v = vb.scale(a.w) + va.scale(b.w) + va.cross(vb);
        Self::new(v.x, v.y, v.z, a.w * b.w - va.dot(vb))
    }
}
impl Add for Quat {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z, self.w + o.w)
    }
}
impl Neg for Quat {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z, -self.w)
    }
}

/// Translation, rotation, scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub translation: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}

impl Transform {
    pub const IDENTITY: Transform = Transform {
        translation: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::ONE,
    };

    pub fn transform_point(self, p: Vec3) -> Vec3 {
        self.rotation.rotate(self.scale * p) + self.translation
    }

    pub fn transform_vector(self, v: Vec3) -> Vec3 {
        self.rotation.rotate(self.scale * v)
    }

    /// `self ∘ child` in TRS algebra (scales multiply component-wise, no shear).
    pub fn compose(self, child: Self) -> Self {
        Self {
            translation: self.transform_point(child.translation),
            rotation: self.rotation * child.rotation,
            scale: self.scale * child.scale,
        }
    }

    /// TRS inverse: `r*`, `1/s` (0 where |s| ≤ 1e-8), `−r*·(t / s)`. Exact for uniform scale.
    pub fn inverse(self) -> Self {
        let rcp = |s: f64| if s.abs() > 1e-8 { 1.0 / s } else { 0.0 };
        let inv_s = Vec3::new(rcp(self.scale.x), rcp(self.scale.y), rcp(self.scale.z));
        let inv_r = self.rotation.conjugate();
        Self {
            translation: -inv_r.rotate(inv_s * self.translation),
            rotation: inv_r,
            scale: inv_s,
        }
    }
}

/// Row-major affine 3×4 matrix (`m[4·row + col]`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat3x4 {
    pub m: [f64; 12],
}

impl Mat3x4 {
    pub const IDENTITY: Mat3x4 = Mat3x4 {
        m: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    };

    /// Columns are the images of the basis vectors, the translation column is `t`.
    pub fn from_transform(t: Transform) -> Self {
        let c0 = t.transform_vector(Vec3::new(1.0, 0.0, 0.0));
        let c1 = t.transform_vector(Vec3::new(0.0, 1.0, 0.0));
        let c2 = t.transform_vector(Vec3::new(0.0, 0.0, 1.0));
        let p = t.translation;
        Self {
            m: [
                c0.x, c1.x, c2.x, p.x, c0.y, c1.y, c2.y, p.y, c0.z, c1.z, c2.z, p.z,
            ],
        }
    }

    pub fn transform_point(self, p: Vec3) -> Vec3 {
        let r = |i: usize| {
            self.m[4 * i] * p.x
                + self.m[4 * i + 1] * p.y
                + self.m[4 * i + 2] * p.z
                + self.m[4 * i + 3]
        };
        Vec3::new(r(0), r(1), r(2))
    }

    // Index loops read as the textbook elimination; clarity over iterator style here.
    #[allow(clippy::needless_range_loop)]
    /// The affine inverse by Gauss-Jordan elimination with partial pivoting, or `None` when
    /// singular (|det| ≤ 1e-24).
    pub fn inverse(self) -> Option<Self> {
        let mut a = [[0.0; 6]; 3];
        for (r, row) in a.iter_mut().enumerate() {
            for c in 0..3 {
                row[c] = self.m[4 * r + c];
            }
            row[3 + r] = 1.0;
        }
        let mut det = 1.0;
        for col in 0..3 {
            let pivot = (col..3)
                .max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))
                .unwrap();
            if pivot != col {
                a.swap(pivot, col);
                det = -det;
            }
            let p = a[col][col];
            det *= p;
            if p == 0.0 {
                return None;
            }
            for v in a[col].iter_mut() {
                *v /= p;
            }
            for r in 0..3 {
                if r != col {
                    let f = a[r][col];
                    for c in 0..6 {
                        a[r][c] -= f * a[col][c];
                    }
                }
            }
        }
        if det.abs() <= 1e-24 {
            return None;
        }
        let t = Vec3::new(self.m[3], self.m[7], self.m[11]);
        let mut m = [0.0; 12];
        for r in 0..3 {
            for c in 0..3 {
                m[4 * r + c] = a[r][3 + c];
            }
            m[4 * r + 3] = -(a[r][3] * t.x + a[r][4] * t.y + a[r][5] * t.z);
        }
        Some(Self { m })
    }
}

/// `a * b` (applies `b` first).
impl Mul for Mat3x4 {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        let mut m = [0.0; 12];
        for r in 0..3 {
            for c in 0..4 {
                let mut v = if c == 3 { self.m[4 * r + 3] } else { 0.0 };
                for k in 0..3 {
                    v += self.m[4 * r + k] * o.m[4 * k + c];
                }
                m[4 * r + c] = v;
            }
        }
        Self { m }
    }
}

/// Root marker in a parent array.
pub const NO_PARENT: u16 = u16::MAX;

/// `model[i] = model[parent] ∘ local[i]`; parents come before children.
pub fn local_to_model(parents: &[u16], local: &[Transform]) -> Vec<Transform> {
    let mut model: Vec<Transform> = Vec::with_capacity(local.len());
    for (i, &p) in parents.iter().enumerate() {
        let m = if p == NO_PARENT {
            local[i]
        } else {
            model[p as usize].compose(local[i])
        };
        model.push(m);
    }
    model
}

/// Largest code of an N-bit unorm.
pub fn unorm_max(bits: u32) -> f64 {
    ((1u64 << bits) - 1) as f64
}

/// Packs a value in [0, 1] (clamped, NaN → 0) into N bits, rounding half up.
pub fn pack_unorm(norm: f64, bits: u32) -> u32 {
    let x = if norm > 0.0 { norm.min(1.0) } else { 0.0 };
    (x * unorm_max(bits) + 0.5).floor() as u32
}

/// Unpacks an N-bit code to [0, 1].
pub fn unpack_unorm(code: u32, bits: u32) -> f64 {
    code as f64 / unorm_max(bits)
}

/// Unpacks an N-bit code into `[min, min + extent]`.
pub fn unpack_range(code: u32, bits: u32, min: f64, extent: f64) -> f64 {
    min + unpack_unorm(code, bits) * extent
}
