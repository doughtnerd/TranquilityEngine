//! The `myco.nav@1` container: one scene's bake (ADR 0065), written beside the scene as `<scene>.nav.bin`.
//!
//! All integers and floats are little-endian. Every offset and section start is a multiple of 8.
//!
//! ```text
//! Header (72 bytes)
//!    0  [u8; 8]    magic "MYCONAV\0"
//!    8  [u8; 16]   format string "myco.nav@1", zero padded
//!   24  u32        format version (1)
//!   28  [u32; 3]   package version (major, minor, patch)
//!   40  [u32; 4]   bake input signature (Hash128)
//!   56  u32        section count
//!   60  u32        reserved (0)
//!   64  u64        total file length in bytes
//! Section table (section count x 40 bytes, from byte 72)
//!    0  u32        kind (SectionKind)
//!    4  u32        group: agent-type / group id (navmesh, volume); the walking group (landing links); else 0
//!    8  u32        group2: the flying group (landing links); else 0
//!   12  u32        reserved (0)
//!   16  u64        payload offset from the file start (multiple of 8, past the table, ascending, no overlap)
//!   24  u64        payload length (multiple of 8)
//!   32  u64        fingerprint of the payload's data (see crate::fingerprint; NavMeshFingerprint for navmeshes
//!                  and volumes)
//! Payloads
//!   a block of scalars (fixed per kind, a multiple of 8 bytes), then each array in the blob's declaration
//!   order as: u64 element count, then count x size_of::<T>() raw little-endian bytes, zero padded to a
//!   multiple of 8. The payload must be consumed exactly.
//! ```
//!
//! Scalars: navmesh {f32 index_cell_size, f32 seam_height_tolerance}; volume {origin f32x3, cell_size f32, dims
//! i32x3, agent_radius f32, base_scale i32, base_dims i32x3}; chunk border {box_min f32x3, box_max f32x3,
//! overhang f32x4, min_depth i32, max_depth i32}; formation {width i32, depth i32}; landing links and gate table
//! have none.
//!
//! Section kinds are unique per (kind, group, group2); the gate table and chunk border appear at most once.
use crate::blob::*;
use crate::fingerprint::*;
use crate::pod::{bytes_of, bytes_of_one, read_one, vec_from_bytes, Pod};
use core::fmt;

