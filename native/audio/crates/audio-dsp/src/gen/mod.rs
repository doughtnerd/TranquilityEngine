//! Sound generators (ADR 0360 §2, §3): the kernels the core's generator voice runs and the offline render shares. No
//! allocation, `libm` maths, deterministic (the same kind, parameters, seed and pitch give the same samples on every
//! build). Output is **mono**.
//!
//! - `osc`: band-limited oscillators (PolyBLEP saw and pulse, PolyBLAMP triangle, polynomial sine) and a band-limited
//!   sample-and-hold;
//! - `noise`: xorshift32 white, Kellet pink, leaky-integrator brown;
//! - `svf`: a TPT state-variable filter (low, high, band) and a TPT one-pole;
//! - `env`: ADSR envelopes (linear attack, exponential decay and release);
//! - `lfo`: the synth's LFO;
//! - `blip`: sfxr's synthesiser, band-limited, in sfxr's units.
//!
//! [`GenVoice`] is one voice of any kind: its parameters (in the generator catalogue's order, which is the wire order:
//! `src/engine/audio/generators/catalogue.ts`), their glides and the kind's state. A parameter set with a ramp glides
//! (frequencies in log2, levels in dB, others linearly; choices and times step); the render reads parameters once per
//! control block of [`CONTROL_FRAMES`] samples, recomputing the filter only while something moves it.

pub mod blip;
pub mod env;
pub mod lfo;
pub mod noise;
pub mod osc;
pub mod svf;

use env::Adsr;
use lfo::Lfo;
use noise::Noise;
use osc::{dt_of, Osc};
use svf::Svf;

/// Generator kinds (the reserved clip id is `GEN_CLIP_ID_FIRST + kind`).
pub const OSCILLATOR: u8 = 1;
pub const SYNTH: u8 = 2;
pub const BLIP: u8 = 3;
pub const SILENCE: u8 = 4;

/// Most parameters a kind has (the GEN mask's width).
pub const PARAMS_MAX: usize = 32;
/// Samples between parameter reads and filter updates.
pub const CONTROL_FRAMES: usize = 16;

/// How a parameter moves when it is set with a ramp.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glide {
    /// Jumps (choices, times, lengths, the blip's latched parameters).
    Step,
    /// Linearly (levels in dB, percentages, semitones).
    Linear,
    /// In log2 (frequencies, rates).
    Log,
}

/// One parameter's range, default and glide (the generator catalogue's `EffectParamSpec`, as the core needs it).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParamSpec {
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub glide: Glide,
}

const fn step(min: f32, max: f32, default: f32) -> ParamSpec {
    ParamSpec { min, max, default, glide: Glide::Step }
}
const fn lin(min: f32, max: f32, default: f32) -> ParamSpec {
    ParamSpec { min, max, default, glide: Glide::Linear }
}
const fn log(min: f32, max: f32, default: f32) -> ParamSpec {
    ParamSpec { min, max, default, glide: Glide::Log }
}

/// The oscillator's and synth's waveforms (the `waveform`, `osc1Wave` and `osc2Wave` choice order).
pub mod wave {
    pub const SINE: u8 = 0;
    pub const SQUARE: u8 = 1;
    pub const SAW: u8 = 2;
    pub const TRIANGLE: u8 = 3;
    pub const NOISE: u8 = 4;
}

/// The oscillator's parameters in wire order.
pub mod osc_p {
    pub const WAVEFORM: usize = 0;
    pub const NOISE_COLOUR: usize = 1;
    pub const FREQUENCY: usize = 2;
    pub const PULSE_WIDTH: usize = 3;
    pub const LEVEL: usize = 4;
    pub const ATTACK: usize = 5;
    pub const DECAY: usize = 6;
    pub const SUSTAIN: usize = 7;
    pub const RELEASE: usize = 8;
    pub const LENGTH: usize = 9;
    pub const COUNT: usize = 10;
}

