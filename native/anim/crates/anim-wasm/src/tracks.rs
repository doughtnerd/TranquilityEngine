//! Feature `tracks`: property and event track outputs: a value column per binding, discrete, event, notify-state, marker, subclip, control and audio records (wire family `tracks`).
//!
//! Seam (T02); filled by T20r.

use anim_wire::core::Init;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]).
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    0
}
