//! [`F32x4`]: four `f32` lanes, the SoA lane type.
//!
//! On `wasm32` with `target_feature = "simd128"` it is a `v128` driven by `core::arch::wasm32`
//! (`f32x4_*`, plain SIMD only, never relaxed SIMD). Everywhere else it is a portable `[f32; 4]`
//! whose every operation runs the scalar [`Lane`] implementation lane by lane. Both backends use
//! only correctly rounded or exact IEEE operations, so they give bit-identical results (NaN
//! payloads aside).

use crate::lane::{Lane, LaneMask};
use core::ops::{Add, BitAnd, BitOr, Div, Mul, Neg, Not, Sub};

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod imp {
    use core::arch::wasm32::*;

    /// Four `f32` lanes (`v128`).
    #[derive(Clone, Copy)]
    #[repr(transparent)]
    pub struct F32x4(pub(super) v128);

    /// A per-lane mask: each lane all ones (set) or all zeros (`v128`).
    #[derive(Clone, Copy)]
    #[repr(transparent)]
    pub struct M32x4(pub(super) v128);

    impl F32x4 {
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> Self {
            Self(f32x4(a, b, c, d))
        }
        #[inline(always)]
        pub fn splat(v: f32) -> Self {
            Self(f32x4_splat(v))
        }
        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            [
                f32x4_extract_lane::<0>(self.0),
                f32x4_extract_lane::<1>(self.0),
                f32x4_extract_lane::<2>(self.0),
                f32x4_extract_lane::<3>(self.0),
            ]
        }
        #[inline(always)]
        pub fn from_u32_array(q: [u32; 4]) -> Self {
            Self(f32x4_convert_u32x4(u32x4(q[0], q[1], q[2], q[3])))
        }
        /// Lane `i & 3`.
        #[inline(always)]
        pub fn get_lane(self, i: usize) -> f32 {
            match i & 3 {
                0 => f32x4_extract_lane::<0>(self.0),
                1 => f32x4_extract_lane::<1>(self.0),
                2 => f32x4_extract_lane::<2>(self.0),
                _ => f32x4_extract_lane::<3>(self.0),
            }
        }
        /// These lanes with lane `i & 3` replaced by `v`.
        #[inline(always)]
        pub fn with_lane(self, i: usize, v: f32) -> Self {
            Self(match i & 3 {
                0 => f32x4_replace_lane::<0>(self.0, v),
                1 => f32x4_replace_lane::<1>(self.0, v),
                2 => f32x4_replace_lane::<2>(self.0, v),
                _ => f32x4_replace_lane::<3>(self.0, v),
            })
        }
        #[inline(always)]
        pub(super) fn v_add(self, o: Self) -> Self {
            Self(f32x4_add(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_sub(self, o: Self) -> Self {
            Self(f32x4_sub(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_mul(self, o: Self) -> Self {
            Self(f32x4_mul(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_div(self, o: Self) -> Self {
            Self(f32x4_div(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_neg(self) -> Self {
            Self(f32x4_neg(self.0))
        }
        #[inline(always)]
        pub(super) fn v_sqrt(self) -> Self {
            Self(f32x4_sqrt(self.0))
        }
        #[inline(always)]
        pub(super) fn v_abs(self) -> Self {
            Self(f32x4_abs(self.0))
        }
        #[inline(always)]
        pub(super) fn v_min(self, o: Self) -> Self {
            // pmin(a, b) = b < a ? b : a
            Self(f32x4_pmin(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_max(self, o: Self) -> Self {
            // pmax(a, b) = a < b ? b : a
            Self(f32x4_pmax(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_floor(self) -> Self {
            Self(f32x4_floor(self.0))
        }
        #[inline(always)]
        pub(super) fn v_round_even(self) -> Self {
            Self(f32x4_nearest(self.0))
        }
        #[inline(always)]
        pub(super) fn v_lt(self, o: Self) -> M32x4 {
            M32x4(f32x4_lt(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_le(self, o: Self) -> M32x4 {
            M32x4(f32x4_le(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_gt(self, o: Self) -> M32x4 {
            M32x4(f32x4_gt(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_ge(self, o: Self) -> M32x4 {
            M32x4(f32x4_ge(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_eq(self, o: Self) -> M32x4 {
            M32x4(f32x4_eq(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_select(m: M32x4, a: Self, b: Self) -> Self {
            Self(v128_bitselect(a.0, b.0, m.0))
        }
    }

    impl M32x4 {
        #[inline(always)]
        pub fn any(self) -> bool {
            v128_any_true(self.0)
        }
        #[inline(always)]
        pub fn all(self) -> bool {
            i32x4_all_true(self.0)
        }
        #[inline(always)]
        pub fn to_array(self) -> [bool; 4] {
            [
                u32x4_extract_lane::<0>(self.0) != 0,
                u32x4_extract_lane::<1>(self.0) != 0,
                u32x4_extract_lane::<2>(self.0) != 0,
                u32x4_extract_lane::<3>(self.0) != 0,
            ]
        }
        #[inline(always)]
        pub(super) fn v_and(self, o: Self) -> Self {
            Self(v128_and(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_or(self, o: Self) -> Self {
            Self(v128_or(self.0, o.0))
        }
        #[inline(always)]
        pub(super) fn v_not(self) -> Self {
            Self(v128_not(self.0))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod imp {
    use crate::lane::Lane;

    /// Four `f32` lanes (portable fallback, `[f32; 4]`).
    #[derive(Clone, Copy)]
    #[repr(C, align(16))]
    pub struct F32x4(pub(super) [f32; 4]);

    /// A per-lane mask: each lane `u32::MAX` (set) or `0` (portable fallback).
    #[derive(Clone, Copy)]
    #[repr(C, align(16))]
    pub struct M32x4(pub(super) [u32; 4]);

    #[inline(always)]
    fn map(a: [f32; 4], f: impl Fn(f32) -> f32) -> [f32; 4] {
        [f(a[0]), f(a[1]), f(a[2]), f(a[3])]
    }
    #[inline(always)]
    fn zip(a: [f32; 4], b: [f32; 4], f: impl Fn(f32, f32) -> f32) -> [f32; 4] {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }
    #[inline(always)]
    fn cmp(a: [f32; 4], b: [f32; 4], f: impl Fn(f32, f32) -> bool) -> M32x4 {
        let m = |x: bool| if x { u32::MAX } else { 0 };
        M32x4([
            m(f(a[0], b[0])),
            m(f(a[1], b[1])),
            m(f(a[2], b[2])),
            m(f(a[3], b[3])),
        ])
    }

    impl F32x4 {
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> Self {
            Self([a, b, c, d])
        }
        #[inline(always)]
        pub fn splat(v: f32) -> Self {
            Self([v; 4])
        }
        #[inline(always)]
        pub fn to_array(self) -> [f32; 4] {
            self.0
        }
        #[inline(always)]
        pub fn from_u32_array(q: [u32; 4]) -> Self {
            // `as f32` rounds to nearest-even, as wasm `f32x4.convert_i32x4_u` does.
            Self([q[0] as f32, q[1] as f32, q[2] as f32, q[3] as f32])
        }
        /// Lane `i & 3`.
        #[inline(always)]
        pub fn get_lane(self, i: usize) -> f32 {
            self.0[i & 3]
        }
        /// These lanes with lane `i & 3` replaced by `v`.
        #[inline(always)]
        pub fn with_lane(mut self, i: usize, v: f32) -> Self {
            self.0[i & 3] = v;
            self
        }
        #[inline(always)]
        pub(super) fn v_add(self, o: Self) -> Self {
            Self(zip(self.0, o.0, |a, b| a + b))
        }
        #[inline(always)]
        pub(super) fn v_sub(self, o: Self) -> Self {
            Self(zip(self.0, o.0, |a, b| a - b))
        }
        #[inline(always)]
        pub(super) fn v_mul(self, o: Self) -> Self {
            Self(zip(self.0, o.0, |a, b| a * b))
        }
        #[inline(always)]
        pub(super) fn v_div(self, o: Self) -> Self {
            Self(zip(self.0, o.0, |a, b| a / b))
        }
        #[inline(always)]
        pub(super) fn v_neg(self) -> Self {
            Self(map(self.0, |a| -a))
        }
        #[inline(always)]
        pub(super) fn v_sqrt(self) -> Self {
            Self(map(self.0, Lane::sqrt))
        }
        #[inline(always)]
        pub(super) fn v_abs(self) -> Self {
            Self(map(self.0, Lane::abs))
        }
        #[inline(always)]
        pub(super) fn v_min(self, o: Self) -> Self {
            Self(zip(self.0, o.0, Lane::min))
        }
        #[inline(always)]
        pub(super) fn v_max(self, o: Self) -> Self {
            Self(zip(self.0, o.0, Lane::max))
        }
        #[inline(always)]
        pub(super) fn v_floor(self) -> Self {
            Self(map(self.0, Lane::floor))
        }
        #[inline(always)]
        pub(super) fn v_round_even(self) -> Self {
            Self(map(self.0, Lane::round_even))
        }
        #[inline(always)]
        pub(super) fn v_lt(self, o: Self) -> M32x4 {
            cmp(self.0, o.0, |a, b| a < b)
        }
        #[inline(always)]
        pub(super) fn v_le(self, o: Self) -> M32x4 {
            cmp(self.0, o.0, |a, b| a <= b)
        }
        #[inline(always)]
        pub(super) fn v_gt(self, o: Self) -> M32x4 {
            cmp(self.0, o.0, |a, b| a > b)
        }
        #[inline(always)]
        pub(super) fn v_ge(self, o: Self) -> M32x4 {
            cmp(self.0, o.0, |a, b| a >= b)
        }
        #[inline(always)]
        pub(super) fn v_eq(self, o: Self) -> M32x4 {
            cmp(self.0, o.0, |a, b| a == b)
        }
        #[inline(always)]
        pub(super) fn v_select(m: M32x4, a: Self, b: Self) -> Self {
            // Bitwise, as v128.bitselect.
            let s = |i: usize| {
                f32::from_bits((a.0[i].to_bits() & m.0[i]) | (b.0[i].to_bits() & !m.0[i]))
            };
            Self([s(0), s(1), s(2), s(3)])
        }
    }

    impl M32x4 {
        #[inline(always)]
        pub fn any(self) -> bool {
            (self.0[0] | self.0[1] | self.0[2] | self.0[3]) != 0
        }
        #[inline(always)]
        pub fn all(self) -> bool {
            self.0[0] != 0 && self.0[1] != 0 && self.0[2] != 0 && self.0[3] != 0
        }
        #[inline(always)]
        pub fn to_array(self) -> [bool; 4] {
            [
                self.0[0] != 0,
                self.0[1] != 0,
                self.0[2] != 0,
                self.0[3] != 0,
            ]
        }
        #[inline(always)]
        pub(super) fn v_and(self, o: Self) -> Self {
            Self([
                self.0[0] & o.0[0],
                self.0[1] & o.0[1],
                self.0[2] & o.0[2],
                self.0[3] & o.0[3],
            ])
        }
        #[inline(always)]
        pub(super) fn v_or(self, o: Self) -> Self {
            Self([
                self.0[0] | o.0[0],
                self.0[1] | o.0[1],
                self.0[2] | o.0[2],
                self.0[3] | o.0[3],
            ])
        }
        #[inline(always)]
        pub(super) fn v_not(self) -> Self {
            Self([!self.0[0], !self.0[1], !self.0[2], !self.0[3]])
        }
    }
}

pub use imp::{F32x4, M32x4};

impl F32x4 {
    /// Lanes from an array (lane 0 first).
    #[inline(always)]
    pub fn from_array(a: [f32; 4]) -> Self {
        Self::new(a[0], a[1], a[2], a[3])
    }

    /// The lanes as raw IEEE bits, for exact comparisons.
    #[inline(always)]
    pub fn to_bits_array(self) -> [u32; 4] {
        let a = self.to_array();
        [
            a[0].to_bits(),
            a[1].to_bits(),
            a[2].to_bits(),
            a[3].to_bits(),
        ]
    }
}

impl core::fmt::Debug for F32x4 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "F32x4{:?}", self.to_array())
    }
}

impl core::fmt::Debug for M32x4 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "M32x4{:?}", self.to_array())
    }
}

impl Add for F32x4 {
    type Output = Self;
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        imp::F32x4::v_add(self, o)
    }
}
impl Sub for F32x4 {
    type Output = Self;
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        imp::F32x4::v_sub(self, o)
    }
}
impl Mul for F32x4 {
    type Output = Self;
    #[inline(always)]
    fn mul(self, o: Self) -> Self {
        imp::F32x4::v_mul(self, o)
    }
}
impl Div for F32x4 {
    type Output = Self;
    #[inline(always)]
    fn div(self, o: Self) -> Self {
        imp::F32x4::v_div(self, o)
    }
}
impl Neg for F32x4 {
    type Output = Self;
    #[inline(always)]
    fn neg(self) -> Self {
        imp::F32x4::v_neg(self)
    }
}

impl BitAnd for M32x4 {
    type Output = Self;
    #[inline(always)]
    fn bitand(self, o: Self) -> Self {
        self.v_and(o)
    }
}
impl BitOr for M32x4 {
    type Output = Self;
    #[inline(always)]
    fn bitor(self, o: Self) -> Self {
        self.v_or(o)
    }
}
impl Not for M32x4 {
    type Output = Self;
    #[inline(always)]
    fn not(self) -> Self {
        M32x4::v_not(self)
    }
}
impl LaneMask for M32x4 {
    #[inline(always)]
    fn any(self) -> bool {
        M32x4::any(self)
    }
}

impl Lane for F32x4 {
    type Mask = M32x4;

    #[inline(always)]
    fn splat(v: f32) -> Self {
        F32x4::splat(v)
    }
    #[inline(always)]
    fn sqrt(self) -> Self {
        imp::F32x4::v_sqrt(self)
    }
    #[inline(always)]
    fn abs(self) -> Self {
        imp::F32x4::v_abs(self)
    }
    #[inline(always)]
    fn min(self, o: Self) -> Self {
        imp::F32x4::v_min(self, o)
    }
    #[inline(always)]
    fn max(self, o: Self) -> Self {
        imp::F32x4::v_max(self, o)
    }
    #[inline(always)]
    fn floor(self) -> Self {
        imp::F32x4::v_floor(self)
    }
    #[inline(always)]
    fn round_even(self) -> Self {
        imp::F32x4::v_round_even(self)
    }
    #[inline(always)]
    fn lt(self, o: Self) -> M32x4 {
        imp::F32x4::v_lt(self, o)
    }
    #[inline(always)]
    fn le(self, o: Self) -> M32x4 {
        imp::F32x4::v_le(self, o)
    }
    #[inline(always)]
    fn gt(self, o: Self) -> M32x4 {
        imp::F32x4::v_gt(self, o)
    }
    #[inline(always)]
    fn ge(self, o: Self) -> M32x4 {
        imp::F32x4::v_ge(self, o)
    }
    #[inline(always)]
    fn eq(self, o: Self) -> M32x4 {
        imp::F32x4::v_eq(self, o)
    }
    #[inline(always)]
    fn select(m: M32x4, a: Self, b: Self) -> Self {
        imp::F32x4::v_select(m, a, b)
    }
}
