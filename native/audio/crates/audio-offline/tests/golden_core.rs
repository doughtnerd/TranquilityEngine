//! ADR 0360 §6's golden: at pitch 1 with no lanes, `myco_offline_generate` is **bit-identical** to the core's generator
//! voice. Each kind is played through a real core (a PLAY of its reserved clip id and a GEN with every parameter, as the
//! runtime sends them, on the root bus at gain 1, not spatial) and rendered offline with the same parameters and seed;
//! the core's output (both channels, after the master limiter's look-ahead delay, which passes these levels untouched)
//! must equal the offline render sample for sample, bit for bit, and be silent after it. Lengths that fall inside a
//! quantum check the key-off split; noise checks the seed. Also: length and release, and seed determinism.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::{bus, scheduler, voices, Core, QUANTUM};
use audio_dsp::gen::{self, blip, osc_p, synth_p};
use audio_wire::generated as wire;
use myco_audio_offline::generate::{generate, GenSpec};

const RATE: f32 = 48_000.0;
const V1: u32 = 1 << 16 | 1;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 16, max_buses: 4, arena_initial_bytes: 0, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// A BATCH of a generator PLAY (mixed, not looping, root bus, gain and pitch 1) and its GEN with every value.
fn play_batch(kind: u32, values: &[f32], seed: u32) -> Vec<u8> {
    let mut buf = vec![0u8; 32 + 4096];
    let mut at = 32;
    let play = wire::Play { voice_id: V1, frame_offset: wire::ASAP, clip: wire::GEN_CLIP_ID_FIRST + kind, bus: wire::BUS_ROOT as u16, flags: wire::PLAY_FLAGS_MIXED, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, ..Default::default() };
    at += play.write(&mut buf, at).unwrap();
    let mask = if values.len() >= 32 { u32::MAX } else { (1u32 << values.len()) - 1 };
    let g = wire::Gen { voice_id: V1, frame_offset: wire::ASAP, mask, seed, ramp_frames: 0, values: values.to_vec() };
    at += g.write(&mut buf, at).unwrap();
    buf.truncate(at);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: 0.0, count: 2, flags: 0 }.write(&mut buf, 0).unwrap();
    buf
}

/// The core's output for one generator voice: until it ends, plus the latency and a few quanta more. Left, right, and
/// the output latency in frames.
fn core_render(kind: u8, values: &[f32], seed: u32, max_seconds: f32) -> (Vec<f32>, Vec<f32>, usize) {
    let mut core = new_core();
    let latency = bus::output_latency_frames(&core) as usize;
    assert_eq!(scheduler::submit(&mut core, &play_batch(kind as u32, values, seed)), 0, "the batch was refused");
    let (mut l, mut r) = (Vec::new(), Vec::new());
    let mut frame = 0u64;
    let mut after = None;
    let max = (max_seconds * RATE) as usize;
    while l.len() < max {
        let out = core.process(frame);
        l.extend_from_slice(&out[..QUANTUM]);
        r.extend_from_slice(&out[QUANTUM..2 * QUANTUM]);
        frame += QUANTUM as u64;
        if after.is_none() && voices::live_count(&mut core) == 0 {
            after = Some(latency / QUANTUM + 4);
        }
        if let Some(n) = after.as_mut() {
            if *n == 0 {
                break;
            }
            *n -= 1;
        }
    }
    (l, r, latency)
}

/// Every parameter of `kind` at its default, then `set` applied by index.
fn values(kind: u8, set: &[(usize, f32)]) -> Vec<f32> {
    let mut v: Vec<f32> = gen::params(kind).iter().map(|s| s.default).collect();
    for &(i, x) in set {
        v[i] = x;
    }
    v
}

fn offline(kind: u8, values: &[f32], seed: u32, seconds: f32) -> Vec<f32> {
    generate(kind, values, seed, RATE, (seconds * RATE) as usize, &GenSpec::default()).expect("a render").pcm
}

/// The golden: the offline render equals the core's output bit for bit, and the core is silent after it.
fn assert_bit_identical(what: &str, kind: u8, values: &[f32], seed: u32, seconds: f32) -> usize {
    let off = offline(kind, values, seed, seconds);
    let (l, r, latency) = core_render(kind, values, seed, seconds);
    assert!(off.len() > 1_000, "{what}: the offline render sounds ({} frames)", off.len());
    assert!(l.len() >= latency + off.len(), "{what}: the core rendered {} frames, the offline {}", l.len(), off.len());
    for (i, &x) in off.iter().enumerate() {
        let (a, b) = (l[latency + i], r[latency + i]);
        assert!(a.to_bits() == x.to_bits() && b.to_bits() == x.to_bits(), "{what}: frame {i}: core {a} / {b}, offline {x}");
    }
    let tail = &l[latency + off.len()..];
    assert!(tail.iter().all(|&x| x == 0.0), "{what}: the core is silent after the offline render ends");
    assert!(l[..latency].iter().all(|&x| x == 0.0));
    off.len()
}

