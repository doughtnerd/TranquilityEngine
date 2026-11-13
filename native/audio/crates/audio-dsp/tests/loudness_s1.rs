//! Spike S1's 189 loudness checks (`spikes/audio-mix/loudness/src/checks.rs`) against
//! `audio_dsp::loudness` (Ld1, ADR 0171 amended by 0172, architecture §4.4): the K-weighting
//! coefficients at 48 kHz against the BS.1770-4 table (7), then at 48 kHz and at 44.1 kHz (91
//! each) EBU Tech 3341/3342-style cases against their expected values, against the `ebur128`
//! crate's readings, the main-side histogram against exact gating, the STATUS ring at the 6- and
//! 48-quantum cadences, the gated true peak against the full one, and a NaN burst.
//!
//! **The `ebur128` readings are recorded**, not computed here: the crate isn't a dependency of
//! this workspace (Ld6 owns the live cross-check). [`REFS`] holds `ebur128` 0.1.11's readings
//! (`Mode::M | S | I | LRA | TRUE_PEAK | SAMPLE_PEAK`, fed 128 frames at a time, as the spike's
//! `reference()`) of the spike's own signals, printed at full precision on 2026-11-13; the checks
//! compare to them with the spike's tolerances (1e-3 LU on I, M, S; 0.01 LU on LRA; 1e-3 dB on true
//! peak). The signals here are the spike's, with `libm` for the transcendentals. At 44.1 kHz the
//! crate's M, S and I are compared after moving them by the high-pass gain libebur128 leaves
//! rate-dependent and the meter keeps at 48 kHz's (FU1, [`hp_correction_lu`]: -0.0038 LU); the
//! recorded values themselves stay the crate's.
//!
//! **The main half** (feed, exact gating, the 1,000-bin histograms) is ported from the spike as
//! test code: in the product it is TypeScript (Ld3's `loudnessStats.ts`).
//!
//! **Wasm.** [`run`] is plain code (no test harness), so a cdylib can include this file with
//! `#[path]` and run the same checks on `wasm32-unknown-unknown` with `+simd128`, where the meter's
//! true peak takes the simd128 path (`loudness::TRUE_PEAK_SIMD128`); natively it's the scalar path.

use audio_dsp::loudness::{self, KCoef, Meter, Ring, QUANTUM, RING};
use core::f64::consts::PI;

// ---------------------------------------------------------------- signals (spike `signals.rs`)

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

fn db(x: f64) -> f64 {
    libm::pow(10.0, x / 20.0)
}

/// Stereo sine (same in both channels), `amp_db` dBFS peak.
fn sine(rate: f64, freq: f64, amp_db: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let a = db(amp_db);
    let v: Vec<f32> = (0..n).map(|i| (a * libm::sin(2.0 * PI * freq * i as f64 / rate)) as f32).collect();
    (v.clone(), v)
}

/// fs/4 sine at 45 degrees: samples are ±A/√2, true peak A.
fn fs4_45(rate: f64, amp: f64, secs: f64) -> Stereo {
    let n = (rate * secs) as usize;
    let v: Vec<f32> = (0..n).map(|i| (amp * libm::sin(PI / 4.0 + i as f64 * PI / 2.0)) as f32).collect();
    (v.clone(), v)
}

fn concat(parts: Vec<Stereo>) -> Stereo {
    let mut l = Vec::new();
    let mut r = Vec::new();
    for (a, b) in parts {
        l.extend(a);
        r.extend(b);
    }
    (l, r)
}

