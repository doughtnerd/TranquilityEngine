//! Exact maths, hashing and fingerprints for Myco's navigation (ADR 0065): Foxfire's
//! `NavExactMath`, `NavHash` and `NavMeshFingerprint`, and the vector types its data uses.
// The maths copies Foxfire's C# literals digit for digit (they're what the bakes were written against),
// rather than the standard library's constants.
#![allow(clippy::approx_constant, clippy::excessive_precision)]

pub mod exact;
pub mod hash;
pub mod math;
pub mod vec;

pub use hash::{Hash128, Pod};
pub use math::{Float3x3, Float4x4};
pub use vec::{Double2, Double3, Float2, Float3, Float4, Int2, Int3, Int4};
