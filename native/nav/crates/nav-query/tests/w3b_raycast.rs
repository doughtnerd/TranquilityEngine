//! The navmesh raycast on baked walking scenes: a floor, a box hole, a floor-to-wall fold, areas and gates.
#[path = "../../nav-bake/tests/bake_common.rs"]
mod bake_common;

use bake_common::*;
use nav_format::{NavLinkKind, NavMeshData};
use nav_math::Float3;
use nav_query::raycast::{raycast, RaycastFilter, RaycastHit};

/// The polygon of `nav` holding `p`: within its bounds and inside its outline in its bin's frame; of several,
/// the one whose plane is nearest.
fn poly_at(nav: &NavMeshData, p: Float3) -> i32 {
    let mut best = (f32::MAX, -1i32);
    for (i, poly) in nav.polys.iter().enumerate() {
        let (lo, hi) = (nav.poly_min[i], nav.poly_max[i]);
        // The baked floor sits a voxel above the geometry (y = 0.2 over a floor at 0): loose in y.
        let (e, ey) = (0.02, 0.5);
        if p.x < lo.x - e || p.y < lo.y - ey || p.z < lo.z - e || p.x > hi.x + e || p.y > hi.y + ey || p.z > hi.z + e {
            continue;
        }
        let bin = &nav.bins[poly.bin as usize];
        let q = |v: Float3| (v.dot(bin.t), v.dot(bin.b));
        let (px, py) = q(p);
        let vs: Vec<(f32, f32)> = (0..poly.vert_count)
            .map(|k| q(nav.verts[nav.poly_verts[(poly.vert_start + k) as usize] as usize]))
            .collect();
        let n = vs.len();
        let area2: f32 = (0..n).map(|k| vs[k].0 * vs[(k + 1) % n].1 - vs[k].1 * vs[(k + 1) % n].0).sum();
        let sgn = if area2 >= 0.0 { 1.0 } else { -1.0 };
        let inside = (0..n).all(|k| {
            let (a, b) = (vs[k], vs[(k + 1) % n]);
            sgn * ((b.0 - a.0) * (py - a.1) - (b.1 - a.1) * (px - a.0)) >= -1e-4
        });
        if !inside {
            continue;
        }
        let d = (p - poly.center).dot(poly.normal).abs();
        if d < best.0 {
            best = (d, i as i32);
        }
    }
    best.1
}

fn cast(nav: &NavMeshData, filter: &RaycastFilter, from: Float3, to: Float3) -> RaycastHit {
    let sp = poly_at(nav, from);
    assert!(sp >= 0, "no polygon at {from:?}");
    raycast(nav, filter, sp, from, to)
}

fn floor_with_hole() -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_obstacle(v3(0.0, 1.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    bake.bake();
    bake
}

#[test]
fn a_clear_line_across_a_floor_is_reached() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    let nav = bake.nav();
    let f = RaycastFilter::default();
    let (a, b) = (v3(-8.0, 0.0, -7.0), v3(8.0, 0.0, 6.0));
    let hit = cast(nav, &f, a, b);
    assert!(hit.reached);
    assert_eq!(hit.t, 1.0);
    assert_eq!(hit.hit_point, b);
    assert_eq!(hit.hit_normal, Float3::default());
    assert!(hit.polys.len() > 2, "crossed several polygons: {}", hit.polys.len());
    assert_eq!(hit.polys[0], poly_at(nav, a));
    assert_eq!(*hit.polys.last().unwrap(), poly_at(nav, b));
    // Consecutive polygons are linked.
    for w in hit.polys.windows(2) {
        let p = &nav.polys[w[0] as usize];
        assert!((0..p.link_count).any(|k| nav.links[(p.link_start + k) as usize].to_poly == w[1]));
    }
}

#[test]
fn a_ray_that_ends_inside_its_polygon_or_has_no_length_is_reached() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    let nav = bake.nav();
    let f = RaycastFilter::default();
    let a = v3(1.0, 0.0, 1.0);
    let hit = cast(nav, &f, a, a);
    assert!(hit.reached && hit.t == 1.0 && hit.polys.len() == 1);
    let hit = cast(nav, &f, a, v3(1.1, 0.0, 1.05));
    assert!(hit.reached);
}

