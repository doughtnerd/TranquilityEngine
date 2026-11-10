//! Gapless loops (task B4). A loop is the decoder's output read to the end, then read again from
//! frame 0 (a clip loops over its decoded frames; a stream wraps with `seek(0)` inside a chunk, as
//! the worker's `streams.ts` does). Here:
//!
//! - every format's stated length is exactly the source's (no priming, no padding: nothing for a
//!   loop to play twice or leave out), and a stream-style wrapped read is bit-identical to the whole
//!   decode repeated, in f32 and int16, from frame 0 and from a seek just before the seam;
//! - on the loopable fixture (whole cycles, no fades) the decoded seam matches the looped source: a
//!   gap of even a few frames would show as a large error there.

mod common;

use common::*;
use myco_audio_decode::Decoder;

/// Every format, on the loopable source; AAC only in the `aac` build.
fn loop_fixtures() -> Vec<&'static str> {
    let mut v = vec!["loop-48000-stereo.wav", "loop-48000-stereo.flac", "loop-48000-stereo.mp3", "loop-48000-stereo.ogg"];
    if cfg!(feature = "aac") {
        v.push("loop-48000-stereo.m4a");
    }
    v
}

/// The tone fixtures that state their length (all but the MP3 without a Xing header).
fn tone_fixtures() -> Vec<&'static str> {
    let mut v = vec![
        "tone-44100-mono.wav",
        "tone-48000-stereo.flac",
        "tone-44100-mono.mp3",
        "tone-48000-stereo.mp3",
        "tone-44100-mono.ogg",
        "tone-48000-stereo.ogg",
    ];
    if cfg!(feature = "aac") {
        v.extend(["tone-44100-mono.m4a", "tone-48000-stereo.m4a"]);
    }
    v
}

/// Reads `total` frames as a looping stream does: `chunk`-frame reads, and on a short read
/// `seek(0)` and the rest of the chunk from the start.
fn read_looping<T: Copy + Default>(d: &mut Decoder, total: usize, chunk: usize, read: impl Fn(&mut Decoder, &mut [T]) -> usize) -> Vec<T> {
    let ch = d.info().channels as usize;
    let mut out = Vec::with_capacity(total * ch);
    let mut buf = vec![T::default(); chunk * ch];
    while out.len() < total * ch {
        let mut n = read(d, &mut buf);
        while n < chunk {
            assert_eq!(d.seek(0).unwrap(), 0);
            let m = read(d, &mut buf[n * ch..]);
            assert!(m > 0, "nothing after the wrap");
            n += m;
        }
        out.extend_from_slice(&buf[..n * ch]);
    }
    out.truncate(total * ch);
    out
}

fn repeated<T: Copy>(whole: &[T], from: usize, len: usize) -> Vec<T> {
    whole.iter().cycle().skip(from).take(len).copied().collect()
}

#[test]
fn stated_length_is_the_source_length() {
    for name in loop_fixtures() {
        let info = open(name).info();
        assert_eq!(info.frames, Some(48_000), "{name}: stated frames");
        let (_, dec) = decode_all(name, 4096);
        assert_eq!(dec.len(), 48_000 * 2, "{name}: decoded samples");
    }
}

#[test]
fn a_wrapped_read_is_the_decode_repeated_bit_for_bit() {
    for name in loop_fixtures().into_iter().chain(tone_fixtures()) {
        let (info, whole) = decode_all(name, 4096);
        let ch = info.channels as usize;
        let n = whole.len() / ch;
        // 2.5 periods in the worker's 4,096-frame chunks and in an odd size that lands the seam mid-chunk.
        for chunk in [4096, 1000] {
            let mut d = open(name);
            let got = read_looping(&mut d, n * 5 / 2, chunk, |d, b: &mut [f32]| d.read_f32(b).unwrap());
            assert!(got == repeated(&whole, 0, got.len()), "{name}: f32 loop in {chunk}-frame reads");
        }
        let mut d = open(name);
        let mut whole16 = vec![0i16; n * ch];
        assert_eq!(d.read_i16(&mut whole16).unwrap(), n, "{name}: int16 frames");
        let mut d = open(name);
        let got = read_looping(&mut d, n * 2 + 77, 4096, |d, b: &mut [i16]| d.read_i16(b).unwrap());
        assert!(got == repeated(&whole16, 0, got.len()), "{name}: int16 loop");
        // From a seek 3,000 frames before the seam (a loop started near its end, or B3b's seek).
        let mut d = open(name);
        let from = n - 3000;
        assert_eq!(d.seek(from as u64).unwrap(), from as u64, "{name}: seek");
        let got = read_looping(&mut d, 9000, 4096, |d, b: &mut [f32]| d.read_f32(b).unwrap());
        let want = repeated(&whole, from * ch, got.len());
        if name.ends_with(".wav") || name.ends_with(".flac") {
            assert!(got == want, "{name}: loop after a seek");
        } else {
            // A lossy seek restarts the decoder mid-file, so it converges over its first frames (B1's
            // seek tests skip 2,048); from the seam on, the replay is the decode itself, bit for bit.
            let seam = 3000 * ch;
            assert!(got[seam..] == want[seam..], "{name}: after the seam, from a seek");
        }
    }
}

/// The decoded seam against the looped source (the WAV): the last and first 2,048 frames, joined.
/// A gap of priming or padding frames at the seam would put the decode out of step with the
/// source there; the lossy codecs' worst seam SNR must stay close to their SNR mid-file.
#[test]
fn the_seam_matches_the_looped_source() {
    let src = wav("loop-48000-stereo.wav").as_f32();
    let ch = 2;
    let n = src.len() / ch;
    let w = 2048;
    for name in loop_fixtures() {
        let (_, dec) = decode_all(name, 4096);
        let seam = |x: &[f32], c: usize| -> Vec<f32> { (n - w..n).chain(0..w).map(|f| x[f * ch + c]).collect() };
        let middle = |x: &[f32], c: usize| -> Vec<f32> { (n / 2 - w..n / 2 + w).map(|f| x[f * ch + c]).collect() };
        for c in 0..ch {
            let (s, d) = (seam(&src, c), seam(&dec, c));
            let at_seam = snr_db(&s, &d, 0, 0);
            let mid = snr_db(&middle(&src, c), &middle(&dec, c), 0, 0);
            eprintln!("{name}: channel {c} SNR at the seam {at_seam:.1} dB, mid-file {mid:.1} dB");
            if name.ends_with(".wav") || name.ends_with(".flac") {
                assert!(s == d, "{name}: lossless seam");
            } else {
                // Codec edge effects cost some dB at the file's ends (ffmpeg's AAC encoder smears its
                // second block: frames 256..1,024 measure 10 dB through ffmpeg's own decoder too, so the
                // M4A's seam reads about 18 dB); a gap costs all of it (below 6 dB).
                assert!(at_seam > 15.0, "{name}: channel {c} seam SNR {at_seam:.1} dB");
            }
            // The check has teeth: the decode with a 1,024-frame gap at the seam (AAC's priming left in)
            // scores far lower.
            let gapped: Vec<f32> = (n - w..n).map(|f| dec[f * ch + c]).chain((0..w).map(|f| if f < 1024 { 0.0 } else { dec[(f - 1024) * ch + c] })).collect();
            let with_gap = snr_db(&s, &gapped, 0, 0);
            eprintln!("{name}: channel {c} with a 1,024-frame gap {with_gap:.1} dB");
            assert!(with_gap < 6.0, "{name}: the seam check would miss a 1,024-frame gap ({with_gap:.1} dB)");
        }
    }
}