/// The synth's parameters in wire order.
pub mod synth_p {
    pub const OSC1_WAVE: usize = 0;
    pub const OSC2_WAVE: usize = 1;
    pub const OSC2_SEMITONES: usize = 2;
    pub const DETUNE: usize = 3;
    pub const OSC_MIX: usize = 4;
    pub const PULSE_WIDTH: usize = 5;
    pub const FREQUENCY: usize = 6;
    pub const FILTER_TYPE: usize = 7;
    pub const CUTOFF: usize = 8;
    pub const RESONANCE: usize = 9;
    pub const FILTER_ENV_AMOUNT: usize = 10;
    pub const FILTER_ATTACK: usize = 11;
    pub const FILTER_DECAY: usize = 12;
    pub const FILTER_SUSTAIN: usize = 13;
    pub const FILTER_RELEASE: usize = 14;
    pub const AMP_ATTACK: usize = 15;
    pub const AMP_DECAY: usize = 16;
    pub const AMP_SUSTAIN: usize = 17;
    pub const AMP_RELEASE: usize = 18;
    pub const LFO_WAVE: usize = 19;
    pub const LFO_RATE: usize = 20;
    pub const LFO_DEPTH: usize = 21;
    pub const LFO_TARGET: usize = 22;
    pub const LEVEL: usize = 23;
    pub const LENGTH: usize = 24;
    pub const COUNT: usize = 25;
}

/// The silence's parameters in wire order (the core plays it with no voice state: only `length` matters there).
pub mod silence_p {
    pub const LENGTH: usize = 0;
    pub const LENGTH_RANDOM: usize = 1;
    pub const COUNT: usize = 2;
}

/// The synth's LFO targets (`lfoTarget`): pitch ±2 st, cut-off ±4 octaves, amplitude, pulse width ±49 % at full depth.
pub mod lfo_target {
    pub const PITCH: u8 = 0;
    pub const CUTOFF: u8 = 1;
    pub const AMP: u8 = 2;
    pub const PULSE_WIDTH: u8 = 3;
}

static OSCILLATOR_PARAMS: [ParamSpec; osc_p::COUNT] = [
    step(0.0, 4.0, 0.0),             // waveform: sine
    step(0.0, 2.0, 0.0),             // noiseColour: white
    log(20.0, 20_000.0, 440.0),      // frequency Hz
    lin(1.0, 99.0, 50.0),            // pulseWidth %
    lin(-60.0, 0.0, -12.0),          // level dB
    step(0.0, 5_000.0, 2.0),         // attack ms (a click guard)
    step(0.0, 5_000.0, 0.0),         // decay ms
    lin(0.0, 100.0, 100.0),          // sustain %
    step(0.0, 10_000.0, 10.0),       // release ms (a click guard)
    step(0.0, 60.0, 0.0),            // length s, 0 until released
];

static SYNTH_PARAMS: [ParamSpec; synth_p::COUNT] = [
    step(0.0, 4.0, 2.0),             // osc1Wave: saw
    step(0.0, 4.0, 2.0),             // osc2Wave: saw
    lin(-24.0, 24.0, 0.0),           // osc2Semitones
    lin(0.0, 100.0, 7.0),            // detune ct
    lin(0.0, 100.0, 50.0),           // oscMix %
    lin(1.0, 99.0, 50.0),            // pulseWidth %
    log(20.0, 20_000.0, 220.0),      // frequency Hz
    step(0.0, 2.0, 0.0),             // filterType: lowpass
    log(20.0, 20_000.0, 2_000.0),    // cutoff Hz
    lin(0.0, 1.0, 0.2),              // resonance
    lin(-48.0, 48.0, 24.0),          // filterEnvAmount st
    step(0.0, 5_000.0, 5.0),         // filterAttack ms
    step(0.0, 5_000.0, 300.0),       // filterDecay ms
    lin(0.0, 100.0, 30.0),           // filterSustain %
    step(0.0, 10_000.0, 300.0),      // filterRelease ms
    step(0.0, 5_000.0, 5.0),         // ampAttack ms
    step(0.0, 5_000.0, 200.0),       // ampDecay ms
    lin(0.0, 100.0, 80.0),           // ampSustain %
    step(0.0, 10_000.0, 300.0),      // ampRelease ms
    step(0.0, 4.0, 0.0),             // lfoWave: sine
    log(0.05, 20.0, 5.0),            // lfoRate Hz
    lin(0.0, 100.0, 0.0),            // lfoDepth %
    step(0.0, 3.0, 0.0),             // lfoTarget: pitch
    lin(-60.0, 0.0, -12.0),          // level dB
    step(0.0, 60.0, 0.0),            // length s
];

