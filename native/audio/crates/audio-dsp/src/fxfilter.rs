//! Per-voice effect filters (ADR 0162, api-and-models §3.1 and §5.1, architecture §4.1, contracts
//! C17 and S20): a low-pass and a high-pass over [`Biquad`] with log-Hz ramped cut-offs, run on a
//! mixed voice's block before its panner (occlusion and `lpHz` for every voice, the event's static
//! filter, SET_VOICE_FX `hpHz`, and automation's low-pass as a cap, "lowest wins").
//!
//! - **Off thresholds** (S20): a low-pass at or above [`LP_TOP`] (20,000 Hz) is off, and so is a
//!   non-finite or non-positive one; a high-pass at or below [`HP_BOTTOM`] (20 Hz) is off. An off
//!   filter costs a compare and leaves the samples untouched (bit for bit). The bus snapshot keeps
//!   its own threshold (`audio-core`'s `fx::lowpass_on`, below 24,000), which this module doesn't use.
//! - **Ramps** ([`CutoffRamp`]): linear in log2(Hz), so a sweep moves at a constant rate in
//!   octaves, as occlusion's smoothing does; monotone, ending exactly on the target in Hz. While a
//!   ramp runs the coefficients are recomputed every [`UPDATE_FRAMES`] frames; a settled filter
//!   processes its whole block in one kernel call (no extra history flushes, so a settled filter
//!   is bit-identical to one `Biquad` pass over the block).
//! - **Mono once** (C17): [`FxFilter::process`] with `right = None` filters only `left`, on the
//!   biquads' channel-0 history, with the same kernel arithmetic as a stereo pass, so the caller can
//!   copy `left` to `right` afterwards and get exactly what filtering two identical channels gives.
//! - **The cap** (automation's `lpAuto`): with `cap = Some(c)` the low-pass always runs, at
//!   `min(base, c)` where `base` is the low-pass ramp's cut-off, or [`LP_OFF_HZ`] (24,000) while that
//!   ramp is settled off. That is M2's automation low-pass exactly (`audio-core`'s
//!   `voices::auto_filter` before D1), so a voice with a lowpass binding and no `lpHz` renders bit
//!   for bit as it did. The capped low-pass is never primed (M2 started it from zeroed history).
//! - **Switching on** without a cap: a filter that wasn't running is primed as if it had been
//!   passing its input through: each channel's history is set to that channel's first sample of the
//!   block (`x1 = x2 = y1 = y2 = x0`). At the off end points (20 kHz low-pass, 20 Hz high-pass) the
//!   filters are nearly the identity, so turning on there is seamless. Switching off happens when a
//!   ramp settles at its off end point.
//! - **Running state** is the biquad's own `last[0]` (its kind: 0 none, 1 lowpass, 2 highpass,
//!   `Biquad`'s documented contract): a filter not running has `last == [0.0; 3]`. So [`FxFilter`]
//!   is exactly two biquads and two ramps, 272 B, inside the mixed-voice pool entry (448 B,
//!   `audio-core`'s `fxpool.rs`).
//!
//! Q is [`Q_DB`] (1 dB, the bus snapshot low-pass's `SNAPSHOT_Q_DB`) for both filters.
//! Transcendentals go through `libm`; nothing allocates.
//!
//! Skeleton by task D1; leaf L-D1a fills the bodies and the tests.

use crate::biquad::{kernel, Biquad};

/// A low-pass cut-off at or above this is off (S20 `LP_TOP`; the wire's `LP_TOP`, asserted equal
/// in `audio-core`).
pub const LP_TOP: f32 = 20_000.0;
/// A high-pass cut-off at or below this is off (S20 `HP_BOTTOM`; the wire's `HP_BOTTOM`).
pub const HP_BOTTOM: f32 = 20.0;
/// The capped low-pass's base while the low-pass ramp is settled off: M2's "off" cut-off (the
/// wire's `BUS_LP_OFF_HZ`), so `min(LP_OFF_HZ, lpAuto)` is M2's automation cut-off.
pub const LP_OFF_HZ: f32 = 24_000.0;
/// The lowest low-pass cut-off kept (a positive cut-off below it is raised to it).
pub const LP_FLOOR: f32 = 10.0;
/// Q of both filters, in dB (as the bus snapshot low-pass).
pub const Q_DB: f32 = 1.0;
/// While a ramp runs, the coefficients are recomputed every this many frames.
pub const UPDATE_FRAMES: usize = 32;
/// The shortest ramp a caller should ask of an audible filter ([`FxFilter::set_lowpass`] and
/// [`FxFilter::set_highpass`] take what they're given; `audio-core` raises an audible voice's
/// `rampFrames` to this, and jumps only on a silent voice). With [`UPDATE_FRAMES`] it bounds a
/// coefficient step to a quarter of the sweep.
pub const MIN_RAMP_FRAMES: u32 = 128;

