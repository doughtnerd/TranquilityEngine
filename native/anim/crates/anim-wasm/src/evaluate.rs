//! Feature `evaluate`: the per-frame calls: `write_inputs` (blackboard rows, Animator fields, IK targets, raycast hits into input views), `evaluate(world, dt_scaled, dt_unscaled)` over every due instance, and the output views (3×4 bone matrices, root-motion deltas, property outputs, notify and state-change records, grounder ray requests). Never allocates.
//!
//! Seam (T02); filled by T13r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
