//! Linear parameter ramps (api-and-models §4.2: "Only SET_PARAMS, FADE, BUS_MIX and MASTER ramp";
//! architecture §4.3: `rampFrames` is chosen by the host; 0171/0172 M5: each bus gain lane of
//! `BUS_RAMP` is one, and an asap ramp on a lone lane is exactly [`Ramp::next`]'s arithmetic, R3).
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
        self.target = target;
        if frames == 0 {
            self.value = target;
            self.step = 0.0;
            self.remaining = 0;
        } else {
            self.step = (target - self.value) / frames as f32;
            self.remaining = frames;
        }
    }

    /// The control-rate retarget of a shaped fade (0166 M4-0, R6; `audio-core`'s `curves`): aims the
    /// next `frames` frames at `knot` (the law's value there) **without moving the ramp's end**:
    /// `target` and `remaining` stay, only `step` becomes `(knot − value) / frames`. So a stopping
    /// fade's `remaining` still counts the frames to its end, and the last frame still lands exactly
    /// on `target`. With `frames >= remaining` it aims at `target` itself (as `set_target` with the
    /// same `remaining`). Settled, or `frames == 0`: no change.
    pub fn retarget(&mut self, knot: f32, frames: u32) {
        if frames == 0 || self.remaining == 0 {
            return;
        }
        self.step = if frames >= self.remaining { (self.target - self.value) / self.remaining as f32 } else { (knot - self.value) / frames as f32 };
    }

    /// Advances one frame and returns the new value: when `remaining > 0`, `remaining -= 1` and
    /// `value` becomes `target` if `remaining` is now 0, else `value + step`. When settled, returns
    /// `value` unchanged. So frame `k` (0-based) of an N-frame ramp from `a` is about
    /// `a + (target - a) * (k + 1) / N`, and frame `N - 1` is exactly `target`.
    pub fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.value = if self.remaining == 0 { self.target } else { self.value + self.step };
        }
        self.value
    }

    /// Skips `frames` frames in O(1) (virtual voices keep time without rendering): if
    /// `frames >= remaining`, settles on `target`; else `value += step * frames as f32` and
    /// `remaining -= frames`. May differ from `frames` calls to `next` by float rounding.
    pub fn advance(&mut self, frames: u32) {
        if frames >= self.remaining {
            self.value = self.target;
            self.remaining = 0;
        } else {
            self.value += self.step * frames as f32;
            self.remaining -= frames;
        }
    }

    /// Writes `next()` into every element of `out`, in order.
    pub fn fill(&mut self, out: &mut [f32]) {
        for sample in out.iter_mut() {
            *sample = self.next();
        }
    }

    /// `true` when `remaining == 0`.
    pub fn is_settled(&self) -> bool {
        self.remaining == 0
    }

    /// `true` when settled at exactly 1: a gain at identity, which a gain stage skips rather than
    /// multiplies by (R3: bit-identical, NaN payloads and all).
    pub fn is_unity(&self) -> bool {
        self.remaining == 0 && self.value == 1.0
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn a_zeroed_ramp_is_settled_at_zero() {
        let mut ramp = Ramp::default();
        assert!(ramp.is_settled());
        assert_eq!(ramp.value, 0.0);
        assert_eq!(ramp.next(), 0.0);
        assert!(ramp.is_settled());
    }

    #[test]
    fn at_is_settled_and_next_returns_the_value() {
        let mut ramp = Ramp::at(0.5);
        assert!(ramp.is_settled());
        assert_eq!(ramp.next(), 0.5);
        assert_eq!(ramp.next(), 0.5);
        assert!(ramp.is_settled());
    }

    #[test]
    fn set_target_with_zero_frames_jumps() {
        let mut ramp = Ramp::at(0.25);
        ramp.set_target(0.75, 0);
        assert_eq!(ramp.value, 0.75);
        assert_eq!(ramp.target, 0.75);
        assert!(ramp.is_settled());
        assert_eq!(ramp.next(), 0.75);
    }

    #[test]
    fn a_ramp_moves_on_its_first_frame_and_lands_exactly_on_its_last() {
        let mut ramp = Ramp::at(0.0);
        ramp.set_target(1.0, 3);
        let first = ramp.next();
        assert!(first != 0.0, "first frame must already move");
        assert!((first - 1.0 / 3.0).abs() < 1e-6);
        ramp.next();
        assert!(!ramp.is_settled());
        let last = ramp.next();
        assert_eq!(last, 1.0, "last frame must land exactly on the target");
        assert_eq!(ramp.value, 1.0);
        assert!(ramp.is_settled());
        assert_eq!(ramp.next(), 1.0);
    }

    #[test]
    fn a_ramp_is_linear_within_float_tolerance() {
        // Power-of-two steps are exact: 1.0 -> 0.0 over 64 frames gives 1 - (k+1)/64 bit-exact.
        let mut down = Ramp::at(1.0);
        down.set_target(0.0, 64);
        for k in 0..64u32 {
            let expected = 1.0 - (k + 1) as f32 / 64.0;
            assert_eq!(down.next(), expected, "frame {k}");
        }
        assert_eq!(down.value, 0.0);
        assert!(down.is_settled());

        // A non-dyadic ramp stays within float tolerance of the linear formula.
        let (a, t, n) = (2.0f32, -4.0f32, 7u32);
        let mut ramp = Ramp::at(a);
        ramp.set_target(t, n);
        for k in 0..n {
            let expected = a + (t - a) * (k + 1) as f32 / n as f32;
            let got = ramp.next();
            assert!((got - expected).abs() < 1e-6, "frame {k}: {got} vs {expected}");
        }
        assert_eq!(ramp.value, t);
    }

    #[test]
    fn retargeting_mid_ramp_starts_from_the_current_value() {
        let mut ramp = Ramp::at(0.0);
        ramp.set_target(1.0, 100);
        for _ in 0..10 {
            ramp.next();
        }
        assert!((ramp.value - 0.1).abs() < 1e-6);
        ramp.set_target(0.0, 5);
        // The new ramp starts from 0.1, not from the original start (0.0) or the old target (1.0).
        let first = ramp.next();
        assert!((first - 0.08).abs() < 1e-6, "got {first}");
        for _ in 0..4 {
            ramp.next();
        }
        assert_eq!(ramp.value, 0.0);
        assert!(ramp.is_settled());
    }

    #[test]
    fn advance_matches_repeated_next_within_tolerance_and_settles_past_the_end() {
        let mut skipped = Ramp::at(0.0);
        skipped.set_target(1.0, 100);
        let mut stepped = skipped;

        skipped.advance(5);
        for _ in 0..5 {
            stepped.next();
        }
        assert!((skipped.value - stepped.value).abs() < 1e-6);
        assert_eq!(skipped.remaining, stepped.remaining);
        assert!(!skipped.is_settled());

        skipped.advance(1000);
        assert_eq!(skipped.value, 1.0);
        assert_eq!(skipped.remaining, 0);
        assert!(skipped.is_settled());
    }

    #[test]
    fn retarget_aims_at_a_knot_and_keeps_the_end() {
        let mut ramp = Ramp::at(0.0);
        ramp.set_target(1.0, 8);
        ramp.retarget(0.25, 4);
        assert_eq!((ramp.target, ramp.remaining), (1.0, 8), "the end stays");
        for k in 0..4 {
            assert_eq!(ramp.next(), 0.0625 * (k + 1) as f32);
        }
        assert_eq!(ramp.remaining, 4);
        ramp.retarget(1.0, 4);
        let tail: Vec<f32> = (0..4).map(|_| ramp.next()).collect();
        assert_eq!(tail, [0.4375, 0.625, 0.8125, 1.0]);
        assert!(ramp.is_settled());
        ramp.retarget(0.5, 4);
        assert_eq!(ramp.next(), 1.0, "a settled ramp ignores a retarget");
    }

    #[test]
    fn retarget_past_the_end_aims_at_the_target() {
        let mut ramp = Ramp::at(0.0);
        ramp.set_target(1.0, 4);
        ramp.retarget(0.1, 16);
        assert_eq!(ramp.step, 0.25);
        ramp.retarget(0.1, 0);
        assert_eq!(ramp.step, 0.25, "0 frames: no change");
    }

    #[test]
    fn is_unity_only_when_settled_at_one() {
        assert!(Ramp::at(1.0).is_unity());
        assert!(!Ramp::at(0.5).is_unity());
        assert!(!Ramp::default().is_unity());
        let mut ramp = Ramp::at(1.0);
        ramp.set_target(1.0, 4);
        assert!(!ramp.is_unity(), "moving, even towards 1");
        ramp.advance(4);
        assert!(ramp.is_unity());
    }

    #[test]
    fn fill_writes_successive_values() {
        let mut filled = Ramp::at(0.0);
        filled.set_target(1.0, 4);
        let mut stepped = filled;
        let mut out = [0.0f32; 4];
        filled.fill(&mut out);
        assert_eq!(out, [0.25, 0.5, 0.75, 1.0]);
        for sample in out {
            assert_eq!(sample, stepped.next());
        }
        assert!(filled.is_settled());
    }
}
