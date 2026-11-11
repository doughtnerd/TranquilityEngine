//! Seeded noise, test IRs and test inputs. Throwaway spike code.

pub const SR: f32 = 48_000.0;

/// xorshift64*: deterministic, no dependencies.
#[derive(Clone)]
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03 | 1)
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        (self.uniform() * 2.0 - 1.0) as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    /// Decaying noise, M1's `makeImpulse` shape (cubic envelope), with a seed.
    Noise,
    /// Direct sound, 28 early reflections in the first ~110 ms, then a diffuse exponential tail
    /// (RT60 about 0.9 x length) that gets darker with time (a one-pole low-pass that closes).
    Room,
}

/// A stereo IR, unnormalised. `seconds` at 48 kHz.
pub fn make_ir(shape: Shape, seconds: f64, seed: u64) -> [Vec<f32>; 2] {
    let n = (SR as f64 * seconds) as usize;
    let mut out = [vec![0.0f32; n], vec![0.0f32; n]];
    for (ch, h) in out.iter_mut().enumerate() {
        let mut rng = Rng::new(seed * 2 + ch as u64 + 1);
        match shape {
            Shape::Noise => {
                for (i, x) in h.iter_mut().enumerate() {
                    let e = 1.0 - i as f64 / n as f64;
                    *x = (rng.signed() as f64 * e * e * e) as f32;
                }
            }
            Shape::Room => {
                let rt60 = seconds * 0.9;
                let onset = 0.035 * SR as f64;
                let mut lp = 0.0f32;
                for (i, x) in h.iter_mut().enumerate() {
                    let t = i as f64 / SR as f64;
                    let rise = (i as f64 / onset).min(1.0);
                    let fade = ((n - i) as f64 / (0.03 * n as f64)).min(1.0);
                    let env = (-6.9078 * t / rt60).exp() * rise * rise * fade;
                    let a = 0.15 + 0.6 * (-t / 0.4).exp();
                    lp += a as f32 * (rng.signed() - lp);
                    *x = lp * env as f32 * 0.9;
                }
                h[0] += 1.0;
                for k in 0..28 {
                    let t = 0.004 + (k as f64 * 0.0031 + rng.uniform() * 0.004) * (1.0 + k as f64 * 0.05);
                    let pos = (t * SR as f64) as usize;
                    if pos < n {
                        h[pos] += rng.signed().signum() * (0.75 * 0.92f64.powi(k)) as f32 * (0.6 + 0.4 * rng.uniform() as f32);
                    }
                }
            }
        }
    }
    out
}

/// A smooth, resonant IR (two decaying tones) so outputs are smooth and a discontinuity shows.
pub fn make_tone_ir(seconds: f64, freq_l: f64, freq_r: f64, tau: f64) -> [Vec<f32>; 2] {
    let n = (SR as f64 * seconds) as usize;
    let f = |freq: f64| -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f64 / SR as f64;
                ((-t / tau).exp() * (2.0 * std::f64::consts::PI * freq * t).sin() * 0.05) as f32
            })
            .collect()
    };
    [f(freq_l), f(freq_r)]
}

/// Stereo input of `frames`: gated noise bursts (50 to 300 ms, gaps 100 to 400 ms) over a quiet
/// low tone, distinct per seed. Peaks about 0.5.
pub fn make_input(seed: u64, frames: usize) -> [Vec<f32>; 2] {
    let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
    for (ch, x) in out.iter_mut().enumerate() {
        let mut rng = Rng::new(seed * 7 + ch as u64 + 101);
        let (mut i, mut on) = (0usize, true);
        let f0 = 110.0 + 40.0 * (seed % 5) as f64;
        while i < frames {
            let len = if on { 0.05 + 0.25 * rng.uniform() } else { 0.1 + 0.3 * rng.uniform() };
            let len = (len * SR as f64) as usize;
            for j in i..(i + len).min(frames) {
                let t = j as f64 / SR as f64;
                let tone = 0.05 * (2.0 * std::f64::consts::PI * f0 * t).sin() as f32;
                x[j] = tone + if on { 0.5 * rng.signed() } else { 0.0 };
            }
            i += len;
            on = !on;
        }
    }
    out
}

pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((q * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[idx]
}
