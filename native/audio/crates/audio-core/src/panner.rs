//! Per-voice panner state (contract K11; architecture §2.4).
//!
//! Every voice pans through a [`PannerState`] here, as the last per-voice stage before the bus.
//! The panner takes the voice's listener-space unit direction (C5: forward is -Z, up is +Y, right
//! is +X, as Web Audio's default listener) and turns it into a 2×2 matrix from the voice's
//! (left, right) samples to the output's (left, right):
//!
//! ```text
//! outL += a·inL + b·inR        outR += c·inL + d·inR
//! ```
//!
//! For a mono clip the resampler copies channel 0 to `inR`, and `b = d = 0`.
//! - **Non-spatial** voices use no panner: the identity (`a = d = 1`, `b = c = 0`), so a mono clip
//!   plays at full level in both channels, as Web Audio up-mixes mono to stereo.
//! - **Equal-power** (kind 0): Blink's `EqualPowerPanner` gains (`audio_dsp::pan`) for the
//!   direction's azimuth. Mono: `a = gainL, c = gainR`. Stereo, azimuth ≤ 0: `a = 1, b = gainL,
//!   d = gainR`; azimuth > 0: `a = gainL, c = gainR, d = 1`, exactly Blink's `Pan`.
//! - **HRTF** (kind 1): not yet. Voices asking for it pan equal-power. H3 adds the HRTF path and the
//!   45 ms crossfade between kinds inside this file (and nowhere else).
//!
//! A direction change from SET_PARAMS ramps the four coefficients linearly over its `rampFrames`
//! (Blink's panner jumps per quantum; ramping the matrix is click-free and lands on Blink's values,
//! and it stays continuous when a stereo source crosses azimuth 0). PLAY sets the matrix at once.
//!
//! All-zero is a valid `PannerState` (a silent matrix); PLAY always sets it. Nothing allocates.

use audio_dsp::pan::EqualPowerPanner;
use audio_dsp::ramp::Ramp;

/// Panner kinds (the PLAY / SET_PARAMS `flags` bits 5–6, api-and-models §4.2).
pub mod kind {
    pub const EQUAL_POWER: u8 = 0;
    pub const HRTF: u8 = 1;
}

/// One voice's panner.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PannerState {
    /// The kind asked for ([`kind`]); only equal-power renders until H3.
    pub kind: u8,
    /// Non-zero for a spatial voice (PLAY flag bit4); otherwise the matrix is the identity.
    pub spatial: u8,
    /// The clip's channels, 1 or 2 (the matrix depends on it).
    pub channels: u8,
    pub reserved: u8,
    /// The listener-space direction last set.
    pub dir: [f32; 3],
    /// `a, b, c, d`, each ramping to its target.
    pub matrix: [Ramp; 4],
}

impl PannerState {
    /// Sets everything at once, with no ramp (PLAY: "a clip starts at its gain").
    pub fn start(&mut self, spatial: bool, kind: u8, dir: [f32; 3], channels: u32) {
        self.kind = kind;
        self.spatial = spatial as u8;
        self.channels = channels.clamp(1, 2) as u8;
        self.dir = dir;
        let m = matrix(spatial, kind, dir, channels);
        for (ramp, value) in self.matrix.iter_mut().zip(m) {
            *ramp = Ramp::at(value);
        }
    }

    /// A new direction (SET_PARAMS mask bit2): the matrix ramps to it over `ramp_frames`.
    pub fn set_direction(&mut self, dir: [f32; 3], ramp_frames: u32) {
        self.dir = dir;
        let m = matrix(self.spatial != 0, self.kind, dir, self.channels as u32);
        for (ramp, value) in self.matrix.iter_mut().zip(m) {
            ramp.set_target(value, ramp_frames);
        }
    }

    /// A new kind (SET_PARAMS mask bit6). Equal-power only until H3, so the matrix doesn't change.
    pub fn set_kind(&mut self, kind: u8) {
        self.kind = kind;
    }

    /// Accumulates `frames` frames of the voice's `(in_l, in_r)` into `(out_l, out_r)` through the
    /// ramping matrix (all four slices at least `in_l.len()` long).
    pub fn mix(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = in_l.len();
        let (in_r, out_l, out_r) = (&in_r[..n], &mut out_l[..n], &mut out_r[..n]);
        if self.matrix.iter().all(|r| r.is_settled()) {
            let [a, b, c, d] = [self.matrix[0].value, self.matrix[1].value, self.matrix[2].value, self.matrix[3].value];
            for i in 0..n {
                out_l[i] += a * in_l[i] + b * in_r[i];
                out_r[i] += c * in_l[i] + d * in_r[i];
            }
            return;
        }
        for i in 0..n {
            let a = self.matrix[0].next();
            let b = self.matrix[1].next();
            let c = self.matrix[2].next();
            let d = self.matrix[3].next();
            out_l[i] += a * in_l[i] + b * in_r[i];
            out_r[i] += c * in_l[i] + d * in_r[i];
        }
    }

    /// Moves the matrix ramps on by `frames` without rendering (virtual voices).
    pub fn advance(&mut self, frames: u32) {
        for ramp in self.matrix.iter_mut() {
            ramp.advance(frames);
        }
    }
}

