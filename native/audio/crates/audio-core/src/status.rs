//! The STATUS writer (api-and-models §4.3, kind 9; architecture §4.5).
//!
//! The core's counters ([`Counters`], contract K12) live at the start of the core-state region, in
//! a [`StatusArea`] with the writer's own state. `myco_audio_init` zeroes the region, and all-zero
//! is a valid area, so nothing is constructed or allocated. Later tasks reach the counters with
//! [`counters_mut`] and never edit this file.
//!
//! [`take`] serialises **every** field, envelope included, into the 16 KB staging buffer that
//! `myco_audio_status_ptr` points at, then ends the block (sections drained, per-block fields
//! reset). The shell copies the bytes into one of its 8 pooled buffers and writes the fields only
//! it knows (`dateMs`, the ping echo, the underrun probe's counts, traps) before posting.
//!
//! The byte offsets below are the wire's (§4.3). `audio-wire`'s generated `StatusBlock::read`
//! checks them in `audio-wasm/tests/status_wire.rs`, and `readStatus` does in `coreDriver.test.ts`,
//! so a drift between this writer and the schema fails a test.

use crate::counters::{flag, Counters};
use crate::core::Core;
use crate::layout::{CORE_STATE_BYTES, REGION_ALIGN};
use crate::QUANTUM;

/// The wire's magic, version and kind for STATUS (api-and-models §4.1).
pub const MAGIC: u32 = 0x4D59_4131;
pub const VERSION: u16 = 0x0100;
pub const KIND_STATUS: u16 = 9;
/// The header, envelope included (§4.3).
pub const HEADER_BYTES: usize = 112;
/// The staging buffer, and each pooled buffer in the shell (§4.7: 16 KB).
pub const BUFFER_BYTES: usize = 16 * 1024;

/// Byte offsets of the header fields from the message's first byte (§4.3).
pub mod off {
    pub const MAGIC: usize = 0;
    pub const VERSION: usize = 4;
    pub const KIND: usize = 6;
    pub const SEQ: usize = 8;
    pub const BODY_BYTES: usize = 12;
    pub const CURRENT_FRAME: usize = 16;
    pub const DATE_MS: usize = 24;
    pub const PING_SEQ: usize = 32;
    pub const PING_FRAME_LO: usize = 36;
    pub const UNDERRUNS: usize = 40;
    pub const LATE_COMMANDS: usize = 44;
    pub const WORK_UNITS: usize = 48;
    pub const WORK_UNITS_MAX: usize = 52;
    pub const MIXED_VOICES: usize = 56;
    pub const LIVE_VOICES: usize = 58;
    pub const FLAGS: usize = 60;
    pub const ENDED_COUNT: usize = 64;
    pub const DEMOTED_COUNT: usize = 66;
    pub const STARVED_COUNT: usize = 68;
    pub const PLAYHEAD_COUNT: usize = 70;
    pub const BUS_COUNT: usize = 72;
    pub const CLIP_EVENT_COUNT: usize = 74;
    pub const STREAM_EVENT_COUNT: usize = 76;
    pub const MIXED_CAP: usize = 78;
    pub const LOAD_PERMILLE: usize = 80;
    pub const TRAPS: usize = 82;
    pub const MIN_SLACK_FRAMES: usize = 84;
    pub const UNDERRUN_FRAMES: usize = 88;
    pub const ARENA_USED_KB: usize = 92;
    pub const ARENA_LARGEST_FREE_KB: usize = 96;
    pub const ABI_VERSION: usize = 100;
    pub const MAX_LATENESS_FRAMES: usize = 104;
    pub const HRTF_VOICES: usize = 108;
    pub const HRTF_LOAD_FAILURE: usize = 110;
}

/// The writer's own state, kept beside the counters.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct WriterState {
    /// The envelope `seq` of the next block (per sender, wraps).
    pub seq: u32,
    /// Blocks written since init (saturating); the first carries `abiVersion`.
    pub blocks: u32,
}

/// What the start of the core-state region holds. All-zero is valid.
#[repr(C)]
pub struct StatusArea {
    pub counters: Counters,
    pub writer: WriterState,
}

