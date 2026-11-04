//! Chunk bounds and the chunk border (ports of Foxfire's `ChunkBoundsTests` and `ChunkBorderTests`): geometry is clipped
//! to the box, walkable ground reaches the box's side faces instead of being eroded there, the navmesh's edges on those
//! faces are recorded as seam edges lying exactly on the faces, the flight volume spans the box, and the border data
//! keeps what overlays need. The test agent has radius 0.5 and 0.25 m voxels.
mod bake_common;

use bake_common::*;
use nav_bake::settings::{snap_chunk_bounds, ChunkSettings};
use nav_format::{NavChunkFace, NavMeshData};
use nav_math::Float3;

const BOX_MIN: Float3 = Float3::new(-10.0, -1.0, -8.0);
const BOX_MAX: Float3 = Float3::new(10.0, 4.0, 8.0);

fn bounded(min: Float3, max: Float3, build: impl Fn(&mut TestBake)) -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    build(&mut bake);
    bake.set_chunk_bounds(min, max, 1, 2);
    bake.bake();
    bake
}

/// Every seam edge lies exactly on its face (within `tol`), inside the box along the face.
fn assert_edges_on_faces(nav: &NavMeshData, min: Float3, max: Float3, tol: f32) {
    assert!(!nav.seam_edges.is_empty(), "no seam edges");
    for (i, edge) in nav.seam_edges.iter().enumerate() {
        for p in [edge.a, edge.b] {
            let (got, want) = match edge.face {
                NavChunkFace::X_MIN => (p.x, min.x),
                NavChunkFace::X_MAX => (p.x, max.x),
                NavChunkFace::Z_MIN => (p.z, min.z),
                _ => (p.z, max.z),
            };
            assert!((got - want).abs() <= tol, "edge {i} not on its face {:?}: {got} vs {want}", edge.face);
            assert!(p.x >= min.x - tol && p.x <= max.x + tol && p.z >= min.z - tol && p.z <= max.z + tol, "edge {i} point {p:?} outside the box");
        }
        assert!(edge.poly >= 0 && (edge.poly as usize) < nav.polys.len(), "edge {i} polygon");
    }
}

#[test]
fn floor_across_the_box_reaches_every_side_face() {
    let bake = bounded(BOX_MIN, BOX_MAX, |b| b.add_floor_simple(-20.0, 20.0));
    let nav = bake.nav();
    let (min, max) = vert_bounds(nav);

    // Exactly on the faces: not eroded by the agent's radius, not past the box.
    assert_eq!(min.x, BOX_MIN.x, "low x face");
    assert_eq!(max.x, BOX_MAX.x, "high x face");
    assert_eq!(min.z, BOX_MIN.z, "low z face");
    assert_eq!(max.z, BOX_MAX.z, "high z face");

    assert_edges_on_faces(nav, BOX_MIN, BOX_MAX, 0.0);
    let depth = BOX_MAX.z - BOX_MIN.z;
    let width = BOX_MAX.x - BOX_MIN.x;
    assert!((coverage(nav, NavChunkFace::X_MIN) - depth).abs() < 0.01, "low x face covered");
    assert!((coverage(nav, NavChunkFace::X_MAX) - depth).abs() < 0.01, "high x face covered");
    assert!((coverage(nav, NavChunkFace::Z_MIN) - width).abs() < 0.01, "low z face covered");
    assert!((coverage(nav, NavChunkFace::Z_MAX) - width).abs() < 0.01, "high z face covered");

    // The output carries the box, and the navmesh's bounds are the box's.
    assert_eq!(bake.out.chunk_bounds, Some((BOX_MIN, BOX_MAX)));
    assert_eq!(bake.out.navmesh_bounds[0], (BOX_MIN, BOX_MAX));
}

#[test]
fn without_bounds_no_seam_edges_and_the_floor_erodes_at_its_edges() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    let nav = bake.nav();

    assert!(nav.seam_edges.is_empty());
    let max_x = vert_bounds(nav).1.x;
    assert!(max_x <= 10.0 - 0.4, "the floor's edge should be eroded by about the agent radius: {max_x}");
    assert!(bake.out.chunk_bounds.is_none());
}

