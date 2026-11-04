//! The bake's file and identity: a full write -> read round trip of everything a bake can produce, the input signature
//! (`NavBakeChangeSystem.InputSignature`), the chunk id, the gate table, and the cost of baking a 50 x 50 m scene.
mod bake_common;

use bake_common::*;
use nav_bake::bake::{input_signature, PACKAGE_VERSION};
use nav_bake::output::chunk_id;
use nav_bake::settings::{GateVolume, NavigationSetup};
use nav_format::FormatError;
use nav_math::math::Float4x4;
use nav_math::{Float4, Hash128};

/// Everything at once: a bounded chunk with a floor, boxes, a gate, a custom area and ground volume, and a walk-and-fly
/// agent next to a plain walker.
fn full_scene() -> TestBake {
    let (walker, f) = hybrid(1.0, 0.5, 10.0, 30.0, 1, true);
    let mut bake = TestBake::new(None);
    bake.add_hybrid(walker, f);
    bake.add_agent(profile(false, true, false, 2));
    bake.add_floor_simple(-20.0, 20.0);
    bake.add_box(v3(5.0, 1.0, 5.0), v3(4.0, 2.0, 4.0), Rot::IDENTITY);
    bake.add_box(v3(-8.0, 1.0, 3.0), v3(3.0, 2.0, 3.0), Rot([[0.6, 0.0, 0.8], [0.0, 1.0, 0.0], [-0.8, 0.0, 0.6]]));
    bake.add_gate(v3(0.0, 0.5, -8.0), v3(1.0, 2.0, 6.0), false);
    let area = bake.add_area(3.0);
    bake.add_ground_volume(v3(10.0, 0.0, -10.0), v3(6.0, 4.0, 6.0), area, &[]);
    bake.set_chunk_bounds(v3(-16.0, -1.0, -16.0), v3(16.0, 8.0, 16.0), 1, 2);
    bake.bake();
    bake
}

#[test]
fn the_whole_bake_round_trips_through_the_file() {
    let bake = full_scene();
    let file = &bake.out.file;
    // Everything a bake can write is in it.
    assert_eq!(file.navmeshes.len(), 2, "the walk-and-fly agent and the wall climber differ");
    assert_eq!(file.volumes.len(), 1);
    assert_eq!(file.landing_links.len(), 1);
    assert_eq!(file.gate_table.as_ref().map(|g| g.ids.len()), Some(2));
    assert!(file.chunk_border.is_some());
    // The gate flags and the agent table: the hybrid has both groups, the wall climber only a walk group.
    let gates = file.gate_table.as_ref().unwrap();
    assert_eq!(gates.closed.len(), gates.ids.len());
    assert_eq!(gates.closed.iter().map(|&c| c != 0).collect::<Vec<_>>(), bake.out.gates_closed);
    assert_eq!(gates.closed[1], 1, "the gate starts closed");
    let table = file.agent_table.as_ref().expect("agent table");
    assert_eq!(table.entries.len(), 2);
    let hybrid = &bake.out.hybrids[0];
    let h = table.entries.iter().find(|e| e.id == hybrid.id).unwrap();
    assert!(h.walk_group >= 0 && h.fly_group >= 0, "walk-and-fly agent has both groups");
    let walker = table.entries.iter().find(|e| e.id != hybrid.id).unwrap();
    assert!(walker.walk_group >= 0 && walker.fly_group == -1, "walk-only agent can't fly");
    assert!(!file.navmeshes[0].data.seam_edges.is_empty());
    assert_eq!(file.package_version, PACKAGE_VERSION);

    let bytes = bake.bytes();
    let back = nav_format::read(&bytes).expect("reads back with every fingerprint verified");
    assert_eq!(&back, file, "the file reads back as written");
    assert_eq!(nav_format::write(&back), bytes, "and writes back to the same bytes");

    // The header carries the input signature and the package version.
    let header = nav_format::read_header(&bytes).unwrap();
    assert_eq!(header.signature, input_signature(&bake.input()));
    assert_eq!(header.package_version, PACKAGE_VERSION);

    // The navmesh sections' fingerprints are the ones in the log lines.
    for (section, line) in back.navmeshes.iter().zip(&bake.out.fingerprints) {
        let hash = format!("{:016X}", nav_format::fingerprint::hash_navmesh(&section.data));
        assert!(line.ends_with(&hash), "{line} / {hash}");
    }
}

