//! Navmesh generation (ADR 0065): Foxfire's port of DotRecast (itself a port of Recast, Copyright (c)
//! 2009-2010 Mikko Mononen; zlib licence), ported to Rust function by function. Keep the upstream
//! structure and operation order: bakes must be deterministic, and later diffs against Foxfire stay
//! readable.
//!
//! Stages, in pipeline order: rasterization → filters → compact heightfield → areas → regions
//! (distance field, watershed/monotone/layers) → contours → poly mesh → detail mesh. The flat
//! heightfield variant serves Foxfire's multi-profile bakes.
pub mod areas;
pub mod compact;
pub mod constants;
pub mod contours;
pub mod filters;
pub mod flat_heightfield;
pub mod mesh_details;
pub mod meshes;
pub mod rasterization;
pub mod regions;
pub mod types;

pub use types::*;
