//! `i32` results of the C ABI (api-and-models §5): 0 is ok, failures are negative.
//!
//! TODO(A0.2): these move to `audio-wire/src/schema.rs`, which owns the codes for Rust and the
//! generated TypeScript; audio-wasm then re-exports them from there and this file goes away.
//! Until then the values here are provisional.

pub const OK: i32 = 0;
/// The export exists (contract K2) but its body lands in a later task.
pub const NOT_IMPLEMENTED: i32 = -1;
/// Called before `myco_audio_init` (or after `myco_audio_dispose`).
pub const NOT_INITIALIZED: i32 = -2;
/// `myco_audio_init` called twice without `myco_audio_dispose` between.
pub const ALREADY_INITIALIZED: i32 = -3;
/// A parameter is out of range.
pub const INVALID_ARGUMENT: i32 = -4;
/// `memory.grow` failed (the memory's `maximum` was reached).
pub const OUT_OF_MEMORY: i32 = -5;
