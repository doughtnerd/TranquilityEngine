//! The clip store (contract K11): where voices find their PCM.
//!
//! The API (`reserve`, `write`, `frames`, `free`, `clear`) is the seam A1.2's voices use. A1.3b
//! replaced the body: a **clip directory** in the `ClipDirectory` region (fixed entries, sorted by
//! clip id) over the **slab arena** ([`crate::arena`]) that starts in the `Arena` region
//! (architecture §5.2). Each clip is one arena block holding its samples, interleaved, in its own
//! format (the shell copies chunks straight in).
//!
//! Rules:
//! - `reserve`, `write`, `chunk_ptr`, `commit` and `free` run from `onmessage` only (the `clip_*`
//!   exports, `submit`), never inside `process`. Only `reserve` may grow memory.
//! - `frames` runs inside `process`: it never allocates and is O(log n).
//! - Clips are interleaved, f32 or int16, each at its own sample rate, with 1 or 2 channels, or 4,
//!   9 or 16 for an ambisonic clip of order 1-3 (ADR 0162 B2, [`is_clip_channel_count`]). A voice
//!   reads an N-channel clip through `resample::lagrange_n` into the core's one shared 8 KB planar
//!   scratch (`resample::PLANAR_SCRATCH_FLOATS`); until task B3's ambisonic voice, a plain voice
//!   plays its W channel.
//! - Clip events (api-and-models §4.3: 1 resident, 2 refusedCeiling, 3 refusedGrow) queue in the
//!   store; the core-level functions at the end of this file move them to the STATUS counters
//!   (K12) with [`flush_events`], and the store keeps what a full block can't take.
//! - **Ceiling.** The main-side clip registry is the primary ceiling check: it refuses a load past
//!   `clipMemoryMB` before CLIP_BEGIN. In the core, a full arena (the Memory's `maximum`, which the
//!   shell sizes as the fixed regions plus the clip ceiling) is refusedGrow; refusedCeiling comes
//!   only from [`ClipStore::set_ceiling`] or a full directory (see [`crate::arena`]).
//! - **HRIR data (H3).** A CLIP_BEGIN with `format = 2` and a reserved id (`0xFFFF0000..=0xFFFF00FF`,
//!   `channels` 1, `frames` = blob bytes / 2, `sampleRate` the context rate: H2's convention) is the
//!   HRTF table, not a voice clip: its entry is never a voice's source ([`ClipStore::frames`] gives
//!   `None`). Its reserve also takes the arena block for the [`HrtfBank`] (the 32 HRTF panners), so
//!   memory grows only in `reserve` as before. When its last range is committed the blob is parsed
//!   with `HrirDatabase::parse`, the bank is built, and clip event 4 `hrtfReady` is queued instead
//!   of `resident`; invalid data, or a rate HRTF can't run at, leaves STATUS `hrtfLoadFailure` at 2
//!   (data) and no event. One HRIR table at a time; freeing it (or a reset) drops the bank, and
//!   kind-1 voices pan equal-power again.
//! - **Zone kernels (ADR 0162 C6, task C3).** `format = 3` (a prepared kernel, `channels` 1, f32
//!   words) and `format = 5` (zone IR PCM, `channels` 2, interleaved f32 at the context rate) take a
//!   zone kernel id (`0xFFFF0200..=0xFFFF02FF`) and are never a voice's source. They are outside
//!   `clipMemoryMB` and count against the zone kernel budget (`zones::kernel_budget_bytes`, the
//!   shell's addition to the Memory's maximum): a reserve past it is refusedCeiling. A format 3 clip
//!   is `resident` when its last range is committed, and the zone slots waiting for it start
//!   (`zones::kernel_resident`); its header is checked when a slot starts (a bad one is the zone
//!   event `badBlob`). A format 5 clip is stored and stays silent: task C3b prepares its kernel in
//!   the core and reports `resident` then.

use audio_dsp::hrtf::HrirDatabase;
use audio_dsp::resample::{Samples, Source};
use audio_wire::generated as wire;

use crate::arena::{Arena, Block, GrowFn, Refusal};
use crate::core::Core;
use crate::counters::{flag, Event};
use crate::layout::CLIP_DIRECTORY_ENTRY_BYTES;
use crate::panner::HrtfBank;
use crate::status;

/// Most bytes one `chunk_ptr`/`commit` takes (api-and-models §5: at most 256 KB per quantum).
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;

/// Clip events the store keeps while STATUS blocks are full.
pub const EVENT_QUEUE: usize = 256;

/// A clip's sample format (CLIP_BEGIN `format`, api-and-models §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipFormat {
    F32,
    I16,
    /// HRIR data (H3): int16 words, the HRTF table; never a voice's source.
    Hrir,
    /// ADR 0162 C6: a prepared zone kernel (format 3), f32 words; never a voice's source.
    ZoneKernel,
    /// ADR 0162 C6: zone IR PCM (format 5), interleaved stereo f32; never a voice's source.
    ZoneIrPcm,
    /// ADR 0162 A4: the MagLS bed filters (format 4, id `MAGLS_CLIP_ID`): f32 words, the
    /// `MaglsHeader` then `[16][2][taps]`; transformed into `bed.rs` at commit; never a voice's source.
    MagLs,
}

impl ClipFormat {
    /// The wire's `format` value (0 f32, 1 int16, 2 HRIR data).
    pub fn from_wire(format: u32) -> Option<ClipFormat> {
        match format {
            wire::clip_format::F32 => Some(ClipFormat::F32),
            wire::clip_format::I16 => Some(ClipFormat::I16),
            wire::clip_format::HRIR => Some(ClipFormat::Hrir),
            wire::clip_format::ZONE_KERNEL => Some(ClipFormat::ZoneKernel),
            wire::clip_format::ZONE_IR_PCM => Some(ClipFormat::ZoneIrPcm),
            wire::clip_format::MAG_LS => Some(ClipFormat::MagLs),
            _ => None,
        }
    }

