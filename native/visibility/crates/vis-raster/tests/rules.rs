//! The core's rules, through `Occlusion::occlude` (ADR 0447 section 3): occlusion, the near rule, the depth push, the
//! silhouette shrink, rejection of NaN and degenerate input, and the 4-wide path against the scalar reference.
use vis_raster::buffer::{raster_scalar, raster_simd, DepthBuf, Tri};
use vis_raster::frame::NONE;
use vis_raster::setup::{setup_poly, xform, EXACT};
use vis_raster::{Config, FrameError, Occluders, Occlusion, Reject, Stats, View};

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The column-major view-projection matrix of a camera at `eye` looking at `target` (y up, clip w = depth).
fn matrix(eye: V3, target: V3, near: f32, far: f32) -> ([f32; 16], f32, f32) {
    let norm = |a: V3| {
        let l = dot(a, a).sqrt();
        [a[0] / l, a[1] / l, a[2] / l]
    };
    let fwd = norm(sub(target, eye));
    let right = norm(cross([0.0, 1.0, 0.0], fwd));
    let up = cross(fwd, right);
    let t = (60f32.to_radians() * 0.5).tan();
    let (sx, sy) = (1.0 / (t * 16.0 / 9.0), 1.0 / t);
    let (a, b) = (far / (far - near), -near * far / (far - near));
    let v = [
        [right[0], right[1], right[2], -dot(right, eye)],
        [up[0], up[1], up[2], -dot(up, eye)],
        [fwd[0], fwd[1], fwd[2], -dot(fwd, eye)],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let p = [
        [sx, 0.0, 0.0, 0.0],
        [0.0, sy, 0.0, 0.0],
        [0.0, 0.0, a, b],
        [0.0, 0.0, 1.0, 0.0],
    ];
    let mut m = [0f32; 16];
    for i in 0..4 {
        for j in 0..4 {
            m[j * 4 + i] = (0..4).map(|k| p[i][k] * v[k][j]).sum();
        }
    }
    (m, sx, sy)
}

/// A view from `eye` looking along +z.
fn view_z(eye: V3) -> View {
    let (m, sx, sy) = matrix(eye, [eye[0], eye[1], eye[2] + 10.0], 0.1, 500.0);
    View::perspective(&m, eye, 0.1, 500.0, sx, sy).unwrap()
}

/// A wall of two triangles in the plane z = `z` (x and y within +-`half`), front face toward -z (the camera).
fn wall(z: f32, half: f32) -> Vec<f32> {
    let (a, b, c, d) = (
        [-half, -half, z],
        [-half, half, z],
        [half, half, z],
        [half, -half, z],
    );
    // the engine's winding (front_normal = (c - a) x (b - a)) must point toward -z: (a, c, b) and (a, d, c) do
    [a, c, b, a, d, c].concat()
}

/// An axis-aligned box as the core's 6 floats.
fn aabb(c: V3, h: V3) -> [f32; 6] {
    [
        c[0] - h[0],
        c[1] - h[1],
        c[2] - h[2],
        c[0] + h[0],
        c[1] + h[1],
        c[2] + h[2],
    ]
}

/// The neighbour table of `wall`: the two triangles share their diagonal (edge c to a of the first, a to c of the second).
// (a, c, b) and (a, d, c) share a-c: edge a to c of the first, c to a of the second.
const WALL_NB: [u32; 6] = [1, NONE, NONE, NONE, NONE, 0];

fn run(
    occ: &mut Occlusion,
    view: &View,
    tris: &[f32],
    errors: &[f32],
    nb: &[u32],
    boxes: &[f32],
) -> (Stats, Vec<u8>) {
    let mut hidden = vec![0u8; boxes.len() / 6];
    let o = Occluders {
        triangles: tris,
        errors,
        neighbors: nb,
    };
    let st = occ
        .occlude(view, &o, boxes, &mut hidden)
        .expect("consistent lengths");
    (st, hidden)
}

fn core() -> Occlusion {
    Occlusion::new(256, 128, Config::default())
}

#[test]
fn a_wall_hides_what_is_behind_it_and_nothing_else() {
    let mut occ = core();
    let view = view_z([0.0, 0.0, 0.0]);
    let boxes = [
        aabb([0.0, 0.0, 20.0], [1.0, 1.0, 1.0]), // behind the wall, in the middle
        aabb([60.0, 0.0, 20.0], [1.0, 1.0, 1.0]), // behind, but past the wall's edge (and outside the frustum)
        aabb([0.0, 0.0, 5.0], [1.0, 1.0, 1.0]),   // in front of the wall
        aabb([9.0, 0.0, 20.0], [1.0, 1.0, 1.0]), // behind the wall's edge: x = 9 of 10 is hidden only if the box is inside it
    ]
    .concat();
    let (st, hidden) = run(
        &mut occ,
        &view,
        &wall(10.0, 10.0),
        &[0.0; 2],
        &WALL_NB,
        &boxes,
    );
    assert_eq!(hidden[0], 1, "behind the wall: hidden");
    assert_eq!(hidden[2], 0, "in front of the wall: visible");
    assert_eq!(hidden[1], 0, "outside the frustum: left alone");
    assert!(
        st.rasterised >= 2,
        "both triangles are drawn (more when clipped to the guard band)"
    );
    assert_eq!(st.culled, hidden.iter().map(|&h| h as u32).sum::<u32>());
}

#[test]
fn triangles_facing_away_are_not_drawn() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    let mut back = wall(10.0, 10.0);
    // swap vertices b and c of each triangle: the winding flips
    for t in 0..2 {
        for k in 0..3 {
            back.swap(t * 9 + 3 + k, t * 9 + 6 + k);
        }
    }
    let (st, hidden) = run(
        &mut occ,
        &view,
        &back,
        &[0.0; 2],
        &[NONE; 6],
        &aabb([0.0, 0.0, 20.0], [1.0; 3]),
    );
    assert_eq!((st.facing_away, st.rasterised), (2, 0));
    assert_eq!(hidden, vec![0]);
}

