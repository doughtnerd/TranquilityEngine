//! The mixed-voice effect pool (ADR 0162, api-and-models §5.1, architecture "mixed-voice pool",
//! contract C3 SET_VOICE_FX): one filter state per mixed voice (≈ 448 B each, the `Fx` region sized
//! from `max_mixed`), handed to a voice when it becomes mixed and reset when it leaves.
//!
//! Skeleton declared by K2 (task A1); K2 adds the stub record handler, task D1 fills it.
