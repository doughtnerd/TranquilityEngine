//! S4 (M5): a sidechain ducking rule as the core could run it: an envelope follower on the trigger bus's output (peak or
//! RMS, attack/release in ms), a gain computer (threshold, ratio or "amount", soft knee, max reduction), smoothing of the
//! reduction (attack/release in ms), and a per-sample gain curve for the target bus.
//!
//! `tick` is how often the gain computer runs: 128 (once per quantum), 16, or 1 (per sample: the upper bound). The detector
//! itself always runs per sample (it is a few ops). The gain between two ticks is linearly interpolated per sample, so the
//! curve is continuous and adds no latency beyond the quantum the trigger was computed in.
use libm::{expf, log10f, powf, sqrtf};

pub const Q: usize = 128;
pub const RATE: f32 = 48_000.0;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Detect {
    Peak,
    Rms,
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub detect: Detect,
    /// Detector time constants, ms (one-pole, time to 63%).
    pub det_attack_ms: f32,
    pub det_release_ms: f32,
    pub threshold_db: f32,
    /// `f32::INFINITY` is a gate (full max reduction as soon as the level is over the threshold, with the knee).
    pub ratio: f32,
    pub knee_db: f32,
    /// Largest reduction, dB (positive): today's `amount` 0.3 is 10.46 dB.
    pub max_reduction_db: f32,
    /// Reduction smoothing, ms (one-pole, time to 63%): today's `attack` / `release` (mixer.ts `approach`: the same shape).
    pub attack_ms: f32,
    pub release_ms: f32,
}

impl Params {
    /// A rule like sound-lab's `{target: Music, trigger: SFX, amount: 0.3, attack: 0.05, release: 0.4}` on a level detector.
    pub fn sound_lab(detect: Detect) -> Params {
        Params { detect, det_attack_ms: 1.0, det_release_ms: 30.0, threshold_db: -40.0, ratio: f32::INFINITY, knee_db: 6.0, max_reduction_db: -20.0 * log10f(0.3), attack_ms: 50.0, release_ms: 400.0 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub p: Params,
    a_att: f32,
    a_rel: f32,
    /// Peak: the envelope; Rms: the mean square.
    env: f32,
    /// The smoothed reduction, dB (>= 0).
    pub gr_db: f32,
    /// The linear gain at the end of the previous quantum.
    pub gain: f32,
}

#[inline]
fn coef(ms: f32, frames: f32) -> f32 {
    if ms <= 0.0 {
        0.0
    } else {
        expf(-frames / (ms * 0.001 * RATE))
    }
}

impl Rule {
    pub fn new(p: Params) -> Rule {
        Rule { p, a_att: coef(p.det_attack_ms, 1.0), a_rel: coef(p.det_release_ms, 1.0), env: 0.0, gr_db: 0.0, gain: 1.0 }
    }

    /// The static curve: the reduction in dB for a detector level in dB.
    #[inline]
    pub fn computer(p: &Params, level_db: f32) -> f32 {
        let slope = if p.ratio.is_finite() { 1.0 - 1.0 / p.ratio } else { 1.0 };
        let over = level_db - p.threshold_db;
        let red = if 2.0 * over < -p.knee_db {
            0.0
        } else if 2.0 * over.abs() <= p.knee_db {
            let x = over + p.knee_db * 0.5;
            slope * x * x / (2.0 * p.knee_db)
        } else {
            slope * over
        };
        red.min(p.max_reduction_db)
    }

    /// Detector over one quantum of the trigger bus; returns the envelope (linear, RMS or peak) at its end.
    #[inline]
    pub fn detect(&mut self, tl: &[f32], tr: &[f32]) -> f32 {
        let (aa, ar) = (self.a_att, self.a_rel);
        let mut env = self.env;
        match self.p.detect {
            Detect::Peak => {
                for i in 0..tl.len() {
                    let x = tl[i].abs().max(tr[i].abs());
                    let c = if x > env { aa } else { ar };
                    env = x + c * (env - x);
                }
                self.env = env;
                env
            }
            Detect::Rms => {
                for i in 0..tl.len() {
                    let x = 0.5 * (tl[i] * tl[i] + tr[i] * tr[i]);
                    let c = if x > env { aa } else { ar };
                    env = x + c * (env - x);
                }
                self.env = env;
                sqrtf(env)
            }
        }
    }

    /// The whole rule for one quantum: detector, gain computer every `tick` samples, smoothing, and the gain curve into `g`.
    pub fn process(&mut self, tl: &[f32], tr: &[f32], tick: usize, g: &mut [f32; Q]) {
        if tick >= Q {
            let lvl = self.detect(tl, tr);
            let g1 = self.step(lvl, Q as f32);
            self.ramp_to(0, Q, g1, g);
            return;
        }
        let mut at = 0;
        while at < Q {
            let n = tick.min(Q - at);
            let lvl = self.detect(&tl[at..at + n], &tr[at..at + n]);
            let g1 = self.step(lvl, n as f32);
            self.ramp_to(at, n, g1, g);
            at += n;
        }
    }

    /// Gain computer + smoothing for `frames` samples at level `lvl`; returns the new linear gain.
    #[inline]
    fn step(&mut self, lvl: f32, frames: f32) -> f32 {
        let db = 20.0 * log10f(lvl + 1e-9);
        let red = Rule::computer(&self.p, db);
        let ms = if red > self.gr_db { self.p.attack_ms } else { self.p.release_ms };
        let c = coef(ms, frames);
        self.gr_db = red + c * (self.gr_db - red);
        powf(10.0, -self.gr_db * 0.05)
    }

    #[inline]
    fn ramp_to(&mut self, at: usize, n: usize, g1: f32, g: &mut [f32; Q]) {
        let g0 = self.gain;
        let step = (g1 - g0) / n as f32;
        let mut v = g0;
        for s in g[at..at + n].iter_mut() {
            v += step;
            *s = v;
        }
        g[at + n - 1] = g1;
        self.gain = g1;
    }
}

/// Multiplies the target's quantum by the per-sample gain curve.
#[inline]
pub fn apply(l: &mut [f32], r: &mut [f32], g: &[f32; Q]) {
    for i in 0..Q {
        l[i] *= g[i];
        r[i] *= g[i];
    }
}

/// Combines a second rule's curve into the first's (the lowest gain wins, as mixer.ts's lowest multiplier does).
#[inline]
pub fn combine_min(a: &mut [f32; Q], b: &[f32; Q]) {
    for i in 0..Q {
        a[i] = a[i].min(b[i]);
    }
}
