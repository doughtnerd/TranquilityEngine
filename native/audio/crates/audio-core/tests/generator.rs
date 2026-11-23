//! Generator voices through the core (ADR 0360 §3, ABI 5.1): a PLAY of a reserved clip id sounds with no clip
//! uploaded; GEN sets its parameters (at once before it starts, gliding after); pitch multiplies its frequencies;
//! SET_LOOP's release keys it off and it ends after its release; `length` keys it off in the core; the loop flag makes
//! it endless; a virtual voice advances its envelopes; AUTOMATE target 5 drives a parameter; the pool's exhaustion
//! starves a voice (silent, counted in STATUS `genStarved`) and silence is always virtual. Everything is heard through
//! the core's output (the master limiter's look-ahead shifts it, which these tests never need to align).

mod common;

use audio_core::{status, voices};
use audio_dsp::gen::{osc_p, synth_p};
use audio_wire::generated as wire;
use common::*;

const OSC: u32 = wire::GEN_CLIP_ID_FIRST + wire::GEN_KIND_OSCILLATOR;
const SYNTH: u32 = wire::GEN_CLIP_ID_FIRST + wire::GEN_KIND_SYNTH;
const BLIP: u32 = wire::GEN_CLIP_ID_FIRST + wire::GEN_KIND_BLIP;
const SILENCE: u32 = wire::GEN_CLIP_ID_FIRST + wire::GEN_KIND_SILENCE;
const V1: u32 = 1 << 16 | 1;
const V2: u32 = 1 << 16 | 2;

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

/// Frequency from rising zero crossings.
fn frequency(x: &[f32]) -> f32 {
    let (mut first, mut last, mut count) = (None, 0.0f32, 0);
    for i in 1..x.len() {
        if x[i - 1] < 0.0 && x[i] >= 0.0 {
            let t = (i - 1) as f32 + x[i - 1] / (x[i - 1] - x[i]);
            if first.is_none() {
                first = Some(t);
            } else {
                count += 1;
            }
            last = t;
        }
    }
    first.map_or(0.0, |f| count as f32 * RATE / (last - f))
}

fn raw(write: impl Fn(&mut [u8]) -> Result<usize, i32>) -> Rec {
    let mut b = vec![0u8; 4096];
    let n = write(&mut b).unwrap();
    b.truncate(n);
    Rec::Raw(b)
}

/// GEN for `voice`: `(index, value)` pairs, a seed (0 keeps) and a ramp.
fn gen(voice: u32, params: &[(usize, f32)], seed: u32, ramp: u32) -> Rec {
    let mut sorted = params.to_vec();
    sorted.sort_by_key(|p| p.0);
    let g = wire::Gen { voice_id: voice, frame_offset: wire::ASAP, mask: sorted.iter().fold(0, |m, p| m | 1 << p.0), seed, ramp_frames: ramp, values: sorted.iter().map(|p| p.1).collect() };
    raw(move |b| g.write(b, 0))
}

fn with_pitch(rec: Rec, pitch: f32) -> Rec {
    match rec {
        Rec::Play(p) => Rec::Play(wire::Play { pitch, ..p }),
        r => r,
    }
}

fn set_loop_release(voice: u32) -> Rec {
    let l = wire::SetLoop { voice_id: voice, frame_offset: wire::ASAP, loop_start_frame: 0, loop_end_frame: 0, flags: 0 };
    raw(move |b| l.write(b, 0))
}

fn set_mixed(voice: u32, mixed: bool) -> Rec {
    let s = wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: mixed as u32, gain: 1.0, dir_x: 0.0, dir_y: 0.0, dir_z: -1.0, lp_hz: OFF };
    raw(move |b| s.write(b, 0))
}

fn status_block(m: &mut Mixer) -> wire::StatusBlock {
    let mut out = vec![0u8; wire::STATUS_BUFFER_BYTES as usize];
    status::take(&mut m.core, &mut out, 0);
    wire::StatusBlock::read(&out, 0).unwrap().0
}

/// The quanta of `secs`.
fn quanta(secs: f32) -> usize {
    (secs * RATE / 128.0).ceil() as usize
}

