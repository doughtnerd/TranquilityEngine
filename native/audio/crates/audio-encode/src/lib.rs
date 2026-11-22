//! Myco's audio encoder (ADR 0337 §4, amended by 0345 §1–§3): turns PCM into what a platform ships.
//!
//! | Codec | Output | Notes |
//! |---|---|---|
//! | [`Codec::Pcm`] | 16-bit RIFF WAV | rounded, no dither |
//! | [`Codec::Adpcm`] | raw IMA ADPCM blocks, [`adpcm`]'s layout | the frame count travels beside the bytes |
//! | [`Codec::Vorbis`] | Ogg Vorbis (libvorbis 1.3.7, VBR) | `q = quality` on libvorbis's −0.1..1 scale (0337 §2: quality × 10 is `-q`) |
//! | [`Codec::Opus`] | Ogg Opus (libopus 1.5.2, float, VBR, complexity 10, 20 ms frames) | always 48 kHz; 16 + 112 × quality kbps per stereo pair; mono or stereo; pre-skip = the encoder's look-ahead, end trimmed by the last granule |
//!
//! Before the codec: an optional **mono downmix** (the mean of the channels: (L+R)/2 for stereo) and a **rate
//! ceiling** (never upsampled, except Opus, always 48 kHz), done by rubato's synchronous FFT resampler (0345 §2).
//!
//! # Host ABI (a WASI reactor; bytes cross through linear memory, never file descriptors: 0345 §1)
//!
//! The module is built for `wasm32-wasip1` as a reactor: the host calls `_initialize` once, then:
//!
//! 1. `p = myco_encode_alloc(bytes)` (16-aligned; 0 when memory can't grow) and copy the interleaved `f32` input in.
//! 2. `r = myco_encode_run(p, frames, channels, rate, codec, quality, rateCeiling, flags)`: `codec` 0 PCM, 1 ADPCM,
//!    2 Vorbis, 3 Opus; `rateCeiling` 0 = the source's rate; `flags` bit 0 = downmix to mono. 0 on success, else an
//!    `ERR_*` code with `myco_encode_error_ptr/len` (UTF-8). The input stays the caller's (`myco_encode_free(p,
//!    bytes)`).
//! 3. On success: `myco_encode_output_ptr/len` (the encoded bytes), `myco_encode_output_rate`, `_channels`,
//!    `_frames` (f64: frames per channel at the output rate, pre-skip excluded) and `_pre_skip` (Opus, at 48 kHz; 0
//!    otherwise); valid until the next run or `myco_encode_output_free()`.
//!
//! `myco_encode_abi_version()` is `(major << 8) | minor`; `myco_encode_source_hash()` points at 16 bytes, the encoder's
//! own source hash (`build.rs`), which callers use as the encoder's version in caches; `myco_encode_vendor_ptr/len` is
//! the vendor string written into every Ogg file. Every export that allocates may grow memory, so callers re-create
//! typed-array views after each call. Six WASI imports are used: `fd_write` (stderr, panics), `random_get`,
//! `clock_time_get`, `environ_get`, `environ_sizes_get` and `proc_exit`.

pub mod adpcm;
mod resample;

use std::alloc::{alloc, dealloc, Layout};
use std::ffi::{c_char, c_long};
use std::sync::Mutex;

/// `(major << 8) | minor` of the host ABI.
pub const ABI_VERSION: u32 = 0x100;
/// Alignment of every `myco_encode_alloc` block.
pub const ALLOC_ALIGN: usize = 16;
/// The vendor string in every Ogg file (Vorbis `ENCODER` comment, OpusTags vendor).
pub const VENDOR: &str = "myco-encode 1 (libvorbis 1.3.7, libopus 1.5.2, rubato 5.1.0)";
/// Opus's encoder complexity (0..10): the spike's measured setting.
pub const OPUS_COMPLEXITY: i32 = 10;

/// A null or misaligned pointer, a zero or oversized length, or channels/rate out of range.
pub const ERR_ARG: i32 = -2;
/// The codec refuses the input (libvorbis refuses the rate/channels/quality; Opus with more than two channels).
pub const ERR_REFUSED: i32 = -3;
/// The encoder failed or memory ran out.
pub const ERR_ENCODE: i32 = -4;

static ENCODE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/encode_hash.bin"));

/// A codec the encoder writes.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Codec {
    Pcm,
    Adpcm,
    Vorbis,
    Opus,
}

