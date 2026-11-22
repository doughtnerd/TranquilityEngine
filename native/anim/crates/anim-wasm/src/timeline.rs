//! Feature `timeline`: timeline programs and their sampling (wire family `timeline`).
//!
//! Seam (T02); filled by T22r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
