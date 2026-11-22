//! `anim-offline` (ADR 0340): an f64 scalar reference for sampling, blending, IK, retargeting and
//! matching. The SIMD crates' tests compare against it with stated tolerances, as `audio-offline`
//! does for the mixer.
//!
//! It depends only on `anim-format` and shares no code with the fast path. One module per
//! reference area; each task fills its own area's module.

pub mod graph;
pub mod matching;
pub mod math;
pub mod pose;
pub mod retarget;
pub mod rig;
pub mod sample;
