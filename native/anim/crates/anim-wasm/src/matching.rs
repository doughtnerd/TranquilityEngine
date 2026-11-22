//! Feature `matching`: pose databases and motion-matching state (wire family `match`; `match` is a Rust keyword).
//!
//! Seam (T02); filled by T42.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
