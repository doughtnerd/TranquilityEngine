//! The baked 16 → 2 bed matrix (R9, api-and-models §9): the order-3 decode whose gains best match
//! `EqualPowerPanner`'s mono law, used while the MagLS filters aren't resident and in
//! `audio.spatial: "equalPower"`.
//!
//! Design: least squares of the left-ear gain over two equally weighted sets, a 2,048-point
//! Fibonacci sphere (so elevated directions decode sensibly) and the horizontal circle at 0.25°
//! (where the panner is compared, §9); the target at a direction is the panner's left gain at its
//! azimuth (the projection on the horizontal plane, as the core's azimuth). The right row is the
//! left row mirrored (channels odd in y change sign), so the matrix is exactly symmetric. An order-3
//! projection can't follow the panner's fold at ±90° (a kink in each ear's gain), which is why §9
//! excludes 10° either side of it.

use audio_dsp::pan::EqualPowerPanner;

use crate::linalg::projector;
use crate::sh::{mirror_sign, sh16, CHANNELS};

const SPHERE_POINTS: usize = 2048;
const CIRCLE_POINTS: usize = 1440;

/// `EqualPowerPanner`'s mono `(gain_l, gain_r)` at the engine azimuth `azimuth` (degrees, positive
/// to the right).
pub fn panner_gains(azimuth: f64) -> (f64, f64) {
    let mut p = EqualPowerPanner::new();
    p.update_desired_gain(azimuth, 1);
    p.desired_gains()
}

/// The engine azimuth (degrees) of the AmbiX direction `(x, y)`: the panner's azimuth.
fn engine_azimuth(x: f64, y: f64) -> f64 {
    -libm::atan2(y, x).to_degrees()
}

/// The matrix `[ear][channel]` in `f64`, before rounding.
pub fn design() -> [[f64; CHANNELS]; 2] {
    let mut rows = Vec::with_capacity(SPHERE_POINTS + CIRCLE_POINTS);
    let mut weights = Vec::with_capacity(rows.capacity());
    let mut target = Vec::with_capacity(rows.capacity());
    let golden = core::f64::consts::PI * (3.0 - libm::sqrt(5.0));
    for i in 0..SPHERE_POINTS {
        let z = 1.0 - 2.0 * (i as f64 + 0.5) / SPHERE_POINTS as f64;
        let r = libm::sqrt(1.0 - z * z);
        let (x, y) = (r * libm::cos(golden * i as f64), r * libm::sin(golden * i as f64));
        // With its front-back and up-down mirror images: the target is even in x (the panner folds
        // the back onto the front) and in z (it ignores elevation), so the fit then lies exactly in
        // the channels even in both (ACN 0, 1, 6, 8, 9, 11) instead of leaking grid noise elsewhere.
        for (sx, sz) in [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            rows.push(sh16(sx * x, y, sz * z));
            weights.push(0.25 / SPHERE_POINTS as f64);
            target.push(panner_gains(engine_azimuth(sx * x, y)).0);
        }
    }
    for i in 0..CIRCLE_POINTS {
        let a = 2.0 * core::f64::consts::PI * i as f64 / CIRCLE_POINTS as f64;
        let (x, y) = (libm::cos(a), libm::sin(a));
        rows.push(sh16(x, y, 0.0));
        weights.push(1.0 / CIRCLE_POINTS as f64);
        target.push(panner_gains(engine_azimuth(x, y)).0);
    }
    let p = projector(&rows, &weights, 0.0);
    let mut left = [0.0f64; CHANNELS];
    for (pi, t) in p.iter().zip(&target) {
        for c in 0..CHANNELS {
            left[c] += pi[c] * t;
        }
    }
    let mut right = [0.0f64; CHANNELS];
    for c in 0..CHANNELS {
        right[c] = mirror_sign(c) * left[c];
    }
    [left, right]
}

/// The matrix as `bed_matrix.rs` holds it.
pub fn baked() -> [[f32; CHANNELS]; 2] {
    let m = design();
    let mut out = [[0.0f32; CHANNELS]; 2];
    for ear in 0..2 {
        for c in 0..CHANNELS {
            // Exact zeros stay zero (the fit leaves rounding dust in the channels the target is orthogonal to).
            let v = m[ear][c];
            out[ear][c] = if v.abs() < 1e-9 { 0.0 } else { v as f32 };
        }
    }
    out
}

/// The Rust source of `BED_MATRIX` for `audio-dsp/src/bed_matrix.rs`.
pub fn rust_source(m: &[[f32; CHANNELS]; 2]) -> String {
    let mut s = String::from("pub const BED_MATRIX: [[f32; 16]; 2] = [\n");
    for (ear, name) in ["left", "right"].iter().enumerate() {
        s.push_str(&format!("    // {name}\n    [\n"));
        for c in 0..CHANNELS {
            s.push_str(&format!("        {:?},\n", m[ear][c]));
        }
        s.push_str("    ],\n");
    }
    s.push_str("];\n");
    s
}
