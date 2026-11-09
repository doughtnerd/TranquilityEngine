//! Rust emitter (lead-owned, A0.2-GEN): writes `src/generated.rs`.
//!
//! Planned surface: `pub const` for every schema constant; `pub mod kind`, `pub mod op`;
//! one `#[repr]`-free plain struct per record with `write(&self, out: &mut [u8]) -> usize` and
//! `read(&[u8]) -> Result<Self, i32>` (error codes from `ERRORS`); `Envelope`, `BatchHeader`,
//! `RecordHead`; `StatusWriter`/`StatusView`; `SCHEMA_HASH: [u8; 16]`.

use crate::model::Schema;

pub fn emit(_schema: &Schema, _hash_hex: &str) -> String {
    todo!("A0.2-GEN")
}
