//! Contract K12: one counter for **every** STATUS field in the wire (K1, api-and-models §4.3).
//!
//! The status writer (`status.rs`) serialises all of these from day one, so a later task reports
//! through STATUS by setting its counter here (or pushing to its list) from its own module, and
//! never edits `status.rs`. Who sets each field is noted on it:
//! - **core**: set inside the core by the task named (0 until that task lands);
//! - **writer**: set by `status.rs` itself;
//! - **shell**: written by the worklet shell (`coreDriver.ts`) into the posted copy, because only
//!   the shell knows it (the wall clock, pings, the underrun probe, traps). The core leaves it 0.
//!
//! `Counters` lives in the first bytes of the core-state region (`status::StatusArea`), which
//! `myco_audio_init` zeroes, so **all-zero bytes must be a valid `Counters`**: plain integers,
//! floats and arrays only; no `bool`, enum, `Option` or pointer. Nothing here allocates.

/// Per-block caps of the STATUS sections (api-and-models §4.3; the wire's `MAX_*_PER_BLOCK`).
pub const ENDED_CAP: usize = 1_024;
pub const DEMOTED_CAP: usize = 1_024;
pub const STARVED_CAP: usize = 1_024;
pub const PLAYHEADS_CAP: usize = 256;
pub const CLIP_EVENTS_CAP: usize = 64;
pub const STREAM_EVENTS_CAP: usize = 64;
/// One peak per bus; the bus tree has at most 32 buses (`settings.ts` MAX_BUSES, the wire's cap).
pub const PEAKS_CAP: usize = 32;
/// ADR 0162 §4.3: the `beds`, `zones` and `zoneEvents` caps (the wire's `MAX_BEDS`,
/// `MAX_ZONE_SLOTS`, `MAX_ZONE_EVENTS_PER_BLOCK`).
pub const BEDS_CAP: usize = 4;
pub const ZONES_CAP: usize = 4;
pub const ZONE_EVENTS_CAP: usize = 16;

/// STATUS `flags` bits (api-and-models §4.3; the wire's `STATUS_FLAGS_*`).
pub mod flag {
    /// bit0: a message of another major version was refused (core: A1.2's submit).
    pub const VERSION_MISMATCH: u32 = 1 << 0;
    /// bit1: the arena is full (core: A1.3b).
    pub const ARENA_FULL: u32 = 1 << 1;
    /// bit2: the inbox couldn't take a message (core: A1.2's submit).
    pub const INBOX_OVERFLOW: u32 = 1 << 2;
    /// bit3: the adaptive cap is active (core: A3.3).
    pub const ADAPTIVE_CAP_ACTIVE: u32 = 1 << 3;
    /// bit4: init is done (writer: set on every block a core writes).
    pub const READY: u32 = 1 << 4;
    /// bit5: a trap was caught (shell).
    pub const TRAP_CAUGHT: u32 = 1 << 5;
    /// bit6: the MagLS filters are committed and transformed (core: A3/A4, ADR 0162).
    pub const BED_DECODER_READY: u32 = 1 << 6;
}

/// ADR 0162 §4.3: a `beds` entry, one per active bed slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BedStatus {
    /// The slot's host bus.
    pub bus: u16,
    /// Voices encoded into it.
    pub voices: u16,
    /// Work units, last quantum.
    pub work: u32,
}

/// ADR 0162 §4.3: a `zones` entry, one per zone slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ZoneStatus {
    pub kernel_id: u32,
    /// The wire's `ZoneState`: 0 off, 1 waiting for kernel, 2 fading in, 3 active, 4 ringing out,
    /// 5 evicting.
    pub state: u8,
    pub _pad: u8,
    /// Quanta since a send last fed the slot (saturating).
    pub quanta_since_input: u16,
    /// The slot's wet peak, last block.
    pub wet_peak: f32,
}

/// ADR 0162 §4.3: a `zoneEvents` entry.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ZoneEvent {
    pub slot: u8,
    /// The wire's `ZoneEvent`: 1 refused kernel, 2 refused slot, 3 bad blob.
    pub code: u8,
}

