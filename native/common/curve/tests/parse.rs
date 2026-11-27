//! The key parser (feature `alloc`): keys read and baked as the evaluator wants them, and what it
//! refuses. Run with `cargo test --features alloc`.

use myco_curve::{eval, parse_keys, CurveError, KEY_FLOATS, MAX_KEYS};

#[test]
fn keys_are_baked_and_evaluate() {
    // Linear 0 -> 2 over [0, 1], then a step held at 2 to x = 2.
    let keys = [
        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, //
        1.0, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0, //
        2.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];
    let baked = parse_keys(&keys).unwrap();
    assert_eq!(baked.len(), 3);
    assert_eq!(eval(baked.as_slice(), 0.5), 1.0);
    assert_eq!(eval(baked.as_slice(), 1.5), 2.0);
    assert_eq!(eval(baked.as_slice(), 3.0), 5.0);
}

#[test]
fn an_unknown_interp_code_reads_as_linear() {
    let keys = [
        0.0, 0.0, 9.5, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];
    let baked = parse_keys(&keys).unwrap();
    assert_eq!(eval(baked.as_slice(), 0.25), 0.25);
}

#[test]
fn malformed_and_oversized_keys_are_refused() {
    assert_eq!(
        parse_keys(&[0.0; KEY_FLOATS - 1]),
        Err(CurveError::Malformed)
    );
    let nan = [f32::NAN, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    assert_eq!(parse_keys(&nan), Err(CurveError::Malformed));
    let unordered = [
        1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];
    assert_eq!(parse_keys(&unordered), Err(CurveError::Malformed));
    let too_many = vec![0.0f32; (MAX_KEYS + 1) * KEY_FLOATS];
    assert_eq!(parse_keys(&too_many), Err(CurveError::TooLarge));
    assert!(parse_keys(&[]).unwrap().is_empty());
}
