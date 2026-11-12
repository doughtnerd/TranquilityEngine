//! 0166 M4-0, hook H1 (waves plan Contracts H1; tree A1; api-and-models §3.1; architecture §4.4):
//! the per-voice loop renders each voice in sub-ranges and the gain loops go through
//! `curves::due_gain`. With no due record nothing of that shows: no voice carries the `due` bit,
//! each voice renders in one range (`voiceSplits` stays 0), nothing splits the quantum
//! (`splitQuanta` stays 0), and the output is bit for bit what the core rendered before the hook.
//!
//! The digest below was recorded on the flip branch's base (`m4/in-voice` at `92969c11`, before
//! H1) by this same scene; a change to it is a change to unstamped rendering (F-21 made one: see
//! [`UNSTAMPED_DIGEST`]).

mod common;

use audio_core::due::FLAG2_DUE;
use audio_core::{status, voices};
use audio_wire::generated as wire;
use common::*;

const CLIPS: [u32; 3] = [11, 12, 13];

/// FNV-1a over the output's bits.
fn fnv(hash: &mut u64, samples: &[f32]) {
    for s in samples {
        for b in s.to_bits().to_le_bytes() {
            *hash ^= b as u64;
            *hash = hash.wrapping_mul(0x0100_0000_01B3);
        }
    }
}

fn raw(bytes: Vec<u8>) -> Rec {
    Rec::Raw(bytes)
}

fn fade(voice: u32, target: f32, frames: u32) -> Rec {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: voice, frame_offset: wire::ASAP, target, frames, flags: 0, shape: 0 }.write(&mut b, 0).unwrap();
    raw(b)
}

fn stop(voice: u32, fade_frames: u32) -> Rec {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: voice, frame_offset: wire::ASAP, fade_frames, reason: 0, shape: 0 }.write(&mut b, 0).unwrap();
    raw(b)
}

fn set_mixed(voice: u32, mixed: bool, gain: f32) -> Rec {
    let mut b = vec![0u8; wire::SetMixed::FIXED_END];
    wire::SetMixed { voice_id: voice, frame_offset: wire::ASAP, mixed: mixed as u32, gain, dir_x: 0.3, dir_y: 0.0, dir_z: -0.9, lp_hz: OFF, ..Default::default() }.write(&mut b, 0).unwrap();
    raw(b)
}

fn set_params(voice: u32, mask: u32, gain: f32, pitch: f32, dir: [f32; 3], ramp_frames: u32) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: wire::ASAP, mask, gain, pitch, dir_x: dir[0], dir_y: dir[1], dir_z: dir[2], lp_hz: OFF, ramp_frames, ..Default::default() })
}

/// A mixer with three generated clips: a slow sine, a saw and LCG noise, 3,000 frames each.
fn mixer() -> Mixer {
    let mut m = Mixer::new(4);
    let n = 3_000;
    let sine: Vec<f32> = (0..n).map(|k| (k as f32 * 0.031).sin() * 0.5).collect();
    let saw: Vec<f32> = (0..n).map(|k| ((k % 97) as f32 / 97.0 - 0.5) * 0.4).collect();
    let mut x = 0x1234_5678u32;
    let noise: Vec<f32> = (0..n)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 8) as f32 / (1u32 << 24) as f32 * 0.3 - 0.15
        })
        .collect();
    m.load_clip(CLIPS[0], &sine);
    m.load_clip(CLIPS[1], &saw);
    m.load_clip(CLIPS[2], &noise);
    m
}

fn voice(index: u32) -> u32 {
    0x0001_0000 | index
}

/// Ten voices (mixed and virtual, looping and not, spatial and plain, pitched), then asap records
/// every few quanta: gain, pitch and direction ramps, fades, a stop with a fade, a demote and a
/// promote. Returns the output digest; checks the hook's invariants every quantum.
fn unstamped_scene() -> u64 {
    let mut m = mixer();
    let mut recs = Vec::new();
    for i in 1..=10u32 {
        let mut flags = if i % 4 == 0 { 0 } else { MIXED };
        if i % 2 == 1 {
            flags |= LOOP;
        }
        if i % 3 == 0 {
            flags |= SPATIAL;
        }
        let Rec::Play(mut p) = play(voice(i), CLIPS[(i % 3) as usize], ROOT, flags) else { unreachable!() };
        p.pitch = 0.75 + 0.11 * i as f32;
        p.gain = 0.2 + 0.05 * i as f32;
        p.dir_x = 0.1 * i as f32 - 0.5;
        recs.push(Rec::Play(p));
    }
    m.submit(&recs);
    let mut hash = 0xCBF2_9CE4_8422_2325u64;
    for q in 0..96 {
        match q {
            5 => m.submit(&[set_params(voice(1), wire::SET_PARAMS_MASK_GAIN, 0.9, 1.0, [0.0; 3], 700)]),
            9 => m.submit(&[set_params(voice(3), wire::SET_PARAMS_MASK_PITCH | wire::SET_PARAMS_MASK_DIR, 0.0, 1.3, [0.7, 0.0, -0.7], 300)]),
            14 => m.submit(&[fade(voice(2), 0.25, 500), fade(voice(5), 0.0, 0)]),
            20 => m.submit(&[set_mixed(voice(4), true, 0.6)]),
            27 => m.submit(&[set_mixed(voice(6), false, 0.0)]),
            33 => m.submit(&[stop(voice(7), 400)]),
            41 => m.submit(&[fade(voice(5), 1.0, 1_000), set_params(voice(9), wire::SET_PARAMS_MASK_GAIN | wire::SET_PARAMS_MASK_PITCH, 0.4, 0.6, [0.0; 3], 200)]),
            60 => m.submit(&[stop(voice(1), 0), set_mixed(voice(6), true, 0.8)]),
            _ => {}
        }
        let (l, r) = m.render();
        fnv(&mut hash, &l);
        fnv(&mut hash, &r);
        assert!(voices::slots(&m.core).iter().all(|s| s.flags2 & FLAG2_DUE == 0), "quantum {q}: no voice is flagged");
        let c = &status::counters(&m.core).music;
        assert_eq!((c.voice_splits, c.split_quanta), (0, 0), "quantum {q}: one range per voice, no split");
    }
    hash
}

