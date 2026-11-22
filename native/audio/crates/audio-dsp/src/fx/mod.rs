//! The effect catalogue's DSP (ADR 0331 "DSP to write"): one implementation of every runtime
//! effect type, shared by the bus chains, the instance submixes and (later) the offline sample
//! render. [`Effect`] is one effect slot: its kind, its parameters (the catalogue's, in the
//! catalogue's order, `effects/catalogue.ts`), their smoothed values and its small DSP state;
//! anything large (delay lines, the reverb's network, the compressor's look-ahead) lives in a
//! memory slice its owner hands to [`Effect::process`], sized by [`mem_floats`].
//!
//! **No worklet assumptions.** Nothing here allocates, reads a clock or a global: an owner in the
//! audio core gives each effect a slice of its effect memory (`audio-core`'s `fxmem.rs`); an
//! offline renderer gives it a `Vec`. The same blocks in give the same samples out, on every
//! platform (`libm` for every transcendental).
//!
//! **Kinds** ([`kind`]) are the wire's `SUBMIX_FX_*` (the core asserts they agree); a kind this
//! module doesn't know passes the signal through. Per kind, the parameters `p[0..]` are:
//!
//! | kind | parameters | memory |
//! |---|---|---|
//! | `LOWPASS`, `HIGHPASS` | cutoff Hz, resonance 0..1 (Q 0.5..20 dB), drive % | — |
//! | `BANDPASS` | centre Hz, resonance 0..1 (Q 0.5..10), drive % | — |
//! | `EQ` | low, mid, high dB (`eq.rs`) | — |
//! | `COMPRESSOR` | threshold dB, ratio, attack ms, release ms, makeup dB, knee dB | the compressor |
//! | `SATURATION` | amount % | — |
//! | `DISTORTION` | drive 0..1, mix % | — |
//! | `BITCRUSH` | bits, downsample, mix % | — |
//! | `CHORUS` | rate Hz, depth %, mix % | two short lines |
//! | `DELAY` | time ms, feedback %, mix % | two lines, sized by the time |
//! | `REVERB` | size 0..1, decay s, mix % | the network, at size 1 |
//! | `FORMANT` | shift st | the analysis ring |
//! | `PITCH` | semitones, cents | two grain lines |
//! | `LIMITER` | ceiling dB, release ms | — |
//! | `SIDECHAIN` | threshold dB, ratio, release ms, key (the owner's: a bus index) | — |
//! | `GAIN` | gain dB | — |
//!
//! **Smoothing.** A running effect (one that has processed a block since it was made or reset)
//! glides to edited parameters over [`SMOOTH_MS`] (the bus compressor's `COMPRESSOR_SMOOTH_MS`),
//! stepping once per block, frequencies in log2 (an octave a step, not a hertz): filter
//! coefficients are recomputed each step (S4's per-quantum blend), and the parameters a kernel can
//! ramp inside the block (gain, delay time, reverb size, pitch ratio) move per sample from the
//! block's start value to its end value. An effect that hasn't run takes its parameters at once.
//! Unchanged parameters cost nothing.
//!
//! **Bypass** (`on` 0): the signal passes untouched and the state is kept (an effect switched back
//! on continues). A kind change starts from zeroed state; the owner zeroes its memory too.

pub mod delay;
pub mod dynamics;
pub mod eq;
pub mod formant;
pub mod pitch;
pub mod reverb;
pub mod shape;

use crate::biquad::Biquad;
use crate::compressor::{db_to_linear, Compressor};

/// The block the effects are written for (the core's quantum); shorter blocks work too.
pub const BLOCK: usize = 128;
/// Parameters per effect (the wire's `p` array).
pub const PARAMS: usize = 8;
/// The parameter glide, ms.
pub const SMOOTH_MS: f32 = 20.0;
/// A filter's Q in dB at resonance 0 and 1 (the bus chain's `Q_RANGE`, `legacyEffects.ts`).
pub const Q_RANGE_DB: (f32, f32) = (0.5, 20.0);

