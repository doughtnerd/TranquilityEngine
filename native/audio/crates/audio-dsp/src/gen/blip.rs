//! The blip: sfxr's synthesiser (DrPetter's sfxr, MIT; the same algorithm as bfxr and jsfxr), its parameters in sfxr's
//! own units so settings port, rendered band-limited at any context rate (ADR 0360 §2, owner decision 2).
//!
//! **What is sfxr's and what changed.** sfxr runs its control (repeat, arpeggio, frequency slide and limit, vibrato, duty
//! sweep, the attack-sustain-punch-decay envelope, the phaser's sweep, the high-pass sweep) once per sample at 44.1 kHz
//! and its oscillator, low-pass, high-pass and phaser eight times per sample (8× supersampling). Here:
//! - the control runs **exactly as sfxr's**, on a 44.1 kHz tick clock of its own ([`SFXR_RATE`]), so envelope times,
//!   slides, arpeggio and repeat times are sfxr's at every context rate (a tick that falls between two output samples
//!   applies at the next);
//! - the oscillator's frequency is sfxr's (`8 × 44,100 / period`, the period an integer of at least 8), read by the
//!   band-limited oscillators (`osc.rs`): the square is a PolyBLEP pulse of sfxr's duty and ±0.5, the saw sfxr's falling
//!   one, the noise sfxr's 32 held values a period with each step band-limited; the triangle is bfxr's;
//! - sfxr's low-pass (a damped two-pole run at 352.8 kHz: `w` its stiffness, `d` its damping) becomes the analog
//!   two-pole it discretises (cut-off `352,800 √w / 2π`, Q `√w / d`) on a TPT state-variable filter, and its one-pole
//!   high-pass (pole `1 − h` at 352.8 kHz) a TPT one-pole at `−ln(1 − h) × 352,800 / 2π`; their sweeps are sfxr's;
//! - the phaser's delay line keeps sfxr's delay in time (`iphase / 352,800` s, up to 2.9 ms) at the context rate, read
//!   with linear interpolation; as in sfxr it adds the delayed copy, so a blip with no phaser sweep plays doubled;
//! - sfxr's master and sound volumes (× 0.05) are replaced by the `level` parameter (dB), which glides live; the other
//!   parameters are read when the blip starts and at each re-trigger (as sfxr reads them at its reset).
//!
//! **How a block runs** (D67, the blip's cost: 2.38× a sample voice to 1.47× with every stage on; the output matches the
//! full per-tick form to the bit, or within an ulp, except the vibrato, below). A render call is one control block (at
//! most [`BLOCK`] samples): one loop per waveform and low-pass (`run`) with the ticks, the oscillator and the filters
//! fused, every value in locals, then a shared second pass (`finish_block`, four lanes at a time with simd128) for the
//! phaser, the envelope and the gain.
//! - sfxr's three tick counters (repeat, arpeggio, envelope stage) only matter when one of them fires: a tick counts down
//!   to the next of the three events, and the counters are brought up to date when it fires (`events`).
//! - Each tick does only what moves every tick: the slide and its limit, the vibrato's phase and the duty sweep, each
//!   skipped when its parameters are neutral (sfxr's arithmetic with them is exact: × 1, + 0, a clamp of a value already
//!   in range).
//! - What the audio reads is worked out once per sample, after its ticks: the period (sfxr sets it every tick from the
//!   same values; only the last tick before a sample is heard) and the envelope's level, from the stage's line.
//! - The control values the audio reads only through a filter's coefficients or the phaser's delay, which the render reads
//!   once a block (the phaser's offset, the low- and high-pass sweeps), are swept once a block by the block's tick count,
//!   multiplication by multiplication as sfxr does.
//! - The vibrato's `sin(vib_phase)` is a phasor turned each tick (f64), closer to sfxr's `sin` than ADR 0360's
//!   polynomial (which differed by up to 4e-6): an integer period can now and then round the other way.
//!
//! **Quality** (D67): at `quality` `high` the oscillator's discontinuities (the saw's and square's jumps, the triangle's
//! corners, the held noise's steps) take a minBLEP residual (`blep.rs`) instead of PolyBLEP, the blip reading its
//! waveform `blep::DELAY` samples late; latched at the trigger like the other parameters.
//!
//! The PLAY loop flag re-triggers the blip at its end (sfxr's repeat, endless) until the key-off.

use super::osc::{pulse_at, saw_at, sine_cycles, triangle_at, Held, MAX_DT};
use super::blep::Ring;
use super::svf::{OnePole, Svf};

/// sfxr's control rate (its per-sample loop).
pub const SFXR_RATE: f64 = 44_100.0;
/// sfxr's oscillator and filter rate (8× supersampling).
pub const SFXR_SUPER: f64 = 8.0 * SFXR_RATE;
/// sfxr's phaser buffer, in its supersampled steps.
pub const PHASER_STEPS: usize = 1_024;
/// The context-rate delay line: sfxr's 1,023 steps at up to 352.8 kHz.
pub const LINE: usize = 1_024;
/// The most samples one [`Blip::render`] takes (the voice's control block).
pub const BLOCK: usize = super::CONTROL_FRAMES;

