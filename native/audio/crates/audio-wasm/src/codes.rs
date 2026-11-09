//! `i32` results of the C ABI (api-and-models §5): 0 is ok, failures are negative.
//!
//! The codes are defined once, in `audio-wire`'s schema (contract K1), and generated for Rust and
//! TypeScript. The names here are the ABI's own words for them.

use audio_wire::generated as wire;

pub const OK: i32 = wire::ERR_OK;
/// The export exists (contract K2) but its body lands in a later task.
pub const NOT_IMPLEMENTED: i32 = wire::ERR_NOT_IMPLEMENTED;
/// Called before `myco_audio_init` (or after `myco_audio_dispose`).
pub const NOT_INITIALIZED: i32 = wire::ERR_BAD_STATE;
/// `myco_audio_init` called twice without `myco_audio_dispose` between.
pub const ALREADY_INITIALIZED: i32 = wire::ERR_BAD_STATE;
/// A parameter is out of range.
pub const INVALID_ARGUMENT: i32 = wire::ERR_BAD_ARG;
/// `memory.grow` failed (the memory's `maximum` was reached).
pub const OUT_OF_MEMORY: i32 = wire::ERR_ARENA_FULL;
