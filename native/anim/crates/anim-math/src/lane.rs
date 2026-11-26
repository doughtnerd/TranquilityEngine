//! The lane abstraction: every formula in this crate is written once over [`Lane`], so the scalar
//! AoS path (`f32`) and the 4-lane SoA path ([`F32x4`](crate::F32x4)) run the same operations in
//! the same order and give bit-identical results lane for lane.
//!
//! Only IEEE-754 operations that are correctly rounded (add, sub, mul, div, sqrt) or exact (neg,
//! abs, floor, round-to-even, compare, select) appear here. There is no fused multiply-add and no
//! libm call, so results don't depend on the target.

use core::ops::{Add, BitAnd, BitOr, Div, Mul, Neg, Not, Sub};

/// A comparison result for one or more lanes (`bool` for `f32`, a lane mask for `F32x4`).
pub trait LaneMask:
    Copy + BitAnd<Output = Self> + BitOr<Output = Self> + Not<Output = Self>
{
    /// Whether any lane is set.
    fn any(self) -> bool;
}

impl LaneMask for bool {
    #[inline(always)]
    fn any(self) -> bool {
        self
    }
}

/// One `f32` or four `f32` lanes. Implemented by `f32` and [`F32x4`](crate::F32x4).
///
/// `min` and `max` are the *pseudo* min and max of wasm `f32x4.pmin`/`pmax`: `min(a, b)` is
/// `if b < a { b } else { a }` and `max(a, b)` is `if a < b { b } else { a }`. They differ from
/// `f32::min`/`f32::max` for NaN and signed zeros, and are the same on every backend.
pub trait Lane:
    Copy
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
{
    /// The comparison result type.
    type Mask: LaneMask;

    /// Every lane set to `v`.
    fn splat(v: f32) -> Self;
    /// Correctly rounded square root.
    fn sqrt(self) -> Self;
    /// Clears the sign bit.
    fn abs(self) -> Self;
    /// Pseudo-minimum: `if other < self { other } else { self }`.
    fn min(self, other: Self) -> Self;
    /// Pseudo-maximum: `if self < other { other } else { self }`.
    fn max(self, other: Self) -> Self;
    /// Round toward negative infinity (exact).
    fn floor(self) -> Self;
    /// Round to the nearest integer, ties to even (exact).
    fn round_even(self) -> Self;
    /// `self < other`.
    fn lt(self, other: Self) -> Self::Mask;
    /// `self <= other`.
    fn le(self, other: Self) -> Self::Mask;
    /// `self > other`.
    fn gt(self, other: Self) -> Self::Mask;
    /// `self >= other`.
    fn ge(self, other: Self) -> Self::Mask;
    /// `self == other` (IEEE: `-0 == +0`, NaN never equal).
    fn eq(self, other: Self) -> Self::Mask;
    /// Per lane, `a` where `mask` is set, otherwise `b`.
    fn select(mask: Self::Mask, a: Self, b: Self) -> Self;
}

impl Lane for f32 {
    type Mask = bool;

    #[inline(always)]
    fn splat(v: f32) -> Self {
        v
    }
    #[inline(always)]
    fn sqrt(self) -> Self {
        f32::sqrt(self)
    }
    #[inline(always)]
    fn abs(self) -> Self {
        f32::from_bits(self.to_bits() & 0x7fff_ffff)
    }
    #[inline(always)]
    fn min(self, other: Self) -> Self {
        if other < self {
            other
        } else {
            self
        }
    }
    #[inline(always)]
    fn max(self, other: Self) -> Self {
        if self < other {
            other
        } else {
            self
        }
    }
    #[inline(always)]
    fn floor(self) -> Self {
        f32::floor(self)
    }
    #[inline(always)]
    fn round_even(self) -> Self {
        f32::round_ties_even(self)
    }
    #[inline(always)]
    fn lt(self, other: Self) -> bool {
        self < other
    }
    #[inline(always)]
    fn le(self, other: Self) -> bool {
        self <= other
    }
    #[inline(always)]
    fn gt(self, other: Self) -> bool {
        self > other
    }
    #[inline(always)]
    fn ge(self, other: Self) -> bool {
        self >= other
    }
    #[inline(always)]
    fn eq(self, other: Self) -> bool {
        self == other
    }
    #[inline(always)]
    fn select(mask: bool, a: Self, b: Self) -> Self {
        if mask {
            a
        } else {
            b
        }
    }
}
