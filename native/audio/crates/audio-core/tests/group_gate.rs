//! 0166 M4a, C2a (contracts-senior S2; architecture §2.2, §4.3, §5.3; api-and-models §3.1, §4.1,
//! §4.4): the group gate's state machine, one case per row of S2 and of §4.3's per-quantum table,
//! on the pure table API of `audio_core::groups` (no core: the table is a `[GroupEntry; 16]`).
//!

#![allow(dead_code, unused_imports)]

use audio_core::counters::Counters;
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
/// A decoded member: always ready (S2).
const DECODED: MemberState = MemberState { present: true, ready: true, starving: false };

/// A STAMPED entry with `members` present, as admission would leave it.
fn stamped(id: u16, size: u8, stamp: u64, members: &[u32]) -> GroupEntry {
    let mut e = GroupEntry { id, size, present: members.len() as u8, state: state::STAMPED, stamp_frame: stamp, ..GroupEntry::default() };
    e.members[..members.len()].copy_from_slice(members);
    e
}

fn with_state(mut e: GroupEntry, st: u8) -> GroupEntry {
    e.state = st;
    e
}

fn started(id: u16, size: u8, stamp: u64, members: &[u32]) -> GroupEntry {
    with_state(stamped(id, size, stamp, members), state::STARTED)
}

fn held(id: u16, size: u8, stamp: u64, members: &[u32], held_frames: u32) -> GroupEntry {
    let mut e = with_state(stamped(id, size, stamp, members), state::HELD);
    e.held_frames = held_frames;
    e
}

fn counters() -> Counters {
    Counters::default()
}

// --- PLAY gate and the table (S2: "PLAY gate: 10-bit id, 6-bit size; 16 core entries") ---

#[test]
fn ungated_play_is_ungated() {
    // Gate word 0 is an ungated PLAY: no entry is taken and no counter moves.
    let mut t = table();
    let before = t;
    let a = admit_in(&mut t, 0, 1, 5_000);
    assert_eq!(a, Admit::Ungated);
    assert_eq!(t, before, "an ungated PLAY leaves the table unchanged");

    let mut c = counters();
    note_admit(&mut c.music, a);
    assert_eq!(c.music.group_table_full, 0);
    assert_eq!(c.music.group_size_refused, 0);
}

#[test]
fn gate_word_decodes_id_and_size() {
    // id in bits 0-9, size - 1 in bits 10-15 (S2; §4.1).
    assert_eq!(gate_group_id(pack_gate(5, 4)), 5);
    assert_eq!(gate_group_size(pack_gate(5, 4)), 4);
    assert_eq!(gate_group_id(pack_gate(1023, 64)), 1023);
    assert_eq!(gate_group_size(pack_gate(1023, 64)), 64);
    assert_eq!(groups::Gate::from_word(pack_gate(5, 4)), Some(groups::Gate { id: 5, size: 4 }));
    assert_eq!(groups::Gate::from_word(pack_gate(1023, 64)), Some(groups::Gate { id: 1023, size: 64 }));
    // Id 0 is ungated, whatever the size bits say.
    assert_eq!(groups::Gate::from_word(0), None);
    assert_eq!(pack_gate(0, 5), 0);
}

#[test]
fn size_over_32_is_refused_and_counted() {
    // Size 33 is above MAX_GROUP_MEMBERS (32): refused, the table untouched, counted once.
    let mut t = table();
    let before = t;
    let a = admit_in(&mut t, pack_gate(5, 33), 1, 0);
    assert_eq!(a, Admit::SizeRefused);
    assert_eq!(t, before);

    let mut c = counters();
    note_admit(&mut c.music, a);
    assert_eq!(c.music.group_size_refused, 1);
    assert_eq!(c.music.group_table_full, 0);

    // Size 32 is the largest accepted.
    assert_eq!(admit_in(&mut t, pack_gate(5, 32), 1, 0), Admit::Member { index: 0 });
    assert_eq!(t[0].size, 32);
}