#[test]
fn a_looping_oscillator_play_sounds_with_no_clip_uploaded() {
    let mut m = Mixer::new(4);
    m.submit(&[play(V1, OSC, ROOT, MIXED | LOOP)]);
    let (l, _) = m.render_n(40);
    // The oscillator's defaults: a 440 Hz sine at -12 dB (0.251 peak, 0.178 RMS), centred.
    let tail = &l[l.len() - 2_048..];
    assert!(rms(tail) > 0.1, "the oscillator sounds: rms {}", rms(tail));
    assert!((frequency(tail) - 440.0).abs() < 1.0, "{}", frequency(tail));
    assert_eq!(m.core.clips().len(), 1, "nothing was uploaded (only the DC clip the mixer loads)");
    assert!(!m.core.clips().is_resident(OSC));
}

#[test]
fn gen_before_the_start_sets_parameters_at_once_and_pitch_multiplies_frequencies() {
    let mut m = Mixer::new(4);
    m.submit(&[with_pitch(play(V1, OSC, ROOT, MIXED | LOOP), 2.0), gen(V1, &[(osc_p::FREQUENCY, 300.0), (osc_p::LEVEL, -6.0)], 0, 48_000)]);
    let (l, _) = m.render_n(40);
    let tail = &l[l.len() - 4_096..];
    assert!((frequency(tail) - 600.0).abs() < 1.0, "300 Hz at pitch 2: {}", frequency(tail));
    let peak = tail.iter().fold(0.0f32, |a, v| a.max(v.abs()));
    assert!((peak - 0.501).abs() < 0.01, "-6 dB from the first sample (no ramp before the start): {peak}");
    // SET_PARAMS pitch moves it as it moves a clip voice.
    m.submit(&[Rec::Set(wire::SetParams { voice_id: V1, frame_offset: wire::ASAP, mask: wire::SET_PARAMS_MASK_PITCH, pitch: 0.5, ..Default::default() })]);
    let (l, _) = m.render_n(40);
    assert!((frequency(&l[l.len() - 4_096..]) - 150.0).abs() < 0.5, "{}", frequency(&l[l.len() - 4_096..]));
}

#[test]
fn a_later_gen_glides_its_frequency_in_log2() {
    let mut m = Mixer::new(4);
    m.submit(&[play(V1, OSC, ROOT, MIXED | LOOP), gen(V1, &[(osc_p::FREQUENCY, 200.0)], 0, 0)]);
    m.render_n(20);
    // 200 Hz to 800 Hz over 0.5 s: halfway (a 50 ms window around 0.25 s) it is 400 Hz, not 500.
    m.submit(&[gen(V1, &[(osc_p::FREQUENCY, 800.0)], 0, 24_000)]);
    let (l, _) = m.render_n(quanta(0.6));
    let mid = 12_000 + bus_latency(&m);
    let f = frequency(&l[mid - 1_200..mid + 1_200]);
    assert!((f / 400.0 - 1.0).abs() < 0.03, "{f}");
    assert!((frequency(&l[l.len() - 2_400..]) - 800.0).abs() < 2.0);
}

fn bus_latency(m: &Mixer) -> usize {
    m.latency()
}

#[test]
fn the_release_keys_off_and_the_voice_ends_after_its_release() {
    let mut m = Mixer::new(4);
    m.submit(&[play(V1, OSC, ROOT, MIXED | LOOP), gen(V1, &[(osc_p::RELEASE, 100.0)], 0, 0)]);
    m.render_n(quanta(0.5));
    assert_eq!(voices::live_count(&mut m.core), 1);
    m.submit(&[set_loop_release(V1)]);
    // To -60 dB in 1.5 × 100 ms; it is gone by 0.2 s and still there at 0.1 s.
    m.render_n(quanta(0.1));
    assert_eq!(voices::live_count(&mut m.core), 1, "releasing");
    m.render_n(quanta(0.1));
    assert_eq!(voices::live_count(&mut m.core), 0, "ended after its release");
    assert!(status::counters(&m.core).ended.as_slice().contains(&V1));
    let (l, _) = m.render_n(4);
    assert!(l.iter().all(|&x| x.abs() < 1e-4));
}

