//! Rust equivalents of Foxfire's baked blobs (Runtime/Lib/NavMeshBlob.cs, NavVolume.cs, NavLandingLinks.cs,
//! Tiles/NavChunkBorder.cs, Components/NavGroupComponents.cs), field for field, in declaration order.
//!
//! Layout rules (they decide the bytes that get hashed and stored):
//! * `#[repr(C)]`, natural alignment, exactly the sizes the C# structs have under Unity.Mathematics.
//! * C# pads some structs (`NavLink`, `NavVolumeLeaf`); Foxfire hashes the raw bytes, padding included. Here the
//!   padding is an explicit zero field (`_pad`), so the Rust struct has no implicit padding, matches the C# size,
//!   and its bytes hash the same.
//! * Enums are newtypes over their C# underlying integer (`byte`, `int`), so any byte pattern read from a file is
//!   a valid value; `is_valid` checks the range.
//! * Each blob is an owned struct of `Vec<T>` plus scalars, replacing `BlobArray<T>`.
use crate::pod::Pod;
use nav_math::{Float2, Float3, Float4, Int2, Int3, Int4};

pub use nav_math::hash::Hash128;

macro_rules! pod_structs {
    ($($t:ty),+ $(,)?) => { $(unsafe impl Pod for $t {})+ };
}

// ---------------------------------------------------------------------------------------------------------
// NavMeshBlob
// ---------------------------------------------------------------------------------------------------------

/// `NavLinkKind : byte`.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavLinkKind(pub u8);
impl NavLinkKind {
    /// Shared edge between two polys in the same bin.
    pub const INTERNAL: Self = Self(0);
    /// Hinge between polys in two different bins.
    pub const FOLD: Self = Self(1);
    /// Ballistic hop between up-facing polys.
    pub const JUMP: Self = Self(2);
    pub fn is_valid(self) -> bool {
        self.0 <= 2
    }
}

/// `NavChunkFace` (int-sized): side face of a chunk's bounds box; values match Recast's portal sides.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NavChunkFace(pub i32);
impl NavChunkFace {
    pub const X_MIN: Self = Self(0);
    pub const Z_MAX: Self = Self(1);
    pub const X_MAX: Self = Self(2);
    pub const Z_MIN: Self = Self(3);
    pub fn is_valid(self) -> bool {
        (0..=3).contains(&self.0)
    }
}

/// `NavPoly`, 72 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavPoly {
    pub vert_start: i32,
    pub vert_count: i32,
    pub link_start: i32,
    pub link_count: i32,
    pub bin: i32,
    pub area: i32,
    /// NavGates index, 0 = none.
    pub gate: i32,
    pub flags: i32,
    pub center: Float3,
    pub normal: Float3,
    pub detail_vert_start: i32,
    pub detail_vert_count: i32,
    pub detail_tri_start: i32,
    pub detail_tri_count: i32,
}

/// `NavLink`, 92 bytes: C# pads two bytes after `convex` to align `fold_angle`; here that is `_pad`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavLink {
    pub to_poly: i32,
    pub kind: NavLinkKind,
    /// Fold only: 1 = outside corner, 0 = inside corner.
    pub convex: u8,
    pub _pad: u16,
    pub fold_angle: f32,
    pub portal_a: Float3,
    pub portal_b: Float3,
    pub dest_a: Float3,
    pub dest_b: Float3,
    pub hinge_a: Float3,
    pub hinge_b: Float3,
    pub jump_rise: f32,
    pub jump_distance: f32,
}

/// `NavSeamEdge`, 32 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavSeamEdge {
    pub poly: i32,
    pub face: NavChunkFace,
    pub a: Float3,
    pub b: Float3,
}

/// `NavTileRange`, 16 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavTileRange {
    pub origin: Int2,
    pub poly_start: i32,
    pub poly_count: i32,
}

/// `OrientationBin`, 40 bytes: a fixed frame (n = the bin's up, t, b) and its tilt from world up in degrees.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OrientationBin {
    pub n: Float3,
    pub t: Float3,
    pub b: Float3,
    pub tilt_deg: f32,
}

/// `NavAreaInfo`, 36 bytes: asset id, default cost, debug colour.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavAreaInfo {
    pub id: Hash128,
    pub cost: f32,
    pub color: Float4,
}

pod_structs!(NavPoly, NavLink, NavLinkKind, NavChunkFace, NavSeamEdge, NavTileRange, OrientationBin, NavAreaInfo);

/// `NavMeshBlob`, owned.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavMeshData {
    pub verts: Vec<Float3>,
    pub poly_verts: Vec<i32>,
    pub polys: Vec<NavPoly>,
    /// Grouped by source poly (`NavPoly::link_start`).
    pub links: Vec<NavLink>,
    pub bins: Vec<OrientationBin>,
    pub bin_adjacency: Vec<u64>,
    pub detail_verts: Vec<Float3>,
    /// (a, b, c, edge flags); a/b/c relative to the poly's `detail_vert_start`.
    pub detail_tris: Vec<Int4>,
    /// Indexed by `NavPoly::area`; empty means every area costs 1.
    pub areas: Vec<NavAreaInfo>,
    pub poly_min: Vec<Float3>,
    pub poly_max: Vec<Float3>,
    pub index_cell_size: f32,
    pub index_keys: Vec<i64>,
    pub index_start: Vec<i32>,
    pub index_polys: Vec<i32>,
    /// Polygon edges on the chunk bounds side faces, in bake order. Empty without bounds.
    pub seam_edges: Vec<NavSeamEdge>,
    pub seam_height_tolerance: f32,
    /// Bookkeeping: not in the fingerprint.
    pub tile_ranges: Vec<NavTileRange>,
    /// Bookkeeping: not in the fingerprint.
    pub open_edges: Vec<NavSeamEdge>,
}

