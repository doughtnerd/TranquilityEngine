//! `myco-curve`: the engine curve (`src/engine/core/curve.ts`, ADR 0158 §3 and audio ADR 0346) in
//! Rust, one evaluator for the audio core and the animation core (ADR 0370 "Crates").
//!
//! # The curve
//!
//! Keys sorted by x, each with a value y and the shape of the segment to the next key (its
//! *interp*, the codes of `curve.ts`'s `CURVE_KEY_INTERPS`): [`INTERP_LINEAR`] (0), [`INTERP_STEP`]
//! (1: hold until the next key), [`INTERP_SMOOTH`] (2: `u²(3 − 2u)`), [`INTERP_EASE_IN`] (3: `u²`),
//! [`INTERP_EASE_OUT`] (4: `1 − (1 − u)²`) and [`INTERP_BEZIER`] (5). Any other code is linear, as
//! `curve.ts`'s default.
//!
//! - An empty curve is 0. Before the first key (and at NaN) the value is the first key's y; at and
//!   after the last key, the last key's y. Keys with the same x jump (the later key wins at its x).
//! - A Bézier segment is the cubic from the key through its out handle and the next key's in
//!   handle (a flat handle a third of the segment long when the next key isn't Bézier) to the next
//!   key. Handles are offsets `[dx, dy]` from their key. Each control point's x is clamped into the
//!   segment, so x(t) never decreases and the curve stays a function of x; the parameter at `x` is
//!   found by [`BEZIER_STEPS`] halvings ([`bezier_controls`], [`bezier_segment`]).
//!
//! The arithmetic is `curve.ts`'s term for term (no fused multiply-add, no reassociation), so the
//! f64 form gives `curve.ts`'s numbers exactly, and the f32 form the same bits on every target.
//! `tests/parity.rs` checks both against `tests/parity.txt`, written from `curve.ts`.
//!
//! # Two layouts, one evaluator
//!
//! [`eval`] reads keys through [`Keys`], with the Bézier control points worked out once, when the
//! keys are set:
//!
//! - [`Curve`]: a fixed table of [`CURVE_KEYS`] keys as parallel f32 arrays, `repr(C)`, all-zero
//!   empty. The audio core keeps 1,024 of them in its automation region (`audio-core`'s
//!   `automation.rs`, CURVES).
//! - `[Key<R>]`: a slice of baked keys ([`bake`]) of any length, f32 or f64. The animation core
//!   keeps curve assets this way (`anim-sample`'s `curve`).
//!
//! There is no lane (SIMD) form: an evaluation is a binary search plus, for Bézier, a bisection,
//! both branchy and per curve, and the cores evaluate a curve once per control quantum, tween or
//! sample, so four lanes would buy nothing.
//!
//! # Feature `alloc`
//!
//! Off by default. It adds [`parse_keys`] (the host's flat key floats read, checked and baked into
//! a `Vec<Key<f32>>`), for hosts that keep curves as slices: the animation core (`anim-sample`'s
//! `curve`) and the tween crate (`myco-tween`'s curve store, ADR 0424). The audio core keeps fixed
//! [`Curve`] tables and links this crate without it.
#![cfg_attr(not(test), no_std)]
#![forbid(unsafe_code)]

#[cfg(feature = "alloc")]
extern crate alloc;

#[cfg(feature = "alloc")]
mod parse;
#[cfg(feature = "alloc")]
pub use parse::{parse_keys, CurveError, KEY_FLOATS, MAX_KEYS};

use core::ops::{Add, Div, Mul, Sub};

/// Interp code: linear (the default).
pub const INTERP_LINEAR: u8 = 0;
/// Interp code: hold the key's value until the next key.
pub const INTERP_STEP: u8 = 1;
/// Interp code: smoothstep, `u²(3 − 2u)`.
pub const INTERP_SMOOTH: u8 = 2;
/// Interp code: quadratic ease in, `u²`.
pub const INTERP_EASE_IN: u8 = 3;
/// Interp code: quadratic ease out, `1 − (1 − u)²`.
pub const INTERP_EASE_OUT: u8 = 4;
/// Interp code: a Bézier segment through the key's handles (ADR 0346).
pub const INTERP_BEZIER: u8 = 5;

