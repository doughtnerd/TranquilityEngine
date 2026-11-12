//! S1: the loudness meter's two halves.
//!
//! Audio-thread half ([`Loudness`]): per metered stereo bus and per 128-frame quantum, allocation-free, no
//! panics on the hot path, `libm` only for the constructor:
//!   1. K-weighting (ITU-R BS.1770-4 stage 1 shelf + stage 2 high-pass; two biquads per channel, f64 state),
//!   2. sum of squares (L + R, channel gains 1.0) into 100 ms sub-blocks, split exactly at the sub-block edge,
//!   3. true peak: 4x polyphase oversampling, 48 taps (12 per phase), f32, optionally gated on the sample peak.
//! It publishes the last four completed sub-block mean-squares (a ring) plus a sequence number, and the true-peak
//! maximum since the last STATUS take.
//!
//! Main half ([`Feed`], [`Gating`], [`Hist`]): turns the sub-block energies into momentary (4 sub-blocks, 400 ms,
//! 75% overlap by construction), short-term (30 sub-blocks, 3 s), gated integrated and loudness range (3 s blocks at a 1 s hop, as Tech 3342 and libebur128).
//!
//! The coefficient formulas and the true-peak interpolator (Hann-windowed sinc, 48 taps, factor 4) are the ones
//! `libebur128` (Copyright (c) 2011 Jan Kokemueller, MIT) and the `ebur128` crate (Copyright (c) 2020 Sebastian
//! Droege, MIT) use; this file is an independent rewrite for the core's fixed-size, no-alloc setting. If the code
//! is ported into `native/audio/`, ship their MIT notices (THIRD_PARTY).

use core::f64::consts::PI;

pub const QUANTUM: usize = 128;
/// Completed sub-blocks kept for the next STATUS (idle STATUS cadence is 48 quanta = 128 ms > 100 ms).
pub const RING: usize = 4;
const TAIL: usize = 11;

/// K-weighting biquads, `a0 = 1`. `[stage]`, stage 0 = shelf, 1 = high-pass.
#[derive(Clone, Copy, Debug)]
pub struct KCoef {
    pub b: [[f64; 3]; 2],
    pub a: [[f64; 2]; 2],
}

impl KCoef {
    #[allow(non_snake_case)]
    pub fn new(rate: f64) -> Self {
        let (f0, G, Q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let K = libm::tan(PI * f0 / rate);
        let Vh = libm::pow(10.0, G / 20.0);
        let Vb = libm::pow(Vh, 0.4996667741545416);
        let a0 = 1.0 + K / Q + K * K;
        let s_b = [(Vh + Vb * K / Q + K * K) / a0, 2.0 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
        let s_a = [2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0];
        let (f0, Q) = (38.13547087602444, 0.5003270373238773);
        let K = libm::tan(PI * f0 / rate);
        let h_a = [2.0 * (K * K - 1.0) / (1.0 + K / Q + K * K), (1.0 - K / Q + K * K) / (1.0 + K / Q + K * K)];
        KCoef { b: [s_b, [1.0, -2.0, 1.0]], a: [s_a, h_a] }
    }
}

/// How the true-peak stage runs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TpMode {
    Off,
    /// Oversample every quantum.
    Full,
    /// Oversample only quanta whose sample peak (either channel) is at least this linear level; the 11-sample
    /// FIR history is kept every quantum, so a quantum that does run is exact.
    Gated(f32),
}

/// One metered stereo bus.
pub struct Loudness {
    k: KCoef,
    z: [[[f64; 2]; 2]; 2], // [ch][stage][z1,z2]
    sub_len: u32,
    sub_n: u32,
    sub_acc: f64,
    /// Sub-blocks completed since reset (wraps).
    pub seq: u32,
    /// Mean square (L + R, K-weighted) of sub-block `e` at `ring[e % RING]`.
    pub ring: [f32; RING],
    taps: [[f32; 4]; 12],
    hist: [[f32; TAIL + QUANTUM]; 2],
    /// True-peak maximum per channel since the last [`Loudness::take_peak`], linear.
    pub tp: [f32; 2],
    pub mode: TpMode,
    /// Quanta in which the oversampler ran (diagnostics).
    pub tp_ran: u64,
}

/// `libebur128`'s interpolator: Hann window over 48 taps times sinc(m/4); tap `4t + p` belongs to phase `p`.
pub fn tp_taps() -> [[f32; 4]; 12] {
    let mut f = [[0.0f32; 4]; 12];
    for j in 0..48usize {
        let jf = j as f64;
        let w = 0.5 * (1.0 - libm::cos(2.0 * PI * jf / 48.0));
        let m = jf - 24.0;
        let c = if m.abs() > 1e-6 { w * libm::sin(m * PI / 4.0) / (m * PI / 4.0) } else { w };
        f[j / 4][j % 4] = c as f32;
    }
    f
}

#[inline]
pub fn sample_peak(l: &[f32], r: &[f32]) -> f32 {
    let pk = |x: &[f32]| x.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    pk(l).max(pk(r))
}

impl Loudness {
    pub fn new(rate: f64, mode: TpMode) -> Self {
        Loudness {
            k: KCoef::new(rate),
            z: [[[0.0; 2]; 2]; 2],
            sub_len: (rate / 10.0 + 0.5) as u32,
            sub_n: 0,
            sub_acc: 0.0,
            seq: 0,
            ring: [0.0; RING],
            taps: tp_taps(),
            hist: [[0.0; TAIL + QUANTUM]; 2],
            tp: [0.0; 2],
            mode,
            tp_ran: 0,
        }
    }