#[test]
fn the_depth_push_keeps_a_box_just_behind_a_stand_in_visible() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    // a box whose nearest face is 5 cm behind the wall at z = 10
    let b = aabb([0.0, 0.0, 10.55], [1.0, 1.0, 0.5]);
    let (_, exact) = run(&mut occ, &view, &wall(10.0, 10.0), &[0.0; 2], &WALL_NB, &b);
    assert_eq!(exact, vec![1], "no error: hidden");
    // the stand-in could be 20 cm in front of the real surface
    let (_, pushed) = run(&mut occ, &view, &wall(10.0, 10.0), &[0.2; 2], &WALL_NB, &b);
    assert_eq!(pushed, vec![0], "error 0.2: the box may be visible");
    // and one clearly behind it stays hidden
    let (_, far) = run(
        &mut occ,
        &view,
        &wall(10.0, 10.0),
        &[0.2; 2],
        &WALL_NB,
        &aabb([0.0, 0.0, 14.0], [1.0; 3]),
    );
    assert_eq!(far, vec![1]);
}

#[test]
fn the_near_rule_skips_triangles_within_near_plus_twice_the_error() {
    let mut occ = core();
    let view = view_z([0.0; 3]); // near 0.1
    let b = aabb([0.0, 0.0, 20.0], [1.0; 3]);
    // wall at z = 1: skipped when 0.1 + 2 E >= 1, i.e. E >= 0.45
    let (st, h) = run(&mut occ, &view, &wall(1.0, 10.0), &[0.44; 2], &WALL_NB, &b);
    assert_eq!(
        (st.near_skipped, h[0]),
        (0, 1),
        "E 0.44: drawn (distance 1 > 0.98)"
    );
    let (st, h) = run(&mut occ, &view, &wall(1.0, 10.0), &[0.46; 2], &WALL_NB, &b);
    assert_eq!(
        (st.near_skipped, h[0]),
        (2, 0),
        "E 0.46: skipped (distance 1 <= 1.02)"
    );
    // with no error the rule is the near plane's: a wall at 0.05 is skipped, one at 0.5 is not
    let (st, _) = run(&mut occ, &view, &wall(0.05, 10.0), &[0.0; 2], &WALL_NB, &b);
    assert_eq!(st.near_skipped, 2);
    let (st, _) = run(&mut occ, &view, &wall(0.5, 10.0), &[0.0; 2], &WALL_NB, &b);
    assert_eq!(st.near_skipped, 0);
}

