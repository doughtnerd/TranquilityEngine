//! The data types shared by every stage of the Recast pipeline, ported from Foxfire's
//! `Runtime/Recast` (Heightfield, RcSpan, SpanPool, RcCompactHeightfield, RcContourSet, RcPolyMesh,
//! RcPolyMeshDetail, FlatSpan, RcAreaModification, FFBounds).
//!
//! Pointers become indices: a heightfield's columns hold the index of their first span in a
//! [`SpanPool`] (or [`NULL_SPAN`]), and spans link by index. Spans live in the pool, not the
//! heightfield, as in Foxfire, so several heightfields (a grid of tiles) can share one pool. Foxfire's
//! `RcArray` and `UnsafeList` become `Vec`s; where the C# keeps a count smaller than the list (poly
//! meshes), the Rust keeps the same count field.
use nav_math::{Float3, Int3, Int4};

/// "No span": the end of a column's list, or an empty column.
pub const NULL_SPAN: u32 = u32::MAX;

/// A solid span of a linked-list heightfield (`RcSpan`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RcSpan {
    pub smin: i32,
    pub smax: i32,
    /// The area id; in profile-mask bakes, the bitmask of profiles the span is walkable for.
    pub area: i32,
    /// Profile-mask bakes: the navmesh area (NavAreas) of a walkable span.
    pub area_id: i32,
    /// The next span up the column, or [`NULL_SPAN`].
    pub next: u32,
}

/// Where spans live (`SpanPool`): allocated one at a time, freed all together.
#[derive(Clone, Debug, Default)]
pub struct SpanPool {
    pub spans: Vec<RcSpan>,
}

impl SpanPool {
    pub fn new() -> Self {
        Self { spans: Vec::with_capacity(4096) }
    }
    /// A new zeroed span's index.
    #[inline]
    pub fn alloc(&mut self) -> u32 {
        self.spans.push(RcSpan { next: NULL_SPAN, ..RcSpan::default() });
        (self.spans.len() - 1) as u32
    }
    #[inline]
    pub fn get(&self, i: u32) -> &RcSpan {
        &self.spans[i as usize]
    }
    #[inline]
    pub fn get_mut(&mut self, i: u32) -> &mut RcSpan {
        &mut self.spans[i as usize]
    }
}

/// A linked-list heightfield (`Heightfield`): `width * height` columns, each the index of its lowest
/// span in a [`SpanPool`].
#[derive(Clone, Debug, Default)]
pub struct Heightfield {
    pub spans: Vec<u32>,
}

impl Heightfield {
    pub fn new(columns: usize) -> Self {
        Self { spans: vec![NULL_SPAN; columns] }
    }
}

/// A solid span of a flattened heightfield (`FlatSpan`). `mask` holds the profile bits it's walkable
/// for (0 = solid for everyone), so one rasterization serves every profile at the same resolution.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FlatSpan {
    pub smin: i32,
    pub smax: i32,
    pub mask: u32,
    /// The navmesh area (NavAreas) where walkable.
    pub area: i32,
}

/// A compact heightfield column (`RcCompactCell`): its spans are `index .. index + count`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RcCompactCell {
    pub index: i32,
    pub count: i32,
}

/// A walkable span of a compact heightfield (`RcCompactSpan`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RcCompactSpan {
    /// The floor height (the solid span's smax).
    pub y: i32,
    /// Region id.
    pub reg: i32,
    /// Packed neighbour connections, 6 bits per direction (0x3f = not connected).
    pub con: u32,
    /// The open height above the floor, clamped to 255 like Recast.
    pub h: i32,
}

/// The compact heightfield (`RcCompactHeightfield`): only walkable spans, column-ordered, with
/// packed 4-neighbour connectivity, plus per-span area, distance and region. Built from a heightfield
/// by the compact-heightfield stage.
#[derive(Clone, Debug, Default)]
pub struct RcCompactHeightfield {
    pub width: i32,
    pub height: i32,
    pub span_count: i32,
    pub walkable_height: i32,
    pub walkable_climb: i32,
    pub border_size: i32,
    pub max_distance: i32,
    pub max_regions: i32,
    pub bmin: Float3,
    pub bmax: Float3,
    pub cs: f32,
    pub ch: f32,
    /// `width * height`.
    pub cells: Vec<RcCompactCell>,
    /// `span_count`.
    pub spans: Vec<RcCompactSpan>,
    /// `span_count`.
    pub areas: Vec<i32>,
    /// `span_count`, filled by the distance field.
    pub dist: Vec<i32>,
}

