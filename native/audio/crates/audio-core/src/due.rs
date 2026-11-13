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
//! Records that aren't per voice (MASTER, LISTENER, configuration tables:
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
//! Owner: **Z2a** (W2, on the flip branch `m4/in-voice`), on Q1's types, constants and views.
//!
//! **Taken records.** A due record that has applied (or that the gain loop holds) stays in its slot
//! with opcode 0 ([`DueList::take`]), so the voice ids stay for [`begin_quantum`] to clear the
//! `due` bits from, at a cost of the list's length, never of the live voices.

use audio_wire::generated::op;

use crate::core::{Core, Regions};
use crate::layout::REGION_ALIGN;

/// The opcode of a taken due record (no wire opcode is 0).
const TAKEN: u8 = 0;

/// `true` when `record` is voice `voice_id`'s and not yet taken.
#[inline]
pub fn is_for(record: &DueRecord, voice_id: u32) -> bool {
    record.voice_id == voice_id && record.op != TAKEN
}

/// One due or parked record: the scheduler's 48-byte pending record (api-and-models §3.1).
pub use crate::scheduler::PendingRecord as DueRecord;

/// Due records per quantum (api-and-models §4.5 `DUE_RECORDS`; architecture §5.3).
pub const DUE_RECORDS: usize = audio_wire::generated::DUE_RECORDS as usize;
/// Parked records across the core (§4.5 `PARKED_RECORDS`; R10: 2 held groups × 16 members × 4).
pub const PARKED_RECORDS: usize = audio_wire::generated::PARKED_RECORDS as usize;
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
    match record.op as u16 {
        op::FADE | op::STOP => Class::G,
        op::SET_PARAMS if record.mask == audio_wire::generated::SET_PARAMS_MASK_GAIN as u8 => Class::G,
        op::SET_PARAMS | op::SET_PAUSED | op::SEEK | op::SET_LOOP => Class::S,
        _ => Class::Quantum,
    }
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
    /// Not per voice, or the due list is full: the caller splits the quantum at the record's offset
    /// and applies it there, as today (`splitQuanta` counts once per quantum that splits).
    Split,
    /// Per voice, but its voice is gone (a stale id, an ended voice): applying it would change
    /// nothing, so it is dropped without a split (Z2a: today's apply drops it too).
    Dropped,
}

/// The sample of `record` in the quantum at `frame`: its offset, or 0 for a record already late.
#[inline]
pub fn offset(record: &DueRecord, frame: u64) -> usize {
    record.frame.saturating_sub(frame).min(crate::QUANTUM as u64 - 1) as usize
}

/// The ramp a class G `record` drives (`curves::ramp_of`): SET_PARAMS the `gain` ramp, FADE and
/// STOP the `fade` ramp (R5).
#[inline]
pub fn ramp_of(record: &DueRecord) -> u8 {
    if record.op as u16 == audio_wire::generated::op::SET_PARAMS { crate::curves::ramp_of::GAIN } else { crate::curves::ramp_of::FADE }
}