    /// The wire's value back.
    fn to_wire(self) -> u8 {
        match self {
            ClipFormat::F32 => 0,
            ClipFormat::I16 => 1,
            ClipFormat::Hrir => 2,
            ClipFormat::ZoneKernel => 3,
            ClipFormat::ZoneIrPcm => 5,
            ClipFormat::MagLs => 4,
        }
    }

    /// Bytes per sample.
    pub fn sample_bytes(self) -> usize {
        match self {
            ClipFormat::F32 | ClipFormat::ZoneKernel | ClipFormat::ZoneIrPcm | ClipFormat::MagLs => 4,
            ClipFormat::I16 | ClipFormat::Hrir => 2,
        }
    }
}

/// A resident clip as a voice reads it.
#[derive(Clone, Copy, Debug)]
pub struct Clip<'a> {
    pub source: Source<'a>,
    /// The clip's own rate, in Hz.
    pub sample_rate: f32,
}

/// One directory entry. All-zero bytes are valid (the region is zeroed at init).
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Entry {
    id: u32,
    frames: u32,
    sample_rate: f32,
    /// Frames committed from frame 0, in order.
    committed: u32,
    /// The block's address.
    addr: usize,
    channels: u8,
    /// 0 f32, 1 int16, 2 HRIR (the wire's values).
    format: u8,
    class: u8,
    /// 1 once the resident event was queued.
    resident: u8,
}

const _: () = assert!(core::mem::size_of::<Entry>() <= CLIP_DIRECTORY_ENTRY_BYTES, "an entry fits its layout size");
const _: () = assert!(core::mem::align_of::<Entry>() <= crate::layout::REGION_ALIGN);

impl Entry {
    fn format(&self) -> ClipFormat {
        match self.format {
            1 => ClipFormat::I16,
            2 => ClipFormat::Hrir,
            3 => ClipFormat::ZoneKernel,
            5 => ClipFormat::ZoneIrPcm,
            4 => ClipFormat::MagLs,
            _ => ClipFormat::F32,
        }
    }

    fn frame_bytes(&self) -> usize {
        self.channels as usize * self.format().sample_bytes()
    }

    fn block(&self) -> Block {
        Block { addr: self.addr, class: self.class }
    }
}

/// Every clip the core holds, by clip id (the main thread's registry id, api-and-models §3).
pub struct ClipStore {
    /// The directory: `len` entries in use, sorted by `id`.
    entries: &'static mut [Entry],
    len: usize,
    arena: Arena,
    /// Clip events not yet in a STATUS block (a ring).
    events: [Event; EVENT_QUEUE],
    events_head: usize,
    events_len: usize,
    /// The HRIR table held (H3): its clip id (0: none) and the bank's block, taken with it.
    hrir_id: u32,
    hrtf_block: Block,
    /// The bank is built (the table was parsed): kind-1 voices can pan HRTF.
    hrtf_ready: bool,
    /// STATUS `hrtfLoadFailure`'s core side: 0, or 2 (data).
    hrtf_failure: u16,
    /// ADR 0162 C6: arena bytes (block classes) held by zone kernels and zone IR PCM.
    zone_bytes: usize,
}

/// The channel counts a clip may have (ADR 0162, api-and-models §5.2): 1, 2, or 4, 9 and 16 for an
/// ambisonic clip of order 1-3. The main-side registry refuses the others first ("multichannel
/// mixes aren't supported"); the core refuses them too, with `ERR_BAD_ARG`.
pub fn is_clip_channel_count(channels: u32) -> bool {
    matches!(channels, 1 | 2 | 4 | 9 | 16)
}

/// The reserved clip ids `format = 2` data must use (api-and-models §4.1).
pub fn is_hrir_id(id: u32) -> bool {
    (wire::HRIR_CLIP_ID_FIRST..=wire::HRIR_CLIP_ID_LAST).contains(&id)
}

/// The reserved clip ids zone kernels (formats 3 and 5) must use (ADR 0162 C6).
pub fn is_zone_kernel_id(id: u32) -> bool {
    (wire::ZONE_KERNEL_ID_FIRST..=wire::ZONE_KERNEL_ID_LAST).contains(&id)
}

/// Whether `format` is a zone kernel's (3 or 5).
fn is_zone(format: ClipFormat) -> bool {
    matches!(format, ClipFormat::ZoneKernel | ClipFormat::ZoneIrPcm)
}

impl Default for ClipStore {
    fn default() -> ClipStore {
        ClipStore::new()
    }
}

impl ClipStore {
    /// A store with no directory: it refuses every reserve (refusedCeiling). Doesn't allocate.
    /// `Core` builds its store with [`ClipStore::over`].
    pub const fn new() -> ClipStore {
        ClipStore {
            entries: &mut [],
            len: 0,
            arena: Arena::empty(),
            events: [Event { id: 0, code: 0 }; EVENT_QUEUE],
            events_head: 0,
            events_len: 0,
            hrir_id: 0,
            hrtf_block: Block { addr: 0, class: 0 },
            hrtf_ready: false,
            hrtf_failure: 0,
            zone_bytes: 0,
        }
    }

    /// A store over the `ClipDirectory` region (zeroed, 64-byte aligned) and the `Arena` region.
    /// The directory holds `directory.len() / CLIP_DIRECTORY_ENTRY_BYTES` clips (4,096); the
    /// region's size-class list heads aren't used (the arena keeps its heads itself).
    pub fn over(directory: &'static mut [u8], arena: &'static mut [u8]) -> ClipStore {
        let count = directory.len() / CLIP_DIRECTORY_ENTRY_BYTES;
        debug_assert_eq!(directory.as_ptr() as usize % core::mem::align_of::<Entry>(), 0);
        // SAFETY: the region is ours alone, aligned (Layout), zeroed, and holds `count` entries
        // of at most CLIP_DIRECTORY_ENTRY_BYTES each; all-zero bytes are a valid Entry.
        let entries = unsafe { core::slice::from_raw_parts_mut(directory.as_mut_ptr() as *mut Entry, count) };
        ClipStore { entries, arena: Arena::over(arena), ..ClipStore::new() }
    }

    /// The arena under the store.
    pub fn arena(&self) -> &Arena {
        &self.arena
    }