/// ADR 0162 §4.3 (K2): the M3 STATUS fields, header 112..143 and the `beds`, `zones` and
/// `zoneEvents` sections. The writer serialises every one; each stays 0 (and each section empty)
/// until the task named sets it from its own module.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SpatialCounters {
    /// `bedVoices`: voices encoded into a bed (core: A4).
    pub bed_voices: u16,
    /// `fxVoices`: pool entries with an active filter (core: D1).
    pub fx_voices: u16,
    /// `ambisonicVoices` (core: B3).
    pub ambisonic_voices: u16,
    /// `zonesActive` (core: C3).
    pub zones_active: u16,
    /// `zonesRinging` (core: C3).
    pub zones_ringing: u16,
    /// `bedsRefused`: buses whose bed host failed validation, cumulative, saturating (core: A4,
    /// through `note_beds_refused`).
    pub beds_refused: u16,
    /// `zoneUsedKB`: zone kernels resident (core: C3).
    pub zone_used_kb: u32,
    /// `workBed`: work units of the last quantum's bed encode, decode and ambisonic voices (core: A4, B3).
    pub work_bed: u32,
    /// `workZones`: work units of the last quantum's zone convolvers, sends and aux (core: C3, C4).
    pub work_zones: u32,
    /// `beds` section: `beds[..beds_active]` (core: A4). Instant: not cleared per block.
    pub beds_active: u16,
    /// `zones` section: `zones[..zone_slots]` (core: C3; `max_zone_slots` once C3 runs). Instant.
    pub zone_slots: u16,
    pub beds: [BedStatus; BEDS_CAP],
    pub zones: [ZoneStatus; ZONES_CAP],
    /// `zoneEvents` section (core: C3), with `zoneEventCount`; cleared per block.
    pub zone_events: List<ZoneEvent, ZONE_EVENTS_CAP>,
}

impl SpatialCounters {
    /// The beds that are sent: `beds[..beds_active]` (clamped to the cap).
    pub fn sent_beds(&self) -> &[BedStatus] {
        &self.beds[..(self.beds_active as usize).min(BEDS_CAP)]
    }

    /// The zones that are sent: `zones[..zone_slots]` (clamped to the cap).
    pub fn sent_zones(&self) -> &[ZoneStatus] {
        &self.zones[..(self.zone_slots as usize).min(ZONES_CAP)]
    }

    /// Adds `n` to `bedsRefused`, saturating.
    pub fn note_beds_refused(&mut self, n: u16) {
        self.beds_refused = self.beds_refused.saturating_add(n);
    }
}

/// A `playheads` entry: a voice and its frame in its clip.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Playhead {
    pub id: u32,
    pub clip_frame: u32,
}

/// A `clipEvents` or `streamEvents` entry: a clip or stream id and its event code.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Event {
    pub id: u32,
    pub code: u32,
}

/// A `peaks` entry: one bus's peak level, left and right.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Peak {
    pub l: f32,
    pub r: f32,
}

/// A fixed-capacity list of `N` items. Valid when zeroed (empty). Never allocates.
///
/// Its capacity is the section's per-block cap, so the writer drains it whole each block. A
/// producer whose `push` returns `false` keeps the item and pushes it again after the next block
/// (api-and-models §4.3: "the core keeps its queues, the next block carries them").
#[repr(C)]
#[derive(Clone, Copy)]
pub struct List<T: Copy, const N: usize> {
    len: u32,
    items: [T; N],
}

impl<T: Copy, const N: usize> List<T, N> {
    /// The list's capacity, `N`.
    pub const CAPACITY: usize = N;

    /// Appends `item`; `false` (and no change) when the list holds `N` items already.
    pub fn push(&mut self, item: T) -> bool {
        if self.is_full() {
            return false;
        }
        self.items[self.len as usize] = item;
        self.len += 1;
        true
    }

    /// The items pushed since the last `clear`, oldest first.
    pub fn as_slice(&self) -> &[T] {
        &self.items[..self.len as usize]
    }

