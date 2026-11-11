//! Reverb zones (ADR 0162, api-and-models §5.2, architecture §4.4, contract C5 ZONE_CONFIG): the
//! fixed `Zones` region of convolver slots, the ZONE_CONFIG table and slot state machine (off,
//! waiting for kernel, fading in, active, ringing out, evicting), the return buses (`add_returns`,
//! called from `bus.rs`'s pre-effects input hook), the shared-return scale and the STATUS zone
//! slots.
//!
//! Skeleton declared by K2 (task A1); K2 adds the stub record handler and the `add_returns` hook
//! (a no-op), task C3 fills it, C4 adds the inputs and C3b the in-core IR preparation.
