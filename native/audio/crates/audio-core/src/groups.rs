//! The group table and the gate (0166 M4a; api-and-models §3.1 "Group table", §4.1 PLAY `gate`;
//! architecture §2.2, §4.3 "The group table: gate, hold on starve, give-up", §3.6; rulings R8, R9,
//! R10, R11; ADR 0167 §2).
//!
//! **The table.** 16 entries ([`MAX_GROUPS`], R9). An entry is taken by the first PLAY of its group
//! ([`admit`]) and freed when every member has ended or been stopped, the group is abandoned, or on
//! RESET. A started group keeps its entry for its whole life (the starve hold needs the
//! membership). A PLAY whose group finds no entry starts ungated and counts `groupTableFull`; a
//! group size above [`MAX_GROUP_MEMBERS`] (32; the wire carries up to 64) is refused and counted.
//! A gated voice carries `flags2` bit 2 ([`FLAG2_GATED`]) while held, and its group's index in
//! bits 3–6 ([`FLAG2_GROUP_SHIFT`], R4).
//!
//! **Per quantum, before the voice loop** ([`begin_quantum`], C2b; the decision is [`decide`], C2a):
//!
//! | State | Condition | Action |
//! |---|---|---|
//! | Stamped, stamp in this quantum or earlier | every member present and ready (≥ 4,096 frames of its epoch, or input ended; decoded members always) | start every member at the stamp's offset (on time) or offset 0 (late); rebase (`group_rebase::apply`); report |
//! | Stamped | a member missing or not ready | hold every member SCHEDULED |
//! | Started | a gated mixed member would starve this quantum | hold (`group_hold::on_starve`, C2c) |
//! | Held | every member ≥ 4,096 frames buffered, or input ended | resume at offset 0 with a 5 ms fade-in; rebase by the hold length; report the slip |
//! | Stamped or Held | > 1 s past the stamp, or held > 1 s | abandon: end every member (5 ms fade if sounding); report |
//!
//! A member STOPped while held leaves the group and the size shrinks. A virtual member is still a
//! member under the same rule. Events go to the `groupStarts` section, one per group per start,
//! resume or abandon (≤ 8 per STATUS, the rest carry over). Cost: one compare per member per
//! quantum while a group waits or holds, one flag read once it plays.
//!
//! **Memory.** The `Groups` region (Q1's layout, before `Arena`): [`MAX_GROUPS`] entries of 160 B =
//! 2,560 B on every preset. All-zero bytes are a free table.
//!
//! Owners: **C2a** (W4: table, [`admit`], [`decide`], give-up, state-machine tests) and **C2b** (W5:
//! [`begin_quantum`], the gate in `voices.rs`'s SCHEDULED branch, ring binding, member STOP, RESET,
//! `groupStarts`; hooks H2). The hold and the rebase are `group_hold.rs` (C2c) and
//! `group_rebase.rs` (C2d).
//!
//! **C2a's API (what C2b calls).** Everything below works on the table as a slice of entries, so the
//! state machine is tested without a core (`tests/group_gate.rs`):
//! - PLAY time: [`admit_in`] (or [`admit`] over the core's region), then [`note_admit`] for the
//!   counters and [`flags2_with_group`] for the voice slot;
//! - per quantum: [`decide`] per taken entry with each member's [`MemberState`], then
//!   [`mark_started`] on `Start`, `group_hold::on_starve` on `Hold`, `group_hold::try_resume` on a
//!   held entry, [`mark_abandoned`] on `Abandon` (and [`free`] once its event is reported);
//! - a member's end or STOP: [`remove_member`] (frees the entry with its last member); RESET:
//!   [`reset_entries`] (or [`reset`]);
//! - the give-up at the core's rate: [`give_up_frames`].

use crate::core::Core;
use crate::counters::{group_start_flag, GroupStart, MusicCounters};

