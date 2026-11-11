# Interactive music M4: the task tree

Who leads each task of [the waves plan](2026-11-audio-music-m4-waves.md), what the lead keeps, and which leaves the cheapest model fills. The task table ([api-and-models.md §10](../design/0166-audio-music/api-and-models.md#10-task-breakdown)) owns IDs, days, dependencies and acceptance; the waves plan owns order, files and gates. **Every leaf day and every model share below is a plan estimate** until the pilot wave reports.

## Tiers

| Tier | Model | Owns |
|---|---|---|
| Coordinator | strongest (main session) | Q0, waves, contracts, single-writer files, merges and wasm rebuilds, the flip branch merge, wave reviews, global checks, the build log |
| Lead | strongest for S rows, Q1, Q2 and L3; mid for M and J rows | the task's skeleton, its hard core, the glue, merging its leaves, the acceptance check |
| Leaf | cheapest | one or two skeleton files filled to a quoted spec, with their own tests |

J rows go to a mid lead, not straight to the cheapest model: D2–D5, Z6 and L1 are prose readers see (the lead keeps it), and G1, Ed9 and Rh2 are a lead plus leaves because G1 and Rh2 sit on the pure chain.

## Collision audit

Every file two tasks in one wave would have touched (*hotspot*), and every later rewrite of an earlier task's output (*rework*), from the table's file columns and the design's §5–§7 layout:

| # | Found | Tasks, wave | Fix |
|---|---|---|---|
| A1 | `voices.rs`: Z2b and Z2c both edit it after Z2a | Z2b, Z2c, W3 | **hook stub** H1: Z2a restructures the per-voice loop into sub-ranges bounded by `voice_split::boundaries` (with its own bit-identical test) and routes the gain-loop compare to `curves::due_gain`; Z2c owns new `voice_split.rs` and never touches `voices.rs`; Z2b takes `voices.rs` alone in W3 only if the hook proves too narrow |
| A2 | `due.rs`: Z2c and C2d (table) both edit Z2a's file | Z2c (W3), C2d (W6) | Z2a writes the whole routing (class G and S marked) and a parked-record API; Z2c works in `voice_split.rs`, C2d in new `group_rebase.rs` (H2) |
| A3 | `groups.rs`: C2c and C2d both edit it after C2b | C2c, C2d, W6 | **per-concern modules**: `group_hold.rs` (C2c), `group_rebase.rs` (C2d), declared in Q1, called from C2b's hooks (H2); one lead runs both anyway |
| A4 | `layout.rs`: Z2a (regions `Due`, `Curves`), C1, C2a (`Groups`) | W2–W4 | **complete config early**: Q1 lays out all three regions in W1; C1 sizes `Streams` in `stream.rs` (`region_bytes`), not `layout.rs` |
| A5 | `counters.rs`: C2b adds counters; the STATUS header lands once (Z1) | C2b (W5) | **counters struct**: Q1 declares every M4 counter and writes the header from it; tasks set their counters in their own module |
| A6 | `params.rs`: W1's `max_music_rings` and C1's pool sizing | W1, C1 | W1 adds the field and validation; C1 only reads it |
| A7 | the wire: Z1 then W1 on the same schema files | W1 | **generate the whole format first**: one lead, two merges in W1; nobody touches the schema after |
| A8 | `statusReader.ts`: Z4 and P10 (table) | W2, W5 | Z4 parses the whole M4 STATUS (both sections); P10 reads the struct (H4) |
| A9 | `decoder/streams.ts`: D1a, D1b, D1c | W2–W3 | **per-concern modules** H3: D1a owns `streams.ts` and creates `musicGroups.ts` (D1b fills cancel and retarget) and `musicCache.ts` (D1c fills) |
| A10 | `decoder/protocol.ts`: D1a, D1b, Ed1 | W1–W3 | Q0 declares every M4 message, peaks included; D1a refines in W2; Ed1 edits only `handler.ts` |
| A11 | `coreBackend.ts`: the group operations have no row, and P1 would add them to a 1,858-line file other work also touches | P1 | **per-concern module**: Q2 wires `core/musicOps.ts` from `coreBackend.ts`; P1 fills `musicOps.ts` |
| A12 | `Audio.ts`, `myco.ts`: P7, K3, K5, Rh1 (and R5, R7 through the handle) each add members | W5–W9 | **declare the whole surface early**: Q2 declares §1 in full, delegating to stubs in each owner's file; P7 fills `Audio.ts` bodies; K3, K5, Rh1, R5, R7 fill their own files |
| A13 | `audioSystem.ts`: P7 (early step) and K2 (dispatch) | W5, W8 | Q2 registers step 0 and step 9 once; P7 and K2 fill `musicSystem.ts` in order |
| A14 | `music/transition.ts`: R7 beside R3b | W7 | **interface stub** H5: R3a exports `planImmediate`; R7 owns new `music/seek.ts` |
| A15 | `music/handle.ts`: R7, K3 (table) and P7 | W5–W8 | P7 (W5) fills the M4a members, K3 (W8) `positionAt` and `judged`; R7's seek is in `seek.ts`, R5's `trigger` in `stingers.ts` (Q2 delegated both) |
| A16 | `settings.ts`: Rh1, and `music.rings`, which no row owns | W8 | Q0 parses both keys in W0, inert; Rh1 consumes |
| A17 | `src/plugins/audio/editor/index.ts` and panel registration: Ed2, Ed4, Ed6 | W3–W6 | Ed2 registers `editor/music/index.ts` with stub panels (H6); Ed4 and Ed6 fill their files |
| A18 | `SegmentView.tsx`: Ed3's drag | W4 | Ed2's view calls `segmentDrag.ts` (H6); Ed3 fills it and `segmentSnap.ts` |
| A19 | `rulesModel.ts`: Ed7's lint after Ed6 | W7 | Ed7's lint in new `ruleLint.ts` |
| A20 | test files: R1's `transitionRules.test.ts` and T3's precedence tests | W5, W8 | **separate test file**: T3 writes `transitionPrecedence.test.ts` |
| A21 | goldens: Z3 re-records existing stamped digests, C3 and T2 add | W3, W6, W8 | **separate layer**: Z3 alone edits existing digests; C3 and T2 add new files |
| A22 | **default flip before its safety net**: Z2a rewrites the split loop, Z2b/Z2c change every stamped record, Z3's goldens come after | W2–W3 | the **flip branch** `m4/in-voice`: Z2a, Z2b, Z2c and Z3 merge together; nothing of them reaches the integration branch first |
| A23 | the smoke spec grown by several tasks, and its switch to `splitQuanta` 0 at the flip | W1–W9 | single writer per wave: S0 (W1), Z3 (W3, on the flip branch), E1 (W6), E2 (W8), E3 then Ed11 (W9) |
| A27 | `audio-core/src/core.rs` (listed as changed in §5, no owner): `Regions` needs the three slices, `StreamStore::over` needs `M`; Z2a and C1 would both edit it in W2 | W2 | Q1 owns `core.rs` in W1 (slices and the `over` signature); C1 fills pools in `stream.rs` |
| A28 | TS init plumbing with no owner: `context.ts` preset and equality (`:31–43`, `:310–320`), the `CorePreset` literals (`testing.ts:367`, `debug.ts:333`, `coreRender.ts:34`, tests), `coreDriver.ts` headroom and layout mirror (`:70`, `:167–187`); `testing.ts` shared with Q2 in W1 | W1 | the wire lead owns all of it in W1 (merge 2); Q2 merges after it and rebases; C1 checks the headroom and asks the coordinator |
| A29 | `decoder/decoderClient.ts` and `handler.ts` (no owner; Ed1, D1a, D1b, P1 need methods and cases); D1c wiring into the open path D1b fills; D1c's acceptance decided by P1's `musicOps.ts` | W1–W3 | Ed1 adds the peaks method and case (W1); D1a's H3 declares every group method and case and the `musicCache.lookup`/`hold`/`release` calls; Q0 fixes the miss rule (`needBytes`), so D1c and P1 test their sides independently |
| A30 | `coreBackend.ts` frozen after Q2, but P9 needs `reopenStreams` (`:1406`) to skip music members, P1 needs stream event 4 (`:446` → `core/streams.ts:476`), P10 needs `DebugSource` members (`debug.ts:26`, `coreBackend.ts:977`) | W5 | Q2 leaves the three hooks (`musicOps.reopenGroups`, `musicOps.onStreamEvent`, the music `DebugSource` members) and owns `core/streams.ts`'s route |
| A31 | `src/engine/tests/systemCatalog.test.ts:123` asserts the update order `engine.AudioMusic` changes | W1 | in Q2's file list |
| A32 | C3's held- and late-group null tests test C2c and C2d, which run beside it in W6 | W6 | an in-wave chain: those cases start after the C2c + C2d merge; the harness and other cases start at once |
| A33 | Q1's `Groups` region needs `MAX_GROUPS`, a gate-family constant | W1 | the wire lead emits every §4.5 constant in merge 1 |
| A24 | `samples/sound-lab`: SM1, SM2, Rh3, L2 | W5, W7, W9, W10 | one per wave |
| A25 | `babylonBackend.ts`: B1, B2, B3 | W5, W7, W9 | one per wave, additive |
| A26 | `docs/guide/interactive-music.md`: D2–D5; Z6's guide note | W4–W10 | one per wave; Z6 writes in the existing audio events guide |

**Overlaps checked and left as they were:** sequential edits in different waves that are additive (`status.rs` Q1 → C1 → C2b; `groups.rs` C2a → C2b; `transition.ts` R3a → R3b; `stems.ts` P5 → R6; `musicSystem.ts` P7 → K2 → K5; `musicFormat.ts` F1a → F1b → F2; `core/context.ts` W1's headroom → Rh1). Read-only uses across a wave (F3 and G1 read `musicFormat.ts` while F1b writes it: they import F1a's merged types, and F1b only adds node kinds). **Changed from the table:** Ed11 moves to W9, after Ed10, because its row tests the settings that Ed10 builds and its dependency list omits Ed10 (logged as a plan ordering, not a change of acceptance).

## How a task runs

1. **Skeleton.** The lead commits every file the task creates: full types and signatures, a doc comment naming the spec rule (section or contract id) each function implements, stub bodies tagged with the leaf id, module declarations so everything compiles, test files with named skipped cases.
2. **Leaves, in parallel.** Each leaf works in its own worktree branched from the skeleton commit, fills the stubs in its files, un-skips its tests, runs only its own checks, and makes one commit.
3. **Lead core, at the same time.** The lead writes the parts that need judgement.
4. **Merge.** Leaves own disjoint files, so their branches merge cleanly; a conflict means a boundary is wrong, and the lead fixes the boundary. The lead writes the glue and runs the acceptance check.

Leaf rules (in every brief, and in the ground rules file):
- **Fill, don't reshape.** Signatures, types, module declarations and other files stay as the skeleton has them. If one looks wrong, stop and report.
- **One owner per file.** A fix goes back to the leaf that owns the file (continue it) or to the lead's glue.
- **Tests as leaves.** A test leaf and an implementation leaf can work from the same quoted spec at once, in separate files; on disagreement the lead checks the spec.
- **Measured numbers only** (M3's lesson, build log D11/D13): a leaf whose spec carries a performance or perceptual bound gets the measured number pasted in, or stays with its lead.
- Leads may skip a listed leaf under about half a day and do it themselves (M3: B1, D0, D2b, E6 did); they say so in the report.
- The coordinator merges a leaf directly when its lead's work is complete and the leaf is one disjoint test file.

**Dispatch is flat:** the coordinator starts the lead; the lead commits the skeleton and returns the leaf briefs; the coordinator starts the leaves in one message and continues the lead with their branch names.

**Leaf brief** (the shape; the project commands are in the ground rules file):

```
Leaf <ID>: <one line>
Read first: CLAUDE.md; docs/plans/2026-11-audio-music-m4-ground-rules.md; <skeleton file(s)>; <spec file and section>.
Base: <lead's skeleton commit>. You own: <files>. Fill only the stubs tagged <ID> and the skipped tests in <test file>.
Leave every other file, signature, type and module declaration as it is; if one looks wrong, stop and report.
Check: <exact command: cargo test -p <crate> <filter> | npx vitest run <file>>, plus npm run typecheck for TS.
The coordinator runs the full suite, e2e and the build.
Done: every <ID> stub filled, its tests un-skipped and passing, one commit on your branch.
Report (≤150 words): what you did, files touched, anything in the spec you had to interpret, what you couldn't verify.
Spec:
<the pasted excerpt, with measured numbers where a bound applies>
```

## The tree

Days are the table's; leaf days are plan est. "Unsplit" gives the reason in one line.

### Contract tasks

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| Q0 (1, plan) | coordinator | all: types and the settings parse | none: types are the coordinator's contract | 0 |
| Q1 (1.5, plan) | strongest | all | none: a skeleton is the lead's job | 0 |
| Q2 (2.5, plan) | strongest | all | none: a skeleton across many files | 0 |
| S0 (1, plan) | mid | all | none: one spec, real-app flake judgement | 0 |

### M4-0

| Task (d) | Lead | Keeps | Leaves (files, spec source) | Leaf d |
|---|---|---|---|---|
| Z1 (3) + W1 (3.5) | mid | the schema in `music.rs` and the family files, `gen_wire`, ABI 3.0, `params.rs` validation, `coreDriver.ts`, `initParams.ts` | **L-Z1a** `audio-wire/tests/m4_per_voice.rs` + `vectors/wire.json` per-voice records: round trip and fuzz from §4.1–4.2, §4.4 (header 176 B, worst case 16,192 B). **L-W1a** `audio-wire/tests/m4_gate.rs`: gate field, `musicRings` and `groupStarts`, fuzz rows of §4.5 (gate size 64, id 1023, 8 `groupStarts`). **L-W1b** `runtime/wire.m4.test.ts`: TS round trip of the same vectors | 1 + 1 + 0.5 |
| Z2a (3) | strongest | `due.rs` routing, `scheduler.rs`, `voices.rs` flags, the sub-range loop and H1 (on the flip branch) | **L-Z2aa** `audio-core/tests/due_list.rs`: §9's cargo list (class routing, overflow, parked records, a record at the start frame) | 0.75 |
| Z2b (4) | strongest | `curves.rs` pool and control-rate retarget, the gain-loop compare, start phase | **L-Z2ba** `audio-dsp/src/equal_power.rs` + `native/audio/tools/gen-equal-power/`: the checked-in 1,024-point table and its verification test (§5: no `sin` in a const context). **L-Z2bb** `audio-dsp/src/curve_laws.rs`: each law's value at a phase, endpoints, power sum within 1e-6 ([ARCH §5.3] constants) | 0.5 + 1 |
| Z2c (3) | strongest | `voice_split.rs` (the split timing inside a quantum) | **L-Z2ca** `audio-core/tests/class_s.rs`: one case per class S record of the row (pitch, low-pass, direction, SET_VOICE_FX, SET_PAUSED, SEEK, SET_LOOP), `voiceSplits` counts | 0.75 |
| Z3 (5) | strongest | the offline reference (piecewise-linear control-rate law, tolerance [ARCH §4.4]), the re-records and their log | **L-Z3a** `runtime/golden/audioGoldenM4.test.ts`: native-equals-wasm cases from the row's list | 1 |
| Z4 (3.5) | mid | `voiceTable.ts` log of un-fired stamped ops, `replay.ts` with start phase | **L-Z4a** `core/statusReader.ts`: the 176-B header and both sections (a byte-layout reader; M3 3/3). **L-Z4b** `core/commandWriter.ts`: shape word, `fadeZero`, gate writers | 1 + 0.75 |
| Z5 (2) | mid | unsplit: bench scenes against twins need measured judgement | none | 0 |
| Z6 (1.5) | mid | unsplit: prose readers see | none | 0 |

### M4a

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| F1a (4.5) | mid | the node model, ids, the writer | **L-F1aa** `musicFormat.limits.test.ts`: every §2.3 limit and message. **L-F1ab** `musicPosition.ts`: the §2.2 position grammar, parse and format | 1 + 1 |
| F1b (3) | mid | `eventFormat.ts` integration, placement rules | **L-F1ba** `musicFormat.writer.test.ts`: writer round trip, `eventClips` lists | 0.5 |
| F3 (3.5) | mid | the stream-or-decode rule, the ring need | **L-F3a** fixture clips + `musicValidate.test.ts`: each lint row of §2.6 | 1 |
| G1 (5, J row) | mid | tempo-map compile, seconds and frames at 44.1/48/96 kHz | **L-G1a** `musicGrid.property.test.ts`: the naive integrator and the property tests. **L-G1b** next beat, bar or grid and cue lookup in `musicGrid.ts`'s tagged stubs (pure, against the compiled map type) | 1 + 1 |
| C1 (4.5) | strongest | pools, epochs, refusal event 4 | **L-C1a** `audio-core/tests/music_rings_init.rs`: `InitError::MusicRings` 0..16 and the `Streams` size table | 0.5 |
| C2a (4) | strongest | the gate state machine, give-up | **L-C2aa** `audio-core/tests/group_gate.rs`: one case per row of S2 (tests from a table; M3 2/2) | 1 |
| C2b (4) | strongest | unsplit: the gate inside `render_range` is timing | none | 0 |
| C2c (3) + C2d (1.5) | strongest | unsplit: hold and rebase are timing; one lead, two files | none | 0 |
| C3 (5.5) | strongest | the late- and held-group null tests (after C2c + C2d merge) | **L-C3a** `audio-core/tests/alignment_harness.rs`: port of the spike's 1,408-case harness; the lead times the spike first and pastes the runtime | 1 |
| D1a (4) | strongest | unsplit: worker scheduling (breadth-first pump) | none | 0 |
| D1b (2.5) | mid | cancel and retarget in `musicGroups.ts` | **L-D1ba** `core/fakeDecoder.ts`: group support from Q0's protocol types | 0.5 |
| D1c (3) | mid | wiring into `streams.ts` callers and `encodedCache.ts` | **L-D1ca** `decoder/musicCache.ts`: refcount by path, per-preset budget (48 / 96 / 160 MiB, est.), eviction of non-candidates (pure) | 1 |
| P1 (5) | strongest | `segmentRun.ts`, `musicOps.ts` (lifecycle, messages) | **L-P1a** `music/segmentRun.loopback.test.ts`: "a segment starts on its planned frame" on the fake backend | 0.75 |
| P2 (5) | strongest | unsplit: the planner is a scheduler | none | 0 |
| P3 (5) | strongest | unsplit: anchors and wrap prediction are timing | none | 0 |
| P4 (4) | mid | `playlist.ts` advance and priming | **L-P4a** `music/playlistOrder.ts`: sequence, random, shuffle, `avoidRepeat`, `plays`, `rounds` (pure, seeded) | 1 |
| P5 (1.5) | mid | unsplit: small | none | 0 |
| P6 (5.5) | mid | unsplit: `eventRuntime.ts` lifecycle, a hot file | none | 0 |
| P7 (4) | mid | the bodies, the early step | **L-P7a** `audioApiM4.test.ts`: every §1 row of M4a | 1 |
| P8 (2.5) | mid | unsplit: reload is lifecycle | none | 0 |
| P9 (5) | strongest | unsplit: recovery | none | 0 |
| P10 (3.5) | mid | `debug.ts` shape, panel | **L-P10a** `editor/audioDebugRows.ts` music rows from §1.6 | 0.75 |
| T1 (5) | mid | the deterministic-clock fixture | **L-T1a** `music/planner.loopback.test.ts` (late worker, re-plan, refusal). **L-T1b** `music/recovery.loopback.test.ts` (rebuild, hidden tab, hot reload) | 1 + 1 |
| B1 (2.5) | mid | unsplit: the fallback's mapping is judgement | none | 0 |
| SM1 (3.5) | mid | the sample segments | **L-SM1a** `tools/music-tempo.mjs` | 0.5 |
| E1 (3) | mid | unsplit: Playwright flake judgement | none | 0 |
| D2 (2) | mid | unsplit: prose | none | 0 |

### M4b

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| F2 (4) | mid | dangling ids, the specificity index | **L-F2a** `musicRules.test.ts`: every §2.4 and §2.5 rule and limit | 1 |
| R1 (5) | strongest | tier lookup, exit and enter under tempo maps | **L-R1a** `transitionRules.test.ts`: §2.4's precedence tables, nested containers | 1 |
| R2 (2) | mid | unsplit: small | none | 0 |
| R3a (5), R3b (3) | strongest | unsplit: transition execution and chained plans | none | 0 |
| R4a (3), R4b (2.5) | strongest | unsplit: timing | none | 0 |
| R4c (3) | mid | unsplit: clip registry lifecycle | none | 0 |
| R5 (3.5) | mid | the trigger namespace, own bus | **L-R5a** `music/stingerPolicy.ts`: `ifTooLate`, `dontRepeat`, at most 4 at once (pure decision table) | 0.75 |
| R6 (2.5), R7 (1.5) | mid | unsplit: small | none | 0 |
| T2 (5) | strongest | the reference for each seam | **L-T2a** `music/seam.test.ts` cases from the row's list | 1 |
| T3 (5) | mid | the transition loopbacks | **L-T3a** `transitionPrecedence.test.ts` (rules, nested containers). **L-T3b** `transition.loopback.test.ts` cases (late prime, pool full, switch race) from the row | 1 + 1 |
| Bench1 (3) | mid | unsplit: measured | none | 0 |
| B2 (2.5) | mid | unsplit | none | 0 |
| SM2 (4) | mid | the scene | **L-SM2a** `tools/makeMusic.mjs`: stems at a tempo and bar count, broadband and click material | 1 |
| E2 (3), D3 (2) | mid | unsplit: flake judgement; prose | none | 0 |

### M4c

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| K1 (5) | strongest | unsplit: the beat clock is timing | none | 0 |
| K2 (3.5), K3 (1.5), K5 (0.5) | mid | unsplit: frame order; small | none | 0 |
| K4 (4) | mid | the fake `ClockMap` | **L-K4a** trace fixtures and the 0-missed/doubled/phantom cases. **L-K4b** tempo change, seek and hidden-tab gap cases (thresholds numeric, S4) | 1 + 1 |
| Rh1 (4.5) | strongest | unsplit: the rebuild path | none | 0 |
| Rh2 (4, J row) | mid | `Storage` persistence per output device, re-ask on change | **L-Rh2a** `Calibration.fromTaps` against the spike's simulated taps (p95 < 10 ms) in `calibration.ts`'s tagged stub | 1 |
| Rh3 (4), B3 (2), E3 (3.5), D4 (2) | mid | unsplit: sample judgement; small; flake judgement; prose | none | 0 |

### M4d

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| Ed1 (4.5) | mid | the worker request, the cache per asset and mtime | **L-Ed1a** `editor/music/peaksMip.ts`: mip reduction (pure) | 0.75 |
| Ed2 (5) | mid | the view, H6 | **L-Ed2a** `segmentViewModel.ts`: ruler and grid lines from the compiled tempo map | 1 |
| Ed3 (5) | mid | drag and undo | **L-Ed3a** `segmentSnap.ts` | 0.5 |
| Ed4 (4) | mid | the forms | **L-Ed4a** `tempoTools.ts`: tap tempo, tempo from length and bars | 0.5 |
| Ed5 (4.5) | mid | unsplit: the audition machinery | none | 0 |
| Ed6 (5) | mid | the table UI | **L-Ed6a** `rulesModel.ts`: the effective rule per pair equals `transitionRules` | 1 |
| Ed7 (4.5) | mid | the editor, audition | **L-Ed7a** `ruleLint.ts`: shadowed, unreachable, duplicate (§2.4) | 1 |
| Ed8 (5) | mid | unsplit: editor UI conventions across three files | none | 0 |
| Ed9 (4.5, J row) | mid | drop handling, lint on import | **L-Ed9a** RIFF `acid`, `cue`, `smpl` reader. **L-Ed9b** Ogg comment hints reader (both in `importHints.ts`'s tagged stubs; byte-layout readers, M3 3/3; one file, so one leaf owns it and does both) | 1.5 (one leaf) |
| Ed10 (2.5), Ed11 (5) | mid | unsplit: small; flake judgement | none | 0 |
| L1 (2.5, J row), L2 (3), D5 (3) | mid | unsplit: prose for the owner; samples; prose | none | 0 |
| L3 (5) | strongest | unsplit: the owner's items | none | 0 |

## What it changes

All plan est., summed by script:

| | Before the tree | After the tree |
|---|---|---|
| Strongest | 99.5 d (S rows) + 4 d (Q1, Q2) = 103.5 d | 94.25 d |
| Mid | 191 d (M + J rows) + 1 d (S0) = 192 d | 161.5 d |
| Cheapest | 0 | ≈ 39.75 d over **45 leaves** (Ed9's two merged into one) |
| Coordinator | Q0 1 d + reviews and merges | the same |

- **Critical path:** leaves on the pure chain (L-F1aa, L-F1ab, L-G1a, L-G1b, L-Rh2a) run beside their leads, so F1a, G1 and Rh2 can finish earlier than their table days; the chain is not re-computed until the pilot measures lead time on skeletons (M3: 10–45%).
- **Unsplit tasks:** each has its one-line reason above. The main groups: timing, lifecycle and recovery (Z2c's split, C2b–C2d, D1a, P2, P3, P9, R3a–R4b, K1, Rh1), measured work (Z5, Bench1), Playwright flake judgement (S0, E1–E3, Ed11), prose (Z6, D2–D5, L1), small (P5, R2, R6, R7, K3, K5, Ed10).
- **Leaf kinds and their M3 record:** tests from a table (L-Z1a, L-W1a, L-W1b, L-Z2aa, L-Z2ca, L-C1a, L-C2aa, L-F1aa, L-F1ba, L-F3a, L-F2a, L-R1a, L-T3a, L-P7a, L-K4a/b; M3 2/2); byte-layout readers and writers (L-Z4a, L-Z4b, L-Ed9a; M3 3/3); small maths and parsing (L-Z2ba, L-Z2bb, L-F1ab, L-G1b, L-D1ca, L-P4a, L-R5a, L-Rh2a, L-Ed1a, L-Ed2a, L-Ed3a, L-Ed4a, L-Ed6a, L-Ed7a; M3 2/2); ports of existing code (L-C3a; M3 1/2: the riskiest, so its runtime is measured first); fixtures and tools (L-SM1a, L-SM2a).

### The pilot (wave 1)

W1 is small on purpose: two strongest skeletons, one mid wire lead with three leaves, two mid heads with three leaves, the smoke spec. It measures:

| Measure | M3's figure | If M4 falls short |
|---|---|---|
| Leaf first-pass success | 10 of 12 (both failures from the spec) | a leaf kind that needs more than one re-run goes back to its leads for the rest of M4 |
| Lead time on skeleton and briefs | 10–45% | over a third on a task under 4 days: stop splitting tasks under 4 days |
| Agent minutes per table day | ≈ 6.4 | used to re-estimate the calendar; no plan change by itself |
| Tokens by model | strongest ≈ 2.4 M, mid ≈ 0.67 M, cheapest ≈ 1.6 M over 12 leaves (W1) | if strongest tokens per table day run more than 2× M3's, move Q-style skeleton work to mid leads where the files are TS-only |
| Mixer size per Rust task | +0.2 to +11.2 KB | logged; a move past the 300 KB warning is raised (tripwire) |
| **New for M4:** the skeletons' fit | n/a | count how many later tasks had to edit a Q1/Q2 file the plan says they don't; more than two in W2–W3 means a seam was wrong: fix the boundary before W4 |
| **New for M4:** the smoke spec | n/a | did S0 catch anything the unit tests missed by W3? If it never fails by M4a, keep it but stop growing it beyond one case per milestone |

## Independent review (2026-11-11)

A fresh agent that hadn't written the plan reviewed the four plan files against `api-and-models.md` §5–§10, ADR 0167 and the code. It confirmed all 81 rows with the table's ids and days, every dependency in an earlier wave or a declared in-wave chain, and the "State at planning" facts. Its ten findings, all fixed:

| # | Finding | Fix |
|---|---|---|
| 1 | Z2a reached the integration branch in W2, before the flip's safety net, though it rewrites the split loop | Z2a moves onto the flip branch; the flip is Z2a + Z2b + Z2c + Z3 (A22) |
| 2 | C3 tests C2c's hold and C2d's rebase but ran beside them | an in-wave chain (A32) |
| 3 | decoder seam: `decoderClient.ts` and `handler.ts` unowned; D1c's wiring and acceptance reached into D1b's and P1's files | H3 widened, Q0's miss rule, Ed1's peaks method (A29) |
| 4 | `coreBackend.ts` frozen after Q2 while P9, P1 and P10 need hooks there | Q2 leaves three named hooks and owns `core/streams.ts`'s route (A30) |
| 5 | `audio-core/src/core.rs` unowned; Z2a and C1 would both edit it | Q1 owns it (A27) |
| 6 | TS init plumbing unowned (`context.ts`, `CorePreset` literals, `coreDriver.ts` headroom), and `testing.ts` shared in W1 | the wire lead owns it; Q2 merges after and rebases (A28) |
| 7 | nobody owned the smoke spec's switch to `splitQuanta` 0 | Z3, on the flip branch (A23) |
| 8 | Q2's change to the update order breaks `systemCatalog.test.ts`, outside its list | added to Q2's files (A31) |
| 9 | H1 too thin: a voice-local split restructures the per-voice loop, so Z2b and Z2c would share `voices.rs` | H1 includes the sub-range loop with its own test (A1) |
| 10 | the plan moved Ed11's settings case to Ed10 (changing table acceptance); Q1 needed `MAX_GROUPS` from merge 2 | Ed11 moves to W9 after Ed10, keeping its acceptance; every constant lands in merge 1 (A33) |
