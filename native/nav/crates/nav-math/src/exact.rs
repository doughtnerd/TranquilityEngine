//! Foxfire's `NavExactMath`: the few non-elementary functions the bake needs, computed in `f64`
//! from only `+ - * /` and `sqrt`, and rounded to `f32` once at the end.
//!
//! Those operations are exactly rounded (IEEE 754), and WebAssembly and Rust never fuse or
//! reassociate them, so every target gets the same bits. Each expression below mirrors the C#'s
//! operation order exactly (no `mul_add`, no libm trig). Do not "tidy" them.
use crate::math::{clamp, floor_d};
use crate::vec::{Double3, Float3};

const PI: f64 = 3.14159265358979323846;
const HALF_PI: f64 = 1.57079632679489661923;
const TWO_PI: f64 = 6.28318530717958647692;

/// Degrees to radians: `(float)(degrees * (pi / 180))`.
#[inline]
pub fn radians(degrees: f32) -> f32 {
    (degrees as f64 * (PI / 180.0)) as f32
}

/// Radians to degrees: `(float)(radians * (180 / pi))`.
#[inline]
pub fn degrees(radians: f32) -> f32 {
    (radians as f64 * (180.0 / PI)) as f32
}

#[inline]
pub fn cos(x: f32) -> f32 {
    cos_d(x as f64) as f32
}

/// `sin x` as `cos(x - pi/2)` (the C# does the same, so the two agree exactly).
#[inline]
pub fn sin(x: f32) -> f32 {
    cos_d(x as f64 - HALF_PI) as f32
}

/// `acos x` for x in [-1, 1] (clamped).
#[inline]
pub fn acos(x: f32) -> f32 {
    acos_d(x as f64) as f32
}

/// cos x: reduced to [0, pi/2] by symmetry, then a Taylor series to x^18 (error under 1e-12).
pub fn cos_d(mut x: f64) -> f64 {
    x -= TWO_PI * floor_d(x / TWO_PI); // [0, 2pi)
    if x > PI {
        x = TWO_PI - x; // cos is even about pi: [0, pi]
    }
    let mut sign = 1.0;
    if x > HALF_PI {
        x = PI - x; // cos(pi - x) = -cos x: [0, pi/2]
        sign = -1.0;
    }

    let x2 = x * x;
    let mut c = 1.0 / 6402373705728000.0; // 1/18!
    c = c * x2 - 1.0 / 20922789888000.0;
    c = c * x2 + 1.0 / 87178291200.0;
    c = c * x2 - 1.0 / 479001600.0;
    c = c * x2 + 1.0 / 3628800.0;
    c = c * x2 - 1.0 / 40320.0;
    c = c * x2 + 1.0 / 720.0;
    c = c * x2 - 1.0 / 24.0;
    c = c * x2 + 0.5;
    sign * (1.0 - c * x2)
}

/// acos x for x in [-1, 1] (clamped): pi/2 - asin x, with asin from its series near 0 and from
/// `asin x = pi/2 - 2 asin(sqrt((1 - x) / 2))` near 1, so the series always runs on |t| at most 0.5
/// (error under 1e-12).
pub fn acos_d(x: f64) -> f64 {
    let x = clamp(x, -1.0, 1.0);
    let a = x.abs();
    let mut asin;
    if a <= 0.5 {
        asin = asin_series(a);
    } else {
        let t = ((1.0 - a) * 0.5).sqrt();
        asin = HALF_PI - 2.0 * asin_series(t);
    }
    if x < 0.0 {
        asin = -asin;
    }
    HALF_PI - asin
}

/// asin t for |t| at most 0.5: its Maclaurin series, enough terms for double precision there.
fn asin_series(t: f64) -> f64 {
    // asin t = sum (2n)! / (4^n (n!)^2 (2n + 1)) t^(2n+1); each term from the last by a rational
    // factor. C# precedence: ((t2 * (2n-1)) * (2n-1)) / ((2.0 * n) * (2n+1)).
    let t2 = t * t;
    let mut term = t;
    let mut sum = t;
    for n in 1..24i32 {
        let a = (2 * n - 1) as f64;
        let nn = n as f64;
        term *= t2 * a * a / ((2.0 * nn) * (2 * n + 1) as f64);
        sum += term;
    }
    sum
}

/// `v / |v|` in doubles, rounded once (`math.normalize` uses rsqrt, which needn't round the same).
#[inline]
pub fn normalize(v: Float3) -> Float3 {
    let d: Double3 = v.to_double();
    let len = d.dot(d).sqrt();
    Double3::new(d.x / len, d.y / len, d.z / len).to_float()
}

