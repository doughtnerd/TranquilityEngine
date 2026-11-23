//! The parity test (ADR 0370): this crate against `src/engine/core/curve.ts`, over
//! `tests/parity.txt`, which `src/engine/tests/curveParity.test.ts` writes from `evalCurve` (and
//! fails on when the two drift apart).
//!
//! - **f64:** exactly `evalCurve`'s numbers (the same operations in the same order; the file's
//!   decimals round-trip exactly).
//! - **f32** (what both cores run): shape segments within [`F32_TOLERANCE`] of `evalCurve`,
//!   relative to the curve's scale (its largest |y|, at least 1). Bézier segments are held to the
//!   same tolerance as a *backward* error: the f32 value is `evalCurve`'s at some input within
//!   [`F32_BEZIER_INPUT`] (relative) of `x`. The bisection compares x(t) in f32, so where x(t) is
//!   flat (control x clamped to a segment's end; `bezier_clamped_overshoot` at 0.5) the parameter
//!   it finds is only as good as an f32 x can say, and the forward error there reaches 2.5e-3
//!   of the scale (printed). Every key's own value outside Bézier segments, the ends, NaN and ±∞
//!   are exact.
//!
//! The f32 form is also checked to give the same bits in both layouts ([`Curve`] and baked keys).

use myco_curve::{bake, eval, Curve, Key, Keys, SourceKey, CURVE_KEYS, INTERP_BEZIER};

/// f32 against f64: relative to the curve's largest |y| (at least 1).
const F32_TOLERANCE: f64 = 1e-6;
/// Bézier segments: the input neighbourhood, relative to the larger of |x| and the segment's span,
/// in which `evalCurve` must reach the f32 value (within [`F32_TOLERANCE`]): four f32 ulps.
const F32_BEZIER_INPUT: f64 = 4.0 * f32::EPSILON as f64;

struct Case {
    name: String,
    keys: Vec<SourceKey<f64>>,
    at: Vec<(f64, f64)>,
}

fn num(s: &str) -> f64 {
    match s {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => s
            .parse()
            .unwrap_or_else(|_| panic!("parity.txt: bad number {s:?}")),
    }
}

fn cases() -> Vec<Case> {
    let text = include_str!("parity.txt");
    let mut out: Vec<Case> = Vec::new();
    for line in text.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.first() {
            Some(&"curve") => out.push(Case {
                name: words[1].to_string(),
                keys: Vec::new(),
                at: Vec::new(),
            }),
            Some(&"key") => {
                let v: Vec<f64> = words[1..].iter().map(|w| num(w)).collect();
                let case = out.last_mut().expect("a key line after a curve line");
                case.keys
                    .push((v[0], v[1], v[2] as u8, [v[3], v[4], v[5], v[6]]));
            }
            Some(&"at") => {
                let case = out.last_mut().expect("an at line after a curve line");
                case.at.push((num(words[1]), num(words[2])));
            }
            _ => {}
        }
    }
    out
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()) || (a == 0.0 && b == 0.0)
}

/// The Bézier segment of `keys` that `x` falls in (from its first key, before its last): its span.
fn bezier_span(keys: &[SourceKey<f64>], x: f64) -> Option<f64> {
    keys.windows(2)
        .find(|w| w[0].2 == INTERP_BEZIER && x >= w[0].0 && x < w[1].0)
        .map(|w| w[1].0 - w[0].0)
}

/// The lowest and highest `evalCurve` value over `[x − d, x + d]` (sampled densely; the segment is
/// smooth, so the samples bracket it to far below the tolerance).
fn range_near(keys: &[Key<f64>], x: f64, d: f64) -> (f64, f64) {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..=256 {
        let y = eval(keys, x - d + 2.0 * d * i as f64 / 256.0);
        lo = lo.min(y);
        hi = hi.max(y);
    }
    (lo, hi)
}

