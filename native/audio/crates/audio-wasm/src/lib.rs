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

/// ABI version, `(major << 8) | minor`: generated from `audio-wire`'s schema beside the schema hash
/// (`CORE_ABI_MAJOR`, `CORE_ABI_MINOR`; their history is there), so the shell and the capture header read the same value.
pub const ABI_MAJOR: u32 = audio_wire::generated::CORE_ABI_MAJOR;
pub const ABI_MINOR: u32 = audio_wire::generated::CORE_ABI_MINOR;

/// The inbox: BATCH, REPLAY and small control messages (api-and-models §5: fixed 1 MiB).
pub const INBOX_BYTES: usize = 1 << 20;
/// STATUS staging (architecture §5.1: 16 KB; 20 KB with the M5 sections, ADR 0171: `STATUS_BUFFER_BYTES`).
pub const STATUS_BYTES: usize = audio_wire::generated::STATUS_BUFFER_BYTES as usize;

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

/// Deterministic init (see `Instance::init`) from the INIT record (ADR 0328) the shell wrote at the inbox's start. May
/// grow memory: the shell refreshes its views after. A refusal names its field (`ERR_INIT_MAX_MIXED`, ...;
/// `InitParams::read`); `ERR_BAD_STATE` when already initialised, `ERR_ARENA_FULL` when memory can't grow.
#[no_mangle]
pub extern "C" fn myco_audio_init() -> i32 {
    match init_params() {
        Ok(p) => instance().init(p),
        Err(code) => code,
    }
}

/// ADR 0327: the 64 KiB pages the core grows its Memory by over its life, past the module's own, for the INIT record in
/// the inbox and the clip ceiling (`audio.clipMemoryMB`): its block, the arena's growth to the ceiling, the zone kernel
/// budget and the spatial data (`audio_core::layout::memory_growth_bytes`). The shell's Memory `maximum` is its initial
/// pages plus this. Pure; callable before `init` (on a throwaway instance). A refused record gives its negative code.
#[no_mangle]
pub extern "C" fn myco_audio_memory_pages(clip_ceiling_bytes: u32) -> i32 {
    match init_params() {
        Ok(p) => {
            let bytes = audio_core::layout::memory_growth_bytes(&p, clip_ceiling_bytes as usize);
            bytes.div_ceil(audio_core::layout::PAGE_BYTES).min(i32::MAX as usize) as i32
        }
        Err(code) => code,
    }
}

/// ADR 0327: bytes of one `MemoryPart` (the block `init` takes, the `Beds`, `Zones` and `Wide` regions, the zone kernel
/// budget, the spatial data) for the INIT record in the inbox: the debug panel's memory row. Pure; callable before
/// `init`. `ERR_BAD_ARG` for an unknown part; a refused record gives its negative code. Saturates at `i32::MAX`.
#[no_mangle]
pub extern "C" fn myco_audio_memory_part_bytes(part: u32) -> i32 {
    match init_params() {
        Ok(p) => match audio_core::layout::memory_part_bytes(&p, part) {
            Some(bytes) => bytes.min(i32::MAX as usize) as i32,
            None => codes::INVALID_ARGUMENT,
        },
        Err(code) => code,
    }
}

/// The INIT record at the inbox's start, read and validated (`InitParams::read`).
fn init_params() -> Result<InitParams, i32> {
    InitParams::read(inbox(INBOX_BYTES as u32).expect("the whole inbox"))
}

