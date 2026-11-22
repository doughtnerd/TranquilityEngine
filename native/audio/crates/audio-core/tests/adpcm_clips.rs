//! ADPCM clips through the core (ADR 0337 A4, 0345 §5; ABI 4.12): a format 6 clip reserves, commits in whole-block
//! chunks and plays, and its voices' output equals, bit for bit, an int16 clip of the same blocks decoded whole
//! (`audio_adpcm::decode`) played the same way: one-shot and looping, at pitch ≠ 1, at a clip rate other than the
//! context's, through a SET_LOOP region crossing blocks, and across a demote and promote (the voice keeps time
//! virtually, then decodes from its new position). Bad shapes and ranges are refused.

mod common;

use audio_core::clips;
use audio_wire::generated as wire;
use common::*;

const BF: usize = audio_adpcm::BLOCK_FRAMES;

fn signal(frames: usize, ch: usize) -> Vec<i16> {
    (0..frames * ch)
        .map(|i| {
            let f = (i / ch) as f32;
            ((f * 0.0311 * (1 + i % ch) as f32).sin() * 13_000.0 + (f * 0.0007).sin() * 6_000.0) as i16
        })
        .collect()
}

/// Reserves ADPCM clip `id` and commits it in chunks of `blocks_per_chunk` blocks (as the shell does).
fn load_adpcm(m: &mut Mixer, id: u32, blocks: &[u8], ch: usize, frames: usize, rate: f32, blocks_per_chunk: usize) {
    assert_eq!(clips::reserve(&mut m.core, id, frames as u32, ch as u32, rate, wire::clip_format::ADPCM_IMA), wire::ERR_OK);
    let bb = audio_adpcm::block_bytes(ch);
    let total = audio_adpcm::blocks(frames);
    let mut b = 0;
    while b < total {
        let n = (total - b).min(blocks_per_chunk);
        let bytes = (n * bb) as u32;
        let p = clips::chunk_ptr(&mut m.core, id, (b * BF) as u32, bytes);
        assert!(!p.is_null(), "block {b}");
        // SAFETY: chunk_ptr gave `bytes` writable bytes for this range.
        unsafe { core::ptr::copy_nonoverlapping(blocks[b * bb..].as_ptr(), p, bytes as usize) };
        assert!(!m.core.clips().is_resident(id) || b + n == total);
        assert_eq!(clips::commit(&mut m.core, id, (b * BF) as u32, bytes), wire::ERR_OK);
        b += n;
    }
    assert!(m.core.clips().is_resident(id));
}

fn load_i16(m: &mut Mixer, id: u32, pcm: &[i16], ch: usize, rate: f32) {
    let frames = pcm.len() / ch;
    assert_eq!(clips::reserve(&mut m.core, id, frames as u32, ch as u32, rate, wire::clip_format::I16), wire::ERR_OK);
    let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
    assert_eq!(clips::write(&mut m.core, id, 0, &bytes), wire::ERR_OK);
}

/// Two mixers, one holding clip 10 as ADPCM, one as the int16 decode of the same blocks.
fn pair(ch: usize, frames: usize, rate: f32) -> (Mixer, Mixer) {
    let blocks = myco_audio_encode::adpcm::encode(&signal(frames, ch), ch);
    let mut pcm = vec![0i16; frames * ch];
    audio_adpcm::decode(&blocks, ch, frames, &mut pcm).unwrap();
    let mut a = Mixer::new(4);
    load_adpcm(&mut a, 10, &blocks, ch, frames, rate, 3);
    let mut b = Mixer::new(4);
    load_i16(&mut b, 10, &pcm, ch, rate);
    (a, b)
}

fn play_at(voice: u32, flags: u16, pitch: f32) -> Rec {
    match play(voice, 10, ROOT, flags) {
        Rec::Play(p) => Rec::Play(wire::Play { pitch, ..p }),
        _ => unreachable!(),
    }
}

fn same(a: &mut Mixer, b: &mut Mixer, quanta: usize, what: &str) {
    let (al, ar) = a.render_n(quanta);
    let (bl, br) = b.render_n(quanta);
    assert!(bl.iter().any(|x| x.abs() > 0.05), "{what}: the reference plays");
    for i in 0..al.len() {
        assert!(al[i].to_bits() == bl[i].to_bits() && ar[i].to_bits() == br[i].to_bits(), "{what}: frame {i}: {} {} vs {} {}", al[i], ar[i], bl[i], br[i]);
    }
}