    pub fn len(&self) -> usize {
        self.len as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn is_full(&self) -> bool {
        self.len as usize >= N
    }

    /// Empties the list (the items' bytes may stay; only `len` matters).
    pub fn clear(&mut self) {
        self.len = 0;
    }
}

/// Every STATUS field (K1), in the order of api-and-models §4.3.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Counters {
    /// `currentFrame`: the context frame after the last rendered quantum (writer, from `process`).
    pub current_frame: f64,
    /// `dateMs`: `Date.now()` at the post (shell).
    pub date_ms: f64,
    /// `pingSeq`: the last TIME_PING's sequence number, echoed (shell).
    pub ping_seq: u32,
    /// `pingFrameLo`: the low 32 bits of the frame at which that ping arrived (shell).
    pub ping_frame_lo: u32,
    /// `underruns`: cumulative, by the drift method, architecture §4.7 (shell).
    pub underruns: u32,
    /// `lateCommands`: cumulative stamped records applied after their frame, architecture §4.4
    /// (core: A1.2 and A3.2, through `note_late`).
    pub late_commands: u32,
    /// `workUnits`: the last quantum's (writer, from `Core::work_units`; A3.3's model).
    pub work_units: u32,
    /// `workUnitsMax`: the most in one quantum since the last block (through `note_work_units`).
    pub work_units_max: u32,
    /// `mixedVoices` (core: A1.2).
    pub mixed_voices: u16,
    /// `liveVoices` (core: A1.2).
    pub live_voices: u16,
    /// `flags`: the [`flag`] bits.
    pub flags: u32,
    /// `ended` section (core: A1.2), with `endedCount`.
    pub ended: List<u32, ENDED_CAP>,
    /// `demoted` section: voices the adaptive cap virtualised (core: A3.3), with `demotedCount`.
    pub demoted: List<u32, DEMOTED_CAP>,
    /// `starved` section (core: B3), with `starvedCount`.
    pub starved: List<u32, STARVED_CAP>,
    /// `playheads` section, round-robin over `wantsPlayhead` voices (core: A1.2), with
    /// `playheadCount`.
    pub playheads: List<Playhead, PLAYHEADS_CAP>,
    /// `busCount`: how many entries of `peaks` are sent (core: A2.1, through `set_bus_count`).
    pub bus_count: u16,
    /// `peaks` section, indexed by bus (core: A2.1, through `set_peak`). Not cleared per block:
    /// the meters own their decay.
    pub peaks: [Peak; PEAKS_CAP],
    /// `clipEvents` section, codes 1 resident, 2 refusedCeiling, 3 refusedGrow, 4 hrtfReady
    /// (core: A1.3b, H2), with `clipEventCount`.
    pub clip_events: List<Event, CLIP_EVENTS_CAP>,
    /// `streamEvents` section, codes 1 starved, 2 eos, 3 error (core: B3), with
    /// `streamEventCount`.
    pub stream_events: List<Event, STREAM_EVENTS_CAP>,
    /// `mixedCap`: the adaptive cap's current mixed-voice cap (core: A3.3).
    pub mixed_cap: u16,
    /// `loadPermille`: 0 = not measured (unmeasured in M1).
    pub load_permille: u16,
    /// `traps`: traps caught (shell).
    pub traps: u16,
    /// `minSlackFrames`: the minimum since the last block (through `note_slack`; read it with
    /// `min_slack_frames()`, which gives 0 when nothing was noted).
    pub min_slack: i32,
    /// Non-zero once `note_slack` was called in this block (all-zero must be valid: no `bool`).
    pub slack_noted: u32,
    /// `underrunFrames`: cumulative (shell).
    pub underrun_frames: u32,
    /// `arenaUsedKB` (core: A1.3b).
    pub arena_used_kb: u32,
    /// `arenaLargestFreeKB` (core: A1.3b).
    pub arena_largest_free_kb: u32,
    /// `abiVersion`: sent in the first block only, else 0 (writer).
    pub abi_version: u32,
    /// `maxLatenessFrames`: the latest stamped record since the last block, in frames
    /// (through `note_late`).
    pub max_lateness_frames: u32,
    /// `hrtfVoices`: voices rendered with HRTF (core: H3).
    pub hrtf_voices: u16,
    /// `hrtfLoadFailure`: 0 none, 1 fetch, 2 data (core: H2).
    pub hrtf_load_failure: u16,
    /// ADR 0162's fields and sections (K2).
    pub spatial: SpatialCounters,
}

impl Counters {
    /// Records the work units of the quantum just rendered: sets `work_units` and raises
    /// `work_units_max`.
    pub fn note_work_units(&mut self, units: u32) {
        self.work_units = units;
        self.work_units_max = self.work_units_max.max(units);
    }

    /// Counts one late stamped record (architecture §4.4): `late_commands` + 1 (wrapping) and
    /// raises `max_lateness_frames` to `lateness_frames`.
    pub fn note_late(&mut self, lateness_frames: u32) {
        self.late_commands = self.late_commands.wrapping_add(1);
        self.max_lateness_frames = self.max_lateness_frames.max(lateness_frames);
    }