/// Bytes of the core-state region the status area takes, rounded to a region alignment. A later
/// task that carves the core-state region starts at this offset.
pub const STATUS_AREA_BYTES: usize = (core::mem::size_of::<StatusArea>() + REGION_ALIGN - 1) / REGION_ALIGN * REGION_ALIGN;

const _: () = assert!(STATUS_AREA_BYTES <= CORE_STATE_BYTES / 2, "the status area leaves half the core-state region");
const _: () = assert!(core::mem::align_of::<StatusArea>() <= REGION_ALIGN);

/// The status area at the start of `core`'s core-state region.
pub fn area(core: &Core) -> &StatusArea {
    let bytes: &[u8] = &core.regions().core_state[..];
    assert!(bytes.len() >= STATUS_AREA_BYTES);
    // SAFETY: the region is 64-byte aligned (Layout), at least STATUS_AREA_BYTES long (asserted),
    // zeroed at init, and all-zero bytes are a valid StatusArea (plain integers, floats, arrays).
    // Only this module views these bytes.
    unsafe { &*(bytes.as_ptr() as *const StatusArea) }
}

/// The status area, mutably.
pub fn area_mut(core: &mut Core) -> &mut StatusArea {
    let bytes: &mut [u8] = &mut core.regions_mut().core_state[..];
    assert!(bytes.len() >= STATUS_AREA_BYTES);
    // SAFETY: as in `area`; `core` is borrowed mutably, so this is the only view.
    unsafe { &mut *(bytes.as_mut_ptr() as *mut StatusArea) }
}

/// The counters (contract K12): later tasks report through these.
pub fn counters(core: &Core) -> &Counters {
    &area(core).counters
}

/// The counters, mutably (contract K12).
pub fn counters_mut(core: &mut Core) -> &mut Counters {
    &mut area_mut(core).counters
}

/// Called by `myco_audio_process` after each quantum: `currentFrame` becomes the frame after the
/// quantum just rendered (`frame + 128`) and the quantum's work units are noted.
pub fn after_quantum(core: &mut Core) {
    let frame_after = core.frame() + QUANTUM as u64;
    let units = core.work_units();
    let c = counters_mut(core);
    c.current_frame = frame_after as f64;
    c.note_work_units(units);
}

/// `myco_audio_status_take`: writes the whole STATUS message (envelope included) into `out` and
/// ends the block. Returns the bytes written, or 0 when `out` is shorter than the message (the
/// block is then kept for the next take). `abi_version` goes in the first block only.
pub fn take(core: &mut Core, out: &mut [u8], abi_version: u32) -> usize {
    let area = area_mut(core);
    area.counters.set_flag(flag::READY, true);
    area.counters.abi_version = if area.writer.blocks == 0 { abi_version } else { 0 };
    let n = write(&area.counters, area.writer.seq, out);
    if n == 0 {
        return 0;
    }
    area.writer.seq = area.writer.seq.wrapping_add(1);
    area.writer.blocks = area.writer.blocks.saturating_add(1);
    area.counters.end_block();
    n
}

/// The message size `counters` needs: the header plus every section.
pub fn message_bytes(c: &Counters) -> usize {
    HEADER_BYTES
        + 4 * (c.ended.len() + c.demoted.len() + c.starved.len())
        + 8 * (c.playheads.len() + c.clip_events.len() + c.stream_events.len() + c.sent_peaks().len())
}

