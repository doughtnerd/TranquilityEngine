//! Ogg Opus through libopus (ADR 0337 A7, 0345 §4; ABI 1.5), against the shipped encoder's own output: the frame
//! count is the encoder's input (the OpusHead pre-skip dropped, the end trimmed by the last granule position), the
//! decode lines up with the source at lag 0 and matches it closely, mono and stereo, at 48 kHz and from a 44.1 kHz
//! source (resampled to 48 kHz by the encoder); seeks are sample-accurate (a seek reads what a straight decode read);
//! and the engine's IMA ADPCM layout decodes through `myco_decode_adpcm`.

mod common;

use common::*;
use myco_audio_decode::{Codec, Decoder, FormatHint};
use myco_audio_encode::{self as enc, Settings};
use std::sync::Arc;

fn source(frames: usize, ch: usize, rate: f32) -> Vec<f32> {
    (0..frames * ch)
        .map(|i| {
            let t = (i / ch) as f32 / rate;
            let c = (i % ch) as f32;
            0.35 * (t * (330.0 + 110.0 * c) * std::f32::consts::TAU).sin() + 0.15 * (t * 1_250.0 * std::f32::consts::TAU).sin()
        })
        .collect()
}

fn encode_opus(pcm: &[f32], ch: usize, rate: u32, quality: f32) -> enc::Encoded {
    enc::encode(pcm, ch, rate, &Settings { codec: enc::Codec::Opus, quality, rate_ceiling: None, mono: false }).expect("opus encodes")
}

fn decode(bytes: &[u8]) -> (myco_audio_decode::Info, Vec<f32>) {
    let mut d = Decoder::open(Arc::new(bytes.to_vec()), FormatHint::Ogg).expect("opens");
    let info = d.info();
    let ch = info.channels as usize;
    let mut out = Vec::new();
    let mut buf = vec![0f32; 4096 * ch];
    loop {
        let n = d.read_f32(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n * ch]);
    }
    (info, out)
}

/// Pearson correlation of two equal-length signals.
fn correlation(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len()) as f64;
    let (ma, mb) = (a.iter().map(|x| *x as f64).sum::<f64>() / n, b.iter().map(|x| *x as f64).sum::<f64>() / n);
    let (mut sab, mut saa, mut sbb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (*x as f64 - ma, *y as f64 - mb);
        sab += x * y;
        saa += x * x;
        sbb += y * y;
    }
    sab / (saa * sbb).sqrt()
}

#[test]
fn the_encoders_opus_decodes_to_its_frames_lined_up_with_the_source() {
    for ch in [1usize, 2] {
        let frames = 48_000 * 2 + 777;
        let src = source(frames, ch, 48_000.0);
        let e = encode_opus(&src, ch, 48_000, 0.5);
        assert!(e.pre_skip > 0, "libopus reports its look-ahead as the pre-skip");
        let (info, dec) = decode(&e.bytes);
        assert_eq!(info.codec, Codec::Opus);
        assert_eq!((info.sample_rate, info.channels as usize), (48_000, ch));
        assert_eq!(dec.len() / ch, frames, "{ch} ch: pre-skip and end trimming give the input's frames");
        assert_eq!(info.frames, Some(frames as u64), "{ch} ch: the stated length");
        for c in 0..ch {
            let (s, d) = (channel(&src, ch, c), channel(&dec, ch, c));
            assert_eq!(best_lag(&s, &d, 960), 0, "{ch} ch, channel {c}: lag");
            let snr = snr_db(&s, &d, 0, 2048);
            let r = correlation(&s[2048..frames - 2048], &d[2048..frames - 2048]);
            eprintln!("Opus q 0.5, {ch} ch, channel {c}: SNR {snr:.1} dB, correlation {r:.5}");
            assert!(snr > 15.0 && r > 0.99, "{ch} ch, channel {c}: SNR {snr:.1} dB, r {r:.4}");
        }
    }
}

