//! The occlusion core (ADR 0447): a CPU depth buffer that coarse occluder triangles are drawn into each frame, and a test
//! of occludee boxes against it.
//!
//! Depth convention ("reverse-W"): a pixel stores `1/w`; LARGER = NEARER and 0 = nothing drawn. Occluders write `max`.
//! An occludee is hidden when its nearest depth is smaller than the smallest stored value over its dilated screen rect.
//!
//! The conservativeness rules of ADR 0447 section 3 live in [`frame`]: depth pushed back by the triangle's error, a
//! coverage shrink at silhouette edges only, a per-triangle near rule, and rejection of NaN and degenerate input. Layers:
//! [`buffer`] (the buffer, the rasterisers, the coarse level), [`view`] (the camera), [`setup`] (clip, project, edge
//! setup), [`frame`] (a whole view), [`geom`] (small vector maths).
//!
//! `no_std` with `alloc`; simd128 (or SSE natively) sits behind [`f4`], with a scalar reference that gives bit-identical
//! output.
// Comparisons that must be false for NaN are written as negations (`!(x > 0.0)`) on purpose: they reject NaN input.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
#![no_std]
extern crate alloc;

pub mod buffer;
pub mod f4;
pub mod frame;
pub mod geom;
pub mod setup;
pub mod view;

pub use buffer::DepthBuf;
pub use frame::{test_occludees, Config, FrameError, Occluders, Occlusion, Stats};
pub use view::{Reject, View};
