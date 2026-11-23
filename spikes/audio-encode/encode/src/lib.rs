//! ADR 0351 spike A0/S1: the encoder as a wasm32-wasip1 reactor (the `spike_*` exports below, driven by
//! `run-node.mjs` under node:wasi and by `browser/worker.js` under a 50-line WASI shim) and a native command
//! (`src/main.rs`) for the native reference numbers.
//!
//! codec: `pcm` (16-bit WAV), `adpcm` (ADR 0351 §3's IMA block layout, raw), `vorbis` (Ogg Vorbis, libvorbis q =
//! quality), `opus` (Ogg Opus, 16 + 112 × quality kbps per stereo pair, resampled to 48 kHz first), `sinc` / `fft`
//! (rubato resampling only, to `rate`, output a 16-bit WAV). `rate` is a ceiling as in §2 (never upsampled; Opus is
//! always 48 kHz). Times come from the WASI clock (`clock_time_get`) inside the module, so they exclude instantiation
//! and the copies in and out.

pub mod adpcm;

use std::time::Instant;

use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Async, Fft, FixedAsync, FixedSync, Resampler, SincInterpolationParameters, SincInterpolationType, WindowFunction};

#[repr(C)]
struct SpikeBuf {
    data: *mut u8,
    len: usize,
    cap: usize,
}

extern "C" {
    fn spike_buf_free(b: *mut SpikeBuf);
    #[cfg(feature = "vorbis")]
    fn spike_vorbis_encode(pcm: *const f32, ch: i32, frames: core::ffi::c_long, rate: core::ffi::c_long, q: f32, out: *mut SpikeBuf) -> i32;
    #[cfg(feature = "opus")]
    fn spike_opus_encode(pcm48: *const f32, ch: i32, frames: core::ffi::c_long, bitrate: i32, complexity: i32, input_rate: u32, out: *mut SpikeBuf) -> i32;
}

struct Wav {
    rate: u32,
    channels: usize,
    /// Interleaved, -1..1.
    samples: Vec<f32>,
}

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn read_wav(b: &[u8]) -> Wav {
    assert!(&b[0..4] == b"RIFF" && &b[8..12] == b"WAVE", "not a RIFF WAVE file");
    let (mut fmt, mut channels, mut rate, mut bits) = (0u16, 0usize, 0u32, 0u16);
    let mut at = 12;
    while at + 8 <= b.len() {
        let id = &b[at..at + 4];
        let size = u32le(b, at + 4) as usize;
        let body = at + 8;
        if id == b"fmt " {
            fmt = u16le(b, body);
            channels = u16le(b, body + 2) as usize;
            rate = u32le(b, body + 4);
            bits = u16le(b, body + 14);
            if fmt == 0xfffe {
                fmt = u16le(b, body + 24);
            }
        } else if id == b"data" {
            let data = &b[body..(body + size).min(b.len())];
            let samples: Vec<f32> = match (fmt, bits) {
                (1, 16) => data.chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0).collect(),
                (1, 24) => data.chunks_exact(3).map(|s| (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8_388_608.0).collect(),
                (3, 32) => data.chunks_exact(4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]])).collect(),
                _ => panic!("unsupported WAV format {fmt} / {bits} bits"),
            };
            return Wav { rate, channels, samples };
        }
        at = body + size + (size & 1);
    }
    panic!("no data chunk");
}

fn to_i16(s: &[f32]) -> Vec<i16> {
    s.iter().map(|&x| (x * 32768.0).round().clamp(-32768.0, 32767.0) as i16).collect()
}

fn wav16(pcm: &[i16], channels: usize, rate: u32) -> Vec<u8> {
    let data = pcm.len() * 2;
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
    for s in pcm {
        o.extend_from_slice(&s.to_le_bytes());
    }
    o
}

/// Resamples interleaved `s` from `from` to `to` Hz with rubato: `sinc` = the asynchronous windowed-sinc resampler at
/// offline quality (256 taps, BlackmanHarris2, cubic, oversampling 256), `fft` = the synchronous FFT resampler.
fn resample(s: &[f32], channels: usize, from: u32, to: u32, kind: &str) -> Vec<f32> {
    if from == to {
        return s.to_vec();
    }
    let frames = s.len() / channels;
    let planar: Vec<Vec<f32>> = (0..channels).map(|c| (0..frames).map(|i| s[i * channels + c]).collect()).collect();
    let input = SequentialSliceOfVecs::new(&planar, channels, frames).unwrap();
    let mut r: Box<dyn Resampler<f32>> = if kind == "fft" {
        Box::new(Fft::<f32>::new(from as usize, to as usize, 1024, channels, FixedSync::Input).unwrap())
    } else {
        let p = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: None,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        Box::new(Async::<f32>::new_sinc(to as f64 / from as f64, 1.0, &p, 1024, channels, FixedAsync::Input).unwrap())
    };
    let out_len = r.process_all_needed_output_len(frames);
    let mut out = vec![vec![0f32; out_len]; channels];
    let mut output = SequentialSliceOfVecs::new_mut(&mut out, channels, out_len).unwrap();
    let (_, n) = r.process_all_into_buffer(&input, &mut output, frames, None).unwrap();
    let mut inter = vec![0f32; n * channels];
    for c in 0..channels {
        for i in 0..n {
            inter[i * channels + c] = out[c][i];
        }
    }
    inter
}

fn take(b: &mut SpikeBuf) -> Vec<u8> {
    let v = unsafe { std::slice::from_raw_parts(b.data, b.len) }.to_vec();
    unsafe { spike_buf_free(b) };
    v
}

