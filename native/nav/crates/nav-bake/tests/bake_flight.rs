//! Flight volumes, landing links and area volumes through the whole bake (the bake-level halves of Foxfire's
//! `FlightVolumeTests`, `FlightAreaTests`, `ResolutionRegionTests` and the landing-link parts of `HybridRouteTests`):
//! a bake with flyers only, one with a walk-and-fly agent, resolution regions, Air and Ground modifier volumes, agent
//! types that share (or don't share) navmeshes and volumes.
mod bake_common;

use bake_common::*;
use nav_bake::settings::ModifierTargets;
use nav_bake::volume::leaf_at;
use nav_format::{NavAreas, NavLinkKind};
use nav_math::Float3;

fn id(n: u32) -> nav_math::Hash128 {
    nav_math::Hash128::new(n, 0, 0, 0)
}

fn pad_scene(b: &mut TestBake) {
    b.add_floor_simple(-10.0, 10.0);
    b.add_box(v3(3.0, 1.0, 3.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
}

#[test]
fn flyers_only_bake_a_flight_volume_and_no_navmesh() {
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0));
    bake.bake();

    assert!(bake.out.file.navmeshes.is_empty(), "no walking agent type, no navmesh");
    assert_eq!(bake.out.file.volumes.len(), 1);
    assert!(bake.out.file.landing_links.is_empty(), "nobody walks and flies");
    assert_eq!(bake.out.flyers.len(), 1);
    assert_eq!(bake.out.flyers[0].group, 0);
    assert_eq!(bake.out.report.tiers, 1, "one rasterization tier for the flight volumes");
    assert_eq!(bake.out.report.tasks, 0);
    assert!(bake.out.report.flight_leaves[0] > 0);
    assert!(bake.out.fingerprints[0].starts_with("NavBake fingerprint: flight volume Test flyer leaves="), "{}", bake.out.fingerprints[0]);

    // Open air high above the floor; blocked inside the box and within the flyer's radius of the floor.
    assert!(!bake.is_flight_blocked(v3(-6.0, 6.0, -6.0), 0), "open air");
    assert!(bake.is_flight_blocked(v3(3.0, 1.0, 3.0), 0), "inside the box");
    assert!(bake.is_flight_blocked(v3(-6.0, 0.5, -6.0), 0), "padded by the radius above the floor");
    assert!(bake.is_flight_blocked(v3(3.0, 2.5, 3.0), 0), "padded above the box");
    assert!(!bake.is_flight_blocked(v3(3.0, 4.5, 3.0), 0), "clear of the padding");
    // Headroom: the volume reaches 10 m above the tallest geometry (2 m).
    assert!(bake.volume().origin.y <= 0.0 && bake.volume().cell_size == 0.5);
    assert!(!bake.is_flight_blocked(v3(-6.0, 11.0, -6.0), 0), "inside the headroom");
    assert!(bake.is_flight_blocked(v3(-6.0, 13.0, -6.0), 0), "above the volume");
}

#[test]
fn an_obstacle_blocks_flight_cells_too() {
    let mut bake = TestBake::new(None);
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_obstacle(v3(0.0, 4.0, 0.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0));
    bake.bake();
    assert!(bake.is_flight_blocked(v3(0.0, 4.0, 0.0), 0));
    assert!(!bake.is_flight_blocked(v3(6.0, 4.0, 0.0), 0));
}

#[test]
fn flyers_that_bake_alike_share_a_volume_and_others_do_not() {
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    let a = flyer_with(1.0, 0.5, 4.0);
    let mut b = a.clone();
    b.id = id(101);
    b.name = "Twin".to_string();
    let mut c = a.clone();
    c.id = id(102);
    c.radius = 2.0;
    c.name = "Big".to_string();
    bake.add_flyer(a);
    bake.add_flyer(b);
    bake.add_flyer(c);
    bake.bake();

    assert_eq!(bake.out.file.volumes.len(), 2, "the twins share a volume");
    assert_eq!(bake.out.flyers.iter().map(|f| f.group).collect::<Vec<_>>(), vec![0, 0, 1]);
    assert!(bake.out.fingerprints[0].contains("Test flyer + Twin"), "{}", bake.out.fingerprints[0]);
    // The bigger flyer's clearance blocks more of the air above the floor.
    assert!(!bake.is_flight_blocked(v3(-6.0, 1.5, -6.0), 0));
    assert!(bake.is_flight_blocked(v3(-6.0, 1.5, -6.0), 1));
}

