//! The generator (lead-owned): schema tables to Rust and TypeScript.
//!
//! * `layout`: resolves a field list to offsets, validates the schema, builds the item IR.
//! * `codec`: an interpretive encoder over the schema (used by the vectors and the self-checks).
//! * `rust`: emits `src/generated.rs` (constants, enums, error codes, per-record readers and writers,
//!   the STATUS reader and writer, `SCHEMA_HASH`).
//! * `ts`: emits `wire.generated.ts` (constants, packers, readers, `readStatus`, `SCHEMA_HASH`).
//! * `vectors`: emits `vectors/wire.json` from `cases::cases()`.

pub mod codec;
pub mod layout;
pub mod rust;
pub mod ts;
pub mod vectors;

#[cfg(test)]
mod tests;

use crate::model::Schema;
use std::path::{Path, PathBuf};

/// One generated file: its path (relative to the repository root) and contents (LF line endings).
pub struct Output {
    pub path: PathBuf,
    pub contents: String,
}

/// Paths of the outputs relative to the repository root.
pub const RUST_OUT: &str = "native/audio/crates/audio-wire/src/generated.rs";
pub const TS_OUT: &str = "src/plugins/audio/runtime/wire.generated.ts";
pub const VECTORS_OUT: &str = "native/audio/crates/audio-wire/vectors/wire.json";

/// Validate `schema`, then run every emitter; `hash_hex` is embedded in both outputs.
pub fn generate(schema: &Schema, hash_hex: &str, cases: &[crate::vector::VectorCase]) -> Result<Vec<Output>, String> {
    layout::validate(schema)?;
    Ok(vec![
        Output { path: RUST_OUT.into(), contents: rust::emit(schema, hash_hex)? },
        Output { path: TS_OUT.into(), contents: ts::emit(schema, hash_hex)? },
        Output { path: VECTORS_OUT.into(), contents: vectors::emit_json(cases)? },
    ])
}

/// The real schema and the real vectors.
pub fn generate_all() -> Result<Vec<Output>, String> {
    generate(&crate::schema::schema(), &crate::schema::schema_hash_hex(), &crate::cases::cases())
}

fn lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Write the outputs under `root`, or with `check` compare and return the stale paths (missing files
/// count as stale; line endings are ignored).
pub fn write_or_check(root: &Path, outputs: &[Output], check: bool) -> Result<Vec<PathBuf>, String> {
    let mut stale = Vec::new();
    for o in outputs {
        let path = root.join(&o.path);
        let current = std::fs::read_to_string(&path).ok().map(|s| lf(&s));
        if current.as_deref() == Some(o.contents.as_str()) {
            continue;
        }
        if check {
            stale.push(o.path.clone());
        } else {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            std::fs::write(&path, &o.contents).map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    Ok(stale)
}
