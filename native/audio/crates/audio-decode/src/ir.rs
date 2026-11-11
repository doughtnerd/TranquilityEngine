//! Impulse-response preparation in the decoder worker (ADR 0162, api-and-models §5.2, contract C9):
//! `myco_ir_prepare` (decode, mix to two channels or duplicate mono, resample, trim the tail under
//! -80 dBFS, cut with a 50 ms fade, normalise, partition, transform) and `myco_ir_generate` (the
//! seeded zone presets), with `myco_ir_blob_ptr/len`. The blob equals the core's `prepare_ir`.
//!
//! Skeleton declared by K2 (task A1); task C2a fills it.
