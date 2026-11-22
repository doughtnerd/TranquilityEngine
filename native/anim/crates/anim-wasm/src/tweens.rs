//! Feature `tweens`: the tween table: Penner easings by name, loops, time scales, a destroyed flag (wire family `tween`).
//!
//! Seam (T02); filled by T22r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
