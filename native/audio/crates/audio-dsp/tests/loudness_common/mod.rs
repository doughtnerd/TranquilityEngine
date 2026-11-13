//! Shared by Ld6's loudness tests (`loudness_crate.rs`, `loudness_files.rs`): the meter under test
//! (`audio_dsp::loudness::Meter`, fed quantum by quantum with a STATUS take every few quanta, as
//! the core runs it) and the main half's exact list-based gating (spike S1's `Gating`, ported in
//! TypeScript by `loudnessStats.ts`, which uses the 1,000-bin histogram form instead), plus spike
//! S1's signals with `libm` for the transcendentals.
#![allow(dead_code)]

use audio_dsp::loudness::{self, Meter, Ring, QUANTUM, RING};
use core::f64::consts::PI;

// ---------------------------------------------------------------- signals (spike `signals.rs`)

pub struct Rng(pub u64);
impl Rng {
    /// Uniform in [-1, 1).
    pub fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_f32() as f64 + 1.0) * 0.5
    }
    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    /// Uniform integer in 0..n.
    pub fn below(&mut self, n: usize) -> usize {
        ((self.unit() * n as f64) as usize).min(n - 1)
    }
}

pub type Stereo = (Vec<f32>, Vec<f32>);

pub fn db(x: f64) -> f64 {
    libm::pow(10.0, x / 20.0)
}

pub fn dbf(x: f64) -> f64 {
    if x > 0.0 {
        20.0 * libm::log10(x)
    } else {
        f64::NEG_INFINITY
    }
}

/// Stereo sine (same in both channels), `amp_db` dBFS peak.
pub fn sine(rate: f64, freq: f64, amp_db: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let a = db(amp_db);
    let v: Vec<f32> = (0..n).map(|i| (a * libm::sin(2.0 * PI * freq * i as f64 / rate)) as f32).collect();
    (v.clone(), v)
}

/// fs/4 sine at 45 degrees: samples are ±A/√2, true peak A.
pub fn fs4_45(rate: f64, amp: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let v: Vec<f32> = (0..n).map(|i| (amp * libm::sin(PI / 4.0 + i as f64 * PI / 2.0)) as f32).collect();
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

/// Spike S1's music-like signal: low-passed noise plus partials, slow level swings (period 7 s),
/// different in L and R; `peak` is the approximate sample peak at the loud part of the swing.
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
            let tone = libm::sin(2.0 * PI * 220.0 * t) * 0.25 + libm::sin(2.0 * PI * (440.0 + 3.0 * ch as f64) * t) * 0.15 + libm::sin(2.0 * PI * 3000.0 * t) * 0.03;
            let sw = 0.5 + 0.5 * libm::sin(2.0 * PI * t / 7.0);
            let env = 0.15 + 0.85 * sw * sw;
            o.push((peak * env * (p2 as f64 * 1.6 + tone) / 1.2) as f32);
        }
    }
    let [l, r] = out;
    (l, r)
}

/// Spike S1's case keys (`loudness_s1.rs`'s `REFS` keys).
pub const S1_KEYS: [&str; 13] = ["t1", "t2", "t2b", "t3", "t4", "t5", "l1", "l2", "l3", "tp0.5", "tp1", "tp1.4125", "music"];

/// Spike S1's signal for a case key at a rate.
pub fn s1_signal(rate: f64, key: &str) -> Stereo {
    match key {
        "t1" => sine(rate, 1000.0, -23.0, 20.0),
        "t2" => sine(rate, 1000.0, -33.0, 20.0),
        "t2b" => sine(rate, 1000.0, -20.0, 20.0),
        "t3" => concat(vec![sine(rate, 1000.0, -36.0, 10.0), sine(rate, 1000.0, -23.0, 60.0), sine(rate, 1000.0, -36.0, 10.0)]),
        "t4" => concat(vec![sine(rate, 1000.0, -80.0, 20.0), sine(rate, 1000.0, -23.0, 20.0)]),
        "t5" => concat(vec![sine(rate, 1000.0, -20.0, 10.0), sine(rate, 1000.0, -26.0, 10.0)]),
        "l1" => concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -30.0, 20.0)]),
        "l2" => concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -15.0, 20.0)]),
        "l3" => concat(vec![sine(rate, 1000.0, -40.0, 20.0), sine(rate, 1000.0, -20.0, 20.0)]),
        "tp0.5" => fs4_45(rate, 0.5, 2.0),
        "tp1" => fs4_45(rate, 1.0, 2.0),
        "tp1.4125" => fs4_45(rate, 1.4125, 2.0),
        "music" => music(rate, 60.0, 0.7, 5),
        _ => panic!("no S1 case {key}"),
    }
}

