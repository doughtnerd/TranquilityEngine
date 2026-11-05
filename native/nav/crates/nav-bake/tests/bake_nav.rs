//! Black-box checks of the bake on tiny procedural scenes (port of Foxfire's `NavBakeTests`): the bake produces a
//! navmesh, the link graph connects it, closed gates block, jumps exist only where they can be taken, folds follow the
//! fold-angle rule, agent types share navmeshes when they bake alike, and baking is deterministic.
//!
//! Pathfinding comes in a later wave, so "a path exists" is a 0-1 breadth-first search over the baked links
//! (`bake_common::find_path`): jump links cost one, everything else nothing.
mod bake_common;

use bake_common::*;
use nav_bake::bins::OrientationConfig;
use nav_bake::settings::{auto_voxel_size, NavigationSetup};
use nav_bake::stitcher::nav_fold_delta;
use nav_format::NavLinkKind;
use nav_math::Float3;

fn identity() -> Rot {
    Rot::IDENTITY
}

#[test]
fn floor_bakes_and_paths_across() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();

    // The test profile (0.25 m voxels, 0.5 step) trips the voxel-size warning, as in the C#; nothing else.
    assert!(bake.out.warnings.iter().all(|w| w.contains("Coverage Deg")), "{:?}", bake.out.warnings);
    assert_eq!(bake.out.file.navmeshes.len(), 1);
    assert!(!bake.nav().polys.is_empty());
    let (status, _) = find_path(bake.nav(), v3(-8.0, 0.0, -8.0), v3(8.0, 0.0, 8.0), &Filter::walker());
    assert_eq!(status, PathStatus::Success);
    // The fingerprint line names the group and the navmesh's size.
    assert!(bake.out.fingerprints[0].starts_with("NavBake fingerprint: Test polys="), "{}", bake.out.fingerprints[0]);
}

fn bake_corridor_with_gate(open: bool) -> TestBake {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor((-10.0, -2.0), (10.0, 2.0), 0.0, &[]);
    bake.add_gate(v3(0.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), open);
    bake.bake();
    bake
}

#[test]
fn closed_gate_blocks_path_open_gate_does_not() {
    // A corridor along x with a gate across its middle: the only way through.
    let closed = bake_corridor_with_gate(false);
    let open = bake_corridor_with_gate(true);
    let (from, to) = (v3(-9.0, 0.0, 0.0), v3(9.0, 0.0, 0.0));

    assert_eq!(closed.closed_gates().len(), 2, "entry 0 is unused, gate 1 follows");
    assert!(closed.closed_gates()[1]);
    assert!(!open.closed_gates()[1]);
    assert_eq!(closed.out.file.gate_table.as_ref().map(|g| g.ids.len()), Some(2));
    assert!(closed.nav().polys.iter().any(|p| p.gate == 1), "the gate marks polygons");

    let filter = Filter::walker().with_gates(closed.closed_gates());
    assert_eq!(find_path(closed.nav(), from, to, &filter).0, PathStatus::Partial);
    let filter = Filter::walker().with_gates(open.closed_gates());
    assert_eq!(find_path(open.nav(), from, to, &filter).0, PathStatus::Success);
}

/// Two floors at the same height with a 2 m gap between them: walkable only by jumping.
fn bake_two_platforms() -> TestBake {
    let mut bake = TestBake::new(Some(profile(true, false, false, 1)));
    bake.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    bake.add_floor((1.0, -3.0), (8.0, 3.0), 0.0, &[]);
    bake.bake();
    bake
}

#[test]
fn gap_is_crossed_only_by_jumping_when_allowed() {
    let bake = bake_two_platforms();
    let (from, to) = (v3(-6.0, 0.0, 0.0), v3(6.0, 0.0, 0.0));
    assert_eq!(find_path(bake.nav(), from, to, &Filter::walker()).0, PathStatus::Partial);
    let (status, jumps) = find_path(bake.nav(), from, to, &Filter::jumper(1.0, 4.0, 2.0));
    assert_eq!(status, PathStatus::Success);
    assert!(jumps > 0, "the path crossed the gap without a jump link");
    // A jumper too weak for the gap can't.
    assert_eq!(find_path(bake.nav(), from, to, &Filter::jumper(1.0, 1.0, 2.0)).0, PathStatus::Partial);
}