/// Halvings of the Bézier parameter search (`curve.ts`'s `BEZIER_STEPS`).
pub const BEZIER_STEPS: usize = 28;

/// Keys a [`Curve`] holds (the audio core's CURVES limit).
pub const CURVE_KEYS: usize = 64;

/// The float types the evaluator runs in: f32 (the cores) and f64 (`curve.ts`'s numbers).
pub trait Real:
    Copy
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
{
    const ZERO: Self;
    const HALF: Self;
    const ONE: Self;
    const TWO: Self;
    const THREE: Self;
}

impl Real for f32 {
    const ZERO: f32 = 0.0;
    const HALF: f32 = 0.5;
    const ONE: f32 = 1.0;
    const TWO: f32 = 2.0;
    const THREE: f32 = 3.0;
}

impl Real for f64 {
    const ZERO: f64 = 0.0;
    const HALF: f64 = 0.5;
    const ONE: f64 = 1.0;
    const TWO: f64 = 2.0;
    const THREE: f64 = 3.0;
}

/// The shape of a segment of interp `interp` at `u` in 0..1 (`curve.ts`'s `curveShape`). Bézier
/// isn't a shape ([`bezier_segment`]); here it and unknown codes are linear.
#[inline]
pub fn shape<R: Real>(interp: u8, u: R) -> R {
    match interp {
        INTERP_STEP => R::ZERO,
        INTERP_SMOOTH => u * u * (R::THREE - R::TWO * u),
        INTERP_EASE_IN => u * u,
        INTERP_EASE_OUT => R::ONE - (R::ONE - u) * (R::ONE - u),
        _ => u,
    }
}

/// The cubic Bézier through `p0..p3` at `t` (`curve.ts`'s `cubic`, term for term).
#[inline]
fn cubic<R: Real>(p0: R, p1: R, p2: R, p3: R, t: R) -> R {
    let m = R::ONE - t;
    m * m * m * p0 + R::THREE * m * m * t * p1 + R::THREE * m * t * t * p2 + t * t * t * p3
}

/// `v` clamped into `0..=span`; NaN is 0 (`curve.ts`'s `clampSpan`).
#[inline]
fn clamp_span<R: Real>(v: R, span: R) -> R {
    if v > R::ZERO {
        if v < span {
            v
        } else {
            span
        }
    } else {
        R::ZERO
    }
}

/// The control points `[c1x, c1y, c2x, c2y]` of the Bézier segment from key `(xa, ya)` with out
/// handle `out` to key `(xb, yb)`, whose in handle is `into` when it is a Bézier key (`None`: the
/// flat handle a third of the segment long). x is relative to `xa` and inside `0..=span`, y
/// absolute (`curve.ts`'s `bezierControls`).
#[inline]
pub fn bezier_controls<R: Real>(
    xa: R,
    ya: R,
    out: [R; 2],
    xb: R,
    yb: R,
    into: Option<[R; 2]>,
) -> [R; 4] {
    let span = xb - xa;
    let c1x = clamp_span(out[0], span);
    let c1y = ya + out[1];
    match into {
        Some(h) => [c1x, c1y, clamp_span(span + h[0], span), yb + h[1]],
        None => [c1x, c1y, span - span / R::THREE, yb],
    }
}

