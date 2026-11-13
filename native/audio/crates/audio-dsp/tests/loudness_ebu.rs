//! The synthesised EBU Tech 3341 / 3342 loudness test set (ADR 0171 amended by 0172, Ld6) against
//! `audio_dsp::loudness` (Ld1's kernels), from spike S1's signal generator
//! (`spikes/audio-mix/loudness/src/signals.rs`, `checks.rs`).
//!
//! **Cases** (each at 48 kHz and at 44.1 kHz, stereo, the same signal in both channels):
//! - Tech 3341 (M, S, I): `t1` (1 kHz, -23 dBFS, 20 s: M = S = I = -23 LUFS), `t2` (-33), `t2b`
//!   (-20), `t3` (10 s at -36, 60 s at -23, 10 s at -36: the relative gate, I = -23), `t4` (20 s at
//!   -80, 20 s at -23: the absolute gate, I = -23) and `t5` (10 s at -20, 10 s at -26: both halves
//!   pass both gates, I = 10 log10((10^-2.0 + 10^-2.6) / 2), analytic). The tests are "3341-style":
//!   S1's signals, not the Tech's numbered files (those are 5.1 or longer).
//! - Tech 3342 (LRA): `l1` (-20 / -30, 10 LU), `l2` (-20 / -15, 5 LU), `l3` (-40 / -20, 20 LU) as S1
//!   has them, and `l4` (20 s each at -50, -35, -20, -35, -50: 15 LU; the -50 steps fall under the
//!   relative gate), which S1 doesn't have but the same generator makes.
//! - Tech 3341 true peak: fs/4 sines at 45 degrees (sample peak 3.01 dB under the true peak), true
//!   peak A = 0.5, 1.0 and 1.4125 (-6.02, 0 and +3 dBTP).
//!
//! **Tolerances.** M, S, I and LRA at ±0.1 LU (the Tech allows ±1 LU on LRA; the kernels are far
//! inside it). True peak at the Tech 3341 window -0.4 / +0.2 dB (the fs/4 case reads +0.10 dB high,
//! the 4x polyphase FIR's own error).
//!
//! **Fixtures.** One JSON per case and rate under `src/plugins/audio/runtime/golden/loudness/`
//! (name, Tech, rate, the signal as segments so another implementation can synthesise it, the
//! expected values, the measured ones), for the TypeScript side's `loudnessStats.ts` to check
//! against the same cases. `UPDATE_GOLDENS=1 cargo test -p audio-dsp --test loudness_ebu` writes the
//! missing ones and never overwrites an existing fixture; without it the tests compare to the files
//! (expected values exactly, measured within 1e-4) and fail on a missing one.
//!
//! The main half (feed, exact gating, LRA) is the same test code as `loudness_s1.rs`.

use audio_dsp::loudness::{self, Meter, Ring, QUANTUM, RING};
use core::f64::consts::PI;
use std::sync::OnceLock;

// ---------------------------------------------------------------- signals (spike `signals.rs`)

type Stereo = (Vec<f32>, Vec<f32>);

/// One stretch of a case's signal.
#[derive(Clone, Copy)]
enum Seg {
    /// 1 kHz-style stereo sine, `amp_db` dBFS peak.
    Sine { freq: f64, amp_db: f64, secs: f64 },
    /// fs/4 sine at 45 degrees, peak `amp` (linear): samples ±amp/√2, true peak `amp`.
    Fs4 { amp: f64, secs: f64 },
}

fn render(rate: f64, segs: &[Seg]) -> Stereo {
    let mut v: Vec<f32> = Vec::new();
    for s in segs {
        match *s {
            Seg::Sine { freq, amp_db, secs } => {
                let n = (rate * secs) as usize;
                let a = libm::pow(10.0, amp_db / 20.0);
                v.extend((0..n).map(|i| (a * libm::sin(2.0 * PI * freq * i as f64 / rate)) as f32));
            }
            Seg::Fs4 { amp, secs } => {
                let n = (rate * secs) as usize;
                v.extend((0..n).map(|i| (amp * libm::sin(PI / 4.0 + i as f64 * PI / 2.0)) as f32));
            }
        }
    }
    (v.clone(), v)
}