#[test]
fn oscillators_match_the_core_bit_for_bit() {
    // A saw keyed off by a length inside a quantum (4,978 frames), with every envelope stage.
    let saw = values(gen::OSCILLATOR, &[(osc_p::WAVEFORM, 2.0), (osc_p::FREQUENCY, 330.0), (osc_p::LEVEL, -9.0), (osc_p::ATTACK, 5.0), (osc_p::DECAY, 50.0), (osc_p::SUSTAIN, 60.0), (osc_p::RELEASE, 40.0), (osc_p::LENGTH, 0.1037)]);
    assert_bit_identical("saw", gen::OSCILLATOR, &saw, 11, 1.0);
    let square = values(gen::OSCILLATOR, &[(osc_p::WAVEFORM, 1.0), (osc_p::PULSE_WIDTH, 30.0), (osc_p::FREQUENCY, 1234.5), (osc_p::LENGTH, 0.25)]);
    assert_bit_identical("square", gen::OSCILLATOR, &square, 3, 1.0);
    let sine = values(gen::OSCILLATOR, &[(osc_p::LENGTH, 0.05)]);
    assert_bit_identical("sine at its defaults", gen::OSCILLATOR, &sine, 1, 1.0);
    let tri = values(gen::OSCILLATOR, &[(osc_p::WAVEFORM, 3.0), (osc_p::FREQUENCY, 97.0), (osc_p::LENGTH, 0.3), (osc_p::RELEASE, 200.0)]);
    assert_bit_identical("triangle", gen::OSCILLATOR, &tri, 5, 1.5);
}

#[test]
fn noise_matches_the_core_bit_for_bit_with_its_seed() {
    for colour in 0..3 {
        let noise = values(gen::OSCILLATOR, &[(osc_p::WAVEFORM, 4.0), (osc_p::NOISE_COLOUR, colour as f32), (osc_p::LENGTH, 0.2)]);
        assert_bit_identical("noise", gen::OSCILLATOR, &noise, 0xDEAD_BEEF, 1.0);
    }
}

#[test]
fn synths_match_the_core_bit_for_bit() {
    let lead = values(gen::SYNTH, &[(synth_p::LENGTH, 0.2), (synth_p::AMP_RELEASE, 100.0)]);
    assert_bit_identical("synth at its defaults", gen::SYNTH, &lead, 9, 1.0);
    // An LFO on the cutoff, a band-pass and a square with noise in the mix.
    let swept = values(gen::SYNTH, &[(synth_p::OSC1_WAVE, 1.0), (synth_p::OSC2_WAVE, 4.0), (synth_p::FILTER_TYPE, 2.0), (synth_p::LFO_DEPTH, 40.0), (synth_p::LFO_TARGET, 1.0), (synth_p::LFO_RATE, 7.0), (synth_p::LENGTH, 0.31), (synth_p::AMP_RELEASE, 80.0)]);
    assert_bit_identical("swept synth", gen::SYNTH, &swept, 77, 1.0);
}

#[test]
fn blips_match_the_core_bit_for_bit() {
    use blip::p;
    // A coin: a square with an arpeggio jump.
    let coin = values(gen::BLIP, &[(p::BASE_FREQUENCY, 0.45), (p::SUSTAIN, 0.08), (p::PUNCH, 0.4), (p::DECAY, 0.3), (p::ARPEGGIO_AMOUNT, 0.5), (p::ARPEGGIO_SPEED, 0.6)]);
    assert_bit_identical("coin", gen::BLIP, &coin, 1734, 3.0);
    // A laser: a saw sliding down, the low-pass swept, the phaser on.
    let laser = values(gen::BLIP, &[(p::WAVEFORM, 1.0), (p::BASE_FREQUENCY, 0.7), (p::SLIDE, -0.3), (p::DECAY, 0.25), (p::LOWPASS_CUTOFF, 0.6), (p::LOWPASS_SWEEP, -0.1), (p::PHASER_OFFSET, 0.2), (p::PHASER_SWEEP, -0.1), (p::HIGHPASS_CUTOFF, 0.1)]);
    assert_bit_identical("laser", gen::BLIP, &laser, 42, 3.0);
    // An explosion: noise.
    let boom = values(gen::BLIP, &[(p::WAVEFORM, 3.0), (p::BASE_FREQUENCY, 0.1), (p::SUSTAIN, 0.3), (p::DECAY, 0.4), (p::PUNCH, 0.5)]);
    assert_bit_identical("explosion", gen::BLIP, &boom, 99, 4.0);
}

