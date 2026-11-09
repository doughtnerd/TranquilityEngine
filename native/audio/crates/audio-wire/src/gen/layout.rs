//! Layout resolution and schema validation (lead-owned, A0.2-GEN).

use crate::model::*;

/// A field with its resolved byte offset (from the start of its record, body or message).
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub field: Field,
    pub offset: u32,
}

/// Assign offsets in order, honouring `Field::at`; error on overlap or misalignment (a field is
/// aligned to its type's size). Returns the placed fields and the end offset.
pub fn resolve(_start: u32, _fields: &[Field]) -> Result<(Vec<Placed>, u32), String> {
    todo!("A0.2-GEN")
}

/// Validate the whole schema: kind and opcode ids and names unique, `total_bytes` equal to the
/// computed size, the STATUS header exactly `header_bytes` with section count fields present, every
/// `Repeat::count_field` and `Section::count_field` resolving, error codes negative.
pub fn validate(_schema: &Schema) -> Result<(), String> {
    todo!("A0.2-GEN")
}
