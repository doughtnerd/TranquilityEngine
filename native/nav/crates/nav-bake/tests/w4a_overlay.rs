//! Overlay builds (the build half of Foxfire's `NavOverlayTests`): chunk A (x in [-40, 0]) has a floor that stops 3 m
//! short of the shared face; chunk B (x in [0, 40]) has a floor that reaches 6 m into A's box (transition geometry).
//! A's own bake can't reach the face. A's overlay rebuilds its edge tiles with B's floor, so it reaches the face.
//! Test agent: 0.25 m voxels, 64-column tiles (16 m), so each 40 m box is 3 tiles across (64, 64, 32 columns) and 2
//! deep (z in [-16, 16]).
mod bake_common;

use bake_common::*;
use nav_bake::overlay::{build_overlay, OverlayInput, OverlayNeighbour};
use nav_format::{NavChunkFace, NavLinkKind};
use nav_math::{Float3, Int2};

const MIN_A: Float3 = Float3::new(-40.0, -1.0, -16.0);
const MAX_A: Float3 = Float3::new(0.0, 6.0, 16.0);
const MIN_B: Float3 = Float3::new(0.0, -1.0, -16.0);
const MAX_B: Float3 = Float3::new(40.0, 6.0, 16.0);

fn chunk_a() -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-40.0, -16.0), (-3.0, 16.0), 0.0, &[]);
    b.set_chunk_bounds(MIN_A, MAX_A, 1, 2);
    b.bake();
    b
}

fn chunk_b() -> TestBake {
    let mut b = TestBake::new(Some(flat_profile()));
    b.add_floor((-6.0, -16.0), (40.0, 16.0), 0.0, &[]); // 6 m past its x- face, into A's box
    b.set_chunk_bounds(MIN_B, MAX_B, 1, 2);
    b.bake();
    b
}

fn profile_of(bake: &TestBake) -> usize {
    bake.out.file.chunk_border.as_ref().unwrap().agents[0].profile as usize
}

#[test]
fn transition_geometry_lets_a_reach_the_face() {
    let a = chunk_a();
    let b = chunk_b();
    assert!(coverage(a.nav(), NavChunkFace::X_MAX) < 0.01, "A's own bake can't reach the face");
    let border_a = a.out.file.chunk_border.as_ref().unwrap();
    let border_b = b.out.file.chunk_border.as_ref().unwrap();
    assert!((border_b.overhang[NavChunkFace::X_MIN.0 as usize] - 6.0).abs() < 1e-3, "B's transition floor");

    let neighbours = [OverlayNeighbour { border: border_b, face: NavChunkFace::X_MAX, profile: profile_of(&b) }];
    let out = build_overlay(&OverlayInput { border: border_a, profile: profile_of(&a), base: a.nav(), neighbours: &neighbours }).expect("builds");

    assert_eq!(out.open_sides, 1 << NavChunkFace::X_MAX.0, "A opens its x+ face");
    assert_eq!(out.tile_size, 64);
    assert_eq!(out.tiles.len(), 2, "one column of tiles (the 32-column last one), 2 deep in z");
    assert!(out.tiles.iter().all(|t| t.x == 2), "the last column of tiles: {:?}", out.tiles);
    assert_eq!(out.tile_origins, vec![Int2::new(128, 0), Int2::new(128, 64)]);
    assert!(out.valid.iter().all(|&v| v));
    assert!(out.triangle_count > 0);
    assert!((coverage(&out.nav, NavChunkFace::X_MAX) - 32.0).abs() < 0.01, "A's overlay reaches the face along all of it");
    assert!(!out.links.is_empty(), "joins to A's kept tiles");

    // The joins are on the inner line (the replaced tiles' low x edge: -40 + 128 * 0.25 = -8), from a kept
    // polygon of A to a polygon of the overlay.
    for l in &out.links {
        assert!(l.base_poly >= 0 && (l.base_poly as usize) < a.nav().polys.len());
        assert!(l.overlay_poly >= 0 && (l.overlay_poly as usize) < out.nav.polys.len());
        for p in [l.a0, l.a1, l.b0, l.b1] {
            assert!((p.x - -8.0).abs() < 1e-3, "on the inner line: {p:?}");
        }
        assert!((l.a0.z - l.b0.z).abs() < 1e-4 && (l.a1.z - l.b1.z).abs() < 1e-4, "b0 pairs with a0");
    }
    let replaced: std::collections::HashSet<i32> = a
        .nav()
        .tile_ranges
        .iter()
        .filter(|r| out.tile_origins.contains(&r.origin))
        .flat_map(|r| r.poly_start..r.poly_start + r.poly_count)
        .collect();
    assert!(!replaced.is_empty());
    assert!(out.links.iter().all(|l| !replaced.contains(&l.base_poly)), "the base side of a join is a kept polygon");
    let covered: f32 = out.links.iter().map(|l| (l.a1.z - l.a0.z).abs()).sum();
    assert!((covered - 32.0).abs() < 0.5, "the inner line is joined along its whole length: {covered}");
    // No jumps in an overlay, and its internal links are the stitcher's.
    assert_eq!(count_links(&out.nav, NavLinkKind::JUMP), 0);
    assert!(!out.nav.tile_ranges.is_empty());
}

#[test]
fn the_other_side_opens_its_own_face() {
    let a = chunk_a();
    let b = chunk_b();
    let border_a = a.out.file.chunk_border.as_ref().unwrap();
    let border_b = b.out.file.chunk_border.as_ref().unwrap();
    let neighbours = [OverlayNeighbour { border: border_a, face: NavChunkFace::X_MIN, profile: profile_of(&a) }];
    let out = build_overlay(&OverlayInput { border: border_b, profile: profile_of(&b), base: b.nav(), neighbours: &neighbours }).expect("builds");
    assert_eq!(out.open_sides, 1 << NavChunkFace::X_MIN.0, "B opens its x- face");
    assert_eq!(out.tiles.len(), 2);
    assert!((coverage(&out.nav, NavChunkFace::X_MIN) - 32.0).abs() < 0.01);
}

#[test]
fn building_twice_gives_the_same_overlay() {
    let a = chunk_a();
    let b = chunk_b();
    let border_a = a.out.file.chunk_border.as_ref().unwrap();
    let border_b = b.out.file.chunk_border.as_ref().unwrap();
    let neighbours = [OverlayNeighbour { border: border_b, face: NavChunkFace::X_MAX, profile: profile_of(&b) }];
    let input = OverlayInput { border: border_a, profile: profile_of(&a), base: a.nav(), neighbours: &neighbours };
    let one = build_overlay(&input).unwrap();
    let two = build_overlay(&input).unwrap();
    assert_eq!(one.nav, two.nav);
    assert_eq!(one.links, two.links);
    assert_eq!(nav_format::fingerprint::hash_navmesh(&one.nav), nav_format::fingerprint::hash_navmesh(&two.nav));
}

#[test]
fn a_profile_out_of_range_builds_nothing() {
    let a = chunk_a();
    let border_a = a.out.file.chunk_border.as_ref().unwrap();
    assert!(build_overlay(&OverlayInput { border: border_a, profile: 9, base: a.nav(), neighbours: &[] }).is_none());
}
