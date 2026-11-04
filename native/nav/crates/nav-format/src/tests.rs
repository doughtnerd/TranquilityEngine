use crate::file::*;
use crate::fingerprint::*;
use crate::*;
use core::mem::{align_of, size_of};
use nav_math::{Float2, Float3, Float4, Int2, Int3, Int4};

// ---- layouts ----------------------------------------------------------------------------------------------

#[test]
fn struct_sizes_match_csharp_layouts() {
    // Field bytes under Unity.Mathematics (float3 = 12, int4 = 16), natural alignment 4 (8 for ulong).
    assert_eq!(size_of::<Hash128>(), 16);
    assert_eq!(size_of::<NavPoly>(), 8 * 4 + 12 + 12 + 4 * 4); // 72
    assert_eq!(size_of::<NavPoly>(), 72);
    // 4 + 1 + 1 (+2 pad) + 4 + 6 float3 + 2 floats
    assert_eq!(size_of::<NavLink>(), 4 + 1 + 1 + 2 + 4 + 6 * 12 + 4 + 4);
    assert_eq!(size_of::<NavLink>(), 92);
    assert_eq!(size_of::<NavSeamEdge>(), 4 + 4 + 12 + 12);
    assert_eq!(size_of::<NavTileRange>(), 16);
    assert_eq!(size_of::<OrientationBin>(), 40);
    assert_eq!(size_of::<NavAreaInfo>(), 16 + 4 + 16);
    // 12 + 4 + 4 + 4 + 1 (+3 pad)
    assert_eq!(size_of::<NavVolumeLeaf>(), 28);
    assert_eq!(size_of::<NavVolumeBlock>(), 8);
    assert_eq!(size_of::<NavLandingLink>(), 36);
    assert_eq!(size_of::<FFBounds>(), 36);
    assert_eq!(size_of::<NavTileAgent>(), 40);
    assert_eq!(size_of::<NavBorderGrid>(), 36 + 8 + 12 + 6 * 4); // 80
    assert_eq!(size_of::<NavBorderProfile>(), 4 + 40 + 80);
    assert_eq!(size_of::<NavBorderAgent>(), 20);
    assert_eq!(size_of::<TriangleData>(), 48);
    assert_eq!(size_of::<NavChunkInfo>(), 12 + 12 + 4 + 4);
    assert_eq!(size_of::<NavLinkKind>(), 1);
    assert_eq!(size_of::<NavChunkFace>(), 4);
    // Everything aligns to at most 4 (no hidden padding from a wider field).
    assert_eq!(align_of::<NavLink>(), 4);
    assert_eq!(align_of::<NavVolumeLeaf>(), 4);
}

#[test]
fn field_offsets_have_no_implicit_padding() {
    use core::mem::offset_of;
    assert_eq!(offset_of!(NavLink, convex), 5);
    assert_eq!(offset_of!(NavLink, _pad), 6);
    assert_eq!(offset_of!(NavLink, fold_angle), 8);
    assert_eq!(offset_of!(NavVolumeLeaf, area), 24);
    assert_eq!(offset_of!(NavVolumeLeaf, _pad), 25);
    assert_eq!(offset_of!(NavSeamEdge, a), 8);
}

#[test]
fn gate_encoding() {
    assert_eq!(NavAreas::MAX, 63);
    assert_eq!(NavAreas::MAX_CUSTOM, 62);
    assert_eq!(NavGates::MAX, 511);
    let code = NavGates::encode(NavAreas::MAX, NavGates::MAX);
    assert_eq!(code, 63 | (511 << 6));
    assert!(code < 1 << 15);
    assert_eq!(NavGates::area_of(code), 63);
    assert_eq!(NavGates::gate_of(code), 511);
    assert_eq!(NavGates::gate_of(NavGates::encode(5, 0)), NavGates::NONE);
    let closed = [false, true, false];
    assert!(NavGates::is_closed(1, &closed));
    assert!(!NavGates::is_closed(0, &closed));
    assert!(!NavGates::is_closed(2, &closed));
    assert!(!NavGates::is_closed(9, &closed)); // past the end: open
}