static BLIP_PARAMS: [ParamSpec; blip::p::COUNT] = [
    step(0.0, 4.0, 0.0),             // waveform: square
    step(0.0, 1.0, 0.0),             // attack
    step(0.0, 1.0, 0.3),             // sustain
    step(0.0, 1.0, 0.0),             // punch
    step(0.0, 1.0, 0.4),             // decay
    step(0.0, 1.0, 0.3),             // baseFrequency
    step(0.0, 1.0, 0.0),             // frequencyLimit
    step(-1.0, 1.0, 0.0),            // slide
    step(-1.0, 1.0, 0.0),            // deltaSlide
    step(0.0, 1.0, 0.0),             // vibratoDepth
    step(0.0, 1.0, 0.0),             // vibratoSpeed
    step(-1.0, 1.0, 0.0),            // arpeggioAmount
    step(0.0, 1.0, 0.0),             // arpeggioSpeed
    step(0.0, 1.0, 0.0),             // duty
    step(-1.0, 1.0, 0.0),            // dutySweep
    step(0.0, 1.0, 0.0),             // repeatSpeed
    step(-1.0, 1.0, 0.0),            // phaserOffset
    step(-1.0, 1.0, 0.0),            // phaserSweep
    step(0.0, 1.0, 1.0),             // lowpassCutoff
    step(-1.0, 1.0, 0.0),            // lowpassSweep
    step(0.0, 1.0, 0.0),             // lowpassResonance
    step(0.0, 1.0, 0.0),             // highpassCutoff
    step(-1.0, 1.0, 0.0),            // highpassSweep
    lin(-60.0, 0.0, -12.0),          // level dB
];

static SILENCE_PARAMS: [ParamSpec; silence_p::COUNT] = [
    step(0.0, 60.0, 1.0),            // length s
    step(0.0, 60.0, 0.0),            // lengthRandom s (drawn by the runtime)
];

/// Kind `kind`'s parameters in wire order (empty for an unknown kind).
pub fn params(kind: u8) -> &'static [ParamSpec] {
    match kind {
        OSCILLATOR => &OSCILLATOR_PARAMS,
        SYNTH => &SYNTH_PARAMS,
        BLIP => &BLIP_PARAMS,
        SILENCE => &SILENCE_PARAMS,
        _ => &[],
    }
}

/// `value` clamped into `spec`'s range (NaN is the default).
#[inline]
pub fn clamp_param(spec: &ParamSpec, value: f32) -> f32 {
    if value.is_nan() {
        spec.default
    } else {
        value.clamp(spec.min, spec.max)
    }
}

/// A level of `db` decibels as a gain.
#[inline]
pub fn db_gain(db: f32) -> f32 {
    libm::exp2f(db * (core::f32::consts::LOG2_10 / 20.0))
}

/// One parameter: its value in its glide's domain (log2 for [`Glide::Log`]), its target, its glide, and the value in its
/// own units (`nat`, kept current so the render reads it with no conversion). All-zero is 0, settled.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Param {
    pub value: f32,
    pub target: f32,
    pub inc: f32,
    pub left: u32,
    pub nat: f32,
    /// The target in its own units (where a glide lands exactly).
    pub goal: f32,
}