/// The blip's parameters in wire order (the generator catalogue's `blip` kind).
pub mod p {
    pub const WAVEFORM: usize = 0;
    pub const ATTACK: usize = 1;
    pub const SUSTAIN: usize = 2;
    pub const PUNCH: usize = 3;
    pub const DECAY: usize = 4;
    pub const BASE_FREQUENCY: usize = 5;
    pub const FREQUENCY_LIMIT: usize = 6;
    pub const SLIDE: usize = 7;
    pub const DELTA_SLIDE: usize = 8;
    pub const VIBRATO_DEPTH: usize = 9;
    pub const VIBRATO_SPEED: usize = 10;
    pub const ARPEGGIO_AMOUNT: usize = 11;
    pub const ARPEGGIO_SPEED: usize = 12;
    pub const DUTY: usize = 13;
    pub const DUTY_SWEEP: usize = 14;
    pub const REPEAT_SPEED: usize = 15;
    pub const PHASER_OFFSET: usize = 16;
    pub const PHASER_SWEEP: usize = 17;
    pub const LOWPASS_CUTOFF: usize = 18;
    pub const LOWPASS_SWEEP: usize = 19;
    pub const LOWPASS_RESONANCE: usize = 20;
    pub const HIGHPASS_CUTOFF: usize = 21;
    pub const HIGHPASS_SWEEP: usize = 22;
    pub const LEVEL: usize = 23;
    pub const QUALITY: usize = 24;
    pub const COUNT: usize = 25;
}

/// The waveforms (sfxr's `wave_type` 0-3, then bfxr's triangle).
pub mod wave {
    pub const SQUARE: u8 = 0;
    pub const SAW: u8 = 1;
    pub const SINE: u8 = 2;
    pub const NOISE: u8 = 3;
    pub const TRIANGLE: u8 = 4;
}

/// sfxr's envelope lengths in ticks for attack, sustain and decay (`p² × 100,000`).
pub fn envelope_ticks(attack: f32, sustain: f32, decay: f32) -> [u32; 3] {
    [(attack * attack * 100_000.0) as u32, (sustain * sustain * 100_000.0) as u32, (decay * decay * 100_000.0) as u32]
}

/// A blip's whole length in seconds by its envelope (sfxr's stages last `length + 1` ticks each).
pub fn envelope_seconds(attack: f32, sustain: f32, decay: f32) -> f64 {
    let t = envelope_ticks(attack, sustain, decay);
    (t[0] as f64 + t[1] as f64 + t[2] as f64 + 3.0) / SFXR_RATE
}

/// The control state sfxr's tick moves, copied into locals for a block.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct Ticks {
    /// Ticks owed: the 44.1 kHz clock against the context rate.
    acc: f64,
    fperiod: f64,
    fslide: f64,
    /// The oscillator's period (supersampled steps, an integer of at least 8) and its reciprocal.
    period: f64,
    inv_period: f64,
    /// sfxr's `sin(vib_phase)` and its cosine: a phasor turned by `vib_speed` each tick.
    vib_sin: f64,
    vib_cos: f64,
    square_duty: f32,
    /// sfxr's `env_time`, counted every tick (a whole number, exact in `f32`).
    env_time: f32,
    /// The envelope's level is `a + (c − env_time × k) × d` in the current stage (the stage's line, written so each
    /// stage's arithmetic is sfxr's to the bit).
    env_a: f32,
    env_c: f32,
    env_k: f32,
    env_d: f32,
    env_stage: u32,
    /// sfxr's `rep_time` and `arp_time` as of the last event (add `span − left` for now).
    rep_time: u32,
    arp_time: u32,
    arp_limit: u32,
    /// Ticks from the last event to the next, and of those still to run.
    span: u32,
    left: u32,
    /// Ticks since the once-a-block sweeps ran.
    swept: u32,
    /// `fperiod` moved by an event (a trigger, a re-trigger, the arpeggio, the limit): the period follows after the
    /// sample's ticks.
    stale: u32,
}

impl Ticks {
    #[inline(always)]
    fn set_period(&mut self, period: f64) {
        if period != self.period {
            self.period = period;
            self.inv_period = 1.0 / period;
        }
    }

    /// The envelope's level (sfxr's `env_vol` after its last tick).
    #[inline(always)]
    fn envelope(&self) -> f32 {
        self.env_a + (self.env_c - self.env_time * self.env_k) * self.env_d
    }
}

/// sfxr's integer period from its float one (`(int)rfperiod`, at least 8).
#[inline(always)]
fn whole_period(rfperiod: f64) -> f64 {
    (rfperiod as i64).max(8) as f64
}

