//! ADR 0337 spike A0/S3: what reading IMA ADPCM costs a voice in the core, against int16, in wasm instructions per
//! quantum (`run.mjs` meters this crate's wasm with `tools/audio-bench/meter.mjs`, the metered gate's instrumenter).
//!
//! Every mode renders N looping stereo voices through the core's own resampler (`audio_dsp::resample::lagrange`,
//! the voices' 4-point kernel) and sums them into a stereo mix, 128 frames a quantum. Only the source differs:
//! - mode 0 `int16`: the clip's int16 samples, as the core reads a CLIP_BEGIN format I16 clip today;
//! - mode 1 `block`: ADR 0337 §3's design: a 1,024-frame decode cache per voice (plus the 1 + 2 neighbour frames the
//!   kernel reads), filled with a whole block when the read position enters it;
//! - mode 2 `incremental`: the alternative: each quantum decodes only the frames it is about to read into a small
//!   sliding window, carrying the IMA state (block headers reset it), so no quantum pays for a whole block;
//! - mode 3 `incremental-fast`: mode 2 with a branchless, bounds-check-free step (bit-exact with mode 2), two
//!   nibbles per byte.
//!
//! `stagger` starts voices at random offsets (real play); without it every voice starts at frame 0, so in mode 1
//! all of them cross a block boundary in the same quantum (the worst case).
//! The clip is 188 blocks (192,512 frames, ≈ 4 s at 48 kHz) of a synthetic signal, encoded once at setup (not counted).

use audio_dsp::resample::{lagrange, Samples, Source};

#[path = "../../encode/src/adpcm.rs"]
mod adpcm;

use adpcm::{State, BLOCK_FRAMES as BF, CHANNEL_BYTES, DATA_BYTES, HEADER_BYTES};

const Q: usize = 128;
const CH: usize = 2;
const BLOCKS: usize = 188;
const FRAMES: usize = BLOCKS * BF;
const BLOCK_BYTES: usize = CH * CHANNEL_BYTES;
/// Block cache: frames block_start - 1 ..= block_start + 1025 (the kernel's idx - 1 and idx + 2 neighbours).
const CACHE: usize = BF + 3;
/// Incremental window in frames.
const WIN: usize = 1024;

struct Voice {
    pos: f64,
    block: usize,
    cache: Vec<i16>,
    win: Vec<i16>,
    /// Clip frame (unwrapped) of win[0], and frames decoded into win.
    win_start: usize,
    decoded: usize,
    st: [State; CH],
}

struct Bench {
    mode: u32,
    steps: [f32; Q],
    clip: Vec<i16>,
    ima: Vec<u8>,
    voices: Vec<Voice>,
    l: [f32; Q],
    r: [f32; Q],
    mix_l: [f32; Q],
    mix_r: [f32; Q],
}

static mut BENCH: Option<Bench> = None;

/// Decodes `count` frames of block `b`, channel `c`, from frame `from` within the block, into `out` (interleaved,
/// stride CH, starting at sample index `at`). Returns the state after the last frame.
#[inline(always)]
fn decode_into(ima: &[u8], b: usize, c: usize, from: usize, count: usize, out: &mut [i16], at: usize) {
    let block = &ima[(b % BLOCKS) * BLOCK_BYTES..][..BLOCK_BYTES];
    let h = &block[c * HEADER_BYTES..];
    let mut st = State { predictor: i16::from_le_bytes([h[0], h[1]]) as i32, index: h[2] as i32 };
    let data = &block[CH * HEADER_BYTES + c * DATA_BYTES..][..DATA_BYTES];
    for i in 0..from + count {
        let byte = data[i >> 1];
        let s = st.step(if i & 1 == 0 { byte & 15 } else { byte >> 4 });
        if i >= from {
            out[at + (i - from) * CH + c] = s;
        }
    }
}

/// Mode 1: fills the voice's cache for block `b` (sequential: frame block_start - 1 is the old cache's last block
/// frame; `seek` decodes the previous block for it instead).
fn enter_block(ima: &[u8], v: &mut Voice, b: usize, seek: bool) {
    if seek {
        for c in 0..CH {
            decode_into(ima, b + BLOCKS - 1, c, BF - 1, 1, &mut v.cache, 0);
        }
    } else {
        for c in 0..CH {
            v.cache[c] = v.cache[BF * CH + c];
        }
    }
    for c in 0..CH {
        decode_into(ima, b, c, 0, BF, &mut v.cache, CH);
        decode_into(ima, b + 1, c, 0, 2, &mut v.cache, (BF + 1) * CH);
    }
    v.block = b;
}

