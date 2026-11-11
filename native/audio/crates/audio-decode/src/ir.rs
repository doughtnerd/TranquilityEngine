//! Impulse-response preparation in the decoder worker (ADR 0162, api-and-models §5.2, contract C9):
//! `myco_ir_prepare` (decode, mix to two channels or duplicate mono, resample, trim the tail under
//! -80 dBFS, cut with a 50 ms fade, normalise, partition, transform) and `myco_ir_generate` (the
//! seeded zone presets), with `myco_ir_blob_ptr/len`. The blob equals the core's `prepare_ir`.
//!
//! Skeleton declared by K2 (task A1); task C2a fills it.
//!
//! # The pipeline (both entry points end in [`kernel`])
//!
//! 1. **Decode** ([`decode`]): the whole file as f32, deinterleaved. Mono stays one channel (it
//!    feeds both kernels and sets `FLAG_SOURCE_MONO`), stereo is left and right; more than two
//!    channels is refused (`ERR_CODEC`, api-and-models §2.3: an ambisonic or surround file is not
//!    an impulse response a stereo convolver can use). Only as many frames as `max_frames` can use
//!    at the target rate are kept; the rest is scanned, so a file whose remainder is above the trim
//!    threshold reports `truncated`.
//! 2. **Resample** ([`resample`]) to the context rate when the rates differ: a windowed-sinc
//!    interpolator, 32 taps, Blackman window, cutoff 0.9 x the lower Nyquist, from a table of 256
//!    phases with linear interpolation between them (the parameters of Blink's `SincResampler`,
//!    which Chromium uses when `decodeAudioData` converts a file to the context's rate). A
//!    4-point voice interpolator would alias the top octave on the downsampling path; an IR's
//!    high-frequency decay is what makes a room sound like itself.
//! 3. **Trim** the tail where every channel stays under -80 dBFS ([`TRIM_THRESHOLD`], absolute,
//!    before normalisation), then **cut** at `max_frames` with a [`FADE_SECONDS`] raised-cosine
//!    fade when it is still longer ([`trim_and_cut`]). A response with nothing above the threshold
//!    is refused (`ERR_DECODE`, "silent").
//! 4. **Normalise** with the shared reverb's rule (`ir::blink_normalization_scale` over both
//!    channels, a mono source counted twice) and **partition and transform** with the core's own
//!    `kernel::prepare_ir`, so the blob is bit-identical to what the core would prepare from the
//!    same samples.
//!
//! [`generate`] skips 1-2: `convolver::presets` writes the preset at the target rate.

use audio_dsp::convolver::ir::{blink_normalization_scale, MAX_SAMPLE_RATE};
use audio_dsp::convolver::kernel::{kernel_bytes, prepare_ir, IrSpec, FLAG_SOURCE_MONO};
use audio_dsp::convolver::{presets, Scratch, SCRATCH_BYTES};

use crate::{Bytes, DecodeError, Decoder, FormatHint, ERR_ARG, ERR_CODEC, ERR_DECODE, ERR_FORMAT, ERR_MEMORY, ERR_SEEK};

/// -80 dBFS: the tail after the last sample at or above this (on any channel) is dropped.
pub const TRIM_THRESHOLD: f32 = 1.0e-4;
/// The fade a cut at `max_frames` ends with (seconds; C9).
pub const FADE_SECONDS: f64 = 0.05;
/// Taps of the resampler's kernel.
pub const RESAMPLE_TAPS: usize = 32;
/// Phases of the resampler's kernel table (linearly interpolated between).
pub const RESAMPLE_PHASES: usize = 256;
/// The resampler's cutoff, as a fraction of the lower of the two Nyquist frequencies.
pub const RESAMPLE_CUTOFF: f64 = 0.9;
/// Frames decoded per read.
const READ_FRAMES: usize = 4096;

/// A failure, as the ABI reports it: an `ERR_*` code and a message.
#[derive(Clone, Debug, PartialEq)]
pub struct IrError {
    pub code: i32,
    pub message: String,
}

