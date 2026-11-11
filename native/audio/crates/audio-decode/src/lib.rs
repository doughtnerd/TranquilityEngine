//! Myco's audio decoder (ADR 0157, M1b; api-and-models §5): symphonia 0.6.1 behind a plain C ABI,
//! compiled to `myco_audio_decode.wasm` and run in the decoder worker (architecture §1). WAV, FLAC,
//! MP3 and Ogg Vorbis are always in; AAC in MP4/M4A or ADTS only with the `aac` feature.
//!
//! # Memory
//!
//! Unlike the mixer, this module **exports** its memory (`memory`) and owns its allocator: it runs
//! alone in a worker, and nothing else shares its memory. Any export that allocates (`alloc`,
//! `open`, `read_*`, `seek`) may grow it, so the caller re-creates its typed-array views after
//! each call (or checks `memory.buffer` for a change).
//!
//! # Calls
//!
//! 1. `p = myco_decode_alloc(len)`, copy the encoded file to `p`, then `h = myco_decode_open(p,
//!    len, hint)`. `open` always takes ownership of the allocation (freed on failure too).
//! 2. `myco_decode_info(h, info)` writes the 40-byte [`INFO_BYTES`] record at `info` (8-aligned): rate u32 @0, channels u32 @4, frames f64 @8
//!    (-1 unknown), frames estimate f64 @16, codec u32 @24, flags u32 @28 (bit 0 length exact, bit 1 the file
//!    states a loop), loop start frame u32 @32 and loop end frame (exclusive) u32 @36 (both 0 without a loop).
//! 3. `myco_decode_read_f32(h, out, frames)` or `myco_decode_read_i16(...)` decodes up to `frames`
//!    interleaved frames into the caller's buffer (from `alloc`, reused across reads) and returns
//!    the count: less than asked only at the end, 0 after it. Whole-clip decode is one read of
//!    `info.frames` (or reads until 0 when the length is unknown); a stream reads 4,096 at a time.
//! 4. `myco_decode_seek(h, frame)` moves the next read to `frame` (sample-accurate) and returns it.
//! 5. `myco_decode_close(h)`. Up to [`MAX_DECODERS`] decoders may be open at once.
//!
//! Negative `i32` (or `f64`) results are the `ERR_*` codes; `myco_decode_error_ptr/len` give the
//! last failure's message (UTF-8). No export panics on bad input: arguments are checked and
//! symphonia's errors become codes. The release build is `panic = "abort"`, so a bug that does
//! panic traps the instance, and the worker re-creates it.

pub mod ambisonic;
mod decoder;
pub mod ir;
mod loop_points;
#[cfg(feature = "aac")]
mod mp4_gapless;

pub use loop_points::{comment_loop_points, smpl_loop_points, wav_loop_points};
pub use decoder::{mp3_has_length_header, Bytes, Codec, DecodeError, Decoder, FormatHint, Info};

use std::alloc::{alloc, dealloc, Layout};
use std::sync::{Arc, Mutex, MutexGuard};

/// `(major << 8) | minor` of this ABI.
pub const ABI_VERSION: u32 = 0x101;
/// Open decoders at once.
pub const MAX_DECODERS: usize = 64;
/// Bytes of the record `myco_decode_info` writes: `u32 sampleRate; u32 channels; f64 frames (-1
/// unknown); f64 framesEstimate (-1 unknown); u32 codec (0 other, 1 PCM, 2 FLAC, 3 MP3, 4 Vorbis,
/// 5 AAC); u32 flags (bit0: frames is exact)`.
pub const INFO_BYTES: usize = 40;
/// Alignment of every `myco_decode_alloc` block (enough for f32, i16 and f64 views).
pub const ALLOC_ALIGN: usize = 16;

/// A handle that isn't open (never was, closed, or stale).
pub const ERR_HANDLE: i32 = -1;
/// A null, misaligned or out-of-range pointer, or a zero or oversized length.
pub const ERR_ARG: i32 = -2;
/// The bytes are not a container this build reads.
pub const ERR_FORMAT: i32 = -3;
/// No audio track, or a codec this build doesn't include.
pub const ERR_CODEC: i32 = -4;
/// A fatal decode error mid-stream.
pub const ERR_DECODE: i32 = -5;
/// The container refused the seek.
pub const ERR_SEEK: i32 = -6;
/// `MAX_DECODERS` are already open.
pub const ERR_LIMIT: i32 = -7;
/// An allocation failed.
pub const ERR_MEMORY: i32 = -8;

