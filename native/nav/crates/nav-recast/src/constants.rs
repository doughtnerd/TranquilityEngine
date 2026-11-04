//! Recast's constants and direction helpers (`RcConstants`).

pub const RC_NULL_NEI: i32 = 0xffff;
/// The null area: a data element with it is no longer assigned to a usable area (unwalkable).
pub const RC_NULL_AREA: i32 = 0;
/// The default walkable area id, also the maximum area id, and the only non-null area id some build steps recognise.
pub const RC_WALKABLE_AREA: i32 = 63;
/// `get_con`'s value when a direction has no neighbour.
pub const RC_NOT_CONNECTED: i32 = 0x3f;
/// Bits for a span's smin and smax.
pub const RC_SPAN_HEIGHT_BITS: i32 = 20;
/// The largest smin or smax.
pub const RC_SPAN_MAX_HEIGHT: i32 = (1 << RC_SPAN_HEIGHT_BITS) - 1;
/// Spans per span-pool chunk (unused by the Rust pool, kept for reference).
pub const RC_SPANS_PER_POOL: i32 = 2048;
/// Must be 255 or smaller: layer ids are stored as a byte where 255 is special.
pub const RC_MAX_LAYERS: i32 = RC_NOT_CONNECTED;
pub const RC_MAX_NEIS: i32 = 16;
/// A region id with this bit is a border region, its spans unwalkable (regions and contours).
pub const RC_BORDER_REG: i32 = 0x8000;
/// A polygon touching several regions (merged across regions while removing border vertices).
pub const RC_MULTIPLE_REGS: i32 = 0;
/// A region id with this bit lies on a tile border; such contour vertices are removed later to match tile edges.
pub const RC_BORDER_VERTEX: i32 = 0x10000;
/// A region id with this bit lies on an area border.
pub const RC_AREA_BORDER: i32 = 0x20000;
/// Extracts the region id from a contour vertex's region field (which carries flags too).
pub const RC_CONTOUR_REG_MASK: i32 = 0xffff;
/// An invalid index within a mesh (not necessarily an error).
pub const RC_MESH_NULL_IDX: i32 = 0xffff;

const DIR_OFFSET_X: [i32; 4] = [-1, 0, 1, 0];
const DIR_OFFSET_Y: [i32; 4] = [0, 1, 0, -1];
const DIR_FOR_OFFSET: [i32; 5] = [3, 0, -1, 2, 1];

/// The x offset to move one cell in `dir` (0..4).
#[inline]
pub fn get_dir_offset_x(dir: i32) -> i32 {
    DIR_OFFSET_X[(dir & 0x03) as usize]
}

/// The z ("y" in Recast's grid) offset to move one cell in `dir` (0..4).
#[inline]
pub fn get_dir_offset_y(dir: i32) -> i32 {
    DIR_OFFSET_Y[(dir & 0x03) as usize]
}

/// The direction of an offset; one of x and y should be 0.
#[inline]
pub fn get_dir_for_offset(x: i32, y: i32) -> i32 {
    DIR_FOR_OFFSET[(((y + 1) << 1) + x) as usize]
}