#[test]
fn length_keys_off_in_the_core_and_the_loop_flag_makes_it_endless() {
    let mut m = Mixer::new(4);
    let p = [(osc_p::LENGTH, 0.25), (osc_p::RELEASE, 20.0)];
    m.submit(&[play(V1, OSC, ROOT, MIXED), gen(V1, &p, 0, 0), play(V2, OSC, 0, MIXED | LOOP), gen(V2, &p, 0, 0)]);
    m.render_n(quanta(0.24));
    assert_eq!(voices::live_count(&mut m.core), 2);
    // 0.25 s, then the 20 ms release to -60 dB (30 ms).
    m.render_n(quanta(0.05));
    assert_eq!(voices::live_count(&mut m.core), 1, "the one-shot keyed off at its length and ended");
    m.render_n(quanta(1.0));
    assert_eq!(voices::live_count(&mut m.core), 1, "the looping one runs on");
    m.submit(&[set_loop_release(V2)]);
    m.render_n(quanta(0.05));
    assert_eq!(voices::live_count(&mut m.core), 0);
}

#[test]
fn the_length_keys_off_on_its_sample() {
    // A 10 ms length with no release: the voice's last sample is the one before its 480th frame.
    let mut m = Mixer::new(4);
    m.submit(&[play(V1, OSC, ROOT, MIXED), gen(V1, &[(osc_p::LENGTH, 0.01), (osc_p::RELEASE, 0.0), (osc_p::ATTACK, 0.0), (osc_p::FREQUENCY, 1_000.0)], 0, 0)]);
    let (l, _) = m.render_n(8);
    let lat = m.latency();
    assert!(l[lat + 478].abs() > 1e-3 || l[lat + 477].abs() > 1e-3, "sounding just before 480");
    assert!(l[lat + 481..].iter().all(|&x| x == 0.0), "silent from 480 on");
    assert_eq!(voices::live_count(&mut m.core), 0);
}

#[test]
fn a_virtual_voice_advances_its_envelope_and_a_promote_resumes_from_there() {
    // A synth with a 400 ms linear attack, virtual for its first 200 ms, then promoted: it comes in at about half its
    // level (where a voice mixed from the start is then), not from the attack's start.
    // One sine (oscillator 2 mixed out: a detuned pair beats, and the promoted voice's oscillators restart in phase).
    let p = [(synth_p::AMP_ATTACK, 400.0), (synth_p::AMP_SUSTAIN, 100.0), (synth_p::FILTER_ENV_AMOUNT, 0.0), (synth_p::CUTOFF, 20_000.0), (synth_p::OSC1_WAVE, 0.0), (synth_p::OSC_MIX, 0.0)];
    let mut a = Mixer::new(4);
    a.submit(&[play(V1, SYNTH, ROOT, LOOP), gen(V1, &p, 0, 0)]);
    let mut b = Mixer::new(4);
    b.submit(&[play(V1, SYNTH, ROOT, MIXED | LOOP), gen(V1, &p, 0, 0)]);
    let (silent, _) = a.render_n(quanta(0.2));
    assert!(silent.iter().all(|&x| x == 0.0), "virtual: nothing rendered");
    b.render_n(quanta(0.2));
    a.submit(&[set_mixed(V1, true)]);
    let (la, _) = a.render_n(quanta(0.05));
    let (lb, _) = b.render_n(quanta(0.05));
    let (ra, rb) = (rms(&la[la.len() - 1_200..]), rms(&lb[lb.len() - 1_200..]));
    assert!(rb > 0.05 && (ra / rb - 1.0).abs() < 0.05, "promoted at {ra} against {rb} for the voice mixed throughout");
}

