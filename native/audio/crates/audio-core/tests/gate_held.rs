//! 0166 M4a, C3 (api-and-models §10 row C3; architecture §4.3 rows "Started" and "Held"; R11; ADR
//! 0167 §2 "A stem that runs dry mid-piece holds its whole group"; owner decision 6; the waves plan's
//! M4a exit: "a held group resumes together"): the held-group null, a dip and an aligned resume.
//!
//! A started group of decoded and streamed members plays; one streamed member's worker stalls and
//! its ring runs dry. The whole group dips: every member takes the 5 ms starve fade **together** (one
//! gain for the whole mix), then holds silent with its position pinned, decoded members too. When the
//! worker catches up, every member resumes at offset 0 of one quantum with a 5 ms fade-in, from the
//! frame it was pinned at. Checked:
//! - before the dip the output nulls against the reference (1e-6);
//! - through the fade-out and the fade-in the output is **one gain** times the reference: the left and
//!   the right channels (whose members' mixes differ) give the same gain at every frame, and it falls
//!   from 1 to 0, then rises from 0 to 1;
//! - silence between the fade-out and the resume; every member's position pinned, all equal;
//! - after the fade-in the output nulls against the reference continued from the pinned frame:
//!   the resume is aligned, every member on one frame;
//! - one resume event (HELD) with the hold's length as its slip; `groupsHeld` 1.
//!
//! `a_dry_ring_dips_the_whole_group_and_it_resumes_aligned` is also a fixture
//! (`golden/gate-held.json`, replayed on the real wasm by `audioGoldenGate.test.ts`).

mod gate_common;

use audio_core::voices::state;
use audio_wire::generated as wire;
use gate_common::*;

const TOL: f32 = 1e-6;
const HELD: u16 = wire::GROUP_START_HELD as u16;
/// The 5 ms starve fade at 48 kHz (`stream::STARVE_FADE_SECONDS`).
const FADE: u64 = 240;

/// One quantum's record: its frame and every member's (state, position) after it.
struct Tick {
    frame: u64,
    members: Vec<(u8, f64)>,
}

struct Held {
    r: Rig,
    members: Vec<Member>,
    ticks: Vec<Tick>,
    stamp: u64,
}

/// Two decoded and two streamed members (stream 102 is the dry one: its first chunk only, then
/// nothing until `refill`), stamped on time at `stamp`, rendered to `until`.
fn held_scene(mut r: Rig, stamp: u64, refill: u64, until: u64, seed: u32) -> Held {
    let mut members = Vec::new();
    for k in 0..2u32 {
        r.clip(1 + k, seed + k, 48_000);
        members.push(Member { voice: voice(k), source: Source::Clip { id: 1 + k, seed: seed + k }, gain: 0.25 });
    }
    for k in 0..2u32 {
        let id = 101 + k;
        let s = seed ^ 0x7E1D_0000 ^ k;
        let mut f = Feed::new(id, s, 0);
        if id == 102 {
            f.stall_until = refill;
        }
        r.feeds.push(f);
        members.push(Member { voice: voice(2 + k), source: Source::Stream { id, seed: s }, gain: 0.25 });
    }
    r.run_to(8 * Q);
    let gate = wire::pack_gate(51, 4);
    let at = r.off(stamp);
    r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
    let mut ticks = Vec::new();
    while r.frame < until {
        let frame = r.frame;
        r.step();
        ticks.push(Tick { frame, members: members.iter().map(|m| (r.slot(m.voice).state, r.slot(m.voice).position)).collect() });
    }
    Held { r, members, ticks, stamp }
}