/// A cut-off ramp, linear in log2(Hz). 16 B, `#[repr(C)]`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CutoffRamp {
    /// log2 of the cut-off reached (exactly `log2f(target)` once settled).
    pub log2: f32,
    /// Added to `log2` per frame while `remaining > 0`.
    pub step: f32,
    /// Frames left; 0 when settled.
    pub remaining: u32,
    /// Where the ramp ends, in Hz (returned exactly once settled).
    pub target: f32,
}

impl CutoffRamp {
    /// Settled at `hz` (> 0): `log2 = log2f(hz)`, `target = hz`.
    pub fn at(hz: f32) -> CutoffRamp {
        let _ = hz;
        todo!("L-D1a")
    }

    /// Ramps from the current cut-off to `hz` (> 0) over `frames` frames, linearly in log2: `step =
    /// (log2f(hz) - log2) / frames`. `frames == 0` jumps (settled at `hz`).
    pub fn set(&mut self, hz: f32, frames: u32) {
        let _ = (hz, frames);
        todo!("L-D1a")
    }

    /// Moves `frames` frames on in O(1): past the end it settles (`log2 = log2f(target)`,
    /// `remaining = 0`); otherwise `log2 += step × frames`, `remaining -= frames`.
    pub fn advance(&mut self, frames: u32) {
        let _ = frames;
        todo!("L-D1a")
    }

    /// The cut-off in Hz: `target` exactly once settled; while ramping `exp2f(log2)`, clamped so
    /// it never passes `target` (a ramp down stays at or above it, a ramp up at or below).
    pub fn hz(&self) -> f32 {
        todo!("L-D1a")
    }

    /// `true` when `remaining == 0`.
    pub fn is_settled(&self) -> bool {
        todo!("L-D1a")
    }
}

/// A voice's low-pass and high-pass with their ramps: 272 B, `#[repr(C)]`. Not all-zero valid:
/// start from [`FxFilter::off`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FxFilter {
    pub lp: Biquad,
    pub hp: Biquad,
    /// The low-pass cut-off ([`LP_TOP`] when off).
    pub lp_ramp: CutoffRamp,
    /// The high-pass cut-off ([`HP_BOTTOM`] when off).
    pub hp_ramp: CutoffRamp,
}

const _: () = assert!(core::mem::size_of::<FxFilter>() == 272, "two biquads and two ramps");

impl FxFilter {
    /// Both filters off and not running: zeroed biquads, the low-pass ramp settled at [`LP_TOP`],
    /// the high-pass ramp at [`HP_BOTTOM`].
    pub fn off() -> FxFilter {
        todo!("L-D1a")
    }

    /// The low-pass ramp's end point for a requested cut-off: `hz` raised to [`LP_FLOOR`] when it
    /// is finite, positive and below [`LP_TOP`]; otherwise [`LP_TOP`] (off: 0, NaN, ±inf, ≥ 20 kHz).
    pub fn lowpass_target(hz: f32) -> f32 {
        let _ = hz;
        todo!("L-D1a")
    }

    /// The high-pass ramp's end point: `hz` lowered to [`LP_TOP`] when it is finite and above
    /// [`HP_BOTTOM`]; otherwise [`HP_BOTTOM`] (off).
    pub fn highpass_target(hz: f32) -> f32 {
        let _ = hz;
        todo!("L-D1a")
    }

    /// Ramps the low-pass to `lowpass_target(hz)` over `frames` (0 jumps).
    pub fn set_lowpass(&mut self, hz: f32, frames: u32) {
        let _ = (hz, frames);
        todo!("L-D1a")
    }