#[test]
fn a_walk_and_fly_agent_gets_landing_links() {
    let (walker, f) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
    let mut bake = TestBake::new(None);
    bake.add_hybrid(walker, f);
    bake.add_floor_simple(-10.0, 10.0);
    // A 40 degree ramp: steeper than the 30 degree landing limit.
    let rad = 40.0f32.to_radians();
    let rise = 3.0 * rad.tan();
    bake.add_quad(
        v3(-8.0, 0.0, 6.0),
        v3(-4.0, 0.0, 6.0),
        v3(-4.0, rise, 9.0),
        v3(-8.0, rise, 9.0),
        v3(0.0, rad.cos(), -rad.sin()),
        false,
    );
    bake.bake();

    assert_eq!(bake.out.file.navmeshes.len(), 1);
    assert_eq!(bake.out.file.volumes.len(), 1);
    assert_eq!(bake.out.file.landing_links.len(), 1, "one (navmesh, volume) pair");
    assert_eq!(bake.out.landing_pairs, vec![(0, 0)]);
    assert_eq!(bake.out.hybrids.len(), 1);
    assert_eq!(bake.out.hybrids[0].pair, 0);
    assert_eq!(bake.out.details.len(), 1);
    assert!(bake.out.details[0].contains("links"), "{}", bake.out.details[0]);

    let section = &bake.out.file.landing_links[0];
    assert_eq!((section.ground_group, section.air_group), (0, 0));
    let links = &section.data;
    let nav = bake.nav();
    let volume = bake.volume();
    assert!(!links.links.is_empty(), "the floor's polygons have air above them");
    let min_cos = 30.0f32.to_radians().cos();
    for l in &links.links {
        let poly = &nav.polys[l.poly as usize];
        assert_eq!(poly.bin, 0, "floor-bin polygons only");
        assert!(poly.normal.y >= min_cos - 1e-4, "poly {} is steeper than the landing limit", l.poly);
        assert!(l.air.y > l.ground.y, "the air point is above the ground point");
        assert!(l.leaf >= 0 && (l.leaf as usize) < volume.leaves.len());
        assert_eq!(leaf_at(volume, l.air), l.leaf, "the air point is in the link's leaf");
        assert!(l.slope_cos >= min_cos - 1e-4);
    }
    // Index tables: one entry per polygon (and leaf) plus one.
    assert_eq!(links.poly_start.len(), nav.polys.len() + 1);
    assert_eq!(links.leaf_start.len(), volume.leaves.len() + 1);
    assert_eq!(links.by_leaf.len(), links.links.len());
    // No link starts on the steep ramp.
    let steep = nav.polys.iter().position(|p| p.normal.y < min_cos - 0.05 && p.normal.y > 0.3);
    if let Some(s) = steep {
        assert!(links.links.iter().all(|l| l.poly as usize != s), "a link on the steep ramp");
    }
}

#[test]
fn walker_and_flyer_with_different_ids_make_no_landing_links() {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_flyer(flyer_with(1.0, 0.5, 10.0)); // id 100: not the walker's
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    assert_eq!(bake.out.file.navmeshes.len(), 1);
    assert_eq!(bake.out.file.volumes.len(), 1);
    assert!(bake.out.file.landing_links.is_empty());
    assert!(bake.out.hybrids.is_empty());
}

#[test]
fn a_hybrid_that_shares_a_navmesh_links_through_one_pair() {
    // Two walkers that bake alike (one also flies): one navmesh, one volume, one pair.
    let (walker, f) = hybrid(1.0, 0.5, 10.0, 30.0, 1, false);
    let twin = profile(false, false, false, 2);
    let mut bake = TestBake::new(None);
    bake.add_hybrid(walker, f);
    bake.add_agent(twin);
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    assert_eq!(bake.out.file.navmeshes.len(), 1);
    assert_eq!(bake.out.agents.iter().map(|a| a.group).collect::<Vec<_>>(), vec![0, 0]);
    assert_eq!(bake.out.file.landing_links.len(), 1);
}

