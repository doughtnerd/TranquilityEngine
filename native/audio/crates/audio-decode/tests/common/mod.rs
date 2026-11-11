//! Shared helpers for audio-decode's tests: fixture loading, an independent WAV reader for the
//! sources, whole-file decode, and lossy-codec comparison (alignment and SNR).
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use myco_audio_decode::{Bytes, Decoder, FormatHint, Info};

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name)
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_path(name)).unwrap_or_else(|e| panic!("{name}: {e} (run tests/fixtures/generate.mjs)"))
}

pub fn bytes(name: &str) -> Bytes {
    Arc::new(fixture(name))
}

pub fn hint_for(name: &str) -> FormatHint {
    match name.rsplit('.').next() {
        Some("wav") => FormatHint::Wav,
        Some("flac") => FormatHint::Flac,
        Some("mp3") => FormatHint::Mp3,
        Some("ogg") => FormatHint::Ogg,
        Some("m4a") => FormatHint::Mp4,
        _ => FormatHint::None,
    }
}

pub fn open(name: &str) -> Decoder {
    Decoder::open(bytes(name), hint_for(name)).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

/// A WAV source read without symphonia: integer samples (interleaved), bits, rate, channels.
pub struct Wav {
    pub rate: u32,
    pub channels: usize,
    pub bits: u32,
    pub samples: Vec<i32>,
}

impl Wav {
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels
    }

    /// The samples as f32 in [-1, 1), as symphonia scales integers.
    pub fn as_f32(&self) -> Vec<f32> {
        let full = (1i64 << (self.bits - 1)) as f32;
        self.samples.iter().map(|&s| s as f32 / full).collect()
    }
}

/// Reads one of generate.mjs's WAVs (PCM, 16 or 24 bit, a 44-byte header).
pub fn wav(name: &str) -> Wav {
    let b = fixture(name);
    assert_eq!(&b[0..4], b"RIFF");
    assert_eq!(&b[36..40], b"data");
    let u16le = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
    let channels = usize::from(u16le(22));
    let rate = u32::from_le_bytes([b[24], b[25], b[26], b[27]]);
    let bits = u32::from(u16le(34));
    let data = &b[44..];
    let samples = match bits {
        16 => data.chunks_exact(2).map(|c| i32::from(i16::from_le_bytes([c[0], c[1]]))).collect(),
        24 => data.chunks_exact(3).map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]])) >> 8).collect(),
        _ => panic!("{name}: {bits}-bit WAV"),
    };
    Wav { rate, channels, bits, samples }
}

/// Decodes the whole file in `chunk`-frame reads. Returns the info and the interleaved samples.
pub fn decode_all(name: &str, chunk: usize) -> (Info, Vec<f32>) {
    let mut d = open(name);
    let info = d.info();
    let ch = info.channels as usize;
    let mut out = Vec::new();
    let mut buf = vec![0f32; chunk * ch];
    loop {
        let n = d.read_f32(&mut buf).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        out.extend_from_slice(&buf[..n * ch]);
        if n < chunk {
            // A short read is the end; the next read returns 0.
            assert_eq!(d.read_f32(&mut buf).unwrap(), 0, "{name}: a read after the end");
            break;
        }
    }
    assert_eq!(d.position() as usize, out.len() / ch);
    (info, out)
}

/// Channel `c` of interleaved `x`.
pub fn channel(x: &[f32], channels: usize, c: usize) -> Vec<f32> {
    x.iter().skip(c).step_by(channels).copied().collect()
}

/// The lag (decoded index minus source index) in `[-max, max]` maximising the correlation of a
/// window from the middle of `src` with `dec`.
pub fn best_lag(src: &[f32], dec: &[f32], max: isize) -> isize {
    let win = 8192.min(src.len() / 2);
    let start = (src.len() - win) / 2;
    let mut best = (f64::MIN, 0isize);
    for lag in -max..=max {
        let mut acc = 0f64;
        for i in 0..win {
            let j = (start + i) as isize + lag;
            if j < 0 || j as usize >= dec.len() {
                continue;
            }
            acc += f64::from(src[start + i]) * f64::from(dec[j as usize]);
        }
        if acc > best.0 {
            best = (acc, lag);
        }
    }
    best.1
}