/// One control block of the oscillator kind: `f(dt)` is the waveform's next sample, times the amp envelope and the
/// gain ramping from `g0` by `dg` a sample.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn run(block: &mut [f32], steps: &[f32], hz: f64, inv: f64, amp: &mut Adsr, g0: f32, dg: f32, mut f: impl FnMut(f64) -> f32) {
    for j in 0..block.len() {
        let x = f(dt_of(hz * steps[j] as f64, inv));
        block[j] = x * amp.next() * (g0 + dg * (j + 1) as f32);
    }
}

/// One generator voice of any kind. All-zero is not started: call [`GenVoice::start`].
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct GenVoice {
    kind: u8,
    /// Set by [`GenVoice::key_off`].
    keyed_off: u8,
    /// Set once the voice has ended (its amp envelope finished, or the blip ended).
    ended: u8,
    /// Parameters changed since the derived values (gain, envelopes, filter) were worked out.
    dirty: u8,
    rate: f32,
    /// Bit i: parameter i is gliding.
    gliding: u32,
    params: [Param; PARAMS_MAX],
    /// The level as a gain (with the synth's LFO amplitude), at the end of the last control block.
    gain: f32,
    noise: Noise,
    osc: [Osc; 2],
    svf: Svf,
    amp: Adsr,
    fenv: Adsr,
    lfo: Lfo,
    /// The synth's filter needs a coefficient update at the next control block.
    filter_moving: u8,
    _pad2: [u8; 3],
    /// The synth's oscillator 2 ratio (`osc2Semitones` + `detune`) and filter Q (from `resonance`), worked out with the
    /// envelopes when parameters change.
    ratio2: f64,
    q: f32,
    blip: blip::Blip,
}

impl Default for GenVoice {
    fn default() -> GenVoice {
        // SAFETY: all-zero is a valid GenVoice (integers, floats and arrays of them).
        unsafe { core::mem::zeroed() }
    }
}

impl GenVoice {
    /// Starts a voice of `kind` at `rate` Hz with noise seed `seed`: every parameter at its default, the envelopes keyed
    /// on. In place, so a pool entry is reused without a copy of the whole voice.
    pub fn start(&mut self, kind: u8, rate: f32, seed: u32) {
        self.kind = kind;
        self.keyed_off = 0;
        self.ended = 0;
        self.dirty = 1;
        self.rate = rate;
        self.gliding = 0;
        let specs = params(kind);
        for (i, p) in self.params.iter_mut().enumerate() {
            let d = specs.get(i).map_or(0.0, |s| s.default);
            let v = if specs.get(i).is_some_and(|s| s.glide == Glide::Log) { libm::log2f(d) } else { d };
            *p = Param { value: v, target: v, inc: 0.0, left: 0, nat: d, goal: d };
        }
        self.noise = Noise::seeded(seed, rate);
        self.osc = [Osc::default(); 2];
        self.svf = Svf::default();
        self.amp = Adsr::default();
        self.fenv = Adsr::default();
        self.lfo = Lfo::seeded(seed);
        self.filter_moving = 1;
        self.blip.started = 0;
        self.blip.playing = 0;
        self.derive();
        self.gain = self.level_gain();
        self.amp.gate_on();
        self.fenv.gate_on();
    }

    /// Re-seeds the noise (and the synth LFO's sample-and-hold).
    pub fn reseed(&mut self, seed: u32) {
        self.noise.reseed(seed);
        self.lfo = Lfo { state: Lfo::seeded(seed).state, ..self.lfo };
    }

    /// Parameter `i` in its own units.
    #[inline]
    pub fn value(&self, i: usize) -> f32 {
        self.params.get(i).map_or(0.0, |p| p.nat)
    }

    #[inline]
    fn choice(&self, i: usize) -> u8 {
        self.value(i) as u8
    }

