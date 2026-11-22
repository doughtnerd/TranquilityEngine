//! Feature `retarget`: retarget maps and `guess_bone_map`.
//!
//! Seam (T02); filled by T41.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
