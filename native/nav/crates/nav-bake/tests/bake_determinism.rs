//! Determinism (port of Foxfire's `BakeDeterminismTests`, minus the Burst/managed split: there is one code path here):
//! repeated bakes, bakes from the incremental caches and bakes of the same scene with its meshes given in a different
//! order must all give the same navmesh, bit for bit. On a mismatch the failure lists the polygons only one side has.
mod bake_common;

use bake_common::*;
use nav_format::NavMeshData;

fn key(nav: &NavMeshData, p: usize) -> String {
    let poly = &nav.polys[p];
    let mut verts: Vec<String> = poly_verts(nav, p)
        .iter()
        .map(|v| format!("{},{},{}", (v.x * 1000.0).round(), (v.y * 1000.0).round(), (v.z * 1000.0).round()))
        .collect();
    let start = (0..verts.len()).min_by(|&a, &b| verts[a].cmp(&verts[b])).unwrap_or(0);
    verts.rotate_left(start);
    format!("{}:{}", poly.bin, verts.join(";"))
}

/// The polygons only one navmesh has (bin and vertices to 1 mm), for the failure message.
fn describe(a: &NavMeshData, b: &NavMeshData) -> String {
    let ka: Vec<String> = (0..a.polys.len()).map(|p| key(a, p)).collect();
    let kb: Vec<String> = (0..b.polys.len()).map(|p| key(b, p)).collect();
    let mut s = format!(
        "A: {} polys, {} verts, {} links; B: {} polys, {} verts, {} links\n",
        a.polys.len(),
        a.verts.len(),
        a.links.len(),
        b.polys.len(),
        b.verts.len(),
        b.links.len()
    );
    for (name, from, other, nav) in [("only in A", &ka, &kb, a), ("only in B", &kb, &ka, b)] {
        for (p, _) in from.iter().enumerate().filter(|(_, k)| !other.contains(k)).take(8) {
            s.push_str(&format!("  {name}: poly {p} bin {} area {} centre {:?}\n", nav.polys[p].bin, nav.polys[p].area, nav.polys[p].center));
        }
    }
    s
}

fn assert_same(a: &TestBake, b: &TestBake, what: &str) {
    if a.fingerprint() == b.fingerprint() && a.bytes() == b.bytes() {
        return;
    }
    panic!("{what}: the bakes differ\n{}", describe(a.nav(), b.nav()));
}

fn bake_of(profile: nav_bake::settings::BakeProfile, build: impl Fn(&mut TestBake)) -> TestBake {
    let mut b = TestBake::new(Some(profile));
    build(&mut b);
    b.bake();
    b
}

/// A heightfield mesh: n x n quads of `step` metres, heights from a couple of sine waves.
fn add_terrain(bake: &mut TestBake, n: usize, step: f32, amplitude: f32) {
    let mut positions = Vec::new();
    for z in 0..=n {
        for x in 0..=n {
            let px = (x as f32 - 0.5 * n as f32) * step;
            let pz = (z as f32 - 0.5 * n as f32) * step;
            let y = amplitude * ((px * 0.37).sin() * (pz * 0.29).cos() + 0.35 * (px * 1.3 + pz * 0.9).sin());
            positions.push(v3(px, y, pz));
        }
    }
    let mut indices = Vec::new();
    for z in 0..n {
        for x in 0..n {
            let i = (x + z * (n + 1)) as u32;
            let w = n as u32 + 1;
            indices.extend_from_slice(&[i, i + w, i + 1, i + 1, i + w, i + w + 1]);
        }
    }
    bake.add_mesh(positions, indices, false);
}

fn rotated_boxes_and_ramps(b: &mut TestBake) {
    b.add_floor((-20.0, -20.0), (20.0, 20.0), 0.0, &[]);
    b.add_box(v3(-6.0, 1.0, 3.0), v3(5.0, 2.0, 3.0), Rot::y(23.0f32.to_radians()));
    b.add_box(v3(5.0, 0.6, -4.0), v3(4.0, 1.2, 6.0), Rot::y((-41.0f32).to_radians()));
    // Ramps at awkward angles, near the walkable slope limit.
    b.add_box(v3(0.0, 0.8, 8.0), v3(6.0, 0.2, 3.0), Rot::x(31.7f32.to_radians()));
    b.add_box(v3(10.0, 1.1, 9.0), v3(3.0, 0.2, 7.0), Rot::y(0.6).then(Rot::z(44.3f32.to_radians())));
}

#[test]
fn rotated_boxes_and_ramps_bake_the_same_every_time() {
    let a = bake_of(flat_profile(), rotated_boxes_and_ramps);
    let b = bake_of(flat_profile(), rotated_boxes_and_ramps);
    assert_same(&a, &b, "rotated boxes and ramps");
}

#[test]
fn bumpy_terrain_bakes_the_same_every_time() {
    let build = |b: &mut TestBake| add_terrain(b, 32, 1.25, 1.7);
    assert_same(&bake_of(flat_profile(), build), &bake_of(flat_profile(), build), "bumpy terrain");
}

