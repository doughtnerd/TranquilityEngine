//! Feature `rig`: rig stack inputs and outputs: IK targets, grounder ray requests and hits (wire family `rig`).
//!
//! Seam (T02); filled by T40.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