/// Smallest normal `f32` (`1.175494351e-38`), the threshold `math.normalizesafe` uses.
const FLT_MIN_NORMAL: f64 = 1.175494351e-38;

/// Normalize, or `fallback` when v is (nearly) zero, like `math.normalizesafe`.
#[inline]
pub fn normalize_safe(v: Float3, fallback: Float3) -> Float3 {
    let d = v.to_double();
    let length_sq = d.dot(d);
    if length_sq > FLT_MIN_NORMAL {
        let len = length_sq.sqrt();
        Double3::new(d.x / len, d.y / len, d.z / len).to_float()
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts as c32;

    #[test]
    fn known_values() {
        assert_eq!(cos(0.0), 1.0);
        assert!(sin(0.0).abs() < 1e-12);
        assert!((cos(c32::PI) + 1.0).abs() < 1e-7);
        assert!((sin(c32::FRAC_PI_2) - 1.0).abs() < 1e-7);
        assert!((sin(c32::FRAC_PI_6) - 0.5).abs() < 1e-7);
        assert!((cos(c32::FRAC_PI_3) - 0.5).abs() < 1e-7);
        assert_eq!(acos(1.0), 0.0);
        assert!((acos(-1.0) - c32::PI).abs() < 1e-7);
        assert!((acos(0.0) - c32::FRAC_PI_2).abs() < 1e-7);
        assert!((acos(0.5) - c32::FRAC_PI_3).abs() < 1e-7);
        assert!((radians(180.0) - c32::PI).abs() < 1e-7);
        assert_eq!(degrees(radians(90.0)), 90.0);
        assert_eq!(radians(0.0), 0.0);
    }

    #[test]
    fn matches_std_closely_and_pythagoras() {
        for i in -4000..=4000 {
            let x = i as f32 * 0.0137;
            let (s, c) = (sin(x) as f64, cos(x) as f64);
            assert!((s - (x as f64).sin()).abs() < 2e-7, "sin {x}");
            assert!((c - (x as f64).cos()).abs() < 2e-7, "cos {x}");
            assert!((s * s + c * c - 1.0).abs() < 2e-7);
        }
    }

    #[test]
    fn symmetries_are_exact() {
        for i in 0..200 {
            let x = i as f32 * 0.031;
            assert_eq!(cos(x), cos(-x));
        }
        // acos(-a) = pi - acos(a) to double precision.
        for i in 0..=200 {
            let a = i as f64 * 0.005;
            let s = acos_d(a) + acos_d(-a);
            assert!((s - PI).abs() < 1e-12, "a={a}");
        }
    }

    #[test]
    fn acos_range_clamp_and_monotonic() {
        assert_eq!(acos(2.0), acos(1.0));
        assert_eq!(acos(-3.0), acos(-1.0));
        let mut prev = f32::MAX;
        for i in -100..=100 {
            let v = acos(i as f32 / 100.0);
            assert!((0.0..=c32::PI + 1e-6).contains(&v));
            assert!(v <= prev);
            prev = v;
        }
        for i in -100..=100 {
            let x = i as f64 / 100.0;
            assert!((acos_d(x) - x.acos()).abs() < 1e-12);
        }
    }

    #[test]
    fn deterministic_bits() {
        for i in 0..500 {
            let x = i as f32 * 0.173 - 40.0;
            assert_eq!(cos(x).to_bits(), cos(x).to_bits());
            assert_eq!(sin(x).to_bits(), (cos_d(x as f64 - HALF_PI) as f32).to_bits());
        }
        // Golden bits guard against accidental reordering of the series.
        assert_eq!(cos(1.0).to_bits(), 0x3f0a5140);
        assert_eq!(sin(1.0).to_bits(), 0x3f576aa4);
        assert_eq!(acos(0.3).to_bits(), 0x3fa20faf);
    }


    #[test]
    fn normalize_behaviour() {
        let n = normalize(Float3::new(3.0, 0.0, 4.0));
        assert_eq!(n, Float3::new(0.6, 0.0, 0.8));
        let n = normalize(Float3::new(1.0, 2.0, 2.0));
        assert!((n.length() - 1.0).abs() < 1e-7);
        let fb = Float3::new(0.0, 1.0, 0.0);
        assert_eq!(normalize_safe(Float3::splat(0.0), fb), fb);
        assert_eq!(normalize_safe(Float3::splat(1e-25), fb), fb);
        assert_eq!(normalize_safe(Float3::new(0.0, 5.0, 0.0), fb), fb);
        assert_eq!(normalize_safe(Float3::new(0.0, 0.0, 2.0), fb), Float3::new(0.0, 0.0, 1.0));
    }
}
