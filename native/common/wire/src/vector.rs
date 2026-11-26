//! Byte vectors: a record's values with the bytes Rust encodes them to. The generator writes each
//! family's vectors to `crates/anim-wire/vectors/<family>.json`; the Vitest round-trip test
//! (`src/plugins/animation/runtime/wasm/wire.roundtrip.test.ts`) decodes the bytes with the
//! generated constants and encodes the values back, so both sides agree on every layout.

use alloc::vec::Vec;

use crate::record::{Value, WireRecord};

/// One case.
#[derive(Clone, Debug)]
pub struct Vector {
    /// Unique within its family.
    pub name: &'static str,
    /// The record's Rust name (the generator writes its TypeScript name).
    pub record: &'static str,
    /// The fields' values in declaration order.
    pub values: Vec<(&'static str, Value)>,
    /// The encoded record.
    pub bytes: Vec<u8>,
}

impl Vector {
    /// The vector of `record`, encoded by its [`WireRecord`] implementation.
    pub fn of<R: WireRecord>(name: &'static str, record: &R) -> Vector {
        Vector {
            name,
            record: R::DESC.name,
            values: record.values(),
            bytes: record.encode(),
        }
    }
}