    /// Installs the arena's growth function (tests).
    pub fn set_grow(&mut self, grow: GrowFn) {
        self.arena.set_grow(grow);
    }

    /// Sets a core-side class-byte ceiling (tests; see the module comment).
    pub fn set_ceiling(&mut self, bytes: usize) {
        self.arena.set_ceiling(bytes);
    }

    /// Clips the directory can hold.
    pub fn capacity(&self) -> usize {
        self.entries.len()
    }

    /// Reserves zeroed space for a clip of `frames` frames (`myco_audio_clip_reserve`).
    /// Refuses (`ERR_BAD_ARG`) an id that's already held, `channels` other than 1, 2, 4, 9 or 16
    /// ([`is_clip_channel_count`]), zero
    /// frames, or a rate that isn't positive and finite. A full directory or the arena's ceiling
    /// gives `ERR_CEILING`, a failed growth `ERR_ARENA_FULL`; each queues its clip event.
    /// HRIR data (`ClipFormat::Hrir`) needs a reserved id, one channel and no other HRIR table
    /// held, and takes the HRTF bank's block too (see the module comment); `sample_rate` is the
    /// context rate the bank is built for. `onmessage` only; may grow memory.
    pub fn reserve(&mut self, id: u32, frames: u32, channels: u32, sample_rate: f32, format: ClipFormat) -> Result<(), i32> {
        if !is_clip_channel_count(channels) || frames == 0 || !(sample_rate > 0.0 && sample_rate.is_finite()) {
            return Err(wire::ERR_BAD_ARG);
        }
        let hrir = format == ClipFormat::Hrir;
        if hrir && (!is_hrir_id(id) || channels != 1 || self.hrir_id != 0) {
            return Err(wire::ERR_BAD_ARG);
        }
        let zone_channels = if format == ClipFormat::ZoneKernel { 1 } else { 2 };
        if is_zone(format) && (!is_zone_kernel_id(id) || channels != zone_channels) {
            return Err(wire::ERR_BAD_ARG);
        }
        if format == ClipFormat::MagLs && (id != wire::MAGLS_CLIP_ID || channels != 1) {
            return Err(wire::ERR_BAD_ARG);
        }
        let bank_bytes = if hrir {
            match HrtfBank::bytes_for(sample_rate) {
                Some(b) => b,
                None => {
                    // HRTF can't run at this rate (176.4 kHz and up): the table is no use.
                    self.hrtf_failure = wire::hrtf_load_failure::DATA as u16;
                    return Err(wire::ERR_BAD_ARG);
                }
            }
        } else {
            0
        };
        let at = match self.find(id) {
            Ok(_) => return Err(wire::ERR_BAD_ARG),
            Err(at) => at,
        };
        let bytes = (frames as usize).checked_mul(channels as usize * format.sample_bytes());
        let block = match bytes {
            _ if self.len == self.entries.len() => Err(Refusal::Ceiling),
            None => Err(Refusal::Ceiling),
            Some(bytes) => self.arena.alloc(bytes),
        };
        let block = match block {
            Ok(block) => block,
            Err(refusal) => {
                self.queue_event(id, refusal.clip_event());
                return Err(refusal.code());
            }
        };
        if hrir {
            match self.arena.alloc(bank_bytes) {
                Ok(bank) => {
                    self.hrir_id = id;
                    self.hrtf_block = bank;
                    self.hrtf_ready = false;
                }
                Err(refusal) => {
                    self.arena.free(block);
                    self.queue_event(id, refusal.clip_event());
                    return Err(refusal.code());
                }
            }
        }
        if is_zone(format) {
            self.zone_bytes += block.len();
        }
        let bytes = bytes.unwrap_or(0);
        // SAFETY: the block is ours and at least `bytes` long (its class holds the request).
        unsafe { core::ptr::write_bytes(block.addr as *mut u8, 0, bytes) };
        self.entries.copy_within(at..self.len, at + 1);
        self.entries[at] = Entry {
            id,
            frames,
            sample_rate,
            committed: 0,
            addr: block.addr,
            channels: channels as u8,
            format: format.to_wire(),
            class: block.class,
            resident: 0,
        };
        self.len += 1;
        Ok(())
    }

    /// Checks a range of `bytes` at frame `frame_offset`: whole frames, non-empty, inside the clip.
    /// Gives the entry's index and the range in frames.
    fn range(&self, id: u32, frame_offset: u32, bytes: usize) -> Result<(usize, usize), i32> {
        let at = self.find(id).map_err(|_| wire::ERR_UNKNOWN_CLIP)?;
        let e = &self.entries[at];
        let fb = e.frame_bytes();
        if bytes % fb != 0 {
            return Err(wire::ERR_BAD_ARG);
        }
        let n = bytes / fb;
        if (frame_offset as usize).checked_add(n).is_none_or(|end| end > e.frames as usize) {
            return Err(wire::ERR_BAD_ARG);
        }
        Ok((at, n))
    }

