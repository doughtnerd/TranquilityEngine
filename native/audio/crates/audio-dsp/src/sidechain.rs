//! Sidechain kernels for ducking (ADR 0171 amended by 0172 §3.8; architecture §4.6):
//! - the **detector**, per sample: peak (instant attack, 10 ms release) or RMS (10 ms one-pole);
//! - the **gain computer**, per quantum: depth = clamp((level dB − threshold) / 6 dB, 0, 1) and
//!   goal = 1 − depth × (1 − amount), a 6 dB knee;
//! - the **follower**: the duck gain approaches the goal with the rule's attack (falling) and
//!   release (rising) as 63 % one-pole time constants, interpolated per sample (spike S4: within
//!   0.024 dB of a per-sample computer).
//!
//! **Who fills it.** Dp1 (M5-0) may put the follower here for presence mode; Sc1 (M5c) the detector
//! and the gain computer, called from `audio-core`'s `duck.rs`. Empty until then (K1 declares it).
//!
//! Rules as for every module of this crate: transcendentals through `libm`; nothing allocates.