/// Group table entries (api-and-models §4.5 `MAX_GROUPS`; R9).
pub const MAX_GROUPS: usize = audio_wire::generated::MAX_GROUPS as usize;
/// Members an entry holds (§4.5 `MAX_GROUP_MEMBERS`).
pub const MAX_GROUP_MEMBERS: usize = audio_wire::generated::MAX_GROUP_MEMBERS as usize;
/// Bytes per entry.
pub const GROUP_ENTRY_BYTES: usize = 160;
/// The `Groups` region: `MAX_GROUPS × 160` = 2,560 B.
pub const REGION_BYTES: usize = MAX_GROUPS * GROUP_ENTRY_BYTES;

const _: () = assert!(REGION_BYTES == 2_560, "api-and-models §3.1");
const _: () = assert!(MAX_GROUPS <= 16, "the group index rides in flags2 bits 3-6");

/// PLAY `gate` (§4.1): bits 0–9 the group id (1..1023; 0 ungated), bits 10–15 the size − 1.
pub const GATE_ID_MASK: u16 = audio_wire::generated::PLAY_GATE_ID_MASK as u16;
pub const GATE_SIZE_SHIFT: u16 = audio_wire::generated::PLAY_GATE_SIZE_SHIFT as u16;

/// The give-up: 1 s after the stamp, or 1 s held (architecture §5.3; R11).
pub const GIVE_UP_SECONDS: f32 = 1.0;

/// Voice slot `flags2` bit 2: the voice is held by its group's gate (R4).
pub const FLAG2_GATED: u8 = 1 << 2;
/// Voice slot `flags2` bits 3–6: the voice's group index (0..15), meaningful while it is a member.
pub const FLAG2_GROUP_SHIFT: u8 = 3;
pub const FLAG2_GROUP_MASK: u8 = 0b1111 << FLAG2_GROUP_SHIFT;

/// [`GroupEntry::state`] values. 0 is free, so a zeroed table is empty.
pub mod state {
    pub const FREE: u8 = 0;
    /// Taken, members arriving or waiting for the stamp and readiness; every member SCHEDULED.
    pub const STAMPED: u8 = 1;
    /// Every member started together.
    pub const STARTED: u8 = 2;
    /// A member starved: every member faded out together and holds silent, positions pinned.
    pub const HELD: u8 = 3;
}

/// [`GroupEntry::flags`] bits.
pub mod flag {
    /// The start was late (reported with the start).
    pub const LATE: u8 = 1 << 0;
    /// A start, resume or abandon event waits for room in `groupStarts`.
    pub const EVENT_PENDING: u8 = 1 << 1;
    /// The pending event is a resume after a hold.
    pub const RESUMED: u8 = 1 << 2;
    /// The pending event is an abandon.
    pub const ABANDONED: u8 = 1 << 3;
}

/// One group: 160 bytes, all-zero free (api-and-models §3.1: id, size, present, state, flags,
/// stamp frame, start frame, slip, held-since, up to 32 member voice ids).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GroupEntry {
    /// The wire's group id (1..1023); 0 with a free entry.
    pub id: u16,
    /// Members expected (the PLAY gate's size; shrinks when a held member is stopped).
    pub size: u8,
    /// Members arrived (`members[..present]`).
    pub present: u8,
    /// [`state`].
    pub state: u8,
    /// [`flag`] bits.
    pub flags: u8,
    pub _pad: u16,
    /// The absolute frame the group is stamped to start at.
    pub stamp_frame: u64,
    /// The absolute frame it started (or last resumed) at; 0 before.
    pub start_frame: u64,
    /// The last start's or resume's slip, in frames (reported in `groupStarts`).
    pub slip: u32,
    /// "Held-since" as a length: frames held so far in the current hold (0 when not held). The hold's
    /// start is `current frame − held_frames`; the give-up compares it with 1 s. (A u32 length keeps
    /// the entry at 160 B; a 1 s give-up is far below its range.)
    pub held_frames: u32,
    /// Member voice ids, `members[..present]`.
    pub members: [u32; MAX_GROUP_MEMBERS],
}

