//! IMA ADPCM in Myco's block layout (ADR 0337 §3 as 0345 §5 settles it): the one reader the audio core (clip format 6,
//! decoded per voice, a little each quantum) and the decoder worker (a `.mycopak` entry decoded whole) both use, so
//! the encoder's layout, the core and the worker agree by construction.
//!
//! **Block layout** (planar, little-endian; block bytes = `channels × 516`), as `audio-encode`'s `adpcm.rs` writes it:
//! - for each channel `c` in order, a 4-byte header: `i16 predictor`, `u8 step_index` (0..88), `u8 0`;
//! - then for each channel in order, 512 bytes holding 1,024 4-bit codes, the low nibble first.
//!
//! The header's predictor is the decoder's state **before** the block's first code, so any block decodes alone. A
//! code `n` updates the state: `step = STEPS[index]`; `diff = step >> 3`, plus `step` if bit 2, `step >> 1` if bit 1,
//! `step >> 2` if bit 0; bit 3 negates `diff`; `predictor = clamp(predictor ± diff, -32768, 32767)` is the sample;
//! `index = clamp(index + INDEX_ADJUST[n], 0, 88)`. A short last block is padded; the frame count travels outside.
//!
//! [`State::step`] is that update without a branch or a bounds check (0345 §5: the incremental decoder the A0 spike
//! measured at +23k wasm instructions per voice per quantum). A header's step index above 88 (corrupt data) is
//! clamped, so no input can read outside the tables.
//!
//! The encoder (`audio-encode`, built for wasm32-wasip1 with wasi-sdk) keeps its own copy of the tables and its
//! branchy update for its quantiser; this crate's tests encode with it and decode here, and compare the tables, so
//! a change on either side fails them.

#![no_std]

/// Frames per channel in one block.
pub const BLOCK_FRAMES: usize = 1024;
/// Bytes of one channel's header.
pub const HEADER_BYTES: usize = 4;
/// Bytes of one channel's codes in one block.
pub const DATA_BYTES: usize = BLOCK_FRAMES / 2;
/// Bytes per channel per block (header and codes).
pub const CHANNEL_BYTES: usize = HEADER_BYTES + DATA_BYTES;
/// The largest step index.
pub const MAX_INDEX: i32 = 88;

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

/// Bytes of one block of `channels` channels.
pub const fn block_bytes(channels: usize) -> usize {
    channels * CHANNEL_BYTES
}

/// Blocks holding `frames` frames.
pub const fn blocks(frames: usize) -> usize {
    frames.div_ceil(BLOCK_FRAMES)
}

/// Bytes of `frames` frames of `channels` channels in this layout (whole blocks).
pub const fn encoded_bytes(frames: usize, channels: usize) -> usize {
    blocks(frames) * block_bytes(channels)
}

/// One channel's decoder state: the last sample and the step index.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    pub predictor: i32,
    /// 0..=[`MAX_INDEX`].
    pub index: i32,
}

impl State {
    /// Channel `c`'s header in `block` (a block of at least `(c + 1) × 4` bytes): the state before the block's first
    /// code. A step index above 88 is clamped.
    #[inline]
    pub fn from_header(block: &[u8], c: usize) -> State {
        let h = &block[c * HEADER_BYTES..c * HEADER_BYTES + HEADER_BYTES];
        State { predictor: i16::from_le_bytes([h[0], h[1]]) as i32, index: (h[2] as i32).min(MAX_INDEX) }
    }

    /// Applies code `n` (its low 4 bits) and returns the sample. Branchless, no bounds checks.
    #[inline(always)]
    pub fn step(&mut self, n: u32) -> i16 {
        let n = (n & 15) as i32;
        // SAFETY: `index` stays in 0..=88 (clamped below and in `from_header`), and `n < 16`.
        let step = unsafe { *STEPS.get_unchecked(self.index as usize) } as i32;
        let mut diff = step >> 3;
        diff += step & -((n >> 2) & 1);
        diff += (step >> 1) & -((n >> 1) & 1);
        diff += (step >> 2) & -(n & 1);
        let s = -((n >> 3) & 1); // 0 or -1: negate
        self.predictor = (self.predictor + ((diff ^ s) - s)).clamp(-32768, 32767);
        // SAFETY: as above.
        self.index = (self.index + unsafe { *INDEX_ADJUST.get_unchecked(n as usize) } as i32).clamp(0, MAX_INDEX);
        self.predictor as i16
    }
}

/// Channel `c`'s 512 code bytes in `block` (a whole block of `channels` channels).
#[inline(always)]
pub fn codes(block: &[u8], channels: usize, c: usize) -> &[u8] {
    let at = channels * HEADER_BYTES + c * DATA_BYTES;
    &block[at..at + DATA_BYTES]
}

