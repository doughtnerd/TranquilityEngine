//! Get-up (ADR 0375): which way the fallen pelvis faces, and the get-up state that picks.
//!
//! The pelvis's front axis (out of the belly, [`FrontAxis`]) turned by the simulated pelvis
//! rotation, against model-space up (+Y): pointing up means the character lies on its back
//! ([`Facing::Up`]: the get-up-from-back state), otherwise on its front ([`Facing::Down`]). The
//! ragdoll plugin then captures the physical pose into a pose snapshot (the `physics` family's
//! capture) and travels to the state, which blends from the snapshot (PuppetMaster and Unreal's
//! get-up pattern).

use crate::desc::FrontAxis;
use anim_math::AosQuat;

/// Which way a lying character faces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Facing {
    /// On its back: the belly points up.
    Up = 1,
    /// On its front (or exactly on its side).
    Down = 2,
}

/// The facing of a pelvis with model-space rotation `pelvis` and front axis `front`.
pub fn facing(pelvis: AosQuat, front: FrontAxis) -> Facing {
    let belly = pelvis.normalize_or_identity().rotate(front.vector());
    if belly.y > 0.0 {
        Facing::Up
    } else {
        Facing::Down
    }
}

/// The get-up state for `facing`: `from_back` when it faces up, `from_front` when down.
pub fn getup_state(facing: Facing, from_back: u32, from_front: u32) -> u32 {
    match facing {
        Facing::Up => from_back,
        Facing::Down => from_front,
    }
}