const _: () = assert!(core::mem::size_of::<GroupEntry>() == GROUP_ENTRY_BYTES, "a group entry is 160 B");

impl GroupEntry {
    /// The members that arrived.
    pub fn present_members(&self) -> &[u32] {
        &self.members[..(self.present as usize).min(MAX_GROUP_MEMBERS)]
    }

    /// `true` when `voice_id` is a member.
    pub fn has_member(&self, voice_id: u32) -> bool {
        voice_id != 0 && self.present_members().contains(&voice_id)
    }
}

/// The table viewed over the `Groups` region's bytes (`MAX_GROUPS` entries; empty for an empty
/// region, so every PLAY starts ungated).
pub fn entries(region: &mut [u8]) -> &mut [GroupEntry] {
    let count = (region.len() / GROUP_ENTRY_BYTES).min(MAX_GROUPS);
    if count == 0 {
        return &mut [];
    }
    // SAFETY: the `Groups` region is 64-byte aligned (Layout) and zeroed at init; all-zero bytes are
    // a valid GroupEntry; `count` entries fit. Only this module (and C2c's, C2d's through it) views it.
    unsafe { core::slice::from_raw_parts_mut(region.as_mut_ptr() as *mut GroupEntry, count) }
}

/// The table, read-only.
pub fn entries_of(region: &[u8]) -> &[GroupEntry] {
    let count = (region.len() / GROUP_ENTRY_BYTES).min(MAX_GROUPS);
    if count == 0 {
        return &[];
    }
    // SAFETY: as in `entries`.
    unsafe { core::slice::from_raw_parts(region.as_ptr() as *const GroupEntry, count) }
}

/// A decoded PLAY `gate`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Gate {
    /// 1..1023.
    pub id: u16,
    /// 1..64 on the wire.
    pub size: u8,
}

impl Gate {
    /// `None` for an ungated PLAY (id 0).
    pub fn from_word(gate: u16) -> Option<Gate> {
        let id = gate & GATE_ID_MASK;
        (id != 0).then_some(Gate { id, size: (gate >> GATE_SIZE_SHIFT) as u8 + 1 })
    }
}

/// What [`admit`] did with a PLAY.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    /// No gate: the voice behaves as today.
    Ungated,
    /// A member of the entry at `index`: the caller sets [`FLAG2_GATED`] and the index in `flags2`.
    Member { index: u8 },
    /// No free entry (or the group's entry can't take another member: it already holds `size`
    /// members, or it has started): the voice starts ungated; the caller counts `groupTableFull`
    /// ([`note_admit`]).
    TableFull,
    /// The size is above `MAX_GROUP_MEMBERS`: the voice starts ungated; the caller counts
    /// `groupSizeRefused` ([`note_admit`]).
    SizeRefused,
}

/// The give-up in frames at `sample_rate`: [`GIVE_UP_SECONDS`] (1 s; architecture §5.3, R11),
/// rounded to the nearest frame (48,000 at 48 kHz, 44,100 at 44.1 kHz).
pub fn give_up_frames(sample_rate: f32) -> u32 {
    let frames = sample_rate as f64 * GIVE_UP_SECONDS as f64 + 0.5;
    if frames <= 0.0 {
        0
    } else if frames >= u32::MAX as f64 {
        u32::MAX
    } else {
        frames as u32
    }
}

/// The index of the taken entry with group id `id`, if any.
pub fn find(entries: &[GroupEntry], id: u16) -> Option<u8> {
    if id == 0 {
        return None;
    }
    entries.iter().position(|e| e.state != state::FREE && e.id == id).map(|i| i as u8)
}