/// Decodes frames `from..to` (`from <= to <= BLOCK_FRAMES`) of channel `c` of `block` (a whole block of `channels`
/// channels), continuing `state`, which must be the state before frame `from` (`State::from_header` when `from` is 0).
/// Writes frame `from + k` to `out[k * stride]`; `out` holds at least `(to - from - 1) * stride + 1` samples.
#[inline]
pub fn decode_run(block: &[u8], channels: usize, c: usize, from: usize, to: usize, state: &mut State, out: &mut [i16], stride: usize) {
    debug_assert!(from <= to && to <= BLOCK_FRAMES);
    if from >= to {
        return;
    }
    let data: &[u8; DATA_BYTES] = codes(block, channels, c).try_into().expect("a channel's codes are 512 bytes");
    let n = to - from;
    assert!(out.len() > (n - 1) * stride, "decode_run: the output is too short");
    let out = out.as_mut_ptr();
    let mut st = *state;
    let mut f = from;
    let mut at = 0usize;
    // SAFETY (every write below): frame `from + k` goes to `k * stride`, and `k < n`, which the assert covers; every
    // read is `data[f >> 1]` with `f < to <= 1024`.
    if f & 1 == 1 {
        let s = st.step((data[f >> 1] >> 4) as u32);
        unsafe { *out.add(at) = s };
        at += stride;
        f += 1;
    }
    while f + 2 <= to {
        let byte = unsafe { *data.get_unchecked(f >> 1) } as u32;
        let a = st.step(byte);
        let b = st.step(byte >> 4);
        unsafe {
            *out.add(at) = a;
            *out.add(at + stride) = b;
        }
        at += 2 * stride;
        f += 2;
    }
    if f < to {
        let s = st.step(data[f >> 1] as u32);
        unsafe { *out.add(at) = s };
    }
    *state = st;
}

/// Moves `state` (the state before frame `from`) over frames `from..to` of channel `c` without keeping the samples.
#[inline]
pub fn skip_run(block: &[u8], channels: usize, c: usize, from: usize, to: usize, state: &mut State) {
    let data = codes(block, channels, c);
    let mut st = *state;
    for f in from..to.min(BLOCK_FRAMES) {
        st.step((data[f >> 1] >> ((f & 1) * 4)) as u32);
    }
    *state = st;
}

/// Why a whole decode was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// No channels, or the output is shorter than `frames × channels`.
    Arg,
    /// Fewer bytes than [`encoded_bytes`] gives.
    Short,
}

