//! Test signals (deterministic).
use core::f64::consts::PI;

pub struct Rng(pub u64);
impl Rng {
    pub fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

pub type Stereo = (Vec<f32>, Vec<f32>);

pub fn db(x: f64) -> f64 {
    10f64.powf(x / 20.0)
}

/// Stereo sine (same in both channels), `amp_db` dBFS peak.
pub fn sine(rate: f64, freq: f64, amp_db: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let a = db(amp_db);
    let v: Vec<f32> = (0..n).map(|i| (a * (2.0 * PI * freq * i as f64 / rate).sin()) as f32).collect();
    (v.clone(), v)
}

/// fs/4 sine at 45 degrees: samples are +-A/sqrt2, true peak A.
pub fn fs4_45(rate: f64, amp: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let v: Vec<f32> = (0..n).map(|i| (amp * (PI / 4.0 + i as f64 * PI / 2.0).sin()) as f32).collect();
    (v.clone(), v)
}

pub fn concat(parts: Vec<Stereo>) -> Stereo {
    let mut l = Vec::new();
    let mut r = Vec::new();
    for (a, b) in parts {
        l.extend(a);
        r.extend(b);
    }
    (l, r)
}

/// Music-like: three-pole-ish low-passed noise plus a few partials, slow level swings (period 7 s), different in L and R.
/// `peak` is the approximate sample peak (linear) at the loud part of the swing.
pub fn music(rate: f64, secs: f64, peak: f64, seed: u64) -> Stereo {
    let n = (rate * secs) as usize;
    let mut rng = Rng(seed | 1);
    let mut out = [Vec::with_capacity(n), Vec::with_capacity(n)];
    for (ch, o) in out.iter_mut().enumerate() {
        let (mut p1, mut p2) = (0.0f32, 0.0f32);
        for i in 0..n {
            let t = i as f64 / rate;
            p1 += 0.08 * (rng.next_f32() - p1);
            p2 += 0.3 * (p1 - p2);
            let tone = (2.0 * PI * 220.0 * t).sin() * 0.25 + (2.0 * PI * (440.0 + 3.0 * ch as f64) * t).sin() * 0.15 + (2.0 * PI * 3000.0 * t).sin() * 0.03;
            let env = 0.15 + 0.85 * (0.5 + 0.5 * (2.0 * PI * t / 7.0).sin()).powi(2);
            o.push((peak * env * (p2 as f64 * 1.6 + tone) / 1.2) as f32);
        }
    }
    let [l, r] = out;
    (l, r)
}

/// A 200 ms tone burst then silence, repeating over `secs`.
pub fn burst(rate: f64, secs: f64, amp: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let on = (rate * 0.2) as usize;
    let v: Vec<f32> = (0..n).map(|i| if i % (n / 4).max(1) < on { (amp * (2.0 * PI * 1000.0 * i as f64 / rate).sin()) as f32 } else { 0.0 }).collect();
    (v.clone(), v)
}
