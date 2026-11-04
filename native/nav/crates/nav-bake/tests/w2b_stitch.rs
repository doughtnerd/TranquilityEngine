//! Stitcher and output tests (W2b): hand-built poly meshes through `stitch`, then the blob, index, file and fingerprint.
use nav_bake::bins::OrientationBinExt;
use nav_bake::output::*;
use nav_bake::stitcher::*;
use nav_format::fingerprint::hash_navmesh;
use nav_format::{NavChunkFace, NavLinkKind, NavMeshData, OrientationBin};
use nav_math::{Float3, Int2, Int3};
use nav_recast::RcPolyMesh;

const NIL: i32 = 0xffff;

/// A poly mesh with `nvp` = 6. Each poly is (vertex indices, neighbours per edge); vertices are voxel coordinates.
fn mesh(bmin: Float3, cs: f32, ch: f32, verts: &[(i32, i32, i32)], polys: &[(&[i32], &[i32])]) -> RcPolyMesh {
    let nvp = 6usize;
    let mut m = RcPolyMesh { nvp: nvp as i32, bmin, cs, ch, ..RcPolyMesh::default() };
    m.verts = verts.iter().map(|v| Int3::new(v.0, v.1, v.2)).collect();
    m.nverts = verts.len() as i32;
    m.npolys = polys.len() as i32;
    m.maxpolys = m.npolys;
    for (vs, ns) in polys {
        let mut row = vec![NIL; nvp * 2];
        for (i, v) in vs.iter().enumerate() {
            row[i] = *v;
        }
        for (i, n) in ns.iter().enumerate() {
            row[nvp + i] = *n;
        }
        m.polys.extend(row);
        m.regs.push(1);
        m.flags.push(1);
        m.areas.push(1);
    }
    m.bmax = bmin
        + Float3::new(
            verts.iter().map(|v| v.0).max().unwrap() as f32 * cs,
            verts.iter().map(|v| v.1).max().unwrap() as f32 * ch,
            verts.iter().map(|v| v.2).max().unwrap() as f32 * cs,
        );
    m
}

fn bm(bin: i32, origin: (i32, i32), m: RcPolyMesh) -> BinPolyMesh {
    BinPolyMesh { bin, mesh: m, origin: Int2::new(origin.0, origin.1), detail: None, faces: ChunkFaces::default() }
}

fn floor_bin() -> OrientationBin {
    OrientationBin::from_normal(Float3::new(0.0, 1.0, 0.0))
}

fn settings() -> StitchSettings {
    StitchSettings { max_fold_angle: std::f32::consts::FRAC_PI_2, ..StitchSettings::from_agent(0.5, 1.0, 1.0, 0.0) }
}

fn no_jump() -> JumpSettings {
    JumpSettings::default()
}

fn run(meshes: &[BinPolyMesh], bins: &[OrientationBin], adj: &[u64], s: &StitchSettings, j: &JumpSettings) -> (NavMeshData, StitchStats) {
    stitch(meshes, bins, adj, s, &NoFoldClearance, j, &NoJumpClearance, None, None)
}

/// Two 2x2 squares sharing the edge x = 2.
fn two_squares() -> RcPolyMesh {
    mesh(
        Float3::new(0.0, 0.0, 0.0),
        1.0,
        1.0,
        &[(0, 0, 0), (2, 0, 0), (2, 0, 2), (0, 0, 2), (4, 0, 0), (4, 0, 2)],
        &[(&[0, 1, 2, 3], &[NIL, 1, NIL, NIL]), (&[1, 4, 5, 2], &[NIL, NIL, NIL, 0])],
    )
}

