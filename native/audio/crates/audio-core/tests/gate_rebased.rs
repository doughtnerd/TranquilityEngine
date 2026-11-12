//! 0166 M4a, C3 (api-and-models §10 row C3; architecture §3.6 "Held records", R10; ADR 0167 §2 "A
//! held group's stamped records are rebased by its slip"): the rebased late group.
//!
//! A group stamped at T starts late, at T + slip. Every record of a member stamped at or after T
//! (parked while the group waited, or still pending) is shifted by the slip, so a fade lands at
//! **start + its offset from the stamp**: aligned to the music, not the clock. A non-member's record
//! (the outgoing group's fade-out) isn't shifted. Checked three ways:
//! - analytically: step fades (FADE, 0 frames) null against the reference with each gain change at
//!   start + offset;
//! - against the same scene rendered on time: shaped fades (linear, S-curve, equal power with
//!   stop-at-end) and a stamped STOP, heard late, null against the on-time render shifted by the slip
//!   (to 1e-4: the control-rate knots move with the quantum grid);
//! - a non-member's fade applies at its own frame while the group still waits.
//!
//! C2d's `group_rebase.rs` tests cover the rebase on DC clips; the last test here runs step fades at
//! harness scale: group sizes 2–8, decoded and streamed mixes, 44.1/48/96 kHz, three slips, stamp
//! offsets across the quantum (54 cases). The rebase across a hold is in `gate_held.rs`.
//!
//! `a_parked_step_fade_lands_at_the_late_start_plus_its_offset` is also a fixture
//! (`golden/gate-rebased.json`, replayed on the real wasm by `audioGoldenGate.test.ts`).

mod gate_common;

use audio_wire::generated::{self as wire, fade_law};
use gate_common::*;

const TOL: f32 = 1e-6;
/// The late render against the on-time one: the shaped laws run at control rate (architecture
/// §4.4), with knots counted from each quantum, so a slip that isn't a whole number of quanta moves
/// the knots against the music. Each render is within 1e-4 of the exact curve (Z3's bound), so
/// their difference is held to that; measured 1.2e-5. A misplaced fade errs by about 1e-2.
const SHIFT_TOL: f32 = 1e-4;
const LATE: u16 = wire::GROUP_START_LATE as u16;

fn eight(r: &mut Rig, slow: u32, slow_at: u64, seed: u32) -> Vec<Member> {
    let mut out = Vec::new();
    for k in 0..4u32 {
        r.clip(1 + k, seed + k, 48_000);
        out.push(Member { voice: voice(k), source: Source::Clip { id: 1 + k, seed: seed + k }, gain: 0.125 });
    }
    for k in 0..4u32 {
        let id = 101 + k;
        let s = seed ^ 0x5A5A_0000 ^ k;
        r.feeds.push(Feed::new(id, s, if id == slow { slow_at } else { 0 }));
        out.push(Member { voice: voice(4 + k), source: Source::Stream { id, seed: s }, gain: 0.125 });
    }
    out
}

fn fade(v: u32, at: u32, target: f32, frames: u32, law: u32, stop: bool) -> Vec<u8> {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    let flags = if stop { wire::FADE_FLAGS_STOP_AT_END } else { 0 };
    wire::Fade { voice_id: v, frame_offset: at, target, frames, flags, shape: wire::pack_shape(law, 0) }.write(&mut b, 0).unwrap();
    b
}

fn stop(v: u32, at: u32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Stop::FIXED_END];
    wire::Stop { voice_id: v, frame_offset: at, fade_frames: 0, reason: 0, shape: 0 }.write(&mut b, 0).unwrap();
    b
}

/// The reference of `members` started at `start` with step gain changes `(member index, frame,
/// factor)`: from `frame` on, that member is heard at `factor` times its gain.
fn reference_with(r: &Rig, members: &[Member], start: u64, steps: &[(usize, u64, f32)], t: u64) -> (f32, f32) {
    let (mut l, mut rr) = (0.0f32, 0.0f32);
    for (i, m) in members.iter().enumerate() {
        let factor = steps.iter().filter(|s| s.0 == i && t >= s.1).fold(1.0, |f, s| f * s.2);
        let one = Member { gain: m.gain * factor, ..*m };
        let (a, b) = r.reference(&[one], start, t);
        l += a;
        rr += b;
    }
    (l, rr)
}