impl IrError {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl From<DecodeError> for IrError {
    fn from(e: DecodeError) -> Self {
        let code = match e {
            DecodeError::Format(_) => ERR_FORMAT,
            DecodeError::Codec(_) => ERR_CODEC,
            DecodeError::Decode(_) => ERR_DECODE,
            DecodeError::Seek(_) => ERR_SEEK,
        };
        IrError::new(code, format!("impulse response: {}", e.message()))
    }
}

/// A response in the time domain: one channel (mono, feeding both kernels) or two (left, right),
/// all the same length, at `rate`.
#[derive(Clone, Debug, PartialEq)]
pub struct Response {
    pub channels: Vec<Vec<f32>>,
    pub rate: f32,
    /// Decoding stopped early (the frames past what `max_frames` can use were scanned, not kept)
    /// and that remainder held a sample at or above [`TRIM_THRESHOLD`].
    pub loud_remainder: bool,
}

impl Response {
    /// Frames per channel.
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }
}

/// A prepared kernel (api-and-models §4.5, clip format 3) and what the worker reports.
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    /// The kernel, in 4-byte words so it is aligned for `prepare_ir`; [`Prepared::bytes`] views it.
    pub words: Vec<u32>,
    /// Frames per channel after trimming and cutting.
    pub frames: usize,
    /// The response was cut at `max_frames` (its trimmed length was longer).
    pub truncated: bool,
}

impl Prepared {
    /// The kernel's bytes (`kernel_bytes(frames)` of them).
    pub fn bytes(&self) -> &[u8] {
        // SAFETY: a u32 buffer viewed as its bytes (u8 has no alignment or validity requirement).
        unsafe { core::slice::from_raw_parts(self.words.as_ptr() as *const u8, self.words.len() * 4) }
    }
}

fn check_args(target_rate: f32, max_frames: usize) -> Result<(), IrError> {
    if !(target_rate > 0.0 && target_rate <= MAX_SAMPLE_RATE) {
        return Err(IrError::new(ERR_ARG, format!("impulse response: target rate {target_rate} is not in (0, {MAX_SAMPLE_RATE}]")));
    }
    if max_frames == 0 || max_frames > u32::MAX as usize {
        return Err(IrError::new(ERR_ARG, "impulse response: max_frames must be at least 1"));
    }
    Ok(())
}

/// Frames of a source at `from` that a response of `max_frames` at `to` can use: the input span of
/// `max_frames + 1` output frames plus the resampler's reach.
fn input_frames_needed(max_frames: usize, from: f32, to: f32) -> usize {
    let span = ((max_frames as f64 + 1.0) * from as f64 / to as f64).ceil();
    (span as usize).saturating_add(RESAMPLE_TAPS)
}

fn grow(v: &mut Vec<f32>, extra: usize) -> Result<(), IrError> {
    v.try_reserve(extra).map_err(|_| IrError::new(ERR_MEMORY, "impulse response: out of memory"))
}

/// Step 1: decodes the file, deinterleaved, keeping at most the frames a response of `max_frames`
/// at `target_rate` can use. Refuses more than two channels.
pub fn decode(bytes: Bytes, hint: FormatHint, target_rate: f32, max_frames: usize) -> Result<Response, IrError> {
    check_args(target_rate, max_frames)?;
    let mut d = Decoder::open(bytes, hint)?;
    let info = d.info();
    let ch = info.channels as usize;
    if ch > 2 {
        return Err(IrError::new(ERR_CODEC, format!("impulse response has {ch} channels: an IR is mono or stereo")));
    }
    let rate = info.sample_rate as f32;
    let keep = input_frames_needed(max_frames, rate, target_rate);
    let mut channels = vec![Vec::new(); ch];
    if let Some(n) = info.frames_estimate {
        for c in channels.iter_mut() {
            grow(c, (n as usize).min(keep))?;
        }
    }
    let mut chunk = vec![0.0f32; READ_FRAMES * ch];
    let mut loud_remainder = false;
    loop {
        let n = d.read_f32(&mut chunk)?;
        if n == 0 {
            break;
        }
        let have = channels[0].len();
        let take = n.min(keep - have);
        for (c, out) in channels.iter_mut().enumerate() {
            grow(out, take)?;
            out.extend(chunk[..take * ch].iter().skip(c).step_by(ch));
        }
        if take < n && !loud_remainder {
            loud_remainder = chunk[take * ch..n * ch].iter().any(|x| x.abs() >= TRIM_THRESHOLD);
        }
    }
    if channels[0].is_empty() {
        return Err(IrError::new(ERR_DECODE, "impulse response: the file has no audio frames"));
    }
    Ok(Response { channels, rate, loud_remainder })
}

