//! Feature `graph`: graph assets and their instance state: parameters, requests, slot plays, linked-graph selections (wire family `graph`).
//!
//! Seam (T02); filled by T31.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