/// The azimuth in degrees (-180..180, 0 ahead, +90 right) of a listener-space direction, by the Web
/// Audio spec's azimuth algorithm for a listener at the origin facing -Z with +Y up (the same
/// arithmetic as Blink's `PannerHandler::CalculateAzimuthElevation`): project onto the horizontal
/// plane, take the angle from the right vector with `acos`, mirror it when the source is behind,
/// then make it relative to the front. A zero or vertical direction gives 0. Uses `libm`.
pub fn azimuth(dir: [f32; 3]) -> f64 {
    let (x, z) = (dir[0] as f64, dir[2] as f64);
    if !(x.is_finite() && z.is_finite()) {
        return 0.0;
    }
    // Removing the up component leaves (x, 0, z); normalise it.
    let len = libm::sqrt(x * x + z * z);
    if len == 0.0 {
        return 0.0;
    }
    let (px, pz) = (x / len, z / len);
    // Angle from the right vector (1, 0, 0).
    let mut az = libm::acos(px.clamp(-1.0, 1.0)).to_degrees();
    // Behind the listener: the projection on forward (0, 0, -1) is negative.
    if -pz < 0.0 {
        az = 360.0 - az;
    }
    // Relative to the front, not the right.
    if (0.0..=270.0).contains(&az) {
        90.0 - az
    } else {
        450.0 - az
    }
}

/// The matrix targets `[a, b, c, d]` for a voice (see the module comment).
pub fn matrix(spatial: bool, kind: u8, dir: [f32; 3], channels: u32) -> [f32; 4] {
    // Equal-power for every kind until H3 (HRTF voices pan equal-power until then).
    let _ = kind;
    if !spatial {
        return [1.0, 0.0, 0.0, 1.0];
    }
    let mut panner = EqualPowerPanner::default();
    let stereo = channels >= 2;
    let az = panner.update_desired_gain(azimuth(dir), if stereo { 2 } else { 1 });
    let (gl, gr) = panner.desired_gains();
    let (gl, gr) = (gl as f32, gr as f32);
    if !stereo {
        [gl, 0.0, gr, 0.0]
    } else if az <= 0.0 {
        [1.0, gl, 0.0, gr]
    } else {
        [gl, 0.0, gr, 1.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn azimuth_of_the_cardinal_directions() {
        assert!(close(azimuth([0.0, 0.0, -1.0]), 0.0));
        assert!(close(azimuth([1.0, 0.0, 0.0]), 90.0));
        assert!(close(azimuth([-1.0, 0.0, 0.0]), -90.0));
        assert!(close(azimuth([0.0, 0.0, 1.0]).abs(), 180.0));
        assert!(close(azimuth([1.0, 0.0, 1.0]), 135.0));
        assert!(close(azimuth([-1.0, 0.0, 1.0]), -135.0));
        assert!((azimuth([0.5, 0.0, -0.866_025_4]) - 30.0).abs() < 1e-4);
        assert_eq!(azimuth([0.0, 1.0, 0.0]), 0.0, "straight up");
        assert_eq!(azimuth([0.0, 0.0, 0.0]), 0.0, "zero");
        assert_eq!(azimuth([f32::NAN, 0.0, -1.0]), 0.0, "not finite");
    }

    #[test]
    fn non_spatial_voices_use_the_identity() {
        assert_eq!(matrix(false, kind::EQUAL_POWER, [1.0, 0.0, 0.0], 1), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(matrix(false, kind::HRTF, [1.0, 0.0, 0.0], 2), [1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn spatial_mono_matches_blinks_gains() {
        let m = matrix(true, kind::EQUAL_POWER, [0.0, 0.0, -1.0], 1);
        assert!((m[0] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7 && (m[2] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-7);
        assert_eq!((m[1], m[3]), (0.0, 0.0));
        let m = matrix(true, kind::EQUAL_POWER, [-1.0, 0.0, 0.0], 1);
        assert_eq!(m, [1.0, 0.0, 0.0, 0.0]);
        let m = matrix(true, kind::EQUAL_POWER, [0.5, 0.0, -0.866_025_4], 1);
        assert!((m[0] - 0.5).abs() < 1e-5 && (m[2] - 0.866_025_4).abs() < 1e-5);
        // Stereo: left of centre keeps L and pans R into both; right of centre the mirror.
        let m = matrix(true, kind::EQUAL_POWER, [-1.0, 0.0, -1.0], 2);
        assert_eq!((m[0], m[2]), (1.0, 0.0));
        assert!((m[1] - core::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        let m = matrix(true, kind::EQUAL_POWER, [1.0, 0.0, -1.0], 2);
        assert_eq!((m[1], m[3]), (0.0, 1.0));
    }

    #[test]
    fn a_direction_change_ramps_the_matrix() {
        let mut p = PannerState::default();
        p.start(true, kind::EQUAL_POWER, [-1.0, 0.0, 0.0], 1);
        p.set_direction([1.0, 0.0, 0.0], 4);
        let input = [1.0f32; 4];
        let (mut l, mut r) = ([0.0f32; 4], [0.0f32; 4]);
        p.mix(&input, &input, &mut l, &mut r);
        assert!(l.windows(2).all(|w| w[1] <= w[0]) && r.windows(2).all(|w| w[1] >= w[0]));
        assert!(l[3].abs() < 1e-6 && (r[3] - 1.0).abs() < 1e-6, "lands on the target");
        assert!((r[0] - 0.25).abs() < 1e-6, "moves on the first frame");
    }
}
