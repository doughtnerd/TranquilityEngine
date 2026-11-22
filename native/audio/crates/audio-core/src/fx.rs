//! Contract K5: per-bus effect slots and their dispatch (api-and-models §4.2 BUS_CONFIG; ADR 0331).
//!
//! BUS_CONFIG and BUS_SLOT carry each bus's effects in order: `u32 type` and `f32 p[7]`.
//! - **Legacy types** (0 lowpass, 1 highpass, 2 compressor, 3 reverb send; lp/hp: frequency Hz, q
//!   in dB; compressor: threshold dB, knee dB, ratio, attack s, release s; reverb: send) behave as
//!   they always have, bit for bit.
//! - **Catalogue types** (ABI 4.6): `BUS_FX_CATALOGUE + k`, `k` one of the wire's `SUBMIX_FX_*`
//!   kinds, `p` the catalogue's parameters in its order (`effects/catalogue.ts`). They run the same
//!   effect code as the instance submixes (`audio_dsp::fx::Effect`, held in the slot's `fx`), with
//!   their large state in the effect memory (`fxmem.rs`) and their parameters smoothed
//!   (`audio_dsp::fx`'s glide). A sidechain compressor's key is `p[3]`, a bus slot: its pre-fader
//!   level ([`BusArea::key_db`](crate::bus::BusArea), measured where the key bus is mixed; the key
//!   is mixed first, `bus_order::rerun`).
//!
//! [`FxChain::configure_with`] stores them in a bus's fixed slots and [`FxChain::process_with`]
//! runs them in order on the bus's quantum, before the snapshot low-pass and the bus gain (the
//! chain of `webAudioReference.ts`: input, effects, low-pass, gain).
//!
//! The DSP behind each kind lives in `audio-dsp`:
//! - `lowpass`, `highpass`, and the snapshot low-pass: `audio_dsp::biquad::Biquad` (A2.2a);
//! - `compressor`: `audio_dsp::compressor::Compressor` (A2.2a);
//! - `reverbSend`: adds `send * signal` into the bus's send scratch (M5, K1: a 1 KB planar stereo
//!   buffer shared by every bus, since they mix one at a time), and leaves the bus signal unchanged
//!   (a tap); `bus.rs` hands the scratch to `sends::feed` after the bus's gain stage, which adds it
//!   into the shared reverb input (post-fader scaling: Rv1); the shared `audio_dsp::convolver`
//!   (A2.2b) renders the wet signal once per quantum in `bus.rs`;
//! - the catalogue's kinds: `audio_dsp::fx` (ADR 0331).
//!
//! **Limits and bad input** (ADR 0331: no four-effect, one-compressor limit). A bus keeps at most
//! [`MAX_EFFECTS`] (8) effects; the rest, and effects of an unknown type (a newer minor), are
//! dropped and counted (the count is returned to `bus.rs`, which keeps it in its area: the wire has
//! no STATUS field for it). An unknown type keeps its place as a [`kind::NONE`] slot, so the others
//! keep their slots. The first legacy compressor runs the bus's own compressor (below); a further
//! one runs as the catalogue's compressor with the same parameters (no makeup), in the effect
//! memory. A non-finite parameter is read as 0; a send is clamped to 0..1. A slot that keeps its
//! kind across a BUS_CONFIG keeps its filter or envelope state (an effect edit doesn't click); a
//! slot whose kind changes starts from zeroed state.
//!
//! **Smoothing (B4, R7; architecture §4.7; ADR 0331).** The legacy compressor's parameters glide,
//! stepping once per quantum along a straight line over `COMPRESSOR_SMOOTH_MS` ([`smooth_frames`],
//! `Compressor::glide`), so a threshold step no longer clicks; legacy filter frequency and Q and
//! the send level stay direct (S4: abrupt 0.15 and 0.10). Every catalogue effect glides
//! (`audio_dsp::fx::SMOOTH_MS`, the same 20 ms), filters in octaves. The snapshot low-pass's
//! coefficients follow its lane's ramp once per quantum ([`snapshot_lowpass`]: S4's per-quantum
//! coefficient blend, +370 instructions per filter). Unchanged parameters cost nothing and stay
//! bit-identical.
//!
//! **Memory.** The legacy compressor's state (about 2.4 KB, most of it its pre-delay line) is held
//! once per bus, in [`FxChain::compressor`], beside the slots; a slot keeps a biquad's state
//! (lowpass, highpass), a send gain (in `p[0]`), or a catalogue effect's small state (`fx`), whose
//! delay lines and networks live in the effect memory.
//!
//! All-zero is a valid empty chain. Nothing here allocates.