#[test]
fn ledge_on_a_tile_edge_still_jumps_up() {
    // With Chunk Bounds the ground is tiled from the box's corner: 64 voxels of 0.375 m, a tile line at z = 24. The lower
    // block's top (eroded to end at z 24.25) is cut there; nothing across matches its edge, so that edge must count as a
    // ledge, or there's no jump from it up onto the higher block.
    let mut p = profile(true, false, false, 1);
    p.radius = 0.75;
    p.cell_size = 0.375;
    p.cell_height = 0.1875;
    p.max_jump_up_height = 2.5;
    p.max_jump_distance = 5.0;
    p.max_fall_distance = 5.0;
    p.jump_arc_height = 1.5;
    let mut bake = TestBake::new(Some(p));
    bake.set_chunk_bounds(v3(0.0, 0.0, 0.0), v3(48.0, 24.0, 48.0), 1, 2);
    bake.add_floor((0.0, 0.0), (48.0, 48.0), 0.0, &[]);
    bake.add_box(v3(10.0, 1.0, 22.5), v3(8.0, 2.0, 5.0), identity()); // top z 20..25, y 2
    bake.add_box(v3(10.0, 2.0, 29.5), v3(8.0, 4.0, 5.0), identity()); // top z 27..32, y 4
    bake.bake();

    let nav = bake.nav();
    let up = nav
        .links
        .iter()
        .filter(|l| l.kind == NavLinkKind::JUMP && (l.portal_a.y - 2.0).abs() < 0.3 && (l.dest_a.y - 4.0).abs() < 0.3)
        .count();
    assert!(up > 0, "no jump up from the lower block, whose edge lies on a tile line");
}

fn bake_slope_under_overhang(max_fold_deg: f32, height: f32) -> (TestBake, Float3, Float3) {
    // A 40 degree slope (walkable side up and towards -x) meeting a 140 degree overhang (walkable side down and towards
    // -x) along the z axis: an 80 degree wedge opening towards -x.
    let orientation = OrientationConfig { max_fold_deg, ..OrientationConfig::DEFAULT };
    let mut p = profile(false, true, true, 1);
    p.height = height;
    let mut bake = TestBake::with_orientation(Some(p), orientation);

    let rad = |d: f32| d.to_radians();
    let slope_normal = v3(-rad(40.0).sin(), rad(40.0).cos(), 0.0);
    let overhang_normal = v3(-rad(140.0).sin(), rad(140.0).cos(), 0.0);
    let down_slope = v3(0.0, 0.0, 1.0).cross(slope_normal).normalize() * 10.0;
    let up_overhang = overhang_normal.cross(v3(0.0, 0.0, 1.0)).normalize() * 10.0;
    assert!(down_slope.y < 0.0 && up_overhang.y > 0.0);

    let (near, far) = (v3(0.0, 0.0, -4.0), v3(0.0, 0.0, 4.0));
    bake.add_quad(near, far, far + down_slope, near + down_slope, slope_normal, false);
    bake.add_quad(near, far, far + up_overhang, near + up_overhang, overhang_normal, false);
    bake.bake();
    (bake, down_slope * 0.6 + slope_normal * 0.1, up_overhang * 0.6 + overhang_normal * 0.1)
}

#[test]
fn slope_into_overhang_is_linked_by_a_fold_up_to_max_fold_deg() {
    // Normals 100 degrees apart: a fold delta of 80. A 1 m agent, so that headroom under the wedge doesn't put the edges at
    // the stitcher's gap tolerance (see the C# test); this checks the angle rule.
    let (linked, on_slope, on_overhang) = bake_slope_under_overhang(85.0, 1.0);
    let folds = count_links(linked.nav(), NavLinkKind::FOLD);
    assert_eq!(
        find_path(linked.nav(), on_slope, on_overhang, &Filter::walker()).0,
        PathStatus::Success,
        "no fold link from the slope to the overhang ({folds} fold links, {} polys)",
        linked.nav().polys.len()
    );

    let (limited, on_slope, on_overhang) = bake_slope_under_overhang(75.0, 1.0);
    assert_eq!(
        find_path(limited.nav(), on_slope, on_overhang, &Filter::walker()).0,
        PathStatus::Partial,
        "an 80 degree fold was linked although Max Fold Deg is 75"
    );
}

