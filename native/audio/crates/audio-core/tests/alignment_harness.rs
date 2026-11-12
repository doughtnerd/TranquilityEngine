//! 0166 M4a, C3 (api-and-models §9 "Golden": "the spike's 1,408-case alignment harness as a test";
//! §10 row C3): the streams-align spike's Q1 grid (`spikes/audio-music/streams-align`,
//! `src/bin/align.rs` `q1_single`: every sample offset 0–127 of the stamp S × 11 arrival quanta A
//! of the slow ring's data = 1,408 cases), ported from one ungated stream voice to a **gated
//! group**.
//!
//! The spike asserted that an ungated stream voice starts at S when its ring was ready before S's
//! quantum and otherwise slips, alone, to A. With the group gate (C2b) the rule per case is:
//! - every member starts on **one frame**: S when every ring is ready before S's quantum
//!   (`A ≤ ⌊S/128⌋·128`), else A, the first quantum in which the last ring is ready;
//! - the output nulls against the offline reference (every member's source summed from that frame);
//! - one `groupStarts` event: on time with slip 0, or LATE with slip A − S; `groupsLate` and
//!   `maxSlipFrames` agree; `lateCommands` and `streamStartsLate` stay 0.
//!
//! Each case also takes a group shape from a cycle (sizes 1–8, decoded and streamed mixes, every
//! group with at least one streamed member, the slowest ring at A and the others ready 0–3 quanta
//! before it) and a context rate (44.1, 48 and 96 kHz). The cycle is coprime with the grid, so
//! every arrival quantum meets every shape at every rate, at several stamp offsets.
//!
//! Timing (the waves plan's risk row): the spike's whole `align` run is 11 s on the loaded build
//! machine (release); this harness renders about 30 quanta per case from a core started near S,
//! on up to 8 threads: 12.6 s on one thread (release, loaded machine), most of it building cores.

mod gate_common;

use audio_wire::generated as wire;
use gate_common::*;

/// S's quantum (750 × 128), as in the spike.
const BASE: u64 = 96_000;
/// The spike's arrival quanta, `(A − BASE) / 128`.
const ARRIVALS: [i64; 11] = [-3, -2, -1, 0, 1, 2, 3, 4, 8, 16, 40];
/// `(members, streamed)` per shape.
const SHAPES: [(u32, u32); 11] = [(1, 1), (2, 1), (2, 2), (3, 1), (3, 2), (4, 2), (4, 4), (5, 1), (6, 3), (8, 4), (8, 8)];
const RATES: [f32; 3] = [44_100.0, 48_000.0, 96_000.0];
const TOL: f32 = 1e-6;
/// Frames nulled after the start.
const WINDOW: u64 = 1_024;

struct Case {
    s_mod: u64,
    j: i64,
    shape: (u32, u32),
    rate: f32,
}

fn cases() -> Vec<Case> {
    let mut out = Vec::with_capacity(1_408);
    for s_mod in 0..Q {
        for (ji, &j) in ARRIVALS.iter().enumerate() {
            let shape = SHAPES[(s_mod as usize + ji) % SHAPES.len()];
            let rate = RATES[s_mod as usize % RATES.len()];
            out.push(Case { s_mod, j, shape, rate });
        }
    }
    out
}

