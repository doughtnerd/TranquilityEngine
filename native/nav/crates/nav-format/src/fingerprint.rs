//! Content fingerprints, mirroring Foxfire's `NavMeshFingerprint` (Runtime/Lib/NavMeshFingerprint.cs) and
//! `NavHash` (Runtime/Lib/NavHash.cs): chained xxHash3-64 over the raw bytes of values and arrays.
//!
//! `NavHash.Bytes(data, n, seed)` = xxh3-64 with `seed`; `NavHash.Array` hashes the `i32` length first (as the
//! seed for the contents), then the contents if non-empty. Arrays hash their raw struct bytes, padding included,
//! which is why the layouts in [`crate::blob`] carry their padding as explicit zero fields.
//!
//! Navmesh: arrays in order Verts, PolyVerts, Polys, Links, Bins, BinAdjacency, DetailVerts, DetailTris, Areas,
//! PolyMin, PolyMax, IndexKeys, IndexStart, IndexPolys, then SeamEdges only if non-empty. Excluded: the scalars
//! (IndexCellSize, SeamHeightTolerance), TileRanges and OpenEdges (bookkeeping).
//!
//! Volume: `Value(float4(Origin, CellSize))`, `Value(int4(Dims, 0))`, arrays BaseLeaf, Leaves, Neighbors, Areas,
//! then only if Blocks is non-empty: `Value(int4(BaseScale, 0, 0, 0))`, arrays Blocks, BlockLeaf. Excluded:
//! AgentRadius and BaseDims (BaseDims follows from Dims and BaseScale).
//!
//! Landing links, gate table, chunk border and formations have no Foxfire fingerprint; the ones here are Myco's
//! (same chaining, seed `0x5EED`) so every section of a `myco.nav@1` file can carry one.
use crate::blob::*;
use crate::pod::{bytes_of, bytes_of_one, Pod};
use nav_math::{Float4, Int4};

/// Foxfire's hash seed for fingerprints.
pub const SEED: u64 = 0x5EED;

/// A chained 64-bit content hash: `hash64(data, seed)`.
///
/// A seam for tests (counting or failing hashers); [`Xxh3`] is the real one, through `nav_math::hash`.
pub trait ChainHash {
    fn hash64(&self, data: &[u8], seed: u64) -> u64;
}

/// xxHash3-64 with seed: what Unity's `xxHash3.Hash64(data, bytes, seed)` returns (low word | high word << 32).
#[derive(Clone, Copy, Debug, Default)]
pub struct Xxh3;
impl ChainHash for Xxh3 {
    fn hash64(&self, data: &[u8], seed: u64) -> u64 {
        nav_math::hash::hash_bytes(data, seed)
    }
}

/// `NavHash.Value`.
pub fn hash_value<T: Pod, H: ChainHash>(h: &H, v: &T, seed: u64) -> u64 {
    h.hash64(bytes_of_one(v), seed)
}

/// `NavHash.Array`: length, then contents.
pub fn hash_array<T: Pod, H: ChainHash>(h: &H, a: &[T], seed: u64) -> u64 {
    let seed = h.hash64(&(a.len() as i32).to_le_bytes(), seed);
    if a.is_empty() {
        seed
    } else {
        h.hash64(bytes_of(a), seed)
    }
}

/// `NavMeshFingerprint.Hash(ref NavMeshBlob)`.
pub fn hash_navmesh_with<H: ChainHash>(h: &H, n: &NavMeshData) -> u64 {
    let mut s = SEED;
    s = hash_array(h, &n.verts, s);
    s = hash_array(h, &n.poly_verts, s);
    s = hash_array(h, &n.polys, s);
    s = hash_array(h, &n.links, s);
    s = hash_array(h, &n.bins, s);
    s = hash_array(h, &n.bin_adjacency, s);
    s = hash_array(h, &n.detail_verts, s);
    s = hash_array(h, &n.detail_tris, s);
    s = hash_array(h, &n.areas, s);
    s = hash_array(h, &n.poly_min, s);
    s = hash_array(h, &n.poly_max, s);
    s = hash_array(h, &n.index_keys, s);
    s = hash_array(h, &n.index_start, s);
    s = hash_array(h, &n.index_polys, s);
    if n.seam_edges.is_empty() {
        return s; // navmeshes without chunk bounds hash as they always did
    }
    hash_array(h, &n.seam_edges, s)
}