fn seg_json(s: &Seg) -> String {
    match *s {
        Seg::Sine { freq, amp_db, secs } => format!("{{\"kind\":\"sine\",\"freqHz\":{freq},\"ampDb\":{amp_db},\"secs\":{secs}}}"),
        Seg::Fs4 { amp, secs } => format!("{{\"kind\":\"fs4_45\",\"amp\":{amp},\"secs\":{secs}}}"),
    }
}

// ---------------------------------------------------------------- main half (as `loudness_s1.rs`)

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

fn last_loudness(subs: &[f64], n: usize) -> f64 {
    if subs.len() < n {
        return f64::NEG_INFINITY;
    }
    loudness::lufs(subs[subs.len() - n..].iter().sum::<f64>() / n as f64)
}

fn integrated(subs: &[f64]) -> f64 {
    let lufs = loudness::lufs;
    let blocks: Vec<f64> = window_means(subs, 4).into_iter().filter(|&e| lufs(e) >= -70.0).collect();
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

/// EBU Tech 3342: 3 s blocks, one per second, -70 / -20 LU gates, 10th to 95th percentile.
fn lra(subs: &[f64]) -> f64 {
    let lufs = loudness::lufs;
    let blocks: Vec<f64> = window_means(subs, 30).into_iter().step_by(10).filter(|&e| lufs(e) >= -70.0).collect();
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

fn dbf(x: f64) -> f64 {
    if x > 0.0 {
        20.0 * libm::log10(x)
    } else {
        f64::NEG_INFINITY
    }
}

#[derive(Clone, Copy)]
struct Meas {
    m: f64,
    s: f64,
    i: f64,
    lra: f64,
    tp_db: f64,
    lost: u64,
}

/// The meter fed quantum by quantum with the true-peak stage always on, a STATUS take every 6 quanta.
fn measure(rate: f64, sig: &Stereo) -> Meas {
    let mut b = Meter::new(rate);
    b.set_true_peak_gate(0.0);
    let mut ring: Ring = [0.0; RING];
    let (mut feed, mut subs) = (Feed::default(), Vec::new());
    let mut peak = 0.0f32;
    let n = sig.0.len();
    let (mut q, mut o) = (0, 0);
    while o < n {
        let e = (o + QUANTUM).min(n);
        b.process(&sig.0[o..e], &sig.1[o..e], &mut ring);
        q += 1;
        o = e;
        if q % 6 == 0 || o == n {
            feed.take(b.seq(), &ring, &mut subs);
            let p = b.take_peak();
            peak = peak.max(p[0]).max(p[1]);
        }
    }
    Meas { m: last_loudness(&subs, 4), s: last_loudness(&subs, 30), i: integrated(&subs), lra: lra(&subs), tp_db: dbf(peak as f64), lost: feed.lost }
}

// ---------------------------------------------------------------- the cases

#[derive(Clone, Copy, PartialEq, Debug)]
enum Group {
    T3341,
    T3342,
    TruePeak,
}

struct Case {
    name: &'static str,
    tech: &'static str,
    group: Group,
    segs: Vec<Seg>,
    /// Expected values (LU or LUFS); `None` where the Tech case doesn't state one.
    i: Option<f64>,
    m: Option<f64>,
    s: Option<f64>,
    lra: Option<f64>,
    /// Expected true peak in dBTP.
    tp: Option<f64>,
}

const TOL_LU: f64 = 0.1;
/// Tech 3341's true-peak window: the reading may be 0.4 dB under and 0.2 dB over.
const TP_UNDER: f64 = 0.4;
const TP_OVER: f64 = 0.2;

fn sine(amp_db: f64, secs: f64) -> Seg {
    Seg::Sine { freq: 1000.0, amp_db, secs }
}

fn cases() -> Vec<Case> {
    let c = |name, tech, group, segs: Vec<Seg>| Case { name, tech, group, segs, i: None, m: None, s: None, lra: None, tp: None };
    let t5 = 10.0 * libm::log10((libm::pow(10.0, -2.0) + libm::pow(10.0, -2.6)) / 2.0);
    let mut v = vec![
        Case { i: Some(-23.0), m: Some(-23.0), s: Some(-23.0), ..c("t1", "3341 (1 kHz stereo -23 dBFS, 20 s)", Group::T3341, vec![sine(-23.0, 20.0)]) },
        Case { i: Some(-33.0), m: Some(-33.0), s: Some(-33.0), ..c("t2", "3341 (1 kHz stereo -33 dBFS, 20 s)", Group::T3341, vec![sine(-33.0, 20.0)]) },
        Case { i: Some(-20.0), m: Some(-20.0), s: Some(-20.0), ..c("t2b", "3341 (1 kHz stereo -20 dBFS, 20 s)", Group::T3341, vec![sine(-20.0, 20.0)]) },
        Case { i: Some(-23.0), ..c("t3", "3341 (relative gate: -36 10 s, -23 60 s, -36 10 s)", Group::T3341, vec![sine(-36.0, 10.0), sine(-23.0, 60.0), sine(-36.0, 10.0)]) },
        Case { i: Some(-23.0), ..c("t4", "3341 (absolute gate: -80 20 s, -23 20 s)", Group::T3341, vec![sine(-80.0, 20.0), sine(-23.0, 20.0)]) },
        Case { i: Some(t5), ..c("t5", "3341 (no gating effect: -20 10 s, -26 10 s)", Group::T3341, vec![sine(-20.0, 10.0), sine(-26.0, 10.0)]) },
        Case { lra: Some(10.0), ..c("l1", "3342 (-20 20 s, -30 20 s)", Group::T3342, vec![sine(-20.0, 20.0), sine(-30.0, 20.0)]) },
        Case { lra: Some(5.0), ..c("l2", "3342 (-20 20 s, -15 20 s)", Group::T3342, vec![sine(-20.0, 20.0), sine(-15.0, 20.0)]) },
        Case { lra: Some(20.0), ..c("l3", "3342 (-40 20 s, -20 20 s)", Group::T3342, vec![sine(-40.0, 20.0), sine(-20.0, 20.0)]) },
        Case { lra: Some(15.0), ..c("l4", "3342 (-50, -35, -20, -35, -50, 20 s each)", Group::T3342, vec![sine(-50.0, 20.0), sine(-35.0, 20.0), sine(-20.0, 20.0), sine(-35.0, 20.0), sine(-50.0, 20.0)]) },
    ];
    for (name, amp) in [("tp0.5", 0.5), ("tp1", 1.0), ("tp1.4125", 1.4125)] {
        v.push(Case { tp: Some(dbf(amp)), ..c(name, "3341 true peak (fs/4 sine at 45 degrees)", Group::TruePeak, vec![Seg::Fs4 { amp, secs: 2.0 }]) });
    }
    v
}

const RATES: [f64; 2] = [48000.0, 44100.0];

struct Outcome {
    case: usize,
    rate: f64,
    meas: Meas,
}

/// Every case at every rate, measured once for all the tests.
fn outcomes() -> &'static (Vec<Case>, Vec<Outcome>) {
    static ALL: OnceLock<(Vec<Case>, Vec<Outcome>)> = OnceLock::new();
    ALL.get_or_init(|| {
        let cs = cases();
        let mut out = Vec::new();
        for (ci, c) in cs.iter().enumerate() {
            for rate in RATES {
                out.push(Outcome { case: ci, rate, meas: measure(rate, &render(rate, &c.segs)) });
            }
        }
        (cs, out)
    })
}

/// One check: `(label, expected, measured, ok)`.
fn checks(c: &Case, m: &Meas) -> Vec<(&'static str, f64, f64, bool)> {
    let mut v = Vec::new();
    let mut lu = |what, e: Option<f64>, got: f64| {
        if let Some(e) = e {
            v.push((what, e, got, (got - e).abs() <= TOL_LU));
        }
    };
    lu("I", c.i, m.i);
    lu("M", c.m, m.m);
    lu("S", c.s, m.s);
    lu("LRA", c.lra, m.lra);
    if let Some(e) = c.tp {
        let d = m.tp_db - e;
        v.push(("TP", e, m.tp_db, (-TP_UNDER..=TP_OVER).contains(&d)));
    }
    v
}

// ---------------------------------------------------------------- fixtures

fn num(x: f64) -> String {
    if x.is_finite() {
        format!("{x:.6}")
    } else {
        "null".into()
    }
}

fn opt(x: Option<f64>) -> String {
    x.map_or("null".into(), num)
}

fn fixture_json(c: &Case, rate: f64, m: &Meas) -> String {
    let segs: Vec<String> = c.segs.iter().map(seg_json).collect();
    format!(
        "{{\"name\":\"{name}\",\"tech\":\"{tech}\",\"rate\":{rate},\"channels\":2,\"segments\":[{segs}],\"expected\":{{\"I\":{i},\"M\":{mm},\"S\":{s},\"LRA\":{lra},\"truePeakDb\":{tp},\"toleranceLU\":{TOL_LU},\"truePeakToleranceDb\":[-{TP_UNDER},{TP_OVER}]}},\"measured\":{{\"I\":{mi},\"M\":{mmm},\"S\":{ms},\"LRA\":{mlra},\"truePeakDb\":{mtp}}}}}\n",
        name = c.name,
        tech = c.tech,
        segs = segs.join(","),
        i = opt(c.i),
        mm = opt(c.m),
        s = opt(c.s),
        lra = opt(c.lra),
        tp = opt(c.tp),
        mi = num(m.i),
        mmm = num(m.m),
        ms = num(m.s),
        mlra = num(m.lra),
        mtp = num(m.tp_db),
    )
}

fn fixture_path(c: &Case, rate: f64) -> String {
    format!("{}/../../../../src/plugins/audio/runtime/golden/loudness/{}-{}.json", env!("CARGO_MANIFEST_DIR"), c.name, rate as u32)
}

/// Pulls a number (or null) out of the fixture's text after `"key":` within `scope`.
fn field(scope: &str, key: &str) -> Option<f64> {
    let at = scope.find(&format!("\"{key}\":"))? + key.len() + 3;
    let rest = &scope[at..];
    let end = rest.find([',', '}']).unwrap();
    rest[..end].parse().ok()
}

/// Writes the fixture when `UPDATE_GOLDENS=1` and it's missing; otherwise compares.
fn fixture(c: &Case, rate: f64, m: &Meas, problems: &mut Vec<String>) {
    let path = fixture_path(c, rate);
    let json = fixture_json(c, rate, m);
    let exists = std::path::Path::new(&path).exists();
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") && !exists {
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, json).unwrap();
        return;
    }
    let Ok(have) = std::fs::read_to_string(&path) else {
        problems.push(format!("{}@{}: no fixture; run UPDATE_GOLDENS=1 cargo test -p audio-dsp --test loudness_ebu", c.name, rate));
        return;
    };
    let split = have.find("\"measured\"").unwrap();
    let want = fixture_json(c, rate, m);
    // the part before "measured" (name, signal, expected values) must be identical
    if have[..split] != want[..want.find("\"measured\"").unwrap()] {
        problems.push(format!("{}@{}: the fixture's signal or expected values changed", c.name, rate));
    }
    let scope = &have[split..];
    for (key, got) in [("I", m.i), ("M", m.m), ("S", m.s), ("LRA", m.lra), ("truePeakDb", m.tp_db)] {
        let was = field(scope, key);
        let same = match was {
            None => !got.is_finite(),
            Some(w) => (w - got).abs() <= 1e-4,
        };
        if !same {
            problems.push(format!("{}@{}: measured {key} {got} vs the fixture's {was:?}", c.name, rate));
        }
    }
}

