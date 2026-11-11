//! 0166 M4-0, hook H1 (waves plan Contracts H1; tree A1; api-and-models §3.1; architecture §4.4):
//! the per-voice loop renders each voice in sub-ranges and the gain loops go through
//! `curves::due_gain`. With no due record nothing of that shows: no voice carries the `due` bit,
//! each voice renders in one range (`voiceSplits` stays 0), nothing splits the quantum
//! (`splitQuanta` stays 0), and the output is bit for bit what the core rendered before the hook.
//!
//! The digest below was recorded on the flip branch's base (`m4/in-voice` at `92969c11`, before
//! H1) by this same scene; a change to it is a change to unstamped rendering.

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

/// Recorded before H1 (see the module comment).
const UNSTAMPED_DIGEST: u64 = 0xfc25_84c0_769b_5f4b;