/// At `high` quality: `f(tau)` for a threshold `th` (cycles) the oscillator crossed moving from `prev` to `ph` (`wrapped`:
/// through the end of the cycle), `tau` the samples since the crossing for a move of `cycles` a sample.
#[inline(always)]
fn crossed(prev: f64, ph: f64, wrapped: bool, th: f64, cycles: f64, mut f: impl FnMut(f64)) {
    if wrapped {
        if prev < th {
            f((ph + 1.0 - th) / cycles);
        }
        if ph >= th {
            f((ph - th) / cycles);
        }
    } else if prev < th && ph >= th {
        f((ph - th) / cycles);
    }
}

/// A block's second pass, in place: `x[i] ← (x[i] + y[i]) × e[i] × (g0 + dg × (base + i + 1))`, where `e[i]` is the envelope and
/// `y[i]` the phaser's delayed sample `d[i] + (d[i + 1] − d[i]) × frac` or, with no phaser, `x[i]` (sfxr's doubling). Four
/// lanes at a time on wasm with simd128 (lane for lane the same IEEE arithmetic as the scalar form, so both give the same
/// samples).
#[inline(always)]
fn finish(x: &mut [f32], e: &[f32], phaser: Option<(&[f32], f32)>, g0: f32, dg: f32, base: usize) {
    let k = x.len().min(e.len());
    let k = match phaser {
        Some((d, _)) => k.min(d.len().saturating_sub(1)),
        None => k,
    };
    #[allow(unused_mut)]
    let mut i = 0;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        // SAFETY: every read and write here is of four floats at `i..i + 4` (`i + 1..i + 5` in `d`) with `i + 4 <= k`,
        // and `k` is at most each slice's length (`d`'s less one); wasm's v128 loads and stores take any alignment.
        let lanes = |s: &[f32], i: usize| unsafe { v128_load(s.as_ptr().add(i) as *const v128) };
        let (g0v, dgv, one) = (f32x4_splat(g0), f32x4_splat(dg), u32x4(1, 2, 3, 4));
        while i + 4 <= k {
            let xv = lanes(x, i);
            let y = match phaser {
                Some((d, frac)) => {
                    let (a, b) = (lanes(d, i), lanes(d, i + 1));
                    f32x4_add(a, f32x4_mul(f32x4_sub(b, a), f32x4_splat(frac)))
                }
                None => xv,
            };
            let g = f32x4_add(g0v, f32x4_mul(dgv, f32x4_convert_u32x4(u32x4_add(u32x4_splat((base + i) as u32), one))));
            unsafe { v128_store(x.as_mut_ptr().add(i) as *mut v128, f32x4_mul(f32x4_mul(f32x4_add(xv, y), lanes(e, i)), g)) };
            i += 4;
        }
    }
    let g = |i: usize| g0 + dg * (base + i + 1) as f32;
    match phaser {
        Some((d, frac)) => {
            for i in i..k {
                x[i] = (x[i] + (d[i] + (d[i + 1] - d[i]) * frac)) * e[i] * g(i);
            }
        }
        None => {
            for i in i..k {
                x[i] = (x[i] + x[i]) * e[i] * g(i);
            }
        }
    }
}

/// One blip's state: the latched parameters, sfxr's control state and the band-limited render's. All-zero is a blip not
/// started yet ([`Blip::start`]).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Blip {
    /// The parameters read at the start and each re-trigger.
    pub(crate) p: [f32; p::COUNT],
    pub(crate) started: u8,
    /// 0 once the blip has ended (its envelope's last stage, or the frequency limit).
    pub(crate) playing: u8,
    wave: u8,
    lp_on: u8,
    phaser_on: u8,
    /// The slide or the vibrato moves the period every tick.
    moving: u8,
    /// The square's duty sweeps.
    duty_on: u8,
    /// Reaching the frequency limit ends the blip.
    limit_ends: u8,
    // What a trigger sets and a re-trigger restores (sfxr's `ResetSample(true)`).
    fperiod0: f64,
    fslide0: f64,
    duty0: f32,
    arp_limit0: u32,
    // Constant for a trigger.
    fmaxperiod: f64,
    fdslide: f64,
    arp_mod: f64,
    /// The vibrato's turn a tick (`vib_speed` radians) as a rotation.
    vib_turn_cos: f64,
    vib_turn_sin: f64,
    vib_amp: f32,
    square_slide: f32,
    rep_limit: u32,
    env_length: [u32; 3],
    /// `1 / env_length` per stage (0 for a stage of no length), so a tick multiplies rather than divides.
    env_inv: [f32; 3],
    punch: f32,
    fdphase: f32,
    flthp_d: f32,
    fltw_d8: f32,
    fltdmp: f32,
    /// The high-pass needs its sweep (moving, or outside sfxr's clamp).
    hp_sweep: u8,
    /// `quality` is `high` (latched at the trigger).
    hq: u8,
    _pad: [u8; 2],
    // Swept once a block.
    fphase: f32,
    flthp: f32,
    fltw: f32,
    t: Ticks,
    // The render's state.
    /// sfxr's oscillator phase: supersampled steps into the current period, read as `phase / period` (a period that grows
    /// mid-cycle slows the cycle, as in sfxr).
    phase: f64,
    held: Held,
    /// At `high` quality: the oscillator's position (cycles) at the last sample (the ring is the voice's, passed to
    /// [`Blip::render`]), and a trigger since the ring was last cleared.
    hq_ph: f64,
    ring_stale: u8,
    _pad3: [u8; 7],
    lp: Svf,
    hp: OnePole,
    lp_w_set: f32,
    hp_set: f32,
    write: u32,
    line: [f32; LINE],
}