/// Effect kinds (the wire's `SUBMIX_FX_*`). 0 is an empty slot.
pub mod kind {
    pub const NONE: u32 = 0;
    pub const LOWPASS: u32 = 1;
    pub const HIGHPASS: u32 = 2;
    pub const COMPRESSOR: u32 = 3;
    pub const EQ: u32 = 4;
    pub const BANDPASS: u32 = 5;
    pub const SATURATION: u32 = 6;
    pub const DISTORTION: u32 = 7;
    pub const BITCRUSH: u32 = 8;
    pub const CHORUS: u32 = 9;
    pub const DELAY: u32 = 10;
    pub const REVERB: u32 = 11;
    pub const FORMANT: u32 = 12;
    pub const PITCH: u32 = 13;
    pub const LIMITER: u32 = 14;
    pub const SIDECHAIN: u32 = 15;
    pub const GAIN: u32 = 16;
    /// One past the last kind.
    pub const COUNT: u32 = 17;
}

/// What an effect reads from outside its chain this block.
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    /// A sidechain compressor's key level, dB (NaN: no key this block).
    pub key_db: f32,
}

impl Default for Ctx {
    fn default() -> Ctx {
        Ctx { key_db: f32::NAN }
    }
}

/// One effect slot. `#[repr(C)]`; all-zero is an empty slot.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Effect {
    /// [`kind`].
    pub kind: u32,
    /// Non-zero: runs; 0: bypassed (state kept).
    pub on: u32,
    /// The parameters as configured (non-finite read as 0).
    pub target: [f32; PARAMS],
    /// The parameters the DSP runs at (gliding to `target`).
    pub cur: [f32; PARAMS],
    /// Frames left in the glide (0: settled).
    pub glide: u32,
    /// Non-zero once a block has run since the slot was made or reset.
    pub running: u32,
    pub sample_rate: f32,
    /// The owner's: where its memory slice starts (in floats, in the owner's pool).
    pub mem_off: u32,
    /// The owner's: the floats its memory slice holds (0: none).
    pub mem_len: u32,
    pub _pad: u32,
    /// Filters: the filter (`bq[0]`), the EQ's three bands.
    pub bq: [Biquad; 3],
    pub crush: shape::CrushState,
    pub delay: delay::DelayState,
    pub chorus: delay::ChorusState,
    pub reverb: reverb::ReverbState,
    pub pitch: pitch::PitchState,
    pub formant: formant::FormantState,
    pub limiter: dynamics::LimiterState,
    pub sidechain: dynamics::SidechainState,
}

impl Default for Effect {
    fn default() -> Effect {
        // SAFETY: integers, floats and all-zero-valid DSP state only.
        unsafe { core::mem::zeroed() }
    }
}

/// The parameter glide in frames at `sample_rate`, at least 1.
pub fn smooth_frames(sample_rate: f32) -> u32 {
    let f = libm::roundf(SMOOTH_MS * sample_rate / 1000.0);
    if f >= 1.0 {
        f as u32
    } else {
        1
    }
}

/// A filter's Q in dB at resonance `r` (0..1, clamped).
pub fn q_db(r: f32) -> f32 {
    let r = shape::clamp(r, 0.0, 1.0);
    Q_RANGE_DB.0 + r * (Q_RANGE_DB.1 - Q_RANGE_DB.0)
}

/// True when parameter `i` of `kind` glides in log2 (frequencies).
fn is_log(kind: u32, i: usize) -> bool {
    i == 0 && matches!(kind, kind::LOWPASS | kind::HIGHPASS | kind::BANDPASS | kind::CHORUS)
}

/// True when parameter `i` of `kind` never glides (an index, not a level).
fn is_discrete(kind: u32, i: usize) -> bool {
    kind == kind::SIDECHAIN && i == 3
}

