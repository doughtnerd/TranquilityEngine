//! The C ABI of Myco's audio core (ADR 0157, api-and-models §5), built as `myco_audio.wasm`.
//!
//! Plain `#[no_mangle] extern "C"` functions over linear memory, no wasm-bindgen: the worklet scope
//! lacks what the glue needs. Memory is **imported** (`--import-memory`, set in `build.rs` with the
//! 256 KB linker stack); the shell creates it. `i32` results are 0 for ok and negative codes
//! (`codes.rs`) otherwise.
//!
//! Contract K2: **every** export in §5's table exists from task A0.1. Those whose bodies belong to
//! later tasks return `NOT_IMPLEMENTED` (or null, 0) and name their task. This file is a
//! single-writer file: after A0.1 only the S task the coordinator names fills a body, one per wave.
//!
//! The worklet is single-threaded, so the globals below are only touched from one thread.

pub mod codes;
pub mod instance;
pub mod memory;

use core::cell::UnsafeCell;

use audio_core::InitParams;

use crate::instance::Instance;
use crate::memory::{PlatformMemory, PLATFORM_MEMORY};

/// ABI version, `(major << 8) | minor`. Bump the minor for an added export, the major for a change.
pub const ABI_MAJOR: u32 = 1;
pub const ABI_MINOR: u32 = 0;

/// The inbox: BATCH, REPLAY and small control messages (api-and-models §5: fixed 1 MiB).
pub const INBOX_BYTES: usize = 1 << 20;
/// STATUS staging (architecture §5.1: 16 KB).
pub const STATUS_BYTES: usize = 16 * 1024;

/// A global the single worklet thread owns.
#[repr(transparent)]
struct Global<T>(UnsafeCell<T>);

// SAFETY: the audio worklet runs every export on one thread; native builds use the stateful
// exports only from single-threaded code.
unsafe impl<T> Sync for Global<T> {}

impl<T> Global<T> {
    const fn new(value: T) -> Global<T> {
        Global(UnsafeCell::new(value))
    }

    fn get(&self) -> *mut T {
        self.0.get()
    }
}

#[repr(C, align(64))]
struct Aligned<const N: usize>([u8; N]);

/// Static, so its address is fixed by the module (deterministic without depending on `init`).
static INBOX: Global<Aligned<INBOX_BYTES>> = Global::new(Aligned([0; INBOX_BYTES]));
static STATUS: Global<Aligned<STATUS_BYTES>> = Global::new(Aligned([0; STATUS_BYTES]));
static INSTANCE: Global<Instance<PlatformMemory>> = Global::new(Instance::new(PLATFORM_MEMORY));

/// The source hash `build.rs` computed (SHA-256 of the sources, first 16 bytes; api-and-models §5).
static SOURCE_HASH: [u8; 16] = *include_bytes!(concat!(env!("OUT_DIR"), "/source_hash.bin"));

static SCHEMA_HASH: [u8; 16] = audio_wire::generated::SCHEMA_HASH;

#[allow(clippy::mut_from_ref)]
fn instance() -> &'static mut Instance<PlatformMemory> {
    // SAFETY: single-threaded (see `Global`); no export holds this across another export.
    unsafe { &mut *INSTANCE.get() }
}

// --- Identity -------------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn myco_audio_abi_version() -> u32 {
    (ABI_MAJOR << 8) | ABI_MINOR
}

/// 16 bytes: the wire schema hash (`audio-wire`, contract K1); `wire.generated.ts` embeds the same.
#[no_mangle]
pub extern "C" fn myco_audio_schema_hash() -> *const u8 {
    SCHEMA_HASH.as_ptr()
}

/// 16 bytes: the source hash `wasm/hash.json` records.
#[no_mangle]
pub extern "C" fn myco_audio_source_hash() -> *const u8 {
    SOURCE_HASH.as_ptr()
}

// --- Lifecycle ------------------------------------------------------------------------------

/// Deterministic init (see `Instance::init`). May grow memory: the shell refreshes its views after.
#[no_mangle]
pub extern "C" fn myco_audio_init(sample_rate: f32, max_logical: u32, max_mixed: u32, max_buses: u32, arena_initial_bytes: u32) -> i32 {
    instance().init(InitParams { sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes })
}

/// Drops state for tests. A rebuild makes a new global scope and reuses nothing.
#[no_mangle]
pub extern "C" fn myco_audio_dispose() {
    instance().dispose();
}

// --- Inbox ----------------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn myco_audio_inbox_ptr() -> *mut u8 {
    INBOX.get() as *mut u8
}

#[no_mangle]
pub extern "C" fn myco_audio_inbox_cap() -> u32 {
    INBOX_BYTES as u32
}

