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
        let _ = (spatial, kind, dir, channels);
        todo!("A1.2-core")
    }

    /// A new direction (SET_PARAMS mask bit2): the matrix ramps to it over `ramp_frames`.
    pub fn set_direction(&mut self, dir: [f32; 3], ramp_frames: u32) {
        let _ = (dir, ramp_frames);
        todo!("A1.2-core")
    }

    /// A new kind (SET_PARAMS mask bit6). Equal-power only until H3, so the matrix doesn't change.
    pub fn set_kind(&mut self, kind: u8) {
        let _ = kind;
        todo!("A1.2-core")
    }

    /// Accumulates `frames` frames of the voice's `(in_l, in_r)` into `(out_l, out_r)` through the
    /// ramping matrix (all four slices at least `in_l.len()` long).
    pub fn mix(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let _ = (in_l, in_r, out_l, out_r);
        todo!("A1.2-core")
    }

    /// Moves the matrix ramps on by `frames` without rendering (virtual voices).
    pub fn advance(&mut self, frames: u32) {
        let _ = frames;
        todo!("A1.2-core")
    }
}

/// The azimuth in degrees (-180..180, 0 ahead, +90 right) of a listener-space direction, by the Web
/// Audio spec's azimuth algorithm for a listener at the origin facing -Z with +Y up (the same
/// arithmetic as Blink's `PannerHandler::CalculateAzimuthElevation`): project onto the horizontal
/// plane, take the angle from the right vector with `acos`, mirror it when the source is behind,
/// then make it relative to the front. A zero or vertical direction gives 0. Uses `libm`.
pub fn azimuth(dir: [f32; 3]) -> f64 {
    let _ = dir;
    todo!("A1.2-core")
}

/// The matrix targets `[a, b, c, d]` for a voice (see the module comment).
pub fn matrix(spatial: bool, kind: u8, dir: [f32; 3], channels: u32) -> [f32; 4] {
    let _ = (spatial, kind, dir, channels);
    todo!("A1.2-core")
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "A1.2-core"]
    fn azimuth_of_the_cardinal_directions() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn non_spatial_voices_use_the_identity() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn spatial_mono_matches_blinks_gains() {}

    #[test]
    #[ignore = "A1.2-core"]
    fn a_direction_change_ramps_the_matrix() {}
}
