//! Contract K5: per-bus effect slots and their dispatch (api-and-models §4.2 BUS_CONFIG).
//!
//! BUS_CONFIG carries each bus's effects in order: `u32 type` (0 lowpass, 1 highpass, 2 compressor,
//! 3 reverb send) and `f32 p[7]` (lp/hp: frequency Hz, q in dB; compressor: threshold dB, knee dB,
//! ratio, attack s, release s; reverb: send). [`FxChain::configure`] stores them in a bus's fixed
//! slots and [`FxChain::process`] runs them in order on the bus's quantum, before the snapshot
//! low-pass and the bus gain (the chain of `webAudioReference.ts`: input, effects, low-pass, gain).
//!
//! The DSP behind each kind lives in `audio-dsp`, one module per kind, so A2.2a and A2.2b fill only
//! their own file and never this one:
//! - `lowpass`, `highpass`, and the snapshot low-pass: `audio_dsp::biquad::Biquad` (A2.2a);
//! - `compressor`: `audio_dsp::compressor::Compressor` (A2.2a);
//! - `reverbSend`: adds `send * signal` into the bus's send scratch (M5, K1: a 1 KB planar stereo
//!   buffer shared by every bus, since they mix one at a time), and leaves the bus signal unchanged
//!   (a tap); `bus.rs` hands the scratch to `sends::feed` after the bus's gain stage, which adds it
//!   into the shared reverb input (post-fader scaling: Rv1); the shared `audio_dsp::convolver`
//!   (A2.2b) renders the wet signal once per quantum in `bus.rs`.
//!
//! (In A2.1 those modules were passthrough stubs; A2.2a and A2.2b filled them.)
//!
//! **Limits and bad input.** A bus keeps at most [`MAX_EFFECTS`] effects, and at most one
//! compressor (the first); the rest, and effects of an unknown type (a newer minor), are dropped
//! and counted (the count is returned to `bus.rs`, which keeps it in its area: the wire has no
//! STATUS field for it). A dropped second compressor and an unknown type keep their place as a
//! [`kind::NONE`] slot, so the others keep their slots. A non-finite parameter is read as 0; a
//! send is clamped to 0..1. A slot that keeps its kind across a BUS_CONFIG keeps its filter or
//! envelope state (an effect edit doesn't click); a slot whose kind changes starts from zeroed
//! state.
//!
//! **Smoothing (B4, R7; architecture §4.7).** Only the compressor's parameters are smoothed: a
//! running compressor that keeps its slot glides to edited parameters, stepping once per quantum
//! along a straight line over `COMPRESSOR_SMOOTH_MS` ([`smooth_frames`], `Compressor::glide`), so
//! a threshold step no longer clicks. Filter frequency and Q and the send level stay direct (S4:
//! abrupt 0.15 and 0.10). The snapshot low-pass's coefficients follow its lane's ramp once per
//! quantum ([`snapshot_lowpass`]: S4's per-quantum coefficient blend, +370 instructions per
//! filter). Unchanged parameters cost nothing and stay bit-identical.
//!
//! **Memory.** The compressor's state (about 2.4 KB, most of it its pre-delay line) is held once
//! per bus, in [`FxChain::compressor`], beside the slots; a slot keeps only a biquad's state
//! (lowpass, highpass), a send gain (in `p[0]`), or nothing (a compressor slot runs the bus's
//! compressor). So a bus stays near architecture §5.1's budget (the `layout.rs` tests check it).
//!
//! All-zero is a valid empty chain. Nothing here allocates.

use audio_dsp::biquad::Biquad;
use audio_dsp::compressor::Compressor;
use audio_wire::generated as wire;

/// Most effects per bus (a bus's slots are fixed so the `Buses` region never grows).
pub const MAX_EFFECTS: usize = 4;

/// The snapshot low-pass's resonance, in dB: Web Audio's `BiquadFilterNode` default Q (1), as the
/// reference graph's snapshot filter uses.
pub const SNAPSHOT_Q_DB: f32 = 1.0;

/// Slot kinds: the wire's effect types, and [`kind::NONE`] for a slot that does nothing.
pub mod kind {
    use super::wire;
    pub const LOWPASS: u32 = wire::effect_type::LOWPASS;
    pub const HIGHPASS: u32 = wire::effect_type::HIGHPASS;
    pub const COMPRESSOR: u32 = wire::effect_type::COMPRESSOR;
    pub const REVERB_SEND: u32 = wire::effect_type::REVERB_SEND;
    /// An unknown type, or a bus's second compressor: skipped.
    pub const NONE: u32 = u32::MAX;
}