#[test]
fn a_damaged_file_is_refused() {
    let bake = full_scene();
    let mut bytes = bake.bytes();
    let last = bytes.len() / 2;
    bytes[last] ^= 0x5A;
    let err = nav_format::read(&bytes).expect_err("a flipped byte is caught");
    assert!(matches!(err, FormatError::FingerprintMismatch { .. } | FormatError::BadCount { .. } | FormatError::InvalidEnum { .. } | FormatError::BadLayout(_)), "{err}");
}

#[test]
fn the_bake_output_is_a_pure_function_of_the_input() {
    let a = full_scene();
    let b = full_scene();
    assert_eq!(a.bytes(), b.bytes());
    assert_eq!(a.out.fingerprints, b.out.fingerprints);
    assert_eq!(a.out.chunk_id, b.out.chunk_id);
}

// ---------------------------------------------------------------------------------------------------------
// The input signature
// ---------------------------------------------------------------------------------------------------------

fn small_scene() -> TestBake {
    let mut b = TestBake::new(Some(profile(true, false, false, 1)));
    b.add_floor_simple(-10.0, 10.0);
    b.add_box(v3(3.0, 1.0, 3.0), v3(2.0, 2.0, 2.0), Rot::IDENTITY);
    b.add_gate(v3(0.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), true);
    b
}

fn signature(b: &TestBake) -> Hash128 {
    input_signature(&b.input())
}

#[test]
fn equal_inputs_have_equal_signatures_and_the_file_carries_it() {
    let mut a = small_scene();
    a.bake();
    assert_eq!(signature(&a), signature(&small_scene()));
    assert_eq!(a.out.file.signature, signature(&a));
    assert!(signature(&a) != Hash128::default());
}

#[test]
fn the_signature_ignores_mesh_order() {
    let a = small_scene();
    let mut b = small_scene();
    b.meshes.reverse();
    assert_eq!(signature(&a), signature(&b));
}

#[test]
fn the_signature_follows_everything_the_bake_reads() {
    let base = signature(&small_scene());
    let differs = |name: &str, change: &dyn Fn(&mut TestBake)| {
        let mut b = small_scene();
        change(&mut b);
        assert!(signature(&b) != base, "the signature ignores {name}");
    };
    differs("a moved vertex", &|b| b.meshes[0].positions[0].y += 0.01);
    differs("a mesh's kind", &|b| b.meshes[1] = nav_bake::bake::BakeMesh::obstacle(b.meshes[1].positions.clone(), b.meshes[1].indices.clone()));
    differs("a mesh's walkable-for list", &|b| b.meshes[0].walkable_for = vec![Hash128::new(1, 0, 0, 0)]);
    differs("a mesh being added", &|b| b.add_box(v3(-5.0, 1.0, -5.0), v3(1.0, 1.0, 1.0), Rot::IDENTITY));
    differs("a gate's start state", &|b| b.settings.gates[0].start_open = false);
    differs("a gate's box", &|b| b.add_gate(v3(5.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), true));
    differs("an agent's radius", &|b| b.settings.setup.agents[0].walk.radius = 0.6);
    differs("an agent's jump", &|b| b.settings.setup.agents[0].walk.max_jump_distance = 9.0);
    differs("another agent", &|b| b.add_agent(profile(false, false, false, 2)));
    differs("an area", &|b| {
        b.add_area(2.0);
    });
    differs("a modifier volume", &|b| {
        let a = b.add_area(2.0);
        b.add_ground_volume(v3(0.0, 0.0, 0.0), v3(2.0, 2.0, 2.0), a, &[]);
    });
    differs("the tile size", &|b| b.set_tile_size(32));
    differs("the orientation settings", &|b| b.settings.setup.orientation.max_fold_deg = 80.0);
    differs("a surface ring", &|b| b.settings.setup.surface_rings[0].count = 8);
    differs("the chunk bounds", &|b| b.set_chunk_bounds(v3(-5.0, -1.0, -5.0), v3(5.0, 4.0, 5.0), 1, 2));
    differs("a flyer", &|b| b.add_flyer(flyer()));
    differs("a resolution volume", &|b| b.add_resolution_volume(v3(0.0, 2.0, 0.0), v3(2.0, 2.0, 2.0), 0.25, &[]));
}

