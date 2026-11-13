//! B4 (0171/0172 M5-0): compressor parameters glide over `COMPRESSOR_SMOOTH_MS` per quantum
//! (architecture §4.7, R7). Acceptance: "a compressor threshold step reads abrupt <= 0.23 (spike
//! S4's smooth bound); the unsmoothed control still clicks".
//!
//! The measure is S4's (`spikes/audio-mix/mix-core/live/live.ts` `analyse`, `src/lib.rs`
//! `blend_compressor`): `abrupt` = the largest sample-to-sample step of d = edited − unedited
//! output, over the peak of |d|, from the edit on. A smooth change of these tones (<= 1760 Hz)
//! reads <= 0.23; a jump about 1 (S4 called > 0.3 a click).

mod common;

use audio_core::fx::{kind, FxChain};
use audio_core::scheduler;
use audio_dsp::compressor::Compressor;
use audio_wire::generated as wire;
use common::*;

const Q: usize = 128;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
/// S4's compressor: threshold (varied), knee 6 dB, ratio 4, attack 3 ms, release 250 ms.
const KNEE: f32 = 6.0;
const RATIO: f32 = 4.0;
const ATTACK: f32 = 0.003;
const RELEASE: f32 = 0.25;

/// `abrupt` and the largest step of d in dBFS, from frame `from`.
fn abrupt(reference: &[f32], edited: &[f32], from: usize) -> (f64, f64) {
    let (mut step, mut peak) = (0.0f64, 0.0f64);
    for i in from..reference.len() {
        let d = (edited[i] - reference[i]) as f64;
        let dp = (edited[i - 1] - reference[i - 1]) as f64;
        step = step.max((d - dp).abs());
        peak = peak.max(d.abs());
    }
    assert!(peak > 1e-5, "the edit changed the output");
    (step / peak, 20.0 * step.log10())
}

/// A 1 s looping clip of whole-cycle tones `(hz, amplitude)`: the loop seam is seamless.
fn tones(spec: &[(f32, f32)]) -> Vec<f32> {
    (0..48_000).map(|i| spec.iter().map(|&(hz, a)| a * libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / RATE)).sum()).collect()
}

fn compressor(threshold: f32) -> wire::BusConfigBusesEffects {
    wire::BusConfigBusesEffects { type_: kind::COMPRESSOR, p: [threshold, KNEE, RATIO, ATTACK, RELEASE, 0.0, 0.0] }
}

/// S4's live tree: Master, Music (low-pass 8 kHz), SFX (the compressor at -24 dB).
fn tree() -> Rec {
    let lp = wire::BusConfigBusesEffects { type_: kind::LOWPASS, p: [8_000.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0] };
    Rec::Config(wire::BusConfig {
        voice_id: 0,
        frame_offset: wire::ASAP,
        buses: vec![
            wire::BusConfigBuses { parent: ROOT, effects: vec![] },
            wire::BusConfigBuses { parent: 0, effects: vec![lp] },
            wire::BusConfigBuses { parent: 0, effects: vec![compressor(-24.0)] },
        ],
    })
}