pub const MAGIC: [u8; 8] = *b"MYCONAV\0";
pub const FORMAT: &str = "myco.nav@1";
pub const FORMAT_VERSION: u32 = 1;
pub const HEADER_LEN: usize = 72;
pub const SECTION_ENTRY_LEN: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u32)]
pub enum SectionKind {
    NavMesh = 1,
    Volume = 2,
    LandingLinks = 3,
    GateTable = 4,
    ChunkBorder = 5,
    Formation = 6,
}
impl SectionKind {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            1 => Self::NavMesh,
            2 => Self::Volume,
            3 => Self::LandingLinks,
            4 => Self::GateTable,
            5 => Self::ChunkBorder,
            6 => Self::Formation,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormatError {
    /// The data ended before `needed` bytes were available at `at` (or the header's file length says so).
    Truncated { at: usize, needed: usize, have: usize },
    BadMagic,
    /// The format string isn't "myco.nav@1".
    UnsupportedFormat(String),
    /// Format string matched but the version number isn't ours.
    VersionMismatch { found: u32, expected: u32 },
    /// Header or section table inconsistent (offsets, lengths, ordering, reserved fields, file length).
    BadLayout(&'static str),
    UnknownSectionKind(u32),
    DuplicateSection { kind: u32, group: u32, group2: u32 },
    /// An array count that overflows or runs past the end of its section.
    BadCount { what: &'static str, count: u64 },
    /// A section payload has bytes left after its last array.
    TrailingBytes { kind: u32, extra: usize },
    /// An enum value outside its range.
    InvalidEnum { what: &'static str, value: i64 },
    FingerprintMismatch { kind: u32, group: u32, stored: u64, computed: u64 },
}
impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use FormatError::*;
        match self {
            Truncated { at, needed, have } => write!(f, "truncated: need {needed} bytes at {at}, file has {have}"),
            BadMagic => write!(f, "not a myco.nav file (bad magic)"),
            UnsupportedFormat(s) => write!(f, "unsupported format {s:?}, expected {FORMAT:?}"),
            VersionMismatch { found, expected } => write!(f, "format version {found}, expected {expected}"),
            BadLayout(s) => write!(f, "bad layout: {s}"),
            UnknownSectionKind(k) => write!(f, "unknown section kind {k}"),
            DuplicateSection { kind, group, group2 } => write!(f, "duplicate section kind {kind} group {group}/{group2}"),
            BadCount { what, count } => write!(f, "bad element count {count} for {what}"),
            TrailingBytes { kind, extra } => write!(f, "section kind {kind} has {extra} trailing bytes"),
            InvalidEnum { what, value } => write!(f, "invalid {what} value {value}"),
            FingerprintMismatch { kind, group, stored, computed } => {
                write!(f, "fingerprint mismatch in section kind {kind} group {group}: stored {stored:016X}, computed {computed:016X}")
            }
        }
    }
}
impl std::error::Error for FormatError {}

// ---------------------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct NavMeshSection {
    pub group: u32,
    pub data: NavMeshData,
}
#[derive(Clone, Debug, PartialEq)]
pub struct VolumeSection {
    pub group: u32,
    pub data: NavVolumeData,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LandingLinksSection {
    /// The walking group (navmesh) side.
    pub ground_group: u32,
    /// The flying group (volume) side.
    pub air_group: u32,
    pub data: NavLandingLinksData,
}
#[derive(Clone, Debug, PartialEq)]
pub struct FormationSection {
    pub id: u32,
    pub data: NavFormationData,
}

/// A scene's bake.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BakeFile {
    pub package_version: [u32; 3],
    /// The bake input signature: equal inputs, equal signature.
    pub signature: Hash128,
    pub navmeshes: Vec<NavMeshSection>,
    pub volumes: Vec<VolumeSection>,
    pub landing_links: Vec<LandingLinksSection>,
    pub gate_table: Option<NavGateTableData>,
    pub chunk_border: Option<NavChunkBorderData>,
    pub formations: Vec<FormationSection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SectionInfo {
    pub kind: SectionKind,
    pub group: u32,
    pub group2: u32,
    pub offset: u64,
    pub length: u64,
    pub fingerprint: u64,
}

/// The header and section table, without the payloads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileHeader {
    pub package_version: [u32; 3],
    pub signature: Hash128,
    pub file_len: u64,
    pub sections: Vec<SectionInfo>,
}

// ---------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------

struct W {
    buf: Vec<u8>,
}
impl W {
    fn pad8(&mut self) {
        while self.buf.len() % 8 != 0 {
            self.buf.push(0);
        }
    }
    fn pod<T: Pod>(&mut self, v: &T) {
        self.buf.extend_from_slice(bytes_of_one(v));
    }
    fn f32(&mut self, v: f32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn array<T: Pod>(&mut self, a: &[T]) {
        self.buf.extend_from_slice(&(a.len() as u64).to_le_bytes());
        self.buf.extend_from_slice(bytes_of(a));
        self.pad8();
    }
}

fn navmesh_payload(n: &NavMeshData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.f32(n.index_cell_size);
    w.f32(n.seam_height_tolerance);
    w.array(&n.verts);
    w.array(&n.poly_verts);
    w.array(&n.polys);
    w.array(&n.links);
    w.array(&n.bins);
    w.array(&n.bin_adjacency);
    w.array(&n.detail_verts);
    w.array(&n.detail_tris);
    w.array(&n.areas);
    w.array(&n.poly_min);
    w.array(&n.poly_max);
    w.array(&n.index_keys);
    w.array(&n.index_start);
    w.array(&n.index_polys);
    w.array(&n.seam_edges);
    w.array(&n.tile_ranges);
    w.array(&n.open_edges);
    w.buf
}

fn volume_payload(v: &NavVolumeData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.pod(&v.origin);
    w.f32(v.cell_size);
    w.pod(&v.dims);
    w.f32(v.agent_radius);
    w.i32(v.base_scale);
    w.pod(&v.base_dims);
    w.array(&v.base_leaf);
    w.array(&v.blocks);
    w.array(&v.block_leaf);
    w.array(&v.leaves);
    w.array(&v.neighbors);
    w.array(&v.areas);
    w.buf
}

fn landing_payload(l: &NavLandingLinksData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.array(&l.links);
    w.array(&l.poly_start);
    w.array(&l.by_leaf);
    w.array(&l.leaf_start);
    w.buf
}

fn gate_payload(g: &NavGateTableData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.array(&g.ids);
    w.buf
}

fn border_payload(b: &NavChunkBorderData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.pod(&b.box_min);
    w.pod(&b.box_max);
    w.pod(&b.overhang);
    w.i32(b.min_depth);
    w.i32(b.max_depth);
    w.array(&b.triangles);
    w.array(&b.profiles);
    w.array(&b.agents);
    w.array(&b.areas);
    w.buf
}

fn formation_payload(f: &NavFormationData) -> Vec<u8> {
    let mut w = W { buf: Vec::new() };
    w.i32(f.width);
    w.i32(f.depth);
    w.array(&f.slots);
    w.buf
}

/// Serialises a bake with the default hasher. Sections are ordered by (kind, group, group2), so the output
/// doesn't depend on the order of the lists in `file`.
pub fn write(file: &BakeFile) -> Vec<u8> {
    write_with(file, &Xxh3)
}

pub fn write_with<H: ChainHash>(file: &BakeFile, h: &H) -> Vec<u8> {
    struct Out {
        kind: SectionKind,
        group: u32,
        group2: u32,
        fingerprint: u64,
        payload: Vec<u8>,
    }
    let mut outs: Vec<Out> = Vec::new();
    for s in &file.navmeshes {
        outs.push(Out { kind: SectionKind::NavMesh, group: s.group, group2: 0, fingerprint: hash_navmesh_with(h, &s.data), payload: navmesh_payload(&s.data) });
    }
    for s in &file.volumes {
        outs.push(Out { kind: SectionKind::Volume, group: s.group, group2: 0, fingerprint: hash_volume_with(h, &s.data), payload: volume_payload(&s.data) });
    }
    for s in &file.landing_links {
        outs.push(Out {
            kind: SectionKind::LandingLinks,
            group: s.ground_group,
            group2: s.air_group,
            fingerprint: hash_landing_links_with(h, &s.data),
            payload: landing_payload(&s.data),
        });
    }
    if let Some(g) = &file.gate_table {
        outs.push(Out { kind: SectionKind::GateTable, group: 0, group2: 0, fingerprint: hash_gate_table_with(h, g), payload: gate_payload(g) });
    }
    if let Some(b) = &file.chunk_border {
        outs.push(Out { kind: SectionKind::ChunkBorder, group: 0, group2: 0, fingerprint: hash_chunk_border_with(h, b), payload: border_payload(b) });
    }
    for s in &file.formations {
        outs.push(Out { kind: SectionKind::Formation, group: s.id, group2: 0, fingerprint: hash_formation_with(h, &s.data), payload: formation_payload(&s.data) });
    }
    outs.sort_by_key(|o| (o.kind, o.group, o.group2));

    let table_end = HEADER_LEN + outs.len() * SECTION_ENTRY_LEN;
    let total = table_end + outs.iter().map(|o| o.payload.len()).sum::<usize>();
    let mut buf = Vec::with_capacity(total);
    buf.extend_from_slice(&MAGIC);
    let mut fmt = [0u8; 16];
    fmt[..FORMAT.len()].copy_from_slice(FORMAT.as_bytes());
    buf.extend_from_slice(&fmt);
    buf.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    for v in file.package_version {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    for v in file.signature.to_array() {
        buf.extend_from_slice(&v.to_le_bytes());
    }
    buf.extend_from_slice(&(outs.len() as u32).to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&(total as u64).to_le_bytes());
    debug_assert_eq!(buf.len(), HEADER_LEN);

    let mut offset = table_end;
    for o in &outs {
        buf.extend_from_slice(&(o.kind as u32).to_le_bytes());
        buf.extend_from_slice(&o.group.to_le_bytes());
        buf.extend_from_slice(&o.group2.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&(offset as u64).to_le_bytes());
        buf.extend_from_slice(&(o.payload.len() as u64).to_le_bytes());
        buf.extend_from_slice(&o.fingerprint.to_le_bytes());
        offset += o.payload.len();
    }
    for o in &outs {
        buf.extend_from_slice(&o.payload);
    }
    debug_assert_eq!(buf.len(), total);
    buf
}

// ---------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------

struct R<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], FormatError> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.data.len());
        match end {
            Some(e) => {
                let s = &self.data[self.pos..e];
                self.pos = e;
                Ok(s)
            }
            None => Err(FormatError::Truncated { at: self.pos, needed: n, have: self.data.len() }),
        }
    }
    fn u32(&mut self) -> Result<u32, FormatError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, FormatError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, FormatError> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, FormatError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn pod<T: Pod>(&mut self) -> Result<T, FormatError> {
        Ok(read_one::<T>(self.take(core::mem::size_of::<T>())?))
    }
    fn array<T: Pod>(&mut self, what: &'static str) -> Result<Vec<T>, FormatError> {
        let count = self.u64()?;
        let bad = FormatError::BadCount { what, count };
        let bytes = usize::try_from(count).ok().and_then(|c| c.checked_mul(core::mem::size_of::<T>())).ok_or(bad.clone())?;
        let padded = bytes.checked_add(7).ok_or(bad.clone())? & !7;
        if padded > self.data.len() - self.pos {
            return Err(bad);
        }
        let raw = self.take(padded)?;
        Ok(vec_from_bytes(&raw[..bytes]))
    }
    fn finish(&self, kind: SectionKind) -> Result<(), FormatError> {
        match self.data.len() - self.pos {
            0 => Ok(()),
            extra => Err(FormatError::TrailingBytes { kind: kind as u32, extra }),
        }
    }
}

