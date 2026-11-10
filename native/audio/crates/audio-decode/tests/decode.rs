//! One case per fixture (task B1): each decodes with the right rate, channels and length, and
//! matches its WAV source: bit-exact for WAV and FLAC, by SNR after alignment for the lossy codecs.
//! The fixtures and their sources come from tests/fixtures/generate.mjs.

mod common;

use common::*;
use myco_audio_decode::Codec;
#[cfg(not(feature = "aac"))]
use myco_audio_decode::{DecodeError, Decoder, FormatHint};

/// Decodes `name` and requires it to equal `source` sample for sample, through both outputs.
fn check_lossless(name: &str, source: &str, codec: Codec) {
    let src = wav(source);
    let (info, dec) = decode_all(name, 4096);
    assert_eq!(info.codec, codec, "{name}: codec");
    assert_eq!(info.sample_rate, src.rate, "{name}: rate");
    assert_eq!(info.channels as usize, src.channels, "{name}: channels");
    assert_eq!(info.frames, Some(src.frames() as u64), "{name}: stated frames");
    assert_eq!(info.frames_estimate, info.frames, "{name}: estimate");
    assert_eq!(dec.len(), src.samples.len(), "{name}: decoded samples");
    let full = (1i64 << (src.bits - 1)) as f32;
    for (i, (&d, &s)) in dec.iter().zip(&src.samples).enumerate() {
        assert_eq!(d * full, s as f32, "{name}: sample {i}");
    }
    // The int16 output: exact for 16-bit sources, rounded for 24-bit ones.
    let mut d = open(name);
    let mut out = vec![0i16; src.samples.len()];
    assert_eq!(d.read_i16(&mut out).unwrap(), src.frames());
    for (i, (&o, &s)) in out.iter().zip(&src.samples).enumerate() {
        let want = if src.bits == 16 { s } else { ((s as f64) / 256.0).round().clamp(-32768.0, 32767.0) as i32 };
        assert_eq!(i32::from(o), want, "{name}: int16 sample {i}");
    }
}

#[test]
fn wav_44100_mono() {
    check_lossless("tone-44100-mono.wav", "tone-44100-mono.wav", Codec::Pcm);
}

#[test]
fn wav_48000_stereo() {
    check_lossless("tone-48000-stereo.wav", "tone-48000-stereo.wav", Codec::Pcm);
}

#[test]
fn wav_22050_stereo_s24() {
    check_lossless("tone-22050-stereo-s24.wav", "tone-22050-stereo-s24.wav", Codec::Pcm);
}

#[test]
fn flac_44100_mono() {
    check_lossless("tone-44100-mono.flac", "tone-44100-mono.wav", Codec::Flac);
}

#[test]
fn flac_48000_stereo() {
    check_lossless("tone-48000-stereo.flac", "tone-48000-stereo.wav", Codec::Flac);
}

#[test]
fn flac_22050_stereo_s24() {
    check_lossless("tone-22050-stereo-s24.flac", "tone-22050-stereo-s24.wav", Codec::Flac);
}

/// A gapless lossy file: the stated length is the source's, the decode has exactly that many
/// frames, and it lines up with the source at lag 0.
fn check_gapless(name: &str, source: &str, codec: Codec, min_db: f64) {
    let src = wav(source);
    let d = open(name);
    let info = d.info();
    assert_eq!(info.codec, codec, "{name}: codec");
    assert_eq!(info.frames, Some(src.frames() as u64), "{name}: stated frames");
    let (_, dec) = decode_all(name, 4096);
    assert_eq!(dec.len() / src.channels, src.frames(), "{name}: decoded frames");
    check_lossy(name, source, min_db, Some(0));
}

#[test]
fn mp3_44100_mono_cbr() {
    // 96 kb/s mono measures about 26 dB on this signal.
    check_gapless("tone-44100-mono.mp3", "tone-44100-mono.wav", Codec::Mp3, 20.0);
}

#[test]
fn mp3_48000_stereo_vbr_xing() {
    check_gapless("tone-48000-stereo.mp3", "tone-48000-stereo.wav", Codec::Mp3, 25.0);
}

/// MS7's unknown-length case: a VBR MP3 without a Xing/Info header reports no exact length (only
/// symphonia's bitrate estimate), and decodes fully: the source plus the encoder's delay and padding
/// (nothing says how much to trim).
#[test]
fn mp3_48000_stereo_vbr_without_xing() {
    let name = "tone-48000-stereo-vbr-noxing.mp3";
    let d = open(name);
    let info = d.info();
    assert_eq!(info.codec, Codec::Mp3);
    assert_eq!(info.frames, None, "no exact length without a Xing header");
    assert!(info.frames_estimate.is_some(), "symphonia's estimate is still reported");
    let (lag, _) = check_lossy(name, "tone-48000-stereo.wav", 25.0, None);
    let (_, dec) = decode_all(name, 4096);
    let frames = dec.len() / 2;
    // MP3 frames are 1,152 samples; the decode covers the source after the decoder delay.
    assert_eq!(frames % 1152, 0, "whole MP3 frames");
    assert!(lag > 0 && frames >= 48000 + lag as usize, "{frames} frames, lag {lag}");
}

#[test]
fn vorbis_44100_mono() {
    check_gapless("tone-44100-mono.ogg", "tone-44100-mono.wav", Codec::Vorbis, 25.0);
}

#[test]
fn vorbis_48000_stereo() {
    check_gapless("tone-48000-stereo.ogg", "tone-48000-stereo.wav", Codec::Vorbis, 25.0);
}

/// AAC in M4A (task B4): symphonia 0.6.1's isomp4 reader ignores the edit list (`elst`) and its AAC
/// decoder doesn't trim, so the decoder trims the encoder's 1,024 priming frames and the last frame's
/// padding itself, from the edit list: the stated length is the source's and the decode lines up
/// with it at lag 0, like the other gapless codecs.
#[cfg(feature = "aac")]
fn check_aac(name: &str, source: &str, min_db: f64) {
    check_gapless(name, source, Codec::Aac, min_db);
}

#[cfg(feature = "aac")]
#[test]
fn aac_44100_mono() {
    check_aac("tone-44100-mono.m4a", "tone-44100-mono.wav", 25.0);
}

#[cfg(feature = "aac")]
#[test]
fn aac_48000_stereo() {
    check_aac("tone-48000-stereo.m4a", "tone-48000-stereo.wav", 25.0);
}

/// Without the `aac` feature an M4A is refused with a clear error, not a panic.
#[cfg(not(feature = "aac"))]
#[test]
fn aac_refused_without_the_feature() {
    for name in ["tone-44100-mono.m4a", "tone-48000-stereo.m4a"] {
        match Decoder::open(bytes(name), FormatHint::Mp4) {
            Err(DecodeError::Format(_)) | Err(DecodeError::Codec(_)) => {}
            Err(e) => panic!("{name}: unexpected {e:?}"),
            Ok(_) => panic!("{name}: opened without the aac feature"),
        }
    }
}
