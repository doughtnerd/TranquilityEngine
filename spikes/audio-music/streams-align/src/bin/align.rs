//! Spike S1: runs every correctness scenario of the README and prints its tables (markdown). Panics on a violated
//! expectation, so a clean exit means every claim in the README that says "asserted" holds.
//! `cargo run --release --bin align`

use audio_core::clips::ClipFormat;
use audio_core::stream::{RING_BYTES, RING_FRAMES, START_FRAMES};
use streamsalign::*;

const BASE: u64 = 96_000; // a quantum start (750 * 128)
const TOL: f32 = 1e-6;

fn qfloor(x: u64) -> u64 {
    x / Q * Q
}

// ---------------------------------------------------------------------------------------------------------------------
// Q1: one stream voice, stamped S, ring data arriving at quantum A

struct One {
    start: Option<u64>,
    first_nz: Option<u64>,
    resid: (f32, Option<u64>, usize),
    late: (u32, u32),
}

fn one(s_mod: u64, ready_at: u64, first_chunk: usize) -> One {
    let s = BASE + s_mod;
    let mut rig = Rig::new(128);
    let mut f = Feed::new(0, Seg { from: 0, piece: 1, stem: 0, file: 0, region: None }, ready_at);
    f.first_chunk = first_chunk;
    rig.feeds.push(f);
    rig.watch(0);
    let off = rig.off(s);
    rig.submit(&[rec_play(voice_id(0), STREAM0, true, off, 1.0)]);
    rig.run_to(s.max(ready_at) + 12 * Q);
    // The output (a click at stream frame 0, then noise) against the ideal start at S.
    let resid = null_test(&rig, s - 128, s + 1024, TOL, |t| if t < s { (0.0, 0.0) } else { src(1, 0, t - s) });
    One { start: rig.started(0), first_nz: rig.first_nonzero(0), resid, late: rig.late() }
}

fn q1_single() {
    println!("### Q1a/b: one stream voice, stamped S = {BASE} + s_mod (S's quantum starts at {BASE}); ring data (OPEN + first 4,096-frame chunk) committed before the quantum starting at A\n");
    println!("Cells: voice's first non-zero output frame minus S (the slip, in frames), measured from the output (click at frame 0). `exact` = 0.\n");
    let js: [i64; 9] = [-40, -8, -1, 0, 1, 2, 8, 32, 40];
    print!("| s_mod \\ A - {BASE} (quanta) |");
    for j in js {
        print!(" {j:+} |");
    }
    println!("\n|---|{}", "---|".repeat(js.len()));
    for s_mod in [0u64, 1, 37, 64, 127] {
        print!("| {s_mod} |");
        for j in js {
            let a = (BASE as i64 + j * Q as i64) as u64;
            let r = one(s_mod, a, CHUNK);
            let slip = r.first_nz.unwrap() as i64 - (BASE + s_mod) as i64;
            print!(" {slip} |");
        }
        println!();
    }
    // Asserted: for every offset and 80 arrival quanta, slip = 0 when A <= S's quantum start, else A - S.
    let mut checked = 0;
    for s_mod in 0..Q {
        for j in [-3i64, -2, -1, 0, 1, 2, 3, 4, 8, 16, 40] {
            let a = (BASE as i64 + j * Q as i64) as u64;
            let s = BASE + s_mod;
            let r = one(s_mod, a, CHUNK);
            let want = if a <= qfloor(s) { s } else { a };
            assert_eq!(r.first_nz, Some(want), "s_mod {s_mod} j {j}");
            assert_eq!(r.start, Some(want), "playhead start, s_mod {s_mod} j {j}");
            if a <= qfloor(s) {
                assert_eq!(r.resid.2, 0, "exact start must null: s_mod {s_mod} j {j}: {:?}", r.resid);
                assert_eq!(r.late.0, 0, "not late");
            }
            checked += 1;
        }
    }
    println!("\nAsserted over {checked} cases (all 128 sample offsets x 11 arrival quanta): the voice starts at S exactly when the data was committed before S's quantum, else at the first quantum boundary after the data arrived (slip = A - S, 1..), never mid-quantum. `lateCommands` stayed 0 in the exact cases (the stamp was ahead; the voice's wait is not a late command).\n");

    // A partial first chunk (1,000 frames): the voice waits for START_FRAMES = 4,096 buffered.
    println!("A first chunk of 1,000 frames then full chunks one quantum apart (the voice waits for {START_FRAMES} buffered frames):\n");
    println!("| A - {BASE} (quanta) | s_mod | start - S |\n|---|---|---|");
    for (j, s_mod) in [(-3i64, 37u64), (-1, 37), (0, 37), (0, 0), (1, 37)] {
        let a = (BASE as i64 + j * Q as i64) as u64;
        let r = one(s_mod, a, 1_000);
        println!("| {j:+} | {s_mod} | {} |", r.first_nz.unwrap() as i64 - (BASE + s_mod) as i64);
    }
    println!();
    println!("Voice waiting past its stamp, no data at all for 50,000 frames (slip = the whole decode time, no upper bound):\n");
    let r = one(37, BASE + 50_000, CHUNK);
    println!("start - S = {}\n", r.first_nz.unwrap() as i64 - (BASE + 37) as i64);
}