/// Sets the master limiter's look-ahead in ms (A2.9, ABI 1.1; the project's
/// `audio.limiterLookaheadMs`): clamped to 0..=5, NaN is the 1.5 ms default, 0 is A2.8's
/// zero-latency limiter. Call once after `init` and before the first `process`; it fixes the
/// core's output latency (`audio_dsp::limiter::latency_frames`). `NOT_INITIALIZED` before `init`,
/// and the same `ERR_BAD_STATE` (nothing changed) once the core has rendered. Never grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_set_limiter_lookahead(ms: f32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    if audio_core::bus::set_limiter_lookahead(core, ms) {
        codes::OK
    } else {
        codes::ALREADY_INITIALIZED // ERR_BAD_STATE: the core has started rendering
    }
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
/// A1.2: `audio_core::scheduler::submit` parses it with `audio-wire`'s readers and applies the
/// records. `NOT_INITIALIZED` before `init`; `INVALID_ARGUMENT` for `len` past the inbox.
#[no_mangle]
pub extern "C" fn myco_audio_submit(len: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    match inbox(len) {
        Some(msg) => audio_core::scheduler::submit(core, msg),
        None => codes::INVALID_ARGUMENT,
    }
}

/// The first `len` bytes of the inbox, or `None` past its capacity.
fn inbox(len: u32) -> Option<&'static [u8]> {
    let len = len as usize;
    // SAFETY: single-threaded (see `Global`); the shell writes the inbox only between exports.
    (len <= INBOX_BYTES).then(|| unsafe { &(&*INBOX.get()).0[..len] })
}

// --- Clips (A1.3b) --------------------------------------------------------------------------

/// Reserves an arena block for the clip (`audio_core::clips::reserve`). `onmessage` only; may grow
/// memory, so the shell refreshes its views after. A refusal returns `ERR_CEILING` or
/// `ERR_ARENA_FULL` and queues a refusedCeiling or refusedGrow clip event for STATUS.
#[no_mangle]
pub extern "C" fn myco_audio_clip_reserve(clip: u32, frames: u32, channels: u32, src_rate: f32, format: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    audio_core::clips::reserve(core, clip, frames, channels, src_rate, format)
}

/// Where the shell copies a chunk of `bytes` (whole frames, at most 256 KB, the data size
/// `frames * channels * bytesPerSample` and never the padded body) for frame `frame_offset` on;
/// null when refused or before `init`.
#[no_mangle]
pub extern "C" fn myco_audio_clip_chunk_ptr(clip: u32, frame_offset: u32, bytes: u32) -> *mut u8 {
    match instance().core_mut() {
        Some(core) => audio_core::clips::chunk_ptr(core, clip, frame_offset, bytes),
        None => core::ptr::null_mut(),
    }
}

/// Marks a range written, in order; the range that completes the clip queues a `resident` clip
/// event.
#[no_mangle]
pub extern "C" fn myco_audio_clip_commit(clip: u32, frame_offset: u32, bytes: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    audio_core::clips::commit(core, clip, frame_offset, bytes)
}

/// Copies `len` bytes of samples (the clip's format, little-endian, whole frames) from the inbox
/// into a reserved clip at `frame_offset`; tests only (A1.2). `ERR_UNKNOWN_CLIP` for a clip not
/// reserved.
#[no_mangle]
pub extern "C" fn myco_audio_clip_write(clip: u32, frame_offset: u32, len: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    let Some(bytes) = inbox(len) else { return codes::INVALID_ARGUMENT };
    audio_core::clips::write(core, clip, frame_offset, bytes)
}

/// Drops the clip and returns its block to the arena; `ERR_UNKNOWN_CLIP` when not held.
#[no_mangle]
pub extern "C" fn myco_audio_clip_free(clip: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    audio_core::clips::free(core, clip)
}

// --- Streams (M1b, B3) ----------------------------------------------------------------------

// STREAM_OPEN and STREAM_CLOSE go through the inbox and `myco_audio_submit` (B3); a chunk goes
// through the two exports below, so the shell copies it once, straight into the ring.

/// Where the shell copies `frames` interleaved f32 frames (at most 4,096) of a STREAM_CHUNK for
/// `stream`, in its ring (`audio_core::stream`; 32,768 frames); then `myco_audio_stream_commit`.
/// Null for an unknown stream, a chunk past the credit window or after the last one, or before
/// `init`. `onmessage` only; never grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_stream_chunk_ptr(stream: u32, frames: u32) -> *mut u8 {
    match instance().core_mut() {
        Some(core) => core.streams_mut().chunk_ptr(stream, frames).unwrap_or(core::ptr::null_mut()),
        None => core::ptr::null_mut(),
    }
}

