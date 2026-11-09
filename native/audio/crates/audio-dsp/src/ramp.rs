//! Linear parameter ramps (api-and-models §4.2: "Only SET_PARAMS, FADE, BUS_MIX and MASTER ramp";
//! architecture §4.3: `rampFrames` is chosen by the host).
//!
//! A [`Ramp`] moves a value linearly from where it is to a target over a whole number of frames.
//! The first frame of a ramp already moves (so no frame is wasted at the start), and the last
//! frame lands exactly on the target (no accumulated rounding is left over). Voice gains, fades,
//! pitch and the panner's matrix coefficients in `audio-core` all use it.
//!
//! `#[repr(C)]` and all-zero valid (value 0, settled): voice slots live in zeroed linear memory.
//! Nothing here allocates.

/// A linear ramp. All-zero is a settled ramp at 0.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Ramp {
    /// The value of the frame last returned by [`Ramp::next`] (or the start value).
    pub value: f32,
    /// Where the ramp ends.
    pub target: f32,
    /// Added to `value` per frame while `remaining > 0`.
    pub step: f32,
    /// Frames left until `value == target`; 0 when settled.
    pub remaining: u32,
}

impl Ramp {
    /// A settled ramp at `value` (`target == value`, `step == 0`, `remaining == 0`).
    pub const fn at(value: f32) -> Ramp {
        Ramp { value, target: value, step: 0.0, remaining: 0 }
    }

    /// Starts a ramp from the current `value` to `target` over `frames` frames.
    /// `frames == 0` jumps: `value = target`, settled. Otherwise `step = (target - value) / frames`
    /// (computed in f32) and `remaining = frames`.
    pub fn set_target(&mut self, target: f32, frames: u32) {
        let _ = (target, frames);
        todo!("A1.2-L2")
    }

    /// Advances one frame and returns the new value: when `remaining > 0`, `remaining -= 1` and
    /// `value` becomes `target` if `remaining` is now 0, else `value + step`. When settled, returns
    /// `value` unchanged. So frame `k` (0-based) of an N-frame ramp from `a` is about
    /// `a + (target - a) * (k + 1) / N`, and frame `N - 1` is exactly `target`.
    pub fn next(&mut self) -> f32 {
        todo!("A1.2-L2")
    }

    /// Skips `frames` frames in O(1) (virtual voices keep time without rendering): if
    /// `frames >= remaining`, settles on `target`; else `value += step * frames as f32` and
    /// `remaining -= frames`. May differ from `frames` calls to `next` by float rounding.
    pub fn advance(&mut self, frames: u32) {
        let _ = frames;
        todo!("A1.2-L2")
    }

    /// Writes `next()` into every element of `out`, in order.
    pub fn fill(&mut self, out: &mut [f32]) {
        let _ = out;
        todo!("A1.2-L2")
    }

    /// `true` when `remaining == 0`.
    pub fn is_settled(&self) -> bool {
        todo!("A1.2-L2")
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "A1.2-L2"]
    fn a_zeroed_ramp_is_settled_at_zero() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn at_is_settled_and_next_returns_the_value() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn set_target_with_zero_frames_jumps() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn a_ramp_moves_on_its_first_frame_and_lands_exactly_on_its_last() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn a_ramp_is_linear_within_float_tolerance() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn retargeting_mid_ramp_starts_from_the_current_value() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn advance_matches_repeated_next_within_tolerance_and_settles_past_the_end() {}

    #[test]
    #[ignore = "A1.2-L2"]
    fn fill_writes_successive_values() {}
}
