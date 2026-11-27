//! Deterministic polynomial trigonometry over [`Lane`]: no libm, so every target gives the same
//! bits. Used by slerp and axis-angle conversion. They are cheap enough for any path, but the hot
//! pose pipeline doesn't need them (it blends with nlerp).
//!
//! The polynomials are Cephes' single-precision minimax fits (`sinf`, `cosf`, `atanf`), evaluated
//! with plain multiplies and adds in a fixed order (Horner, no fused multiply-add).
//!
//! Accuracy against f64 libm (tested in `tests/vs_offline.rs`):
//! - [`sin_cos`]: absolute error ≤ 3e-7 for |x| ≤ 100; still deterministic but less accurate
//!   beyond |x| ≈ 8192, where range reduction loses bits.
//! - [`atan2`]: absolute error ≤ 3e-7 (radians) for all finite inputs.

// The constants are Cephes' published decimal values, kept verbatim so they can be checked
// against the source; the compiler rounds them to the nearest f32.
#![allow(clippy::excessive_precision)]

use crate::lane::Lane;

/// π/2 split in three parts for Cody-Waite range reduction (Cephes `DP1..DP3` doubled). The first
/// two have short mantissas so `k * DP1` and `k * DP2` are exact for |k| < 2^15.
const DP1: f32 = 1.570_312_5;
const DP2: f32 = 4.837_512_969_970_703e-4;
const DP3: f32 = 7.549_789_954_891_882e-8;
const TWO_OVER_PI: f32 = core::f32::consts::FRAC_2_PI;

/// `(sin x, cos x)`, lane by lane. Deterministic; see the module docs for accuracy.
#[inline]
pub fn sin_cos<L: Lane>(x: L) -> (L, L) {
    let k = (x * L::splat(TWO_OVER_PI)).round_even();
    let r = ((x - k * L::splat(DP1)) - k * L::splat(DP2)) - k * L::splat(DP3);
    let z = r * r;
    let s = r + r
        * z
        * (L::splat(-1.666_665_461_1e-1)
            + z * (L::splat(8.332_160_873_6e-3) + z * L::splat(-1.951_529_589_1e-4)));
    let c = (L::splat(1.0) - L::splat(0.5) * z)
        + z * z
            * (L::splat(4.166_664_568_298_827e-2)
                + z * (L::splat(-1.388_731_625_493_765e-3)
                    + z * L::splat(2.443_315_711_809_948e-5)));
    // Quadrant q = k mod 4 in 0..=3, computed in floats (k is an exact integer).
    let q = k - L::splat(4.0) * (k * L::splat(0.25)).floor();
    let one = L::splat(1.0);
    let two = L::splat(2.0);
    let three = L::splat(3.0);
    let swap = q.eq(one) | q.eq(three);
    let sin = L::select(swap, c, s);
    let cos = L::select(swap, s, c);
    let sin = L::select(q.ge(two), -sin, sin);
    let cos = L::select(q.eq(one) | q.eq(two), -cos, cos);
    (sin, cos)
}

/// atan(r) for r in [0, 1].
#[inline]
fn atan_unit<L: Lane>(r: L) -> L {
    // Above tan(π/8), atan(r) = π/4 + atan((r - 1) / (r + 1)).
    let big = r.gt(L::splat(0.414_213_562_373_095_1));
    let one = L::splat(1.0);
    let x = L::select(big, (r - one) / (r + one), r);
    let base = L::select(big, L::splat(core::f32::consts::FRAC_PI_4), L::splat(0.0));
    let z = x * x;
    let p = (((L::splat(8.053_744_495_38e-2) * z - L::splat(1.387_768_560_32e-1)) * z
        + L::splat(1.997_771_064_78e-1))
        * z
        - L::splat(3.333_294_915_39e-1))
        * z
        * x
        + x;
    base + p
}

/// `atan2(y, x)` in [-π, π], lane by lane. `atan2(0, 0)` is 0. A negative zero `y` counts as
/// positive (the result is never -0 or -π). Deterministic; see the module docs for accuracy.
#[inline]
pub fn atan2<L: Lane>(y: L, x: L) -> L {
    let ay = y.abs();
    let ax = x.abs();
    let zero = L::splat(0.0);
    // atan2(|y|, |x|) in [0, π/2] through a ratio in [0, 1]; max() keeps 0/0 out of every lane.
    let steep = ay.gt(ax);
    let tiny = L::splat(f32::MIN_POSITIVE);
    let num = L::select(steep, ax, ay);
    let den = L::select(steep, ay, ax).max(tiny);
    let a = atan_unit(num / den);
    let a = L::select(steep, L::splat(core::f32::consts::FRAC_PI_2) - a, a);
    let a = L::select(x.lt(zero), L::splat(core::f32::consts::PI) - a, a);
    L::select(y.lt(zero), -a, a)
}

/// `2^x` for `x` in about `[−100, 100]` (clamped to f32's normal range). Deterministic: `2^round(x)`
/// (exact, built from the exponent bits) times the degree-7 Taylor series of `e^(r·ln 2)` for the
/// remainder `r` in `[−½, ½]` (truncation error under 6e-9 relative). Used by the Penner easings
/// (`myco-tween`, moved out of this crate's former `ease` module, ADR 0424 spike) and `anim-match`'s
/// springs.
pub fn exp2(x: f32) -> f32 {
    let n = x.round_even().clamp(-126.0, 127.0);
    let y = (x - n) * core::f32::consts::LN_2;
    // Horner over 1/k!, k = 7..0.
    let p = 1.0
        + y * (1.0
            + y * (0.5
                + y * (1.0 / 6.0
                    + y * (1.0 / 24.0
                        + y * (1.0 / 120.0 + y * (1.0 / 720.0 + y * (1.0 / 5040.0)))))));
    p * f32::from_bits(((n as i32 + 127) as u32) << 23)
}