    pub fn reset(&mut self) {
        self.z = [[[0.0; 2]; 2]; 2];
        self.sub_n = 0;
        self.sub_acc = 0.0;
        self.seq = 0;
        self.ring = [0.0; RING];
        self.hist = [[0.0; TAIL + QUANTUM]; 2];
        self.tp = [0.0; 2];
    }

    /// K-weights `l`/`r` and returns the sum over frames of `l_k^2 + r_k^2`.
    #[inline]
    fn kw(&mut self, l: &[f32], r: &[f32]) -> f64 {
        let k = &self.k;
        let [mut zl, mut zr] = self.z;
        let mut acc = 0.0f64;
        for i in 0..l.len() {
            let mut x = [l[i] as f64, r[i] as f64];
            for s in 0..2 {
                let (b, a) = (&k.b[s], &k.a[s]);
                let y0 = b[0] * x[0] + zl[s][0];
                zl[s][0] = b[1] * x[0] - a[0] * y0 + zl[s][1];
                zl[s][1] = b[2] * x[0] - a[1] * y0;
                let y1 = b[0] * x[1] + zr[s][0];
                zr[s][0] = b[1] * x[1] - a[0] * y1 + zr[s][1];
                zr[s][1] = b[2] * x[1] - a[1] * y1;
                x = [y0, y1];
            }
            acc += x[0] * x[0] + x[1] * x[1];
        }
        self.z = [zl, zr];
        acc
    }

    /// K-weighting and energy only (the part that always runs).
    pub fn process_energy(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        let mut i = 0;
        while i < n {
            let take = (n - i).min((self.sub_len - self.sub_n) as usize);
            let e = self.kw(&l[i..i + take], &r[i..i + take]);
            if e.is_finite() {
                self.sub_acc += e;
            } else {
                self.z = [[[0.0; 2]; 2]; 2]; // a NaN/inf sample must not poison the filter state
            }
            self.sub_n += take as u32;
            i += take;
            if self.sub_n == self.sub_len {
                self.ring[(self.seq as usize) % RING] = (self.sub_acc / self.sub_len as f64) as f32;
                self.seq = self.seq.wrapping_add(1);
                self.sub_acc = 0.0;
                self.sub_n = 0;
            }
        }
        // Flush decaying states so digital silence never reaches denormals (no FTZ in wasm).
        for ch in self.z.iter_mut() {
            for st in ch.iter_mut() {
                for v in st.iter_mut() {
                    if v.abs() < 1e-200 {
                        *v = 0.0;
                    }
                }
            }
        }
    }

    /// The true-peak stage (history upkeep every quantum; the FIR per `mode`).
    pub fn process_tp(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len()).min(QUANTUM);
        let run = match self.mode {
            TpMode::Off => return,
            TpMode::Full => true,
            TpMode::Gated(th) => sample_peak(&l[..n], &r[..n]) >= th,
        };
        if run {
            self.tp_ran += 1;
        }
        for (ch, x) in [l, r].into_iter().enumerate() {
            let h = &mut self.hist[ch];
            h[TAIL..TAIL + n].copy_from_slice(&x[..n]);
            if run {
                let mut m = [0.0f32; 4];
                for i in 0..n {
                    let w: &[f32; 12] = h[i..i + 12].try_into().unwrap(); // w[11 - t] = x[i - t + 0]
                    let mut acc = [0.0f32; 4];
                    for t in 0..12 {
                        let s = w[11 - t];
                        for p in 0..4 {
                            acc[p] += s * self.taps[t][p];
                        }
                    }
                    for p in 0..4 {
                        m[p] = m[p].max(acc[p].abs());
                    }
                }
                let mx = m[0].max(m[1]).max(m[2].max(m[3]));
                self.tp[ch] = self.tp[ch].max(mx);
            }
            h.copy_within(n..n + TAIL, 0);
        }
    }

    /// One quantum, everything.
    pub fn process(&mut self, l: &[f32], r: &[f32]) {
        self.process_energy(l, r);
        self.process_tp(l, r);
    }

    /// STATUS take: the true peak since the last take, then cleared.
    pub fn take_peak(&mut self) -> [f32; 2] {
        core::mem::take(&mut self.tp)
    }
}

/// Bytes per metered bus in STATUS: seq u32 + ring 4 x f32 + true peak 2 x f32.
pub const STATUS_BYTES_PER_BUS: usize = 4 + 4 * RING + 8;