impl Codec {
    /// The ABI's `codec` argument.
    pub fn from_code(code: u32) -> Option<Codec> {
        match code {
            0 => Some(Codec::Pcm),
            1 => Some(Codec::Adpcm),
            2 => Some(Codec::Vorbis),
            3 => Some(Codec::Opus),
            _ => None,
        }
    }
}

/// What to encode to.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Settings {
    pub codec: Codec,
    /// 0..1 (clamped); Vorbis and Opus only.
    pub quality: f32,
    /// The highest output rate; `None` keeps the source's. Never upsamples. Ignored by Opus (48 kHz).
    pub rate_ceiling: Option<u32>,
    /// Downmix to one channel first.
    pub mono: bool,
}

/// The encoded result.
#[derive(Clone, Debug)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub rate: u32,
    pub channels: usize,
    /// Frames per channel at `rate`, pre-skip excluded (what a decoder yields).
    pub frames: u64,
    /// Opus's pre-skip at 48 kHz; 0 for the other codecs.
    pub pre_skip: u32,
}

/// Why an encode failed.
#[derive(Clone, Debug, PartialEq)]
pub enum EncodeError {
    Arg(String),
    Refused(String),
    Encode(String),
}

impl EncodeError {
    pub fn code(&self) -> i32 {
        match self {
            EncodeError::Arg(_) => ERR_ARG,
            EncodeError::Refused(_) => ERR_REFUSED,
            EncodeError::Encode(_) => ERR_ENCODE,
        }
    }
    pub fn message(&self) -> &str {
        match self {
            EncodeError::Arg(m) | EncodeError::Refused(m) | EncodeError::Encode(m) => m,
        }
    }
}

/// Most channels the encoder takes (an order-3 ambisonic file).
pub const MAX_CHANNELS: usize = 16;
/// The lowest and highest sample rates the encoder takes.
pub const MIN_RATE: u32 = 8_000;
pub const MAX_RATE: u32 = 192_000;
/// Opus's output rate.
pub const OPUS_RATE: u32 = 48_000;

#[repr(C)]
struct CBuf {
    data: *mut u8,
    len: usize,
    cap: usize,
    failed: i32,
}

extern "C" {
    fn myco_buf_free(b: *mut CBuf);
    fn myco_vorbis_encode(pcm: *const f32, ch: i32, frames: c_long, rate: c_long, q: f32, vendor: *const c_char, out: *mut CBuf) -> i32;
    fn myco_opus_encode(pcm48: *const f32, ch: i32, frames: c_long, bitrate: i32, complexity: i32, input_rate: u32, vendor: *const c_char, out: *mut CBuf) -> i32;
}

fn take(b: &mut CBuf) -> Vec<u8> {
    let v = if b.data.is_null() {
        Vec::new()
    } else {
        // SAFETY: the C side wrote `len` bytes at `data`.
        unsafe { std::slice::from_raw_parts(b.data, b.len) }.to_vec()
    };
    // SAFETY: `b` came from the C encoders (or is empty).
    unsafe { myco_buf_free(b) };
    v
}

fn vendor_c() -> Vec<u8> {
    let mut v = VENDOR.as_bytes().to_vec();
    v.push(0);
    v
}

/// `x` (−1..1) as int16: rounded and clamped.
#[inline]
fn to_i16(x: f32) -> i16 {
    (x * 32768.0).round().clamp(-32768.0, 32767.0) as i16
}

fn wav16(samples: &[f32], channels: usize, rate: u32) -> Vec<u8> {
    let data = samples.len() * 2;
    let mut o = Vec::with_capacity(44 + data);
    o.extend_from_slice(b"RIFF");
    o.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    o.extend_from_slice(b"WAVEfmt ");
    o.extend_from_slice(&16u32.to_le_bytes());
    o.extend_from_slice(&1u16.to_le_bytes());
    o.extend_from_slice(&(channels as u16).to_le_bytes());
    o.extend_from_slice(&rate.to_le_bytes());
    o.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    o.extend_from_slice(&(channels as u16 * 2).to_le_bytes());
    o.extend_from_slice(&16u16.to_le_bytes());
    o.extend_from_slice(b"data");
    o.extend_from_slice(&(data as u32).to_le_bytes());
    for &s in samples {
        o.extend_from_slice(&to_i16(s).to_le_bytes());
    }
    o
}