use audio_dsp::biquad::Biquad;
use audio_dsp::compressor::Compressor;
use audio_dsp::fx::{Ctx, Effect, PARAMS};
use audio_wire::generated as wire;

/// Most effects per bus (a bus's slots are fixed so the `Buses` region never grows; the wire's
/// `BUS_SLOT_MAX_EFFECTS`, ADR 0331's insert cap).
pub const MAX_EFFECTS: usize = wire::BUS_SLOT_MAX_EFFECTS as usize;

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
    /// A catalogue effect is this plus its `audio_dsp::fx::kind` (the wire's `BUS_FX_CATALOGUE`).
    pub const CATALOGUE: u32 = wire::BUS_FX_CATALOGUE;
    /// An unknown type: skipped.
    pub const NONE: u32 = u32::MAX;

    /// The catalogue kind of slot kind `k`, if it is one.
    pub fn catalogue(k: u32) -> Option<u32> {
        let c = k.checked_sub(CATALOGUE)?;
        (c > audio_dsp::fx::kind::NONE && c < audio_dsp::fx::kind::COUNT).then_some(c)
    }
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
    /// A catalogue effect's state (all-zero for the legacy kinds).
    pub fx: Effect,
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

/// A legacy compressor's parameters (threshold dB, knee dB, ratio, attack s, release s) as the
/// catalogue's (threshold, ratio, attack ms, release ms, makeup 0, knee).
fn catalogue_compressor(p: &[f32; 7]) -> [f32; PARAMS] {
    [p[0], p[2], p[3] * 1000.0, p[4] * 1000.0, 0.0, p[1], 0.0, 0.0]
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

    /// [`FxChain::configure_with`] without effect memory (catalogue effects that need memory pass
    /// their signal through): the legacy chains' tests.
    pub fn configure<I: IntoIterator<Item = (u32, [f32; 7])>>(&mut self, effects: I, sample_rate: f32) -> u32 {
        self.configure_with(effects, sample_rate, &mut [])
    }

    /// Stores the effects `(type, p)` in order (BUS_CONFIG, BUS_SLOT), catalogue effects taking
    /// their memory from the `FxMem` region `fxmem`. Returns how many were dropped: past
    /// [`MAX_EFFECTS`], or of an unknown type (which keeps its place as a [`kind::NONE`] slot, so
    /// the order of the others is kept).
    pub fn configure_with<I: IntoIterator<Item = (u32, [f32; 7])>>(&mut self, effects: I, sample_rate: f32, fxmem: &mut [u8]) -> u32 {
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
            let mut p = [0.0f32; 7];
            for (dst, src) in p.iter_mut().zip(raw) {
                *dst = if src.is_finite() { src } else { 0.0 };
            }
            // A second legacy compressor runs as the catalogue's (ADR 0331: no one-compressor limit).
            let (k, cat) = match type_ {
                kind::COMPRESSOR if compressor.is_some() => (kind::CATALOGUE + audio_dsp::fx::kind::COMPRESSOR, Some(catalogue_compressor(&p))),
                kind::LOWPASS | kind::HIGHPASS | kind::COMPRESSOR | kind::REVERB_SEND => (type_, None),
                t => match kind::catalogue(t) {
                    Some(_) => {
                        let mut q = [0.0f32; PARAMS];
                        q[..7].copy_from_slice(&p);
                        (t, Some(q))
                    }
                    None => {
                        dropped += 1;
                        (kind::NONE, None)
                    }
                },
            };
            let in_use = n < self.count as usize;
            let slot = &mut self.slots[n];
            let kept = slot.kind == k && in_use;
            if !kept {
                slot.biquad = Biquad::default();
            }
            slot.kind = k;
            slot.p = p;
            match (kind::catalogue(k), cat) {
                (Some(c), Some(q)) => crate::fxmem::configure(fxmem, &mut slot.fx, kept, c, true, &q, sample_rate),
                _ => slot.fx = Effect::default(),
            }
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
        for slot in self.slots[n..].iter_mut() {
            slot.fx = Effect::default();
        }
        self.count = n as u32;
        self.compressor_slot = compressor.map_or(NO_COMPRESSOR, |i| i as u32);
        dropped
    }

    /// [`FxChain::process_with`] without effect memory or sidechain keys.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], reverb_l: &mut [f32], reverb_r: &mut [f32]) -> bool {
        self.process_with(left, right, reverb_l, reverb_r, &mut [], &[])
    }

    /// Runs the chain on one block of the bus (`left`, `right`, equal lengths). Each reverb send
    /// adds `send * signal` (the signal at its slot) into `reverb_l`/`reverb_r` (at least as long):
    /// the bus's send scratch, which `sends::feed` adds into the shared reverb input. Catalogue
    /// effects run on their memory in `fxdata` (the `FxMem` region's floats); a sidechain
    /// compressor reads its key's level from `keys` (dB by bus slot; NaN or out of range: none).
    /// Returns `true` when a send wrote into the scratch.
    pub fn process_with(&mut self, left: &mut [f32], right: &mut [f32], reverb_l: &mut [f32], reverb_r: &mut [f32], fxdata: &mut [f32], keys: &[f32]) -> bool {
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
                k if kind::catalogue(k).is_some() => {
                    let e = &mut slot.fx;
                    let key = e.target[3];
                    let key_db = if key >= 0.0 && (key as usize) < keys.len() { keys[key as usize] } else { f32::NAN };
                    let mem = crate::fxmem::slice(fxdata, e);
                    e.process(mem, left, right, &Ctx { key_db });
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

    /// The key bus of each sidechain compressor in use (`p[3]`, a bus slot).
    pub fn sidechain_keys(&self) -> impl Iterator<Item = u16> + '_ {
        self.slots[..self.used()]
            .iter()
            .filter(|s| s.kind == kind::CATALOGUE + audio_dsp::fx::kind::SIDECHAIN && s.p[3] >= 0.0 && s.p[3] < u16::MAX as f32)
            .map(|s| s.p[3] as u16)
    }

    /// Calls `f` with each catalogue effect in use (the effect memory's sweep).
    pub fn for_each_effect(&self, f: &mut impl FnMut(&Effect)) {
        for s in &self.slots[..self.used()] {
            if kind::catalogue(s.kind).is_some() {
                f(&s.fx);
            }
        }
    }

    /// Clears every slot's filter and envelope state, keeping the configuration (RESET). A
    /// catalogue effect's memory in `fxdata` is zeroed with it.
    pub fn reset_with(&mut self, fxdata: &mut [f32]) {
        let used = self.used();
        for slot in self.slots[..used].iter_mut() {
            if matches!(slot.kind, kind::LOWPASS | kind::HIGHPASS) {
                slot.biquad.reset();
            }
            if kind::catalogue(slot.kind).is_some() {
                let mem = crate::fxmem::slice(fxdata, &slot.fx);
                slot.fx.reset(mem);
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

    /// [`FxChain::reset_with`] without effect memory.
    pub fn reset(&mut self) {
        self.reset_with(&mut []);
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
        let mut effects = vec![fx(kind::LOWPASS, 800.0), fx(kind::COMPRESSOR, -24.0), fx(kind::HIGHPASS, 80.0), fx(kind::REVERB_SEND, 0.3)];
        effects.extend((0..5).map(|i| fx(kind::LOWPASS, 1_000.0 + i as f32)));
        assert_eq!(c.configure(effects, 48_000.0), 1, "ADR 0331: eight effects a bus");
        assert_eq!(c.kinds().take(5).collect::<Vec<_>>(), vec![kind::LOWPASS, kind::COMPRESSOR, kind::HIGHPASS, kind::REVERB_SEND, kind::LOWPASS]);
        assert_eq!(c.kinds().count(), MAX_EFFECTS);
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

    /// An `FxMem` region of `blocks` blocks, 64-byte aligned, inside `buf`.
    fn region(buf: &mut Vec<u8>, blocks: usize) -> &mut [u8] {
        let header = (core::mem::size_of::<crate::fxmem::Header>() + 63) / 64 * 64;
        let len = header + blocks * crate::fxmem::BLOCK_FLOATS * 4;
        *buf = vec![0u8; len + 64];
        let skip = (64 - buf.as_ptr() as usize % 64) % 64;
        let r = &mut buf[skip..skip + len];
        crate::fxmem::init(r);
        r
    }

    #[test]
    fn a_second_compressor_runs_as_the_catalogues() {
        let mut buf = Vec::new();
        let mem = region(&mut buf, 8);
        let mut c = FxChain::default();
        let effects = [fx(kind::HIGHPASS, 80.0), comp(-20.0), comp(-10.0), fx(kind::LOWPASS, 900.0)];
        assert_eq!(c.configure_with(effects, 48_000.0, mem), 0, "ADR 0331: no one-compressor limit");
        let cat = kind::CATALOGUE + audio_dsp::fx::kind::COMPRESSOR;
        assert_eq!(c.kinds().collect::<Vec<_>>(), vec![kind::HIGHPASS, kind::COMPRESSOR, cat, kind::LOWPASS]);
        assert_eq!((c.compressor_slot, c.compressor.params[0]), (1, -20.0), "the first compressor runs the bus's own");
        let want = [-10.0, 4.0, 3.0, 250.0, 0.0, 6.0];
        assert!(c.slots[2].fx.target.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-4), "the second as the catalogue's, same parameters: {:?}", c.slots[2].fx.target);
        assert!(c.slots[2].fx.mem_len > 0, "with its memory");
        assert_eq!(c.slots[3].biquad.last, [1.0, 900.0, 1.0], "later effects keep their slot");
        c.configure([fx(kind::LOWPASS, 900.0)], 48_000.0);
        assert_eq!(c.compressor_slot, NO_COMPRESSOR);
    }

    #[test]
    fn catalogue_effects_run_on_a_bus_and_a_sidechain_reads_its_key() {
        let mut buf = Vec::new();
        let mem = region(&mut buf, 8);
        let mut c = FxChain::default();
        let gain = (kind::CATALOGUE + audio_dsp::fx::kind::GAIN, [-6.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        let sc = (kind::CATALOGUE + audio_dsp::fx::kind::SIDECHAIN, [-20.0, 4.0, 100.0, 2.0, 0.0, 0.0, 0.0]);
        assert_eq!(c.configure_with([gain, sc], 48_000.0, mem), 0);
        assert_eq!(c.sidechain_keys().collect::<Vec<_>>(), vec![2]);
        let (_, data) = crate::fxmem::split(mem).unwrap();
        let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
        let (mut rl, mut rr) = ([0.0f32; 128], [0.0f32; 128]);
        c.process_with(&mut l, &mut r, &mut rl, &mut rr, data, &[f32::NAN; 4]);
        let g = audio_dsp::compressor::db_to_linear(-6.0);
        assert!((l[127] - g).abs() < 1e-6, "the gain ran, no key: no ducking");
        for _ in 0..40 {
            let (mut l, mut r) = ([1.0f32; 128], [1.0f32; 128]);
            c.process_with(&mut l, &mut r, &mut rl, &mut rr, data, &[f32::NAN, f32::NAN, 0.0, f32::NAN]);
        }
        assert!((c.slots[1].fx.sidechain.reduction_db - 15.0).abs() < 0.1, "key at 0 dB, threshold -20, ratio 4");
        let unknown = (kind::CATALOGUE + 99, [0.0; 7]);
        assert_eq!(c.configure_with([unknown], 48_000.0, mem), 1, "a kind past the catalogue is dropped");
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
