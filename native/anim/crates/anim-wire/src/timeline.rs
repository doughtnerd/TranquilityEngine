//! Family `timeline`: timelines: timeline program control and multi-binding track outputs (ADR 0341).
//!
//! No records yet (T02 seam). T22r declares them here with `wire_record!`, lists them in
//! `FAMILY.records` and their vectors in `vectors()`, and bumps `VERSION` when a layout changes.

use crate::record::FamilyDesc;
use crate::vector::Vector;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 7;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    Vec::new()
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "timeline",
    id: ID,
    version: VERSION,
    doc: "Wire family `timeline`: timelines: timeline program control and multi-binding track outputs (ADR 0341).",
    records: &[],
    consts: &[],
    vectors,
};