fn even_slope_is_walkable(degrees: f32) {
    // A plain slope under the walkable limit, 10 m long. Recast's steep-slope rule used to fire on rounding alone every few
    // metres on slopes near 40 degrees, cutting a band across the slope that nothing could path through.
    let rad = degrees.to_radians();
    let normal = v3(-rad.sin(), rad.cos(), 0.0);
    let down = v3(0.0, 0.0, 1.0).cross(normal).normalize() * 10.0;
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_quad(v3(0.0, 0.0, -4.0), v3(0.0, 0.0, 4.0), v3(0.0, 0.0, 4.0) + down, v3(0.0, 0.0, -4.0) + down, normal, false);
    bake.bake();
    let from = down * 0.9 + normal * 0.1;
    let to = down * 0.1 + normal * 0.1;
    assert_eq!(find_path(bake.nav(), from, to, &Filter::walker()).0, PathStatus::Success, "no path up the {degrees} degree slope");
}

#[test]
fn even_slope_30_is_walkable_all_the_way_up() {
    even_slope_is_walkable(30.0);
}

#[test]
fn even_slope_40_is_walkable_all_the_way_up() {
    even_slope_is_walkable(40.0);
}

#[test]
fn fold_delta_ignores_which_way_the_surfaces_face() {
    for (normals_deg, delta_deg) in [(30.0f32, 30.0f32), (150.0, 30.0), (90.0, 90.0), (0.0, 0.0)] {
        let delta = nav_fold_delta(normals_deg.to_radians()).to_degrees();
        assert!((delta - delta_deg).abs() < 1e-3, "{normals_deg}: {delta}");
    }
}

#[test]
fn thin_lip_outside_fold_hinges_stay_next_to_their_portals() {
    // A thin slab, tilted a little: its top and bottom fold around its edges as outside corners whose planes are (nearly)
    // parallel, so the planes' intersection line is far off or missing. The baked hinge must stay by the edge.
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_box(v3(0.0, 3.0, 0.0), v3(8.0, 0.3, 8.0), Rot::z(3.0f32.to_radians()));
    bake.bake();

    let reach = 3.0; // a little over the test profile's gap tolerance (2.65)
    let mut outside = 0;
    for l in &bake.nav().links {
        if l.kind != NavLinkKind::FOLD || l.convex == 0 {
            continue;
        }
        outside += 1;
        assert!(l.hinge_a.distance(l.portal_a) <= reach, "hinge A is far from its portal");
        assert!(l.hinge_a.distance(l.dest_a) <= reach, "hinge A is far from its destination");
        assert!(l.hinge_b.distance(l.portal_b) <= reach, "hinge B is far from its portal");
        assert!(l.hinge_b.distance(l.dest_b) <= reach, "hinge B is far from its destination");
    }
    assert!(outside > 0, "no outside-corner folds around the slab's edges");
}

#[test]
fn wall_on_a_floor_has_no_wrap_round_its_buried_base_but_a_thin_wall_wraps_over_its_top() {
    // Both faces of a wall standing on a floor are cut back from the floor by erosion, so their bottom edges look like the
    // two sides of a thin plate. The way round that "edge" is through the floor: the fold clearance rejects it. A wall
    // thinner than an agent has no walkable top, so its top edge is the only way over: that wrap is in open air and stays.
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(-6.0, 2.5, 0.0), v3(1.0, 5.0, 10.0), identity()); // thick: x -6.5..-5.5
    bake.add_box(v3(6.0, 2.0, 0.0), v3(0.3, 4.0, 10.0), identity()); // thin: x 5.85..6.15
    bake.bake();

    let nav = bake.nav();
    let (mut under_thick, mut under_thin, mut over_thin) = (0, 0, 0);
    for (p, poly) in nav.polys.iter().enumerate() {
        let _ = p;
        for l in 0..poly.link_count {
            let link = &nav.links[(poly.link_start + l) as usize];
            if link.kind != NavLinkKind::FOLD || link.convex == 0 {
                continue;
            }
            let (a, b) = (poly, &nav.polys[link.to_poly as usize]);
            if a.normal.y.abs() > 0.7 || b.normal.y.abs() > 0.7 || a.normal.dot(b.normal) > -0.9 {
                continue; // wall to opposite wall
            }
            let thick = a.center.x < 0.0;
            let low = link.portal_a.y < 2.0;
            if low && thick {
                under_thick += 1;
            } else if low {
                under_thin += 1;
            } else if !thick {
                over_thin += 1;
            }
        }
    }
    assert_eq!(under_thick, 0, "a fold wraps round the thick wall's base, through the floor");
    assert_eq!(under_thin, 0, "a fold wraps round the thin wall's base, through the floor");
    assert!(over_thin > 0, "no fold over the thin wall's top edge");
}

