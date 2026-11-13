//! The STATUS writer (api-and-models §4.3, kind 9; architecture §4.5).
//!
//! The core's counters ([`Counters`], contract K12) live at the start of the core-state region, in
//! a [`StatusArea`] with the writer's own state. `myco_audio_init` zeroes the region, and all-zero
//! is a valid area, so nothing is constructed or allocated. Later tasks reach the counters with
//! [`counters_mut`] and never edit this file.
//!
//! [`take`] serialises **every** field, envelope included, into the 20 KB staging buffer that
//! `myco_audio_status_ptr` points at, then ends the block (sections drained, per-block fields
//! reset). The shell copies the bytes into one of its 8 pooled buffers and writes the fields only
//! it knows (`dateMs`, the ping echo, the underrun probe's counts, traps) before posting.
//!
//! The byte offsets below are the wire's (§4.3). `audio-wire`'s generated `StatusBlock::read`
//! checks them in `audio-wasm/tests/status_wire.rs`, and `readStatus` does in `coreDriver.test.ts`,
//! so a drift between this writer and the schema fails a test.
//!
//! **M5 (0171/0172, K1).** The 256-B header's fields 176..251 come from `Counters::mix` (the shell
//! overwrites `busyMsTotal`, `quantaTotal`, `clockStepMs`, `clockSteps` in its posted copy), and
//! the `loudBuses`, `loudEnergies` and `busDuck` sections from `loudness::status` and
//! `duck::status`, asked for a take's [`MixSections`] just before the block is written;
//! `loudness::taken` follows a successful take (the ring's sent cursor advances only then).

use crate::counters::{flag, Counters, MixSections, MusicRing, MUSIC_RINGS_CAP};
use crate::core::Core;
use crate::layout::{CORE_STATE_BYTES, REGION_ALIGN};
use crate::QUANTUM;

/// The wire's magic, version and kind for STATUS (api-and-models §4.1).
pub const MAGIC: u32 = 0x4D59_4131;
pub const VERSION: u16 = 0x0101;
pub const KIND_STATUS: u16 = 9;
/// The header, envelope included (§4.3; 144 B since ADR 0162 §4.3, 176 B with the M4 fields of API §4.4,
/// 256 B with the M5 fields of 0171's API §4.3, which read 0 until K1 and the tasks after it fill them).
pub const HEADER_BYTES: usize = 256;
/// The staging buffer, and each pooled buffer in the shell (§4.7: 16 KB; 20 KB since 0171 M5).
pub const BUFFER_BYTES: usize = 20 * 1024;

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
    // ADR 0162 §4.3.
    pub const BED_VOICES: usize = 112;
    pub const BEDS_ACTIVE: usize = 114;
    pub const FX_VOICES: usize = 116;
    pub const AMBISONIC_VOICES: usize = 118;
    pub const ZONES_ACTIVE: usize = 120;
    pub const ZONES_RINGING: usize = 122;
    pub const ZONE_EVENT_COUNT: usize = 124;
    pub const BEDS_REFUSED: usize = 126;
    pub const ZONE_SLOTS: usize = 128;
    pub const M3_SHED: usize = 130;
    pub const ZONE_USED_KB: usize = 132;
    pub const WORK_BED: usize = 136;
    pub const WORK_ZONES: usize = 140;
    // 0166 M4, api-and-models §4.4 (Q1: from `Counters::music`).
    pub const MUSIC_RING_COUNT: usize = 144;
    pub const GROUP_START_COUNT: usize = 146;
    pub const MUSIC_RINGS_OPEN: usize = 148;
    pub const STREAM_STARTS_LATE: usize = 150;
    pub const GROUPS_LATE: usize = 152;
    pub const GROUPS_HELD: usize = 154;
    pub const GROUPS_ABANDONED: usize = 156;
    pub const CURVE_POOL_FULL: usize = 158;
    pub const MAX_SLIP_FRAMES: usize = 160;
    pub const SPLIT_QUANTA: usize = 164;
    pub const VOICE_SPLITS: usize = 168;
    pub const M4_RESERVED: usize = 172;
    // 0171/0172 M5, API §4.3 (K1: from `Counters::mix` and the `MixSections` of the take).
    pub const BUSY_MS_TOTAL: usize = 176;
    pub const QUANTA_TOTAL: usize = 184;
    pub const WU_VOICES: usize = 192;
    pub const WU_BUSES: usize = 200;
    pub const WU_SPATIAL: usize = 208;
    pub const WU_MUSIC: usize = 216;
    pub const WU_LOUDNESS: usize = 224;
    pub const LOUD_BUS_COUNT: usize = 232;
    pub const LOUD_ENERGY_COUNT: usize = 234;
    pub const DUCK_COUNT: usize = 236;
    pub const CLOCK_STEP_MS: usize = 238;
    pub const LOUD_SUB_BLOCK_FRAMES: usize = 240;
    pub const CLOCK_STEPS: usize = 244;
    pub const LOUD_SHED: usize = 246;
    pub const BUS_RECORDS_EARLY: usize = 248;
    pub const SIDECHAIN_LATE: usize = 250;
    pub const M5_RESERVED: usize = 252;
}