#[test]
fn the_near_rule_is_per_triangle_not_per_occluder() {
    // a big floor under the camera: the triangle beneath the eye is skipped, the far one still occludes
    let mut occ = core();
    let eye = [0.0, 1.0, 0.0];
    let view = view_z(eye);
    // a floor y = 0 from z = -50..50, wound so its front faces up (+y): two huge triangles split at the diagonal
    let (a, b, c, d) = (
        [-50.0, 0.0, -50.0],
        [-50.0, 0.0, 50.0],
        [50.0, 0.0, 50.0],
        [50.0, 0.0, -50.0],
    );
    let floor = [a, c, b, a, d, c].concat();
    // front_normal(a, c, b) = (b - a) x (c - a) = (0,0,100) x (100,0,100) = (0, 10000, 0): up
    let (st, _) = run(
        &mut occ,
        &view,
        &floor,
        &[0.5; 2],
        &WALL_NB,
        &aabb([0.0, 0.5, 30.0], [1.0; 3]),
    );
    // both triangles are within 1 m of the floor plane near the eye: the eye is above them (distance 1) <= 0.1 + 1.0
    assert_eq!(
        st.near_skipped, 2,
        "the floor under the eye is inside the near rule's reach"
    );
    // a stand-in with a small error keeps the floor
    let (st, _) = run(
        &mut occ,
        &view,
        &floor,
        &[0.1; 2],
        &WALL_NB,
        &aabb([0.0, 0.5, 30.0], [1.0; 3]),
    );
    assert_eq!(st.near_skipped, 0);
}