fn climber() -> nav_bake::settings::BakeProfile {
    let mut p = profile(false, true, true, 1);
    p.radius = 0.75;
    p.height = 1.5;
    p.cell_size = 0.375;
    p.cell_height = 0.1875;
    p
}

#[test]
fn roof_between_capped_walls_has_no_fold_over_the_caps_but_a_box_top_still_folds_over_its_rim() {
    // The streaming demo's climb course: side walls walkable to 7 m under a 1 m obstacle cap, a roof between them up to
    // 8 m. The roof's top and a wall's outside face, continued, meet on top of the cap: no fold there. Nor does a wall's
    // outside face wrap over its top to its inside face: the top is under the cap. A real corner is about an agent radius
    // from each edge: a box's top still folds over its rim.
    let mut bake = TestBake::new(Some(climber()));
    bake.add_floor((-30.0, -30.0), (30.0, 30.0), 0.0, &[]);
    bake.add_box(v3(-4.5, 3.5, 0.0), v3(1.0, 7.0, 30.0), identity());
    bake.add_box(v3(4.5, 3.5, 0.0), v3(1.0, 7.0, 30.0), identity());
    bake.add_obstacle(v3(-4.5, 7.5, 0.0), v3(1.0, 1.0, 30.0), identity());
    bake.add_obstacle(v3(4.5, 7.5, 0.0), v3(1.0, 1.0, 30.0), identity());
    bake.add_box(v3(0.0, 6.0, 0.0), v3(8.0, 4.0, 8.0), identity()); // the roof, 4-8 m
    bake.add_box(v3(-18.0, 2.0, 0.0), v3(8.0, 4.0, 8.0), identity()); // a plain box, top at 4 m
    bake.bake();

    let nav = bake.nav();
    let (mut over_caps, mut over_rim, mut over_capped) = (0, 0, 0);
    for poly in &nav.polys {
        for l in 0..poly.link_count {
            let link = &nav.links[(poly.link_start + l) as usize];
            if link.kind != NavLinkKind::FOLD || link.convex == 0 {
                continue;
            }
            let (a, b) = (poly, &nav.polys[link.to_poly as usize]);
            if a.normal.y >= 0.7 && b.normal.y.abs() <= 0.7 {
                // a top to a side
                if a.center.y > 7.5 && b.center.x.abs() > 4.6 {
                    over_caps += 1; // the roof's top to a wall's outside face
                }
                if a.center.x < -12.0 && a.center.y > 3.5 {
                    over_rim += 1; // the box's top to its sides
                }
            }
            // A wall's outside face to its inside face, over its capped top (or the reverse).
            if a.normal.y.abs() < 0.7 && a.normal.dot(b.normal) < -0.9 && link.portal_a.y > 4.0 && a.center.x.abs() > 3.5 {
                over_capped += 1;
            }
        }
    }
    assert_eq!(over_caps, 0, "folds from the roof's top over the caps to the walls' outside faces");
    assert_eq!(over_capped, 0, "folds wrapping over a wall's capped top");
    assert!(over_rim > 0, "no folds from the box's top over its rim");
}