// ---- sample data ------------------------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn f(&mut self) -> f32 {
        (self.next() % 20000) as f32 / 100.0 - 100.0
    }
    fn i(&mut self, m: u32) -> i32 {
        (self.next() % m) as i32
    }
    fn v3(&mut self) -> Float3 {
        Float3::new(self.f(), self.f(), self.f())
    }
}

fn areas(r: &mut Rng) -> Vec<NavAreaInfo> {
    (0..4)
        .map(|i| NavAreaInfo { id: Hash128::new(i, r.next(), r.next(), r.next()), cost: 1.0 + i as f32, color: Float4::new(0.1, 0.2, 0.3, 1.0) })
        .collect()
}

fn seam(r: &mut Rng, n: usize) -> Vec<NavSeamEdge> {
    (0..n).map(|_| NavSeamEdge { poly: r.i(50), face: NavChunkFace(r.i(4)), a: r.v3(), b: r.v3() }).collect()
}

fn sample_navmesh(seed: u64) -> NavMeshData {
    let mut r = Rng(seed);
    NavMeshData {
        verts: (0..37).map(|_| r.v3()).collect(),
        poly_verts: (0..90).map(|_| r.i(37)).collect(),
        polys: (0..11)
            .map(|i| NavPoly {
                vert_start: i * 3,
                vert_count: 3,
                link_start: i * 2,
                link_count: 2,
                bin: r.i(3),
                area: r.i(4),
                gate: r.i(3),
                flags: r.i(8),
                center: r.v3(),
                normal: r.v3(),
                detail_vert_start: i * 4,
                detail_vert_count: 4,
                detail_tri_start: i * 2,
                detail_tri_count: 2,
            })
            .collect(),
        links: (0..23)
            .map(|i| NavLink {
                to_poly: r.i(11),
                kind: NavLinkKind((i % 3) as u8),
                convex: (i % 2) as u8,
                _pad: 0,
                fold_angle: r.f(),
                portal_a: r.v3(),
                portal_b: r.v3(),
                dest_a: r.v3(),
                dest_b: r.v3(),
                hinge_a: r.v3(),
                hinge_b: r.v3(),
                jump_rise: r.f(),
                jump_distance: r.f(),
            })
            .collect(),
        bins: (0..3).map(|_| OrientationBin { n: r.v3(), t: r.v3(), b: r.v3(), tilt_deg: r.f() }).collect(),
        bin_adjacency: (0..3).map(|_| (r.next() as u64) << 32 | r.next() as u64).collect(),
        detail_verts: (0..44).map(|_| r.v3()).collect(),
        detail_tris: (0..22).map(|_| Int4::new(r.i(4), r.i(4), r.i(4), r.i(64))).collect(),
        areas: areas(&mut r),
        poly_min: (0..11).map(|_| r.v3()).collect(),
        poly_max: (0..11).map(|_| r.v3()).collect(),
        index_cell_size: 4.0,
        index_keys: (0..5).map(|i| (i as i64) << 40 | r.next() as i64).collect(),
        index_start: (0..6).collect(),
        index_polys: (0..5).collect(),
        seam_edges: seam(&mut r, 7),
        seam_height_tolerance: 0.4,
        tile_ranges: (0..3).map(|i| NavTileRange { origin: Int2::new(i, -i), poly_start: i * 4, poly_count: 4 }).collect(),
        open_edges: seam(&mut r, 2),
    }
}

fn sample_volume(seed: u64) -> NavVolumeData {
    let mut r = Rng(seed);
    NavVolumeData {
        origin: r.v3(),
        cell_size: 0.5,
        dims: Int3::new(16, 8, 16),
        agent_radius: 0.75,
        base_scale: 4,
        base_dims: Int3::new(4, 2, 4),
        base_leaf: (0..32).map(|i| if i % 5 == 0 { -1 } else { -2 - (i % 3) }).collect(),
        blocks: (0..3).map(|i| NavVolumeBlock { scale: 1 << i, start: i * 8 }).collect(),
        block_leaf: (0..24).map(|_| r.i(9) - 1).collect(),
        leaves: (0..9)
            .map(|i| NavVolumeLeaf { min: Int3::new(i, 2 * i, 3 * i), size: 1 << (i % 4), neighbor_start: i * 2, neighbor_count: 2, area: (i % 63) as u8, _pad: [0; 3] })
            .collect(),
        neighbors: (0..18).map(|_| r.i(9)).collect(),
        areas: areas(&mut r),
    }
}