// ---------------------------------------------------------------------------------------------------------
// NavVolumeBlob
// ---------------------------------------------------------------------------------------------------------

/// `NavVolumeLeaf`, 28 bytes: 25 bytes of fields, C# pads three to the 4-byte struct alignment (`_pad`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavVolumeLeaf {
    pub min: Int3,
    /// Cube edge in finest cells (power of two).
    pub size: i32,
    pub neighbor_start: i32,
    pub neighbor_count: i32,
    /// NavAreas id.
    pub area: u8,
    pub _pad: [u8; 3],
}

/// `NavVolumeBlock`, 8 bytes: a refined base cell.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavVolumeBlock {
    pub scale: i32,
    pub start: i32,
}

pod_structs!(NavVolumeLeaf, NavVolumeBlock);

/// `NavVolumeBlob`, owned.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavVolumeData {
    pub origin: Float3,
    pub cell_size: f32,
    pub dims: Int3,
    pub agent_radius: f32,
    pub base_scale: i32,
    pub base_dims: Int3,
    /// Per base cell: free leaf, -1 if blocked, or `-2 - b` for refined block b.
    pub base_leaf: Vec<i32>,
    pub blocks: Vec<NavVolumeBlock>,
    pub block_leaf: Vec<i32>,
    pub leaves: Vec<NavVolumeLeaf>,
    pub neighbors: Vec<i32>,
    pub areas: Vec<NavAreaInfo>,
}

// ---------------------------------------------------------------------------------------------------------
// NavLandingLinksBlob
// ---------------------------------------------------------------------------------------------------------

/// `NavLandingLink`, 36 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavLandingLink {
    pub poly: i32,
    pub leaf: i32,
    pub ground: Float3,
    pub air: Float3,
    pub slope_cos: f32,
}
pod_structs!(NavLandingLink);

/// `NavLandingLinksBlob`, owned.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavLandingLinksData {
    pub links: Vec<NavLandingLink>,
    /// Navmesh polygon count + 1.
    pub poly_start: Vec<i32>,
    pub by_leaf: Vec<i32>,
    /// Flight volume leaf count + 1.
    pub leaf_start: Vec<i32>,
}

// ---------------------------------------------------------------------------------------------------------
// NavChunkBorderBlob
// ---------------------------------------------------------------------------------------------------------

/// `FFBounds`, 36 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FFBounds {
    pub center: Float3,
    pub min: Float3,
    pub max: Float3,
}

/// `NavTileAgent`, 40 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavTileAgent {
    pub radius: f32,
    pub height: f32,
    pub step_height: f32,
    pub min_region_area: i32,
    pub merge_region_area: i32,
    pub max_simplification_error: f32,
    pub max_edge_length: i32,
    pub verts_per_poly: i32,
    pub detail_sample_distance: f32,
    pub detail_sample_max_error: f32,
}

/// `NavBorderGrid`, 80 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavBorderGrid {
    pub bounds: FFBounds,
    pub cs: f32,
    pub ch: f32,
    pub width: i32,
    pub height: i32,
    pub depth: i32,
    pub tier_mask: u32,
    pub flag_merge_threshold: i32,
    pub tile_size: i32,
    pub border: i32,
    pub tiles_x: i32,
    pub tiles_z: i32,
}

/// `NavBorderProfile`, 124 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavBorderProfile {
    pub bit: i32,
    pub agent: NavTileAgent,
    pub grid: NavBorderGrid,
}

/// `NavBorderAgent`, 20 bytes: an agent type the bake built a navmesh for, and its profile index.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NavBorderAgent {
    pub agent_type: Hash128,
    pub profile: i32,
}

/// `TriangleData` (Tiles/NavTileTypes.cs), 48 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TriangleData {
    pub a: Float3,
    pub b: Float3,
    pub c: Float3,
    pub bin: i32,
    /// 0 = solid for every profile.
    pub walkable_for: u32,
    pub area: i32,
}
pod_structs!(FFBounds, NavTileAgent, NavBorderGrid, NavBorderProfile, NavBorderAgent, TriangleData);

/// `NavChunkBorderBlob`, owned.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavChunkBorderData {
    pub box_min: Float3,
    pub box_max: Float3,
    /// Per `NavChunkFace` (XMin, ZMax, XMax, ZMin): how far geometry reaches past that face.
    pub overhang: Float4,
    pub min_depth: i32,
    pub max_depth: i32,
    pub triangles: Vec<TriangleData>,
    pub profiles: Vec<NavBorderProfile>,
    pub agents: Vec<NavBorderAgent>,
    /// Area asset ids by area index.
    pub areas: Vec<Hash128>,
}

// ---------------------------------------------------------------------------------------------------------
// Gate table, formations
// ---------------------------------------------------------------------------------------------------------

/// The baked part of a gate table (`NavGateTableEntry` buffer): `ids[i]` is the id of gate index i, entry 0
/// unused. The closed flags (`NavGateClosed`) are runtime state and aren't baked.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NavGateTableData {
    pub ids: Vec<Hash128>,
}

/// `NavFormationBlob`, owned: slot offsets in units of the group's spacing (x right, y forward), fill order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavFormationData {
    pub slots: Vec<Float2>,
    pub width: i32,
    pub depth: i32,
}