#[test]
fn first_play_takes_an_entry_later_plays_join() {
    let mut t = table();
    // The first PLAY takes the lowest free entry (0) with id, size, stamp, STAMPED, itself as member.
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 10, 5_000), Admit::Member { index: 0 });
    assert_eq!(t[0].id, 7);
    assert_eq!(t[0].size, 2);
    assert_eq!(t[0].present, 1);
    assert_eq!(t[0].state, state::STAMPED);
    assert_eq!(t[0].stamp_frame, 5_000);
    assert_eq!(t[0].members[0], 10);
    assert_eq!(find(&t, 7), Some(0));

    // A different group takes the next lowest free entry.
    assert_eq!(admit_in(&mut t, pack_gate(9, 1), 20, 5_000), Admit::Member { index: 1 });
    assert_eq!(find(&t, 9), Some(1));

    // A later PLAY with the same id joins its STAMPED entry while present < size.
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 11, 5_000), Admit::Member { index: 0 });
    assert_eq!(t[0].present, 2);
    assert_eq!(t[0].members[..2], [10, 11]);

    // A join past size is TableFull and leaves the table unchanged.
    let before = t;
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 12, 5_000), Admit::TableFull);
    assert_eq!(t, before, "a join past size leaves the table unchanged");

    // A join to a STARTED entry is TableFull too (its membership is fixed).
    t[0] = with_state(t[0], state::STARTED);
    let before = t;
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 13, 5_000), Admit::TableFull);
    assert_eq!(t, before, "a join to a started entry leaves the table unchanged");

    let mut c = counters();
    note_admit(&mut c.music, Admit::TableFull);
    assert_eq!(c.music.group_table_full, 1, "TableFull counts groupTableFull");
}

#[test]
fn seventeenth_group_starts_ungated_and_counts_table_full() {
    let mut t = table();
    for id in 1..=16u16 {
        assert_eq!(admit_in(&mut t, pack_gate(id as u32, 2), id as u32, 0), Admit::Member { index: (id - 1) as u8 });
    }
    let before = t;
    // A 17th distinct group finds no free entry.
    let a = admit_in(&mut t, pack_gate(17, 2), 99, 0);
    assert_eq!(a, Admit::TableFull);
    assert_eq!(t, before, "a 17th group leaves the table unchanged");

    let mut c = counters();
    note_admit(&mut c.music, a);
    assert_eq!(c.music.group_table_full, 1);
    assert_eq!(c.music.group_size_refused, 0);

    // A full table still takes a join to an existing group.
    assert_eq!(admit_in(&mut t, pack_gate(3, 2), 98, 0), Admit::Member { index: 2 });
}

#[test]
fn flags2_carries_gated_bit_and_group_index() {
    // Gated bit 2, group index in bits 3-6; bits 0, 1, 7 (ambisonic, due, bit 7) kept.
    assert_eq!(flags2_with_group(0, 3), FLAG2_GATED | (3 << 3));
    assert_eq!(FLAG2_GATED, 1 << 2);
    assert_eq!(flags2_with_group(0b1000_0011, 5), 0b1000_0011 | FLAG2_GATED | (5 << 3));
    assert_eq!(flags2_with_group(0, 15), FLAG2_GATED | (15 << 3));

    assert_eq!(flags2_group(flags2_with_group(0, 3)), Some(3));
    assert_eq!(flags2_group(flags2_with_group(0, 15)), Some(15));
    // The index reads only while the gated bit is set.
    assert_eq!(flags2_group(0b0001_1000), None);
    assert_eq!(flags2_group(0), None);

    // Clearing drops bits 2-6 and keeps 0, 1, 7.
    assert_eq!(flags2_without_group(flags2_with_group(0b1000_0011, 9)), 0b1000_0011);
    assert_eq!(flags2_without_group(0xFF), 0b1000_0011);
    assert_eq!(flags2_without_group(0b0000_0011), 0b0000_0011);
}

// --- Stamped (S2: "incomplete at the stamp's quantum = not ready"; "ready = ...") ---