/// The Bézier segment from `ya` to `yb` over `span > 0` with control points `c`
/// ([`bezier_controls`]) at `dx` past its first key: bisection for the parameter whose x is `dx`,
/// then its y (`curve.ts`'s `bezierAt`).
#[inline]
pub fn bezier_segment<R: Real>(span: R, dx: R, ya: R, yb: R, c: [R; 4]) -> R {
    let (mut lo, mut hi) = (R::ZERO, R::ONE);
    for _ in 0..BEZIER_STEPS {
        let t = (lo + hi) * R::HALF;
        if cubic(R::ZERO, c[0], c[2], span, t) < dx {
            lo = t;
        } else {
            hi = t;
        }
    }
    cubic(ya, c[1], c[3], yb, (lo + hi) * R::HALF)
}

/// Keys as [`eval`] reads them: sorted by x, with each Bézier segment's control points worked out
/// ([`bezier_controls`]; unused for other interps).
pub trait Keys {
    type R: Real;
    /// Keys in the curve.
    fn count(&self) -> usize;
    fn x(&self, i: usize) -> Self::R;
    fn y(&self, i: usize) -> Self::R;
    fn interp(&self, i: usize) -> u8;
    /// The control points of the segment from key `i` (`[c1x, c1y, c2x, c2y]`).
    fn controls(&self, i: usize) -> [Self::R; 4];
}

/// The curve's value at `x` (`curve.ts`'s `evalCurve`). An empty curve is 0.
// `!(x > x0)` is meant: NaN reads the first key, as in curve.ts.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub fn eval<K: Keys + ?Sized>(keys: &K, x: K::R) -> K::R {
    let n = keys.count();
    if n == 0 {
        return K::R::ZERO;
    }
    if !(x > keys.x(0)) {
        return keys.y(0); // also NaN
    }
    if x >= keys.x(n - 1) {
        return keys.y(n - 1);
    }
    let (mut lo, mut hi) = (0usize, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1;
        if keys.x(mid) <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (xa, xb) = (keys.x(lo), keys.x(hi));
    let span = xb - xa;
    if span <= K::R::ZERO {
        return keys.y(hi);
    }
    let (ya, yb) = (keys.y(lo), keys.y(hi));
    let interp = keys.interp(lo);
    if interp == INTERP_BEZIER {
        return bezier_segment(span, x - xa, ya, yb, keys.controls(lo));
    }
    ya + (yb - ya) * shape(interp, (x - xa) / span)
}

/// A source key: `(x, y, interp, [inDx, inDy, outDx, outDy])`, `curve.ts`'s key with its
/// handles (zeros for a key that isn't Bézier).
pub type SourceKey<R> = (R, R, u8, [R; 4]);

/// One baked key ([`bake`]): the key and the control points of the segment from it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Key<R> {
    pub x: R,
    pub y: R,
    pub interp: u8,
    /// The segment's control points (x relative to `x`, y absolute); 0 unless Bézier.
    pub c1x: R,
    pub c1y: R,
    pub c2x: R,
    pub c2y: R,
}

impl<R: Real> Keys for [Key<R>] {
    type R = R;
    #[inline]
    fn count(&self) -> usize {
        self.len()
    }
    #[inline]
    fn x(&self, i: usize) -> R {
        self[i].x
    }
    #[inline]
    fn y(&self, i: usize) -> R {
        self[i].y
    }
    #[inline]
    fn interp(&self, i: usize) -> u8 {
        self[i].interp
    }
    #[inline]
    fn controls(&self, i: usize) -> [R; 4] {
        let k = &self[i];
        [k.c1x, k.c1y, k.c2x, k.c2y]
    }
}

/// Bakes source keys (sorted by x) into `out`, working out each Bézier segment's control points.
/// Returns the keys written: `min(src.len(), out.len())`.
pub fn bake<R: Real>(src: &[SourceKey<R>], out: &mut [Key<R>]) -> usize {
    let n = src.len().min(out.len());
    for i in 0..n {
        let (x, y, interp, _) = src[i];
        let mut k = Key {
            x,
            y,
            interp,
            c1x: R::ZERO,
            c1y: R::ZERO,
            c2x: R::ZERO,
            c2y: R::ZERO,
        };
        if interp == INTERP_BEZIER && i + 1 < n {
            let next = src[i + 1];
            let into = (next.2 == INTERP_BEZIER).then_some([next.3[0], next.3[1]]);
            [k.c1x, k.c1y, k.c2x, k.c2y] =
                bezier_controls(x, y, [src[i].3[2], src[i].3[3]], next.0, next.1, into);
        }
        out[i] = k;
    }
    n
}

