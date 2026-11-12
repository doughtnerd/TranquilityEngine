//! 0166 M4a, C3 (api-and-models §10 row C3; architecture §4.3 rows "Started" and "Held"; R11; ADR
//! 0167 §2 "A stem that runs dry mid-piece holds its whole group"; owner decision 6; the waves plan's
//! M4a exit: "a held group resumes together"): the held-group null, a dip and an aligned resume,
//! at harness scale. C2c's `group_hold.rs` tests cover the mechanism on DC clips at one rate; these
//! run it across a grid of group sizes (1–8), decoded and streamed mixes, which streamed member runs
//! dry, rates (44.1, 48, 96 kHz), hold lengths and stamp offsets, on noise signals.
//!
//! A started group plays; one streamed member's worker stalls and its ring runs dry. Checked:
//! - before the dip the output nulls against the reference (1e-6);
//! - the dip starts at sample 0 of a quantum and the fade-out lasts the hold fade (5 ms rounded up
//!   to whole quanta: 256 frames at 44.1 and 48 kHz, 512 at 96 kHz), then silence;
//! - through the fade-out and the fade-in the output is **one gain** times the reference: the left
//!   and right channels (whose members' mixes differ) give the same gain at every frame, falling from
//!   1 to 0, then rising from 0 to 1 — decoded members fade with the streamed ones;
//! - every member's position pinned while held, all on one frame;
//! - after the fade-in (a true 5 ms) the output nulls against the reference continued from the
//!   pinned frame: the resume is aligned;
//! - one HELD `groupStarts` event, start frame = the resume, slip = the time held (from the first
//!   silent frame to the resume); `groupsHeld` 1, `maxSlipFrames` at least the slip.
//!
//! And the rebase rule across the hold (C2d): a record stamped inside the fade-out applies at its own
//! frame; one stamped after the hold's start lands at the resume + its offset from the hold's start.
//!
//! `a_dry_ring_dips_the_whole_group_and_it_resumes_aligned` is also a fixture
//! (`golden/gate-held.json`, replayed on the real wasm by `audioGoldenGate.test.ts`).

mod gate_common;

use audio_core::voices::state;
use audio_wire::generated::{self as wire, fade_law};
use gate_common::*;

const TOL: f32 = 1e-6;
const HELD: u16 = wire::GROUP_START_HELD as u16;

/// The hold's fade-out at `rate`: 5 ms rounded up to whole quanta (`group_hold::hold_fade_frames`).
fn hold_fade(rate: f32) -> u64 {
    ((0.005f32 * rate).ceil() as u64).div_ceil(Q) * Q
}

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

/// A group's shape: `n` members, `streamed` of them streamed (spread through the group), the
/// `dry`-th streamed one running dry, at `rate`.
#[derive(Clone, Copy, Debug)]
struct Shape {
    n: u32,
    streamed: u32,
    dry: u32,
    rate: f32,
}

/// The scene: `shape`'s members stamped on time at `stamp`; the dry ring gets its first chunk only,
/// then nothing until `refill`; `extra` records go in the PLAYs' batch; rendered to `until`.
fn held_scene(mut r: Rig, shape: Shape, stamp: u64, refill: u64, until: u64, seed: u32, extra: &dyn Fn(&Rig) -> Vec<Vec<u8>>) -> Held {
    assert_eq!(r.rate, shape.rate, "{shape:?}: the rig's rate");
    let mut members = Vec::new();
    let gain = 1.0 / shape.n as f32;
    let mut s_index = 0;
    for k in 0..shape.n {
        let is_stream = (k * shape.streamed) / shape.n != ((k + 1) * shape.streamed) / shape.n;
        let source = if is_stream {
            let id = 101 + k;
            let s = seed ^ 0x7E1D_0000 ^ k;
            let mut f = Feed::new(id, s, 0);
            if s_index == shape.dry {
                f.stall_until = refill;
            }
            s_index += 1;
            r.feeds.push(f);
            Source::Stream { id, seed: s }
        } else {
            r.clip(1 + k, seed + k, 48_000);
            Source::Clip { id: 1 + k, seed: seed + k }
        };
        members.push(Member { voice: voice(k), source, gain });
    }
    assert!(shape.dry < s_index, "{shape:?}: the dry member is streamed");
    r.run_to(8 * Q);
    let gate = wire::pack_gate(51, shape.n);
    let at = r.off(stamp);
    let mut recs: Vec<Vec<u8>> = members.iter().map(|m| play(m, at, gate)).collect();
    recs.extend(extra(&r));
    r.submit(&recs);
    let mut ticks = Vec::new();
    while r.frame < until {
        let frame = r.frame;
        r.step();
        ticks.push(Tick { frame, members: members.iter().map(|m| (r.slot(m.voice).state, r.slot(m.voice).position)).collect() });
    }
    Held { r, members, ticks, stamp }
}

