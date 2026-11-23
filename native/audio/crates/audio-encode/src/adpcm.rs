//! IMA ADPCM encoding (the public IMA/DVI algorithm) in the block layout of ADR 0351 §3 as 0359 §5 settles it: blocks
//! of [`BLOCK_FRAMES`] (1,024) frames per channel, each channel's part starting with its own header so any block decodes
//! alone. This layout isn't WAV IMA ADPCM (which interleaves 4-byte groups in blocks of 1 + 8k frames): the core's block
//! reader (ADR 0351 A4) and the decoder worker read it, never symphonia.
//!
//! **Block layout** (planar, little-endian; block bytes = `channels × 516`):
//! - for each channel `c` in order, a 4-byte header: `i16 predictor`, `u8 step_index` (0..88), `u8 0`;
//! - then for each channel in order, 512 bytes holding 1,024 4-bit codes, the low nibble first.
//!
//! The header's predictor is the decoder's state **before** the block's first code; the encoder sets it to the block's
//! first source sample, so error never carries across blocks. The step index carries over from the previous block (0
//! in the first). Decoding a code: `step = STEPS[index]`; `diff = step >> 3`, plus `step` if bit 2, `step >> 1` if bit
//! 1, `step >> 2` if bit 0; bit 3 negates `diff`; `predictor = clamp(predictor ± diff, -32768, 32767)` is the sample;
//! `index = clamp(index + INDEX_ADJUST[code], 0, 88)`. A short last block is padded with silence; the frame count
//! travels outside the blocks (the package TOC, the encoder's result).

/// Frames per channel in one block.
pub const BLOCK_FRAMES: usize = 1024;
/// Bytes of one channel's header.
pub const HEADER_BYTES: usize = 4;
/// Bytes of one channel's codes in one block.
pub const DATA_BYTES: usize = BLOCK_FRAMES / 2;
/// Bytes per channel per block (header and codes).
pub const CHANNEL_BYTES: usize = HEADER_BYTES + DATA_BYTES;

/// The IMA step table.
pub const STEPS: [i16; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
    118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
    6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
];
/// The IMA step-index adjustment per code.
pub const INDEX_ADJUST: [i8; 16] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

/// Bytes of `frames` frames of `channels` channels in this layout (whole blocks).
pub fn encoded_bytes(frames: usize, channels: usize) -> usize {
    frames.div_ceil(BLOCK_FRAMES) * channels * CHANNEL_BYTES
}

#[derive(Clone, Copy, Default)]
struct State {
    predictor: i32,
    index: i32,
}

impl State {
    /// Applies `code` as the decoder will.
    #[inline(always)]
    fn apply(&mut self, code: u8) {
        let step = STEPS[self.index as usize] as i32;
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
        self.predictor = if code & 8 != 0 { self.predictor - diff } else { self.predictor + diff }.clamp(-32768, 32767);
        self.index = (self.index + INDEX_ADJUST[code as usize] as i32).clamp(0, 88);
    }

    /// The standard greedy IMA quantiser for `sample`; updates the state as the decoder will.
    #[inline(always)]
    fn encode(&mut self, sample: i16) -> u8 {
        let step = STEPS[self.index as usize] as i32;
        let mut diff = sample as i32 - self.predictor;
        let mut code = 0u8;
        if diff < 0 {
            code = 8;
            diff = -diff;
        }
        let mut s = step;
        if diff >= s {
            code |= 4;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            code |= 2;
            diff -= s;
        }
        s >>= 1;
        if diff >= s {
            code |= 1;
        }
        self.apply(code);
        code
    }
}

/// Encodes interleaved int16 (`pcm.len() / channels` frames) into blocks.
pub fn encode(pcm: &[i16], channels: usize) -> Vec<u8> {
    if channels == 0 {
        return Vec::new();
    }
    let frames = pcm.len() / channels;
    let blocks = frames.div_ceil(BLOCK_FRAMES);
    let mut out = vec![0u8; blocks * channels * CHANNEL_BYTES];
    let mut states = vec![State::default(); channels];
    for b in 0..blocks {
        let block = &mut out[b * channels * CHANNEL_BYTES..(b + 1) * channels * CHANNEL_BYTES];
        let start = b * BLOCK_FRAMES;
        for (c, st) in states.iter_mut().enumerate() {
            let first = pcm[start * channels + c];
            st.predictor = first as i32;
            let h = &mut block[c * HEADER_BYTES..(c + 1) * HEADER_BYTES];
            h[0..2].copy_from_slice(&first.to_le_bytes());
            h[2] = st.index as u8;
            h[3] = 0;
            let data_at = channels * HEADER_BYTES + c * DATA_BYTES;
            for i in 0..BLOCK_FRAMES {
                let f = start + i;
                let s = if f < frames { pcm[f * channels + c] } else { 0 };
                let code = st.encode(s);
                let byte = &mut block[data_at + i / 2];
                if i & 1 == 0 {
                    *byte = code;
                } else {
                    *byte |= code << 4;
                }
            }
        }
    }
    out
}
