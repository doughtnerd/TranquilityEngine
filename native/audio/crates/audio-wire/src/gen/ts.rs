//! TypeScript emitter (lead-owned, A0.2-GEN): writes `wire.generated.ts`.
//!
//! Planned surface: `export const` for constants and offsets, `export enum`-like const objects,
//! error codes, `packEnvelope`, one `pack<Record>` per opcode/kind into a `DataView`/`Uint8Array`,
//! a `BatchBuilder`-free low-level `writeRecordHead`, `readStatus(buffer): StatusBlock`,
//! and `SCHEMA_HASH` (32 hex chars).

use crate::model::Schema;

pub fn emit(_schema: &Schema, _hash_hex: &str) -> String {
    todo!("A0.2-GEN")
}