/// Blackman window over `u` in [0, 1].
fn blackman(u: f64) -> f64 {
    use core::f64::consts::PI;
    0.42 - 0.5 * libm::cos(2.0 * PI * u) + 0.08 * libm::cos(4.0 * PI * u)
}

/// The resampler's table: `(RESAMPLE_PHASES + 1) x RESAMPLE_TAPS`, row `p` the kernel for a
/// fractional position `p / RESAMPLE_PHASES` (tap `k` weighs input frame `idx - 15 + k`).
fn sinc_table(scale: f64) -> Vec<f32> {
    use core::f64::consts::PI;
    let half = (RESAMPLE_TAPS / 2) as f64;
    let mut t = Vec::with_capacity((RESAMPLE_PHASES + 1) * RESAMPLE_TAPS);
    for p in 0..=RESAMPLE_PHASES {
        let frac = p as f64 / RESAMPLE_PHASES as f64;
        for k in 0..RESAMPLE_TAPS {
            let x = k as f64 - (half - 1.0) - frac;
            let s = if x == 0.0 { 1.0 } else { libm::sin(PI * scale * x) / (PI * scale * x) };
            t.push((scale * s * blackman((x + half) / RESAMPLE_TAPS as f64)) as f32);
        }
    }
    t
}

/// Step 2: `input` at `from` resampled to `to`, `ceil(len * to / from)` frames (a copy when the
/// rates are equal). Frames outside `input` read as 0.
pub fn resample(input: &[f32], from: f32, to: f32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64; // input frames per output frame
    let scale = RESAMPLE_CUTOFF * if ratio > 1.0 { 1.0 / ratio } else { 1.0 };
    let table = sinc_table(scale);
    let len = input.len();
    let out_len = ((len as f64) / ratio).ceil() as usize;
    let back = RESAMPLE_TAPS / 2 - 1;
    let mut out = Vec::with_capacity(out_len);
    let mut window = [0.0f32; RESAMPLE_TAPS];
    for n in 0..out_len {
        let x = n as f64 * ratio;
        let idx = x as usize;
        let pf = (x - idx as f64) * RESAMPLE_PHASES as f64;
        let p = (pf as usize).min(RESAMPLE_PHASES - 1);
        let w = (pf - p as f64) as f32;
        let (k0, k1) = (&table[p * RESAMPLE_TAPS..][..RESAMPLE_TAPS], &table[(p + 1) * RESAMPLE_TAPS..][..RESAMPLE_TAPS]);
        let src: &[f32] = if idx >= back && idx + RESAMPLE_TAPS - back <= len {
            &input[idx - back..idx - back + RESAMPLE_TAPS]
        } else {
            for (k, s) in window.iter_mut().enumerate() {
                let j = idx as isize - back as isize + k as isize;
                *s = if j >= 0 && (j as usize) < len { input[j as usize] } else { 0.0 };
            }
            &window
        };
        let mut acc = 0.0f32;
        for k in 0..RESAMPLE_TAPS {
            acc += src[k] * (k0[k] + (k1[k] - k0[k]) * w);
        }
        out.push(acc);
    }
    out
}

/// Step 3: drops the tail under [`TRIM_THRESHOLD`] on every channel, then cuts at `max_frames`
/// with a [`FADE_SECONDS`] raised-cosine fade at `rate`: the last `F = min(round down(0.05 x rate),
/// max_frames)` frames are multiplied by `cos²(π/2 · (j + 1) / F)`, `j = 0..F`, so the last kept
/// frame is (all but) 0. Returns the frames left and whether it cut; 0 frames when nothing
/// reaches the threshold.
pub fn trim_and_cut(channels: &mut [Vec<f32>], rate: f32, max_frames: usize) -> (usize, bool) {
    let len = channels.first().map_or(0, Vec::len);
    let last = (0..len).rev().find(|&i| channels.iter().any(|c| c[i].abs() >= TRIM_THRESHOLD));
    let Some(last) = last else {
        channels.iter_mut().for_each(Vec::clear);
        return (0, false);
    };
    let mut frames = last + 1;
    let cut = frames > max_frames;
    if cut {
        frames = max_frames;
        let fade = ((FADE_SECONDS * rate as f64) as usize).clamp(1, frames);
        for c in channels.iter_mut() {
            for j in 0..fade {
                let g = libm::cos(core::f64::consts::FRAC_PI_2 * (j + 1) as f64 / fade as f64);
                let x = &mut c[frames - fade + j];
                *x = (*x as f64 * g * g) as f32;
            }
        }
    }
    channels.iter_mut().for_each(|c| c.truncate(frames));
    (frames, cut)
}