/// [`FxChain::compressor_slot`] when no slot is a compressor.
pub const NO_COMPRESSOR: u32 = u32::MAX;

/// One effect slot. All-zero is a lowpass with zeroed parameters, which is never processed unless
/// it is within the chain's `count`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FxSlot {
    /// [`kind`].
    pub kind: u32,
    /// The wire parameters, sanitised (non-finite to 0; a send clamped to 0..1).
    pub p: [f32; 7],
    /// The filter state of a lowpass or highpass slot (zeroed and unused for the other kinds).
    pub biquad: Biquad,
}

/// One bus's effect chain. All-zero is an empty chain.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FxChain {
    /// Slots in use, in order.
    pub count: u32,
    /// The index of the slot that runs [`FxChain::compressor`], or [`NO_COMPRESSOR`]. Read only
    /// below `count` and with that slot's kind (all-zero reads slot 0, not in use when empty).
    pub compressor_slot: u32,
    pub slots: [FxSlot; MAX_EFFECTS],
    /// The bus's one compressor, run by the slot at `compressor_slot`.
    pub compressor: Compressor,
    /// B4 (R7): frames left in the compressor's parameter glide (0: none; [`smooth_frames`] when an
    /// edit starts one); `Compressor::glide` steps it once per quantum. The glide's target is the
    /// compressor slot's own `p` (the edit's parameters), clamped ([`FxChain::compressor_target`]),
    /// so a bus grows by this counter only.
    pub compressor_glide: u32,
}

impl Default for FxChain {
    fn default() -> FxChain {
        // SAFETY: integers, floats and all-zero-valid DSP state only.
        unsafe { core::mem::zeroed() }
    }
}

impl FxChain {
    /// The number of slots in use.
    fn used(&self) -> usize {
        (self.count as usize).min(MAX_EFFECTS)
    }

    /// The compressor's slot, when one is in use.
    fn compressor_in_use(&self) -> Option<usize> {
        let i = self.compressor_slot as usize;
        (i < self.used() && self.slots[i].kind == kind::COMPRESSOR).then_some(i)
    }

    /// What the compressor at slot `i` glides to: the slot's parameters, clamped as
    /// `Compressor::configure` clamps them.
    fn compressor_target(&self, i: usize) -> [f32; 5] {
        let p = self.slots[i].p;
        Compressor::clamp([p[0], p[1], p[2], p[3], p[4]])
    }

    /// Stores the effects `(type, p)` in order (BUS_CONFIG). Returns how many were dropped: past
    /// [`MAX_EFFECTS`], a second compressor, or of an unknown type (those two keep their place as
    /// a [`kind::NONE`] slot, so the order of the others is kept).
    pub fn configure<I: IntoIterator<Item = (u32, [f32; 7])>>(&mut self, effects: I, sample_rate: f32) -> u32 {
        let old_compressor = self.compressor_in_use();
        // Where a glide in flight is heading, read before the slots are overwritten.
        let old_target = old_compressor.map(|i| self.compressor_target(i));
        let mut compressor = None;
        let mut n = 0usize;
        let mut dropped = 0u32;
        for (type_, raw) in effects {
            if n >= MAX_EFFECTS {
                dropped += 1;
                continue;
            }
            let k = match type_ {
                kind::COMPRESSOR if compressor.is_some() => {
                    dropped += 1;
                    kind::NONE
                }
                kind::LOWPASS | kind::HIGHPASS | kind::COMPRESSOR | kind::REVERB_SEND => type_,
                _ => {
                    dropped += 1;
                    kind::NONE
                }
            };
            let in_use = n < self.count as usize;
            let slot = &mut self.slots[n];
            if slot.kind != k || !in_use {
                slot.biquad = Biquad::default();
            }
            slot.kind = k;
            for (dst, src) in slot.p.iter_mut().zip(raw) {
                *dst = if src.is_finite() { src } else { 0.0 };
            }
            let p = slot.p;
            match k {
                kind::LOWPASS => slot.biquad.set_lowpass(sample_rate, p[0], p[1]),
                kind::HIGHPASS => slot.biquad.set_highpass(sample_rate, p[0], p[1]),
                kind::COMPRESSOR => {
                    // The rule for every kind: the compressor keeps its envelope only when it
                    // stays in the same slot.
                    if old_compressor != Some(n) {
                        self.compressor = Compressor::default();
                        self.compressor_glide = 0;
                    }
                    // B4 (R7): a compressor that is running (it has compressed a quantum since it
                    // was built or reset, at this rate) glides to changed parameters over
                    // `COMPRESSOR_SMOOTH_MS`; one that hasn't run takes them at once (init, a new
                    // or moved slot, the replay after RESET). Unchanged parameters (a resent tree)
                    // touch nothing: a glide in flight carries on, a settled compressor stays
                    // bit-identical.
                    let target = Compressor::clamp([p[0], p[1], p[2], p[3], p[4]]);
                    let running = self.compressor.constructed != 0 && self.compressor.sample_rate == sample_rate;
                    if !running {
                        self.compressor.configure(sample_rate, p[0], p[1], p[2], p[3], p[4]);
                        self.compressor_glide = 0;
                    } else if target != if self.compressor_glide != 0 { old_target.unwrap_or(target) } else { self.compressor.params } {
                        // A new glide, or a retarget mid-glide: from where the parameters are now.
                        self.compressor_glide = smooth_frames(sample_rate);
                    }
                    compressor = Some(n);
                }
                kind::REVERB_SEND => slot.p[0] = p[0].clamp(0.0, 1.0),
                _ => {}
            }
            n += 1;
        }
        self.count = n as u32;
        self.compressor_slot = compressor.map_or(NO_COMPRESSOR, |i| i as u32);
        dropped
    }