#[test]
fn geometry_outside_the_box_is_not_baked() {
    let bake = bounded(BOX_MIN, BOX_MAX, |b| {
        b.add_floor_simple(-20.0, 20.0);
        b.add_box(v3(15.0, 1.0, 0.0), v3(4.0, 2.0, 4.0), Rot::IDENTITY); // beside the box
        b.add_floor((-5.0, -5.0), (5.0, 5.0), 6.0, &[]); // above it
    });
    for v in &bake.nav().verts {
        assert!(
            v.x >= BOX_MIN.x && v.y >= BOX_MIN.y && v.z >= BOX_MIN.z && v.x <= BOX_MAX.x && v.y <= BOX_MAX.y && v.z <= BOX_MAX.z,
            "vertex {v:?} outside the box"
        );
    }
}

#[test]
fn obstacle_on_a_face_erodes_around_it_and_leaves_a_gap_in_the_seam() {
    let bake = bounded(BOX_MIN, BOX_MAX, |b| {
        b.add_floor_simple(-20.0, 20.0);
        b.add_obstacle(v3(BOX_MAX.x, 1.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    });
    let nav = bake.nav();

    assert_edges_on_faces(nav, BOX_MIN, BOX_MAX, 0.0);
    // The obstacle covers z in [-1, 1]; erosion keeps another agent radius (0.5) clear on each side.
    let covered = coverage(nav, NavChunkFace::X_MAX);
    assert!((covered - (BOX_MAX.z - BOX_MIN.z - 2.0 - 1.0)).abs() < 0.6, "seam on the high x face around the obstacle: {covered}");
    for edge in nav.seam_edges.iter().filter(|e| e.face == NavChunkFace::X_MAX) {
        let (lo, hi) = (edge.a.z.min(edge.b.z), edge.a.z.max(edge.b.z));
        assert!(hi <= -1.0 || lo >= 1.0, "seam edge z [{lo}, {hi}] runs through the obstacle");
    }
}

#[test]
fn neighbouring_chunks_put_their_seam_edges_on_the_shared_face() {
    let a = bounded(BOX_MIN, v3(0.0, BOX_MAX.y, BOX_MAX.z), |b| b.add_floor_simple(-20.0, 20.0));
    let b = bounded(v3(0.0, BOX_MIN.y, BOX_MIN.z), BOX_MAX, |b| b.add_floor_simple(-20.0, 20.0));

    let depth = BOX_MAX.z - BOX_MIN.z;
    assert!((coverage(a.nav(), NavChunkFace::X_MAX) - depth).abs() < 0.01, "chunk A's side of the shared face");
    assert!((coverage(b.nav(), NavChunkFace::X_MIN) - depth).abs() < 0.01, "chunk B's side of the shared face");
    for (bake, face) in [(&a, NavChunkFace::X_MAX), (&b, NavChunkFace::X_MIN)] {
        for edge in bake.nav().seam_edges.iter().filter(|e| e.face == face) {
            assert_eq!(edge.a.x, 0.0, "on the shared face");
            assert_eq!(edge.b.x, 0.0, "on the shared face");
            assert!(edge.a.y.abs() <= 0.25 && edge.b.y.abs() <= 0.25, "at floor height");
        }
    }
    // The two sides' seam edges cover the same stretch of the shared face, end to end.
    let spans = |bake: &TestBake, face| {
        let mut s: Vec<(f32, f32)> = bake
            .nav()
            .seam_edges
            .iter()
            .filter(|e| e.face == face)
            .map(|e| (e.a.z.min(e.b.z), e.a.z.max(e.b.z)))
            .collect();
        s.sort_by(|x, y| x.partial_cmp(y).unwrap());
        (s.first().unwrap().0, s.last().unwrap().1)
    };
    assert_eq!(spans(&a, NavChunkFace::X_MAX), spans(&b, NavChunkFace::X_MIN));
}

#[test]
fn box_not_a_whole_number_of_voxels_edges_still_land_on_the_faces() {
    let (min, max) = (v3(-10.1, -1.0, -7.93), v3(9.93, 4.0, 8.07));
    let bake = bounded(min, max, |b| b.add_floor_simple(-20.0, 20.0));
    let nav = bake.nav();
    // The box goes through centre and extents, as Unity's Bounds does: equal to a few ulps.
    assert_edges_on_faces(nav, min, max, 1e-3);
    assert!((coverage(nav, NavChunkFace::X_MAX) - (max.z - min.z)).abs() < 0.01);
    assert!((coverage(nav, NavChunkFace::Z_MIN) - (max.x - min.x)).abs() < 0.01);
}

#[test]
fn flight_volume_spans_the_box() {
    let mut bake = TestBake::new(None);
    bake.add_floor_simple(-20.0, 20.0);
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0)); // headroom is ignored with bounds
    bake.set_chunk_bounds(BOX_MIN, BOX_MAX, 1, 2);
    bake.bake();
    let volume = bake.volume();

    assert_eq!(volume.origin, BOX_MIN, "the volume starts at the box's corner");
    let end = volume.origin + Float3::new(volume.dims.x as f32, volume.dims.y as f32, volume.dims.z as f32) * volume.cell_size;
    assert!(
        (end - BOX_MAX).abs().cmax() <= volume.cell_size,
        "the volume ends at {end:?}, not the box's {BOX_MAX:?}"
    );
}