static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

// --- The encoded file, owned from `alloc` ------------------------------------------------------

/// A block from `myco_decode_alloc`, freed with the same layout when the last reader drops it.
struct OwnedBlock {
    ptr: *mut u8,
    len: usize,
}

// SAFETY: the block is uniquely owned and only read after open; wasm32 is single-threaded and
// native tests only move it between threads behind the table's mutex.
unsafe impl Send for OwnedBlock {}
unsafe impl Sync for OwnedBlock {}

impl AsRef<[u8]> for OwnedBlock {
    fn as_ref(&self) -> &[u8] {
        // SAFETY: `ptr` came from `alloc(len)` and lives until drop.
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for OwnedBlock {
    fn drop(&mut self) {
        free_block(self.ptr, self.len);
    }
}

fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len, ALLOC_ALIGN).ok()
}

fn free_block(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Some(l) = layout(len) {
        // SAFETY: the caller passes a block from `myco_decode_alloc(len)`.
        unsafe { dealloc(ptr, l) }
    }
}

// --- Handle table ------------------------------------------------------------------------------

struct Slot {
    generation: u16,
    decoder: Option<Box<Decoder>>,
}

struct Table {
    slots: Vec<Slot>,
    error: String,
}

static TABLE: Mutex<Table> = Mutex::new(Table { slots: Vec::new(), error: String::new() });

fn table() -> MutexGuard<'static, Table> {
    // panic = "abort": a poisoned lock can't be observed in release; tests recover it.
    TABLE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Handles are `generation << 16 | (index + 1)`, always positive, so a closed slot's old handle
/// is refused after the slot is reused.
fn handle_of(index: usize, generation: u16) -> i32 {
    (i32::from(generation & 0x7fff) << 16) | (index as i32 + 1)
}

impl Table {
    fn get(&mut self, handle: i32) -> Option<&mut Decoder> {
        if handle <= 0 {
            return None;
        }
        let index = (handle & 0xffff) as usize;
        let generation = ((handle >> 16) & 0x7fff) as u16;
        let slot = self.slots.get_mut(index.checked_sub(1)?)?;
        if slot.generation & 0x7fff != generation {
            return None;
        }
        slot.decoder.as_deref_mut()
    }

    fn fail(&mut self, code: i32, message: &str) -> i32 {
        self.error.clear();
        self.error.push_str(message);
        code
    }

    fn fail_decode(&mut self, e: &DecodeError) -> i32 {
        let code = match e {
            DecodeError::Format(_) => ERR_FORMAT,
            DecodeError::Codec(_) => ERR_CODEC,
            DecodeError::Decode(_) => ERR_DECODE,
            DecodeError::Seek(_) => ERR_SEEK,
        };
        self.fail(code, e.message())
    }

    fn insert(&mut self, decoder: Decoder) -> i32 {
        let index = match self.slots.iter().position(|s| s.decoder.is_none()) {
            Some(i) => i,
            None if self.slots.len() < MAX_DECODERS => {
                self.slots.push(Slot { generation: 0, decoder: None });
                self.slots.len() - 1
            }
            None => return self.fail(ERR_LIMIT, "too many open decoders"),
        };
        let slot = &mut self.slots[index];
        slot.generation = slot.generation.wrapping_add(1) & 0x7fff;
        slot.decoder = Some(Box::new(decoder));
        handle_of(index, slot.generation)
    }
}

/// Whether `[ptr, ptr + bytes)` is inside the module's memory (wasm32), and `ptr` is non-null and
/// `align`-aligned.
fn valid_range(ptr: usize, bytes: usize, align: usize) -> bool {
    if ptr == 0 || ptr % align != 0 {
        return false;
    }
    let Some(end) = ptr.checked_add(bytes) else { return false };
    #[cfg(target_arch = "wasm32")]
    {
        end <= core::arch::wasm32::memory_size(0) * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = end;
        true
    }
}

