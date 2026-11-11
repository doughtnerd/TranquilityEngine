# Spatial audio M3: the task tree (ADR 0162)

This file goes with [2026-11-audio-spatial-m3-waves.md](2026-11-audio-spatial-m3-waves.md), which owns the waves, file ownership, contracts and gates. It says who does each task: which model leads it, what the lead keeps, and which pieces go to the cheapest model as leaves. Task IDs, days and acceptance are the task table's ([api-and-models.md §10](../design/0162-audio-spatial/api-and-models.md#10-task-breakdown)). **Every leaf day and model share here is an estimate**, to be checked against wave 1 (the pilot).

## Tiers

| Tier | Model | Owns |
|---|---|---|
| Coordinator | strongest (the main session) | waves, K0, single-writer files, merges, wasm rebuilds, wave reviews, global checks, the build log, owner reports |
| Lead | strongest for the S-level tasks, A1 (it carries K1/K2, the skeleton every senior task builds on) and K4; mid for the rest | the task's skeleton, its hard core, the glue, merging its leaves, the acceptance check |
| Leaf | cheapest | one or two skeleton files filled to a quoted spec, with their own tests |

E10 (level J) runs as a single leaf with no lead and reports to the coordinator.

## Collision audit

Done before splitting, over every task's files, and extended after the independent review (rows 36–41) (the waves plan lists them per wave). A **hotspot** is a file that two tasks in one wave would touch. **Rework** is a later task rewriting an earlier one's output.