/// Where the hold fell: the dip (the fade's first frame), the first silent frame, the resume and
/// the frame every member was pinned at.
struct Found {
    dip: u64,
    hold_start: u64,
    resume: u64,
    pinned: f64,
}

/// Finds the hold and checks the pinning and the aligned playheads.
fn find_hold(h: &Held, what: &str) -> Found {
    let (r, members, stamp) = (&h.r, &h.members, h.stamp);
    let dip = (stamp..r.frame)
        .find(|&t| {
            let (wl, wr) = r.reference(members, stamp, t);
            let (l, rr) = r.out(t);
            (l - wl).abs().max((rr - wr).abs()) > TOL
        })
        .unwrap_or_else(|| panic!("{what}: the group never dips"));
    assert_eq!(dip % Q, 0, "{what}: the hold's fade starts at sample 0 of a quantum ({dip})");
    let hold_start = dip + hold_fade(r.rate);
    // Pinned: every quantum from the hold's start until the resume, no member moves, all on one frame.
    let at_hold = h.ticks.iter().find(|t| t.frame == hold_start).unwrap_or_else(|| panic!("{what}: rendered past the hold's start"));
    let pinned = at_hold.members[0].1;
    let resume = h.ticks.iter().find(|t| t.frame > hold_start && t.members[0].1 != pinned).map(|t| t.frame).unwrap_or_else(|| panic!("{what}: never resumes"));
    for t in h.ticks.iter().filter(|t| t.frame >= hold_start && t.frame < resume) {
        for (i, m) in t.members.iter().enumerate() {
            assert_eq!(m.1, pinned, "{what}: member {i} pinned on the group's frame at {}", t.frame);
            assert_ne!(m.0, state::FREE, "{what}: member {i} still a voice while held");
        }
    }
    same_playhead(r, members, (pinned as u64) + (r.frame - resume), what);
    for t in hold_start..resume {
        assert_eq!(r.out(t), (0.0, 0.0), "{what}: silent while held, at {t}");
    }
    Found { dip, hold_start, resume, pinned }
}

/// The full checks; returns the scene's `groupStarts` and the worst null.
fn check_held(h: &mut Held, what: &str) -> (Vec<(u16, u16, u32, u64)>, f32) {
    let f = find_hold(h, what);
    let (r, members, stamp) = (&h.r, &h.members, h.stamp);
    let pre = r.null(members, stamp, 0, f.dip, TOL);
    assert_eq!(pre.2, 0, "{what}: nulls before the dip");
    let start_after = f.resume - f.pinned as u64;
    let fade_in = (0.005f32 * r.rate).ceil() as u64;
    let post = r.null(members, start_after, f.resume + fade_in, r.frame, TOL);
    assert_eq!(post.2, 0, "{what}: after the 5 ms fade-in the output nulls against the reference continued from the pinned frame {}: {post:?}", f.pinned);
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
    common_gain(f.dip, f.hold_start, stamp, true);
    common_gain(f.resume, f.resume + fade_in, start_after, false);
    let worst = pre.0.max(post.0);
    let st = h.r.take();
    let starts = group_starts(&st);
    let resumes: Vec<_> = starts.iter().filter(|g| g.1 & HELD != 0).copied().collect();
    assert_eq!(resumes, [(51, HELD, (f.resume - f.hold_start) as u32, f.resume)], "{what}: one HELD event: the resume's frame, the time held");
    assert_eq!(st.groups_held, 1, "{what}: groupsHeld");
    assert!(st.max_slip_frames >= resumes[0].2);
    assert_eq!((st.groups_abandoned, st.late_commands), (0, 0), "{what}");
    (starts, worst)
}

const NO_RECORDS: &dyn Fn(&Rig) -> Vec<Vec<u8>> = &|_| Vec::new();

#[test]
fn a_dry_ring_dips_the_whole_group_and_it_resumes_aligned() {
    // The stamp at sample 77 of the quantum at 2,304; the dry ring's 4,096 frames run out 4,096
    // frames after it, and its worker sends again 20 quanta later.
    let stamp = 18 * Q + 77;
    let shape = Shape { n: 4, streamed: 2, dry: 1, rate: 48_000.0 };
    let mut h = held_scene(Rig::recording(), shape, stamp, stamp + 4_096 + 20 * Q, stamp + 24_000, 0x0C3_4001, NO_RECORDS);
    let (starts, worst) = check_held(&mut h, "one dry ring");
    h.r.finish("gate-held", "2 decoded and 2 streamed stems start on time; one ring runs dry: the whole group fades out together over 256 frames, holds pinned, and resumes aligned with a 5 ms fade-in when the ring refills", &starts, (worst, TOL));
}

