//! The C ABI, called natively as the worker will call it in wasm: alloc, open, info, read, seek,
//! close, handles, limits and error codes. One test, because the handle table is process-wide.

mod common;

use common::*;
use myco_audio_decode::*;

/// Copies `bytes` into a fresh `myco_decode_alloc` block and opens it.
fn open_abi(bytes: &[u8], hint: u32) -> i32 {
    let p = myco_decode_alloc(bytes.len() as u32);
    assert!(!p.is_null());
    assert_eq!(p as usize % ALLOC_ALIGN, 0);
    // SAFETY: `p` has `bytes.len()` bytes; open takes ownership.
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        myco_decode_open(p, bytes.len() as u32, hint)
    }
}

fn last_error() -> String {
    let p = myco_decode_error_ptr();
    let n = myco_decode_error_len() as usize;
    // SAFETY: the table's message string, valid until the next call.
    String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(p, n) }).into_owned()
}

struct InfoRec {
    rate: u32,
    channels: u32,
    frames: f64,
    estimate: f64,
    codec: u32,
    flags: u32,
    loop_start: u32,
    loop_end: u32,
}

fn info(h: i32) -> InfoRec {
    let mut rec = [0u64; INFO_BYTES / 8];
    // SAFETY: 40 writable, 8-aligned bytes.
    assert_eq!(unsafe { myco_decode_info(h, rec.as_mut_ptr().cast()) }, 0);
    let b: Vec<u8> = rec.iter().flat_map(|w| w.to_ne_bytes()).collect();
    let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let f64at = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    InfoRec { rate: u32at(0), channels: u32at(4), frames: f64at(8), estimate: f64at(16), codec: u32at(24), flags: u32at(28), loop_start: u32at(32), loop_end: u32at(36) }
}