#[test]
fn chunk_grid_snaps_roughly_placed_neighbours_onto_one_face() {
    // Boxes before one was moved: 0.6 m apart along x.
    let (amin, amax) = snap_chunk_bounds(v3(-552.3, -109.7, -185.0), v3(-152.3, 290.3, 375.0), 4.0);
    let (bmin, bmax) = snap_chunk_bounds(v3(-151.7, -99.2, -183.58), v3(241.7, 279.8, 375.18), 4.0);

    assert!((amax.x - -152.0).abs() < 1e-4);
    assert_eq!(amax.x, bmin.x, "the faces coincide");
    assert!((amin.y - -109.7).abs() < 1e-3 && (amax.y - 290.3).abs() < 1e-3, "height isn't snapped");
    assert!((bmax.z - 376.0).abs() < 1e-4);
}

#[test]
fn chunk_grid_zero_leaves_the_box_and_a_tiny_box_keeps_one_step() {
    let (min, max) = (v3(1.05, 0.5, -0.95), v3(1.55, 3.5, -0.45));
    assert_eq!(snap_chunk_bounds(min, max, 0.0), (min, max));
    let (smin, smax) = snap_chunk_bounds(min, max, 4.0);
    assert!(((smax.x - smin.x) - 4.0).abs() < 1e-4, "at least one step wide");
    assert!(((smax.z - smin.z) - 4.0).abs() < 1e-4, "at least one step deep");
}

#[test]
fn a_baked_chunk_box_snaps_to_the_chunk_grid() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-30.0, 30.0);
    bake.set_chunk_bounds(v3(-9.7, -1.0, -8.3), v3(10.2, 4.0, 7.9), 1, 2);
    bake.settings.chunk = ChunkSettings { chunk_grid: 4.0, ..bake.settings.chunk.clone() };
    bake.bake();
    let (min, max) = bake.out.chunk_bounds.expect("bounded");
    assert_eq!((min.x, max.x, min.z, max.z), (-8.0, 12.0, -8.0, 8.0));
    assert_eq!((min.y, max.y), (-1.0, 4.0), "height isn't snapped");
    assert_edges_on_faces(bake.nav(), min, max, 1e-4);
}

#[test]
fn a_box_with_no_volume_bakes_without_bounds_and_warns() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.set_chunk_bounds(v3(0.0, 0.0, 0.0), v3(5.0, 0.0, 5.0), 1, 2); // flat: no height
    bake.bake();
    assert!(bake.out.chunk_bounds.is_none());
    assert!(bake.out.warnings.iter().any(|w| w.contains("no volume")), "{:?}", bake.out.warnings);
    assert!(bake.nav().seam_edges.is_empty());
}

// ---------------------------------------------------------------------------------------------------------
// The border data: 64-column tiles (16 m), border 5 columns, max overlay depth 2, so the band reaches
// 2 * 16 + 1.25 = 33.25 m inside each face.
// ---------------------------------------------------------------------------------------------------------

const BORDER_MIN: Float3 = Float3::new(-40.0, -1.0, -40.0);
const BORDER_MAX: Float3 = Float3::new(40.0, 6.0, 40.0);

#[test]
fn overhang_is_how_far_geometry_reaches_past_each_face() {
    let bake = bounded(BORDER_MIN, BORDER_MAX, |b| {
        b.add_floor((-40.0, -40.0), (44.0, 40.0), 0.0, &[]); // 4 m past x+
        b.add_box(v3(-41.0, 1.0, 0.0), v3(4.0, 2.0, 4.0), Rot::IDENTITY); // 3 m past x-
    });
    let border = bake.out.file.chunk_border.as_ref().expect("no border data");
    assert!((border.overhang[NavChunkFace::X_MIN.0 as usize] - 3.0).abs() < 1e-4, "x-");
    assert!(border.overhang[NavChunkFace::Z_MAX.0 as usize].abs() < 1e-4, "z+");
    assert!((border.overhang[NavChunkFace::X_MAX.0 as usize] - 4.0).abs() < 1e-4, "x+");
    assert!(border.overhang[NavChunkFace::Z_MIN.0 as usize].abs() < 1e-4, "z-");
    assert_eq!(border.box_min, BORDER_MIN);
    assert_eq!((border.min_depth, border.max_depth), (1, 2));
}

