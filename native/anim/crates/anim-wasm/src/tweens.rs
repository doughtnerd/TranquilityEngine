//! Feature `tweens`: the tween table: Penner easings by name or an engine curve (a curve asset,
//! T70), loops, time scales, a destroyed flag (wire family `tween`, whose docs define the
//! commands, views and timing).
//!
//! The table, its value function and the easings are `myco-tween`'s (`native/common/tween`, ADR
//! 0420 spike), shared with the standalone tween module; this module is the core's side of it: the
//! table's share of `init`'s memory, and the asset arena as the table's curve lookup (curve assets
//! are arena handles, T70).

use anim_sample::curve::Key;
use anim_wire::core::Init;
use anim_wire::tween::DEFAULT_MAX_TWEENS;

pub use myco_tween::{Curves, Eval, Spec, Tweens, MAX_TWEENS};

use crate::assets::Arena;

/// The memory this feature needs for `init`'s parameters, in bytes (summed by [`crate::init`]):
/// the default table, its value rows and its change records.
pub(crate) fn bytes_needed(_init: &Init) -> u64 {
    Tweens::bytes_for(DEFAULT_MAX_TWEENS as usize)
}

/// Curve easings read curve assets from the arena (a released handle, or one that isn't a curve,
/// eases linearly).
impl Curves for Arena {
    #[inline]
    fn curve(&self, handle: u32) -> Option<&[Key<f32>]> {
        Arena::curve(self, handle).ok()
    }
}