    /// Lowers the block's minimum slack to `frames` (the first note in a block sets it).
    pub fn note_slack(&mut self, frames: i32) {
        if self.slack_noted == 0 {
            self.min_slack = frames;
            self.slack_noted = 1;
        } else {
            self.min_slack = self.min_slack.min(frames);
        }
    }

    /// The block's minimum slack, or 0 when `note_slack` wasn't called since the last block.
    pub fn min_slack_frames(&self) -> i32 {
        if self.slack_noted != 0 {
            self.min_slack
        } else {
            0
        }
    }

    /// Sets (`on`) or clears the [`flag`] bits in `bits`.
    pub fn set_flag(&mut self, bits: u32, on: bool) {
        if on {
            self.flags |= bits;
        } else {
            self.flags &= !bits;
        }
    }

    /// Sets bus `bus`'s peak; `false` (and no change) when `bus >= PEAKS_CAP`.
    pub fn set_peak(&mut self, bus: usize, l: f32, r: f32) -> bool {
        if bus >= PEAKS_CAP {
            return false;
        }
        self.peaks[bus] = Peak { l, r };
        true
    }

    /// Sets `bus_count`, clamped to `PEAKS_CAP`.
    pub fn set_bus_count(&mut self, count: usize) {
        self.bus_count = count.min(PEAKS_CAP) as u16;
    }

    /// The peaks that are sent: `peaks[..bus_count]`.
    pub fn sent_peaks(&self) -> &[Peak] {
        &self.peaks[..self.bus_count as usize]
    }

    /// Called by the writer after it serialised a block: clears the six section lists and resets
    /// the per-block fields (`work_units_max` to 0, the slack to "not noted", `max_lateness_frames`
    /// to 0, `abi_version` to 0). Cumulative counts, instant values, `flags`, `bus_count` and
    /// `peaks` are kept.
    pub fn end_block(&mut self) {
        self.ended.clear();
        self.demoted.clear();
        self.starved.clear();
        self.playheads.clear();
        self.clip_events.clear();
        self.stream_events.clear();
        self.spatial.zone_events.clear();
        self.work_units_max = 0;
        self.slack_noted = 0;
        self.min_slack = 0;
        self.max_lateness_frames = 0;
        self.abi_version = 0;
    }
}

/// A zeroed `Counters`, as `myco_audio_init` leaves one (for tests and `Default`).
impl Default for Counters {
    fn default() -> Counters {
        // SAFETY: every field is an integer, a float or an array of them, so all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn a_zeroed_list_is_empty() {
        let c = Counters::default();
        assert_eq!(c.ended.len(), 0);
        assert!(c.ended.is_empty());
        assert!(!c.ended.is_full());
        assert!(c.ended.as_slice().is_empty());
        assert!(c.playheads.is_empty());
        assert_eq!(List::<Event, CLIP_EVENTS_CAP>::CAPACITY, CLIP_EVENTS_CAP);
    }

    #[test]
    fn push_fills_to_capacity_then_refuses() {
        let mut c = Counters::default();
        for i in 0..ENDED_CAP as u32 {
            assert!(c.ended.push(i));
        }
        assert!(c.ended.is_full());
        assert_eq!(c.ended.len(), ENDED_CAP);
        assert!(!c.ended.push(9_999));
        assert_eq!(c.ended.len(), ENDED_CAP);
        let items = c.ended.as_slice();
        assert_eq!(items.first(), Some(&0));
        assert_eq!(items.last(), Some(&(ENDED_CAP as u32 - 1)));
    }

    #[test]
    fn clear_empties_a_list() {
        let mut c = Counters::default();
        for i in 0..3 {
            assert!(c.playheads.push(Playhead { id: i, clip_frame: i * 10 }));
        }
        assert_eq!(c.playheads.len(), 3);
        c.playheads.clear();
        assert!(c.playheads.is_empty());
        assert!(c.playheads.as_slice().is_empty());
        assert!(c.playheads.push(Playhead { id: 7, clip_frame: 70 }));
        assert_eq!(c.playheads.as_slice(), &[Playhead { id: 7, clip_frame: 70 }]);
    }