#[test]
fn a_silence_is_its_length_of_zeros() {
    let v = values(gen::SILENCE, &[(gen::silence_p::LENGTH, 0.25)]);
    let out = offline(gen::SILENCE, &v, 1, 10.0);
    assert_eq!(out.len(), 12_000);
    assert!(out.iter().all(|&x| x == 0.0));
    assert_eq!(offline(gen::SILENCE, &v, 1, 0.1).len(), 4_800, "capped by the frames asked for");
}

#[test]
fn the_envelope_ends_at_length_then_releases() {
    // A sine at 0 dB, sustain 100 %, keyed off at 0.1 s with a 50 ms release.
    let v = values(gen::OSCILLATOR, &[(osc_p::LEVEL, 0.0), (osc_p::LENGTH, 0.1), (osc_p::RELEASE, 50.0)]);
    let out = offline(gen::OSCILLATOR, &v, 1, 2.0);
    let peak = |a: usize, b: usize| out[a..b].iter().fold(0.0f32, |m, x| m.max(x.abs()));
    assert!(peak(3_800, 4_800) > 0.99, "full level before the key-off: {}", peak(3_800, 4_800));
    // 50 ms after the key-off the release has fallen to about 1 % of its span; the voice ends soon after.
    assert!(peak(4_800 + 2_300, 4_800 + 2_500) < 0.05, "{}", peak(4_800 + 2_300, 4_800 + 2_500));
    assert!(out.len() > 4_800 + 2_400 && out.len() < 4_800 + 6_000, "ends after its release: {} frames", out.len());
    // An endless oscillator (length 0) renders exactly the frames asked for.
    let endless = values(gen::OSCILLATOR, &[]);
    assert_eq!(offline(gen::OSCILLATOR, &endless, 1, 0.5).len(), 24_000);
}

#[test]
fn the_same_seed_renders_the_same_samples_and_another_differs() {
    let v = values(gen::OSCILLATOR, &[(osc_p::WAVEFORM, 4.0), (osc_p::LENGTH, 0.1)]);
    let a = offline(gen::OSCILLATOR, &v, 1234, 1.0);
    let b = offline(gen::OSCILLATOR, &v, 1234, 1.0);
    let c = offline(gen::OSCILLATOR, &v, 1235, 1.0);
    assert_eq!(a.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), b.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
    assert!(a.iter().zip(&c).any(|(x, y)| x != y), "another seed, other noise");
}

#[test]
fn a_parameter_lane_and_pitch_move_the_render() {
    use myco_audio_offline::generate::parse;
    // A sine at 200 Hz with a frequency lane from 200 to 800 Hz over 1 s (log2 keys), and the same at pitch 2.
    let v = values(gen::OSCILLATOR, &[(osc_p::FREQUENCY, 200.0)]);
    let lane = [1.0, 1.0, 1.0, osc_p::FREQUENCY as f64, 20.0, 20_000.0, 1.0, 2.0, 0.0, 200f64.log2(), 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 800f64.log2(), 0.0, 0.0, 0.0, 0.0, 0.0];
    let spec = parse(&lane).expect("a spec");
    let out = generate(gen::OSCILLATOR, &v, 1, RATE, 48_000, &spec).unwrap().pcm;
    let crossings = |x: &[f32]| x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    let (early, late) = (crossings(&out[..4_800]), crossings(&out[43_200..]));
    assert!((19..=23).contains(&early), "about 200 Hz at the start: {early}");
    assert!((74..=82).contains(&late), "about 800 Hz at the end: {late}");
    let mut p2 = lane;
    p2[1] = 2.0;
    let out2 = generate(gen::OSCILLATOR, &v, 1, RATE, 48_000, &parse(&p2).unwrap()).unwrap().pcm;
    assert!((38..=46).contains(&crossings(&out2[..4_800])), "pitch 2 doubles it: {}", crossings(&out2[..4_800]));
}