/// Decodes the first `frames` frames of `bytes` (blocks of `channels` channels) into `out`, interleaved.
pub fn decode(bytes: &[u8], channels: usize, frames: usize, out: &mut [i16]) -> Result<(), DecodeError> {
    if channels == 0 || out.len() < frames * channels {
        return Err(DecodeError::Arg);
    }
    if bytes.len() < encoded_bytes(frames, channels) {
        return Err(DecodeError::Short);
    }
    let bb = block_bytes(channels);
    for b in 0..blocks(frames) {
        let block = &bytes[b * bb..(b + 1) * bb];
        let start = b * BLOCK_FRAMES;
        let n = (frames - start).min(BLOCK_FRAMES);
        for c in 0..channels {
            let mut st = State::from_header(block, c);
            decode_run(block, channels, c, 0, n, &mut st, &mut out[start * channels + c..], channels);
        }
    }
    Ok(())
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use myco_audio_encode::adpcm as enc;
    use std::vec;
    use std::vec::Vec;

    /// The plain, branchy update (the algorithm as written in the module comment).
    fn step_ref(st: &mut State, n: u8) -> i16 {
        let step = STEPS[st.index as usize] as i32;
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
        st.predictor = if n & 8 != 0 { st.predictor - diff } else { st.predictor + diff }.clamp(-32768, 32767);
        st.index = (st.index + INDEX_ADJUST[n as usize] as i32).clamp(0, 88);
        st.predictor as i16
    }

    fn signal(frames: usize, channels: usize) -> Vec<i16> {
        let mut seed = 0x2468_ace1u32;
        (0..frames * channels)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let f = (i / channels) as f32;
                let tone = (f * 0.031 * (1 + i % channels) as f32).sin() * 12_000.0;
                (tone + (seed as f32 / u32::MAX as f32 - 0.5) * 3_000.0) as i16
            })
            .collect()
    }

    #[test]
    fn the_tables_and_layout_are_the_encoders() {
        assert_eq!(STEPS, enc::STEPS);
        assert_eq!(INDEX_ADJUST, enc::INDEX_ADJUST);
        assert_eq!((BLOCK_FRAMES, HEADER_BYTES, DATA_BYTES, CHANNEL_BYTES), (enc::BLOCK_FRAMES, enc::HEADER_BYTES, enc::DATA_BYTES, enc::CHANNEL_BYTES));
        for (frames, ch) in [(1, 1), (1024, 2), (1025, 2), (5000, 1)] {
            assert_eq!(encoded_bytes(frames, ch), enc::encoded_bytes(frames, ch));
        }
    }

    #[test]
    fn the_branchless_step_is_the_reference_for_every_state_and_code() {
        for index in 0..=88 {
            for predictor in [-32768, -32000, -1000, -1, 0, 1, 1000, 32000, 32767] {
                for n in 0..16u8 {
                    let (mut a, mut b) = (State { predictor, index }, State { predictor, index });
                    assert_eq!(a.step(n as u32), step_ref(&mut b, n));
                    assert_eq!(a, b);
                }
            }
        }
    }

    #[test]
    fn the_encoders_blocks_decode_to_its_own_reconstruction() {
        // The encoder's quantiser tracks the decoder's state; decoding its codes must give what it tracked, which is
        // within the step of the source (a loose SNR check here; the exact check is the reference decode below).
        for ch in [1usize, 2] {
            let frames = 3 * BLOCK_FRAMES + 321;
            let pcm = signal(frames, ch);
            let bytes = enc::encode(&pcm, ch);
            let mut out = vec![0i16; frames * ch];
            decode(&bytes, ch, frames, &mut out).unwrap();
            // Reference: the branchy update over the same codes.
            let bb = block_bytes(ch);
            for b in 0..blocks(frames) {
                let block = &bytes[b * bb..(b + 1) * bb];
                for c in 0..ch {
                    let mut st = State::from_header(block, c);
                    let data = codes(block, ch, c);
                    for i in 0..BLOCK_FRAMES {
                        let f = b * BLOCK_FRAMES + i;
                        let s = step_ref(&mut st, (data[i >> 1] >> ((i & 1) * 4)) & 15);
                        if f < frames {
                            assert_eq!(out[f * ch + c], s, "block {b} frame {i} channel {c}");
                        }
                    }
                }
            }
            let (mut sig, mut err) = (0f64, 0f64);
            for (a, b) in pcm.iter().zip(&out) {
                sig += (*a as f64).powi(2);
                err += (*a as f64 - *b as f64).powi(2);
            }
            let snr = 10.0 * (sig / err).log10();
            assert!(snr > 25.0, "{ch} channels: SNR {snr:.1} dB");
        }
    }

    #[test]
    fn runs_from_any_frame_continue_the_state_bit_for_bit() {
        let ch = 2;
        let pcm = signal(BLOCK_FRAMES, ch);
        let bytes = enc::encode(&pcm, ch);
        let mut whole = vec![0i16; BLOCK_FRAMES * ch];
        decode(&bytes, ch, BLOCK_FRAMES, &mut whole).unwrap();
        // Pieces of every parity: [0,1) [1,4) [4,7) [7,500) [500,1023) [1023,1024).
        let cuts = [0usize, 1, 4, 7, 500, 1023, 1024];
        for c in 0..ch {
            let mut st = State::from_header(&bytes, c);
            let mut out = vec![0i16; BLOCK_FRAMES];
            for w in cuts.windows(2) {
                decode_run(&bytes, ch, c, w[0], w[1], &mut st, &mut out[w[0]..], 1);
            }
            for f in 0..BLOCK_FRAMES {
                assert_eq!(out[f], whole[f * ch + c]);
            }
            // Skipping then decoding lands on the same samples.
            let mut st = State::from_header(&bytes, c);
            skip_run(&bytes, ch, c, 0, 333, &mut st);
            let mut tail = vec![0i16; BLOCK_FRAMES - 333];
            decode_run(&bytes, ch, c, 333, BLOCK_FRAMES, &mut st, &mut tail, 1);
            assert_eq!(tail[0], whole[333 * ch + c]);
            assert_eq!(tail[BLOCK_FRAMES - 334], whole[(BLOCK_FRAMES - 1) * ch + c]);
        }
    }

    #[test]
    fn corrupt_headers_and_short_inputs_are_safe() {
        let mut block = vec![0xffu8; block_bytes(1)];
        block[2] = 200; // step index past 88
        let mut st = State::from_header(&block, 0);
        assert_eq!(st.index, 88);
        let mut out = vec![0i16; BLOCK_FRAMES];
        decode_run(&block, 1, 0, 0, BLOCK_FRAMES, &mut st, &mut out, 1);
        assert_eq!(decode(&block, 1, 1025, &mut vec![0; 1025]), Err(DecodeError::Short));
        assert_eq!(decode(&block, 0, 1, &mut out), Err(DecodeError::Arg));
    }
}
