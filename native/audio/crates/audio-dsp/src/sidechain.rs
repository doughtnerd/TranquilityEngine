//! Sidechain kernels for ducking (ADR 0171 amended by 0172 §3.8; architecture §4.6):
//! - the **detector**, per sample: peak (instant attack, 10 ms release) or RMS (10 ms one-pole);
//! - the **gain computer**, per quantum: depth = clamp((level dB − threshold) / 6 dB, 0, 1) and
//!   goal = 1 − depth × (1 − amount), a 6 dB knee;
//! - the **follower**: the duck gain approaches the goal with the rule's attack (falling) and
//!   release (rising) as 63 % one-pole time constants, interpolated per sample (spike S4: within
//!   0.024 dB of a per-sample computer).
//!
//! **Who fills it.** Dp1 (M5-0) may put the follower here for presence mode; Sc1 (M5c) the detector
//! and the gain computer, called from `audio-core`'s `duck.rs`. L-Sc1a filled the detectors
//! (`detect_peak`, `detect_rms`, with `DetectorCoeffs` and `DetectorState`) and `gain_goal`; the
//! follower is not here yet. A detector returns the envelope at the quantum's end (spike S4's
//! `Rule::detect`), in dB, floored at -240 dB.
//!
//! Rules as for every module of this crate: transcendentals through `libm`; nothing allocates.

/// The dB floor: silence reads -240, never -inf or NaN.
const FLOOR_DB: f32 = -240.0;
/// Envelopes under this are flushed to zero (no denormal tails; -300 dB, below the floor).
const FLUSH: f32 = 1e-15;
/// The detectors' time constant: 10 ms to 63 %.
/// The same for the RMS detector's mean square (-300 dB in power).
const FLUSH_MS: f32 = 1e-30;
const TAU_S: f32 = 0.010;

/// Per-rate coefficients, computed once at configure (libm only). Both are the pole of a one-pole
/// (`env = x + pole * (env - x)`), so a 10 ms constant gives `exp(-1 / (0.01 * rate))`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DetectorCoeffs {
    pub peak_release: f32,
    pub rms_alpha: f32,
}

impl DetectorCoeffs {
    pub fn new(rate: f32) -> Self {
        let pole = libm::expf(-1.0 / (TAU_S * rate));
        Self { peak_release: pole, rms_alpha: pole }
    }
}

/// A detector's carried state; all-zero valid (silence). Peak: the linear envelope; RMS: the mean square.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DetectorState {
    pub env: f32,
}

/// Peak detector over one quantum of the trigger's pre-fader stereo signal (max(|l|, |r|) per
/// sample; instant attack, `peak_release` one-pole release); returns the quantum's level in dB
/// (the envelope at the quantum's end; -inf -> -240).
pub fn detect_peak(s: &mut DetectorState, c: &DetectorCoeffs, l: &[f32; 128], r: &[f32; 128]) -> f32 {
    let mut env = s.env;
    for i in 0..128 {
        let x = libm::fabsf(l[i]).max(libm::fabsf(r[i]));
        env = if x > env { x } else { x + c.peak_release * (env - x) };
    }
    if !(env >= FLUSH) {
        env = 0.0; // also catches NaN
    }
    s.env = env;
    if env == 0.0 {
        FLOOR_DB
    } else {
        (20.0 * libm::log10f(env)).max(FLOOR_DB)
    }
}

/// RMS detector: a `rms_alpha` one-pole on the mean of l^2 and r^2; returns 10*log10(ms) at the
/// quantum's end (-240 floor).
pub fn detect_rms(s: &mut DetectorState, c: &DetectorCoeffs, l: &[f32; 128], r: &[f32; 128]) -> f32 {
    let mut env = s.env;
    for i in 0..128 {
        let x = 0.5 * (l[i] * l[i] + r[i] * r[i]);
        env = x + c.rms_alpha * (env - x);
    }
    if !(env >= FLUSH_MS) {
        env = 0.0;
    }
    s.env = env;
    if env == 0.0 {
        FLOOR_DB
    } else {
        (10.0 * libm::log10f(env)).max(FLOOR_DB)
    }
}

/// The gain computer, per quantum: depth = clamp((level_db - threshold_db) / 6, 0, 1);
/// goal = 1 - depth * (1 - amount).
pub fn gain_goal(level_db: f32, threshold_db: f32, amount: f32) -> f32 {
    let depth = ((level_db - threshold_db) / 6.0).clamp(0.0, 1.0);
    // The two ends are exact (1 - 1 * (1 - amount) would round).
    if depth <= 0.0 {
        1.0
    } else if depth >= 1.0 {
        amount
    } else {
        1.0 - depth * (1.0 - amount)
    }
}