#[test]
fn a_box_hole_stops_the_ray_at_its_edge_with_the_edge_normal() {
    let bake = floor_with_hole();
    let nav = bake.nav();
    let f = RaycastFilter::default();
    let (a, b) = (v3(-6.0, 0.0, 0.0), v3(6.0, 0.0, 0.0));
    let hit = cast(nav, &f, a, b);
    assert!(!hit.reached);
    // The box is x -1..1, eroded by the agent radius 0.5: the hole's edge is about x = -1.5.
    assert!(hit.hit_point.x > -2.0 && hit.hit_point.x < -1.0, "{:?}", hit.hit_point);
    assert!(hit.hit_point.z.abs() < 1e-3);
    assert!((hit.t - (hit.hit_point.x + 6.0) / 12.0).abs() < 1e-3, "t = {}", hit.t);
    assert!(hit.hit_normal.dot(v3(1.0, 0.0, 0.0)) > 0.99, "outward normal of the walkable polygon: {:?}", hit.hit_normal);
    assert!(hit.hit_normal.y.abs() < 1e-3);
    assert!((hit.hit_normal.length() - 1.0).abs() < 1e-4);
    assert!(!hit.polys.is_empty() && *hit.polys.last().unwrap() != -1);
    // The same line a little to the side, and beyond the hole, is clear.
    assert!(cast(nav, &f, v3(-6.0, 0.0, 3.0), v3(6.0, 0.0, 3.0)).reached);
    // From the far side the other way: hits the +x edge with a normal along -x.
    let back = cast(nav, &f, b, a);
    assert!(!back.reached && back.hit_point.x > 1.0 && back.hit_point.x < 2.0, "{:?}", back.hit_point);
    assert!(back.hit_normal.dot(v3(-1.0, 0.0, 0.0)) > 0.9, "the hole edge is slightly slanted: {back:?}");
    // A diagonal into a corner of the hole.
    let diag = cast(nav, &f, v3(-6.0, 0.0, -6.0), v3(6.0, 0.0, 6.0));
    assert!(!diag.reached);
    assert!(diag.t > 0.3 && diag.t < 0.5, "t = {}", diag.t);
}

#[test]
fn a_ray_toward_the_floors_edge_hits_the_boundary() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    let nav = bake.nav();
    let hit = cast(nav, &RaycastFilter::default(), v3(0.0, 0.0, 0.0), v3(20.0, 0.0, 0.0));
    assert!(!hit.reached);
    // The navmesh stops a radius short of the floor's edge (x = 10).
    assert!(hit.hit_point.x > 8.5 && hit.hit_point.x < 10.0, "{:?}", hit.hit_point);
    assert!(hit.hit_normal.dot(v3(1.0, 0.0, 0.0)) > 0.99);
    assert!(hit.t > 0.4 && hit.t < 0.5);
}

#[test]
fn a_start_on_an_edge_or_vertex_works_and_one_outside_the_polygon_does_not() {
    let bake = floor_with_hole();
    let nav = bake.nav();
    let f = RaycastFilter::default();
    // Start on a polygon vertex, walking away over the floor.
    let poly = &nav.polys[poly_at(nav, v3(-6.0, 0.0, 0.0)) as usize];
    let vert = nav.verts[nav.poly_verts[poly.vert_start as usize] as usize];
    let sp = poly_at(nav, vert);
    let away = Float3::new(poly.center.x - vert.x, 0.0, poly.center.z - vert.z);
    let hit = raycast(nav, &f, sp, vert, vert + away * 0.5);
    assert!(hit.reached, "{hit:?}");
    // Start on the middle of an edge, heading out of the polygon into its neighbour.
    let p0 = nav.verts[nav.poly_verts[poly.vert_start as usize] as usize];
    let p1 = nav.verts[nav.poly_verts[(poly.vert_start + 1) as usize] as usize];
    let mid = (p0 + p1) * 0.5;
    let out = raycast(nav, &f, poly_at(nav, v3(-6.0, 0.0, 0.0)), mid, mid + (mid - poly.center));
    assert!(out.t >= 0.0 && !out.polys.is_empty());
    // A start far outside the given polygon: nothing, t = 0.
    let off = raycast(nav, &f, poly_at(nav, v3(-6.0, 0.0, 0.0)), v3(8.0, 0.0, 8.0), v3(7.0, 0.0, 7.0));
    assert!(!off.reached && off.t == 0.0 && off.polys.is_empty());
    // A bad polygon index.
    assert!(raycast(nav, &f, -1, vert, vert).polys.is_empty());
    assert!(raycast(nav, &f, nav.polys.len() as i32, vert, vert).polys.is_empty());
}