pub fn lufs(mean_square: f64) -> f64 {
    if mean_square > 0.0 {
        -0.691 + 10.0 * mean_square.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// Main: turns (seq, ring) pairs from STATUS into the list of new sub-block energies.
#[derive(Default)]
pub struct Feed {
    last: u32,
    pub lost: u64,
}

impl Feed {
    pub fn take(&mut self, seq: u32, ring: &[f32; RING], out: &mut Vec<f64>) {
        let mut new = seq.wrapping_sub(self.last) as usize;
        if new > RING {
            self.lost += (new - RING) as u64;
            new = RING;
        }
        for j in 0..new {
            let e = (seq as usize).wrapping_sub(new).wrapping_add(j);
            out.push(ring[e % RING] as f64);
        }
        self.last = seq;
    }
}

/// Main: exact (list-based) gating, the reference for [`Hist`].
#[derive(Default)]
pub struct Gating {
    pub subs: Vec<f64>,
}

fn window_means(subs: &[f64], n: usize) -> Vec<f64> {
    if subs.len() < n {
        return Vec::new();
    }
    (n - 1..subs.len()).map(|i| subs[i + 1 - n..=i].iter().sum::<f64>() / n as f64).collect()
}

impl Gating {
    pub fn momentary(&self) -> f64 {
        self.last(4)
    }
    pub fn shortterm(&self) -> f64 {
        self.last(30)
    }
    fn last(&self, n: usize) -> f64 {
        if self.subs.len() < n {
            return f64::NEG_INFINITY;
        }
        lufs(self.subs[self.subs.len() - n..].iter().sum::<f64>() / n as f64)
    }
    pub fn integrated(&self) -> f64 {
        let blocks: Vec<f64> = window_means(&self.subs, 4).into_iter().filter(|&e| lufs(e) >= -70.0).collect();
        if blocks.is_empty() {
            return f64::NEG_INFINITY;
        }
        let rel = lufs(blocks.iter().sum::<f64>() / blocks.len() as f64) - 10.0;
        let g: Vec<f64> = blocks.into_iter().filter(|&e| lufs(e) >= rel).collect();
        if g.is_empty() {
            return f64::NEG_INFINITY;
        }
        lufs(g.iter().sum::<f64>() / g.len() as f64)
    }
    pub fn lra(&self) -> f64 {
        // EBU Tech 3342 / libebur128: 3 s blocks, one per second (hop 10 sub-blocks), first after 3 s.
        let blocks: Vec<f64> = window_means(&self.subs, 30).into_iter().step_by(10).filter(|&e| lufs(e) >= -70.0).collect();
        if blocks.is_empty() {
            return 0.0;
        }
        let rel = lufs(blocks.iter().sum::<f64>() / blocks.len() as f64) - 20.0;
        let mut l: Vec<f64> = blocks.into_iter().map(lufs).filter(|&x| x >= rel).collect();
        if l.len() < 2 {
            return 0.0;
        }
        l.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |p: f64| l[((l.len() - 1) as f64 * p + 0.5) as usize];
        at(0.95) - at(0.10)
    }
}

/// Main: fixed-memory gating (what ships): 1000 bins of 0.1 LU from -70 LUFS, per bin a count and an exact
/// energy sum. Two of them (400 ms blocks for I, 3 s blocks for LRA) cost 2 x 1000 x 12 B = 24 kB per metered bus.
pub struct Hist {
    cnt: Vec<u32>,
    esum: Vec<f64>,
}

const BINS: usize = 1000;

impl Hist {
    pub fn new() -> Self {
        Hist { cnt: vec![0; BINS], esum: vec![0.0; BINS] }
    }
    pub fn add(&mut self, e: f64) {
        let l = lufs(e);
        if l < -70.0 {
            return;
        }
        let i = (((l + 70.0) * 10.0) as usize).min(BINS - 1);
        self.cnt[i] += 1;
        self.esum[i] += e;
    }
    fn mean_from(&self, from: usize) -> Option<f64> {
        let (c, s) = (from..BINS).fold((0u64, 0.0), |(c, s), i| (c + self.cnt[i] as u64, s + self.esum[i]));
        (c > 0).then(|| s / c as f64)
    }
    fn bin_of(l: f64) -> usize {
        (((l + 70.0) * 10.0).floor().max(0.0) as usize).min(BINS - 1)
    }
    pub fn integrated(&self) -> f64 {
        match self.mean_from(0) {
            None => f64::NEG_INFINITY,
            Some(m) => self.mean_from(Self::bin_of(lufs(m) - 10.0)).map_or(f64::NEG_INFINITY, lufs),
        }
    }
    pub fn lra(&self) -> f64 {
        let Some(m) = self.mean_from(0) else { return 0.0 };
        let from = Self::bin_of(lufs(m) - 20.0);
        let total: u64 = (from..BINS).map(|i| self.cnt[i] as u64).sum();
        if total < 2 {
            return 0.0;
        }
        let pick = |p: f64| {
            let target = ((total - 1) as f64 * p + 0.5) as u64; // 0-based rank
            let mut seen = 0u64;
            for i in from..BINS {
                seen += self.cnt[i] as u64;
                if seen > target {
                    return lufs(self.esum[i] / self.cnt[i] as f64);
                }
            }
            f64::NEG_INFINITY
        };
        pick(0.95) - pick(0.10)
    }
}