/// A PLAY with `gate` for voice `voice_id`, stamped at `stamp_frame` (§4.1, §4.3), on the table
/// `entries`: an ungated PLAY (id 0) is [`Admit::Ungated`]; a size above [`MAX_GROUP_MEMBERS`] is
/// [`Admit::SizeRefused`]; the first PLAY of a group takes the lowest free entry (id, size, the
/// stamp, state STAMPED, the voice as its first member); a later one joins its group's STAMPED
/// entry while `present < size`; otherwise (no free entry, a full or started entry)
/// [`Admit::TableFull`]. The table is left unchanged by every result but `Member`. (A voice already
/// a member is `Member` again with nothing added; an abandoned entry takes no new member.)
pub fn admit_in(entries: &mut [GroupEntry], gate: u16, voice_id: u32, stamp_frame: u64) -> Admit {
    let Some(g) = Gate::from_word(gate) else {
        return Admit::Ungated;
    };
    if g.size as usize > MAX_GROUP_MEMBERS {
        return Admit::SizeRefused;
    }
    if let Some(index) = find(entries, g.id) {
        let e = &mut entries[index as usize];
        if e.has_member(voice_id) {
            return Admit::Member { index };
        }
        let joinable = e.state == state::STAMPED && e.flags & flag::ABANDONED == 0 && e.present < e.size && (e.present as usize) < MAX_GROUP_MEMBERS;
        if !joinable {
            return Admit::TableFull;
        }
        e.members[e.present as usize] = voice_id;
        e.present += 1;
        return Admit::Member { index };
    }
    let Some(index) = entries.iter().position(|e| e.state == state::FREE) else {
        return Admit::TableFull;
    };
    let mut e = GroupEntry { id: g.id, size: g.size, present: 1, state: state::STAMPED, stamp_frame, ..GroupEntry::default() };
    e.members[0] = voice_id;
    entries[index] = e;
    Admit::Member { index: index as u8 }
}

/// [`admit_in`] over the core's `Groups` region. Called at PLAY time (`onmessage`), by C2b.
pub fn admit(core: &mut Core, gate: u16, voice_id: u32, stamp_frame: u64) -> Admit {
    admit_in(entries(core.regions_mut().groups), gate, voice_id, stamp_frame)
}

/// Counts an [`Admit`]: `groupTableFull` for `TableFull`, `groupSizeRefused` for `SizeRefused`
/// (wrapping); nothing otherwise.
pub fn note_admit(counters: &mut MusicCounters, admit: Admit) {
    match admit {
        Admit::TableFull => counters.group_table_full = counters.group_table_full.wrapping_add(1),
        Admit::SizeRefused => counters.group_size_refused = counters.group_size_refused.wrapping_add(1),
        Admit::Ungated | Admit::Member { .. } => {}
    }
}

/// `flags2` with [`FLAG2_GATED`] set and the group index `index` (0..15) in bits 3–6; the other
/// bits (ambisonic, due, bit 7) unchanged.
pub fn flags2_with_group(flags2: u8, index: u8) -> u8 {
    flags2_without_group(flags2) | FLAG2_GATED | ((index << FLAG2_GROUP_SHIFT) & FLAG2_GROUP_MASK)
}

/// The group index a voice's `flags2` carries: `Some(index)` while [`FLAG2_GATED`] is set.
pub fn flags2_group(flags2: u8) -> Option<u8> {
    (flags2 & FLAG2_GATED != 0).then_some((flags2 & FLAG2_GROUP_MASK) >> FLAG2_GROUP_SHIFT)
}

/// `flags2` with [`FLAG2_GATED`] and the group index cleared; the other bits unchanged.
pub fn flags2_without_group(flags2: u8) -> u8 {
    flags2 & !(FLAG2_GATED | FLAG2_GROUP_MASK)
}

/// One member's readiness this quantum, as the caller (C2b, in `voices.rs`) reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemberState {
    /// The voice exists and holds a ring (or is decoded).
    pub present: bool,
    /// ≥ `START_FRAMES` (4,096) frames of its epoch buffered, or input ended; decoded: always.
    pub ready: bool,
    /// Mixed and would starve this quantum (buffered < 128 + the 5 ms fade, the existing check).
    pub starving: bool,
}

