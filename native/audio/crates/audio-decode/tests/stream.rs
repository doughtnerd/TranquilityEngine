//! Stream behaviour (task B1, for B3's 4,096-frame chunks and B3b's seeks): chunk size doesn't
//! change the output, seeks are sample-accurate, a seek to 0 restarts bit-identically (loops), and
//! several decoders run side by side.

mod common;

use common::*;
use myco_audio_decode::{DecodeError, Decoder, FormatHint};

const LOSSLESS: [&str; 6] = [
    "tone-44100-mono.wav",
    "tone-48000-stereo.wav",
    "tone-22050-stereo-s24.wav",
    "tone-44100-mono.flac",
    "tone-48000-stereo.flac",
    "tone-22050-stereo-s24.flac",
];

const LOSSY: [&str; 5] = [
    "tone-44100-mono.mp3",
    "tone-48000-stereo.mp3",
    "tone-48000-stereo-vbr-noxing.mp3",
    "tone-44100-mono.ogg",
    "tone-48000-stereo.ogg",
];

#[cfg(feature = "aac")]
const AAC: [&str; 2] = ["tone-44100-mono.m4a", "tone-48000-stereo.m4a"];
#[cfg(not(feature = "aac"))]
const AAC: [&str; 0] = [];

fn all() -> Vec<&'static str> {
    LOSSLESS.iter().chain(LOSSY.iter()).chain(AAC.iter()).copied().collect()
}

#[test]
fn chunk_size_does_not_change_the_output() {
    for name in all() {
        let (_, whole) = decode_all(name, 1 << 20);
        for chunk in [1, 333, 4096] {
            let (_, chunked) = decode_all(name, chunk);
            assert!(chunked == whole, "{name}: {chunk}-frame reads differ from one read");
        }
    }
}

/// Reads `frames` frames after seeking to `target`; returns the landed frame and the samples.
fn read_after_seek(d: &mut Decoder, target: u64, frames: usize) -> (u64, Vec<f32>) {
    let ch = d.info().channels as usize;
    let at = d.seek(target).unwrap_or_else(|e| panic!("seek {target}: {e:?}"));
    let mut buf = vec![0f32; frames * ch];
    let n = d.read_f32(&mut buf).unwrap();
    buf.truncate(n * ch);
    (at, buf)
}

#[test]
fn lossless_seeks_are_sample_exact() {
    for name in LOSSLESS {
        let (info, whole) = decode_all(name, 4096);
        let ch = info.channels as usize;
        let total = whole.len() / ch;
        let mut d = open(name);
        // Forward, backward, odd offsets, the last frames, and 0.
        for target in [total / 2, 1234, 7, total - 100, total / 3 + 1, 0] {
            let (at, got) = read_after_seek(&mut d, target as u64, 4096);
            assert_eq!(at, target as u64, "{name}: landed frame");
            let end = (target + 4096).min(total);
            assert!(got == whole[target * ch..end * ch], "{name}: samples after a seek to {target}");
        }
        // Past the end: clamped to the length, and the next read is empty.
        let (at, got) = read_after_seek(&mut d, total as u64 + 50, 16);
        assert_eq!(at, total as u64, "{name}: a seek past the end");
        assert!(got.is_empty());
    }
}

/// Lossy seeks land exactly (the leading frames are dropped); the samples match the straight
/// decode closely (a decoder restarted mid-stream converges within a frame or two).
#[test]
fn lossy_seeks_land_on_the_frame() {
    for name in LOSSY.iter().chain(AAC.iter()).copied() {
        let (info, whole) = decode_all(name, 4096);
        let ch = info.channels as usize;
        let total = whole.len() / ch;
        let mut d = open(name);
        for target in [total / 2, 10_001, total / 4 + 3] {
            let (at, got) = read_after_seek(&mut d, target as u64, 8192);
            assert_eq!(at, target as u64, "{name}: landed frame");
            assert_eq!(got.len(), 8192 * ch, "{name}: frames after a seek to {target}");
            let reference = &whole[target * ch..(target + 8192) * ch];
            let lag = best_lag(&channel(reference, ch, 0), &channel(&got, ch, 0), 64);
            assert_eq!(lag, 0, "{name}: the seek to {target} is off by {lag} frames");
            // Skip the first 2,048 frames: the restarted decoder is still converging there.
            let snr = snr_db(&channel(reference, ch, 0), &channel(&got, ch, 0), 0, 2048);
            assert!(snr > 30.0, "{name}: {snr:.1} dB against the straight decode after a seek to {target}");
            eprintln!("{name}: seek {target} -> {at}, {snr:.1} dB vs straight decode");
        }
    }
}