const _: () = assert!(off::M5_RESERVED + 4 == HEADER_BYTES && HEADER_BYTES == audio_wire::generated::STATUS_HEADER_BYTES as usize);
const _: () = assert!(BUFFER_BYTES == audio_wire::generated::STATUS_BUFFER_BYTES as usize);

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

/// Bytes of the core-state region the status area takes, rounded to a region alignment.
/// **`core_state[..STATUS_AREA_BYTES]` belongs to this module**: a later task that carves the
/// core-state region (`layout.rs`, `CoreState`) starts at this offset, never before it.
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
    // OD3 (D5): the ladder's steps, bed-idle plus the zone steps, into `m3Shed`.
    let shed = (crate::bed::m3_shed(core) + crate::zones::shed_steps(core)).min(u16::MAX as u32) as u16;
    // 0166 M4 §4.4 (C1): the music pool's level, refilled before every take: every open music ring
    // (`musicRings`, a lost report repairs itself), `musicRingsOpen`, and the refusals so far.
    let mut rings = [MusicRing::default(); MUSIC_RINGS_CAP];
    let mut open = 0;
    for (id, flags) in core.streams().music_rings().take(MUSIC_RINGS_CAP) {
        rings[open] = MusicRing { stream_id: id, epoch_flags: flags };
        open += 1;
    }
    let refused = core.streams().music_refused();
    let area = area_mut(core);
    let m = &mut area.counters.music;
    m.music_rings.clear();
    for r in &rings[..open] {
        m.music_rings.push(*r);
    }
    m.music_rings_open = open as u16;
    m.music_ring_refused = refused;
    area.counters.spatial.m3_shed = shed;
    area.counters.set_flag(flag::READY, true);
    area.counters.abi_version = if area.writer.blocks == 0 { abi_version } else { 0 };
    // 0171/0172 M5 (K1): the loudness and duck sections, from their modules' own state (Ld2, Dp1).
    let mut mix = MixSections::default();
    crate::loudness::status(core, &mut mix);
    crate::duck::status(core, &mut mix);
    let area = area_mut(core);
    let n = write_with(&area.counters, &mix, area.writer.seq, out);
    if n == 0 {
        return 0;
    }
    // The sub-blocks this take carried are sent: the loudness ring's cursor advances (Ld2).
    crate::loudness::taken(core, &mix);
    let area = area_mut(core);
    area.writer.seq = area.writer.seq.wrapping_add(1);
    area.writer.blocks = area.writer.blocks.saturating_add(1);
    area.counters.end_block();
    n
}

/// The message size `counters` needs with no M5 section items: the header plus every section.
pub fn message_bytes(c: &Counters) -> usize {
    message_bytes_with(c, &MixSections::default())
}

/// The message size `counters` and the M5 sections `mix` need.
pub fn message_bytes_with(c: &Counters, mix: &MixSections) -> usize {
    HEADER_BYTES
        + 16 * mix.loud_buses.len()
        + 4 * mix.loud_energies.len()
        + 8 * mix.bus_duck.len()
        + 4 * (c.ended.len() + c.demoted.len() + c.starved.len())
        + 8 * (c.playheads.len() + c.clip_events.len() + c.stream_events.len() + c.sent_peaks().len())
        + 8 * c.spatial.sent_beds().len()
        + 12 * c.spatial.sent_zones().len()
        + 4 * c.spatial.zone_events.len()
        + 8 * c.music.music_rings.len()
        + 16 * c.music.group_starts.len()
}

