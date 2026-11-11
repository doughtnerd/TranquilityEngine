//! The listener's orientation in the core (ADR 0162, api-and-models §4.2, contract C4 LISTENER):
//! the world-to-listener rotation applied to ambisonic voices and beds, slerped per quantum over
//! `rampFrames` (or jumped to on a snap). Axis map: `(X, Y, Z)_ambix = (-z, -x, +y)_engine`.
//!
//! Skeleton declared by K2 (task A1): a LISTENER handler that takes the parsed record and drops it,
//! and `reset` (a no-op). Task B3 fills it.

use audio_wire::generated::Listener;

use crate::core::Core;

/// LISTENER (C4, asap). K2: dropped; B3 normalises the quaternion (ignoring a non-finite or zero
/// one) and ramps to it.
pub fn set(core: &mut Core, l: &Listener) {
    let _ = (core, l);
}

/// RESET (§4.2: "RESET clears … the listener"). K2: a no-op.
pub fn reset(core: &mut Core) {
    let _ = core;
}
