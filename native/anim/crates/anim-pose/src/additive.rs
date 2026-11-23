//! Additive poses: a delta from a reference pose, applied on top of any base pose with a weight.
//!
//! For a pose `p` and a reference `r` (per bone):
//!
//! | channel | additive (delta) | apply with weight `w` onto base `b` |
//! |---|---|---|
//! | translation | `p.t - r.t` | `b.t + w * d.t` |
//! | rotation | `r⁻¹ * p.r` | `b.r * nlerp(identity, d.r, w)` |
//! | scale | `p.s / r.s` (1 where `r.s` is ~0) | `b.s * (1 + w * (d.s - 1))` |
//!
//! `w = 0` returns the base bit for bit (for finite inputs). `w = 1` onto the reference gives the
//! pose back (up to rounding). The rotation delta is on the *right* of the reference (a
//! local-space delta), and `nlerp(identity, d, w)` takes the shortest path (`d` is sign-fixed so
//! its `w` is non-negative), so a delta of more than 180 degrees is applied the short way round.
//! `w` outside [0, 1] extrapolates (translation and scale linearly, rotation by the same nlerp
//! formula).

use anim_math::{Lane, QuatT, TransformT, Vec3T, SCALE_EPSILON};

/// `out[i]` = the additive delta of `pose[i]` from `reference[i]`. Panics unless all three
/// slices have the same length. Never allocates.
#[inline]
pub fn make_additive<L: Lane>(
    pose: &[TransformT<L>],
    reference: &[TransformT<L>],
    out: &mut [TransformT<L>],
) {
    assert_eq!(pose.len(), out.len(), "pose length");
    assert_eq!(reference.len(), out.len(), "pose length");
    for ((o, p), r) in out.iter_mut().zip(pose).zip(reference) {
        *o = additive_of(*p, *r);
    }
}

/// `out[i] = apply(base[i], additive[i], weight)`. Panics unless all three slices have the same
/// length. Never allocates.
#[inline]
pub fn apply_additive<L: Lane>(
    base: &[TransformT<L>],
    additive: &[TransformT<L>],
    weight: f32,
    out: &mut [TransformT<L>],
) {
    assert_eq!(base.len(), out.len(), "pose length");
    assert_eq!(additive.len(), out.len(), "pose length");
    let w = L::splat(weight);
    for ((o, b), a) in out.iter_mut().zip(base).zip(additive) {
        *o = apply_additive_transform(*b, *a, w);
    }
}

/// Like [`apply_additive`] with a per-bone weight `mask[i] * weight` (the mask packed like a
/// pose, see [`pack_mask`](crate::blend::pack_mask)): a masked-out bone gets the base back.
#[inline]
pub fn apply_additive_masked<L: Lane>(
    base: &[TransformT<L>],
    additive: &[TransformT<L>],
    mask: &[L],
    weight: f32,
    out: &mut [TransformT<L>],
) {
    assert_eq!(base.len(), out.len(), "pose length");
    assert_eq!(additive.len(), out.len(), "pose length");
    assert_eq!(mask.len(), out.len(), "mask length");
    let w = L::splat(weight);
    for (((o, b), a), m) in out.iter_mut().zip(base).zip(additive).zip(mask) {
        *o = apply_additive_transform(*b, *a, *m * w);
    }
}

/// The delta of one transform from its reference.
#[inline(always)]
pub fn additive_of<L: Lane>(pose: TransformT<L>, reference: TransformT<L>) -> TransformT<L> {
    let one = L::splat(1.0);
    let rs = reference.scale;
    let ratio = |p: L, r: L| {
        let ok = r.abs().gt(L::splat(SCALE_EPSILON));
        L::select(ok, p * (one / L::select(ok, r, one)), one)
    };
    TransformT::new(
        pose.translation - reference.translation,
        reference.rotation.conjugate() * pose.rotation,
        Vec3T::new(
            ratio(pose.scale.x, rs.x),
            ratio(pose.scale.y, rs.y),
            ratio(pose.scale.z, rs.z),
        ),
    )
}

/// Applies one delta onto a base with weight `w` (per lane).
#[inline(always)]
pub fn apply_additive_transform<L: Lane>(
    base: TransformT<L>,
    d: TransformT<L>,
    w: L,
) -> TransformT<L> {
    let one = L::splat(1.0);
    // nlerp(identity, d, w) on the shortest path: negate d where d.w < 0.
    let neg = d.rotation.w.lt(L::splat(0.0));
    let dq = QuatT::select(neg, -d.rotation, d.rotation);
    let part =
        QuatT::new(dq.x * w, dq.y * w, dq.z * w, (one - w) + dq.w * w).normalize_or_identity();
    let ds = d.scale;
    TransformT::new(
        base.translation + d.translation.scale(w),
        base.rotation * part,
        Vec3T::new(
            base.scale.x * (one + (ds.x - one) * w),
            base.scale.y * (one + (ds.y - one) * w),
            base.scale.z * (one + (ds.z - one) * w),
        ),
    )
}
