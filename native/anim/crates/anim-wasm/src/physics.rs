//! Feature `physics`: physical-animation drive-target outputs (wire family `physics`).
//!
//! Seam (T02); filled by T44r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