#[test]
fn the_fixture_covers_every_key_form() {
    let cases = cases();
    assert!(cases.len() >= 50, "{} curves", cases.len());
    for interp in 0..=5u8 {
        assert!(
            cases.iter().any(|c| c.keys.iter().any(|k| k.2 == interp)),
            "no key of interp {interp}"
        );
    }
    assert!(cases.iter().any(|c| c.keys.is_empty()));
    assert!(
        cases
            .iter()
            .any(|c| c.keys.windows(2).any(|w| w[0].0 == w[1].0)),
        "no jump"
    );
}

#[test]
fn f64_matches_curve_ts_exactly() {
    let mut checked = 0;
    for case in cases() {
        let mut keys = vec![Key::default(); case.keys.len()];
        bake(&case.keys, &mut keys);
        for &(x, want) in &case.at {
            let got = eval(&keys[..], x);
            assert!(
                same(got, want),
                "{}: at {x}: {got} (curve.ts {want})",
                case.name
            );
            checked += 1;
        }
    }
    assert!(checked > 6000, "{checked}");
}

#[test]
fn f32_matches_curve_ts_within_tolerance() {
    let (mut worst_shape, mut worst_forward, mut worst_backward) = (0.0f64, 0.0f64, 0.0f64);
    for case in cases() {
        let keys32: Vec<SourceKey<f32>> = case
            .keys
            .iter()
            .map(|k| (k.0 as f32, k.1 as f32, k.2, k.3.map(|h| h as f32)))
            .collect();
        // The inputs are f32 values: nothing is lost converting the keys.
        for (a, b) in keys32.iter().zip(&case.keys) {
            let handles = a.3.iter().zip(b.3).all(|(h, g)| *h as f64 == g);
            assert!(
                a.0 as f64 == b.0 && a.1 as f64 == b.1 && handles,
                "{}: a key isn't f32",
                case.name
            );
        }
        let mut baked = vec![Key::default(); keys32.len()];
        bake(&keys32, &mut baked);
        let mut baked64 = vec![Key::default(); case.keys.len()];
        bake(&case.keys, &mut baked64);
        let table = (keys32.len() <= CURVE_KEYS).then(|| Curve::from_keys(&keys32));
        let scale = case.keys.iter().fold(1.0f64, |m, k| m.max(k.1.abs()));
        for &(x, want) in &case.at {
            assert!(
                x.is_nan() || x as f32 as f64 == x,
                "{}: input {x} isn't f32",
                case.name
            );
            let got = eval(&baked[..], x as f32);
            if let Some(c) = &table {
                assert_eq!(
                    eval(c, x as f32).to_bits(),
                    got.to_bits(),
                    "{}: the layouts differ at {x}",
                    case.name
                );
            }
            let err = (got as f64 - want).abs() / scale;
            match bezier_span(&case.keys, x) {
                Some(span) => {
                    worst_forward = worst_forward.max(err);
                    let d = F32_BEZIER_INPUT * x.abs().max(span);
                    let (lo, hi) = range_near(&baked64, x, d);
                    let g = got as f64;
                    let miss = if g < lo {
                        lo - g
                    } else if g > hi {
                        g - hi
                    } else {
                        0.0
                    } / scale;
                    worst_backward = worst_backward.max(miss);
                    assert!(
                        miss <= F32_TOLERANCE,
                        "{}: at {x}: {got}, curve.ts {lo}..{hi} within {d:e}",
                        case.name
                    );
                }
                None => {
                    worst_shape = worst_shape.max(err);
                    assert!(
                        err <= F32_TOLERANCE,
                        "{}: at {x}: {got} (curve.ts {want}), error {err:e}",
                        case.name
                    );
                    let on_key = x.is_nan()
                        || x.is_infinite()
                        || case.keys.iter().any(|k| k.0 == x)
                        || baked.count() == 0;
                    if on_key {
                        assert!(
                            same(got as f64, want as f32 as f64),
                            "{}: at {x}: {got} (curve.ts {want})",
                            case.name
                        );
                    }
                }
            }
        }
    }
    println!(
        "worst f32 error relative to scale: shapes {worst_shape:e}; Bézier forward {worst_forward:e}, backward {worst_backward:e}"
    );
}