/// The checks; returns the resume's `(groupId, flags, slip, start)` events and the worst null.
fn check_held(h: &mut Held, what: &str) -> (Vec<(u16, u16, u32, u64)>, f32) {
    let (r, members, stamp) = (&h.r, &h.members, h.stamp);
    // The dip: the first frame the output leaves the uninterrupted reference.
    let first_off = (stamp..r.frame).find(|&t| {
        let (wl, wr) = r.reference(members, stamp, t);
        let (l, rr) = r.out(t);
        (l - wl).abs().max((rr - wr).abs()) > TOL
    });
    let dip = first_off.unwrap_or_else(|| panic!("{what}: the group never dips"));
    let pre = r.null(members, stamp, 0, dip, TOL);
    assert_eq!(pre.2, 0, "{what}: nulls before the dip");
    // The hold: quanta after the dip in which no member moves; every member's position pinned,
    // all equal.
    let held: Vec<&Tick> = h.ticks.windows(2).filter(|w| w[1].frame > dip && w[0].members.iter().zip(&w[1].members).all(|(a, b)| a.1 == b.1)).map(|w| &w[1]).collect();
    assert!(!held.is_empty(), "{what}: a hold (positions pinned)");
    let pinned = held[0].members[0].1;
    for t in &held {
        for (i, m) in t.members.iter().enumerate() {
            assert_eq!(m.1, pinned, "{what}: member {i} pinned at the group's frame at {}", t.frame);
            assert_ne!(m.0, state::FREE, "{what}: member {i} still a voice while held");
        }
    }
    let hold_from = held[0].frame;
    // The resume: the first quantum after the hold in which the members move again.
    let resume = h.ticks.iter().find(|t| t.frame > hold_from && t.members[0].1 != pinned).map(|t| t.frame).unwrap_or_else(|| panic!("{what}: never resumes"));
    // Aligned: from the resume every member's playhead has advanced the same frames from `pinned`.
    same_playhead(r, members, (pinned as u64) + (r.frame - resume), what);
    // Silence between the end of the fade-out and the resume.
    let mut quiet_from = resume;
    while quiet_from > dip && r.out(quiet_from - 1) == (0.0, 0.0) {
        quiet_from -= 1;
    }
    assert!(quiet_from < resume, "{what}: silent before the resume");
    assert!(quiet_from <= dip + FADE, "{what}: the fade-out lasts at most 5 ms (dip {dip}, silent from {quiet_from})");
    // The heard reference: before the dip from the stamp; from the resume, continued from `pinned`.
    let start_after = resume - pinned as u64;
    let post = r.null(members, start_after, resume + FADE, r.frame, TOL);
    assert_eq!(post.2, 0, "{what}: after the fade-in the output nulls against the reference continued from the pinned frame {pinned}: {post:?}");
    // One gain for the whole mix through each fade: L and R agree on it, and it is monotone.
    let common_gain = |from: u64, to: u64, start: u64, falling: bool| {
        let mut last = if falling { 1.0f32 } else { 0.0 };
        for t in from..to {
            let (wl, wr) = r.reference(members, start, t);
            let (l, rr) = r.out(t);
            if wl.abs() < 1e-3 || wr.abs() < 1e-3 {
                continue;
            }
            let (gl, gr) = (l / wl, rr / wr);
            assert!((gl - gr).abs() < 1e-3, "{what}: one gain for every member at {t} (L {gl}, R {gr})");
            assert!((-1e-4..=1.0 + 1e-4).contains(&gl), "{what}: gain {gl} at {t}");
            if falling {
                assert!(gl <= last + 1e-4, "{what}: the fade-out falls at {t}");
            } else {
                assert!(gl >= last - 1e-4, "{what}: the fade-in rises at {t}");
            }
            last = gl;
        }
    };
    common_gain(dip, quiet_from, stamp, true);
    common_gain(resume, resume + FADE, start_after, false);
    let worst = pre.0.max(post.0);
    let st = h.r.take();
    let starts = group_starts(&st);
    let resumes: Vec<_> = starts.iter().filter(|g| g.1 & HELD != 0).copied().collect();
    assert_eq!(resumes.len(), 1, "{what}: one resume event: {starts:?}");
    assert_eq!(resumes[0].3, resume, "{what}: the resume's frame");
    assert!(resumes[0].2 > 0, "{what}: the hold's length as its slip");
    assert_eq!(st.groups_held, 1, "{what}: groupsHeld");
    assert!(st.max_slip_frames >= resumes[0].2);
    assert_eq!((st.groups_abandoned, st.late_commands), (0, 0), "{what}");
    (starts, worst)
}

#[test]
#[ignore = "waits for C2c + C2d: the hold and the rebase are stubs at this base"]
fn a_dry_ring_dips_the_whole_group_and_it_resumes_aligned() {
    // The stamp at sample 77 of the quantum at 2,304; the dry ring's 4,096 frames run out 4,096
    // frames after it, and its worker sends again 20 quanta later.
    let stamp = 18 * Q + 77;
    let mut h = held_scene(Rig::recording(), stamp, stamp + 4_096 + 20 * Q, stamp + 24_000, 0x0C3_4001);
    let (starts, worst) = check_held(&mut h, "one dry ring");
    h.r.finish("gate-held", "2 decoded and 2 streamed stems start on time; one ring runs dry: the whole group dips together, holds pinned, and resumes aligned when the ring refills", &starts, (worst, TOL));
}

#[test]
#[ignore = "waits for C2c + C2d: the hold and the rebase are stubs at this base"]
fn every_hold_length_and_stamp_offset_dips_together_and_resumes_aligned() {
    // The worker sends again `refill_q` quanta after the dry ring's data runs out (0: during the
    // fade-out).
    for (n, refill_q) in [0u64, 2, 9, 40].into_iter().enumerate() {
        for s_mod in [0u64, 63, 127] {
            let stamp = 18 * Q + s_mod;
            let mut h = held_scene(Rig::new(48_000.0), stamp, stamp + 4_096 + refill_q * Q, stamp + 16_000, 0x0C3_4100 + n as u32);
            check_held(&mut h, &format!("refill {refill_q} quanta after the dry point, s_mod {s_mod}"));
        }
    }
}