#[test]
fn with_no_due_records_every_voice_renders_in_one_range_bit_identical() {
    let digest = unstamped_scene();
    eprintln!("unstamped scene digest: {digest:#018x}");
    assert_eq!(digest, UNSTAMPED_DIGEST, "unstamped rendering changed");
}

/// Recorded before H1 (see the module comment), as `0xfc25_84c0_769b_5f4b`; re-recorded by F-21,
/// whose linear knots (`curves::linear_knot`) put the scene's gain and fade ramps back on their
/// lines at each quantum boundary: their worst error against the exact line at a quantum's end
/// went from 7.96e-6 to 3.37e-6 (the 1,000-frame fade, 7.96e-6 to 1.70e-6; the 700-frame gain ramp,
/// 5.99e-6 to 1.23e-6; the 500-frame fade, 4.03e-6 to 1.35e-6; the 400-frame stop, 8.8e-7 to 3.1e-7;
/// the worst, the 200-frame gain ramp's first quantum, is unchanged).
const UNSTAMPED_DIGEST: u64 = 0xfadf_8234_65e2_a3c9;

fn stamped(rec: Rec, frame_offset: u32) -> Rec {
    match rec {
        Rec::Play(mut p) => {
            p.frame_offset = frame_offset;
            Rec::Play(p)
        }
        Rec::Set(mut p) => {
            p.frame_offset = frame_offset;
            Rec::Set(p)
        }
        Rec::Raw(mut b) => {
            // Every record head keeps `frameOffset` at bytes 8..12.
            b[8..12].copy_from_slice(&frame_offset.to_le_bytes());
            Rec::Raw(b)
        }
        _ => unreachable!(),
    }
}

/// Z2a's acceptance: stamped per-voice records inside a quantum go into the due list and apply in
/// their voice, so nothing splits the quantum. Z2b: the class G records (the fade, the stop) apply
/// in the gain loop without a split; the pitch ramp (class S) splits voice 2 once.
#[test]
fn stamped_per_voice_records_split_only_their_voice() {
    let mut m = mixer();
    let recs: Vec<Rec> = (1..=6u32).map(|i| play(voice(i), CLIPS[(i % 3) as usize], ROOT, MIXED | LOOP)).collect();
    m.submit(&recs);
    m.render_n(2);
    // Frame 256 + 40 and 256 + 90: a fade and a pitch ramp on voice 2, a stop with a fade on voice 5.
    m.submit(&[
        stamped(fade(voice(2), 0.5, 64), 40),
        stamped(set_params(voice(2), wire::SET_PARAMS_MASK_PITCH, 0.0, 1.5, [0.0; 3], 32), 90),
        stamped(stop(voice(5), 100), 90),
    ]);
    assert_eq!(audio_core::scheduler::pending_len(&mut m.core), 3);
    m.render();
    let c = &status::counters(&m.core).music;
    assert_eq!(c.split_quanta, 0, "per-voice records never split the quantum");
    assert_eq!(c.voice_splits, 1, "voice 2 in two pieces (the pitch ramp), voice 5 in one");
    let s = voices::slots(&m.core);
    assert_eq!((s[2].fade.target, s[2].pitch.target), (0.5, 1.5), "both reached voice 2");
    assert_eq!(s[5].fade.target, 0.0, "the stop reached voice 5");
    assert!(s.iter().all(|s| s.flags2 & FLAG2_DUE == 0 || s.id == voice(2) || s.id == voice(5)), "only the targets are flagged");
    m.render();
    assert!(voices::slots(&m.core).iter().all(|s| s.flags2 & FLAG2_DUE == 0), "the bits last one quantum");
}

