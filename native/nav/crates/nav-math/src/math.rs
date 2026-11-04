//! The `Unity.Mathematics` (`math.*`) behaviours Foxfire relies on, defined as Unity defines them.
//!
//! Foxfire's runtime code isn't Strict-mode, so these are the straightforward definitions:
//! `rsqrt = 1/sqrt`, `normalize = rsqrt(dot) * v`, `min`/`max` with Unity's NaN rule, `round` ties
//! to even, and so on. The deterministic bake code uses [`crate::exact`] instead.
//!
//! Not ported on purpose: `sincos`, `atan2`, `pow`, `exp`, `log2` (Foxfire uses them only in
//! runtime steering, debug drawing and slot layouts; later crates call `std` for those, since
//! Myco doesn't require runtime steering to be deterministic), and `math.hash` / `Random` (the
//! constants are Unity's internals; Foxfire only uses them for table hashing and ORCA nudges).
use crate::vec::{Double3, Float2, Float3, Float4, Int2, Int3, Int4};

pub const PI: f32 = 3.14159265358979323846;
/// `math.FLT_MIN_NORMAL`, the threshold of `normalizesafe`.
pub const FLT_MIN_NORMAL: f32 = 1.175494351e-38;
/// Unity's `math.TORADIANS` / `TODEGREES` (single-precision constants, unlike [`crate::exact`]).
pub const TORADIANS: f32 = 0.0174532925;
pub const TODEGREES: f32 = 57.295779513;

