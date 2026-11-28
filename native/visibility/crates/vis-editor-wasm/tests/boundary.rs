//! The editor module's boundary on its success paths (the error paths build a `JsError`, which only exists in a browser).
use vis_editor_wasm::{neighbors_of, trim_standin};

/// A unit square in the XY plane as two triangles.
const SQUARE: [f32; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
const TRIS: [u32; 6] = [0, 1, 2, 0, 2, 3];

#[test]
fn an_exact_standin_comes_back_whole_with_its_neighbours() {
    let r = trim_standin(&SQUARE, &TRIS, &SQUARE, &TRIS, 0.005, 0.005)
        .ok()
        .expect("a usable mesh");
    assert_eq!(r.kept(), vec![0, 1]);
    assert_eq!(r.indices(), TRIS.to_vec());
    assert_eq!(
        r.neighbors(),
        vec![u32::MAX, u32::MAX, 1, 0, u32::MAX, u32::MAX]
    );
    assert_eq!(r.dropped(), 0);
    assert!(r.errors().iter().all(|e| *e < 1e-5));
    assert!((r.diagonal() - 2f32.sqrt()).abs() < 1e-5);
}

#[test]
fn a_standin_that_closes_a_hole_loses_those_triangles() {
    // the original: a frame with a 2 x 2 hole in a 4 x 4 square; the stand-in: the full square
    let orig_p = [
        0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0, 1.0, 1.0, 0.0, 3.0, 1.0, 0.0,
        3.0, 3.0, 0.0, 1.0, 3.0, 0.0,
    ];
    let orig_i = [
        0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ];
    let full_p = [0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0];
    let r = trim_standin(&orig_p, &orig_i, &full_p, &TRIS, 0.005, 0.005)
        .ok()
        .expect("a usable mesh");
    assert_eq!(r.dropped(), 2);
    assert!(r.kept().is_empty());
}

#[test]
fn neighbours_of_a_self_occluding_mesh() {
    assert_eq!(
        neighbors_of(&SQUARE, &TRIS).ok().unwrap(),
        vec![u32::MAX, u32::MAX, 1, 0, u32::MAX, u32::MAX]
    );
}
