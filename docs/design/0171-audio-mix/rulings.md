# 0171 audio mix (M5): coordinator's rulings, round 2

Issued 2026-11-12 after both round-2A reviews ([review-round2-architect.md](review-round2-architect.md), [review-round2-senior.md](review-round2-senior.md)), in one batch. Rulings settle disagreements **between the two documents**; anything that changes product behaviour, scope or schedule is on the owner list at the end. Each author revises only their own document and ends it with a resolutions table covering every item of the other's review.

In round 2A several points **crossed**: each author conceded to the other's round-1 position (lanes, drag ramp, rotation, `loadPermille`, replay, live decoding). The rulings below pick one answer for each; where your concession and the ruling differ, the ruling wins.

Code facts checked for these rulings:
- the reverb send is taken inside `slot.fx.process` (`audio-core/src/bus.rs:540`) before the gain stage (`:547-568`), so no gain lane silences it today;
- `ProjectSurface.changed()` exists with no arguments (`src/editor/sdk/project.ts:42-43, 67-68`);
- ADR 0147 is **Proposed** (its line 3), so an amendment section may be appended to it;
- `loadPermille` is written by the core as 0 today (`counters.rs:424-425`, `status.rs:241`);
- tests hard-code 16,384 (`runtime/core/mirror.test.ts:133,141`, `runtime/core/bufferPool.test.ts:96`);
- the lookahead is `clamp(2Δ̄, …)` (`lookahead.ts:27-31`), 67 ms at 30 fps.

## Core mix model

