//! 0166 M4a, C2c (architecture §4.3 rows "Started" and "Held"; R11; ADR 0167 §2, owner decision 6):
//! the group hold on starve. When one member's ring runs dry, the whole group fades out together
//! over the hold's fade (the 5 ms starve fade rounded up to whole quanta), holds silent with every
//! position pinned, and resumes together, aligned, with a 5 ms fade-in once every ring holds 4,096
//! frames again. Held more than 1 s, the group is abandoned.
//!
//! The acceptance is a null test: a run with a hold against a reference run of the same group that
//! never starves. Before the hold they are equal; through the fade the held run is the reference
//! times the fade; through the hold it is silent; after the resume's fade-in it is the reference
//! delayed by the slip, sample for sample.

mod group_rig;

use audio_core::group_hold::{self, must_hold, on_starve, try_resume, StarveAction, FLAG_FADING};
use audio_core::groups::{self, flag, state as gstate, GroupEntry};
use audio_core::voices::{self, state};
use audio_wire::generated as wire;
use group_rig::*;

#[test]
fn one_dry_ring_dips_the_whole_group_and_it_resumes_aligned() {
    let total = 120;
    let streams = [(101, PLENTY), (102, PLENTY), (103, PLENTY)];
    let mut reference = Rig::new();
    group(&mut reference, 21, &[], &streams);
    reference.render(total);
    assert_eq!(reference.take().groups_held, 0, "the reference never holds");

    let mut held = Rig::new();
    let members = group(&mut held, 21, &[], &[(101, PLENTY), (102, PLENTY), (103, SHORT)]);
    let h = hold_run(&mut held, 103, 10, total);
    let span = check_null(&held, &reference, &h, true);
    assert!(span > 40 * QUANTUM_USIZE, "a long null ({span} frames)");
    same_playhead(&held, &members);
    // The reference's playheads, the slip earlier.
    assert_eq!(held.slot(members[0]).position + h.slip as f64, reference.slot(members[0]).position);
    // No member reported starved: the group held, not the voice.
    assert!(held.take().starved.is_empty());
}

#[test]
fn decoded_and_streamed_members_hold_and_resume_on_one_frame() {
    // Decoded members fade by their mix ramp, streamed ones by their ring's gain: the same fade.
    let total = 110;
    let mut reference = Rig::new();
    group(&mut reference, 22, &[1, 2], &[(101, PLENTY), (102, PLENTY)]);
    reference.render(total);

    let mut held = Rig::new();
    let members = group(&mut held, 22, &[1, 2], &[(101, SHORT), (102, PLENTY)]);
    let h = hold_run(&mut held, 101, 7, total);
    check_null(&held, &reference, &h, true);
    same_playhead(&held, &members);
}

#[test]
fn a_ring_refilled_during_the_fade_resumes_at_once_with_no_slip() {
    let total = 90;
    let mut reference = Rig::new();
    group(&mut reference, 23, &[], &[(101, PLENTY), (102, PLENTY)]);
    reference.render(total);

    let mut held = Rig::new();
    group(&mut held, 23, &[], &[(101, PLENTY), (102, SHORT)]);
    while held.entry(0).flags & FLAG_FADING == 0 {
        held.render(1);
    }
    let q = held.frame - Q;
    let _ = held.take();
    // The data comes back mid-fade: the fade still runs to its end (the members are already on
    // their way down), then the group resumes in the very next quantum, slip 0.
    held.feed(102, 8_192);
    held.render_through(q + hold_fade());
    held.render(total - held.out.len() / QUANTUM_USIZE);
    let s = held.take();
    let hold_start = q + hold_fade();
    assert_eq!(group_starts(&s), [(23, wire::GROUP_START_HELD as u16, 0, hold_start)]);
    let h = Hold { q, hold_start, resume: hold_start, slip: 0 };
    check_null(&held, &reference, &h, true);
}

#[test]
fn a_group_held_more_than_one_second_is_abandoned() {
    let mut r = Rig::new();
    let members = group(&mut r, 24, &[1], &[(101, PLENTY), (102, SHORT)]);
    while r.entry(0).flags & FLAG_FADING == 0 {
        r.render(1);
    }
    let hold_start = r.frame - Q + hold_fade();
    // Held exactly 1 s: still held (the give-up is strict).
    r.render_through(hold_start + 48_000);
    assert_eq!(r.entry(0).state, gstate::HELD);
    assert!(members.iter().all(|&m| r.slot(m).state == state::PLAYING));
    let _ = r.take();
    r.render(2);
    for &m in &members {
        assert_eq!(r.slot(m).state, voices::state::FREE, "member {m:#x} ended");
    }
    assert!(groups::entries_of(r.core.regions().groups).iter().all(|e| e.state == gstate::FREE));
    let s = r.take();
    let starts = group_starts(&s);
    assert_eq!(starts.len(), 1);
    assert_eq!((starts[0].0, starts[0].1), (24, wire::GROUP_START_ABANDONED as u16));
    assert!(starts[0].2 > 48_000, "the slip is the time held");
    assert_eq!(s.groups_abandoned, 1);
}