    /// Sets parameter `i` to `value` (clamped; NaN is the default), gliding over `ramp` frames if it glides at all (0
    /// jumps). An index past the kind's parameters is ignored.
    pub fn set(&mut self, i: usize, value: f32, ramp: u32) {
        let Some(spec) = params(self.kind).get(i) else { return };
        let x = clamp_param(spec, value);
        let v = if spec.glide == Glide::Log { libm::log2f(x) } else { x };
        if self.kind == BLIP && i < blip::p::COUNT {
            // The blip reads its parameters at its start and each re-trigger (as sfxr at its reset).
            self.blip.p[i] = x;
        }
        let p = &mut self.params[i];
        p.target = v;
        p.goal = x;
        if ramp == 0 || spec.glide == Glide::Step || p.value == v {
            p.value = v;
            p.nat = x;
            p.left = 0;
            p.inc = 0.0;
            self.gliding &= !(1 << i);
        } else {
            p.inc = (v - p.value) / ramp as f32;
            p.left = ramp;
            self.gliding |= 1 << i;
        }
        self.dirty = 1;
    }

    /// Key-off: the envelopes release (a blip stops re-triggering and plays to its end).
    pub fn key_off(&mut self) {
        self.keyed_off = 1;
        self.amp.gate_off();
        self.fenv.gate_off();
    }

    /// Moves every gliding parameter `n` frames on.
    fn advance_glides(&mut self, n: u32) {
        let mut bits = self.gliding;
        while bits != 0 {
            let i = bits.trailing_zeros() as usize;
            bits &= bits - 1;
            let p = &mut self.params[i];
            if n >= p.left {
                p.value = p.target;
                p.nat = p.goal;
                p.left = 0;
                self.gliding &= !(1 << i);
            } else {
                p.value += p.inc * n as f32;
                p.left -= n;
                p.nat = if params(self.kind)[i].glide == Glide::Log { libm::exp2f(p.value) } else { p.value };
            }
        }
        self.dirty = 1;
    }

    fn level_gain(&self) -> f32 {
        let i = match self.kind {
            OSCILLATOR => osc_p::LEVEL,
            SYNTH => synth_p::LEVEL,
            BLIP => blip::p::LEVEL,
            _ => return 0.0,
        };
        db_gain(self.value(i))
    }

    /// The envelopes from the parameters (times in ms, sustain in %).
    fn derive(&mut self) {
        let ms = |v: f32| v * 0.001;
        let r = self.rate;
        let v = |i: usize| self.params[i].nat;
        match self.kind {
            OSCILLATOR => {
                let (a, d, s, rel) = (ms(v(osc_p::ATTACK)), ms(v(osc_p::DECAY)), v(osc_p::SUSTAIN) * 0.01, ms(v(osc_p::RELEASE)));
                self.amp.configure(a, d, s, rel, r);
            }
            SYNTH => {
                use synth_p::*;
                let (a, d, s, rel) = (ms(v(AMP_ATTACK)), ms(v(AMP_DECAY)), v(AMP_SUSTAIN) * 0.01, ms(v(AMP_RELEASE)));
                let (fa, fd, fs, frel) = (ms(v(FILTER_ATTACK)), ms(v(FILTER_DECAY)), v(FILTER_SUSTAIN) * 0.01, ms(v(FILTER_RELEASE)));
                self.amp.configure(a, d, s, rel, r);
                self.fenv.configure(fa, fd, fs, frel, r);
                self.filter_moving = 1;
                self.ratio2 = libm::exp2((v(OSC2_SEMITONES) as f64 + v(DETUNE) as f64 * 0.01) / 12.0);
                self.q = core::f32::consts::FRAC_1_SQRT_2 * libm::powf(25.0, v(RESONANCE));
            }
            _ => {}
        }
        self.dirty = 0;
    }

