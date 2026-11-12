//! 0166 M4a, C3 (api-and-models §10 row C3, acceptance "null against the reference after a late
//! start"; the waves plan's M4a exit: "a late ring delays all equally and they still null").
//!
//! A slow ring holds the whole group: no member sounds, decoded ones included, until the first
//! quantum in which every ring is ready; then every member starts on that frame, and the output
//! nulls against the reference **shifted by the slip** (every member's source from the late start,
//! not from the stamp). The start is reported once, LATE, with its slip; `groupsLate` and
//! `maxSlipFrames` agree and nothing else is counted. `gate_common` has the rig.
//!
//! `one_slow_ring_delays_eight_stems_equally_and_they_null_from_the_late_start` is also a fixture
//! (`golden/gate-late.json`) that `audioGoldenGate.test.ts` replays on the real wasm.

mod gate_common;

use audio_wire::generated as wire;
use gate_common::*;

const TOL: f32 = 1e-6;
const LATE: u16 = wire::GROUP_START_LATE as u16;

/// Four decoded members (clips 1..4) and four streamed (streams 101..104), gains 1/8. Every ring
/// is ready at `ready` except stream `slow`, ready at `slow_at`.
fn eight(r: &mut Rig, ready: u64, slow: u32, slow_at: u64, seed: u32) -> Vec<Member> {
    let mut out = Vec::new();
    for k in 0..4u32 {
        r.clip(1 + k, seed + k, 48_000);
        out.push(Member { voice: voice(k), source: Source::Clip { id: 1 + k, seed: seed + k }, gain: 0.125 });
    }
    for k in 0..4u32 {
        let id = 101 + k;
        let s = seed ^ 0x5A5A_0000 ^ k;
        r.feeds.push(Feed::new(id, s, if id == slow { slow_at } else { ready }));
        out.push(Member { voice: voice(4 + k), source: Source::Stream { id, seed: s }, gain: 0.125 });
    }
    out
}

/// Submits the gated PLAYs of `members` (group `id`) stamped at `stamp`.
fn stamp_group(r: &mut Rig, members: &[Member], id: u32, stamp: u64) {
    let gate = wire::pack_gate(id, members.len() as u32);
    let at = r.off(stamp);
    r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
}

/// The late start's checks: silence until `start`, one frame for every member, the null from
/// `start`, and the one LATE event with slip `start − stamp`.
fn check_late(r: &mut Rig, members: &[Member], id: u16, stamp: u64, start: u64, what: &str) -> (f32, Vec<(u16, u16, u32, u64)>) {
    assert!(start > stamp, "{what}: a late case");
    same_playhead(r, members, r.frame - start, what);
    let from = r.out_origin;
    let null = r.null(members, start, from, r.frame, TOL);
    assert_eq!(null.2, 0, "{what}: the output nulls against the reference started at {start} (the stamp {stamp} + the slip): {null:?}");
    // And not against the unshifted reference: the slip is audible as an offset, not absorbed.
    let unshifted = r.null(members, stamp, from, r.frame, TOL);
    assert!(unshifted.2 > 0, "{what}: the reference from the stamp doesn't null");
    let st = r.take();
    let slip = (start - stamp) as u32;
    let starts = group_starts(&st);
    assert_eq!(starts, [(id, LATE, slip, start)], "{what}: one LATE start, its slip");
    assert_eq!((st.groups_late, st.max_slip_frames), (1, slip), "{what}");
    assert_eq!((st.late_commands, st.stream_starts_late, st.groups_abandoned), (0, 0, 0), "{what}: a held member isn't late, the group is");
    (null.0, starts)
}

#[test]
fn one_slow_ring_delays_eight_stems_equally_and_they_null_from_the_late_start() {
    let mut r = Rig::recording();
    // The stamp at sample 77 of the quantum at 2,304; stream 103's data lands 8 quanta after that
    // quantum began, so the group starts at 3,328: a slip of 947 frames.
    let stamp = 18 * Q + 77;
    let slow_at = 26 * Q;
    let members = eight(&mut r, 0, 103, slow_at, 0x0C3_2001);
    r.run_to(8 * Q);
    stamp_group(&mut r, &members, 31, stamp);
    r.run_to(slow_at);
    for m in &members {
        assert_eq!(r.slot(m.voice).state, audio_core::voices::state::SCHEDULED, "every member waits for the slow ring");
    }
    assert!(r.left.iter().chain(&r.right).all(|&s| s == 0.0), "nothing sounds while the group waits");
    r.run_to(slow_at + 24_000);
    let (err, starts) = check_late(&mut r, &members, 31, stamp, slow_at, "one slow ring");
    r.finish("gate-late", "8 stems (4 decoded, 4 streamed) stamped at sample 77 of a quantum; one ring is ready 8 quanta late: every member starts on that quantum and the sum nulls against the reference shifted by the 947-frame slip", &starts, (err, TOL));
}

