//! The baked 16 to 2 ambisonic decode matrix (ADR 0162, api-and-models §5.1 and its build-plan
//! additions): the MagLS order-3 matrix baked offline by `native/audio/tools/bake-magls/` into
//! `src/engine/audio/magls-o3.bin` (format 4) and its loader. Split from `ambisonic.rs` so A2 and
//! A3 never share a file.
//!
//! Skeleton declared by K2 (task A1); task A3 fills it.
