//! The bus snapshot low-pass engaging from "off" (task F2): the click G1 measured with the F-40
//! `maxStep` detector (0.067 stamped, 0.178 in a 20 ms asap ramp, over DC).
//!
//! Each case renders the same material twice through a real core (bus 1 under the root, no
//! limiter look-ahead): once untouched, once with the `snapshot` lane's low-pass sent from off
//! (24 kHz) to a cut-off at quantum `AT`, as a step (what a stamped snapshot does: the low-pass has
//! quantum granularity) or a 20 ms ramp. It reports, over the edit's window:
//! - `maxStep`: the largest sample-to-sample step of the edited output (F-40), beside the
//!   untouched output's (`dry`);
//! - `abrupt`: S4's live measure, the largest step of `d = edited - untouched` over the peak of `d`
//!   (S4: a smooth change of tones gives <= 0.23, its click verdict is > 0.3, a jump is about 1).
//!   On noise `d` is itself broadband, so `abrupt` reads high for any filter change; it is
//!   meaningful on DC and on the tone mix (S4's live scene: 220/880/1760 Hz + 330/990/1650 Hz).
//!
//! `cargo test -p audio-core --test snapshot_lp_engage -- --nocapture` prints the table.

mod common;

use audio_core::QUANTUM;
use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const WHITE: u32 = 2;
const PINK: u32 = 3;
const TONES: u32 = 4;
/// The quantum the low-pass is sent at.
const AT: usize = 24;
/// Quanta rendered after it.
const AFTER: usize = 40;
const LEN: usize = 48_000;

fn white() -> Vec<f32> {
    let mut s = 0x1234_5678u32;
    (0..LEN)
        .map(|_| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((s >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * 0.5
        })
        .collect()
}

/// Paul Kellet's pink filter over the white noise.
fn pink() -> Vec<f32> {
    let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    white()
        .into_iter()
        .map(|w| {
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            let p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
            b6 = w * 0.115926;
            p * 0.25
        })
        .collect()
}

/// S4's live scene, both clips summed into one (one second, whole cycles of every tone).
fn tones() -> Vec<f32> {
    let t = |hz: f32, i: usize| libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / RATE);
    (0..LEN).map(|i| 0.15 * t(220.0, i) + 0.1 * t(880.0, i) + 0.05 * t(1760.0, i) + 0.15 * t(330.0, i) + 0.1 * t(990.0, i) + 0.05 * t(1650.0, i)).collect()
}

fn scene(clip: u32, gain: f32) -> Mixer {
    let mut m = Mixer::new(8);
    m.set_lookahead(0.0);
    m.load_clip(WHITE, &white());
    m.load_clip(PINK, &pink());
    m.load_clip(TONES, &tones());
    let Rec::Play(mut p) = play(V1, clip, 1, MIXED | LOOP) else { unreachable!() };
    p.gain = gain;
    m.submit(&[config(&[ROOT, 0]), Rec::Play(p)]);
    m
}

/// The left output of `clip` with `edits` sent at the start of the quanta they name.
fn render(clip: u32, gain: f32, edits: &[(usize, f32, u32)]) -> Vec<f32> {
    let mut m = scene(clip, gain);
    let mut out = Vec::new();
    let last = edits.iter().map(|e| e.0).max().unwrap_or(AT) + AFTER;
    for q in 0..last {
        for &(at, hz, frames) in edits {
            if at == q {
                m.submit(&[Rec::Ramps(vec![lane_ramp(1, wire::LANE_SNAPSHOT, None, Some(hz), frames)])]);
            }
        }
        out.extend(m.render().0);
    }
    out
}

fn max_step(x: &[f32]) -> f32 {
    x.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()))
}

struct Measure {
    max_step: f32,
    dry: f32,
    abrupt: f32,
    /// `maxStep` of the edited output over the three quanta from the edit (the onset).
    onset: f32,
    /// `maxStep` of the edited output over its last 16 quanta (the filter settled).
    settled: f32,
}

/// The measures over the window from 4 quanta before `from` (a quantum index) to the end.
fn measure(clip: u32, gain: f32, edits: &[(usize, f32, u32)], from: usize) -> Measure {
    let dry = render(clip, gain, &[]);
    let got = render(clip, gain, edits);
    let w = (from - 4) * QUANTUM..got.len().min(dry.len());
    let d: Vec<f32> = got[w.clone()].iter().zip(&dry[w.clone()]).map(|(a, b)| a - b).collect();
    let peak = d.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let onset = max_step(&got[from * QUANTUM - 1..(from + 3) * QUANTUM]);
    let settled = max_step(&got[got.len() - 16 * QUANTUM..]);
    Measure { max_step: max_step(&got[w.clone()]), dry: max_step(&dry[w]), abrupt: if peak > 1e-5 { max_step(&d) / peak } else { 0.0 }, onset, settled }
}

const MATERIALS: [(&str, u32, f32); 4] = [("dc 0.5", DC, 0.5), ("white", WHITE, 1.0), ("pink", PINK, 1.0), ("tones", TONES, 1.0)];
const CUTOFFS: [f32; 3] = [500.0, 2_000.0, 8_000.0];
const SCHEMES: [(&str, u32); 2] = [("step", 0), ("ramp 20 ms", 960)];

#[test]
fn the_engage_table() {
    eprintln!("| material | cut-off | scheme | maxStep | dry maxStep | abrupt | onset maxStep | settled maxStep |");
    for (name, clip, gain) in MATERIALS {
        for hz in CUTOFFS {
            for (scheme, frames) in SCHEMES {
                let m = measure(clip, gain, &[(AT, hz, frames)], AT);
                eprintln!("| {name} | {hz} | {scheme} | {:.4} | {:.4} | {:.2} | {:.4} | {:.4} |", m.max_step, m.dry, m.abrupt, m.onset, m.settled);
            }
        }
    }
    // Re-engaging: on at 2 kHz, off again (a step), then on again 16 quanta later.
    for (name, clip, gain) in MATERIALS {
        let m = measure(clip, gain, &[(8, 2_000.0, 0), (16, OFF, 0), (AT, 2_000.0, 0)], AT);
        eprintln!("| {name} | re-engage 2000 | step | {:.4} | {:.4} | {:.2} | {:.4} | {:.4} |", m.max_step, m.dry, m.abrupt, m.onset, m.settled);
    }
}

/// Over DC, a low-pass engaging from off changes nothing a low-pass passes: the output stays at
/// the DC level to rounding, step or ramp, first engagement or a later one. Before F2 the filter
/// started from zero (or stale) history and stepped 0.067..0.5.
#[test]
fn engaging_from_off_over_dc_does_not_click() {
    for hz in CUTOFFS {
        for (scheme, frames) in SCHEMES {
            let m = measure(DC, 0.5, &[(AT, hz, frames)], AT);
            assert!(m.max_step < 1e-4, "{hz} Hz {scheme}: maxStep {}", m.max_step);
        }
    }
    let m = measure(DC, 0.5, &[(8, 2_000.0, 0), (16, OFF, 0), (AT, 2_000.0, 0)], 8);
    assert!(m.max_step < 1e-4, "re-engage: maxStep {}", m.max_step);
}

/// On the tone mix (S4's live scene), a 20 ms ramp from off is smooth by S4's measure.
#[test]
fn a_ramp_from_off_over_tones_is_smooth_by_s4s_measure() {
    for hz in CUTOFFS {
        let m = measure(TONES, 1.0, &[(AT, hz, 960)], AT);
        assert!(m.abrupt <= 0.3, "{hz} Hz: abrupt {}", m.abrupt);
    }
}