    /// Runs the chain on one block of the bus (`left`, `right`, equal lengths). Each reverb send
    /// adds `send * signal` (the signal at its slot) into `reverb_l`/`reverb_r` (at least as long):
    /// the bus's send scratch, which `sends::feed` adds into the shared reverb input. Returns
    /// `true` when a send wrote into it.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], reverb_l: &mut [f32], reverb_r: &mut [f32]) -> bool {
        let mut sent = false;
        let used = self.used();
        for slot in self.slots[..used].iter_mut() {
            match slot.kind {
                kind::LOWPASS | kind::HIGHPASS => slot.biquad.process(left, right),
                // `configure` keeps at most one compressor slot: the one `compressor` belongs to.
                kind::COMPRESSOR => {
                    if self.compressor_glide != 0 {
                        let p = slot.p;
                        let target = Compressor::clamp([p[0], p[1], p[2], p[3], p[4]]);
                        self.compressor.glide(&target, &mut self.compressor_glide, left.len().min(right.len()) as u32);
                        self.compressor.process_gliding(left, right)
                    } else {
                        self.compressor.process(left, right)
                    }
                }
                kind::REVERB_SEND => {
                    let send = slot.p[0];
                    if send > 0.0 {
                        for (acc, x) in reverb_l.iter_mut().zip(left.iter()) {
                            *acc += send * *x;
                        }
                        for (acc, x) in reverb_r.iter_mut().zip(right.iter()) {
                            *acc += send * *x;
                        }
                        sent = true;
                    }
                }
                _ => {}
            }
        }
        sent
    }

    /// `true` when a slot in use is a reverb send.
    pub fn has_reverb_send(&self) -> bool {
        self.slots[..self.used()].iter().any(|s| s.kind == kind::REVERB_SEND)
    }

    /// Clears every slot's filter and envelope state, keeping the configuration (RESET).
    pub fn reset(&mut self) {
        let used = self.used();
        for slot in self.slots[..used].iter_mut() {
            if matches!(slot.kind, kind::LOWPASS | kind::HIGHPASS) {
                slot.biquad.reset();
            }
        }
        if let Some(i) = self.compressor_in_use() {
            // A glide in flight lands: the compressor starts again on the edit's parameters.
            if self.compressor_glide != 0 {
                self.compressor.params = self.compressor_target(i);
                self.compressor_glide = 0;
            }
            self.compressor.reset();
        }
    }

    /// The kinds in use, in order (tests and the debug panel).
    pub fn kinds(&self) -> impl Iterator<Item = u32> + '_ {
        self.slots[..self.used()].iter().map(|s| s.kind)
    }
}

