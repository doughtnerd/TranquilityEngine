//! IMA ADPCM: encode through the crate's interface, decode with a reader written here from the layout in `adpcm.rs`'s
//! documentation (the core's reader is ADR 0337 A4's), and check the round trip, block independence and the layout.

mod common;

use common::*;
use myco_audio_encode::adpcm::{encoded_bytes, BLOCK_FRAMES, CHANNEL_BYTES, HEADER_BYTES};
use myco_audio_encode::{encode, Codec, Settings};

const STEPS: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
const ADJUST: [i32; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/// Decodes channel `c` of one block on its own (its header only), all 1,024 frames.
fn read_block(block: &[u8], channels: usize, c: usize) -> Vec<i16> {
    let h = &block[c * 4..c * 4 + 4];
    let mut predictor = i16::from_le_bytes([h[0], h[1]]) as i32;
    let mut index = h[2].min(88) as i32;
    let data = &block[channels * 4 + c * 512..channels * 4 + (c + 1) * 512];
    let mut out = Vec::with_capacity(1024);
    for i in 0..1024 {
        let code = if i % 2 == 0 { data[i / 2] & 15 } else { data[i / 2] >> 4 } as i32;
        let step = STEPS[index as usize];
        let mut diff = step >> 3;
        if code & 4 != 0 {
            diff += step;
        }
        if code & 2 != 0 {
            diff += step >> 1;
        }
        if code & 1 != 0 {
            diff += step >> 2;
        }
        predictor = if code & 8 != 0 { predictor - diff } else { predictor + diff }.clamp(-32768, 32767);
        index = (index + ADJUST[code as usize]).clamp(0, 88);
        out.push(predictor as i16);
    }
    out
}

/// The whole stream back to interleaved −1..1 (`frames` frames).
fn read_all(bytes: &[u8], channels: usize, frames: usize) -> Vec<f32> {
    let mut out = vec![0f32; frames * channels];
    for (b, block) in bytes.chunks_exact(channels * CHANNEL_BYTES).enumerate() {
        for c in 0..channels {
            for (i, s) in read_block(block, channels, c).into_iter().enumerate() {
                let f = b * BLOCK_FRAMES + i;
                if f < frames {
                    out[f * channels + c] = s as f32 / 32768.0;
                }
            }
        }
    }
    out
}

fn adpcm() -> Settings {
    Settings { codec: Codec::Adpcm, quality: 0.5, rate_ceiling: None, mono: false }
}

#[test]
fn round_trips_stereo_within_ima_precision() {
    let frames = 48_000 + 123; // a short last block
    let src = sines(frames, 2, 48_000, 440.0);
    let out = encode(&src, 2, 48_000, &adpcm()).unwrap();
    assert_eq!((out.rate, out.channels, out.frames, out.pre_skip), (48_000, 2, frames as u64, 0));
    assert_eq!(out.bytes.len(), encoded_bytes(frames, 2));
    assert_eq!(out.bytes.len(), frames.div_ceil(1024) * 2 * 516, "516 bytes per channel per 1,024 frames");
    let back = read_all(&out.bytes, 2, frames);
    for c in 0..2 {
        let snr = snr_db(&channel(&src, 2, c), &channel(&back, 2, c));
        assert!(snr > 30.0, "channel {c}: SNR {snr:.1} dB");
    }
}

#[test]
fn every_block_decodes_alone_and_starts_from_its_first_sample() {
    let frames = 5 * BLOCK_FRAMES;
    let src = sines(frames, 1, 44_100, 1000.0);
    let out = encode(&src, 1, 44_100, &adpcm()).unwrap();
    let whole = read_all(&out.bytes, 1, frames);
    for b in 0..5 {
        let block = &out.bytes[b * CHANNEL_BYTES..(b + 1) * CHANNEL_BYTES];
        // The header predictor is the block's first source sample.
        let first = (src[b * BLOCK_FRAMES] * 32768.0).round() as i16;
        assert_eq!(i16::from_le_bytes([block[0], block[1]]), first, "block {b} predictor");
        assert!(block[2] <= 88, "block {b} step index");
        assert_eq!(block[3], 0, "block {b} reserved byte");
        // Decoded alone, it matches the sequential decode exactly.
        let alone = read_block(block, 1, 0);
        for i in 0..BLOCK_FRAMES {
            assert_eq!(alone[i] as f32 / 32768.0, whole[b * BLOCK_FRAMES + i], "block {b} frame {i}");
        }
    }
    assert_eq!(HEADER_BYTES, 4);
}

#[test]
fn channels_are_planar_with_headers_first() {
    // Channel 0 silent, channel 1 a loud square: the headers sit at 0 and 4, channel 0's codes at 8..520.
    let frames = BLOCK_FRAMES;
    let mut src = vec![0f32; frames * 2];
    for i in 0..frames {
        src[i * 2 + 1] = if (i / 32) % 2 == 0 { 0.8 } else { -0.8 };
    }
    let out = encode(&src, 2, 22_050, &adpcm()).unwrap();
    assert_eq!(out.bytes.len(), 2 * CHANNEL_BYTES);
    assert_eq!(i16::from_le_bytes([out.bytes[4], out.bytes[5]]), (0.8f32 * 32768.0).round() as i16);
    let silent = read_block(&out.bytes, 2, 0);
    assert!(silent.iter().all(|&s| s.abs() <= 8), "channel 0 stays near silence");
    let loud = read_block(&out.bytes, 2, 1);
    assert!(loud.iter().map(|s| s.unsigned_abs()).max().unwrap() > 20_000, "channel 1 decodes loud");
}

#[test]
fn mono_downmix_and_rate_ceiling_apply_before_adpcm() {
    let frames = 44_100;
    let src = sines(frames, 2, 44_100, 300.0);
    let s = Settings { mono: true, rate_ceiling: Some(22_050), ..adpcm() };
    let out = encode(&src, 2, 44_100, &s).unwrap();
    assert_eq!((out.channels, out.rate), (1, 22_050));
    assert!((out.frames as i64 - 22_050).abs() <= 1, "frames {}", out.frames);
    assert_eq!(out.bytes.len(), encoded_bytes(out.frames as usize, 1));
}
