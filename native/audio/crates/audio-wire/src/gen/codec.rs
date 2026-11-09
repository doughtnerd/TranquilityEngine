//! Interpretive encoder over the schema (lead-owned, A0.2-GEN): the independent path the vectors and
//! the self-checks use. Conventions per subject are in `crate::vector`.

use crate::model::*;
use crate::vector::VectorCase;

/// Encode a vector case to bytes (computed fields filled in).
pub fn encode(_schema: &Schema, _case: &VectorCase) -> Result<Vec<u8>, String> {
    todo!("A0.2-GEN")
}

/// Lower-case hex.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
