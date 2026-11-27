//! `anim-match` (ADR 0370, 0372): motion matching. Feature extraction and normalisation, a
//! KD-tree plus brute-force SIMD search over the pose database, trajectory prediction, the
//! matching controller, and the database bake.
//!
//! Internal to the animation core: nothing here is engine public API (ADR 0010).
//!
//! The graph's `matching` node family (`anim-graph::matching`, T42's node half) calls it.
//! Tested against `anim-offline::matching`.
//!
//! # Shape
//!
//! - **Offline:** [`bake::bake`] samples tagged clip ranges into a `myco.posedb@1` file
//!   ([`schema`] says what is measured, [`character`] in which frame) with its KD-tree
//!   ([`kdtree`]). It allocates and is deterministic: the same inputs give the same bytes.
//! - **At load:** [`db::MatchDb::new`] turns a parsed file into search-ready rows (allocates once).
//! - **Per frame, per character** (fixed size, never allocates):
//!   [`trajectory::TrajectoryPredictor`] predicts the trajectory with critically damped springs
//!   ([`spring`]); [`query::build_query`] turns the pose and trajectory into a normalised, weighted
//!   query; [`controller::MatchController`] decides when to search ([`search`]: brute force or
//!   KD-tree, the same result) and when to switch. A switch is a request the host or graph turns
//!   into an inertialized transition (`anim_pose::inertialize`).
//!
//! # Determinism
//!
//! The runtime follows `anim-math`'s rules: correctly rounded f32 operations in a fixed order, no
//! fused multiply-add, no relaxed SIMD, no libm (`e^-x` and trigonometry come from
//! `anim_math::trig::exp2` and `anim_math::trig`). The bake accumulates its statistics in f64 in a
//! fixed order.

// `!(x > 0.0)` is deliberate: it is true for NaN as well, which `x <= 0.0` is not.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod bake;
pub mod character;
pub mod controller;
pub mod db;
pub mod kdtree;
pub mod query;
pub mod schema;
pub mod search;
pub mod spring;
pub mod trajectory;

/// The most tags a database may have for search (four `u32` words of tag bits per frame).
pub const MAX_TAGS: usize = 128;
/// `u32` words in a [`db::TagMask`].
pub const TAG_WORDS: usize = MAX_TAGS / 32;
/// The most distinct trajectory time offsets a schema may have.
pub const MAX_TRAJECTORY: usize = 16;
/// The deepest KD-tree the search accepts (a median-split tree over 2^32 frames is 32 deep).
pub const MAX_KD_DEPTH: usize = 64;

pub use bake::{
    bake, BakeClip, BakeError, BakeSettings, Baked, CustomFeature, Normalization, TaggedRange,
};
pub use character::CharacterFrame;
pub use controller::{ControllerSettings, MatchController, MatchOutput};
pub use db::{tag_index, LoadError, MatchDb, TagFilter, TagMask};
pub use query::{build_query, build_query_from, BoneSource, PoseInput, QueryError};
pub use schema::{default_schema, FeatureSpec};
pub use search::{Match, SearchFilter, SearchMode, Skip};
pub use trajectory::{Trajectory, TrajectoryInput, TrajectoryPredictor, TrajectorySettings};
