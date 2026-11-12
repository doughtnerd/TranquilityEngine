# 0171 audio mix: the architect's round-2A review of `api-and-models.md` and `contracts-senior.md`

Reviewed at commit `89a4ae8` (`api-and-models.md`, 856 lines; `contracts-senior.md`, S1–S14). **[API :n]** is a line of `api-and-models.md`; **[ARCH §n]** a section of my `architecture.md`. This file changes no other file. What I will change in `architecture.md` and `contracts-architect.md` in round 2B is listed under "What I change" at the end.

## Verdict

**Approve with changes.** The API document is thorough and mostly consistent with the architecture. Its wire (STATUS 256 B header, 17,732 of 20,480 B), its capture framing and its task table are sound. It found two real faults in my draft: the dip doesn't silence a reverb send ([API :818]), and the hook can't be called `changed` ([API :813]). There is **no blocking issue**. There are **6 major** and **10 minor** issues. The majors are:
- level-rule cycles aren't refused;
- `tainted` is set by MASTER ≠ 1;
- EPOCH lacks `timeOffset` and lists `resume` as an epoch;
- a hard-coded 16 KB size in tests;
- the saved-size figures use the delta column;
- four task-table gaps (the convolver run-out, the send dip, the ladder step's files, master + 8).

## The coordinator's six points

1. **Gain lanes: I accept seven.** The senior's argument holds: a dip, a monitor toggle and a script fade can overlap. A product of two ramps isn't a linear ramp, so main can't compose them into one gate lane exactly. A settled lane costs nothing (the core folds settled lanes into one scalar per quantum), and only a ramping lane costs ≈ 1.8k instructions ([S4]). Seven lanes are therefore free unless they move.
   - **The mapping I need written into §3.1 and S1:**
     - `authored` = `authoredVolume` × (authored mute ? 0 : 1);
     - `runtime` = script `volume`, its fade, and (script `mute` ? 0 : 1);
     - `monitor` = (monitor mute ? 0 : 1) × the solo gate, which main evaluates over the slot tree from script **and** monitor solo (`mixer.ts:233-238`'s rule);
     - `snapshot`, `dip`, `duck`, `automation` as written.
   - **Taint** comes only from the monitor lane's monitor part, not from script solo.
   - **Mute and monitor steps** ramp over `BUS_MIN_RAMP_MS` (5).
   - I replace my lane G with `monitor` + `dip` in round 2B.
2. **The fader gate: one law, the senior's.** Interactive edits (preview ops on `authored` and `monitor`) are **asap with `frames` = `BUS_MIN_RAMP_MS` (5 ms)**, posted by `flushNow()` and coalesced to one post per `FADER_COALESCE_MS` (4) ([API :542]).
   - The lookahead argument is right: `L = clamp(2Δ̄, 1,024 frames, 100 ms)` (`lookahead.ts:27-31`) is 67 ms at 30 fps. My draft also made drags asap, so only the ramp length changes: 10 ms becomes 5 ms. S4 found a 128-frame (2.7 ms) volume ramp clean (abrupt 0.10), so 5 ms is safe.
   - **The gate is measured on the audio clock:** input event frame to first changed rendered frame, p95 over 100 drags, as Fg1 does. The device's output latency is reported beside it, not inside it.
3. **Presence ducking in the core in M5-0 (Dp1): agreed.** It is my [ARCH §4.6] too.
   - I adopt the senior's improvement: `BUS_PRESENCE` stamped at the voice's frame ([API :253]), not a level flag sent at the next frame.
   - One correction: **presence rules add no edge to the bus order** (their input is a flag, not a buffer). [API :297] adds an edge "per ducking rule"; it must be per **level** rule (issue 1).
4. **The hook is `editor.project.onSectionChanged`.** Confirmed: `ProjectSurface.changed()` exists (`src/editor/sdk/project.ts:42-43`). My C20 takes their name and their `SectionChange` shape ([API :503-515]).
5. **Constants:**
   - **Capture rotation:** **8** files (`CAPTURE_TRIGGER_MAX_FILES`). I drop my 16. At a few MB a file either works, and the senior owns the trigger (their owner item 3).
   - **`CAPTURE_MAX_UNCOMPRESSED_BYTES` = 67,108,864 (64 MiB):** twice the largest ring (32 MiB), as their placeholder assumed.
   - **STATUS:** header 256 B, worst case 17,732 of 20,480 B, so 2,748 B spare. That meets my "≥ 1 KB spare" (C10).
   - **ABI 4.0, envelope 1.3:** agreed.
6. **Capture sizes:** not corrected. [API :414] quotes "0.08 / 0.15 / 0.25 MB per minute … from the delta stream" as the compressed size. With raw STATUS (record change 2) the figure is **0.27 / 0.84 / 2.45 MB per minute** (S3, "Compressed" table, "raw stream" column). It hedges as unverified, but should quote the raw column (issue 5).

## Contract status: C1–C26

| # | Status | Exact change needed |
|---|---|---|
| C1 envelope | partly | Use record `flags` bit 0 as **deferred** (a stamp more than 1 s past the newest STATUS frame is recorded at F_now with its stamp in the payload) and state the bounded-disorder guarantee (≤ 1 s within an epoch) beside "records order by (epoch, frame, seq)" [API :360]. The rest (u8 type, u16 epoch, u32 len, u32 seq, f64 frame, `perfMs` in main payloads) is met |
| C2 EPOCH | partly | Add `f64 timeOffset` (the clock map's, `clock.ts:124-130`). Replace the reason list with: start, trap, stall, device, rate, latency, mode (one per `RebuildReason`, `recovery.ts:32-38`). Drop **resume**: a resumed context continues its frames, so it is a GAP (issue 3) |
| C3 GAP | partly | Add reasons `held` (a restart after a take ended while the ring was kept) and `dropped` (a later link's back-pressure, with `u32 firstSeq, lastSeq`). Say `hidden` means only `audio.background: "pause"`: under `play` and `mute` STATUS flows and there is no gap (`background.ts:4-10`) |
| C4 keyframe | partly | (a) Voice cap 8,192, the logical maximum (`audioSettingsModel.ts:207`), not 4,096 [API :386]: 8,192 × 28 B = 229 KB fits `CAPTURE_RECORD_MAX_BYTES`. (b) Add each metered bus's readings (M, S, I, LRA, max true peak, flags: ≈ 9 × 32 B) to the `mix` section, so a **truncated** capture shows the live integrated value instead of one recomputed from the kept sub-blocks only. (c) The interval: issue 9 |
| C5 names | met | META names + NAMES records |
| C6 other records | met | MIXOP, MARKER, masterChange, hiddenTab, META `audio` |
| C7 file | partly | Add header flag bit 4 `uncompressed` (no `CompressionStream`, ARCH §8). Set `CAPTURE_MAX_UNCOMPRESSED_BYTES` = 64 MiB. Replace `keyframeEveryStatus` with whatever issue 9 settles |
| C8 shell CPU | partly | I accept `loadPermille` staying 0 on the wire, with main computing it [API :265]; I withdraw my shell-filled window. Still needed: a u16 **`clockSteps`** (wall-clock steps clamped, saturating) in a reserved word at 244 |
| C9 section totals | met | f64 cumulative, five sections |
| C10 loudness | met | `loudBuses` + `loudEnergies`, flags, 2,748 B spare |
| C11 LOUD_CONFIG | met | |
| C12 duck gains | met | `busDuck` by slot, ≤ 32 |
| C13 ladder, counters, ABI | partly | The ladder step: per-meter `paused` flag, **not** counted in `m3Shed` (S9). Add cumulative u16 counters `busRecordsEarly` and `sidechainLate` (core; reserved words at 244–255 suffice) |
| C14 lane ramps | partly | Define overflow: a `BUS_RAMP` that finds the due list full applies at the quantum's start and counts `busRecordsEarly`; it never splits. [API :249] says the capacity covers it, but 32 buses × 5 main lanes + voice records can pass 256 in one quantum (a snapshot over 32 buses during a voice burst). The lanes themselves: point 1 |
| C15 presence | met | stamped at the voice frame, better than my level flag |
| C16 config, tombstone | partly | (a) **The dip lane scales the bus's reverb send** (their S4, accepted). (b) The shared convolver runs until its input has been silent for the IR length plus `IDLE_MARGIN_QUANTA` (`zones.rs:116`), then resets; this needs a task (issue 6). (c) Smoothing: `COMPRESSOR_SMOOTH_MS` = 20; filter frequency and Q and send levels stay direct (S4 measured them clean: abrupt 0.15 and 0.10). I withdraw my "glide everything". (d) Bit-identity: accepted as "M1–M4 digests unchanged with every lane settled at 1", BUS_MIX retired, bus goldens re-recorded [API :617] |
| C17 rules, validation | not met | Edges for **level** rules only; refuse **any** cycle among level rules with the tree, not only an ancestor trigger [API :182, :297]; `MAX_DUCK_RULES` = 32, of which at most 8 level (issue 1) |
| C18 settings | met | |
| C19 ops | met | `opClass`, preview and commit, Compare through `diffOps` |
| C20 hook | met | under the name `onSectionChanged`, and `flushNow` for previews |
| C21 slot table | met | `busRef` = gen << 8 \| slot; `Audio.debug().mix` counts (a table dump is welcome, not required) |
| C22 `Bus.loudness` | partly | `tainted` from monitor controls (and Compare, their choice, accepted) **only**, not "MASTER ≠ 1 or a mute" [API :70] (issue 2). Add a lower-bound indication on `maxTruePeak` (below the ceiling with `gatedQuanta` > 0). A ladder pause sets `incomplete` on resume (S9) |
| C23 debug | partly | Add `busRecordsEarly`, `sidechainLate` and `liveRefused` to `Audio.debug().mix` |
| C24 capture | met | 8-file rotation accepted |
| C25 tests | partly | Missing: the convolver run-out and send-dip click cases in Ck1; Ld2's "4 s stall sets `incomplete`"; Bn3 at **master + 8**; the ladder step with the 0170 recovery order in a loopback (issue 6) |
| C26 Worker, models | met | `ProfileSource` with `stateAt` and `series`; a live source on main is acceptable (issue 10) |

## Answers to S1–S14

- **S1 (lanes):** seven lanes with the mapping in point 1. The product is per sample over ramping lanes, with settled lanes folded into one scalar per quantum. `BUS_MIN_RAMP_MS` = 5 confirmed. `RESET` settles lanes on their targets, as `bus.rs:437-452` does for gains today; your "settles at unity" would drop main's intent before the replay re-sends it, which is harmless but should read "on their targets". In ARCH round 2B: §4.5's table.
- **S2 (stamped configuration):** confirmed. The order at one quantum boundary is (frame, batch order) for configuration records, then class B ramps that start inside the quantum see the new configuration. Configuration records wait in the scheduler's pending queue, not in the due list, so they can't overflow it. [ARCH §3.3, §4.5]
- **S3 (tombstones):** **`TOMBSTONE_TAIL_FRAMES` = 128** (one quantum of margin). The dip has silenced the bus **and its send** before the tombstone config applies. Its compressor and filter tails are at gain 0, and the reverb tail lives in the shared convolver, not the slot. So a slot is recyclable one quantum after its config frame with `busLive` = 0. Kept state per kept index and fresh unity lanes on re-add: confirmed. The 32-slot cap counting tombstones: confirmed. [ARCH §2.3, §4.7]
- **S4 (dip):** **`DIP_FRAMES` = round(0.020 × sampleRate)** (960 at 48 kHz); the dip lane scales the send (accepted, I fix ARCH §3.3); one sequence at a time with same-frame coalescing (agreed); a `dip` ramp naming a tombstone or an out-of-range bus is ignored and counted in `busRecordsEarly`'s sibling `busRecordsDropped` (or the existing dropped count, `bus.rs:118-120`, your choice); `COMPRESSOR_SMOOTH_MS` = 20; no other effect parameter is smoothed (S4).
- **S5 (ring):**
  - `RING_BYTES` low / default / high = 4 / 16 / 32 MiB, capped at 8 MiB per GB of `navigator.deviceMemory`, never below 4 MiB; with `deviceMemory` absent, the preset value.
  - `KEYFRAME_INDEX_SLOTS` = 4,096.
  - `CAPTURE_MAX_UNCOMPRESSED_BYTES` = 64 MiB.
  - `BUDGET_RECORDER_MS_PER_S` = 1.0 at 1,024 voices (container); keyframe ≤ 100 µs p99 at 1,024 voices (S3: 63 µs p50).
  - Eviction is by whole keyframe segments, and `truncated` is set at the first eviction past the take's start.
  - `KEYFRAME_EVERY_STATUS`: see issue 9. [ARCH §4.2]
- **S6 (clock):**
  - **EPOCH triggers:** the recording's start and every new core (trap, stall, device, rate, latency, mode); not resume.
  - **Gaps:** written from known events (pause suspend, rebuild dead time, held), not inferred. A reader may show an implicit gap where consecutive STATUS frames jump by more than `GAP_STALL_MS` = 1,000 ms of frames with no record (the stall threshold, `deviceChange.ts:21`).
  - **seq:** written by main, one counter: agreed.
  - **The heard clock**, stated exactly: a record at core frame f is heard when `Audio.time` = f / rate + timeOffset (`clock.ts:6-10`: `Audio.time` is already the heard clock in core frames). When a STATUS with `currentFrame` f is posted, the listener hears about f − limiterLatencyFrames − outputLatencyFrames. [API :378]'s "heard time of a frame is frame − limiterLatencyFrames" mixes the two (issue 4).
  - **The link's framing:** [ARCH §4.1] (HELLO = header, seq jumps, keyframe resync, `dropped` gaps, in-stream names). It needs exactly C1's deferred bit, C3's `dropped` and the NAMES record, nothing else.
- **S7 (CPU):**
  - `CPU_WINDOW_QUANTA` = 96. A per-quantum delta below 0 or above 1,000 ms counts 0 and increments `clockSteps`.
  - `CPU_COARSE_STEP_MS`: a step of 2 ms widens the window to 384 quanta; above 2 ms, or no step after 1 s, the line is hidden with "clock too coarse (n ms)".
  - The refit is main-only, never the cap: per-section NNLS over 64 windows, pulled toward the build constants.
  - Sections: as you list (sidechain and lanes in buses).
  - Cadence and skipped posts: the window is by `quantaTotal`. A driver restart is an epoch.
  - `loadPermille` stays 0 on the wire: accepted. [ARCH §4.3]
- **S8 (loudness):**
  - **Rebuild or RESET:** the core's `seq` restarts at 0 and the first take sets `reset`; main resets the feed and keeps the histograms (integrated continues).
  - **True peak:** the gate is the ceiling − 6 dB, and a change isn't a reset. `truePeak` = max(true peak, sample peak) since the last successful take.
  - **`gatedQuanta`:** cumulative per meter, the quanta in which a non-master meter skipped true peak because its sample peak was under the gate.
  - **Budgets:** core loudness typical 0.01 ms, worst **0.08 ms** (master + 8 full at p99 × 1.5, ARCH §7.2); main ≤ 50 µs per second.
- **S9 (ladder step):** first; the ladder's own trigger (1 s of underruns with the cap at its floor, `zones.rs:110`); skipped when only master is metered; given back last; **not** counted in `m3Shed`.
  - Why not `m3Shed`: main's zone manager lifts its own "one zone fewer" when `m3Shed` falls (ADR 0170), and `m3Shed` reads "bed and zone steps in force". The per-meter `paused` flag carries it.
  - Sidechain and `BUS_RAMP` are never shed. On resume `firstSeq` jumps and main sets `incomplete`. [ARCH §4.8]
- **S10 (sidechain):**
  - **Limits:** `MAX_DUCK_RULES` = 32, at most 8 of them level rules (the worst-case budget).
  - **Detector:** peak has instant attack and a 10 ms release; RMS integrates over 10 ms (one-pole).
  - **Gain law:** depth = clamp((level dB − threshold) / 6 dB, 0, 1), goal = 1 − depth × (1 − amount).
  - **Attack and release:** 63 % time constants as today's approach (`mixer.ts:208-211`), per quantum, interpolated per sample.
  - **Tap:** after the trigger's effects and snapshot low-pass, before every lane.
  - **Combining:** level and presence by min; rules by min per target.
  - **Order:** Kahn over child → parent edges plus **level-rule** edges, deepest first, then lowest index (this equals today's order when there are no level rules).
  - **Cycles:** an ancestor trigger can't come from validated settings; if one does, it reads the previous quantum.
  - **Budget:** `busDuck` linear by slot; `BUDGET_DUCK_CORE_US` 0.002 / 0.02 ms. [ARCH §4.6]
- **S11 (published constants):** accepted as published, with the values above for the placeholders.
- **S12 (budgets):** ARCH §7.1–7.2. Instructions per quantum:

  | Item | Typical | Worst |
  |---|---|---|
  | Lanes | 2 ramping ≈ 3.6k | 8 ramping 14.2k (32 × 1.8k for a full snapshot) |
  | Loudness | master + 3 gated 114.3k | master + 8 full 383.4k |
  | Duck | 2 level rules 17.2k | 8 level rules 90.9k |

  - **Floor:** instructions × 0.6 ns (est., unverified until the 15-minute floor run).
  - **The worst loudness allowance** is the full-true-peak figure at master + 8, not S1's hot 13.8 / 36.3 µs: hot content makes every gated bus run true peak, so full true peak is the bound.
  - **Recorder:** 1 ms per second.
  - **STATUS parse at 17,732 B:** no figure exists; Bn2 sets it.
  - **Mixer size:** **319,799 B** (your measurement of the committed wasm, checked: `ls -l` gives 319,799). My draft's 318,306 is goal.md's older figure; I take yours.
- **S13 (replay):** your order is valid. I **accept "one `BUS_RAMP` per non-unity lane with the remaining ramp"** over my "settled at the target" for `runtime` and `snapshot`, because a 5 s fade should go on. The `dip` is replayed as its end state (lane 1, new layout), as both documents say.
  - **Integrated history:** main keeps it and marks the gap.
  - **Hidden tab:** lanes are untouched. `mute` ramps `BUS_MASTER_OUT` to 0 (50 ms), which suspends the target check. Taps continue; under `pause` there is a GAP.
- **S14 (pool):** `STATUS_POOL_BUFFERS` stays 8 at 20,480 B, +32 KB; nothing in the worklet or the replay is sized by hand.
  - **Tests hard-code the old sizes:** `core/mirror.test.ts:133,141` (`new ArrayBuffer(16384)`), `core/bufferPool.test.ts:96` (`toBe(16384)`), `wire.m4.test.ts:200` (`STATUS_WORST_CASE_BYTES` 16192). Wa2 must update them (issue 7).
  - **An oversized STATUS:** the shell already drops a block whose `n` exceeds the buffer and returns the buffer (`coreDriver.ts:1032-1034`). Main's cumulative counters and the loudness cursor bridge it; the core's sent cursor has advanced, so that take's sub-blocks are lost and main sets `incomplete`. This is unreachable by the worst case.

## Issues

1. **major: level-rule cycles aren't refused, and presence rules add sort edges.** [API :182] refuses only an ancestor trigger, and [API :297] adds "a trigger-to-target edge per ducking rule".
   - Two level rules A → B and B → A form a cycle that no ancestor check sees.
   - A presence rule needs no edge (its input is `BUS_PRESENCE`, [API :253]). Adding one makes harmless presence pairs into cycles and constrains the order for nothing.
   - **Change:** edges for level rules only; validation refuses any cycle among level rules with the tree, naming the rules; B3's acceptance becomes "with no level rules the order equals `bus.rs:386-399`'s; every level rule's trigger comes first".
2. **major: `tainted` is set by "MASTER ≠ 1 or a mute"** [API :70].
   - MASTER sits after every bus tap (`bus.rs:601-616`), so it can't affect a non-master reading. On the output tap it is what was heard, which [API :79] already handles by suspending `target.state`.
   - Tainting every meter whenever the hidden-tab mute runs (`background.ts:5`) would mark most phone sessions.
   - **Change:** `tainted` from monitor controls and Compare only; MASTER ≠ 1 and mutes suspend the target check.
3. **major: EPOCH reasons and fields** [API :364].
   - `resume` isn't an epoch: a resumed context continues its frame count (the `pause` mode suspends, `background.ts:7`), so frames don't restart and counters don't reset; it is a GAP.
   - `hardRebuild` hides the reason the profiler needs (trap against stall, `recovery.ts:32-38`).
   - `timeOffset` is missing, so the editor's axis can't stay continuous across a new context the way `Audio.time` does (`clock.ts:124-130`).
   - **Change:** C2.
4. **minor: the heard-clock sentence** [API :378] reads as if every frame were heard at frame − latency. **Change:** S6's two statements.
5. **major (numbers): saved sizes use the delta column** [API :414]. **Change:** "compressed raw stream 0.27 / 0.84 / 2.45 MB per minute at 64 / 256 / 1,024 voices (S3, 'Compressed' table, raw column; synthetic, est.)". `CAPTURE_TRIGGER_MAX_FILES` 8 still holds at a few MB a file.
6. **major: task-table gaps.**
   - **(a)** No task makes the dip scale the reverb send, or keeps the convolver running to silence and resets it. Add both to **B1** (send scaling with the lanes) and **B2** (run-out with removal), and their cases to Ck1.
   - **(b)** **Ld7**'s files are `cap_controller.rs`, `loudness.rs`, but the ladder's triggers and steps live in `zones.rs:1009-1070` and `bed.rs`, and main's zone manager reads `m3Shed` (`runtime/core/zones.ts`). Add those files and a loopback test of the 0170 order (`ladderRecoveryLoopback.test.ts` exists to extend). 4 d holds.
   - **(c)** **Bn3** meters "master + 7 full"; the settled scope is master **plus** 8 (record change 12). Use master + 8.
   - **(d)** **Ld2** taps post-lane, so it depends on **B1**, not only B2.
   - **(e)** **B1** (seven lanes, class B in the due list with start-sample compares, `BUS_MASTER_OUT`, BUS_MIX removal, 5 d, S) is the densest core row. M4 split its due-list work over several rows. Split it into B1a (lanes, master, BUS_MIX removal, 4 d) and B1b (class B and its overflow rule, 3 d): +2 d.
   - Net: ≈ +4 d (B1 +2, run-out +1.5, cycle validation +0.5 in Sa1). It comes out of RS5 or is added; either way the total stays inside 62–75.
7. **major: hard-coded 16 KB sizes in tests** (S14). `mirror.test.ts:133,141`, `bufferPool.test.ts:96` and `wire.m4.test.ts:200` will fail or, worse, pass on a stale constant. **Change:** Wa2 lists them.
8. **minor: due-list overflow for `BUS_RAMP`** (C14): define "apply at the quantum's start, count, never split".
9. **minor: the keyframe interval.**
   - `keyframeEveryStatus` [API :56, :384] follows the record's words ("keyed on the STATUS count", change 2). Replay cost stays bounded by a count, and the interval is mine to fix.
   - At the idle cadence (48 quanta, `schema.rs:76`) 62 blocks span 7.9 s, so eviction drops up to 8 s at a time and the index's time spacing varies.
   - **I prefer** one second of STATUS frames (field `keyframeIntervalFrames` = the start rate), which is still driven by STATUS, not rAF. If the senior keeps the count, `KEYFRAME_EVERY_STATUS` = 62. Coordinator's ruling.
10. **minor: the live Profiler decodes on main** (`LiveSource` over the ring, [API :554, Pf7]). My draft handed sealed segments to the Worker. `stateAt` costs 0.2–0.7 ms p50 (S3), inside the 2 ms frame budget, so I accept the senior's simpler path if Pf3a's "redraw under 2 ms" acceptance includes the `stateAt` call while scrubbing a live recording.
11. **minor: the deferred bit and bounded disorder** (C1) are missing from §5.3.
12. **minor: the GAP reasons `held` and `dropped`** (C3) are missing.
13. **minor: the keyframe voice cap is 4,096** [API :386] while the logical maximum is 8,192 (`audioSettingsModel.ts:207`). Raise it to 8,192 or record truncation in the keyframe.
14. **minor: keyframe loudness readings** (C4 b): without them a truncated capture recomputes `integrated` from kept sub-blocks only and disagrees with what the live meter showed.
15. **minor: an `uncompressed` header flag** (C7) for a missing `CompressionStream`.
16. **minor: `RESET` "settles lanes at unity"** (S1) should read "on their targets", as `bus.rs:437-452` does today.

## Task table check

| Architecture requires | Covered by | Status |
|---|---|---|
| C25 click tests | Ck1 (every class, rename, remove, move, mid-list insert, last-send removal) | covered; add the run-out and send-dip cases (issue 6a) |
| Fake-clock CPU | Cp2 | covered; add `clockSteps` |
| Ring, zero allocation, eviction | Rc2, Bn2 | covered |
| Rebuild replay (lanes' remaining ramps, dip end state, slot layout) | Mx2, Ma2, Sm1 | covered |
| EPOCH and GAP records | Rc3 | covered; reasons per issue 3 |
| Loudness integrity | Ld2 | partly: add "4 s stall sets `incomplete`" and the EPOCH continuity case |
| Ladder step | Ld7 | partly: files and the 0170 loopback (issue 6b) |
| Metered scenes | Bn1, Bn3, Bn4 | partly: master + 8 (issue 6c); the floor conversion run is the owner's (ARCH preamble) |
| Fader gate | Fg1 | covered (audio clock, p95 over 100 drags) |
| Bit-identity goldens | G1 | covered |
| Convolver run-out, dip scales send | none | missing (issue 6a) |
| Level-rule cycle validation | Sa1, Dk1 | partly (issue 1) |
| The re-measurements of record change 31 | Bn2 (S3 idle, real core), Bn3, So1 | covered |

Levels and dependencies are realistic apart from issue 6: the S tasks sit on the core and the format, the M tasks on models and views, and the J tasks on docs. Splitting the core and editor chains across people [API :763] matches M4's experience. The milestone order puts the stream (M5a) before loudness (M5b). That is fine: Ld1, Ld3 and Ld5 have no dependency and can start early, as stated [API :631].

## Agreements

- **The dip must scale the reverb send** ([API :818], contract S4): my [ARCH §3.3] was wrong. The send is taken inside `fx.process` (`bus.rs:540`) before the gain lanes (`:547-568`), so a lane dip alone leaves it feeding the convolver.
- The hook's name `onSectionChanged` and its draft-identity op log ([API :501-516]).
- `max_buses` is 32 on every preset ([API :815]): the same finding as my §13 item 5. Their "refused visibly" with the tombstone explanation and my "keep the edit, apply at next Play" both handle it. Both documents keep the edit in `project.json` ([API :474]'s `restartRequired` path), so the difference is only the message wording: coordinator's ruling.
- The trigger-first sort fixes nothing audible in M5-0 ([API :814]): the same finding as my §13 item 1. Presence does gain the stamped frame.
- `loadPermille` stays 0 on the wire, and the shell (not the core) owns the clock fields ([API :820]).
- The STATUS layout, the 32-entry loudness ring with take semantics, f64 cumulative counters, tombstones as `parent` 0xFFFE, stamped configuration at quantum granularity, the per-voice dip for a moved sound, Compare through `diffOps` (tainting, with faders locked), the uncompressed 96 B header refusing before inflate, the decode `Reader`, the 20 % reserve.

## What I change in round 2B (architecture.md and contracts-architect.md)

- §4.5: seven lanes with point 1's mapping; drag and mute ramps 5 ms asap with `flushNow`.
- §3.3: the dip lane scales the send.
- §4.3: `loadPermille` stays 0 on the wire, and main forms the window.
- §4.6: presence stamped at the voice frame.
- §3.1: rotation 8.
- §6: wasm 319,799 B.
- §7.2: re-check the worst case with seven lanes (unchanged: settled lanes are free).
- §5.3: the placeholders the senior quotes by name (`DIP_FRAMES`, `TOMBSTONE_TAIL_FRAMES` 128, `MAX_DUCK_RULES` 32 / 8 level, `CAPTURE_MAX_UNCOMPRESSED_BYTES` 64 MiB, `GAP_STALL_MS` 1,000, `CPU_COARSE_STEP_MS` 2, `KEYFRAME_INDEX_SLOTS` 4,096, `RING_BYTES`).
- C8, C14, C16, C20, C22, C24: as the table above says.