| # | Found | Where | Fix |
|---|---|---|---|
| 1 | Hotspot: `settings.ts` and `audioSettingsModel.ts` wanted by A6 and C6 | W1 | one lead for A6a + C6 |
| 2 | Rework: the §2.1 keys no task row owns (`occlusion.*`, `doppler.maxSpeed`, `speedOfSound`) would be added to `settings.ts` by D2a, D2b and D3 in three later waves | W2–W6 | **Complete config early**: the W1 settings lead parses every §2.1 key, inert until used; the material table parse goes in `occlusionMaterials.ts`, which D2b extends with compile and combine in W2 |
| 3 | Rework: A6's preset numbers (HRTF 32/16 → 8) landing in W1 would cut HRTF voices three waves before beds exist to take the rest, so high and default would play 24 and 8 voices equal-power | W1 → W4 | **split the flip out**: A6a parses (W1); A6b sets the numbers, `DEFAULT_VOICES.hrtf` and `stress`'s 32, merged last in W4 behind A3, A4's goldens and A7's bench |
| 4 | Hotspot: `audio-dsp/src/ambisonic.rs` wanted by A2 (encode, rotation) and A3 (the baked 16 → 2 matrix, which §5.1 puts in the same file) | W2 | **per-concern module**: `bed_matrix.rs`, A3's (written back to §5.1) |
| 5 | Hotspot: the three crates' `lib.rs` module lines wanted by A2, A3, C2a, C3, D1 | W2 | **interface stub**: K1 declares every new module with a doc-comment skeleton |
| 6 | Hotspot: `layout.rs`, `audio-wasm` init and `memory.rs` wanted by A4 (`Beds`), C3 (`Zones`), B4 (`Wide`), D1 (`Fx`) | W2–W3 | **complete config early**: K2 sizes every region from the ABI 2.0 `InitParams`; tasks fill the region's user, never the layout |
| 7 | Hotspot: `scheduler.rs` (record dispatch) wanted by A4 (BED_CONFIG), C3 (ZONE_CONFIG), D1 (SET_VOICE_FX), B3 (LISTENER) | W2–W4 | **hook stub**: K2 routes each kind to a stub handler in its module |
| 8 | Hotspot: `status.rs` and `counters.rs` wanted by A4, C3, C3b, B3, B4 | W2–W4 | **counters struct**: K2 serialises every STATUS field from day one; tasks set their counters in their own module |
| 9 | Hotspot: `bus.rs` wanted by C3 (return buses, shared-return scale, W2), A4 (bed decode before host effects) and C4 (aux add) in W3 | W2–W3 | **hook stub** in K2: the pre-effects input hook calls `bed::decode_into`, `zones::add_returns`, `sends::add_aux`; C3 is `bus.rs`'s only writer (W2) |
| 10 | Hotspot: the bus-chain gain wanted by A4 (gain fold for sharing buses) and C4 (send × chain gain), same wave | W3 | `chain.rs` written whole in K2 with its test; both call it |
| 11 | Hotspot: `voices.rs` wanted by D1 (W2), A4 and C4 (W3), B3 (W4) | W2–W4 | **hook stub** K3 (D1's skeleton): `sends::tap` after the filters, before the distance gain; C4 fills `sends.rs`; `voices.rs` then has one writer per wave: D1, A4, B3. D1 must merge before A4 starts (a file-order edge) |
| 12 | Hotspot: `zones.rs` wanted by C4 and C3b | W3 | wave move: C3b to W4 (nothing depends on it) |
| 13 | Hotspot: `bed.rs` wanted by A4 (W3) and B3 (W4) | | sequential and additive (private decoders); checked and left |
| 14 | Hotspot: `clips.rs` wanted by B2 (W1) and C3 (W2) | | sequential and additive (formats 3, 5); checked and left |
| 15 | Hotspot: `audio-decode/src/lib.rs`/`decoder.rs` wanted by B2 (W1), C2a (W2) and possibly B4 | W1–W3 | B2 owns them in W1, C2a in W2; B4 stays out of `audio-decode` (its chunking is in the worker's TS and `stream.rs`) |
| 16 | Hotspot: `decoder/protocol.ts` and `handler.ts` wanted by B4 and C2b, same wave | W3 | **generate the whole format first** (K0): every worker message, and `handler.ts` routes IR messages to the stub `irPrepare.ts`; B4 owns `handler.ts`, C2b fills `irPrepare.ts` |
| 17 | Hotspot: `commandWriter.ts` wanted by A5, B5, C5, D2a, D4 | W4–W5 | **generate the whole format first** (K1): every new record's writer method |
| 18 | Hotspot: `statusReader.ts` wanted by A5, C5, D5, E4 | W4–W8 | K1 parses every new STATUS field into a typed struct |
| 19 | Hotspot: `audioSystem.ts` wanted by A5 (`pannerPick`), B5 (listener), C5 (zones), D2a (occlusion), D3 (Doppler) | W4–W6 | **declare the whole surface early** (K4): the M3 frame order calling stubs in each feature's file |
| 20 | Hotspot: `core/voiceFx.ts` wanted by C5 and D4 (both list it, W4), D2a and B5 (W5) | W4–W5 | K4 writes it complete (merge rule, thresholds, promotion re-send); features call setters |
| 21 | Hotspot: `replay.ts`, `coreBackend.ts` wanted by A5, C5 (W4), B5 (W5) | W4–W5 | K4: construction and replay hooks in C10's order |
| 22 | Rework: `AudioSource`'s §1.2 fields are needed by C5 (W4), D2a, B5 (W5), D3 (W6), but D5 declares the §1 surface in W7 | W4–W7 | K4 declares them (with `@field` descriptions and `apply()`/`applyEvent()`); D5 keeps the handle bodies, debug additions, exports and the §1 tests |
| 23 | Hotspot: `testing.ts` (fake backend) wanted by every main-side task's tests | W3–W7 | K4 implements every K0 member; afterwards the coordinator |
| 24 | Hotspot: `voiceTable.ts`/`selection.ts`: occlusion gain into audibility (D2a) and the `hrtfPick` rename (A5) | W3–W5 | K4 adds `occGain` (default 1) and selection's product; A5 changes only imports; D2a writes `occGain` |
| 25 | Hotspot: `AudioSource.ts`, `Audio.ts`: B5 (W5), D5 (W7); `core/listener.ts`: B5 (W5), D3 (W6); `core/debug.ts`: A5 (W4), D5 (W7); `babylonBackend.ts`: F2 (W5), F1 (W7) | | sequential; checked and left |
| 26 | Hotspot: `golden/` and the `audio-bench` scene registry wanted by A7, B6, C7, D6 | W4–W6 | **separate files**: one golden file per scene; the registry has one writer per wave (A7, C7, D6) |
| 27 | Rework: E8's sample settings (`stress` HRTF, `pirates` occlusion, `dopplerLevel: 0` on the orbiting and bench sources, incl. `stress`'s generator) would land in W7, leaving samples changed or benches moved for three waves | W4–W7 | each line moves into its flip (A6b, D2a, D3), the owner's "update the samples" rule; E8 keeps the spatial scene, scripts, guides and the rest of the settings |
| 28 | Hotspot: `audioSettingsModel.ts` wanted by A6a (W1), A6b (W4), E3 (W5) | | sequential; E3 is placed after the flip deliberately |
| 29 | Hotspot: the audio editor's `index.ts` wanted by E1, E2, E4 | | different waves, additive lines; checked and left |
| 30 | Hotspot: `native/audio/build.mjs` wanted by A3 (bake check, 230 KB warning) and C2a (decoder size, already gated) | W2 | A3 is its only writer; C2a reads the existing gate |
| 31 | Inconsistency: FuMa in `audio-decode/src/ambisonic.rs` (§5.1) or `decoder/ambisonic.ts` (B1's row) | W1 | the table wins: TypeScript, in the worker per chunk (architecture §3); §5.1 written back |
| 32 | Hotspot: the wide ring's size, if B4's stall test fails, changes the wire constant (A1's) and K2's region | W3 | the coordinator regenerates; B4 reports the measured result |
| 33 | Rework: E7 ("live tuning check") had no files; E9 writes the live-tuning spec | W6, W9 | E7 fixes fields that don't apply in Play (W6); E9's spec checks them (W9); neither rewrites the other |
| 34 | Hotspot: `myco.ts`, `runtime/index.ts` wanted by D2b, C5 (components) and D5 (exports) | | coordinator single writer, from the tasks' reports |
| 35 | Checked and left: `worldServices.ts` and the physics plugin (D0 only); `importSettings.ts` (B1 only); `AssetInspector.tsx` (E6 only); `eventFormat.ts`, `eventRuntime.ts` (D4 only); the event editor (E5 only); `hrir.ts` (A3 only); `convolver/` (C1 in W1, C2a's `presets.rs` in W2) | | no overlap |
| 36 | Hotspot: `InitParams` struct literals (37, incl. `clips.rs:608`, `voices.rs`, `stream.rs`, `audio-bench`, tests) wanted by K2 and B2 in W1, and by every later region | W1 | K2's first commit adds a `Default` and changes every literal to `..InitParams::default()`; B2 and C1 branch after it. B2's N-channel resampler is a new function, so `lagrange`'s callers in `voices.rs` and `stream.rs` don't change (review) |
| 37 | Rework and missing owner: the region sizes on main (`core/context.ts` preset and rebuild check, `coreDriver.ts`'s constant 16 MiB headroom, too small for high once zones and wide exist) | W1–W5 | K2 adds the preset fields and a headroom function; each feature's region function (beds A5, zones C5, wide B5) is its memory flip (review) |
| 38 | Hotspot: `worklet/coreDriver.ts` wanted by B4 (16-channel chunks), C2b, A3 and C3 (frame sizes for formats 3–5) | W2–W3 | K2 handles both in W1; afterwards a coordinator-only file (review) |
| 39 | Hotspot: `decoder/streams.ts` (STREAM_OPEN, the 2-channel clamp) wanted by B1 (per-chunk FuMa) and B4 (wide streams) | W1, W3 | B4 owns the stream path; B1 writes the per-chunk function in `decoder/ambisonic.ts` that B4 calls (review) |
| 40 | Hotspot: Babylon needs main's occlusion and Doppler (F1), but K4 froze `audioSystem.ts` around core-only modules | W3, W7 | K0 adds `setOcclusion?`/`setDopplerRate?`; K4's order runs occlusion and Doppler for both backends (review) |
| 41 | Missing owners: `mirror.ts`, `spatial.ts` (A5 and C5 would share them in W4), `AudioListener.setVelocity`'s body, the ambisonic stream default in `clipRegistry.ts`, the `zoneIr` interface K4 constructs while C2b writes it | W3–W6 | K4 takes `mirror.ts` and `spatial.ts`; D3 the `setVelocity` body; B5 the stream default; K0 declares `ZoneIrService` (review) |

## How a task runs

As the M1 tree's "How a task runs" ([2026-11-audio-core-m1-tree.md](2026-11-audio-core-m1-tree.md#how-a-task-runs)):

1. The lead commits the skeleton: types, signatures, stub bodies tagged with the leaf id, and named skipped tests.
2. The leaves fill their files in parallel worktrees branched from the skeleton commit.
3. Meanwhile the lead writes its core.
4. The lead merges the leaves, writes the glue and runs the task's acceptance (the per-task cadence: typecheck, the touched files' tests, `cargo test -p <crate>`).

**Dispatch is flat.** Subagents can't start subagents here, so:
1. The coordinator starts the lead.
2. The lead returns its leaf briefs in its report.
3. The coordinator starts the leaves in one message.
4. The coordinator continues the lead with `SendMessage` and the leaves' branch names.

A lead runs as its own session only if the owner wants to steer it. C5 and A4 are the candidates, being the longest S-level tasks on the two chains.

**Leaf rules, in every brief:**
- Fill, don't reshape: signatures, types, `mod` and index lines stay. If one looks wrong, stop and report.
- One owner per file.
- A test leaf and an implementation leaf can work from the same quoted spec at once.

**The leaf brief:**

```
Leaf <ID>: <one line>
Read first: CLAUDE.md; <skeleton file(s)>; <upstream file to port, path and commit>.
Base: <the lead's skeleton commit>.
You own: <files>. Fill only the stubs tagged <ID> and the skipped tests in <test file>.
Leave every other file, signature, type and module declaration as it is; if one looks wrong, stop and report.
Rules: no Babylon, three.js, Rapier or Howler types in the public API; import Babylon module by module;
editor CSS uses theme tokens (var(--panel)…); Rust follows native/audio/README.md; the committed wasm is
the coordinator's (don't commit a rebuild).
Check: <exact command, e.g. npx vitest run <file> | cargo test -p audio-dsp --lib ambisonic>.
The coordinator runs the full suite, end-to-end tests and the build.
Done: every <ID> stub filled, its tests un-skipped and passing, one commit on your branch.
Report (≤150 words): what you did, files touched, anything in the spec you had to interpret, what you couldn't verify.
Spec:
<the pasted excerpt>
```

The spec excerpt is pasted from the design, not referenced. Use the section named in the leaf's row (§n is `api-and-models.md`; C/S are the contracts files; [ARCH §n] is `architecture.md`).

## The tree

### M3a: bed

| Task (days) | Lead | Lead keeps | Leaves (id: files; spec source) | Leaf days (est.) |
|---|---|---|---|---|
| A1 (5, + K1/K2 plan est. 2.5) | strongest | the schema (`spatial.rs` and the edits to `batch`/`status`/`envelope`/`schema.rs`), generation and hash, the module skeletons (K1); `InitParams` `Default` and its literals (first commit), ABI 2.0, regions, dispatch stubs, counters struct, bus hook, `chain.rs`, the `context.ts` preset fields, `coreDriver.ts` headroom function, frame sizes and wide chunks (K2) | **L-A1a**: `audio-wire/tests/spatial_vectors.rs` + golden vectors, round trip and fuzz of every new record; spec: C2–C7 byte tables, §4.2–§4.3. **L-A1b**: `core/statusReader.ts` M3 parse + `statusReaderM3.test.ts`; spec: C7, §4.3 (header 144 B, sections, worst case 15,904 B). **L-A1c**: the M3 methods in `core/commandWriter.ts` + `commandWriterM3.test.ts`; spec: C1–C5 tables and the existing methods as the model | 0.75 + 0.5 + 0.75 = 2.0 |
| A2 (5) | strongest | `bed_decoder.rs` (partitioned decode, 142 µs p50), bit-identity native vs wasm | **L-A2a**: `audio-dsp/src/ambisonic.rs` (SN3D/ACN encode orders 1–3, Ivanic–Ruedenberg rotation) + tests; spec: the real spherical harmonic formulas, the recurrence (paste the paper's tables), §9's two unit rows (64 directions per order, 1e-5). *The one numerics-heavy leaf: if it needs a second run, it moves back to the lead.* **L-A2b**: `audio-dsp/tests/bed_decoder.rs` (partitioned against direct convolution); spec: §9 row | 1.0 + 0.5 = 1.5 |
| A3 (4) | strongest | `bake-magls` (the MagLS design from the HRIR set, the asset and `--check`), `bed_matrix.rs`, `build.mjs` | **L-A3a**: format 4 loader in `core/hrir.ts` + test; spec: C6 format 4, S5, the existing HRIR loader. **L-A3b**: `audio-dsp/tests/bed_matrix.rs`; spec: §9 (within 2 dB of `EqualPowerPanner` except within 10° of ±90°) | 0.5 + 0.25 = 0.75 |
| A4 (7) | strongest | all | none: slot and host lifecycle, the crossfade law, decode order, gain fold, RESET and the ladder step are lifecycle and ordering | – |
| A5 (3.5) + A6b (flip) | mid | `pannerPick.ts` (dwell, hysteresis, R13), the `hrtfPick` removal, debug rows, the flip commit and the tests it changes | **L-A5a**: `core/beds.ts`'s resolution function + `beds.test.ts`; spec: §2.1 bed rows, §3.2, §9's "bed resolution table" (maxBeds, priority, ties, losers, root default 255, `none`) | 0.75 |
| A6a + C6 (2.5 + 2.5) | mid | `settings.ts` parsing for every §2.1 key, `audioSettingsModel.ts` (`zones.standby`, memory accounting) | **L-A6a**: `src/engine/tests/audioSettingsSpatial.test.ts`, one case per §2.1 row (range, default, refusal message); spec: §2.1 table, C10. **L-A6b**: `src/engine/audio/occlusionMaterials.ts` table and parse + test; spec: §2.2 | 0.75 + 0.5 = 1.25 |
| A7 (4.5) | mid | all | none: the value is the bench method and the numbers | – |

### M3b: ambisonic clips

| Task (days) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| B1 (3.5) | mid | registry validation in `clipRegistry.ts`; the per-chunk FuMa function that B4 calls from `decoder/streams.ts` | **L-B1a**: the `ambisonic` key in `importSettings.ts` (parse, serialise) + test; spec: §2.4. **L-B1b**: `decoder/ambisonic.ts`, FuMa → AmbiX for orders 1–3 (channel order and weights, int16 headroom scaling, f32 when a factor exceeds 4) + test (FuMa twin equals AmbiX within 1e-6); spec: §2.4, the FuMa table | 0.5 + 0.75 = 1.25 |
| B2 (4) | strongest | the arena to 16 channels (`clips.rs`, the shared 8 KB planar scratch), the decoder limit | **L-B2a**: a new N ≤ 16-channel function in `resample.rs` + tests (the stereo `lagrange` signature stays); spec: port the existing two-channel code, same filters, bit-identical for 1 and 2 channels | 1.0 |
| B3 (6) | strongest | all | none: per-quantum rotation slerp, private decoders, stealing in the core | – |
| B4 (5.5) | strongest | all, incl. `decoder/streams.ts` (1–16 channels, `convention`, the call into B1's FuMa function) | none: ring class, streaming, chunk timing, the stall test | – |
| B5 (3.5) | mid | all | none: wiring across `listener.ts`, `AudioSource.ts`, `Audio.ts`; the stealing rule is under a quarter day | – |
| B6 (3) | mid | the loopback tests (image azimuth, bed and private decoder) | **L-B6a**: `samples/sound-lab/tools/makeAmbisonic.mjs` (a tone at a given azimuth and elevation encoded into 4/9/16-channel AmbiX WAVs, and a FuMa twin); spec: the SN3D formulas from L-A2a's merged `ambisonic.rs`, the WAV writer in `makeTones.mjs` | 0.75 |

### M3c: zones

| Task (days) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| C1 (6) | strongest | the split (`kernel.rs`, `instance.rs`), bit-identity of the shared reverb | **L-C1a**: `convolver/stagger.rs` (`plan_stagger`) + test (never above the sequential peak); spec: port the spike's load balancer in `spikes/audio-spatial/convolution/` | 0.75 |
| C2a (4) | strongest | decode, resample, trim, normalise, partition, the exports, the timings | **L-C2aa**: `convolver/presets.rs` (generated IRs `room`, `corridor`, `hall`, `cave`, `open`) + test; spec: §2.3, R10 | 0.75 |
| C2b (3.5) | mid | all | none: the worker-to-worklet port, cache lifecycle, rate change, failure paths | – |
| C3 (9) | strongest | the region, table, state machine, return buses, shared-return scale, slot paths, ladder | **L-C3a**: `audio-core/tests/zones_state.rs`, the slot machine cases (waiting for kernel, fade in, active, release, ring out, off, refused, evict on low; standby on high and default); spec: C5, C7 states, §9 row | 0.75 |
| C3b (3) | strongest | all | none: spreading work over quanta | – |
| C4 (3) | strongest | all | none: small, and its value is the tap's timing against the filters | – |
| C5 (8.5) | strongest | the planner, kernel LRU, proximity preload, 5 s timeout, both slot paths, the listener weight | **L-C5a**: `core/zoneWeights.ts` (zone weight from `blendDistance`, `send = volume × reverbSend × curve × weight × wetFactor`, the product with the curve clamped to 4) + test; spec: §1.5, §3.2, S21. **L-C5b**: `runtime/AudioReverbZone.ts` fields with `@field` descriptions and presets + test; spec: §1.5 table, R10, R17 (`output`) | 0.75 + 0.5 = 1.25 |
| C7 (4.75) | mid | all | none: bench method and numbers | – |

### M3d: occlusion, Doppler, event effects

| Task (days) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| D0 (3.5) | mid | all | none: an engine-core interface with Rapier filters across the plugin boundary | – |
| D1 (4) + K3 | strongest | `fxpool.rs`, the migration (bit-identical), the `voices.rs` order and K3 | **L-D1a**: `audio-dsp/src/fxfilter.rs` (a log-Hz ramped mono pair over `Biquad`) + tests (ramp monotone, `LP_TOP` 20,000, `HP_BOTTOM` 20); spec: C17, S20 | 0.75 |
| D2a (5.5) | strongest | the ray scheduler (count from `budgetMs` and the EMA, overrun halving, ranking, round robin), `pirates`' occlusion settings | **L-D2aa**: `core/occlusionMath.ts` (attack/release smoothing, wet folding, lateral ray directions) + test; spec: §2.1 occlusion rows, S1 | 0.75 |
| D2b (3) | mid | compile, combine and cache in `occlusionMaterials.ts`, debug rows, the 2D note | **L-D2ba**: `runtime/AudioOccluder.ts` fields (`material`, `transmissionTrimDb`, `cutoffScale`, `openness`) with descriptions + test; spec: §1.5, R15 | 0.5 |
| D3 (3) | mid | the velocity wiring in `listener.ts` and `AudioListener.setVelocity`, the hidden-tab reset, `dopplerLevel: 0` in `sound-lab`'s main scene and `stress`'s generator | **L-D3a**: `core/doppler.ts` maths (the formula, the velocity estimator, the teleport guard, the `maxSpeed` clamp) + test; spec: §1.x Doppler rows, C10 | 0.75 |
| D4 (3) | mid | the runtime path in `eventRuntime.ts` | **L-D4a**: the `filter`/`sends`/`spatial` additions to `eventFormat.ts` + test; spec: §2.5 rules | 0.75 |
| D5 (3.5) | mid | handle bodies, debug additions, the export list | **L-D5a**: `audioApiM3.test.ts`, one case per §1 row and the `@field` description check; spec: §1 tables | 1.0 |
| D6 (3.75) | mid | all | none: bench method and numbers | – |

### Babylon fallback

| Task (days) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| F1 (3) | mid | the backend changes, incl. K0's `setOcclusion?` (gain only) and `setDopplerRate?` on Babylon voices | **L-F1a**: `babylonBackendM3.test.ts`, one case per §8 row against the existing mocks; spec: §8 table | 0.75 |
| F2 (0.5) | mid | all | none: too small | – |

### M3e: editor, samples, listening pass

| Task (days) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| E1 (4) | mid | the viewport tool, handles, the Edit Zone action, undo | **L-E1a**: `editor/zoneMath.ts` (volume and blend shell geometry, handle positions, face drag to size) + test; spec: §1.5 zone shape fields, §7 row | 0.75 |
| E2 (3.5) | mid | all | none: Inspector UI and its warnings | – |
| E3 (5.5) | mid | the section UI and CSS | **L-E3a**: the setters in `audioSettingsModel.ts` (`setBed`, `setBusBed`, `setMaxClips`, `setOcclusion`, `setMaterial`, `setZones`, `setDoppler`, preset keys) + tests; spec: §7 row, §2.1 | 1.0 |
| E4 (4) | mid | the panel sections, the overlay | **L-E4a**: `editor/audioDebugRows.ts` (rows for beds, zones, occlusion and the new voice columns from `AudioDebugInfo`) + test; spec: §1.6, [ARCH §9] health column | 0.75 |
| E5 (3) | mid | `NodeProperties.tsx`, the audition label | **L-E5a**: the `filter`/`sends`/`spatial` fields in `event/nodeFields.ts` + test; spec: §2.5 | 0.5 |
| E6 (2) | mid | all | none: one small UI block | – |
| E7 (1) | mid | all | none: checks and small fixes | – |
| E8 (6.5) | mid | the scene, settings and the guides (prose readers will see) | **L-E8a**: `samples/sound-lab/scripts/behaviors/` door (moves `openness`) and pass-by mover scripts; spec: the lead's list, `AudioOccluder.openness` (§1.5) | 0.5 |
| E9 (4) | mid | all | none: browser specs | – |
| E10 (2) | — (single leaf, cheapest) | — | **E10**: `listening-pass.md` and `ListeningBench.ts`; spec: §9's exit checks per milestone, the M2 listening document's format and sign-off block | 2.0 |

### Contract task

| Task (plan est.) | Lead | Lead keeps | Leaves | Leaf days (est.) |
|---|---|---|---|---|
| K4 (2.5) | strongest | the frame order for both backends, construction, `mirror.ts`, `spatial.ts`, replay order, the §1 surface declarations | **L-K4a**: `core/voiceFx.ts` + test (staging, `lpHz` as the lowest contribution, thresholds 0.5 dB / 1 Hz / 0.001 rad, re-send on promotion); spec: S3, C3, C20. **L-K4b**: the K0 members in `testing.ts`; spec: K0's types (mocks from declarations) | 1.0 + 0.75 = 1.75 |

## What it changes

All figures are estimates.

| | Before the tree | After |
|---|---|---|
| Strongest model | 74.5 days (the S rows) | ≈ 72.5 (+ A1 5, K1/K2 2.5, K4 2.5; − 12 days of leaves) |
| Mid model | 95 days (M rows 93, E10 2) | ≈ 76.75 |
| Cheapest model | 0 | ≈ 25.25 (34 leaves, E10 included) |
| Total | 169.5 | ≈ 174.5 (+ 5 days of contracts, counted as added; part of it is work the rows would otherwise do, which the pilot measures) |
| Pure critical path | 41 days | ≈ 41–42.5 with K1/K2, less ≈ 1–2 where leaves overlap their lead on A1, A2, D5 and E4 |

**Leaves per wave:** W1 9, W2 8, W3 2, W4 4, W5 5, W6 1, W7 3, W8 2 (E10).

**Unsplit tasks and why:**
- lifecycle, ordering or streaming: A4, B3, B4, C3b, C4, C2b;
- an interface across a plugin boundary: D0;
- the value is the method or the numbers: A7, C7, D6;
- too small, or judgement across files: B5, F2, E6, E7;
- UI and prose: E2;
- browser specs: E9.

**The pilot (wave 1)** has 9 leaves of four kinds:
- tests from a table: L-A1a, L-A6a;
- byte-layout readers and writers: L-A1b, L-A1c;
- ports of existing code: L-B2a, L-C1a;
- small specified maths or parsing: L-A6b, L-B1a, L-B1b.

Measure and log in the build log:
- each leaf's first-pass success (merged without a re-run);
- the lead's time on skeleton and briefs against its own work;
- tokens by model;
- **agent wall time per table day**, which turns the table's human days into a calendar for the later waves;
- the mixer and decoder size change per Rust task.

What changes if the pilot falls short:
- If a kind of leaf needs more than one re-run, move that kind back to its leads from W2 on. The likely candidates are the byte-layout leaves, which depend on the lead's skeleton more than on the pasted table.
- If leads spend more than a third of their time on skeletons and briefs, stop splitting tasks under 4 days.
- L-A2a (W2, numerics) is the riskiest leaf after the pilot. Its lead reviews it before anything builds on it.
