//! [`TransformT`]: translation, rotation, scale over a [`Lane`]. [`SoaTransform`] holds four
//! (the local pose's unit), [`AosTransform`] one.
//!
//! A transform maps a point `p` to `rotation · (scale ⊙ p) + translation` (scale first, then
//! rotate, then translate). Composition follows Unreal's `FTransform`: scales multiply component
//! by component, so a parent's non-uniform scale under a rotated child loses the shear a matrix
//! product would have. Use [`Mat3x4T`](crate::Mat3x4T) where shear matters.

use crate::f32x4::F32x4;
use crate::lane::Lane;
use crate::quat::{AosQuat, QuatT, SoaQuat};
use crate::vec3::{AosVec3, SoaVec3, Vec3T};

/// Scale components with |s| at or below this get an inverse scale of 0 in
/// [`TransformT::inverse`] (Unreal's `SMALL_NUMBER`).
pub const SCALE_EPSILON: f32 = 1e-8;

/// A translation, rotation and scale whose components are lanes.
#[derive(Clone, Copy, Debug)]
pub struct TransformT<L> {
    pub translation: Vec3T<L>,
    pub rotation: QuatT<L>,
    pub scale: Vec3T<L>,
}

/// Four transforms, one per lane (SoA).
pub type SoaTransform = TransformT<F32x4>;
/// One transform (AoS, scalar `f32`).
pub type AosTransform = TransformT<f32>;

impl<L: Lane> TransformT<L> {
    #[inline(always)]
    pub fn new(translation: Vec3T<L>, rotation: QuatT<L>, scale: Vec3T<L>) -> Self {
        Self {
            translation,
            rotation,
            scale,
        }
    }

    /// The identity in every lane.
    #[inline(always)]
    pub fn identity() -> Self {
        Self::new(Vec3T::zero(), QuatT::identity(), Vec3T::one())
    }

    /// `self ∘ child`: the transform that applies `child`, then `self` (`model = parent ∘ local`).
    /// Rotation `self.r · child.r`, scale `self.s ⊙ child.s`, translation
    /// `self.r · (self.s ⊙ child.t) + self.t`.
    #[inline(always)]
    pub fn compose(self, child: Self) -> Self {
        Self::new(
            self.rotation.rotate(self.scale * child.translation) + self.translation,
            self.rotation * child.rotation,
            self.scale * child.scale,
        )
    }

    /// The inverse: rotation `r⁻¹`, scale `1 / s` (0 where |s| ≤ [`SCALE_EPSILON`]),
    /// translation `−r⁻¹ · (t / s)`.
    ///
    /// Exact (`inverse ∘ self` and `self ∘ inverse` are identity, and it undoes
    /// [`transform_point`](Self::transform_point)) when the scale is uniform, positive or
    /// negative, or when the rotation is identity. With non-uniform scale and a rotation the
    /// exact inverse needs shear, which a TRS can't hold: then only `inverse ∘ self` is identity
    /// (in TRS algebra), as with Unreal's `FTransform::Inverse`. Use
    /// [`Mat3x4T::inverse_or`](crate::Mat3x4T::inverse_or) for the exact affine inverse.
    #[inline]
    pub fn inverse(self) -> Self {
        let inv_s = Vec3T::new(
            safe_recip(self.scale.x),
            safe_recip(self.scale.y),
            safe_recip(self.scale.z),
        );
        let inv_r = self.rotation.conjugate();
        Self::new(-inv_r.rotate(inv_s * self.translation), inv_r, inv_s)
    }

    /// `r · (s ⊙ p) + t`.
    #[inline(always)]
    pub fn transform_point(self, p: Vec3T<L>) -> Vec3T<L> {
        self.rotation.rotate(self.scale * p) + self.translation
    }

    /// `r · (s ⊙ v)`: a direction or offset, without translation.
    #[inline(always)]
    pub fn transform_vector(self, v: Vec3T<L>) -> Vec3T<L> {
        self.rotation.rotate(self.scale * v)
    }

    /// Per lane, `a` where `mask` is set, otherwise `b`.
    #[inline(always)]
    pub fn select(mask: L::Mask, a: Self, b: Self) -> Self {
        Self::new(
            Vec3T::select(mask, a.translation, b.translation),
            QuatT::select(mask, a.rotation, b.rotation),
            Vec3T::select(mask, a.scale, b.scale),
        )
    }
}

