//! The tile and build caches (port of Foxfire's `BakeCacheTests`): a live rebake reuses the tiles and builds whose
//! inputs didn't change, and its navmesh must be bit for bit what a full bake of the same scene gives. Every test bakes a
//! scene, changes it, rebakes with the same caches (a live baking session), and compares the fingerprint with a fresh bake
//! of the result.
mod bake_common;

use bake_common::*;

/// Floor, ramps and boxes; a tall pillar in a corner fixes the bake's height, so small edits don't change the grid
/// (without Chunk Bounds the grid follows the geometry's extent, and a new extent rebuilds every tile).
fn scene(bake: &mut TestBake) {
    bake.add_floor((-24.0, -24.0), (24.0, 24.0), 0.0, &[]);
    bake.add_box(v3(22.0, 5.0, 22.0), v3(2.0, 10.0, 2.0), Rot::IDENTITY);
    bake.add_box(v3(-6.0, 1.0, 3.0), v3(5.0, 2.0, 3.0), Rot::y(23.0f32.to_radians()));
    bake.add_box(v3(0.0, 0.8, 8.0), v3(6.0, 0.2, 3.0), Rot::x(31.7f32.to_radians()));
    bake.add_box(v3(8.0, 0.6, -10.0), v3(4.0, 1.2, 6.0), Rot::y((-41.0f32).to_radians()));
}

fn obstacle(bake: &mut TestBake) {
    bake.add_obstacle(v3(-14.0, 1.0, -14.0), v3(3.0, 2.0, 3.0), Rot::y(0.4));
}

fn new_bake() -> TestBake {
    TestBake::new(Some(profile(true, false, false, 1)))
}

fn full_bake(build: impl Fn(&mut TestBake), configure: impl Fn(&mut TestBake)) -> (u64, Vec<u8>) {
    let mut fresh = new_bake();
    configure(&mut fresh);
    build(&mut fresh);
    fresh.bake();
    (fresh.fingerprint(), fresh.bytes())
}

fn nothing(_: &mut TestBake) {}

#[test]
fn rebake_unchanged_reuses_everything() {
    let mut bake = new_bake();
    scene(&mut bake);
    bake.bake();
    let first = bake.fingerprint();
    let bytes = bake.bytes();
    assert_eq!(bake.reused_tiles(), 0, "a first bake has nothing to reuse");
    assert!(bake.tile_count() > 1, "the scene should span several tiles");

    bake.bake();
    assert_eq!(bake.reused_tiles(), bake.tile_count(), "tiles reused");
    assert_eq!(bake.reused_tasks(), bake.task_count(), "builds reused");
    assert_eq!(first, bake.fingerprint());
    assert_eq!(bytes, bake.bytes(), "a rebake from the caches writes the same file");
}

#[test]
fn rebake_after_adding_an_obstacle_matches_a_full_bake() {
    let mut bake = new_bake();
    scene(&mut bake);
    bake.bake();

    obstacle(&mut bake);
    bake.bake();
    assert!(bake.reused_tiles() > 0, "nothing reused");
    assert!(bake.reused_tiles() < bake.tile_count(), "the obstacle's tiles should rebuild");
    assert!(bake.reused_tasks() < bake.task_count());
    let (fp, bytes) = full_bake(
        |b| {
            scene(b);
            obstacle(b);
        },
        nothing,
    );
    assert_eq!(fp, bake.fingerprint());
    assert_eq!(bytes, bake.bytes());
}

#[test]
fn rebake_after_removing_an_obstacle_matches_a_full_bake() {
    let mut bake = new_bake();
    scene(&mut bake);
    let mark = bake.mesh_mark();
    obstacle(&mut bake);
    bake.bake();

    bake.remove_meshes_since(mark);
    bake.bake();
    assert!(bake.reused_tiles() > 0, "nothing reused");
    assert_eq!(full_bake(scene, nothing).0, bake.fingerprint());
}

