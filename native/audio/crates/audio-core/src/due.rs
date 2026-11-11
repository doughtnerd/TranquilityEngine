//! The per-quantum due list and the parked records (0166 M4-0; api-and-models §3.1 "Due list",
//! "Class G and class S"; architecture §4.4 "`render`", §3.6 "Held records"; ADR 0167 §1.1;
//! rulings R2, R3, R10).
//!
//! **What it does (Z2a fills it).** `pop_due` still pops every pending record due in the quantum,
//! but a **per-voice** record now goes into this list and marks its voice's `due` bit
//! ([`FLAG2_DUE`]) instead of splitting the quantum; the quantum renders once and each flagged voice
//! applies its own records in frame order:
//! - **class G** ([`Class::G`]: FADE, SET_PARAMS with a gain-only mask, STOP with or without a fade)
//!   by a start-sample compare in the voice's gain loop (`curves::due_gain`, Z2b);
//! - **class S** ([`Class::S`]: every other per-voice record: SET_PARAMS with pitch, low-pass,
//!   direction, score, bus or flag bits, SET_VOICE_FX, SET_PAUSED, SEEK, SET_LOOP) by a split of
//!   that voice's render at the record's sample (`voice_split::boundaries`, Z2c). Two class G
//!   records for one voice at different offsets in one quantum take the class S path too.
//!
//! Records that aren't per voice (BUS_MIX, MASTER, LISTENER, configuration tables:
//! [`Class::Quantum`]) keep splitting the quantum and count `splitQuanta`; so does a quantum with
//! more than [`DUE_RECORDS`] due records ([`Route::Split`]). A due record at a voice's own start
//! frame applies before its first sample.
//!
//! **Parked records (R10).** A due record for a voice held by the gate (`groups::FLAG2_GATED`) is
//! parked here (up to [`PARKED_RECORDS`] across the core) instead of applying. When the group
//! starts or resumes, `group_rebase::apply` (C2d) shifts the member's parked **and still pending**
//! records with frame ≥ the stamp (or the hold's start) by the slip through [`rebase`]; a parked
//! record whose voice is no longer gated re-enters the due list in the quantum its (rebased) frame
//! falls in ([`release_parked`]). Past the 128th, a record applies at its own frame, unrebased, and
//! counts `parkedOverflow` ([`Route::Overflow`]).
//!
//! **Memory.** The `Due` region (Q1's layout, before `Arena`): [`DUE_RECORDS`] due records, then
//! [`PARKED_RECORDS`] parked records, each a 48-byte [`DueRecord`] (the scheduler's
//! `PendingRecord`): `(256 + 128) × 48 = 18,432 B` on every preset. The lengths live in a
//! [`DueArea`] in the core-state region after the zones' area. All-zero bytes are an empty list.
//!
//! Owner: **Z2a** (W2, on the flip branch `m4/in-voice`). Q1 left the types, constants, views and
//! signatures; bodies tagged `Z2a:` are inert stubs, so behaviour is today's until Z2a lands.

use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;

/// One due or parked record: the scheduler's 48-byte pending record (api-and-models §3.1).
pub use crate::scheduler::PendingRecord as DueRecord;

/// Due records per quantum (api-and-models §4.5 `DUE_RECORDS`; architecture §5.3).
// Q1 stage B: from `audio_wire::generated::DUE_RECORDS`.
pub const DUE_RECORDS: usize = 256;
/// Parked records across the core (§4.5 `PARKED_RECORDS`; R10: 2 held groups × 16 members × 4).
// Q1 stage B: from `audio_wire::generated::PARKED_RECORDS`.
pub const PARKED_RECORDS: usize = 128;
/// Bytes per due or parked record.
pub const DUE_RECORD_BYTES: usize = crate::layout::PENDING_RECORD_BYTES;
/// The `Due` region: `(DUE_RECORDS + PARKED_RECORDS) × 48` = 18,432 B.
pub const REGION_BYTES: usize = (DUE_RECORDS + PARKED_RECORDS) * DUE_RECORD_BYTES;

