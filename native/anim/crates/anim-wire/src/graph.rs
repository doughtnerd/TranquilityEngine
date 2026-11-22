//! Family `graph`: graph inputs and state: blackboard parameter rows, requests, slot plays, linked-graph selections and state-change records (ADR 0342).
//!
//! No records yet (T02 seam). T31 declares them here with `wire_record!`, lists them in
//! `FAMILY.records` and their vectors in `vectors()`, and bumps `VERSION` when a layout changes.

use crate::record::FamilyDesc;
use crate::vector::Vector;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 3;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    Vec::new()
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "graph",
    id: ID,
    version: VERSION,
    doc: "Wire family `graph`: graph inputs and state: blackboard parameter rows, requests, slot plays, linked-graph selections and state-change records (ADR 0342).",
    records: &[],
    consts: &[],
    vectors,
};