/// §3.1: "so does a quantum with more than 256 due records": the records past `DUE_RECORDS` split
/// the quantum, which counts once, and every record still applies, in order.
#[test]
fn past_the_due_list_a_quantum_splits_and_counts_once() {
    let mut m = mixer();
    m.submit(&[play(voice(1), CLIPS[0], ROOT, MIXED | LOOP)]);
    m.render();
    let n = audio_core::due::DUE_RECORDS + 4;
    let recs: Vec<Rec> = (0..n).map(|k| stamped(Rec::Set(wire::SetParams { voice_id: voice(1), mask: wire::SET_PARAMS_MASK_SCORE, score: k as f32, ..Default::default() }), 10 + (k / 64) as u32)).collect();
    m.submit(&recs);
    m.render();
    let c = &status::counters(&m.core).music;
    assert_eq!(c.split_quanta, 1);
    assert_eq!(voices::slots(&m.core)[1].score, (n - 1) as f32, "the last record applied last");
}

fn gain_at(voice_id: u32, gain: f32, frame_offset: u32) -> Rec {
    stamped(set_params(voice_id, wire::SET_PARAMS_MASK_GAIN, gain, 0.0, [0.0; 3], 0), frame_offset)
}

/// One frame's records keep their order across the due list and a quantum split: the last record
/// the list takes and the first one past it, both for one voice at one sample, apply in that order.
#[test]
fn one_frames_records_keep_their_order_across_the_list_and_a_split() {
    let mut m = mixer();
    m.submit(&[play(voice(1), CLIPS[0], ROOT, MIXED | LOOP), play(voice(2), CLIPS[1], ROOT, MIXED | LOOP)]);
    m.render();
    let mut recs: Vec<Rec> = (0..audio_core::due::DUE_RECORDS - 1).map(|_| gain_at(voice(2), 0.5, 5)).collect();
    recs.push(gain_at(voice(1), 0.3, 20)); // the list's last record
    recs.push(gain_at(voice(1), 0.6, 20)); // past the list: splits at 20
    m.submit(&recs);
    m.render();
    assert_eq!(status::counters(&m.core).music.split_quanta, 1);
    assert_eq!(voices::slots(&m.core)[1].gain.target, 0.6, "the later record wins");
}

/// A PLAY that replaces a held voice drops that voice's parked records (R10).
#[test]
fn a_play_replacing_a_held_voice_drops_its_parked_records() {
    use audio_core::layout::VOICE_SLOT_BYTES;
    let mut m = mixer();
    m.submit(&[play(voice(1), CLIPS[0], ROOT, MIXED | LOOP), play(voice(2), CLIPS[0], ROOT, MIXED | LOOP)]);
    m.render();
    for v in [1usize, 2] {
        m.core.regions_mut().voices[v * VOICE_SLOT_BYTES + core::mem::offset_of!(voices::VoiceSlot, flags2)] |= audio_core::groups::FLAG2_GATED;
    }
    m.submit(&[gain_at(voice(1), 0.3, 10), gain_at(voice(2), 0.4, 10)]);
    m.render();
    assert_eq!(audio_core::due::view(m.core.regions_mut()).parked().len(), 2);
    m.submit(&[play(0x0002_0001, CLIPS[1], ROOT, MIXED)]);
    let list = audio_core::due::view(m.core.regions_mut());
    assert_eq!(list.parked().iter().map(|r| r.voice_id).collect::<Vec<_>>(), vec![voice(2)], "only the replaced voice's went");
}

/// ADR 0167 §1.1 says a stamped spatial play with non-default effects splits the quantum because
/// its SET_VOICE_FX goes at the same frame (`coreBackend.ts` `sendPlay`, `voiceFx.ts` `onPlay`).
/// It doesn't, before or after M4-0: PLAY writes its slot at once and SET_VOICE_FX applies at once
/// (`fxpool::set_voice_fx` ignores its frame), so neither enters the pending queue.
#[test]
fn a_stamped_spatial_play_with_sends_queues_nothing_and_splits_nothing() {
    let mut m = mixer();
    m.render();
    let Rec::Play(mut p) = play(voice(3), CLIPS[1], ROOT, MIXED | SPATIAL) else { unreachable!() };
    p.dir_x = 0.6;
    p.dir_z = -0.8;
    let mut fx = vec![0u8; wire::SetVoiceFx::FIXED_END];
    wire::SetVoiceFx { voice_id: voice(3), frame_offset: 0, mask: wire::SET_VOICE_FX_MASK_SENDS | wire::SET_VOICE_FX_MASK_HP_HZ, ramp_frames: 0, hp_hz: 200.0, send: [0.5, 0.25, 0.0, 0.0], yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }.write(&mut fx, 0).unwrap();
    m.submit(&[stamped(Rec::Play(p), 300), stamped(raw(fx), 300)]);
    assert_eq!(audio_core::scheduler::pending_len(&mut m.core), 0, "nothing waits in the pending queue");
    m.render_n(4);
    let c = &status::counters(&m.core).music;
    assert_eq!((c.split_quanta, c.voice_splits), (0, 0));
}