// --- Exports -----------------------------------------------------------------------------------

/// `(major << 8) | minor`: 1.0.
#[no_mangle]
pub extern "C" fn myco_decode_abi_version() -> u32 {
    ABI_VERSION
}

/// 16 bytes: the audio core's source hash (the mixer's `myco_audio_source_hash` gives the same).
#[no_mangle]
pub extern "C" fn myco_decode_source_hash() -> *const u8 {
    SOURCE_HASH.as_ptr()
}

/// A block of `len` bytes aligned to 16, or 0 when `len` is 0 or memory can't grow.
#[no_mangle]
pub extern "C" fn myco_decode_alloc(len: u32) -> *mut u8 {
    let len = len as usize;
    if len == 0 {
        return std::ptr::null_mut();
    }
    match layout(len) {
        // SAFETY: a non-zero size and a valid layout.
        Some(l) => unsafe { alloc(l) },
        None => std::ptr::null_mut(),
    }
}

/// Frees a block from `myco_decode_alloc(len)` (the same `len`). Null is ignored.
///
/// # Safety
/// `ptr` must come from `myco_decode_alloc(len)` and not be freed or passed to `open` already.
#[no_mangle]
pub unsafe extern "C" fn myco_decode_free(ptr: *mut u8, len: u32) {
    free_block(ptr, len as usize);
}

/// Opens the encoded file at `ptr` (`len` bytes from `myco_decode_alloc(len)`, which this call
/// owns from now on). `hint`: 0 none, 1 wav, 2 flac, 3 mp3, 4 ogg, 5 mp4/m4a, 6 aac (ADTS).
/// Returns a handle (> 0) or an `ERR_*` code.
///
/// # Safety
/// `ptr` must come from `myco_decode_alloc(len)` and not be freed or opened already.
#[no_mangle]
pub unsafe extern "C" fn myco_decode_open(ptr: *mut u8, len: u32, hint: u32) -> i32 {
    let mut t = table();
    if !valid_range(ptr as usize, len as usize, ALLOC_ALIGN) || len == 0 {
        return t.fail(ERR_ARG, "open: null or invalid buffer");
    }
    let block = OwnedBlock { ptr, len: len as usize };
    if t.slots.iter().all(|s| s.decoder.is_some()) && t.slots.len() >= MAX_DECODERS {
        return t.fail(ERR_LIMIT, "too many open decoders");
    }
    let bytes: Bytes = Arc::new(block);
    match Decoder::open(bytes, FormatHint::from_code(hint)) {
        Ok(d) => t.insert(d),
        Err(e) => t.fail_decode(&e),
    }
}

/// Closes a decoder and frees its file. Returns 0 or `ERR_HANDLE`.
#[no_mangle]
pub extern "C" fn myco_decode_close(handle: i32) -> i32 {
    let mut t = table();
    if t.get(handle).is_none() {
        return t.fail(ERR_HANDLE, "close: no such decoder");
    }
    let index = (handle & 0xffff) as usize - 1;
    t.slots[index].decoder = None;
    0
}

/// Writes the [`INFO_BYTES`] record at `out` (8-aligned). Returns 0 or an `ERR_*` code.
///
/// # Safety
/// `out` must point at `INFO_BYTES` writable bytes of this module's memory.
#[no_mangle]
pub unsafe extern "C" fn myco_decode_info(handle: i32, out: *mut u8) -> i32 {
    let mut t = table();
    let Some(d) = t.get(handle) else { return t.fail(ERR_HANDLE, "info: no such decoder") };
    let info = d.info();
    if !valid_range(out as usize, INFO_BYTES, 8) {
        return t.fail(ERR_ARG, "info: null or misaligned record");
    }
    let mut rec = [0u8; INFO_BYTES];
    rec[0..4].copy_from_slice(&info.sample_rate.to_le_bytes());
    rec[4..8].copy_from_slice(&info.channels.to_le_bytes());
    let frames = info.frames.map_or(-1.0, |f| f as f64);
    let estimate = info.frames_estimate.map_or(-1.0, |f| f as f64);
    rec[8..16].copy_from_slice(&frames.to_le_bytes());
    rec[16..24].copy_from_slice(&estimate.to_le_bytes());
    rec[24..28].copy_from_slice(&(info.codec as u32).to_le_bytes());
    let (loop_start, loop_end) = info.loop_points.unwrap_or((0, 0));
    let flags = u32::from(info.frames.is_some()) | (u32::from(info.loop_points.is_some()) << 1);
    rec[32..36].copy_from_slice(&loop_start.to_le_bytes());
    rec[36..40].copy_from_slice(&loop_end.to_le_bytes());
    rec[28..32].copy_from_slice(&flags.to_le_bytes());
    // SAFETY: checked above (in range and aligned); the caller owns the record.
    std::ptr::copy_nonoverlapping(rec.as_ptr(), out, INFO_BYTES);
    0
}

