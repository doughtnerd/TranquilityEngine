//! Feature `debug`: graph debug records for the editor (wire family `debug`).
//!
//! Seam (T02); filled by T31.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
