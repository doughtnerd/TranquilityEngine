//! Voice sends (ADR 0162, api-and-models §4.4 and §5.1 build-plan additions, contracts C1 and C5):
//! the pre-distance send tap (`tap`, called from `voices.rs`, K3) feeding the zone inputs, and the
//! one aux send (`add_aux`, called from `bus.rs`'s pre-effects input hook), both scaled by the
//! bus-chain gain of `chain.rs`.
//!
//! Skeleton declared by K2 (task A1): the `add_aux` hook (a no-op). K3 (D1) adds `tap`; task C4
//! fills both.

/// The pre-effects input hook (`bus::mixdown`): adds this quantum's aux sends aimed at `bus` into
/// its input `l`, `r`. `fx` is the mixed-voice pool's region, where the sends' state lives. K2: a
/// no-op (no voice sends before C4).
#[inline]
pub fn add_aux(fx: &mut [u8], bus: usize, l: &mut [f32], r: &mut [f32]) {
    let _ = (fx, bus, l, r);
}
