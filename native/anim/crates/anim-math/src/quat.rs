//! [`QuatT`]: a rotation quaternion over a [`Lane`]. [`SoaQuat`] holds four, [`AosQuat`] one.
//!
//! Quaternions are `(x, y, z, w)` with `w` the scalar part, Hamilton convention: `a * b` rotates
//! by `b` first, then `a` (as glam). Operations that rotate assume unit quaternions; the
//! normalising ones ([`QuatT::normalize_or_identity`], [`QuatT::nlerp`]) accept any.

use crate::f32x4::F32x4;
use crate::lane::Lane;
use crate::trig::{atan2, sin_cos};
use crate::vec3::{Vec3T, NORMALIZE_EPSILON_SQ};
use core::ops::{Mul, Neg};

/// A quaternion whose components are lanes.
#[derive(Clone, Copy, Debug)]
pub struct QuatT<L> {
    pub x: L,
    pub y: L,
    pub z: L,
    pub w: L,
}

/// Four quaternions, one per lane (SoA).
pub type SoaQuat = QuatT<F32x4>;
/// One quaternion (AoS, scalar `f32`).
pub type AosQuat = QuatT<f32>;

/// Below this `sin θ` (θ the half-angle between the inputs), [`QuatT::slerp`] blends linearly:
/// the difference from a true slerp is O(θ²), under 1e-12.
const SLERP_LINEAR_SIN: f32 = 1e-6;

impl<L: Lane> QuatT<L> {
    #[inline(always)]
    pub fn new(x: L, y: L, z: L, w: L) -> Self {
        Self { x, y, z, w }
    }

    /// The identity rotation in every lane.
    #[inline(always)]
    pub fn identity() -> Self {
        let z = L::splat(0.0);
        Self::new(z, z, z, L::splat(1.0))
    }

    /// The same quaternion in every lane.
    #[inline(always)]
    pub fn broadcast(x: f32, y: f32, z: f32, w: f32) -> Self {
        Self::new(L::splat(x), L::splat(y), L::splat(z), L::splat(w))
    }

    /// The vector part `(x, y, z)`.
    #[inline(always)]
    pub fn xyz(self) -> Vec3T<L> {
        Vec3T::new(self.x, self.y, self.z)
    }

    /// `((x·x + y·y) + z·z) + w·w`, in that order.
    #[inline(always)]
    pub fn dot(self, o: Self) -> L {
        self.x * o.x + self.y * o.y + self.z * o.z + self.w * o.w
    }

    #[inline(always)]
    pub fn length_squared(self) -> L {
        self.dot(self)
    }

    #[inline(always)]
    pub fn length(self) -> L {
        self.dot(self).sqrt()
    }

    /// The inverse of a unit quaternion: `(-x, -y, -z, w)`.
    #[inline(always)]
    pub fn conjugate(self) -> Self {
        Self::new(-self.x, -self.y, -self.z, self.w)
    }

