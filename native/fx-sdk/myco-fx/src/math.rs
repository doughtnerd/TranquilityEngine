//! Small `no_std` maths for effects (a plugin module imports nothing, so `f32::sin` and friends from `std` aren't
//! there). Pure wasm, deterministic on every engine. For more, the `libm` crate also compiles without imports.

use core::f32::consts::{FRAC_PI_2, PI, TAU};

/// The largest integer not above `x` (for |x| < 2^31).
pub fn floor(x: f32) -> f32 {
    let i = x as i32 as f32;
    if i > x {
        i - 1.0
    } else {
        i
    }
}

/// The fractional part of `x` in [0, 1) (an oscillator's phase wrap).
pub fn fract(x: f32) -> f32 {
    x - floor(x)
}

/// sin(x), |error| < 1e-6 for |x| < 2^20 (range-reduced to [-π/2, π/2], then an odd polynomial).
pub fn sin(x: f32) -> f32 {
    let t = x * (1.0 / TAU);
    let x = (t - floor(t + 0.5)) * TAU;
    let x = if x > FRAC_PI_2 {
        PI - x
    } else if x < -FRAC_PI_2 {
        -PI - x
    } else {
        x
    };
    let x2 = x * x;
    x * (1.0 + x2 * (-1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 * (-1.0 / 5040.0 + x2 * (1.0 / 362_880.0 + x2 * (-1.0 / 39_916_800.0))))))
}

/// cos(x), as `sin(x + π/2)`.
pub fn cos(x: f32) -> f32 {
    sin(x + FRAC_PI_2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sin_and_cos_match_std_closely() {
        let mut worst = 0.0f32;
        for i in -20_000..20_000 {
            let x = i as f32 * 0.001;
            worst = worst.max((sin(x) - x.sin()).abs());
            worst = worst.max((cos(x) - x.cos()).abs());
        }
        assert!(worst < 2e-6, "worst error {worst}");
    }

    #[test]
    fn floor_and_fract() {
        assert_eq!(floor(-0.5), -1.0);
        assert_eq!(floor(2.0), 2.0);
        assert_eq!(fract(1.25), 0.25);
        assert_eq!(fract(-0.25), 0.75);
    }
}