#[test]
fn rebake_several_edits_in_a_row_matches_a_full_bake_each_time() {
    let with_obstacle = |b: &mut TestBake| {
        scene(b);
        obstacle(b);
    };
    let mut bake = new_bake();
    scene(&mut bake);
    bake.bake();

    let mark = bake.mesh_mark();
    obstacle(&mut bake);
    bake.bake();
    assert_eq!(full_bake(with_obstacle, nothing).0, bake.fingerprint(), "after adding");

    bake.remove_meshes_since(mark);
    bake.bake();
    assert_eq!(full_bake(scene, nothing).0, bake.fingerprint(), "after removing");

    obstacle(&mut bake);
    bake.bake();
    assert_eq!(full_bake(with_obstacle, nothing).0, bake.fingerprint(), "after adding again");
    // The obstacle's tiles from two bakes ago were evicted by the bake in between, which didn't use them.
    assert!(bake.reused_tiles() < bake.tile_count(), "evicted tiles rebuild");
    assert!(bake.reused_tiles() > 0, "the rest is reused");
}

#[test]
fn rebake_with_chunk_bounds_after_an_edit_matches_a_full_bake() {
    let bounds = |b: &mut TestBake| b.set_chunk_bounds(v3(-20.0, -2.0, -20.0), v3(20.0, 12.0, 20.0), 1, 2);
    let mut bake = new_bake();
    bounds(&mut bake);
    scene(&mut bake);
    bake.bake();

    obstacle(&mut bake);
    bake.bake();
    assert!(bake.reused_tiles() > 0, "nothing reused");
    let (fp, bytes) = full_bake(
        |b| {
            scene(b);
            obstacle(b);
        },
        bounds,
    );
    assert_eq!(fp, bake.fingerprint());
    assert_eq!(bytes, bake.bytes(), "the border data matches too");
}

#[test]
fn rebake_after_a_tile_size_change_rebuilds_everything_and_matches_a_full_bake() {
    let mut bake = new_bake();
    scene(&mut bake);
    bake.bake();

    bake.set_tile_size(32);
    bake.bake();
    assert_eq!(bake.reused_tiles(), 0, "a new tile size changes every tile");
    assert_eq!(full_bake(scene, |b| b.set_tile_size(32)).0, bake.fingerprint());
}

#[test]
fn moving_one_vertex_rebuilds_only_the_tiles_it_touches() {
    let mut bake = new_bake();
    scene(&mut bake);
    bake.bake();
    let (tiles, tasks) = (bake.tile_count(), bake.task_count());

    // Lift a corner of the rotated box in the -x half: well inside the grid's extent, so the grid doesn't change.
    // Meshes: the floor, then six quads for each box.
    let victim = 1 + 6; // the first quad of the second box
    bake.meshes[victim].positions[0].y += 0.3;
    bake.bake();

    assert!(bake.reused_tiles() > 0 && bake.reused_tiles() < tiles, "{} of {tiles} tiles reused", bake.reused_tiles());
    assert!(bake.reused_tasks() > 0 && bake.reused_tasks() < tasks, "{} of {tasks} builds reused", bake.reused_tasks());
    let moved = bake.meshes.clone();
    let (fp, _) = full_bake(|b| b.meshes = moved.clone(), nothing);
    assert_eq!(fp, bake.fingerprint());
}

#[test]
fn a_gate_toggle_changes_only_the_gate_table() {
    let build = |open: bool| {
        let mut b = TestBake::new(Some(flat_profile()));
        b.add_floor((-10.0, -2.0), (10.0, 2.0), 0.0, &[]);
        b.add_gate(v3(0.0, 0.5, 0.0), v3(1.0, 2.0, 6.0), open);
        b
    };
    let mut bake = build(false);
    bake.bake();
    let (fp, closed) = (bake.fingerprint(), bake.closed_gates().to_vec());
    assert!(closed[1]);

    // Same scene with the gate opened: the gate's box (and so every key) is the same, so everything is reused.
    bake.settings.gates = build(true).settings.gates;
    bake.bake();
    assert_eq!(bake.reused_tiles(), bake.tile_count());
    assert_eq!(bake.reused_tasks(), bake.task_count());
    assert_eq!(bake.fingerprint(), fp, "the navmesh is the same");
    assert!(!bake.closed_gates()[1], "the start state changed");
}