/// Chunk Bounds clip triangles and move vertices onto the faces: the same every time.
#[test]
fn chunk_bounds_terrain_bakes_the_same_every_time() {
    let build = |b: &mut TestBake| {
        add_terrain(b, 32, 1.25, 1.7);
        b.add_box(v3(7.3, 1.0, -2.0), v3(3.0, 2.0, 3.0), Rot::y(17.0f32.to_radians()));
        b.set_chunk_bounds(v3(-11.3, -5.0, -9.71), v3(7.77, 6.0, 12.4), 1, 2);
    };
    let a = bake_of(flat_profile(), build);
    assert!(!a.nav().polys.is_empty() && !a.nav().seam_edges.is_empty());
    assert_same(&a, &bake_of(flat_profile(), build), "chunk bounds terrain");
}

fn scattered_boxes(reversed: bool) -> impl Fn(&mut TestBake) {
    move |bake: &mut TestBake| {
        let mut boxes = Vec::new();
        let mut random = Rng::new(12345);
        for _ in 0..24 {
            let center = v3(random.range(-20.0, 20.0), random.range(0.5, 3.0), random.range(-20.0, 20.0));
            let size = v3(random.range(1.0, 6.0), random.range(0.5, 4.0), random.range(1.0, 6.0));
            let rot = Rot::euler(random.range(-0.3, 0.3), random.range(0.0, std::f32::consts::TAU), random.range(-0.3, 0.3));
            boxes.push((center, size, rot));
        }
        if reversed {
            boxes.reverse();
        }
        if !reversed {
            bake.add_floor((-25.0, -25.0), (25.0, 25.0), 0.0, &[]);
        }
        for (c, s, r) in boxes {
            bake.add_box(c, s, r);
        }
        if reversed {
            bake.add_floor((-25.0, -25.0), (25.0, 25.0), 0.0, &[]);
        }
    }
}

#[test]
fn scattered_boxes_bake_the_same_whatever_the_order() {
    let p = profile(false, true, true, 1);
    let a = bake_of(p.clone(), scattered_boxes(false));
    let b = bake_of(p, scattered_boxes(true));
    assert!(a.nav().polys.len() > 50, "the scene should have some structure: {} polys", a.nav().polys.len());
    assert_same(&a, &b, "boxes in order / boxes reversed");
}

#[test]
fn scattered_boxes_with_walls_and_ceilings_bake_the_same_every_time() {
    let p = profile(true, true, true, 1);
    let a = bake_of(p.clone(), scattered_boxes(false));
    let b = bake_of(p, scattered_boxes(false));
    assert_same(&a, &b, "scattered boxes, walls and ceilings");
}

#[test]
fn shuffled_input_bakes_the_same() {
    // Every mesh (the floor, the boxes' quads) in a fresh random order, several times over.
    let reference = bake_of(profile(true, true, true, 1), scattered_boxes(false));
    for seed in 1..=4u64 {
        let mut shuffled = TestBake::new(Some(profile(true, true, true, 1)));
        scattered_boxes(false)(&mut shuffled);
        let mut random = Rng::new(seed);
        for i in (1..shuffled.meshes.len()).rev() {
            let j = (random.next_u32() as usize) % (i + 1);
            shuffled.meshes.swap(i, j);
        }
        shuffled.bake();
        assert_same(&reference, &shuffled, &format!("shuffle {seed}"));
    }
}

#[test]
fn a_bake_from_warm_caches_equals_a_cold_one() {
    let mut warm = TestBake::new(Some(profile(true, true, true, 1)));
    scattered_boxes(false)(&mut warm);
    warm.bake();
    warm.bake();
    assert_eq!(warm.reused_tiles(), warm.tile_count());
    let cold = bake_of(profile(true, true, true, 1), scattered_boxes(false));
    assert_same(&warm, &cold, "warm / cold");
}

#[test]
fn a_golden_fingerprint_guards_regressions() {
    // Produced by this port, not by Unity: any change to the bake's output shows up here. Update it on purpose, and only
    // with a reason (ADR 0065: byte parity with Unity is not a goal, regression guarding is).
    let bake = bake_of(profile(true, false, false, 1), |b| {
        b.add_floor((-8.0, -8.0), (8.0, 8.0), 0.0, &[]);
        // A 3-4-5 rotation about y: no trig, so the scene is the same bits on every platform.
        b.add_box(v3(0.0, 1.0, 0.0), v3(3.0, 2.0, 3.0), Rot([[0.6, 0.0, 0.8], [0.0, 1.0, 0.0], [-0.8, 0.0, 0.6]]));
    });
    let fp = bake.fingerprint();
    eprintln!("golden fingerprint: {fp:016X}");
    assert_eq!(fp, GOLDEN, "{fp:016X}");
}

const GOLDEN: u64 = 0x52F4_7118_2294_D84D;