// ---------------------------------------------------------------- the tests

/// Runs a group's checks and fixtures; returns the number of checks and the failures.
fn run(group: Group, rate: f64) -> (usize, Vec<String>) {
    let (cs, outs) = outcomes();
    let (mut n, mut failed) = (0, Vec::new());
    for o in outs.iter().filter(|o| o.rate == rate && cs[o.case].group == group) {
        let c = &cs[o.case];
        for (what, e, got, ok) in checks(c, &o.meas) {
            n += 1;
            if !ok {
                failed.push(format!("{}@{}: {what}: expect {e} (tol {}), measured {got}", c.name, rate, if what == "TP" { format!("-{TP_UNDER}/+{TP_OVER} dB") } else { format!("±{TOL_LU}") }));
            }
        }
        n += 1;
        if o.meas.lost != 0 {
            failed.push(format!("{}@{}: the ring lost {} sub-blocks", c.name, rate, o.meas.lost));
        }
        fixture(c, rate, &o.meas, &mut failed);
    }
    (n, failed)
}

fn assert_group(group: Group, rate: f64, want: usize) {
    let (n, failed) = run(group, rate);
    assert_eq!(n, want, "{group:?}@{rate}: check count");
    assert!(failed.is_empty(), "{} of {n} failed:\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn tech_3341_at_48k() {
    // t1, t2, t2b: I, M, S + lost = 4 each; t3, t4, t5: I + lost = 2 each
    assert_group(Group::T3341, 48000.0, 3 * 4 + 3 * 2);
}

#[test]
fn tech_3341_at_44k1() {
    assert_group(Group::T3341, 44100.0, 3 * 4 + 3 * 2);
}

#[test]
fn tech_3342_at_48k() {
    assert_group(Group::T3342, 48000.0, 4 * 2);
}

#[test]
fn tech_3342_at_44k1() {
    assert_group(Group::T3342, 44100.0, 4 * 2);
}

#[test]
fn tech_3341_true_peak_at_48k() {
    assert_group(Group::TruePeak, 48000.0, 3 * 2);
}

#[test]
fn tech_3341_true_peak_at_44k1() {
    assert_group(Group::TruePeak, 44100.0, 3 * 2);
}

/// The window itself: a reading of the fs/4 case 0.5 dB low or 0.3 dB high is out.
#[test]
fn true_peak_window_rejects_outside_readings() {
    let all = cases();
    let c = all.iter().find(|c| c.name == "tp0.5").unwrap();
    let m = Meas { m: 0.0, s: 0.0, i: 0.0, lra: 0.0, tp_db: c.tp.unwrap(), lost: 0 };
    assert!(checks(c, &m).iter().all(|x| x.3));
    for (d, ok) in [(-0.5, false), (-0.39, true), (0.19, true), (0.3, false)] {
        let m = Meas { tp_db: c.tp.unwrap() + d, ..m };
        assert_eq!(checks(c, &m)[0].3, ok, "{d} dB off");
    }
}

/// Prints the worst error per measure over the whole set (`--nocapture`).
#[test]
fn worst_errors_per_measure() {
    let (cs, outs) = outcomes();
    let mut worst: Vec<(&str, f64, String)> = Vec::new();
    for o in outs {
        let c = &cs[o.case];
        for (what, e, got, _) in checks(c, &o.meas) {
            let err = got - e;
            match worst.iter_mut().find(|w| w.0 == what) {
                Some(w) if w.1.abs() >= err.abs() => {}
                Some(w) => *w = (what, err, format!("{}@{}", c.name, o.rate)),
                None => worst.push((what, err, format!("{}@{}", c.name, o.rate))),
            }
        }
    }
    for (what, err, at) in &worst {
        eprintln!("worst {what} error: {err:+.6} at {at}");
    }
    assert_eq!(worst.len(), 5, "I, M, S, LRA, TP");
    assert!(worst.iter().filter(|w| w.0 != "TP").all(|w| w.1.abs() <= TOL_LU));
}