/// Parses the header and section table and checks their consistency; payloads aren't touched.
pub fn read_header(data: &[u8]) -> Result<FileHeader, FormatError> {
    let mut r = R { data, pos: 0 };
    if data.len() < HEADER_LEN {
        // Distinguish "not our file" from "our file, cut short" when the prefix allows it.
        if data.len() >= 8 && data[..8] != MAGIC {
            return Err(FormatError::BadMagic);
        }
        return Err(FormatError::Truncated { at: data.len(), needed: HEADER_LEN, have: data.len() });
    }
    if r.take(8)? != MAGIC {
        return Err(FormatError::BadMagic);
    }
    let fmt_bytes = r.take(16)?;
    let fmt_len = fmt_bytes.iter().position(|&b| b == 0).unwrap_or(16);
    let fmt = String::from_utf8_lossy(&fmt_bytes[..fmt_len]).into_owned();
    if fmt != FORMAT {
        return Err(FormatError::UnsupportedFormat(fmt));
    }
    let version = r.u32()?;
    if version != FORMAT_VERSION {
        return Err(FormatError::VersionMismatch { found: version, expected: FORMAT_VERSION });
    }
    let package_version = [r.u32()?, r.u32()?, r.u32()?];
    let signature = Hash128::new(r.u32()?, r.u32()?, r.u32()?, r.u32()?);
    let count = r.u32()? as usize;
    if r.u32()? != 0 {
        return Err(FormatError::BadLayout("reserved header field is not zero"));
    }
    let file_len = r.u64()?;
    if file_len > data.len() as u64 {
        return Err(FormatError::Truncated { at: data.len(), needed: (file_len - data.len() as u64).min(usize::MAX as u64) as usize, have: data.len() });
    }
    if file_len < data.len() as u64 {
        return Err(FormatError::BadLayout("file is longer than its header says"));
    }
    let table_end = count
        .checked_mul(SECTION_ENTRY_LEN)
        .and_then(|t| t.checked_add(HEADER_LEN))
        .filter(|&e| e <= data.len())
        .ok_or(FormatError::Truncated { at: HEADER_LEN, needed: count.saturating_mul(SECTION_ENTRY_LEN), have: data.len() })?;

    let mut sections: Vec<SectionInfo> = Vec::with_capacity(count);
    let mut prev_end = table_end as u64;
    for _ in 0..count {
        let kind_raw = r.u32()?;
        let kind = SectionKind::from_u32(kind_raw).ok_or(FormatError::UnknownSectionKind(kind_raw))?;
        let group = r.u32()?;
        let group2 = r.u32()?;
        if r.u32()? != 0 {
            return Err(FormatError::BadLayout("reserved section field is not zero"));
        }
        let offset = r.u64()?;
        let length = r.u64()?;
        let fingerprint = r.u64()?;
        if offset % 8 != 0 || length % 8 != 0 {
            return Err(FormatError::BadLayout("section offset or length is not a multiple of 8"));
        }
        if offset < prev_end {
            return Err(FormatError::BadLayout("sections overlap, are out of order, or start inside the table"));
        }
        let end = offset.checked_add(length).filter(|&e| e <= file_len).ok_or(FormatError::BadLayout("section runs past the end of the file"))?;
        prev_end = end;
        if sections.iter().any(|s| s.kind == kind && s.group == group && s.group2 == group2) {
            return Err(FormatError::DuplicateSection { kind: kind_raw, group, group2 });
        }
        if matches!(kind, SectionKind::GateTable | SectionKind::ChunkBorder) && (group != 0 || group2 != 0) {
            return Err(FormatError::BadLayout("gate table and chunk border take no group"));
        }
        sections.push(SectionInfo { kind, group, group2, offset, length, fingerprint });
    }
    Ok(FileHeader { package_version, signature, file_len, sections })
}