    /// Copies little-endian samples in the clip's format into the clip, starting at frame
    /// `frame_offset` (`myco_audio_clip_write`, tests only), in any order, and commits the range
    /// when it continues the committed frames. `bytes` must be
    /// whole frames and fit inside the clip. `ERR_UNKNOWN_CLIP` for an id not reserved,
    /// `ERR_BAD_ARG` for a range that doesn't fit.
    pub fn write(&mut self, id: u32, frame_offset: u32, bytes: &[u8]) -> Result<(), i32> {
        let (at, n) = self.range(id, frame_offset, bytes.len())?;
        let e = self.entries[at];
        // SAFETY: the range is inside the clip's block (checked); the source is a distinct slice.
        // Wasm and every native test host are little-endian, so the bytes are the samples.
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), (e.addr + frame_offset as usize * e.frame_bytes()) as *mut u8, bytes.len()) };
        if frame_offset <= e.committed {
            self.commit_frames(at, frame_offset, n)?;
        }
        Ok(())
    }

    /// Where the shell copies a chunk of `bytes` for frame `frame_offset` on
    /// (`myco_audio_clip_chunk_ptr`): whole frames, at most [`MAX_CHUNK_BYTES`], inside the clip.
    /// The shell passes `frames * channels * bytesPerSample`, never the padded body size.
    pub fn chunk_ptr(&mut self, id: u32, frame_offset: u32, bytes: u32) -> Result<*mut u8, i32> {
        let bytes = bytes as usize;
        if bytes == 0 || bytes > MAX_CHUNK_BYTES {
            return Err(wire::ERR_BAD_ARG);
        }
        let (at, _) = self.range(id, frame_offset, bytes)?;
        let e = &self.entries[at];
        Ok((e.addr + frame_offset as usize * e.frame_bytes()) as *mut u8)
    }

    /// Marks a range written (`myco_audio_clip_commit`); the same checks as `chunk_ptr`. Ranges
    /// arrive in order: one that ends at or before the committed frames is a repeat (ok), one that
    /// starts past them leaves a gap (`ERR_BAD_ARG`). The range that completes the clip queues the
    /// `resident` event, once.
    pub fn commit(&mut self, id: u32, frame_offset: u32, bytes: u32) -> Result<(), i32> {
        let bytes = bytes as usize;
        if bytes == 0 || bytes > MAX_CHUNK_BYTES {
            return Err(wire::ERR_BAD_ARG);
        }
        let (at, n) = self.range(id, frame_offset, bytes)?;
        self.commit_frames(at, frame_offset, n)
    }

    fn commit_frames(&mut self, at: usize, frame_offset: u32, n: usize) -> Result<(), i32> {
        let e = &mut self.entries[at];
        let end = frame_offset + n as u32;
        if frame_offset > e.committed {
            return Err(wire::ERR_BAD_ARG);
        }
        e.committed = e.committed.max(end);
        if e.committed == e.frames && e.resident == 0 {
            e.resident = 1;
            let id = e.id;
            if e.format() == ClipFormat::Hrir {
                self.finish_hrir(at);
            } else if e.format() == ClipFormat::ZoneIrPcm {
                // Task C3b prepares the kernel and reports `resident` then.
            } else if e.format() == ClipFormat::MagLs {
                // ADR 0162 A4: the core-level `commit` transforms it and queues the event.
            } else {
                self.queue_event(id, wire::clip_event::RESIDENT);
            }
        }
        Ok(())
    }

    /// The HRIR table at entry `at` is complete: parse it, build the bank in its block, queue
    /// `hrtfReady`; invalid data sets `hrtfLoadFailure` 2 instead. `onmessage` only (it builds 32
    /// panners); never allocates.
    fn finish_hrir(&mut self, at: usize) {
        let e = self.entries[at];
        if e.id != self.hrir_id {
            return;
        }
        // SAFETY: the block holds `frames * 2` bytes of the clip (int16 words), all committed.
        let bytes = unsafe { core::slice::from_raw_parts(e.addr as *const u8, e.frames as usize * 2) };
        let valid = HrirDatabase::parse(bytes).is_ok_and(|db| (db.header().rate - e.sample_rate).abs() <= 0.5);
        // SAFETY: `reserve` took the bank's block for `HrtfBank::bytes_for(e.sample_rate)` bytes;
        // blocks are at least 4 KB aligned; nothing else uses it.
        if valid && unsafe { HrtfBank::init(self.hrtf_block.addr, e.sample_rate) } {
            self.hrtf_ready = true;
            self.hrtf_failure = wire::hrtf_load_failure::NONE as u16;
            self.queue_event(e.id, wire::clip_event::HRTF_READY);
        } else {
            self.hrtf_failure = wire::hrtf_load_failure::DATA as u16;
        }
    }

    /// The HRTF bank's address and the HRIR table's bytes, once the table is parsed and the bank
    /// built (H3). Never allocates (`process` calls it).
    pub fn hrtf_bank(&self) -> Option<(usize, &[u8])> {
        if !self.hrtf_ready {
            return None;
        }
        let e = &self.entries[self.find(self.hrir_id).ok()?];
        // SAFETY: the HRIR entry's block holds `frames * 2` committed bytes; only `onmessage`
        // writes or frees it, never while `process` reads.
        Some((self.hrtf_block.addr, unsafe { core::slice::from_raw_parts(e.addr as *const u8, e.frames as usize * 2) }))
    }

    /// STATUS `hrtfLoadFailure`'s core side (0 none, 2 data).
    pub fn hrtf_failure(&self) -> u16 {
        self.hrtf_failure
    }

    /// Drops the HRTF bank (the HRIR table is going).
    fn drop_hrtf(&mut self) {
        if self.hrir_id != 0 {
            self.arena.free(self.hrtf_block);
        }
        self.hrir_id = 0;
        self.hrtf_ready = false;
        self.hrtf_block = Block { addr: 0, class: 0 };
    }

    /// ADR 0162 A4: the MagLS blob's bytes, once every frame of it is committed.
    pub fn magls_bytes(&self) -> Option<&[u8]> {
        let e = &self.entries[self.find(wire::MAGLS_CLIP_ID).ok()?];
        // SAFETY: the entry's block holds `frames * 4` bytes, all committed; only `onmessage`
        // writes or frees it.
        (e.format() == ClipFormat::MagLs && e.resident != 0).then(|| unsafe { core::slice::from_raw_parts(e.addr as *const u8, e.frames as usize * 4) })
    }

    /// Whether every frame of the clip was committed.
    pub fn is_resident(&self, id: u32) -> bool {
        self.find(id).is_ok_and(|at| self.entries[at].resident != 0)
    }

    /// The clip's frames, or `None` when `id` isn't held. Never allocates (`process` calls it).
    pub fn frames(&self, id: u32) -> Option<Clip<'_>> {
        let e = &self.entries[self.find(id).ok()?];
        let len = e.frames as usize * e.channels as usize;
        // SAFETY: the block holds `len` samples of the clip's format, aligned (blocks are at least
        // 1024-byte aligned); only `onmessage` writes it, never while `process` reads.
        let samples = unsafe {
            match e.format() {
                ClipFormat::F32 => Samples::F32(core::slice::from_raw_parts(e.addr as *const f32, len)),
                ClipFormat::I16 => Samples::I16(core::slice::from_raw_parts(e.addr as *const i16, len)),
                // The HRTF table, zone kernels and the MagLS filters aren't a voice's source.
                ClipFormat::Hrir | ClipFormat::ZoneKernel | ClipFormat::ZoneIrPcm | ClipFormat::MagLs => return None,
            }
        };
        Some(Clip { source: Source { samples, channels: e.channels as u32, frames: e.frames }, sample_rate: e.sample_rate })
    }

    /// Drops the clip (`myco_audio_clip_free`); its block goes back to the arena. `ERR_UNKNOWN_CLIP`
    /// when `id` isn't held. Voices still on it end at their next quantum (main frees a clip only
    /// when no voice uses it).
    pub fn free(&mut self, id: u32) -> Result<(), i32> {
        let at = self.find(id).map_err(|_| wire::ERR_UNKNOWN_CLIP)?;
        let block = self.entries[at].block();
        if id == self.hrir_id {
            self.drop_hrtf();
        }
        if is_zone(self.entries[at].format()) {
            self.zone_bytes -= block.len();
        }
        self.entries.copy_within(at + 1..self.len, at);
        self.len -= 1;
        self.arena.free(block);
        Ok(())
    }

    /// Drops every clip and reclaims the whole arena (RESET with `keepClips = 0`). Queued clip
    /// events go too: main re-sends its clips after a reset.
    pub fn clear(&mut self) {
        self.len = 0;
        self.hrir_id = 0;
        self.hrtf_ready = false;
        self.hrtf_block = Block { addr: 0, class: 0 };
        self.zone_bytes = 0;
        self.arena.reset();
        self.events_len = 0;
        self.events_head = 0;
    }

    /// A resident prepared zone kernel's bytes (format 3, ADR 0162 C6), for `Kernel::parse`; `None`
    /// when `id` isn't held, isn't a format 3 clip or isn't fully committed. Never allocates
    /// (`process` calls it).
    pub fn zone_kernel(&self, id: u32) -> Option<&[u8]> {
        let e = &self.entries[self.find(id).ok()?];
        if e.format() != ClipFormat::ZoneKernel || e.resident == 0 {
            return None;
        }
        // SAFETY: the block holds `frames * 4` committed bytes (f32 words); only `onmessage`
        // writes or frees it, never while `process` reads.
        Some(unsafe { core::slice::from_raw_parts(e.addr as *const u8, e.frames as usize * 4) })
    }

    /// Arena bytes (block classes) held by zone kernels and zone IR PCM (formats 3 and 5).
    pub fn zone_bytes(&self) -> usize {
        self.zone_bytes
    }

    /// Clips held.
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The oldest queued clip event.
    pub fn peek_event(&self) -> Option<Event> {
        (self.events_len > 0).then(|| self.events[self.events_head])
    }

    /// Drops the oldest queued clip event.
    pub fn pop_event(&mut self) {
        if self.events_len > 0 {
            self.events_head = (self.events_head + 1) % EVENT_QUEUE;
            self.events_len -= 1;
        }
    }

    /// Queued clip events.
    pub fn events_len(&self) -> usize {
        self.events_len
    }

    pub(crate) fn queue_event(&mut self, id: u32, code: u32) {
        if self.events_len == EVENT_QUEUE {
            // Full: drop the oldest. Main still learns of a refusal from the call's result.
            self.pop_event();
        }
        self.events[(self.events_head + self.events_len) % EVENT_QUEUE] = Event { id, code };
        self.events_len += 1;
    }

    fn find(&self, id: u32) -> Result<usize, usize> {
        self.entries[..self.len].binary_search_by_key(&id, |e| e.id)
    }
}