fn snr_db(reference: &[i16], test: &[i16]) -> f64 {
    let (mut sig, mut err) = (0f64, 0f64);
    for (a, b) in reference.iter().zip(test) {
        sig += (*a as f64).powi(2);
        err += (*a as f64 - *b as f64).powi(2);
    }
    10.0 * (sig / err.max(1e-9)).log10()
}

/// Encodes the WAV `input` with `codec` (see the module doc). Returns the encoded bytes and a JSON stats line.
pub fn encode(input: &[u8], codec: &str, quality: f32, ceiling: Option<u32>, complexity: i32) -> (Vec<u8>, String) {
    let wav = read_wav(input);
    let ch = wav.channels;
    let frames = wav.samples.len() / ch;
    let seconds = frames as f64 / wav.rate as f64;

    let t0 = Instant::now();
    let mut rate = wav.rate;
    let mut resample_ms = 0.0;
    let mut extra = String::new();
    let target = match codec {
        "opus" | "opus-fft" => Some(48_000),
        _ => ceiling.filter(|&r| r < wav.rate),
    };
    let samples = if let Some(to) = target {
        let kind = if codec.ends_with("fft") { "fft" } else { "sinc" };
        let s = resample(&wav.samples, ch, wav.rate, to, kind);
        rate = to;
        resample_ms = t0.elapsed().as_secs_f64() * 1000.0;
        s
    } else {
        wav.samples.clone()
    };
    let out_frames = samples.len() / ch;
    let bytes: Vec<u8> = match codec {
        "pcm" | "sinc" | "fft" => wav16(&to_i16(&samples), ch, rate),
        "adpcm" => {
            let pcm = to_i16(&samples);
            let enc = adpcm::encode(&pcm, ch);
            let back = adpcm::decode(&enc, ch, out_frames);
            extra = format!(",\"snrDb\":{:.2}", snr_db(&pcm, &back));
            enc
        }
        #[cfg(feature = "vorbis")]
        "vorbis" => {
            let mut b = SpikeBuf { data: core::ptr::null_mut(), len: 0, cap: 0 };
            let r = unsafe { spike_vorbis_encode(samples.as_ptr(), ch as i32, out_frames as _, rate as _, quality, &mut b) };
            assert_eq!(r, 0, "vorbis_encode_init_vbr refused q={quality} at {rate} Hz");
            take(&mut b)
        }
        #[cfg(feature = "opus")]
        "opus" | "opus-fft" => {
            let pair_kbps = 16.0 + 112.0 * quality as f64;
            let bitrate = (pair_kbps * 1000.0 * ch as f64 / 2.0) as i32;
            let mut b = SpikeBuf { data: core::ptr::null_mut(), len: 0, cap: 0 };
            let pre = unsafe { spike_opus_encode(samples.as_ptr(), ch as i32, out_frames as _, bitrate, complexity, wav.rate, &mut b) };
            assert!(pre >= 0, "opus encode failed: {pre}");
            extra = format!(",\"preSkip\":{pre},\"targetKbps\":{:.1},\"complexity\":{complexity}", bitrate as f64 / 1000.0);
            take(&mut b)
        }
        other => panic!("unknown or not-built codec {other}"),
    };
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let kbps = bytes.len() as f64 * 8.0 / seconds / 1000.0;
    let stats = format!(
        "{{\"codec\":\"{codec}\",\"quality\":{quality},\"inRate\":{},\"outRate\":{rate},\"channels\":{ch},\"seconds\":{seconds:.3},\"ms\":{ms:.1},\"resampleMs\":{resample_ms:.1},\"xRealtime\":{:.1},\"bytes\":{},\"kbps\":{kbps:.1}{extra}}}",
        wav.rate,
        seconds * 1000.0 / ms,
        bytes.len()
    );
    (bytes, stats)
}

// The reactor ABI the JS hosts use (ADR 0351's production shape: bytes cross through linear memory, never through
// WASI file descriptors; Node 22.23's node:wasi crashes in a GC inside its fd_read fast call on multi-MB reads).
// spike_alloc(n) -> ptr; spike_encode(ptr, n, codec, quality, rate, complexity) -> 0 | -1; then spike_out_ptr/len and
// spike_stats_ptr/len. codec: 0 pcm, 1 adpcm, 2 vorbis, 3 opus, 4 sinc, 5 fft, 6 opus-fft
// (Opus with the 44.1 -> 48 kHz step done by rubato's FFT resampler instead of the sinc one).
static mut OUT: Vec<u8> = Vec::new();
static mut STATS: String = String::new();

#[no_mangle]
pub extern "C" fn spike_alloc(n: usize) -> *mut u8 {
    let mut v = vec![0u8; n];
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn spike_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, n, n));
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn spike_encode(p: *const u8, n: usize, codec: u32, quality: f32, rate: u32, complexity: i32) -> i32 {
    let name = ["pcm", "adpcm", "vorbis", "opus", "sinc", "fft", "opus-fft"].get(codec as usize).copied().unwrap_or("?");
    let input = core::slice::from_raw_parts(p, n);
    let (bytes, stats) = encode(input, name, quality, Some(rate).filter(|&r| r > 0), complexity);
    OUT = bytes;
    STATS = stats;
    0
}

#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn spike_out_ptr() -> *const u8 { OUT.as_ptr() }
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn spike_out_len() -> usize { OUT.len() }
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn spike_stats_ptr() -> *const u8 { STATS.as_ptr() }
#[no_mangle]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn spike_stats_len() -> usize { STATS.len() }