const _: () = assert!(core::mem::size_of::<DueRecord>() == DUE_RECORD_BYTES);
const _: () = assert!(REGION_BYTES == 18_432, "api-and-models §3.1");

/// Voice slot `flags2` bit 1: the voice has records in this quantum's due list (§3.1, R4).
pub const FLAG2_DUE: u8 = 1 << 1;

/// A due record's class (api-and-models §3.1, R2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Gain-like, applied by a compare in the voice's gain loop: FADE, SET_PARAMS with a gain-only
    /// mask, STOP with or without a fade.
    G,
    /// Every other per-voice record, applied by a split of that voice's render.
    S,
    /// Not per voice: splits the whole quantum and counts `splitQuanta`.
    Quantum,
}

/// The class of `record` (§3.1): by opcode, and for SET_PARAMS by its mask (gain bit alone → G).
pub fn classify(record: &DueRecord) -> Class {
    // Z2a: the table of §3.1. Until then every record splits the quantum, as today.
    let _ = record;
    Class::Quantum
}

/// Where [`route`] sent a record popped in this quantum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Into the due list; its voice's [`FLAG2_DUE`] is set. Applied inside the voice.
    Voice,
    /// Its voice is held by the gate: parked, applied (rebased) when the group starts.
    Parked,
    /// Its voice is held but the parked records are full: the caller applies it at its own frame,
    /// unrebased; `parkedOverflow` was counted.
    Overflow,
    /// Not per voice, or the due list is full, or its voice is gone: the caller splits the quantum
    /// at the record's offset and applies it there, as today (`splitQuanta` counts once per quantum).
    Split,
}

/// What [`rebase`] moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rebased {
    /// Parked records shifted.
    pub parked: u32,
    /// Records still in the pending queue shifted (the queue stays sorted, stable).
    pub pending: u32,
}

/// The due list's scalars in the core-state region. All-zero is valid (both lists empty).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DueArea {
    /// Records in this quantum's due list (`records[..len]`, in frame order, stable).
    pub len: u32,
    /// Parked records (`parked[..parked]`, in arrival order).
    pub parked: u32,
    /// The quantum's first frame the list was filled for (`begin_quantum`).
    pub frame: u64,
}

/// Offset of [`DueArea`] in the core-state region (after the zones' area).
pub const DUE_AREA_OFFSET: usize = align_up(crate::zones::ZONE_AREA_OFFSET + core::mem::size_of::<crate::zones::ZoneArea>(), REGION_ALIGN);
/// Bytes it takes, rounded to a region alignment (`curves`' area follows).
pub const DUE_AREA_BYTES: usize = align_up(core::mem::size_of::<DueArea>(), REGION_ALIGN);

const _: () = assert!(DUE_AREA_OFFSET + DUE_AREA_BYTES <= crate::layout::CORE_STATE_BYTES, "the due area fits the core-state region");

const fn align_up(n: usize, to: usize) -> usize {
    (n + to - 1) / to * to
}

/// The due list, the parked records and their scalars, borrowed together.
pub struct DueList<'a> {
    /// `DUE_RECORDS` slots (`len` live).
    pub records: &'a mut [DueRecord],
    /// `PARKED_RECORDS` slots (`area.parked` live).
    pub parked: &'a mut [DueRecord],
    pub area: &'a mut DueArea,
}