impl RcCompactHeightfield {
    pub const RC_NOT_CONNECTED: i32 = 0x3f;
    pub const RC_NULL_AREA: i32 = 0;
    pub const RC_BORDER_REG: i32 = 0x8000;
    pub const MAX_LAYERS: i32 = Self::RC_NOT_CONNECTED - 1;
    pub const MAX_HEIGHT: i32 = 0xffff;

    #[inline]
    pub fn get_con(s: &RcCompactSpan, dir: i32) -> i32 {
        ((s.con >> (dir * 6)) & 0x3f) as i32
    }
    #[inline]
    pub fn set_con(s: &mut RcCompactSpan, dir: i32, i: i32) {
        let shift = dir * 6;
        s.con = (s.con & !(0x3fu32 << shift)) | (((i as u32) & 0x3f) << shift);
    }
    /// Direction offsets: 0 = (-1, 0), 1 = (0, 1), 2 = (1, 0), 3 = (0, -1).
    #[inline]
    pub fn dir_offset_x(dir: i32) -> i32 {
        if dir & 1 == 0 { dir - 1 } else { 0 }
    }
    #[inline]
    pub fn dir_offset_y(dir: i32) -> i32 {
        if dir & 1 == 1 { 2 - dir } else { 0 }
    }
}

/// Contour-building flags (`RcBuildContoursFlags`).
pub mod build_contours_flags {
    /// Tessellate wall edges.
    pub const RC_CONTOUR_TESS_WALL_EDGES: i32 = 0x01;
    /// Tessellate edges between areas.
    pub const RC_CONTOUR_TESS_AREA_EDGES: i32 = 0x02;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RcContourStatus {
    Success = 0,
    /// "Multiple outlines for region".
    MultipleOutlines,
    /// "Bad outline for region ... simplification is likely too aggressive".
    BadOutline,
}

/// A region's outline (`RcContour`). Vertices are (x, y, z, flags/region); raw vertices the same.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RcContour {
    pub reg: i32,
    pub area: i32,
    /// Simplified.
    pub verts: Vec<Int4>,
    /// Raw.
    pub rverts: Vec<Int4>,
}

impl RcContour {
    pub fn nverts(&self) -> usize {
        self.verts.len()
    }
    pub fn nrverts(&self) -> usize {
        self.rverts.len()
    }
}

#[derive(Clone, Debug, Default)]
pub struct RcContourSet {
    pub conts: Vec<RcContour>,
    pub bmin: Float3,
    pub bmax: Float3,
    pub cs: f32,
    pub ch: f32,
    pub width: i32,
    pub height: i32,
    pub border_size: i32,
    pub max_error: f32,
    /// The number of holes DotRecast would have logged "Failed to find merge points" for.
    pub merge_hole_failures: i32,
}

/// A contour in flattened form (`RcContourHeader`): ranges into shared vertex lists.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RcContourHeader {
    pub reg: i32,
    pub area: i32,
    /// Index into the verts list.
    pub vert_start: i32,
    pub nverts: i32,
    /// Index into the raw verts list.
    pub rvert_start: i32,
    pub nrverts: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RcPolyMeshStatus {
    Success = 0,
    /// "rcBuildPolyMesh: Too many vertices".
    TooManyContourVertices,
    /// The polygon count exceeded the estimate while building or removing vertices.
    TooManyPolygons,
    /// The result has more than MAX_MESH_VERTS_POLY vertices.
    TooManyMeshVertices,
    /// The result has more than MAX_MESH_VERTS_POLY polygons.
    TooManyMeshPolygons,
    /// MergePolyMeshes called with nothing to merge.
    NoMeshes,
}

