//! 0166 M4-0, class S records: the voice-local split (Z2c; api-and-models §3.1 "Class G and class
//! S"; architecture §4.4 "`render`" step 3; ADR 0167 §1.1; rulings R2, R3; tree A1, hook H1).
//!
//! Class S is every per-voice record that isn't gain-like: SET_PARAMS with pitch, low-pass
//! (`lpHz`), direction, score, bus or flag bits; SET_VOICE_FX; SET_PAUSED; SEEK; SET_LOOP. A stamped
//! one inside a quantum goes into the due list (Z2a) and applies by splitting **that voice's**
//! render at its sample (`voice_split::boundaries`, Z2c; `voices::render_due_voice`, H1): the voice
//! renders `[from, k)`, the record applies, then `[k, to)`. The quantum renders once, so
//! `splitQuanta` stays 0 and each extra render of the voice counts once in `voiceSplits`.
//!
//! **SET_VOICE_FX (build log D7).** A stamped SET_VOICE_FX applies at once at submit today
//! (`fxpool::set_voice_fx` ignores its frame) and never enters the pending queue or the due list;
//! its case pins that behaviour (no split of either kind), it does not test a split.
//!
//! Every case uses the same frame: the record is stamped at sample [`K`] of the second quantum
//! (absolute frame `QUANTUM + K`), so the voices are already running when it lands. "The other
//! voices are untouched" means their `VoiceSlot`s after the quantum are byte-identical to those of
//! a twin mixer that got the same submits without the record.
//!
//! Leaf **L-Z2ca** fills these cases. Helpers to copy, not import (test files share only
//! `common/`): the record builders in `due_list.rs` (`pitch_at`, `paused_at`, `seek_at`, `loop_at`,
//! `played`, `submit_abs`, `per_voice_case`'s expectations), `stamped` and the spatial-with-sends
//! scene in `in_voice_hooks.rs`, the aux-bus send set-up in `sends.rs`.

#![allow(unused_imports, dead_code)]

mod common;

use audio_core::due::FLAG2_DUE;
use audio_core::scheduler;
use audio_core::layout::VOICE_SLOT_BYTES;
use audio_core::{status, voices, Core, QUANTUM};
use audio_wire::generated as wire;
use common::*;

/// The record's sample inside the quantum it lands in.
const K: usize = 50;
const V1: u32 = 0x0001_0001;
const V2: u32 = 0x0001_0002;
const V3: u32 = 0x0001_0003;
const V4: u32 = 0x0001_0004;
const V5: u32 = 0x0001_0005;
/// The ramp clip of `due_list.rs`: frame `k` is `k / 100_000`.
const RAMP: u32 = 2;
const RAMP_FRAMES: usize = 2_000;
/// A bright clip, the saw of `in_voice_hooks.rs`.
const SAW: u32 = 3;
const SAW_FRAMES: usize = 4_000;
const TOL_OUT: f32 = 1e-6;
/// The 5 ms mix fade a pause or a seek of a mixed voice ramps over.
const MIX_FADE: usize = 240;

/// The ramp clip's sample at frame `p`.
fn c(p: usize) -> f32 {
    p as f32 / 100_000.0
}

/// A mixer over no look-ahead (its frames are core frames), with the ramp and saw clips loaded.
/// (`Mixer::new` loads the DC clip, id 1.)
fn quiet(max_buses: u32) -> Mixer {
    let mut m = Mixer::new(max_buses);
    m.set_lookahead(0.0);
    let ramp: Vec<f32> = (0..RAMP_FRAMES).map(c).collect();
    m.load_clip(RAMP, &ramp);
    let saw: Vec<f32> = (0..SAW_FRAMES).map(|k| ((k % 97) as f32 / 97.0 - 0.5) * 0.4).collect();
    m.load_clip(SAW, &saw);
    m
}

/// A PLAY of `clip` on `bus` at `gain`, stamped at `at` (`wire::ASAP` for at once).
fn play_at(voice: u32, clip: u32, bus: u16, flags: u16, gain: f32, at: u32) -> Rec {
    let Rec::Play(mut p) = play(voice, clip, bus, flags) else { unreachable!() };
    p.gain = gain;
    p.frame_offset = at;
    Rec::Play(p)
}