#[test]
fn triangles_are_the_band_along_the_faces_unclipped() {
    let bake = bounded(BORDER_MIN, BORDER_MAX, |b| {
        b.add_floor_simple(-40.0, 40.0);
        b.add_box(v3(42.0, 1.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY); // transition geometry past x+
        b.add_box(v3(0.0, 1.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY); // the middle, outside the band
        b.add_box(v3(-20.0, 1.0, 30.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY); // 10 m inside z+: in it
    });
    let border = bake.out.file.chunk_border.as_ref().expect("border");

    let (mut past, mut middle, mut near_z, mut floor) = (false, false, false, false);
    for t in &border.triangles {
        let lo = t.a.min_v(t.b).min_v(t.c);
        let hi = t.a.max_v(t.b).max_v(t.c);
        past |= lo.x >= 41.0 - 1e-3;
        middle |= lo.x >= -1.0 - 1e-3 && hi.x <= 1.0 + 1e-3 && lo.z >= -1.0 - 1e-3 && hi.z <= 1.0 + 1e-3;
        near_z |= lo.z >= 29.0 - 1e-3 && hi.z <= 31.0 + 1e-3 && hi.x <= -19.0 + 1e-3;
        floor |= hi.x - lo.x >= 79.0; // the floor's triangles, whole
    }
    assert!(past, "the box past x+ (clipped away from the navmesh) is kept whole");
    assert!(!middle, "the box in the middle is outside every band");
    assert!(near_z, "the box 10 m inside z+ is in the band");
    assert!(floor, "triangles are kept unclipped");
}

#[test]
fn profiles_and_agents_describe_the_build() {
    let bake = bounded(BORDER_MIN, BORDER_MAX, |b| b.add_floor_simple(-40.0, 40.0));
    let border = bake.out.file.chunk_border.as_ref().expect("border");

    assert_eq!(border.profiles.len(), 1);
    assert_eq!(border.agents.len(), 1);
    assert_eq!(border.agents[0].agent_type, flat_profile().id);
    assert_eq!(border.agents[0].profile, 0);
    let profile = &border.profiles[0];
    assert_eq!(profile.agent.radius, 0.5);
    assert_eq!(profile.grid.cs, 0.25);
    assert_eq!(profile.grid.width, 320, "80 m of 0.25 m columns");
    assert_eq!(profile.grid.tile_size, 64);
    assert_eq!(profile.grid.border, 5, "radius 2 voxels + 3");
    assert_eq!(profile.grid.bounds.min, BORDER_MIN, "the ground grid starts at the box's corner");
    assert_eq!(border.areas.len(), 2, "the null and walkable areas");
}

#[test]
fn tile_ranges_cover_every_ground_polygon_once() {
    let bake = bounded(BORDER_MIN, BORDER_MAX, |b| {
        b.add_floor_simple(-40.0, 40.0);
        b.add_box(v3(10.0, 1.0, -5.0), v3(4.0, 2.0, 3.0), Rot::y(0.3));
    });
    let nav = bake.nav();

    assert_eq!(nav.tile_ranges.len(), 25, "5 x 5 tiles of 64 columns over 320");
    let mut covered = vec![false; nav.polys.len()];
    for range in &nav.tile_ranges {
        assert_eq!(range.origin.x % 64, 0, "tile origins on the tile grid");
        for p in range.poly_start..range.poly_start + range.poly_count {
            assert!(!covered[p as usize], "polygon {p} in two tiles");
            covered[p as usize] = true;
        }
    }
    for (p, poly) in nav.polys.iter().enumerate() {
        if poly.bin == 0 && poly.vert_count >= 3 {
            assert!(covered[p], "ground polygon {p} in no tile");
        }
    }
}

#[test]
fn without_bounds_no_border_data_and_no_tile_ranges() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    assert!(bake.out.file.chunk_border.is_none());
    assert!(bake.nav().tile_ranges.is_empty());
}

#[test]
fn the_border_survives_the_file() {
    let bake = bounded(BORDER_MIN, BORDER_MAX, |b| {
        b.add_floor_simple(-40.0, 40.0);
        b.add_box(v3(42.0, 1.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    });
    let back = nav_format::read(&bake.bytes()).expect("reads back");
    assert_eq!(back.chunk_border, bake.out.file.chunk_border);
    assert_eq!(back.navmeshes[0].data, *bake.nav());
}
