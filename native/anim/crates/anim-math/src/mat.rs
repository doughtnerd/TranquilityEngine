//! [`Mat3x4T`]: an affine 3×4 matrix over a [`Lane`] — the bone-matrix output format.
//!
//! # Layout
//!
//! Twelve floats, **row-major, three rows of four**: `[m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz]`.
//! The 3×3 block's columns are the transformed basis vectors (column vectors: `p' = M·[p, 1]`), and
//! `(tx, ty, tz)` is the translation. Each row is one `vec4`, so a shader transforms a point with
//! three dot products (`p'.x = dot(row0, vec4(p, 1))`); read as a column-major GLSL/WGSL
//! `mat3x4`, it is the transpose, used as `vec4(p, 1) * M`. This is the layout T13r writes into the
//! bone-matrix output view (12 `f32` per bone, bone `i` at offset `12·i`).

use crate::f32x4::F32x4;
use crate::lane::Lane;
use crate::transform::TransformT;
use crate::vec3::Vec3T;
use core::ops::Mul;

/// |det| at or below this makes [`Mat3x4T::inverse_or`] return its fallback (three axis scales of
/// [`SCALE_EPSILON`](crate::SCALE_EPSILON) multiplied).
pub const DET_EPSILON: f32 = 1e-24;

/// An affine 3×4 matrix, row-major (`m[4·row + col]`, column 3 is the translation).
#[derive(Clone, Copy, Debug)]
pub struct Mat3x4T<L> {
    pub m: [L; 12],
}

/// Four matrices, one per lane (SoA).
pub type SoaMat3x4 = Mat3x4T<F32x4>;
/// One matrix (AoS, scalar `f32`), stored exactly in the output layout.
pub type AosMat3x4 = Mat3x4T<f32>;

impl<L: Lane> Mat3x4T<L> {
    #[inline(always)]
    pub fn identity() -> Self {
        let (o, z) = (L::splat(1.0), L::splat(0.0));
        Self {
            m: [o, z, z, z, z, o, z, z, z, z, o, z],
        }
    }

    /// The matrix of `rotation · diag(scale)` with `translation` (the same map as
    /// [`TransformT::transform_point`]). The rotation is assumed unit.
    #[inline]
    pub fn from_transform(t: TransformT<L>) -> Self {
        let q = t.rotation;
        let (x2, y2, z2) = (q.x + q.x, q.y + q.y, q.z + q.z);
        let (xx, yy, zz) = (q.x * x2, q.y * y2, q.z * z2);
        let (xy, xz, yz) = (q.x * y2, q.x * z2, q.y * z2);
        let (wx, wy, wz) = (q.w * x2, q.w * y2, q.w * z2);
        let one = L::splat(1.0);
        let s = t.scale;
        let p = t.translation;
        Self {
            m: [
                (one - (yy + zz)) * s.x,
                (xy - wz) * s.y,
                (xz + wy) * s.z,
                p.x,
                (xy + wz) * s.x,
                (one - (xx + zz)) * s.y,
                (yz - wx) * s.z,
                p.y,
                (xz - wy) * s.x,
                (yz + wx) * s.y,
                (one - (xx + yy)) * s.z,
                p.z,
            ],
        }
    }

    /// `M·[p, 1]`.
    #[inline(always)]
    pub fn transform_point(self, p: Vec3T<L>) -> Vec3T<L> {
        let m = &self.m;
        Vec3T::new(
            m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
            m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
            m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
        )
    }

    /// `M·[v, 0]`.
    #[inline(always)]
    pub fn transform_vector(self, v: Vec3T<L>) -> Vec3T<L> {
        let m = &self.m;
        Vec3T::new(
            m[0] * v.x + m[1] * v.y + m[2] * v.z,
            m[4] * v.x + m[5] * v.y + m[6] * v.z,
            m[8] * v.x + m[9] * v.y + m[10] * v.z,
        )
    }

