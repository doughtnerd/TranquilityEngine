//! `anim-rig` (ADR 0340, 0342): the post-process rig stack.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010). The graph's
//! `rig` node family (`anim-graph::rig`) calls these solvers; each node is one rig-stack entry.
//!
//! - IK: [`two_bone`](two_bone::two_bone), [`ccd`](chain::ccd), [`fabrik`](chain::fabrik) and
//!   [`full_body`](full_body::full_body) (a FABRIK-based solver over a tree of chains with
//!   effectors and a centre-of-mass pull);
//! - [`look_at`](aim::look_at) and [`aim`](aim::aim), with limits and weight distribution;
//! - the foot [`grounder`] (ray requests out, the host's hits back in a frame later, ADR 0340);
//! - [`spring`] bones (Verlet, sphere and capsule colliders bound to bones);
//! - copy, limit and damp [`constraints`];
//! - distance, stride, orientation and motion [`warp`]ing.
//!
//! # Shape
//!
//! Every solver works on a [`RigPose`]: the local pose (SoA, `anim-pose`'s layout) and its
//! model-space cache, kept valid lazily. Solvers read model-space transforms, solve in model
//! space, and write **local** rotations (and translations) for their bones only, each blended
//! from the input pose by the entry's weight (`weight ≤ 0` leaves the pose untouched, `1`
//! applies the full solution). Targets and rays are in model space (the character's space); the
//! host converts world positions.
//!
//! Scratch is caller-provided ([`ChainJoint`] slices) and state is fixed-size
//! ([`grounder::GrounderState`], [`spring::SpringChainState`], [`constraints::DampState`]), so
//! **no solve function allocates**. Maths follows `anim-math`'s determinism rules (no fused
//! multiply-add, no libm; [`geom`] has the shared deterministic helpers).
//!
//! Each solver is tested against `anim-offline::rig`, the f64 reference.

// `!(x > 0.0)` is deliberate throughout: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
// Index loops mirror the maths (joint j, its parent j − 1, its child j + 1).
#![allow(clippy::needless_range_loop)]

pub mod aim;
pub mod chain;
pub mod constraints;
pub mod full_body;
pub mod geom;
pub mod grounder;
pub mod limit;
pub mod pose;
pub mod spring;
pub mod two_bone;
pub mod warp;

pub use limit::JointLimit;
pub use pose::{blend_rotation, blend_vec, ChainJoint, RigPose};