/// The compressor's parameter glide in frames: round(`COMPRESSOR_SMOOTH_MS` × rate / 1000), 960 at
/// 48 kHz (R7). At least one frame, so a glide always ends.
pub fn smooth_frames(sample_rate: f32) -> u32 {
    let frames = libm::roundf(wire::COMPRESSOR_SMOOTH_MS as f32 * sample_rate / 1000.0);
    if frames >= 1.0 {
        frames as u32
    } else {
        1
    }
}

/// `true` when a snapshot low-pass at `lp_hz` filters anything: a finite cut-off above 0 and below
/// the wire's "off" value (`BUS_LP_OFF_HZ`, 24,000 Hz).
pub fn lowpass_on(lp_hz: f32) -> bool {
    lp_hz.is_finite() && lp_hz > 0.0 && lp_hz < wire::BUS_LP_OFF_HZ as f32
}

/// The snapshot low-pass on one block: configures `filter` for `lp_hz` (Q [`SNAPSHOT_Q_DB`]) and
/// filters in place, or leaves the block untouched when the cut-off is off ([`lowpass_on`]).
///
/// **Engaging from off (F2).** While off, the filter's history follows the block as a pass-through
/// filter's would (`Biquad::follow`: four stores per channel per quantum, nothing per sample, the
/// samples untouched), so when the cut-off comes in its first quantum continues from the signal
/// instead of from rest (zero history before the first engagement, the last engagement's stale
/// history after). Before, a low-pass stepping in from off over DC 0.5 dropped the output by up to
/// 0.50 in one sample (0.18 in a 20 ms ramp); now it holds the level.
///
/// **The snapshot blend (B4).** `bus.rs` calls this once per quantum with the `snapshot` lane's
/// low-pass ramp sampled at the quantum's start, so a snapshot transition's coefficients are
/// recomputed per quantum along the ramp and the filter history carries over (S4's "step per
/// quantum" scheme: click-free, its glitch 1.19× its own per-sample version, against up to 3.5× for
/// an unblended switch; +370 wasm instructions per filter per moving quantum). A settled cut-off
/// recomputes nothing (`Biquad::set_lowpass` keeps the coefficients of an unchanged call).
pub fn snapshot_lowpass(filter: &mut Biquad, sample_rate: f32, lp_hz: f32, left: &mut [f32], right: &mut [f32]) {
    if lowpass_on(lp_hz) {
        filter.set_lowpass(sample_rate, lp_hz, SNAPSHOT_Q_DB);
        filter.process(left, right);
    } else {
        filter.follow(left, right);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(type_: u32, p0: f32) -> (u32, [f32; 7]) {
        (type_, [p0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    }

    #[test]
    fn a_zeroed_chain_is_empty() {
        let c = FxChain::default();
        assert_eq!(c.count, 0);
        assert_eq!(c.kinds().count(), 0);
        assert!(!c.has_reverb_send());
    }

    #[test]
    fn configure_keeps_order_and_drops_past_the_limit() {
        let mut c = FxChain::default();
        let effects = [fx(kind::LOWPASS, 800.0), fx(kind::COMPRESSOR, -24.0), fx(kind::HIGHPASS, 80.0), fx(kind::REVERB_SEND, 0.3), fx(kind::LOWPASS, 1.0)];
        assert_eq!(c.configure(effects, 48_000.0), 1);
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::LOWPASS, kind::COMPRESSOR, kind::HIGHPASS, kind::REVERB_SEND]);
        assert!(c.has_reverb_send());
        assert_eq!(c.slots[0].biquad.last, [1.0, 800.0, 1.0], "the biquad was configured");
    }

    #[test]
    fn unknown_types_and_bad_values_are_neutralised() {
        let mut c = FxChain::default();
        assert_eq!(c.configure([(9, [1.0; 7]), (kind::REVERB_SEND, [f32::NAN; 7]), fx(kind::REVERB_SEND, 7.0)], 48_000.0), 1);
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::NONE, kind::REVERB_SEND, kind::REVERB_SEND]);
        assert_eq!((c.slots[1].p[0], c.slots[2].p[0]), (0.0, 1.0), "NaN reads 0; the send clamps to 1");
        let (mut l, mut r) = ([0.5f32; 4], [0.25f32; 4]);
        let (mut rl, mut rr) = ([0.0f32; 4], [0.0f32; 4]);
        assert!(c.process(&mut l, &mut r, &mut rl, &mut rr));
        assert_eq!((l, r), ([0.5; 4], [0.25; 4]), "sends are taps; stubs pass through");
        assert_eq!((rl, rr), ([0.5; 4], [0.25; 4]), "a zero send adds nothing; a full send adds the signal");
    }

    #[test]
    fn a_kept_kind_keeps_its_state_and_a_new_kind_starts_zeroed() {
        let mut c = FxChain::default();
        c.configure([fx(kind::LOWPASS, 500.0)], 48_000.0);
        c.slots[0].biquad.history[0][0] = 0.75;
        c.configure([fx(kind::LOWPASS, 600.0)], 48_000.0);
        assert_eq!(c.slots[0].biquad.history[0][0], 0.75, "same kind: state kept");
        c.configure([fx(kind::COMPRESSOR, -20.0)], 48_000.0);
        assert_eq!(c.compressor.params[0], -20.0);
        c.configure([fx(kind::LOWPASS, 600.0)], 48_000.0);
        assert_eq!(c.slots[0].biquad.history[0][0], 0.0, "a kind change zeroes the state");
    }

    #[test]
    fn reset_clears_state_but_keeps_the_configuration() {
        let mut c = FxChain::default();
        c.configure([fx(kind::HIGHPASS, 100.0)], 48_000.0);
        c.slots[0].biquad.history[1][3] = 0.5;
        c.reset();
        assert_eq!(c.slots[0].biquad.history[1][3], 0.0);
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::HIGHPASS]);
    }

    #[test]
    fn a_second_compressor_is_dropped_and_keeps_its_place() {
        let mut c = FxChain::default();
        let effects = [fx(kind::HIGHPASS, 80.0), fx(kind::COMPRESSOR, -20.0), fx(kind::COMPRESSOR, -10.0), fx(kind::LOWPASS, 900.0)];
        assert_eq!(c.configure(effects, 48_000.0), 1, "the second compressor is counted");
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::HIGHPASS, kind::COMPRESSOR, kind::NONE, kind::LOWPASS]);
        assert_eq!((c.compressor_slot, c.compressor.params[0]), (1, -20.0), "the first compressor runs");
        assert_eq!(c.slots[3].biquad.last, [1.0, 900.0, 1.0], "later effects keep their slot");
        c.configure([fx(kind::LOWPASS, 900.0)], 48_000.0);
        assert_eq!(c.compressor_slot, NO_COMPRESSOR);
    }

    #[test]
    fn the_compressor_keeps_its_envelope_only_in_the_same_slot() {
        let mut c = FxChain::default();
        c.configure([fx(kind::COMPRESSOR, -20.0)], 48_000.0);
        c.compressor.detector_average = 0.5;
        c.configure([fx(kind::COMPRESSOR, -30.0), fx(kind::LOWPASS, 900.0)], 48_000.0);
        assert_eq!((c.compressor.detector_average, c.compressor.params[0]), (0.5, -30.0), "same slot: state kept, parameters updated");
        c.configure([fx(kind::LOWPASS, 900.0), fx(kind::COMPRESSOR, -30.0)], 48_000.0);
        assert_eq!(c.compressor.detector_average, 0.0, "moved to another slot: starts zeroed");
        c.compressor.detector_average = 0.5;
        c.configure([fx(kind::LOWPASS, 900.0)], 48_000.0);
        c.configure([fx(kind::LOWPASS, 900.0), fx(kind::COMPRESSOR, -30.0)], 48_000.0);
        assert_eq!(c.compressor.detector_average, 0.0, "removed then added back: starts zeroed");
        c.compressor.constructed = 1;
        c.reset();
        assert_eq!(c.compressor.constructed, 0, "RESET returns it to a new node's state");
    }

    #[test]
    fn a_compressor_slot_matches_a_lone_compressor() {
        let mut c = FxChain::default();
        c.configure([fx(kind::HIGHPASS, 20.0), fx(kind::COMPRESSOR, -30.0), fx(kind::COMPRESSOR, -5.0)], 48_000.0);
        let mut hp = Biquad::default();
        hp.set_highpass(48_000.0, 20.0, 1.0);
        let mut alone = Compressor::default();
        alone.configure(48_000.0, -30.0, 1.0, 0.0, 0.0, 0.0);
        for q in 0..8 {
            let mut l: Vec<f32> = (0..128).map(|i| ((q * 128 + i) as f32 * 0.05).sin() * 0.9).collect();
            let mut r: Vec<f32> = l.iter().map(|x| -x * 0.5).collect();
            let (mut el, mut er) = (l.clone(), r.clone());
            let (mut rl, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
            c.process(&mut l, &mut r, &mut rl, &mut rr);
            hp.process(&mut el, &mut er);
            alone.process(&mut el, &mut er);
            assert_eq!((l, r), (el, er), "quantum {q}");
        }
    }

    fn comp(threshold: f32) -> (u32, [f32; 7]) {
        (kind::COMPRESSOR, [threshold, 6.0, 4.0, 0.003, 0.25, 0.0, 0.0])
    }

    fn run(c: &mut FxChain, quanta: usize) {
        for _ in 0..quanta {
            let (mut l, mut r) = ([0.5f32; 128], [0.5f32; 128]);
            let (mut rl, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
            c.process(&mut l, &mut r, &mut rl, &mut rr);
        }
    }

    #[test]
    fn a_running_compressor_glides_to_an_edit_and_an_idle_one_takes_it_at_once() {
        assert_eq!((smooth_frames(48_000.0), smooth_frames(44_100.0), smooth_frames(0.0)), (960, 882, 1));
        let mut c = FxChain::default();
        c.configure([comp(-24.0)], 48_000.0);
        c.configure([comp(-30.0)], 48_000.0);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (-30.0, 0), "not run yet: at once");
        run(&mut c, 1);
        c.configure([comp(-40.0)], 48_000.0);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (-30.0, 960), "running: a glide starts, nothing moves yet");
        run(&mut c, 1);
        assert!((c.compressor.params[0] - (-30.0 - 10.0 * 128.0 / 960.0)).abs() < 1e-4, "{}", c.compressor.params[0]);
        c.configure([comp(-40.0)], 48_000.0);
        assert_eq!(c.compressor_glide, 960 - 128, "an unchanged resend keeps the glide in flight");
        run(&mut c, 7);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (-40.0, 0), "landed on the target in 8 quanta");
        c.configure([comp(-40.0)], 48_000.0);
        assert_eq!(c.compressor_glide, 0, "unchanged: no glide");
        c.configure([comp(-20.0)], 44_100.0);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (-20.0, 0), "a rate change takes the edit at once");
    }

    #[test]
    fn a_retarget_glides_on_from_where_it_is_and_reset_lands_the_glide() {
        let mut c = FxChain::default();
        c.configure([comp(-24.0)], 48_000.0);
        run(&mut c, 1);
        c.configure([comp(-48.0)], 48_000.0);
        run(&mut c, 3);
        let mid = c.compressor.params[0];
        assert!((mid - (-24.0 - 24.0 * 384.0 / 960.0)).abs() < 1e-4, "{mid}");
        c.configure([comp(-12.0)], 48_000.0);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (mid, 960), "retargeted from where it is, over the whole glide");
        run(&mut c, 1);
        assert!(c.compressor.params[0] > mid);
        c.reset();
        assert_eq!((c.compressor.params[0], c.compressor_glide, c.compressor.constructed), (-12.0, 0, 0), "RESET lands the glide");
        c.configure([comp(-6.0), fx(kind::LOWPASS, 900.0)], 48_000.0);
        assert_eq!(c.compressor_glide, 0, "after RESET the compressor hasn't run: at once");
        run(&mut c, 1);
        c.configure([fx(kind::LOWPASS, 900.0), comp(-30.0)], 48_000.0);
        assert_eq!((c.compressor.params[0], c.compressor_glide), (-30.0, 0), "a moved compressor starts zeroed and takes it at once");
    }

    #[test]
    fn the_snapshot_lowpass_is_off_at_24_khz_and_for_bad_values() {
        assert!(lowpass_on(500.0));
        assert!(!lowpass_on(24_000.0));
        assert!(!lowpass_on(0.0));
        assert!(!lowpass_on(f32::NAN));
        let mut f = Biquad::default();
        let (mut l, mut r) = ([1.0f32; 2], [1.0f32; 2]);
        snapshot_lowpass(&mut f, 48_000.0, 24_000.0, &mut l, &mut r);
        assert_eq!(f.last, [0.0; 3], "off: not configured");
        snapshot_lowpass(&mut f, 48_000.0, 500.0, &mut l, &mut r);
        assert_eq!(f.last, [1.0, 500.0, SNAPSHOT_Q_DB]);
    }
}