/// Scalars `min`/`max`/`clamp` work on. `is_nan` is false for integers.
pub trait Scalar: Copy + PartialOrd {
    fn is_nan(self) -> bool;
}
impl Scalar for f32 { #[inline] fn is_nan(self) -> bool { f32::is_nan(self) } }
impl Scalar for f64 { #[inline] fn is_nan(self) -> bool { f64::is_nan(self) } }
impl Scalar for i32 { #[inline] fn is_nan(self) -> bool { false } }
impl Scalar for u32 { #[inline] fn is_nan(self) -> bool { false } }

/// `math.min`: `isnan(y) || x < y ? x : y`, so a NaN second argument yields the first.
#[inline]
pub fn min<T: Scalar>(x: T, y: T) -> T { if y.is_nan() || x < y { x } else { y } }
/// `math.max`: `isnan(y) || x > y ? x : y`.
#[inline]
pub fn max<T: Scalar>(x: T, y: T) -> T { if y.is_nan() || x > y { x } else { y } }
/// `math.clamp`: `max(a, min(b, x))`.
#[inline]
pub fn clamp<T: Scalar>(x: T, a: T, b: T) -> T { max(a, min(b, x)) }

#[inline] pub fn abs(x: f32) -> f32 { f32::from_bits(x.to_bits() & 0x7FFF_FFFF) }
#[inline] pub fn saturate(x: f32) -> f32 { clamp(x, 0.0, 1.0) }
/// `math.lerp`: `x + s * (y - x)`.
#[inline] pub fn lerp(x: f32, y: f32, s: f32) -> f32 { x + s * (y - x) }
#[inline] pub fn floor(x: f32) -> f32 { x.floor() }
#[inline] pub fn ceil(x: f32) -> f32 { x.ceil() }
/// `math.floor` on doubles.
#[inline] pub fn floor_d(x: f64) -> f64 { x.floor() }
/// `math.round`: ties to even (`Math.Round`), not away from zero.
#[inline] pub fn round(x: f32) -> f32 { x.round_ties_even() }
/// `math.frac`: `x - floor(x)` (so negative inputs give a fraction in [0, 1)).
#[inline] pub fn frac(x: f32) -> f32 { x - x.floor() }
/// `math.sign` for floats: -1, 0 or 1 (0 for 0 and NaN).
#[inline] pub fn sign(x: f32) -> f32 { (x > 0.0) as i32 as f32 - (x < 0.0) as i32 as f32 }
#[inline] pub fn square(x: f32) -> f32 { x * x }
/// `math.rsqrt` as a plain `1 / sqrt(x)`.
#[inline] pub fn rsqrt(x: f32) -> f32 { 1.0 / x.sqrt() }
#[inline] pub fn radians(x: f32) -> f32 { x * TORADIANS }
#[inline] pub fn degrees(x: f32) -> f32 { x * TODEGREES }
/// `math.select(a, b, c)`: `c ? b : a` (note the argument order).
#[inline] pub fn select<T>(a: T, b: T, c: bool) -> T { if c { b } else { a } }
#[inline] pub fn isnan(x: f32) -> bool { x.is_nan() }
#[inline] pub fn isfinite(x: f32) -> bool { abs(x) < f32::INFINITY }

/// `math.ceilpow2`: the next power of two at or above `i` (0 gives 0, as in Unity).
#[inline]
pub fn ceilpow2(i: i32) -> i32 {
    let mut x = i.wrapping_sub(1);
    x |= x >> 1;
    x |= x >> 2;
    x |= x >> 4;
    x |= x >> 8;
    x |= x >> 16;
    x.wrapping_add(1)
}
/// `math.tzcnt`: trailing zero bits, 32 for 0.
#[inline] pub fn tzcnt(x: i32) -> i32 { (x as u32).trailing_zeros() as i32 }

// ---- boolean vectors (`math.any` / `math.all`) -------------------------------------------------

macro_rules! bool_vec {
    ($name:ident, $($f:ident),+) => {
        /// A component-wise comparison result, like Unity's `bool2/3/4`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
        pub struct $name { $(pub $f: bool),+ }
        impl $name {
            #[inline] pub fn any(self) -> bool { false $(|| self.$f)+ }
            #[inline] pub fn all(self) -> bool { true $(&& self.$f)+ }
            #[inline] pub fn not(self) -> Self { Self { $($f: !self.$f),+ } }
        }
    };
}
bool_vec!(Bool2, x, y);
bool_vec!(Bool3, x, y, z);
bool_vec!(Bool4, x, y, z, w);

macro_rules! cmp_methods {
    ($vec:ident, $b:ident, $($f:ident),+) => {
        impl $vec {
            #[inline] pub fn lt(self, o: Self) -> $b { $b { $($f: self.$f < o.$f),+ } }
            #[inline] pub fn le(self, o: Self) -> $b { $b { $($f: self.$f <= o.$f),+ } }
            #[inline] pub fn gt(self, o: Self) -> $b { $b { $($f: self.$f > o.$f),+ } }
            #[inline] pub fn ge(self, o: Self) -> $b { $b { $($f: self.$f >= o.$f),+ } }
            #[inline] pub fn eq_v(self, o: Self) -> $b { $b { $($f: self.$f == o.$f),+ } }
            #[inline] pub fn ne_v(self, o: Self) -> $b { $b { $($f: self.$f != o.$f),+ } }
        }
    };
}
cmp_methods!(Float2, Bool2, x, y);
cmp_methods!(Float3, Bool3, x, y, z);
cmp_methods!(Float4, Bool4, x, y, z, w);
cmp_methods!(Int2, Bool2, x, y);
cmp_methods!(Int3, Bool3, x, y, z);
cmp_methods!(Int4, Bool4, x, y, z, w);

// ---- float2 / float3 functions -----------------------------------------------------------------

macro_rules! float_vec_math {
    ($vec:ident, $($f:ident),+) => {
        impl $vec {
            /// `math.abs`.
            #[inline] pub fn abs(self) -> Self { Self { $($f: abs(self.$f)),+ } }
            /// `math.floor`.
            #[inline] pub fn floor(self) -> Self { Self { $($f: self.$f.floor()),+ } }
            #[inline] pub fn ceil(self) -> Self { Self { $($f: self.$f.ceil()),+ } }
            /// `math.round` (ties to even).
            #[inline] pub fn round(self) -> Self { Self { $($f: round(self.$f)),+ } }
            #[inline] pub fn frac(self) -> Self { Self { $($f: frac(self.$f)),+ } }
            #[inline] pub fn saturate(self) -> Self { Self { $($f: saturate(self.$f)),+ } }
            #[inline] pub fn clamp(self, a: Self, b: Self) -> Self { Self { $($f: clamp(self.$f, a.$f, b.$f)),+ } }
            #[inline] pub fn min_v(self, o: Self) -> Self { Self { $($f: min(self.$f, o.$f)),+ } }
            #[inline] pub fn max_v(self, o: Self) -> Self { Self { $($f: max(self.$f, o.$f)),+ } }
            /// `math.lerp(x, y, s)` with a scalar `s`.
            #[inline] pub fn lerp(self, y: Self, s: f32) -> Self { Self { $($f: lerp(self.$f, y.$f, s)),+ } }
            /// `math.distance`.
            #[inline] pub fn distance(self, o: Self) -> f32 { (o - self).length() }
            /// `math.distancesq`.
            #[inline] pub fn distance_sq(self, o: Self) -> f32 { (o - self).length_sq() }
            /// `math.normalize`: `rsqrt(dot(v, v)) * v` (NaN or infinite for a zero vector).
            #[inline] pub fn normalize(self) -> Self { self * rsqrt(self.dot(self)) }
            /// `math.normalizesafe(v, fallback)`: the fallback unless `dot(v, v)` is strictly
            /// greater than `FLT_MIN_NORMAL`, else `v * rsqrt(len)`.
            #[inline]
            pub fn normalize_safe(self, fallback: Self) -> Self {
                let len = self.dot(self);
                if len > FLT_MIN_NORMAL { self * rsqrt(len) } else { fallback }
            }
        }
    };
}
float_vec_math!(Float2, x, y);
float_vec_math!(Float3, x, y, z);

impl Float2 {
    #[inline] pub fn cmin(self) -> f32 { min(self.x, self.y) }
    #[inline] pub fn cmax(self) -> f32 { max(self.x, self.y) }
    #[inline] pub fn csum(self) -> f32 { self.x + self.y }
}
impl Float3 {
    pub const UP: Float3 = Float3::new(0.0, 1.0, 0.0);
    pub const FORWARD: Float3 = Float3::new(0.0, 0.0, 1.0);
    pub const RIGHT: Float3 = Float3::new(1.0, 0.0, 0.0);
    /// `math.cmin`: `min(x, min(y, z))`.
    #[inline] pub fn cmin(self) -> f32 { min(self.x, min(self.y, self.z)) }
    #[inline] pub fn cmax(self) -> f32 { max(self.x, max(self.y, self.z)) }
    /// `math.csum`: `x + y + z`.
    #[inline] pub fn csum(self) -> f32 { self.x + self.y + self.z }
    /// `math.sign`, per component.
    #[inline] pub fn sign(self) -> Self { Self::new(sign(self.x), sign(self.y), sign(self.z)) }
    /// `math.select(a, b, c)` per component.
    #[inline] pub fn select(a: Self, b: Self, c: Bool3) -> Self {
        Self::new(select(a.x, b.x, c.x), select(a.y, b.y, c.y), select(a.z, b.z, c.z))
    }
}
impl Int2 {
    #[inline] pub fn cmin(self) -> i32 { min(self.x, self.y) }
    #[inline] pub fn cmax(self) -> i32 { max(self.x, self.y) }
}
impl Int3 {
    #[inline] pub fn cmin(self) -> i32 { min(self.x, min(self.y, self.z)) }
    /// `math.cmax(int3)`: `max(x, max(y, z))`.
    #[inline] pub fn cmax(self) -> i32 { max(self.x, max(self.y, self.z)) }
    #[inline] pub fn csum(self) -> i32 { self.x.wrapping_add(self.y).wrapping_add(self.z) }
}
impl Double3 {
    #[inline] pub fn length_sq(self) -> f64 { self.dot(self) }
    #[inline] pub fn length(self) -> f64 { self.length_sq().sqrt() }
}

// ---- matrices (column-major, like Unity) -------------------------------------------------------

/// `float3x3`: three columns.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Float3x3 { pub c0: Float3, pub c1: Float3, pub c2: Float3 }

impl Float3x3 {
    pub const IDENTITY: Float3x3 = Float3x3 {
        c0: Float3::new(1.0, 0.0, 0.0), c1: Float3::new(0.0, 1.0, 0.0), c2: Float3::new(0.0, 0.0, 1.0),
    };
    #[inline] pub const fn new(c0: Float3, c1: Float3, c2: Float3) -> Self { Self { c0, c1, c2 } }
    /// `math.transpose`.
    #[inline]
    pub fn transpose(self) -> Self {
        Self::new(
            Float3::new(self.c0.x, self.c1.x, self.c2.x),
            Float3::new(self.c0.y, self.c1.y, self.c2.y),
            Float3::new(self.c0.z, self.c1.z, self.c2.z),
        )
    }
    /// `math.mul(m, v)`: `c0*v.x + c1*v.y + c2*v.z`, in that order.
    #[inline]
    pub fn mul_vec(self, v: Float3) -> Float3 { self.c0 * v.x + self.c1 * v.y + self.c2 * v.z }
    /// `math.mul(a, b)`.
    #[inline]
    pub fn mul(self, b: Self) -> Self { Self::new(self.mul_vec(b.c0), self.mul_vec(b.c1), self.mul_vec(b.c2)) }
}

/// `float4x4`: four columns.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Float4x4 { pub c0: Float4, pub c1: Float4, pub c2: Float4, pub c3: Float4 }

impl Float4x4 {
    pub const IDENTITY: Float4x4 = Float4x4 {
        c0: Float4::new(1.0, 0.0, 0.0, 0.0), c1: Float4::new(0.0, 1.0, 0.0, 0.0),
        c2: Float4::new(0.0, 0.0, 1.0, 0.0), c3: Float4::new(0.0, 0.0, 0.0, 1.0),
    };
    #[inline] pub const fn new(c0: Float4, c1: Float4, c2: Float4, c3: Float4) -> Self { Self { c0, c1, c2, c3 } }
    #[inline] pub fn mul_vec(self, v: Float4) -> Float4 { self.c0 * v.x + self.c1 * v.y + self.c2 * v.z + self.c3 * v.w }
    #[inline] pub fn mul(self, b: Self) -> Self {
        Self::new(self.mul_vec(b.c0), self.mul_vec(b.c1), self.mul_vec(b.c2), self.mul_vec(b.c3))
    }
    /// `math.transform(m, p)`: `mul(m, float4(p, 1)).xyz` (no perspective divide).
    #[inline]
    pub fn transform_point(self, p: Float3) -> Float3 {
        let r = self.mul_vec(Float4::new(p.x, p.y, p.z, 1.0));
        Float3::new(r.x, r.y, r.z)
    }
    /// The upper 3x3 applied to a direction.
    #[inline]
    pub fn transform_direction(self, d: Float3) -> Float3 {
        let r = self.c0 * d.x + self.c1 * d.y + self.c2 * d.z;
        Float3::new(r.x, r.y, r.z)
    }
    pub fn transpose(self) -> Self {
        let c = [self.c0, self.c1, self.c2, self.c3];
        Self::new(
            Float4::new(c[0].x, c[1].x, c[2].x, c[3].x),
            Float4::new(c[0].y, c[1].y, c[2].y, c[3].y),
            Float4::new(c[0].z, c[1].z, c[2].z, c[3].z),
            Float4::new(c[0].w, c[1].w, c[2].w, c[3].w),
        )
    }
    /// `math.inverse`: the general 4x4 inverse by cofactors, in doubles (the bake uses it for box
    /// transforms, where bit-equality with Unity's expression order isn't required). A singular
    /// matrix gives infinities/NaNs, as in Unity.
    pub fn inverse(self) -> Self {
        let cols = [self.c0, self.c1, self.c2, self.c3];
        // Row-major copy: r[row * 4 + col].
        let mut r = [0.0f64; 16];
        for (col, c) in cols.iter().enumerate() {
            r[col] = c.x as f64;
            r[4 + col] = c.y as f64;
            r[8 + col] = c.z as f64;
            r[12 + col] = c.w as f64;
        }
        let mut inv = [0.0f64; 16];
        inv[0] = r[5]*r[10]*r[15] - r[5]*r[11]*r[14] - r[9]*r[6]*r[15] + r[9]*r[7]*r[14] + r[13]*r[6]*r[11] - r[13]*r[7]*r[10];
        inv[4] = -r[4]*r[10]*r[15] + r[4]*r[11]*r[14] + r[8]*r[6]*r[15] - r[8]*r[7]*r[14] - r[12]*r[6]*r[11] + r[12]*r[7]*r[10];
        inv[8] = r[4]*r[9]*r[15] - r[4]*r[11]*r[13] - r[8]*r[5]*r[15] + r[8]*r[7]*r[13] + r[12]*r[5]*r[11] - r[12]*r[7]*r[9];
        inv[12] = -r[4]*r[9]*r[14] + r[4]*r[10]*r[13] + r[8]*r[5]*r[14] - r[8]*r[6]*r[13] - r[12]*r[5]*r[10] + r[12]*r[6]*r[9];
        inv[1] = -r[1]*r[10]*r[15] + r[1]*r[11]*r[14] + r[9]*r[2]*r[15] - r[9]*r[3]*r[14] - r[13]*r[2]*r[11] + r[13]*r[3]*r[10];
        inv[5] = r[0]*r[10]*r[15] - r[0]*r[11]*r[14] - r[8]*r[2]*r[15] + r[8]*r[3]*r[14] + r[12]*r[2]*r[11] - r[12]*r[3]*r[10];
        inv[9] = -r[0]*r[9]*r[15] + r[0]*r[11]*r[13] + r[8]*r[1]*r[15] - r[8]*r[3]*r[13] - r[12]*r[1]*r[11] + r[12]*r[3]*r[9];
        inv[13] = r[0]*r[9]*r[14] - r[0]*r[10]*r[13] - r[8]*r[1]*r[14] + r[8]*r[2]*r[13] + r[12]*r[1]*r[10] - r[12]*r[2]*r[9];
        inv[2] = r[1]*r[6]*r[15] - r[1]*r[7]*r[14] - r[5]*r[2]*r[15] + r[5]*r[3]*r[14] + r[13]*r[2]*r[7] - r[13]*r[3]*r[6];
        inv[6] = -r[0]*r[6]*r[15] + r[0]*r[7]*r[14] + r[4]*r[2]*r[15] - r[4]*r[3]*r[14] - r[12]*r[2]*r[7] + r[12]*r[3]*r[6];
        inv[10] = r[0]*r[5]*r[15] - r[0]*r[7]*r[13] - r[4]*r[1]*r[15] + r[4]*r[3]*r[13] + r[12]*r[1]*r[7] - r[12]*r[3]*r[5];
        inv[14] = -r[0]*r[5]*r[14] + r[0]*r[6]*r[13] + r[4]*r[1]*r[14] - r[4]*r[2]*r[13] - r[12]*r[1]*r[6] + r[12]*r[2]*r[5];
        inv[3] = -r[1]*r[6]*r[11] + r[1]*r[7]*r[10] + r[5]*r[2]*r[11] - r[5]*r[3]*r[10] - r[9]*r[2]*r[7] + r[9]*r[3]*r[6];
        inv[7] = r[0]*r[6]*r[11] - r[0]*r[7]*r[10] - r[4]*r[2]*r[11] + r[4]*r[3]*r[10] + r[8]*r[2]*r[7] - r[8]*r[3]*r[6];
        inv[11] = -r[0]*r[5]*r[11] + r[0]*r[7]*r[9] + r[4]*r[1]*r[11] - r[4]*r[3]*r[9] - r[8]*r[1]*r[7] + r[8]*r[3]*r[5];
        inv[15] = r[0]*r[5]*r[10] - r[0]*r[6]*r[9] - r[4]*r[1]*r[10] + r[4]*r[2]*r[9] + r[8]*r[1]*r[6] - r[8]*r[2]*r[5];
        let det = r[0]*inv[0] + r[1]*inv[4] + r[2]*inv[8] + r[3]*inv[12];
        let d = 1.0 / det;
        let f = |row: usize, col: usize| (inv[row * 4 + col] * d) as f32;
        Self::new(
            Float4::new(f(0, 0), f(1, 0), f(2, 0), f(3, 0)),
            Float4::new(f(0, 1), f(1, 1), f(2, 1), f(3, 1)),
            Float4::new(f(0, 2), f(1, 2), f(2, 2), f(3, 2)),
            Float4::new(f(0, 3), f(1, 3), f(2, 3), f(3, 3)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_max_nan_rule() {
        assert_eq!(min(1.0f32, f32::NAN), 1.0);
        assert_eq!(max(1.0f32, f32::NAN), 1.0);
        assert_eq!(min(f32::NAN, 1.0), 1.0); // x NaN: x < y is false, so y
        assert_eq!(clamp(5.0f32, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-5.0f32, 0.0, 1.0), 0.0);
        assert_eq!(clamp(7, 0, 3), 3);
        assert_eq!(saturate(2.0), 1.0);
    }

    #[test]
    fn scalar_helpers() {
        assert_eq!(round(0.5), 0.0);
        assert_eq!(round(1.5), 2.0);
        assert_eq!(round(2.5), 2.0);
        assert_eq!(frac(-0.25), 0.75);
        assert_eq!(frac(1.75), 0.75);
        assert_eq!(sign(-3.0), -1.0);
        assert_eq!(sign(0.0), 0.0);
        assert_eq!(sign(f32::NAN), 0.0);
        assert_eq!(lerp(2.0, 4.0, 0.25), 2.5);
        assert_eq!(select(1, 2, true), 2);
        assert_eq!(select(1, 2, false), 1);
        assert_eq!(rsqrt(4.0), 0.5);
        assert_eq!(abs(-0.0).to_bits(), 0);
        assert_eq!(ceilpow2(5), 8);
        assert_eq!(ceilpow2(8), 8);
        assert_eq!(ceilpow2(1), 1);
        assert_eq!(ceilpow2(17), 32);
        assert_eq!(tzcnt(8), 3);
        assert_eq!(tzcnt(0), 32);
        assert!(isfinite(1.0) && !isfinite(f32::INFINITY) && !isfinite(f32::NAN));
    }

    #[test]
    fn vector_helpers() {
        let v = Float3::new(0.0, 3.0, 4.0);
        assert_eq!(v.length(), 5.0);
        assert_eq!(v.distance(Float3::splat(0.0)), 5.0);
        assert_eq!(v.distance_sq(Float3::splat(0.0)), 25.0);
        assert!((v.normalize().length() - 1.0).abs() < 1e-6);
        assert_eq!(Float3::splat(0.0).normalize_safe(Float3::UP), Float3::UP);
        assert_eq!(Float3::new(0.0, 0.0, 1e-30).normalize_safe(Float3::UP), Float3::UP);
        assert_eq!(Float3::new(0.0, 2.0, 0.0).normalize_safe(Float3::FORWARD), Float3::UP);
        assert_eq!(Float3::new(3.0, -1.0, 2.0).cmin(), -1.0);
        assert_eq!(Float3::new(3.0, -1.0, 2.0).cmax(), 3.0);
        assert_eq!(Int3::new(3, 9, 2).cmax(), 9);
        let a = Float3::new(1.0, 2.0, 3.0);
        assert!(a.lt(Float3::new(2.0, 3.0, 4.0)).all());
        assert!(a.gt(Float3::new(2.0, 0.0, 4.0)).any());
        assert!(!a.gt(Float3::new(2.0, 3.0, 4.0)).any());
        assert_eq!(
            Float3::select(a, Float3::splat(9.0), Bool3 { x: true, y: false, z: true }),
            Float3::new(9.0, 2.0, 9.0)
        );
        assert_eq!(Float3::new(0.5, 1.5, -0.5).round(), Float3::new(0.0, 2.0, -0.0));
    }

    #[test]
    fn matrices() {
        let m = Float3x3::new(Float3::new(1.0, 2.0, 3.0), Float3::new(4.0, 5.0, 6.0), Float3::new(7.0, 8.0, 10.0));
        assert_eq!(m.transpose().transpose(), m);
        assert_eq!(m.mul_vec(Float3::new(1.0, 0.0, 0.0)), m.c0);
        assert_eq!(m.mul(Float3x3::IDENTITY), m);
        let t = Float4x4::new(
            Float4::new(2.0, 0.0, 0.0, 0.0),
            Float4::new(0.0, 3.0, 0.0, 0.0),
            Float4::new(0.0, 0.0, 4.0, 0.0),
            Float4::new(1.0, 2.0, 3.0, 1.0),
        );
        assert_eq!(t.transform_point(Float3::new(1.0, 1.0, 1.0)), Float3::new(3.0, 5.0, 7.0));
        let inv = t.inverse();
        let p = Float3::new(0.3, -2.0, 5.0);
        let q = inv.transform_point(t.transform_point(p));
        assert!((q - p).length() < 1e-5);
        let id = t.mul(inv);
        for (a, b) in [(id.c0.x, 1.0), (id.c1.y, 1.0), (id.c2.z, 1.0), (id.c3.w, 1.0), (id.c3.x, 0.0)] {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