/// Runs one case and checks it; returns `(start − S, max residual)`.
fn run(c: &Case, index: usize) -> (u64, f32) {
    let s = BASE + c.s_mod;
    let a = (BASE as i64 + c.j * Q as i64) as u64;
    let (n, m) = c.shape;
    let what = format!("case {index}: s_mod {} j {:+} shape {n}/{m} streamed at {} Hz", c.s_mod, c.j, c.rate);
    let mut r = Rig::new(c.rate);
    r.skip_to(BASE - 8 * Q);
    // Streamed members spread through the group (Bresenham), the slowest (the first) at A.
    let gain = 1.0 / n as f32;
    let mut members = Vec::new();
    let mut streamed = 0u32;
    for k in 0..n {
        let is_stream = (k * m) / n != ((k + 1) * m) / n;
        let source = if is_stream {
            let id = 200 + k;
            let seed = 0x5EED_0000 ^ (index as u32) << 4 ^ k;
            let early = if streamed == 0 { 0 } else { (index as u64 + streamed as u64) % 4 };
            r.feeds.push(Feed::new(id, seed, a - early * Q));
            streamed += 1;
            Source::Stream { id, seed }
        } else {
            let id = 1 + k;
            let seed = 0xC1_1900 ^ (index as u32) << 4 ^ k;
            r.clip(id, seed, 4_096);
            Source::Clip { id, seed }
        };
        members.push(Member { voice: voice(k), source, gain });
    }
    assert_eq!(streamed, m, "{what}: the shape's streamed count");
    let group = (index % 1_000) as u32 + 1;
    let gate = wire::pack_gate(group, n);
    let at = r.off(s);
    r.submit(&members.iter().map(|mb| play(mb, at, gate)).collect::<Vec<_>>());
    let start = if a <= s / Q * Q { s } else { a };
    r.run_to(s.max(a) + 10 * Q);

    same_playhead(&r, &members, r.frame - start, &what);
    let resid = r.null(&members, start, BASE - Q, start + WINDOW, TOL);
    assert_eq!(resid.2, 0, "{what}: the sum nulls against the reference from {start}: {resid:?}");
    let st = r.take();
    let slip = (start - s) as u32;
    let late = if slip > 0 { wire::GROUP_START_LATE as u16 } else { 0 };
    assert_eq!(group_starts(&st), [(group as u16, late, slip, start)], "{what}: one groupStarts event");
    assert_eq!((st.groups_late, st.max_slip_frames), ((slip > 0) as u16, slip), "{what}: groupsLate, maxSlipFrames");
    assert_eq!((st.late_commands, st.stream_starts_late, st.groups_abandoned), (0, 0, 0), "{what}: nothing else counted");
    (start - s, resid.0)
}

#[test]
fn every_member_of_a_group_starts_on_one_frame_over_the_spikes_1408_cases() {
    let all = cases();
    assert_eq!(all.len(), 1_408, "128 stamp offsets × 11 arrival quanta");
    let t0 = std::time::Instant::now();
    // Cases are independent (a core each; a new core costs about 7 ms, most of a case), so they
    // run on a few threads; each thread builds its own rigs.
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).clamp(1, 8);
    let per = all.len().div_ceil(threads);
    let results: Vec<(u64, f32)> = std::thread::scope(|scope| {
        let handles: Vec<_> = all.chunks(per).enumerate().map(|(t, part)| scope.spawn(move || part.iter().enumerate().map(|(i, c)| run(c, t * per + i)).collect::<Vec<_>>())).collect();
        handles.into_iter().flat_map(|h| h.join().expect("a case failed (its message is above)")).collect()
    });
    assert_eq!(results.len(), 1_408);
    let on_time = results.iter().filter(|r| r.0 == 0).count();
    let late = results.len() - on_time;
    let worst = results.iter().fold(0f32, |w, r| w.max(r.1));
    // Arrivals −3..0 are ready by S's quantum (4 of 11), the other 7 are late.
    assert_eq!((on_time, late), (128 * 4, 128 * 7));
    eprintln!("alignment harness: 1,408 cases ({on_time} on time, {late} late), worst residual {worst:e}, {:.2} s", t0.elapsed().as_secs_f64());
}

#[test]
fn the_shape_cycle_covers_every_shape_and_rate_at_every_arrival() {
    let all = cases();
    for &j in &ARRIVALS {
        for &shape in &SHAPES {
            for &rate in &RATES {
                assert!(all.iter().any(|c| c.j == j && c.shape == shape && c.rate == rate), "j {j} shape {shape:?} rate {rate}");
            }
        }
    }
}