#[test]
fn slow_rings_landing_in_different_quanta_start_the_group_with_the_last() {
    let mut r = Rig::new(48_000.0);
    let stamp = 10 * Q + 31;
    let members = eight(&mut r, 0, 102, 13 * Q, 0x0C3_2002);
    // Two more slow rings: 104 at 15 quanta, 101 at 21 (the last).
    r.feeds.iter_mut().find(|f| f.id == 104).unwrap().ready_at = 15 * Q;
    r.feeds.iter_mut().find(|f| f.id == 101).unwrap().ready_at = 21 * Q;
    stamp_group(&mut r, &members, 32, stamp);
    r.run_to(21 * Q);
    assert!(members.iter().all(|m| r.slot(m.voice).state == audio_core::voices::state::SCHEDULED), "held until the last ring");
    r.run_to(21 * Q + 8_192);
    check_late(&mut r, &members, 32, stamp, 21 * Q, "three slow rings");
}

#[test]
fn a_partial_first_chunk_holds_the_group_until_the_ring_holds_4096_frames() {
    let mut r = Rig::new(48_000.0);
    let stamp = 10 * Q + 100;
    // Stream 104 opens before the stamp with 1,000 frames; its next chunk comes the quantum after
    // the stamp's, so it is ready (5,096 frames) one quantum late.
    let members = eight(&mut r, 0, 104, 9 * Q, 0x0C3_2003);
    let f = r.feeds.iter_mut().find(|f| f.id == 104).unwrap();
    f.first_chunk = 1_000;
    f.stall_until = 11 * Q;
    stamp_group(&mut r, &members, 33, stamp);
    r.run_to(11 * Q + 8_192);
    check_late(&mut r, &members, 33, stamp, 11 * Q, "a partial first chunk");
}

#[test]
fn a_half_second_slip_still_nulls_and_every_slip_of_the_spikes_grid_is_one_frame_for_all() {
    // The spike's slips (1, 2, 8, 32 quanta past the stamp's quantum) and a half second (187
    // quanta), each at two stamp offsets.
    for late_q in [1u64, 2, 8, 32, 187] {
        for s_mod in [0u64, 127] {
            let mut r = Rig::new(48_000.0);
            let stamp = 10 * Q + s_mod;
            let slow_at = 10 * Q + late_q * Q;
            let members = eight(&mut r, 0, 101 + (late_q % 4) as u32, slow_at, 0x0C3_2100 + late_q as u32);
            stamp_group(&mut r, &members, 34, stamp);
            r.run_to(slow_at + 4_096);
            check_late(&mut r, &members, 34, stamp, slow_at, &format!("slip of {late_q} quanta, s_mod {s_mod}"));
        }
    }
}

#[test]
fn a_late_group_beside_an_on_time_one_leaves_the_on_time_group_untouched() {
    let mut r = Rig::new(48_000.0);
    // Group 35 (clips 1..4, streams 101..104) is late on stream 102; group 36 (clips 11, 12,
    // streams 201, 202) is on time at the same stamp.
    let stamp = 10 * Q + 64;
    let slow_at = 14 * Q;
    let late = eight(&mut r, 0, 102, slow_at, 0x0C3_2200);
    let mut on_time = Vec::new();
    for k in 0..2u32 {
        r.clip(11 + k, 0x0C3_2300 + k, 48_000);
        on_time.push(Member { voice: voice(10 + k), source: Source::Clip { id: 11 + k, seed: 0x0C3_2300 + k }, gain: 0.125 });
        r.feeds.push(Feed::new(201 + k, 0x0C3_2310 + k, 0));
        on_time.push(Member { voice: voice(12 + k), source: Source::Stream { id: 201 + k, seed: 0x0C3_2310 + k }, gain: 0.125 });
    }
    let (g1, g2) = (wire::pack_gate(35, 8), wire::pack_gate(36, 4));
    let at = r.off(stamp);
    let mut recs: Vec<Vec<u8>> = late.iter().map(|m| play(m, at, g1)).collect();
    recs.extend(on_time.iter().map(|m| play(m, at, g2)));
    r.submit(&recs);
    r.run_to(slow_at + 4_096);
    same_playhead(&r, &late, r.frame - slow_at, "the late group");
    same_playhead(&r, &on_time, r.frame - stamp, "the on-time group");
    let mut over = 0;
    for t in 0..r.frame {
        let (al, ar) = r.reference(&late, slow_at, t);
        let (bl, br) = r.reference(&on_time, stamp, t);
        let (l, rr) = r.out(t);
        over += ((l - al - bl).abs().max((rr - ar - br).abs()) > TOL) as usize;
    }
    assert_eq!(over, 0, "the late group from its start plus the on-time group from the stamp");
    let st = r.take();
    let mut starts = group_starts(&st);
    starts.sort_unstable();
    assert_eq!(starts, [(35, LATE, (slow_at - stamp) as u32, slow_at), (36, 0, 0, stamp)]);
    assert_eq!(st.groups_late, 1);
}