    /// Renders `out.len()` samples with per-sample pitch ratios `steps` (the voice's pitch × its pitch binding; every
    /// frequency is multiplied by it). `repeat` is the PLAY loop flag (a blip re-triggers at its end until the key-off).
    /// Returns `false` once the voice has ended (the rest of `out` is zero).
    pub fn render(&mut self, steps: &[f32], out: &mut [f32], repeat: bool) -> bool {
        if self.ended != 0 {
            out.fill(0.0);
            return false;
        }
        let alive = match self.kind {
            OSCILLATOR => self.render_oscillator(steps, out),
            SYNTH => self.render_synth(steps, out),
            BLIP => self.render_blip(steps, out, repeat),
            _ => {
                out.fill(0.0);
                true
            }
        };
        if !alive {
            self.ended = 1;
        }
        alive
    }

    /// Moves `n` samples on without rendering (a virtual voice): glides, envelopes and the LFO keep time; oscillators
    /// and filters hold. Returns `false` once the voice has ended.
    pub fn advance(&mut self, n: u32, repeat: bool) -> bool {
        if self.ended != 0 {
            return false;
        }
        if self.gliding != 0 {
            self.advance_glides(n);
        }
        if self.dirty != 0 {
            self.derive();
            self.gain = self.level_gain();
        }
        let alive = match self.kind {
            OSCILLATOR | SYNTH => {
                self.amp.advance(n);
                self.fenv.advance(n);
                if self.kind == SYNTH {
                    self.lfo.advance(n as f32 * self.value(synth_p::LFO_RATE) / self.rate);
                }
                !self.amp.done()
            }
            BLIP => {
                if self.blip.started == 0 {
                    self.start_blip();
                }
                self.blip.advance(n, self.rate, repeat && self.keyed_off == 0)
            }
            _ => true,
        };
        if !alive {
            self.ended = 1;
        }
        alive
    }

    /// The control block's start: glides move `k` frames, derived values follow. Returns the gain at the block's start
    /// and end (the level glides across it).
    #[inline]
    fn control(&mut self, k: usize) -> (f32, f32) {
        let g0 = self.gain;
        if self.gliding != 0 {
            self.advance_glides(k as u32);
        }
        if self.dirty != 0 {
            self.derive();
            self.gain = self.level_gain();
        }
        (g0, self.gain)
    }

    fn render_oscillator(&mut self, steps: &[f32], out: &mut [f32]) -> bool {
        let inv = 1.0 / self.rate as f64;
        let n = out.len();
        let mut i = 0;
        while i < n {
            let k = (n - i).min(CONTROL_FRAMES);
            let hz = self.value(osc_p::FREQUENCY) as f64;
            let width = (self.value(osc_p::PULSE_WIDTH) * 0.01) as f64;
            let wave = self.choice(osc_p::WAVEFORM);
            let colour = self.choice(osc_p::NOISE_COLOUR);
            let (g0, g1) = self.control(k);
            let dg = (g1 - g0) / k as f32;
            let (o, s, amp) = (&mut self.osc[0], &steps[i..i + k], &mut self.amp);
            let block = &mut out[i..i + k];
            match wave {
                wave::SQUARE => run(block, s, hz, inv, amp, g0, dg, |dt| o.pulse(dt, width, 1.0)),
                wave::SAW => run(block, s, hz, inv, amp, g0, dg, |dt| o.saw(dt)),
                wave::TRIANGLE => run(block, s, hz, inv, amp, g0, dg, |dt| o.triangle(dt)),
                wave::NOISE => {
                    let noise = &mut self.noise;
                    run(block, s, hz, inv, amp, g0, dg, |_| noise.colour(colour))
                }
                _ => run(block, s, hz, inv, amp, g0, dg, |dt| o.sine(dt)),
            }
            if self.amp.done() {
                out[i + k..].fill(0.0);
                return false;
            }
            i += k;
        }
        true
    }

