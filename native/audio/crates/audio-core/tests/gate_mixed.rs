//! 0166 M4a, C3 (api-and-models §9 "Golden", §10 row C3): mixed decoded and streamed groups null
//! against an offline reference.
//!
//! A group's decoded members (mono lcg clips) and streamed members (stereo `noise32` music streams
//! fed by the worker model) start on one frame, and the output equals the reference, the sum of
//! every member's source from that frame, to an f32 ulp (1e-6), for as long as the scene runs:
//! across ring refills and the ring's wrap at 32,768 frames. `gate_common` has the rig.
//!
//! `primed_eight_stems_null_for_forty_thousand_frames` is also a fixture (`golden/gate-mixed.json`)
//! that `audioGoldenGate.test.ts` replays on the real wasm (native equals wasm).

mod gate_common;

use audio_wire::generated as wire;
use gate_common::*;

const TOL: f32 = 1e-6;

/// `n_clips` decoded members (clips 1.., seeds `seed + k`) then `n_streams` streamed members
/// (streams `stream0`.., ready at `ready`), voices from `voice0`, each at gain `gain`.
fn stems(r: &mut Rig, voice0: u32, n_clips: u32, n_streams: u32, stream0: u32, ready: u64, gain: f32, clip_frames: usize, seed: u32) -> Vec<Member> {
    let mut out = Vec::new();
    for k in 0..n_clips {
        let id = voice0 + k + 1;
        r.clip(id, seed + k, clip_frames);
        out.push(Member { voice: voice(voice0 + k), source: Source::Clip { id, seed: seed + k }, gain });
    }
    for k in 0..n_streams {
        let id = stream0 + k;
        let s = seed ^ 0xA5A5_0000 ^ k;
        r.feeds.push(Feed::new(id, s, ready));
        out.push(Member { voice: voice(voice0 + n_clips + k), source: Source::Stream { id, seed: s }, gain });
    }
    out
}

#[test]
fn primed_eight_stems_null_for_forty_thousand_frames() {
    let mut r = Rig::recording();
    // Clips load (the wasm shell copies 256 KiB per quantum) and the rings prime before the stamp.
    let members = stems(&mut r, 0, 4, 4, 101, 0, 0.125, 48_000, 0x0C3_0001);
    r.run_to(8 * Q);
    // The stamp mid-quantum, 10 quanta ahead: sample 77 of the quantum at 2,304.
    let stamp = 18 * Q + 77;
    let gate = wire::pack_gate(21, 8);
    let at = r.off(stamp);
    r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
    let end = stamp + 40_000;
    r.run_to(end);
    same_playhead(&r, &members, r.frame - stamp, "primed eight");
    let null = r.null(&members, stamp, 0, r.frame, TOL);
    assert_eq!(null.2, 0, "the sum nulls against the reference for 40,000 frames: {null:?}");
    let st = r.take();
    let starts = group_starts(&st);
    assert_eq!(starts, [(21, 0, 0, stamp)], "one on-time start");
    assert_eq!((st.groups_late, st.late_commands, st.stream_starts_late), (0, 0, 0));
    for id in 101..105u32 {
        let ring = r.core.streams().get(id).expect("open");
        assert!(ring.consumed > 32_768, "ring {id} wrapped ({} consumed)", ring.consumed);
    }
    r.finish("gate-mixed", "4 decoded and 4 streamed stems gated in one group, stamped at sample 77 of a quantum: they start on the stamp and the sum nulls against the reference for 40,000 frames", &starts, (null.0, TOL));
}

#[test]
fn rings_primed_a_second_early_wait_full_and_the_group_still_nulls() {
    let mut r = Rig::new(48_000.0);
    // The rings open at frame 0 and fill to the credit window (32,768), then idle: a ring isn't
    // consumed before its member starts.
    let members = stems(&mut r, 0, 3, 5, 301, 0, 0.125, 8_192, 0x0C3_0002);
    let stamp = 48_000 + 5;
    let gate = wire::pack_gate(22, 8);
    let at = r.off(stamp);
    r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
    r.run_to(stamp - Q);
    for id in 301..306u32 {
        let ring = r.core.streams().get(id).expect("open");
        assert_eq!((ring.written, ring.consumed), (32_768, 0), "ring {id} full and untouched before the start");
    }
    r.run_to(stamp + 4_096);
    same_playhead(&r, &members, r.frame - stamp, "primed early");
    let null = r.null(&members, stamp, stamp - 4 * Q, r.frame, TOL);
    assert_eq!(null.2, 0, "{null:?}");
    assert_eq!(group_starts(&r.take()), [(22, 0, 0, stamp)]);
}