/// Serialises `c` as one STATUS message with envelope `seq`. Pure: doesn't change `c`. Returns
/// the bytes written, or 0 when `out` is too short.
pub fn write(c: &Counters, seq: u32, out: &mut [u8]) -> usize {
    let total = message_bytes(c);
    if out.len() < total {
        return 0;
    }
    put_u32(out, off::MAGIC, MAGIC);
    put_u16(out, off::VERSION, VERSION);
    put_u16(out, off::KIND, KIND_STATUS);
    put_u32(out, off::SEQ, seq);
    put_u32(out, off::BODY_BYTES, (total - 16) as u32);
    put_f64(out, off::CURRENT_FRAME, c.current_frame);
    put_f64(out, off::DATE_MS, c.date_ms);
    put_u32(out, off::PING_SEQ, c.ping_seq);
    put_u32(out, off::PING_FRAME_LO, c.ping_frame_lo);
    put_u32(out, off::UNDERRUNS, c.underruns);
    put_u32(out, off::LATE_COMMANDS, c.late_commands);
    put_u32(out, off::WORK_UNITS, c.work_units);
    put_u32(out, off::WORK_UNITS_MAX, c.work_units_max);
    put_u16(out, off::MIXED_VOICES, c.mixed_voices);
    put_u16(out, off::LIVE_VOICES, c.live_voices);
    put_u32(out, off::FLAGS, c.flags);
    put_u16(out, off::ENDED_COUNT, c.ended.len() as u16);
    put_u16(out, off::DEMOTED_COUNT, c.demoted.len() as u16);
    put_u16(out, off::STARVED_COUNT, c.starved.len() as u16);
    put_u16(out, off::PLAYHEAD_COUNT, c.playheads.len() as u16);
    put_u16(out, off::BUS_COUNT, c.sent_peaks().len() as u16);
    put_u16(out, off::CLIP_EVENT_COUNT, c.clip_events.len() as u16);
    put_u16(out, off::STREAM_EVENT_COUNT, c.stream_events.len() as u16);
    put_u16(out, off::MIXED_CAP, c.mixed_cap);
    put_u16(out, off::LOAD_PERMILLE, c.load_permille);
    put_u16(out, off::TRAPS, c.traps);
    put_i32(out, off::MIN_SLACK_FRAMES, c.min_slack_frames());
    put_u32(out, off::UNDERRUN_FRAMES, c.underrun_frames);
    put_u32(out, off::ARENA_USED_KB, c.arena_used_kb);
    put_u32(out, off::ARENA_LARGEST_FREE_KB, c.arena_largest_free_kb);
    put_u32(out, off::ABI_VERSION, c.abi_version);
    put_u32(out, off::MAX_LATENESS_FRAMES, c.max_lateness_frames);
    put_u16(out, off::HRTF_VOICES, c.hrtf_voices);
    put_u16(out, off::HRTF_LOAD_FAILURE, c.hrtf_load_failure);
    // Sections, in §4.3's order.
    let mut cur = HEADER_BYTES;
    for list in [c.ended.as_slice(), c.demoted.as_slice(), c.starved.as_slice()] {
        for id in list {
            put_u32(out, cur, *id);
            cur += 4;
        }
    }
    for p in c.playheads.as_slice() {
        put_u32(out, cur, p.id);
        put_u32(out, cur + 4, p.clip_frame);
        cur += 8;
    }
    for list in [c.clip_events.as_slice(), c.stream_events.as_slice()] {
        for e in list {
            put_u32(out, cur, e.id);
            put_u32(out, cur + 4, e.code);
            cur += 8;
        }
    }
    for p in c.sent_peaks() {
        put_f32(out, cur, p.l);
        put_f32(out, cur + 4, p.r);
        cur += 8;
    }
    debug_assert_eq!(cur, total);
    total
}

fn put_u16(out: &mut [u8], at: usize, v: u16) {
    out[at..at + 2].copy_from_slice(&v.to_le_bytes());
}

fn put_u32(out: &mut [u8], at: usize, v: u32) {
    out[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn put_i32(out: &mut [u8], at: usize, v: i32) {
    out[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn put_f32(out: &mut [u8], at: usize, v: f32) {
    out[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn put_f64(out: &mut [u8], at: usize, v: f64) {
    out[at..at + 8].copy_from_slice(&v.to_le_bytes());
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn an_empty_block_is_the_bare_header_with_ready_and_abi() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn abi_version_goes_in_the_first_block_only() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn every_field_lands_at_its_offset() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn sections_follow_the_header_in_order_and_are_drained() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn a_short_buffer_writes_nothing_and_keeps_the_block() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn the_worst_case_fits_the_buffer() {}

    #[test]
    #[ignore = "A0.3 core: needs A0.3-L2's counters"]
    fn after_quantum_sets_current_frame_and_work_units() {}
}