/// The mean of each frame's channels.
fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    let scale = 1.0 / channels as f32;
    samples.chunks_exact(channels).map(|f| f.iter().sum::<f32>() * scale).collect()
}

/// Encodes `samples` (interleaved, `channels` channels at `rate` Hz, −1..1) with `settings`.
pub fn encode(samples: &[f32], channels: usize, rate: u32, settings: &Settings) -> Result<Encoded, EncodeError> {
    if channels == 0 || channels > MAX_CHANNELS {
        return Err(EncodeError::Arg(format!("{channels} channels (1 to {MAX_CHANNELS})")));
    }
    if !(MIN_RATE..=MAX_RATE).contains(&rate) {
        return Err(EncodeError::Arg(format!("sample rate {rate} Hz ({MIN_RATE} to {MAX_RATE})")));
    }
    if samples.len() % channels != 0 {
        return Err(EncodeError::Arg(format!("{} samples isn't a whole number of {channels}-channel frames", samples.len())));
    }
    let quality = if settings.quality.is_finite() { settings.quality.clamp(0.0, 1.0) } else { 0.5 };

    let mixed;
    let (mut pcm, ch): (&[f32], usize) = if settings.mono && channels > 1 {
        mixed = downmix(samples, channels);
        (&mixed, 1)
    } else {
        (samples, channels)
    };
    if settings.codec == Codec::Opus && ch > 2 {
        return Err(EncodeError::Refused(format!("Opus encodes mono or stereo, not {ch} channels")));
    }

    let target = match settings.codec {
        Codec::Opus => OPUS_RATE,
        _ => match settings.rate_ceiling {
            Some(c) if c > 0 && c < rate => c.max(MIN_RATE),
            _ => rate,
        },
    };
    let resampled;
    if target != rate {
        resampled = resample::fft(pcm, ch, rate, target).map_err(EncodeError::Encode)?;
        pcm = &resampled;
    }
    let frames = pcm.len() / ch;

    let (bytes, pre_skip) = match settings.codec {
        Codec::Pcm => (wav16(pcm, ch, target), 0),
        Codec::Adpcm => {
            let ints: Vec<i16> = pcm.iter().map(|&x| to_i16(x)).collect();
            (adpcm::encode(&ints, ch), 0)
        }
        Codec::Vorbis => {
            let mut b = CBuf { data: std::ptr::null_mut(), len: 0, cap: 0, failed: 0 };
            let vendor = vendor_c();
            // SAFETY: `pcm` holds `frames × ch` floats; `vendor` is NUL-terminated; `b` is an empty buffer.
            let r = unsafe { myco_vorbis_encode(pcm.as_ptr(), ch as i32, frames as c_long, target as c_long, quality, vendor.as_ptr().cast(), &mut b) };
            let bytes = take(&mut b);
            match r {
                0 => (bytes, 0),
                -1 => return Err(EncodeError::Refused(format!("libvorbis refuses quality {quality} for {ch} channels at {target} Hz"))),
                _ => return Err(EncodeError::Encode("out of memory in the Vorbis encoder".into())),
            }
        }
        Codec::Opus => {
            let pair_kbps = 16.0 + 112.0 * quality as f64;
            let bitrate = (pair_kbps * 1000.0 * ch as f64 / 2.0).round() as i32;
            let mut b = CBuf { data: std::ptr::null_mut(), len: 0, cap: 0, failed: 0 };
            let vendor = vendor_c();
            // SAFETY: as above, at 48 kHz.
            let r = unsafe { myco_opus_encode(pcm.as_ptr(), ch as i32, frames as c_long, bitrate, OPUS_COMPLEXITY, rate, vendor.as_ptr().cast(), &mut b) };
            let bytes = take(&mut b);
            if r < 0 {
                return Err(EncodeError::Encode(format!("the Opus encoder failed ({r})")));
            }
            (bytes, r as u32)
        }
    };
    Ok(Encoded { bytes, rate: target, channels: ch, frames: frames as u64, pre_skip })
}

// ---- The host ABI -------------------------------------------------------------------------------------------------

struct Last {
    output: Option<Encoded>,
    error: String,
}

static LAST: Mutex<Last> = Mutex::new(Last { output: None, error: String::new() });

fn last() -> std::sync::MutexGuard<'static, Last> {
    LAST.lock().unwrap_or_else(|e| e.into_inner())
}

fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len, ALLOC_ALIGN).ok()
}

/// `(major << 8) | minor`.
#[no_mangle]
pub extern "C" fn myco_encode_abi_version() -> u32 {
    ABI_VERSION
}

/// 16 bytes: the encoder's source hash (see `build.rs`).
#[no_mangle]
pub extern "C" fn myco_encode_source_hash() -> *const u8 {
    ENCODE_HASH.as_ptr()
}

#[no_mangle]
pub extern "C" fn myco_encode_vendor_ptr() -> *const u8 {
    VENDOR.as_ptr()
}

#[no_mangle]
pub extern "C" fn myco_encode_vendor_len() -> u32 {
    VENDOR.len() as u32
}

/// A block of `len` bytes aligned to 16, or 0 when `len` is 0 or memory can't grow.
#[no_mangle]
pub extern "C" fn myco_encode_alloc(len: u32) -> *mut u8 {
    match layout(len as usize) {
        // SAFETY: a non-zero size (checked) and a valid layout.
        Some(l) if len > 0 => unsafe { alloc(l) },
        _ => std::ptr::null_mut(),
    }
}

/// Frees a block from `myco_encode_alloc` (`len` as allocated).
///
/// # Safety
/// `ptr` came from `myco_encode_alloc(len)` and isn't freed yet.
#[no_mangle]
pub unsafe extern "C" fn myco_encode_free(ptr: *mut u8, len: u32) {
    if let (false, Some(l)) = (ptr.is_null(), layout(len as usize)) {
        if len > 0 {
            dealloc(ptr, l);
        }
    }
}

/// Encodes (module header, step 2).
///
/// # Safety
/// `pcm` points at `frames × channels` `f32`s the caller owns.
#[no_mangle]
pub unsafe extern "C" fn myco_encode_run(pcm: *const f32, frames: u32, channels: u32, rate: u32, codec: u32, quality: f32, rate_ceiling: u32, flags: u32) -> i32 {
    let mut l = last();
    l.output = None;
    l.error.clear();
    let fail = |l: &mut Last, e: EncodeError| {
        l.error = e.message().to_string();
        e.code()
    };
    let Some(codec) = Codec::from_code(codec) else {
        return fail(&mut l, EncodeError::Arg(format!("unknown codec {codec}")));
    };
    let n = frames as usize * channels as usize;
    if pcm.is_null() || (pcm as usize) % 4 != 0 || n == 0 || channels as usize > MAX_CHANNELS {
        return fail(&mut l, EncodeError::Arg("a null or misaligned input, or no frames".into()));
    }
    let samples = std::slice::from_raw_parts(pcm, n);
    let settings = Settings { codec, quality, rate_ceiling: (rate_ceiling > 0).then_some(rate_ceiling), mono: flags & 1 != 0 };
    match encode(samples, channels as usize, rate, &settings) {
        Ok(out) => {
            l.output = Some(out);
            0
        }
        Err(e) => fail(&mut l, e),
    }
}

#[no_mangle]
pub extern "C" fn myco_encode_output_ptr() -> *const u8 {
    last().output.as_ref().map_or(std::ptr::null(), |o| o.bytes.as_ptr())
}

#[no_mangle]
pub extern "C" fn myco_encode_output_len() -> u32 {
    last().output.as_ref().map_or(0, |o| o.bytes.len() as u32)
}

#[no_mangle]
pub extern "C" fn myco_encode_output_rate() -> u32 {
    last().output.as_ref().map_or(0, |o| o.rate)
}

#[no_mangle]
pub extern "C" fn myco_encode_output_channels() -> u32 {
    last().output.as_ref().map_or(0, |o| o.channels as u32)
}

#[no_mangle]
pub extern "C" fn myco_encode_output_frames() -> f64 {
    last().output.as_ref().map_or(0.0, |o| o.frames as f64)
}

#[no_mangle]
pub extern "C" fn myco_encode_output_pre_skip() -> u32 {
    last().output.as_ref().map_or(0, |o| o.pre_skip)
}

/// Frees the last output.
#[no_mangle]
pub extern "C" fn myco_encode_output_free() {
    last().output = None;
}

#[no_mangle]
pub extern "C" fn myco_encode_error_ptr() -> *const u8 {
    last().error.as_ptr()
}

#[no_mangle]
pub extern "C" fn myco_encode_error_len() -> u32 {
    last().error.len() as u32
}