/// `true` for a class G record that ends its voice when its fade settles: a STOP with a fade, or a
/// FADE with "stop at end" over at least one frame (over 0 frames it ends the voice at once).
#[inline]
pub fn stops_at_end(record: &DueRecord) -> bool {
    use audio_wire::generated::op;
    match record.op as u16 {
        op::STOP => record.frames > 0,
        op::FADE => record.flags & 1 != 0 && record.frames > 0,
        _ => false,
    }
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

/// The `Due` region and the due area, viewed. (An empty region, as in a hand-built test core, gives
/// empty lists: every push fails, so callers take today's path.)
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

    /// Adds a due record in frame order, after any of the same frame (stable: `pop_due` pops in
    /// order, so this appends; a released parked record may land earlier). `false` (no change) when
    /// the list holds `DUE_RECORDS` already.
    pub fn push(&mut self, record: DueRecord) -> bool {
        let len = self.area.len as usize;
        if len >= self.records.len() {
            return false;
        }
        let mut i = len;
        while i > 0 && self.records[i - 1].frame > record.frame {
            self.records[i] = self.records[i - 1];
            i -= 1;
        }
        self.records[i] = record;
        self.area.len += 1;
        true
    }

    /// Parks a record of a held voice, after the others (arrival order); `false` (no change) when
    /// `PARKED_RECORDS` are parked.
    pub fn park(&mut self, record: DueRecord) -> bool {
        let n = self.area.parked as usize;
        if n >= self.parked.len() {
            return false;
        }
        self.parked[n] = record;
        self.area.parked += 1;
        true
    }

    /// Takes due record `at` out of the list: it has applied (or the gain loop has it). It keeps its
    /// slot and voice id with opcode 0, so the other records keep their places;
    /// [`for_voice`](Self::for_voice) and [`is_for`] no longer yield it.
    pub fn take(&mut self, at: usize) {
        if at < self.records().len() {
            self.records[at].op = TAKEN;
        }
    }

    /// Voice `voice_id`'s due records in this quantum not yet taken, in frame order.
    pub fn for_voice(&self, voice_id: u32) -> impl Iterator<Item = &DueRecord> + '_ {
        self.records().iter().filter(move |r| is_for(r, voice_id))
    }

    /// Drops voice `voice_id`'s parked records (its voice ended, or a PLAY replaced it); the others
    /// keep their order. Returns how many went.
    pub fn drop_parked(&mut self, voice_id: u32) -> u32 {
        let n = self.area.parked as usize;
        let mut kept = 0;
        for i in 0..n.min(self.parked.len()) {
            if self.parked[i].voice_id != voice_id {
                self.parked[kept] = self.parked[i];
                kept += 1;
            }
        }
        self.area.parked = kept as u32;
        (n - kept) as u32
    }
}

/// Starts quantum `frame`'s list: clears the due records and the voices' [`FLAG2_DUE`] bits left
/// from the last quantum. Called by `voices::render` before `pop_due` (H1, Z2a's).
///
/// **M5 (B2):** then the stamped configuration due in this quantum applies at its start
/// (`scheduler::apply_due_config`: `BUS_SLOT`, `BUS_PRESENCE`, in (frame, batch order); ARCH §4.7).
/// It runs here because this is the per-quantum entry before any voice renders or any pending
/// record pops; `sends::begin_quantum` and `bed::begin_quantum` ran before it, so a re-parent
/// reaches the voice-send chain gains one quantum later, under the dip at 0.
pub fn begin_quantum(core: &mut Core, frame: u64) {
    let len = view(core.regions_mut()).records().len();
    for i in 0..len {
        let id = view(core.regions_mut()).records[i].voice_id;
        crate::voices::set_due(core, id, false);
    }
    let list = view(core.regions_mut());
    list.area.len = 0;
    list.area.frame = frame;
    crate::scheduler::apply_due_config(core, frame);
}

/// The structural sequence a pending or due record belongs to (C27; API §4.2), 0 for none: a
/// `BUS_RAMP`'s `shape` bits 3–15 (`wire::ramp_sequence_id`), read through
/// `scheduler::shape_word`. Every other record has none.
///
/// **The hook for B1b (W3, class B).** This is the `sequenceId` link between the dip ramps and the
/// late-batch rule. Today no `BUS_RAMP` reaches the pending queue (`lanes::on_ramp` takes it at
/// submit, with its frame already shifted by `scheduler::sequence_shifts`), so this returns 0 for
/// every queued record. When B1b routes stamped `BUS_RAMP`s through the pending queue into the due
/// list as class B, it:
/// 1. stores the ramp's shape word in its `PendingRecord` and adds that record's arm to
///    `scheduler::shape_word`, so this function returns its sequence;
/// 2. when it pops a dip-down ramp whose frame is before the quantum's first frame q (a sequence
///    found late at pop, not at arrival), calls `scheduler::shift_sequence(core, id, s)` with
///    s = ⌈(q − F0) / 128⌉ × 128 — which moves the sequence's records still in the pending and
///    configuration queues and counts `lateCommands` once — and re-queues the popped ramp at
///    F0 + s itself (and any of the sequence's records already in this quantum's due list).
pub fn sequence_of(record: &DueRecord) -> u16 {
    match record.op as u16 {
        op::BUS_RAMP => audio_wire::generated::ramp_sequence_id(crate::scheduler::shape_word(record)) as u16,
        _ => 0,
    }
}

