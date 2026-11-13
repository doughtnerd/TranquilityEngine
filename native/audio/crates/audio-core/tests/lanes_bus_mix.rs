//! B1a's bit-identity check for the `BUS_MIX` → `BUS_RAMP` conversion (0171/0172 M5, R3; the
//! "Seven gain lanes" flip): the same scenes driven by BUS_MIX and by B1a's mapping (per bus, an
//! asap `BUS_RAMP` on the `runtime` lane with the entry's gain and one on the `snapshot` lane with
//! its low-pass, both over BUS_MIX's `rampFrames`) render bit for bit the same output. With the
//! Rust goldens converted to `BUS_RAMP` and the TypeScript goldens still sending BUS_MIX until
//! Wa2, this ties the two. **R0 deletes this file with BUS_MIX.**

mod common;

use audio_core::fx::kind;
use audio_wire::generated as wire;
use common::*;

/// A BUS_MIX record (retired at R0) of `(gain, lpHz)` per bus over `ramp`.
fn bus_mix(ramp: u32, buses: &[(f32, f32)]) -> Rec {
    let rec = wire::BusMix { voice_id: 0, frame_offset: wire::ASAP, ramp_frames: ramp, buses: buses.iter().map(|&(gain, lp_hz)| wire::BusMixBuses { gain, lp_hz }).collect() };
    let mut b = vec![0u8; 4096];
    let n = rec.write(&mut b, 0).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

/// One step of a scene: records to submit (BUS_MIX entries given as `(ramp, buses)`), then quanta.
enum Step {
    Recs(Vec<Rec>),
    Mix(u32, Vec<(f32, f32)>),
    Render(usize),
}

/// Runs `scene` with each `Step::Mix` sent as BUS_MIX (`legacy`) or as `BUS_RAMP`s; returns the
/// output's bits.
fn run(scene: &dyn Fn() -> Vec<Step>, legacy: bool) -> Vec<u32> {
    let mut m = Mixer::new(8);
    let mut bits = Vec::new();
    for step in scene() {
        match step {
            Step::Recs(recs) => m.submit(&recs),
            Step::Mix(ramp, buses) => m.submit(&[if legacy { bus_mix(ramp, &buses) } else { mix(ramp, &buses) }]),
            Step::Render(n) => {
                let (l, r) = m.render_n(n);
                bits.extend(l.iter().chain(&r).map(|x| x.to_bits()));
            }
        }
    }
    bits
}

fn assert_bit_identical(name: &str, scene: &dyn Fn() -> Vec<Step>) {
    let (a, b) = (run(scene, true), run(scene, false));
    assert!(a.iter().any(|&x| f32::from_bits(x) != 0.0), "{name}: the scene is audible");
    assert_eq!(a.len(), b.len());
    let first = a.iter().zip(&b).position(|(x, y)| x != y);
    assert_eq!(first, None, "{name}: BUS_RAMP differs from BUS_MIX at sample {first:?}");
}


#[test]
fn the_duck_golden_scene_is_bit_identical() {
    assert_bit_identical("duck", &|| {
        let g = |a: f32, b: f32, c: f32| vec![(a, OFF), (b, OFF), (c, OFF)];
        vec![
            Step::Recs(vec![config(&[ROOT, 0, 0]), master(0.25, false, 0), dc(0x0001_0001, 1, 0.0), dc(0x0001_0002, 2, 0.0)]),
            Step::Mix(0, g(1.0, 1.0, 1.0)),
            Step::Render(2),
            Step::Mix(300, g(1.0, 0.25, 1.0)),
            Step::Render(6),
            Step::Mix(1_000, g(1.0, 1.0, 1.0)),
            Step::Render(9),
            Step::Mix(256, g(1.0, 0.0, 1.0)),
            Step::Render(1),
            Step::Mix(128, g(1.0, 1.0, 1.0)),
            Step::Render(3),
        ]
    });
}

#[test]
fn the_snapshot_golden_scene_with_low_passes_effects_and_a_send_is_bit_identical() {
    assert_bit_identical("snapshot", &|| {
        vec![
            Step::Recs(vec![
                config_fx(&[(ROOT, vec![(kind::COMPRESSOR, -24.0, 30.0)]), (0, vec![(kind::REVERB_SEND, 0.5, 0.0)]), (0, vec![(kind::LOWPASS, 2_000.0, 0.7)]), (0, vec![])]),
                master(0.5, false, 0),
                dc(0x0001_0001, 1, -1.0),
                dc(0x0001_0002, 2, 1.0),
                dc(0x0001_0003, 3, 1.0),
            ]),
            Step::Mix(0, vec![(1.0, OFF); 4]),
            Step::Render(3),
            // One snapshot: several gains and a low-pass at once, the root too, over 640 frames.
            Step::Mix(640, vec![(0.8, OFF), (0.5, 900.0), (1.25, OFF), (0.0, 300.0)]),
            Step::Render(4),
            // Cut short and reversed, with an unchanged low-pass target (its ramp keeps running).
            Step::Mix(200, vec![(1.0, OFF), (1.0, 900.0), (1.0, OFF), (1.0, 300.0)]),
            Step::Render(8),
            Step::Recs(vec![reset(true), dc(0x0001_0004, 1, 0.0)]),
            Step::Render(2),
            Step::Mix(64, vec![(0.5, 1_000.0), (0.5, OFF)]),
            Step::Render(3),
        ]
    });
}

#[test]
fn the_m4_s_bus_scene_is_bit_identical() {
    // `golden/m4-s-bus.json`'s bus setup (its fixture still carries the BUS_MIX bytes until R0):
    // gains 1, 0.5, 0.25, voices on buses 1 and 2, one moved between them.
    assert_bit_identical("m4-s-bus", &|| {
        vec![
            Step::Recs(vec![config(&[ROOT, 0, 0]), dc(0x0001_0001, 1, 0.0), dc(0x0001_0002, 2, 0.0)]),
            Step::Mix(0, vec![(1.0, OFF), (0.5, OFF), (0.25, OFF)]),
            Step::Render(1),
            Step::Recs(vec![set_bus(0x0001_0001, 2)]),
            Step::Render(3),
        ]
    });
}