#[test]
fn resolution_regions_refine_flight_cells() {
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    bake.add_flyer(flyer_with(1.0, 0.5, 4.0));
    bake.add_resolution_volume(v3(-4.0, 4.0, -4.0), v3(4.0, 4.0, 4.0), 0.25, &[]);
    bake.bake();
    assert_eq!(bake.out.report.flight_regions[0], (1, 0), "one region applied, none ignored");
    assert!(!bake.volume().blocks.is_empty(), "the region refined cells");
    assert!(bake.out.warnings.iter().all(|w| !w.contains("resolution region")), "{:?}", bake.out.warnings);

    let mut plain = TestBake::new(None);
    pad_scene(&mut plain);
    plain.add_flyer(flyer_with(1.0, 0.5, 4.0));
    plain.bake();
    assert!(plain.volume().blocks.is_empty());
}

#[test]
fn a_resolution_region_that_does_nothing_warns() {
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    bake.add_flyer(flyer_with(1.0, 0.5, 4.0));
    bake.add_resolution_volume(v3(-4.0, 4.0, -4.0), v3(4.0, 4.0, 4.0), 0.4, &[]); // not at most half of 0.5
    bake.bake();
    assert_eq!(bake.out.report.flight_regions[0], (0, 1));
    assert!(bake.out.warnings.iter().any(|w| w.contains("resolution region")), "{:?}", bake.out.warnings);
}

#[test]
fn a_resolution_region_names_its_flyers_so_they_stop_sharing_a_volume() {
    let a = flyer_with(1.0, 0.5, 4.0);
    let mut b = a.clone();
    b.id = id(101);
    let b_id = b.id;
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    bake.add_flyer(a);
    bake.add_flyer(b);
    bake.add_resolution_volume(v3(-4.0, 4.0, -4.0), v3(4.0, 4.0, 4.0), 0.25, &[b_id]);
    bake.bake();
    assert_eq!(bake.out.file.volumes.len(), 2, "only one of the twins gets the region");
    assert!(bake.out.file.volumes[0].data.blocks.is_empty());
    assert!(!bake.out.file.volumes[1].data.blocks.is_empty());
}

#[test]
fn an_air_modifier_volume_sets_the_area_of_the_cells_inside_it() {
    let mut bake = TestBake::new(None);
    pad_scene(&mut bake);
    let area = bake.add_area(3.0);
    bake.add_flyer(flyer_with(1.0, 0.5, 6.0));
    bake.add_modifier_volume(v3(-5.0, 5.0, -5.0), v3(4.0, 4.0, 4.0), area, ModifierTargets::AIR, &[]);
    bake.bake();

    let volume = bake.volume();
    let inside = leaf_at(volume, v3(-5.0, 5.0, -5.0));
    let outside = leaf_at(volume, v3(5.0, 5.0, -5.0));
    assert!(inside >= 0 && outside >= 0);
    assert_eq!(volume.leaves[inside as usize].area as i32, NavAreas::FIRST_CUSTOM, "the custom area's index");
    assert_eq!(volume.leaves[outside as usize].area as i32, NavAreas::WALKABLE);
    assert_eq!(volume.areas[NavAreas::FIRST_CUSTOM as usize].cost, 3.0, "the area table rides in the volume");
}

#[test]
fn a_ground_modifier_volume_sets_the_area_of_the_polygons_inside_it() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    let area = bake.add_area(5.0);
    bake.add_ground_volume(v3(-5.0, 0.0, 0.0), v3(6.0, 4.0, 30.0), area, &[]);
    bake.bake();

    let nav = bake.nav();
    let custom = NavAreas::FIRST_CUSTOM;
    let inside: Vec<_> = nav.polys.iter().filter(|p| p.center.x < -3.0 && p.center.x > -7.0).collect();
    let outside: Vec<_> = nav.polys.iter().filter(|p| p.center.x > -1.0).collect();
    assert!(!inside.is_empty() && !outside.is_empty());
    assert!(inside.iter().all(|p| p.area == custom), "polygons in the volume take its area");
    assert!(outside.iter().all(|p| p.area == NavAreas::WALKABLE), "the others keep the default");
    assert_eq!(nav.areas.len(), 3);
    assert_eq!(nav.areas[custom as usize].cost, 5.0);
}

