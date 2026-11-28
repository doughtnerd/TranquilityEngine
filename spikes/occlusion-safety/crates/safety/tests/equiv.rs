//! With every rule off the setup path gives the spike's depth buffer bit for bit; with the rules on, coverage can only shrink and
//! depth can only move away from the camera.
use occ::cull::{setup_instances, N_STATS};
use occ::geom::{Camera, Mesh};
use occ::raster::{raster_scalar, DepthBuf, Tri};
use safety::data::{adjacency, Occluder, Standin};
use safety::setup::{setup_standin, Rule, Shrink, RULE_NONE};

fn scene_mesh() -> Mesh {
    let mut m = Mesh::default();
    m.add_box([-6.0, 0.0, 8.0], [6.0, 7.0, 10.0]);
    m.add_box([8.0, 0.0, 3.0], [10.0, 4.0, 40.0]);
    m.add_box([-30.0, -1.0, -30.0], [30.0, 0.0, 60.0]);
    m.add_box([-0.5, 0.0, -0.5], [0.5, 2.0, 0.5]);
    m.add_icosa([0.0, 3.0, 20.0], [3.0, 3.0, 3.0]);
    m.finish()
}

fn occluder(m: &Mesh, err: f32) -> Occluder {
    let verts: Vec<[f32; 3]> = m.verts.iter().map(|v| [v[0], v[1], v[2]]).collect();
    let (edge_cnt, edge_adj) = adjacency(&m.tris);
    let st = Standin { tris: m.tris.clone(), err, tri_err: vec![err; m.tris.len()], edge_cnt, edge_adj };
    Occluder { diag: 100.0, bmin: [-30.0, -1.0, -30.0], bmax: [30.0, 7.0, 60.0], verts, types: vec![st] }
}

fn cams() -> Vec<Camera> {
    vec![
        Camera::perspective([0.0, 1.7, -5.0], [0.0, 2.0, 30.0], 60.0, 16.0 / 9.0, 0.1, 400.0),
        Camera::perspective([0.0, 1.7, 0.0], [3.0, 1.0, 9.0], 60.0, 16.0 / 9.0, 0.1, 400.0), // inside / touching the small box: near clipping
        Camera::perspective([9.0, 1.7, 1.0], [9.2, 1.0, 40.0], 60.0, 16.0 / 9.0, 0.1, 400.0), // grazing the long wall
        Camera::perspective([-20.0, 0.3, 2.0], [10.0, 3.0, 30.0], 60.0, 16.0 / 9.0, 0.1, 400.0),
        Camera::perspective([2.0, 12.0, -10.0], [0.0, 0.0, 25.0], 60.0, 16.0 / 9.0, 0.1, 400.0),
    ]
}

fn raster(tris: &[Tri], w: usize, h: usize) -> DepthBuf {
    let mut b = DepthBuf::new(w, h);
    for t in tris {
        raster_scalar(&mut b, t);
    }
    b
}

#[test]
fn rules_off_equals_spike() {
    let m = scene_mesh();
    let o = occluder(&m, 0.0);
    for cam in cams() {
        for (w, h) in [(256, 128), (320, 180)] {
            let mut theirs = vec![];
            let mut st = [0u32; N_STATS];
            let xf = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            setup_instances(&cam, w, h, &xf, &[0], std::slice::from_ref(&m), &[0], false, 0.0, &mut vec![], &mut theirs, &mut st);
            let mut mine = vec![];
            setup_standin(&cam, w, h, &o, &o.types[0], &RULE_NONE, &mut mine);
            let (a, b) = (raster(&theirs, w, h), raster(&mine, w, h));
            assert!(a.fine.iter().zip(&b.fine).all(|(x, y)| x.to_bits() == y.to_bits()), "buffers differ at {w}x{h}");
            assert!(a.fine.iter().any(|&d| d > 0.0));
        }
    }
}

#[test]
fn rules_only_move_away_and_shrink() {
    let m = scene_mesh();
    let o = occluder(&m, 0.4);
    let rule = Rule { name: "t", push: true, shrink: Shrink::ErrAll(0.25), ..RULE_NONE };
    for cam in cams() {
        let (mut plain, mut safe) = (vec![], vec![]);
        setup_standin(&cam, 256, 128, &o, &o.types[0], &RULE_NONE, &mut plain);
        setup_standin(&cam, 256, 128, &o, &o.types[0], &rule, &mut safe);
        let (a, b) = (raster(&plain, 256, 128), raster(&safe, 256, 128));
        let mut lost = 0;
        for (x, y) in a.fine.iter().zip(&b.fine) {
            // stored depth is 1/w, larger = nearer: the safe buffer may only be farther (smaller) or empty
            assert!(*y <= *x * 1.0001, "safe buffer nearer than plain: {y} > {x}");
            if *x > 0.0 && *y == 0.0 {
                lost += 1;
            }
        }
        assert!(lost > 0 || plain.is_empty());
    }
}