/// Step 4: normalises and prepares the kernel of `channels` (one: mono, fed to both; or two) at
/// `rate`, with [`prepare_ir`] as the core does: the sum of squares over both channels (a mono
/// channel twice), `blink_normalization_scale(sum, 2 * frames, rate)`, channel 0's samples then
/// channel 1's. `None` for no frames or a channel count other than 1 or 2.
pub fn kernel(channels: &[Vec<f32>], rate: f32) -> Option<Vec<u32>> {
    let frames = channels.first().map_or(0, Vec::len);
    if frames == 0 || !(1..=2).contains(&channels.len()) || channels.iter().any(|c| c.len() != frames) {
        return None;
    }
    let mono = channels.len() == 1;
    let mut sum: f64 = channels.iter().flatten().map(|&x| x as f64 * x as f64).sum();
    if mono {
        sum *= 2.0;
    }
    let scale = blink_normalization_scale(sum, 2 * frames, rate);
    let mut scratch_words = vec![0u32; SCRATCH_BYTES / 4];
    let mut scratch = Scratch::from_bytes(as_bytes(&mut scratch_words))?;
    scratch.fill_twiddles();
    let mut words = Vec::new();
    words.try_reserve_exact(kernel_bytes(frames) / 4).ok()?;
    words.resize(kernel_bytes(frames) / 4, 0);
    let spec = IrSpec { frames, sample_rate: rate, scale, flags: if mono { FLAG_SOURCE_MONO } else { 0 } };
    let (left, right) = (&channels[0], &channels[channels.len() - 1]);
    let mut samples = left.iter().chain(right.iter()).copied();
    prepare_ir(as_bytes(&mut words), &mut scratch, spec, || samples.next().unwrap_or(0.0))?;
    Some(words)
}

fn as_bytes(words: &mut [u32]) -> &mut [u8] {
    // SAFETY: a u32 buffer viewed as its bytes.
    unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, words.len() * 4) }
}

/// Steps 3-4 on a response already at `rate`.
fn finish(mut channels: Vec<Vec<f32>>, rate: f32, max_frames: usize, loud_remainder: bool) -> Result<Prepared, IrError> {
    let (frames, cut) = trim_and_cut(&mut channels, rate, max_frames);
    if frames == 0 {
        return Err(IrError::new(ERR_DECODE, "impulse response is silent (nothing reaches -80 dBFS)"));
    }
    let words = kernel(&channels, rate).ok_or_else(|| IrError::new(ERR_MEMORY, "impulse response: out of memory for the kernel"))?;
    Ok(Prepared { words, frames, truncated: cut || loud_remainder })
}

/// `myco_ir_prepare`: the whole pipeline on an encoded file, to a kernel at `target_rate` of at
/// most `max_frames` frames per channel.
pub fn prepare(bytes: Bytes, hint: FormatHint, target_rate: f32, max_frames: usize) -> Result<Prepared, IrError> {
    let src = decode(bytes, hint, target_rate, max_frames)?;
    let channels = src.channels.iter().map(|c| resample(c, src.rate, target_rate)).collect();
    finish(channels, target_rate, max_frames, src.loud_remainder)
}

/// `myco_ir_generate`: preset `preset` (`convolver::presets::PRESETS`' index) generated at
/// `target_rate`, then trimmed, cut, normalised and prepared as a file would be.
pub fn generate(preset: u32, target_rate: f32, max_frames: usize) -> Result<Prepared, IrError> {
    check_args(target_rate, max_frames)?;
    let n = presets::frames(preset, target_rate);
    if n == 0 {
        return Err(IrError::new(ERR_ARG, format!("impulse response: no preset {preset} (0 room, 1 corridor, 2 hall, 3 cave, 4 open)")));
    }
    let (mut left, mut right) = (vec![0.0f32; n], vec![0.0f32; n]);
    presets::generate(preset, target_rate, &mut left, &mut right);
    finish(vec![left, right], target_rate, max_frames, false)
}
