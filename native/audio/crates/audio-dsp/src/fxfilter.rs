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
//!   ramp runs the coefficients are recomputed every [`UPDATE_FRAMES`] frames, and a ramp is
//!   stretched so one update moves at most [`MAX_UPDATE_OCTAVES`] (1 octave; the click bound: a
//!   1 kHz sine through a 10-octave sweep steps at most 1.23x its own largest step); a settled filter
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
//! Skeleton and the ramp stretch by task D1; leaf L-D1a filled the bodies and the tests.

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
/// `rampFrames` to this, and jumps only on a silent voice). A large sweep is stretched further by
/// [`MAX_UPDATE_OCTAVES`].
pub const MIN_RAMP_FRAMES: u32 = 128;

/// The most a running ramp moves the cut-off between two coefficient updates, in octaves
/// ([`CutoffRamp::set`] stretches a ramp that would move faster): the click bound.
pub const MAX_UPDATE_OCTAVES: f32 = 1.0;

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
        CutoffRamp { log2: libm::log2f(hz), step: 0.0, remaining: 0, target: hz }
    }

    /// Ramps from the current cut-off to `hz` (> 0) over `frames` frames, linearly in log2: `step =
    /// (log2f(hz) - log2) / frames`. `frames == 0` jumps (settled at `hz`). A ramp is stretched so
    /// it moves at most [`MAX_UPDATE_OCTAVES`] per [`UPDATE_FRAMES`] (a sweep of `d` octaves takes
    /// at least `d × UPDATE_FRAMES / MAX_UPDATE_OCTAVES` frames: 10 octaves, 320 frames).
    pub fn set(&mut self, hz: f32, frames: u32) {
        if frames == 0 {
            *self = CutoffRamp::at(hz);
            return;
        }
        let octaves = libm::fabsf(libm::log2f(hz) - self.log2);
        let least = libm::ceilf(octaves * UPDATE_FRAMES as f32 / MAX_UPDATE_OCTAVES);
        let frames = if least.is_finite() && least > frames as f32 { least as u32 } else { frames };
        self.step = (libm::log2f(hz) - self.log2) / frames as f32;
        self.remaining = frames;
        self.target = hz;
    }

    /// Moves `frames` frames on in O(1): past the end it settles (`log2 = log2f(target)`,
    /// `remaining = 0`); otherwise `log2 += step × frames`, `remaining -= frames`.
    pub fn advance(&mut self, frames: u32) {
        if self.remaining == 0 {
            return;
        }
        if frames >= self.remaining {
            *self = CutoffRamp::at(self.target);
        } else {
            self.log2 += self.step * frames as f32;
            self.remaining -= frames;
        }
    }

    /// The cut-off in Hz: `target` exactly once settled; while ramping `exp2f(log2)`, clamped so
    /// it never passes `target` (a ramp down stays at or above it, a ramp up at or below).
    pub fn hz(&self) -> f32 {
        if self.remaining == 0 {
            return self.target;
        }
        let v = libm::exp2f(self.log2);
        if self.step < 0.0 {
            v.max(self.target)
        } else {
            v.min(self.target)
        }
    }

    /// `true` when `remaining == 0`.
    pub fn is_settled(&self) -> bool {
        self.remaining == 0
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
        FxFilter { lp: Biquad::default(), hp: Biquad::default(), lp_ramp: CutoffRamp::at(LP_TOP), hp_ramp: CutoffRamp::at(HP_BOTTOM) }
    }

    /// The low-pass ramp's end point for a requested cut-off: `hz` raised to [`LP_FLOOR`] when it
    /// is finite, positive and below [`LP_TOP`]; otherwise [`LP_TOP`] (off: 0, NaN, ±inf, ≥ 20 kHz).
    pub fn lowpass_target(hz: f32) -> f32 {
        if hz.is_finite() && hz > 0.0 && hz < LP_TOP {
            hz.max(LP_FLOOR)
        } else {
            LP_TOP
        }
    }

    /// The high-pass ramp's end point: `hz` lowered to [`LP_TOP`] when it is finite and above
    /// [`HP_BOTTOM`]; otherwise [`HP_BOTTOM`] (off).
    pub fn highpass_target(hz: f32) -> f32 {
        if hz.is_finite() && hz > HP_BOTTOM {
            hz.min(LP_TOP)
        } else {
            HP_BOTTOM
        }
    }

    /// Ramps the low-pass to `lowpass_target(hz)` over `frames` (0 jumps).
    pub fn set_lowpass(&mut self, hz: f32, frames: u32) {
        self.lp_ramp.set(Self::lowpass_target(hz), frames);
    }

    /// Ramps the high-pass to `highpass_target(hz)` over `frames` (0 jumps).
    pub fn set_highpass(&mut self, hz: f32, frames: u32) {
        self.hp_ramp.set(Self::highpass_target(hz), frames);
    }

    /// `true` while the low-pass is running (its biquad's kind is set: `lp.last[0] != 0.0`).
    pub fn lowpass_running(&self) -> bool {
        self.lp.last[0] != 0.0
    }

    /// `true` while the high-pass is running.
    pub fn highpass_running(&self) -> bool {
        self.hp.last[0] != 0.0
    }

    /// Multiplies both filters' histories (every channel's `x1, x2, y1, y2`) by `k`: the filters
    /// then continue as if their past input had been `k` times what it was. A linear filter's
    /// state is in the units of its input, so a caller that moves a gain from before the filters
    /// to after them (or back) rescales by `1 / gain` (or `gain`) and the output stays continuous
    /// (F-40: `audio-core`'s voice chain when a zone send starts or settles at 0).
    pub fn rescale_history(&mut self, k: f32) {
        let k = k as f64;
        for bq in [&mut self.lp, &mut self.hp] {
            for ch in bq.history.iter_mut() {
                for h in ch.iter_mut() {
                    *h *= k;
                }
            }
        }
    }

    /// `true` while either filter runs (STATUS `fxVoices` counts these).
    pub fn running(&self) -> bool {
        self.lowpass_running() || self.highpass_running()
    }

    /// Automation gained a lowpass binding (`audio-core`'s `automation::automate`): when the
    /// low-pass isn't running, its biquad starts again from `Biquad::default()` (zeroed history,
    /// as M2 reset the automation filter); a running low-pass is left alone (no click).
    pub fn lowpass_bound(&mut self) {
        if !self.lowpass_running() {
            self.lp = Biquad::default();
        }
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
    pub fn process(&mut self, sample_rate: f32, cap: Option<f32>, left: &mut [f32], mut right: Option<&mut [f32]>) -> bool {
        let n = left.len();
        if let Some(r) = right.as_deref() {
            debug_assert_eq!(r.len(), n, "stereo channels have equal lengths");
        }
        let whole = self.lp_ramp.is_settled() && self.hp_ramp.is_settled();
        let seg = if whole { n } else { UPDATE_FRAMES };
        let mut start = 0;
        while start < n {
            let end = (start + seg).min(n);
            let frames = (end - start) as u32;
            let l = &mut left[start..end];
            let r = right.as_deref_mut().map(|r| &mut r[start..end]);
            self.segment(sample_rate, cap, frames, l, r);
            start = end;
        }
        self.running()
    }

    /// One segment of [`FxFilter::process`]: the ramps advance, then the low-pass, then the
    /// high-pass. `frames >= 1`.
    fn segment(&mut self, sample_rate: f32, cap: Option<f32>, frames: u32, left: &mut [f32], mut right: Option<&mut [f32]>) {
        self.lp_ramp.advance(frames);
        self.hp_ramp.advance(frames);

        let lp_off = self.lp_ramp.is_settled() && self.lp_ramp.target == LP_TOP;
        if cap.is_some() || !lp_off {
            let hz = match cap {
                Some(c) => (if lp_off { LP_OFF_HZ } else { self.lp_ramp.hz() }).min(c),
                None => self.lp_ramp.hz(),
            };
            if cap.is_none() && !self.lowpass_running() {
                prime(&mut self.lp, left[0], right.as_deref().map(|r| r[0]));
            }
            self.lp.set_lowpass(sample_rate, hz, Q_DB);
            run(&mut self.lp, left, right.as_deref_mut());
        } else {
            self.lp.last = [0.0; 3];
        }

        let hp_off = self.hp_ramp.is_settled() && self.hp_ramp.target == HP_BOTTOM;
        if !hp_off {
            if !self.highpass_running() {
                prime(&mut self.hp, left[0], right.as_deref().map(|r| r[0]));
            }
            self.hp.set_highpass(sample_rate, self.hp_ramp.hz(), Q_DB);
            run(&mut self.hp, left, right);
        } else {
            self.hp.last = [0.0; 3];
        }
    }
}