/// Mode 2: decodes frames [win_start + decoded, upto) into the window, carrying the IMA state.
#[inline(always)]
fn decode_upto(ima: &[u8], v: &mut Voice, upto: usize) {
    while v.win_start + v.decoded < upto {
        let f = v.win_start + v.decoded; // unwrapped clip frame
        let b = (f / BF) % BLOCKS;
        let i = f % BF;
        let n = (BF - i).min(upto - f);
        let block = &ima[b * BLOCK_BYTES..][..BLOCK_BYTES];
        for c in 0..CH {
            if i == 0 {
                let h = &block[c * HEADER_BYTES..];
                v.st[c] = State { predictor: i16::from_le_bytes([h[0], h[1]]) as i32, index: h[2] as i32 };
            }
            let data = &block[CH * HEADER_BYTES + c * DATA_BYTES..][..DATA_BYTES];
            let mut st = v.st[c];
            let mut at = v.decoded * CH + c;
            for k in i..i + n {
                let byte = data[k >> 1];
                v.win[at] = st.step(if k & 1 == 0 { byte & 15 } else { byte >> 4 });
                at += CH;
            }
            v.st[c] = st;
        }
        v.decoded += n;
    }
}

/// One IMA step, bit-exact with `State::step` (the standard shift-sum), but branchless and without bounds checks.
#[inline(always)]
fn step_fast(pred: &mut i32, index: &mut i32, n: u32) -> i16 {
    // SAFETY: index is kept in 0..=88 and n < 16.
    let step = unsafe { *adpcm::STEPS.get_unchecked(*index as usize) } as i32;
    let n = n as i32;
    let mut diff = step >> 3;
    diff += step & -((n >> 2) & 1);
    diff += (step >> 1) & -((n >> 1) & 1);
    diff += (step >> 2) & -(n & 1);
    let s = -((n >> 3) & 1); // 0 or -1
    *pred = (*pred + ((diff ^ s) - s)).clamp(-32768, 32767);
    *index = (*index + unsafe { *adpcm::INDEX_ADJUST.get_unchecked(n as usize) } as i32).clamp(0, 88);
    *pred as i16
}

/// Mode 3: `decode_upto` with `step_fast`, two nibbles per byte and unchecked stores.
#[inline(always)]
fn decode_upto_fast(ima: &[u8], v: &mut Voice, upto: usize) {
    while v.win_start + v.decoded < upto {
        let f = v.win_start + v.decoded;
        let b = (f / BF) % BLOCKS;
        let i = f % BF;
        // Whole bytes only (an even count from an even frame); the window keeps a frame or two of slack.
        let n = ((BF - i).min(upto - f + 1)) & !1;
        let n = if i & 1 == 1 { 1 } else { n.max(2) };
        let block = &ima[b * BLOCK_BYTES..][..BLOCK_BYTES];
        let out = v.win.as_mut_ptr();
        for c in 0..CH {
            if i == 0 {
                let h = &block[c * HEADER_BYTES..];
                v.st[c] = State { predictor: i16::from_le_bytes([h[0], h[1]]) as i32, index: h[2] as i32 };
            }
            let data = &block[CH * HEADER_BYTES + c * DATA_BYTES..][..DATA_BYTES];
            let (mut p, mut x) = (v.st[c].predictor, v.st[c].index);
            let mut at = v.decoded * CH + c;
            if n == 1 {
                // An odd start (only after a seek into the middle of a byte).
                let s = step_fast(&mut p, &mut x, (data[i >> 1] >> 4) as u32);
                unsafe { *out.add(at) = s };
            } else {
                for k in (i..i + n).step_by(2) {
                    let byte = unsafe { *data.get_unchecked(k >> 1) } as u32;
                    let a = step_fast(&mut p, &mut x, byte & 15);
                    let b2 = step_fast(&mut p, &mut x, byte >> 4);
                    unsafe {
                        *out.add(at) = a;
                        *out.add(at + CH) = b2;
                    }
                    at += 2 * CH;
                }
            }
            v.st[c] = State { predictor: p, index: x };
        }
        v.decoded += n;
    }
}

