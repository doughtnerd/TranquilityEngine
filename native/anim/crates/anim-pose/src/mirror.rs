//! Mirroring a local pose across a plane through the model origin, through a left/right bone map.
//!
//! `partner[i]` is the bone whose motion bone `i` takes over, mirrored: the other side's bone for
//! a left or right bone, `i` itself for a centre bone (the profile's left/right map, ADR 0342).
//! The map has one entry per bone; an entry out of range counts as the bone itself.
//!
//! The reflection of a local transform across the plane with normal axis `a`: the translation's
//! `a` component changes sign, and a rotation `(x, y, z, w)` keeps its angle and reflects its axis
//! as a pseudo-vector, so the two components other than `a` (and not `w`) change sign; scale is
//! unchanged. For `a = X`: `t -> (-tx, ty, tz)`, `q -> (qx, -qy, -qz, qw)`.
//!
//! **Assumption:** the two sides of the skeleton are *mirror images in local space*: their
//! local frames are reflections of each other (rigs built by mirroring, as in most DCC tools), and
//! the centre bones' local axes are aligned with the model axes. A skeleton whose left bones use a
//! flipped-axis convention needs a per-bone correction that this map doesn't carry.

use crate::Axis;
use anim_math::layout::{soa_len, LANES};
use anim_math::{AosTransform, Lane, QuatT, SoaTransform, TransformT, Vec3T};

/// The reflection of one local transform across the plane with normal `axis`. Exact (only sign
/// changes), so applying it twice returns the input.
#[inline(always)]
pub fn mirror_transform<L: Lane>(t: TransformT<L>, axis: Axis) -> TransformT<L> {
    let (p, q) = (t.translation, t.rotation);
    let (translation, rotation) = match axis {
        Axis::X => (Vec3T::new(-p.x, p.y, p.z), QuatT::new(q.x, -q.y, -q.z, q.w)),
        Axis::Y => (Vec3T::new(p.x, -p.y, p.z), QuatT::new(-q.x, q.y, -q.z, q.w)),
        Axis::Z => (Vec3T::new(p.x, p.y, -p.z), QuatT::new(-q.x, -q.y, q.z, q.w)),
    };
    TransformT::new(translation, rotation, t.scale)
}

/// `out[i]` = the mirror of `pose[partner[i]]`, for the SoA pose of `partner.len()` bones.
/// Spare lanes of the last group are identity. Pose and `out` are distinct slices.
///
/// Panics unless `pose.len() == out.len() == soa_len(partner.len())`. Never allocates. It gathers
/// across lanes (a partner can sit in any group), so it is a scalar pass over the bones; the
/// graph mirrors only when a mirror node asks for it.
#[inline]
pub fn mirror(pose: &[SoaTransform], partner: &[u16], axis: Axis, out: &mut [SoaTransform]) {
    let n = partner.len();
    assert_eq!(pose.len(), soa_len(n), "SoA pose length");
    assert_eq!(out.len(), soa_len(n), "SoA pose length");
    for (g, o) in out.iter_mut().enumerate() {
        let lanes: [AosTransform; LANES] = core::array::from_fn(|l| {
            let i = g * LANES + l;
            if i >= n {
                return AosTransform::identity();
            }
            let p = partner[i] as usize;
            let src = if p < n { p } else { i };
            mirror_transform(pose[src / LANES].lane(src % LANES), axis)
        });
        *o = SoaTransform::from_aos(&lanes);
    }
}