// ---------------------------------------------------------------------------------------------------------------------
// Q1c: N stems of one piece, one stamp

struct Stems {
    starts: Vec<Option<u64>>,
    resid: (f32, Option<u64>, usize),
    streams_open: usize,
    refused: usize,
}

fn stems(n: u32, max_mixed: u32, s_mod: u64, ready: impl Fn(u32, u64) -> u64) -> Stems {
    let s = BASE + s_mod;
    let g = 1.0 / n as f32;
    let mut rig = Rig::new(max_mixed);
    for i in 0..n {
        rig.feeds.push(Feed::new(i, Seg { from: 0, piece: 1, stem: i, file: 0, region: None }, qfloor(ready(i, s))));
        rig.watch(i);
    }
    let off = rig.off(s);
    let recs: Vec<_> = (0..n).map(|i| rec_play(voice_id(i), STREAM0 + i, true, off, g)).collect();
    rig.submit(&recs);
    let last_ready = rig.feeds.iter().map(|f| f.ready_at).max().unwrap();
    rig.run_to(s.max(last_ready) + 10_000);
    // Null: the sum of the stems from S, against the ideal sum of the source stems from S.
    let resid = null_test(&rig, s - 128, s + 8192, TOL, |t| {
        if t < s {
            return (0.0, 0.0);
        }
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for i in 0..n {
            let (a, b) = src(1, i, t - s);
            l += g * a;
            r += g * b;
        }
        (l, r)
    });
    Stems { starts: (0..n as usize).map(|i| rig.started(i)).collect(), resid, streams_open: rig.core.streams().open_count(), refused: rig.feeds.iter().filter(|f| f.refused_open).count() }
}