**R1. Seven gain lanes.** `authored`, `runtime`, `snapshot`, `monitor`, `dip` (main-written) and `duck`, `automation` (core-owned). Lane ids and byte order are the senior's. Mapping (the architect's review, point 1): `authored` = `authoredVolume` × authored mute; `runtime` = script volume, its fade and script mute; `monitor` = monitor mute × the solo gate (main evaluates solo over the slot tree from script and monitor solo, `mixer.ts:233-238`'s rule). Reason: a dip, a monitor toggle and a fade overlap, and a product of ramps isn't a ramp, so one main-composed gate lane is inexact; settled lanes fold into one scalar per quantum and cost nothing. The main-side gate composer (task Mx3) is **dropped**.

**R2. One fader law.** Interactive edits are **asap, never stamped**, posted with `flushNow()` and at most one post per `FADER_COALESCE_MS` = 4. Ramps: **`DRAG_RAMP_MS` = 10** for continuous drags (a 5 ms ramp leaves plateaus between 16.7 ms pointer steps); **`BUS_MIN_RAMP_MS` = 5** for toggles (mute, solo, monitor) and as main's floor for script jumps. `frames = 0` is a literal step used only by replay and RESET. The ≤ 50 ms gate is measured on the audio clock from `event.timeStamp` to the first changed rendered sample, p95 over 100 drags; device output latency is reported beside it, not inside it.

**R3. Bit-identity.** An asap `BUS_RAMP` on a lone lane uses `Ramp::next`'s arithmetic, and lanes at identity are skipped, so **every existing bus golden keeps its digest** with a harness that sends `BUS_RAMP` where it sent `BUS_MIX`. Only stamped cases and R11's named change get new goldens. `BUS_MIX` is retired. G1's acceptance reads "digests unchanged".

**R4. Presence ducking moves into the core in M5-0** (task Dp1). `BUS_PRESENCE` is stamped at the voice's frame. **Presence rules add no sort edge**; only level rules do.

**R5. Level rules and cycles.** Kahn order over child → parent edges plus level-rule edges, deepest first then lowest index (equal to `bus.rs:386-399` with no level rules). Validation refuses **any** cycle among level rules with the tree, naming the rules; presence rules keep only the ancestor/self check. `MAX_DUCK_RULES` = 32, of which at most 8 are level rules.

**R6. Lane-ramp overflow and order.** A `BUS_RAMP` that finds the due list full applies at the quantum's start and counts `busRecordsEarly`; it never splits. Two records for one lane in one quantum apply in frame order. `BUS_DUCK` and `LOUD_CONFIG` are asap only; `BUS_SLOT` and `BUS_PRESENCE` carry a frame (quantum granularity for `BUS_SLOT`).

**R7. `BUS_SLOT` (0x1C)** is taken: one slot's parent and effect list in the BUS_CONFIG item layout, with a frame. `BUS_CONFIG` stays the full-tree record, used at init and in replay. Parameter smoothing: **only the compressor** (`COMPRESSOR_SMOOTH_MS` = 20); filter frequency and Q and send levels stay direct (S4 measured them clean, abrupt 0.15 and 0.10).

**R8. The structural dip is one stamped sequence.** The dip-down ramp, the `BUS_SLOT` change and the dip-up ramp go in **one batch from one F0 = now + lookahead** (the senior's blocking issue 2). A structural edit isn't under the fader gate; it is heard within lookahead + 2 × `DIP_FRAMES`. **Late-batch rule (architect to specify, senior to encode):** a structural record never applies before the dip-down ramp it follows has reached 0 — if the batch arrives late, the core shifts the whole sequence to the arrival quantum (as M4's group rebase does) and counts `lateCommands`. One structural sequence in flight; same-frame structural ops coalesce; later ones queue. `DIP_FRAMES` = round(0.020 × sampleRate).

**R9. Tombstones** are the architect's silent root (lanes held at 0, no effects, no wire sentinel). A slot is recyclable when its dip has ended, no voice references it, and one quantum (`TOMBSTONE_TAIL_FRAMES` = 128) has passed. They count toward the 32 slots.

**R10. Live adds that find no slot are deferred**, not refused: `ApplyResult.deferred`, retried each time a tombstone recycles; the fifth-effect case applies at the next Play. The edit is always kept in `project.json`. The message says when it will apply.

**R11. Reverb sends and the lanes.** The dip and the monitor lane **must** scale the bus's reverb send (structural safety and a faithful monitor solo/mute): both documents adopt this. Whether the send also follows the bus's fader and script/authored mute (post-fader, as FMOD's sends default) is **owner item O1**; design for post-fader as the recommendation and state what the alternative changes. Either way it is the one named exception to R3 (a new golden for a muted bus with a send). The convolver **runs out** until its input has been silent for the IR length plus `IDLE_MARGIN_QUANTA` (`zones.rs:116`), then resets: new core task **Rv1**.

**R12. Rebuild replay.** After RESET, in the order RESET, `BUS_CONFIG` (slot order), rules, presence, loudness config, lanes: `runtime` and `snapshot` lanes replay as **their remaining ramp** (a 5 s fade continues); `authored`, `monitor` and a drag replay at their value; a dip replays as its **end state** (lane 1, new layout). RESET settles lanes **on their targets**, as `bus.rs:437-452` does today.

## Stream, capture, CPU

**R13. Keyframes** are keyed on STATUS **frames**: header field `keyframeIntervalMs` = 1000, measured in rendered frames (not rAF, not a block count). Index `KEYFRAME_INDEX_SLOTS` = 4,096. Keyframe voice rows ≤ 24 B, cap **8,192** voices (`audioSettingsModel.ts:207`). Keyframes carry each lane's value and target and each metered bus's readings (M, S, I, LRA, max true peak, max M, elapsed, flags), the active snapshot and event states.

**R14. EPOCH and GAP.** EPOCH reasons: start, trap, stall, device, rate, latency, mode (one per `RebuildReason`, `recovery.ts:32-38`); it carries `timeOffset` (f64 s) and the limiter latency. **Resume is not an epoch**: it is a GAP. GAP reasons: paused, rebuild, held, dropped (with first and last missing seq), recordTooLarge; `hidden` means only `audio.background: "pause"`. Records carry the `deferred` flag (bit 0; real stamp in the payload) with disorder bounded to 1 s within an epoch. The heard-clock statement is the architect's (S6 answer): a record at frame f is heard at `Audio.time` = f / rate + timeOffset; a STATUS at `currentFrame` f is heard ≈ f − limiter − output latency.

**R15. Capture sizes** quote S3's **raw** column everywhere: 0.27 / 0.84 / 2.45 MB per saved minute at 64 / 256 / 1,024 voices (synthetic, estimate). The record's delta figures are stale and will be corrected in the write-back.

**R16. Capture limits.** `CAPTURE_MAX_UNCOMPRESSED_BYTES` = 64 MiB, checked from the header before inflate and while inflating; largest record 256 KB. Header flag `compressed` (clear when `CompressionStream` is missing). The built-in trigger keeps **`CAPTURE_TRIGGER_MAX_FILES` = 16**: oldest deleted first on Tauri and Android (`Storage.list`/`delete`); on the web, where a download can't be deleted, the trigger stops at 16 per session with a message. A `start()` from Held begins a new take after a GAP; `save()` writes from the latest take's start keyframe.

**R17. One decoder: the Worker**, for files and for the live ring (live segments appended every second, `seek`, `range` with transferred arrays). The main-thread `LiveSource` goes. Pf3a's "redraw under 2 ms" covers scrubbing a live recording. Tasks: Rc6 added, Pf7 shrinks.

**R18. CPU figure.** Counters are cumulative **f64** (`busyMsTotal`, `quantaTotal`, five work-unit totals), written by the shell for the clock fields and by the core for work units. **Main computes the window** over `CPU_WINDOW_QUANTA` = 96 by `quantaTotal`; the wire's `loadPermille` stays 0 (reserved; documented as superseded by change 6). One implementation, testable with a fake clock in TS. `clockSteps` (u16, saturating) and `clockStepMs` in the header. Coarse clock: 1 ms normal; 2 ms widens the window to 384 quanta; coarser, or no step within 1 s, hides the line with "clock too coarse (n ms)". The NNLS refit stays on main and never feeds the cap.

**R19. STATUS layout** is the senior's revised one: header 256 B with `loudShed`, `busRecordsEarly`, `sidechainLate`, `clockSteps` in the reserved bytes 244–255; loudness item 16 B per metered bus; duck section only for rule targets (`{u16 slot, u16 pad, f32 gain}`). Worst case ≈ 17,824 of 20,480 B (the senior states the exact figure); 8 pool buffers. The recorder taps in `CoreLink.handleMessage` (`runtime/core/context.ts:239-247`). ABI 4.0, envelope 1.3.

## Loudness and the ladder

**R20. Taint.** `tainted` comes from **monitor controls and Compare only**. A monitor mute of X taints X, its ancestors and master; a solo taints every meter. MASTER ≠ 1, script or authored mutes and the hidden-tab mute **suspend the target check** (`target.state = "suspended"`) and don't taint; monitor controls also suspend it. `maxTruePeak` carries a lower-bound indication when true peak was gated. A ladder pause sets `incomplete` on resume.

**R21. The ladder step** is reported in a new header field `loudShed`; `m3Shed` keeps meaning bed and zone steps (ADR 0170's recovery reads it). First step, skipped when only master is metered, given back last. Ld7's files add `zones.rs`, `bed.rs`, `runtime/core/zones.ts` and an extension of `ladderRecoveryLoopback.test.ts`.

## Editor

**R22. The hook** is `editor.project.onSectionChanged(key, listener)`, fired **synchronously** from `Session.edit` after `history.push` and from `step` (undo, redo), only when the draft is valid. **Previews bypass the hook**: the Mixer model calls `mixer.apply` and `flushNow()` directly; only the commit goes through the hook. The 0147 change is an amendment section appended to ADR 0147 (Proposed).

## Task table and documents

**R23. Task-table changes** (the senior re-sums by script): split B1 into B1a (lanes, master, `BUS_MIX` removal, 4 d) and B1b (class B and overflow, 3 d); Rv1 (send scaling and convolver run-out, 4 d); Bn3 at **master + 8**; Ld2 depends on B1; Wa2 lists the hard-coded 16,384 tests and `wire.m4.test.ts:200`; Ld8 (loudness integrity); Rc1b, Rc6, Ma3 as proposed; Mx3 dropped (R1); B4 +0 (R7). Keep the **20% reserve** with named items; state the change against round 1 line by line.

**R24. Lengths.** Architecture ≤ 10,000 words of prose; API ≤ 14,000 excluding §11 (the task table and its sums). Cut by pointing at the other document instead of restating its semantics (the senior's lanes, dip, clock and CPU prose should cite architecture sections; the architect's record and STATUS field lists should cite API sections).

**R25. Wasm size.** The baseline is **319,799 B** (the committed `myco_audio.wasm`). The projected ≈ 347–351 KB passes the 327,680 B gate in `native/audio/build.mjs`; per CLAUDE.md that is a tripwire move to raise and record in the build log, not a reason to cut. Both documents say so in one sentence.

## Owner list (to bring after verification, provisional)

- **O1. Reverb sends follow the bus fader and mutes (post-fader)?** Recommended yes (FMOD's default; a muted bus stops feeding the reverb, which is what a designer expects). Alternative: only the dip and monitor controls scale the send; the fader and script mutes keep today's pre-fader send. Net effect: both ≈ the same days (inside Rv1); post-fader changes today's sound for a bus with a send whose volume isn't 1 or is muted.
- **O2. The task-table total and reserve** after round 2B.
- **O3. The floor-conversion run** (≈ 15 min on the Pixel 8 profile) that turns metered instructions into floor µs: every floor figure is an estimate until it runs. It can't change the design, only the tripwire numbers.

Further owner items come from each document's "For the owner" after 2B.
