//! The equal-power fade table (0166 M4-0, api-and-models §3.1 "Fade laws", §5; architecture §4.4;
//! rulings R5, R6; spike S4).
//!
//! `equalPowerIn` rises as `sin(u·π/2)` and `equalPowerOut` falls as `cos(u·π/2)`. Neither calls
//! `libm` per sample (S4: `sinf`/`sqrtf` are 4.5× slower in wasm): both read this 1,024-point
//! quarter-sine table with linear interpolation (table error ≤ 3.6e-7), and only at control rate
//! (`curve_laws`, once per quantum and at a record's sample).
//!
//! **Shape (the contract):** [`QUARTER_SINE`]`[i] = sin(π/2 · i / (N − 1))` for `i` in `0..N`,
//! `N =` [`FADE_CURVE_TABLE_POINTS`], rounded to the nearest f32, so `[0] == 0.0` and
//! `[N − 1] == 1.0` exactly and both ends of a fade land on their targets. The table is a
//! checked-in constant written by `native/audio/tools/gen-equal-power/` (no `sin` in a const
//! context) and verified against `libm::sin` (f64) by a test here.
//!
//! Owner: **Z2b** (generator, table, interpolation, tests). Q1 left the shape and the signatures.

/// Points in the quarter-sine table (the wire's `FADE_CURVE_TABLE_POINTS`, api-and-models §4.5;
/// `audio-core` asserts the two agree).
pub const FADE_CURVE_TABLE_POINTS: usize = 1_024;

/// `sin(π/2 · i / (N − 1))`, `i` in `0..N` (see the module comment).
// Z2b: replace the zeros with the generated table (`tools/gen-equal-power/`) and its test.
pub static QUARTER_SINE: [f32; FADE_CURVE_TABLE_POINTS] = [0.0; FADE_CURVE_TABLE_POINTS];

/// `sin(u·π/2)` for `u` in `[0, 1]` (clamped), by linear interpolation in [`QUARTER_SINE`]:
/// `x = u·(N − 1)`, `i = floor(x)` (at most `N − 2`), `t = x − i`, `T[i] + t·(T[i + 1] − T[i])`.
/// Control rate only. `sin_quarter(0) == 0`, `sin_quarter(1) == 1` exactly.
#[inline]
pub fn sin_quarter(u: f32) -> f32 {
    // Z2b: the interpolated read. Inert until then (nothing calls it before Z2b).
    let _ = u;
    0.0
}

/// `cos(u·π/2)` for `u` in `[0, 1]` (clamped): `sin_quarter(1 − u)`, so `sin_quarter(u)² +
/// cos_quarter(u)²` is 1 to within the table error (power-complementary crossfades).
#[inline]
pub fn cos_quarter(u: f32) -> f32 {
    // Z2b: `sin_quarter(1.0 - u)` once the table is in.
    let _ = u;
    0.0
}
