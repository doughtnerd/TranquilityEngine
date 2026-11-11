//! Per-voice effect filters (ADR 0162, api-and-models §5.1, contract C3): a low-pass and high-pass
//! pair over `Biquad` with log-Hz ramped cutoffs, run once on the mono signal before panning
//! (occlusion, `lpHz` for every voice).
//!
//! Skeleton declared by K2 (task A1); task D1 fills it. Nothing allocates while processing.
