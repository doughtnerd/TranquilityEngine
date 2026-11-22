//! AoS↔SoA transposes for whole poses, padding, and the local→model pass.
//!
//! # Padding
//!
//! A pose of `n` bones is stored as [`soa_len`]`(n)` = ⌈n / 4⌉ [`SoaTransform`]s; bone `i` is lane
//! `i % 4` of group `i / 4`. When `n` isn't a multiple of 4, the last group's spare lanes are
//! **identity transforms**: every SoA operation computes them (identity keeps them finite, so no
//! NaN or denormal slows a lane down), and nothing ever reads them back — [`unpack_pose`] and
//! [`local_to_model`] stop at bone `n − 1`. Blending identity with identity stays identity, so
//! later passes (T12) keep the padding valid without masking.

use crate::transform::{AosTransform, SoaTransform};

/// Lanes per SoA group.
pub const LANES: usize = 4;

/// The parent index of a root bone in a parent array.
pub const NO_PARENT: u16 = u16::MAX;

/// SoA groups needed for `bone_count` bones: ⌈bone_count / 4⌉.
#[inline(always)]
pub const fn soa_len(bone_count: usize) -> usize {
    bone_count.div_ceil(LANES)
}

/// Transposes an AoS pose into SoA groups, padding spare lanes with identity.
/// Panics unless `soa.len() == soa_len(aos.len())`. Never allocates.
#[inline]
pub fn pack_pose(aos: &[AosTransform], soa: &mut [SoaTransform]) {
    assert_eq!(soa.len(), soa_len(aos.len()), "SoA pose length");
    for (g, group) in soa.iter_mut().enumerate() {
        let lanes: [AosTransform; 4] =
            core::array::from_fn(|l| aos.get(g * LANES + l).copied().unwrap_or_default());
        *group = SoaTransform::from_aos(&lanes);
    }
}

/// Transposes SoA groups back into an AoS pose of `aos.len()` bones; padding lanes are dropped.
/// Panics unless `soa.len() == soa_len(aos.len())`. Never allocates.
#[inline]
pub fn unpack_pose(soa: &[SoaTransform], aos: &mut [AosTransform]) {
    assert_eq!(soa.len(), soa_len(aos.len()), "SoA pose length");
    for (g, chunk) in aos.chunks_mut(LANES).enumerate() {
        let lanes = soa[g].to_aos();
        chunk.copy_from_slice(&lanes[..chunk.len()]);
    }
}

/// Local to model space: `model[i] = model[parents[i]] ∘ local[i]`, or `local[i]` for a root
/// (`parents[i] == NO_PARENT`). Composition is [`TransformT::compose`](crate::TransformT::compose)
/// (TRS, no shear).
///
/// **Order guarantee:** every bone's parent comes before it (`parents[i] < i` or `NO_PARENT`), which
/// `myco.skel@1` skeletons must guarantee (parents first, as ozz and ACL order them). One forward pass is then enough,
/// even when a parent sits in the same SoA group. A parent index that breaks the rule is a bug in
/// the skeleton: debug builds panic on it; release builds read whatever `model` held there (no
/// undefined behaviour) or panic if it is out of range.
///
/// `parents.len()` is the bone count; `local` holds `soa_len(n)` groups and `model` `n` entries.
/// Never allocates.
#[inline]
pub fn local_to_model(parents: &[u16], local: &[SoaTransform], model: &mut [AosTransform]) {
    let n = parents.len();
    assert_eq!(local.len(), soa_len(n), "SoA pose length");
    assert_eq!(model.len(), n, "model pose length");
    for (g, group) in local.iter().enumerate() {
        let lanes = group.to_aos();
        for (l, lt) in lanes.iter().enumerate() {
            let i = g * LANES + l;
            if i >= n {
                break;
            }
            let p = parents[i];
            model[i] = if p == NO_PARENT {
                *lt
            } else {
                debug_assert!((p as usize) < i, "bone {i}: parent {p} must come before it");
                model[p as usize].compose(*lt)
            };
        }
    }
}