/// Primes a filter that is switching on as if it had been passing its input: every processed
/// channel's history `[x1, x2, y1, y2]` is that channel's first sample.
fn prime(bq: &mut Biquad, left0: f32, right0: Option<f32>) {
    bq.history[0] = [left0 as f64; 4];
    if let Some(r) = right0 {
        bq.history[1] = [r as f64; 4];
    }
}

/// Runs a biquad whose coefficients are set over one segment: stereo, or mono on channel 0's
/// history (the same arithmetic, so mono equals stereo on identical channels).
fn run(bq: &mut Biquad, left: &mut [f32], right: Option<&mut [f32]>) {
    match right {
        Some(r) => bq.process(left, r),
        None => kernel::process(&bq.coefficients, &mut bq.history[0], left),
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    const SR: f32 = 48_000.0;

    /// A 1 kHz sine at amplitude 1, samples `start..start + n`.
    fn tone(start: usize, n: usize) -> Vec<f32> {
        (start..start + n).map(|i| libm::sinf(core::f32::consts::TAU * 1_000.0 * i as f32 / SR)).collect()
    }

    /// The largest sample-to-sample step of a block.
    fn max_step(x: &[f32]) -> f32 {
        x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn a_ramp_is_monotone_in_both_directions_and_ends_on_its_target() {
        for (from, to) in [(20_000.0f32, 200.0f32), (20.0, 5_000.0)] {
            let mut r = CutoffRamp::at(from);
            r.set(to, 1_000);
            let mut prev = r.hz();
            for _ in 0..1_000 {
                r.advance(1);
                let h = r.hz();
                if from > to {
                    assert!(h <= prev && h >= to, "{from} -> {to}: {prev} then {h}");
                } else {
                    assert!(h >= prev && h <= to, "{from} -> {to}: {prev} then {h}");
                }
                prev = h;
            }
            assert_eq!(r.hz(), to);
            assert!(r.is_settled());
        }
    }

    #[test]
    fn a_ramp_is_linear_in_log2() {
        let mut r = CutoffRamp::at(20_000.0);
        r.set(200.0, 1_000);
        let mut marks = Vec::new();
        for _ in 0..4 {
            r.advance(250);
            marks.push(r.log2);
        }
        let start = libm::log2f(20_000.0);
        let quarter = marks[0] - start;
        for (i, m) in marks.iter().enumerate() {
            let expect = start + quarter * (i as f32 + 1.0);
            assert!((m - expect).abs() < 1e-4, "quarter {i}: {m} vs {expect}");
        }
        // Half way is the geometric mean: sqrt(20000 * 200) = 2000 Hz.
        let mut half = CutoffRamp::at(20_000.0);
        half.set(200.0, 1_000);
        half.advance(500);
        assert!((half.hz() / 2_000.0 - 1.0).abs() < 1e-3, "{}", half.hz());
    }

    #[test]
    fn a_lowpass_at_or_above_lp_top_is_off_and_leaves_samples_untouched() {
        for hz in [LP_TOP, 25_000.0, f32::INFINITY, f32::NEG_INFINITY, 0.0, -5.0, f32::NAN] {
            let mut f = FxFilter::off();
            f.set_lowpass(hz, 0);
            let mut l = tone(0, 200);
            let before = l.clone();
            f.process(SR, None, &mut l, None);
            assert!(!f.lowpass_running(), "{hz}");
            assert_eq!(l, before, "{hz}");
        }
    }

    #[test]
    fn a_highpass_at_or_below_hp_bottom_is_off() {
        for hz in [HP_BOTTOM, 10.0, 0.0, -5.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut f = FxFilter::off();
            f.set_highpass(hz, 0);
            let mut l = tone(0, 200);
            let before = l.clone();
            f.process(SR, None, &mut l, None);
            assert!(!f.highpass_running(), "{hz}");
            assert_eq!(l, before, "{hz}");
        }
    }

    #[test]
    fn a_settled_filter_is_one_biquad_pass() {
        let mut f = FxFilter::off();
        f.set_lowpass(1_000.0, 0);
        // Warm up: the first block primes the filter, so the next one is a settled, running filter.
        let (mut wl, mut wr) = (tone(0, 256), tone(0, 256));
        wr.iter_mut().for_each(|x| *x *= 0.5);
        f.process(SR, None, &mut wl, Some(&mut wr[..]));

        let mut reference = f.lp;
        let mut l = tone(256, 300);
        let mut r: Vec<f32> = l.iter().map(|x| -0.5 * x).collect();
        let (mut rl, mut rr) = (l.clone(), r.clone());
        f.process(SR, None, &mut l, Some(&mut r[..]));
        reference.set_lowpass(SR, 1_000.0, Q_DB);
        reference.process(&mut rl, &mut rr);
        assert_eq!((l, r), (rl, rr));
        assert_eq!(f.lp, reference);
    }

    #[test]
    fn mono_once_equals_filtering_two_identical_channels() {
        for cap in [None, Some(900.0f32)] {
            let mut m = FxFilter::off();
            let mut s = FxFilter::off();
            m.set_lowpass(300.0, 256);
            s.set_lowpass(300.0, 256);
            // A DC offset and a ramp into the filter, so priming and the ramp both matter.
            let input: Vec<f32> = tone(0, 1_000).iter().map(|x| 0.8 * x + 0.1).collect();
            let mut left_m = input.clone();
            let (mut left_s, mut right_s) = (input.clone(), input.clone());
            m.process(SR, cap, &mut left_m, None);
            s.process(SR, cap, &mut left_s, Some(&mut right_s[..]));
            assert_eq!(left_m, left_s, "cap {cap:?}");
            assert_eq!(left_s, right_s, "cap {cap:?}");
            assert_eq!(m.lp.history[0], s.lp.history[0]);
            assert_eq!(m.lp_ramp, s.lp_ramp);
        }
    }

    #[test]
    fn the_cap_is_m2s_automation_lowpass_bit_for_bit() {
        // A DC input: a filter that wrongly primed would start at 1.0 and not ring up from zero.
        for c in [1_000.0f32, 30_000.0] {
            let mut f = FxFilter::off();
            let (mut l, mut r) = ([1.0f32; 300], [1.0f32; 300]);
            f.process(SR, Some(c), &mut l, Some(&mut r[..]));

            let mut b = Biquad::default();
            b.set_lowpass(SR, c.min(LP_OFF_HZ), Q_DB);
            let (mut bl, mut br) = ([1.0f32; 300], [1.0f32; 300]);
            b.process(&mut bl, &mut br);
            assert_eq!((l, r), (bl, br), "cap {c}");
            assert_eq!(f.lp, b, "cap {c}");
            assert!(f.lowpass_running());
        }
    }

    #[test]
    fn coefficients_move_every_update_frames_while_ramping() {
        let mut f = FxFilter::off();
        f.set_lowpass(200.0, 128);
        let mut prev = f.lp.coefficients;
        for _ in 0..4 {
            let mut l = [1.0f32; UPDATE_FRAMES];
            f.process(SR, None, &mut l, None);
            let mut expect = Biquad::default();
            expect.set_lowpass(SR, f.lp_ramp.hz(), Q_DB);
            assert_eq!(f.lp.coefficients, expect.coefficients);
            assert_ne!(f.lp.coefficients, prev);
            prev = f.lp.coefficients;
        }

        // Segmenting is invisible: one 128-frame call equals four 32-frame calls, bit for bit.
        let input = tone(0, 128);
        let (mut one, mut many) = (FxFilter::off(), FxFilter::off());
        one.set_lowpass(200.0, 128);
        many.set_lowpass(200.0, 128);
        let mut whole = input.clone();
        one.process(SR, None, &mut whole, None);
        let mut parts = input.clone();
        for chunk in parts.chunks_mut(UPDATE_FRAMES) {
            many.process(SR, None, chunk, None);
        }
        assert_eq!(whole, parts);
        assert_eq!(one, many);
    }

    #[test]
    fn a_cutoff_jump_over_the_minimum_ramp_does_not_click() {
        let input = tone(0, 2_048);
        let in_step = max_step(&input);

        let mut lp = FxFilter::off();
        lp.set_lowpass(100.0, MIN_RAMP_FRAMES);
        let mut out = input.clone();
        lp.process(SR, None, &mut out, None);
        let lp_step = max_step(&out);
        assert!(lp_step <= 2.0 * in_step, "low-pass: output step {lp_step} vs input step {in_step}");

        let mut hp = FxFilter::off();
        hp.set_highpass(5_000.0, MIN_RAMP_FRAMES);
        let mut out = input.clone();
        hp.process(SR, None, &mut out, None);
        let hp_step = max_step(&out);
        eprintln!("click bound: low-pass {:.3}x, high-pass {:.3}x of the input step", lp_step / in_step, hp_step / in_step);
        assert!(hp_step <= 2.0 * in_step, "high-pass: output step {hp_step} vs input step {in_step}");
    }

    #[test]
    fn switching_on_is_primed_and_seamless() {
        // A low-pass switched on just under the off end point passes DC from its first sample.
        let mut f = FxFilter::off();
        f.set_lowpass(19_000.0, 0);
        let (mut l, mut r) = ([1.0f32; 512], [1.0f32; 512]);
        f.process(SR, None, &mut l, Some(&mut r[..]));
        assert!(f.lowpass_running());
        for (i, (a, b)) in l.iter().zip(r.iter()).enumerate() {
            assert!((a - 1.0).abs() < 0.01 && (b - 1.0).abs() < 0.01, "frame {i}: {a} {b}");
        }
    }

    #[test]
    fn a_ramp_back_to_the_off_end_point_stops_the_filter() {
        let mut f = FxFilter::off();
        f.set_lowpass(1_000.0, 0);
        let mut warm = tone(0, 256);
        f.process(SR, None, &mut warm, None);
        assert!(f.lowpass_running());

        // Ramp back up to LP_TOP over 256 frames (8 segments): it settles and stops.
        f.set_lowpass(LP_TOP, 256);
        let mut ramp = tone(256, 512);
        f.process(SR, None, &mut ramp, None);
        assert!(f.lp_ramp.is_settled());
        assert!(!f.lowpass_running());

        // From then on the samples pass untouched.
        let input = tone(768, 300);
        let mut out = input.clone();
        assert!(!f.process(SR, None, &mut out, None));
        assert_eq!(out, input);
    }

    #[test]
    fn lowpass_bound_resets_only_a_filter_not_running() {
        let mut f = FxFilter::off();
        f.set_lowpass(1_000.0, 0);
        let mut l = tone(0, 64);
        f.process(SR, None, &mut l, None);
        assert_ne!(f.lp.history, [[0.0; 4]; 2]);

        // Running: left alone, history and all.
        let before = f.lp;
        f.lowpass_bound();
        assert_eq!(f.lp, before);

        // Stopped (with history left behind): starts again from a default biquad.
        f.set_lowpass(LP_TOP, 0);
        let mut l = tone(64, 64);
        f.process(SR, None, &mut l, None);
        assert!(!f.lowpass_running());
        assert_ne!(f.lp.history, [[0.0; 4]; 2]);
        f.lowpass_bound();
        assert_eq!(f.lp, Biquad::default());
    }
}