#[test]
fn capped_corridor_in_a_chunk_has_no_wraps_over_the_caps() {
    // The climb corridor in its chunk: there the voxel grid starts at the chunk's corner, and the walls' outside faces fall
    // near a cell boundary. The fold clearance's look along a face past its edge must find the cap's face carrying on
    // whatever the alignment.
    let mut bake = TestBake::new(Some(climber()));
    let x = -180.0;
    bake.set_chunk_bounds(v3(-192.0, -8.0, -64.0), v3(-64.0, 40.0, 64.0), 1, 2);
    bake.add_box(v3(-128.0, -0.5, 0.0), v3(128.0, 1.0, 128.0), identity()); // the ground
    for side in [-1.0f32, 1.0] {
        bake.add_box(v3(x + side * 4.5, 3.5, -30.0), v3(1.0, 7.0, 46.0), identity());
        bake.add_obstacle(v3(x + side * 4.5, 7.5, -30.0), v3(1.0, 1.0, 46.0), identity());
    }
    bake.add_box(v3(x, 6.0, -24.0), v3(8.0, 4.0, 8.0), identity()); // the roof
    bake.bake();

    let nav = bake.nav();
    let mut over_caps = 0;
    for poly in &nav.polys {
        for l in 0..poly.link_count {
            let link = &nav.links[(poly.link_start + l) as usize];
            if link.kind != NavLinkKind::FOLD || link.convex == 0 {
                continue;
            }
            let b = &nav.polys[link.to_poly as usize];
            if poly.normal.y.abs() < 0.7 && poly.normal.dot(b.normal) < -0.9 && link.portal_a.y > 4.0 {
                over_caps += 1;
            }
        }
    }
    assert_eq!(over_caps, 0, "folds wrapping over a wall's capped top");
}

#[test]
fn box_corner_outside_fold_hinge_is_on_the_edge() {
    // A plain box: the top wraps onto each side over a 90 degree outside corner, and the hinge is on that corner.
    let mut bake = TestBake::new(Some(profile(false, true, true, 1)));
    bake.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    bake.add_box(v3(0.0, 2.0, 0.0), v3(8.0, 4.0, 8.0), identity());
    bake.bake();

    let nav = bake.nav();
    let mut checked = 0;
    for poly in &nav.polys {
        for l in 0..poly.link_count {
            let link = &nav.links[(poly.link_start + l) as usize];
            if link.kind != NavLinkKind::FOLD || link.convex == 0 {
                continue;
            }
            // The box's top (floor bin, 4 m up) to a side. The box is a hollow shell, so the floor inside it and its underside
            // are walkable too and fold round its base like the two faces of a thin plate: not what this checks.
            let dest = &nav.polys[link.to_poly as usize];
            let top = poly.bin == 0 && poly.center.y > 3.0;
            let to_top = dest.bin == 0 && dest.center.y > 3.0;
            if !top && !to_top {
                continue;
            }
            for hinge in [link.hinge_a, link.hinge_b] {
                assert!((hinge.y - 4.0).abs() <= 0.5, "hinge {hinge:?} isn't at the box's top edge");
                let on_rim = (hinge.x.abs() - 4.0).abs() < 0.5 || (hinge.z.abs() - 4.0).abs() < 0.5;
                assert!(on_rim, "hinge {hinge:?} isn't on the box's rim");
                checked += 1;
            }
        }
    }
    assert!(checked > 0, "no outside-corner folds over the box's rim");
}

#[test]
fn identical_agent_types_share_one_navmesh_with_the_larger_jumps() {
    let walker = profile(true, false, false, 1);
    let mut leaper = profile(true, false, false, 2);
    leaper.max_jump_distance = 8.0;
    let mut bake = TestBake::new(Some(walker));
    bake.add_agent(leaper);
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();

    assert_eq!(bake.out.file.navmeshes.len(), 1, "identical agent types baked separate navmeshes");
    assert_eq!(bake.out.agents.iter().map(|a| a.group).collect::<Vec<_>>(), vec![0, 0]);
    assert_eq!(bake.out.profiles[0].max_jump_distance, 8.0, "the shared navmesh didn't take the larger jump");
    // The log names the agent types sharing the navmesh.
    assert!(bake.out.fingerprints[0].contains("Test + Test"), "{}", bake.out.fingerprints[0]);
}

