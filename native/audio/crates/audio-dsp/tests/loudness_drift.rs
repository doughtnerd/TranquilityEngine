//! So1 soak 3 (ADR 0171 amended by 0172, M5d; architecture §4.4): loudness drift over 20 minutes
//! of programme at 48 kHz against the live `ebur128` crate 0.1.11 (dev-only, as Ld6's
//! `loudness_crate.rs`). **Ignored by default** (a soak: about 7 s of compute in release (plus the build), longer in a
//! debug build); run it alone with
//!
//! ```text
//! cargo test --release -p audio-dsp --test loudness_drift -- --ignored --nocapture
//! ```
//!
//! **What runs.** Programme-like material, synthesised and streamed segment by segment (never
//! held whole): spike S1's music-like signal at random levels and Ld6's random programme
//! (noise, tones, sweeps, clipped tones, clicks, silence), 8 to 40 s a segment. The core's meter
//! (`audio_dsp::loudness::Meter`, the kernels the wasm core runs) takes it one 128-frame quantum
//! at a time with a STATUS take every 6 quanta, and main's exact gating (spike S1's `Gating`,
//! `loudness_common::stats`) reads the sub-blocks; the crate takes the same audio. At **every
//! minute** M, S, I and LRA are compared: the bar is 1e-3 LU across the whole 20 minutes (drift
//! would show as a difference that grows with the programme's length).
//!
//! **Main's TypeScript gating.** The sub-block energies and the crate's readings at each minute
//! are written to `tests/vectors/loudness_drift.json` (or checked against the committed file: the
//! energies bit for bit), and `src/plugins/audio/runtime/capture/loudnessDrift.soak.ts` feeds them
//! to the shipped `LoudnessStats` (exact gating since G7d, D4) and compares at each minute, with
//! its memory bound (one hour of gated programme) not reached. Rewrite the file with
//! `LOUDNESS_DRIFT_VECTORS=write`.

mod loudness_common;

use audio_dsp::loudness::{self, Meter, Ring, QUANTUM, RING};
use ebur128::{EbuR128, Mode};
use loudness_common::{db, diff, music, programme, stats, Rng, Stats, Stereo};

const RATE: f64 = 48_000.0;
const MINUTES: usize = 20;
/// The cross-check's bar, LU.
const TOL: f64 = 1e-3;
/// The STATUS cadence (quanta), as the active core.
const EVERY: usize = 6;
/// Readings below this are digital silence on both sides (Ld6's rule).
const SILENCE_LUFS: f64 = -300.0;

fn floor(x: f64) -> f64 {
    if x < SILENCE_LUFS { f64::NEG_INFINITY } else { x }
}

/// The next programme segment: S1's music-like signal at a random level, or Ld6's random programme.
fn segment(rng: &mut Rng, n: u64) -> Stereo {
    if rng.below(5) < 3 {
        let secs = 8.0 + rng.below(33) as f64; // whole seconds: whole sub-blocks at 48 kHz
        music(RATE, secs, db(rng.range(-30.0, -3.0)), 1000 + n)
    } else {
        programme(RATE, 2000 + n)
    }
}

/// The meter streamed: `push` takes any number of frames, quantum by quantum, with a take every `EVERY` quanta.
struct Streamed {
    meter: Meter,
    ring: Ring,
    last: u32,
    lost: u64,
    q: usize,
    subs: Vec<f32>,
    /// A partial quantum carried to the next push.
    carry: (Vec<f32>, Vec<f32>),
}

impl Streamed {
    fn new() -> Self {
        Streamed { meter: Meter::new(RATE), ring: [0.0; RING], last: 0, lost: 0, q: 0, subs: Vec::new(), carry: (Vec::new(), Vec::new()) }
    }

    fn quantum(&mut self, l: &[f32], r: &[f32]) {
        self.meter.process(l, r, &mut self.ring);
        self.q += 1;
        if self.q % EVERY == 0 {
            let seq = self.meter.seq();
            let mut new = seq.wrapping_sub(self.last) as usize;
            if new > RING {
                self.lost += (new - RING) as u64;
                new = RING;
            }
            for j in 0..new {
                let e = (seq as usize).wrapping_sub(new).wrapping_add(j);
                self.subs.push(self.ring[e % RING]);
            }
            self.last = seq;
            self.meter.take_peak();
        }
    }

    fn push(&mut self, l: &[f32], r: &[f32]) {
        let (mut cl, mut cr) = std::mem::take(&mut self.carry);
        cl.extend_from_slice(l);
        cr.extend_from_slice(r);
        let whole = cl.len() / QUANTUM * QUANTUM;
        let mut o = 0;
        while o < whole {
            self.quantum(&cl[o..o + QUANTUM], &cr[o..o + QUANTUM]);
            o += QUANTUM;
        }
        self.carry = (cl[whole..].to_vec(), cr[whole..].to_vec());
    }
}

fn crate_stats(c: &EbuR128) -> Stats {
    Stats { m: c.loudness_momentary().unwrap(), s: c.loudness_shortterm().unwrap(), i: c.loudness_global().unwrap(), lra: c.loudness_range().unwrap() }
}

/// One minute's comparison.
struct Minute {
    own: Stats,
    reference: Stats,
}

