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
//! Owner: **Z2b** (generator, table, interpolation, tests). Q1 left the shape and the signatures;
//! leaf **L-Z2ba** fills the stubs tagged `L-Z2ba` and un-ignores the tests below.

/// Points in the quarter-sine table (the wire's `FADE_CURVE_TABLE_POINTS`, api-and-models §4.5;
/// `audio-core` asserts the two agree).
pub const FADE_CURVE_TABLE_POINTS: usize = 1_024;

/// `sin(π/2 · i / (N − 1))`, `i` in `0..N` (see the module comment).
// L-Z2ba: replace the zeros with the table `cargo run -p gen-equal-power` prints.
pub static QUARTER_SINE: [f32; FADE_CURVE_TABLE_POINTS] = [0.0; FADE_CURVE_TABLE_POINTS];

/// `sin(u·π/2)` for `u` in `[0, 1]` (clamped), by linear interpolation in [`QUARTER_SINE`]:
/// `x = u·(N − 1)`, `i = floor(x)` (at most `N − 2`), `t = x − i`, `T[i] + t·(T[i + 1] − T[i])`.
/// Control rate only. `sin_quarter(0) == 0`, `sin_quarter(1) == 1` exactly.
#[inline]
pub fn sin_quarter(u: f32) -> f32 {
    // L-Z2ba: the interpolated read. Inert until then (nothing calls it before Z2b).
    let _ = u;
    0.0
}

/// `cos(u·π/2)` for `u` in `[0, 1]` (clamped): `sin_quarter(1 − u)`, so `sin_quarter(u)² +
/// cos_quarter(u)²` is 1 to within the table error (power-complementary crossfades).
#[inline]
pub fn cos_quarter(u: f32) -> f32 {
    // L-Z2ba: `sin_quarter(1.0 - u)` once the table is in.
    let _ = u;
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interpolated table's error against `sin(u·π/2)` in f64. Spike S4 quoted 3.6e-7; the lead
    /// measured 3.522e-7 for this exact formulation on a 1,000,001-point grid of `u` (Z2b, W3).
    const TABLE_ERROR: f64 = 3.6e-7;
    /// The lead's measured `sin_quarter(u)² + cos_quarter(u)² − 1` bound on the same grid: 8.0e-7.
    const POWER_ERROR: f64 = 1e-6;

    fn exact_sin(u: f32) -> f64 {
        libm::sin(core::f64::consts::FRAC_PI_2 * u as f64)
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn the_table_is_the_rounded_quarter_sine() {
        for (i, &t) in QUARTER_SINE.iter().enumerate() {
            let x = core::f64::consts::FRAC_PI_2 * i as f64 / (FADE_CURVE_TABLE_POINTS - 1) as f64;
            assert_eq!(t.to_bits(), (libm::sin(x) as f32).to_bits(), "point {i}");
        }
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn both_ends_of_the_table_and_the_reads_are_exact() {
        assert_eq!(QUARTER_SINE[0], 0.0);
        assert_eq!(QUARTER_SINE[FADE_CURVE_TABLE_POINTS - 1], 1.0);
        assert_eq!(sin_quarter(0.0), 0.0);
        assert_eq!(sin_quarter(1.0), 1.0);
        assert_eq!(cos_quarter(0.0), 1.0);
        assert_eq!(cos_quarter(1.0), 0.0);
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn reads_clamp_outside_the_unit_interval() {
        assert_eq!(sin_quarter(-0.5), 0.0);
        assert_eq!(sin_quarter(2.0), 1.0);
        assert_eq!(cos_quarter(-0.5), 1.0);
        assert_eq!(cos_quarter(2.0), 0.0);
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn the_interpolated_read_is_within_the_table_error() {
        let steps = 1_000_000u32;
        let mut max = 0.0f64;
        for k in 0..=steps {
            let u = k as f32 / steps as f32;
            max = max.max((sin_quarter(u) as f64 - exact_sin(u)).abs());
        }
        assert!(max <= TABLE_ERROR, "max error {max:e}");
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn sin_and_cos_are_power_complementary() {
        let steps = 1_000_000u32;
        let mut max = 0.0f64;
        for k in 0..=steps {
            let u = k as f32 / steps as f32;
            let (s, c) = (sin_quarter(u) as f64, cos_quarter(u) as f64);
            max = max.max((s * s + c * c - 1.0).abs());
        }
        assert!(max <= POWER_ERROR, "max power error {max:e}");
    }

    #[test]
    #[ignore = "L-Z2ba"]
    fn sin_quarter_is_monotone() {
        let mut last = 0.0f32;
        for k in 0..=100_000u32 {
            let s = sin_quarter(k as f32 / 100_000.0);
            assert!(s >= last, "step {k}");
            last = s;
        }
    }
}
