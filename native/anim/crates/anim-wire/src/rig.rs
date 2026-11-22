//! Family `rig`: rig stack inputs and outputs: IK target transforms, grounder ray requests and their hits, per-entry weights (ADR 0340).
//!
//! No records yet (T02 seam). T40 declares them here with `wire_record!`, lists them in
//! `FAMILY.records` and their vectors in `vectors()`, and bumps `VERSION` when a layout changes.

use crate::record::FamilyDesc;
use crate::vector::Vector;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 4;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    Vec::new()
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "rig",
    id: ID,
    version: VERSION,
    doc: "Wire family `rig`: rig stack inputs and outputs: IK target transforms, grounder ray requests and their hits, per-entry weights (ADR 0340).",
    records: &[],
    consts: &[],
    vectors,
};