#[test]
fn automate_target_5_moves_a_generator_parameter() {
    let mut m = Mixer::new(4);
    // A log2 curve over global 0: 0 -> 2^8 = 256 Hz, 1 -> 2^10 = 1,024 Hz.
    let c = wire::Curves { voice_id: 0, frame_offset: wire::ASAP, first_curve: 0, curves: vec![wire::CurvesCurves { reserved: 0, keys: [(0.0f32, 8.0f32), (1.0, 10.0)].iter().map(|&(x, y)| wire::CurvesCurvesKeys { x, y, interp: 0, in_dx: 0.0, in_dy: 0.0, out_dx: 0.0, out_dy: 0.0 }).collect() }] };
    let param = |value: f32| {
        let p = wire::Param { voice_id: 0, frame_offset: wire::ASAP, group: 0, slot: 0, value, seek_per_second: 0.0 };
        raw(move |b| p.write(b, 0))
    };
    let target = wire::AUTO_TARGET_GEN | (osc_p::FREQUENCY as u32) << wire::AUTO_TARGET_GEN_PARAM_SHIFT | wire::AUTO_TARGET_LOG;
    let a = wire::Automate { voice_id: V1, frame_offset: wire::ASAP, bindings: vec![wire::AutomateBindings { param: 0x8000, curve: 0, target, offset: 0.0 }] };
    m.submit(&[raw(move |b| c.write(b, 0)), param(0.0), play(V1, OSC, ROOT, MIXED | LOOP), raw(move |b| a.write(b, 0))]);
    let (l, _) = m.render_n(40);
    assert!((frequency(&l[l.len() - 4_096..]) - 256.0).abs() < 1.0, "{}", frequency(&l[l.len() - 4_096..]));
    m.submit(&[param(0.5)]);
    let (l, _) = m.render_n(40);
    assert!((frequency(&l[l.len() - 4_096..]) - 512.0).abs() < 1.5, "{}", frequency(&l[l.len() - 4_096..]));
    // A GEN of the same parameter is overridden by the binding at the next quantum.
    m.submit(&[gen(V1, &[(osc_p::FREQUENCY, 3_000.0)], 0, 0)]);
    let (l, _) = m.render_n(40);
    assert!((frequency(&l[l.len() - 4_096..]) - 512.0).abs() < 1.5);
}

#[test]
fn a_full_pool_starves_a_voice_which_plays_silent_counts_and_still_ends() {
    // `params` lays out max_mixed 16: max(16, 16 / 4) = 16 entries.
    let mut m = Mixer::new(4);
    let mut recs = Vec::new();
    for k in 0..16u32 {
        recs.push(play(1 << 16 | (10 + k), OSC, ROOT, LOOP));
    }
    recs.push(play(V1, OSC, ROOT, MIXED | LOOP));
    m.submit(&recs);
    let (l, _) = m.render_n(20);
    assert!(l.iter().all(|&x| x == 0.0), "the 17th voice found no entry: it is silent");
    assert_eq!(status_block(&mut m).gen_starved, 1);
    // A starved voice keeps time and ends at its key-off.
    m.submit(&[set_loop_release(V1)]);
    m.render_n(2);
    assert_eq!(voices::live_count(&mut m.core), 16);
    // An entry freed by a voice that ended goes to the next PLAY.
    m.submit(&[Rec::Raw({
        let s = wire::Stop { voice_id: 1 << 16 | 10, frame_offset: wire::ASAP, fade_frames: 0, reason: 0, shape: 0 };
        let mut b = vec![0u8; 64];
        let n = s.write(&mut b, 0).unwrap();
        b.truncate(n);
        b
    })]);
    m.render();
    m.submit(&[play(V2, OSC, ROOT, MIXED | LOOP)]);
    let (l, _) = m.render_n(20);
    assert!(rms(&l[l.len() - 1_024..]) > 0.1, "the new voice took the freed entry");
    assert_eq!(status_block(&mut m).gen_starved, 1);
    // With the pool full again, two one-shot blips are both starved and end at their envelope's length (0.567 s).
    let mut recs = Vec::new();
    recs.push(play(1 << 16 | 40, BLIP, ROOT, MIXED));
    recs.push(play(1 << 16 | 41, BLIP, ROOT, MIXED));
    m.submit(&recs);
    m.render_n(quanta(0.5));
    assert_eq!(voices::live_count(&mut m.core), 18, "starved blips keep time silently");
    m.render_n(quanta(0.3));
    assert_eq!(voices::live_count(&mut m.core), 16, "both starved blips ended");
    assert_eq!(status_block(&mut m).gen_starved, 3);
}

#[test]
fn silence_is_always_virtual_and_ends_at_its_length() {
    let mut m = Mixer::new(4);
    m.submit(&[play(V1, SILENCE, ROOT, MIXED), gen(V1, &[(0, 0.1)], 0, 0), play(V2, SILENCE, ROOT, MIXED | LOOP), set_mixed(V2, true)]);
    m.render();
    let s = voices::slots(&m.core);
    assert_eq!(s[1].flags & voices::flag::MIXED, 0, "silence is never mixed, even asked to be");
    assert_eq!(s[2].flags & voices::flag::MIXED, 0);
    m.render_n(quanta(0.11));
    assert_eq!(voices::live_count(&mut m.core), 1, "the one-shot silence ended at 100 ms");
    m.render_n(quanta(2.0));
    assert_eq!(voices::live_count(&mut m.core), 1, "a looping silence lasts until its release");
    m.submit(&[set_loop_release(V2)]);
    m.render();
    assert_eq!(voices::live_count(&mut m.core), 0);
    assert_eq!(status_block(&mut m).gen_starved, 0, "silence takes no entry");
}