/// Music-like: low-passed noise plus a few partials, slow level swings (period 7 s), different in
/// L and R; `peak` is the approximate sample peak (linear) at the loud part of the swing.
fn music(rate: f64, secs: f64, peak: f64, seed: u64) -> Stereo {
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

// ---------------------------------------------------------------- main half (spike `loud.rs`)

/// Turns (seq, ring) pairs from STATUS into the list of new sub-block energies.
#[derive(Default)]
struct Feed {
    last: u32,
    lost: u64,
}

impl Feed {
    fn take(&mut self, seq: u32, ring: &Ring, out: &mut Vec<f64>) {
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

fn window_means(subs: &[f64], n: usize) -> Vec<f64> {
    if subs.len() < n {
        return Vec::new();
    }
    (n - 1..subs.len()).map(|i| subs[i + 1 - n..=i].iter().sum::<f64>() / n as f64).collect()
}

/// Exact (list-based) gating.
#[derive(Default)]
struct Gating {
    subs: Vec<f64>,
}

impl Gating {
    fn last(&self, n: usize) -> f64 {
        if self.subs.len() < n {
            return f64::NEG_INFINITY;
        }
        loudness::lufs(self.subs[self.subs.len() - n..].iter().sum::<f64>() / n as f64)
    }
    fn momentary(&self) -> f64 {
        self.last(4)
    }
    fn shortterm(&self) -> f64 {
        self.last(30)
    }
    fn integrated(&self) -> f64 {
        let lufs = loudness::lufs;
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
    /// EBU Tech 3342 / libebur128: 3 s blocks, one per second, −70 / −20 LU gates, 10th–95th.
    fn lra(&self) -> f64 {
        let lufs = loudness::lufs;
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

const BINS: usize = 1000;

/// Fixed-memory gating (what main ships): 1,000 bins of 0.1 LU from −70 LUFS, per bin a count and
/// an exact energy sum.
struct Hist {
    cnt: Vec<u32>,
    esum: Vec<f64>,
}

impl Hist {
    fn new() -> Self {
        Hist { cnt: vec![0; BINS], esum: vec![0.0; BINS] }
    }
    fn add(&mut self, e: f64) {
        let l = loudness::lufs(e);
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
    fn integrated(&self) -> f64 {
        match self.mean_from(0) {
            None => f64::NEG_INFINITY,
            Some(m) => self.mean_from(Self::bin_of(loudness::lufs(m) - 10.0)).map_or(f64::NEG_INFINITY, loudness::lufs),
        }
    }
    fn lra(&self) -> f64 {
        let Some(m) = self.mean_from(0) else { return 0.0 };
        let from = Self::bin_of(loudness::lufs(m) - 20.0);
        let total: u64 = (from..BINS).map(|i| self.cnt[i] as u64).sum();
        if total < 2 {
            return 0.0;
        }
        let pick = |p: f64| {
            let target = ((total - 1) as f64 * p + 0.5) as u64;
            let mut seen = 0u64;
            for i in from..BINS {
                seen += self.cnt[i] as u64;
                if seen > target {
                    return loudness::lufs(self.esum[i] / self.cnt[i] as f64);
                }
            }
            f64::NEG_INFINITY
        };
        pick(0.95) - pick(0.10)
    }
}

// ---------------------------------------------------------------- the ebur128 crate's readings

/// `ebur128` 0.1.11's readings of a case's signal (see the module comment).
#[derive(Clone, Copy)]
pub struct Ref {
    pub rate: f64,
    pub case: &'static str,
    pub i: f64,
    pub m: f64,
    pub s: f64,
    pub lra: f64,
    pub tp_db: f64,
}

#[rustfmt::skip]
pub const REFS: &[Ref] = &[
    Ref { rate: 48000.0, case: "t1", i: -22.99329710168592, m: -22.9932955803647, s: -22.99329558036496, lra: 1.8474111129762605e-13, tp_db: -23.000000432125567 },
    Ref { rate: 48000.0, case: "t2", i: -32.993297040685945, m: -32.99329551936467, s: -32.993295519364935, lra: 5.542233338928781e-13, tp_db: -32.999999706425804 },
    Ref { rate: 48000.0, case: "t2b", i: -19.993297107925116, m: -19.993295586603885, s: -19.993295586603836, lra: 1.2896350654045818e-12, tp_db: -19.99999987057016 },
    Ref { rate: 48000.0, case: "t3", i: -23.013868674472892, m: -35.993295557849564, s: -35.99329555785025, lra: 12.999999977485139, tp_db: -23.000000432125567 },
    Ref { rate: 48000.0, case: "t4", i: -23.025996397942496, m: -22.993295580364716, s: -22.993295580364986, lra: 3.9947688097896616e-5, tp_db: -23.000000432125567 },
    Ref { rate: 48000.0, case: "t5", i: -22.030363814616003, m: -25.993295532243156, s: -25.99329553224329, lra: 5.999999945640784, tp_db: -19.99999987057016 },
    Ref { rate: 48000.0, case: "l1", i: -22.589665958549993, m: -29.993295659205867, s: -29.99329565920371, lra: 10.00000007260073, tp_db: -19.99999987057016 },
    Ref { rate: 48000.0, case: "l2", i: -16.810288260798355, m: -14.993295517439522, s: -14.993295517439392, lra: 5.000000069164619, tp_db: -15.000000078774018 },
    Ref { rate: 48000.0, case: "l3", i: -20.025668120867355, m: -19.993295586603907, s: -19.99329558660382, lra: 19.99999998961539, tp_db: -19.99999987057016 },
    Ref { rate: 48000.0, case: "tp0.5", i: -2.668937779524415, m: -2.6689361129277422, s: -4.429854369920171, lra: 0.0, tp_db: -5.917074888824398 },
    Ref { rate: 48000.0, case: "tp1", i: 3.351662133755209, m: 3.351663800351881, s: 1.590745543359453, lra: 0.0, tp_db: 0.10352502445522632 },
    Ref { rate: 48000.0, case: "tp1.4125", i: 6.351431658824279, m: 6.351433325420965, s: 4.590515068425621, lra: 0.0, tp_db: 3.1032948424350226 },
    Ref { rate: 48000.0, case: "music", i: -17.182976753030943, m: -25.091570969665653, s: -16.017567728600422, lra: 12.482732257026942, tp_db: -4.60687922567823 },
    Ref { rate: 44100.0, case: "t1", i: -22.9905397873912, m: -22.990538266405306, s: -22.990538266381865, lra: 2.680451416381402e-10, tp_db: -22.995011669787004 },
    Ref { rate: 44100.0, case: "t2", i: -32.99053981481062, m: -32.9905382946983, s: -32.9905382945646, lra: 1.3418599564829492e-9, tp_db: -32.99501177474363 },
    Ref { rate: 44100.0, case: "t2b", i: -19.99053978403787, m: -19.990538262909567, s: -19.990538262909485, lra: 1.1404210908949608e-12, tp_db: -19.995011782791327 },
    Ref { rate: 44100.0, case: "t3", i: -23.01111135414449, m: -35.990538245724224, s: -35.99053824572434, lra: 12.999999979518218, tp_db: -22.995011669787004 },
    Ref { rate: 44100.0, case: "t4", i: -23.023239083140872, m: -22.99053826640534, s: -22.99053826638188, lra: 3.99430577857629e-5, tp_db: -22.995011669787004 },
    Ref { rate: 44100.0, case: "t5", i: -22.027606466626814, m: -25.990538270175247, s: -25.990538270175396, lra: 6.000000007266067, tp_db: -19.995011782791327 },
    Ref { rate: 44100.0, case: "l1", i: -22.586908599538123, m: -29.990538259337473, s: -29.990538259337843, lra: 9.999999996429594, tp_db: -19.995011782791327 },
    Ref { rate: 44100.0, case: "l2", i: -16.807530978672474, m: -14.99053823762302, s: -14.990538237622493, lra: 5.0000000252885, tp_db: -14.995011457768516 },
    Ref { rate: 44100.0, case: "l3", i: -20.022910800592957, m: -19.99053826290959, s: -19.990538262909453, lra: 19.999999976975936, tp_db: -19.995011782791327 },
    Ref { rate: 44100.0, case: "tp0.5", i: -2.6652874432762057, m: -2.6652854607546677, s: -4.426204791895942, lra: 0.0, tp_db: -5.917074888824398 },
    Ref { rate: 44100.0, case: "tp1", i: 3.355312470003418, m: 3.355314452524956, s: 1.5943951213836818, lra: 0.0, tp_db: 0.10352502445522632 },
    Ref { rate: 44100.0, case: "tp1.4125", i: 6.355081995071857, m: 6.355083977593385, s: 4.594164646467415, lra: 0.0, tp_db: 3.1032948424350226 },
    Ref { rate: 44100.0, case: "music", i: -17.249586932875683, m: -25.098591943370266, s: -16.093410992914976, lra: 12.520656061605578, tp_db: -4.632293861907513 },
];

/// The crate's reading of a case, with M, S and I moved to the 48 kHz-equivalent K-weighting
/// high-pass ([`hp_correction_lu`]; nothing moves at 48 kHz).
fn reference(rate: f64, case: &str) -> Ref {
    let r = REFS.iter().find(|r| r.rate == rate && r.case == case).expect("a recorded reading for every case");
    let d = hp_correction_lu(rate);
    Ref { i: r.i + d, m: r.m + d, s: r.s + d, ..*r }
}

/// FU1: libebur128 (and so the crate, whose readings [`REFS`] are) keeps the high-pass's numerator
/// at [1, -2, 1] at every rate, so its passband gain drifts with the rate (`a0 = 1 + K/Q + K²`);
/// the meter keeps 48 kHz's gain (BS.1770-5 Annex 1). The flat gain that moves the crate's M, S
/// and I at `rate` to the 48 kHz-equivalent response, in LU: `20 log10(a0(48 kHz) / a0(rate))`,
/// exactly 0 at 48 kHz and -0.0038 at 44.1 kHz (as `loudness_crate.rs`'s, from libebur128's
/// constants, not from the meter).
fn hp_correction_lu(rate: f64) -> f64 {
    let a0 = |fs: f64| {
        let k = libm::tan(PI * 38.13547087602444 / fs);
        1.0 + k / 0.5003270373238773 + k * k
    };
    20.0 * libm::log10(a0(48_000.0) / a0(rate))
}

// ---------------------------------------------------------------- the checks (spike `checks.rs`)

/// One case's readings from the meter under test.
pub struct Meas {
    pub m: f64,
    pub s: f64,
    pub i: f64,
    pub lra: f64,
    pub hist_i: f64,
    pub hist_lra: f64,
    pub tp_db: f64,
    pub lost: u64,
}

fn dbf(x: f64) -> f64 {
    if x > 0.0 {
        20.0 * libm::log10(x)
    } else {
        f64::NEG_INFINITY
    }
}

/// How the true-peak stage runs in a case: every quantum, gated at a linear sample peak, or never.
#[derive(Clone, Copy)]
pub enum Tp {
    Full,
    Gated(f32),
    Off,
}

/// The meter fed quantum by quantum, a STATUS take every `every` quanta (and at the end).
pub fn own(rate: f64, sig: &Stereo, tp: Tp, every: usize) -> Meas {
    let mut b = Meter::new(rate);
    b.set_true_peak_gate(match tp {
        Tp::Full => 0.0,
        Tp::Gated(g) => g,
        Tp::Off => f32::INFINITY,
    });
    let mut ring: Ring = [0.0; RING];
    let mut feed = Feed::default();
    let mut g = Gating::default();
    let mut peak = 0.0f32;
    let n = sig.0.len();
    let (mut q, mut o) = (0, 0);
    while o < n {
        let e = (o + QUANTUM).min(n);
        b.process(&sig.0[o..e], &sig.1[o..e], &mut ring);
        q += 1;
        o = e;
        if q % every == 0 || o == n {
            feed.take(b.seq(), &ring, &mut g.subs);
            let p = b.take_peak();
            peak = peak.max(p[0]).max(p[1]);
        }
    }
    let (mut hi, mut hl) = (Hist::new(), Hist::new());
    for i in 3..g.subs.len() {
        hi.add(g.subs[i - 3..=i].iter().sum::<f64>() / 4.0);
    }
    for i in (29..g.subs.len()).step_by(10) {
        hl.add(g.subs[i - 29..=i].iter().sum::<f64>() / 30.0);
    }
    Meas { m: g.momentary(), s: g.shortterm(), i: g.integrated(), lra: g.lra(), hist_i: hi.integrated(), hist_lra: hl.lra(), tp_db: dbf(peak as f64), lost: feed.lost }
}

/// The checks' tally: how many ran, and a line per failure.
#[derive(Default)]
pub struct Tally {
    pub total: usize,
    pub failed: Vec<String>,
}

impl Tally {
    /// The meter's reading `own` (and the crate's `refv`) against an expected value.
    fn row(&mut self, name: &str, what: &str, expect: f64, tol: f64, own: f64, refv: Option<f64>) {
        self.total += 1;
        let ok_own = (own - expect).abs() <= tol;
        let ok_ref = refv.map_or(true, |r| (r - expect).abs() <= tol);
        if !(ok_own && ok_ref) {
            self.failed.push(format!("{name}: {what}: expect {expect} ± {tol}, own {own}, ebur128 {refv:?}"));
        }
    }
    /// Two readings that must agree.
    fn pair(&mut self, name: &str, what: &str, tol: f64, a: f64, b: f64) {
        self.total += 1;
        let ok = (a - b).abs() <= tol || (a.is_infinite() && a == b);
        if !ok {
            self.failed.push(format!("{name}: {what}: {a} vs {b} (tol {tol})"));
        }
    }
}

/// The 7 K-weighting coefficient checks at 48 kHz against the BS.1770-4 table.
pub fn k_coefficients(t: &mut Tally) {
    let k: KCoef = Meter::new(48000.0).coefficients();
    let want = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585, -1.99004745483398, 0.99007225036621];
    let got = [k.b[0][0], k.b[0][1], k.b[0][2], k.a[0][0], k.a[0][1], k.a[1][0], k.a[1][1]];
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        t.row("k-coef-48k", ["b0", "b1", "b2", "a1", "a2", "hp a1", "hp a2"][i], w, 1e-8, *g, None);
    }
}

/// The 91 checks at one rate.
pub fn at_rate(t: &mut Tally, rate: f64) {
    let tag = |s: &str| format!("{s}@{}", rate as u32);
    let case = |t: &mut Tally, key: &str, name: &str, sig: Stereo, i: Option<f64>, m: Option<f64>, s: Option<f64>, lra: Option<(f64, f64)>| {
        let a = own(rate, &sig, Tp::Full, 6);
        let r = reference(rate, key);
        let n = tag(name);
        if let Some(e) = i {
            t.row(&n, "I", e, 0.1, a.i, Some(r.i));
            t.pair(&n, "I hist vs exact (own)", 0.11, a.hist_i, a.i);
        }
        if let Some(e) = m {
            t.row(&n, "M", e, 0.1, a.m, Some(r.m));
        }
        if let Some(e) = s {
            t.row(&n, "S", e, 0.1, a.s, Some(r.s));
        }
        if let Some((e, tol)) = lra {
            t.row(&n, "LRA", e, tol, a.lra, Some(r.lra));
            t.pair(&n, "LRA hist vs exact (own)", 0.11, a.hist_lra, a.lra);
        }
        t.pair(&n, "own vs ebur I", 1e-3, a.i, r.i);
        t.pair(&n, "own vs ebur M", 1e-3, a.m, r.m);
        t.pair(&n, "own vs ebur S", 1e-3, a.s, r.s);
        t.pair(&n, "own vs ebur LRA", 0.01, a.lra, r.lra);
        t.pair(&n, "own vs ebur TP dB", 1e-3, a.tp_db, r.tp_db);
        t.pair(&n, "ring lost", 0.0, a.lost as f64, 0.0);
    };
    // Tech 3341 style
    case(t, "t1", "t1 1k stereo -23 20s", sine(rate, 1000.0, -23.0, 20.0), Some(-23.0), Some(-23.0), Some(-23.0), None);
    case(t, "t2", "t2 1k stereo -33 20s", sine(rate, 1000.0, -33.0, 20.0), Some(-33.0), Some(-33.0), Some(-33.0), None);
    case(t, "t2b", "t2b 1k stereo -20 20s", sine(rate, 1000.0, -20.0, 20.0), Some(-20.0), Some(-20.0), Some(-20.0), None);
    case(t, "t3", "t3 -36 10s,-23 60s,-36 10s (relative gate)", concat(vec![sine(rate, 1000.0, -36.0, 10.0), sine(rate, 1000.0, -23.0, 60.0), sine(rate, 1000.0, -36.0, 10.0)]), Some(-23.0), None, None, None);
    case(t, "t4", "t4 -80 20s,-23 20s (absolute gate)", concat(vec![sine(rate, 1000.0, -80.0, 20.0), sine(rate, 1000.0, -23.0, 20.0)]), Some(-23.0), None, None, None);
    // analytic: both halves pass both gates, I = 10 log10((10^-2.0 + 10^-2.6) / 2)
    let t5 = 10.0 * libm::log10((libm::pow(10.0, -2.0) + libm::pow(10.0, -2.6)) / 2.0);
    case(t, "t5", "t5 -20 10s,-26 10s (no gating effect)", concat(vec![sine(rate, 1000.0, -20.0, 10.0), sine(rate, 1000.0, -26.0, 10.0)]), Some(t5), None, None, None);
    // Tech 3342 style (tolerance 1 LU)
    case(t, "l1", "l1 -20 20s,-30 20s", concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -30.0, 20.0)]), None, None, None, Some((10.0, 1.0)));
    case(t, "l2", "l2 -20 20s,-15 20s", concat(vec![sine(rate, 1000.0, -20.0, 20.0), sine(rate, 1000.0, -15.0, 20.0)]), None, None, None, Some((5.0, 1.0)));
    case(t, "l3", "l3 -40 20s,-20 20s", concat(vec![sine(rate, 1000.0, -40.0, 20.0), sine(rate, 1000.0, -20.0, 20.0)]), None, None, None, Some((20.0, 1.0)));
    // true peak: fs/4 at 45 degrees (the sample peak is 3.01 dB below the true peak)
    for (key, amp, want) in [("tp0.5", 0.5, -6.0206), ("tp1", 1.0, 0.0), ("tp1.4125", 1.4125, 3.0)] {
        let a = own(rate, &fs4_45(rate, amp, 2.0), Tp::Full, 6);
        let r = reference(rate, key).tp_db;
        t.row(&tag(&format!("tp fs/4 45deg A={amp} (sample peak {:.2} dBFS)", dbf(amp / libm::sqrt(2.0)))), "TP dBTP", want, 0.3, a.tp_db, Some(r));
    }
    // music-like content with level swings (exercises gating, 60 s)
    let sig = music(rate, 60.0, 0.7, 5);
    let a = own(rate, &sig, Tp::Full, 6);
    let g = own(rate, &sig, Tp::Gated(0.5), 6);
    let n = tag("music 60s");
    t.pair(&n, "gated TP (>= -6 dBFS) vs full TP dB", 1e-6, g.tp_db, a.tp_db);
    t.pair(&n, "idle STATUS cadence (48 quanta) I vs 6", 0.0, own(rate, &sig, Tp::Off, 48).i, a.i);
    t.pair(&n, "I hist vs exact", 0.11, a.hist_i, a.i);
    t.pair(&n, "LRA hist vs exact", 0.11, a.hist_lra, a.lra);
    let r = reference(rate, "music");
    t.pair(&n, "I own vs ebur", 1e-3, a.i, r.i);
    t.pair(&n, "M own vs ebur", 1e-3, a.m, r.m);
    t.pair(&n, "S own vs ebur", 1e-3, a.s, r.s);
    t.pair(&n, "LRA own vs ebur", 0.01, a.lra, r.lra);
    t.pair(&n, "TP dB own vs ebur", 1e-3, a.tp_db, r.tp_db);
    // the tail after a loud tone: silence must not produce denormals or NaN, and a NaN burst must
    // not poison the meter
    let mut b = Meter::new(rate);
    let mut ring: Ring = [0.0; RING];
    let z = vec![0.0f32; QUANTUM];
    let tone = sine(rate, 1000.0, -3.0, 0.1);
    for c in tone.0.chunks(QUANTUM).filter(|c| c.len() == QUANTUM) {
        b.process(c, c, &mut ring);
    }
    for _ in 0..4000 {
        b.process(&z, &z, &mut ring);
    }
    let mut nanq = z.clone();
    nanq[5] = f32::NAN;
    b.process(&nanq, &nanq, &mut ring);
    for c in tone.0.chunks(QUANTUM).filter(|c| c.len() == QUANTUM) {
        b.process(c, c, &mut ring);
    }
    t.pair(&n, "NaN burst: energy still finite", 0.0, ring.iter().all(|x| x.is_finite()) as u8 as f64, 1.0);
}

/// Every check: the coefficients, then 48 kHz and 44.1 kHz (7 + 2 × 91 = 189).
pub fn run() -> Tally {
    let mut t = Tally::default();
    k_coefficients(&mut t);
    at_rate(&mut t, 48000.0);
    at_rate(&mut t, 44100.0);
    t
}

/// Checks per rate, and in all.
pub const PER_RATE: usize = 91;
pub const COEFFICIENT_CHECKS: usize = 7;
pub const ALL: usize = COEFFICIENT_CHECKS + 2 * PER_RATE;

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_all_pass(t: &Tally, want: usize) {
        assert_eq!(t.total, want, "check count");
        assert!(t.failed.is_empty(), "{} of {} failed:\n{}", t.failed.len(), t.total, t.failed.join("\n"));
    }

    #[test]
    fn s1_k_weighting_coefficients_at_48k() {
        let mut t = Tally::default();
        k_coefficients(&mut t);
        assert_all_pass(&t, COEFFICIENT_CHECKS);
    }

    #[test]
    fn s1_checks_at_48k() {
        let mut t = Tally::default();
        at_rate(&mut t, 48000.0);
        assert_all_pass(&t, PER_RATE);
    }

    #[test]
    fn s1_checks_at_44k1() {
        let mut t = Tally::default();
        at_rate(&mut t, 44100.0);
        assert_all_pass(&t, PER_RATE);
    }

    #[test]
    fn s1_is_189_checks() {
        assert_eq!(ALL, 189);
    }

    /// Natively the meter's true peak is the scalar FIR (the wasm run checks the simd128 one
    /// against the same expectations).
    #[test]
    fn native_true_peak_path_is_scalar() {
        assert!(!loudness::TRUE_PEAK_SIMD128 || cfg!(target_arch = "wasm32"));
    }
}