/// The live edit as main sends it (architecture §4.7): an asap `BUS_SLOT` of SFX with the new
/// threshold.
fn edit(threshold: f32) -> Rec {
    let r = wire::BusSlot {
        voice_id: 0,
        frame_offset: wire::ASAP,
        slot: 2,
        flags: 0,
        sequence_id: 0,
        reserved: 0,
        reserved2: 0,
        parent: 0,
        effects: vec![wire::BusSlotEffects { type_: kind::COMPRESSOR, p: [threshold, KNEE, RATIO, ATTACK, RELEASE, 0.0, 0.0] }],
    };
    let mut b = vec![0u8; wire::BusSlot::FIXED_END + wire::BusSlotEffects::FIXED_END];
    r.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// S4's live scene on the real core: two looping tone voices (Music, SFX), the edit (if any)
/// after `warm` quanta, 64 quanta in all; the left output.
fn scene(warm: usize, threshold: Option<f32>) -> Vec<f32> {
    let mut m = Mixer::new(8);
    m.load_clip(10, &tones(&[(220.0, 0.15), (880.0, 0.1), (1760.0, 0.05)]));
    m.load_clip(11, &tones(&[(330.0, 0.15), (990.0, 0.1), (1650.0, 0.05)]));
    // Master at 0.25 keeps the sum (with the compressor's makeup gain) under the limiter.
    m.submit(&[tree(), master(0.25, false, 0), play(V1, 10, 1, MIXED | LOOP), play(V2, 11, 2, MIXED | LOOP)]);
    let (mut out, _) = m.render_n(warm);
    if let Some(t) = threshold {
        assert_eq!(scheduler::submit(&mut m.core, &batch(m.frame as f64, &[edit(t)])), 0);
    }
    out.extend(m.render_n(64 - warm).0);
    out
}

#[test]
fn a_live_threshold_edit_on_the_real_core_reads_smooth() {
    // S4's live method: the edit lands at quantum 12..19 (each a different tone phase); the
    // worst of the eight is the reading. S4 measured the unsmoothed core at 1.0 (CLICK).
    for to in [-30.0f32, -50.0] {
        let mut worst = (0.0f64, -200.0f64);
        for warm in 12..20 {
            let (a, db) = abrupt(&scene(warm, None), &scene(warm, Some(to)), warm * Q);
            worst = (worst.0.max(a), worst.1.max(db));
        }
        println!("real core, BUS_SLOT threshold -24 -> {to} dB: abrupt {:.3}, largest step {:.1} dBFS", worst.0, worst.1);
        assert!(worst.0 <= 0.23, "-24 -> {to} dB: abrupt {:.3}", worst.0);
    }
}

#[test]
fn a_threshold_step_glides_and_the_unsmoothed_control_clicks() {
    // S4's `blend_compressor`: 0.3 × 220 Hz + 0.2 × 880 Hz + 0.1 × 1760 Hz, 0.6 s, the edit at
    // 0.2 s (a quantum boundary). Smoothed: the bus's chain (`FxChain::configure`, the path a
    // BUS_SLOT edit takes). Control: the same compressor configured with the new threshold at
    // once (what the core did before B4). S4: hard step 0.78, blend per quantum over 20 ms
    // 0.19 (-30 dB) and 0.23 (-40 dB).
    let n = (0.6 * RATE) as usize / Q * Q;
    let x: Vec<f32> = (0..n)
        .map(|i| {
            let t = 2.0 * core::f32::consts::PI * i as f32 / RATE;
            0.3 * libm::sinf(220.0 * t) + 0.2 * libm::sinf(880.0 * t) + 0.1 * libm::sinf(1760.0 * t)
        })
        .collect();
    let t0 = (0.2 * RATE) as usize / Q * Q;
    let fx = |thr: f32| (kind::COMPRESSOR, [thr, KNEE, RATIO, ATTACK, RELEASE, 0.0, 0.0]);
    let chain = |to: Option<f32>| -> Vec<f32> {
        let mut c = FxChain::default();
        c.configure([fx(-24.0)], RATE);
        let mut y = x.clone();
        for q in 0..n / Q {
            if let (Some(t), true) = (to, q * Q == t0) {
                c.configure([fx(t)], RATE);
            }
            let (mut l, mut r) = (y[q * Q..(q + 1) * Q].to_vec(), y[q * Q..(q + 1) * Q].to_vec());
            let (mut rl, mut rr) = (vec![0.0f32; Q], vec![0.0f32; Q]);
            c.process(&mut l, &mut r, &mut rl, &mut rr);
            y[q * Q..(q + 1) * Q].copy_from_slice(&l);
        }
        y
    };
    let hard = |to: f32| -> Vec<f32> {
        let mut c = Compressor::default();
        let mut y = x.clone();
        for q in 0..n / Q {
            let thr = if q * Q < t0 { -24.0 } else { to };
            c.configure(RATE, thr, KNEE, RATIO, ATTACK, RELEASE);
            let (mut l, mut r) = (y[q * Q..(q + 1) * Q].to_vec(), y[q * Q..(q + 1) * Q].to_vec());
            c.process(&mut l, &mut r);
            y[q * Q..(q + 1) * Q].copy_from_slice(&l);
        }
        y
    };
    let base = chain(None);
    for to in [-30.0f32, -40.0] {
        let (smooth, smooth_db) = abrupt(&base, &chain(Some(to)), t0);
        let (control, control_db) = abrupt(&base, &hard(to), t0);
        println!("threshold -24 -> {to} dB: glide abrupt {smooth:.3} ({smooth_db:.1} dBFS), unsmoothed control {control:.3} ({control_db:.1} dBFS)");
        assert!(smooth <= 0.23, "-24 -> {to} dB: the glide reads {smooth:.3}");
        assert!(control > 0.3, "-24 -> {to} dB: the unsmoothed control reads {control:.3}, not a click");
    }
}