/// Floats of memory an effect of `kind` with parameters `p` needs at `sample_rate` (0: none).
pub fn mem_floats(kind: u32, p: &[f32; PARAMS], sample_rate: f32) -> usize {
    match kind {
        kind::COMPRESSOR => core::mem::size_of::<Compressor>().div_ceil(4),
        kind::CHORUS => delay::chorus_floats(sample_rate),
        kind::DELAY => delay::delay_floats(sample_rate, p[0]),
        kind::REVERB => reverb::floats(sample_rate),
        kind::FORMANT => formant::floats(sample_rate),
        kind::PITCH => pitch::floats(sample_rate),
        _ => 0,
    }
}

/// The compressor living in `mem`, when it is long and aligned enough.
fn compressor_in(mem: &mut [f32]) -> Option<&mut Compressor> {
    let bytes = core::mem::size_of_val(mem);
    let ptr = mem.as_mut_ptr();
    if bytes < core::mem::size_of::<Compressor>() || (ptr as usize) % core::mem::align_of::<Compressor>() != 0 {
        return None;
    }
    // SAFETY: long enough and aligned (checked); `Compressor` is integers and floats, all-zero
    // valid, and any bit pattern of them is a valid (if odd) state; `mem` is borrowed mutably for
    // the result's lifetime.
    Some(unsafe { &mut *(ptr as *mut Compressor) })
}

impl Effect {
    /// Configures the slot: `kind`, `on`, the catalogue's parameters `p` (non-finite read as 0).
    /// A different kind starts from zeroed state and returns `true`: the owner gives it fresh
    /// (zeroed) memory of [`mem_floats`]. The same kind keeps its state and, when running, glides
    /// to the new parameters.
    pub fn configure(&mut self, kind: u32, on: bool, p: &[f32; PARAMS], sample_rate: f32) -> bool {
        let fresh = self.kind != kind || self.sample_rate != sample_rate;
        if fresh {
            let (off, len) = (self.mem_off, self.mem_len);
            *self = Effect::default();
            self.mem_off = off;
            self.mem_len = len;
        }
        self.kind = kind;
        self.on = on as u32;
        self.sample_rate = sample_rate;
        for (t, v) in self.target.iter_mut().zip(p.iter()) {
            *t = if v.is_finite() { *v } else { 0.0 };
        }
        if self.running == 0 {
            self.cur = self.target;
            self.glide = 0;
        } else {
            for i in 0..PARAMS {
                if is_discrete(kind, i) {
                    self.cur[i] = self.target[i];
                }
            }
            if self.cur != self.target {
                self.glide = smooth_frames(sample_rate);
            }
        }
        fresh
    }

    /// Clears the DSP state and `mem` (RESET), keeping the configuration; a glide lands.
    pub fn reset(&mut self, mem: &mut [f32]) {
        mem.fill(0.0);
        for b in self.bq.iter_mut() {
            b.reset();
        }
        self.crush = Default::default();
        self.delay = Default::default();
        self.chorus = Default::default();
        self.reverb = Default::default();
        self.pitch = Default::default();
        self.formant = Default::default();
        self.limiter = Default::default();
        self.sidechain = Default::default();
        self.cur = self.target;
        self.glide = 0;
        self.running = 0;
    }

    /// One glide step over `n` frames; `true` when the parameters moved.
    fn step(&mut self, n: u32) -> bool {
        if self.glide == 0 {
            return false;
        }
        if self.glide <= n {
            self.cur = self.target;
            self.glide = 0;
            return true;
        }
        let u = n as f32 / self.glide as f32;
        for i in 0..PARAMS {
            let (c, t) = (self.cur[i], self.target[i]);
            self.cur[i] = if is_log(self.kind, i) && c > 0.0 && t > 0.0 {
                libm::exp2f(libm::log2f(c) + (libm::log2f(t) - libm::log2f(c)) * u)
            } else {
                c + (t - c) * u
            };
        }
        self.glide -= n;
        true
    }