/// Parses the inbox message of `len` bytes (BATCH, REPLAY or control); never inside `process`.
/// TODO(A1.2): command apply.
#[no_mangle]
pub extern "C" fn myco_audio_submit(_len: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

// --- Clips (A1.3b) --------------------------------------------------------------------------

/// `onmessage` only; may grow memory. TODO(A1.3b).
#[no_mangle]
pub extern "C" fn myco_audio_clip_reserve(_clip: u32, _frames: u32, _channels: u32, _src_rate: f32, _format: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

/// Where the shell copies a chunk (at most 256 KB per quantum). TODO(A1.3b).
#[no_mangle]
pub extern "C" fn myco_audio_clip_chunk_ptr(_clip: u32, _frame_offset: u32, _bytes: u32) -> *mut u8 {
    core::ptr::null_mut()
}

/// Marks a range written; the last range emits a `resident` clip event. TODO(A1.3b).
#[no_mangle]
pub extern "C" fn myco_audio_clip_commit(_clip: u32, _frame_offset: u32, _bytes: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

/// Copies from the inbox; tests only. TODO(A1.3b).
#[no_mangle]
pub extern "C" fn myco_audio_clip_write(_clip: u32, _frame_offset: u32, _len: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

/// TODO(A1.3b).
#[no_mangle]
pub extern "C" fn myco_audio_clip_free(_clip: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

// --- Streams (M1b, B3) ----------------------------------------------------------------------

/// Into the stream ring (32,768 frames). TODO(B3).
#[no_mangle]
pub extern "C" fn myco_audio_stream_chunk_ptr(_stream: u32, _frames: u32) -> *mut u8 {
    core::ptr::null_mut()
}

/// A stale `epoch` is dropped. TODO(B3).
#[no_mangle]
pub extern "C" fn myco_audio_stream_commit(_stream: u32, _frames: u32, _epoch: u32, _flags: u32) -> i32 {
    codes::NOT_IMPLEMENTED
}

// --- Render ---------------------------------------------------------------------------------

/// Renders exactly 128 frames at context frame `frame_hi << 32 | frame_lo` and returns planar
/// stereo `[L; 128][R; 128]`, or null before `init`. Never allocates or grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_process(frame_lo: u32, frame_hi: u32) -> *const f32 {
    instance().process(((frame_hi as u64) << 32) | frame_lo as u64)
}

/// Writes the STATUS body at `myco_audio_status_ptr` and returns its length in bytes.
/// TODO(A0.3): the status writer; 0 (nothing to send) until then.
#[no_mangle]
pub extern "C" fn myco_audio_status_take() -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn myco_audio_status_ptr() -> *const u8 {
    STATUS.get() as *const u8
}

/// Work units of the last quantum (A3.3); 0 before `init`.
#[no_mangle]
pub extern "C" fn myco_audio_work_units() -> u32 {
    instance().core().map_or(0, |core| core.work_units())
}

// --- Test hooks -----------------------------------------------------------------------------

/// Decodes the batch in the inbox and writes its values back for the round-trip test.
/// TODO(A0.2/A1.2): returns `NOT_IMPLEMENTED` as a u32 until then.
#[cfg(feature = "test-hooks")]
#[no_mangle]
pub extern "C" fn myco_audio_debug_decode_batch(_len: u32) -> u32 {
    codes::NOT_IMPLEMENTED as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_exports() {
        assert_eq!(myco_audio_abi_version(), 0x100);
        assert_eq!(myco_audio_inbox_cap(), 1 << 20);
        assert_eq!(myco_audio_inbox_ptr() as usize % 64, 0);
        assert_eq!(myco_audio_status_ptr() as usize % 64, 0);
        assert!(!myco_audio_source_hash().is_null());
    }

    #[test]
    fn stubbed_exports_return_not_implemented() {
        use codes::NOT_IMPLEMENTED as NI;
        assert_eq!(myco_audio_submit(0), NI);
        assert_eq!(myco_audio_clip_reserve(1, 128, 2, 48_000.0, 0), NI);
        assert!(myco_audio_clip_chunk_ptr(1, 0, 4).is_null());
        assert_eq!(myco_audio_clip_commit(1, 0, 4), NI);
        assert_eq!(myco_audio_clip_write(1, 0, 4), NI);
        assert_eq!(myco_audio_clip_free(1), NI);
        assert!(myco_audio_stream_chunk_ptr(0, 4_096).is_null());
        assert_eq!(myco_audio_stream_commit(0, 4_096, 0, 0), NI);
        assert_eq!(myco_audio_status_take(), 0);
    }
}