/// The gate's decision for one entry this quantum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// No change: a STAMPED entry waits (stamp ahead, or a member missing or not ready; members
    /// stay SCHEDULED), a HELD entry stays held (a member not ready yet), a FREE entry stays free.
    Wait,
    /// Start every member at sample `offset` of this quantum; `slip` frames after the stamp (0 on
    /// time, then `offset` is the stamp's).
    Start { offset: u32, slip: u32 },
    /// Playing on.
    Play,
    /// A member starves: hold the group (C2c).
    Hold,
    /// Held and every member ready again: resume at offset 0; `slip` is the hold's length.
    Resume { slip: u32 },
    /// More than 1 s past the stamp or held: end every member.
    Abandon,
}

/// The gate's decision for `entry` in the quantum `[frame, frame + QUANTUM)` (architecture §4.3's
/// table), with `give_up_frames` from [`give_up_frames`] and `member(voice_id)` each present
/// member's state. Pure, so the state machine is tested without a core. In order:
/// - FREE: `Wait`.
/// - STAMPED: `Abandon` when `frame > stamp_frame + give_up_frames` (more than 1 s past the stamp,
///   whatever the members); else `Wait` while the stamp is past this quantum
///   (`stamp_frame >= frame + QUANTUM`), the group is incomplete (`present < size`) or a member
///   isn't `present && ready`; else `Start` on time (`stamp_frame >= frame`: `offset = stamp_frame
///   − frame`, `slip = 0`) or late (`offset = 0`, `slip = frame − stamp_frame`).
/// - STARTED: `Hold` when any member is `starving` (the caller sets it only for a gated mixed
///   member, the existing check), else `Play`.
/// - HELD: `Abandon` when `held_frames > give_up_frames` (held more than 1 s); else `Resume { slip:
///   held_frames }` when every member is `ready`, else `Wait`.
pub fn decide(entry: &GroupEntry, frame: u64, give_up_frames: u32, member: impl Fn(u32) -> MemberState) -> Decision {
    let all_ready = || entry.present_members().iter().all(|&v| {
        let m = member(v);
        m.present && m.ready
    });
    match entry.state {
        state::STAMPED => {
            if frame > entry.stamp_frame.saturating_add(give_up_frames as u64) {
                return Decision::Abandon;
            }
            if entry.stamp_frame >= frame + crate::QUANTUM as u64 || entry.present < entry.size || !all_ready() {
                return Decision::Wait;
            }
            if entry.stamp_frame >= frame {
                Decision::Start { offset: (entry.stamp_frame - frame) as u32, slip: 0 }
            } else {
                // `frame − stamp ≤ give_up_frames` (checked above), so it fits.
                Decision::Start { offset: 0, slip: (frame - entry.stamp_frame) as u32 }
            }
        }
        state::STARTED => {
            if entry.present_members().iter().any(|&v| member(v).starving) {
                Decision::Hold
            } else {
                Decision::Play
            }
        }
        state::HELD => {
            if entry.held_frames > give_up_frames {
                Decision::Abandon
            } else if all_ready() {
                Decision::Resume { slip: entry.held_frames }
            } else {
                Decision::Wait
            }
        }
        _ => Decision::Wait,
    }
}

/// Applies `Decision::Start { offset, slip }` decided in the quantum at `frame`: state STARTED,
/// `start_frame = frame + offset`, `slip`, [`flag::LATE`] when `slip > 0`, [`flag::EVENT_PENDING`]
/// (C2b reports it in `groupStarts`, counts `groupsLate` and `note_slip`, and rebases).
pub fn mark_started(entry: &mut GroupEntry, frame: u64, offset: u32, slip: u32) {
    entry.state = state::STARTED;
    entry.start_frame = frame + offset as u64;
    entry.slip = slip;
    entry.held_frames = 0;
    entry.flags &= !(flag::LATE | flag::RESUMED | flag::ABANDONED);
    if slip > 0 {
        entry.flags |= flag::LATE;
    }
    entry.flags |= flag::EVENT_PENDING;
}

