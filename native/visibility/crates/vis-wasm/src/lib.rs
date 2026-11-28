//! The occlusion core's WebAssembly boundary (ADR 0447 sections 1 and 2): setup calls through wasm-bindgen, per-frame
//! data through raw typed-array views over linear memory (no JavaScript objects cross).
//!
//! The module keeps one [`Core`] per page. `init` allocates every region once; the JavaScript side then asks for the
//! regions' addresses (`*_ptr`), builds `Float32Array` / `Uint32Array` / `Uint8Array` views over `memory.buffer`
//! (rebuilding them if the memory ever grows, which no call here does after `init`), and per view:
//!
//! 1. writes the view header ([`VIEW_LEN`] floats at `view_ptr`: the column-major view-projection matrix, the eye,
//!    near, far, and the projection's x and y scale);
//! 2. writes `n` occluder triangles (`triangles_ptr`: 9 floats each, world space; `errors_ptr`: 1 float each, the final
//!    doubled error; `neighbors_ptr`: 3 u32 each, indices into this frame's list or `0xFFFFFFFF`) and `m` occludee
//!    boxes (`boxes_ptr`: 6 floats each, world min then max);
//! 3. calls `occlude(n, m)`, then reads `hidden_ptr` (`m` bytes: 1 = proven hidden, this frame's result) and the
//!    counters at `stats_ptr` ([`STATS_LEN`] u32).
//!
//! `depth_ptr` is the last view's buffer (`width * height` floats of 1/w, 0 = empty) for the debug image.
use std::cell::RefCell;
use vis_raster::{Config, FrameError, Occluders, Occlusion, Reject, View};
use wasm_bindgen::prelude::*;

/// The source hash `build.rs` embedded.
static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

/// Floats in the view header: matrix (16), eye (3), near, far, sx, sy.
pub const VIEW_LEN: usize = 23;
/// u32 counters after a view: status, then [`vis_raster::Stats`] in field order, zero-padded to this length.
pub const STATS_LEN: usize = 16;

/// `init` and `occlude` results.
pub const OK: u32 = 0;
/// `occlude`: no core (call `init` first).
pub const NO_CORE: u32 = 1;
/// `init`: a size the core refuses; `occlude`: a count over the capacity given to `init`.
pub const BAD_SIZE: u32 = 2;
/// `occlude`: the view header has a NaN or infinity.
pub const VIEW_NOT_FINITE: u32 = 3;
/// `occlude`: `near`, `far` or a projection scale is out of range.
pub const VIEW_BAD_RANGE: u32 = 4;
/// `occlude`: the matrix is singular (a zero scale).
pub const VIEW_SINGULAR: u32 = 5;

const MAX_SIDE: usize = 2048;
const MAX_ITEMS: usize = 1 << 21;

/// The whole core as a Rust value: the buffer and the per-frame regions.
pub struct Core {
    occ: Occlusion,
    width: usize,
    height: usize,
    triangles: Vec<f32>,
    errors: Vec<f32>,
    neighbors: Vec<u32>,
    boxes: Vec<f32>,
    hidden: Vec<u8>,
    view: [f32; VIEW_LEN],
    stats: [u32; STATS_LEN],
}

impl Core {
    /// A core for a `width` x `height` buffer (width a multiple of 8) with room for `max_triangles` occluder triangles
    /// and `max_boxes` occludees per view. `None` for a size it refuses.
    pub fn new(
        width: usize,
        height: usize,
        max_triangles: usize,
        max_boxes: usize,
    ) -> Option<Core> {
        if width == 0
            || height == 0
            || !width.is_multiple_of(8)
            || width > MAX_SIDE
            || height > MAX_SIDE
            || max_triangles > MAX_ITEMS
            || max_boxes > MAX_ITEMS
        {
            return None;
        }
        Some(Core {
            occ: Occlusion::new(width, height, Config::default()),
            width,
            height,
            triangles: vec![0.0; max_triangles * 9],
            errors: vec![0.0; max_triangles],
            neighbors: vec![0; max_triangles * 3],
            boxes: vec![0.0; max_boxes * 6],
            hidden: vec![0; max_boxes],
            view: [0.0; VIEW_LEN],
            stats: [0; STATS_LEN],
        })
    }

    pub fn view_mut(&mut self) -> &mut [f32; VIEW_LEN] {
        &mut self.view
    }
    pub fn triangles_mut(&mut self) -> &mut [f32] {
        &mut self.triangles
    }
    pub fn errors_mut(&mut self) -> &mut [f32] {
        &mut self.errors
    }
    pub fn neighbors_mut(&mut self) -> &mut [u32] {
        &mut self.neighbors
    }
    pub fn boxes_mut(&mut self) -> &mut [f32] {
        &mut self.boxes
    }
    /// This frame's result: 1 = proven hidden.
    pub fn hidden(&self) -> &[u8] {
        &self.hidden
    }
    /// The counters of the last view.
    pub fn stats(&self) -> &[u32; STATS_LEN] {
        &self.stats
    }
    /// The last view's depth buffer (`width * height` floats of 1/w; 0 = nothing drawn).
    pub fn depth(&self) -> &[f32] {
        &self.occ.buffer().fine
    }

