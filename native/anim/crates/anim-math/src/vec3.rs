//! [`Vec3T`]: a 3-vector over a [`Lane`]. [`SoaVec3`] holds four vectors (one per lane),
//! [`AosVec3`] one.

use crate::f32x4::F32x4;
use crate::lane::Lane;
use core::ops::{Add, Mul, Neg, Sub};

/// A 3-vector whose components are lanes.
#[derive(Clone, Copy, Debug)]
pub struct Vec3T<L> {
    pub x: L,
    pub y: L,
    pub z: L,
}

/// Four 3-vectors, one per lane (SoA).
pub type SoaVec3 = Vec3T<F32x4>;
/// One 3-vector (AoS, scalar `f32`).
pub type AosVec3 = Vec3T<f32>;

/// Squared length under which [`Vec3T::normalize_or`] returns its fallback. Lengths below 1e-12
/// (squared 1e-24) can't be normalised to f32 precision.
pub const NORMALIZE_EPSILON_SQ: f32 = 1e-24;

impl<L: Lane> Vec3T<L> {
    #[inline(always)]
    pub fn new(x: L, y: L, z: L) -> Self {
        Self { x, y, z }
    }

    /// Every component set to `v`.
    #[inline(always)]
    pub fn splat(v: f32) -> Self {
        let s = L::splat(v);
        Self { x: s, y: s, z: s }
    }

    #[inline(always)]
    pub fn zero() -> Self {
        Self::splat(0.0)
    }

    #[inline(always)]
    pub fn one() -> Self {
        Self::splat(1.0)
    }

    /// The same vector `(x, y, z)` in every lane.
    #[inline(always)]
    pub fn broadcast(x: f32, y: f32, z: f32) -> Self {
        Self::new(L::splat(x), L::splat(y), L::splat(z))
    }

    /// Multiplies every component by `s`.
    #[inline(always)]
    pub fn scale(self, s: L) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }

    /// `(x·x + y·y) + z·z`, in that order.
    #[inline(always)]
    pub fn dot(self, o: Self) -> L {
        self.x * o.x + self.y * o.y + self.z * o.z
    }

    #[inline(always)]
    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }

    #[inline(always)]
    pub fn length_squared(self) -> L {
        self.dot(self)
    }

    #[inline(always)]
    pub fn length(self) -> L {
        self.dot(self).sqrt()
    }

    /// The unit vector, or `fallback` in lanes whose squared length is at most
    /// [`NORMALIZE_EPSILON_SQ`] (zero, tiny or NaN vectors).
    #[inline]
    pub fn normalize_or(self, fallback: Self) -> Self {
        let len2 = self.length_squared();
        let ok = len2.gt(L::splat(NORMALIZE_EPSILON_SQ));
        // max() keeps 1/0 out of the unused lanes.
        let inv = L::splat(1.0) / len2.max(L::splat(NORMALIZE_EPSILON_SQ)).sqrt();
        Self::select(ok, self.scale(inv), fallback)
    }

    /// `self + (o - self) * t`.
    #[inline(always)]
    pub fn lerp(self, o: Self, t: L) -> Self {
        self + (o - self).scale(t)
    }

    /// Per lane, `a` where `mask` is set, otherwise `b`.
    #[inline(always)]
    pub fn select(mask: L::Mask, a: Self, b: Self) -> Self {
        Self::new(
            L::select(mask, a.x, b.x),
            L::select(mask, a.y, b.y),
            L::select(mask, a.z, b.z),
        )
    }
}

impl<L: Lane> Add for Vec3T<L> {
    type Output = Self;
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl<L: Lane> Sub for Vec3T<L> {
    type Output = Self;
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
/// Component-wise product.
impl<L: Lane> Mul for Vec3T<L> {
    type Output = Self;
    #[inline(always)]
    fn mul(self, o: Self) -> Self {
        Self::new(self.x * o.x, self.y * o.y, self.z * o.z)
    }
}
impl<L: Lane> Neg for Vec3T<L> {
    type Output = Self;
    #[inline(always)]
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z)
    }
}

impl SoaVec3 {
    /// Transposes four AoS vectors into one SoA vector (lane i = `v[i]`).
    #[inline]
    pub fn from_aos(v: &[AosVec3; 4]) -> Self {
        Self::new(
            F32x4::new(v[0].x, v[1].x, v[2].x, v[3].x),
            F32x4::new(v[0].y, v[1].y, v[2].y, v[3].y),
            F32x4::new(v[0].z, v[1].z, v[2].z, v[3].z),
        )
    }

    /// Transposes back into four AoS vectors.
    #[inline]
    pub fn to_aos(self) -> [AosVec3; 4] {
        let (x, y, z) = (self.x.to_array(), self.y.to_array(), self.z.to_array());
        core::array::from_fn(|i| AosVec3::new(x[i], y[i], z[i]))
    }

    /// Lane `i` as an AoS vector.
    #[inline]
    pub fn lane(self, i: usize) -> AosVec3 {
        self.to_aos()[i]
    }
}

impl From<glam::Vec3> for AosVec3 {
    #[inline(always)]
    fn from(v: glam::Vec3) -> Self {
        Self::new(v.x, v.y, v.z)
    }
}
impl From<AosVec3> for glam::Vec3 {
    #[inline(always)]
    fn from(v: AosVec3) -> Self {
        glam::Vec3::new(v.x, v.y, v.z)
    }
}
