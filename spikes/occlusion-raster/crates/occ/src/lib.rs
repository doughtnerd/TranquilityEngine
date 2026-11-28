//! Software occlusion buffer spike: a CPU depth buffer rasterised from coarse occluder meshes, with a coarse
//! min-depth level for testing occludee bounds. Depth convention ("reverse-W"): a pixel stores 1/w (perspective) or
//! 2-z (orthographic); LARGER = NEARER, 0 = nothing drawn. Occluders write max(); an occludee is hidden when its
//! nearest depth is smaller than the smallest stored value over its screen rect.
pub mod cull;
pub mod ctx;
pub mod f4;
pub mod geom;
pub mod raster;
pub mod rng;
pub mod scene;

pub use ctx::Ctx;