impl Default for Blip {
    fn default() -> Blip {
        // SAFETY: all-zero is a valid Blip (integers, floats and arrays of them).
        unsafe { core::mem::zeroed() }
    }
}

impl Blip {
    /// Starts the blip from parameters `params` (a fresh trigger: sfxr's `ResetSample(false)`).
    pub fn start(&mut self, params: &[f32; p::COUNT]) {
        self.p = *params;
        self.started = 1;
        self.playing = 1;
        self.phase = 0.0;
        self.held.phase = 0.0;
        self.reset();
    }

    /// sfxr's `ResetSample(false)`: every constant of the trigger, then the re-trigger's part.
    fn reset(&mut self) {
        let p = self.p;
        let sq = |x: f32| x * x;
        let cube = |x: f32| x as f64 * x as f64 * x as f64;
        self.wave = p[p::WAVEFORM].clamp(0.0, 4.0) as u8;
        self.hq = (p[p::QUALITY] as u8 == super::quality::HIGH) as u8;
        self.ring_stale = 1;
        self.hq_ph = 0.0;
        self.fperiod0 = 100.0 / (sq(p[p::BASE_FREQUENCY]) as f64 + 0.001);
        self.fmaxperiod = 100.0 / (sq(p[p::FREQUENCY_LIMIT]) as f64 + 0.001);
        self.limit_ends = (p[p::FREQUENCY_LIMIT] > 0.0) as u8;
        self.fslide0 = 1.0 - cube(p[p::SLIDE]) * 0.01;
        self.fdslide = -cube(p[p::DELTA_SLIDE]) * 0.000_001;
        self.duty0 = 0.5 - p[p::DUTY] * 0.5;
        self.square_slide = -p[p::DUTY_SWEEP] * 0.000_05;
        let arp = p[p::ARPEGGIO_AMOUNT] as f64;
        self.arp_mod = if arp >= 0.0 { 1.0 - arp * arp * 0.9 } else { 1.0 + arp * arp * 10.0 };
        self.arp_limit0 = if p[p::ARPEGGIO_SPEED] == 1.0 { 0 } else { (sq(1.0 - p[p::ARPEGGIO_SPEED]) * 20_000.0 + 32.0) as u32 };
        self.lp.clear();
        self.fltw = sq(p[p::LOWPASS_CUTOFF]) * p[p::LOWPASS_CUTOFF] * 0.1;
        let fltw_d = 1.0 + p[p::LOWPASS_SWEEP] * 0.0001;
        self.fltw_d8 = libm::powf(fltw_d, 8.0);
        self.fltdmp = (5.0 / (1.0 + sq(p[p::LOWPASS_RESONANCE]) * 20.0) * (0.01 + self.fltw)).min(0.8);
        self.lp_on = (p[p::LOWPASS_CUTOFF] != 1.0) as u8;
        self.hp.s = 0.0;
        self.flthp = sq(p[p::HIGHPASS_CUTOFF]) * 0.1;
        self.flthp_d = 1.0 + p[p::HIGHPASS_SWEEP] * 0.0003;
        self.lp_w_set = -1.0;
        self.hp_set = -1.0;
        let vib_speed = (sq(p[p::VIBRATO_SPEED]) * 0.01) as f64;
        (self.vib_turn_cos, self.vib_turn_sin) = (libm::cos(vib_speed), libm::sin(vib_speed));
        self.vib_amp = p[p::VIBRATO_DEPTH] * 0.5;
        self.env_length = envelope_ticks(p[p::ATTACK], p[p::SUSTAIN], p[p::DECAY]);
        self.env_inv = self.env_length.map(|l| if l == 0 { 0.0 } else { 1.0 / l as f32 });
        self.punch = p[p::PUNCH];
        self.fphase = sq(p[p::PHASER_OFFSET]) * 1_020.0;
        if p[p::PHASER_OFFSET] < 0.0 {
            self.fphase = -self.fphase;
        }
        self.fdphase = sq(p[p::PHASER_SWEEP]);
        if p[p::PHASER_SWEEP] < 0.0 {
            self.fdphase = -self.fdphase;
        }
        self.phaser_on = (p[p::PHASER_OFFSET] != 0.0 || p[p::PHASER_SWEEP] != 0.0) as u8;
        if self.phaser_on != 0 {
            self.line = [0.0; LINE];
            self.write = 0;
        }
        self.rep_limit = if p[p::REPEAT_SPEED] == 0.0 { 0 } else { (sq(1.0 - p[p::REPEAT_SPEED]) * 20_000.0 + 32.0) as u32 };
        // The fast paths: a stage whose tick would leave its values as they are is skipped (sfxr's arithmetic with a
        // neutral parameter is exact: × 1, + 0, a clamp of a value inside its range).
        self.moving = (self.fdslide != 0.0 || self.fslide0 != 1.0 || self.vib_amp > 0.0) as u8;
        self.duty_on = (self.square_slide != 0.0 && self.wave == wave::SQUARE) as u8;
        self.hp_sweep = (self.flthp_d != 1.0 || !(0.000_01..=0.1).contains(&self.flthp)) as u8;
        let mut t = Ticks { vib_cos: 1.0, ..Ticks::default() };
        self.retrigger(&mut t);
        self.stage(&mut t);
        // The first tick runs the events: the frequency limit's first check, then the real countdown.
        t.span = 1;
        t.left = 1;
        self.t = t;
    }