/// Commits the `frames` copied at the last `myco_audio_stream_chunk_ptr` as the stream's next
/// frames (`frames == 0`: only `flags`, e.g. an empty last chunk). A chunk of another `epoch` is
/// dropped (`ERR_STALE_EPOCH`). `flags` bit0 is the stream's last chunk.
#[no_mangle]
pub extern "C" fn myco_audio_stream_commit(stream: u32, frames: u32, epoch: u32, flags: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    core.streams_mut().commit(stream, frames, epoch, flags)
}

/// ABI 1.3 (B3): frames of `stream` its voice consumed since the last call, which the shell
/// credits back to the decoder worker (STREAM_CREDIT); `ERR_UNKNOWN_STREAM` once the ring is
/// gone. The shell polls it after `process`. Never grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_stream_consumed(stream: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    core.streams_mut().take_consumed(stream)
}

// --- Render ---------------------------------------------------------------------------------

/// Renders exactly 128 frames at context frame `frame_hi << 32 | frame_lo` and returns planar
/// stereo `[L; 128][R; 128]`, or null before `init`. Never allocates or grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_process(frame_lo: u32, frame_hi: u32) -> *const f32 {
    // A0.3: render, then let the status writer note the quantum (currentFrame, work units).
    let frame = ((frame_hi as u64) << 32) | frame_lo as u64;
    match instance().core_mut() {
        Some(core) => {
            let out = core.process(frame).as_ptr();
            audio_core::status::after_quantum(core);
            // A1.3b: clip events a full STATUS block couldn't take move into the next one.
            audio_core::clips::flush_events(core);
            out
        }
        None => core::ptr::null(),
    }
}

/// Writes the whole STATUS message (envelope included, api-and-models §4.3) at
/// `myco_audio_status_ptr`, ends the block, and returns its length in bytes; 0 before `init`.
/// The shell calls it only when it has a pooled buffer to post (§4.3), so a skipped post keeps the
/// block for the next take. Never allocates or grows memory.
#[no_mangle]
pub extern "C" fn myco_audio_status_take() -> u32 {
    let abi = myco_audio_abi_version();
    match instance().core_mut() {
        Some(core) => {
            // SAFETY: single-threaded (see `Global`); nothing else holds the staging buffer.
            let out: &mut [u8] = unsafe { &mut (&mut *STATUS.get()).0 };
            audio_core::status::take(core, out, abi) as u32
        }
        None => 0,
    }
}

/// The 16 KB STATUS staging buffer (architecture §5.1), 64-byte aligned, at a fixed address.
#[no_mangle]
pub extern "C" fn myco_audio_status_ptr() -> *const u8 {
    STATUS.get() as *const u8
}

/// Work units of the last quantum (A3.3); 0 before `init`.
#[no_mangle]
pub extern "C" fn myco_audio_work_units() -> u32 {
    instance().core().map_or(0, |core| core.work_units())
}