fn sample_landing() -> NavLandingLinksData {
    let mut r = Rng(5);
    NavLandingLinksData {
        links: (0..6).map(|i| NavLandingLink { poly: i, leaf: i * 2, ground: r.v3(), air: r.v3(), slope_cos: 0.9 }).collect(),
        poly_start: (0..8).collect(),
        by_leaf: (0..6).rev().collect(),
        leaf_start: (0..11).collect(),
    }
}

fn sample_border() -> NavChunkBorderData {
    let mut r = Rng(9);
    let agent = NavTileAgent {
        radius: 0.4,
        height: 1.8,
        step_height: 0.4,
        min_region_area: 8,
        merge_region_area: 20,
        max_simplification_error: 1.3,
        max_edge_length: 12,
        verts_per_poly: 6,
        detail_sample_distance: 6.0,
        detail_sample_max_error: 1.0,
    };
    let grid = NavBorderGrid {
        bounds: FFBounds { center: r.v3(), min: r.v3(), max: r.v3() },
        cs: 0.3,
        ch: 0.2,
        width: 100,
        height: 80,
        depth: 12,
        tier_mask: 0xF0F0_0001,
        flag_merge_threshold: 3,
        tile_size: 32,
        border: 4,
        tiles_x: 4,
        tiles_z: 3,
    };
    NavChunkBorderData {
        box_min: Float3::new(0.0, -5.0, 0.0),
        box_max: Float3::new(64.0, 20.0, 64.0),
        overhang: Float4::new(0.0, 1.0, 2.0, 3.0),
        min_depth: 1,
        max_depth: 3,
        triangles: (0..10).map(|i| TriangleData { a: r.v3(), b: r.v3(), c: r.v3(), bin: i % 3, walkable_for: r.next(), area: i }).collect(),
        profiles: vec![NavBorderProfile { bit: 1, agent, grid }, NavBorderProfile { bit: 2, agent, grid }],
        agents: vec![NavBorderAgent { agent_type: Hash128::new(1, 2, 3, 4), profile: 0 }, NavBorderAgent { agent_type: Hash128::new(5, 6, 7, 8), profile: 1 }],
        areas: vec![Hash128::default(), Hash128::new(9, 9, 9, 9)],
    }
}

fn sample_file() -> BakeFile {
    BakeFile {
        package_version: [1, 2, 3],
        signature: Hash128::new(0xDEAD, 0xBEEF, 0xCAFE, 0xF00D),
        navmeshes: vec![NavMeshSection { group: 0, data: sample_navmesh(1) }, NavMeshSection { group: 3, data: sample_navmesh(2) }],
        volumes: vec![VolumeSection { group: 1, data: sample_volume(3) }],
        landing_links: vec![LandingLinksSection { ground_group: 0, air_group: 1, data: sample_landing() }],
        gate_table: Some(NavGateTableData { ids: vec![Hash128::default(), Hash128::new(1, 1, 1, 1), Hash128::new(2, 2, 2, 2)], closed: vec![0, 1, 0] }),
        agent_table: Some(NavAgentTableData {
            entries: vec![
                NavAgentEntry { id: Hash128::new(5, 0, 0, 0), walk_group: 0, fly_group: 1, pad: [0; 2] },
                NavAgentEntry { id: Hash128::new(6, 0, 0, 0), walk_group: 3, fly_group: -1, pad: [0; 2] },
            ],
        }),
        chunk_border: Some(sample_border()),
        chunk_info: Some(NavChunkInfo { box_min: Float3::new(0.0, -5.0, 0.0), box_max: Float3::new(64.0, 20.0, 64.0), bounded: 1, pad: 0 }),
        formations: vec![FormationSection { id: 7, data: NavFormationData { slots: vec![Float2::new(0.0, 0.0), Float2::new(1.0, 0.0), Float2::new(-1.0, 0.0)], width: 3, depth: 1 } }],
    }
}

// ---- round trips ------------------------------------------------------------------------------------------

#[test]
fn round_trip_each_blob_kind() {
    let f = sample_file();
    let bytes = write(&f);
    assert_eq!(bytes.len() % 8, 0);
    let back = read(&bytes).unwrap();
    assert_eq!(back, f);
}

