//! ADR 0362's goldens: a sequence clip's reverse and Amp envelope played by the core are **bit-identical** to the same
//! sample baked by the offline render (the catalogue's `reverse` and `envelope` effects), so a bake or an export of a
//! reversed or enveloped clip sounds as the Studio played it. A mono clip of noise is played through a real core (a
//! PLAY on the root bus at gain and pitch 1, not spatial: the voice's samples reach the output untouched, after the
//! master limiter's look-ahead delay, which passes these levels) and rendered offline; every frame must match bit for
//! bit, and the core must be silent after the clip.

use audio_core::layout::{Layout, PAGE_BYTES};
use audio_core::params::InitParams;
use audio_core::clips::ClipFormat;
use audio_core::{bus, scheduler, voices, Core, QUANTUM};
use audio_dsp::adsr::Adsr;
use audio_dsp::fx::PARAMS;
use audio_wire::generated as wire;
use myco_audio_offline::render::{envelope_of, render};
use myco_audio_offline::spec::{FxSpec, Op, Spec};

const RATE: f32 = 48_000.0;
const V1: u32 = 1 << 16 | 1;
const CLIP: u32 = 7;

fn new_core() -> Core {
    let p = InitParams { sample_rate: RATE, max_logical: 64, max_mixed: 16, max_buses: 4, ..InitParams::default() };
    let layout = Layout::new(&p);
    let block = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
    // SAFETY: non-zero size, zeroed, page-aligned; leaked on purpose ('static).
    let base = unsafe { std::alloc::alloc_zeroed(block) };
    // SAFETY: `base` is a fresh block of `layout.total()` zeroed bytes, aligned to PAGE_BYTES.
    unsafe { Core::new(p, layout, base) }
}

/// Deterministic noise in ±0.4 (under the master limiter).
fn noise(n: usize) -> Vec<f32> {
    let mut s = 0x1234_5678u32;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s >> 8) as f32 / (1u32 << 24) as f32 * 0.8 - 0.4
        })
        .collect()
}

/// The core's left channel for `clip` played once by a PLAY with `flags`, then `extra` records; until it ends and
/// a few quanta more. Also the output latency.
fn core_render(clip: &[f32], flags: u16, extra: &[Vec<u8>]) -> (Vec<f32>, usize) {
    let mut core = new_core();
    core.clips_mut().reserve(CLIP, clip.len() as u32, 1, RATE, ClipFormat::F32).unwrap();
    let bytes: Vec<u8> = clip.iter().flat_map(|s| s.to_le_bytes()).collect();
    core.clips_mut().write(CLIP, 0, &bytes).unwrap();
    let latency = bus::output_latency_frames(&core) as usize;
    let mut buf = vec![0u8; 32 + 4096];
    let mut at = 32;
    let play = wire::Play { voice_id: V1, frame_offset: wire::ASAP, clip: CLIP, bus: wire::BUS_ROOT as u16, flags: wire::PLAY_FLAGS_MIXED | flags, gain: 1.0, pitch: 1.0, dir_z: -1.0, lp_hz: wire::BUS_LP_OFF_HZ as f32, ..Default::default() };
    at += play.write(&mut buf, at).unwrap();
    for r in extra {
        buf[at..at + r.len()].copy_from_slice(r);
        at += r.len();
    }
    buf.truncate(at);
    wire::Envelope::new(wire::kind::BATCH, 1, (buf.len() - 16) as u32).write(&mut buf, 0).unwrap();
    wire::BatchHeader { first_frame: 0.0, count: 1 + extra.len() as u32, flags: 0 }.write(&mut buf, 0).unwrap();
    assert_eq!(scheduler::submit(&mut core, &buf), 0, "the batch was refused");
    let (mut l, mut frame, mut after) = (Vec::new(), 0u64, None);
    while l.len() < clip.len() + latency + 64 * QUANTUM {
        let out = core.process(frame);
        l.extend_from_slice(&out[..QUANTUM]);
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
    (l, latency)
}

fn offline(clip: &[f32], op: Op, p: &[f32]) -> Vec<f32> {
    let mut params = [0.0f32; PARAMS];
    params[..p.len()].copy_from_slice(p);
    let spec = Spec { effects: vec![FxSpec { op, on: true, p: params }], lanes: vec![], segments: vec![], tail_cap: 10.0 };
    render(clip, 1, RATE, &spec).pcm
}

fn assert_bit_identical(what: &str, off: &[f32], core: &[f32], latency: usize) {
    assert!(core.len() >= latency + off.len(), "{what}: the core rendered {} frames, the offline {}", core.len(), off.len());
    assert!(core[..latency].iter().all(|&x| x == 0.0));
    for (i, &x) in off.iter().enumerate() {
        let a = core[latency + i];
        // The core's buses add into zeroed buffers, so a -0 (a negative sample at a gain of 0) arrives as +0.
        assert!(a.to_bits() == x.to_bits() || (a == 0.0 && x == 0.0), "{what}: frame {i}: core {a}, offline {x}");
    }
    assert!(core[latency + off.len()..].iter().all(|&x| x == 0.0), "{what}: the core is silent after the clip");
}

#[test]
fn a_reversed_clip_matches_the_offline_reverse_bit_for_bit() {
    let clip = noise(10_007);
    let off = offline(&clip, Op::Reverse, &[]);
    assert_eq!(off.len(), clip.len());
    let (core, latency) = core_render(&clip, wire::PLAY_FLAGS_REVERSE, &[]);
    assert_bit_identical("reverse", &off, &core, latency);
}

fn amp_envelope(e: Adsr) -> Vec<u8> {
    let rec = wire::AmpEnvelope {
        voice_id: V1,
        frame_offset: wire::ASAP,
        flags: wire::AMP_ENV_ON,
        attack_frames: e.attack,
        hold_frames: e.hold,
        decay_frames: e.decay,
        sustain: e.sustain,
        release_frames: e.release,
        key_off_frame: e.key_off,
        offset_frames: 0,
    };
    let mut b = vec![0u8; 64];
    let n = rec.write(&mut b, 0).unwrap();
    b.truncate(n);
    b
}

#[test]
fn an_enveloped_clip_matches_the_offline_envelope_bit_for_bit() {
    let clip = noise(20_011);
    // Attack 12 ms, hold 3 ms, decay 40 ms to 35 %, release 80 ms; and a set too long for the clip (squeezed).
    for p in [[12.0f32, 3.0, 40.0, 35.0, 80.0], [150.0, 100.0, 200.0, 60.0, 300.0]] {
        let off = offline(&clip, Op::Envelope, &p);
        let mut params = [0.0f32; PARAMS];
        params[..5].copy_from_slice(&p);
        let e = envelope_of(&params, clip.len(), RATE);
        let (core, latency) = core_render(&clip, 0, &[amp_envelope(e)]);
        assert_bit_identical("envelope", &off, &core, latency);
    }
}

#[test]
fn a_reversed_enveloped_clip_matches_reverse_then_envelope() {
    let clip = noise(9_001);
    let p = [5.0f32, 0.0, 20.0, 50.0, 30.0];
    let mut params = [0.0f32; PARAMS];
    params[..5].copy_from_slice(&p);
    let reversed = offline(&clip, Op::Reverse, &[]);
    let off = offline(&reversed, Op::Envelope, &p);
    let (core, latency) = core_render(&clip, wire::PLAY_FLAGS_REVERSE, &[amp_envelope(envelope_of(&params, clip.len(), RATE))]);
    assert_bit_identical("reverse and envelope", &off, &core, latency);
}