#[test]
fn a_ground_modifier_volume_for_one_agent_type_keeps_it_apart_from_its_twin() {
    let a = profile(false, false, false, 1);
    let b = profile(false, false, false, 2);
    let a_id = a.id;
    let mut bake = TestBake::new(Some(a));
    bake.add_agent(b);
    bake.add_floor_simple(-10.0, 10.0);
    let area = bake.add_area(5.0);
    bake.add_ground_volume(v3(-5.0, 0.0, 0.0), v3(6.0, 4.0, 30.0), area, &[a_id]);
    bake.bake();

    assert_eq!(bake.out.file.navmeshes.len(), 2, "named by different volumes, they don't share a navmesh");
    let (na, nb) = (&bake.out.file.navmeshes[0].data, &bake.out.file.navmeshes[1].data);
    assert!(na.polys.iter().any(|p| p.area == NavAreas::FIRST_CUSTOM));
    assert!(nb.polys.iter().all(|p| p.area == NavAreas::WALKABLE));
}

#[test]
fn an_unlisted_area_bakes_as_plain_walkable_with_a_warning() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_ground_volume(v3(0.0, 0.0, 0.0), v3(4.0, 4.0, 4.0), id(9999), &[]);
    bake.bake();
    assert!(bake.out.warnings.iter().any(|w| w.contains("isn't listed")), "{:?}", bake.out.warnings);
    assert!(bake.nav().polys.iter().all(|p| p.area == NavAreas::WALKABLE));
}

#[test]
fn a_mesh_area_marks_its_polygons() {
    let mut bake = TestBake::new(Some(flat_profile()));
    let mud = bake.add_area(4.0);
    bake.add_floor_simple(-10.0, 0.0);
    // A second floor beside the first, in the mud area.
    bake.add_floor((0.0, -10.0), (10.0, 10.0), 0.0, &[]);
    let last = bake.meshes.len() - 1;
    bake.meshes[last] = bake.meshes[last].clone().with_area(mud);
    bake.bake();
    let nav = bake.nav();
    assert!(nav.polys.iter().any(|p| p.area == NavAreas::FIRST_CUSTOM && p.center.x > 2.0));
    assert!(nav.polys.iter().any(|p| p.area == NavAreas::WALKABLE && p.center.x < -2.0));
}

#[test]
fn a_jump_up_between_blocks_works_within_the_limits() {
    let mut bake = TestBake::new(Some(profile(true, false, false, 1)));
    bake.add_floor((-8.0, -3.0), (-1.0, 3.0), 0.0, &[]);
    bake.add_box(v3(4.5, 0.4, 0.0), v3(7.0, 0.8, 6.0), Rot::IDENTITY); // top at 0.8, 1.5 m beyond the floor's edge
    bake.bake();
    let nav = bake.nav();
    let jumps_up = nav.links.iter().filter(|l| l.kind == NavLinkKind::JUMP && l.jump_rise > 0.3).count();
    assert!(jumps_up > 0, "a jump from the floor up onto the block");
    let (from, to) = (v3(-6.0, 0.0, 0.0), v3(6.0, 0.8, 0.0));
    assert_eq!(find_path(nav, from, to, &Filter::jumper(1.0, 4.0, 2.0)).0, PathStatus::Success);
    assert_eq!(find_path(nav, from, to, &Filter::jumper(0.5, 4.0, 2.0)).0, PathStatus::Partial, "too weak to jump up 0.8");
}

#[test]
fn a_flight_volume_next_to_walkers_uses_the_finest_tiers_heightfield() {
    // Two walkers with different voxel sizes (auto sizing): two tiers; the flight volume is built from the finer one.
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    let mut big = profile(false, false, false, 2);
    big.radius = 1.0;
    bake.add_agent(big);
    bake.add_flyer(flyer_with(1.0, 0.5, 4.0));
    bake.settings.setup.voxels = nav_bake::settings::VoxelSizing::Auto;
    bake.settings.setup.flight_voxels = nav_bake::settings::VoxelSizing::Fixed;
    bake.add_floor_simple(-10.0, 10.0);
    bake.add_box(v3(3.0, 1.0, 3.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    bake.bake();

    assert_eq!(bake.out.report.tiers, 2, "voxel sizes follow each agent's radius");
    assert_eq!(bake.out.file.navmeshes.len(), 2);
    assert_eq!(bake.out.file.volumes.len(), 1);
    let cell = bake.volume().cell_size;
    // The finest tier's voxel is cs = radius 0.5 / 2 = 0.25 (rounded to 3 digits): the flight cell is whole voxels of it.
    assert!((cell / 0.25 - (cell / 0.25).round()).abs() < 1e-4, "flight cell {cell} isn't a whole number of 0.25 voxels");
    assert!(bake.is_flight_blocked(v3(3.0, 1.0, 3.0), 0));
    let _: Float3 = bake.volume().origin;
}