#[test]
fn a_parked_step_fade_lands_at_the_late_start_plus_its_offset() {
    let mut r = Rig::recording();
    let stamp = 18 * Q + 77;
    let slow_at = 26 * Q;
    let members = eight(&mut r, 103, slow_at, 0x0C3_3001);
    r.run_to(8 * Q);
    let gate = wire::pack_gate(41, 8);
    let at = r.off(stamp);
    let mut recs: Vec<Vec<u8>> = members.iter().map(|m| play(m, at, gate)).collect();
    // A decoded member halves 200 frames after the stamp, a streamed one 600 after it.
    recs.push(fade(voice(0), at + 200, 0.5, 0, fade_law::LINEAR, false));
    recs.push(fade(voice(5), at + 600, 0.5, 0, fade_law::LINEAR, false));
    r.submit(&recs);
    r.run_to(slow_at + 8_192);
    let start = slow_at;
    let slip = (start - stamp) as u32;
    same_playhead(&r, &members, r.frame - start, "late group");
    let steps = [(0, start + 200, 0.5), (5, start + 600, 0.5)];
    let (mut worst, mut over, mut first) = (0f32, 0, None);
    for t in 0..r.frame {
        let (wl, wr) = reference_with(&r, &members, start, &steps, t);
        let (l, rr) = r.out(t);
        let e = (l - wl).abs().max((rr - wr).abs());
        worst = worst.max(e);
        if e > TOL {
            over += 1;
            first.get_or_insert(t);
        }
    }
    assert_eq!(over, 0, "each fade lands at the late start + its offset from the stamp (first wrong frame {first:?}, worst {worst:e})");
    let st = r.take();
    let starts = group_starts(&st);
    assert_eq!(starts, [(41, LATE, slip, start)]);
    assert_eq!(st.late_commands, 0, "a rebased record isn't late");
    r.finish("gate-rebased", "8 stems stamped at sample 77, one ring 8 quanta late, with step FADEs stamped 200 and 600 frames after the stamp: the group starts late and each fade lands at the late start plus its offset", &starts, (worst, TOL));
}

/// The rebase scene: eight stems stamped at `stamp`, the slow ring at `slow_at`, with shaped
/// fades and a STOP on members. Returns the rig rendered to `stamp + until`.
fn shaped(slow_at: u64, stamp: u64, until: u64) -> Rig {
    let mut r = Rig::new(48_000.0);
    let members = eight(&mut r, 102, slow_at, 0x0C3_3002);
    let gate = wire::pack_gate(42, 8);
    let at = r.off(stamp);
    let mut recs: Vec<Vec<u8>> = members.iter().map(|m| play(m, at, gate)).collect();
    recs.push(fade(voice(1), at + 300, 0.25, 1_000, fade_law::LINEAR, false));
    recs.push(fade(voice(4), at + 1_500, 0.0, 2_400, fade_law::EQUAL_POWER_OUT, true));
    recs.push(fade(voice(6), at + 64, 0.5, 4_800, fade_law::S_CURVE, false));
    recs.push(stop(voice(3), at + 2_222));
    r.submit(&recs);
    r.run_to(stamp + until);
    r
}

#[test]
fn shaped_fades_and_a_stop_of_a_late_group_null_against_the_on_time_render_shifted_by_the_slip() {
    let stamp = 10 * Q + 45;
    let on_time = shaped(0, stamp, 12_000);
    for late_q in [1u64, 3, 8] {
        let slow_at = 10 * Q + late_q * Q;
        let slip = slow_at - stamp;
        let mut late = shaped(slow_at, stamp, slip + 12_000);
        assert_eq!(group_starts(&late.take()), [(42, LATE, slip as u32, slow_at)], "slip {slip}");
        let (mut over, mut worst, mut first) = (0, 0f32, None);
        for t in 0..stamp + 12_000 {
            let (a, b) = on_time.out(t);
            let (c, d) = late.out(t + slip);
            let e = (a - c).abs().max((b - d).abs());
            worst = worst.max(e);
            if e > SHIFT_TOL {
                over += 1;
                first.get_or_insert(t);
            }
        }
        assert!(late.left[..slow_at as usize].iter().all(|&s| s == 0.0), "slip {slip}: silent until the late start");
        assert_eq!(over, 0, "slip {slip}: the late render is the on-time one shifted by the slip (first wrong on-time frame {first:?}, worst {worst:e})");
    }
}