/// Applies `Decision::Abandon`: [`flag::ABANDONED`] and [`flag::EVENT_PENDING`] set, the state kept
/// (C2b ends every member, counts `groupsAbandoned`, reports the event, then [`free`]s the entry).
pub fn mark_abandoned(entry: &mut GroupEntry) {
    entry.flags |= flag::ABANDONED | flag::EVENT_PENDING;
}

/// Frees an entry (all zero).
pub fn free(entry: &mut GroupEntry) {
    *entry = GroupEntry::default();
}

/// What [`remove_member`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberLeft {
    /// `voice_id` isn't a member of that entry (or the index is out of range): nothing changed.
    NotMember,
    /// Removed; `present` and `size` each shrank by one, the other members keep their order.
    Left,
    /// It was the last member: the entry is free now.
    Freed,
}

/// Voice `voice_id` left the entry at `index`: it ended, or it was STOPped (while held it leaves
/// the group and the size shrinks, S2; while stamped too, so the others don't wait for it).
pub fn remove_member(entries: &mut [GroupEntry], index: u8, voice_id: u32) -> MemberLeft {
    let Some(e) = entries.get_mut(index as usize) else {
        return MemberLeft::NotMember;
    };
    let Some(at) = (if voice_id == 0 { None } else { e.present_members().iter().position(|&v| v == voice_id) }) else {
        return MemberLeft::NotMember;
    };
    let present = e.present as usize;
    e.members.copy_within(at + 1..present, at);
    e.members[present - 1] = 0;
    e.present -= 1;
    e.size = e.size.saturating_sub(1);
    if e.present == 0 {
        free(e);
        return MemberLeft::Freed;
    }
    MemberLeft::Left
}

/// RESET: every entry free.
pub fn reset_entries(entries: &mut [GroupEntry]) {
    entries.iter_mut().for_each(free);
}

/// The index of the entry `voice_id` is a member of, read from its `flags2` (bits 3–6, kept after
/// the start while [`FLAG2_GATED`] is clear) and checked against the entry's members, so a voice
/// that never joined a group (index bits 0) is never taken for entry 0's member.
#[inline]
pub fn member_index(entries: &[GroupEntry], flags2: u8, voice_id: u32) -> Option<u8> {
    let index = (flags2 & FLAG2_GROUP_MASK) >> FLAG2_GROUP_SHIFT;
    entries.get(index as usize).filter(|e| e.state != state::FREE && e.has_member(voice_id)).map(|_| index)
}

/// Voice `voice_id` (with `flags2`) ended, was stopped or was replaced: it leaves its group, if it
/// is a member ([`remove_member`]). An entry whose last member leaves with an event still waiting
/// for room in `groupStarts` is kept, memberless, until [`begin_quantum`] reports it, then freed.
pub fn leave(entries: &mut [GroupEntry], flags2: u8, voice_id: u32) -> MemberLeft {
    let Some(index) = member_index(entries, flags2, voice_id) else {
        return MemberLeft::NotMember;
    };
    let before = entries[index as usize];
    let left = remove_member(entries, index, voice_id);
    if left == MemberLeft::Freed && before.flags & flag::EVENT_PENDING != 0 {
        entries[index as usize] = GroupEntry { present: 0, size: 0, members: [0; MAX_GROUP_MEMBERS], ..before };
    }
    left
}

/// [`leave`] for voice `voice_id` whose `flags2` is gone (its slot was freed): finds its entry by
/// its members. Called only while some entry is taken.
pub fn leave_any(entries: &mut [GroupEntry], voice_id: u32) -> MemberLeft {
    match entries.iter().position(|e| e.state != state::FREE && e.has_member(voice_id)) {
        Some(index) => leave(entries, flags2_with_group(0, index as u8), voice_id),
        None => MemberLeft::NotMember,
    }
}

