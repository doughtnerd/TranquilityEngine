//! S4 (M5): snapshot blending of effect parameters. Three ways to move a biquad bus effect between two settings:
//! - `Step`: today's snapshot low-pass: the parameter ramp is sampled once per quantum and `set_lowpass` recomputes the
//!   coefficients at the quantum boundary (`audio-core/src/fx.rs` `snapshot_lowpass`, `bus.rs` `slot.lp.advance`).
//! - `CoefLerp`: the coefficients of the two end points interpolated linearly per sample across the transition.
//! - `Exact`: the coefficients recomputed from the interpolated parameters at every sample (the reference; costly).
use audio_dsp::biquad::coeffs::{self, Coefficients};

pub const Q: usize = 128;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Lowpass,
    Highpass,
}

pub fn coefs(kind: Kind, rate: f32, hz: f32, q_db: f32) -> Coefficients {
    let c = coeffs::normalize_frequency(rate, hz);
    match kind {
        Kind::Lowpass => coeffs::lowpass(c, q_db as f64),
        Kind::Highpass => coeffs::highpass(c, q_db as f64),
    }
}

/// Direct form I, double history, per-sample coefficients supplied by `c(i)`; one channel.
pub fn run(x: &[f32], hist: &mut [f64; 4], mut c: impl FnMut(usize) -> Coefficients) -> Vec<f32> {
    let [mut x1, mut x2, mut y1, mut y2] = *hist;
    let mut out = Vec::with_capacity(x.len());
    for (i, &s) in x.iter().enumerate() {
        let [b0, b1, b2, a1, a2] = c(i);
        let y = (b0 * s as f64 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) as f32;
        x2 = x1;
        x1 = s as f64;
        y2 = y1;
        y1 = y as f64;
        out.push(y);
    }
    *hist = [x1, x2, y1, y2];
    out
}

/// Frequency at `u` in 0..=1 between `a` and `b`, linear in log2(Hz) (`fxfilter`'s law).
pub fn log_hz(a: f32, b: f32, u: f32) -> f32 {
    a * libm::powf(b / a, u)
}

/// Per-sample coefficient interpolation between two end points.
pub fn lerp_coefs(a: &Coefficients, b: &Coefficients, u: f64) -> Coefficients {
    let mut o = [0.0; 5];
    for i in 0..5 {
        o[i] = a[i] + (b[i] - a[i]) * u;
    }
    o
}
