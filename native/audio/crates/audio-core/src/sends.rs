//! Voice sends (ADR 0162, api-and-models §4.4 and §5.1 build-plan additions, contracts C1, C5 and
//! C17): the pre-distance zone send tap ([`tap`], called from `voices.rs`, K3) feeding the zone
//! inputs, the post-fader aux tap ([`tap_aux`], also from `voices.rs`) and the aux add into a bus
//! ([`add_aux`], from `bus.rs`'s pre-effects input hook), all scaled by the bus-chain gain of
//! `chain.rs`.
//!
//! Skeleton declared by K2 (task A1: `add_aux`) and K3 (task D1: [`begin_quantum`], [`tap`],
//! [`tap_aux`] and their call sites in `voices.rs`). Every body is a no-op; task C4 fills them
//! without touching `voices.rs` or `bus.rs`.
//!
//! **Where the hooks run** (architecture §4, R11 as clarified, C17), for a mixed voice whose pool
//! entry (`fxpool.rs`) has a zone send that isn't settled at 0:
//! 1. resample; 2. fade and mix ramps, automation `gainMul`; 3. the voice's own filters (low-pass
//!    `min(lpHz, lpAuto)`, high-pass; mono-once); 4. **[`tap`]**; 5. the dry `gain` ramp;
//!    6. **[`tap_aux`]** (when the entry has an aux bus); 7. the panner; 8. into the bus.
//!
//! A voice with no zone send keeps M2's order (the dry `gain` with the fade and mix, then
//! `gainMul`, then the filters), so every M2 golden stays bit-identical; it still calls
//! [`tap_aux`] after its filters when it has an aux bus (post-fader either way). Voices without a
//! pool entry (virtual voices, or a mixed voice past a full pool) call neither hook.

use audio_dsp::ramp::Ramp;

use crate::core::Core;
use crate::panner::PannerState;

/// Once per quantum, before any voice renders (`voices::render`, right after
/// `automation::begin_quantum`, so the buses' automation `gainMul` for this quantum is known):
/// where C4 computes each bus's chain gain to the root (`chain::fill`) for the taps. K3: a no-op.
#[inline]
pub fn begin_quantum(core: &mut Core) {
    let _ = core;
}

/// The zone send tap (step 4): `l`, `r` are frames `from..from + l.len()` of the quantum of a mixed
/// voice on `bus`, after its own filters and before its dry gain (a mono voice has the same samples
/// in both). `send` is the voice's four send ramps (SET_VOICE_FX `send[k]`, ramped over its
/// `rampFrames`), which the tap advances one step per frame. `zones` is the `Zones` region, where
/// the slot inputs live. C4: `send[k] × mono sum × chain gain` into slot `k`'s input. K3: a no-op
/// (the ramps don't move).
#[inline]
pub fn tap(send: &mut [Ramp; 4], zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32]) {
    let _ = (send, zones, bus, from, l, r);
}

/// The aux tap (step 6): `l`, `r` as in [`tap`] but after the dry gain (post-fader) and before the
/// panner; `aux` is the aux level ramp and `aux_bus` its bus (never `AUX_BUS_NONE`: the caller skips
/// those); `panner` is the voice's panner state, for C4's equal-power pan. C4 keeps the signal for
/// `bus::mixdown`'s [`add_aux`]. K3: a no-op.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn tap_aux(aux: &mut Ramp, aux_bus: u16, zones: &mut [u8], bus: u16, from: usize, l: &[f32], r: &[f32], panner: &PannerState) {
    let _ = (aux, aux_bus, zones, bus, from, l, r, panner);
}

/// The pre-effects input hook (`bus::mixdown`): adds this quantum's aux sends aimed at `bus` into
/// its input `l`, `r`. `fx` is the mixed-voice pool's region, where the sends' state lives. K2: a
/// no-op (no voice sends before C4).
#[inline]
pub fn add_aux(fx: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let _ = (fx, bus, l, r);
}
