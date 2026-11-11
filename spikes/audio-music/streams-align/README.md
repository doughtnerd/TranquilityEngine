# S1: stream start alignment, priming and seams (audio M4 spike)

Question: can M4's interactive music (4-8 stem layers of one piece, transitions that begin exactly on a bar) rest on the core's streamed voices? Goal and constraints: [goal.md](../../../docs/design/0163-audio-music/goal.md). Rules: [BRIEFS.md](../BRIEFS.md).

**Short answer.** The core already starts a stamped stream voice sample-exactly *if its ring holds 4,096 frames when the quantum containing the stamp begins*. If not, the voice slips to the next quantum boundary after the data lands, by an unbounded amount, and **nothing tells main**. Stems whose rings fill at different times end up permanently skewed against each other. Priming (opening the streams early and stamping the PLAYs far enough ahead) needs **no core change** and gives exact starts, seams and crossfades, as the tests below show. What M4 needs is a prime planner on main, an acked group start, a slip counter in STATUS, and more rings.

## Method

- `src/lib.rs` drives the real `audio_core::Core` natively, as `native/audio/crates/audio-core/tests/wide_streams.rs` does: BATCH records through `scheduler::submit`, rings filled with `streams_mut().open / chunk_ptr / commit` at quantum boundaries (as the worklet shell does between `process()` calls), credits back with a quantum of latency each way, limiter look-ahead 0 so output frames are core frames. The decoder worker is a model (`Feed`): `buffered + inFlight <= 32,768`, 4,096-frame chunks, `ready_at` and throughput are parameters.
- Signals (`src`): a click (0.5) at file frame 0, then exact dyadic noise, stereo with R different from L. First non-zero sample = frame 0 of the file; any shift of any stem shows in the sum; sums at gain 1/N are exact to an f32 ulp. References are built from the generator, not through the core.
- Start frames are measured two ways: from the output (first non-zero frame, solo) and from each voice's playhead advance (concurrent voices).
- `src/prime.rs` is the prime planner prototype. `src/bin/decode_lat.rs` times the (native) decoder: open, seek, first chunk, full ring.
- Reproduce: `./run.sh` (correctness + timing), or `cargo run --release --bin align > results.md` (asserts; about 15 s; exit 0 = every "asserted" below holds). Full tables: [results.md](results.md). Timed decode run: [results-decode.md](results-decode.md) (coordinator's; expected 20-30 s (est.)).
- Smoke-only on the shared VM: decode numbers below are a 2x5 smoke, not measurements.

## What the code does today (cited)

| Claim | Where |
|---|---|
| A stamped PLAY writes its slot at once; the voice starts at its stamp's sample offset | `voices.rs:375-396`, `scheduler.rs:34-43` |
| A stream voice that starts but whose ring has < `START_FRAMES` (4,096) written holds silent in `WAITING`, position pinned to the ring's start, and re-checks at offset 0 of every later quantum | `voices.rs:705-713`, `stream.rs:24-27,114` |
| It binds to its ring (rate, channels) only when it first renders, i.e. at its stamp; a ring opened earlier is not consumed meanwhile, so the worker stops at 32,768 outstanding frames and idles | `voices.rs:677-681`, `credit.ts:8-22`, `decoder/streams.ts` header |
| `Audio.play(at)` on a stream: PLAY (stamped when `at` is ahead of F_now) and the worker's `streamOpen` are issued in the same call | `coreBackend.ts:1388-1394`, `clock.ts:298`, `core/streams.ts:250-279` |
| L = clamp(2 x frame interval, 1,024 frames, 100 ms) covers the *batch's* arrival, not the decode | `lookahead.ts:11-31` |
| 4 / 8 / 16 rings by preset | `stream.rs:118-120` |
| STOP with fade 0 ends a voice at its exact sample; STOP of a SCHEDULED voice ends it at once | `voices.rs:1390-1396` |
| A splice (new epoch, STREAM_OPEN `loopEnd != 0`) continues a ring at a stream frame the ring holds, if `consumed + 4 <= at <= written` and channels match | `stream.rs:474-492`, test `stream.rs:1243` |

## Q1. A stamped stream PLAY whose ring is not full at its frame

Rig result (asserted over 1,408 cases: every sample offset 0-127 of S x 11 arrival quanta). `A` = the quantum boundary before which OPEN + the first full chunk were committed.

| Data state at S | Voice starts at | Slip |
|---|---|---|
| (a) committed before S's quantum begins (A <= floor(S/128) x 128) | **S, sample-exact** (first non-zero output frame = S; null vs reference = 0 frames wrong) | 0 |
| (b) committed after (A > floor(S/128) x 128) | A (offset 0 of a quantum, never mid-quantum) | A - S: 1 to 128 for the next quantum, 4,096 for 32 quanta late, 50,011 for 50,000 frames late. Unbounded |
| first chunk partial (1,000 frames) | the quantum after the chunk that brings the ring to >= 4,096 | one extra quantum per extra chunk |

Slip by arrival (cells = first non-zero frame minus S):

| s_mod \ A - 96,000 (quanta) | -40 | -1 | 0 | +1 | +2 | +8 | +32 |
|---|---|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 128 | 256 | 1024 | 4096 |
| 37 | 0 | 0 | 0 | 91 | 219 | 987 | 4059 |
| 127 | 0 | 0 | 0 | 1 | 129 | 897 | 3969 |

**No signal reaches main.** `lateCommands`, `maxLatenessFrames` and `starved` stayed 0 in every case including the slipped ones (asserted): the stamp was on time, the voice then waits silently. A slip is invisible today.

**(c) 4 and 8 stems of one piece, one stamp** (gain 1/N, click at frame 0 of each; one worker opens stems D frames apart). Excerpt of the table in results.md:

| N (rings) | D | T0 - S | start_i - S | spread | null (sum vs reference) |
|---|---|---|---|---|---|
| 4 (64 mixed) | 512 | -3,072 | 0 0 0 0 | 0 | 0 wrong frames |
| 4 | 512 | 0 | 0 475 987 1499 | 1,499 | wrong for the whole piece, max error 0.375 |
| 8 (128 mixed) | 2,048 | -21,504 | all 0 | 0 | 0 wrong |
| 8 | 2,048 | -10,240 | 0 0 0 0 0 0 2011 4059 | 4,059 | 0.19 |
| 8 | 2,048 | 0 | 0 2011 4059 6107 8155 10203 12251 14299 | 14,299 | 0.44 |

Stems that were ready before S's quantum start at S together (sum nulls exactly). A late stem starts at its own quantum boundary and stays shifted: the stems drift apart by up to (N-1) x D, for the whole piece. Never sample-exact unless every ring was ready.

**Capacity.** 8 stems on the low preset (64 mixed = 4 rings): 4 streams open, 4 STREAM_OPEN refused, **4 of 8 voices ever start**; the rest wait silent until main stops them (`stream.rs:39-40`). A piece of 4+ stems cannot cross-fade into the next one's 4+ stems on low (8 rings needed), nor 8+8 on default (16 needed; default has 8).

## Q2. Prime (pre-roll) path

**Finding: the core needs no prime command.** A stream voice is not bound to its ring before its stamp, so `STREAM_OPEN` + chunks sent any time earlier just fill the ring to 32,768 frames and idle (the worker stops at the credit window, no timers). The existing contract is the whole story:

> **Stream-start contract.** A stamped stream PLAY starts exactly at its stamp iff, when the quantum containing the stamp begins, the ring holds >= 4,096 frames of the stream's current epoch (STREAM_OPEN taken, first chunk committed).

Today `Audio.play(at)` primes implicitly (PLAY and `streamOpen` go out together), so it is exact when `at - now >= prime time`; `L` does not cover prime time.

**Prototype** `src/prime.rs`, validated against the core (asserted; table in results.md, 27 rows):

- `prime_lead(N, cost, L) = max(L, (N x D + tail + 128) x 1.25)` where `D` is the per-stem cost in the one decoder worker (fetch + wasm open + seek + decode of a 4,096-frame chunk + post) and `tail` the worker-to-worklet delivery tail.
- `plan_bar_transition(now, grid, N, cost, L)` returns the first bar line at or after `now + lead`.
- Rig: whenever the worker is no slower than 1.25 x the estimate, all stems start at the stamp and null (asserted, 18 rows). At 2x the estimate on a tight plan, the late stems skew: `0 0 512 1408`, `0 0 0 0 0 896 1920 2816`, or never start before the window closes, silently.

**How far ahead must priming begin?** The prime lead is `N x D + tail`; it has no ring-size term. Components:

| Component | Value | Source |
|---|---|---|
| main -> worker `streamOpen` postMessage (bytes transferred) | ~0.2 ms RTT p50 / 0.5 p99 (idle main); main jank adds its own stall | M1 `spikes/audio-worklet/messaging` section 2 |
| decode: open + first 4,096-frame chunk, native | town.mp3 0.14 ms, FLAC 0.08, WAV 0.02, Ogg fixture 1.3; with a seek 0.2 / 0.18 / 0.03 / 1.1; full 8-chunk ring from mid-file 1.2 / 0.46 / 0.10 / 1.6 ms | `decode_lat` **smoke only (2x5, shared VM)**; wasm 1.5-3x (est.) |
| worker -> worklet chunk delivery tail | one-way p50 1 quantum (2.7 ms), p99 4-5 quanta (11-13 ms) | M1 messaging section 2 |
| encoded-file fetch | 0 if the bytes are cached; a network/disk read otherwise: unmeasured | [U] |

N = 8 cached stems: about 8 x (0.5 to 4 ms) + 13 ms = 17 to 45 ms (est.), so a lead of 50-100 ms is enough in the best case; a cold fetch of 8 files can be hundreds of ms. The Q1c/Q2 tables show what one missed stem costs.

**Ring size.** It bounds how much audio is *buffered* ahead (0.68 s), not how far ahead a start can be primed: a primed voice can sit SCHEDULED for as long as needed with its ring full and the worker idle. Priming earlier than about 0.68 s before the stamp adds no buffered audio, only holds a ring and a voice slot. Memory per stream: 307,200 B = **300 KiB** (`stream.rs:104-108`); low 4 rings 1.17 MiB, default 8 rings 2.34 MiB, high 16 rings 4.69 MiB. A decoded stereo f32 stem costs 69 MB per 3 minutes (34.6 MB as i16 [U], arena format not checked).

## Q3. Seamless transition A -> B

A streamed from S_A = 24,005, B streamed, T = 216,005 (two bars at 120 bpm later, off the quantum grid on purpose). A ends by a stamped STOP (fade 0) at T, or by its own last chunk; B's PLAY is stamped T. Window checked: [S_A, T + 8,192), tol 1e-6.

| B data committed (T - ready) | A ends by | frames wrong | max error | silence after T |
|---|---|---|---|---|
| 44,101 / 20,037 / 4,293 / 69 (the last = T's own quantum start) | STOP and natural end | **0** | 0.000 | 0 |
| -59 (one quantum late) | STOP | 8,192 (all) | 0.500 | 59 |
| -571 (10 ms late) | STOP | 8,192 | 0.591 | 571 |
| -2,491 (50 ms late) | STOP | 8,192 | 0.673 | 2,491 |

Primed: sample-exact in both ending styles, with no fade and no click. Unprimed, B starts at the next quantum and **everything after is shifted by the slip** (a musical offset, not a click), after a hole of that length. With the engine's issue-together behaviour (`lead = L - D`), L = 1,024 fails once D > ~960 frames (20 ms); L = 4,800 (100 ms) survives D up to 4,800.

**Crossfade** over X = 4,800 frames, linear gains, B starting at T - X (A: stamped FADE to 0 with stop-at-end; B: PLAY gain 0 plus SET_PARAMS gain 1 over X, both stamped T - X):

| B data committed | frames wrong | max error |
|---|---|---|
| 20,101 or 133 frames before T - X | 0 | 1.2e-5 (the core ramp's f32 step accumulation, `audio-dsp/src/ramp.rs:51-57`) |
| 123 or 507 frames after | 12,990 | 0.50 |

Equal-power or other curves need either many stamped SET_PARAMS steps or a curve ramp in the core (not tested).

## Q4. Loop seams and region-loop jumps

- **A streamed loop region is already sample-exact.** The worker wraps `loopEnd -> loopStart` inside one chunk, so the ring (and the core) see one continuous signal: `decoder/streamRegion.test.ts` "wraps a region gaplessly" checks every frame of 5+ passes of a 13,000-frame region (and the file's own `smpl` points, a start inside the region); my rig repeats it through the core: region 10,001..35,004 (25,003 frames, off both the 128 and 4,096 grids), 8 passes, 0 frames wrong, 0 starves (asserted). The core never knows about the loop (`stream.rs:72`).
- **A region change or release lands on an exact stream frame** (`atStreamFrame`), by a splice when the worker had sent past it: `streamRegion.test.ts` (release at a seam already sent; region change at a frame already sent) and core test `stream.rs:1243` ("plays on gaplessly into the new epoch at its frame"). Main predicts the frame from the STATUS playhead: exact while the voice neither starves nor changes pitch (`core/streams.ts` header).
- **Can a loop end jump to a different segment? Not today.** `changeLoop` seeks the same decoder handle (`decoder/streams.ts:379-425`): it can jump to another *region of the same file* only. The core's splice is agnostic to content, so I tested a stream continuing with different audio (B) at stream frame `at`, same ring and voice: sample-exact (0 frames wrong, 0 starves) when B's first chunk is committed at least ~325 frames before the seam; at 197 it fails (367 frames wrong, error 0.13) and at 69 a starve fade begins (8,517 wrong). The reason: the voice begins its 5 ms starve fade when less than a quantum plus the fade (368 frames) is buffered ahead (`voices.rs:754-757`), so the new epoch must arrive before that, i.e. a splice needs more lead than a fresh primed start (which only needs the ring ready by the stamp's quantum). Splice also needs the same channel count (else it restarts as a seek with a fade) and does not re-bind the sample rate (`voices.rs:677-680`, bind-time only) [U, from code]. A worker op to continue with another file does not exist.
- Cheaper alternative with no new code: loop A as a region, and at the bar: STOP A at T (fade 0) and a primed B stamped at T (Q3). It costs a second ring while B is primed.

## Q5. Decoded clips, 8 voices, one stamp

Asserted for 128 runs (stamp offset 0-127 in the quantum), 8 clip voices each at gain 1/8: each voice's playhead starts at S, the first non-zero output frame is S, the sum nulls (worst residual 0.0), `lateCommands` 0. Existing coverage: `audio-core/tests/golden_native.rs:476` ("a stamped play starts at its sample offset"), `:500` (late: offset 0 and counted), `:519` (stamped stop). Decoded clips need no priming; the cost is memory (above) and decode time before the stamp.

## Recommendation for the M4 design

1. **Write the stream-start contract into the design** (the box in Q2). The core already honours it; no PRIME command is needed there.
2. **Prime on main/worker, acked, as a group.** A segment's stems are one group. The music layer opens all N streams at `now`, waits for a worker ack per stream (`streamPrimed {streamId, epoch, framesPosted}`, posted after the first chunk is posted), then sends the stamped PLAYs (stamp >= ack + L). If the acks are late, re-plan to the next grid point instead of stamping into a slip: STOP of a SCHEDULED voice is safe and immediate (`voices.rs:1394-1396`). `prime.rs` is the planner: `lead = max(L, 1.25 x (N x D + tail + 128))`, with D measured per platform (the coordinator's runs plus a Chromium wasm-worker measurement still to do).
3. **Make slips visible.** Add a core STATUS counter for stream voices that were still WAITING after their stamp (count and max slip frames), next to `lateCommands`. Today a slip and a permanent stem skew are silent. This is a small core change [U on effort]. A group gate in the core (stems of one `group` start only when all rings are ready, together) would also remove skew by construction at the price of a whole-group slip; not needed if (2) is done.
4. **Pre-prime likely candidates.** Next-beat transitions have less than N x D of lead: keep the next segment's stems primed (SCHEDULED, rings full, idle) and release them at the beat. The cost is rings and voice slots only.
5. **Ring budget.** 300 KiB per ring and 4 / 8 / 16 rings are too few for A + B stems: low gives one 4-stem piece and no overlap. Give music its own pool (e.g. `maxMusicStreams` = 2 x the largest stem count), or use decoded clips for short loops (a 32 s stereo stem is 12 MB f32). Keep the ring at 32,768 frames and chunks at 4,096: priming does not depend on them.
6. **Seams.** Stamped STOP fade 0 plus a primed B, or a natural end, are exact. Crossfades work with stamped FADE and SET_PARAMS (linear, 1e-5). Equal-power curves need a curve ramp. Treat a splice-to-another-file as an optimisation for later (needs a worker op, same channels, same rate, ~370 frames of extra lead).
7. **Do not rely on stems as separate streams without the group ack:** the failure is permanent skew, silent.

## Unverified

- Wasm decode and the real worker/Chromium path (fetch, `streamOpen` transfer, wasm copy, serial opens, worker -> worklet ordering relative to main's BATCH) are not measured; `decode_lat` is native only and smoke-run. Every prime-lead number in ms is **(est.)**.
- M1's postMessage numbers are from Windows desktop Chromium, one run per cell.
- That a worker -> main ack precedes the chunk's commit in the worklet is an assumption of the protocol [U]: the two travel on different ports; the stamp's margin (L plus the ack hop) is what covers it.
- Splice with a different sample rate (stale `rate_ratio`) and stems at 44.1 kHz in a 48 kHz context (Lagrange-resampled; starts stay aligned, the bit-exact null does not apply) are from code reading, untested.
- Arena clip formats and sizes (i16 storage) not checked.
- The worker model is simple (fixed delivery cadence, no stalls); stall behaviour is covered by `wide_streams.rs` (300 ms stall at 32,768).
- Babylon fallback has no stamped streams (`goal.md`); nothing here applies to it.