#[inline(always)]
fn safe_recip<L: Lane>(s: L) -> L {
    let ok = s.abs().gt(L::splat(SCALE_EPSILON));
    let one = L::splat(1.0);
    L::select(ok, one / L::select(ok, s, one), L::splat(0.0))
}

impl SoaTransform {
    /// Transposes four AoS transforms into one SoA transform (lane i = `t[i]`).
    #[inline]
    pub fn from_aos(t: &[AosTransform; 4]) -> Self {
        Self::new(
            SoaVec3::from_aos(&core::array::from_fn(|i| t[i].translation)),
            SoaQuat::from_aos(&core::array::from_fn(|i| t[i].rotation)),
            SoaVec3::from_aos(&core::array::from_fn(|i| t[i].scale)),
        )
    }

    /// Transposes back into four AoS transforms.
    #[inline]
    pub fn to_aos(self) -> [AosTransform; 4] {
        let t = self.translation.to_aos();
        let r = self.rotation.to_aos();
        let s = self.scale.to_aos();
        core::array::from_fn(|i| AosTransform::new(t[i], r[i], s[i]))
    }

    /// Lane `i` as an AoS transform. Panics unless `i < 4`.
    #[inline]
    pub fn lane(self, i: usize) -> AosTransform {
        // One branch on the lane, then constant-lane extracts (no transpose of the group).
        match i {
            0 => self.lane_at(0),
            1 => self.lane_at(1),
            2 => self.lane_at(2),
            3 => self.lane_at(3),
            _ => panic!("lane {i} out of range"),
        }
    }

    /// Replaces lane `i` with `t` (the other lanes are unchanged). Panics unless `i < 4`.
    #[inline]
    pub fn set_lane(&mut self, i: usize, t: AosTransform) {
        match i {
            0 => self.set_lane_at(0, t),
            1 => self.set_lane_at(1, t),
            2 => self.set_lane_at(2, t),
            3 => self.set_lane_at(3, t),
            _ => panic!("lane {i} out of range"),
        }
    }

    #[inline(always)]
    fn lane_at(self, l: usize) -> AosTransform {
        let (t, r, s) = (self.translation, self.rotation, self.scale);
        AosTransform::new(
            AosVec3::new(t.x.get_lane(l), t.y.get_lane(l), t.z.get_lane(l)),
            AosQuat::new(
                r.x.get_lane(l),
                r.y.get_lane(l),
                r.z.get_lane(l),
                r.w.get_lane(l),
            ),
            AosVec3::new(s.x.get_lane(l), s.y.get_lane(l), s.z.get_lane(l)),
        )
    }

    #[inline(always)]
    fn set_lane_at(&mut self, l: usize, v: AosTransform) {
        let (t, r, s) = (&mut self.translation, &mut self.rotation, &mut self.scale);
        t.x = t.x.with_lane(l, v.translation.x);
        t.y = t.y.with_lane(l, v.translation.y);
        t.z = t.z.with_lane(l, v.translation.z);
        r.x = r.x.with_lane(l, v.rotation.x);
        r.y = r.y.with_lane(l, v.rotation.y);
        r.z = r.z.with_lane(l, v.rotation.z);
        r.w = r.w.with_lane(l, v.rotation.w);
        s.x = s.x.with_lane(l, v.scale.x);
        s.y = s.y.with_lane(l, v.scale.y);
        s.z = s.z.with_lane(l, v.scale.z);
    }
}

impl AosTransform {
    /// From glam types (the crate's AoS boundary).
    #[inline(always)]
    pub fn from_glam(translation: glam::Vec3, rotation: glam::Quat, scale: glam::Vec3) -> Self {
        Self::new(translation.into(), rotation.into(), scale.into())
    }

    /// To glam types: `(translation, rotation, scale)`.
    #[inline(always)]
    pub fn to_glam(self) -> (glam::Vec3, glam::Quat, glam::Vec3) {
        (
            self.translation.into(),
            self.rotation.into(),
            self.scale.into(),
        )
    }
}

impl Default for AosTransform {
    #[inline(always)]
    fn default() -> Self {
        Self::identity()
    }
}

impl Default for SoaTransform {
    #[inline(always)]
    fn default() -> Self {
        Self::identity()
    }
}