    /// sfxr's `ResetSample(true)` on the tick state (the constants it sets are the trigger's, unchanged).
    #[inline(always)]
    fn retrigger(&self, t: &mut Ticks) {
        t.fperiod = self.fperiod0;
        t.set_period(whole_period(self.fperiod0));
        t.fslide = self.fslide0;
        t.square_duty = self.duty0;
        t.arp_time = 0;
        t.arp_limit = self.arp_limit0;
        t.stale = 1;
    }

    /// The envelope's line for stage `t.env_stage`: attack `t / len`, sustain `1 + (1 − t / len) × 2 punch`, decay
    /// `1 − t / len`, then 0 (sfxr's, to the bit: `t·k` is `0 − t·(−k)`, a product by 2 is exact).
    #[inline(always)]
    fn stage(&self, t: &mut Ticks) {
        (t.env_a, t.env_c, t.env_k, t.env_d) = match t.env_stage {
            0 => (0.0, 0.0, -self.env_inv[0], 1.0),
            1 => (1.0, 1.0, self.env_inv[1], 2.0 * self.punch),
            2 => (1.0, 0.0, self.env_inv[2], 1.0),
            _ => (0.0, 0.0, 0.0, 0.0),
        };
    }

    /// The ticks to the next event: the repeat, the arpeggio or the envelope's next stage (at least 1).
    #[inline(always)]
    fn schedule(&self, t: &mut Ticks) {
        let r = if self.rep_limit != 0 { self.rep_limit.saturating_sub(t.rep_time) } else { u32::MAX };
        let a = if t.arp_limit != 0 { t.arp_limit.saturating_sub(t.arp_time) } else { u32::MAX };
        let e = (self.env_length[t.env_stage.min(2) as usize] + 1).saturating_sub(t.env_time as u32);
        t.span = r.min(a).min(e).max(1);
        t.left = t.span;
    }

    /// The tick on which the countdown ran out: the counters catch up, then this tick's repeat, arpeggio, frequency limit
    /// (when no slide checks it every tick) and envelope stage, in sfxr's order. `t.env_time` is already this tick's. Out
    /// of line and by value (rare, and the hot loop keeps its copy of the state in locals).
    #[cold]
    #[inline(never)]
    fn events(&self, mut t: Ticks, mut playing: u8) -> (Ticks, u8) {
        self.events_in(&mut t, &mut playing);
        (t, playing)
    }

    #[inline(always)]
    fn events_in(&self, t: &mut Ticks, playing: &mut u8) {
        let quiet = t.span - 1;
        t.rep_time += quiet;
        t.arp_time += quiet;
        t.rep_time += 1;
        if self.rep_limit != 0 && t.rep_time >= self.rep_limit {
            t.rep_time = 0;
            self.retrigger(t);
        }
        t.arp_time += 1;
        if t.arp_limit != 0 && t.arp_time >= t.arp_limit {
            t.arp_limit = 0;
            t.fperiod *= self.arp_mod;
            t.stale = 1;
        }
        if self.moving == 0 && t.fperiod > self.fmaxperiod {
            t.fperiod = self.fmaxperiod;
            t.stale = 1;
            if self.limit_ends != 0 {
                *playing = 0;
            }
        }
        if t.env_time > self.env_length[t.env_stage.min(2) as usize] as f32 {
            t.env_time = 0.0;
            t.env_stage += 1;
            if t.env_stage >= 3 {
                t.env_stage = 3;
                *playing = 0;
            }
            self.stage(t);
        }
        self.schedule(t);
    }

