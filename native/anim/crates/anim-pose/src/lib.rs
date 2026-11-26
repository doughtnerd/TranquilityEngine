//! `anim-pose` (ADR 0370, 0372): blend, additive, masked layered blend, mirror, local to model
//! space with skinning matrices, root motion, sync-marker phase maths and inertialization.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! # Shape
//!
//! A *pose* is a slice of [`SoaTransform`]s of length [`soa_len`]`(bone_count)`: four bones per
//! value, bone `i` in lane `i % 4` of group `i / 4`, spare lanes of the last group identity
//! (see `anim_math::layout`). Every function writes into a caller-provided output slice and
//! never allocates. The one exception is [`inertialize::Inertializer::new`], which allocates its
//! per-bone state once, at construction.
//!
//! Pose-level functions are generic over `anim_math::Lane`: instantiated with `F32x4` they are
//! the SoA path (a `v128` per component on wasm `simd128`), with `f32` they are the scalar AoS
//! path (one bone per `TransformT<f32>`), and the two agree bit for bit lane for lane, because
//! both run the same operations in the same order (the determinism rules of `anim-math`:
//! no fused multiply-add, no relaxed SIMD, no libm in this crate).
//!
//! # Conventions
//!
//! - Quaternions are `(x, y, z, w)`, Hamilton, `a * b` rotates by `b` first.
//! - Blends take the *shortest path*: `q` and `-q` are the same rotation and are sign-aligned
//!   before they are mixed.
//! - Bone matrices are row-major 3x4, 12 floats per bone (decision D10).
//! - Up is +Y and the default mirror plane has normal +X; both are arguments ([`Axis`]).

// `!(x > 0.0)` is deliberate throughout: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod additive;
pub mod blend;
pub mod inertialize;
pub mod mirror;
pub mod model;
pub mod root;
pub mod sync;

pub use anim_math::layout::{soa_len, LANES, NO_PARENT};
pub use anim_math::{AosMat3x4, AosQuat, AosTransform, AosVec3, F32x4, Lane, SoaTransform};

/// One of the three coordinate axes: a mirror plane's normal, or the up direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Axis {
    #[default]
    X,
    Y,
    Z,
}

/// Bone `i` of an SoA pose as an AoS transform. Panics if `i` is out of range of the groups.
#[inline]
pub fn bone(pose: &[SoaTransform], i: usize) -> AosTransform {
    pose[i / LANES].lane(i % LANES)
}

/// Replaces bone `i` of an SoA pose (the other three bones of its group are unchanged). Panics if
/// `i` is out of range of the groups.
#[inline]
pub fn set_bone(pose: &mut [SoaTransform], i: usize, t: AosTransform) {
    pose[i / LANES].set_lane(i % LANES, t);
}