fn wall_scene() -> TestBake {
    // A thick wall standing on a floor, walkable on its faces (profile with walls).
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(-6.0, 2.5, 0.0), v3(1.0, 5.0, 10.0), Rot::IDENTITY); // x -6.5..-5.5
    bake.bake();
    bake
}

/// Floor polygons with a fold link to a wall polygon, and the wall polygon: (floor poly, link index).
fn wall_fold(nav: &NavMeshData) -> Option<(usize, usize)> {
    for (i, poly) in nav.polys.iter().enumerate() {
        if poly.normal.y < 0.9 {
            continue;
        }
        for k in 0..poly.link_count {
            let li = (poly.link_start + k) as usize;
            let l = &nav.links[li];
            if l.kind == NavLinkKind::FOLD && nav.polys[l.to_poly as usize].normal.x > 0.9 {
                return Some((i, li));
            }
        }
    }
    None
}

#[test]
fn a_ray_climbs_a_floor_to_wall_fold_when_folds_are_allowed_and_stops_when_not() {
    let bake = wall_scene();
    let nav = bake.nav();
    let (fp, li) = wall_fold(nav).expect("a fold from the floor onto the wall's +x face");
    let link = nav.links[li];
    let wall_poly = &nav.polys[link.to_poly as usize];
    assert!(wall_poly.bin != nav.polys[fp].bin);
    // Aim at a point on the wall polygon, from a point on the floor on the other side of the fold, at the same z.
    let target = wall_poly.center;
    let start = v3(-2.0, 0.0, target.z);
    assert!(poly_at(nav, start) >= 0);
    let f = RaycastFilter::default();
    let hit = cast(nav, &f, start, target);
    assert!(hit.reached, "{hit:?}");
    assert_eq!(hit.t, 1.0);
    assert!(hit.polys.iter().any(|&p| nav.polys[p as usize].bin == wall_poly.bin), "walked onto the wall");
    assert_eq!(*hit.polys.last().unwrap(), poly_at(nav, target));

    // No climbing: the fold angle limit zero.
    // (A fold of exactly pi, over a thin top, has delta 0 and would still pass; floor to wall is pi / 2.)
    let flat = RaycastFilter { max_fold_angle: 0.1, ..RaycastFilter::default() };
    let blocked = cast(nav, &flat, start, target);
    assert!(!blocked.reached);
    assert!(blocked.t > 0.0 && blocked.t < 1.0);
    assert!((blocked.hit_point.y - 0.2).abs() < 1e-3, "stopped on the floor: {:?}", blocked.hit_point);
    assert!(blocked.hit_normal.x < -0.99, "the floor's edge faces the wall (-x): {:?}", blocked.hit_normal);
    assert!(blocked.polys.iter().all(|&p| nav.polys[p as usize].bin == nav.polys[fp].bin));

    // The wall's bin not allowed: the same.
    let floor_only = RaycastFilter { allowed_bins: 1u64 << nav.polys[fp].bin, ..RaycastFilter::default() };
    let blocked = cast(nav, &floor_only, start, target);
    assert!(!blocked.reached && (blocked.hit_point.y - 0.2).abs() < 1e-3);

    // Walking off the wall back onto the floor works the other way too.
    let back = cast(nav, &f, target, start);
    assert!(back.reached, "{back:?}");
    assert!(cast(nav, &flat, target, start).t < 1.0);
}