    /// Rasterises the first `n` triangles and tests the first `m` boxes against the view header. The result is
    /// [`OK`] or the reason the view was refused (then every box stays visible: `hidden` is all zero).
    pub fn occlude(&mut self, n: usize, m: usize) -> u32 {
        self.stats = [0; STATS_LEN];
        if n > self.errors.len() || m > self.hidden.len() {
            self.stats[0] = BAD_SIZE;
            return BAD_SIZE;
        }
        self.hidden[..m].fill(0);
        let v = &self.view;
        let matrix: [f32; 16] = v[..16].try_into().expect("16 floats");
        let view =
            match View::perspective(&matrix, [v[16], v[17], v[18]], v[19], v[20], v[21], v[22]) {
                Ok(view) => view,
                Err(reason) => {
                    let code = match reason {
                        Reject::NotFinite => VIEW_NOT_FINITE,
                        Reject::BadRange => VIEW_BAD_RANGE,
                        Reject::Singular => VIEW_SINGULAR,
                    };
                    self.stats[0] = code;
                    return code;
                }
            };
        let occ = Occluders {
            triangles: &self.triangles[..n * 9],
            errors: &self.errors[..n],
            neighbors: &self.neighbors[..n * 3],
        };
        match self
            .occ
            .occlude(&view, &occ, &self.boxes[..m * 6], &mut self.hidden[..m])
        {
            Ok(s) => {
                self.stats[1..11].copy_from_slice(&[
                    s.triangles,
                    s.invalid,
                    s.facing_away,
                    s.near_skipped,
                    s.clipped,
                    s.rasterised,
                    s.tested,
                    s.outside,
                    s.near_visible,
                    s.culled,
                ]);
                OK
            }
            Err(FrameError::Lengths) => {
                self.stats[0] = BAD_SIZE;
                BAD_SIZE
            }
        }
    }
}

thread_local! {
    static CORE: RefCell<Option<Core>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut Core) -> R) -> Option<R> {
    CORE.with(|c| c.borrow_mut().as_mut().map(f))
}

/// An address in linear memory (wasm32 pointers are 32 bits).
fn addr<T>(p: *const T) -> u32 {
    p as usize as u32
}

/// Allocates the core: a `width` x `height` buffer (256x128 or 320x180 in the tiers) and room for `max_triangles`
/// occluder triangles and `max_boxes` occludees per view. Replaces any earlier core (its regions move). Returns [`OK`]
/// or [`BAD_SIZE`].
#[wasm_bindgen]
pub fn init(width: u32, height: u32, max_triangles: u32, max_boxes: u32) -> u32 {
    match Core::new(
        width as usize,
        height as usize,
        max_triangles as usize,
        max_boxes as usize,
    ) {
        Some(core) => {
            CORE.with(|c| *c.borrow_mut() = Some(core));
            OK
        }
        None => BAD_SIZE,
    }
}

/// Frees the core.
#[wasm_bindgen]
pub fn shutdown() {
    CORE.with(|c| *c.borrow_mut() = None);
}

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

/// Floats in the view header.
#[wasm_bindgen]
pub fn view_len() -> u32 {
    VIEW_LEN as u32
}

/// u32 counters after a view.
#[wasm_bindgen]
pub fn stats_len() -> u32 {
    STATS_LEN as u32
}

macro_rules! region {
    ($name:ident, $method:ident) => {
        /// The region's address in linear memory (0 without a core).
        #[wasm_bindgen]
        pub fn $name() -> u32 {
            with(|c| addr(c.$method().as_ptr())).unwrap_or(0)
        }
    };
}
region!(triangles_ptr, triangles_mut);
region!(errors_ptr, errors_mut);
region!(neighbors_ptr, neighbors_mut);
region!(boxes_ptr, boxes_mut);

/// The view header's address.
#[wasm_bindgen]
pub fn view_ptr() -> u32 {
    with(|c| addr(c.view_mut().as_ptr())).unwrap_or(0)
}

/// The result's address: one byte per occludee, 1 = proven hidden.
#[wasm_bindgen]
pub fn hidden_ptr() -> u32 {
    with(|c| addr(c.hidden().as_ptr())).unwrap_or(0)
}

/// The counters' address.
#[wasm_bindgen]
pub fn stats_ptr() -> u32 {
    with(|c| addr(c.stats().as_ptr())).unwrap_or(0)
}

/// The last view's depth buffer's address (`width * height` floats).
#[wasm_bindgen]
pub fn depth_ptr() -> u32 {
    with(|c| addr(c.depth().as_ptr())).unwrap_or(0)
}

/// Runs one view over the first `n_triangles` and `n_boxes` of the regions. Returns [`OK`] or why it did not.
#[wasm_bindgen]
pub fn occlude(n_triangles: u32, n_boxes: u32) -> u32 {
    with(|c| c.occlude(n_triangles as usize, n_boxes as usize)).unwrap_or(NO_CORE)
}

/// The buffer's size, for the debug image: `width` then `height` packed as `width << 16 | height`.
#[wasm_bindgen]
pub fn buffer_size() -> u32 {
    with(|c| ((c.width as u32) << 16) | c.height as u32).unwrap_or(0)
}