#[test]
fn a_non_members_fade_is_not_rebased() {
    let mut r = Rig::new(48_000.0);
    let stamp = 10 * Q + 45;
    let slow_at = 20 * Q;
    let members = eight(&mut r, 104, slow_at, 0x0C3_3003);
    // The outgoing music: an ungated decoded voice playing from the start, faded to 0 (a step)
    // 200 frames after the incoming group's stamp.
    r.clip(30, 0x0C3_3030, 48_000);
    let outgoing = Member { voice: voice(30), source: Source::Clip { id: 30, seed: 0x0C3_3030 }, gain: 0.25 };
    r.submit(&[play(&outgoing, 0, 0)]);
    r.run_to(2 * Q);
    let gate = wire::pack_gate(43, 8);
    let at = r.off(stamp);
    let mut recs: Vec<Vec<u8>> = members.iter().map(|m| play(m, at, gate)).collect();
    recs.push(fade(outgoing.voice, at + 200, 0.0, 0, fade_law::LINEAR, false));
    recs.push(fade(voice(0), at + 200, 0.5, 0, fade_law::LINEAR, false));
    r.submit(&recs);
    r.run_to(slow_at + 4_096);
    let mut over = 0;
    for t in 0..r.frame {
        // The outgoing voice stops being heard at the stamp + 200 (its own frame); the member's
        // fade lands at the late start + 200.
        let (ol, or) = if t < stamp + 200 { r.reference(&[outgoing], 0, t) } else { (0.0, 0.0) };
        let (ml, mr) = reference_with(&r, &members, slow_at, &[(0, slow_at + 200, 0.5)], t);
        let (l, rr) = r.out(t);
        over += ((l - ol - ml).abs().max((rr - or - mr).abs()) > TOL) as usize;
    }
    assert_eq!(over, 0, "a hole of the slip's length at the seam: the outgoing fade isn't shifted, the member's is");
}


#[test]
fn step_fades_land_at_the_late_start_plus_their_offset_across_shapes_rates_and_slips() {
    // Group sizes 2–8 with decoded and streamed mixes (the slow ring the first streamed member), at
    // 44.1, 48 and 96 kHz, slips of 1, 5 and 40 quanta past the stamp's quantum, two step FADEs on
    // the first and the last member at offsets past the stamp, and stamp offsets across the quantum.
    const SHAPES: [(u32, u32); 6] = [(2, 1), (3, 2), (4, 1), (5, 5), (6, 3), (8, 4)];
    const RATES: [f32; 3] = [44_100.0, 48_000.0, 96_000.0];
    const SLIPS: [u64; 3] = [1, 5, 40];
    let mut cases = 0u32;
    for (si, &(n, streamed)) in SHAPES.iter().enumerate() {
        for (ri, &rate) in RATES.iter().enumerate() {
            for (li, &late_q) in SLIPS.iter().enumerate() {
                let s_mod = ((si * 41 + ri * 23 + li * 61) % 128) as u64;
                let stamp = 10 * Q + s_mod;
                let slow_at = 10 * Q + late_q * Q;
                let (d0, d1) = (17 + 97 * cases as u64 % 900, 1_000 + 131 * cases as u64 % 2_000);
                let mut r = Rig::new(rate);
                let gain = 1.0 / n as f32;
                let mut members = Vec::new();
                let mut first_stream = true;
                for k in 0..n {
                    let is_stream = (k * streamed) / n != ((k + 1) * streamed) / n;
                    let seed = 0x0C3_5000 ^ (cases << 4) ^ k;
                    let source = if is_stream {
                        let id = 101 + k;
                        r.feeds.push(Feed::new(id, seed, if first_stream { slow_at } else { 0 }));
                        first_stream = false;
                        Source::Stream { id, seed }
                    } else {
                        r.clip(1 + k, seed, 16_384);
                        Source::Clip { id: 1 + k, seed }
                    };
                    members.push(Member { voice: voice(k), source, gain });
                }
                let gate = wire::pack_gate(44, n);
                let at = r.off(stamp);
                let mut recs: Vec<Vec<u8>> = members.iter().map(|m| play(m, at, gate)).collect();
                recs.push(fade(voice(0), at + d0 as u32, 0.5, 0, fade_law::LINEAR, false));
                recs.push(fade(voice(n - 1), at + d1 as u32, 0.25, 0, fade_law::LINEAR, false));
                r.submit(&recs);
                r.run_to(slow_at + 4_096);
                let what = format!("{n}/{streamed} streamed at {rate} Hz, slip {late_q} quanta, s_mod {s_mod}");
                same_playhead(&r, &members, r.frame - slow_at, &what);
                let steps = [(0, slow_at + d0, 0.5), (n as usize - 1, slow_at + d1, 0.25)];
                let mut over = 0;
                for t in 0..r.frame {
                    let (wl, wr) = reference_with(&r, &members, slow_at, &steps, t);
                    let (l, rr) = r.out(t);
                    over += ((l - wl).abs().max((rr - wr).abs()) > TOL) as usize;
                }
                assert_eq!(over, 0, "{what}: each fade at the late start + its offset ({d0}, {d1})");
                let st = r.take();
                assert_eq!(group_starts(&st), [(44, LATE, (slow_at - stamp) as u32, slow_at)], "{what}");
                assert_eq!(st.late_commands, 0, "{what}");
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 54);
}