/// Serialises `c` as one STATUS message with envelope `seq` and empty M5 sections. Pure: doesn't
/// change `c`. Returns the bytes written, or 0 when `out` is too short.
pub fn write(c: &Counters, seq: u32, out: &mut [u8]) -> usize {
    write_with(c, &MixSections::default(), seq, out)
}

/// Serialises `c` and the M5 sections `mix` as one STATUS message with envelope `seq`. Pure.
/// Returns the bytes written, or 0 when `out` is too short.
pub fn write_with(c: &Counters, mix: &MixSections, seq: u32, out: &mut [u8]) -> usize {
    let total = message_bytes_with(c, mix);
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
    // ADR 0162 §4.3.
    let s = &c.spatial;
    put_u16(out, off::BED_VOICES, s.bed_voices);
    put_u16(out, off::BEDS_ACTIVE, s.sent_beds().len() as u16);
    put_u16(out, off::FX_VOICES, s.fx_voices);
    put_u16(out, off::AMBISONIC_VOICES, s.ambisonic_voices);
    put_u16(out, off::ZONES_ACTIVE, s.zones_active);
    put_u16(out, off::ZONES_RINGING, s.zones_ringing);
    put_u16(out, off::ZONE_EVENT_COUNT, s.zone_events.len() as u16);
    put_u16(out, off::BEDS_REFUSED, s.beds_refused);
    put_u16(out, off::ZONE_SLOTS, s.sent_zones().len() as u16);
    put_u16(out, off::M3_SHED, s.m3_shed);
    put_u32(out, off::ZONE_USED_KB, s.zone_used_kb);
    put_u32(out, off::WORK_BED, s.work_bed);
    put_u32(out, off::WORK_ZONES, s.work_zones);
    // 0166 M4 §4.4 (Q1). C1 writes `musicRings`, C2b `groupStarts`.
    let m = &c.music;
    put_u16(out, off::MUSIC_RING_COUNT, m.music_rings.len() as u16);
    put_u16(out, off::GROUP_START_COUNT, m.group_starts.len() as u16);
    put_u16(out, off::MUSIC_RINGS_OPEN, m.music_rings_open);
    put_u16(out, off::STREAM_STARTS_LATE, m.stream_starts_late);
    put_u16(out, off::GROUPS_LATE, m.groups_late);
    put_u16(out, off::GROUPS_HELD, m.groups_held);
    put_u16(out, off::GROUPS_ABANDONED, m.groups_abandoned);
    put_u16(out, off::CURVE_POOL_FULL, m.curve_pool_full);
    put_u32(out, off::MAX_SLIP_FRAMES, m.max_slip_frames);
    put_u32(out, off::SPLIT_QUANTA, m.split_quanta);
    put_u32(out, off::VOICE_SPLITS, m.voice_splits);
    put_u32(out, off::M4_RESERVED, 0);
    // 0171/0172 M5, API §4.3 (K1). The shell writes `busyMsTotal`, `quantaTotal`, `clockStepMs` and
    // `clockSteps` into its posted copy; the core's counters for them stay 0.
    let x = &c.mix;
    put_f64(out, off::BUSY_MS_TOTAL, x.busy_ms_total);
    put_f64(out, off::QUANTA_TOTAL, x.quanta_total);
    put_f64(out, off::WU_VOICES, x.wu_voices);
    put_f64(out, off::WU_BUSES, x.wu_buses);
    put_f64(out, off::WU_SPATIAL, x.wu_spatial);
    put_f64(out, off::WU_MUSIC, x.wu_music);
    put_f64(out, off::WU_LOUDNESS, x.wu_loudness);
    put_u16(out, off::LOUD_BUS_COUNT, mix.loud_buses.len() as u16);
    put_u16(out, off::LOUD_ENERGY_COUNT, mix.loud_energies.len() as u16);
    put_u16(out, off::DUCK_COUNT, mix.bus_duck.len() as u16);
    put_u16(out, off::CLOCK_STEP_MS, x.clock_step_ms);
    put_u32(out, off::LOUD_SUB_BLOCK_FRAMES, x.loud_sub_block_frames);
    put_u16(out, off::CLOCK_STEPS, x.clock_steps);
    put_u16(out, off::LOUD_SHED, x.loud_shed);
    put_u16(out, off::BUS_RECORDS_EARLY, x.bus_records_early);
    put_u16(out, off::SIDECHAIN_LATE, x.sidechain_late);
    put_u32(out, off::M5_RESERVED, 0);
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
    for b in s.sent_beds() {
        put_u16(out, cur, b.bus);
        put_u16(out, cur + 2, b.voices);
        put_u32(out, cur + 4, b.work);
        cur += 8;
    }
    for z in s.sent_zones() {
        put_u32(out, cur, z.kernel_id);
        out[cur + 4] = z.state;
        out[cur + 5] = 0;
        put_u16(out, cur + 6, z.quanta_since_input);
        put_f32(out, cur + 8, z.wet_peak);
        cur += 12;
    }
    for e in s.zone_events.as_slice() {
        out[cur] = e.slot;
        out[cur + 1] = e.code;
        put_u16(out, cur + 2, 0);
        cur += 4;
    }
    // 0166 M4 §4.4 (C1): `musicRings {u32 streamId; u32 epochFlags}`, after `zoneEvents`.
    for r in m.music_rings.as_slice() {
        put_u32(out, cur, r.stream_id);
        put_u32(out, cur + 4, r.epoch_flags);
        cur += 8;
    }
    // 0166 M4 §4.4 (C2b): `groupStarts {u16 groupId; u16 flags; u32 slipFrames; u32 startFrameLo;
    // u32 startFrameHi}`, after `musicRings`.
    for g in m.group_starts.as_slice() {
        put_u16(out, cur, g.group_id);
        put_u16(out, cur + 2, g.flags);
        put_u32(out, cur + 4, g.slip_frames);
        put_u32(out, cur + 8, g.start_frame as u32);
        put_u32(out, cur + 12, (g.start_frame >> 32) as u32);
        cur += 16;
    }
    // 0171/0172 M5 §4.3: `loudBuses {u16 slot; u16 flags; u32 firstSeq; f32 truePeak; u32
    // gatedQuanta}`, `loudEnergies {f32}`, `busDuck {u16 slot; u16 pad; f32 gain}`, after
    // `groupStarts`.
    for b in mix.loud_buses.as_slice() {
        put_u16(out, cur, b.slot);
        put_u16(out, cur + 2, b.flags);
        put_u32(out, cur + 4, b.first_seq);
        put_f32(out, cur + 8, b.true_peak);
        put_u32(out, cur + 12, b.gated_quanta);
        cur += 16;
    }
    for e in mix.loud_energies.as_slice() {
        put_f32(out, cur, *e);
        cur += 4;
    }
    for d in mix.bus_duck.as_slice() {
        put_u16(out, cur, d.slot);
        put_u16(out, cur + 2, 0);
        put_f32(out, cur + 4, d.gain);
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
    use super::*;
    use crate::counters::{BusDuckGain, LoudBus, BUS_DUCK_CAP, LOUD_BUSES_CAP, LOUD_ENERGIES_CAP};
    use crate::counters::{Event, GroupStart, Peak, Playhead, ZoneEvent, BEDS_CAP, GROUP_STARTS_CAP, CLIP_EVENTS_CAP, ENDED_CAP, PEAKS_CAP, PLAYHEADS_CAP, ZONES_CAP, ZONE_EVENTS_CAP};
    use crate::layout::{Layout, PAGE_BYTES};
    use crate::params::InitParams;

    fn core() -> Core {
        let params = InitParams { sample_rate: 48_000.0, max_logical: 256, max_mixed: 32, max_buses: 8, arena_initial_bytes: 1 << 20, ..InitParams::default() };
        let layout = Layout::new(&params);
        let alloc = std::alloc::Layout::from_size_align(layout.total(), PAGE_BYTES).unwrap();
        // SAFETY: non-zero size; zeroed; leaked on purpose ('static).
        let base = unsafe { std::alloc::alloc_zeroed(alloc) };
        // SAFETY: as Core::new requires.
        unsafe { Core::new(params, layout, base) }
    }

    fn u16_at(b: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(b[at..at + 2].try_into().unwrap())
    }
    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }
    fn i32_at(b: &[u8], at: usize) -> i32 {
        i32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }
    fn f32_at(b: &[u8], at: usize) -> f32 {
        f32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }
    fn f64_at(b: &[u8], at: usize) -> f64 {
        f64::from_le_bytes(b[at..at + 8].try_into().unwrap())
    }

    #[test]
    fn an_empty_block_is_the_bare_header_with_ready_and_abi() {
        let mut core = core();
        let mut out = [0u8; BUFFER_BYTES];
        assert_eq!(take(&mut core, &mut out, 0x100), HEADER_BYTES);
        assert_eq!(u32_at(&out, off::MAGIC), MAGIC);
        assert_eq!(u16_at(&out, off::VERSION), 0x0101);
        assert_eq!(u16_at(&out, off::KIND), KIND_STATUS);
        assert_eq!(u32_at(&out, off::SEQ), 0);
        assert_eq!(u32_at(&out, off::BODY_BYTES), (HEADER_BYTES - 16) as u32);
        assert_eq!(u32_at(&out, off::FLAGS), flag::READY);
        assert_eq!(u32_at(&out, off::ABI_VERSION), 0x100);
    }

    #[test]
    fn abi_version_goes_in_the_first_block_only() {
        let mut core = core();
        let mut out = [0u8; BUFFER_BYTES];
        take(&mut core, &mut out, 0x100);
        take(&mut core, &mut out, 0x100);
        assert_eq!(u32_at(&out, off::ABI_VERSION), 0);
        assert_eq!(u32_at(&out, off::SEQ), 1);
        assert_eq!(u32_at(&out, off::FLAGS) & flag::READY, flag::READY);
    }

    #[test]
    fn every_field_lands_at_its_offset() {
        let mut c = Counters::default();
        c.current_frame = 1_234_567.0;
        c.date_ms = 9.5;
        c.ping_seq = 3;
        c.ping_frame_lo = 4;
        c.underruns = 5;
        c.late_commands = 6;
        c.work_units = 7;
        c.work_units_max = 8;
        c.mixed_voices = 9;
        c.live_voices = 10;
        c.flags = flag::ARENA_FULL;
        c.mixed_cap = 11;
        c.load_permille = 12;
        c.traps = 13;
        c.note_slack(-14);
        c.underrun_frames = 15;
        c.arena_used_kb = 16;
        c.arena_largest_free_kb = 17;
        c.abi_version = 18;
        c.max_lateness_frames = 19;
        c.hrtf_voices = 20;
        c.hrtf_load_failure = 2;
        let mut out = [0u8; BUFFER_BYTES];
        assert_eq!(write(&c, 77, &mut out), HEADER_BYTES);
        assert_eq!(u32_at(&out, off::SEQ), 77);
        assert_eq!(f64_at(&out, off::CURRENT_FRAME), 1_234_567.0);
        assert_eq!(f64_at(&out, off::DATE_MS), 9.5);
        assert_eq!(u32_at(&out, off::PING_SEQ), 3);
        assert_eq!(u32_at(&out, off::PING_FRAME_LO), 4);
        assert_eq!(u32_at(&out, off::UNDERRUNS), 5);
        assert_eq!(u32_at(&out, off::LATE_COMMANDS), 6);
        assert_eq!(u32_at(&out, off::WORK_UNITS), 7);
        assert_eq!(u32_at(&out, off::WORK_UNITS_MAX), 8);
        assert_eq!(u16_at(&out, off::MIXED_VOICES), 9);
        assert_eq!(u16_at(&out, off::LIVE_VOICES), 10);
        assert_eq!(u32_at(&out, off::FLAGS), flag::ARENA_FULL);
        assert_eq!(u16_at(&out, off::MIXED_CAP), 11);
        assert_eq!(u16_at(&out, off::LOAD_PERMILLE), 12);
        assert_eq!(u16_at(&out, off::TRAPS), 13);
        assert_eq!(i32_at(&out, off::MIN_SLACK_FRAMES), -14);
        assert_eq!(u32_at(&out, off::UNDERRUN_FRAMES), 15);
        assert_eq!(u32_at(&out, off::ARENA_USED_KB), 16);
        assert_eq!(u32_at(&out, off::ARENA_LARGEST_FREE_KB), 17);
        assert_eq!(u32_at(&out, off::ABI_VERSION), 18);
        assert_eq!(u32_at(&out, off::MAX_LATENESS_FRAMES), 19);
        assert_eq!(u16_at(&out, off::HRTF_VOICES), 20);
        assert_eq!(u16_at(&out, off::HRTF_LOAD_FAILURE), 2);
    }

    #[test]
    fn the_m4_header_fields_come_from_the_music_counters() {
        let mut c = Counters::default();
        let m = &mut c.music;
        m.music_rings_open = 3;
        m.stream_starts_late = 4;
        m.groups_late = 5;
        m.groups_held = 6;
        m.groups_abandoned = 7;
        m.curve_pool_full = 8;
        m.max_slip_frames = 0x0001_0009;
        m.split_quanta = 0x0002_000A;
        m.voice_splits = 0x0003_000B;
        m.parked_overflow = 99; // core only: not in STATUS
        let mut out = [0xAAu8; BUFFER_BYTES];
        assert_eq!(write(&c, 1, &mut out), HEADER_BYTES);
        let (s, read) = audio_wire::generated::StatusBlock::read(&out, 0).expect("the generated reader accepts the header");
        assert_eq!(read, HEADER_BYTES);
        assert_eq!((s.music_rings.len(), s.group_starts.len(), s.music_rings_open, s.stream_starts_late), (0, 0, 3, 4));
        assert_eq!((s.groups_late, s.groups_held, s.groups_abandoned, s.curve_pool_full), (5, 6, 7, 8));
        assert_eq!((s.max_slip_frames, s.split_quanta, s.voice_splits, s.reserved), (0x0001_0009, 0x0002_000A, 0x0003_000B, 0));
        assert_eq!(u32_at(&out, off::VOICE_SPLITS), 0x0003_000B);
    }

    #[test]
    fn group_starts_follow_the_music_rings_and_read_back() {
        let mut c = Counters::default();
        c.music.music_rings.push(MusicRing { stream_id: 9, epoch_flags: 3 });
        c.music.group_starts.push(GroupStart { group_id: 1023, flags: 1, slip_frames: 384, start_frame: 0x0000_0002_0000_0080 });
        c.music.group_starts.push(GroupStart { group_id: 4, flags: 4, slip_frames: 0, start_frame: 48_000 });
        let mut out = [0u8; BUFFER_BYTES];
        let n = write(&c, 0, &mut out);
        assert_eq!(n, HEADER_BYTES + 8 + 2 * 16);
        assert_eq!(u16_at(&out, off::GROUP_START_COUNT), 2);
        let (s, _) = audio_wire::generated::StatusBlock::read(&out, 0).expect("the generated reader accepts it");
        assert_eq!(s.music_rings.len(), 1);
        let g = &s.group_starts;
        assert_eq!((g.len(), g[0].group_id, g[0].flags, g[0].slip_frames, g[0].start_frame_lo, g[0].start_frame_hi), (2, 1023, 1, 384, 0x80, 2));
        assert_eq!((g[1].group_id, g[1].flags, g[1].start_frame_lo, g[1].start_frame_hi), (4, 4, 48_000, 0));
    }

    #[test]
    fn sections_follow_the_header_in_order_and_are_drained() {
        let mut core = core();
        {
            let c = counters_mut(&mut core);
            c.ended.push(1);
            c.ended.push(2);
            c.demoted.push(3);
            c.starved.push(4);
            c.playheads.push(Playhead { id: 5, clip_frame: 6 });
            c.clip_events.push(Event { id: 7, code: 1 });
            c.stream_events.push(Event { id: 8, code: 2 });
            c.set_bus_count(2);
            c.set_peak(0, 0.25, 0.5);
            c.set_peak(1, 0.75, 1.0);
        }
        let mut out = [0u8; BUFFER_BYTES];
        let n = take(&mut core, &mut out, 0x100);
        assert_eq!(n, HEADER_BYTES + 4 * 4 + 8 * 3 + 8 * 2);
        assert_eq!(u16_at(&out, off::ENDED_COUNT), 2);
        assert_eq!(u16_at(&out, off::DEMOTED_COUNT), 1);
        assert_eq!(u16_at(&out, off::STARVED_COUNT), 1);
        assert_eq!(u16_at(&out, off::PLAYHEAD_COUNT), 1);
        assert_eq!(u16_at(&out, off::BUS_COUNT), 2);
        assert_eq!(u16_at(&out, off::CLIP_EVENT_COUNT), 1);
        assert_eq!(u16_at(&out, off::STREAM_EVENT_COUNT), 1);
        let words: Vec<u32> = (0..10).map(|i| u32_at(&out, HEADER_BYTES + 4 * i)).collect();
        assert_eq!(words, [1, 2, 3, 4, 5, 6, 7, 1, 8, 2]);
        let p = HEADER_BYTES + 40;
        assert_eq!([f32_at(&out, p), f32_at(&out, p + 4), f32_at(&out, p + 8), f32_at(&out, p + 12)], [0.25, 0.5, 0.75, 1.0]);
        // Drained: the next block has no list entries but keeps the peaks.
        assert_eq!(take(&mut core, &mut out, 0x100), HEADER_BYTES + 16);
        assert_eq!(u16_at(&out, off::ENDED_COUNT), 0);
    }

    #[test]
    fn a_short_buffer_writes_nothing_and_keeps_the_block() {
        let mut core = core();
        counters_mut(&mut core).ended.push(42);
        let mut short = [0u8; HEADER_BYTES];
        assert_eq!(take(&mut core, &mut short, 0x100), 0);
        let mut out = [0u8; BUFFER_BYTES];
        assert_eq!(take(&mut core, &mut out, 0x100), HEADER_BYTES + 4);
        assert_eq!(u32_at(&out, off::SEQ), 0, "the refused take used no seq");
        assert_eq!(u32_at(&out, off::ABI_VERSION), 0x100, "still the first block");
        assert_eq!(u32_at(&out, HEADER_BYTES), 42);
    }

    #[test]
    fn the_worst_case_fits_the_buffer() {
        let mut c = Counters::default();
        for i in 0..ENDED_CAP as u32 {
            assert!(c.ended.push(i) && c.demoted.push(i) && c.starved.push(i));
        }
        for i in 0..PLAYHEADS_CAP as u32 {
            c.playheads.push(Playhead { id: i, clip_frame: i });
        }
        for i in 0..CLIP_EVENTS_CAP as u32 {
            c.clip_events.push(Event { id: i, code: 1 });
            c.stream_events.push(Event { id: i, code: 1 });
        }
        c.set_bus_count(PEAKS_CAP);
        for b in 0..PEAKS_CAP {
            c.set_peak(b, 1.0, 1.0);
        }
        assert_eq!(c.peaks[PEAKS_CAP - 1], Peak { l: 1.0, r: 1.0 });
        // ADR 0162 §4.3: the M3 sections at their caps too.
        c.spatial.beds_active = BEDS_CAP as u16;
        c.spatial.zone_slots = ZONES_CAP as u16;
        for i in 0..ZONE_EVENTS_CAP {
            assert!(c.spatial.zone_events.push(ZoneEvent { slot: i as u8, code: 1 }));
        }
        // 0166 M4 §4.4: 16 music rings (C1) and 8 group starts (C2b).
        for i in 0..MUSIC_RINGS_CAP as u32 {
            assert!(c.music.music_rings.push(MusicRing { stream_id: i, epoch_flags: i }));
        }
        for i in 0..GROUP_STARTS_CAP as u16 {
            assert!(c.music.group_starts.push(GroupStart { group_id: i + 1, flags: 1, slip_frames: 7, start_frame: 1 << 33 }));
        }
        assert_eq!(message_bytes(&c), 16_192 - 176 + HEADER_BYTES, "M4's sections under the M5 header");
        // 0171/0172 M5 §4.3: the three new sections at their caps.
        let mut mix = MixSections::default();
        for i in 0..LOUD_BUSES_CAP as u16 {
            assert!(mix.loud_buses.push(LoudBus { slot: i, flags: 32, first_seq: 1_000 + i as u32, true_peak: 0.5, gated_quanta: 3 }));
        }
        for i in 0..LOUD_ENERGIES_CAP {
            assert!(mix.loud_energies.push(i as f32 * 1e-3));
        }
        for i in 0..BUS_DUCK_CAP as u16 {
            assert!(mix.bus_duck.push(BusDuckGain { slot: i, gain: 0.25 }));
        }
        let worst = audio_wire::generated::STATUS_WORST_CASE_BYTES as usize;
        assert_eq!(message_bytes_with(&c, &mix), 17_824, "API §4.3's worst case");
        assert_eq!(message_bytes_with(&c, &mix), worst, "the generated worst case");
        let mut out = [0u8; BUFFER_BYTES];
        assert_eq!(write_with(&c, &mix, 0, &mut out), worst);
        // The M5 sections follow `groupStarts`, in order.
        let at = worst - 8 * BUS_DUCK_CAP - 4 * LOUD_ENERGIES_CAP - 16 * LOUD_BUSES_CAP;
        assert_eq!((u16_at(&out, at), u16_at(&out, at + 2), u32_at(&out, at + 4), f32_at(&out, at + 8), u32_at(&out, at + 12)), (0, 32, 1_000, 0.5, 3));
        assert_eq!(f32_at(&out, at + 16 * LOUD_BUSES_CAP + 4), 1e-3);
        let d = worst - 8;
        assert_eq!((u16_at(&out, d), u16_at(&out, d + 2), f32_at(&out, d + 4)), (BUS_DUCK_CAP as u16 - 1, 0, 0.25));
        assert_eq!((u16_at(&out, off::LOUD_BUS_COUNT), u16_at(&out, off::LOUD_ENERGY_COUNT), u16_at(&out, off::DUCK_COUNT)), (9, 288, 32));
    }

    #[test]
    fn the_m5_header_fields_come_from_the_mix_counters_and_the_shell_fields_stay_for_the_shell() {
        let mut core = core();
        let x = &mut counters_mut(&mut core).mix;
        x.wu_voices = 1.5;
        x.wu_buses = 2.5;
        x.wu_spatial = 3.5;
        x.wu_music = 4.5;
        x.wu_loudness = (1u64 << 52) as f64;
        x.loud_sub_block_frames = 4_800;
        x.loud_shed = 1;
        x.bus_records_early = 7;
        x.sidechain_late = 9;
        let mut out = [0xAAu8; BUFFER_BYTES];
        assert_eq!(take(&mut core, &mut out, 0x400), HEADER_BYTES, "K1's stubs: the three M5 sections are empty");
        assert_eq!((f64_at(&out, off::BUSY_MS_TOTAL), f64_at(&out, off::QUANTA_TOTAL)), (0.0, 0.0), "shell fields: 0 from the core");
        assert_eq!((u16_at(&out, off::CLOCK_STEP_MS), u16_at(&out, off::CLOCK_STEPS)), (0, 0));
        let wu: Vec<f64> = [off::WU_VOICES, off::WU_BUSES, off::WU_SPATIAL, off::WU_MUSIC, off::WU_LOUDNESS].iter().map(|&o| f64_at(&out, o)).collect();
        assert_eq!(wu, vec![1.5, 2.5, 3.5, 4.5, (1u64 << 52) as f64]);
        assert_eq!((u16_at(&out, off::LOUD_BUS_COUNT), u16_at(&out, off::LOUD_ENERGY_COUNT), u16_at(&out, off::DUCK_COUNT)), (0, 0, 0));
        assert_eq!(u32_at(&out, off::LOUD_SUB_BLOCK_FRAMES), 4_800);
        assert_eq!((u16_at(&out, off::LOUD_SHED), u16_at(&out, off::BUS_RECORDS_EARLY), u16_at(&out, off::SIDECHAIN_LATE)), (1, 7, 9));
        assert_eq!(u32_at(&out, off::M5_RESERVED), 0);
        assert_eq!(u32_at(&out, off::BODY_BYTES), (HEADER_BYTES - 16) as u32);
        assert_eq!(u32_at(&out, off::M4_RESERVED), 0, "the M4 reserve still reads 0");
    }

    #[test]
    fn after_quantum_sets_current_frame_and_work_units() {
        let mut core = core();
        core.process(256);
        after_quantum(&mut core);
        let c = counters(&core);
        assert_eq!(c.current_frame, 384.0);
        // A3.3's model: the root bus and the limiter, no voices.
        assert_eq!(c.work_units, crate::cap::wu::BUS + crate::cap::wu::LIMITER);
        assert_eq!(c.work_units, core.work_units());
    }

    #[test]
    fn the_status_area_starts_the_core_state_region() {
        let core = core();
        assert!(core.regions().core_state.len() >= STATUS_AREA_BYTES);
        assert_eq!(area(&core) as *const StatusArea as usize, core.regions().core_state.as_ptr() as usize);
    }
}
