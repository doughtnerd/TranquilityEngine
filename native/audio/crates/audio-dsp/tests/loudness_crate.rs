//! Ld6 (ADR 0171 amended by 0172, test plan; architecture §4.4): the loudness path against the
//! `ebur128` crate 0.1.11 (the Rust port of libebur128), live, as a dev-only dependency.
//!
//! **What is compared.** Ld1's kernels (`audio_dsp::loudness::Meter`: K-weighting, sub-blocks,
//! 4× true peak), fed one 128-frame quantum at a time with a STATUS take every 6 quanta as the core
//! runs them, then the main half's exact gating (`loudness_common::stats`, spike S1's `Gating`),
//! against the crate fed the same audio. Momentary, short-term, integrated and LRA are compared at
//! **every sub-block boundary** (the crate is queried there), not only at the end; the true peak
//! per channel at the end. Signals: spike S1's (48 and 44.1 kHz) and random programme material at
//! 32, 44.1, 48 and 88.2 kHz (below 96 kHz the crate oversamples 4×, as the meter does). The bar
//! is 1e-3 LU (1e-3 dB for the true peak).
//!
//! **The TypeScript gating.** Main's gating ships in TypeScript (`loudnessStats.ts`, Ld3) with
//! 1,000-bin histograms. [`ts_gating_vectors`] writes the meter's sub-block energies and the
//! crate's readings to `tests/vectors/loudness_crate.json` (or checks the committed file still
//! matches); `src/plugins/audio/runtime/mix/loudnessCrate.test.ts` feeds the energies to
//! `LoudnessStats` and compares with the crate. Rewrite the file with
//! `LOUDNESS_CRATE_VECTORS=write cargo test -p audio-dsp --test loudness_crate`.
//!
//! **Ld1's recorded readings.** `loudness_s1.rs` keeps the crate's readings as constants
//! (`REFS`), because that file is also built into a scratch wasm cdylib through `#[path]` (Ld1's
//! simd128 run), where the crate isn't wanted. [`recorded_s1_readings_are_the_crates`] checks every
//! constant against the live crate instead of replacing them.
//!
//! Run with `-- --nocapture` to print the worst difference per measure.

mod loudness_common;

use audio_dsp::loudness::{self, QUANTUM};
use ebur128::{EbuR128, Mode};
use loudness_common::{dbf, diff, feed, programme, s1_signal, stats, stats_series, Fed, Stats, Stereo, S1_KEYS};
use std::sync::OnceLock;

/// The cross-check's bar (LU; dB for the true peak).
const TOL: f64 = 1e-3;
/// The STATUS cadence the meter is read at (quanta), as the active core.
const EVERY: usize = 6;

/// The crate's readings at every sub-block boundary, and its true peak per channel at the end.
struct CrateRun {
    at: Vec<Stats>,
    tp: [f64; 2],
}

fn crate_run(rate: f64, sig: &Stereo) -> CrateRun {
    let mode = Mode::M | Mode::S | Mode::I | Mode::LRA | Mode::TRUE_PEAK | Mode::SAMPLE_PEAK;
    let mut c = EbuR128::new(2, rate as u32, mode).unwrap();
    let sub = loudness::subblock_frames(rate) as usize;
    let n = sig.0.len().min(sig.1.len());
    let mut at = Vec::with_capacity(n / sub);
    let mut o = 0;
    while o < n {
        // a quantum, cut at the next sub-block edge
        let edge = (o / sub + 1) * sub;
        let e = (o + QUANTUM).min(n).min(edge);
        c.add_frames_planar_f32(&[&sig.0[o..e], &sig.1[o..e]]).unwrap();
        o = e;
        if o % sub == 0 {
            at.push(Stats { m: c.loudness_momentary().unwrap(), s: c.loudness_shortterm().unwrap(), i: c.loudness_global().unwrap(), lra: c.loudness_range().unwrap() });
        }
    }
    CrateRun { at, tp: [c.true_peak(0).unwrap(), c.true_peak(1).unwrap()] }
}

/// One signal through the meter and through the crate.
struct Run {
    name: String,
    rate: f64,
    fed: Fed,
    cr: CrateRun,
}