/// A loop: after the end, a seek to 0 replays the file bit-identically (it reopens), for every
/// format, AAC included (isomp4's seek after EOF fails in symphonia 0.6.1).
#[test]
fn seek_to_zero_after_the_end_replays_identically() {
    for name in all() {
        let (info, whole) = decode_all(name, 4096);
        let ch = info.channels as usize;
        let mut d = open(name);
        let mut buf = vec![0f32; whole.len() + 4096 * ch];
        for pass in 0..3 {
            let n = d.read_f32(&mut buf).unwrap();
            assert!(buf[..n * ch] == whole[..], "{name}: pass {pass}");
            assert_eq!(d.read_f32(&mut buf).unwrap(), 0);
            assert_eq!(d.seek(0).unwrap(), 0);
        }
        // A mid-file seek after the end works too.
        let total = whole.len() / ch;
        let n = d.read_f32(&mut buf).unwrap();
        assert_eq!(n, total);
        let (at, got) = read_after_seek(&mut d, (total / 2) as u64, 1024);
        assert_eq!(at, (total / 2) as u64, "{name}: mid seek after the end");
        assert_eq!(got.len(), 1024 * ch);
    }
}

#[test]
fn decoders_run_side_by_side() {
    let names = all();
    let mut decoders: Vec<Decoder> = names.iter().map(|n| open(n)).collect();
    let mut outs: Vec<Vec<f32>> = vec![Vec::new(); names.len()];
    let mut live = names.len();
    while live > 0 {
        live = 0;
        for (d, out) in decoders.iter_mut().zip(outs.iter_mut()) {
            let ch = d.info().channels as usize;
            let mut buf = vec![0f32; 4096 * ch];
            let n = d.read_f32(&mut buf).unwrap();
            out.extend_from_slice(&buf[..n * ch]);
            if n > 0 {
                live += 1;
            }
        }
    }
    for (name, out) in names.iter().zip(&outs) {
        let (_, whole) = decode_all(name, 4096);
        assert!(*out == whole, "{name}: interleaved decoding changed the output");
    }
}

#[test]
fn bad_input_is_an_error_not_a_panic() {
    let open_bytes = |b: Vec<u8>, hint| Decoder::open(std::sync::Arc::new(b), hint);
    assert!(matches!(open_bytes(b"not audio at all".repeat(64), FormatHint::None), Err(DecodeError::Format(_))));
    assert!(matches!(open_bytes(vec![0u8; 4096], FormatHint::Mp3), Err(DecodeError::Format(_))));
    // Truncated files: open may fail, or decode stops early; neither panics.
    for name in all() {
        let full = fixture(name);
        for cut in [16, 100, full.len() / 3, full.len() - 7] {
            let Ok(mut d) = open_bytes(full[..cut].to_vec(), hint_for(name)) else { continue };
            let ch = d.info().channels as usize;
            let mut buf = vec![0f32; 4096 * ch];
            for _ in 0..1000 {
                match d.read_f32(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            let _ = d.seek(10);
            let _ = d.read_f32(&mut buf);
        }
        // Corrupted bytes in the middle: skipped packets or an error, never a panic.
        let mut bad = full.clone();
        let mid = bad.len() / 2;
        for b in &mut bad[mid..(mid + 200).min(full.len())] {
            *b = b.wrapping_mul(31).wrapping_add(7);
        }
        if let Ok(mut d) = open_bytes(bad, hint_for(name)) {
            let ch = d.info().channels as usize;
            let mut buf = vec![0f32; 4096 * ch];
            for _ in 0..1000 {
                match d.read_f32(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
    }
}