#[test]
fn stamp_ahead_waits() {
    let frame = 1_000u64;
    // The stamp is a whole quantum ahead: nothing this quantum.
    let e = stamped(1, 1, frame + Q, &[1]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Wait);
    // The stamp is the last frame of this quantum: starts on time at offset 127.
    let e = stamped(1, 1, frame + Q - 1, &[1]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 127, slip: 0 });
}

#[test]
fn incomplete_group_at_its_stamp_waits() {
    // Size 2, one member arrived: not complete, so it waits even though the stamp is due.
    let frame = 1_000u64;
    let e = stamped(1, 2, frame, &[1]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Wait);
}

#[test]
fn member_not_ready_holds_every_member_scheduled() {
    // One member not ready (< 4,096 frames) keeps the whole group waiting, whichever member it is.
    let frame = 1_000u64;
    let e = stamped(1, 2, frame, &[1, 2]);
    let one_slow = |v: u32| if v == 2 { NOT_READY } else { READY };
    assert_eq!(decide(&e, frame, GIVE_UP, one_slow), Decision::Wait);
    let other_slow = |v: u32| if v == 1 { NOT_READY } else { READY };
    assert_eq!(decide(&e, frame, GIVE_UP, other_slow), Decision::Wait);
    // All ready: it starts.
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 0, slip: 0 });
}

#[test]
fn decoded_member_is_always_ready() {
    // A decoded member counts as ready; the group with it and a ready streamed member starts.
    let frame = 1_000u64;
    let e = stamped(1, 2, frame, &[1, 2]);
    let mixed = |v: u32| if v == 2 { DECODED } else { READY };
    assert_eq!(decide(&e, frame, GIVE_UP, mixed), Decision::Start { offset: 0, slip: 0 });
    // The streamed member not ready still blocks, the decoded one doesn't matter.
    let blocked = |v: u32| if v == 1 { NOT_READY } else { DECODED };
    assert_eq!(decide(&e, frame, GIVE_UP, blocked), Decision::Wait);
}

#[test]
fn on_time_start_at_the_stamps_offset() {
    let frame = 1_000u64;
    let e = stamped(1, 2, frame + 40, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 40, slip: 0 });
    // The stamp at the quantum's first frame is on time at offset 0.
    let e = stamped(1, 2, frame, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 0, slip: 0 });
}

#[test]
fn late_start_at_offset_zero_with_slip() {
    // The stamp is before this quantum: start at offset 0, slip = frame - stamp.
    let frame = 10_000u64;
    let e = stamped(1, 2, 9_700, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 0, slip: 300 });
    let e = stamped(1, 2, frame - 1, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Start { offset: 0, slip: 1 });
}

#[test]
fn mark_started_records_start_frame_slip_and_late_flag() {
    // On time: start_frame = frame + offset, slip 0, no LATE flag; the event is pending.
    let mut on_time = stamped(1, 2, 1_000, &[1, 2]);
    mark_started(&mut on_time, 1_000, 40, 0);
    assert_eq!(on_time.state, state::STARTED);
    assert_eq!(on_time.start_frame, 1_040);
    assert_eq!(on_time.slip, 0);
    assert_eq!(on_time.flags & groups::flag::LATE, 0);
    assert_ne!(on_time.flags & groups::flag::EVENT_PENDING, 0);

    // Late: start at the quantum's frame (offset 0), slip recorded, LATE set, event pending.
    let mut late = stamped(2, 2, 9_700, &[3, 4]);
    mark_started(&mut late, 10_000, 0, 300);
    assert_eq!(late.state, state::STARTED);
    assert_eq!(late.start_frame, 10_000);
    assert_eq!(late.slip, 300);
    assert_ne!(late.flags & groups::flag::LATE, 0);
    assert_ne!(late.flags & groups::flag::EVENT_PENDING, 0);
}

// --- Started and held (S2: "a starving member holds the whole group, which resumes together") ---

#[test]
fn started_plays_on() {
    // A started group plays on while its members are ready; a not-ready, non-starving member does
    // not hold it (only a starving one does), and the stamp being long past does not abandon it.
    let frame = 5 * GIVE_UP as u64;
    let e = started(1, 2, 1_000, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| READY), Decision::Play);
    assert_eq!(decide(&e, frame, GIVE_UP, |_| NOT_READY), Decision::Play);
}

