//! Feature `assets`: the pooled asset arena. Clips, skeletons, compiled graphs and pose databases
//! are copied in on load and released when the asset is released, or between editor play sessions.
//! Growth happens only in load calls, never inside `evaluate`.
//!
//! Seam (T02); filled by T13r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the arena's first size.
pub(crate) fn bytes_needed(init: &Init) -> u64 {
    init.arena_initial_bytes as u64
}