#[test]
fn a_44100_source_decodes_at_48000_with_its_length_scaled() {
    let frames = 44_100 * 2;
    let src = source(frames, 2, 44_100.0);
    let e = encode_opus(&src, 2, 44_100, 0.3);
    let (info, dec) = decode(&e.bytes);
    assert_eq!(info.sample_rate, 48_000);
    assert_eq!(dec.len() / 2, e.frames as usize, "what the encoder says it wrote");
    assert!((e.frames as i64 - 96_000).abs() <= 1, "{} frames", e.frames);
}

#[test]
fn opus_seeks_read_what_a_straight_decode_read() {
    let frames = 48_000 * 3;
    let src = source(frames, 2, 48_000.0);
    let e = encode_opus(&src, 2, 48_000, 0.5);
    let (_, whole) = decode(&e.bytes);
    let mut d = Decoder::open(Arc::new(e.bytes.clone()), FormatHint::Ogg).unwrap();
    for target in [100_000u64, 12_345, 0, 70_000, (frames - 100) as u64] {
        assert_eq!(d.seek(target).unwrap(), target);
        let mut buf = vec![0f32; 2 * 2048];
        let n = d.read_f32(&mut buf).unwrap();
        assert!(n > 0);
        let at = target as usize * 2;
        // After the 0.5 s pre-roll libopus has converged: the samples equal the straight decode's within an LSB or so.
        let worst = buf[..n * 2].iter().zip(&whole[at..at + n * 2]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(worst < 2e-3, "seek to {target}: worst difference {worst}");
    }
}

#[test]
fn the_engines_adpcm_entries_decode_through_the_abi() {
    let pcm: Vec<i16> = (0..3_000 * 2).map(|i| ((i as f32 * 0.01).sin() * 9_000.0) as i16).collect();
    let blocks = enc::adpcm::encode(&pcm, 2);
    let p = myco_audio_decode::myco_decode_alloc(blocks.len() as u32);
    let out = myco_audio_decode::myco_decode_alloc(3_000 * 2 * 2) as *mut i16;
    // SAFETY: both blocks are ours, of those sizes.
    unsafe {
        core::ptr::copy_nonoverlapping(blocks.as_ptr(), p, blocks.len());
        assert_eq!(myco_audio_decode::myco_decode_adpcm(p, blocks.len() as u32, 2, 3_000, out), 3_000);
        let got = core::slice::from_raw_parts(out, 6_000);
        let mut want = vec![0i16; 6_000];
        audio_adpcm_reference(&blocks, &mut want);
        assert_eq!(got, &want[..]);
        assert_eq!(myco_audio_decode::myco_decode_adpcm(p, 100, 2, 3_000, out), myco_audio_decode::ERR_DECODE, "too few blocks");
        assert_eq!(myco_audio_decode::myco_decode_adpcm(p, blocks.len() as u32, 3, 1, out), myco_audio_decode::ERR_ARG, "3 channels");
        myco_audio_decode::myco_decode_free(p, blocks.len() as u32);
        myco_audio_decode::myco_decode_free(out.cast(), 3_000 * 2 * 2);
    }
}

/// The encoder's reconstruction, by the plain IMA update (independent of `audio_adpcm`).
fn audio_adpcm_reference(blocks: &[u8], out: &mut [i16]) {
    let (ch, frames) = (2usize, out.len() / 2);
    for b in 0..frames.div_ceil(1024) {
        let block = &blocks[b * ch * 516..];
        for c in 0..ch {
            let mut pred = i16::from_le_bytes([block[c * 4], block[c * 4 + 1]]) as i32;
            let mut index = block[c * 4 + 2] as i32;
            for i in 0..1024 {
                let f = b * 1024 + i;
                let n = (block[ch * 4 + c * 512 + i / 2] >> ((i & 1) * 4)) & 15;
                let step = enc::adpcm::STEPS[index as usize] as i32;
                let mut diff = step >> 3;
                if n & 4 != 0 {
                    diff += step;
                }
                if n & 2 != 0 {
                    diff += step >> 1;
                }
                if n & 1 != 0 {
                    diff += step >> 2;
                }
                pred = if n & 8 != 0 { pred - diff } else { pred + diff }.clamp(-32768, 32767);
                index = (index + enc::adpcm::INDEX_ADJUST[n as usize] as i32).clamp(0, 88);
                if f < frames {
                    out[f * ch + c] = pred as i16;
                }
            }
        }
    }
}