#[test]
fn the_abi() {
    assert_eq!(myco_decode_abi_version(), 0x103);
    assert!(!myco_decode_source_hash().is_null());
    assert!(myco_decode_alloc(0).is_null());

    // Open, info, whole-clip read into an f32 buffer from alloc, matching the Rust API.
    let flac = fixture("tone-48000-stereo.flac");
    let h = open_abi(&flac, 2);
    assert!(h > 0, "open: {h} {}", last_error());
    let i = info(h);
    assert_eq!((i.rate, i.channels, i.frames, i.estimate, i.codec, i.flags), (48000, 2, 48000.0, 48000.0, 2, 1));
    let (_, whole) = decode_all("tone-48000-stereo.flac", 4096);
    let out = myco_decode_alloc(48000 * 2 * 4).cast::<f32>();
    // SAFETY: the block holds 48,000 stereo f32 frames.
    unsafe {
        assert_eq!(myco_decode_read_f32(h, out, 48000), 48000);
        assert!(std::slice::from_raw_parts(out, 96000) == &whole[..]);
        assert_eq!(myco_decode_read_f32(h, out, 4096), 0, "the end");
        // Seek and stream in 4,096-frame chunks, as int16.
        assert_eq!(myco_decode_seek(h, 1000.0), 1000.0);
        let out16 = out.cast::<i16>();
        assert_eq!(myco_decode_read_i16(h, out16, 4096), 4096);
        let got = std::slice::from_raw_parts(out16, 8192);
        for (k, &s) in got.iter().enumerate() {
            assert_eq!(f32::from(s) / 32768.0, whole[2000 + k]);
        }
        // Bad arguments: misaligned, null, zero frames, negative or NaN seeks.
        assert_eq!(myco_decode_read_f32(h, out.cast::<u8>().add(1).cast(), 16), ERR_ARG);
        assert_eq!(myco_decode_read_f32(h, std::ptr::null_mut(), 16), ERR_ARG);
        assert_eq!(myco_decode_read_f32(h, out, 0), 0);
        assert_eq!(myco_decode_seek(h, -1.0), f64::from(ERR_ARG));
        assert_eq!(myco_decode_seek(h, f64::NAN), f64::from(ERR_ARG));
        assert_eq!(myco_decode_info(h, out.cast::<u8>().add(4)), ERR_ARG);
        myco_decode_free(out.cast(), 48000 * 2 * 4);
    }

    // Close; the handle is then stale, even after its slot is reused.
    assert_eq!(myco_decode_close(h), 0);
    assert_eq!(myco_decode_close(h), ERR_HANDLE);
    let h2 = open_abi(&flac, 0);
    assert!(h2 > 0 && h2 != h, "a reused slot gets a new handle ({h} then {h2})");
    assert_eq!(myco_decode_seek(h, 0.0), f64::from(ERR_HANDLE));
    assert_eq!(myco_decode_close(h2), 0);
    for bad in [0, -5, 0x7fff_ffff] {
        assert_eq!(myco_decode_close(bad), ERR_HANDLE);
    }

    // Unknown bytes and unsupported codecs: codes and messages, and the block is freed.
    assert_eq!(open_abi(&b"not audio".repeat(100), 0), ERR_FORMAT);
    assert!(last_error().contains("unrecognised"), "{}", last_error());
    let m4a = open_abi(&fixture("tone-44100-mono.m4a"), 5);
    if cfg!(feature = "aac") {
        assert!(m4a > 0);
        assert_eq!(info(m4a).codec, 5);
        assert_eq!(myco_decode_close(m4a), 0);
    } else {
        assert!(m4a == ERR_FORMAT || m4a == ERR_CODEC, "{m4a}");
    }
    // SAFETY: a null block is refused before ownership is taken.
    assert_eq!(unsafe { myco_decode_open(std::ptr::null_mut(), 10, 0) }, ERR_ARG);

    // The unknown-length MP3: frames -1, flags 0, an estimate.
    let h = open_abi(&fixture("tone-48000-stereo-vbr-noxing.mp3"), 3);
    let i = info(h);
    assert_eq!((i.frames, i.flags, i.codec), (-1.0, 0, 3));
    assert!(i.estimate > 40000.0);
    assert_eq!(myco_decode_close(h), 0);

    // Loop points ride in the record: none on plain files, the comments' on a tagged Ogg.
    assert_eq!((i.loop_start, i.loop_end, i.flags & 2), (0, 0, 0));
    let h = open_abi(&fixture("loop/tagged.ogg"), 4);
    assert!(h > 0, "open: {h} {}", last_error());
    let i = info(h);
    assert_eq!((i.loop_start, i.loop_end, i.flags & 2), (1000, 6000, 2));
    assert_eq!(myco_decode_close(h), 0);

    // ADR 0162 B2: the convention, once, before the first read; 1 on a stereo file (nothing to
    // convert), √2 on a 4-channel FuMa file; refused after a read and for an unknown code.
    let h = open_abi(&flac, 2);
    assert_eq!(myco_decode_set_convention(h, 2), f64::from(ERR_ARG));
    assert_eq!(myco_decode_set_convention(h, 1), 1.0);
    assert_eq!(myco_decode_set_convention(h, 1), f64::from(ERR_ARG), "only once");
    assert_eq!(myco_decode_close(h), 0);
    let h = open_abi(&flac, 2);
    let out = myco_decode_alloc(4096 * 2 * 4).cast::<f32>();
    // SAFETY: 4,096 stereo f32 frames.
    unsafe {
        assert_eq!(myco_decode_read_f32(h, out, 16), 16);
        myco_decode_free(out.cast(), 4096 * 2 * 4);
    }
    assert_eq!(myco_decode_set_convention(h, 0), f64::from(ERR_ARG), "after a read");
    assert!(last_error().contains("before the first read"), "{}", last_error());
    assert_eq!(myco_decode_close(h), 0);
    assert_eq!(myco_decode_set_convention(h, 0), f64::from(ERR_HANDLE));
    let h = open_abi(&pcm16_wav(4, 64, |_, _| 0), 1);
    assert!(h > 0, "open: {h} {}", last_error());
    assert_eq!(myco_decode_set_convention(h, 1), f64::from(std::f32::consts::SQRT_2));
    assert_eq!(myco_decode_close(h), 0);
    assert_eq!(open_abi(&pcm16_wav(5, 64, |_, _| 0), 1), ERR_CODEC, "5 channels");
    assert!(last_error().contains("5-channel"), "{}", last_error());

    // At most MAX_DECODERS open at once.
    let wav = fixture("tone-22050-stereo-s24.wav");
    let handles: Vec<i32> = (0..MAX_DECODERS).map(|_| open_abi(&wav, 1)).collect();
    assert!(handles.iter().all(|&h| h > 0));
    assert_eq!(open_abi(&wav, 1), ERR_LIMIT);
    for h in handles {
        assert_eq!(myco_decode_close(h), 0);
    }
    let h = open_abi(&wav, 1);
    assert!(h > 0);
    assert_eq!(myco_decode_close(h), 0);
}

#[test]
fn wav_smpl_loop_points_reach_the_info_record() {
    // A tone WAV with a trailing `smpl` chunk (forward loop 100..=1099), appended after `data`.
    let mut wav = fixture("tone-44100-mono.wav");
    let mut body = vec![0u8; 28];
    body.extend_from_slice(&1u32.to_le_bytes());
    body.extend_from_slice(&0u32.to_le_bytes());
    for v in [0u32, 0, 100, 1099, 0, 0] {
        body.extend_from_slice(&v.to_le_bytes());
    }
    wav.extend_from_slice(b"smpl");
    wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
    wav.extend_from_slice(&body);
    let h = open_abi(&wav, 1);
    assert!(h > 0, "open: {h} {}", last_error());
    let i = info(h);
    assert_eq!((i.loop_start, i.loop_end, i.flags & 2), (100, 1100, 2));
    assert_eq!(myco_decode_close(h), 0);
}