/// Streams 20 minutes through the meter and the crate; returns the energies and each minute's readings.
fn run() -> (Vec<f32>, Vec<Minute>, u64) {
    let mode = Mode::M | Mode::S | Mode::I | Mode::LRA;
    let mut c = EbuR128::new(2, RATE as u32, mode).unwrap();
    let mut m = Streamed::new();
    let mut rng = Rng(0x5011_D41F7_u64 | 1);
    let minute = (60.0 * RATE) as usize;
    let total = MINUTES * minute;
    let mut fed = 0usize;
    let mut out = Vec::new();
    let mut n = 0u64;
    while fed < total {
        let (l, r) = segment(&mut rng, n);
        n += 1;
        let mut o = 0;
        while o < l.len() && fed < total {
            // up to the next minute edge, so the crate is read exactly there
            let edge = (fed / minute + 1) * minute;
            let e = (o + (edge - fed)).min(l.len());
            m.push(&l[o..e], &r[o..e]);
            c.add_frames_planar_f32(&[&l[o..e], &r[o..e]]).unwrap();
            fed += e - o;
            o = e;
            if fed % minute == 0 {
                assert!(m.carry.0.is_empty() && m.q % EVERY == 0, "a minute ends on a take");
                let subs: Vec<f64> = m.subs.iter().map(|&e| e as f64).collect();
                assert_eq!(subs.len(), fed / loudness::subblock_frames(RATE) as usize, "every sub-block taken by the minute");
                out.push(Minute { own: stats(&subs), reference: crate_stats(&c) });
            }
        }
    }
    (m.subs, out, m.lost)
}

#[test]
#[ignore = "So1 soak: 20 minutes of programme; run alone with --ignored (release recommended)"]
fn twenty_minutes_of_programme_do_not_drift_from_the_crate() {
    let t0 = std::time::Instant::now();
    let (subs, minutes, lost) = run();
    assert_eq!(lost, 0, "no sub-block lost at the {EVERY}-quantum cadence");
    assert_eq!(minutes.len(), MINUTES);
    eprintln!("So1 soak 3 (Rust): meter + exact gating vs ebur128 0.1.11, 48 kHz, {MINUTES} min of programme, {} sub-blocks, {:.1} s wall", subs.len(), t0.elapsed().as_secs_f64());
    eprintln!("| minute | I own | I crate | |dI| | LRA own | LRA crate | |dLRA| | |dM| | |dS| |");
    eprintln!("|---|---|---|---|---|---|---|---|---|");
    let mut worst = [0.0f64; 4];
    for (k, Minute { own, reference }) in minutes.iter().enumerate() {
        let d = [diff(floor(own.i), floor(reference.i)), diff(own.lra, reference.lra), diff(floor(own.m), floor(reference.m)), diff(floor(own.s), floor(reference.s))];
        for j in 0..4 {
            worst[j] = worst[j].max(d[j]);
        }
        eprintln!("| {} | {:.4} | {:.4} | {:.2e} | {:.4} | {:.4} | {:.2e} | {:.2e} | {:.2e} |", k + 1, own.i, reference.i, d[0], own.lra, reference.lra, d[1], d[2], d[3]);
    }
    eprintln!("worst over {MINUTES} minutes: I {:.3e}, LRA {:.3e}, M {:.3e}, S {:.3e} LU (bar {TOL})", worst[0], worst[1], worst[2], worst[3]);
    for (j, label) in ["I", "LRA", "M", "S"].iter().enumerate() {
        assert!(worst[j] <= TOL, "{label} drifted {} LU from ebur128 (> {TOL})", worst[j]);
    }
    vectors(&subs, &minutes);
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

fn num(x: f64) -> String {
    if x.is_finite() { format!("{x:?}") } else { "null".into() }
}

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/loudness_drift.json");

/// Writes (or checks) the energies and the crate's per-minute readings for `loudnessDrift.soak.ts`.
fn vectors(subs: &[f32], minutes: &[Minute]) {
    let energies = b64(&subs.iter().flat_map(|e| e.to_le_bytes()).collect::<Vec<u8>>());
    let rows: Vec<String> = minutes.iter().map(|m| format!("[{},{},{},{}]", num(m.reference.m), num(m.reference.s), num(m.reference.i), num(m.reference.lra))).collect();
    let text = format!(
        "{{\"about\":\"So1 soak 3: audio_dsp::loudness::Meter sub-block energies (f32 LE, base64) over 20 minutes of synthesised programme at 48 kHz, and the ebur128 0.1.11 crate's M, S, I, LRA at the end of each minute (null is -Infinity); written by native/audio/crates/audio-dsp/tests/loudness_drift.rs (--ignored), read by src/plugins/audio/runtime/capture/loudnessDrift.soak.ts\",\"rate\":48000,\"minutes\":[{}],\"subs\":\"{}\"}}\n",
        rows.join(","),
        energies
    );
    let write = std::env::var("LOUDNESS_DRIFT_VECTORS").as_deref() == Ok("write");
    match std::fs::read_to_string(VECTORS) {
        Ok(committed) if !write => {
            let field = |t: &str, name: &str| -> String {
                let at = t.find(&format!("\"{name}\":")).unwrap() + name.len() + 3;
                let rest = &t[at..];
                let end = if rest.starts_with('"') { rest[1..].find('"').unwrap() + 2 } else { rest.find("]]").unwrap() + 2 };
                rest[..end].to_string()
            };
            assert_eq!(field(&committed, "subs"), field(&text, "subs"), "the meter's energies changed; rewrite with LOUDNESS_DRIFT_VECTORS=write if that is intended");
            eprintln!("checked {VECTORS}");
        }
        _ => {
            std::fs::write(VECTORS, &text).unwrap();
            eprintln!("wrote {VECTORS}");
        }
    }
}
