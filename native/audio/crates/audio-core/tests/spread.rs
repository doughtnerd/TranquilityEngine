//! ADR 0347 per-voice spread (SET_VOICE_FX `spread`, ABI 4.11) through the real render path: a
//! positioned noise voice's interaural correlation falls from 1 towards 0 as its spread grows, its
//! power stays, a spread of 0 is the panner bit for bit, a stereo voice keeps its image, a spread
//! change ramps without a click, and a non-spatial voice ignores it.

mod common;

use audio_wire::generated as wire;
use common::*;

const V1: u32 = 0x0001_0001;
const NOISE: u32 = 2;
const STEREO: u32 = 3;
const SINE: u32 = 4;

fn noise(n: usize, seed: u32) -> Vec<f32> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s = s.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            0.25 * ((s as f64 / 4_294_967_296.0) * 2.0 - 1.0) as f32
        })
        .collect()
}

fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    m.set_lookahead(0.0);
    m.load_clip(NOISE, &noise(48_000, 1));
    // A stereo clip: left noise, right a different noise (uncorrelated channels).
    let (l, r) = (noise(48_000, 7), noise(48_000, 99));
    let inter: Vec<f32> = l.iter().zip(&r).flat_map(|(a, b)| [*a, *b]).collect();
    m.core.clips_mut().reserve(STEREO, 48_000, 2, RATE, audio_core::clips::ClipFormat::F32).unwrap();
    let bytes: Vec<u8> = inter.iter().flat_map(|s| s.to_le_bytes()).collect();
    m.core.clips_mut().write(STEREO, 0, &bytes).unwrap();
    let sine: Vec<f32> = (0..4_800).map(|i| 0.25 * (std::f32::consts::TAU * i as f32 / 48.0).sin()).collect();
    m.load_clip(SINE, &sine);
    m
}

fn spatial_play(clip: u32, dir: [f32; 3]) -> Rec {
    let Rec::Play(mut p) = play(V1, clip, 0, MIXED | LOOP | SPATIAL) else { unreachable!() };
    (p.dir_x, p.dir_y, p.dir_z) = (dir[0], dir[1], dir[2]);
    Rec::Play(p)
}

fn spread(deg: f32, ramp_frames: u32) -> Rec {
    let mut b = vec![0u8; wire::SetVoiceFx::FIXED_END];
    let centi = (deg * 100.0).round() as u16;
    wire::SetVoiceFx { voice_id: V1, frame_offset: wire::ASAP, mask: wire::SET_VOICE_FX_MASK_SPREAD, ramp_frames, hp_hz: 0.0, send: [0.0; 4], yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, spread: centi }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

fn corr(a: &[f32], b: &[f32]) -> f64 {
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for (x, y) in a.iter().zip(b) {
        ab += (*x as f64) * (*y as f64);
        aa += (*x as f64) * (*x as f64);
        bb += (*y as f64) * (*y as f64);
    }
    ab / (aa * bb).sqrt()
}

fn power(x: &[f32]) -> f64 {
    x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64
}

/// Left and right of a voice on `clip` at `dir` with `deg` of spread, after a settling second.
fn heard(clip: u32, dir: [f32; 3], deg: f32) -> (Vec<f32>, Vec<f32>) {
    let mut m = mixer();
    m.submit(&[spatial_play(clip, dir), spread(deg, 0)]);
    m.render_n(40);
    m.render_n(300)
}

const AHEAD: [f32; 3] = [0.0, 0.0, -1.0];

#[test]
fn interaural_correlation_falls_as_the_spread_grows_and_power_stays() {
    let mut last = 2.0;
    let (l0, r0) = heard(NOISE, AHEAD, 0.0);
    let p0 = power(&l0) + power(&r0);
    for deg in [0.0f32, 45.0, 90.0, 180.0, 270.0, 360.0] {
        let (l, r) = heard(NOISE, AHEAD, deg);
        let c = corr(&l, &r);
        eprintln!("spread {deg:>5}: correlation {c:.3}, power {:.3} of the point's", (power(&l) + power(&r)) / p0);
        assert!(c < last - 0.05 || deg == 0.0, "spread {deg}: correlation {c} not below {last}");
        last = c;
        assert!(((power(&l) + power(&r)) / p0 - 1.0).abs() < 0.05, "spread {deg}: power");
    }
    assert!(last.abs() < 0.1, "360 degrees reads decorrelated: {last}");
}

#[test]
fn zero_spread_is_the_panner_bit_for_bit() {
    let mut a = mixer();
    a.submit(&[spatial_play(NOISE, [0.6, 0.0, -0.8])]);
    let plain = a.render_n(20);
    let mut b = mixer();
    b.submit(&[spatial_play(NOISE, [0.6, 0.0, -0.8]), spread(0.0, 0)]);
    let zero = b.render_n(20);
    assert_eq!(plain.0.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), zero.0.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
    assert_eq!(plain.1.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), zero.1.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
}

#[test]
fn a_narrow_spread_keeps_the_direction_and_a_stereo_voice_keeps_its_image() {
    // 30 degrees to the right: the right ear stays louder.
    let (l, r) = heard(NOISE, [0.5, 0.0, -0.866], 60.0);
    assert!(power(&r) > 1.5 * power(&l), "{} {}", power(&l), power(&r));
    // A stereo voice ahead with a full spread: its left channel stays on the left ear, its right on the right.
    let (l, r) = heard(STEREO, AHEAD, 360.0);
    let c = corr(&l, &r);
    assert!(c.abs() < 0.1, "uncorrelated channels stay uncorrelated: {c}");
    assert!((power(&l) / power(&r) - 1.0).abs() < 0.1, "a centred stereo image stays balanced");
}

#[test]
fn a_spread_change_ramps_without_a_click() {
    let mut m = mixer();
    m.submit(&[spatial_play(SINE, AHEAD)]);
    let (before, _) = m.render_n(8);
    m.submit(&[spread(360.0, 4_800)]);
    let (during, _) = m.render_n(60);
    let step = |x: &[f32]| x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
    let sine_step = step(&before);
    assert!(step(&during) < 1.5 * sine_step, "{} vs the sine's {}", step(&during), sine_step);
}

#[test]
fn a_flat_voice_ignores_spread() {
    let mut a = mixer();
    a.submit(&[play(V1, NOISE, 0, MIXED | LOOP)]);
    let plain = a.render_n(10);
    let mut b = mixer();
    b.submit(&[play(V1, NOISE, 0, MIXED | LOOP), spread(360.0, 0)]);
    let spread_flat = b.render_n(10);
    assert_eq!(plain, spread_flat);
}