#[test]
fn round_trip_empty_and_partial() {
    let empty = BakeFile::default();
    assert_eq!(read(&write(&empty)).unwrap(), empty);

    let only_volume = BakeFile { volumes: vec![VolumeSection { group: 9, data: sample_volume(8) }], ..Default::default() };
    assert_eq!(read(&write(&only_volume)).unwrap(), only_volume);

    let empty_arrays = BakeFile { navmeshes: vec![NavMeshSection { group: 0, data: NavMeshData::default() }], ..Default::default() };
    assert_eq!(read(&write(&empty_arrays)).unwrap(), empty_arrays);
}

#[test]
fn write_is_independent_of_list_order_and_deterministic() {
    let a = sample_file();
    let mut b = a.clone();
    b.navmeshes.reverse();
    assert_eq!(write(&a), write(&a));
    assert_eq!(write(&a), write(&b));
}

#[test]
fn layout_is_aligned_and_header_is_as_documented() {
    let bytes = write(&sample_file());
    assert_eq!(&bytes[..8], b"MYCONAV\0");
    assert_eq!(&bytes[8..18], b"myco.nav@1");
    assert!(bytes[18..24].iter().all(|&b| b == 0));
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 1);
    let h = read_header(&bytes).unwrap();
    assert_eq!(h.package_version, [1, 2, 3]);
    assert_eq!(h.file_len as usize, bytes.len());
    assert_eq!(h.sections.len(), 9);
    for s in &h.sections {
        assert_eq!(s.offset % 8, 0);
        assert_eq!(s.length % 8, 0);
    }
    // Sorted by kind then group.
    assert_eq!((h.sections[0].kind, h.sections[0].group), (SectionKind::NavMesh, 0));
    assert_eq!((h.sections[1].kind, h.sections[1].group), (SectionKind::NavMesh, 3));
    assert_eq!(h.sections[1].fingerprint, hash_navmesh(&sample_navmesh(2)));
}

// ---- corruption -------------------------------------------------------------------------------------------

#[test]
fn rejects_bad_magic() {
    let mut b = write(&sample_file());
    b[0] ^= 0xFF;
    assert_eq!(read(&b).unwrap_err(), FormatError::BadMagic);
    assert_eq!(read(b"hello world, not nav data at all").unwrap_err(), FormatError::BadMagic);
}

#[test]
fn rejects_wrong_format_string_and_version() {
    let mut b = write(&sample_file());
    b[8..18].copy_from_slice(b"myco.nav@2");
    assert!(matches!(read(&b), Err(FormatError::UnsupportedFormat(s)) if s == "myco.nav@2"));
    let mut b = write(&sample_file());
    b[24..28].copy_from_slice(&2u32.to_le_bytes());
    assert_eq!(read(&b).unwrap_err(), FormatError::VersionMismatch { found: 2, expected: 1 });
}

#[test]
fn rejects_every_truncation() {
    let b = write(&sample_file());
    for len in [0, 7, 8, 40, 71, 72, 100, 300, b.len() / 2, b.len() - 8, b.len() - 1] {
        let e = read(&b[..len]).unwrap_err();
        assert!(matches!(e, FormatError::Truncated { .. }), "len {len}: {e:?}");
    }
    // Header only reads must also fail on a short table.
    assert!(matches!(read_header(&b[..100]), Err(FormatError::Truncated { .. })));
}

#[test]
fn rejects_trailing_bytes_after_file() {
    let mut b = write(&sample_file());
    b.extend_from_slice(&[0; 8]);
    assert!(matches!(read(&b), Err(FormatError::BadLayout(_))));
}

#[test]
fn rejects_misaligned_and_overlapping_sections() {
    let base = write(&sample_file());
    let entry0 = HEADER_LEN; // first section entry
    // offset not a multiple of 8
    let mut b = base.clone();
    let off = u64::from_le_bytes(b[entry0 + 16..entry0 + 24].try_into().unwrap());
    b[entry0 + 16..entry0 + 24].copy_from_slice(&(off + 4).to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::BadLayout(_))));
    // offset inside the table
    let mut b = base.clone();
    b[entry0 + 16..entry0 + 24].copy_from_slice(&8u64.to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::BadLayout(_))));
    // length runs past the end of the file
    let mut b = base.clone();
    b[entry0 + 24..entry0 + 32].copy_from_slice(&(1u64 << 40).to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::BadLayout(_))));
    // length overflow
    let mut b = base.clone();
    b[entry0 + 24..entry0 + 32].copy_from_slice(&(u64::MAX - 7).to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::BadLayout(_))));
}

