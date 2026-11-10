# Audio events M2: the task tree (ADR 0158)

Companion to [2026-11-audio-events-m2-waves.md](2026-11-audio-events-m2-waves.md), which owns the waves, file ownership and contracts. This file says who does each remaining task: which model leads, what the lead keeps, and which pieces go to the cheapest model as leaves. **Every day figure is an estimate**, to be checked against wave 1 (the pilot).

## Tiers

| Tier | Model | Owns |
|---|---|---|
| Coordinator | strongest (the main session) | waves, contracts C1–C3, single-writer files, merges, wasm rebuilds, wave reviews, global checks, the build log, owner reports |
| Lead | strongest for E3.1, E4.4, E6.3; mid for the rest | the task's skeleton, its hard core, the glue, merging its leaves, the acceptance check |
| Leaf | cheapest (Haiku) | one or two skeleton files filled to a quoted spec, with their own tests |

## Collision audit

Done before splitting, over the file lists in the waves plan. Hotspots are files two tasks in one wave would touch; rework is a later task rewriting an earlier one's output.

| Found | Where | Fix |
|---|---|---|
| Hotspot: `coreBackend.ts` wanted by E3.1 (automation) and E4.4/E4.5 (stream loops, plain-clip loop points) | W1–W3 | **Per-concern module** (C6): E3.1 puts the sink, the mirror, the replay records and the `onPlay` hook in `core/coreAutomation.ts`; `coreBackend.ts` only constructs it. E4.4 and E4.5 edit `coreAutomation.ts`, in different waves |
| Hotspot: `babylonBackend.ts` wanted by E3.2 (setLoop) and E4's Babylon loop points | W1/W3 | **Hook stub** (C1): E3.2 calls `loopPointsFor()` from `loopPoints.ts`, which returns `null` until E4.2 fills it; E4.5 (W3) makes the call live. No E4 task edits `babylonBackend.ts` before W3 |
| Hotspot: debug voice rows (`core/debug.ts`, Babylon's `debug()`) and the panel | W1 | **Interface stub** (C3): `voices[].event` declared in `backend.ts` in W0; E3.1 fills core rows, E3.2 Babylon rows, E3.6 groups in the panel |
| Hotspot: `decoder/protocol.ts` wanted by E4.1 (decode reply), E4.2 (main side) and E4.4 (stream open, release) | W1/W2 | **Generate the whole format first** (C2): the coordinator adds every M2 field and message in W0 |
| Hotspot: `decoder.rs` and `handler.ts` wanted by E4.1 and E4.4 | W1/W2 | wave move: E4.1 in W1, E4.4 in W2 (E4.4 needs E4.1's reader anyway) |
| Hotspot: `events/eventRuntime.ts` wanted by E3.3 (re-send), E3.5 (fixes from tests) and E3.6 (rough edges) | W1/W2 | E3.6 alone in W1; E3.3 and E3.5 share one lead in W2, who owns the file |
| Hotspot: `testing.ts` (fake backend) | W1/W2 | single writer per wave: E3.6 in W1, the E3.3+E3.5 lead in W2 |
| Hotspot: `clipRegistry.ts` wanted by E3.1 (duration getter) and E4.2 (loop points) | W1/W2 | wave move: E4.2 in W2; E3.1's edit is a getter only |
| Hotspot: `wasm/hash.json` and the wasm binaries, rebuilt by any task changing Rust (E4.1, E4.4, maybe E3.4) | W1/W2 | single writer: the coordinator rebuilds after merging |
| Hotspot: `plugins/audio/editor/index.ts` wanted by E6.2 (asset kind, create menu, context menu) and E6.3/E6.4 (panel) | W1–W3 | **Declare the whole surface early** (C4): E6.2 registers the kind, the panel (placeholder) and the open hook; E6.3/E6.4 fill their own files |
| Hotspot: the curve widget used by E6.3 and E6.5 while E6.1 moves it | W1/W2 | E6.1 in W1 commits the props (C5) first; E6.3 and E6.5 start in W2 |
| Hotspot: tests: E3.5 vs the existing `events.test.ts` and `audioGolden.test.ts` | W2 | **Separate test files**: `containers`, `instances`, `sourceAndDebug`, `handover`, `eventGolden` |
| Rework: E3.2's loop-points call, E4.5's flip | W1→W3 | **Planned stub replacement**, labelled in both briefs |
| Rework: E6.2's placeholder panel and stub `Audition.tsx` | W1→W2/W3 | planned; E6.2's brief says the bodies are placeholders |
| Rework: E3.4 finding a Rust bug | W2 | allowed: E3.4 owns `audio-core/src/automation.rs` in W2; nobody else edits audio-core in M2 |
| Checked and left: `Audio.ts`, `AudioSource.ts` (E3.6 only); `importSettings.ts` (E4.2 only); `AudioSettingsSection.tsx` and its model (E6.5 only); the particles plugin (E6.1 only); `samples/sound-lab/` (E5.1 only) | | no overlap |

## How a task runs

As the M1 tree's "How a task runs" ([2026-11-audio-core-m1-tree.md](2026-11-audio-core-m1-tree.md#how-a-task-runs)): the lead commits the skeleton (types, signatures, stub bodies tagged with the leaf id, named skipped tests), the leaves fill their files in parallel worktrees branched from the skeleton commit, the lead writes its core meanwhile, then merges the leaves and runs the acceptance check.

**Dispatch here is flat:** subagents can't start subagents, so the coordinator starts the lead, the lead returns its leaf briefs in its report, the coordinator starts the leaves in one message, then continues the lead with `SendMessage` and the leaves' branch names. A lead runs as its own session only if the owner wants to steer it (E6.3 is the candidate).

**Leaf rules, in every brief:** fill, don't reshape (signatures, types, `mod` and index lines stay; if one looks wrong, stop and report); one owner per file; a test leaf and an implementation leaf can work from the same quoted spec at once.

**The leaf brief:**

```
Leaf <ID>: <one line>
Read first: CLAUDE.md; <skeleton file(s)>; <upstream file to port, path and commit>.
You own: <files>. Fill only the stubs tagged <ID> and the skipped tests in <test file>.
Leave every other file, signature, type and module declaration as it is; if one looks wrong, stop and report.
Rules: no Babylon, three.js, Rapier or Howler types in public API; editor CSS uses theme tokens (var(--panel)…);
Rust: follow native/audio/README.md (build, goldens, the committed wasm is the coordinator's).
Check: <exact command, e.g. npx vitest run <file> | cargo test -p audio-decode --test loop_points>.
The coordinator runs the full suite, end-to-end tests and the build.
Done: every <ID> stub filled, its tests un-skipped and passing, one commit on your branch.
Report (≤150 words): what you did, files touched, anything in the spec you had to interpret, what you couldn't verify.
Spec:
<the pasted excerpt>
```

## The tree

### E3: event runtime

| Task (days est.) | Lead | Lead keeps | Leaves (id: files; spec source) | Leaf days (est.) |
|---|---|---|---|---|
| E3.1 (3) | strongest | all: the sink over the command writer, the mirror and its replay in REPLAY, `group` in PLAY, `horizon()` from the clock map, audibility of bound voices on a parameter change (evaluate with `curve.ts` at the target), core debug rows, the loopback tests (including a rebuild mid-automation) | none: replay, ordering against PLAY and the rebuild lifecycle are lead work; the audibility helper is under a quarter day | – |
| E3.2 (1) | mid | all | none: one file, the mocked AudioV2 voice lifecycle; too small to split | – |
| E3.6 (1.5) | mid | all | none: judgement calls across five files (the getter, per-World seeding, live pitch, the panel grouping) | – |
| E3.3 (0.5) + E3.5 (3) | mid (one lead) | skeleton test files with named skipped cases; `PendingVoice` hand-over (E3.3); the four wasm event goldens (capture on the loopback host, JSON files); runtime fixes the leaves' tests expose | **L3.5a**: `events/containers.test.ts`; spec: 0158 §1 "Containers" bullets, `eventFormat.ts` node types, the fake backend's API in `testing.ts`. **L3.5b**: `events/instances.test.ts` (limits oldest/quietest/none, cooldown, group exhaustion and reuse at 1024, release twice, release with no sustain); spec: 0158 §1 "Instances", §4 "Release", the capacities in `events/automation.ts`. **L3.5c**: `events/sourceAndDebug.test.ts` (`AudioSource` with an event, `setParameter`/`release` through it, `Audio.debug().events` and `voices[].event`, backend-switch re-send); spec: 0158 §5 | 0.6 each, 1.8 |
| E3.4 (1.5) | mid | all | none: one test file whose value is the choice of scenes and tolerance | – |

### E4: loop points from files

| Task (days est.) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| E4.1 (1.5) | mid | the skeleton of `loop_points.rs` (`fn read_loop_points(bytes) -> Option<(u32, u32)>` per container), the call from `decoder.rs`, the worker's reply in `handler.ts` (C2 fields), how a streamed file's trailing `smpl` is found (risk in the waves plan) | **L4.1a**: `audio-decode/src/loop_points.rs`, `audio-decode/tests/loop_points.rs`; spec: the WAV `smpl` chunk layout (manufacturer, product, sample period, MIDI unity note, pitch fraction, SMPTE format/offset, loop count, sampler data, then 24-byte loop records `cuePointId, type, start, end, fraction, playCount`; use the first forward loop, `end` inclusive), Vorbis/Opus comments `LOOPSTART` (frames) and `LOOPLENGTH` (frames), case-insensitive, fixtures built in the test | 0.75 |
| E4.2 (1.5) | mid | `loopPoints.ts` (precedence: sidecar over file), the decoder client and clip registry wiring, the `importSettings.ts` keys | **L4.2a**: `runtime/loopPointsReader.ts`, `loopPointsReader.test.ts`; spec: port `audio-decode/src/loop_points.rs` at W1's merge commit, same rules and fixtures | 0.75 |
| E4.4 (2) | strongest | all | none: the worker's region seek and prefetch, release timing against the ring, the stream rebuild path | – |
| E4.5 (0.5) | mid | all | none: a behaviour change with a sample-clip survey | – |

### E5: M2a exit

| Task (days est.) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| E5.1 (2) | mid | the scene, the behaviour scripts (surface switching, RPM, ignition and key-off, intensity), new tones in `makeTones.mjs`, the event spec list the leaf works from | **L5.1a**: `samples/sound-lab/audio/events/*.audioevent.json`; spec: 0158 §1's shape and the lead's list (footsteps: switch on `Surface` over randoms with `avoidRepeat`; engine: sustain container with a blend on `RPM` in the loop slot; music: bus automation on `Intensity` in `project.json` is the lead's) | 0.5 |
| E5.2 (1) | mid | all | none: prose readers will see | – |
| E5.3 (1) | mid | all | none: bench method and numbers | – |
| E5.4 (0.5) | mid | all | none: a browser spec with audio timing | – |

### E6: editor (M2b)

| Task (days est.) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| E6.1 (2) | mid | the move across plugins (imports in four particle files, deleting the old ones), C5 props, the widget's x range and segment-interpolation UI | **L6.1a**: `src/editor/ui/curveEdit.ts`, `curveEdit.test.ts`; spec: the existing `curveEdit.ts` and its tests (port), plus new helpers for an arbitrary `[xMin, xMax]` and setting a key's `interp`, with `Curve`/`CurveKey` from `src/engine/core/curve.ts` | 0.75 |
| E6.2 (1.5) | mid | registration in `editor/index.ts` (kind, format, create, the clip context menu, the panel placeholder and open hook: C4) | **L6.2a**: `createEventFromClips.ts` + test; spec: clip paths → a `random` root with one `clip` child each, the event defaults of 0158 §1. **L6.2b**: `eventAsset.ts` + test (the format's reference walk and rename rewrite over every `clip` path in the tree); spec: the `registerAssetFormat` interface in `src/editor/sdk/contributions.ts`, a sky or particles format as the model | 0.5 each, 1.0 |
| E6.3 (5) | strongest | the panel, drag-in from the asset browser, undo through the editor's command stack, selection, the parameters pane, wiring the curve widget for automation | **L6.3a**: `event/eventTree.ts` + test (add, remove, reorder, move, duplicate by node path); spec: the node types in `eventFormat.ts`. **L6.3b**: `event/nodeFields.ts` + test (per node type, the field descriptors: name, kind, range, default); spec: 0158 §1 container list and the shape block | 0.75 each, 1.5 |
| E6.4 (2) | mid | all | none: the running audio host, instance lifecycle in the editor | – |
| E6.5 (2) | mid | the section UI and CSS | **L6.5a**: `audioSettingsModel.ts` + test (add, remove, rename a global parameter, numeric/labelled, bus automation entries); spec: 0158 §2, §3 "Targets" and the `audio.parameters`/`audio.automation` parsing in `src/engine/audio/settings.ts` | 0.75 |
| E6.6 (1) | mid | all | none: Playwright specs | – |

### E7

E7.2 is the coordinator's; E7.1 is the owner's.

## What it changes

All figures are estimates.

| | Before the tree | After |
|---|---|---|
| Strongest model | 10 days (E3.1, E4.4, E6.3) | 8.5 |
| Mid model | ≈ 25 days (incl. the coordinator's E7.2) | ≈ 18.7 |
| Cheapest model | 0 | ≈ 7.8 (12 leaves) |
| Pure critical path | 10 days | ≈ 9 (E6.3's leaves overlap its lead's core) |

**Unsplit tasks and why:** E3.1, E4.4 (concurrency, replay, streaming); E3.2, E4.5, E5.4 (too small or a behaviour call); E3.4, E5.3 (the value is the method); E3.6 (judgement across files); E5.2 (prose); E6.4, E6.6 (host lifecycle, browser specs).

**The pilot (wave 1)** has four leaves: L4.1a, L6.1a, L6.2a and L6.2b. Measure and log in the build log: each leaf's first-pass success (merged without a re-run), the lead's time on skeleton and briefs against its own work, and tokens by model. If a kind of leaf needs more than one re-run, move that kind back to its lead for the later waves (the likely candidates are the test leaves L3.5a–c, which depend on the fake backend's behaviour more than on a pasted spec).