    /// Recomputes the filters from `cur`.
    fn design(&mut self) {
        let sr = self.sample_rate;
        let c = self.cur;
        match self.kind {
            kind::LOWPASS => self.bq[0].set_lowpass(sr, c[0], q_db(c[1])),
            kind::HIGHPASS => self.bq[0].set_highpass(sr, c[0], q_db(c[1])),
            kind::BANDPASS => set(&mut self.bq[0], eq::bandpass(sr, c[0], eq::bandpass_q(c[1])), sr, c[0], c[1]),
            kind::EQ => {
                set(&mut self.bq[0], eq::low_shelf(sr, eq::EQ_LOW_HZ, shape::clamp(c[0], -24.0, 24.0)), sr, 1.0, c[0]);
                set(&mut self.bq[1], eq::peak(sr, eq::EQ_MID_HZ, eq::EQ_MID_Q, shape::clamp(c[1], -24.0, 24.0)), sr, 2.0, c[1]);
                set(&mut self.bq[2], eq::high_shelf(sr, eq::EQ_HIGH_HZ, shape::clamp(c[2], -24.0, 24.0)), sr, 3.0, c[2]);
            }
            _ => {}
        }
    }

    /// Runs the effect on one block in place (`l`, `r`: equal lengths). `mem` is its memory
    /// ([`mem_floats`]; a kind that needs memory and has too little passes the signal through).
    pub fn process(&mut self, mem: &mut [f32], l: &mut [f32], r: &mut [f32], ctx: &Ctx) {
        if self.on == 0 || self.kind == kind::NONE {
            return;
        }
        let n = l.len().min(r.len());
        let (l, r) = (&mut l[..n], &mut r[..n]);
        let prev = self.cur;
        let moved = self.step(n as u32);
        if moved || self.running == 0 {
            self.design();
        }
        let first = self.running == 0;
        self.running = 1;
        let sr = self.sample_rate;
        let c = self.cur;
        match self.kind {
            kind::LOWPASS | kind::HIGHPASS | kind::BANDPASS => {
                let g = shape::drive_gain(c[2]);
                shape::drive(l, g);
                shape::drive(r, g);
                self.bq[0].process(l, r);
            }
            kind::EQ => {
                for i in 0..3 {
                    if c[i] != 0.0 {
                        self.bq[i].process(l, r);
                    } else {
                        self.bq[i].follow(l, r);
                    }
                }
            }
            kind::COMPRESSOR => {
                let Some(comp) = compressor_in(mem) else { return };
                if moved || first {
                    comp.configure(sr, c[0], c[5], c[1], c[2] / 1000.0, c[3] / 1000.0);
                }
                comp.process(l, r);
                ramp_gain(l, r, db_to_linear(shape::clamp(prev[4], 0.0, 24.0)), db_to_linear(shape::clamp(c[4], 0.0, 24.0)));
            }
            kind::SATURATION => {
                let g = shape::saturation_gain(c[0]);
                shape::saturate(l, g);
                shape::saturate(r, g);
            }
            kind::DISTORTION => {
                let (g, m) = (shape::distortion_gain(c[0]), shape::clamp(c[1], 0.0, 100.0) / 100.0);
                shape::distort(l, g, m);
                shape::distort(r, g, m);
            }
            kind::BITCRUSH => shape::crush(&mut self.crush, l, r, c[0], c[1], shape::clamp(c[2], 0.0, 100.0) / 100.0),
            kind::CHORUS => delay::chorus(&mut self.chorus, mem, sr, l, r, c[0], c[1] / 100.0, c[2] / 100.0),
            kind::DELAY => {
                let fpm = sr / 1000.0;
                let d0 = shape::clamp(prev[0], 1.0, delay::DELAY_MAX_MS) * fpm;
                let d1 = shape::clamp(c[0], 1.0, delay::DELAY_MAX_MS) * fpm;
                delay::delay(&mut self.delay, mem, l, r, d0, d1, shape::clamp(c[1], 0.0, 95.0) / 100.0, shape::clamp(c[2], 0.0, 100.0) / 100.0)
            }
            kind::REVERB => reverb::process(&mut self.reverb, mem, sr, l, r, prev[0], c[0], shape::clamp(c[1], 0.1, 20.0), shape::clamp(c[2], 0.0, 100.0) / 100.0),
            kind::FORMANT => formant::process(&mut self.formant, mem, sr, l, r, c[0]),
            kind::PITCH => {
                let (r0, r1) = (pitch::ratio(prev[0], prev[1]), pitch::ratio(c[0], c[1]));
                if r0 == 1.0 && r1 == 1.0 {
                    pitch::follow(&mut self.pitch, mem, l, r);
                } else {
                    pitch::process(&mut self.pitch, mem, sr, l, r, r0, r1);
                }
            }
            kind::LIMITER => dynamics::limit(&mut self.limiter, sr, l, r, c[0], c[1]),
            kind::SIDECHAIN => dynamics::sidechain(&mut self.sidechain, sr, l, r, ctx.key_db, c[0], c[1], c[2]),
            kind::GAIN => ramp_gain(l, r, db_to_linear(shape::clamp(prev[0], -96.0, 48.0)), db_to_linear(shape::clamp(c[0], -96.0, 48.0))),
            _ => {}
        }
    }
}