#[test]
fn started_with_a_starving_member_holds() {
    // Any starving member holds the whole group.
    let e = started(1, 2, 1_000, &[1, 2]);
    let one = |v: u32| if v == 2 { STARVING } else { READY };
    assert_eq!(decide(&e, 1_000, GIVE_UP, one), Decision::Hold);
    assert_eq!(decide(&e, 1_000, GIVE_UP, |_| STARVING), Decision::Hold);
}

#[test]
fn held_stays_held_while_a_member_is_not_ready() {
    // Held with a member still below the threshold: wait, and don't resume or abandon.
    let e = held(1, 2, 1_000, &[1, 2], 1_000);
    let one_slow = |v: u32| if v == 2 { NOT_READY } else { READY };
    assert_eq!(decide(&e, 2_000, GIVE_UP, one_slow), Decision::Wait);
}

#[test]
fn held_resumes_together_when_all_ready_with_the_hold_as_slip() {
    // Every member at 4,096 frames again: resume at offset 0 with the hold's length as the slip.
    let e = held(1, 3, 1_000, &[1, 2, 3], 2_000);
    assert_eq!(decide(&e, 3_000, GIVE_UP, |_| READY), Decision::Resume { slip: 2_000 });
}

#[test]
fn member_stopped_while_held_leaves_and_the_size_shrinks() {
    // A size-3 held group loses member 2 (stopped). It leaves, size and present each drop by one,
    // the others keep their order, and the group resumes once the rest are ready.
    let mut t = table();
    t[0] = held(1, 3, 1_000, &[1, 2, 3], 1_500);
    assert_eq!(remove_member(&mut t, 0, 2), MemberLeft::Left);
    assert_eq!(t[0].size, 2);
    assert_eq!(t[0].present, 2);
    assert_eq!(t[0].members[..2], [1, 3]);
    assert_eq!(t[0].state, state::HELD);
    assert_eq!(decide(&t[0], 2_000, GIVE_UP, |_| READY), Decision::Resume { slip: 1_500 });
}

#[test]
fn virtual_member_keeps_the_same_rule() {
    // A virtual member is a streamed member for readiness: not ready blocks, ready allows.
    let frame = 1_000u64;
    let virt_not_ready = |v: u32| if v == 2 { NOT_READY } else { READY };
    let virt_ready = |_: u32| READY;
    let e = stamped(1, 2, frame, &[1, 2]);
    assert_eq!(decide(&e, frame, GIVE_UP, virt_not_ready), Decision::Wait);
    assert_eq!(decide(&e, frame, GIVE_UP, virt_ready), Decision::Start { offset: 0, slip: 0 });
    // Held, the same rule applies.
    let h = held(1, 2, frame, &[1, 2], 500);
    assert_eq!(decide(&h, frame, GIVE_UP, virt_not_ready), Decision::Wait);
    assert_eq!(decide(&h, frame, GIVE_UP, virt_ready), Decision::Resume { slip: 500 });
}

// --- Give-up (S2: "held or never started past the give-up time is abandoned"; §5.3: 1 s) ---

#[test]
fn give_up_is_one_second_at_the_rate() {
    assert_eq!(give_up_frames(48_000.0), 48_000);
    assert_eq!(give_up_frames(44_100.0), 44_100);
    assert_eq!(give_up_frames(96_000.0), 96_000);
}

#[test]
fn stamped_past_one_second_is_abandoned() {
    // More than 1 s past the stamp abandons the group, whatever the members (here: incomplete).
    let stamp = 1_000u64;
    let e = stamped(1, 2, stamp, &[1]);
    assert_eq!(decide(&e, stamp + GIVE_UP as u64 + 1, GIVE_UP, |_| NOT_READY), Decision::Abandon);
    // Even fully ready: still abandoned once past the give-up.
    let ready = stamped(1, 1, stamp, &[1]);
    assert_eq!(decide(&ready, stamp + GIVE_UP as u64 + 1, GIVE_UP, |_| READY), Decision::Abandon);
}