    /// One 44.1 kHz control tick (sfxr's per-sample control, less what is read once a sample or once a block).
    #[inline(always)]
    fn tick(&self, t: &mut Ticks, playing: &mut u8) {
        t.env_time += 1.0;
        t.left -= 1;
        if t.left == 0 {
            core::hint::cold_path();
            (*t, *playing) = self.events(*t, *playing);
        }
        if self.moving != 0 {
            t.fslide += self.fdslide;
            t.fperiod *= t.fslide;
            if t.fperiod > self.fmaxperiod {
                core::hint::cold_path();
                t.fperiod = self.fmaxperiod;
                if self.limit_ends != 0 {
                    *playing = 0;
                }
            }
            if self.vib_amp > 0.0 {
                // sfxr's `vib_phase += vib_speed`, as the phasor's turn (exact to within a few units in the last place
                // of f64 over a minute of ticks, closer to sfxr's sin than a polynomial would be).
                let (c, s) = (t.vib_cos, t.vib_sin);
                t.vib_cos = c * self.vib_turn_cos - s * self.vib_turn_sin;
                t.vib_sin = s * self.vib_turn_cos + c * self.vib_turn_sin;
            }
        }
        if self.duty_on != 0 {
            // sfxr's clamp to 0..0.5, as two compares.
            let d = t.square_duty + self.square_slide;
            t.square_duty = if d < 0.0 {
                0.0
            } else if d > 0.5 {
                0.5
            } else {
                d
            };
        }
    }

    /// After a sample's ticks: the period sfxr's last tick set (with the vibrato), if anything moved it.
    #[inline(always)]
    fn follow(&self, t: &mut Ticks) {
        if (self.moving as u32 | t.stale) != 0 {
            t.stale = 0;
            let mut rfperiod = t.fperiod;
            if self.vib_amp > 0.0 {
                rfperiod = t.fperiod * (1.0 + t.vib_sin * self.vib_amp as f64);
            }
            t.set_period(whole_period(rfperiod));
        }
    }

    /// The control values read once a block, moved by the block's ticks as sfxr moves them each tick: the phaser's offset
    /// (`fphase += fdphase`), the high-pass (`flthp × flthp_d`, clamped) and the low-pass (`fltw × fltw_d⁸`, clamped).
    fn sweep(&mut self) {
        let n = self.t.swept;
        self.t.swept = 0;
        if self.phaser_on != 0 && self.fdphase != 0.0 {
            for _ in 0..n {
                self.fphase += self.fdphase;
            }
        }
        if self.hp_sweep != 0 && n > 0 {
            let mut h = self.flthp;
            for _ in 0..n {
                h = (h * self.flthp_d).clamp(0.000_01, 0.1);
            }
            self.flthp = h;
            // With no sweep, one clamp brings it inside sfxr's range, where it stays.
            self.hp_sweep = (self.flthp_d != 1.0) as u8;
        }
        if self.fltw_d8 != 1.0 {
            let mut w = self.fltw;
            for _ in 0..n {
                w = (w * self.fltw_d8).clamp(0.0, 0.1);
            }
            self.fltw = w;
        }
    }

    /// Sets the filters' coefficients when sfxr's values moved (at most once per control block).
    fn coefficients(&mut self, rate: f32) {
        if self.lp_on != 0 && self.fltw != self.lp_w_set {
            self.lp_w_set = self.fltw;
            let s = self.fltw.sqrt();
            let hz = (SFXR_SUPER as f32) * s * (1.0 / core::f32::consts::TAU);
            self.lp.set(hz, s / self.fltdmp, rate);
        }
        if self.flthp != self.hp_set {
            self.hp_set = self.flthp;
            let hz = -libm::logf(1.0 - self.flthp) * (SFXR_SUPER as f32) * (1.0 / core::f32::consts::TAU);
            self.hp.set(hz, rate);
        }
    }