    fn render_synth(&mut self, steps: &[f32], out: &mut [f32]) -> bool {
        use synth_p::*;
        let inv = 1.0 / self.rate as f64;
        let n = out.len();
        let mut i = 0;
        while i < n {
            let k = (n - i).min(CONTROL_FRAMES);
            let (w1, w2, kind) = (self.choice(OSC1_WAVE), self.choice(OSC2_WAVE), self.choice(FILTER_TYPE));
            let hz = self.value(FREQUENCY) as f64;
            let ratio2 = self.ratio2;
            let mix = self.value(OSC_MIX) * 0.01;
            let mut width = self.value(PULSE_WIDTH) * 0.01;
            // The LFO, read at the block's start.
            let depth = self.value(LFO_DEPTH) * 0.01;
            let (mut pitch, mut octaves, mut amp_lfo) = (1.0f64, 0.0f32, 1.0f32);
            if depth > 0.0 {
                let l = self.lfo.value(self.choice(LFO_WAVE));
                match self.choice(LFO_TARGET) {
                    lfo_target::CUTOFF => octaves = l * 4.0 * depth,
                    lfo_target::AMP => amp_lfo = 1.0 - depth * (0.5 - 0.5 * l),
                    lfo_target::PULSE_WIDTH => width = (width + l * 0.49 * depth).clamp(0.01, 0.99),
                    _ => pitch = libm::exp2((l * 2.0 * depth / 12.0) as f64),
                }
                self.lfo.advance(k as f32 * self.value(LFO_RATE) / self.rate);
                self.filter_moving |= (octaves != 0.0) as u8;
            }
            let g_prev = self.gain;
            let (_, g1) = self.control(k);
            self.gain = g1 * amp_lfo;
            let (g0, g1) = (g_prev, self.gain);
            if self.filter_moving != 0 || !self.fenv.settled() {
                let semis = self.value(FILTER_ENV_AMOUNT) * self.fenv.value;
                let cut = self.value(CUTOFF) * libm::exp2f(semis * (1.0 / 12.0) + octaves);
                let q = self.q;
                self.svf.set(cut, q, self.rate);
                self.filter_moving = 0;
            }
            let dg = (g1 - g0) / k as f32;
            let width = width as f64;
            for j in 0..k {
                let s = steps[i + j] as f64 * pitch;
                let d1 = dt_of(hz * s, inv);
                let d2 = dt_of(hz * ratio2 * s, inv);
                let o1 = Self::wave(&mut self.osc[0], &mut self.noise, w1, d1, width);
                let o2 = Self::wave(&mut self.osc[1], &mut self.noise, w2, d2, width);
                let x = o1 + (o2 - o1) * mix;
                self.fenv.next();
                let y = self.svf.process(kind, x);
                out[i + j] = y * self.amp.next() * (g0 + dg * (j + 1) as f32);
            }
            if self.amp.done() {
                out[i + k..].fill(0.0);
                return false;
            }
            i += k;
        }
        true
    }

    #[inline]
    fn wave(o: &mut Osc, noise: &mut Noise, w: u8, dt: f64, width: f64) -> f32 {
        match w {
            wave::SQUARE => o.pulse(dt, width, 1.0),
            wave::SAW => o.saw(dt),
            wave::TRIANGLE => o.triangle(dt),
            wave::NOISE => noise.white(),
            _ => o.sine(dt),
        }
    }

    fn start_blip(&mut self) {
        let mut p = [0.0f32; blip::p::COUNT];
        for (i, v) in p.iter_mut().enumerate() {
            *v = self.value(i);
        }
        self.blip.start(&p);
    }

    fn render_blip(&mut self, steps: &[f32], out: &mut [f32], repeat: bool) -> bool {
        if self.blip.started == 0 {
            self.start_blip();
        }
        let repeat = repeat && self.keyed_off == 0;
        let n = out.len();
        let mut i = 0;
        while i < n {
            let k = (n - i).min(CONTROL_FRAMES);
            let (g0, g1) = self.control(k);
            if !self.blip.render(&steps[i..i + k], &mut out[i..i + k], g0, g1, self.rate, repeat, &mut self.noise.state) {
                out[i + k..].fill(0.0);
                return false;
            }
            i += k;
        }
        true
    }
}