/// A flat quad's two triangles joined along the diagonal, filling much of the screen.
fn pixels_unfilled(occ: &Occlusion, margin: usize) -> usize {
    let b = occ.buffer();
    let mut n = 0;
    for y in margin..b.h - margin {
        for x in margin..b.w - margin {
            if b.fine[y * b.w + x] == 0.0 {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn interior_edges_keep_their_coverage_and_silhouette_edges_shrink() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    let w = wall(10.0, 20.0); // covers the whole screen: no silhouette inside it
    run(&mut occ, &view, &w, &[0.0; 2], &WALL_NB, &[]);
    assert_eq!(
        pixels_unfilled(&occ, 0),
        0,
        "joined triangles leave no seam"
    );
    // the same triangles, each edge a boundary: the diagonal becomes a silhouette on both sides and leaves a gap
    run(&mut occ, &view, &w, &[0.0; 2], &[NONE; 6], &[]);
    assert!(
        pixels_unfilled(&occ, 0) > 100,
        "unjoined triangles leave a seam along the diagonal ({})",
        pixels_unfilled(&occ, 0)
    );
    // a neighbour that is not drawn (facing away) makes the shared edge a silhouette too
    let mut mixed = w.clone();
    for k in 0..3 {
        mixed.swap(9 + 3 + k, 9 + 6 + k); // second triangle flips: not drawn
    }
    let (st, _) = run(&mut occ, &view, &mixed, &[0.0; 2], &WALL_NB, &[]);
    assert_eq!(st.facing_away, 1);
}

/// Exact coverage of the same triangles through the lower layers (no shrink, no push).
fn exact_buffer(view: &View, tris: &[f32], w: usize, h: usize) -> DepthBuf {
    let mut buf = DepthBuf::new(w, h);
    let mut out: Vec<Tri> = vec![];
    for t in tris.chunks_exact(9) {
        let v = [
            xform(&view.cols, [t[0], t[1], t[2]]),
            xform(&view.cols, [t[3], t[4], t[5]]),
            xform(&view.cols, [t[6], t[7], t[8]]),
        ];
        out.clear();
        setup_poly(view, w, h, v, &EXACT, &mut out);
        for t in &out {
            raster_simd(&mut buf, t);
        }
    }
    buf
}

#[test]
fn the_shrink_only_ever_removes_coverage() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    // a small wall: all four sides are silhouettes
    let w = wall(10.0, 2.0);
    run(&mut occ, &view, &w, &[0.3; 2], &WALL_NB, &[]);
    let exact = exact_buffer(&view, &w, 256, 128);
    let (mut shrunk, mut full) = (0, 0);
    for (a, b) in occ.buffer().fine.iter().zip(exact.fine.iter()) {
        if *a > 0.0 {
            shrunk += 1;
            assert!(*b > 0.0, "a pixel the exact wall does not cover");
        }
        full += (*b > 0.0) as i32;
    }
    assert!(shrunk > 0 && shrunk < full, "{shrunk} of {full}");
}

#[test]
fn nan_and_degenerate_input_is_rejected() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    let good = wall(10.0, 10.0);
    // a NaN vertex, an infinite error, a negative error: three triangles refused, the valid wall still occludes
    let mut tris = good.clone();
    let mut bad = [
        good[0..9].to_vec(),
        good[0..9].to_vec(),
        good[0..9].to_vec(),
    ]
    .concat();
    bad[1] = f32::NAN;
    tris.extend_from_slice(&bad);
    let errors = [0.0, 0.0, 0.0, f32::INFINITY, -1.0];
    let nb = [WALL_NB.to_vec(), vec![NONE; 9]].concat();
    let boxes = [
        aabb([0.0, 0.0, 20.0], [1.0; 3]),
        [f32::NAN, 0.0, 20.0, 1.0, 1.0, 21.0],
        [3.0, 0.0, 20.0, 1.0, 1.0, 21.0],
    ]
    .concat();
    let (st, hidden) = run(&mut occ, &view, &tris, &errors, &nb, &boxes);
    assert_eq!(st.invalid, 3);
    let (clean, _) = run(&mut occ, &view, &good, &[0.0; 2], &WALL_NB, &[]);
    assert_eq!(
        st.rasterised, clean.rasterised,
        "only the valid wall is drawn"
    );
    assert_eq!(
        hidden,
        vec![1, 0, 0],
        "the NaN box and the inverted box stay visible"
    );
    assert!(occ.buffer().fine.iter().all(|d| d.is_finite()));
    // a zero-sized degenerate triangle draws nothing and breaks nothing
    let (st, _) = run(&mut occ, &view, &[0.0; 9], &[0.0], &[NONE; 3], &[]);
    assert_eq!(st.rasterised, 0);
    // infinities far out do not poison the buffer
    let (_, _) = run(
        &mut occ,
        &view,
        &[1e30, 1e30, 1e30, -1e30, 1e30, 1e30, 1e30, -1e30, 1e30],
        &[0.0],
        &[NONE; 3],
        &[],
    );
    assert!(occ.buffer().fine.iter().all(|d| d.is_finite()));
}

#[test]
fn views_with_nan_or_zero_scale_are_rejected() {
    let (m, sx, sy) = matrix([0.0; 3], [0.0, 0.0, 10.0], 0.1, 500.0);
    assert!(View::perspective(&m, [0.0; 3], 0.1, 500.0, sx, sy).is_ok());
    let mut nan = m;
    nan[5] = f32::NAN;
    assert_eq!(
        View::perspective(&nan, [0.0; 3], 0.1, 500.0, sx, sy).unwrap_err(),
        Reject::NotFinite
    );
    assert_eq!(
        View::perspective(&m, [f32::INFINITY, 0.0, 0.0], 0.1, 500.0, sx, sy).unwrap_err(),
        Reject::NotFinite
    );
    // a zero scale along y: the y row of the matrix collapses
    let mut flat = m;
    for j in 0..4 {
        flat[j * 4 + 1] = 0.0;
    }
    assert_eq!(
        View::perspective(&flat, [0.0; 3], 0.1, 500.0, sx, sy).unwrap_err(),
        Reject::Singular
    );
    assert_eq!(
        View::perspective(&[0.0; 16], [0.0; 3], 0.1, 500.0, sx, sy).unwrap_err(),
        Reject::Singular
    );
    // the rows can be fine and w constant (no depth): refused too
    let mut no_w = m;
    for j in 0..3 {
        no_w[j * 4 + 3] = 0.0;
    }
    assert_eq!(
        View::perspective(&no_w, [0.0; 3], 0.1, 500.0, sx, sy).unwrap_err(),
        Reject::Singular
    );
    assert_eq!(
        View::perspective(&m, [0.0; 3], 0.0, 500.0, sx, sy).unwrap_err(),
        Reject::BadRange
    );
    assert_eq!(
        View::perspective(&m, [0.0; 3], 1.0, 0.5, sx, sy).unwrap_err(),
        Reject::BadRange
    );
    assert_eq!(
        View::perspective(&m, [0.0; 3], 0.1, 500.0, 0.0, sy).unwrap_err(),
        Reject::BadRange
    );
    // a far-away eye does not make a regular view look singular
    let (m, sx, sy) = matrix([1.0e4, 2.0e3, -5.0e4], [1.0e4, 2.0e3, 0.0], 0.1, 500.0);
    assert!(View::perspective(&m, [1.0e4, 2.0e3, -5.0e4], 0.1, 500.0, sx, sy).is_ok());
}

#[test]
fn mismatched_lengths_are_refused() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    let w = wall(10.0, 10.0);
    let o = Occluders {
        triangles: &w,
        errors: &[0.0],
        neighbors: &WALL_NB,
    };
    assert_eq!(
        occ.occlude(&view, &o, &[], &mut []).unwrap_err(),
        FrameError::Lengths
    );
    let o = Occluders {
        triangles: &w,
        errors: &[0.0; 2],
        neighbors: &WALL_NB,
    };
    assert_eq!(
        occ.occlude(&view, &o, &aabb([0.0; 3], [1.0; 3]), &mut [])
            .unwrap_err(),
        FrameError::Lengths
    );
}