/// A polygon mesh (`RcPolyMesh`). The counts (`nverts`, `npolys`) can be smaller than the list
/// lengths: only the first `nverts` vertices and `npolys` polygons are valid, exactly like DotRecast's
/// oversized arrays.
#[derive(Clone, Debug, Default)]
pub struct RcPolyMesh {
    /// `nverts` used.
    pub verts: Vec<Int3>,
    /// `npolys * nvp * 2`: vertex indices, then neighbour indices.
    pub polys: Vec<i32>,
    /// Per polygon.
    pub regs: Vec<i32>,
    /// Per polygon, filled by the user.
    pub flags: Vec<i32>,
    /// Per polygon.
    pub areas: Vec<i32>,
    pub nverts: i32,
    pub npolys: i32,
    pub maxpolys: i32,
    pub nvp: i32,
    pub bmin: Float3,
    pub bmax: Float3,
    pub cs: f32,
    pub ch: f32,
    pub border_size: i32,
    pub max_edge_error: f32,
    /// Times DotRecast would have logged a bad-triangulation warning.
    pub triangulation_warnings: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RcDetailStatus {
    Success = 0,
    /// The mesh had no vertices or polygons (DotRecast returns null).
    EmptyMesh,
    /// "addEdge: Too many edges".
    TooManyEdges,
    /// "buildPolyDetail: Could not triangulate polygon".
    CouldNotTriangulate,
}

/// A detail mesh (`RcPolyMeshDetail`): `meshes[i]` = (base vertex, vertex count, base triangle,
/// triangle count); `tris` = (a, b, c, flags) with indices relative to the submesh's first vertex.
#[derive(Clone, Debug, Default)]
pub struct RcPolyMeshDetail {
    pub meshes: Vec<Int4>,
    pub verts: Vec<Float3>,
    pub tris: Vec<Int4>,
    /// Dangling faces, failed centre walks, triangle-cap truncations.
    pub warnings: i32,
}

impl RcPolyMeshDetail {
    pub fn nmeshes(&self) -> usize {
        self.meshes.len()
    }
    pub fn nverts(&self) -> usize {
        self.verts.len()
    }
    pub fn ntris(&self) -> usize {
        self.tris.len()
    }
}

/// A patch of sampled heights under a polygon (`RcHeightPatch`).
#[derive(Clone, Debug, Default)]
pub struct RcHeightPatch {
    pub xmin: i32,
    pub ymin: i32,
    pub width: i32,
    pub height: i32,
    pub data: Vec<i32>,
}

/// An area id and mask to apply (`RcAreaModification`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RcAreaModification {
    pub value: i32,
    pub mask: i32,
}

impl RcAreaModification {
    pub const RC_AREA_FLAGS_MASK: i32 = 0x3F;
    pub const fn new(value: i32) -> Self {
        Self { value, mask: Self::RC_AREA_FLAGS_MASK }
    }
    pub const fn with_mask(value: i32, mask: i32) -> Self {
        Self { value, mask }
    }
    #[inline]
    pub fn masked_value(self) -> i32 {
        self.value & self.mask
    }
    #[inline]
    pub fn apply(self, area: i32) -> i32 {
        (self.value & self.mask) | (area & !self.mask)
    }
}

/// Recast's span filters (`HeightfieldFilters`), as bit flags.
pub mod heightfield_filters {
    pub const WALKABLE_LOW_HEIGHT: u8 = 1;
    pub const LEDGE: u8 = 2;
    pub const LOW_HANGING_OBSTACLES: u8 = 4;
}

/// Axis-aligned bounds with a centre (`FFBounds`; world or bin-local, depending on use).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FFBounds {
    pub center: Float3,
    pub min: Float3,
    pub max: Float3,
}

impl FFBounds {
    pub fn encapsulate(&mut self, other: &FFBounds) {
        self.encapsulate_point(other.min);
        self.encapsulate_point(other.max);
    }
    fn encapsulate_point(&mut self, p: Float3) {
        self.min = self.min.zip(p, nav_math::math::min); // Unity's math.min, component-wise
        self.max = self.max.zip(p, nav_math::math::max);
        self.center = Float3::new(
            self.min.x + (self.max.x - self.min.x) * 0.5,
            self.min.y + (self.max.y - self.min.y) * 0.5,
            self.min.z + (self.max.z - self.min.z) * 0.5,
        );
    }
    pub fn overlaps(&self, bmin: Float3, bmax: Float3) -> bool {
        self.min.x <= bmax.x && self.max.x >= bmin.x && self.min.y <= bmax.y && self.max.y >= bmin.y && self.min.z <= bmax.z && self.max.z >= bmin.z
    }
}
