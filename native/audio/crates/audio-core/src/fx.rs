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
//! - `reverbSend`: adds `send * signal` into the shared reverb input, and leaves the bus signal
//!   unchanged (a tap); the shared `audio_dsp::convolver` (A2.2b) renders the wet signal once per
//!   quantum in `bus.rs`.
//!
//! In A2.1 those modules are passthrough stubs, so a configured chain changes nothing yet.
//!
//! **Limits and bad input.** A bus keeps at most [`MAX_EFFECTS`] effects; the rest, and effects of
//! an unknown type (a newer minor), are dropped and counted (the count is returned to `bus.rs`,
//! which keeps it in its area: the wire has no STATUS field for it). A non-finite parameter is
//! read as 0; a send is clamped to 0..1. A slot that keeps its kind across a BUS_CONFIG keeps its
//! filter or envelope state (an effect edit doesn't click); a slot whose kind changes starts from
//! zeroed state.
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
    /// An unknown type: skipped.
    pub const NONE: u32 = u32::MAX;
}

/// A slot's DSP state: one of the kinds' state types. All-zero is valid for each.
#[repr(C)]
#[derive(Clone, Copy)]
pub union FxState {
    pub biquad: Biquad,
    pub compressor: Compressor,
}

impl FxState {
    fn zeroed() -> FxState {
        // SAFETY: every member is all-zero valid (`audio-dsp`'s contract for both types).
        unsafe { core::mem::zeroed() }
    }
}

/// One effect slot. All-zero is a lowpass with zeroed parameters, which is never processed unless
/// it is within the chain's `count`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FxSlot {
    /// [`kind`].
    pub kind: u32,
    /// The wire parameters, sanitised (non-finite to 0).
    pub p: [f32; 7],
    pub state: FxState,
}

/// One bus's effect chain. All-zero is an empty chain.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct FxChain {
    /// Slots in use, in order.
    pub count: u32,
    pub slots: [FxSlot; MAX_EFFECTS],
}

impl Default for FxChain {
    fn default() -> FxChain {
        // SAFETY: integers, floats and all-zero-valid DSP state only.
        unsafe { core::mem::zeroed() }
    }
}

impl FxChain {
    /// Stores the effects `(type, p)` in order (BUS_CONFIG). Returns how many were dropped: past
    /// [`MAX_EFFECTS`], or of an unknown type (those keep their place as a [`kind::NONE`] slot, so
    /// the order of the others is kept).
    pub fn configure<I: IntoIterator<Item = (u32, [f32; 7])>>(&mut self, effects: I, sample_rate: f32) -> u32 {
        let mut n = 0usize;
        let mut dropped = 0u32;
        for (type_, raw) in effects {
            if n >= MAX_EFFECTS {
                dropped += 1;
                continue;
            }
            let k = match type_ {
                kind::LOWPASS | kind::HIGHPASS | kind::COMPRESSOR | kind::REVERB_SEND => type_,
                _ => {
                    dropped += 1;
                    kind::NONE
                }
            };
            let slot = &mut self.slots[n];
            if slot.kind != k || n >= self.count as usize {
                slot.state = FxState::zeroed();
            }
            slot.kind = k;
            for (dst, src) in slot.p.iter_mut().zip(raw) {
                *dst = if src.is_finite() { src } else { 0.0 };
            }
            let p = slot.p;
            // SAFETY: the member read and written matches `k` (the state was zeroed on a kind
            // change, and all-zero is valid for every member).
            unsafe {
                match k {
                    kind::LOWPASS => slot.state.biquad.set_lowpass(sample_rate, p[0], p[1]),
                    kind::HIGHPASS => slot.state.biquad.set_highpass(sample_rate, p[0], p[1]),
                    kind::COMPRESSOR => slot.state.compressor.configure(sample_rate, p[0], p[1], p[2], p[3], p[4]),
                    kind::REVERB_SEND => slot.p[0] = p[0].clamp(0.0, 1.0),
                    _ => {}
                }
            }
            n += 1;
        }
        self.count = n as u32;
        dropped
    }

