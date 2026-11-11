//! 0166 M4-0, the due list (Z2a; api-and-models §3.1 "Due list", "Class G and class S", §9 "Unit
//! (cargo)"; architecture §4.4 "`render`", §3.6 "Held records"; ADR 0167 §1.1; rulings R2, R3, R10).
//!
//! `pop_due` still pops every stamped record due in a quantum; `due::route` sends a per-voice record
//! into the quantum's due list (setting its voice's `due::FLAG2_DUE`) or parks it (its voice held by
//! the gate, `groups::FLAG2_GATED`), and the quantum renders once: the record applies inside its own
//! voice, at its own sample. Records that aren't per voice, and a quantum with more than
//! `due::DUE_RECORDS` due records, still split the quantum and count `splitQuanta` once per quantum.
//! A due record at a voice's own start frame applies before its first sample. Past
//! `due::PARKED_RECORDS` parked records a record applies at its own frame, unrebased, and counts
//! `parkedOverflow`. `due::rebase` shifts a held group's parked and still pending records.
//!
//! Leaf **L-Z2aa** fills these cases (tree: §9's cargo list). Records go in as BATCH messages through
//! `scheduler::submit` and render through `Core::process` (see `in_voice_hooks.rs`, `paused.rs`), or,
//! for the list's own API, through `due::view`, `due::route` and `due::rebase` on a core. A voice is
//! gated for a test by setting `groups::FLAG2_GATED` in its slot's `flags2` byte in the `Voices`
//! region (`index * layout::VOICE_SLOT_BYTES + core::mem::offset_of!(VoiceSlot, flags2)`): no task
//! before C2b sets it.

#![allow(unused_imports)]

mod common;

use audio_core::due::{self, Class, Route, DUE_RECORDS, FLAG2_DUE, PARKED_RECORDS};
use audio_core::groups::FLAG2_GATED;
use audio_core::scheduler::{self, PendingRecord};
use audio_core::{status, voices};
use audio_wire::generated as wire;
use common::*;

// --- Class routing (§3.1 "Class G and class S") ---

/// `due::classify`: FADE, STOP (fade 0 and with a fade) and SET_PARAMS with the gain bit alone are
/// class G; SET_PARAMS with any other bit (pitch, direction, `lpHz`, score, bus, flags; gain with
/// another bit), SET_PAUSED, SEEK and SET_LOOP are class S; any other opcode is `Class::Quantum`.
#[test]
#[ignore = "L-Z2aa"]
fn classify_follows_the_class_table() {}

/// A stamped record for a live, ungated voice: `route` returns `Route::Voice`, the record is in the
/// list (`DueList::records`, `for_voice`) and its voice carries `FLAG2_DUE`; the next
/// `due::begin_quantum` empties the list and clears the bit.
#[test]
#[ignore = "L-Z2aa"]
fn a_per_voice_record_goes_into_the_due_list_and_flags_its_voice() {}

/// A record for a stale id or an ended voice: `Route::Dropped`, nothing in the list, no flag, no
/// split.
#[test]
#[ignore = "L-Z2aa"]
fn a_record_for_a_gone_voice_is_dropped_without_a_split() {}

/// Every per-voice record (STOP with fade 0 and with a fade, FADE, SET_PARAMS gain and pitch,
/// SET_PAUSED, SEEK, SET_LOOP), stamped at a sample inside a quantum on one voice among several,
/// lands on that voice at that sample (its output against the expected curve, as
/// `golden_native.rs` and `paused.rs` check them), the other voices' output is bit-identical to a
/// twin core without the record, and `splitQuanta` stays 0.
#[test]
#[ignore = "L-Z2aa"]
fn every_per_voice_record_reaches_its_voice_at_its_sample() {}