#[test]
fn boxes_crossing_the_near_plane_stay_visible() {
    let mut occ = core();
    let view = view_z([0.0; 3]);
    let boxes = aabb([0.0, 0.0, 0.0], [1.0; 3]); // the eye is inside the box
    let (st, h) = run(
        &mut occ,
        &view,
        &wall(10.0, 10.0),
        &[0.0; 2],
        &WALL_NB,
        &boxes,
    );
    assert_eq!((st.near_visible, h[0]), (1, 0));
}

/// Deterministic random triangle soup in front of a camera, with random neighbours and errors.
fn soup(seed: u64, n: usize) -> (Vec<f32>, Vec<f32>, Vec<u32>, Vec<f32>) {
    let mut s = seed;
    let mut f = move || {
        s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    };
    let mut tris = vec![];
    let mut errors = vec![];
    let mut nb = vec![];
    for i in 0..n {
        let c = [f() * 80.0 - 40.0, f() * 30.0 - 10.0, f() * 60.0 + 2.0];
        let size = 0.5 + f() * 12.0;
        for _ in 0..3 {
            tris.extend_from_slice(&[
                c[0] + (f() - 0.5) * size,
                c[1] + (f() - 0.5) * size,
                c[2] + (f() - 0.5) * size,
            ]);
        }
        errors.push(if f() < 0.5 { 0.0 } else { f() * 0.4 });
        for _ in 0..3 {
            nb.push(if f() < 0.4 {
                NONE
            } else {
                (i as u32 + 1 + (f() * 7.0) as u32) % n as u32
            });
        }
    }
    let mut boxes = vec![];
    for _ in 0..600 {
        let c = [f() * 100.0 - 50.0, f() * 30.0 - 10.0, f() * 90.0 + 1.0];
        boxes.extend_from_slice(&aabb(
            c,
            [0.2 + f() * 2.0, 0.2 + f() * 2.0, 0.2 + f() * 2.0],
        ));
    }
    (tris, errors, nb, boxes)
}