/// Random programme material: segments of 50 ms to 8 s of noise (white or low-passed), sines,
/// sweeps, clipped sines, sparse near-full-scale clicks, silence and near-silence, at random levels
/// (−90 to 0 dBFS) and random stereo forms (same, independent, one side, inverted). The length is
/// 10 to 40 s, cut to whole sub-blocks so the momentary and short-term windows line up with the
/// crate's.
pub fn programme(rate: f64, seed: u64) -> Stereo {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let sub = loudness::subblock_frames(rate) as usize;
    let total = ((rng.range(10.0, 40.0) * rate) as usize / sub).max(1) * sub;
    let (mut l, mut r) = (Vec::with_capacity(total), Vec::with_capacity(total));
    let mut t = 0usize;
    while l.len() < total {
        let len = ((rng.range(0.05, 8.0) * rate) as usize).min(total - l.len()).max(1);
        let kind = rng.below(8);
        let level = if rng.below(10) == 0 { db(rng.range(-100.0, -70.0)) } else { db(rng.range(-60.0, 0.0)) };
        let stereo = rng.below(4);
        let f0 = rng.range(20.0, rate * 0.45);
        let f1 = rng.range(20.0, rate * 0.45);
        let (mut p1, mut p2, mut q1) = (0.0f64, 0.0f64, 0.0f64);
        let lp = rng.range(0.01, 0.5);
        for i in 0..len {
            let ts = (t + i) as f64 / rate;
            let u = i as f64 / len as f64;
            let (a, b) = match kind {
                0 => (rng.next_f32() as f64, rng.next_f32() as f64),
                1 => {
                    p1 += lp * (rng.next_f32() as f64 - p1);
                    q1 += lp * (rng.next_f32() as f64 - q1);
                    p2 += lp * (p1 - p2);
                    (p2 * 3.0, q1 * 3.0)
                }
                2 => {
                    let s = libm::sin(2.0 * PI * f0 * ts);
                    (s, libm::sin(2.0 * PI * f0 * ts + 0.3))
                }
                3 => {
                    // linear sweep f0 → f1 over the segment
                    let ph = 2.0 * PI * (f0 * (i as f64 / rate) + 0.5 * (f1 - f0) * u * (i as f64 / rate));
                    (libm::sin(ph), libm::cos(ph))
                }
                4 => {
                    let s = (3.0 * libm::sin(2.0 * PI * f0 * 0.05 * ts)).clamp(-1.0, 1.0);
                    (s, -s)
                }
                5 => {
                    let c = if rng.below(2000) == 0 { rng.next_f32().signum() as f64 } else { 0.0 };
                    (c, c)
                }
                6 => (0.0, 0.0),
                _ => {
                    let s = libm::sin(2.0 * PI * 997.0 * ts) * (0.5 + 0.5 * libm::sin(2.0 * PI * 0.7 * ts));
                    (s, s * 0.5)
                }
            };
            let (a, b) = match stereo {
                0 => (a, a),
                1 => (a, b),
                2 => (a, 0.0),
                _ => (a, -a),
            };
            l.push((level * a).clamp(-1.0, 1.0) as f32);
            r.push((level * b).clamp(-1.0, 1.0) as f32);
        }
        t += len;
    }
    (l, r)
}

// ---------------------------------------------------------------- the meter under test

/// The sub-block energies a meter delivered through STATUS takes, and its peaks.
pub struct Fed {
    /// Every sub-block's mean square, in order (the f32 ring values).
    pub subs: Vec<f32>,
    /// Sub-blocks the takes lost (ring overrun): 0 at the cadences used here.
    pub lost: u64,
    /// The peak (max of true and sample peak) per channel over the whole signal, linear.
    pub peak: [f32; 2],
}

/// Feeds `l`, `r` through a [`Meter`] at `rate` one quantum at a time, true peak every quantum,
/// with a STATUS take (the spike's `Feed::take`, `take_peak`) every `every` quanta and at the end.
pub fn feed(rate: f64, l: &[f32], r: &[f32], every: usize) -> Fed {
    let mut m = Meter::new(rate);
    let mut ring: Ring = [0.0; RING];
    let (mut last, mut lost) = (0u32, 0u64);
    let mut subs = Vec::new();
    let mut peak = [0.0f32; 2];
    let n = l.len().min(r.len());
    let (mut q, mut o) = (0usize, 0usize);
    while o < n {
        let e = (o + QUANTUM).min(n);
        m.process(&l[o..e], &r[o..e], &mut ring);
        q += 1;
        o = e;
        if q % every == 0 || o == n {
            let seq = m.seq();
            let mut new = seq.wrapping_sub(last) as usize;
            if new > RING {
                lost += (new - RING) as u64;
                new = RING;
            }
            for j in 0..new {
                let e = (seq as usize).wrapping_sub(new).wrapping_add(j);
                subs.push(ring[e % RING]);
            }
            last = seq;
            let p = m.take_peak();
            peak = [peak[0].max(p[0]), peak[1].max(p[1])];
        }
    }
    Fed { subs, lost, peak }
}

