//! Feature `instances`: the instance table (handles are index plus generation, so a handle to a
//! destroyed Animator is a no-op), per-instance state snapshot and restore, and the LOD fields.
//!
//! Seam (T02); filled by T13r, which replaces the provisional sizes below with the real layout.

use anim_wire::core::Init;

/// Provisional: an instance's fixed state (handle, generation, playheads, LOD) in bytes.
const INSTANCE_BYTES: u64 = 64;
/// Provisional: per bone, a SoA local pose (translation 3, rotation 4, scale 3 floats = 40 bytes),
/// a model-space 3×4 matrix (48) and the output 3×4 bone matrix (48).
const BONE_BYTES: u64 = 40 + 48 + 48;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    let per_instance = INSTANCE_BYTES + init.max_bones as u64 * BONE_BYTES;
    (init.max_instances as u64).saturating_mul(per_instance)
}