/// ABI 1.2 (A3.3): the shell's underrun probe's running total (architecture §4.7), called when it
/// changes. A rise is an underrun signal for the adaptive cap. `NOT_INITIALIZED` before `init`.
#[no_mangle]
pub extern "C" fn myco_audio_note_underruns(total: u32) -> i32 {
    let Some(core) = instance().core_mut() else { return codes::NOT_INITIALIZED };
    core.note_underruns(total);
    codes::OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_exports() {
        assert_eq!(myco_audio_abi_version(), audio_wire::generated::CORE_ABI_VERSION);
        assert_eq!(myco_audio_inbox_cap(), 1 << 20);
        assert_eq!(myco_audio_inbox_ptr() as usize % 64, 0);
        assert_eq!(myco_audio_status_ptr() as usize % 64, 0);
        assert!(!myco_audio_source_hash().is_null());
    }

    /// Writes the INIT record for `p` at the inbox's start, as the shell does (ADR 0328).
    fn write_init(p: &InitParams) {
        use audio_wire::generated as wire;
        // SAFETY: single-threaded use of the inbox in this test (no other test writes it).
        let inbox = unsafe { &mut (&mut *INBOX.get()).0 };
        wire::Envelope::new(wire::kind::INIT, 0, (wire::Init::FIXED_END - 16) as u32).write(inbox, 0).unwrap();
        let r = wire::Init { sample_rate: p.sample_rate, max_logical: p.max_logical, max_mixed: p.max_mixed, max_buses: p.max_buses, arena_initial_bytes: p.arena_initial_bytes, max_beds: p.max_beds, max_zone_slots: p.max_zone_slots, zone_max_frames: p.zone_max_frames, max_wide: p.max_wide, max_music_rings: p.max_music_rings };
        r.write(inbox, 0).unwrap();
    }

    #[test]
    fn the_memory_exports_read_the_init_record_and_are_pure() {
        use audio_wire::generated::{self as wire, memory_part as mp};
        // ADR 0327: the pages cover the block, the arena to the ceiling, the kernel budget and the spatial data.
        let p = InitParams { max_beds: 2, max_zone_slots: 3, zone_max_frames: 96_000, max_wide: 1, ..InitParams::default() };
        write_init(&p);
        let layout = audio_core::Layout::new(&p);
        assert_eq!(myco_audio_memory_part_bytes(mp::LAYOUT) as usize, layout.total());
        assert_eq!(myco_audio_memory_part_bytes(mp::ZONE_KERNELS) as usize, audio_core::zones::kernel_budget_bytes(3, 96_000));
        assert_eq!(myco_audio_memory_part_bytes(mp::WIDE) as usize, audio_core::stream::WIDE_RING_BYTES);
        assert_eq!(myco_audio_memory_part_bytes(77), codes::INVALID_ARGUMENT);
        let pages = myco_audio_memory_pages(128 << 20) as usize;
        assert_eq!(pages, audio_core::layout::memory_growth_bytes(&p, 128 << 20).div_ceil(65_536));
        assert!(pages * 65_536 >= layout.total() + (128 << 20) - (16 << 20));
        // ADR 0328: a refused record names its field, and every export that reads it says so.
        write_init(&InitParams { max_beds: 5, ..p });
        assert_eq!(myco_audio_memory_pages(0), wire::ERR_INIT_MAX_BEDS);
        assert_eq!(myco_audio_memory_part_bytes(mp::LAYOUT), wire::ERR_INIT_MAX_BEDS);
    }

    #[test]
    fn stubbed_exports_return_not_implemented() {
        assert_eq!(myco_audio_submit(0), codes::NOT_INITIALIZED, "A1.2: before init");
        let not_init = codes::NOT_INITIALIZED;
        assert_eq!(myco_audio_clip_reserve(1, 128, 2, 48_000.0, 0), not_init, "A1.3b: before init");
        assert!(myco_audio_clip_chunk_ptr(1, 0, 4).is_null());
        assert_eq!(myco_audio_clip_commit(1, 0, 4), not_init);
        assert_eq!(myco_audio_clip_write(1, 0, 4), not_init, "A1.2: before init");
        assert_eq!(myco_audio_clip_free(1), not_init);
        assert!(myco_audio_stream_chunk_ptr(0, 4_096).is_null());
        assert_eq!(myco_audio_stream_commit(0, 4_096, 0, 0), not_init, "B3: before init");
        assert_eq!(myco_audio_stream_consumed(0), not_init);
        assert_eq!(myco_audio_status_take(), 0);
        assert_eq!(myco_audio_set_limiter_lookahead(1.5), not_init, "A2.9: before init");
        assert_eq!(myco_audio_note_underruns(1), not_init, "A3.3: before init");
    }
}