#[test]
fn an_excluded_area_stops_the_ray() {
    let mut bake = TestBake::new(Some(flat_profile()));
    let mud = bake.add_area(4.0);
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_ground_volume(v3(0.0, 0.0, 0.0), v3(4.0, 4.0, 30.0), mud, &[]);
    bake.bake();
    let nav = bake.nav();
    let (a, b) = (v3(-8.0, 0.0, 0.0), v3(8.0, 0.0, 0.0));
    let open = cast(nav, &RaycastFilter::default(), a, b);
    assert!(open.reached, "areas cost, they don't block");
    let f = RaycastFilter { excluded_areas: 1u64 << nav_format::NavAreas::FIRST_CUSTOM, ..RaycastFilter::default() };
    let hit = cast(nav, &f, a, b);
    assert!(!hit.reached);
    assert!(hit.hit_point.x > -2.6 && hit.hit_point.x < -1.4, "{:?}", hit.hit_point);
    assert!(hit.hit_normal.x > 0.99);
    assert!(hit.polys.iter().all(|&p| nav.polys[p as usize].area == nav_format::NavAreas::WALKABLE));
    // Starting in an excluded polygon: nothing.
    let inside = raycast(nav, &f, poly_at(nav, v3(0.0, 0.0, 0.0)), v3(0.0, 0.0, 0.0), b);
    assert!(inside.polys.is_empty() && !inside.reached && inside.t == 0.0);
}

#[test]
fn a_closed_gate_stops_the_ray_and_an_open_one_does_not() {
    let corridor = |open: bool| {
        let mut bake = TestBake::new(Some(flat_profile()));
        bake.add_floor((-10.0, -2.0), (10.0, 2.0), 0.0, &[]);
        bake.add_gate(v3(0.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), open);
        bake.bake();
        bake
    };
    let (closed, open) = (corridor(false), corridor(true));
    let (a, b) = (v3(-9.0, 0.0, 0.0), v3(9.0, 0.0, 0.0));
    let f = RaycastFilter { closed_gates: closed.closed_gates(), ..RaycastFilter::default() };
    let hit = cast(closed.nav(), &f, a, b);
    assert!(!hit.reached && hit.hit_point.x < 0.0 && hit.hit_normal.x > 0.99, "{hit:?}");
    let f = RaycastFilter { closed_gates: open.closed_gates(), ..RaycastFilter::default() };
    assert!(cast(open.nav(), &f, a, b).reached);
    // With no gate states given, gates are open.
    assert!(cast(closed.nav(), &RaycastFilter::default(), a, b).reached);
}

#[test]
fn jump_links_are_not_followed() {
    let mut bake = TestBake::new(Some(profile(true, false, false, 1)));
    bake.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    bake.add_floor((1.0, -3.0), (8.0, 3.0), 0.0, &[]);
    bake.bake();
    let nav = bake.nav();
    assert!(nav.links.iter().any(|l| l.kind == NavLinkKind::JUMP), "the platforms are joined by jumps");
    let hit = cast(nav, &RaycastFilter::default(), v3(-5.0, 0.0, 0.0), v3(5.0, 0.0, 0.0));
    assert!(!hit.reached);
    assert!(hit.hit_point.x < -1.0 && hit.hit_normal.x > 0.99);
}

#[test]
fn raycast_is_deterministic() {
    let bake = floor_with_hole();
    let nav = bake.nav();
    let f = RaycastFilter::default();
    let (a, b) = (v3(-6.0, 0.0, 0.3), v3(6.0, 0.0, -0.2));
    let first = cast(nav, &f, a, b);
    for _ in 0..5 {
        assert_eq!(cast(nav, &f, a, b), first);
    }
    let wall = wall_scene();
    let n2 = wall.nav();
    if let Some((_, li)) = wall_fold(n2) {
        let target = n2.polys[n2.links[li].to_poly as usize].center;
        let start = v3(-2.0, 0.0, target.z);
        let first = cast(n2, &f, start, target);
        assert_eq!(cast(n2, &f, start, target), first);
    }
}
