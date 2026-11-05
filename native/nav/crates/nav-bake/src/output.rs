//! The blob-building end of a bake (Foxfire `NavMeshStitcher.ToBlob`, `Lib/NavPolyIndex.cs`, and the navmesh parts of
//! `Authoring/Baking/NavBakeOutputSystem.cs`): stitched lists to [`NavMeshData`], the nearest-polygon index, navmesh
//! bounds, the fingerprint log line and the chunk id.
//!
//! What stays behind in Unity and has no counterpart here: entity creation, the `BlobAssetStore`, baking-world
//! cleanup, scene sections and guids. The orchestrator owns writing the `myco.nav@1` file (`nav_format::write`).
use nav_format::fingerprint::describe_navmesh;
use nav_format::{NavAreaInfo, NavLink, NavMeshData, NavPoly, NavSeamEdge, NavTileRange, OrientationBin};
use nav_math::hash::{hash_array, CHUNK_SEED};
use nav_math::{math, Float3, Hash128, Int3, Int4};

/// A link and the poly it leaves (`LinkRec`): links are grouped by source poly when the blob is built.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LinkRec {
    pub from: i32,
    pub link: NavLink,
}

/// The stitcher's lists, before the blob (`ToBlob`'s parameters). `link_recs` is in generation order: internal links
/// by poly, then seam links, folds, jumps; grouping is stable, so that order survives within a poly.
#[derive(Clone, Debug, Default)]
pub struct StitchedMesh {
    pub verts: Vec<Float3>,
    pub poly_verts: Vec<i32>,
    /// `link_start` / `link_count` are filled in by [`build_nav_mesh_data`].
    pub polys: Vec<NavPoly>,
    pub link_recs: Vec<LinkRec>,
    pub detail_verts: Vec<Float3>,
    pub detail_tris: Vec<Int4>,
    pub seams: Vec<NavSeamEdge>,
    pub tile_ranges: Vec<NavTileRange>,
    pub open_edges: Vec<NavSeamEdge>,
}

/// `NavMeshStitcher.ToBlob`: groups the links by source poly with a counting sort (stable: internal links stay before
/// folds), copies the arrays, and builds the nearest-polygon index. `areas` `None` means an empty area table.
pub fn build_nav_mesh_data(
    mut m: StitchedMesh,
    bins: &[OrientationBin],
    adjacency: &[u64],
    areas: Option<&[NavAreaInfo]>,
    seam_height_tolerance: f32,
) -> NavMeshData {
    let mut counts = vec![0i32; m.polys.len()];
    for r in &m.link_recs {
        counts[r.from as usize] += 1;
    }

    let mut cursor = vec![0i32; m.polys.len()];
    let mut running = 0;
    for p in 0..m.polys.len() {
        m.polys[p].link_start = running;
        m.polys[p].link_count = counts[p];
        cursor[p] = running;
        running += counts[p];
    }

    let mut links = vec![NavLink::default(); m.link_recs.len()];
    for rec in &m.link_recs {
        let c = &mut cursor[rec.from as usize];
        links[*c as usize] = rec.link;
        *c += 1;
    }

    let mut nav = NavMeshData {
        verts: m.verts,
        poly_verts: m.poly_verts,
        polys: m.polys,
        links,
        bins: bins.to_vec(),
        bin_adjacency: adjacency.to_vec(),
        detail_verts: m.detail_verts,
        detail_tris: m.detail_tris,
        areas: areas.map(|a| a.to_vec()).unwrap_or_default(),
        seam_edges: m.seams,
        seam_height_tolerance,
        tile_ranges: m.tile_ranges,
        open_edges: m.open_edges,
        ..NavMeshData::default()
    };
    build_poly_index(&mut nav);
    nav
}

// ---------------------------------------------------------------------------------------------------------
// NavPolyIndex
// ---------------------------------------------------------------------------------------------------------

const BITS: i32 = 21;
const OFFSET: i32 = 1 << (BITS - 1);
const MASK: i64 = (1i64 << BITS) - 1;

/// Queries touching more cells than this fall back to testing every polygon (`NavPolyIndex.MaxQueryCells`).
pub const MAX_QUERY_CELLS: i64 = 4096;