/// Sets `b`'s coefficients directly (a design `Biquad`'s own setters don't cover): the tag in
/// `last[0]` is non-zero so `Biquad::process` runs it, and the rest records the arguments.
fn set(b: &mut Biquad, c: crate::biquad::coeffs::Coefficients, sr: f32, a: f32, v: f32) {
    b.coefficients = c;
    b.last = [9.0, a, v];
    b.sample_rate = sr;
}

/// Scales the block by a gain moving linearly from `g0` to `g1` (the identity when both are 1).
pub fn ramp_gain(l: &mut [f32], r: &mut [f32], g0: f32, g1: f32) {
    if g0 == 1.0 && g1 == 1.0 {
        return;
    }
    let n = l.len().min(r.len());
    if g0 == g1 {
        for i in 0..n {
            l[i] *= g1;
            r[i] *= g1;
        }
        return;
    }
    let step = (g1 - g0) / n.max(1) as f32;
    for i in 0..n {
        let g = g0 + step * (i as f32 + 1.0);
        l[i] *= g;
        r[i] *= g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(v: &[f32]) -> [f32; PARAMS] {
        let mut p = [0.0; PARAMS];
        p[..v.len()].copy_from_slice(v);
        p
    }

    fn sine(q: usize, hz: f32) -> ([f32; 128], [f32; 128]) {
        let l: [f32; 128] = core::array::from_fn(|i| 0.5 * libm::sinf(core::f32::consts::TAU * hz * (q * 128 + i) as f32 / 48_000.0));
        (l, l)
    }

    #[test]
    fn every_kind_runs_on_its_memory_and_stays_finite() {
        let sr = 48_000.0;
        let cases: [(u32, &[f32]); 16] = [
            (kind::LOWPASS, &[800.0, 0.3, 40.0]),
            (kind::HIGHPASS, &[300.0, 0.1, 0.0]),
            (kind::BANDPASS, &[1_000.0, 0.5, 20.0]),
            (kind::EQ, &[6.0, -3.0, 4.0]),
            (kind::COMPRESSOR, &[-30.0, 4.0, 5.0, 100.0, 3.0, 6.0]),
            (kind::SATURATION, &[60.0]),
            (kind::DISTORTION, &[0.5, 80.0]),
            (kind::BITCRUSH, &[6.0, 4.0, 100.0]),
            (kind::CHORUS, &[0.8, 50.0, 50.0]),
            (kind::DELAY, &[120.0, 40.0, 30.0]),
            (kind::REVERB, &[0.7, 2.5, 30.0]),
            (kind::FORMANT, &[5.0]),
            (kind::PITCH, &[7.0, 0.0]),
            (kind::LIMITER, &[-6.0, 50.0]),
            (kind::SIDECHAIN, &[-20.0, 4.0, 200.0, 1.0]),
            (kind::GAIN, &[-6.0]),
        ];
        for (k, p) in cases {
            let p = params(p);
            let mut e = Effect::default();
            assert!(e.configure(k, true, &p, sr));
            let mut mem = vec![0.0f32; mem_floats(k, &p, sr)];
            let ctx = Ctx { key_db: -6.0 };
            let mut energy = 0.0f32;
            for q in 0..64 {
                let (mut l, mut r) = sine(q, 440.0);
                e.process(&mut mem, &mut l, &mut r, &ctx);
                assert!(l.iter().chain(r.iter()).all(|x| x.is_finite()), "kind {k}");
                energy += l.iter().map(|x| x * x).sum::<f32>();
            }
            assert!(energy > 1e-3, "kind {k} is not silent");
            // Bypassed: untouched.
            e.configure(k, false, &p, sr);
            let (mut l, mut r) = sine(70, 440.0);
            let dry = l;
            e.process(&mut mem, &mut l, &mut r, &ctx);
            assert_eq!(l, dry, "kind {k} bypassed");
        }
    }

    #[test]
    fn a_running_filter_glides_in_octaves_and_an_idle_one_takes_the_edit_at_once() {
        let sr = 48_000.0;
        let mut e = Effect::default();
        e.configure(kind::LOWPASS, true, &params(&[1_000.0, 0.0, 0.0]), sr);
        e.configure(kind::LOWPASS, true, &params(&[4_000.0, 0.0, 0.0]), sr);
        assert_eq!((e.cur[0], e.glide), (4_000.0, 0), "not run yet: at once");
        let (mut l, mut r) = sine(0, 440.0);
        e.process(&mut [], &mut l, &mut r, &Ctx::default());
        e.configure(kind::LOWPASS, true, &params(&[1_000.0, 0.0, 0.0]), sr);
        assert_eq!(e.glide, 960);
        let (mut l, mut r) = sine(1, 440.0);
        e.process(&mut [], &mut l, &mut r, &Ctx::default());
        // Two octaves over 960 frames: 128 frames move 2·128/960 octaves.
        let want = 4_000.0 * libm::exp2f(-2.0 * 128.0 / 960.0);
        assert!((e.cur[0] - want).abs() < 1.0, "{} vs {want}", e.cur[0]);
        assert_eq!(e.bq[0].last[1], e.cur[0], "the filter follows the glide");
        for q in 2..12 {
            let (mut l, mut r) = sine(q, 440.0);
            e.process(&mut [], &mut l, &mut r, &Ctx::default());
        }
        assert_eq!((e.cur[0], e.glide), (1_000.0, 0));
    }

    #[test]
    fn a_kind_change_starts_zeroed_and_the_same_kind_keeps_its_state() {
        let sr = 48_000.0;
        let mut e = Effect::default();
        e.configure(kind::HIGHPASS, true, &params(&[200.0, 0.1, 0.0]), sr);
        let (mut l, mut r) = sine(0, 100.0);
        e.process(&mut [], &mut l, &mut r, &Ctx::default());
        let h = e.bq[0].history;
        assert!(!e.configure(kind::HIGHPASS, true, &params(&[250.0, 0.1, 0.0]), sr));
        assert_eq!(e.bq[0].history, h);
        assert!(e.configure(kind::LOWPASS, true, &params(&[250.0, 0.1, 0.0]), sr));
        assert_eq!(e.bq[0].history, [[0.0; 4]; 2]);
    }

    #[test]
    fn the_compressor_slot_matches_a_lone_compressor_plus_makeup() {
        let sr = 48_000.0;
        let p = params(&[-30.0, 4.0, 3.0, 250.0, 6.0, 1.0]);
        let mut e = Effect::default();
        e.configure(kind::COMPRESSOR, true, &p, sr);
        let mut mem = vec![0.0f32; mem_floats(kind::COMPRESSOR, &p, sr)];
        let mut alone = Compressor::default();
        alone.configure(sr, -30.0, 1.0, 4.0, 0.003, 0.25);
        let g = db_to_linear(6.0);
        for q in 0..8 {
            let (mut l, mut r) = sine(q, 300.0);
            let (mut el, mut er) = (l, r);
            e.process(&mut mem, &mut l, &mut r, &Ctx::default());
            alone.process(&mut el, &mut er);
            for i in 0..128 {
                assert_eq!(l[i], el[i] * g, "quantum {q} frame {i}");
            }
        }
    }
}
