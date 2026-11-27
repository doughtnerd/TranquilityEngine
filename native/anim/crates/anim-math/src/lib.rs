//! `anim-math` (ADR 0370): SoA quaternion, vector and transform maths for the pose pipeline, with
//! `core::arch::wasm32` `simd128` (4 lanes) on the web and glam types at the AoS boundary.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! # Shape
//!
//! - [`F32x4`] is the lane type: a `v128` on `wasm32` + `simd128`, a portable `[f32; 4]`
//!   elsewhere (native `cargo test`, benches, the offline tools).
//! - Every formula is written once over the [`Lane`] trait, which `f32` and `F32x4` implement.
//!   So [`SoaVec3`]/[`SoaQuat`]/[`SoaTransform`]/[`SoaMat3x4`] (four bones per value) and
//!   [`AosVec3`]/[`AosQuat`]/[`AosTransform`]/[`AosMat3x4`] (one bone, scalar `f32`) share their
//!   code and agree bit for bit, lane for lane.
//! - [`layout`] transposes whole poses (with identity padding) and runs local→model;
//!   [`quant`] packs and unpacks N-bit unorms; [`trig`] has deterministic `sin_cos`/`atan2`/`exp2` (the Penner easings moved to `myco-tween`, ADR 0424 spike).
//! - glam is the AoS interchange type (`From` between `glam::Vec3`/`glam::Quat` and the AoS
//!   types). glam's own arithmetic is not used: its SSE2, `simd128` and scalar backends order
//!   some operations differently, which would break the rules below.
//!
//! # Determinism rules
//!
//! The same inputs give the same bits on every target (wasm in V8, JavaScriptCore and
//! SpiderMonkey, and native x86-64/aarch64), so client and server agree on root motion (ADR 0370).
//!
//! 1. Only correctly rounded IEEE-754 binary32 operations (`+ − × ÷ √`) and exact ones (negate,
//!    abs, floor, round-to-even, compare, bitwise select, u32→f32 below 2^24).
//! 2. **No fused multiply-add**: no `mul_add`, and Rust never contracts `a * b + c` on its own.
//! 3. **No relaxed SIMD** (`relaxed_*` instructions differ between engines), only `simd128`.
//! 4. **No libm** in this crate (`sin`, `cos`, `acos`, `atan2`, `exp`… differ between platforms):
//!    trigonometry is [`trig`]'s fixed polynomials.
//! 5. A fixed evaluation order, spelled out in each function's docs (dot products sum left to
//!    right; a portable lane runs exactly the scalar operation of the SIMD lane).
//! 6. `min`/`max` are wasm's pseudo-min/max (`pmin`/`pmax`), defined by one comparison, so NaN and
//!    signed zeros behave the same everywhere.
//!
//! NaN *payloads* may differ between backends; a NaN is never produced from finite inputs except
//! where a function documents it.
//!
//! # Allocation
//!
//! Nothing in this crate allocates. Pose-level functions ([`layout`]) take caller-owned slices.

mod f32x4;
mod lane;
pub mod layout;
mod mat;
pub mod quant;
mod quat;
mod transform;
pub mod trig;
mod vec3;

pub use f32x4::{F32x4, M32x4};
pub use lane::{Lane, LaneMask};
pub use mat::{AosMat3x4, Mat3x4T, SoaMat3x4, DET_EPSILON};
pub use quat::{AosQuat, QuatT, SoaQuat};
pub use transform::{AosTransform, SoaTransform, TransformT, SCALE_EPSILON};
pub use vec3::{AosVec3, SoaVec3, Vec3T, NORMALIZE_EPSILON_SQ};