    /// Samples `from..n` of waveform `W` (the low-pass `LP`: 0 none, 1 on, 2 as `lp_on` says; `high` quality when `HQ`):
    /// the ticks, the oscillator and the filters, fused,
    /// into `out` (before the phaser), and the envelope's level into `eb`. No ticks before sample `from` when `fresh` (a
    /// re-trigger just reset the clock there). Stops at a sample whose ticks ended the blip: returns it and `true`.
    #[allow(clippy::too_many_arguments)]
    #[inline(always)]
    fn run<const W: u8, const LP: u8, const HQ: bool>(&mut self, from: usize, n: usize, steps: &[f32], out: &mut [f32], eb: &mut [f32; BLOCK], rate: f32, fresh: bool, noise: &mut u32, ring: &mut Ring) -> (usize, bool) {
        self.coefficients(rate);
        let step = SFXR_RATE / rate as f64;
        let adv0 = SFXR_SUPER / rate as f64;
        let mut t = self.t;
        let mut playing = self.playing;
        let mut phase = self.phase;
        let mut held = self.held;
        let (mut lp, mut hp) = (self.lp, self.hp);
        let lp_on = LP == 1 || (LP == 2 && self.lp_on != 0);
        if lp_on && self.fltw <= 0.0 {
            // A low-pass at 0 passes nothing: an all-zero filter outputs exactly 0.
            lp = Svf::default();
        }
        let n = n.min(out.len());
        if HQ && self.ring_stale != 0 {
            ring.clear();
            self.ring_stale = 0;
        }
        let mut hq_ph = self.hq_ph;
        let mut env = t.envelope();
        let acc0 = t.acc;
        let mut j = from;
        let mut ended = false;
        // The re-trigger's sample has no ticks (sfxr's reset happens after them).
        let mut skip = fresh;
        while j < n {
            if !skip {
                t.acc += step;
                if t.acc >= 1.0 {
                    loop {
                        t.acc -= 1.0;
                        self.tick(&mut t, &mut playing);
                        if t.acc < 1.0 {
                            break;
                        }
                    }
                    if playing == 0 {
                        core::hint::cold_path();
                        ended = true;
                        break;
                    }
                    self.follow(&mut t);
                    env = t.envelope();
                }
            }
            skip = false;
            // sfxr's phase moves 8 steps a tick (352,800 a second), times the pitch.
            let adv = adv0 * steps[j] as f64;
            let mut wrapped = false;
            if phase >= t.period {
                // sfxr's `phase %= period`: one subtraction unless the period just shrank below half the phase.
                wrapped = true;
                phase -= t.period;
                if phase >= t.period {
                    core::hint::cold_path();
                    phase %= t.period;
                }
            }
            let ph = phase * t.inv_period;
            let cycles = adv * t.inv_period;
            // (A compare, not `f64::min`: no NaN can arrive, and `min`'s NaN rule costs a select chain.)
            let dt = if cycles < MAX_DT { cycles } else { MAX_DT };
            phase += adv;
            let mut x = if HQ {
                // `high`: the naive waveform through the ring, each discontinuity the move crossed (the wrap, the
                // square's duty, the triangle's top) a residual from `tau` = (its distance behind) / (the move).
                let prev = hq_ph;
                hq_ph = ph;
                match W {
                    wave::SAW => {
                        if wrapped {
                            ring.edge(ph / cycles, 2.0);
                        }
                        ring.push((1.0 - 2.0 * ph) as f32)
                    }
                    wave::SINE => ring.push(sine_cycles(ph)),
                    wave::NOISE => held.next_hq(32.0 * cycles, || super::noise::uniform(noise), ring),
                    wave::TRIANGLE => {
                        let c = (8.0 * cycles) as f32;
                        if wrapped {
                            ring.corner(ph / cycles, c);
                        }
                        crossed(prev, ph, wrapped, 0.5, cycles, |tau| ring.corner(tau, -c));
                        ring.push(if ph < 0.5 { 4.0 * ph - 1.0 } else { 3.0 - 4.0 * ph } as f32)
                    }
                    _ => {
                        let duty = t.square_duty as f64;
                        if wrapped {
                            ring.edge(ph / cycles, 1.0);
                        }
                        crossed(prev, ph, wrapped, duty, cycles, |tau| ring.edge(tau, -1.0));
                        ring.push(if ph < duty { 0.5 } else { -0.5 })
                    }
                }
            } else {
                match W {
                    wave::SAW => -saw_at(ph, dt) as f32,
                    wave::SINE => sine_cycles(ph),
                    // sfxr's 32 held values a period.
                    wave::NOISE => held.next(32.0 * cycles, || super::noise::uniform(noise)),
                    wave::TRIANGLE => triangle_at(ph, dt) as f32,
                    _ => pulse_at(ph, dt, t.square_duty as f64, 0.5) as f32,
                }
            };
            if lp_on {
                x = lp.lowpass(x);
            }
            out[j] = hp.highpass(x);
            eb[j] = env;
            j += 1;
        }
        if !ended {
            // The run's ticks, for the once-a-block sweeps: the clock's advance less what it still owes (exact: a handful
            // of additions far from rounding to the next whole tick).
            let stepped = (j - from).saturating_sub(fresh as usize) as f64;
            t.swept += (acc0 + stepped * step - t.acc + 0.5) as u32;
        }
        self.t = t;
        self.playing = playing;
        self.phase = phase;
        self.held = held;
        self.lp = lp;
        self.hp = hp;
        if HQ {
            self.hq_ph = hq_ph;
        }
        (j, ended)
    }

