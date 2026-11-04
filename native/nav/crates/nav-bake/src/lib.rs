//! Foxfire's bake pipeline in Rust (ADR 0065): orientation bins, triangle classification and bucketing, tiles, the
//! stitcher (folds, jumps, seams), chunk borders, the flight volume and landing links.
//!
//! Pipeline, in stage order (`types::BakeStage`):
//! 1. Setup: [`settings`] resolves agent types into profiles (navmesh groups) and flyers, tiers and voxel grids;
//!    [`bins`] builds the orientation bins.
//! 2. Triangles / Classify / Bucket (`classify`): world triangles get a bin, a walkable-for profile mask and an area,
//!    and are bucketed into the grid tiles they touch.
//! 3. Rasterize (`tiles`): each tile rasterizes its bordered solid heightfield once for every profile of its tier.
//! 4. PolyMesh (`tiles`): per (profile, tile) Recast filter, regions, contours and polygon/detail mesh (`nav-recast`).
//! 5. Jumps (`clearance`), Stitch (`stitcher`): tile meshes become one navmesh with seam, fold and jump links.
//! 6. Flight volume (`volume`) and landing links (`landing`); chunk [`border`]; blob assembly (`output`).
//!
//! Everything is deterministic: same inputs, same bits, on any target (`nav-math`'s exact maths, no fused or
//! reassociated float ops, stable tie-breaking).
pub mod bake;
pub mod bins;
pub mod border;
pub mod classify;
pub mod clearance;
pub mod landing;
pub mod output;
pub mod overlay;
pub mod settings;
pub mod stitcher;
pub mod tiles;
pub mod types;
pub mod volume;