#[test]
fn internal_links_across_a_shared_edge() {
    let (nav, stats) = run(&[bm(0, (0, 0), two_squares())], &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(nav.polys.len(), 2);
    assert_eq!(stats.internal_links, 2);
    assert_eq!(nav.links.len(), 2);
    assert_eq!(stats.boundary_edges, 6);
    for (p, to) in [(0usize, 1), (1, 0)] {
        let poly = nav.polys[p];
        assert_eq!(poly.link_count, 1);
        let l = nav.links[poly.link_start as usize];
        assert_eq!(l.kind, NavLinkKind::INTERNAL);
        assert_eq!(l.to_poly, to);
        assert_eq!(l.portal_a, l.dest_a);
        assert_eq!(l.portal_b, l.dest_b);
        assert!((poly.normal.y - 1.0).abs() < 1e-6);
    }
    // Poly A's centre is (1, 0, 1); the shared edge runs x = 2, z 0..2 in either direction.
    assert_eq!(nav.polys[0].center, Float3::new(1.0, 0.0, 1.0));
    let l = nav.links[nav.polys[0].link_start as usize];
    assert_eq!(l.portal_a.x, 2.0);
    assert_eq!(l.portal_b.x, 2.0);
}

#[test]
fn links_across_a_tile_edge() {
    // Tile 1 covers x 0..2 (origin 0, 0), tile 2 covers x 2..4 (origin 2, 0). Edge side 2 = high x, side 0 = low x.
    let t1 = mesh(
        Float3::new(0.0, 0.0, 0.0),
        1.0,
        1.0,
        &[(0, 0, 0), (2, 0, 0), (2, 0, 2), (0, 0, 2)],
        &[(&[0, 1, 2, 3], &[NIL, 0x8002, NIL, NIL])],
    );
    let t2 = mesh(
        Float3::new(2.0, 0.0, 0.0),
        1.0,
        1.0,
        &[(0, 0, 0), (2, 0, 0), (2, 0, 2), (0, 0, 2)],
        &[(&[0, 1, 2, 3], &[NIL, NIL, NIL, 0x8000])],
    );
    let (nav, stats) = run(&[bm(0, (0, 0), t1), bm(0, (2, 0), t2)], &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(stats.seam_links, 2);
    assert_eq!(stats.internal_links, 0);
    assert_eq!(nav.polys.len(), 2);
    let l = nav.links[nav.polys[0].link_start as usize];
    assert_eq!((l.kind, l.to_poly), (NavLinkKind::INTERNAL, 1));
    assert_eq!((l.portal_a.x, l.portal_b.x, l.dest_a.x, l.dest_b.x), (2.0, 2.0, 2.0, 2.0));
    assert_eq!(nav.polys[1].link_count, 1);
    assert!(nav.open_edges.is_empty());
    // Both seam stretches matched, so neither tile edge is a ledge: boundary edges are only the 3 free sides of each.
    assert_eq!(stats.boundary_edges, 6);
}

#[test]
fn unmatched_tile_edge_is_open_and_a_ledge_when_a_tile_is_across() {
    // Tile 2's low-x edge has nothing matching on tile 1's side, but tile 1 is there (a ledge at another height).
    let t1 = mesh(
        Float3::new(0.0, 0.0, 0.0),
        1.0,
        1.0,
        &[(0, 0, 0), (2, 0, 0), (2, 0, 2), (0, 0, 2)],
        &[(&[0, 1, 2, 3], &[NIL, 0x8002, NIL, NIL])],
    );
    // 10 voxels higher: beyond the seam height tolerance (1).
    let t2 = mesh(
        Float3::new(2.0, 0.0, 0.0),
        1.0,
        1.0,
        &[(0, 10, 0), (2, 10, 0), (2, 10, 2), (0, 10, 2)],
        &[(&[0, 1, 2, 3], &[NIL, NIL, NIL, 0x8000])],
    );
    let (nav, stats) = run(&[bm(0, (0, 0), t1), bm(0, (2, 0), t2)], &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(stats.seam_links, 0);
    assert_eq!(nav.open_edges.len(), 2);
    // 3 free sides each, plus the two ledge stretches.
    assert_eq!(stats.boundary_edges, 8);
}

/// The wall bin for a wall facing -z (normal (0, 0, -1)): local x = world x, local y = world -z, local z = world y.
fn wall_bin_minus_z() -> OrientationBin {
    OrientationBin::from_normal(Float3::new(0.0, 0.0, -1.0))
}

/// The wall bin for a wall facing +z: local x = world -x, local y = world z, local z = world y.
fn wall_bin_plus_z() -> OrientationBin {
    OrientationBin::from_normal(Float3::new(0.0, 0.0, 1.0))
}

fn fold_meshes() -> Vec<BinPolyMesh> {
    // Floor y = 0, x 0..4, z 0..3; the wall is the plane z = 4 facing the floor, y 1..4, x 0..4.
    let floor = mesh(Float3::new(0.0, 0.0, 0.0), 1.0, 1.0, &[(0, 0, 0), (4, 0, 0), (4, 0, 3), (0, 0, 3)], &[(&[0, 1, 2, 3], &[])]);
    let wall = mesh(Float3::new(0.0, -4.0, 1.0), 1.0, 1.0, &[(0, 0, 0), (4, 0, 0), (4, 0, 3), (0, 0, 3)], &[(&[0, 1, 2, 3], &[])]);
    vec![bm(0, (0, 0), floor), bm(1, (0, 0), wall)]
}

#[test]
fn concave_fold_between_floor_and_wall() {
    let bins = [floor_bin(), wall_bin_minus_z()];
    let adj = [1u64 << 1, 1u64 << 0];
    let mut s = settings();
    s.gap_tolerance = 3.0;
    let meshes = fold_meshes();
    let (nav, stats) = run(&meshes, &bins, &adj, &s, &no_jump());
    assert_eq!(stats.fold_candidates, 1);
    assert_eq!(stats.fold_links, 2);
    let l = nav.links[nav.polys[0].link_start as usize];
    assert_eq!(l.kind, NavLinkKind::FOLD);
    assert_eq!(l.to_poly, 1);
    assert_eq!(l.convex, 0);
    assert!((l.fold_angle - std::f32::consts::FRAC_PI_2).abs() < 1e-4, "{}", l.fold_angle);
    assert_eq!(l.hinge_a, Float3::default());
    // The floor's portal is on its z = 3 edge, the wall's on its y = 1 edge.
    assert!(l.portal_a.z == 3.0 && l.portal_a.y == 0.0);
    assert!(l.dest_a.z == 4.0 && l.dest_a.y == 1.0);
    let back = nav.links[nav.polys[1].link_start as usize];
    assert_eq!((back.kind, back.to_poly, back.portal_a, back.dest_a), (NavLinkKind::FOLD, 0, l.dest_a, l.portal_a));

    // A fold sharper than MaxFoldAngle isn't linked; unrelated bins (no adjacency bit) never fold.
    let mut tight = s;
    tight.max_fold_angle = 0.5;
    assert_eq!(run(&meshes, &bins, &adj, &tight, &no_jump()).1.fold_links, 0);
    assert_eq!(run(&meshes, &bins, &[0, 0], &s, &no_jump()).1.fold_links, 0);
    // Clearance can veto.
    struct Never;
    impl FoldClearance for Never {
        fn is_clear(&self, _c: &FoldCandidate) -> bool {
            false
        }
    }
    let (_, st) = stitch(&meshes, &bins, &adj, &s, &Never, &no_jump(), &NoJumpClearance, None, None);
    assert_eq!((st.fold_candidates, st.fold_links), (1, 0));
}

#[test]
fn convex_fold_over_a_lip_has_a_hinge_on_the_corner() {
    // Top y = 0, x 0..4, z 0..3; the box's side is the plane z = 4 facing +z, y -4..-1.
    let top = mesh(Float3::new(0.0, 0.0, 0.0), 1.0, 1.0, &[(0, 0, 0), (4, 0, 0), (4, 0, 3), (0, 0, 3)], &[(&[0, 1, 2, 3], &[])]);
    let side = mesh(Float3::new(-4.0, 4.0, -4.0), 1.0, 1.0, &[(0, 0, 0), (4, 0, 0), (4, 0, 3), (0, 0, 3)], &[(&[0, 1, 2, 3], &[])]);
    let bins = [floor_bin(), wall_bin_plus_z()];
    let mut s = settings();
    s.gap_tolerance = 3.0;
    let (nav, stats) = run(&[bm(0, (0, 0), top), bm(1, (0, 0), side)], &bins, &[1 << 1, 1 << 0], &s, &no_jump());
    assert_eq!(stats.fold_links, 2);
    let l = nav.links[nav.polys[0].link_start as usize];
    assert_eq!((l.kind, l.convex), (NavLinkKind::FOLD, 1));
    // The corner is the edge z = 4, y = 0.
    for h in [l.hinge_a, l.hinge_b] {
        assert!((h.y - 0.0).abs() < 1e-5 && (h.z - 4.0).abs() < 1e-5, "{h:?}");
    }
    assert_eq!(l.hinge_a.x, l.portal_a.x);
    assert_eq!(l.hinge_b.x, l.portal_b.x);
}

/// Two floor tiles with a gap of `gap_cells` voxels between them (cs = 0.5).
fn gap_meshes(gap_cells: i32) -> Vec<BinPolyMesh> {
    let a = mesh(Float3::new(0.0, 0.0, 0.0), 0.5, 0.2, &[(0, 0, 0), (4, 0, 0), (4, 0, 4), (0, 0, 4)], &[(&[0, 1, 2, 3], &[])]);
    let bx = 4 + gap_cells;
    let b = mesh(
        Float3::new(bx as f32 * 0.5, 0.0, 0.0),
        0.5,
        0.2,
        &[(0, 0, 0), (4, 0, 0), (4, 0, 4), (0, 0, 4)],
        &[(&[0, 1, 2, 3], &[])],
    );
    vec![bm(0, (0, 0), a), bm(0, (bx, 0), b)]
}

fn jump(max_dist: f32) -> JumpSettings {
    JumpSettings {
        enabled: true,
        max_jump_up_height: 1.0,
        max_jump_distance: max_dist,
        max_fall_distance: 2.0,
        max_surface_tilt_deg: 45.0,
        sample_spacing: 1.0,
        probe_step: 0.5,
        min_jump_gap: 1.0,
        min_jump_rise: 0.4,
        arc_height: 1.0,
    }
}

#[test]
fn jump_across_a_gap_within_limits_and_none_beyond() {
    let s = settings();
    let (nav, stats) = run(&gap_meshes(4), &[floor_bin()], &[0], &s, &jump(4.0));
    assert_eq!(stats.jump_links, 2);
    for p in 0..2 {
        let poly = nav.polys[p];
        let jumps: Vec<_> = (0..poly.link_count)
            .map(|i| nav.links[(poly.link_start + i) as usize])
            .filter(|l| l.kind == NavLinkKind::JUMP)
            .collect();
        assert_eq!(jumps.len(), 1, "poly {p}");
        let l = jumps[0];
        assert_eq!(l.to_poly, 1 - p as i32);
        assert!((l.jump_distance - 2.0).abs() < 1e-5, "{}", l.jump_distance);
        assert_eq!(l.jump_rise, 0.0);
        assert_eq!(l.portal_a, l.portal_b);
        assert_eq!(l.dest_a, l.dest_b);
    }
    // Beyond MaxJumpDistance (1.5 < the 2 m gap), and with jumping off: none.
    assert_eq!(run(&gap_meshes(4), &[floor_bin()], &[0], &s, &jump(1.5)).1.jump_links, 0);
    assert_eq!(run(&gap_meshes(4), &[floor_bin()], &[0], &s, &no_jump()).1.jump_links, 0);
    // Landings no farther than MinJumpGap with no rise are steps, not jumps (every landing here is within 3 m).
    let mut steps = jump(4.0);
    steps.min_jump_gap = 10.0;
    assert_eq!(run(&gap_meshes(2), &[floor_bin()], &[0], &s, &steps).1.jump_links, 0);
    // Clearance can veto.
    struct Never;
    impl JumpClearance for Never {
        fn is_clear(&self, _f: nav_math::Double3, _t: nav_math::Double3, _a: f64) -> bool {
            false
        }
    }
    let g = gap_meshes(4);
    let (_, st) = stitch(&g, &[floor_bin()], &[0], &s, &NoFoldClearance, &jump(4.0), &Never, None, None);
    assert_eq!(st.jump_links, 0);
}

#[test]
fn jump_links_chunked_in_any_order_equal_the_inline_ones() {
    let s = settings();
    let g = gap_meshes(4);
    let refs: Vec<&BinPolyMesh> = g.iter().collect();
    let j = jump(4.0);
    let bins = [floor_bin()];
    let (inline, _) = run(&g, &bins, &[0], &s, &j);
    for chunks in [1, 2, 3, 7] {
        let mut all = Vec::new();
        for c in (0..chunks).rev() {
            all.extend(generate_jump_links_for_edge_range(&refs, &bins, &s, &j, &NoJumpClearance, c, chunks));
        }
        all.sort_by(JumpLinkRecord::edge_order);
        let (pre, st) = stitch(&g, &bins, &[0], &s, &NoFoldClearance, &j, &NoJumpClearance, Some(&all), None);
        assert_eq!(st.jump_links, 2);
        assert_eq!(pre, inline, "chunks = {chunks}");
        assert_eq!(hash_navmesh(&pre), hash_navmesh(&inline));
    }
}

fn faces_mesh() -> BinPolyMesh {
    // 4 x 4 columns of 0.5 m; every side is a tile portal, on a chunk face. The box is a little bigger than the grid.
    let mut m = mesh(
        Float3::new(0.0, 0.0, 0.0),
        0.5,
        0.2,
        &[(0, 0, 0), (0, 0, 4), (4, 0, 4), (4, 0, 0)],
        &[(&[0, 1, 2, 3], &[0x8000, 0x8001, 0x8002, 0x8003])],
    );
    m.bmax = Float3::new(2.0, 0.0, 2.0);
    BinPolyMesh {
        bin: 0,
        mesh: m,
        origin: Int2::new(0, 0),
        detail: None,
        faces: ChunkFaces { enabled: true, columns: Int2::new(4, 4), box_min: [0.0, 0.0], box_max: [2.05, 2.05] },
    }
}

#[test]
fn seam_edges_on_chunk_faces() {
    let (nav, stats) = run(&[faces_mesh()], &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(stats.seam_edges, 4);
    assert_eq!(nav.seam_edges.len(), 4);
    assert_eq!(nav.tile_ranges.len(), 1);
    assert_eq!((nav.tile_ranges[0].poly_start, nav.tile_ranges[0].poly_count), (0, 1));
    assert!(nav.open_edges.is_empty());
    // Vertices on the high faces moved onto them (2.05, not 2.0).
    assert_eq!(nav.verts[2], Float3::new(2.05, 0.0, 2.05));
    let faces: Vec<_> = nav.seam_edges.iter().map(|e| e.face).collect();
    assert_eq!(faces, vec![NavChunkFace::X_MIN, NavChunkFace::Z_MAX, NavChunkFace::X_MAX, NavChunkFace::Z_MIN]);
    let hi = nav.seam_edges[2];
    assert_eq!((hi.a.x, hi.b.x), (2.05, 2.05));
    let hz = nav.seam_edges[1];
    assert_eq!((hz.a.z, hz.b.z), (2.05, 2.05));
    assert_eq!(nav.seam_height_tolerance, settings().seam_height_tolerance);
    // No links, nothing on the tile seams.
    assert_eq!(nav.links.len(), 0);
}

#[test]
fn nearest_poly_index_lookups() {
    let (nav, _) = run(&gap_meshes(4), &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(nav.poly_min.len(), 2);
    assert_eq!(nav.poly_min[0], Float3::new(0.0, 0.0, 0.0));
    assert_eq!(nav.poly_max[1], Float3::new(6.0, 0.0, 2.0));
    assert_eq!(nav.index_cell_size, 2.0); // average of the polys' largest extent
    assert_eq!(nav.index_start.len(), nav.index_keys.len() + 1);
    assert!(nav.index_keys.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(*nav.index_start.last().unwrap() as usize, nav.index_polys.len());
    // Every poly is in every cell its bounds touch, and a point in poly 1 finds it.
    assert!(polys_near(&nav, Float3::new(1.0, 0.0, 1.0)).contains(&0));
    assert!(polys_near(&nav, Float3::new(4.5, 0.0, 1.0)).contains(&1));
    assert!(!polys_near(&nav, Float3::new(4.5, 0.0, 1.0)).contains(&0));
    assert!(polys_near(&nav, Float3::new(50.0, 0.0, 50.0)).is_empty());
    assert!(poly_index_can_query(&nav, Int3::new(0, 0, 0), Int3::new(3, 3, 3)));
    assert!(!poly_index_can_query(&nav, Int3::new(0, 0, 0), Int3::new(100, 100, 100)));
    assert_eq!(poly_bounds_distance_sq(&nav, 0, Float3::new(1.0, 0.0, 1.0)), 0.0);
    assert_eq!(poly_bounds_distance_sq(&nav, 0, Float3::new(3.0, 0.0, 0.0)), 1.0);
    // Key packs (x, y, z) + 2^20 in 21 bits each.
    assert_eq!(cell_key(Int3::new(0, 0, 0)), ((1i64 << 20) << 42) | ((1i64 << 20) << 21) | (1i64 << 20));
    assert_eq!(cell_of(Float3::new(-0.1, 2.0, 3.9), 2.0), Int3::new(-1, 1, 1));
    // An empty navmesh has no index.
    let (empty, _) = run(&[], &[floor_bin()], &[0], &settings(), &no_jump());
    assert!(empty.index_keys.is_empty() && empty.polys.is_empty());
    assert_eq!(empty.index_cell_size, 1.0);
}

#[test]
fn detail_mesh_is_converted_and_bounds_include_it() {
    use nav_math::Int4;
    use nav_recast::RcPolyMeshDetail;
    let mut b = bm(0, (0, 0), mesh(Float3::new(0.0, 0.0, 0.0), 1.0, 1.0, &[(0, 0, 0), (2, 0, 0), (2, 0, 2), (0, 0, 2)], &[(&[0, 1, 2, 3], &[])]));
    // Detail verts carry Recast's + ch offset (ch = 1 here); one dips 1.5 below the polygon.
    b.detail = Some(RcPolyMeshDetail {
        meshes: vec![Int4::new(0, 4, 0, 2)],
        verts: vec![Float3::new(0.0, 1.0, 0.0), Float3::new(2.0, 1.0, 0.0), Float3::new(2.0, 1.0, 2.0), Float3::new(0.0, -0.5, 2.0)],
        tris: vec![Int4::new(0, 1, 2, 0), Int4::new(0, 2, 3, 0)],
        warnings: 0,
    });
    let mut s = settings();
    s.detail_height_offset = 1.0;
    let (nav, _) = run(&[b], &[floor_bin()], &[0], &s, &no_jump());
    assert_eq!((nav.polys[0].detail_vert_count, nav.polys[0].detail_tri_count), (4, 2));
    assert_eq!(nav.detail_verts[3], Float3::new(0.0, -1.5, 2.0));
    assert_eq!(nav.poly_min[0].y, -1.5);
}

#[test]
fn round_trip_through_the_nav_file() {
    let (nav, _) = run(&gap_meshes(4), &[floor_bin()], &[0], &settings(), &jump(4.0));
    let file = nav_format::BakeFile {
        package_version: [1, 0, 0],
        signature: chunk_id("scenes/level.scene", "chunk-1"),
        navmeshes: vec![nav_format::file::NavMeshSection { group: 0, data: nav.clone() }],
        ..nav_format::BakeFile::default()
    };
    let bytes = nav_format::write(&file);
    let back = nav_format::read(&bytes).expect("reads back");
    assert_eq!(back.navmeshes.len(), 1);
    assert_eq!(back.navmeshes[0].data, nav);
    assert_eq!(hash_navmesh(&back.navmeshes[0].data), hash_navmesh(&nav));
}

#[test]
fn fingerprint_line_and_stability() {
    let build = || run(&gap_meshes(4), &[floor_bin()], &[0], &settings(), &jump(4.0)).0;
    let a = build();
    let b = build();
    assert_eq!(hash_navmesh(&a), hash_navmesh(&b));
    let line = fingerprint_line(&group_name(0, [(0, "Ground"), (1, "Flyer"), (0, "Scout")]), &a);
    assert!(line.starts_with("NavBake fingerprint: Ground + Scout polys=2 links=2 jumps=2 hash="), "{line}");
    assert_eq!(line.len(), "NavBake fingerprint: Ground + Scout polys=2 links=2 jumps=2 hash=".len() + 16);
    // A different mesh hashes differently.
    let other = run(&gap_meshes(6), &[floor_bin()], &[0], &settings(), &jump(4.0)).0;
    assert_ne!(hash_navmesh(&a), hash_navmesh(&other));
    assert!(empty_navmesh_warning("Ground", &a).is_none());
    assert!(empty_navmesh_warning("Ground", &NavMeshData::default()).unwrap().contains("Ground is empty"));
}

#[test]
fn bounds_and_chunk_ids() {
    let (nav, _) = run(&gap_meshes(4), &[floor_bin()], &[0], &settings(), &no_jump());
    assert_eq!(nav_mesh_bounds(&nav), (Float3::new(0.0, 0.0, 0.0), Float3::new(6.0, 0.0, 2.0)));
    assert_eq!(nav_mesh_bounds(&NavMeshData::default()), (Float3::default(), Float3::default()));
    let id = chunk_id("scenes/level.scene", "chunk-1");
    assert_eq!(id, chunk_id("scenes/level.scene", "chunk-1"));
    assert_ne!(id, chunk_id("scenes/level.scene", "chunk-2"));
    assert_ne!(id, chunk_id("scenes/other.scene", "chunk-1"));
    // The path and node ids are length-prefixed, so moving a byte between them changes the id.
    assert_ne!(chunk_id("ab", "c"), chunk_id("a", "bc"));
    assert!(id.is_valid());
}

#[test]
fn stitch_profile_uses_the_profile_settings() {
    use nav_bake::bins::{OrientationBinSet, OrientationConfig, SurfaceRing};
    use nav_bake::settings::BakeProfile;
    use nav_bake::types::BinGrid;
    let set = OrientationBinSet::create(&OrientationConfig::DEFAULT, &[SurfaceRing::DEFAULT]).unwrap();
    let bins = set.bake_bins(Float3::new(0.0, 0.0, 0.0), Float3::new(10.0, 10.0, 10.0));
    let profile = BakeProfile::test_profile(true, false, false, 1);
    let ground = BinGrid { cs: 0.5, ch: 0.2, ..BinGrid::default() };
    let meshes = gap_meshes(4);
    let input = StitchInput {
        profile: &profile,
        ground: &ground,
        bins: &bins,
        meshes: meshes.iter().collect(),
        jump_links: None,
        areas: &[],
        max_fold_deg: 90.0,
    };
    let (settings, jump) = stitch_setup(&profile, &ground);
    assert_eq!(jump.max_jump_distance, 4.0);
    assert_eq!(jump.min_jump_rise, 2.0 * 0.2); // walkable climb = (int)(0.5 / 0.2) = 2
    assert_eq!(settings.seam_height_tolerance, 2.0 * 0.2);
    let (nav, stats) = stitch_profile(&input, &NoFoldClearance, &NoJumpClearance);
    assert_eq!(stats.polys, 2);
    assert_eq!(stats.jump_links, 2);
    assert_eq!(nav.bins.len(), bins.len());
    assert_eq!(nav.bin_adjacency.len(), bins.len());
    // Precomputed jump links (merged chunks) give the same navmesh.
    let pre = generate_jump_links_for_profile(&input, &NoJumpClearance, 5);
    let input2 = StitchInput { jump_links: Some(&pre), ..input.clone() };
    let (nav2, _) = stitch_profile(&input2, &NoFoldClearance, &NoJumpClearance);
    assert_eq!(nav, nav2);
}