/// Runs each `(name, rate, signal maker)` once, a thread per case (debug builds are slow and the
/// tests share the results).
fn runs(cases: Vec<(String, f64, Box<dyn Fn() -> Stereo + Send>)>) -> Vec<Run> {
    std::thread::scope(|sc| {
        let hs: Vec<_> = cases
            .into_iter()
            .map(|(name, rate, make)| {
                sc.spawn(move || {
                    let sig = make();
                    Run { name, rate, fed: feed(rate, &sig.0, &sig.1, EVERY), cr: crate_run(rate, &sig) }
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    })
}

/// Spike S1's 13 cases at 48 and 44.1 kHz (computed once for every test that needs them).
fn s1_runs() -> &'static [Run] {
    static R: OnceLock<Vec<Run>> = OnceLock::new();
    R.get_or_init(|| {
        let mut cases: Vec<(String, f64, Box<dyn Fn() -> Stereo + Send>)> = Vec::new();
        for rate in [48_000.0, 44_100.0] {
            for key in S1_KEYS {
                cases.push((key.to_string(), rate, Box::new(move || s1_signal(rate, key))));
            }
        }
        runs(cases)
    })
}

/// Random programme seeds per rate (3 each, 10 to 40 s apiece).
const PROGRAMMES: &[(f64, u64)] = &[(32_000.0, 1), (32_000.0, 2), (32_000.0, 3), (44_100.0, 4), (44_100.0, 5), (44_100.0, 6), (48_000.0, 7), (48_000.0, 8), (48_000.0, 9), (88_200.0, 10), (88_200.0, 11), (88_200.0, 12)];

fn programme_runs() -> &'static [Run] {
    static R: OnceLock<Vec<Run>> = OnceLock::new();
    R.get_or_init(|| runs(PROGRAMMES.iter().map(|&(rate, seed)| (format!("programme {seed}"), rate, Box::new(move || programme(rate, seed)) as Box<dyn Fn() -> Stereo + Send>)).collect()))
}

/// Readings below this are digital silence on both sides: the meter flushes filter states under
/// 1e-200 and its ring is f32 (nothing under ~1.4e-45, −449 LUFS), so where the crate's f64 filters
/// decay to, say, −619 LUFS the meter reads `-inf`. 230 LU under the absolute gate, it can't change
/// a gated reading.
const SILENCE_LUFS: f64 = -300.0;

fn floor(x: f64) -> f64 {
    if x < SILENCE_LUFS { f64::NEG_INFINITY } else { x }
}

/// The worst difference per measure over a set of comparisons, with where it happened.
#[derive(Default)]
struct Worst {
    m: (f64, String),
    s: (f64, String),
    i: (f64, String),
    lra: (f64, String),
    tp: (f64, String),
    points: usize,
}

impl Worst {
    fn note(slot: &mut (f64, String), own: f64, refv: f64, at: impl FnOnce() -> String) {
        let d = diff(floor(own), floor(refv));
        if d > slot.0 || slot.1.is_empty() || (d.is_nan() && !slot.0.is_nan()) {
            *slot = (d, format!("{} (own {own}, ebur128 {refv})", at()));
        }
    }

    /// Compares the meter + exact gating with the crate on one signal.
    fn case(&mut self, run: &Run) {
        let Run { name, rate, fed, cr } = run;
        let rate = *rate;
        assert_eq!(fed.lost, 0, "{name}: no sub-block lost at the {EVERY}-quantum cadence");
        assert_eq!(fed.subs.len(), cr.at.len(), "{name}: sub-block count");
        let subs: Vec<f64> = fed.subs.iter().map(|&e| e as f64).collect();
        for (k, (own, c)) in stats_series(&subs).iter().zip(&cr.at).enumerate() {
            let n = k + 1;
            let at = || format!("{name}@{} sub-block {n}", rate as u32);
            if n >= 4 {
                Self::note(&mut self.m, own.m, c.m, at);
            }
            if n >= 30 {
                Self::note(&mut self.s, own.s, c.s, at);
            }
            Self::note(&mut self.i, own.i, c.i, at);
            Self::note(&mut self.lra, own.lra, c.lra, at);
            self.points += 1;
        }
        // the series against the one-shot form at the end
        let (end, one) = (stats_series(&subs).pop().unwrap(), stats(&subs));
        assert!(diff(end.i, one.i) < 1e-9 && diff(end.lra, one.lra) < 1e-9 && diff(end.m, one.m) < 1e-9 && diff(end.s, one.s) < 1e-9, "{name}: series {end:?} vs {one:?}");
        for ch in 0..2 {
            Self::note(&mut self.tp, dbf(fed.peak[ch] as f64), dbf(cr.tp[ch]), || format!("{name}@{} channel {ch}", rate as u32));
        }
    }

    fn report_and_check(&self, what: &str) {
        eprintln!("{what}: {} comparison points", self.points);
        for (label, (d, at)) in [("M", &self.m), ("S", &self.s), ("I", &self.i), ("LRA", &self.lra), ("TP dB", &self.tp)] {
            eprintln!("  worst {label:<5} {d:.3e} at {at}");
        }
        for (label, (d, at)) in [("M", &self.m), ("S", &self.s), ("I", &self.i), ("LRA", &self.lra), ("TP dB", &self.tp)] {
            assert!(*d <= TOL, "{what}: {label} differs from ebur128 by {d} (> {TOL}) at {at}");
        }
    }
}

#[test]
fn kernels_and_gating_match_the_crate_on_s1_signals() {
    let mut w = Worst::default();
    for r in s1_runs() {
        w.case(r);
    }
    w.report_and_check("S1 signals");
}

#[test]
fn kernels_and_gating_match_the_crate_on_random_programmes() {
    let mut w = Worst::default();
    for r in programme_runs() {
        w.case(r);
    }
    w.report_and_check("random programmes");
}

/// The comparison itself can fail: the last sub-block's energy 1 % high (+0.043 LU on it, about
/// +0.011 LU on the momentary reading) is caught.
#[test]
fn the_comparison_catches_a_small_error() {
    let rate = 48_000.0;
    let sig = loudness_common::sine(rate, 1000.0, -23.0, 5.0);
    let fed = feed(rate, &sig.0, &sig.1, EVERY);
    let cr = crate_run(rate, &sig);
    let mut subs: Vec<f64> = fed.subs.iter().map(|&e| e as f64).collect();
    let last = subs.len() - 1;
    let c = cr.at.last().unwrap();
    assert!(diff(stats(&subs).m, c.m) <= TOL, "unchanged, the reading agrees");
    subs[last] *= 1.01;
    let d = diff(stats(&subs).m, c.m);
    assert!(d > TOL && d < 0.02, "a {d} LU momentary error must exceed the bar");
}

// ---------------------------------------------------------------- Ld1's recorded readings

/// One `Ref { … }` row of `loudness_s1.rs`'s `REFS`: (rate, case, [i, m, s, lra, tp_db]).
fn recorded() -> Vec<(f64, String, [f64; 5])> {
    let src = include_str!("loudness_s1.rs");
    let mut out = Vec::new();
    for line in src.lines().map(str::trim).filter(|l| l.starts_with("Ref { rate:")) {
        let field = |name: &str| -> &str {
            let at = line.find(&format!(" {name}: ")).unwrap_or_else(|| panic!("{name} in {line}")) + name.len() + 3;
            let rest = &line[at..];
            rest[..rest.find([',', ' ']).unwrap()].trim_matches('"')
        };
        let num = |name: &str| field(name).parse::<f64>().unwrap();
        out.push((num("rate"), field("case").to_string(), [num("i"), num("m"), num("s"), num("lra"), num("tp_db")]));
    }
    out
}

/// Ld1's `REFS` (the crate's readings, recorded from the spike's signals) against the live crate
/// on `loudness_common`'s signals (the same signals with `libm` for the transcendentals: a few
/// samples may round differently, hence 1e-6 rather than 0).
#[test]
fn recorded_s1_readings_are_the_crates() {
    let rows = recorded();
    assert_eq!(rows.len(), 26, "13 cases at 2 rates");
    let mut worst = 0.0f64;
    for Run { name: key, rate, cr, .. } in s1_runs() {
        let (_, _, rec) = rows.iter().find(|(r, k, _)| r == rate && k == key).unwrap_or_else(|| panic!("{key}@{rate} recorded"));
        let end = cr.at.last().unwrap();
        let live = [end.i, end.m, end.s, end.lra, dbf(cr.tp[0].max(cr.tp[1]))];
        for (j, (a, b)) in live.iter().zip(rec).enumerate() {
            let d = diff(*a, *b);
            worst = worst.max(d);
            assert!(d <= 1e-6, "{key}@{rate}: {} live {a} recorded {b}", ["I", "M", "S", "LRA", "TP dB"][j]);
        }
    }
    eprintln!("recorded REFS vs live ebur128: worst {worst:.3e}");
}

// ---------------------------------------------------------------- vectors for the TypeScript gating

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let v = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..4 {
            if k <= c.len() {
                s.push(B64[(v >> (18 - 6 * k) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

fn unb64(s: &str) -> Vec<u8> {
    let val = |c: u8| B64.iter().position(|&b| b == c).map(|p| p as u32);
    let mut out = Vec::new();
    for c in s.as_bytes().chunks(4) {
        let mut v = 0u32;
        let mut n = 0usize;
        for (k, &ch) in c.iter().enumerate() {
            if let Some(x) = val(ch) {
                v |= x << (18 - 6 * k);
                n += 1;
            }
        }
        for k in 0..n.saturating_sub(1) {
            out.push((v >> (16 - 8 * k)) as u8);
        }
    }
    out
}

fn f32s_b64(x: impl IntoIterator<Item = f32>) -> String {
    b64(&x.into_iter().flat_map(f32::to_le_bytes).collect::<Vec<u8>>())
}

fn f32s_unb64(s: &str) -> Vec<f32> {
    unb64(s).chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
}

fn num(x: f64) -> String {
    if x.is_finite() { format!("{x:?}") } else { "null".into() }
}

/// One case's line: the energies (f32, little-endian, base64), the crate's M, S, I, LRA after every
/// 10th sub-block (f32, base64, 4 per point) and after the last (f64).
fn vector_line(name: &str, Run { rate, fed, cr, .. }: &Run) -> String {
    let every10 = cr.at.iter().skip(9).step_by(10).flat_map(|s| [s.m as f32, s.s as f32, s.i as f32, s.lra as f32]);
    let end = cr.at.last().unwrap();
    format!(
        "{{\"name\":\"{name}\",\"rate\":{},\"subs\":\"{}\",\"every10\":\"{}\",\"end\":[{},{},{},{}]}}",
        *rate as u32,
        f32s_b64(fed.subs.iter().copied()),
        f32s_b64(every10),
        num(end.m),
        num(end.s),
        num(end.i),
        num(end.lra)
    )
}

fn field<'a>(line: &'a str, name: &str) -> &'a str {
    let at = line.find(&format!("\"{name}\":")).unwrap_or_else(|| panic!("{name}")) + name.len() + 3;
    let rest = &line[at..];
    let end = if rest.starts_with('"') { rest[1..].find('"').unwrap() + 2 } else if rest.starts_with('[') { rest.find(']').unwrap() + 1 } else { rest.find([',', '}']).unwrap() };
    rest[..end].trim_matches('"')
}

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/loudness_crate.json");

#[test]
fn ts_gating_vectors() {
    let mut lines = Vec::new();
    for r in s1_runs().iter().filter(|r| r.rate == 48_000.0) {
        lines.push(vector_line(&format!("s1 {}", r.name), r));
    }
    for r in programme_runs() {
        lines.push(vector_line(&r.name, r));
    }
    let text = format!(
        "{{\"about\":\"Ld6: audio_dsp::loudness::Meter sub-block energies (f32 LE, base64) and the ebur128 0.1.11 crate's M, S, I, LRA (every 10th sub-block as f32 LE base64, and at the end); written by native/audio/crates/audio-dsp/tests/loudness_crate.rs, read by src/plugins/audio/runtime/mix/loudnessCrate.test.ts\",\"cases\":[\n{}\n]}}\n",
        lines.join(",\n")
    );
    let write = std::env::var("LOUDNESS_CRATE_VECTORS").as_deref() == Ok("write");
    let committed = std::fs::read_to_string(VECTORS).ok();
    if write || committed.is_none() {
        std::fs::create_dir_all(std::path::Path::new(VECTORS).parent().unwrap()).unwrap();
        std::fs::write(VECTORS, &text).unwrap();
        eprintln!("wrote {VECTORS}");
        return;
    }
    // The energies are this crate's own arithmetic (libm, no platform maths): bit-exact. The crate's
    // readings go through the platform's log10: compared to 1e-9 (1e-5 for the f32 points).
    let committed = committed.unwrap();
    let old: Vec<&str> = committed.lines().filter(|l| l.starts_with("{\"name\"")).collect();
    assert_eq!(old.len(), lines.len(), "case count: rewrite with LOUDNESS_CRATE_VECTORS=write");
    for (a, b) in lines.iter().zip(old) {
        let name = field(a, "name");
        assert_eq!(name, field(b, "name"));
        assert_eq!(field(a, "rate"), field(b, "rate"), "{name}");
        assert_eq!(field(a, "subs"), field(b, "subs"), "{name}: the meter's energies changed; rewrite with LOUDNESS_CRATE_VECTORS=write if that is intended");
        let (pa, pb) = (f32s_unb64(field(a, "every10")), f32s_unb64(field(b, "every10")));
        assert_eq!(pa.len(), pb.len(), "{name}");
        for (x, y) in pa.iter().zip(&pb) {
            assert!(diff(*x as f64, *y as f64) <= 1e-5, "{name}: crate reading {x} vs committed {y}");
        }
        let nums = |l: &str| -> Vec<f64> { field(l, "end").trim_matches(['[', ']']).split(',').map(|v| v.parse().unwrap_or(f64::NEG_INFINITY)).collect() };
        for (x, y) in nums(a).iter().zip(nums(b)) {
            assert!(diff(*x, y) <= 1e-9, "{name}: crate end reading {x} vs committed {y}");
        }
    }
}

#[test]
fn base64_round_trips() {
    for n in 0..10 {
        let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
        assert_eq!(unb64(&b64(&bytes)), bytes);
    }
    assert_eq!(b64(b"Man"), "TWFu");
    assert_eq!(b64(b"Ma"), "TWE=");
    assert_eq!(f32s_unb64(&f32s_b64([1.5f32, -0.25, f32::NEG_INFINITY])), [1.5, -0.25, f32::NEG_INFINITY]);
}
