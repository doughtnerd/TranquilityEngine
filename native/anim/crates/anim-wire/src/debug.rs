//! Family `debug`: debug records: transition blockers, request lifetimes and node weights for the graph debugger (ADR 0342, 0343).
//!
//! No records yet (T02 seam). T31 declares them here with `wire_record!`, lists them in
//! `FAMILY.records` and their vectors in `vectors()`, and bumps `VERSION` when a layout changes.

use crate::record::FamilyDesc;
use crate::vector::Vector;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 10;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    Vec::new()
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "debug",
    id: ID,
    version: VERSION,
    doc: "Wire family `debug`: debug records: transition blockers, request lifetimes and node weights for the graph debugger (ADR 0342, 0343).",
    records: &[],
    consts: &[],
    vectors,
};