fn check_enums(what: &'static str, edges: &[NavSeamEdge]) -> Result<(), FormatError> {
    match edges.iter().find(|e| !e.face.is_valid()) {
        Some(e) => Err(FormatError::InvalidEnum { what, value: e.face.0 as i64 }),
        None => Ok(()),
    }
}

fn parse_navmesh(p: &[u8]) -> Result<NavMeshData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let index_cell_size = r.f32()?;
    let seam_height_tolerance = r.f32()?;
    let n = NavMeshData {
        verts: r.array("verts")?,
        poly_verts: r.array("poly_verts")?,
        polys: r.array("polys")?,
        links: r.array("links")?,
        bins: r.array("bins")?,
        bin_adjacency: r.array("bin_adjacency")?,
        detail_verts: r.array("detail_verts")?,
        detail_tris: r.array("detail_tris")?,
        areas: r.array("areas")?,
        poly_min: r.array("poly_min")?,
        poly_max: r.array("poly_max")?,
        index_cell_size,
        index_keys: r.array("index_keys")?,
        index_start: r.array("index_start")?,
        index_polys: r.array("index_polys")?,
        seam_edges: r.array("seam_edges")?,
        seam_height_tolerance,
        tile_ranges: r.array("tile_ranges")?,
        open_edges: r.array("open_edges")?,
    };
    r.finish(SectionKind::NavMesh)?;
    if let Some(l) = n.links.iter().find(|l| !l.kind.is_valid()) {
        return Err(FormatError::InvalidEnum { what: "NavLinkKind", value: l.kind.0 as i64 });
    }
    check_enums("NavChunkFace (seam edge)", &n.seam_edges)?;
    check_enums("NavChunkFace (open edge)", &n.open_edges)?;
    Ok(n)
}

