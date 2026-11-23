//! ADR 0351 spike A0/S2: the shipped decoder (audio-decode, linked unchanged) plus, with feature `libopus`, an Ogg
//! Opus decode path through libopus (fixed point). The baseline build of this crate is the shipped
//! `myco_audio_decode.wasm` give or take the crate name; the `libopus` build's size delta is what Opus decoding adds.
//!
//! `spike_opus_decode_ogg(ptr, len)` decodes a whole Ogg Opus file (OpusHead pre-skip honoured, the last granule
//! position trimming the end, RFC 7845 §4) and returns the frame count, or a negative error. The glue a real
//! symphonia `Decoder` would add on top (codec registration, packet routing from symphonia's Ogg demuxer, which
//! already parses OpusHead) is of the same order as the page walker below.

// Keep the shipped decoder's #[no_mangle] C ABI in this cdylib.
use myco_audio_decode as _;

#[no_mangle]
pub extern "C" fn spike_alloc(n: usize) -> *mut u8 {
    let mut v = vec![0u8; n];
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// Walks the Ogg pages of one logical stream and returns its packets plus the last granule position.
#[cfg(any(feature = "libopus", feature = "opusrs"))]
fn packets(b: &[u8]) -> (Vec<Vec<u8>>, i64) {
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut last_granule = 0i64;
    let mut at = 0;
    while at + 27 <= b.len() && &b[at..at + 4] == b"OggS" {
        let granule = i64::from_le_bytes(b[at + 6..at + 14].try_into().unwrap());
        let nseg = b[at + 26] as usize;
        let lacing = &b[at + 27..at + 27 + nseg];
        let mut data = at + 27 + nseg;
        for &l in lacing {
            cur.extend_from_slice(&b[data..data + l as usize]);
            data += l as usize;
            if l < 255 {
                out.push(std::mem::take(&mut cur));
            }
        }
        if granule >= 0 {
            last_granule = granule;
        }
        at = data;
    }
    (out, last_granule)
}

/// The same decode through opus-rs 0.1.42 (pure Rust, BSD-3-Clause), for the size and speed comparison.
#[cfg(feature = "opusrs")]
#[no_mangle]
pub unsafe extern "C" fn spike_opus_decode_ogg(p: *const u8, n: usize) -> i64 {
    let (pkts, last) = packets(core::slice::from_raw_parts(p, n));
    if pkts.len() < 2 || &pkts[0][..8] != b"OpusHead" {
        return -1;
    }
    let ch = pkts[0][9] as usize;
    let pre_skip = u16::from_le_bytes([pkts[0][10], pkts[0][11]]) as i64;
    let Ok(mut dec) = opus_rs::OpusDecoder::new(48_000, ch) else { return -2 };
    let mut pcm = vec![0f32; 5760 * ch];
    let mut decoded = 0i64;
    let mut sum = 0f32;
    for pk in &pkts[2..] {
        // The frame size from the TOC (RFC 6716 §3.1): config → 2.5/5/10/20/40/60 ms, times the frame count code.
        let toc = pk[0];
        let config = toc >> 3;
        let per = match config {
            0..=11 => [480, 960, 1920, 2880][(config & 3) as usize],
            12..=15 => [480, 960][(config & 1) as usize],
            _ => [120, 240, 480, 960][(config & 3) as usize],
        };
        let count = match toc & 3 { 0 => 1, 1 | 2 => 2, _ => (pk[1] & 63) as usize };
        match dec.decode(pk, per * count, &mut pcm) {
            Ok(r) => decoded += r as i64,
            Err(_) => return -3,
        }
        sum += pcm[0];
    }
    core::hint::black_box(sum);
    (decoded.min(last) - pre_skip).max(0)
}

#[cfg(feature = "libopus")]
mod opus {
    use std::alloc::{alloc, alloc_zeroed, dealloc, realloc as re, Layout};

    // libc for libopus: malloc/calloc/realloc/free with a 16-byte size header, and abort.
    const H: usize = 16;
    unsafe fn layout(n: usize) -> Layout {
        Layout::from_size_align_unchecked(n + H, 16)
    }
    #[no_mangle]
    pub unsafe extern "C" fn malloc(n: usize) -> *mut u8 {
        let p = alloc(layout(n));
        if p.is_null() {
            return p;
        }
        (p as *mut usize).write(n);
        p.add(H)
    }
    #[no_mangle]
    pub unsafe extern "C" fn calloc(n: usize, size: usize) -> *mut u8 {
        let total = n * size;
        let p = alloc_zeroed(layout(total));
        if p.is_null() {
            return p;
        }
        (p as *mut usize).write(total);
        p.add(H)
    }
    #[no_mangle]
    pub unsafe extern "C" fn realloc(p: *mut u8, n: usize) -> *mut u8 {
        if p.is_null() {
            return malloc(n);
        }
        let base = p.sub(H);
        let old = (base as *const usize).read();
        let q = re(base, layout(old), n + H);
        if q.is_null() {
            return q;
        }
        (q as *mut usize).write(n);
        q.add(H)
    }
    #[no_mangle]
    pub unsafe extern "C" fn free(p: *mut u8) {
        if !p.is_null() {
            let base = p.sub(H);
            dealloc(base, layout((base as *const usize).read()));
        }
    }
    #[no_mangle]
    pub extern "C" fn abort() -> ! {
        panic!("libopus abort")
    }
    #[no_mangle]
    pub extern "C" fn abs(x: i32) -> i32 {
        x.abs()
    }

    #[repr(C)]
    pub struct OpusDecoder {
        _p: [u8; 0],
    }
    extern "C" {
        fn opus_decoder_create(fs: i32, channels: i32, error: *mut i32) -> *mut OpusDecoder;
        fn opus_decode(st: *mut OpusDecoder, data: *const u8, len: i32, pcm: *mut i16, frame_size: i32, decode_fec: i32) -> i32;
        fn opus_decoder_destroy(st: *mut OpusDecoder);
    }

    use super::packets;

    #[no_mangle]
    pub unsafe extern "C" fn spike_opus_decode_ogg(p: *const u8, n: usize) -> i64 {
        let (pkts, last) = packets(core::slice::from_raw_parts(p, n));
        if pkts.len() < 2 || &pkts[0][..8] != b"OpusHead" {
            return -1;
        }
        let ch = pkts[0][9] as i32;
        let pre_skip = u16::from_le_bytes([pkts[0][10], pkts[0][11]]) as i64;
        let mut err = 0;
        let dec = opus_decoder_create(48_000, ch, &mut err);
        if err != 0 {
            return -2;
        }
        let mut pcm = vec![0i16; 5760 * ch as usize];
        let mut decoded = 0i64;
        let mut sum = 0i64;
        for pk in &pkts[2..] {
            let r = opus_decode(dec, pk.as_ptr(), pk.len() as i32, pcm.as_mut_ptr(), 5760, 0);
            if r < 0 {
                opus_decoder_destroy(dec);
                return -3;
            }
            decoded += r as i64;
            sum = sum.wrapping_add(pcm[0] as i64);
        }
        opus_decoder_destroy(dec);
        core::hint::black_box(sum);
        // End trimming: the last page's granule position counts pre-skip samples too.
        (decoded.min(last) - pre_skip).max(0)
    }
}
