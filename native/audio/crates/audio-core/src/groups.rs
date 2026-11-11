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
//! `group_rebase.rs` (C2d). Bodies tagged `C2a:` or `C2b:` are inert stubs.

use crate::core::Core;

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
    /// No free entry: the voice starts ungated; `groupTableFull` was counted.
    TableFull,
    /// The size is above `MAX_GROUP_MEMBERS`: the voice starts ungated; the refusal was counted.
    SizeRefused,
}

/// A PLAY with `gate` for voice `voice_id`, stamped at `stamp_frame` (§4.1, §4.3): the first PLAY
/// of a group takes an entry; later ones join it. Called at PLAY time (`onmessage`), by C2b.
pub fn admit(core: &mut Core, gate: u16, voice_id: u32, stamp_frame: u64) -> Admit {
    // C2a.
    let _ = (core, gate, voice_id, stamp_frame);
    Admit::Ungated
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
    /// Not yet (stamp ahead, or a member missing or not ready): members stay SCHEDULED.
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

/// The gate's decision for `entry` in the quantum at `frame` (architecture §4.3's table), with
/// `give_up_frames` = 1 s at the core's rate and `member(voice_id)` each member's state. Pure, so
/// C2a tests every row of the state machine without a core.
pub fn decide(entry: &GroupEntry, frame: u64, give_up_frames: u32, member: impl Fn(u32) -> MemberState) -> Decision {
    // C2a.
    let _ = (entry, frame, give_up_frames, member);
    Decision::Wait
}

/// Per quantum, before the voice loop (`voices::render`, C2b): decides every taken entry and acts
/// (start, hold through `group_hold`, resume, abandon, rebase through `group_rebase`), frees the
/// entries whose members are all gone, and pushes the `groupStarts` events and slip counters.
pub fn begin_quantum(core: &mut Core, frame: u64) {
    // C2b.
    let _ = (core, frame);
}

/// A member left its group: stopped while held (the size shrinks), or ended. Frees the entry when
/// no member is left. Called from `voices.rs` (C2b).
pub fn member_gone(core: &mut Core, index: u8, voice_id: u32) {
    // C2b.
    let _ = (core, index, voice_id);
}

/// RESET: every entry free.
pub fn reset(core: &mut Core) {
    // C2b.
    let _ = core;
}