fn q1_stems() {
    println!("### Q1c: 4 and 8 stems of one piece, one stamp S = {BASE} + 37, each stem its own stream (gain 1/N, click at frame 0 of every stem)\n");
    println!("The decoder worker is one thread: it opens and primes the stems one after another, `D` frames apart (stem i is ready at T0 + i*D). Rows vary T0 relative to S. start offsets are `start_i - S` read from each voice's playhead advance; null = sum of the stems vs the ideal sum.\n");
    println!("| N | rings (max_mixed) | D | T0 - S | start_i - S (per stem) | spread | null: max resid / frames > 1e-6 |\n|---|---|---|---|---|---|---|");
    for (n, mm) in [(4u32, 64u32), (8, 128)] {
        for d in [0u64, 512, 2_048] {
            let t0s: Vec<i64> = if d == 0 { vec![-5_120, 3_000] } else { vec![-(n as i64) * d as i64 - 5_120, -(n as i64) * d as i64 / 2 - 2_048, 0, 3_000] };
            for t0 in t0s {
                let r = stems(n, mm, 37, |i, s| (s as i64 + t0 + (i as u64 * d) as i64) as u64);
                let offs: Vec<i64> = r.starts.iter().map(|s| s.map_or(-1, |s| s as i64 - (BASE + 37) as i64)).collect();
                let spread = offs.iter().max().unwrap() - offs.iter().min().unwrap();
                let shown: Vec<String> = offs.iter().map(|o| o.to_string()).collect();
                println!("| {n} | {mm} | {d} | {t0} | {} | {spread} | {:.2e} / {} |", shown.join(" "), r.resid.0, r.resid.2);
                if t0 + ((n as u64 - 1) * d) as i64 <= -(4_096 + 128) {
                    assert!(offs.iter().all(|&o| o == 0), "all primed: aligned to S");
                    assert_eq!(r.resid.2, 0, "primed stems null against the reference");
                }
            }
        }
    }
    println!();
    println!("Asserted: with every stem's data committed before S's quantum, all N voices start at S and the sum nulls against the reference (max residual shown is f32 summation order only). Any stem whose data lands later starts at its own quantum boundary: the stems are then shifted against each other by up to D*(N-1) and the sum is wrong for the whole piece (the offset never recovers).\n");

    // 8 stems on the low preset: 4 rings.
    let r = stems(8, 64, 37, |_, s| s - 20_000);
    let started = r.starts.iter().filter(|s| s.is_some()).count();
    println!("**8 stems on the low preset (max_mixed 64 -> 4 rings):** {} streams open, {} STREAM_OPEN refused, {started} of 8 voices ever started (the other four wait silent until main stops them: `stream.rs:41-43` \"none free: stream event 3, and the voice stays waiting\").\n", r.streams_open, r.refused);
    assert_eq!((r.streams_open, started), (4, 4));
}

// ---------------------------------------------------------------------------------------------------------------------
// Q3: segment A (streamed) -> segment B (streamed) at frame T

const SA: u64 = 24_005;
const T: u64 = SA + 192_000; // two bars at 120 bpm later, off the quantum grid on purpose

fn refseam(t: u64) -> (f32, f32) {
    if t < SA {
        (0.0, 0.0)
    } else if t < T {
        src(1, 0, t - SA)
    } else {
        src(2, 0, t - T)
    }
}

struct Seam {
    b_first: Option<u64>,
    resid: (f32, Option<u64>, usize),
    silent: usize,
}

/// A plays from SA; STOP at T (or its natural end); B stamped at T with its data committed at `b_ready`.
fn seam(b_ready: u64, eos: bool) -> Seam {
    let mut rig = Rig::new(128);
    let mut a = Feed::new(0, Seg { from: 0, piece: 1, stem: 0, file: 0, region: None }, 0);
    if eos {
        a.total = Some(T - SA);
    }
    rig.feeds.push(a);
    rig.feeds.push(Feed::new(1, Seg { from: 0, piece: 2, stem: 0, file: 0, region: None }, b_ready));
    rig.watch(1);
    let (oa, ot) = (rig.off(SA), rig.off(T));
    let mut recs = vec![rec_play(voice_id(0), STREAM0, true, oa, 1.0), rec_play(voice_id(1), STREAM0 + 1, true, ot, 1.0)];
    if !eos {
        recs.push(rec_stop(voice_id(0), ot, 0));
    }
    rig.submit(&recs);
    rig.run_to(T + 3 * 4096);
    let resid = null_test(&rig, SA, T + 8192, TOL, refseam);
    let silent = (T..T + 8192).filter(|&t| rig.out[0][t as usize] == 0.0 && rig.out[1][t as usize] == 0.0).count();
    Seam { b_first: rig.started(0), resid, silent }
}