    /// Multiplies every component by `s`.
    #[inline(always)]
    pub fn scale(self, s: L) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s, self.w * s)
    }

    /// Component-wise sum (not a rotation on its own; used by blends).
    #[inline(always)]
    pub fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z, self.w + o.w)
    }

    /// Per lane, `a` where `mask` is set, otherwise `b`.
    #[inline(always)]
    pub fn select(mask: L::Mask, a: Self, b: Self) -> Self {
        Self::new(
            L::select(mask, a.x, b.x),
            L::select(mask, a.y, b.y),
            L::select(mask, a.z, b.z),
            L::select(mask, a.w, b.w),
        )
    }

    /// The unit quaternion, or identity in lanes whose squared length is at most 1e-24 (zero, tiny
    /// or NaN).
    #[inline]
    pub fn normalize_or_identity(self) -> Self {
        let len2 = self.length_squared();
        let ok = len2.gt(L::splat(NORMALIZE_EPSILON_SQ));
        let inv = L::splat(1.0) / len2.max(L::splat(NORMALIZE_EPSILON_SQ)).sqrt();
        Self::select(ok, self.scale(inv), Self::identity())
    }

    /// `o`, negated in lanes where `dot(self, o) < 0`, so a blend from `self` to the result takes
    /// the shortest path (`q` and `-q` are the same rotation).
    #[inline(always)]
    pub fn align_to(self, o: Self) -> Self {
        Self::select(self.dot(o).lt(L::splat(0.0)), -o, o)
    }

    /// Normalised linear interpolation on the shortest path: `normalize(a + (b' - a) * t)` with
    /// `b'` = `b` sign-fixed toward `a`. The hot-path blend. At `t = 0.5` between opposite
    /// rotations it can't fail: after the sign fix the sum is never shorter than √2/2·|a|.
    #[inline]
    pub fn nlerp(self, b: Self, t: L) -> Self {
        let b = self.align_to(b);
        let r = Self::new(
            self.x + (b.x - self.x) * t,
            self.y + (b.y - self.y) * t,
            self.z + (b.z - self.z) * t,
            self.w + (b.w - self.w) * t,
        );
        r.normalize_or_identity()
    }

    /// Spherical linear interpolation on the shortest path, for unit inputs. Uses the crate's
    /// deterministic polynomial trigonometry (no libm). The angle between the inputs comes from
    /// `θ = 2·atan2(|a − b|, |a + b|)`, which stays accurate near 0 and π (unlike `acos(dot)`).
    /// Not needed on the hot path (blends use [`nlerp`](Self::nlerp)), but cheap enough for it.
    #[inline]
    pub fn slerp(self, b: Self, t: L) -> Self {
        let b = self.align_to(b);
        let diff = Self::new(self.x - b.x, self.y - b.y, self.z - b.z, self.w - b.w).length();
        let sum = self.add(b).length();
        // Half the 4D angle between a and b' is atan2(diff, sum); θ in [0, π/2] after the sign fix.
        let theta = L::splat(2.0) * atan2(diff, sum);
        let one = L::splat(1.0);
        let (s, _) = sin_cos(theta);
        let (sa, _) = sin_cos((one - t) * theta);
        let (sb, _) = sin_cos(t * theta);
        let linear = s.le(L::splat(SLERP_LINEAR_SIN));
        let safe_s = s.max(L::splat(SLERP_LINEAR_SIN));
        let wa = L::select(linear, one - t, sa / safe_s);
        let wb = L::select(linear, t, sb / safe_s);
        self.scale(wa).add(b.scale(wb))
    }

    /// Rotates `v` by this unit quaternion: `v + w·t + u × t` with `u = xyz`, `t = 2·(u × v)`.
    #[inline(always)]
    pub fn rotate(self, v: Vec3T<L>) -> Vec3T<L> {
        let u = self.xyz();
        let t = u.cross(v).scale(L::splat(2.0));
        v + t.scale(self.w) + u.cross(t)
    }

    /// The rotation of `angle` radians about the unit `axis` (right-handed). Uses the crate's
    /// deterministic polynomial `sin_cos`. Off the hot path (setup and authoring).
    #[inline]
    pub fn from_axis_angle(axis: Vec3T<L>, angle: L) -> Self {
        let (s, c) = sin_cos(angle * L::splat(0.5));
        Self::new(axis.x * s, axis.y * s, axis.z * s, c)
    }

    /// The unit axis and angle in [0, π] of this unit quaternion (`q` and `-q` give the same
    /// result). For a rotation under about 1e-12 radians the axis is `+X` and the angle is that
    /// tiny angle (or 0). Uses the deterministic polynomial `atan2`. Off the hot path.
    #[inline]
    pub fn to_axis_angle(self) -> (Vec3T<L>, L) {
        let q = Self::select(self.w.lt(L::splat(0.0)), -self, self);
        let v = q.xyz();
        let len = v.length();
        let angle = L::splat(2.0) * atan2(len, q.w);
        let axis = v.normalize_or(Vec3T::broadcast(1.0, 0.0, 0.0));
        (axis, angle)
    }
}

/// Hamilton product: `a * b` rotates by `b`, then `a`.
impl<L: Lane> Mul for QuatT<L> {
    type Output = Self;
    #[inline(always)]
    fn mul(self, b: Self) -> Self {
        let a = self;
        Self::new(
            a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
        )
    }
}

impl<L: Lane> Neg for QuatT<L> {
    type Output = Self;
    #[inline(always)]
    fn neg(self) -> Self {
        Self::new(-self.x, -self.y, -self.z, -self.w)
    }
}

impl SoaQuat {
    /// Transposes four AoS quaternions into one SoA quaternion (lane i = `q[i]`).
    #[inline]
    pub fn from_aos(q: &[AosQuat; 4]) -> Self {
        Self::new(
            F32x4::new(q[0].x, q[1].x, q[2].x, q[3].x),
            F32x4::new(q[0].y, q[1].y, q[2].y, q[3].y),
            F32x4::new(q[0].z, q[1].z, q[2].z, q[3].z),
            F32x4::new(q[0].w, q[1].w, q[2].w, q[3].w),
        )
    }

    /// Transposes back into four AoS quaternions.
    #[inline]
    pub fn to_aos(self) -> [AosQuat; 4] {
        let (x, y, z, w) = (
            self.x.to_array(),
            self.y.to_array(),
            self.z.to_array(),
            self.w.to_array(),
        );
        core::array::from_fn(|i| AosQuat::new(x[i], y[i], z[i], w[i]))
    }

    /// Lane `i` as an AoS quaternion.
    #[inline]
    pub fn lane(self, i: usize) -> AosQuat {
        self.to_aos()[i]
    }
}

impl From<glam::Quat> for AosQuat {
    #[inline(always)]
    fn from(q: glam::Quat) -> Self {
        Self::new(q.x, q.y, q.z, q.w)
    }
}
impl From<AosQuat> for glam::Quat {
    #[inline(always)]
    fn from(q: AosQuat) -> Self {
        glam::Quat::from_xyzw(q.x, q.y, q.z, q.w)
    }
}