    #[test]
    fn work_units_keep_the_last_and_the_max() {
        let mut c = Counters::default();
        c.note_work_units(5);
        c.note_work_units(3);
        assert_eq!(c.work_units, 3);
        assert_eq!(c.work_units_max, 5);
        c.note_work_units(9);
        assert_eq!((c.work_units, c.work_units_max), (9, 9));
        c.note_work_units(2);
        assert_eq!((c.work_units, c.work_units_max), (2, 9));
    }

    #[test]
    fn late_records_count_and_keep_the_max_lateness() {
        let mut c = Counters::default();
        c.note_late(10);
        c.note_late(4);
        assert_eq!(c.late_commands, 2);
        assert_eq!(c.max_lateness_frames, 10);
        c.late_commands = u32::MAX;
        c.note_late(0);
        assert_eq!(c.late_commands, 0, "the count wraps");
    }

    #[test]
    fn slack_is_the_block_minimum_and_zero_when_unnoted() {
        let mut c = Counters::default();
        assert_eq!(c.min_slack_frames(), 0);
        c.note_slack(7);
        assert_eq!(c.min_slack_frames(), 7);
        c.note_slack(9);
        assert_eq!(c.min_slack_frames(), 7);
        c.note_slack(-3);
        assert_eq!(c.min_slack_frames(), -3);
        c.end_block();
        assert_eq!(c.min_slack_frames(), 0, "unnoted again after a block");
        c.note_slack(5);
        assert_eq!(c.min_slack_frames(), 5, "the new block's first note sets it, not the old -3");
    }

    #[test]
    fn flags_set_and_clear_only_their_bits() {
        let mut c = Counters::default();
        c.set_flag(flag::ARENA_FULL | flag::READY, true);
        assert_eq!(c.flags, flag::ARENA_FULL | flag::READY);
        c.set_flag(flag::ARENA_FULL, false);
        assert_eq!(c.flags, flag::READY);
        c.set_flag(flag::READY, false);
        c.set_flag(flag::TRAP_CAUGHT, false);
        assert_eq!(c.flags, 0);
    }

    #[test]
    fn peaks_past_the_cap_are_refused_and_bus_count_clamps() {
        let mut c = Counters::default();
        assert!(c.set_peak(PEAKS_CAP - 1, 0.5, 0.25));
        assert!(!c.set_peak(PEAKS_CAP, 1.0, 1.0));
        assert_eq!(c.peaks[PEAKS_CAP - 1], Peak { l: 0.5, r: 0.25 });

        c.set_bus_count(100);
        assert_eq!(c.bus_count as usize, PEAKS_CAP);
        assert_eq!(c.sent_peaks().len(), PEAKS_CAP);

        assert!(c.set_peak(1, 0.1, 0.2));
        c.set_bus_count(2);
        assert_eq!(c.sent_peaks(), &[Peak::default(), Peak { l: 0.1, r: 0.2 }]);
    }

    #[test]
    fn end_block_clears_sections_and_per_block_fields_only() {
        let mut c = Counters::default();
        assert!(c.ended.push(1));
        assert!(c.demoted.push(2));
        assert!(c.starved.push(3));
        assert!(c.playheads.push(Playhead { id: 4, clip_frame: 5 }));
        assert!(c.clip_events.push(Event { id: 6, code: 1 }));
        assert!(c.stream_events.push(Event { id: 7, code: 2 }));
        c.note_work_units(8);
        c.note_late(3);
        c.note_slack(2);
        c.set_flag(flag::READY, true);
        c.underruns = 4;
        c.current_frame = 1.0;
        c.abi_version = 99;
        c.set_bus_count(2);
        assert!(c.set_peak(0, 0.5, 0.5));

        c.end_block();

        assert!(c.ended.is_empty());
        assert!(c.demoted.is_empty());
        assert!(c.starved.is_empty());
        assert!(c.playheads.is_empty());
        assert!(c.clip_events.is_empty());
        assert!(c.stream_events.is_empty());
        assert_eq!(c.work_units_max, 0);
        assert_eq!(c.min_slack_frames(), 0);
        assert_eq!(c.max_lateness_frames, 0);
        assert_eq!(c.abi_version, 0);

        assert_eq!(c.late_commands, 1);
        assert_eq!(c.underruns, 4);
        assert_eq!(c.current_frame, 1.0);
        assert_eq!(c.work_units, 8);
        assert_eq!(c.flags, flag::READY);
        assert_eq!(c.bus_count, 2);
        assert_eq!(c.peaks[0], Peak { l: 0.5, r: 0.5 });
    }
}
