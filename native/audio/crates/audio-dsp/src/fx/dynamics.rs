//! The catalogue's bus dynamics beyond the compressor (ADR 0345): `limiter` (`ceiling` −12..0 dB,
//! `release` 1..1000 ms) and `sidechainCompressor` (`threshold`, `ratio`, `release`, a key bus).
//!
//! - **Limiter:** a stereo-linked peak limiter with no look-ahead (a bus insert must not delay its
//!   bus against its siblings: the mix has no delay compensation): the gain drops at once to what
//!   keeps the frame at the ceiling and recovers with the release as a one-pole, and a final clamp
//!   guarantees nothing passes the ceiling. It reads sample peaks (no oversampling: the
//!   catalogue's "dBTP" is approximated by the sample peak). The master output keeps its own
//!   look-ahead limiter (`limiter.rs`).
//! - **Sidechain compressor:** the key bus's pre-fader level (dB, once per block, measured by the
//!   core where the key is mixed) drives a hard-knee gain computer, `(level − threshold)·(1 −
//!   1/ratio)` dB of reduction above the threshold; the gain follows it per sample with
//!   [`SIDECHAIN_ATTACK_MS`] (falling) and the release (rising) as 63 % one-pole constants.

use super::shape::clamp;

/// The sidechain compressor's attack, ms (the catalogue gives it none; a fast, click-free value).
pub const SIDECHAIN_ATTACK_MS: f32 = 5.0;

/// A one-pole coefficient reaching 63 % in `ms`.
pub fn pole(ms: f32, sample_rate: f32) -> f32 {
    let frames = ms.max(0.01) * sample_rate / 1000.0;
    libm::expf(-1.0 / frames.max(1.0))
}

/// The limiter's state: the gain reduction now (`1 − gain`; all-zero: none).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LimiterState {
    pub reduction: f32,
}

/// One block of the limiter at `ceiling_db` with `release_ms`.
pub fn limit(state: &mut LimiterState, sample_rate: f32, l: &mut [f32], r: &mut [f32], ceiling_db: f32, release_ms: f32) {
    let ceiling = libm::powf(10.0, clamp(ceiling_db, -60.0, 0.0) / 20.0);
    let rel = pole(clamp(release_ms, 1.0, 5_000.0), sample_rate);
    let mut red = if state.reduction.is_finite() { clamp(state.reduction, 0.0, 1.0) } else { 0.0 };
    for (a, b) in l.iter_mut().zip(r.iter_mut()) {
        let peak = a.abs().max(b.abs());
        let need = if peak > ceiling { 1.0 - ceiling / peak } else { 0.0 };
        red = if need > red { need } else { need + (red - need) * rel };
        let g = 1.0 - red;
        *a = clamp_abs(*a * g, ceiling);
        *b = clamp_abs(*b * g, ceiling);
    }
    state.reduction = if red > 1e-9 { red } else { 0.0 };
}

#[inline]
fn clamp_abs(x: f32, c: f32) -> f32 {
    if x > c {
        c
    } else if x < -c {
        -c
    } else if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// The sidechain compressor's state: the gain reduction now, in dB (≥ 0; all-zero: none).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SidechainState {
    pub reduction_db: f32,
}

/// The reduction (dB) a key at `level_db` asks of a compressor at `threshold_db` and `ratio`.
pub fn sidechain_goal(level_db: f32, threshold_db: f32, ratio: f32) -> f32 {
    if !level_db.is_finite() {
        return 0.0;
    }
    let over = level_db - threshold_db;
    if over <= 0.0 {
        0.0
    } else {
        over * (1.0 - 1.0 / clamp(ratio, 1.0, 100.0))
    }
}

/// One block of the sidechain compressor: the key's level `key_db` (NaN: no key, the gain
/// recovers), `threshold_db`, `ratio`, `release_ms`.
pub fn sidechain(state: &mut SidechainState, sample_rate: f32, l: &mut [f32], r: &mut [f32], key_db: f32, threshold_db: f32, ratio: f32, release_ms: f32) {
    let goal = sidechain_goal(key_db, threshold_db, ratio);
    let att = pole(SIDECHAIN_ATTACK_MS, sample_rate);
    let rel = pole(clamp(release_ms, 1.0, 5_000.0), sample_rate);
    let mut red = if state.reduction_db.is_finite() { state.reduction_db.max(0.0) } else { 0.0 };
    if red == 0.0 && goal == 0.0 {
        return;
    }
    let c = if goal > red { att } else { rel };
    // The follower's value at the block's end, exactly; the gain between the block's ends is
    // interpolated linearly (one `pow` a block instead of one a sample: within 0.02 dB).
    let n = l.len().min(r.len());
    let end = goal + (red - goal) * libm::powf(c, n as f32);
    let (g0, g1) = (libm::powf(10.0, -red / 20.0), libm::powf(10.0, -end / 20.0));
    super::ramp_gain(l, r, g0, g1);
    red = end;
    state.reduction_db = if red > 1e-3 { red } else { 0.0 };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limiter_holds_the_ceiling_and_recovers() {
        let sr = 48_000.0;
        let mut s = LimiterState::default();
        let (mut l, mut r) = ([2.0f32; 128], [-1.5f32; 128]);
        limit(&mut s, sr, &mut l, &mut r, -6.0, 50.0);
        let c = libm::powf(10.0, -6.0 / 20.0);
        assert!(l.iter().chain(r.iter()).all(|x| x.abs() <= c + 1e-6));
        assert!(s.reduction > 0.5);
        for _ in 0..200 {
            let (mut l, mut r) = ([0.1f32; 128], [0.1f32; 128]);
            limit(&mut s, sr, &mut l, &mut r, -6.0, 50.0);
        }
        assert!(s.reduction < 1e-3, "{}", s.reduction);
        let (mut q, mut w) = ([0.2f32; 4], [0.1f32; 4]);
        limit(&mut LimiterState::default(), sr, &mut q, &mut w, 0.0, 50.0);
        assert_eq!((q, w), ([0.2; 4], [0.1; 4]), "under the ceiling: untouched");
    }

    #[test]
    fn the_sidechain_compressor_ducks_by_the_ratio_and_releases() {
        assert_eq!(sidechain_goal(-10.0, -20.0, 2.0), 5.0);
        assert_eq!(sidechain_goal(-30.0, -20.0, 4.0), 0.0);
        assert_eq!(sidechain_goal(f32::NAN, -20.0, 4.0), 0.0);
        let sr = 48_000.0;
        let mut s = SidechainState::default();
        for _ in 0..40 {
            let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
            sidechain(&mut s, sr, &mut l, &mut r, 0.0, -20.0, 4.0, 100.0);
        }
        assert!((s.reduction_db - 15.0).abs() < 0.1, "{}", s.reduction_db);
        for _ in 0..400 {
            let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
            sidechain(&mut s, sr, &mut l, &mut r, f32::NAN, -20.0, 4.0, 100.0);
        }
        assert_eq!(s.reduction_db, 0.0);
    }
}
