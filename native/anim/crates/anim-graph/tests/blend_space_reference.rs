//! Leaf L31a against the f64 reference (`anim-offline::graph`): the runtime triangulation (sweep and
//! Lawson flips) equals the empty-circumcircle definition for points in general position, and its
//! f32 weights match the reference's within 1e-5 (f32 barycentric arithmetic on coordinates of
//! magnitude ≤ 2: a few ulps of 1, with margin) inside and outside the hull.

use anim_graph::sources::triangulate::{triangulate, weights};
use anim_offline::graph as reference;

fn points(seed: u32, n: usize) -> Vec<[f32; 2]> {
    let mut s = seed | 1;
    let mut r = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        (s >> 8) as f32 / (1u32 << 24) as f32 * 4.0 - 2.0
    };
    (0..n).map(|_| [r(), r()]).collect()
}

#[test]
fn triangles_match_the_definition() {
    for (seed, n) in [(7, 5), (11, 9), (23, 16), (99, 30)] {
        let pts = points(seed, n);
        let p64: Vec<[f64; 2]> = pts.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
        let ours = triangulate(&pts);
        assert_eq!(ours.triangles, reference::delaunay(&p64), "seed {seed}");
        let mut h = ours.hull.clone();
        let mut rh = reference::hull(&ours.triangles);
        h.sort();
        rh.sort();
        assert_eq!(h, rh);
    }
}

#[test]
fn weights_match_the_reference_inside_and_outside() {
    let pts = points(31, 12);
    let p64: Vec<[f64; 2]> = pts.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
    let t = triangulate(&pts);
    let mut s = 5u32;
    for _ in 0..400 {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let x = (s & 0xFFFF) as f32 / 65535.0 * 6.0 - 3.0;
        let y = (s >> 16) as f32 / 65535.0 * 6.0 - 3.0;
        let (idx, w) = weights(&pts, &t.triangles, &t.hull, [x, y]);
        let mut ours = vec![0.0f64; pts.len()];
        for k in 0..3 {
            ours[idx[k] as usize] += w[k] as f64;
        }
        let want = reference::weights(&p64, &t.triangles, [x as f64, y as f64]);
        for (a, b) in ours.iter().zip(&want) {
            assert!((a - b).abs() < 1e-5, "at ({x}, {y}): {ours:?} vs {want:?}");
        }
    }
}