#[test]
fn the_simd_path_is_bit_identical_to_the_scalar_reference() {
    for (w, h) in [(256, 128), (320, 180)] {
        let mut fast = Occlusion::new(w, h, Config { simd: true });
        let mut slow = Occlusion::new(w, h, Config { simd: false });
        for seed in 0..6u64 {
            let (tris, errors, nb, boxes) = soup(seed, 900);
            let eye = [seed as f32 * 3.0 - 6.0, 2.0, -3.0];
            let (m, sx, sy) = matrix(
                eye,
                [eye[0] + (seed as f32 - 3.0) * 5.0, 3.0, 40.0],
                0.1,
                300.0,
            );
            let view = View::perspective(&m, eye, 0.1, 300.0, sx, sy).unwrap();
            let (sf, hf) = run(&mut fast, &view, &tris, &errors, &nb, &boxes);
            let (ss, hs) = run(&mut slow, &view, &tris, &errors, &nb, &boxes);
            assert!(sf.rasterised > 50, "the soup draws something ({sf:?})");
            assert_eq!(sf, ss, "stats at {w}x{h} seed {seed}");
            assert_eq!(hf, hs, "hidden at {w}x{h} seed {seed}");
            let (a, b) = (fast.buffer(), slow.buffer());
            assert!(
                a.fine
                    .iter()
                    .zip(b.fine.iter())
                    .all(|(x, y)| x.to_bits() == y.to_bits()),
                "depth at {w}x{h} seed {seed}"
            );
            assert!(
                a.coarse
                    .iter()
                    .zip(b.coarse.iter())
                    .all(|(x, y)| x.to_bits() == y.to_bits()),
                "coarse level at {w}x{h} seed {seed}"
            );
        }
    }
}

#[test]
fn rasterisers_agree_on_single_triangles() {
    // the two rasterisers on exact setup triangles, including ones clipped by the near plane and the guard band
    let view = view_z([0.0; 3]);
    let mut a = DepthBuf::new(256, 128);
    let mut b = DepthBuf::new(256, 128);
    let mut out: Vec<Tri> = vec![];
    for t in soup(99, 400).0.chunks_exact(9) {
        let v = [
            xform(&view.cols, [t[0], t[1], t[2]]),
            xform(&view.cols, [t[3], t[4], t[5]]),
            xform(&view.cols, [t[6], t[7], t[8]]),
        ];
        out.clear();
        setup_poly(&view, 256, 128, v, &EXACT, &mut out);
        for t in &out {
            raster_simd(&mut a, t);
            raster_scalar(&mut b, t);
        }
    }
    assert!(a.fine.iter().any(|d| *d > 0.0));
    assert!(a
        .fine
        .iter()
        .zip(b.fine.iter())
        .all(|(x, y)| x.to_bits() == y.to_bits()));
}

#[test]
fn the_coarse_level_is_the_tile_minimum_including_a_partial_last_row() {
    let mut occ = Occlusion::new(320, 180, Config::default());
    let view = view_z([0.0; 3]);
    let (tris, errors, nb, _) = soup(5, 500);
    run(&mut occ, &view, &tris, &errors, &nb, &[]);
    let b = occ.buffer();
    for ty in 0..b.th {
        for tx in 0..b.tw {
            let mut m = f32::MAX;
            for y in ty * 8..(ty * 8 + 8).min(b.h) {
                for x in tx * 8..tx * 8 + 8 {
                    m = m.min(b.fine[y * b.w + x]);
                }
            }
            assert_eq!(
                b.coarse[ty * b.tw + tx].to_bits(),
                m.to_bits(),
                "tile {tx},{ty}"
            );
        }
    }
}
