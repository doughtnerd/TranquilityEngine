//! Voice sends (ADR 0162, api-and-models §5.1 build-plan additions, contracts C1 and C5): the
//! pre-distance send tap (`tap`, called from `voices.rs`, K3) feeding the zone inputs, and the one
//! aux send (`add_aux`, called from `bus.rs`'s pre-effects input hook), both scaled by the
//! bus-chain gain of `chain.rs`.
//!
//! Skeleton declared by K2 (task A1); K2 adds the `add_aux` hook (a no-op), task C4 fills it.
