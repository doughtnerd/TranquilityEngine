//! Ambisonic beds (ADR 0162, api-and-models §5.1, architecture §3.1, contract C4 BED_CONFIG): bed
//! slots and their host buses, the encoded-voice pool, panner kind 2 with the equal-power
//! crossfade law, the decode before the host bus's effects (`decode_into`, called from `bus.rs`'s
//! pre-effects input hook), the bus-chain gain fold, RESET and the bed counters.
//!
//! Skeleton declared by K2 (task A1); K2 adds the stub record handler and the `decode_into` hook
//! (a no-op), task A4 fills it and task B3 adds private decoders and `maxClips` stealing.
