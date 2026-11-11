//! 0166 M4a, C2a (contracts-senior S2; architecture §2.2, §4.3, §5.3; api-and-models §3.1, §4.1,
//! §4.4): the group gate's state machine, one case per row of S2 and of §4.3's per-quantum table,
//! on the pure table API of `audio_core::groups` (no core: the table is a `[GroupEntry; 16]`).
//!
//! Leaf L-C2aa fills the cases tagged `#[ignore = "L-C2aa"]`.

#![allow(dead_code, unused_imports)]

use audio_core::groups::{
    self, admit_in, decide, find, flags2_group, flags2_with_group, flags2_without_group, give_up_frames, mark_abandoned, mark_started, note_admit, remove_member, reset_entries, state, Admit,
    Decision, GroupEntry, MemberLeft, MemberState, FLAG2_GATED, MAX_GROUPS, MAX_GROUP_MEMBERS,
};
use audio_core::QUANTUM;
use audio_wire::generated::{gate_group_id, gate_group_size, pack_gate};

/// 1 s at 48 kHz.
const GIVE_UP: u32 = 48_000;
const Q: u64 = QUANTUM as u64;

fn table() -> [GroupEntry; MAX_GROUPS] {
    [GroupEntry::default(); MAX_GROUPS]
}

const READY: MemberState = MemberState { present: true, ready: true, starving: false };
const NOT_READY: MemberState = MemberState { present: true, ready: false, starving: false };
const STARVING: MemberState = MemberState { present: true, ready: false, starving: true };

// --- PLAY gate and the table (S2: "PLAY gate: 10-bit id, 6-bit size; 16 core entries") ---

#[test]
#[ignore = "L-C2aa"]
fn ungated_play_is_ungated() {}

#[test]
#[ignore = "L-C2aa"]
fn gate_word_decodes_id_and_size() {}

#[test]
#[ignore = "L-C2aa"]
fn size_over_32_is_refused_and_counted() {}

#[test]
#[ignore = "L-C2aa"]
fn first_play_takes_an_entry_later_plays_join() {}

#[test]
#[ignore = "L-C2aa"]
fn seventeenth_group_starts_ungated_and_counts_table_full() {}

#[test]
#[ignore = "L-C2aa"]
fn flags2_carries_gated_bit_and_group_index() {}

// --- Stamped (S2: "incomplete at the stamp's quantum = not ready"; "ready = ...") ---

#[test]
#[ignore = "L-C2aa"]
fn stamp_ahead_waits() {}

#[test]
#[ignore = "L-C2aa"]
fn incomplete_group_at_its_stamp_waits() {}

#[test]
#[ignore = "L-C2aa"]
fn member_not_ready_holds_every_member_scheduled() {}

#[test]
#[ignore = "L-C2aa"]
fn decoded_member_is_always_ready() {}

#[test]
#[ignore = "L-C2aa"]
fn on_time_start_at_the_stamps_offset() {}

#[test]
#[ignore = "L-C2aa"]
fn late_start_at_offset_zero_with_slip() {}

#[test]
#[ignore = "L-C2aa"]
fn mark_started_records_start_frame_slip_and_late_flag() {}

// --- Started and held (S2: "a starving member holds the whole group, which resumes together") ---

#[test]
#[ignore = "L-C2aa"]
fn started_plays_on() {}

#[test]
#[ignore = "L-C2aa"]
fn started_with_a_starving_member_holds() {}

#[test]
#[ignore = "L-C2aa"]
fn held_stays_held_while_a_member_is_not_ready() {}

#[test]
#[ignore = "L-C2aa"]
fn held_resumes_together_when_all_ready_with_the_hold_as_slip() {}

#[test]
#[ignore = "L-C2aa"]
fn member_stopped_while_held_leaves_and_the_size_shrinks() {}

#[test]
#[ignore = "L-C2aa"]
fn virtual_member_keeps_the_same_rule() {}

// --- Give-up (S2: "held or never started past the give-up time is abandoned"; §5.3: 1 s) ---

#[test]
#[ignore = "L-C2aa"]
fn give_up_is_one_second_at_the_rate() {}

#[test]
#[ignore = "L-C2aa"]
fn stamped_past_one_second_is_abandoned() {}

#[test]
#[ignore = "L-C2aa"]
fn stamped_at_exactly_one_second_is_not_abandoned() {}

#[test]
#[ignore = "L-C2aa"]
fn held_past_one_second_is_abandoned() {}

#[test]
#[ignore = "L-C2aa"]
fn mark_abandoned_flags_the_event() {}

// --- Freeing (§4.3: "freed when every member ended or was stopped, or abandoned, or on RESET") ---

#[test]
#[ignore = "L-C2aa"]
fn entry_freed_when_its_last_member_leaves() {}

#[test]
#[ignore = "L-C2aa"]
fn freed_entry_is_taken_again() {}

#[test]
#[ignore = "L-C2aa"]
fn reset_clears_the_table() {}
