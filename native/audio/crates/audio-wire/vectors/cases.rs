//! A0.2-L4: byte vectors, one or more per record of ADR 0157 section 4, with the expected bytes derived
//! by hand from the spec tables (see `crate::vector` for the value conventions per subject).
//! Fill `cases()` and the ignored test in `tests/vectors.rs`.
//!
//! Coverage required: the envelope; every kind; every opcode (LISTENER excepted: it is never sent);
//! PLAY with the `panner` bits at 0, 1 and 2; SET_PARAMS with a panner change; asap and stamped
//! `frameOffset`; a BATCH and a REPLAY (first chunk with RESET, last chunk flag); BUS_CONFIG with two
//! buses and mixed effects; the HRIR header; a STATUS message with every header field set to a
//! distinct value, every flag bit, and every section non-empty.

use crate::vector::VectorCase;

/// A0.2-L4: fill.
pub fn cases() -> Vec<VectorCase> {
    Vec::new()
}