    /// Runs the chain on one block of the bus (`left`, `right`, equal lengths). Each reverb send
    /// adds `send * signal` into `reverb_l`/`reverb_r` (at least as long). Returns `true` when a
    /// send fed the reverb.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], reverb_l: &mut [f32], reverb_r: &mut [f32]) -> bool {
        let mut sent = false;
        for slot in self.slots[..(self.count as usize).min(MAX_EFFECTS)].iter_mut() {
            // SAFETY: each arm reads the member `configure` set up for the slot's kind.
            unsafe {
                match slot.kind {
                    kind::LOWPASS | kind::HIGHPASS => slot.state.biquad.process(left, right),
                    kind::COMPRESSOR => slot.state.compressor.process(left, right),
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
        }
        sent
    }

    /// `true` when a slot in use is a reverb send.
    pub fn has_reverb_send(&self) -> bool {
        self.slots[..(self.count as usize).min(MAX_EFFECTS)].iter().any(|s| s.kind == kind::REVERB_SEND)
    }

    /// Clears every slot's filter and envelope state, keeping the configuration (RESET).
    pub fn reset(&mut self) {
        for slot in self.slots[..(self.count as usize).min(MAX_EFFECTS)].iter_mut() {
            // SAFETY: as in `process`.
            unsafe {
                match slot.kind {
                    kind::LOWPASS | kind::HIGHPASS => slot.state.biquad.reset(),
                    kind::COMPRESSOR => slot.state.compressor.reset(),
                    _ => {}
                }
            }
        }
    }

    /// The kinds in use, in order (tests and the debug panel).
    pub fn kinds(&self) -> impl Iterator<Item = u32> + '_ {
        self.slots[..(self.count as usize).min(MAX_EFFECTS)].iter().map(|s| s.kind)
    }
}

/// `true` when a snapshot low-pass at `lp_hz` filters anything: a finite cut-off above 0 and below
/// the wire's "off" value (`BUS_LP_OFF_HZ`, 24,000 Hz).
pub fn lowpass_on(lp_hz: f32) -> bool {
    lp_hz.is_finite() && lp_hz > 0.0 && lp_hz < wire::BUS_LP_OFF_HZ as f32
}

/// The snapshot low-pass on one block: configures `filter` for `lp_hz` (Q [`SNAPSHOT_Q_DB`]) and
/// filters in place, or does nothing when the cut-off is off ([`lowpass_on`]).
pub fn snapshot_lowpass(filter: &mut Biquad, sample_rate: f32, lp_hz: f32, left: &mut [f32], right: &mut [f32]) {
    if lowpass_on(lp_hz) {
        filter.set_lowpass(sample_rate, lp_hz, SNAPSHOT_Q_DB);
        filter.process(left, right);
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
        // SAFETY: slot 0 is a lowpass.
        assert_eq!(unsafe { c.slots[0].state.biquad.last }, [1.0, 800.0, 1.0], "the biquad was configured");
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
        // SAFETY: slot 0 is a lowpass.
        unsafe { c.slots[0].state.biquad.history[0][0] = 0.75 };
        c.configure([fx(kind::LOWPASS, 600.0)], 48_000.0);
        assert_eq!(unsafe { c.slots[0].state.biquad.history[0][0] }, 0.75, "same kind: state kept");
        c.configure([fx(kind::COMPRESSOR, -20.0)], 48_000.0);
        assert_eq!(unsafe { c.slots[0].state.compressor.params[0] }, -20.0);
        c.configure([fx(kind::LOWPASS, 600.0)], 48_000.0);
        assert_eq!(unsafe { c.slots[0].state.biquad.history[0][0] }, 0.0, "a kind change zeroes the state");
    }

    #[test]
    fn reset_clears_state_but_keeps_the_configuration() {
        let mut c = FxChain::default();
        c.configure([fx(kind::HIGHPASS, 100.0)], 48_000.0);
        unsafe { c.slots[0].state.biquad.history[1][3] = 0.5 };
        c.reset();
        assert_eq!(unsafe { c.slots[0].state.biquad.history[1][3] }, 0.0);
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::HIGHPASS]);
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