#[test]
fn a_blip_plays_to_its_envelope_s_end_and_the_loop_flag_repeats_it() {
    let mut m = Mixer::new(4);
    // sfxr's defaults: sustain 0.3, decay 0.4: (9,000 + 16,000 + 3) ticks at 44.1 kHz, 0.567 s.
    m.submit(&[play(V1, BLIP, ROOT, MIXED), play(V2, BLIP, ROOT, MIXED | LOOP)]);
    let (l, _) = m.render_n(quanta(0.3));
    assert!(rms(&l) > 0.02, "{}", rms(&l));
    m.render_n(quanta(0.3));
    assert_eq!(voices::live_count(&mut m.core), 1, "the one-shot ended, the looping one re-triggered");
    m.render_n(quanta(2.0));
    assert_eq!(voices::live_count(&mut m.core), 1);
    m.submit(&[set_loop_release(V2)]);
    m.render_n(quanta(0.6));
    assert_eq!(voices::live_count(&mut m.core), 0, "released, it played to its end");
}

#[test]
fn noise_follows_the_gen_seed() {
    let render = |seed: u32| {
        let mut m = Mixer::new(4);
        m.submit(&[play(V1, OSC, ROOT, MIXED | LOOP), gen(V1, &[(osc_p::WAVEFORM, 4.0), (osc_p::NOISE_COLOUR, 1.0)], seed, 0)]);
        m.render_n(8).0
    };
    assert_eq!(render(77), render(77));
    assert_ne!(render(77), render(78));
}

#[test]
fn gen_for_a_clip_voice_is_ignored_and_a_malformed_gen_refuses_the_batch() {
    let mut m = Mixer::new(4);
    m.submit(&[dc(V1, ROOT, 0.0), gen(V1, &[(0, 3.0)], 5, 0)]);
    let (l, _) = m.render_n(4);
    assert!(l[l.len() - 1] > 0.5, "the clip voice plays on");
    // valueCount past GEN_PARAMS_MAX (the writer refuses one, so the record is patched), and one past its length.
    let mut b = vec![0u8; 256];
    let g = wire::Gen { voice_id: V1, frame_offset: wire::ASAP, mask: u32::MAX, seed: 0, ramp_frames: 0, values: vec![0.0; 32] };
    let n = g.write(&mut b, 0).unwrap();
    b.truncate(n);
    let mut over = b.clone();
    over[24..28].copy_from_slice(&33u32.to_le_bytes());
    over.extend_from_slice(&[0; 4]);
    let words = (over.len() / 4) as u16;
    over[2..4].copy_from_slice(&words.to_le_bytes());
    assert_eq!(m.try_submit(&[Rec::Raw(over)]), wire::ERR_MALFORMED);
    let mut short = b.clone();
    short.truncate(28 + 4 * 31);
    let words = (short.len() / 4) as u16;
    short[2..4].copy_from_slice(&words.to_le_bytes());
    assert_eq!(m.try_submit(&[Rec::Raw(short)]), wire::ERR_MALFORMED);
    assert_eq!(m.try_submit(&[Rec::Raw(b)]), 0);
}

#[test]
fn a_generator_voice_mixes_through_its_bus() {
    // Bus 1 under the root at half gain: the generator follows the bus's gain as a clip voice would.
    let mut a = Mixer::new(4);
    a.submit(&[config(&[ROOT, 0]), play(V1, OSC, 1, MIXED | LOOP)]);
    let mut b = Mixer::new(4);
    b.submit(&[config(&[ROOT, 0]), Rec::Ramps(vec![lane_ramp(1, wire::LANE_RUNTIME, Some(0.5), None, 0)]), play(V1, OSC, 1, MIXED | LOOP)]);
    let (la, _) = a.render_n(40);
    let (lb, _) = b.render_n(40);
    let (ra, rb) = (rms(&la[la.len() - 2_048..]), rms(&lb[lb.len() - 2_048..]));
    assert!((rb / ra - 0.5).abs() < 0.01, "{rb} / {ra}");
}