/// SNR in dB of `dec` (shifted by `lag`) against `src`, over `src` minus `margin` samples at each
/// end (codec ringing at the fades).
pub fn snr_db(src: &[f32], dec: &[f32], lag: isize, margin: usize) -> f64 {
    let (mut sig, mut err) = (0f64, 0f64);
    for i in margin..src.len().saturating_sub(margin) {
        let j = i as isize + lag;
        let d = if j >= 0 && (j as usize) < dec.len() { dec[j as usize] } else { 0.0 };
        sig += f64::from(src[i]).powi(2);
        err += f64::from(src[i] - d).powi(2);
    }
    10.0 * (sig / err.max(1e-30)).log10()
}

/// Asserts a lossy decode matches its WAV source: same rate and channels, the expected lag (0 for
/// gapless files), and at least `min_db` SNR on every channel. Returns (lag, worst SNR).
pub fn check_lossy(name: &str, source: &str, min_db: f64, expect_lag: Option<isize>) -> (isize, f64) {
    let src = wav(source);
    let (info, dec) = decode_all(name, 4096);
    assert_eq!(info.sample_rate, src.rate, "{name}: rate");
    assert_eq!(info.channels as usize, src.channels, "{name}: channels");
    let ch = src.channels;
    let s = src.as_f32();
    let mut worst = f64::MAX;
    let mut lag0 = 0;
    for c in 0..ch {
        let sc = channel(&s, ch, c);
        let dc = channel(&dec, ch, c);
        let lag = best_lag(&sc, &dc, 2400);
        if let Some(want) = expect_lag {
            assert_eq!(lag, want, "{name}: channel {c} lag");
        }
        if c == 0 {
            lag0 = lag;
        }
        let snr = snr_db(&sc, &dc, lag, 2048);
        assert!(snr >= min_db, "{name}: channel {c} SNR {snr:.1} dB < {min_db} dB (lag {lag})");
        worst = worst.min(snr);
    }
    eprintln!("{name}: {} frames decoded, lag {lag0}, SNR {worst:.1} dB", dec.len() / ch);
    (lag0, worst)
}

/// A WAV built in memory (ADR 0162 B2): `channels` channels of `frames` frames at 48 kHz with a
/// plain 16-byte `fmt ` chunk. `bits` 16 writes PCM (`sample(frame, ch)` × 32768, rounded and
/// clamped); `bits` 32 writes IEEE float (format 3).
pub fn built_wav(channels: u16, frames: u32, bits: u16, sample: impl Fn(u32, u16) -> f32) -> Vec<u8> {
    let bytes = u32::from(bits / 8);
    let data = frames * u32::from(channels) * bytes;
    let mut b = Vec::with_capacity(44 + data as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&(if bits == 32 { 3u16 } else { 1u16 }).to_le_bytes());
    b.extend_from_slice(&channels.to_le_bytes());
    b.extend_from_slice(&48_000u32.to_le_bytes());
    b.extend_from_slice(&(48_000 * u32::from(channels) * bytes).to_le_bytes());
    b.extend_from_slice(&(channels * bits / 8).to_le_bytes());
    b.extend_from_slice(&bits.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for f in 0..frames {
        for c in 0..channels {
            let s = sample(f, c);
            if bits == 32 {
                b.extend_from_slice(&s.to_le_bytes());
            } else {
                b.extend_from_slice(&((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes());
            }
        }
    }
    b
}

/// [`built_wav`] at 16 bits from int16 samples.
pub fn pcm16_wav(channels: u16, frames: u32, sample: impl Fn(u32, u16) -> i16) -> Vec<u8> {
    built_wav(channels, frames, 16, |f, c| f32::from(sample(f, c)) / 32768.0)
}
