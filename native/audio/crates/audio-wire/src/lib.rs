//! `audio-wire`: the Myco audio core wire format (ADR 0157 section 4, contract K1).
//!
//! One schema (`schema`, data built from `model` types) generates the Rust readers and writers in
//! `generated` and the TypeScript in `src/plugins/audio/runtime/wire.generated.ts`, via the
//! `gen_wire` binary (`gen`). `vector` and `cases` hold the byte vectors both sides are tested
//! against. Std only; self-contained (no workspace-inherited keys).
//!
//! Regenerate: `cargo run --manifest-path native/audio/crates/audio-wire/Cargo.toml --bin gen_wire`
//! (add `-- --check` to fail on stale output instead of writing it).

pub mod gen;
pub mod generated;
pub mod model;
pub mod schema;
pub mod sha256;
pub mod vector;

/// Hand-computed byte vectors (A0.2-L4); `vectors/` is the crate's vector directory.
#[path = "../vectors/cases.rs"]
pub mod cases;

/// ADR 0162's byte vectors (leaf L-A1a), chained into `cases::cases()`.
#[path = "../vectors/spatial_cases.rs"]
pub mod spatial_cases;

pub use schema::{schema, schema_hash, schema_hash_hex};