    /// Ramps the high-pass to `highpass_target(hz)` over `frames` (0 jumps).
    pub fn set_highpass(&mut self, hz: f32, frames: u32) {
        let _ = (hz, frames);
        todo!("L-D1a")
    }

    /// `true` while the low-pass is running (its biquad's kind is set: `lp.last[0] != 0.0`).
    pub fn lowpass_running(&self) -> bool {
        todo!("L-D1a")
    }

    /// `true` while the high-pass is running.
    pub fn highpass_running(&self) -> bool {
        todo!("L-D1a")
    }

    /// `true` while either filter runs (STATUS `fxVoices` counts these).
    pub fn running(&self) -> bool {
        todo!("L-D1a")
    }

    /// Automation gained a lowpass binding (`audio-core`'s `automation::automate`): when the
    /// low-pass isn't running, its biquad starts again from `Biquad::default()` (zeroed history,
    /// as M2 reset the automation filter); a running low-pass is left alone (no click).
    pub fn lowpass_bound(&mut self) {
        todo!("L-D1a")
    }

    /// Filters a block in place: `left` (mono, `right == None`: channel-0 history only) or `left`
    /// and `right` (same length). `cap` is automation's `lpAuto` while the voice has a lowpass
    /// binding. Returns [`FxFilter::running`] afterwards.
    ///
    /// The block is cut into segments: one segment of the whole block when both ramps are settled,
    /// otherwise segments of [`UPDATE_FRAMES`] (the last shorter). Per segment of `k` frames:
    /// 1. both ramps `advance(k)` (so the cut-off used is the one reached at the segment's end, and
    ///    the last segment of a ramp uses the target exactly);
    /// 2. **low-pass**: it should run when `cap` is `Some` or the low-pass ramp isn't settled at
    ///    [`LP_TOP`]. Cut-off: with `cap = Some(c)`, `min(base, c)` with `base` = [`LP_OFF_HZ`] if the
    ///    ramp is settled at `LP_TOP`, else `lp_ramp.hz()`; without a cap, `lp_ramp.hz()`. If it
    ///    should run: when it wasn't running and `cap` is `None`, prime its history (each processed
    ///    channel's `[x1, x2, y1, y2]` = that channel's first sample of the segment, as f64); then
    ///    `lp.set_lowpass(sample_rate, cutoff, Q_DB)` and process (mono: `kernel::process` on
    ///    `lp.history[0]`; stereo: `lp.process`). If it shouldn't run and is running: stop it
    ///    (`lp.last = [0.0; 3]`), samples untouched;
    /// 3. **high-pass**, after the low-pass: it should run while the high-pass ramp isn't settled at
    ///    [`HP_BOTTOM`]; the same priming (never capped), `hp.set_highpass(sample_rate,
    ///    hp_ramp.hz(), Q_DB)`, process or stop.
    pub fn process(&mut self, sample_rate: f32, cap: Option<f32>, left: &mut [f32], right: Option<&mut [f32]>) -> bool {
        let _ = (sample_rate, cap, left, right, kernel::process);
        todo!("L-D1a")
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "L-D1a"]
    fn a_ramp_is_monotone_in_both_directions_and_ends_on_its_target() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_ramp_is_linear_in_log2() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_lowpass_at_or_above_lp_top_is_off_and_leaves_samples_untouched() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_highpass_at_or_below_hp_bottom_is_off() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_settled_filter_is_one_biquad_pass() {}

    #[test]
    #[ignore = "L-D1a"]
    fn mono_once_equals_filtering_two_identical_channels() {}

    #[test]
    #[ignore = "L-D1a"]
    fn the_cap_is_m2s_automation_lowpass_bit_for_bit() {}

    #[test]
    #[ignore = "L-D1a"]
    fn coefficients_move_every_update_frames_while_ramping() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_cutoff_jump_over_the_minimum_ramp_does_not_click() {}

    #[test]
    #[ignore = "L-D1a"]
    fn switching_on_is_primed_and_seamless() {}

    #[test]
    #[ignore = "L-D1a"]
    fn a_ramp_back_to_the_off_end_point_stops_the_filter() {}

    #[test]
    #[ignore = "L-D1a"]
    fn lowpass_bound_resets_only_a_filter_not_running() {}
}