#[test]
fn an_ungated_stream_voice_still_starves_alone() {
    let mut r = Rig::new();
    let members = group(&mut r, 25, &[], &[(101, PLENTY), (102, PLENTY)]);
    r.open(103);
    r.feed(103, 4_096);
    r.submit(&[play(voice(9), 103, true, STAMP, 0)]);
    r.render(60);
    let s = r.take();
    assert_eq!(s.starved, [voice(9)], "the ungated voice starved, alone");
    assert_eq!(s.groups_held, 0);
    assert_eq!(r.entry(0).state, gstate::STARTED, "the group plays on");
    same_playhead(&r, &members);
}

fn entry(st: u8, members: &[u32]) -> GroupEntry {
    let mut e = GroupEntry { id: 5, size: members.len() as u8, present: members.len() as u8, state: st, ..GroupEntry::default() };
    e.members[..members.len()].copy_from_slice(members);
    e
}

#[test]
fn on_starve_holds_a_started_group_once_and_is_idempotent() {
    let mut t = [GroupEntry::default(), entry(gstate::STARTED, &[7, 8])];
    let mut held = 0u16;
    assert_eq!(on_starve(&mut t, 1, 9, 0, &mut held), StarveAction::Alone, "not a member");
    assert_eq!(on_starve(&mut t, 0, 7, 0, &mut held), StarveAction::Alone, "a free entry");
    assert_eq!(on_starve(&mut t, 1, 7, 0, &mut held), StarveAction::Group);
    assert_eq!((t[1].state, t[1].held_frames, held), (gstate::HELD, 0, 1));
    assert!(must_hold(&t, 1));
    // Every quantum, every starving member: no second count, no change.
    let before = t[1];
    assert_eq!(on_starve(&mut t, 1, 8, 128, &mut held), StarveAction::Group);
    assert_eq!(on_starve(&mut t, 1, 7, 256, &mut held), StarveAction::Group);
    assert_eq!((t[1], held), (before, 1));
    // A joint fade under way: nothing to do (the look-ahead counted it).
    let mut f = [entry(gstate::STARTED, &[7])];
    f[0].flags = FLAG_FADING;
    let before = f[0];
    assert_eq!(on_starve(&mut f, 0, 7, 0, &mut held), StarveAction::Group);
    assert_eq!((f[0], held), (before, 1));
    assert!(!must_hold(&f, 0), "the members play through the fade");
    // A stamped group's member starves alone (it can't: the gate waits for every ring).
    let mut s = [entry(gstate::STAMPED, &[7])];
    assert_eq!(on_starve(&mut s, 0, 7, 0, &mut held), StarveAction::Alone);
    assert_eq!(s[0].state, gstate::STAMPED);
    assert!(!must_hold(&s, 0) && !must_hold(&s, 3));
}

#[test]
fn try_resume_counts_the_hold_and_resumes_with_its_length() {
    let mut e = entry(gstate::HELD, &[7]);
    e.flags = flag::LATE;
    assert_eq!(try_resume(&mut e, 1_000, false), None);
    assert_eq!(try_resume(&mut e, 1_128, false), None);
    assert_eq!(e.held_frames, 256);
    assert_eq!(try_resume(&mut e, 1_256, true), Some(256));
    assert_eq!((e.state, e.start_frame, e.slip, e.held_frames), (gstate::STARTED, 1_256, 256, 0));
    assert_eq!(e.flags, flag::RESUMED | flag::EVENT_PENDING, "a resume event, not late");
    let event = groups::event_of(&e);
    assert_eq!((event.flags, event.slip_frames, event.start_frame), (wire::GROUP_START_HELD as u16, 256, 1_256));
    assert_eq!(try_resume(&mut e, 1_384, true), None, "not held");
}

#[test]
fn the_hold_fade_is_the_starve_fade_in_whole_quanta() {
    assert_eq!(group_hold::hold_fade_frames(48_000.0), 256);
    assert_eq!(group_hold::hold_fade_frames(44_100.0), 256);
    assert_eq!(group_hold::hold_fade_frames(96_000.0), 512);
    assert_eq!(group_hold::hold_fade_frames(192_000.0), 1_024);
    assert_eq!(group_hold::hold_fade_frames(8_000.0), 128);
}