/// Several records for one voice in one quantum, at different samples and at the same sample,
/// apply in frame order, and in arrival order at one frame (e.g. two SET_PARAMS gains at one frame:
/// the second wins).
#[test]
#[ignore = "L-Z2aa"]
fn one_voices_records_apply_in_frame_order_and_stably() {}

/// §3.1: "A due record at a voice's own start frame applies before its first sample": a stamped
/// PLAY at sample k with a FADE to 0 over 0 frames, or a SET_PARAMS gain, stamped at the same frame:
/// the voice's first sample already has it. A record stamped before the start (same quantum)
/// applies too, in order.
#[test]
#[ignore = "L-Z2aa"]
fn a_record_at_a_voices_start_frame_applies_before_its_first_sample() {}

/// A record whose frame has passed applies at sample 0 of the next quantum, counts in
/// `lateCommands` and `maxLatenessFrames` as before, and doesn't split.
#[test]
#[ignore = "L-Z2aa"]
fn a_late_record_applies_at_sample_0_and_counts_late() {}

// --- Overflow (§3.1: "so does a quantum with more than 256 due records") ---

/// More than `DUE_RECORDS` records due in one quantum: the first `DUE_RECORDS` go into the list;
/// each one past it splits the quantum at its sample (`Route::Split`) and applies there. Every
/// record still lands on its sample, and `splitQuanta` counts the quantum once.
#[test]
#[ignore = "L-Z2aa"]
fn past_due_records_a_quantum_splits_and_counts_split_quanta_once() {}

// --- Parked records (§3.1, architecture §3.6, R10) ---

/// A record for a gated voice: `Route::Parked`, in `DueList::parked`, not applied, not counted late
/// while held, the voice not flagged.
#[test]
#[ignore = "L-Z2aa"]
fn a_held_voices_record_is_parked_not_applied() {}

/// Past `PARKED_RECORDS` parked records, a held voice's record returns `Route::Overflow`: it goes
/// into the due list and applies at its own frame, unrebased, and `parkedOverflow` counts it
/// (`status::counters(..).music.parked_overflow`).
#[test]
#[ignore = "L-Z2aa"]
fn past_parked_records_a_record_applies_unrebased_and_counts_parked_overflow() {}

/// `due::release_parked(core, before)`: once the voice's `FLAG2_GATED` is clear, its parked records
/// with a frame before `before` move into the due list in frame order and apply at their samples in
/// that quantum; later ones stay parked; a still gated voice's stay parked; a gone voice's are
/// dropped.
#[test]
#[ignore = "L-Z2aa"]
fn released_parked_records_apply_in_the_quantum_their_frame_falls_in() {}

/// R10, `due::rebase(core, is_member, from_frame, slip)`: every parked record and every record still
/// in the pending queue of a member, with frame ≥ `from_frame`, moves by `slip` (the counts come
/// back in `Rebased`); records before `from_frame` and every non-member's record stay; the pending
/// queue stays sorted by frame and stable (pop it with `scheduler::pop_due`).
#[test]
#[ignore = "L-Z2aa"]
fn rebase_shifts_members_parked_and_pending_records_and_keeps_the_queue_sorted() {}

/// `DueList::drop_parked(voice)` removes that voice's parked records only (returns how many); a
/// voice that ends (or a PLAY replacing it) drops its own; RESET (`scheduler::reset`) empties the
/// due list and the parked records.
#[test]
#[ignore = "L-Z2aa"]
fn drop_parked_and_reset_empty_the_lists() {}

// --- The shape word in a 48-byte record (api-and-models §4.2; Z2a's ruling) ---

/// `scheduler::shape_word` reads back a stamped FADE's, STOP's and gain-only SET_PARAMS' `shape`
/// word; a shaped SET_PARAMS with the gain bit and others is queued as two records at one frame
/// (gain alone with the shape, then the rest with none: `scheduler::pending_len` 2); an unshaped
/// one stays one record.
#[test]
#[ignore = "L-Z2aa"]
fn the_shape_word_rides_in_the_record() {}