#[test]
fn the_signature_follows_the_overlay_depth() {
    let bounded = |max_depth: i32| {
        let mut b = small_scene();
        b.set_chunk_bounds(v3(-5.0, -1.0, -5.0), v3(5.0, 4.0, 5.0), 1, max_depth);
        signature(&b)
    };
    assert!(bounded(2) != bounded(3));
    assert_eq!(bounded(2), bounded(2));
}

#[test]
fn the_signature_ignores_what_the_bake_does_not_read() {
    let base = signature(&small_scene());
    let mut b = small_scene();
    b.settings.chunk.log_bake_details = true;
    b.settings.chunk.thread_headroom = 0;
    assert_eq!(signature(&b), base, "log flags and thread headroom don't change the bake");
    let mut input = b.input();
    input.scene_path = "elsewhere.scene".to_string();
    assert_eq!(input_signature(&input), base, "the chunk's identity isn't an input of its contents");
}

// ---------------------------------------------------------------------------------------------------------
// Chunk id, gate table, tiers
// ---------------------------------------------------------------------------------------------------------

#[test]
fn the_chunk_id_comes_from_the_scene_and_the_chunk_node() {
    let mut bake = small_scene();
    bake.bake();
    assert_eq!(bake.out.chunk_id, chunk_id("scenes/test.scene", "chunk"));
    let mut input = bake.input();
    input.chunk_node_id = "other".to_string();
    let other = nav_bake::bake::bake_chunk(&input, &mut Default::default());
    assert!(other.chunk_id != bake.out.chunk_id);
    assert_eq!(other.file.navmeshes[0].data, *bake.nav(), "the node's id doesn't change the geometry");
    input.chunk_node_id = "chunk".to_string();
    input.scene_path = "scenes/b.scene".to_string();
    assert!(nav_bake::bake::bake_chunk(&input, &mut Default::default()).chunk_id != bake.out.chunk_id);
}

fn gate(id: u32, x: f32, open: bool) -> GateVolume {
    let m = Float4x4::new(
        Float4::new(1.0, 0.0, 0.0, 0.0),
        Float4::new(0.0, 2.0, 0.0, 0.0),
        Float4::new(0.0, 0.0, 6.0, 0.0),
        Float4::new(x, 0.5, 0.0, 1.0),
    );
    GateVolume::from_box(m, Hash128::new(id, 9, 0, 0), open)
}

#[test]
fn gate_indices_follow_the_gate_ids_not_their_order() {
    let build = |gates: Vec<GateVolume>| {
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-10.0, -2.0), (10.0, 2.0), 0.0, &[]);
        b.settings.gates = gates;
        b.bake();
        b
    };
    let a = build(vec![gate(7, -4.0, true), gate(3, 4.0, false)]);
    let b = build(vec![gate(3, 4.0, false), gate(7, -4.0, true)]);
    let ids = &a.out.file.gate_table.as_ref().unwrap().ids;
    assert_eq!(ids, &vec![Hash128::default(), Hash128::new(3, 9, 0, 0), Hash128::new(7, 9, 0, 0)]);
    assert_eq!(a.closed_gates(), &[false, true, false], "gate 3 starts closed, gate 7 open");
    assert_eq!(a.out.file.gate_table, b.out.file.gate_table);
    assert_eq!(a.closed_gates(), b.closed_gates());
    assert_eq!(a.fingerprint(), b.fingerprint(), "the navmesh doesn't depend on the gate order");
    assert_eq!(signature(&a), signature(&b));
}

#[test]
fn no_gates_no_gate_table() {
    let mut bake = TestBake::new(Some(flat_profile()));
    bake.add_floor_simple(-5.0, 5.0);
    bake.bake();
    assert!(bake.out.file.gate_table.is_none());
    assert_eq!(bake.closed_gates(), &[false]);
}

