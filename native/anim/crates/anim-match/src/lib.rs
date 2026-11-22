//! `anim-match` (ADR 0340): motion matching. Feature extraction and normalisation, a KD-tree plus
//! brute-force SIMD search over the pose database, trajectory prediction, inertialization
//! blending. Baking the database also lives here.
//!
//! The graph's `matching` node family (`anim-graph::matching`) calls it.
//! Tested against `anim-offline::matching`.
//!
//! Stub (T02). Filled by T42.
