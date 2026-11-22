//! `anim-math` (ADR 0340): SoA quaternion, vector and transform maths on `glam` with
//! `core::arch::wasm32` `simd128` (4 lanes).
//!
//! Deterministic rules, as in nav: no `mul_add`, no relaxed SIMD, no libm trig in hot paths. The
//! f64 scalar reference is `anim-offline::math`; tests compare the two with stated tolerances.
//!
//! Stub (T02). Filled by T10.