/// The `groupStarts` item for `entry`'s pending event (architecture §4.3 "Events"; api-and-models
/// §4.4): its id, the late / held-and-resumed / abandoned bits, the slip and the frame.
pub fn event_of(entry: &GroupEntry) -> GroupStart {
    let mut flags = 0u16;
    if entry.flags & flag::LATE != 0 {
        flags |= group_start_flag::LATE;
    }
    if entry.flags & flag::RESUMED != 0 {
        flags |= group_start_flag::HELD_RESUMED;
    }
    if entry.flags & flag::ABANDONED != 0 {
        flags |= group_start_flag::ABANDONED;
    }
    GroupStart { group_id: entry.id, flags, slip_frames: entry.slip, start_frame: entry.start_frame }
}

/// Pushes the entry at `index`'s pending event into `groupStarts`; with no room it stays pending
/// for the next block (as `starved`). A reported abandon, or a reported entry with no member left,
/// frees the entry. Returns `true` when the event went out.
fn report_event(core: &mut Core, index: usize) -> bool {
    let e = entries(core.regions_mut().groups)[index];
    if e.flags & flag::EVENT_PENDING == 0 {
        return true;
    }
    if !crate::status::counters_mut(core).music.group_starts.push(event_of(&e)) {
        return false;
    }
    let slot = &mut entries(core.regions_mut().groups)[index];
    slot.flags &= !flag::EVENT_PENDING;
    if slot.flags & flag::ABANDONED != 0 || slot.present == 0 {
        free(slot);
    }
    true
}

/// Per quantum, before the voice loop and before the parked records come back (`voices::render`,
/// C2b; architecture §4.3's table): for every taken entry,
/// - an event still waiting for room in `groupStarts` goes first (an abandoned entry waits for its
///   report and is then freed);
/// - **STAMPED** (an asap stamp becomes this quantum's frame): a member no longer live leaves (a STOP
///   before the start, a steal); then [`decide`] with each member's [`MemberState`]:
///   - `Start { offset, slip }`: every member starts at this quantum's frame + `offset` (on time: the
///     stamp; late: offset 0), each stream member binding its ring ([`mark_started`],
///     `voices::gate_start`); `groupsLate` and `maxSlipFrames` count it; the members' records are
///     rebased by the slip (`group_rebase::apply`, hook H2, C2d's); the start is reported;
///   - `Abandon` (more than 1 s past the stamp): every member ends ([`abandon`]);
///   - `Wait`: every member stays SCHEDULED;
/// - **HELD** (C2c's hold): every member is held by the gate (`FLAG2_GATED`, so its records park);
///   more than 1 s held abandons; else `group_hold::try_resume` with every member ready resumes it:
///   the flag clears, `maxSlipFrames` counts the slip, the records are rebased by it and the resume
///   is reported;
/// - **STARTED**: `group_hold::begin_started` (C2c) looks ahead for a member about to starve and
///   runs the joint fade-out; when it has run, the entry is HELD from this quantum (as above).
pub fn begin_quantum(core: &mut Core, frame: u64) {
    if entries_of(core.regions().groups).iter().all(|e| e.state == state::FREE) {
        return;
    }
    let give_up = give_up_frames(core.params().sample_rate);
    for index in 0..entries_of(core.regions().groups).len() {
        let e = entries_of(core.regions().groups)[index];
        if e.state == state::FREE {
            continue;
        }
        if !report_event(core, index) || e.flags & flag::ABANDONED != 0 {
            continue;
        }
        let now = entries_of(core.regions().groups)[index].state;
        match now {
            state::STAMPED => stamped(core, index, frame, give_up),
            state::HELD => held(core, index, frame, give_up),
            // C2c: the hold's look-ahead and joint fade; a fade that ran out holds from this quantum.
            state::STARTED if crate::group_hold::begin_started(core, index, frame) => held(core, index, frame, give_up),
            _ => {}
        }
    }
}

