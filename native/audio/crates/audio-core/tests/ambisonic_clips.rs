//! Ambisonic clips through the core (ADR 0162 B2): 4, 9 and 16-channel int16 clips reserve,
//! commit in chunks and play; 5 channels are refused. Until task B3's ambisonic voice, a plain
//! voice plays the clip's W channel, so its output equals a mono clip of W played the same way.

mod common;

use audio_core::clips;
use audio_wire::generated as wire;
use common::*;

/// Frame `f`, channel `c` of the test clip: W (channel 0) a 440 Hz-ish tone, the other channels
/// loud distinct signals (which must not reach the output).
fn sample(f: usize, c: usize) -> i16 {
    if c == 0 {
        ((f as f32 * 0.0577).sin() * 12_000.0) as i16
    } else {
        (((f * 31 + c * 977) % 50_000) as i32 - 25_000) as i16
    }
}

/// Reserves an int16 clip of `channels` and copies it in 2,048-frame chunks (as the shell does).
fn load(m: &mut Mixer, id: u32, channels: usize, frames: usize) {
    assert_eq!(clips::reserve(&mut m.core, id, frames as u32, channels as u32, RATE, wire::clip_format::I16), wire::ERR_OK, "{channels} channels");
    let mut at = 0;
    while at < frames {
        let n = (frames - at).min(2048);
        let chunk: Vec<i16> = (at..at + n).flat_map(|f| (0..channels).map(move |c| sample(f, c))).collect();
        let bytes = (n * channels * 2) as u32;
        let p = clips::chunk_ptr(&mut m.core, id, at as u32, bytes);
        assert!(!p.is_null());
        // SAFETY: chunk_ptr gave `bytes` writable bytes for this range.
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr().cast::<u8>(), p, bytes as usize) };
        assert_eq!(clips::commit(&mut m.core, id, at as u32, bytes), wire::ERR_OK);
        at += n;
    }
    assert!(m.core.clips().is_resident(id));
}

#[test]
fn four_nine_and_sixteen_channel_clips_load_and_play_their_w_channel() {
    let frames = 20_000;
    for channels in [4usize, 9, 16] {
        let mut ambi = Mixer::new(4);
        load(&mut ambi, 10, channels, frames);
        let mut mono = Mixer::new(4);
        load(&mut mono, 10, 1, frames);
        for m in [&mut ambi, &mut mono] {
            m.submit(&[play(1 << 16, 10, ROOT, MIXED)]);
        }
        let (al, ar) = ambi.render_n(40);
        let (ml, mr) = mono.render_n(40);
        assert!(ml.iter().any(|x| x.abs() > 0.1), "the reference plays");
        assert_eq!(al, ml, "{channels} channels: left");
        assert_eq!(ar, mr, "{channels} channels: right");
    }
}

#[test]
fn a_5_channel_clip_is_refused() {
    let mut m = Mixer::new(4);
    for channels in [3u32, 5, 8, 17] {
        assert_eq!(clips::reserve(&mut m.core, 20, 64, channels, RATE, wire::clip_format::I16), wire::ERR_BAD_ARG, "{channels} channels");
    }
    assert!(m.core.clips().frames(20).is_none());
}