/// Decodes up to `frames` frames as interleaved f32 into `out` (`frames * channels * 4` bytes,
/// 4-aligned). Returns the frames written (0 at the end) or an `ERR_*` code.
///
/// # Safety
/// `out` must point at that many writable bytes of this module's memory.
#[no_mangle]
pub unsafe extern "C" fn myco_decode_read_f32(handle: i32, out: *mut f32, frames: u32) -> i32 {
    read(handle, out, frames, |d, s| d.read_f32(s))
}

/// As `myco_decode_read_f32`, as int16 (`frames * channels * 2` bytes, 2-aligned).
///
/// # Safety
/// `out` must point at that many writable bytes of this module's memory.
#[no_mangle]
pub unsafe extern "C" fn myco_decode_read_i16(handle: i32, out: *mut i16, frames: u32) -> i32 {
    read(handle, out, frames, |d, s| d.read_i16(s))
}

unsafe fn read<T>(
    handle: i32,
    out: *mut T,
    frames: u32,
    f: impl FnOnce(&mut Decoder, &mut [T]) -> Result<usize, DecodeError>,
) -> i32 {
    let mut t = table();
    let Some(d) = t.get(handle) else { return t.fail(ERR_HANDLE, "read: no such decoder") };
    // At most i32::MAX frames can be reported.
    let frames = frames.min(i32::MAX as u32) as usize;
    let samples = frames.checked_mul(d.info().channels as usize);
    let size = std::mem::size_of::<T>();
    let Some(samples) = samples.filter(|s| s.checked_mul(size).is_some()) else {
        return t.fail(ERR_ARG, "read: buffer too large");
    };
    if frames == 0 {
        return 0;
    }
    if !valid_range(out as usize, samples * size, std::mem::align_of::<T>()) {
        return t.fail(ERR_ARG, "read: null, misaligned or out-of-range buffer");
    }
    // SAFETY: checked above; the caller owns the buffer for the call.
    let slice = std::slice::from_raw_parts_mut(out, samples);
    match f(d, slice) {
        Ok(n) => n as i32,
        Err(e) => t.fail_decode(&e),
    }
}

/// Moves the next read to `frame` (sample-accurate; clamped to the length when known). Returns the
/// frame the next read starts at, or an `ERR_*` code.
#[no_mangle]
pub extern "C" fn myco_decode_seek(handle: i32, frame: f64) -> f64 {
    let mut t = table();
    let Some(d) = t.get(handle) else { return f64::from(t.fail(ERR_HANDLE, "seek: no such decoder")) };
    if !(frame >= 0.0) || frame > 9.0e15 {
        return f64::from(t.fail(ERR_ARG, "seek: frame must be a non-negative number"));
    }
    match d.seek(frame as u64) {
        Ok(at) => at as f64,
        Err(e) => f64::from(t.fail_decode(&e)),
    }
}

/// The last failure's message: its address (valid until the next call) and length in bytes.
#[no_mangle]
pub extern "C" fn myco_decode_error_ptr() -> *const u8 {
    table().error.as_ptr()
}

/// See `myco_decode_error_ptr`.
#[no_mangle]
pub extern "C" fn myco_decode_error_len() -> u32 {
    table().error.len() as u32
}