#[test]
fn an_adpcm_voice_plays_its_decode_bit_for_bit() {
    for ch in [1usize, 2] {
        for (flags, pitch, rate) in [(MIXED, 1.0f32, RATE), (MIXED, 1.37, RATE), (MIXED | LOOP, 0.81, RATE), (MIXED | LOOP, 2.6, 44_100.0), (MIXED, 1.0, 22_050.0)] {
            let (mut a, mut b) = pair(ch, 7 * BF + 300, rate);
            for m in [&mut a, &mut b] {
                m.submit(&[play_at(1 << 16, flags, pitch), play_at(2 << 16 | 1, flags, pitch * 0.5)]);
            }
            same(&mut a, &mut b, 220, &format!("{ch} ch, flags {flags}, pitch {pitch}, rate {rate}"));
        }
    }
}

#[test]
fn a_set_loop_region_crossing_blocks_plays_bit_for_bit() {
    let (mut a, mut b) = pair(2, 6 * BF, RATE);
    let region = || {
        let mut buf = vec![0u8; wire::SetLoop::FIXED_END];
        wire::SetLoop { voice_id: 1 << 16, frame_offset: wire::ASAP, loop_start_frame: 900, loop_end_frame: 2_700, flags: wire::SET_LOOP_FLAGS_LOOPING }.write(&mut buf, 0).unwrap();
        Rec::Raw(buf)
    };
    for m in [&mut a, &mut b] {
        m.submit(&[play_at(1 << 16, MIXED, 1.23), region()]);
    }
    same(&mut a, &mut b, 300, "region 900..2700");
}

#[test]
fn a_demoted_voice_keeps_time_and_resumes_bit_for_bit() {
    let (mut a, mut b) = pair(2, 10 * BF, RATE);
    let id = 1u32 << 16;
    let mixed = |on: bool| {
        let r = wire::SetMixed { voice_id: id, mixed: on as u32, gain: 1.0, dir_z: -1.0, lp_hz: OFF, ..Default::default() };
        let mut buf = vec![0u8; wire::SetMixed::FIXED_END];
        r.write(&mut buf, 0).unwrap();
        Rec::Raw(buf)
    };
    for m in [&mut a, &mut b] {
        m.submit(&[play_at(id, MIXED | LOOP, 1.11)]);
    }
    same(&mut a, &mut b, 30, "before the demote");
    for m in [&mut a, &mut b] {
        m.submit(&[mixed(false)]);
    }
    let _ = (a.render_n(60), b.render_n(60));
    for m in [&mut a, &mut b] {
        m.submit(&[mixed(true)]);
    }
    same(&mut a, &mut b, 60, "after the promote");
}

#[test]
fn bad_adpcm_shapes_and_ranges_are_refused() {
    let mut m = Mixer::new(4);
    for ch in [3u32, 4, 9, 16] {
        assert_eq!(clips::reserve(&mut m.core, 20, 4_096, ch, RATE, wire::clip_format::ADPCM_IMA), wire::ERR_BAD_ARG, "{ch} channels");
    }
    assert_eq!(clips::reserve(&mut m.core, 21, 2 * BF as u32 + 1, 2, RATE, wire::clip_format::ADPCM_IMA), wire::ERR_OK);
    let bb = audio_adpcm::block_bytes(2) as u32;
    assert!(clips::chunk_ptr(&mut m.core, 21, 1, bb).is_null(), "not on a block");
    assert!(clips::chunk_ptr(&mut m.core, 21, 0, bb + 4).is_null(), "not whole blocks");
    assert!(clips::chunk_ptr(&mut m.core, 21, 0, 4 * bb).is_null(), "past the clip's blocks");
    assert!(!clips::chunk_ptr(&mut m.core, 21, 0, 3 * bb).is_null(), "all three blocks");
    assert_eq!(clips::commit(&mut m.core, 21, (2 * BF) as u32, bb), wire::ERR_BAD_ARG, "a gap");
    assert_eq!(clips::commit(&mut m.core, 21, 0, 2 * bb), wire::ERR_OK);
    assert!(!m.core.clips().is_resident(21));
    assert_eq!(clips::commit(&mut m.core, 21, (2 * BF) as u32, bb), wire::ERR_OK, "the last block holds one frame");
    assert!(m.core.clips().is_resident(21));
    assert!(m.core.clips().frames(21).is_none(), "not a PCM clip");
    let a = m.core.clips().adpcm(21).unwrap();
    assert_eq!((a.channels, a.frames, a.blocks.len()), (2, 2 * BF as u32 + 1, 3 * bb as usize));
}