#[test]
fn agents_with_different_voxel_sizes_bake_in_separate_tiers() {
    let mut bake = TestBake::new(Some(profile(false, false, false, 1)));
    bake.add_agent(profile(false, false, false, 2));
    bake.settings.setup.agents[1].walk.radius = 1.0;
    bake.settings.setup.voxels = nav_bake::settings::VoxelSizing::Auto;
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    assert_eq!(bake.out.report.tiers, 2);
    assert_eq!(bake.out.file.navmeshes.len(), 2);
    let (fine, coarse) = (&bake.out.profiles[0], &bake.out.profiles[1]);
    assert!(coarse.cell_size > fine.cell_size);
    for nav in bake.navs() {
        assert!(!nav.polys.is_empty());
    }
}

#[test]
fn a_bake_reports_every_stage() {
    let mut bake = small_scene();
    bake.bake();
    let stages: Vec<_> = bake.out.report.stage_times.iter().map(|s| s.stage).collect();
    assert_eq!(stages, nav_bake::types::BakeStage::ALL.to_vec());
    assert_eq!(bake.out.report.triangles, 14, "the floor's 2 and the box's 12");
}

// ---------------------------------------------------------------------------------------------------------
// Cost of a ~50 x 50 m scene (run with --release and --nocapture to see the times)
// ---------------------------------------------------------------------------------------------------------

fn big_scene(walls: bool, flyer_too: bool) -> TestBake {
    let mut p = profile(true, walls, walls, 1);
    p.radius = 0.5;
    let mut bake = TestBake::new(None);
    if flyer_too {
        let (w, f) = hybrid(1.0, 0.5, 10.0, 30.0, 1, true);
        bake.add_hybrid(w, f);
    } else {
        bake.add_agent(p);
    }
    bake.add_floor_simple(-25.0, 25.0);
    let mut random = Rng::new(7);
    for _ in 0..40 {
        let center = v3(random.range(-22.0, 22.0), random.range(0.5, 2.5), random.range(-22.0, 22.0));
        let size = v3(random.range(1.0, 5.0), random.range(0.5, 3.0), random.range(1.0, 5.0));
        bake.add_box(center, size, Rot::euler(random.range(-0.2, 0.2), random.range(0.0, std::f32::consts::TAU), random.range(-0.2, 0.2)));
    }
    bake.add_box(v3(0.0, 0.8, 12.0), v3(6.0, 0.2, 3.0), Rot::x(25.0f32.to_radians()));
    bake
}

#[test]
fn bake_a_50_by_50_metre_scene() {
    for (name, walls, flyer_too) in [("floors only", false, false), ("walls and ceilings", true, false), ("walk and fly", false, true)] {
        let mut bake = big_scene(walls, flyer_too);
        let start = std::time::Instant::now();
        bake.bake();
        let cold = start.elapsed();
        let r = &bake.out.report;
        let nav = bake.nav().clone();
        eprintln!(
            "[{name}] cold bake {:.0} ms ({} triangles, {} tiles, {} builds): {} polys, {} links, {} jumps; stages: {}",
            cold.as_secs_f64() * 1000.0,
            r.triangles,
            r.tiles,
            r.tasks,
            nav.polys.len(),
            nav.links.len(),
            count_links(&nav, nav_format::NavLinkKind::JUMP),
            r.summary(1, 1)
        );
        let start = std::time::Instant::now();
        bake.bake();
        eprintln!("[{name}] rebake from warm caches {:.0} ms", start.elapsed().as_secs_f64() * 1000.0);
        assert!(!bake.nav().polys.is_empty());
        assert_eq!(bake.reused_tiles(), bake.tile_count());
    }
}

#[test]
fn the_default_setup_is_usable() {
    // A setup straight from the defaults (auto voxels) with one agent bakes without surprises.
    let mut setup = NavigationSetup::default();
    setup.agents.push(nav_bake::settings::NavAgentSettings::new("Default", Hash128::new(1, 0, 0, 0)));
    setup.agents[0].walk.radius = 0.5;
    setup.agents[0].walk.height = 2.0;
    setup.agents[0].walk.step_height = 0.4;
    let mut bake = TestBake::new(None);
    bake.settings.setup = setup;
    bake.add_floor_simple(-10.0, 10.0);
    bake.bake();
    assert_eq!(bake.out.profiles[0].cell_size, 0.25);
    assert!(!bake.nav().polys.is_empty());
}