fn parse_volume(p: &[u8]) -> Result<NavVolumeData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let v = NavVolumeData {
        origin: r.pod()?,
        cell_size: r.f32()?,
        dims: r.pod()?,
        agent_radius: r.f32()?,
        base_scale: r.i32()?,
        base_dims: r.pod()?,
        base_leaf: r.array("base_leaf")?,
        blocks: r.array("blocks")?,
        block_leaf: r.array("block_leaf")?,
        leaves: r.array("leaves")?,
        neighbors: r.array("neighbors")?,
        areas: r.array("areas")?,
    };
    r.finish(SectionKind::Volume)?;
    Ok(v)
}

fn parse_landing(p: &[u8]) -> Result<NavLandingLinksData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let l = NavLandingLinksData {
        links: r.array("landing links")?,
        poly_start: r.array("poly_start")?,
        by_leaf: r.array("by_leaf")?,
        leaf_start: r.array("leaf_start")?,
    };
    r.finish(SectionKind::LandingLinks)?;
    Ok(l)
}

fn parse_gate(p: &[u8]) -> Result<NavGateTableData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let g = NavGateTableData { ids: r.array("gate ids")? };
    r.finish(SectionKind::GateTable)?;
    Ok(g)
}

fn parse_border(p: &[u8]) -> Result<NavChunkBorderData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let b = NavChunkBorderData {
        box_min: r.pod()?,
        box_max: r.pod()?,
        overhang: r.pod()?,
        min_depth: r.i32()?,
        max_depth: r.i32()?,
        triangles: r.array("triangles")?,
        profiles: r.array("profiles")?,
        agents: r.array("agents")?,
        areas: r.array("areas")?,
    };
    r.finish(SectionKind::ChunkBorder)?;
    Ok(b)
}