    /// The second pass over samples `from..m` of `out` (the blip before its phaser), four lanes at a time where the build
    /// has simd128: the phaser (or sfxr's doubling without it), the envelope `eb` and the gain `g0` ramping by `dg` a
    /// sample. The phaser reads only samples at or before its own (its delay is at least 0), so the block goes into the
    /// line first and its delayed window is read out of it in a line.
    #[allow(clippy::too_many_arguments)]
    fn finish_block(&mut self, from: usize, m: usize, out: &mut [f32], eb: &[f32; BLOCK], g0: f32, dg: f32, rate: f32) {
        let m = m.min(out.len());
        if m <= from {
            return;
        }
        let k = m - from;
        let (x, e) = (&mut out[from..m], &eb[from..m]);
        if self.phaser_on != 0 {
            // The phaser's delay for the block, `whole + 1 - frac` samples back: `a` one further back than `b`, and
            // `a + (b - a) × frac` (frac 1 reads `b`, the delay a whole number of samples).
            let iphase = ((self.fphase as i32).unsigned_abs()).min(PHASER_STEPS as u32 - 1);
            let delay = iphase as f32 * (rate / SFXR_SUPER as f32);
            let whole = delay as i32 as f32;
            let (back, frac) = (whole as usize % LINE, 1.0 - (delay - whole));
            let w0 = self.write as usize % LINE;
            let first = (LINE - w0).min(k);
            self.line[w0..w0 + first].copy_from_slice(&x[..first]);
            self.line[..k - first].copy_from_slice(&x[first..]);
            // d[i] is the sample `back + 1` before sample i (sfxr's `a`), d[i + 1] the one `back` before (`b`).
            let mut d = [0.0f32; BLOCK + 1];
            let s0 = (w0 + 2 * LINE - back - 1) % LINE;
            let first = (LINE - s0).min(k + 1);
            d[..first].copy_from_slice(&self.line[s0..s0 + first]);
            d[first..k + 1].copy_from_slice(&self.line[..k + 1 - first]);
            finish(x, e, Some((&d[..k + 1], frac)), g0, dg, from);
            self.write = ((w0 + k) % LINE) as u32;
        } else {
            finish(x, e, None, g0, dg, from);
        }
    }

    /// Renders `out.len()` samples (at most [`BLOCK`]) with per-sample pitch `steps`, times gain `g0` ramping to `g1`;
    /// `noise` draws held values; `ring` is the minBLEP ring `high` quality uses (the voice's). Returns `false` once the blip has ended (the rest of `out` is zero).
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, steps: &[f32], out: &mut [f32], g0: f32, g1: f32, rate: f32, repeat: bool, noise: &mut u32, ring: &mut Ring) -> bool {
        let n = out.len().min(BLOCK);
        let dg = (g1 - g0) / n as f32;
        let (mut from, mut fresh) = (0, false);
        let mut eb = [0.0f32; BLOCK];
        loop {
            macro_rules! run {
                ($w:expr) => {
                    if self.hq != 0 {
                        self.run::<{ $w }, 2, true>(from, n, steps, out, &mut eb, rate, fresh, noise, ring)
                    } else if self.lp_on != 0 {
                        self.run::<{ $w }, 1, false>(from, n, steps, out, &mut eb, rate, fresh, noise, ring)
                    } else {
                        self.run::<{ $w }, 0, false>(from, n, steps, out, &mut eb, rate, fresh, noise, ring)
                    }
                };
            }
            let (m, ended) = match self.wave {
                wave::SAW => run!(wave::SAW),
                wave::SINE => run!(wave::SINE),
                wave::NOISE => run!(wave::NOISE),
                wave::TRIANGLE => run!(wave::TRIANGLE),
                _ => run!(wave::SQUARE),
            };
            self.finish_block(from, m, out, &eb, g0, dg, rate);
            if !ended {
                break;
            }
            if !repeat {
                out[m..].fill(0.0);
                return false;
            }
            // The PLAY loop flag: a fresh trigger from this sample (sfxr's repeat, endless).
            let p = self.p;
            self.start(&p);
            (from, fresh) = (m, true);
        }
        self.sweep();
        true
    }

    /// Moves `n` samples on without rendering (a virtual voice): the envelope's ticks only (the oscillator, filters and
    /// slides hold). Returns `false` once the blip has ended.
    pub fn advance(&mut self, n: u32, rate: f32, repeat: bool) -> bool {
        // The counters catch up with the ticks rendered since the last event.
        let done = self.t.span - self.t.left;
        self.t.rep_time += done;
        self.t.arp_time += done;
        self.t.acc += SFXR_RATE / rate as f64 * n as f64;
        let mut ticks = self.t.acc.floor() as u64;
        self.t.acc -= ticks as f64;
        self.t.rep_time = self.t.rep_time.wrapping_add(ticks as u32);
        while ticks > 0 && self.playing != 0 {
            let len = self.env_length[self.t.env_stage.min(2) as usize] as u64 + 1;
            let left = len - (self.t.env_time as u64).min(len);
            if ticks < left {
                self.t.env_time += ticks as f32;
                break;
            }
            ticks -= left;
            self.t.env_time = 0.0;
            self.t.env_stage += 1;
            if self.t.env_stage >= 3 {
                self.t.env_stage = 3;
                if repeat {
                    let p = self.p;
                    self.start(&p);
                } else {
                    self.playing = 0;
                }
            }
        }
        let mut t = self.t;
        self.stage(&mut t);
        if t.stale != 0 {
            // A re-trigger: its first tick runs the events (the frequency limit's first check).
            (t.span, t.left) = (1, 1);
        } else {
            self.schedule(&mut t);
        }
        self.t = t;
        self.playing != 0
    }
}