#[test]
fn stamped_at_exactly_one_second_is_not_abandoned() {
    // frame == stamp + give_up is not past it: an incomplete group waits.
    let stamp = 1_000u64;
    let e = stamped(1, 2, stamp, &[1]);
    assert_eq!(decide(&e, stamp + GIVE_UP as u64, GIVE_UP, |_| READY), Decision::Wait);
}

#[test]
fn held_past_one_second_is_abandoned() {
    // Held more than 1 s abandons even with every member ready; exactly 1 s still resumes.
    let e = held(1, 2, 1_000, &[1, 2], GIVE_UP + 1);
    assert_eq!(decide(&e, 2_000, GIVE_UP, |_| READY), Decision::Abandon);
    let at_limit = held(1, 2, 1_000, &[1, 2], GIVE_UP);
    assert_eq!(decide(&at_limit, 2_000, GIVE_UP, |_| READY), Decision::Resume { slip: GIVE_UP });
}

#[test]
fn mark_abandoned_flags_the_event() {
    // ABANDONED and EVENT_PENDING set; the state is kept (a STAMPED group stays STAMPED).
    let mut e = stamped(1, 2, 1_000, &[1]);
    mark_abandoned(&mut e);
    assert_ne!(e.flags & groups::flag::ABANDONED, 0);
    assert_ne!(e.flags & groups::flag::EVENT_PENDING, 0);
    assert_eq!(e.state, state::STAMPED);

    let mut started_e = started(2, 2, 1_000, &[1, 2]);
    mark_abandoned(&mut started_e);
    assert_eq!(started_e.state, state::STARTED);
}

// --- Freeing (§4.3: "freed when every member ended or was stopped, or abandoned, or on RESET") ---

#[test]
fn entry_freed_when_its_last_member_leaves() {
    let mut t = table();
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 5, 0), Admit::Member { index: 0 });
    assert_eq!(admit_in(&mut t, pack_gate(7, 2), 6, 0), Admit::Member { index: 0 });

    // A voice that isn't a member: NotMember, the table unchanged (also for an out-of-range index).
    let before = t;
    assert_eq!(remove_member(&mut t, 0, 99), MemberLeft::NotMember);
    assert_eq!(remove_member(&mut t, 15, 5), MemberLeft::NotMember);
    assert_eq!(t, before);

    // The first member leaves: still taken, size and present shrink.
    assert_eq!(remove_member(&mut t, 0, 5), MemberLeft::Left);
    assert_eq!(t[0].size, 1);
    assert_eq!(t[0].present, 1);
    assert_eq!(t[0].members[0], 6);

    // The last member leaves: freed.
    assert_eq!(remove_member(&mut t, 0, 6), MemberLeft::Freed);
    assert_eq!(t[0], GroupEntry::default());
}

#[test]
fn freed_entry_is_taken_again() {
    let mut t = table();
    assert_eq!(admit_in(&mut t, pack_gate(1, 1), 1, 0), Admit::Member { index: 0 });
    assert_eq!(admit_in(&mut t, pack_gate(2, 1), 2, 0), Admit::Member { index: 1 });
    assert_eq!(remove_member(&mut t, 0, 1), MemberLeft::Freed);
    // The next new group takes the freed (lowest) entry.
    assert_eq!(admit_in(&mut t, pack_gate(3, 1), 3, 0), Admit::Member { index: 0 });
    assert_eq!(t[0].id, 3);
    assert_eq!(find(&t, 2), Some(1));
    assert_eq!(find(&t, 1), None);
}

#[test]
fn reset_clears_the_table() {
    let mut t = table();
    admit_in(&mut t, pack_gate(1, 2), 1, 0);
    admit_in(&mut t, pack_gate(2, 2), 2, 0);
    t[0] = with_state(t[0], state::STARTED);
    reset_entries(&mut t);
    for e in &t {
        assert_eq!(*e, GroupEntry::default());
    }
}
