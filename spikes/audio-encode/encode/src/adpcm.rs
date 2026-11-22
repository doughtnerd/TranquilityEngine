//! IMA ADPCM (the public IMA/DVI algorithm), in the block layout ADR 0337 §3 sketches: 1,024 frames per channel per
//! block, each channel's part starting with its own predictor header so any block decodes alone.
//!
//! Block layout (planar, little-endian), per channel c in order: `i16 predictor, u8 step_index, u8 0`, then for each
//! channel the 512 bytes of 1,024 nibbles (low nibble first). Block bytes = channels × 516. The header predictor is
//! the decoder's state *before* the block's first sample (set to the source's first sample, so drift never carries
//! across blocks). A short last block is padded with silence; the frame count lives outside the block data.
//!
//! Shared by the encoder (`main.rs`) and the core-cost bench (`../../adpcm-bench`, which `#[path]`-includes this file).
#![allow(dead_code)]

pub const BLOCK_FRAMES: usize = 1024;
pub const HEADER_BYTES: usize = 4;
pub const DATA_BYTES: usize = BLOCK_FRAMES / 2;
pub const CHANNEL_BYTES: usize = HEADER_BYTES + DATA_BYTES;

pub const STEPS: [i16; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
pub const INDEX_ADJUST: [i8; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/// One channel's decoder state.
#[derive(Clone, Copy, Debug, Default)]
pub struct State {
    pub predictor: i32,
    pub index: i32,
}

impl State {
    /// Decodes one nibble, returning the sample.
    #[inline(always)]
    pub fn step(&mut self, nibble: u8) -> i16 {
        let step = STEPS[self.index as usize] as i32;
        let mut diff = step >> 3;
        if nibble & 4 != 0 {
            diff += step;
        }
        if nibble & 2 != 0 {
            diff += step >> 1;
        }
        if nibble & 1 != 0 {
            diff += step >> 2;
        }
        if nibble & 8 != 0 {
            self.predictor -= diff;
        } else {
            self.predictor += diff;
        }
        self.predictor = self.predictor.clamp(-32768, 32767);
        self.index = (self.index + INDEX_ADJUST[nibble as usize] as i32).clamp(0, 88);
        self.predictor as i16
    }

    /// Encodes one sample greedily (the standard IMA quantiser), updating the state as the decoder will.
    #[inline(always)]
    fn encode(&mut self, sample: i16) -> u8 {
        let step = STEPS[self.index as usize] as i32;
        let mut diff = sample as i32 - self.predictor;
        let mut nibble = 0u8;
        if diff < 0 {
            nibble = 8;
            diff = -diff;
        }
        let mut s = step;
        if diff >= s {
            nibble |= 4;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            nibble |= 2;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            nibble |= 1;
        }
        self.step(nibble);
        nibble
    }
}

/// Encodes interleaved int16 into blocks. Returns the bytes; frames = `pcm.len() / channels`.
pub fn encode(pcm: &[i16], channels: usize) -> Vec<u8> {
    let frames = pcm.len() / channels;
    let blocks = frames.div_ceil(BLOCK_FRAMES);
    let mut out = vec![0u8; blocks * channels * CHANNEL_BYTES];
    let mut states = vec![State::default(); channels];
    for b in 0..blocks {
        let block = &mut out[b * channels * CHANNEL_BYTES..(b + 1) * channels * CHANNEL_BYTES];
        let start = b * BLOCK_FRAMES;
        for c in 0..channels {
            let first = pcm[start * channels + c];
            states[c].predictor = first as i32;
            let h = &mut block[c * HEADER_BYTES..(c + 1) * HEADER_BYTES];
            h[0..2].copy_from_slice(&first.to_le_bytes());
            h[2] = states[c].index as u8;
            let data_at = channels * HEADER_BYTES + c * DATA_BYTES;
            for i in 0..BLOCK_FRAMES {
                let f = start + i;
                let s = if f < frames { pcm[f * channels + c] } else { 0 };
                let n = states[c].encode(s);
                let byte = &mut block[data_at + i / 2];
                if i & 1 == 0 {
                    *byte = n;
                } else {
                    *byte |= n << 4;
                }
            }
        }
    }
    out
}

/// Decodes block `b`'s channel `c` (`count` frames from `skip`) into `out`.
pub fn decode_channel(block: &[u8], channels: usize, c: usize, skip: usize, out: &mut [i16]) {
    let h = &block[c * HEADER_BYTES..];
    let mut st = State { predictor: i16::from_le_bytes([h[0], h[1]]) as i32, index: (h[2] as i32).min(88) };
    let data = &block[channels * HEADER_BYTES + c * DATA_BYTES..][..DATA_BYTES];
    let mut written = 0;
    for i in 0..(skip + out.len()) {
        let byte = data[i / 2];
        let n = if i & 1 == 0 { byte & 15 } else { byte >> 4 };
        let s = st.step(n);
        if i >= skip {
            out[written] = s;
            written += 1;
        }
    }
}

/// Decodes a whole stream back to interleaved int16 (`frames` frames).
pub fn decode(bytes: &[u8], channels: usize, frames: usize) -> Vec<i16> {
    let mut pcm = vec![0i16; frames * channels];
    let mut tmp = vec![0i16; BLOCK_FRAMES];
    for (b, block) in bytes.chunks_exact(channels * CHANNEL_BYTES).enumerate() {
        let start = b * BLOCK_FRAMES;
        let n = BLOCK_FRAMES.min(frames.saturating_sub(start));
        for c in 0..channels {
            decode_channel(block, channels, c, 0, &mut tmp[..n]);
            for i in 0..n {
                pcm[(start + i) * channels + c] = tmp[i];
            }
        }
    }
    pcm
}