/// The `Due` region and the due area, viewed. An empty `Due` region (before Q1's stage B layout)
/// gives empty lists: every push fails, so callers take today's path.
pub fn view(regions: &mut Regions) -> DueList<'_> {
    let count = (regions.due.len() / DUE_RECORD_BYTES).min(DUE_RECORDS + PARKED_RECORDS);
    let area = &mut regions.core_state[DUE_AREA_OFFSET..DUE_AREA_OFFSET + DUE_AREA_BYTES];
    // SAFETY: the `Due` and core-state regions are 64-byte aligned (Layout) and zeroed at init;
    // all-zero bytes are a valid PendingRecord and DueArea; `count` records fit the region and the
    // area fits the core-state region (asserted above). Only this module views these bytes. An
    // empty region gives a zero-length slice, whose pointer needn't be aligned for reads.
    let (all, area) = unsafe {
        let all: &mut [DueRecord] = if count == 0 { &mut [] } else { core::slice::from_raw_parts_mut(regions.due.as_mut_ptr() as *mut DueRecord, count) };
        (all, &mut *(area.as_mut_ptr() as *mut DueArea))
    };
    let split = count.min(DUE_RECORDS);
    let (records, parked) = all.split_at_mut(split);
    DueList { records, parked, area }
}

impl DueList<'_> {
    /// This quantum's due records, in frame order.
    pub fn records(&self) -> &[DueRecord] {
        &self.records[..(self.area.len as usize).min(self.records.len())]
    }

    /// The parked records, in arrival order.
    pub fn parked(&self) -> &[DueRecord] {
        &self.parked[..(self.area.parked as usize).min(self.parked.len())]
    }

    /// Appends a due record; `false` (no change) when the list holds `DUE_RECORDS` already.
    pub fn push(&mut self, record: DueRecord) -> bool {
        // Z2a: append in frame order (pop_due already pops in order).
        let _ = record;
        false
    }

    /// Parks a record of a held voice; `false` (no change) when `PARKED_RECORDS` are parked.
    pub fn park(&mut self, record: DueRecord) -> bool {
        // Z2a.
        let _ = record;
        false
    }

    /// Voice `voice_id`'s due records in this quantum, in frame order.
    pub fn for_voice(&self, voice_id: u32) -> impl Iterator<Item = &DueRecord> + '_ {
        // Z2a may index per voice; the contract is the order.
        self.records().iter().filter(move |r| r.voice_id == voice_id)
    }

    /// Drops voice `voice_id`'s parked records (its voice ended or was stopped while held; RESET).
    pub fn drop_parked(&mut self, voice_id: u32) -> u32 {
        // Z2a.
        let _ = voice_id;
        0
    }
}

/// Starts quantum `frame`'s list: clears the due records and the voices' [`FLAG2_DUE`] bits left
/// from the last quantum. Called by `voices::render` before `pop_due` (H1, Z2a's).
pub fn begin_quantum(core: &mut Core, frame: u64) {
    // Z2a.
    let _ = (core, frame);
}

/// Routes one record `pop_due` returned for the quantum at `frame` (see [`Route`]). Counts
/// `parkedOverflow` itself; the caller counts `splitQuanta` once per quantum that splits.
pub fn route(core: &mut Core, record: &DueRecord, frame: u64) -> Route {
    // Z2a. Until then every record splits the quantum, as today.
    let _ = (core, record, frame);
    Route::Split
}

/// Moves every parked record whose voice is no longer gated and whose frame is before `before`
/// (the quantum's end) into the due list, in frame order; a record that doesn't fit stays parked
/// for the next quantum. Returns how many moved. Called after the gate's per-quantum pass.
pub fn release_parked(core: &mut Core, before: u64) -> u32 {
    // Z2a.
    let _ = (core, before);
    0
}

/// R10, for `group_rebase::apply` (C2d): shifts by `slip` frames every **parked** record and every
/// record **still in the pending queue** whose voice satisfies `is_member` and whose frame is ≥
/// `from_frame` (the group's stamp, or the hold's start), keeping the queue sorted and stable.
/// Records of non-members are never moved.
pub fn rebase(core: &mut Core, is_member: impl Fn(u32) -> bool, from_frame: u64, slip: u64) -> Rebased {
    // Z2a (the mechanism; C2d decides when and by how much).
    let _ = (core, is_member, from_frame, slip);
    Rebased::default()
}

/// RESET: both lists empty.
pub fn reset(core: &mut Core) {
    // Z2a.
    let _ = core;
}
