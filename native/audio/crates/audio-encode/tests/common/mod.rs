//! Test helpers: signals, an Ogg page walker, SNR, and the shipped decoder.
#![allow(dead_code)]

use std::sync::Arc;

use myco_audio_decode::{Decoder, FormatHint, Info};

/// `frames` frames of `channels` channels at `rate`: channel `c` is a sine of `freq × (c + 1)` Hz at 0.5, interleaved.
pub fn sines(frames: usize, channels: usize, rate: u32, freq: f64) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        for c in 0..channels {
            let f = freq * (c + 1) as f64;
            out.push((0.5 * (2.0 * std::f64::consts::PI * f * i as f64 / rate as f64).sin()) as f32);
        }
    }
    out
}

/// One Ogg page: its granule position, flags and packets' bytes (segments joined; a packet spanning pages isn't
/// expected in these tests' header pages).
pub struct Page {
    pub granule: i64,
    pub flags: u8,
    pub serial: u32,
    pub body: Vec<u8>,
    pub segments: Vec<u8>,
}

/// Every page of an Ogg stream, checking the capture pattern.
pub fn pages(bytes: &[u8]) -> Vec<Page> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        assert_eq!(&bytes[at..at + 4], b"OggS", "capture pattern at byte {at}");
        let flags = bytes[at + 5];
        let granule = i64::from_le_bytes(bytes[at + 6..at + 14].try_into().unwrap());
        let serial = u32::from_le_bytes(bytes[at + 14..at + 18].try_into().unwrap());
        let n = bytes[at + 26] as usize;
        let segments = bytes[at + 27..at + 27 + n].to_vec();
        let body_len: usize = segments.iter().map(|&s| s as usize).sum();
        let body_at = at + 27 + n;
        out.push(Page { granule, flags, serial, body: bytes[body_at..body_at + body_len].to_vec(), segments });
        at = body_at + body_len;
    }
    out
}

/// Packets that end on each page (a lacing value < 255 ends a packet).
pub fn packets_ending(page: &Page) -> usize {
    page.segments.iter().filter(|&&s| s < 255).count()
}

/// Signal-to-noise ratio of `test` against `reference`, dB, over their common length.
pub fn snr_db(reference: &[f32], test: &[f32]) -> f64 {
    let (mut sig, mut err) = (0f64, 0f64);
    for (a, b) in reference.iter().zip(test) {
        sig += (*a as f64).powi(2);
        err += (*a as f64 - *b as f64).powi(2);
    }
    10.0 * (sig / err.max(1e-20)).log10()
}

/// Decodes `bytes` with the shipped decoder (audio-decode, symphonia): its info and every interleaved sample.
pub fn decode(bytes: Vec<u8>, hint: FormatHint) -> (Info, Vec<f32>) {
    let mut d = Decoder::open(Arc::new(bytes), hint).unwrap_or_else(|e| panic!("decoder opens the output: {}", e.message()));
    let info = d.info();
    let ch = info.channels as usize;
    let mut out = Vec::new();
    let mut buf = vec![0f32; 4096 * ch];
    loop {
        let n = d.read_f32(&mut buf).unwrap_or_else(|e| panic!("decodes: {}", e.message()));
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n * ch]);
    }
    (info, out)
}

/// Every sample of channel `c`.
pub fn channel(samples: &[f32], channels: usize, c: usize) -> Vec<f32> {
    samples.iter().skip(c).step_by(channels).copied().collect()
}

/// Upward zero crossings of `x` (an estimate of a sine's cycles).
pub fn crossings(x: &[f32]) -> usize {
    x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count()
}