fn parse_formation(p: &[u8]) -> Result<NavFormationData, FormatError> {
    let mut r = R { data: p, pos: 0 };
    let f = NavFormationData { width: r.i32()?, depth: r.i32()?, slots: r.array("slots")? };
    r.finish(SectionKind::Formation)?;
    Ok(f)
}

/// Parses a bake, verifying every section's stored fingerprint with the default hasher.
pub fn read(data: &[u8]) -> Result<BakeFile, FormatError> {
    read_with(data, Some(&Xxh3))
}

/// Parses a bake; `verify` = `Some(hasher)` recomputes each section's fingerprint and compares it with the
/// stored one (`None` skips the check, for loading trusted files fast).
pub fn read_with<H: ChainHash>(data: &[u8], verify: Option<&H>) -> Result<BakeFile, FormatError> {
    let header = read_header(data)?;
    let mut file = BakeFile { package_version: header.package_version, signature: header.signature, ..Default::default() };
    for s in &header.sections {
        let payload = &data[s.offset as usize..(s.offset + s.length) as usize];
        let check = |computed: u64| match verify {
            Some(_) if computed != s.fingerprint => {
                Err(FormatError::FingerprintMismatch { kind: s.kind as u32, group: s.group, stored: s.fingerprint, computed })
            }
            _ => Ok(()),
        };
        match s.kind {
            SectionKind::NavMesh => {
                let d = parse_navmesh(payload)?;
                if let Some(h) = verify {
                    check(hash_navmesh_with(h, &d))?;
                }
                file.navmeshes.push(NavMeshSection { group: s.group, data: d });
            }
            SectionKind::Volume => {
                let d = parse_volume(payload)?;
                if let Some(h) = verify {
                    check(hash_volume_with(h, &d))?;
                }
                file.volumes.push(VolumeSection { group: s.group, data: d });
            }
            SectionKind::LandingLinks => {
                let d = parse_landing(payload)?;
                if let Some(h) = verify {
                    check(hash_landing_links_with(h, &d))?;
                }
                file.landing_links.push(LandingLinksSection { ground_group: s.group, air_group: s.group2, data: d });
            }
            SectionKind::GateTable => {
                let d = parse_gate(payload)?;
                if let Some(h) = verify {
                    check(hash_gate_table_with(h, &d))?;
                }
                file.gate_table = Some(d);
            }
            SectionKind::ChunkBorder => {
                let d = parse_border(payload)?;
                if let Some(h) = verify {
                    check(hash_chunk_border_with(h, &d))?;
                }
                file.chunk_border = Some(d);
            }
            SectionKind::Formation => {
                let d = parse_formation(payload)?;
                if let Some(h) = verify {
                    check(hash_formation_with(h, &d))?;
                }
                file.formations.push(FormationSection { id: s.group, data: d });
            }
        }
    }
    Ok(file)
}
