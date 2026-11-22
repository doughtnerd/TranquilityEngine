//! Feature `plugin`: third-party node modules: load, the imported host call, fault reports (wire family `plugin`).
//!
//! Seam (T02); filled by T45.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