fn q3_seam() {
    println!("### Q3: hard seam A -> B at T = {T} (A streamed from {SA}, B streamed, both stamped; A stopped by a stamped STOP with fade 0, or ends at its own last chunk)\n");
    println!("Reference = A's source up to T-1, B's source from T (built from the same generator, not through the core). Window checked: [{SA}, T + 8,192). tol 1e-6.\n");
    println!("| B data committed | lead = T - A (frames) | A ends by | B first sound - T | frames wrong in window | max error | silent frames after T |\n|---|---|---|---|---|---|---|");
    for (label, lead) in [("primed", 44_100i64), ("primed", 20_000), ("primed", 4_096 + 128), ("last exact quantum", T as i64 - qfloor(T) as i64), ("1 quantum late", -1), ("unprimed (10 ms late)", -480), ("unprimed (50 ms late)", -2_400)] {
        for eos in [false, true] {
            if eos && lead < 0 {
                continue;
            }
            let ready = (T as i64 - lead).max(0) as u64;
            let ready = if lead >= 0 { qfloor(ready) } else { ready.div_ceil(Q) * Q };
            let r = seam(ready, eos);
            let first = r.b_first.map_or(-1, |f| f as i64 - T as i64);
            println!("| {label} (ready {ready}) | {} | {} | {first} | {} | {:.3} | {} |", T as i64 - ready as i64, if eos { "natural end" } else { "STOP @T" }, r.resid.2, r.resid.0, r.silent);
            if lead >= 128 {
                assert_eq!(r.resid.2, 0, "primed seam must null: lead {lead} eos {eos}: {:?}", r.resid);
                assert_eq!(first, 0);
            } else if lead < 0 {
                assert!(r.resid.2 > 0, "an unprimed seam differs");
            }
        }
    }
    println!();
    println!("Reading: `lead` is how long before T the B stream's OPEN and first chunk were committed in the ring. Anything committed before T's quantum starts gives a sample-exact seam (asserted: 0 frames wrong). Later, B starts at the next quantum boundary and *everything after* is shifted by the slip, so the error is not a click but a rhythmic offset for the rest of the segment.\n");

    println!("Unprimed, as the engine behaves today (`coreBackend.ts:1390-1394`: PLAY and the worker's open are issued together, at T - L; D = open + first-chunk decode + postMessage to the ring):\n");
    println!("| L (lookahead) | D | lead = L - D | B start - T | frames wrong in window |\n|---|---|---|---|---|");
    for l in [1_024u64, 4_800] {
        for d in [48u64, 240, 960, 2_400, 4_800] {
            let lead = l as i64 - d as i64;
            let ready = if lead >= 0 { qfloor((T as i64 - lead) as u64) } else { (T + (-lead) as u64).div_ceil(Q) * Q };
            let r = seam(ready, false);
            println!("| {l} | {d} | {lead} | {} | {} |", r.b_first.map_or(-1, |f| f as i64 - T as i64), r.resid.2);
        }
    }
    println!();

    // Crossfade.
    println!("### Q3b: crossfade A -> B over X = 4,800 frames (100 ms), linear gains, B starting at T - X\n");
    println!("A: FADE to 0 over X with stop-at-end, stamped T - X. B: PLAY gain 0 stamped T - X, SET_PARAMS gain 1 over X stamped T - X. Reference: A*(1-(k+1)/X) + B*((k+1)/X), k = t - (T - X). tol 1e-4: the core's ramp adds an f32 step per frame (`audio-dsp/src/ramp.rs:51-57`), so it drifts from the exact line by up to ~1e-5 here; a misaligned B is wrong by 0.1-0.5.\n");
    println!("| B data committed (lead before T - X) | frames wrong | max error |\n|---|---|---|");
    const X: u64 = 4_800;
    for lead in [20_000i64, 128, -1, -480] {
        let start = T - X;
        let ready = if lead >= 0 { qfloor((start as i64 - lead).max(0) as u64) } else { (start + (-lead) as u64).div_ceil(Q) * Q };
        let mut rig = Rig::new(128);
        rig.feeds.push(Feed::new(0, Seg { from: 0, piece: 1, stem: 0, file: 0, region: None }, 0));
        rig.feeds.push(Feed::new(1, Seg { from: 0, piece: 2, stem: 0, file: 0, region: None }, ready));
        let (oa, ox) = (rig.off(SA), rig.off(start));
        rig.submit(&[rec_play(voice_id(0), STREAM0, true, oa, 1.0), rec_play(voice_id(1), STREAM0 + 1, true, ox, 0.0), rec_fade_out(voice_id(0), ox, X as u32), rec_gain(voice_id(1), ox, 1.0, X as u32)]);
        rig.run_to(T + 3 * 4096);
        let resid = null_test(&rig, SA, T + 8192, 1e-4, |t| {
            if t < SA {
                (0.0, 0.0)
            } else if t < start {
                src(1, 0, t - SA)
            } else if t < T {
                let k = (t - start + 1) as f32 / X as f32;
                let (a, b) = (src(1, 0, t - SA), src(2, 0, t - start));
                (a.0 * (1.0 - k) + b.0 * k, a.1 * (1.0 - k) + b.1 * k)
            } else {
                src(2, 0, t - start)
            }
        });
        println!("| {} (ready {ready}) | {} | {:.2e} |", start as i64 - ready as i64, resid.2, resid.0);
        if lead >= 128 {
            assert_eq!(resid.2, 0, "primed crossfade nulls: {:?}", resid);
        } else {
            assert!(resid.2 > 0);
        }
    }
    println!();
}

