//! The bus-chain gain to the root (ADR 0162, api-and-models §5.1 build-plan additions): the product
//! of volume × mute × ducking along a bus's path to the master, ramped per quantum. The bed's gain
//! fold (A4) and the voice sends (C4) both use it, so a send follows a ducked or muted bus exactly
//! as the dry path does.
//!
//! Skeleton declared by K2 (task A1); K2 fills it, with its < 0.05 dB test.