#[test]
fn a_streamed_member_whose_input_ended_short_of_4096_frames_is_ready_and_starts_with_the_rest() {
    let mut r = Rig::new(48_000.0);
    let mut members = stems(&mut r, 0, 2, 1, 401, 0, 0.25, 8_192, 0x0C3_0003);
    // A 1,000-frame stinger: one LAST chunk, short of the 4,096 frames a ring needs, but ended.
    let mut short = Feed::new(402, 0x0C3_0403, 0);
    short.total = Some(1_000);
    r.feeds.push(short);
    members.push(Member { voice: voice(3), source: Source::Stream { id: 402, seed: 0x0C3_0403 }, gain: 0.25 });
    let stamp = 6 * Q + 100;
    let gate = wire::pack_gate(23, 4);
    let at = r.off(stamp);
    r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
    r.run_to(stamp + 3_000);
    same_playhead(&r, &members[..3], r.frame - stamp, "the long members");
    // The stinger played its 1,000 frames from the stamp, then ended.
    let null = r.null(&members, stamp, 0, r.frame, TOL);
    assert_eq!(null.2, 0, "{null:?}");
    let st = r.take();
    assert_eq!(group_starts(&st), [(23, 0, 0, stamp)], "on time: an ended input is ready");
    assert!(st.ended.contains(&voice(3)), "the stinger ended");
}

#[test]
fn two_overlapping_mixed_groups_each_start_on_their_own_frame_and_their_sum_nulls() {
    let mut r = Rig::new(48_000.0);
    // Group A (2 decoded, 2 streamed) at s1; group B (1 decoded, 3 streamed) 1,000 frames later,
    // both submitted in one batch: an overlap as a crossfade's has, at full gain.
    let a = stems(&mut r, 0, 2, 2, 501, 0, 0.125, 8_192, 0x0C3_0004);
    let b = stems(&mut r, 10, 1, 3, 601, 0, 0.125, 8_192, 0x0C3_0005);
    let s1 = 8 * Q + 3;
    let s2 = s1 + 1_000;
    let (ga, gb) = (wire::pack_gate(24, 4), wire::pack_gate(25, 4));
    let (oa, ob) = (r.off(s1), r.off(s2));
    let mut recs: Vec<Vec<u8>> = a.iter().map(|m| play(m, oa, ga)).collect();
    recs.extend(b.iter().map(|m| play(m, ob, gb)));
    r.submit(&recs);
    r.run_to(s2 + 6_000);
    same_playhead(&r, &a, r.frame - s1, "group A");
    same_playhead(&r, &b, r.frame - s2, "group B");
    let mut worst = (0f32, 0usize);
    for t in 0..r.frame {
        let (al, ar) = r.reference(&a, s1, t);
        let (bl, br) = r.reference(&b, s2, t);
        let (l, rr) = r.out(t);
        let e = (l - al - bl).abs().max((rr - ar - br).abs());
        worst.0 = worst.0.max(e);
        worst.1 += (e > TOL) as usize;
    }
    assert_eq!(worst.1, 0, "the two groups' sum nulls (worst {:e})", worst.0);
    let mut starts = group_starts(&r.take());
    starts.sort_unstable();
    assert_eq!(starts, [(24, 0, 0, s1), (25, 0, 0, s2)]);
}

#[test]
fn every_decoded_and_streamed_mix_of_eight_nulls_at_every_stamp_offset_in_a_quantum() {
    // 9 mixes (0..=8 streamed) × 16 stamp offsets spread over the quantum.
    for streamed in 0..=8u32 {
        for s_mod in (0..Q).step_by(8).map(|s| s + (streamed as u64 % 8)) {
            let mut r = Rig::new(48_000.0);
            let members = stems(&mut r, 0, 8 - streamed, streamed, 701, 0, 0.125, 4_096, 0x0C3_1000 + streamed);
            let stamp = 6 * Q + s_mod;
            let gate = wire::pack_gate(26, 8);
            let at = r.off(stamp);
            r.submit(&members.iter().map(|m| play(m, at, gate)).collect::<Vec<_>>());
            r.run_to(stamp + 2_048);
            let what = format!("{streamed} streamed, s_mod {s_mod}");
            same_playhead(&r, &members, r.frame - stamp, &what);
            let null = r.null(&members, stamp, 0, r.frame, TOL);
            assert_eq!(null.2, 0, "{what}: {null:?}");
            assert_eq!(group_starts(&r.take()), [(26, 0, 0, stamp)], "{what}");
        }
    }
}