/// `NavMeshFingerprint.Hash(ref NavVolumeBlob)`.
pub fn hash_volume_with<H: ChainHash>(h: &H, v: &NavVolumeData) -> u64 {
    let mut s = hash_value(h, &Float4::new(v.origin.x, v.origin.y, v.origin.z, v.cell_size), SEED);
    s = hash_value(h, &Int4::new(v.dims.x, v.dims.y, v.dims.z, 0), s);
    s = hash_array(h, &v.base_leaf, s);
    s = hash_array(h, &v.leaves, s);
    s = hash_array(h, &v.neighbors, s);
    s = hash_array(h, &v.areas, s);
    if v.blocks.is_empty() {
        return s; // volumes without resolution regions hash as they always did
    }
    s = hash_value(h, &Int4::new(v.base_scale, 0, 0, 0), s);
    s = hash_array(h, &v.blocks, s);
    hash_array(h, &v.block_leaf, s)
}

/// Myco's landing-links fingerprint: Links, PolyStart, ByLeaf, LeafStart.
pub fn hash_landing_links_with<H: ChainHash>(h: &H, l: &NavLandingLinksData) -> u64 {
    let mut s = hash_array(h, &l.links, SEED);
    s = hash_array(h, &l.poly_start, s);
    s = hash_array(h, &l.by_leaf, s);
    hash_array(h, &l.leaf_start, s)
}

/// Myco's gate-table fingerprint: the id array, then the starting closed flags.
pub fn hash_gate_table_with<H: ChainHash>(h: &H, g: &NavGateTableData) -> u64 {
    let s = hash_array(h, &g.ids, SEED);
    hash_array(h, &g.closed, s)
}

/// Myco's agent-table fingerprint: the entry array.
pub fn hash_agent_table_with<H: ChainHash>(h: &H, a: &NavAgentTableData) -> u64 {
    hash_array(h, &a.entries, SEED)
}

/// Myco's chunk-border fingerprint: box, overhang, depths, then the four arrays.
pub fn hash_chunk_border_with<H: ChainHash>(h: &H, b: &NavChunkBorderData) -> u64 {
    let mut s = hash_value(h, &Float4::new(b.box_min.x, b.box_min.y, b.box_min.z, 0.0), SEED);
    s = hash_value(h, &Float4::new(b.box_max.x, b.box_max.y, b.box_max.z, 0.0), s);
    s = hash_value(h, &b.overhang, s);
    s = hash_value(h, &Int4::new(b.min_depth, b.max_depth, 0, 0), s);
    s = hash_array(h, &b.triangles, s);
    s = hash_array(h, &b.profiles, s);
    s = hash_array(h, &b.agents, s);
    hash_array(h, &b.areas, s)
}

/// Myco's formation fingerprint: Slots, then Width and Depth.
pub fn hash_formation_with<H: ChainHash>(h: &H, f: &NavFormationData) -> u64 {
    let s = hash_array(h, &f.slots, SEED);
    hash_value(h, &Int4::new(f.width, f.depth, 0, 0), s)
}

pub fn hash_navmesh(n: &NavMeshData) -> u64 {
    hash_navmesh_with(&Xxh3, n)
}
pub fn hash_volume(v: &NavVolumeData) -> u64 {
    hash_volume_with(&Xxh3, v)
}

fn hex(v: u64) -> String {
    format!("{v:016X}")
}

/// "polys=N links=N jumps=N hash=XXXXXXXXXXXXXXXX" (`NavMeshFingerprint.Describe`).
pub fn describe_navmesh(n: &NavMeshData) -> String {
    let jumps = n.links.iter().filter(|l| l.kind == NavLinkKind::JUMP).count();
    format!("polys={} links={} jumps={} hash={}", n.polys.len(), n.links.len(), jumps, hex(hash_navmesh(n)))
}

/// "leaves=N hash=XXXXXXXXXXXXXXXX" (`NavMeshFingerprint.Describe`).
pub fn describe_volume(v: &NavVolumeData) -> String {
    format!("leaves={} hash={}", v.leaves.len(), hex(hash_volume(v)))
}