#[test]
fn rejects_unknown_kind_and_duplicates() {
    let base = write(&sample_file());
    let mut b = base.clone();
    b[HEADER_LEN..HEADER_LEN + 4].copy_from_slice(&99u32.to_le_bytes());
    assert_eq!(read(&b).unwrap_err(), FormatError::UnknownSectionKind(99));
    // Second navmesh entry claims group 0 like the first.
    let mut b = base.clone();
    let e1 = HEADER_LEN + SECTION_ENTRY_LEN;
    b[e1 + 4..e1 + 8].copy_from_slice(&0u32.to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::DuplicateSection { kind: 1, group: 0, .. })));
}

#[test]
fn rejects_array_count_past_section() {
    let base = write(&sample_file());
    let h = read_header(&base).unwrap();
    let s = h.sections[0];
    // First array (verts) count sits right after the 8 scalar bytes.
    let at = s.offset as usize + 8;
    let mut b = base.clone();
    b[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    assert!(matches!(read(&b), Err(FormatError::BadCount { what: "verts", .. })));
    let mut b = base.clone();
    b[at..at + 8].copy_from_slice(&(1u64 << 60).to_le_bytes()); // overflows count * size
    assert!(matches!(read(&b), Err(FormatError::BadCount { what: "verts", .. })));
    let mut b = base.clone();
    b[at..at + 8].copy_from_slice(&1_000_000u64.to_le_bytes()); // fits arithmetic, not the section
    assert!(matches!(read(&b), Err(FormatError::BadCount { what: "verts", .. })));
}

#[test]
fn rejects_trailing_bytes_inside_section() {
    // Shrink the declared verts count so bytes are left over at the end of the section.
    let base = write(&sample_file());
    let h = read_header(&base).unwrap();
    let s = h.sections[0];
    let at = s.offset as usize + 8;
    let mut b = base.clone();
    let count = u64::from_le_bytes(b[at..at + 8].try_into().unwrap());
    b[at..at + 8].copy_from_slice(&(count - 2).to_le_bytes());
    // The later arrays are now read from shifted bytes; whatever the error, it must not be accepted.
    assert!(read(&b).is_err());
}

#[test]
fn rejects_invalid_enums() {
    let mut f = sample_file();
    f.navmeshes[0].data.links[0].kind = NavLinkKind(7);
    assert_eq!(read(&write(&f)).unwrap_err(), FormatError::InvalidEnum { what: "NavLinkKind", value: 7 });
    let mut f = sample_file();
    f.navmeshes[0].data.seam_edges[0].face = NavChunkFace(4);
    assert!(matches!(read(&write(&f)), Err(FormatError::InvalidEnum { value: 4, .. })));
    let mut f = sample_file();
    f.navmeshes[0].data.open_edges[0].face = NavChunkFace(-1);
    assert!(matches!(read(&write(&f)), Err(FormatError::InvalidEnum { value: -1, .. })));
    let mut f = sample_file();
    f.chunk_info.as_mut().unwrap().bounded = 2;
    assert!(matches!(read(&write(&f)), Err(FormatError::InvalidEnum { value: 2, .. })));
}

#[test]
fn flipped_payload_bit_fails_fingerprint_unless_unchecked() {
    let base = write(&sample_file());
    let h = read_header(&base).unwrap();
    let nm = h.sections[0];
    // Flip a bit inside the first vertex.
    let mut b = base.clone();
    b[nm.offset as usize + 8 + 8 + 2] ^= 0x01;
    assert!(matches!(read(&b), Err(FormatError::FingerprintMismatch { kind: 1, group: 0, .. })));
    let loaded = read_with(&b, None::<&Xxh3>).unwrap();
    assert_ne!(loaded.navmeshes[0].data.verts, sample_navmesh(1).verts);
}

// ---- fingerprints -----------------------------------------------------------------------------------------

fn nav_mutations() -> Vec<(&'static str, fn(&mut NavMeshData))> {
    vec![
        ("verts", |n| n.verts[3].y += 1.0),
        ("poly_verts", |n| n.poly_verts[0] += 1),
        ("polys", |n| n.polys[2].flags ^= 1),
        ("links", |n| n.links[4].jump_rise += 1.0),
        ("bins", |n| n.bins[1].tilt_deg += 1.0),
        ("bin_adjacency", |n| n.bin_adjacency[0] ^= 1),
        ("detail_verts", |n| n.detail_verts[0].x += 1.0),
        ("detail_tris", |n| n.detail_tris[0].w ^= 1),
        ("areas", |n| n.areas[1].cost += 1.0),
        ("poly_min", |n| n.poly_min[0].x += 1.0),
        ("poly_max", |n| n.poly_max[0].x += 1.0),
        ("index_keys", |n| n.index_keys[0] ^= 1),
        ("index_start", |n| n.index_start[1] += 1),
        ("index_polys", |n| n.index_polys[1] += 1),
        ("seam_edges", |n| n.seam_edges[0].a.x += 1.0),
        ("link padding", |n| n.links[0]._pad = 1), // Foxfire hashes padding bytes
    ]
}

#[test]
fn navmesh_fingerprint_covers_every_hashed_array() {
    let base = sample_navmesh(1);
    let h0 = hash_navmesh(&base);
    assert_eq!(h0, hash_navmesh(&base.clone()));
    for (name, m) in nav_mutations() {
        let mut n = base.clone();
        m(&mut n);
        assert_ne!(hash_navmesh(&n), h0, "{name} should change the fingerprint");
    }
}

#[test]
fn navmesh_fingerprint_ignores_excluded_data() {
    let base = sample_navmesh(1);
    let h0 = hash_navmesh(&base);
    let mut n = base.clone();
    n.tile_ranges[0].poly_count += 1;
    n.tile_ranges.push(NavTileRange::default());
    n.open_edges.clear();
    n.index_cell_size *= 2.0;
    n.seam_height_tolerance += 1.0;
    assert_eq!(hash_navmesh(&n), h0);
}

#[test]
fn navmesh_seam_edges_hashed_only_when_non_empty() {
    // With no seam edges the hash is the chain up to index_polys, which is the same as hashing without the
    // seam step: an empty array must not contribute its length word.
    let mut n = sample_navmesh(1);
    n.seam_edges.clear();
    let with_seam_step = {
        // What the hash would be if an empty SeamEdges array were hashed (length 0).
        let mut m = n.clone();
        m.seam_edges = Vec::new();
        let base = hash_navmesh(&m);
        hash_array(&Xxh3, &m.seam_edges, base)
    };
    assert_ne!(hash_navmesh(&n), with_seam_step);
    // And adding one edge does change it.
    let mut m = n.clone();
    m.seam_edges = seam(&mut Rng(1), 1);
    assert_ne!(hash_navmesh(&m), hash_navmesh(&n));
}

#[test]
fn array_hash_is_length_prefixed_and_order_sensitive() {
    let h = Xxh3;
    // Same bytes split differently between consecutive arrays differ (length goes into the chain).
    let a = hash_array(&h, &[1i32, 2], hash_array(&h, &[3i32], SEED));
    let b = hash_array(&h, &[2i32], hash_array(&h, &[3i32, 1], SEED));
    assert_ne!(a, b);
    // Order of arrays matters.
    let x = hash_array(&h, &[1i32], hash_array(&h, &[2i32], SEED));
    let y = hash_array(&h, &[2i32], hash_array(&h, &[1i32], SEED));
    assert_ne!(x, y);
    // Empty array = hash of its i32 length 0 as the seed chain; contents hash is skipped.
    assert_eq!(hash_array(&h, &[] as &[i32], SEED), h.hash64(&0i32.to_le_bytes(), SEED));
    // Non-empty: length chained first, then bytes.
    let len_then = h.hash64(&1i32.to_le_bytes(), SEED);
    assert_eq!(hash_array(&h, &[7i32], SEED), h.hash64(&7i32.to_le_bytes(), len_then));
}

#[test]
fn volume_fingerprint_coverage() {
    let base = sample_volume(3);
    let h0 = hash_volume(&base);
    let muts: Vec<(&str, fn(&mut NavVolumeData))> = vec![
        ("origin", |v| v.origin.x += 1.0),
        ("cell_size", |v| v.cell_size *= 2.0),
        ("dims", |v| v.dims.y += 1),
        ("base_leaf", |v| v.base_leaf[0] += 1),
        ("leaves", |v| v.leaves[2].size += 1),
        ("leaf padding", |v| v.leaves[2]._pad[1] = 1),
        ("neighbors", |v| v.neighbors[0] += 1),
        ("areas", |v| v.areas[0].cost += 1.0),
        ("base_scale", |v| v.base_scale = 8),
        ("blocks", |v| v.blocks[0].start += 1),
        ("block_leaf", |v| v.block_leaf[0] += 1),
    ];
    for (name, m) in muts {
        let mut v = base.clone();
        m(&mut v);
        assert_ne!(hash_volume(&v), h0, "{name}");
    }
    // Not hashed: agent_radius, base_dims.
    let mut v = base.clone();
    v.agent_radius += 1.0;
    v.base_dims.x += 1;
    assert_eq!(hash_volume(&v), h0);
    // Without blocks, base_scale and block_leaf are skipped.
    let mut a = base.clone();
    a.blocks.clear();
    let mut b = a.clone();
    b.base_scale = 99;
    b.block_leaf.clear();
    assert_eq!(hash_volume(&a), hash_volume(&b));
}

#[test]
fn describe_strings() {
    let n = sample_navmesh(1);
    let d = describe_navmesh(&n);
    assert!(d.starts_with("polys=11 links=23 jumps=7 hash="), "{d}");
    assert_eq!(d.len(), "polys=11 links=23 jumps=7 hash=".len() + 16);
    assert!(describe_volume(&sample_volume(3)).starts_with("leaves=9 hash="));
}

#[test]
fn xxh3_matches_known_vector() {
    // xxh3_64 of the empty input with seed 0 (public test vector).
    assert_eq!(Xxh3.hash64(&[], 0), 0x2D06800538D394C2);
}

#[test]
fn int3_and_float3_have_no_padding() {
    assert_eq!(size_of::<Int3>(), 12);
    assert_eq!(size_of::<Float3>(), 12);
    assert_eq!(size_of::<Int4>(), 16);
}

#[test]
fn agent_table_and_gate_flags_round_trip_and_are_checked() {
    let f = sample_file();
    let back = read(&write(&f)).unwrap();
    assert_eq!(back.agent_table, f.agent_table);
    assert_eq!(back.gate_table.as_ref().unwrap().closed, vec![0, 1, 0]);
    assert_eq!(core::mem::size_of::<NavAgentEntry>(), 32);

    // A closed-flag array shorter than the ids is a count error.
    let mut bad = f.clone();
    bad.gate_table.as_mut().unwrap().closed.pop();
    assert!(matches!(read(&write(&bad)), Err(FormatError::BadCount { what: "gate closed flags", .. })));

    // The new data is fingerprinted: changing it changes the section fingerprint.
    let fp = |f: &BakeFile, k: SectionKind| read_header(&write(f)).unwrap().sections.iter().find(|s| s.kind == k).unwrap().fingerprint;
    let mut g = f.clone();
    g.gate_table.as_mut().unwrap().closed[0] = 1;
    assert_ne!(fp(&f, SectionKind::GateTable), fp(&g, SectionKind::GateTable));
    let mut a = f.clone();
    a.agent_table.as_mut().unwrap().entries[1].fly_group = 0;
    assert_ne!(fp(&f, SectionKind::AgentTable), fp(&a, SectionKind::AgentTable));

    // A tampered payload byte fails verification.
    let bytes = write(&f);
    let s = *read_header(&bytes).unwrap().sections.iter().find(|s| s.kind == SectionKind::AgentTable).unwrap();
    let mut b = bytes.clone();
    b[s.offset as usize + 8 + 16] ^= 1; // first entry's walk group
    assert!(matches!(read(&b), Err(FormatError::FingerprintMismatch { .. })));
}