// --- Core-level entry points (the `clip_*` exports) -------------------------------------------

/// Moves queued clip events into the STATUS block's `clipEvents` until it's full (the rest wait
/// for the next block), and updates `arenaUsedKB` and `arenaLargestFreeKB`. Never allocates;
/// `myco_audio_process` calls it after each quantum.
pub fn flush_events(core: &mut Core) {
    while let Some(e) = core.clips().peek_event() {
        if !status::counters_mut(core).clip_events.push(e) {
            break;
        }
        core.clips_mut().pop_event();
    }
    let (used, largest) = (core.clips().arena().used_bytes(), core.clips().arena().largest_free_bytes());
    let failure = core.clips().hrtf_failure();
    let c = status::counters_mut(core);
    c.arena_used_kb = (used / 1024) as u32;
    c.arena_largest_free_kb = (largest / 1024) as u32;
    c.hrtf_load_failure = failure;
}

/// Sets STATUS `arenaFull` after a refusal and clears it after a reserve that succeeded, a free or
/// a reset, then flushes.
fn report(core: &mut Core, full: Option<bool>) {
    if let Some(full) = full {
        status::counters_mut(core).set_flag(flag::ARENA_FULL, full);
    }
    flush_events(core);
}

/// `myco_audio_clip_reserve`. `format` is the wire's (0 f32, 1 int16, 2 HRIR data; anything else
/// `ERR_BAD_ARG`). HRIR data at a rate other than the core's is refused and reported as
/// `hrtfLoadFailure` 2 (main resamples the table for the context, H2).
pub fn reserve(core: &mut Core, id: u32, frames: u32, channels: u32, sample_rate: f32, format: u32) -> i32 {
    let Some(format) = ClipFormat::from_wire(format) else { return wire::ERR_BAD_ARG };
    if is_zone(format) {
        // ADR 0162 C6: zone kernels have their own budget; their rate is the context's.
        let zone_channels = if format == ClipFormat::ZoneKernel { 1 } else { 2 };
        if !is_zone_kernel_id(id) || channels != zone_channels || frames == 0 || (sample_rate - core.params().sample_rate).abs() > 0.5 {
            return wire::ERR_BAD_ARG;
        }
        let p = core.params();
        let budget = crate::zones::kernel_budget_bytes(p.max_zone_slots, p.zone_max_frames);
        let bytes = (frames as usize).saturating_mul(channels as usize * 4);
        let class = crate::arena::size_class::class_of(bytes).map(crate::arena::size_class::class_bytes);
        if class.is_none_or(|c| core.clips().zone_bytes() + c > budget) {
            core.clips_mut().queue_event(id, wire::clip_event::REFUSED_CEILING);
            report(core, None);
            return wire::ERR_CEILING;
        }
    }
    if format == ClipFormat::Hrir && (sample_rate - core.params().sample_rate).abs() > 0.5 {
        core.clips_mut().hrtf_failure = wire::hrtf_load_failure::DATA as u16;
        report(core, None);
        return wire::ERR_BAD_ARG;
    }
    if format == ClipFormat::MagLs && (!crate::bed::has_region(core) || (sample_rate - core.params().sample_rate).abs() > 0.5) {
        // ADR 0162 A4: no beds to decode (main sends the filters on first bed use), or not at the
        // context rate (main resamples them).
        core.clips_mut().queue_event(id, wire::clip_event::REFUSED_FORMAT);
        report(core, None);
        return wire::ERR_BAD_ARG;
    }
    let result = core.clips_mut().reserve(id, frames, channels, sample_rate, format);
    let full = match result {
        Ok(()) => Some(false),
        Err(e) if e == wire::ERR_CEILING || e == wire::ERR_ARENA_FULL => Some(true),
        Err(_) => None,
    };
    report(core, full);
    result.err().unwrap_or(wire::ERR_OK)
}

