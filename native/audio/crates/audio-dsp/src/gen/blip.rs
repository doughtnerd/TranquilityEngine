//! The blip: sfxr's synthesiser (DrPetter's sfxr, MIT; the same algorithm as bfxr and jsfxr), its parameters in sfxr's
//! own units so settings port, rendered band-limited at any context rate (ADR 0346 §2, owner decision 2).
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
//! The PLAY loop flag re-triggers the blip at its end (sfxr's repeat, endless) until the key-off.

use super::osc::{dt_of, pulse_at, saw_at, sine_cycles, triangle_at, Held, MAX_DT};
use super::svf::{OnePole, Svf, LOWPASS};

/// sfxr's control rate (its per-sample loop).
pub const SFXR_RATE: f64 = 44_100.0;
/// sfxr's oscillator and filter rate (8× supersampling).
pub const SFXR_SUPER: f64 = 8.0 * SFXR_RATE;
/// sfxr's phaser buffer, in its supersampled steps.
pub const PHASER_STEPS: usize = 1_024;
/// The context-rate delay line: sfxr's 1,023 steps at up to 352.8 kHz.
pub const LINE: usize = 1_024;

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
    pub const COUNT: usize = 24;
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

/// One blip's state: the latched parameters, sfxr's control state and the band-limited render's. All-zero is a blip not
/// started yet ([`Blip::start`]).
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Blip {
    /// The parameters read at the start and each re-trigger.
    pub p: [f32; p::COUNT],
    pub started: u8,
    /// 0 once the blip has ended (its envelope's last stage, or the frequency limit).
    pub playing: u8,
    wave: u8,
    lp_on: u8,
    phaser_on: u8,
    _pad: [u8; 3],
    // sfxr's control state.
    fperiod: f64,
    fmaxperiod: f64,
    fslide: f64,
    fdslide: f64,
    arp_mod: f64,
    tick_acc: f64,
    period: f64,
    square_duty: f32,
    square_slide: f32,
    arp_time: u32,
    arp_limit: u32,
    vib_phase: f32,
    vib_speed: f32,
    vib_amp: f32,
    pub env_vol: f32,
    pub env_stage: u32,
    env_time: u32,
    env_length: [u32; 3],
    fphase: f32,
    fdphase: f32,
    iphase: u32,
    fltw: f32,
    fltw_d8: f32,
    fltdmp: f32,
    flthp: f32,
    flthp_d: f32,
    rep_time: u32,
    rep_limit: u32,
    // The render's state.
    /// sfxr's oscillator phase: supersampled steps into the current period, read as `phase / period` (a period that grows
    /// mid-cycle slows the cycle, as in sfxr).
    phase: f64,
    held: Held,
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
        self.tick_acc = 0.0;
        self.phase = 0.0;
        self.held.phase = 0.0;
        self.reset(false);
    }

    /// sfxr's `ResetSample(restart)`.
    fn reset(&mut self, restart: bool) {
        let p = self.p;
        let sq = |x: f32| x * x;
        let cube = |x: f32| x as f64 * x as f64 * x as f64;
        self.wave = p[p::WAVEFORM].clamp(0.0, 4.0) as u8;
        self.fperiod = 100.0 / (sq(p[p::BASE_FREQUENCY]) as f64 + 0.001);
        self.period = (self.fperiod as i64).max(8) as f64;
        self.fmaxperiod = 100.0 / (sq(p[p::FREQUENCY_LIMIT]) as f64 + 0.001);
        self.fslide = 1.0 - cube(p[p::SLIDE]) * 0.01;
        self.fdslide = -cube(p[p::DELTA_SLIDE]) * 0.000_001;
        self.square_duty = 0.5 - p[p::DUTY] * 0.5;
        self.square_slide = -p[p::DUTY_SWEEP] * 0.000_05;
        let arp = p[p::ARPEGGIO_AMOUNT] as f64;
        self.arp_mod = if arp >= 0.0 { 1.0 - arp * arp * 0.9 } else { 1.0 + arp * arp * 10.0 };
        self.arp_time = 0;
        self.arp_limit = if p[p::ARPEGGIO_SPEED] == 1.0 { 0 } else { (sq(1.0 - p[p::ARPEGGIO_SPEED]) * 20_000.0 + 32.0) as u32 };
        if restart {
            return;
        }
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
        self.vib_phase = 0.0;
        self.vib_speed = sq(p[p::VIBRATO_SPEED]) * 0.01;
        self.vib_amp = p[p::VIBRATO_DEPTH] * 0.5;
        self.env_vol = 0.0;
        self.env_stage = 0;
        self.env_time = 0;
        self.env_length = envelope_ticks(p[p::ATTACK], p[p::SUSTAIN], p[p::DECAY]);
        self.fphase = sq(p[p::PHASER_OFFSET]) * 1_020.0;
        if p[p::PHASER_OFFSET] < 0.0 {
            self.fphase = -self.fphase;
        }
        self.fdphase = sq(p[p::PHASER_SWEEP]);
        if p[p::PHASER_SWEEP] < 0.0 {
            self.fdphase = -self.fdphase;
        }
        self.iphase = (self.fphase as i32).unsigned_abs();
        self.phaser_on = (p[p::PHASER_OFFSET] != 0.0 || p[p::PHASER_SWEEP] != 0.0) as u8;
        if self.phaser_on != 0 {
            self.line = [0.0; LINE];
            self.write = 0;
        }
        self.rep_time = 0;
        self.rep_limit = if p[p::REPEAT_SPEED] == 0.0 { 0 } else { (sq(1.0 - p[p::REPEAT_SPEED]) * 20_000.0 + 32.0) as u32 };
    }

    /// One 44.1 kHz control tick, sfxr's per-sample control in its order.
    fn tick(&mut self) {
        self.rep_time += 1;
        if self.rep_limit != 0 && self.rep_time >= self.rep_limit {
            self.rep_time = 0;
            self.reset(true);
        }
        self.arp_time += 1;
        if self.arp_limit != 0 && self.arp_time >= self.arp_limit {
            self.arp_limit = 0;
            self.fperiod *= self.arp_mod;
        }
        self.fslide += self.fdslide;
        self.fperiod *= self.fslide;
        if self.fperiod > self.fmaxperiod {
            self.fperiod = self.fmaxperiod;
            if self.p[p::FREQUENCY_LIMIT] > 0.0 {
                self.playing = 0;
            }
        }
        let mut rfperiod = self.fperiod;
        if self.vib_amp > 0.0 {
            self.vib_phase += self.vib_speed;
            rfperiod = self.fperiod * (1.0 + libm::sinf(self.vib_phase) as f64 * self.vib_amp as f64);
        }
        self.period = (rfperiod as i64).max(8) as f64;
        self.square_duty = (self.square_duty + self.square_slide).clamp(0.0, 0.5);
        self.env_time += 1;
        if self.env_time > self.env_length[self.env_stage.min(2) as usize] {
            self.env_time = 0;
            self.env_stage += 1;
            if self.env_stage >= 3 {
                self.env_stage = 3;
                self.playing = 0;
            }
        }
        let frac = |t: u32, len: u32| if len == 0 { 0.0 } else { t as f32 / len as f32 };
        match self.env_stage {
            0 => self.env_vol = frac(self.env_time, self.env_length[0]),
            1 => self.env_vol = 1.0 + (1.0 - frac(self.env_time, self.env_length[1])) * 2.0 * self.p[p::PUNCH],
            2 => self.env_vol = 1.0 - frac(self.env_time, self.env_length[2]),
            _ => self.env_vol = 0.0,
        }
        self.fphase += self.fdphase;
        self.iphase = ((self.fphase as i32).unsigned_abs()).min(PHASER_STEPS as u32 - 1);
        if self.flthp_d != 0.0 {
            self.flthp = (self.flthp * self.flthp_d).clamp(0.000_01, 0.1);
        }
        // sfxr sweeps its low-pass once per supersample: eight times a tick.
        self.fltw = (self.fltw * self.fltw_d8).clamp(0.0, 0.1);
    }

    /// Sets the filters' coefficients when sfxr's values moved (at most once per control block).
    fn coefficients(&mut self, rate: f32) {
        if self.lp_on != 0 && self.fltw != self.lp_w_set {
            self.lp_w_set = self.fltw;
            let s = libm::sqrtf(self.fltw);
            let hz = (SFXR_SUPER as f32) * s * (1.0 / core::f32::consts::TAU);
            self.lp.set(hz, s / self.fltdmp, rate);
        }
        if self.flthp != self.hp_set {
            self.hp_set = self.flthp;
            let hz = -libm::logf(1.0 - self.flthp) * (SFXR_SUPER as f32) * (1.0 / core::f32::consts::TAU);
            self.hp.set(hz, rate);
        }
    }

    /// Renders `out.len()` samples (at most a control block) with per-sample pitch `steps`, times gain `g0` ramping to
    /// `g1`; `noise` draws held values. Returns `false` once the blip has ended (the rest of `out` is zero).
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, steps: &[f32], out: &mut [f32], g0: f32, g1: f32, rate: f32, repeat: bool, noise: &mut u32) -> bool {
        let inv = 1.0 / rate as f64;
        let tick_step = SFXR_RATE * inv;
        let n = out.len();
        self.coefficients(rate);
        let dg = (g1 - g0) / n as f32;
        let delay = self.iphase as f32 * (rate / SFXR_SUPER as f32);
        for j in 0..n {
            self.tick_acc += tick_step;
            while self.tick_acc >= 1.0 {
                self.tick_acc -= 1.0;
                self.tick();
            }
            if self.playing == 0 {
                if !repeat {
                    out[j..].fill(0.0);
                    return false;
                }
                let p = self.p;
                self.start(&p);
            }
            // sfxr's phase moves 8 steps a tick (352,800 a second), times the pitch.
            let adv = SFXR_SUPER * inv * steps[j] as f64;
            if self.phase >= self.period {
                self.phase %= self.period;
            }
            let t = self.phase / self.period;
            let dt = (adv / self.period).min(MAX_DT);
            self.phase += adv;
            let mut x = match self.wave {
                wave::SAW => -saw_at(t, dt) as f32,
                wave::SINE => sine_cycles(t),
                wave::NOISE => self.held.next(dt_of(32.0 * adv / self.period * rate as f64, inv), || super::noise::uniform(noise)),
                wave::TRIANGLE => triangle_at(t, dt) as f32,
                _ => pulse_at(t, dt, self.square_duty as f64, 0.5) as f32,
            };
            if self.lp_on != 0 {
                x = if self.fltw > 0.0 { self.lp.process(LOWPASS, x) } else { 0.0 };
            }
            x = self.hp.highpass(x);
            if self.phaser_on != 0 {
                let w = self.write as usize;
                self.line[w] = x;
                let pos = w as f32 - delay;
                let base = libm::floorf(pos);
                let f = pos - base;
                let i0 = (base as i32).rem_euclid(LINE as i32) as usize;
                let i1 = (i0 + 1) % LINE;
                x += self.line[i0] + (self.line[i1] - self.line[i0]) * f;
                self.write = ((w + 1) % LINE) as u32;
            } else {
                x += x;
            }
            out[j] = x * self.env_vol * (g0 + dg * (j + 1) as f32);
        }
        true
    }

    /// Moves `n` samples on without rendering (a virtual voice): the envelope's ticks only (the oscillator, filters and
    /// slides hold). Returns `false` once the blip has ended.
    pub fn advance(&mut self, n: u32, rate: f32, repeat: bool) -> bool {
        self.tick_acc += SFXR_RATE / rate as f64 * n as f64;
        let mut t = libm::floor(self.tick_acc) as u64;
        self.tick_acc -= t as f64;
        self.rep_time = self.rep_time.wrapping_add(t as u32);
        while t > 0 && self.playing != 0 {
            let len = self.env_length[self.env_stage.min(2) as usize] as u64 + 1;
            let left = len - (self.env_time as u64).min(len);
            if t < left {
                self.env_time += t as u32;
                break;
            }
            t -= left;
            self.env_time = 0;
            self.env_stage += 1;
            if self.env_stage >= 3 {
                self.env_stage = 3;
                if repeat {
                    let p = self.p;
                    self.start(&p);
                } else {
                    self.playing = 0;
                }
            }
        }
        self.playing != 0
    }
}