/// A PLAY of `clip` on the root bus at `gain`, at once.
fn played(voice: u32, clip: u32, flags: u16, gain: f32) -> Rec {
    play_at(voice, clip, ROOT, flags, gain, wire::ASAP)
}

/// A spatial PLAY of the saw on the root bus, facing `[0.6, 0, -0.8]`, stamped at sample `k`.
fn spatial_play_at(voice: u32, k: usize) -> Rec {
    let Rec::Play(mut p) = play(voice, SAW, ROOT, MIXED | SPATIAL) else { unreachable!() };
    p.frame_offset = k as u32;
    p.dir_x = 0.6;
    p.dir_z = -0.8;
    Rec::Play(p)
}

/// SET_PARAMS of pitch `pitch`, stamped at sample `k`.
fn pitch_at(voice: u32, pitch: f32, k: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: k as u32, mask: wire::SET_PARAMS_MASK_PITCH, pitch, ramp_frames: 0, ..Default::default() })
}

/// SET_PARAMS of `lpHz` `hz` over `ramp` frames, stamped at sample `k`.
fn lowpass_at(voice: u32, hz: f32, ramp: u32, k: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: k as u32, mask: wire::SET_PARAMS_MASK_LP_HZ, lp_hz: hz, ramp_frames: ramp, ..Default::default() })
}

/// SET_PARAMS of direction `dir`, at once, stamped at sample `k`.
fn direction_at(voice: u32, dir: [f32; 3], k: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: k as u32, mask: wire::SET_PARAMS_MASK_DIR, dir_x: dir[0], dir_y: dir[1], dir_z: dir[2], ramp_frames: 0, ..Default::default() })
}

/// SET_PARAMS of score `score`, stamped at sample `k`.
fn score_at(voice: u32, score: f32, k: usize) -> Rec {
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: k as u32, mask: wire::SET_PARAMS_MASK_SCORE, score, ..Default::default() })
}

/// SET_PARAMS moving `voice` to `bus` with score `score` in the same record, stamped at sample `k`.
fn bus_and_score_at(voice: u32, bus: u32, score: f32, k: usize) -> Rec {
    let mask = wire::SET_PARAMS_MASK_BUS | wire::SET_PARAMS_MASK_SCORE;
    Rec::Set(wire::SetParams { voice_id: voice, frame_offset: k as u32, mask, bus, score, ..Default::default() })
}