// ---------------------------------------------------------------- exact gating (spike `loud.rs`)

/// Momentary, short-term, integrated and LRA from the first `subs.len()` sub-blocks, exact
/// (list-based) gating as spike S1's `Gating` and libebur128: `-inf` for M, S, I without enough
/// audio; LRA 0 with fewer than two blocks past the gates (the crate's convention).
#[derive(Clone, Copy, Debug)]
pub struct Stats {
    pub m: f64,
    pub s: f64,
    pub i: f64,
    pub lra: f64,
}

fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len() as f64
}

/// The exact statistics of a sub-block sequence (energies as f64).
pub fn stats(subs: &[f64]) -> Stats {
    let lufs = loudness::lufs;
    let last = |n: usize| if subs.len() < n { f64::NEG_INFINITY } else { lufs(mean(&subs[subs.len() - n..])) };
    let window = |n: usize| -> Vec<f64> { if subs.len() < n { Vec::new() } else { (n - 1..subs.len()).map(|i| mean(&subs[i + 1 - n..=i])).collect() } };
    let i = {
        let blocks: Vec<f64> = window(4).into_iter().filter(|&e| lufs(e) >= -70.0).collect();
        if blocks.is_empty() {
            f64::NEG_INFINITY
        } else {
            let rel = lufs(mean(&blocks)) - 10.0;
            let g: Vec<f64> = blocks.into_iter().filter(|&e| lufs(e) >= rel).collect();
            if g.is_empty() { f64::NEG_INFINITY } else { lufs(mean(&g)) }
        }
    };
    let lra = {
        let blocks: Vec<f64> = window(30).into_iter().step_by(10).filter(|&e| lufs(e) >= -70.0).collect();
        if blocks.is_empty() {
            0.0
        } else {
            let rel = lufs(mean(&blocks)) - 20.0;
            let mut v: Vec<f64> = blocks.into_iter().map(lufs).filter(|&x| x >= rel).collect();
            if v.len() < 2 {
                0.0
            } else {
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let at = |p: f64| v[((v.len() - 1) as f64 * p + 0.5) as usize];
                at(0.95) - at(0.10)
            }
        }
    };
    Stats { m: last(4), s: last(30), i, lra }
}

/// [`stats`] after every sub-block (`[k]` = the statistics of `subs[..=k]`), in O(n²) simple
/// arithmetic rather than [`stats`]' allocations per prefix; same formulas.
pub fn stats_series(subs: &[f64]) -> Vec<Stats> {
    let lufs = loudness::lufs;
    let n = subs.len();
    let block = |w: usize, k: usize| if k + 1 >= w { Some(mean(&subs[k + 1 - w..=k])) } else { None };
    let b4: Vec<Option<f64>> = (0..n).map(|k| block(4, k)).collect();
    let mut lra_blocks: Vec<f64> = Vec::new();
    let mut lra = 0.0;
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        // integrated: the 400 ms blocks ending at 3..=k
        let (mut c, mut s) = (0usize, 0.0);
        for e in b4[..=k].iter().flatten() {
            if lufs(*e) >= -70.0 {
                c += 1;
                s += e;
            }
        }
        let i = if c == 0 {
            f64::NEG_INFINITY
        } else {
            let rel = lufs(s / c as f64) - 10.0;
            let (mut c2, mut s2) = (0usize, 0.0);
            for e in b4[..=k].iter().flatten() {
                if lufs(*e) >= -70.0 && lufs(*e) >= rel {
                    c2 += 1;
                    s2 += e;
                }
            }
            if c2 == 0 { f64::NEG_INFINITY } else { lufs(s2 / c2 as f64) }
        };
        // LRA: a new 3 s block at k = 29, 39, 49, …
        if k >= 29 && (k - 29) % 10 == 0 {
            let e = block(30, k).unwrap();
            if lufs(e) >= -70.0 {
                lra_blocks.push(e);
            }
            if !lra_blocks.is_empty() {
                let rel = lufs(mean(&lra_blocks)) - 20.0;
                let mut v: Vec<f64> = lra_blocks.iter().map(|&e| lufs(e)).filter(|&x| x >= rel).collect();
                lra = if v.len() < 2 {
                    0.0
                } else {
                    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    let at = |p: f64| v[((v.len() - 1) as f64 * p + 0.5) as usize];
                    at(0.95) - at(0.10)
                };
            }
        }
        let m = b4[k].map_or(f64::NEG_INFINITY, lufs);
        let s = block(30, k).map_or(f64::NEG_INFINITY, lufs);
        out.push(Stats { m, s, i, lra });
    }
    out
}

/// `|a − b|`, 0 when both are the same infinity (a reading that is `-inf` on both sides agrees).
pub fn diff(a: f64, b: f64) -> f64 {
    if a == b { 0.0 } else { (a - b).abs() }
}
