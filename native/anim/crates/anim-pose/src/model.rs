//! Local to model space and the skinning matrices.
//!
//! The skinning matrix of bone `i` is `model[i] * inverse_bind[i]` (the model-space transform
//! times the inverse of the bind pose's model-space transform), row-major 3x4, 12 floats per bone
//! at offset `12 * i` (decision D10): `p_skinned = M * [p_bind_model, 1]`.

use anim_math::layout::{local_to_model, soa_len};
use anim_math::{AosMat3x4, AosTransform, SoaTransform};

/// Local to model space: `model[i] = model[parent] ∘ local[i]` (see `anim_math::layout`). Parents
/// must come before children. `parents.len()` is the bone count; `local` holds `soa_len(n)`
/// groups and `model` `n` entries. Never allocates.
#[inline]
pub fn model_space(parents: &[u16], local: &[SoaTransform], model: &mut [AosTransform]) {
    local_to_model(parents, local, model);
}

/// The exact affine inverse of each bind-pose model transform, to store once at load. A singular
/// bind transform (a zero scale) gives identity.
#[inline]
pub fn inverse_bind_matrices(bind_model: &[AosTransform], out: &mut [AosMat3x4]) {
    assert_eq!(bind_model.len(), out.len(), "bone count");
    for (o, b) in out.iter_mut().zip(bind_model) {
        *o = AosMat3x4::from_transform(*b).inverse_or(AosMat3x4::identity());
    }
}

/// `out[12 * i..12 * i + 12] = from_transform(model[i]) * inverse_bind[i]`. Panics unless
/// `model.len() == inverse_bind.len()` and `out.len() == 12 * model.len()`. Never allocates.
#[inline]
pub fn skinning_from_model(model: &[AosTransform], inverse_bind: &[AosMat3x4], out: &mut [f32]) {
    assert_eq!(model.len(), inverse_bind.len(), "bone count");
    assert_eq!(out.len(), 12 * model.len(), "12 floats per bone");
    for ((m, ib), o) in model
        .iter()
        .zip(inverse_bind)
        .zip(out.as_chunks_mut::<12>().0)
    {
        *o = AosMat3x4::from_transform(*m).mul_rows(*ib).m;
    }
}

/// [`model_space`] then [`skinning_from_model`] for the bones `needed` marks only (T70: a server
/// World's gameplay bones). A needed bone's ancestors must be marked too; the model transforms and
/// matrix rows of other bones are left as they are. The needed bones get bit-identical results to
/// the full functions. Panics on the lengths [`skinning_matrices`] checks, or unless
/// `needed.len() == parents.len()`. Never allocates.
pub fn skinning_matrices_subset(
    parents: &[u16],
    local: &[SoaTransform],
    inverse_bind: &[AosMat3x4],
    needed: &[bool],
    model: &mut [AosTransform],
    out: &mut [f32],
) {
    let n = parents.len();
    assert_eq!(local.len(), soa_len(n), "SoA pose length");
    assert_eq!(needed.len(), n, "one flag per bone");
    assert_eq!(model.len(), n, "model pose length");
    assert_eq!(inverse_bind.len(), n, "bone count");
    assert_eq!(out.len(), 12 * n, "12 floats per bone");
    for (i, &want) in needed.iter().enumerate() {
        if !want {
            continue;
        }
        let lt = local[i / 4].lane(i % 4);
        let p = parents[i];
        model[i] = if p == anim_math::layout::NO_PARENT || p as usize >= i {
            lt
        } else {
            model[p as usize].compose(lt)
        };
        let o: &mut [f32; 12] = (&mut out[12 * i..12 * i + 12]).try_into().unwrap();
        *o = AosMat3x4::from_transform(model[i])
            .mul_rows(inverse_bind[i])
            .m;
    }
}

/// Local pose to skinning matrices: [`model_space`] into the scratch `model` (which holds the
/// model-space transforms afterwards), then [`skinning_from_model`] into `out`.
///
/// Panics unless `local.len() == soa_len(parents.len())`, `model.len()` and `inverse_bind.len()`
/// equal `parents.len()` and `out.len() == 12 * parents.len()`. Never allocates.
#[inline]
pub fn skinning_matrices(
    parents: &[u16],
    local: &[SoaTransform],
    inverse_bind: &[AosMat3x4],
    model: &mut [AosTransform],
    out: &mut [f32],
) {
    assert_eq!(local.len(), soa_len(parents.len()), "SoA pose length");
    model_space(parents, local, model);
    skinning_from_model(model, inverse_bind, out);
}
