//! `myco-wire` (ADR 0424 spike): the boundary-record mechanism of Myco's wasm cores, defined once.
//!
//! Moved out of `anim-wire` (where it was `record` and `vector`) so a family can live in a crate
//! of its own: `myco-tween` holds the `tween` family and `anim-wire` re-exports it, which needs the
//! mechanism below both. Nothing here changed in the move except `std` → `core` + `alloc`.
//!
//! - [`record`]: fixed-stride, little-endian, versioned rows, declared with [`wire_record!`];
//! - [`vector`]: byte vectors for the round-trip tests.
//!
//! The TypeScript generator stays with the family table that lists the families (`anim-wire`'s
//! `gen`). `no_std` with `alloc` (vectors and [`WireRecord::encode`] allocate; encode and decode
//! into caller buffers never do). No dependencies.

#![no_std]

extern crate alloc;

#[doc(hidden)]
pub extern crate alloc as __alloc;

pub mod record;
pub mod vector;

pub use record::{
    opcode, Const, FamilyDesc, RecordDesc, Scalar, Value, WireError, WireRecord, WireScalar,
};
pub use vector::Vector;