/// Routes one record `pop_due` returned for the quantum at `frame` (see [`Route`]). Counts
/// `parkedOverflow` itself; the caller counts `splitQuanta` once per quantum that splits.
/// - Not per voice ([`Class::Quantum`]): [`Route::Split`].
/// - Its voice gone: [`Route::Dropped`].
/// - Its voice held by the gate (`groups::FLAG2_GATED`): parked ([`Route::Parked`]); with the
///   parked records full, into the due list at its own frame, unrebased ([`Route::Overflow`],
///   `parkedOverflow` + 1).
/// - Otherwise into the due list, its voice flagged ([`Route::Voice`]).
///
/// With the due list full, a record that would go into it splits instead ([`Route::Split`]).
pub fn route(core: &mut Core, record: &DueRecord, frame: u64) -> Route {
    let _ = frame;
    if classify(record) == Class::Quantum {
        return Route::Split;
    }
    let Some(flags2) = crate::voices::live_flags2(core, record.voice_id) else { return Route::Dropped };
    let mut overflow = false;
    if flags2 & crate::groups::FLAG2_GATED != 0 {
        if view(core.regions_mut()).park(*record) {
            return Route::Parked;
        }
        crate::status::counters_mut(core).music.note_parked_overflow();
        overflow = true;
    }
    if !view(core.regions_mut()).push(*record) {
        return Route::Split;
    }
    crate::voices::set_due(core, record.voice_id, true);
    if overflow {
        Route::Overflow
    } else {
        Route::Voice
    }
}

/// Moves every parked record whose voice is no longer gated and whose frame is before `before`
/// (the quantum's end) into the due list, in frame order; a record that doesn't fit stays parked
/// for the next quantum. Returns how many moved. Called after the gate's per-quantum pass. A
/// parked record whose voice is gone is dropped; one whose frame has passed applies at sample 0,
/// not counted late (it was held).
pub fn release_parked(core: &mut Core, before: u64) -> u32 {
    let n = view(core.regions_mut()).parked().len();
    if n == 0 {
        return 0;
    }
    let (mut kept, mut moved) = (0usize, 0u32);
    for i in 0..n {
        let r = view(core.regions_mut()).parked[i];
        let keep = match crate::voices::live_flags2(core, r.voice_id) {
            None => false,
            Some(f) if f & crate::groups::FLAG2_GATED != 0 || r.frame >= before => true,
            Some(_) => {
                if view(core.regions_mut()).push(r) {
                    crate::voices::set_due(core, r.voice_id, true);
                    moved += 1;
                    false
                } else {
                    true
                }
            }
        };
        if keep {
            view(core.regions_mut()).parked[kept] = r;
            kept += 1;
        }
    }
    view(core.regions_mut()).area.parked = kept as u32;
    moved
}

/// R10, for `group_rebase::apply` (C2d): shifts by `slip` frames every **parked** record and every
/// record **still in the pending queue** whose voice satisfies `is_member` and whose frame is ≥
/// `from_frame` (the group's stamp, or the hold's start), keeping the queue sorted and stable.
/// Records of non-members are never moved.
pub fn rebase(core: &mut Core, is_member: impl Fn(u32) -> bool, from_frame: u64, slip: u64) -> Rebased {
    let mut parked = 0u32;
    let list = view(core.regions_mut());
    let n = list.parked().len();
    for r in list.parked[..n].iter_mut() {
        if r.frame >= from_frame && is_member(r.voice_id) {
            r.frame = r.frame.saturating_add(slip);
            parked += 1;
        }
    }
    let pending = crate::scheduler::rebase_pending(core, &is_member, from_frame, slip);
    Rebased { parked, pending }
}

/// RESET: both lists empty.
pub fn reset(core: &mut Core) {
    *view(core.regions_mut()).area = DueArea::default();
}