fn render_voice(b: &mut Bench, vi: usize) {
    let pitch = b.steps[0] as f64;
    let (ima, clip) = (&b.ima, &b.clip);
    let v = &mut b.voices[vi];
    match b.mode {
        0 => {
            let src = Source { samples: Samples::I16(clip), channels: 2, frames: FRAMES as u32 };
            lagrange(&src, &mut v.pos, &b.steps, true, &mut b.l, &mut b.r);
        }
        1 => {
            let mut done = 0;
            while done < Q {
                let start = (v.block * BF) as f64;
                let rel = v.pos - start;
                if rel >= BF as f64 {
                    let next = v.block + 1;
                    if next == BLOCKS {
                        v.pos -= FRAMES as f64;
                    }
                    enter_block(ima, v, next % BLOCKS, false);
                    continue;
                }
                let n = (((BF as f64 - rel) / pitch).ceil() as usize).clamp(1, Q - done);
                let src = Source { samples: Samples::I16(&v.cache), channels: 2, frames: CACHE as u32 };
                let mut p = rel + 1.0;
                lagrange(&src, &mut p, &b.steps[done..done + n], false, &mut b.l[done..done + n], &mut b.r[done..done + n]);
                v.pos = start + p - 1.0;
                done += n;
            }
        }
        _ => {
            let last = (v.pos + Q as f64 * pitch) as usize + 3;
            if last > v.win_start + WIN {
                // Slide: keep from frame floor(pos) - 1.
                let keep_from = v.pos as usize - 1;
                let shift = keep_from - v.win_start;
                v.win.copy_within(shift * CH..v.decoded * CH, 0);
                v.decoded -= shift;
                v.win_start = keep_from;
            }
            if b.mode == 3 {
                decode_upto_fast(ima, v, last);
            } else {
                decode_upto(ima, v, last);
            }
            let src = Source { samples: Samples::I16(&v.win[..v.decoded * CH]), channels: 2, frames: v.decoded as u32 };
            let mut p = v.pos - v.win_start as f64;
            lagrange(&src, &mut p, &b.steps, false, &mut b.l, &mut b.r);
            v.pos = v.win_start as f64 + p;
        }
    }
    for i in 0..Q {
        b.mix_l[i] += b.l[i];
        b.mix_r[i] += b.r[i];
    }
}

/// mode 0 int16, 1 block cache, 2 incremental; `voices` voices at `pitch`; `stagger` 1 = random start offsets.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn bench_setup(mode: u32, voices: u32, pitch: f32, stagger: u32) {
    let mut seed = 0x1234_5678u32;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed
    };
    let mut clip = vec![0i16; FRAMES * CH];
    for f in 0..FRAMES {
        let t = f as f32 / 48_000.0;
        for c in 0..CH {
            let tone = libm_sin(t * (220.0 + 110.0 * c as f32) * core::f32::consts::TAU) * 0.4;
            let noise = (rnd() as f32 / u32::MAX as f32 - 0.5) * 0.2;
            clip[f * CH + c] = ((tone + noise) * 32767.0) as i16;
        }
    }
    let ima = adpcm::encode(&clip, CH);
    let mut vs = Vec::new();
    for _ in 0..voices {
        let start = if stagger != 0 { (rnd() as usize) % FRAMES } else { 0 };
        let mut v = Voice { pos: start as f64, block: start / BF, cache: vec![0; CACHE * CH], win: vec![0; (WIN + 4) * CH], win_start: start.saturating_sub(1), decoded: 0, st: [State::default(); CH] };
        if mode == 1 {
            enter_block(&ima, &mut v, start / BF, true);
        }
        if mode >= 2 {
            // Seek: decode from the block start up to the window start (setup, not counted).
            let b0 = v.win_start / BF * BF;
            let mut tmp = vec![0i16; (v.win_start - b0 + 1) * CH];
            let saved = (v.win_start, v.decoded);
            core::mem::swap(&mut v.win, &mut tmp);
            v.win_start = b0;
            decode_upto(&ima, &mut v, saved.0);
            core::mem::swap(&mut v.win, &mut tmp);
            v.win_start = saved.0;
            v.decoded = 0;
        }
        vs.push(v);
    }
    unsafe {
        BENCH = Some(Bench { mode, steps: [pitch; Q], clip, ima, voices: vs, l: [0.0; Q], r: [0.0; Q], mix_l: [0.0; Q], mix_r: [0.0; Q] });
    }
}

fn libm_sin(x: f32) -> f32 {
    // Setup only; precision doesn't matter. Bhaskara-free Taylor on a wrapped argument.
    let x = x - (x / core::f32::consts::TAU).round() * core::f32::consts::TAU;
    let x2 = x * x;
    x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0)))
}

/// One quantum: every voice rendered and summed into the mix.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn bench_quantum() {
    let b = unsafe { BENCH.as_mut().unwrap() };
    b.mix_l = [0.0; Q];
    b.mix_r = [0.0; Q];
    for v in 0..b.voices.len() {
        render_voice(b, v);
    }
}

/// The mix's first sample (so nothing is optimised away; also a cross-mode sanity check).
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn bench_probe() -> f32 {
    let b = unsafe { BENCH.as_ref().unwrap() };
    b.mix_l.iter().chain(b.mix_r.iter()).map(|x| x.abs()).sum::<f32>()
}
