//! Blends: [`lerp`] (two poses), [`blend`] (N weighted poses) and [`blend_masked`] (a layer over
//! a base by per-bone weights).
//!
//! Translation and scale mix linearly. Rotation mixes as a *normalised linear* combination
//! (nlerp-style): each rotation is sign-aligned to the first pose's rotation of that bone
//! (`q` and `-q` are one rotation), the weighted quaternions are summed left to right, and the
//! sum is normalised (a zero or non-finite sum gives identity). nlerp is not constant-speed
//! like slerp, but its error against slerp is below 4% of the angle at the 180-degree worst case
//! and far less for the small angles between pose samples; it is the hot-path choice of every
//! engine this one follows.
//!
//! The evaluation order is fixed (poses in slice order, one multiply and one add per component),
//! so the SoA and scalar instantiations agree bit for bit.

use anim_math::{F32x4, Lane, LaneMask, QuatT, TransformT, Vec3T};

/// Total weight at or below this counts as "no weight" in [`blend`].
pub const MIN_TOTAL_WEIGHT: f32 = 1e-12;

/// `t` clamped to [0, 1]; NaN becomes 0.
#[inline(always)]
pub(crate) fn unit(t: f32) -> f32 {
    if t > 0.0 {
        if t < 1.0 {
            t
        } else {
            1.0
        }
    } else {
        0.0
    }
}

/// Weights must be positive to count; anything else (negative, zero, NaN) is 0.
#[inline(always)]
fn sanitize(w: f32) -> f32 {
    if w > 0.0 {
        w
    } else {
        0.0
    }
}

/// One transform's blend: lerp of translation and scale, nlerp of rotation (shortest path).
/// `t` is per lane and not clamped.
#[inline(always)]
pub fn lerp_transform<L: Lane>(a: TransformT<L>, b: TransformT<L>, t: L) -> TransformT<L> {
    TransformT::new(
        a.translation.lerp(b.translation, t),
        a.rotation.nlerp(b.rotation, t),
        a.scale.lerp(b.scale, t),
    )
}

/// `out = lerp(a, b, t)` bone by bone, `t` clamped to [0, 1] (NaN is 0). The two-pose fast path
/// of [`blend`].
///
/// Panics unless the three slices have the same length.
#[inline]
pub fn lerp<L: Lane>(a: &[TransformT<L>], b: &[TransformT<L>], t: f32, out: &mut [TransformT<L>]) {
    assert_eq!(a.len(), out.len(), "pose length");
    assert_eq!(b.len(), out.len(), "pose length");
    let t = L::splat(unit(t));
    for ((o, &a), &b) in out.iter_mut().zip(a).zip(b) {
        *o = lerp_transform(a, b, t);
    }
}

/// `out` = the weighted blend of `poses`.
///
/// - Weights are normalised by their sum. A weight that is zero, negative or NaN contributes
///   nothing (and its pose is not read).
/// - Rotations are sign-aligned against `poses[0]`'s rotation of the same bone (even when
///   `poses[0]` has weight 0), so the result doesn't depend on the order of the others.
/// - **No weight** (no poses, or the weights sum to at most [`MIN_TOTAL_WEIGHT`]): `out` is a
///   copy of `rest`, the reference (usually bind) pose. The graph passes its bind pose.
/// - Exactly one positive weight: `out` is a bit-exact copy of that pose.
///
/// Panics unless `poses.len() == weights.len()` and every pose, `rest` and `out` have the same
/// length. Never allocates.
#[inline]
pub fn blend<L: Lane>(
    poses: &[&[TransformT<L>]],
    weights: &[f32],
    rest: &[TransformT<L>],
    out: &mut [TransformT<L>],
) {
    assert_eq!(poses.len(), weights.len(), "one weight per pose");
    assert_eq!(rest.len(), out.len(), "pose length");
    let mut total = 0.0f32;
    let mut positive = 0usize;
    let mut last = 0usize;
    for (k, &w) in weights.iter().enumerate() {
        let w = sanitize(w);
        if w > 0.0 {
            total += w;
            positive += 1;
            last = k;
        }
    }
    if positive == 0 || total <= MIN_TOTAL_WEIGHT {
        out.copy_from_slice(rest);
        return;
    }
    if positive == 1 {
        assert_eq!(poses[last].len(), out.len(), "pose length");
        out.copy_from_slice(poses[last]);
        return;
    }
    let zero = TransformT::new(
        Vec3T::zero(),
        QuatT::new(L::splat(0.0), L::splat(0.0), L::splat(0.0), L::splat(0.0)),
        Vec3T::zero(),
    );
    out.fill(zero);
    let reference = poses[0];
    assert_eq!(reference.len(), out.len(), "pose length");
    for (k, &pose) in poses.iter().enumerate() {
        let w = sanitize(weights[k]);
        if w <= 0.0 {
            continue;
        }
        assert_eq!(pose.len(), out.len(), "pose length");
        let w = L::splat(w / total);
        for ((o, p), r) in out.iter_mut().zip(pose).zip(reference) {
            let q = r.rotation.align_to(p.rotation).scale(w);
            // `align_to(r, p)` returns ±p, so `q` is the aligned `p` scaled by `w`.
            o.translation = o.translation + p.translation.scale(w);
            o.rotation = o.rotation + q;
            o.scale = o.scale + p.scale.scale(w);
        }
    }
    for o in out.iter_mut() {
        o.rotation = o.rotation.normalize_or_identity();
    }
}

/// Layered blend by a bone mask: `out[i] = lerp(base[i], layer[i], clamp(mask[i] * weight))`.
///
/// `mask` holds one weight per bone packed like a pose (`soa_len` groups of four lanes; build it
/// with [`pack_mask`]). A bone whose final weight is 0 (or less, or NaN) gets `base` bit for bit,
/// so a layer over a masked-out limb leaves it exactly as the base made it. `weight` is the
/// layer's overall weight (usually 0..1); the product is clamped to [0, 1].
///
/// Panics unless all slices have the same length. Never allocates.
#[inline]
pub fn blend_masked<L: Lane>(
    base: &[TransformT<L>],
    layer: &[TransformT<L>],
    mask: &[L],
    weight: f32,
    out: &mut [TransformT<L>],
) {
    assert_eq!(base.len(), out.len(), "pose length");
    assert_eq!(layer.len(), out.len(), "pose length");
    assert_eq!(mask.len(), out.len(), "mask length");
    let w = L::splat(unit(weight));
    let (zero, one) = (L::splat(0.0), L::splat(1.0));
    for (((o, &b), &l), &m) in out.iter_mut().zip(base).zip(layer).zip(mask) {
        let t = (m * w).max(zero).min(one);
        let on = t.gt(zero);
        if !on.any() {
            // Nothing layered on this group (the select below would keep `b` in every lane).
            *o = b;
            continue;
        }
        let blended = lerp_transform(b, l, t);
        // Keep the base exactly where nothing is layered (also where t is NaN).
        *o = TransformT::select(on, blended, b);
    }
}

/// Packs per-bone weights into the SoA mask layout [`blend_masked`] takes: `out.len()` must be
/// `soa_len(per_bone.len())`; spare lanes of the last group get 0.
#[inline]
pub fn pack_mask(per_bone: &[f32], out: &mut [F32x4]) {
    assert_eq!(
        out.len(),
        anim_math::layout::soa_len(per_bone.len()),
        "mask length"
    );
    for (g, o) in out.iter_mut().enumerate() {
        let at = |l: usize| per_bone.get(4 * g + l).copied().unwrap_or(0.0);
        *o = F32x4::new(at(0), at(1), at(2), at(3));
    }
}