/// One curve of at most [`CURVE_KEYS`] keys as parallel f32 arrays: the audio core's curve table
/// entry. `repr(C)` with integers and floats only; all-zero ([`Curve::EMPTY`]) is an empty curve.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Curve {
    pub count: u32,
    pub x: [f32; CURVE_KEYS],
    pub y: [f32; CURVE_KEYS],
    /// The shape from each key to the next: 0 linear, 1 step, 2 smooth, 3 easeIn, 4 easeOut,
    /// 5 Bézier (anything else is linear, as `curve.ts`'s default).
    pub interp: [u8; CURVE_KEYS],
    /// The control points of each Bézier segment (from key `k` to `k + 1`): x relative to `x[k]`
    /// and inside `0..=span`, y absolute. Unused for other shapes.
    pub c1x: [f32; CURVE_KEYS],
    pub c1y: [f32; CURVE_KEYS],
    pub c2x: [f32; CURVE_KEYS],
    pub c2y: [f32; CURVE_KEYS],
}

impl Curve {
    /// The empty curve (all zero).
    pub const EMPTY: Curve = Curve {
        count: 0,
        x: [0.0; CURVE_KEYS],
        y: [0.0; CURVE_KEYS],
        interp: [0; CURVE_KEYS],
        c1x: [0.0; CURVE_KEYS],
        c1y: [0.0; CURVE_KEYS],
        c2x: [0.0; CURVE_KEYS],
        c2y: [0.0; CURVE_KEYS],
    };

    /// A curve from source keys sorted by x, its Bézier control points worked out ([`Self::set_controls`]);
    /// keys past [`CURVE_KEYS`] are ignored.
    pub fn from_keys(keys: &[SourceKey<f32>]) -> Curve {
        let mut c = Curve::EMPTY;
        let n = keys.len().min(CURVE_KEYS);
        c.count = n as u32;
        for (i, k) in keys[..n].iter().enumerate() {
            c.x[i] = k.0;
            c.y[i] = k.1;
            c.interp[i] = k.2;
        }
        c.set_controls(|k| keys[k].3);
        c
    }

    /// Works out the control points of every Bézier segment of the curve's first `count` keys
    /// (whose x, y and interp are set) from the keys' handles: `handles(k)` is key `k`'s
    /// `[inDx, inDy, outDx, outDy]`, asked only for Bézier keys.
    pub fn set_controls(&mut self, handles: impl Fn(usize) -> [f32; 4]) {
        let n = (self.count as usize).min(CURVE_KEYS);
        for k in 0..n.saturating_sub(1) {
            if self.interp[k] != INTERP_BEZIER {
                continue;
            }
            let out = handles(k);
            let into = if self.interp[k + 1] == INTERP_BEZIER {
                let h = handles(k + 1);
                Some([h[0], h[1]])
            } else {
                None
            };
            let c = bezier_controls(
                self.x[k],
                self.y[k],
                [out[2], out[3]],
                self.x[k + 1],
                self.y[k + 1],
                into,
            );
            [self.c1x[k], self.c1y[k], self.c2x[k], self.c2y[k]] = c;
        }
    }
}