/// SET_PAUSED at sample `k`.
fn paused_at(voice: u32, paused: bool, k: usize) -> Rec {
    let mut b = vec![0u8; wire::SetPaused::FIXED_END];
    wire::SetPaused { voice_id: voice, frame_offset: k as u32, paused: paused as u32 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SEEK to clip frame `clip_frame` at sample `k` (clips: epoch 0).
fn seek_at(voice: u32, clip_frame: u32, k: usize) -> Rec {
    let mut b = vec![0u8; wire::Seek::FIXED_END];
    wire::Seek { voice_id: voice, frame_offset: k as u32, clip_frame, epoch: 0 }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SET_LOOP over `start..end` (clip frames) at sample `k`, looping or not.
fn loop_at(voice: u32, start: u32, end: u32, looping: bool, k: usize) -> Rec {
    let flags = if looping { wire::SET_LOOP_FLAGS_LOOPING } else { 0 };
    let mut b = vec![0u8; wire::SetLoop::FIXED_END];
    wire::SetLoop { voice_id: voice, frame_offset: k as u32, loop_start_frame: start, loop_end_frame: end, flags }.write(&mut b, 0).unwrap();
    Rec::Raw(b)
}

/// SET_VOICE_FX of sends (0.5, 0.25) and a 200 Hz high-pass, stamped at sample `k` (as
/// `in_voice_hooks.rs`' spatial scene).
fn sends_at(voice: u32, k: usize) -> Rec {
    let mut b = vec![0u8; wire::SetVoiceFx::FIXED_END];
    let mask = wire::SET_VOICE_FX_MASK_SENDS | wire::SET_VOICE_FX_MASK_HP_HZ;
    wire::SetVoiceFx { voice_id: voice, frame_offset: k as u32, mask, ramp_frames: 0, hp_hz: 200.0, send: [0.5, 0.25, 0.0, 0.0], yaw: 0.0, aux_level: 0.0, aux_bus: wire::AUX_BUS_NONE as u16, reserved: 0 }
        .write(&mut b, 0)
        .unwrap();
    Rec::Raw(b)
}

/// The three-voice scene: voices 1 and 2 DC loops at gain 0.1, voice 3 `clip` (flags `flags3`) at
/// gain 0.5, all from frame 0, rendered one quantum, so they run when a record lands at sample `K`
/// of the next quantum (absolute frame `QUANTUM + K`).
fn three_voices(clip: u32, flags3: u16) -> Mixer {
    let mut m = quiet(4);
    m.submit(&[played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1), play_at(V3, clip, ROOT, flags3, 0.5, wire::ASAP)]);
    m.render();
    m
}

/// A voice's slot bytes (`VOICE_SLOT_BYTES` of its region).
fn slot_bytes(core: &Core, voice: u32) -> Vec<u8> {
    let at = (voice & 0xFFFF) as usize * VOICE_SLOT_BYTES;
    core.regions().voices[at..at + VOICE_SLOT_BYTES].to_vec()
}

/// Whether two sample runs are bit-identical.
fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

/// The `splitQuanta` and `voiceSplits` counters, cumulative.
fn split_counts(m: &Mixer) -> (u32, u32) {
    let music = &status::counters(&m.core).music;
    (music.split_quanta, music.voice_splits)
}

/// SET_PARAMS pitch: voice 3 of three (a ramp clip, mixed, gain 0.5; voices 1 and 2 DC loops at
/// gain 0.1) gets pitch 2 at once at sample `K`. Its output follows `0.5 · c(p)` with the position
/// advancing one frame a sample before `K` and two after (as `due_list.rs`' pitch case);
/// `splitQuanta` 0, `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
fn a_stamped_pitch_splits_only_its_voice() {
    let mut m = three_voices(RAMP, MIXED);
    let mut twin = three_voices(RAMP, MIXED);
    m.submit(&[pitch_at(V3, 2.0, K)]);
    let (l, _) = m.render();
    twin.render();
    // Quantum 1 starts at frame 128; voice 3 has moved one frame a sample, then two from K.
    check(&l, TOL_OUT, "pitch 2 from sample K", |k| 0.2 + 0.5 * c(if k < K { QUANTUM + k } else { QUANTUM + K + 2 * (k - K) }));
    assert_eq!(split_counts(&m), (0, 1));
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// SET_PARAMS low-pass: the acceptance's `lowpass` ramp. A mixed voice on a bright clip (the saw of
/// `in_voice_hooks.rs`) gets `lpHz` 500 over 960 frames (the 20 ms quantised ramp of api-and-models
/// §2 `segment`) at sample `K`. Its output is bit-identical to the twin's before `K` and differs
/// after; `splitQuanta` reads 0 across the quantum and the 8 that follow (the ramp's span) while
/// `voiceSplits` reads 1 (the ramp runs inside the voice; only its start splits).
#[test]
fn a_stamped_lowpass_ramp_splits_only_its_voice() {
    let mut m = three_voices(SAW, MIXED | LOOP);
    let mut twin = three_voices(SAW, MIXED | LOOP);
    m.submit(&[lowpass_at(V3, 500.0, 960, K)]);
    let (l, r) = m.render();
    let (tl, tr) = twin.render();
    assert!(same_bits(&l[..K], &tl[..K]) && same_bits(&r[..K], &tr[..K]), "bit-identical before sample K");
    assert!(!same_bits(&l[K..], &tl[K..]) || !same_bits(&r[K..], &tr[K..]), "the ramp changes the output after K");
    assert_eq!(split_counts(&m), (0, 1), "the start splits, the ramp runs inside the voice");
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
    for _ in 0..8 {
        m.render();
        assert_eq!(split_counts(&m), (0, 1), "no split across the ramp's span");
    }
}

/// SET_PARAMS direction on a spatial voice with sends (the acceptance's "stamped spatial play with
/// sends"): voice 3 starts with a **stamped** spatial PLAY at sample `K` of one quantum, with a
/// SET_VOICE_FX of sends (0.5, 0.25) at the same frame (`in_voice_hooks.rs`' scene), and a stamped
/// SET_PARAMS direction (from `[0.6, 0, -0.8]` to `[-0.6, 0, -0.8]`, ramp 0) at sample `K` of a
/// later quantum. Across all of it `splitQuanta` reads 0; the PLAY itself splits nothing (a record
/// at a voice's start frame applies before its first sample: `voiceSplits` 0 after that quantum),
/// the direction change counts `voiceSplits` 1; the output is bit-identical to the twin's before
/// the direction's sample and differs after it (the pan moves; the sends tap per piece).
#[test]
fn a_stamped_direction_on_a_spatial_voice_with_sends_splits_only_its_voice() {
    // Quantum 0: voices 1 and 2 run. Quantum 1: the spatial PLAY and its sends, both at K.
    let mut m = quiet(4);
    m.submit(&[played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1)]);
    m.render();
    let mut twin = quiet(4);
    twin.submit(&[played(V1, DC, MIXED | LOOP, 0.1), played(V2, DC, MIXED | LOOP, 0.1)]);
    twin.render();

    m.submit(&[spatial_play_at(V3, K), sends_at(V3, K)]);
    assert_eq!(scheduler::pending_len(&mut m.core), 0, "the PLAY and its sends queue nothing");
    twin.submit(&[spatial_play_at(V3, K), sends_at(V3, K)]);
    m.render();
    twin.render();
    assert_eq!(split_counts(&m), (0, 0), "a start at K splits nothing");

    // Quantum 2: the direction flips from [0.6, 0, -0.8] to [-0.6, 0, -0.8] at K (the twin doesn't get it).
    m.submit(&[direction_at(V3, [-0.6, 0.0, -0.8], K)]);
    let (l, r) = m.render();
    let (tl, tr) = twin.render();
    assert!(same_bits(&l[..K], &tl[..K]) && same_bits(&r[..K], &tr[..K]), "bit-identical before the direction's sample");
    assert!(!same_bits(&l[K..], &tl[K..]) || !same_bits(&r[K..], &tr[K..]), "the pan moves after K");
    assert_eq!(split_counts(&m), (0, 1), "the direction splits its voice once");
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// SET_VOICE_FX (D7, see the module notes): a SET_VOICE_FX stamped at sample `K` of a later quantum
/// for a playing mixed voice leaves the pending queue empty after submit (`scheduler::pending_len`
/// 0), its voice carries no `FLAG2_DUE` during the render, and `splitQuanta` and `voiceSplits` both
/// read 0 after it. (Today it applies at submit; if a later task makes it honour its frame, this
/// case becomes a split case like the others.)
#[test]
fn a_stamped_voice_fx_applies_at_once_and_splits_nothing() {
    let mut m = three_voices(RAMP, MIXED);
    m.submit(&[sends_at(V3, K)]);
    assert_eq!(scheduler::pending_len(&mut m.core), 0, "SET_VOICE_FX doesn't wait in the pending queue");
    m.render();
    assert!(voices::slots(&m.core).iter().all(|s| s.flags2 & FLAG2_DUE == 0), "no voice is flagged");
    assert_eq!(split_counts(&m), (0, 0));
}

/// SET_PAUSED: voice 3 (as the pitch case) paused at sample `K`: `0.5 · c(k)` before `K`, then
/// faded over the 5 ms mix fade (240 frames, `due_list.rs` `MIX_FADE`) from `K`; `splitQuanta` 0,
/// `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
fn a_stamped_pause_splits_only_its_voice() {
    let mut m = three_voices(RAMP, MIXED);
    let mut twin = three_voices(RAMP, MIXED);
    m.submit(&[paused_at(V3, true, K)]);
    let (l, _) = m.render();
    twin.render();
    check(&l, TOL_OUT, "paused at K, faded over the mix fade", |k| {
        let fade = if k < K { 1.0 } else { ramp_to(1.0, 0.0, MIX_FADE, k - K) };
        0.2 + 0.5 * c(QUANTUM + k) * fade
    });
    assert_eq!(split_counts(&m), (0, 1));
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// SEEK: voice 3 seeks to clip frame 1,000 at sample `K`: the old audio fades over the mix fade
/// from `K` (the jump comes after it, as `due_list.rs`' SEEK case); `splitQuanta` 0,
/// `voiceSplits` 1; voices 1 and 2 untouched.
#[test]
fn a_stamped_seek_splits_only_its_voice() {
    let mut m = three_voices(RAMP, MIXED);
    let mut twin = three_voices(RAMP, MIXED);
    m.submit(&[seek_at(V3, 1_000, K)]);
    let (l, _) = m.render();
    twin.render();
    // The old audio fades out over the mix fade from K; the jump to clip frame 1,000 comes after it.
    check(&l, TOL_OUT, "the old audio fades from K", |k| {
        let fade = if k < K { 1.0 } else { ramp_to(1.0, 0.0, MIX_FADE, k - K) };
        0.2 + 0.5 * c(QUANTUM + k) * fade
    });
    assert_eq!(split_counts(&m), (0, 1));
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// SET_LOOP: voice 3, a one-shot, gets a loop over clip frames `0..(QUANTUM + K + 20)` at sample
/// `K`: it plays on unchanged until its position reaches the loop end, then wraps to clip frame 0
/// (skip the wrap sample itself, as `due_list.rs` does); `splitQuanta` 0, `voiceSplits` 1;
/// voices 1 and 2 untouched.
#[test]
fn a_stamped_set_loop_splits_only_its_voice() {
    let mut m = three_voices(RAMP, MIXED);
    let mut twin = three_voices(RAMP, MIXED);
    // The loop covers clip frames 0..198: voice 3 (at frame 128 + k) reaches 198 at sample 70.
    let end = QUANTUM + K + 20;
    let wrap = end - QUANTUM;
    m.submit(&[loop_at(V3, 0, end as u32, true, K)]);
    let (l, _) = m.render();
    twin.render();
    for (k, &a) in l.iter().enumerate() {
        if k == wrap {
            continue; // the wrap sample itself
        }
        let pos = if k < wrap { QUANTUM + k } else { k - wrap };
        let v = 0.2 + 0.5 * c(pos);
        assert!((a - v).abs() <= TOL_OUT, "SET_LOOP: sample {k} is {a}, expected {v}");
    }
    assert_eq!(split_counts(&m), (0, 1));
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// SET_PARAMS bus (and score): two buses under the root; voice 3 on bus 1 moves to bus 2 at
/// sample `K` (score 5 in the same record). Bus 1's input carries voice 3 for `[0, K)` only and
/// bus 2's for `[K, QUANTUM)` (give the buses different gains so the output shows the move at `K`
/// exactly: `g1 · v(k)` before, `g2 · v(k)` after); the slot's `score` reads 5; `splitQuanta` 0,
/// `voiceSplits` 1.
/// The bus scene: bus 0 the root, buses 1 and 2 under it with gains 0.5 and 0.25; voices 1 and 2 on
/// the root, voice 3 (the ramp, gain 0.5) on bus 1; rendered one quantum.
fn bus_scene() -> Mixer {
    let mut m = quiet(4);
    m.submit(&[
        config(&[ROOT, 0, 0]),
        gains(0, &[1.0, 0.5, 0.25]),
        played(V1, DC, MIXED | LOOP, 0.1),
        played(V2, DC, MIXED | LOOP, 0.1),
        play_at(V3, RAMP, 1, MIXED, 0.5, wire::ASAP),
    ]);
    m.render();
    m
}

#[test]
fn a_stamped_bus_move_splits_only_its_voice() {
    let mut m = bus_scene();
    let mut twin = bus_scene();
    m.submit(&[bus_and_score_at(V3, 2, 5.0, K)]);
    let (l, _) = m.render();
    twin.render();
    // Bus 1 (gain 0.5) carries voice 3 before K, bus 2 (gain 0.25) after it.
    check(&l, TOL_OUT, "the move to bus 2 at K", |k| {
        let gain = if k < K { 0.5 * 0.5 } else { 0.25 * 0.5 };
        0.2 + gain * c(QUANTUM + k)
    });
    assert_eq!(voices::slots(&m.core)[3].score, 5.0, "the score applied");
    assert_eq!(split_counts(&m), (0, 1));
    assert_eq!(slot_bytes(&m.core, V1), slot_bytes(&twin.core, V1), "voice 1 untouched");
    assert_eq!(slot_bytes(&m.core, V2), slot_bytes(&twin.core, V2), "voice 2 untouched");
}

/// `voiceSplits` counts the pieces past the first, per voice, cumulatively: in one quantum voice 1
/// gets class S records at samples 20, 60 and two at 90 (one sample: one boundary), voice 2 one at
/// 0 (before its first sample: no split) and one at 127, voice 3 none. `voiceSplits` reads 3 + 1 =
/// 4, `splitQuanta` 0; the next quantum with no records adds nothing; a further quantum with one
/// record adds 1 (cumulative). Each voice's `FLAG2_DUE` is clear after the quantum that follows.
#[test]
fn voice_splits_counts_each_extra_piece() {
    let mut m = three_voices(RAMP, MIXED);
    m.submit(&[
        score_at(V1, 1.0, 20),
        score_at(V1, 2.0, 60),
        score_at(V1, 3.0, 90),
        score_at(V1, 4.0, 90),
        score_at(V2, 5.0, 0), // before voice 2's first sample in the quantum: no split
        score_at(V2, 6.0, 127),
    ]);
    m.render();
    // Voice 1 in four pieces (three splits), voice 2 in two (one split).
    assert_eq!(split_counts(&m), (0, 4));
    m.render();
    assert_eq!(split_counts(&m), (0, 4), "a quantum with no records adds nothing");
    assert!(voices::slots(&m.core).iter().all(|s| s.flags2 & FLAG2_DUE == 0), "the flags are clear");
    m.submit(&[score_at(V1, 7.0, 10)]);
    m.render();
    assert_eq!(split_counts(&m), (0, 5), "cumulative: one more split");
}

/// A voice that starts inside the quantum (a stamped PLAY at sample 30) with a class S record at 30
/// (applies before its first sample: no split) and one at 80 (one split): `voiceSplits` 1. A record
/// for a voice that has ended inside the quantum before its sample applies to no effect and counts
/// nothing.
#[test]
fn a_voice_starting_or_ending_inside_the_quantum_splits_only_past_its_first_sample() {
    // A voice that starts at sample 30, with a record at 30 (before its first sample) and one at 80.
    let mut m = quiet(4);
    m.render();
    m.submit(&[play_at(V4, RAMP, ROOT, MIXED | LOOP, 0.5, 30), score_at(V4, 1.0, 30), score_at(V4, 2.0, 80)]);
    m.render();
    assert_eq!(voices::slots(&m.core)[4].score, 2.0, "both records applied");
    assert_eq!(split_counts(&m), (0, 1), "only the record at 80 splits");

    // A 64-frame one-shot on DC starts at sample 10 and ends at sample 74; its record at 100 is for
    // a voice that has ended: it applies to no effect and counts nothing.
    let mut m = quiet(4);
    m.render();
    m.submit(&[play_at(V5, DC, ROOT, MIXED, 1.0, 10), score_at(V5, 9.0, 100)]);
    let (l, _) = m.render();
    check(&l, TOL_OUT, "the one-shot plays samples 10..74", |k| if (10..74).contains(&k) { 1.0 } else { 0.0 });
    assert_eq!(split_counts(&m), (0, 0), "a record for an ended voice counts nothing");
}

/// Two class G records for one voice at different samples (a FADE at 30 and a SET_PARAMS gain at
/// 70) take the class S path for the second (§3.1): `voiceSplits` 1, `splitQuanta` 0, and the
/// output follows both at their samples. Depends on Z2b's `curves::prepare` taking the first record
/// into the gain loop (with Z2b's stub both split: 2); stays ignored until Z2b and Z2c are both on
/// the flip branch.
#[test]
#[ignore = "Z2b"]
fn two_class_g_offsets_take_one_voice_local_split() {
    unimplemented!("after Z2b")
}