#[test]
fn different_agent_types_get_their_own_navmeshes() {
    let small = profile(false, false, false, 1);
    let mut large = profile(false, false, false, 2);
    large.radius = 1.0;
    let mut bake = TestBake::new(Some(small));
    bake.add_agent(large);
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();

    assert_eq!(bake.out.file.navmeshes.len(), 2);
    assert_eq!(bake.out.agents.iter().map(|a| a.group).collect::<Vec<_>>(), vec![0, 1]);
    // Sections are keyed by group.
    assert_eq!(bake.out.file.navmeshes.iter().map(|s| s.group).collect::<Vec<_>>(), vec![0, 1]);
    // The larger agent has a smaller navmesh on the same floor.
    let (a, b) = (vert_bounds(&bake.out.file.navmeshes[0].data), vert_bounds(&bake.out.file.navmeshes[1].data));
    assert!(b.1.x < a.1.x, "the radius 1 navmesh should be eroded further from the floor's edge");
}

#[test]
fn walkable_for_keeps_otherwise_identical_agent_types_apart() {
    let a = profile(false, false, false, 1);
    let b = profile(false, false, false, 2);
    let a_id = a.id;
    let mut bake = TestBake::new(Some(a));
    bake.add_agent(b);
    bake.add_floor((-10.0, -10.0), (10.0, 10.0), 0.0, &[a_id]); // walkable for a only
    bake.bake();

    assert_eq!(bake.out.agents.iter().map(|g| g.group).collect::<Vec<_>>(), vec![0, 1]);
    assert!(!bake.out.file.navmeshes[0].data.polys.is_empty(), "a has no navmesh on its own floor");
    assert!(bake.out.file.navmeshes[1].data.polys.is_empty(), "b can walk a floor that isn't walkable for it");
    assert!(bake.out.warnings.iter().any(|w| w.contains("is empty")), "an empty navmesh warns: {:?}", bake.out.warnings);
}

#[test]
fn auto_voxel_size_follows_radius_and_step() {
    for (radius, step, cell_size, cell_height) in [(0.5f32, 0.25f32, 0.25f32, 0.125f32), (5.0, 8.0, 2.5, 1.25)] {
        let (cs, ch) = auto_voxel_size(radius, step, NavigationSetup::DEFAULT_CELLS_PER_RADIUS);
        assert!((cs - cell_size).abs() < 1e-5 && (ch - cell_height).abs() < 1e-5, "{radius}/{step}: {cs} x {ch}");
    }
}

#[test]
fn bake_is_deterministic() {
    let first = bake_two_platforms();
    let second = bake_two_platforms();
    assert_eq!(first.fingerprint(), second.fingerprint(), "two bakes of the same scene differ");
    assert_eq!(first.bytes(), second.bytes(), "the files differ");
}

#[test]
fn nothing_to_bake_warns_and_still_gives_a_file() {
    let mut bake = TestBake::new(None);
    bake.add_floor_simple(-5.0, 5.0);
    bake.bake();
    assert!(bake.out.warnings.iter().any(|w| w.contains("nothing baked")), "{:?}", bake.out.warnings);
    assert!(bake.out.file.navmeshes.is_empty() && bake.out.file.volumes.is_empty());
    let bytes = bake.bytes();
    let back = nav_format::read(&bytes).expect("an empty bake reads back");
    assert_eq!(back.signature, bake.out.file.signature);
}

#[test]
fn empty_scene_bakes_an_empty_navmesh_with_a_warning() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.bake();
    assert_eq!(bake.out.file.navmeshes.len(), 1);
    assert!(bake.nav().polys.is_empty());
    assert!(bake.out.warnings.iter().any(|w| w.contains("is empty")), "{:?}", bake.out.warnings);
}

#[test]
fn a_mesh_with_stray_indices_is_skipped_with_a_warning() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-5.0, 5.0);
    bake.add_mesh(vec![v3(0.0, 1.0, 0.0), v3(1.0, 1.0, 0.0), v3(0.0, 1.0, 1.0)], vec![0, 1, 2, 9, 9], false);
    bake.add_mesh(vec![v3(0.0, 1.0, 0.0)], vec![0, 1, 2], false);
    bake.bake();
    assert_eq!(bake.out.warnings.iter().filter(|w| w.starts_with("mesh ")).count(), 2, "{:?}", bake.out.warnings);
    assert!(!bake.nav().polys.is_empty());
}