// ---------------------------------------------------------------------------------------------------------------------
// Q4: loop regions and a splice to a different segment

fn q4_loops() {
    println!("### Q4a: a region loop through the core\n");
    // The worker wraps loopEnd -> loopStart inside a chunk; the core sees one continuous signal.
    let (ls, le) = (10_001u64, 10_001 + 25_003);
    let mut rig = Rig::new(128);
    rig.feeds.push(Feed::new(0, Seg { from: 0, piece: 1, stem: 0, file: 0, region: Some((ls, le)) }, 0));
    let s = BASE + 53;
    let off = rig.off(s);
    rig.submit(&[rec_play(voice_id(0), STREAM0, true, off, 1.0)]);
    let end = s + 8 * (le - ls) + 5_000; // 8+ passes
    rig.run_to(end);
    let reg = Seg { from: 0, piece: 1, stem: 0, file: 0, region: Some((ls, le)) };
    let resid = null_test(&rig, s, end - 256, 0.0, |t| reg.at(t - s));
    println!("Region {ls}..{le} (length {}, not a multiple of 128 or 4,096), worker model wraps inside chunks as `decoder/streams.ts` does; 8 passes ({} frames): residual vs the ideal looped signal {:.1e}, frames wrong {}, starves {}. The core never knows about the loop: it plays the ring's continuous signal.\n", le - ls, end - s, resid.0, resid.2, rig.starved);
    assert_eq!((resid.2, rig.starved), (0, 0));

    println!("### Q4b: jump to a different segment at the loop point by a splice (a new epoch whose STREAM_OPEN has `loopEnd != 0`; `stream.rs:474-492`)\n");
    println!("One stream voice plays A from {SA}; at stream frame `at` = T - {SA} the stream continues with B (same ring, same voice, no new stream). The decision (the splice) is made at T - 20,000. B's first chunk reaches the ring at T - lead. Reference as Q3. The core's voice fades out over 5 ms (240 frames) when the ring holds less than a quantum plus the fade ahead, so the first B data must land before that.\n");
    println!("| lead (B data committed before T) | frames wrong in window | max error | starve events | silent frames in [T, T+8192) |\n|---|---|---|---|---|");
    for lead in [20_000i64, 4_096, 1_024, 640, 512, 384, 256, 128, 0] {
        let ready = qfloor((T as i64 - lead) as u64);
        let mut rig = Rig::new(128);
        rig.feeds.push(Feed::new(0, Seg { from: 0, piece: 1, stem: 0, file: 0, region: None }, 0));
        let off = rig.off(SA);
        rig.submit(&[rec_play(voice_id(0), STREAM0, true, off, 1.0)]);
        rig.run_to(qfloor(T - 20_000));
        let at = T - SA;
        assert!(rig.feeds[0].splice(&mut rig.core, at, Seg { from: at, piece: 2, stem: 0, file: 0, region: None }, ready));
        rig.run_to(T + 3 * 4096);
        let resid = null_test(&rig, SA, T + 8192, TOL, refseam);
        println!("| {} (ready {ready}) | {} | {:.3} | {} | {} |", T as i64 - ready as i64, resid.2, resid.0, rig.starved, (T..T + 8192).filter(|&t| rig.out[0][t as usize] == 0.0).count());
        if lead >= 640 {
            assert_eq!((resid.2, rig.starved), (0, 0), "splice lead {lead}");
        }
    }
    println!();
}