impl Keys for Curve {
    type R = f32;
    #[inline]
    fn count(&self) -> usize {
        (self.count as usize).min(CURVE_KEYS)
    }
    #[inline]
    fn x(&self, i: usize) -> f32 {
        self.x[i]
    }
    #[inline]
    fn y(&self, i: usize) -> f32 {
        self.y[i]
    }
    #[inline]
    fn interp(&self, i: usize) -> u8 {
        self.interp[i]
    }
    #[inline]
    fn controls(&self, i: usize) -> [f32; 4] {
        [self.c1x[i], self.c1y[i], self.c2x[i], self.c2y[i]]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A curve from `(x, y, interp)` keys.
    fn curve(keys: &[(f32, f32, u8)]) -> Curve {
        bez(&keys
            .iter()
            .map(|&(x, y, i)| (x, y, i, [0.0; 4]))
            .collect::<Vec<_>>())
    }

    /// A curve from `(x, y, interp, [inDx, inDy, outDx, outDy])` keys.
    fn bez(keys: &[SourceKey<f32>]) -> Curve {
        Curve::from_keys(keys)
    }

    /// The same keys baked into a slice.
    fn baked(keys: &[SourceKey<f32>]) -> Vec<Key<f32>> {
        let mut out = vec![Key::default(); keys.len()];
        bake(keys, &mut out);
        out
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // The cases of `src/engine/tests/curve.test.ts` (moved here from audio-core's automation.rs).

    #[test]
    fn is_0_when_empty_and_flat_beyond_the_ends() {
        assert_eq!(eval(&curve(&[]), 3.0), 0.0);
        assert_eq!(eval(&baked(&[])[..], 3.0), 0.0);
        let c = curve(&[(1.0, 2.0, 0), (3.0, 6.0, 0)]);
        assert_eq!(eval(&c, -5.0), 2.0);
        assert_eq!(eval(&c, 9.0), 6.0);
        assert_eq!(eval(&c, f32::NAN), 2.0);
    }

    #[test]
    fn interpolates_linearly_by_default() {
        assert!(close(
            eval(&curve(&[(0.0, 0.0, 0), (10.0, 1.0, 0)]), 2.5),
            0.25
        ));
        assert!(close(
            eval(&curve(&[(0.0, 0.0, 0), (1.0, 10.0, 0), (2.0, 0.0, 0)]), 1.5),
            5.0
        ));
        assert!(
            close(eval(&curve(&[(0.0, 0.0, 9), (10.0, 1.0, 0)]), 2.5), 0.25),
            "an unknown shape is linear"
        );
    }

    #[test]
    fn holds_a_step_until_the_next_key() {
        let c = curve(&[(0.0, 1.0, 1), (1.0, 5.0, 0)]);
        assert_eq!(eval(&c, 0.999), 1.0);
        assert_eq!(eval(&c, 1.0), 5.0);
    }

    #[test]
    fn shapes_smooth_ease_in_and_ease_out_segments() {
        assert!(close(
            eval(&curve(&[(0.0, 0.0, 2), (1.0, 1.0, 0)]), 0.25),
            0.15625
        ));
        assert!(close(
            eval(&curve(&[(0.0, 0.0, 3), (1.0, 1.0, 0)]), 0.5),
            0.25
        ));
        assert!(close(
            eval(&curve(&[(0.0, 0.0, 4), (1.0, 1.0, 0)]), 0.5),
            0.75
        ));
        for s in [0u8, 2, 3, 4] {
            assert_eq!(shape(s, 0.0f32), 0.0);
            assert_eq!(shape(s, 1.0f32), 1.0);
        }
    }

    #[test]
    fn jumps_at_keys_with_the_same_x() {
        let c = curve(&[(0.0, 0.0, 0), (1.0, 1.0, 0), (1.0, 4.0, 0), (2.0, 4.0, 0)]);
        assert!(close(eval(&c, 0.5), 0.5));
        assert_eq!(eval(&c, 1.0), 4.0);
        assert_eq!(eval(&c, 1.5), 4.0);
    }

    #[test]
    fn finds_the_right_segment_in_a_long_curve() {
        let keys: Vec<(f32, f32, u8)> = (0..CURVE_KEYS)
            .map(|i| (i as f32, i as f32 * 2.0, 0))
            .collect();
        let c = curve(&keys);
        for x in [0.5f32, 17.25, 23.9, 30.5, 47.1, 62.5] {
            assert!(close(eval(&c, x), x * 2.0), "{x}");
        }
    }

    #[test]
    fn a_curve_ignores_keys_past_its_table() {
        let keys: Vec<SourceKey<f32>> =
            (0..70).map(|i| (i as f32, i as f32, 0, [0.0; 4])).collect();
        let c = Curve::from_keys(&keys);
        assert_eq!(c.count as usize, CURVE_KEYS);
        assert_eq!(
            eval(&c, 66.0),
            (CURVE_KEYS - 1) as f32,
            "flat after the last key it kept"
        );
        assert_eq!(
            eval(&baked(&keys)[..], 66.0),
            66.0,
            "a baked slice keeps every key"
        );
    }

    // The Bézier cases of `curve.test.ts` (ADR 0346).

    #[test]
    fn a_bezier_with_handles_on_the_line_is_linear() {
        let c = bez(&[
            (0.0, 0.0, 5, [0.0, 0.0, 1.0, 1.0]),
            (3.0, 3.0, 5, [-1.0, -1.0, 0.0, 0.0]),
        ]);
        for x in [0.3f32, 1.0, 1.7, 2.9] {
            assert!(close(eval(&c, x), x), "{x}: {}", eval(&c, x));
        }
    }

    #[test]
    fn a_bezier_before_a_plain_key_uses_a_flat_third_handle() {
        // Out handle flat and a third long, next key plain: the same control points as smoothstep's cubic.
        let c = bez(&[
            (0.0, 0.0, 5, [0.0, 0.0, 1.0 / 3.0, 0.0]),
            (1.0, 1.0, 0, [0.0; 4]),
        ]);
        for x in [0.1f32, 0.25, 0.5, 0.8] {
            assert!(close(eval(&c, x), x * x * (3.0 - 2.0 * x)), "{x}");
        }
        assert_eq!(eval(&c, 0.0), 0.0);
        assert_eq!(eval(&c, 1.0), 1.0);
    }

    #[test]
    fn a_bezier_clamps_control_x_into_the_segment_and_overshoots_in_y() {
        // Handles reaching past the segment: x clamped, so the curve stays a function and ends on its keys.
        let c = bez(&[
            (0.0, 0.0, 5, [0.0, 0.0, 9.0, 2.0]),
            (1.0, 1.0, 5, [-9.0, 2.0, 0.0, 0.0]),
        ]);
        assert_eq!((c.c1x[0], c.c2x[0]), (1.0, 0.0));
        let mid = eval(&c, 0.5);
        assert!(
            mid > 1.0,
            "{mid}: control y of 2 and 3 lift the middle above both keys"
        );
        assert!((eval(&c, 0.999) - 1.0).abs() < 0.05);
    }

    #[test]
    fn the_two_layouts_give_the_same_bits() {
        let keys: Vec<SourceKey<f32>> = vec![
            (-1.0, 2.0, 5, [0.0, 0.0, 0.7, 3.0]),
            (0.5, -1.0, 5, [-0.2, 1.0, 0.4, -2.0]),
            (0.5, 4.0, 2, [0.0; 4]),
            (2.0, 0.0, 5, [0.0, 0.0, 1.5, 0.5]),
            (3.0, 1.0, 3, [0.0; 4]),
            (4.0, -2.0, 1, [0.0; 4]),
            (5.0, 3.0, 4, [0.0; 4]),
            (7.0, 0.0, 0, [0.0; 4]),
        ];
        let (c, s) = (Curve::from_keys(&keys), baked(&keys));
        for i in 0..=900 {
            let x = -2.0 + i as f32 * 0.01;
            assert_eq!(eval(&c, x).to_bits(), eval(&s[..], x).to_bits(), "{x}");
        }
    }
}