/// `myco_audio_clip_chunk_ptr`: null when the range is refused.
pub fn chunk_ptr(core: &mut Core, id: u32, frame_offset: u32, bytes: u32) -> *mut u8 {
    core.clips_mut().chunk_ptr(id, frame_offset, bytes).unwrap_or(core::ptr::null_mut())
}

/// `myco_audio_clip_commit`.
pub fn commit(core: &mut Core, id: u32, frame_offset: u32, bytes: u32) -> i32 {
    let was = core.clips().is_resident(id);
    let result = core.clips_mut().commit(id, frame_offset, bytes);
    if result.is_ok() && core.clips().zone_kernel(id).is_some() {
        crate::zones::kernel_resident(core, id);
    }
    if id == wire::MAGLS_CLIP_ID && !was && core.clips().is_resident(id) {
        finish_magls(core);
    }
    report(core, None);
    result.err().unwrap_or(wire::ERR_OK)
}

/// `myco_audio_clip_write` (tests): [`ClipStore::write`], then, as [`commit`], the zone slots
/// waiting for a zone kernel it completes start. Events flush with the next quantum, as before.
pub fn write(core: &mut Core, id: u32, frame_offset: u32, bytes: &[u8]) -> i32 {
    let result = core.clips_mut().write(id, frame_offset, bytes);
    if result.is_ok() && core.clips().zone_kernel(id).is_some() {
        crate::zones::kernel_resident(core, id);
    }
    result.err().unwrap_or(wire::ERR_OK)
}

/// ADR 0162 A4: the MagLS blob is complete: transform it (`bed::load_filters`, `bedDecoderReady`)
/// and queue `resident`, or `refusedFormat` for a bad blob (beds keep decoding through the matrix).
pub fn finish_magls(core: &mut Core) {
    let Some(bytes) = core.clips().magls_bytes() else { return };
    // SAFETY: the clip's block lives until `onmessage` frees it; `load_filters` only reads it and
    // writes the `Beds` region and the counters, never the clip store.
    let bytes: &[u8] = unsafe { core::slice::from_raw_parts(bytes.as_ptr(), bytes.len()) };
    let ok = crate::bed::load_filters(core, bytes);
    let code = if ok { wire::clip_event::RESIDENT } else { wire::clip_event::REFUSED_FORMAT };
    core.clips_mut().queue_event(wire::MAGLS_CLIP_ID, code);
}

/// `myco_audio_clip_free`.
pub fn free(core: &mut Core, id: u32) -> i32 {
    let result = core.clips_mut().free(id);
    if id == wire::MAGLS_CLIP_ID && result.is_ok() {
        crate::bed::clear_filters(core);
    }
    report(core, result.is_ok().then_some(false));
    result.err().unwrap_or(wire::ERR_OK)
}