/// `NavPolyIndex.CellOf`.
pub fn cell_of(p: Float3, cell_size: f32) -> Int3 {
    Int3::new(
        math::floor(p.x / cell_size) as i32,
        math::floor(p.y / cell_size) as i32,
        math::floor(p.z / cell_size) as i32,
    )
}

/// `NavPolyIndex.Key`: the cell's three 21-bit offset coordinates, packed.
pub fn cell_key(c: Int3) -> i64 {
    ((((c.x.wrapping_add(OFFSET)) as i64) & MASK) << (2 * BITS))
        | ((((c.y.wrapping_add(OFFSET)) as i64) & MASK) << BITS)
        | (((c.z.wrapping_add(OFFSET)) as i64) & MASK)
}

/// `NavPolyIndex.Build`: fills `poly_min` / `poly_max` (poly bounds, detail mesh included) and the sparse grid of sorted
/// cell keys, each owning `index_polys[index_start[k]..index_start[k + 1]]`. Cells are about one average polygon across.
/// The polys must already be in `nav`.
pub fn build_poly_index(nav: &mut NavMeshData) {
    let count = nav.polys.len();
    let mut b_min = Vec::with_capacity(count);
    let mut b_max = Vec::with_capacity(count);

    let mut extent_sum = 0.0f32;
    for poly in &nav.polys {
        let mut min = Float3::splat(f32::MAX);
        let mut max = Float3::splat(f32::MIN);
        for i in 0..poly.vert_count {
            let v = nav.verts[nav.poly_verts[(poly.vert_start + i) as usize] as usize];
            min = min.min_v(v);
            max = max.max_v(v);
        }
        for i in 0..poly.detail_vert_count {
            let v = nav.detail_verts[(poly.detail_vert_start + i) as usize];
            min = min.min_v(v);
            max = max.max_v(v);
        }
        if poly.vert_count == 0 {
            min = poly.center;
            max = poly.center;
        }
        b_min.push(min);
        b_max.push(max);
        extent_sum += (max - min).cmax();
    }

    let cell_size = math::max(if count > 0 { extent_sum / count as f32 } else { 1.0 }, 1e-2);
    nav.index_cell_size = cell_size;

    let mut entries: Vec<(i64, i32)> = Vec::with_capacity(count * 4);
    for p in 0..count {
        let c0 = cell_of(b_min[p], cell_size);
        let c1 = cell_of(b_max[p], cell_size);
        for z in c0.z..=c1.z {
            for y in c0.y..=c1.y {
                for x in c0.x..=c1.x {
                    entries.push((cell_key(Int3::new(x, y, z)), p as i32));
                }
            }
        }
    }

    // By key, then poly: a total order (a poly adds each cell once), so the sort needn't be stable.
    entries.sort_unstable();

    let mut keys: Vec<i64> = Vec::new();
    let mut starts: Vec<i32> = Vec::new();
    let mut index_polys: Vec<i32> = Vec::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        if i == 0 || e.0 != entries[i - 1].0 {
            keys.push(e.0);
            starts.push(i as i32);
        }
        index_polys.push(e.1);
    }
    starts.push(entries.len() as i32);

    nav.poly_min = b_min;
    nav.poly_max = b_max;
    nav.index_keys = keys;
    nav.index_start = starts;
    nav.index_polys = index_polys;
}

/// `NavPolyIndex.TryGetCell`: the polys whose bounds touch the cell with this key (`index_polys` slice), or `None` if
/// the cell is empty.
pub fn poly_index_cell(nav: &NavMeshData, key: i64) -> Option<&[i32]> {
    nav.index_keys.binary_search(&key).ok().map(|k| {
        &nav.index_polys[nav.index_start[k] as usize..nav.index_start[k + 1] as usize]
    })
}

/// `NavPolyIndex.CanQuery`: the index is built, and the box of cells `c0..=c1` isn't too many.
pub fn poly_index_can_query(nav: &NavMeshData, c0: Int3, c1: Int3) -> bool {
    if nav.index_keys.is_empty() || nav.poly_min.len() != nav.polys.len() {
        return false;
    }
    let span = (c1.x - c0.x + 1) as i64 * (c1.y - c0.y + 1) as i64 * (c1.z - c0.z + 1) as i64;
    span <= MAX_QUERY_CELLS
}

