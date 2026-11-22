//! Unsigned normalised integers ("unorm") of N bits, for compressed tracks (T11).
//!
//! Supported widths: 1–16, 19 and 23 bits ([`is_supported_bits`]). The largest code is
//! `2^N − 1` < 2^24, so every code and `2^N − 1` are exact in an `f32`.
//!
//! - **Unpack** (the runtime path): `code / (2^N − 1)`, one correctly rounded f32 division, so
//!   `0 → 0.0` and `2^N − 1 → 1.0` exactly. [`unpack_range`] maps that into a range as
//!   `min + unorm · extent` (multiply, then add; no fused multiply-add). The AoS and SoA forms run
//!   the same operations and agree bit for bit.
//! - **Pack** (offline, the compressor): computed in f64 and rounded **half up**
//!   (`floor(x · (2^N − 1) + 0.5)`) after clamping to [0, 1]; NaN packs to 0. Packing an unpacked
//!   code gives the same code back for every supported width.

use crate::f32x4::F32x4;
use crate::lane::Lane;

/// Whether `bits` is a supported unorm width (1–16, 19 or 23).
#[inline(always)]
pub const fn is_supported_bits(bits: u32) -> bool {
    matches!(bits, 1..=16 | 19 | 23)
}

/// The largest code of an N-bit unorm: `2^N − 1`.
#[inline(always)]
pub const fn unorm_max(bits: u32) -> u32 {
    debug_assert!(is_supported_bits(bits));
    (1u32 << bits) - 1
}

/// Packs `norm` (clamped to [0, 1], NaN → 0) into an N-bit code, rounding half up.
/// Panics on an unsupported width.
#[inline]
pub fn pack_unorm(norm: f32, bits: u32) -> u32 {
    assert!(is_supported_bits(bits), "unsupported unorm width {bits}");
    let x = norm as f64;
    let x = if x > 0.0 { x.min(1.0) } else { 0.0 }; // also NaN → 0
    (x * unorm_max(bits) as f64 + 0.5).floor() as u32
}

/// Packs `v` from the range `[min, min + extent]`: `pack_unorm((v − min) / extent)`, the
/// normalisation computed in f64. An extent ≤ 0 (a constant track) packs to 0.
#[inline]
pub fn pack_range(v: f32, min: f32, extent: f32, bits: u32) -> u32 {
    assert!(is_supported_bits(bits), "unsupported unorm width {bits}");
    if extent <= 0.0 {
        return 0;
    }
    let norm = (v as f64 - min as f64) / extent as f64;
    let x = if norm > 0.0 { norm.min(1.0) } else { 0.0 };
    (x * unorm_max(bits) as f64 + 0.5).floor() as u32
}

#[inline(always)]
fn unorm<L: Lane>(code: L, bits: u32) -> L {
    code / L::splat(unorm_max(bits) as f32)
}

/// Unpacks an N-bit code to [0, 1]: `code / (2^N − 1)`.
#[inline(always)]
pub fn unpack_unorm(code: u32, bits: u32) -> f32 {
    unorm(code as f32, bits)
}

/// Unpacks an N-bit code into `[min, min + extent]`: `min + unorm · extent`.
#[inline(always)]
pub fn unpack_range(code: u32, bits: u32, min: f32, extent: f32) -> f32 {
    min + unorm(code as f32, bits) * extent
}

/// Four codes of the same width at once (SoA): lane i = `unpack_unorm(codes[i], bits)`.
#[inline(always)]
pub fn unpack_unorm4(codes: [u32; 4], bits: u32) -> F32x4 {
    unorm(F32x4::from_u32_array(codes), bits)
}

/// Four codes into four ranges (SoA): lane i = `unpack_range(codes[i], bits, min[i], extent[i])`.
#[inline(always)]
pub fn unpack_range4(codes: [u32; 4], bits: u32, min: F32x4, extent: F32x4) -> F32x4 {
    min + unorm(F32x4::from_u32_array(codes), bits) * extent
}