/// RESET with `keepClips = 0`: every clip dropped, the arena reclaimed.
pub fn reset(core: &mut Core) {
    core.clips_mut().clear();
    crate::bed::clear_filters(core);
    report(core, Some(false));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arena::size_class::class_bytes;
    use crate::layout::{Layout, PAGE_BYTES};
    use crate::InitParams;

    fn f32_bytes(v: &[f32]) -> Vec<u8> {
        v.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// A leaked, zeroed, page-aligned buffer.
    fn leak(bytes: usize) -> &'static mut [u8] {
        let l = std::alloc::Layout::from_size_align(bytes.max(1), PAGE_BYTES).unwrap();
        // SAFETY: non-zero size; leaked on purpose.
        unsafe { core::slice::from_raw_parts_mut(std::alloc::alloc_zeroed(l), bytes) }
    }

    /// A store with a 16-entry directory and a 64 KB arena that can't grow.
    fn store() -> ClipStore {
        let mut s = ClipStore::over(leak(16 * CLIP_DIRECTORY_ENTRY_BYTES), leak(PAGE_BYTES));
        s.set_grow(|_| None);
        s
    }

    fn core_with_arena(arena_bytes: u32) -> Core {
        let p = InitParams { sample_rate: 48_000.0, max_logical: 16, max_mixed: 8, max_buses: 4, arena_initial_bytes: arena_bytes, ..InitParams::default() };
        let layout = Layout::new(&p);
        let base = leak(layout.total()).as_mut_ptr();
        // SAFETY: a fresh, zeroed, page-aligned, leaked block of `layout.total()` bytes.
        unsafe { Core::new(p, layout, base) }
    }

    fn events(core: &Core) -> Vec<(u32, u32)> {
        status::counters(core).clip_events.as_slice().iter().map(|e| (e.id, e.code)).collect()
    }

    #[test]
    fn reserve_write_read_free() {
        let mut s = store();
        s.reserve(7, 4, 2, 44_100.0, ClipFormat::F32).unwrap();
        s.write(7, 1, &f32_bytes(&[0.5, -0.5, 0.25, -0.25])).unwrap();
        let clip = s.frames(7).unwrap();
        assert_eq!(clip.sample_rate, 44_100.0);
        assert_eq!((clip.source.channels, clip.source.frames), (2, 4));
        match clip.source.samples {
            Samples::F32(v) => assert_eq!(v, &[0.0, 0.0, 0.5, -0.5, 0.25, -0.25, 0.0, 0.0]),
            Samples::I16(_) => panic!("f32 clip"),
        }
        s.free(7).unwrap();
        assert!(s.frames(7).is_none());
        assert_eq!(s.free(7), Err(wire::ERR_UNKNOWN_CLIP));
    }

    #[test]
    fn int16_clips_keep_their_samples() {
        let mut s = store();
        s.reserve(1, 2, 1, 48_000.0, ClipFormat::I16).unwrap();
        s.write(1, 0, &[0x00, 0x40, 0x00, 0xC0]).unwrap();
        match s.frames(1).unwrap().source.samples {
            Samples::I16(v) => assert_eq!(v, &[16_384, -16_384]),
            Samples::F32(_) => panic!("int16 clip"),
        }
    }

    #[test]
    fn bad_reserves_and_writes_are_refused() {
        let mut s = store();
        for channels in [0, 3, 5, 6, 8, 10, 15, 17, 32] {
            assert_eq!(s.reserve(1, 4, channels, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG), "{channels} channels");
        }
        assert_eq!(s.reserve(1, 0, 1, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG));
        assert_eq!(s.reserve(1, 4, 1, f32::NAN, ClipFormat::F32), Err(wire::ERR_BAD_ARG));
        s.reserve(1, 4, 1, 48_000.0, ClipFormat::F32).unwrap();
        assert_eq!(s.reserve(1, 4, 1, 48_000.0, ClipFormat::F32), Err(wire::ERR_BAD_ARG), "already held");
        assert_eq!(s.write(1, 3, &f32_bytes(&[1.0, 1.0])), Err(wire::ERR_BAD_ARG), "past the end");
        assert_eq!(s.write(1, 0, &[0, 0, 0]), Err(wire::ERR_BAD_ARG), "not whole frames");
        assert_eq!(s.write(2, 0, &f32_bytes(&[1.0])), Err(wire::ERR_UNKNOWN_CLIP));
    }

    #[test]
    fn ambisonic_channel_counts_are_held() {
        let mut s = store();
        for (id, channels) in [(1, 4u32), (2, 9), (3, 16)] {
            s.reserve(id, 8, channels, 48_000.0, ClipFormat::I16).unwrap();
            let bytes: Vec<u8> = (0..8 * channels as i16).flat_map(|v| v.to_le_bytes()).collect();
            s.write(id, 0, &bytes).unwrap();
            assert!(s.is_resident(id));
            let clip = s.frames(id).unwrap();
            assert_eq!((clip.source.channels, clip.source.frames), (channels, 8));
            match clip.source.samples {
                Samples::I16(v) => assert_eq!(v.len(), 8 * channels as usize),
                Samples::F32(_) => panic!("int16 clip"),
            }
        }
        assert_eq!(s.write(3, 0, &[0u8; 30]), Err(wire::ERR_BAD_ARG), "not a whole 16-channel frame");
    }

    #[test]
    fn ids_stay_sorted() {
        let mut s = store();
        for id in [9, 3, 6, 1] {
            s.reserve(id, 1, 1, 48_000.0, ClipFormat::F32).unwrap();
        }
        for id in [1, 3, 6, 9] {
            assert!(s.frames(id).is_some());
        }
        assert_eq!(s.len(), 4);
        s.free(3).unwrap();
        assert!(s.frames(3).is_none());
        for id in [1, 6, 9] {
            assert!(s.frames(id).is_some());
        }
    }

    #[test]
    fn a_reused_block_is_zeroed() {
        let mut s = store();
        s.reserve(1, 1024, 1, 48_000.0, ClipFormat::F32).unwrap();
        s.reserve(2, 1, 1, 48_000.0, ClipFormat::F32).unwrap(); // keeps the arena from resetting
        s.write(1, 0, &f32_bytes(&[1.0; 1024])).unwrap();
        s.free(1).unwrap();
        s.reserve(3, 1024, 1, 48_000.0, ClipFormat::F32).unwrap();
        match s.frames(3).unwrap().source.samples {
            Samples::F32(v) => assert!(v.iter().all(|x| *x == 0.0)),
            Samples::I16(_) => panic!("f32 clip"),
        }
    }

    #[test]
    fn chunks_land_in_place_and_the_last_one_is_resident() {
        let mut s = store();
        s.reserve(5, 4, 2, 48_000.0, ClipFormat::I16).unwrap();
        for (k, chunk) in [[1i16, 2, 3, 4], [5, 6, 7, 8]].iter().enumerate() {
            let at = k as u32 * 2;
            let p = s.chunk_ptr(5, at, 8).unwrap();
            // SAFETY: 8 bytes at the pointer chunk_ptr returned.
            unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr() as *const u8, p, 8) };
            assert!(!s.is_resident(5));
            s.commit(5, at, 8).unwrap();
        }
        assert!(s.is_resident(5));
        assert_eq!(s.peek_event(), Some(Event { id: 5, code: wire::clip_event::RESIDENT }));
        s.pop_event();
        s.commit(5, 2, 8).unwrap();
        assert_eq!(s.peek_event(), None, "resident is queued once");
        match s.frames(5).unwrap().source.samples {
            Samples::I16(v) => assert_eq!(v, &[1, 2, 3, 4, 5, 6, 7, 8]),
            Samples::F32(_) => panic!("int16 clip"),
        }
    }

    #[test]
    fn an_odd_sample_int16_chunk_takes_only_its_samples() {
        // A1.3a pads an int16 CLIP_CHUNK with an odd sample count to 4 bytes; the shell passes
        // `frames * channels * 2`, so the padding never reaches the arena.
        let mut s = store();
        s.reserve(9, 3, 1, 48_000.0, ClipFormat::I16).unwrap();
        s.reserve(10, 1, 1, 48_000.0, ClipFormat::I16).unwrap(); // the next clip's block
        let p = s.chunk_ptr(9, 0, 6).unwrap();
        // SAFETY: 6 bytes at the pointer chunk_ptr returned.
        unsafe { core::ptr::copy_nonoverlapping([7i16, 8, 9].as_ptr() as *const u8, p, 6) };
        s.commit(9, 0, 6).unwrap();
        assert!(s.is_resident(9));
        match s.frames(9).unwrap().source.samples {
            Samples::I16(v) => assert_eq!(v, &[7, 8, 9]),
            Samples::F32(_) => panic!("int16 clip"),
        }
        assert_eq!(s.chunk_ptr(9, 0, 8), Err(wire::ERR_BAD_ARG), "the padded size passes the clip's end");
        assert_eq!(s.commit(9, 0, 8), Err(wire::ERR_BAD_ARG));
        // Stereo int16 with an odd frame count: 3 frames x 2 x 2 = 12 bytes, padding 0.
        s.reserve(11, 3, 2, 48_000.0, ClipFormat::I16).unwrap();
        assert!(s.chunk_ptr(11, 0, 12).is_ok());
        assert_eq!(s.chunk_ptr(11, 0, 14), Err(wire::ERR_BAD_ARG), "not whole frames");
    }

    #[test]
    fn chunk_ranges_are_checked() {
        let mut s = store();
        s.reserve(1, 16 * 1024, 1, 48_000.0, ClipFormat::I16).unwrap();
        assert_eq!(s.chunk_ptr(1, 0, 0), Err(wire::ERR_BAD_ARG), "empty");
        assert_eq!(s.chunk_ptr(1, 0, MAX_CHUNK_BYTES as u32 + 2), Err(wire::ERR_BAD_ARG), "past 256 KB");
        assert_eq!(s.chunk_ptr(2, 0, 2), Err(wire::ERR_UNKNOWN_CLIP));
        assert_eq!(s.commit(1, 10, 2), Err(wire::ERR_BAD_ARG), "a gap");
    }

    #[test]
    fn a_full_directory_refuses_with_refused_ceiling() {
        let mut s = ClipStore::over(leak(2 * CLIP_DIRECTORY_ENTRY_BYTES), leak(PAGE_BYTES));
        s.reserve(1, 1, 1, 48_000.0, ClipFormat::F32).unwrap();
        s.reserve(2, 1, 1, 48_000.0, ClipFormat::F32).unwrap();
        assert_eq!(s.reserve(3, 1, 1, 48_000.0, ClipFormat::F32), Err(wire::ERR_CEILING));
        assert_eq!(s.peek_event(), Some(Event { id: 3, code: wire::clip_event::REFUSED_CEILING }));
    }

    #[test]
    fn a_resident_event_reaches_status() {
        let mut core = core_with_arena(0);
        assert_eq!(reserve(&mut core, 4, 2, 1, 48_000.0, wire::clip_format::F32), wire::ERR_OK);
        assert!(events(&core).is_empty());
        let p = chunk_ptr(&mut core, 4, 0, 8);
        assert!(!p.is_null());
        assert_eq!(commit(&mut core, 4, 0, 8), wire::ERR_OK);
        assert_eq!(events(&core), vec![(4, wire::clip_event::RESIDENT)]);
        assert_eq!(status::counters(&core).arena_used_kb, 4, "one 4 KB block");
    }

    #[test]
    fn a_refused_load_warns_through_status() {
        let mut core = core_with_arena(64 * 1024);
        core.clips_mut().set_grow(|_| None);
        assert_eq!(reserve(&mut core, 1, 16 * 1024, 1, 48_000.0, wire::clip_format::F32), wire::ERR_OK); // 64 KB: all of it
        assert_eq!(reserve(&mut core, 2, 1, 1, 48_000.0, wire::clip_format::F32), wire::ERR_ARENA_FULL);
        assert_eq!(events(&core), vec![(2, wire::clip_event::REFUSED_GROW)]);
        assert_ne!(status::counters(&core).flags & flag::ARENA_FULL, 0);
        core.clips_mut().set_ceiling(64 * 1024);
        assert_eq!(reserve(&mut core, 3, 1, 1, 48_000.0, wire::clip_format::F32), wire::ERR_CEILING);
        assert_eq!(events(&core)[1], (3, wire::clip_event::REFUSED_CEILING));
        assert_eq!(free(&mut core, 1), wire::ERR_OK);
        assert_eq!(status::counters(&core).flags & flag::ARENA_FULL, 0, "cleared by a free");
        assert_eq!(reserve(&mut core, 5, 1, 1, 48_000.0, 7), wire::ERR_BAD_ARG, "unknown format");
    }

    #[test]
    fn events_past_a_full_block_wait_for_the_next() {
        let mut core = core_with_arena(0);
        core.clips_mut().set_ceiling(0);
        for id in 0..70 {
            reserve(&mut core, id, 1, 1, 48_000.0, wire::clip_format::F32);
        }
        assert_eq!(events(&core).len(), 64);
        assert_eq!(core.clips().events_len(), 6);
        status::counters_mut(&mut core).end_block();
        flush_events(&mut core);
        assert_eq!(events(&core).len(), 6);
        assert_eq!(events(&core)[0].0, 64);
    }

    #[test]
    fn reset_reclaims_every_clip() {
        let mut core = core_with_arena(1 << 20);
        for id in 1..=5 {
            assert_eq!(reserve(&mut core, id, 10_000, 2, 48_000.0, wire::clip_format::I16), wire::ERR_OK);
        }
        assert_eq!(core.clips().len(), 5);
        assert!(core.clips().arena().used_bytes() >= 5 * 40_000);
        reset(&mut core);
        assert_eq!(core.clips().len(), 0);
        assert_eq!(core.clips().arena().used_bytes(), 0);
        assert_eq!(core.clips().arena().largest_free_bytes(), 1 << 20);
        assert_eq!(status::counters(&core).arena_used_kb, 0);
        assert!(core.clips().frames(1).is_none());
        assert_eq!(class_bytes(0), 4096);
    }
}