/// `NavPolyIndex.BoundsDistanceSq`: squared distance from `p` to the poly's bounds (0 inside).
pub fn poly_bounds_distance_sq(nav: &NavMeshData, poly: usize, p: Float3) -> f32 {
    let zero = Float3::splat(0.0);
    let d = (nav.poly_min[poly] - p).max_v(zero) + (p - nav.poly_max[poly]).max_v(zero);
    d.dot(d)
}

/// Polys whose bounds touch the cell holding `p`, found through the index (a convenience over [`cell_of`], [`cell_key`]
/// and [`poly_index_cell`]).
pub fn polys_near(nav: &NavMeshData, p: Float3) -> &[i32] {
    poly_index_cell(nav, cell_key(cell_of(p, nav.index_cell_size))).unwrap_or(&[])
}

// ---------------------------------------------------------------------------------------------------------
// NavBakeOutputSystem
// ---------------------------------------------------------------------------------------------------------

/// `NavBakeOutputSystem.NavMeshBounds`: world bounds `(min, max)` of a navmesh's vertices; zeroes if it has none.
pub fn nav_mesh_bounds(nav: &NavMeshData) -> (Float3, Float3) {
    if nav.verts.is_empty() {
        return (Float3::default(), Float3::default());
    }
    let mut min = Float3::splat(f32::MAX);
    let mut max = Float3::splat(f32::MIN);
    for v in &nav.verts {
        min = min.min_v(*v);
        max = max.max_v(*v);
    }
    (min, max)
}

/// `GroupName`: the agent types sharing navmesh `g`, for the log: "Ground + Scout". `agents` yields `(group, name)`.
pub fn group_name<'a>(g: i32, agents: impl IntoIterator<Item = (i32, &'a str)>) -> String {
    let mut name = String::new();
    for (group, agent) in agents {
        if group == g {
            if !name.is_empty() {
                name.push_str(" + ");
            }
            name.push_str(agent);
        }
    }
    name
}

/// The fingerprint log line: `NavBake fingerprint: <group> polys=N links=N jumps=N hash=XXXXXXXXXXXXXXXX`.
pub fn fingerprint_line(group_name: &str, nav: &NavMeshData) -> String {
    format!("NavBake fingerprint: {} {}", group_name, describe_navmesh(nav))
}

/// The warning for a navmesh with no polygons (same text as `NavBakeOutputSystem`), or `None`.
pub fn empty_navmesh_warning(group_name: &str, nav: &NavMeshData) -> Option<String> {
    if !nav.polys.is_empty() {
        return None;
    }
    Some(format!(
        "NavBake: the navmesh for {group_name} is empty: nothing in the scene is walkable for it. \
         Meshes whose NavMeshAuthoring lists agent types under Walkable For are solid for every other agent \
         type: add it to those lists (or clear them). Otherwise check its Radius, Height and Step Height \
         against the geometry."
    ))
}

/// A chunk's id (`NavBakeOutputSystem.OutputContext`): the same in every bake and load, different for every chunk.
///
/// Foxfire chains `NavHash.Value` over the subscene's `SceneGUID`, its section and the chunk authoring object's key,
/// from seed `0xC4C4`, then `h1 = hash(h0, 0x5EC7)`. Myco has no subscenes: a chunk is a scene node (ADR 0016), so the
/// two inputs are the scene's project path and the chunk node's id, both UTF-8 strings, hashed as `NavHash.Array` of
/// their bytes (length, then contents). Use the path as stored in the project (forward slashes, project-relative) so
/// the id doesn't depend on the machine. The `0x5EC7` half is `Hash128::from_chunk_hash`.
pub fn chunk_id(scene_path: &str, chunk_node_id: &str) -> Hash128 {
    let mut h0 = hash_array(scene_path.as_bytes(), CHUNK_SEED);
    h0 = hash_array(chunk_node_id.as_bytes(), h0);
    Hash128::from_chunk_hash(h0)
}
