//! Family `tracks`: track outputs: a value column per binding for property tracks, and discrete, event, notify-state, marker, subclip, control and audio records (ADR 0341).
//!
//! No records yet (T02 seam). T20r declares them here with `wire_record!`, lists them in
//! `FAMILY.records` and their vectors in `vectors()`, and bumps `VERSION` when a layout changes.

use crate::record::FamilyDesc;
use crate::vector::Vector;

/// The family id (the opcodes' high byte).
pub const ID: u8 = 2;
/// The family version. Bump it when a record's layout changes.
pub const VERSION: u16 = 1;

/// The family's vectors.
fn vectors() -> Vec<Vector> {
    Vec::new()
}

/// The family.
pub const FAMILY: FamilyDesc = FamilyDesc {
    name: "tracks",
    id: ID,
    version: VERSION,
    doc: "Wire family `tracks`: track outputs: a value column per binding for property tracks, and discrete, event, notify-state, marker, subclip, control and audio records (ADR 0341).",
    records: &[],
    consts: &[],
    vectors,
};
