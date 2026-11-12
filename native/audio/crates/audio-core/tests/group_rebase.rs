//! 0166 M4a, C2d (architecture §3.6 "Held records", §4.3 rows "Stamped" and "Held"; R10; ADR 0167
//! §2): the slip rebase. A late group's records, parked or still pending, apply relative to its
//! actual start: one stamped at the stamp + `k` lands at the start + `k`. After a hold, one stamped
//! at or after the hold's start + `k` lands at the resume + `k`. Records of non-members, and a
//! member's records stamped before the hold's start, keep their frames.
//!
//! The acceptance is a null test: the late (or held) run against an on-time reference run with the
//! same records, delayed by the slip.

mod group_rig;

use audio_core::due;
use audio_core::group_rebase;
use audio_core::groups::state as gstate;
use audio_wire::generated as wire;
use group_rig::*;

/// The late run's slow ring: half a chunk, not ready at the stamp.
const SLOW: u32 = 2_048;

/// A decoded member (clip 1) and a streamed one (stream 101) in group `id` at [`STAMP`], with a
/// FADE of the decoded member at the stamp + 300 (to 0.25, a step: parked while the group waits)
/// and one of the streamed member at the stamp + 5,000 (to 0.5 over 64 frames: still pending at
/// the start).
fn late_scene(r: &mut Rig, id: u32, stream_frames: u32) -> Vec<u32> {
    let members = group(r, id, &[1], &[(101, stream_frames)]);
    r.submit(&[fade(members[0], STAMP + 300, 0.25, 0), fade(members[1], STAMP + 5_000, 0.5, 64)]);
    members
}

#[test]
fn a_fade_stamped_with_a_late_group_lands_at_the_groups_start_plus_its_offset() {
    let total = 80;
    let mut reference = Rig::new();
    let members = late_scene(&mut reference, 31, PLENTY);
    reference.render(total);
    assert_eq!(group_starts(&reference.take()), [(31, 0, 0, STAMP as u64)], "the reference starts on time");
    assert_eq!(reference.slot(members[0]).fade.value, 0.25);
    assert_eq!(reference.slot(members[1]).fade.value, 0.5);

    let mut late = Rig::new();
    late_scene(&mut late, 31, SLOW);
    late.render_through(STAMP as u64 + 400);
    assert_eq!(due::view(late.core.regions_mut()).parked().len(), 1, "the stamp + 300 FADE is parked");
    late.render(6);
    late.feed(101, PLENTY - SLOW);
    let start = late.frame;
    late.render(total - late.out.len() / QUANTUM_USIZE);
    let slip = start - STAMP as u64;
    assert_eq!(group_starts(&late.take()), [(31, wire::GROUP_START_LATE as u16, slip as u32, start)]);
    assert!(slip > 300, "the parked FADE's frame passed while the group waited");
    // The null: the late run is the reference delayed by the slip, the FADEs included (one parked,
    // one pending at the start).
    let lat = late.latency();
    let at = start as usize + lat;
    assert!(late.out[..at].iter().all(|&s| s == 0.0), "silent before the start");
    let b = &late.out[at..];
    let a = &reference.out[at - slip as usize..late.out.len() - slip as usize];
    assert_eq!(max_diff(b, a), 0.0, "null against the on-time run, delayed by the slip");
    // And the steps sit where they should: the decoded member's FADE at the start + 300.
    let before = late.at(start + 299) - reference.at(STAMP as u64 + 299);
    assert_eq!(before, 0.0);
    assert_ne!(reference.at(STAMP as u64 + 300), Rig::new_reference_without_fades_at(STAMP as u64 + 300));
}

impl Rig {
    /// The on-time scene's output at frame `f` with no FADEs (so a test can see a FADE changed it).
    fn new_reference_without_fades_at(f: u64) -> f32 {
        let mut r = Rig::new();
        group(&mut r, 31, &[1], &[(101, PLENTY)]);
        r.render_through(f);
        r.at(f)
    }
}

#[test]
fn a_late_groups_rebase_leaves_non_members_alone() {
    let mut r = Rig::new();
    let members = late_scene(&mut r, 32, SLOW);
    // An ungated voice with a FADE at the same frame as the member's.
    let other = voice(20);
    r.clip(7);
    r.submit(&[play(other, 7, false, STAMP, 0), fade(other, STAMP + 300, 0.0, 0)]);
    r.render_through(STAMP as u64 + 300 + Q);
    assert_eq!(r.slot(other).fade.value, 0.0, "the non-member's FADE applied at its own frame");
    assert_eq!(r.slot(members[0]).fade.value, 1.0, "the member's is parked");
    r.feed(101, 8_192);
    let start = r.frame;
    r.render(1);
    assert_eq!(r.slot(members[0]).fade.value, 1.0, "not yet: it lands at the start + 300");
    r.render_through(start + 300 + Q);
    assert_eq!(r.slot(members[0]).fade.value, 0.25);
    assert_eq!(r.entry(0).state, gstate::STARTED);
}

#[test]
fn a_zero_slip_or_a_free_entry_moves_nothing() {
    let mut r = Rig::new();
    late_scene(&mut r, 33, SLOW);
    r.render(1);
    let moved = group_rebase::apply(&mut r.core, 0, 0, 0);
    assert_eq!(moved, due::Rebased::default(), "slip 0");
    let moved = group_rebase::apply(&mut r.core, 5, 0, 1_000);
    assert_eq!(moved, due::Rebased::default(), "entry 5 is free");
    // Entry 0's members: both pending FADEs move, nothing else.
    let moved = group_rebase::apply(&mut r.core, 0, STAMP as u64, 128);
    assert_eq!(moved, due::Rebased { parked: 0, pending: 2 });
}

#[test]
fn records_stamped_after_the_holds_start_land_at_the_resume_plus_their_offset() {
    // Where the hold falls is deterministic: a probe run finds it, then both runs carry records at
    // frames relative to it.
    let total = 120;
    let streams = |short: bool| [(101, PLENTY), (102, if short { SHORT } else { PLENTY })];
    let mut probe = Rig::new();
    group(&mut probe, 34, &[], &streams(true));
    let p = hold_run(&mut probe, 102, 10, total);

    // In the fade-out (members still playing): its own frame. After the hold's start (parked while
    // held, or still pending at the resume): shifted by the slip.
    let records = |r: &mut Rig, members: &[u32]| {
        r.submit(&[
            fade(members[0], (p.q + 50) as u32, 0.8, 0),
            fade(members[1], (p.hold_start + 500) as u32, 0.5, 0),
            fade(members[0], (p.hold_start + 3_000) as u32, 0.4, 32),
        ]);
    };
    let mut reference = Rig::new();
    let m = group(&mut reference, 34, &[], &streams(false));
    records(&mut reference, &m);
    reference.render(total);

    let mut held = Rig::new();
    let m = group(&mut held, 34, &[], &streams(true));
    records(&mut held, &m);
    let h = hold_run(&mut held, 102, 10, total);
    assert_eq!((h.q, h.hold_start, h.resume), (p.q, p.hold_start, p.resume), "the records don't move the hold");
    assert!(h.slip > 500, "the hold start + 500 FADE came due while held");
    // check_null: equal before, the reference times the fade through the fade-out (the q + 50 FADE
    // in both at its own frame), then the reference delayed by the slip (both later FADEs rebased).
    check_null(&held, &reference, &h, true);
    assert_eq!(held.slot(m[1]).fade.value, 0.5);
    assert_eq!(held.slot(m[0]).fade.value, 0.4);
}