#[test]
fn every_shape_rate_hold_length_and_stamp_offset_dips_together_and_resumes_aligned() {
    const SHAPES: [(u32, u32); 8] = [(1, 1), (2, 1), (2, 2), (3, 1), (4, 2), (5, 3), (8, 4), (8, 8)];
    const RATES: [f32; 3] = [44_100.0, 48_000.0, 96_000.0];
    // The worker sends again `refill_q` quanta after the dry ring's data runs out (0: during the
    // fade-out).
    const REFILLS: [u64; 4] = [0, 2, 9, 40];
    let mut cases = 0;
    for (si, &(n, streamed)) in SHAPES.iter().enumerate() {
        for (ri, &rate) in RATES.iter().enumerate() {
            for (fi, &refill_q) in REFILLS.iter().enumerate() {
                let s_mod = ((si * 37 + ri * 53 + fi * 29) % 128) as u64;
                let dry = (si + fi) as u32 % streamed;
                let shape = Shape { n, streamed, dry, rate };
                let stamp = 18 * Q + s_mod;
                let seed = 0x0C3_4100 + cases;
                let mut h = held_scene(Rig::new(rate), shape, stamp, stamp + 4_096 + refill_q * Q, stamp + 16_000, seed, NO_RECORDS);
                check_held(&mut h, &format!("{shape:?}, refill {refill_q} quanta after the dry point, s_mod {s_mod}"));
                cases += 1;
            }
        }
    }
    assert_eq!(cases, 96);
}

/// A step FADE to `target` of `voice` at absolute frame `frame` (`r`'s next quantum is the batch's).
fn step_fade(r: &Rig, v: u32, frame: u64, target: f32) -> Vec<u8> {
    let mut b = vec![0u8; wire::Fade::FIXED_END];
    wire::Fade { voice_id: v, frame_offset: r.off(frame), target, frames: 0, flags: 0, shape: wire::pack_shape(fade_law::LINEAR, 0) }.write(&mut b, 0).unwrap();
    b
}

#[test]
fn a_record_inside_the_fade_out_applies_at_its_frame_and_one_after_the_holds_start_lands_at_the_resume_plus_its_offset() {
    for (rate, shape) in [(44_100.0f32, (3u32, 1u32)), (48_000.0, (4, 2)), (96_000.0, (8, 4))] {
        let shape = Shape { n: shape.0, streamed: shape.1, dry: 0, rate };
        let stamp = 18 * Q + 40;
        let refill = stamp + 4_096 + 12 * Q;
        let what = format!("{shape:?}");
        // A first run finds the hold; the second stamps records relative to it (the same scene, so
        // the same frames).
        let probe = held_scene(Rig::new(rate), shape, stamp, refill, stamp + 16_000, 0x0C3_4500, NO_RECORDS);
        let f = find_hold(&probe, &what);
        let inside = f.dip + 64;
        let offset = 700u64;
        let after = f.hold_start + offset;
        let last = shape.n - 1;
        let records = move |r: &Rig| vec![step_fade(r, voice(0), inside, 0.5), step_fade(r, voice(last), after, 0.5)];
        let mut h = held_scene(Rig::new(rate), shape, stamp, refill, stamp + 16_000, 0x0C3_4500, &records);
        let g = find_hold(&h, &what);
        assert_eq!((g.dip, g.hold_start, g.resume), (f.dip, f.hold_start, f.resume), "{what}: the records don't move the hold");
        // After the resume's fade-in: member 0 at half all along (its fade applied inside the
        // fade-out, unrebased); the last member at full until the resume + 700, then half.
        let start_after = g.resume - g.pinned as u64;
        let fade_in = (0.005f32 * rate).ceil() as u64;
        let mut over = 0;
        for t in g.resume + fade_in..h.r.frame {
            let (mut wl, mut wr) = (0.0f32, 0.0f32);
            for (i, m) in h.members.iter().enumerate() {
                let mut gain = m.gain;
                if i == 0 {
                    gain *= 0.5;
                }
                if i == last as usize && t >= g.resume + offset {
                    gain *= 0.5;
                }
                let (a, b) = h.r.reference(&[Member { gain, ..*m }], start_after, t);
                wl += a;
                wr += b;
            }
            let (l, rr) = h.r.out(t);
            over += ((l - wl).abs().max((rr - wr).abs()) > TOL) as usize;
        }
        assert_eq!(over, 0, "{what}: the fade inside the fade-out at its frame, the one after the hold's start at the resume + {offset}");
        assert_eq!(h.r.take().late_commands, 0, "{what}");
    }
}
