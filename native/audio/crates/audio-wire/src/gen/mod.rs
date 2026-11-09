//! The generator (lead-owned): schema tables to Rust and TypeScript.
//!
//! * `layout`: resolves a field list to offsets and checks alignment, sizes and the spec totals.
//! * `codec`: an interpretive encoder over the schema (used by the vectors and the self-checks).
//! * `rust`: emits `src/generated.rs` (constants, enums, error codes, per-record readers and writers,
//!   the STATUS reader, `SCHEMA_HASH`).
//! * `ts`: emits `wire.generated.ts` (constants, offsets, packers, `readStatus`, `SCHEMA_HASH`).
//! * `vectors`: emits `vectors/wire.json` from `cases::cases()`.

pub mod codec;
pub mod layout;
pub mod rust;
pub mod ts;
pub mod vectors;

use std::path::{Path, PathBuf};

/// One generated file: its path (relative to the repository root) and contents.
pub struct Output {
    pub path: PathBuf,
    pub contents: String,
}

/// Paths of the outputs relative to the repository root.
pub const RUST_OUT: &str = "native/audio/crates/audio-wire/src/generated.rs";
pub const TS_OUT: &str = "src/plugins/audio/runtime/wire.generated.ts";
pub const VECTORS_OUT: &str = "native/audio/crates/audio-wire/vectors/wire.json";

/// Run every emitter. A0.2-GEN: validates the schema first (layouts, totals, unique ids and names)
/// and returns an error string naming the first problem.
pub fn generate_all() -> Result<Vec<Output>, String> {
    todo!("A0.2-GEN")
}

/// Write the outputs under `root`, or with `check` compare and return the stale paths.
pub fn write_or_check(_root: &Path, _outputs: &[Output], _check: bool) -> Result<Vec<PathBuf>, String> {
    todo!("A0.2-GEN")
}