/// [`begin_quantum`] for the STAMPED entry at `index`.
fn stamped(core: &mut Core, index: usize, frame: u64, give_up: u32) {
    let mut e = entries(core.regions_mut().groups)[index];
    if e.stamp_frame == crate::voices::ASAP {
        // An asap gated PLAY: the group starts in the first quantum every member is ready.
        e.stamp_frame = frame;
        entries(core.regions_mut().groups)[index].stamp_frame = frame;
    }
    // Members no longer live (stopped before the start, stolen) leave, so the rest don't wait.
    let mut i = 0;
    while i < e.present as usize {
        let v = e.members[i];
        if crate::voices::member_state(core, v).present {
            i += 1;
            continue;
        }
        if remove_member(entries(core.regions_mut().groups), index as u8, v) == MemberLeft::Freed {
            return;
        }
        e = entries(core.regions_mut().groups)[index];
    }
    match decide(&e, frame, give_up, |v| crate::voices::member_state(core, v)) {
        Decision::Start { offset, slip } => {
            mark_started(&mut e, frame, offset, slip);
            entries(core.regions_mut().groups)[index] = e;
            for &v in e.present_members() {
                crate::voices::gate_start(core, v, frame + offset as u64);
            }
            let m = &mut crate::status::counters_mut(core).music;
            if slip > 0 {
                m.note_group_late();
            }
            m.note_slip(slip);
            crate::group_rebase::apply(core, index as u8, e.stamp_frame, slip);
            report_event(core, index);
        }
        Decision::Abandon => abandon(core, index, frame, frame.saturating_sub(e.stamp_frame).min(u32::MAX as u64) as u32),
        _ => {}
    }
}

/// [`begin_quantum`] for the HELD entry at `index` (C2c's hold).
fn held(core: &mut Core, index: usize, frame: u64, give_up: u32) {
    let mut e = entries(core.regions_mut().groups)[index];
    for &v in e.present_members() {
        crate::voices::set_gated(core, v, true);
    }
    if e.held_frames > give_up {
        abandon(core, index, frame, e.held_frames);
        return;
    }
    let all_ready = e.present_members().iter().all(|&v| crate::group_hold::member_ready(core, v));
    let resumed = crate::group_hold::try_resume(&mut e, frame, all_ready);
    entries(core.regions_mut().groups)[index] = e;
    if let Some(slip) = resumed {
        for &v in e.present_members() {
            crate::voices::set_gated(core, v, false);
        }
        crate::group_hold::resume_members(core, index);
        crate::status::counters_mut(core).music.note_slip(slip);
        crate::group_rebase::apply(core, index as u8, frame.saturating_sub(slip as u64), slip);
        report_event(core, index);
    }
}

/// Abandons the entry at `index` in the quantum at `frame`, `slip` frames past its stamp (or held):
/// every member leaves and ends (`voices::gate_abandon`: at once if silent, else a 5 ms fade; the
/// ended voices give their rings back as any voice does), `groupsAbandoned` counts it, and the
/// abandon is reported (the entry is freed once it is).
fn abandon(core: &mut Core, index: usize, frame: u64, slip: u32) {
    let mut e = entries(core.regions_mut().groups)[index];
    for &v in e.present_members() {
        crate::voices::gate_abandon(core, v);
    }
    mark_abandoned(&mut e);
    e.start_frame = frame;
    e.slip = slip;
    e.present = 0;
    e.size = 0;
    e.members = [0; MAX_GROUP_MEMBERS];
    entries(core.regions_mut().groups)[index] = e;
    crate::status::counters_mut(core).music.note_group_abandoned();
    report_event(core, index);
}

/// [`remove_member`] over the core's `Groups` region: a member left its group (stopped, or ended).
/// Frees the entry when no member is left. Called from `voices.rs` (C2b).
pub fn member_gone(core: &mut Core, index: u8, voice_id: u32) -> MemberLeft {
    remove_member(entries(core.regions_mut().groups), index, voice_id)
}

/// RESET: every entry free.
pub fn reset(core: &mut Core) {
    reset_entries(entries(core.regions_mut().groups));
}