// ---------------------------------------------------------------------------------------------------------------------
// Q5: decoded clips, 8 voices, one stamp

fn q5_clips() {
    println!("### Q5: 8 decoded (non-streamed) clips, one stamp, all 128 sample offsets\n");
    let mut worst = 0f32;
    let mut cases = 0;
    for s_mod in 0..Q {
        let s = BASE + s_mod;
        let mut rig = Rig::new(128);
        for i in 0..8u32 {
            rig.core.clips_mut().reserve(1 + i, 20_000, 1, RATE, ClipFormat::F32).unwrap();
            let bytes: Vec<u8> = (0..20_000u64).flat_map(|k| src(3, i, k).0.to_le_bytes()).collect();
            rig.core.clips_mut().write(1 + i, 0, &bytes).unwrap();
        }
        let off = rig.off(s);
        let recs: Vec<_> = (0..8).map(|i| rec_play(voice_id(i), 1 + i, false, off, 0.125)).collect();
        for i in 0..8 {
            rig.watch(i);
        }
        rig.submit(&recs);
        rig.run_to(s + 20 * Q);
        let resid = null_test(&rig, s - 128, s + 2_048, TOL, |t| {
            if t < s {
                return (0.0, 0.0);
            }
            let l: f32 = (0..8).map(|i| 0.125 * src(3, i, t - s).0).sum();
            (l, l) // mono clips: L = R
        });
        worst = worst.max(resid.0);
        assert_eq!(resid.2, 0, "s_mod {s_mod}");
        assert_eq!(rig.first_nonzero(0), Some(s), "first sample at S, s_mod {s_mod}");
        for n in 0..8 {
            assert_eq!(rig.started(n), Some(s));
        }
        assert_eq!(rig.late().0, 0);
        cases += 1;
    }
    println!("{cases} runs (stamp offset 0..127 in the quantum), 8 clip voices each, gain 1/8: every voice's playhead starts at S, the first non-zero output frame is S, the sum nulls against the reference (worst residual {worst:.1e}), `lateCommands` 0. Asserted.\n");
}

fn memory() {
    println!("### Ring memory\n");
    println!("Narrow ring storage (`stream.rs:99-107`): ({RING_FRAMES} ring + 4,096 chunk tail + 1,536 seek-fade copy) x 2 ch x 4 B = {RING_BYTES} B = {:.1} KiB per stream; a ring holds {:.2} s at 48 kHz.\n", RING_BYTES as f64 / 1024.0, RING_FRAMES as f64 / 48_000.0);
    println!("| preset | max_mixed | rings | Streams region |\n|---|---|---|---|");
    for (n, m) in [("low", 64u32), ("default", 128), ("high", 256)] {
        let rings = (m as usize / 16).clamp(4, 16);
        println!("| {n} | {m} | {rings} | {:.2} MiB |", (rings * RING_BYTES) as f64 / (1 << 20) as f64);
    }
    println!("\nFor comparison one *decoded* stereo stem (f32, 48 kHz): {:.1} MB per 3 minutes; as i16 {:.1} MB (`clips.rs` formats [U] which the arena stores).\n", 180.0 * 48_000.0 * 2.0 * 4.0 / 1e6, 180.0 * 48_000.0 * 2.0 * 2.0 / 1e6);
}

fn main() {
    println!("# streams-align results (generated by `cargo run --release --bin align`)\n");
    memory();
    q1_single();
    q1_stems();
    q3_seam();
    q4_loops();
    q5_clips();
    println!("All assertions passed.");
}