    /// The exact affine inverse (handles non-uniform and negative scale and shear), through the
    /// adjugate. Lanes with |det| ≤ [`DET_EPSILON`] (singular, e.g. a zero scale) get `fallback`.
    #[inline]
    pub fn inverse_or(self, fallback: Self) -> Self {
        let m = &self.m;
        let (a, b, c) = (m[0], m[1], m[2]);
        let (d, e, f) = (m[4], m[5], m[6]);
        let (g, h, i) = (m[8], m[9], m[10]);
        let c00 = e * i - f * h;
        let c01 = c * h - b * i;
        let c02 = b * f - c * e;
        let c10 = f * g - d * i;
        let c11 = a * i - c * g;
        let c12 = c * d - a * f;
        let c20 = d * h - e * g;
        let c21 = b * g - a * h;
        let c22 = a * e - b * d;
        let det = a * c00 + b * c10 + c * c20;
        let ok = det.abs().gt(L::splat(DET_EPSILON));
        let one = L::splat(1.0);
        let inv_det = one / L::select(ok, det, one);
        let r = [
            c00 * inv_det,
            c01 * inv_det,
            c02 * inv_det,
            c10 * inv_det,
            c11 * inv_det,
            c12 * inv_det,
            c20 * inv_det,
            c21 * inv_det,
            c22 * inv_det,
        ];
        let (tx, ty, tz) = (m[3], m[7], m[11]);
        let t = |k: usize| -(r[3 * k] * tx + r[3 * k + 1] * ty + r[3 * k + 2] * tz);
        let inv = Self {
            m: [
                r[0],
                r[1],
                r[2],
                t(0),
                r[3],
                r[4],
                r[5],
                t(1),
                r[6],
                r[7],
                r[8],
                t(2),
            ],
        };
        Self {
            m: core::array::from_fn(|k| L::select(ok, inv.m[k], fallback.m[k])),
        }
    }
}

/// `a * b` as affine maps: applies `b`, then `a`.
impl<L: Lane> Mul for Mat3x4T<L> {
    type Output = Self;
    #[inline]
    fn mul(self, o: Self) -> Self {
        let a = &self.m;
        let b = &o.m;
        let e = |r: usize, c: usize| {
            a[4 * r] * b[c] + a[4 * r + 1] * b[4 + c] + a[4 * r + 2] * b[8 + c]
        };
        let t = |r: usize| e(r, 3) + a[4 * r + 3];
        Self {
            m: [
                e(0, 0),
                e(0, 1),
                e(0, 2),
                t(0),
                e(1, 0),
                e(1, 1),
                e(1, 2),
                t(1),
                e(2, 0),
                e(2, 1),
                e(2, 2),
                t(2),
            ],
        }
    }
}

impl AosMat3x4 {
    /// `self * o` a row at a time, four lanes per row: the same bits as `*` (each element is
    /// `a0·b0 + a1·b1 + a2·b2` in that order, plus `a3` on the translation column only).
    #[inline]
    pub fn mul_rows(self, o: Self) -> Self {
        let (a, b) = (&self.m, &o.m);
        let row = |k: usize| F32x4::new(b[4 * k], b[4 * k + 1], b[4 * k + 2], b[4 * k + 3]);
        let (b0, b1, b2) = (row(0), row(1), row(2));
        let r = |i: usize| {
            let v = F32x4::splat(a[4 * i]) * b0
                + F32x4::splat(a[4 * i + 1]) * b1
                + F32x4::splat(a[4 * i + 2]) * b2;
            v.with_lane(3, v.get_lane(3) + a[4 * i + 3]).to_array()
        };
        let (r0, r1, r2) = (r(0), r(1), r(2));
        Self {
            m: [
                r0[0], r0[1], r0[2], r0[3], r1[0], r1[1], r1[2], r1[3], r2[0], r2[1], r2[2], r2[3],
            ],
        }
    }

    /// The twelve floats in the output layout.
    #[inline(always)]
    pub fn to_rows(self) -> [f32; 12] {
        self.m
    }

    /// From twelve floats in the output layout.
    #[inline(always)]
    pub fn from_rows(m: [f32; 12]) -> Self {
        Self { m }
    }
}

impl SoaMat3x4 {
    /// Transposes into four AoS matrices (lane i = bone i of the group).
    #[inline]
    pub fn to_aos(self) -> [AosMat3x4; 4] {
        let cols: [[f32; 4]; 12] = core::array::from_fn(|k| self.m[k].to_array());
        core::array::from_fn(|lane| AosMat3x4 {
            m: core::array::from_fn(|k| cols[k][lane]),
        })
    }

    /// Writes the first `count` (≤ 4) lanes into `out` in the output layout, 12 floats each, so a
    /// padded last group writes only its real bones. Panics if `out` holds fewer than `12·count`.
    #[inline]
    pub fn write_rows(self, out: &mut [f32], count: usize) {
        let mats = self.to_aos();
        for (lane, mat) in mats.iter().enumerate().take(count.min(4)) {
            out[12 * lane..12 * lane + 12].copy_from_slice(&mat.m);
        }
    }
}
