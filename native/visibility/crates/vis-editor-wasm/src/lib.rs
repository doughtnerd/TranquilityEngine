//! The occlusion core's editor and export module (ADR 0447 section 3): import-time hole trimming of occluder stand-ins,
//! for the editor's import worker and the exporters. Never loaded by games (they ship the baked result).
//!
//! `trim_standin` measures the stand-in against the original, drops the triangles that close holes and returns the
//! kept triangles with their raw errors and edge neighbours; the caller doubles the errors when it stores them (ADR 0447:
//! "errors doubled"). `neighbors_of` builds just the neighbour table, for a mesh that occludes with itself (at most 512
//! triangles, error 0).
use vis_trim::{Mesh, Options, TrimError, Trimmed};
use wasm_bindgen::prelude::*;

/// The source hash `build.rs` embedded.
static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

/// The source hash the module was built from, as 32 lowercase hex digits (the staleness check).
#[wasm_bindgen]
pub fn source_hash() -> String {
    // by hand: `format!` would link the whole formatting machinery for 32 digits
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for b in SOURCE_HASH {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// A trimmed stand-in; each getter copies one array out.
#[wasm_bindgen]
pub struct TrimResult {
    inner: Trimmed,
}

#[wasm_bindgen]
impl TrimResult {
    /// For each kept triangle, its index in the stand-in's triangle list.
    pub fn kept(&self) -> Vec<u32> {
        self.inner.kept.clone()
    }
    /// The kept triangles' vertex indices (into the stand-in's positions), three per triangle.
    pub fn indices(&self) -> Vec<u32> {
        self.inner.indices.clone()
    }
    /// The kept triangles' sampled errors in world units (raw: the caller doubles them).
    pub fn errors(&self) -> Vec<f32> {
        self.inner.errors.clone()
    }
    /// The kept triangles' neighbours across edges a to b, b to c, c to a (indices into the kept list, or 0xFFFFFFFF).
    pub fn neighbors(&self) -> Vec<u32> {
        self.inner.neighbors.clone()
    }
    /// Triangles dropped as closed holes.
    pub fn dropped(&self) -> u32 {
        self.inner.dropped
    }
    /// The original's bounding-box diagonal.
    pub fn diagonal(&self) -> f32 {
        self.inner.diagonal
    }
    /// The largest error among the kept triangles.
    pub fn max_error(&self) -> f32 {
        self.inner.max_error
    }
}

fn why(e: TrimError) -> JsError {
    match e {
        TrimError::BadMesh => JsError::new(
            "a mesh has a length that is not a multiple of 3, or an index out of range",
        ),
        TrimError::Unusable => JsError::new(
            "the original is empty or a position is not finite, or an option is not positive",
        ),
    }
}

/// Trims `standin` against `original`. Triangles whose error exceeds `trim_fraction` of the original's diagonal are
/// dropped (ADR 0447: 0.005); `spacing_fraction` is the sampling lattice's spacing (0.005).
#[wasm_bindgen]
pub fn trim_standin(
    original_positions: &[f32],
    original_indices: &[u32],
    standin_positions: &[f32],
    standin_indices: &[u32],
    trim_fraction: f32,
    spacing_fraction: f32,
) -> Result<TrimResult, JsError> {
    let original = Mesh {
        positions: original_positions,
        indices: original_indices,
    };
    let standin = Mesh {
        positions: standin_positions,
        indices: standin_indices,
    };
    vis_trim::trim(
        &original,
        &standin,
        &Options {
            trim_fraction,
            spacing_fraction,
        },
    )
    .map(|inner| TrimResult { inner })
    .map_err(why)
}

/// The edge-neighbour table of a triangle list (see `TrimResult::neighbors`). An index out of range gives an error.
#[wasm_bindgen]
pub fn neighbors_of(positions: &[f32], indices: &[u32]) -> Result<Vec<u32>, JsError> {
    let nv = positions.len() / 3;
    if !positions.len().is_multiple_of(3)
        || !indices.len().is_multiple_of(3)
        || indices.iter().any(|&i| i as usize >= nv)
    {
        return Err(why(TrimError::BadMesh));
    }
    Ok(vis_trim::neighbors(positions, indices))
}
