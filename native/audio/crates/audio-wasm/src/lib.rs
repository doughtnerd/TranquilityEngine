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
/// 2.0 (ADR 0162 R6, C8): `myco_audio_init` takes nine parameters; `myco_audio_zone_kernel_budget_bytes`.
pub const ABI_MAJOR: u32 = 2;
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
/// ABI 2.0 (ADR 0162 C8): the four M3 counts size the `Beds`, `Zones` and `Wide` regions before the
/// arena (0 is none); `INVALID_ARGUMENT` past their ranges (`InitParams::validate`).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn myco_audio_init(
    sample_rate: f32,
    max_logical: u32,
    max_mixed: u32,
    max_buses: u32,
    arena_initial_bytes: u32,
    max_beds: u32,
    max_zone_slots: u32,
    zone_max_frames: u32,
    max_wide: u32,
) -> i32 {
    instance().init(InitParams { sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide })
}

/// ABI 2.0 (ADR 0162 C8): bytes the arena needs for `max_zone_slots` zone kernels of
/// `zone_max_frames` (format 3 blobs, outside `clipMemoryMB`), which the shell adds to the Memory's
/// maximum. Pure; callable before `init`. Saturates at `u32::MAX`.
#[no_mangle]
pub extern "C" fn myco_audio_zone_kernel_budget_bytes(max_zone_slots: u32, zone_max_frames: u32) -> u32 {
    audio_core::zones::kernel_budget_bytes(max_zone_slots, zone_max_frames).min(u32::MAX as usize) as u32
}

/// ABI 2.0 (ADR 0162 C8): bytes of the block `myco_audio_init` would take for these parameters (every
/// fixed region and the arena's initial reserve, in whole pages), or 0 when they are refused. Pure;
/// callable before `init`. The shell's TypeScript mirror of the layout is tested against it.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn myco_audio_layout_bytes(
    sample_rate: f32,
    max_logical: u32,
    max_mixed: u32,
    max_buses: u32,
    arena_initial_bytes: u32,
    max_beds: u32,
    max_zone_slots: u32,
    zone_max_frames: u32,
    max_wide: u32,
) -> u32 {
    let p = InitParams { sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide };
    if p.validate().is_err() {
        return 0;
    }
    audio_core::Layout::new(&p).total().min(u32::MAX as usize) as u32
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
    match core.clips_mut().write(clip, frame_offset, bytes) {
        Ok(()) => codes::OK,
        Err(e) => e,
    }
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
    #[cfg(feature = "test-hooks")]
    trap_if_asked();
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

// --- Test hooks -----------------------------------------------------------------------------

/// Decodes the batch in the inbox and writes its values back for the round-trip test.
/// TODO(A0.2/A1.2): returns `NOT_IMPLEMENTED` as a u32 until then.
#[cfg(feature = "test-hooks")]
#[no_mangle]
pub extern "C" fn myco_audio_debug_decode_batch(_len: u32) -> u32 {
    codes::NOT_IMPLEMENTED as u32
}

/// Set by `myco_audio_debug_trap_next`; the next `myco_audio_process` traps when it is set.
#[cfg(feature = "test-hooks")]
static TRAP_NEXT: Global<bool> = Global::new(false);

/// A3.4a: makes the next `myco_audio_process` hit `unreachable` (a real wasm trap inside the render
/// call), so the loopback tests can drive the shell's trap catch and the host's hard rebuild.
#[cfg(feature = "test-hooks")]
#[no_mangle]
pub extern "C" fn myco_audio_debug_trap_next() {
    // SAFETY: single-threaded (see `Global`).
    unsafe { *TRAP_NEXT.get() = true };
}

/// The trap `myco_audio_debug_trap_next` asked for, at the top of `myco_audio_process`.
#[cfg(feature = "test-hooks")]
fn trap_if_asked() {
    // SAFETY: single-threaded (see `Global`).
    if unsafe { core::mem::replace(&mut *TRAP_NEXT.get(), false) } {
        #[cfg(target_arch = "wasm32")]
        core::arch::wasm32::unreachable();
        #[cfg(not(target_arch = "wasm32"))]
        panic!("myco_audio_debug_trap_next: the trap asked for");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_exports() {
        assert_eq!(myco_audio_abi_version(), 0x200);
        assert_eq!(myco_audio_inbox_cap(), 1 << 20);
        assert_eq!(myco_audio_inbox_ptr() as usize % 64, 0);
        assert_eq!(myco_audio_status_ptr() as usize % 64, 0);
        assert!(!myco_audio_source_hash().is_null());
    }

    #[test]
    fn the_layout_and_kernel_budget_exports_are_pure() {
        // ADR 0162 C8: zero M3 counts give M2's layout plus the pool and scratch; refused parameters 0.
        let m2 = myco_audio_layout_bytes(48_000.0, 4_096, 128, 32, 16 << 20, 0, 0, 0, 0);
        let m3 = myco_audio_layout_bytes(48_000.0, 4_096, 128, 32, 16 << 20, 2, 3, 96_000, 1);
        assert_eq!(m2 as usize % 65_536, 0);
        let extra = audio_core::bed::region_bytes(&InitParams { max_beds: 2, max_wide: 1, ..InitParams::default() })
            + 3 * audio_core::zones::slot_state_bytes(96_000)
            + audio_core::stream::WIDE_RING_BYTES;
        // Whole pages around the arena: within a page either way.
        assert!(((m3 - m2) as i64 - extra as i64).abs() <= 65_536, "{m2} -> {m3}, regions {extra}");
        assert_eq!(myco_audio_layout_bytes(48_000.0, 4_096, 128, 32, 0, 5, 0, 0, 0), 0, "5 beds are refused");
        assert_eq!(myco_audio_zone_kernel_budget_bytes(0, 96_000), 0);
        assert_eq!(myco_audio_zone_kernel_budget_bytes(3, 96_000) as usize, audio_core::zones::kernel_budget_bytes(3, 96_000));
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

    /// A3.4a's test hook: the check `myco_audio_process` runs first traps (natively, a panic) once
    /// after `myco_audio_debug_trap_next`. `cargo test -p audio-wasm --features test-hooks` runs it
    /// (the loopback tests drive the real wasm trap).
    #[cfg(feature = "test-hooks")]
    #[test]
    fn trap_next_traps_once() {
        trap_if_asked();
        myco_audio_debug_trap_next();
        assert!(std::panic::catch_unwind(trap_if_asked).is_err());
        trap_if_asked();
    }
}
