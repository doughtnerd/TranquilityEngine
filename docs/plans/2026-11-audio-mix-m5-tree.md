# Audio mix M5: the task tree

Who leads each task of [the waves plan](2026-11-audio-mix-m5-waves.md), what the lead keeps, and which leaves the cheapest model fills. The task table ([api-and-models.md §11](../design/0171-audio-mix/api-and-models.md#11-task-breakdown)) owns IDs, days, dependencies and acceptance; the waves plan owns order, files and gates. **Every leaf day and every model share below is a plan estimate** until the pilot wave reports.

## Tiers

| Tier | Model | Owns |
|---|---|---|
| Coordinator | strongest (main session) | W0, R0, waves, contracts' merges, single-writer files, wasm rebuilds, held flip branches, wave reviews, global checks, the build log |
| Lead | strongest for S rows, K0, K1, DS0 and Ls2; mid for M and J rows and the mid plan tasks | the task's skeleton, its hard core, the glue, merging its leaves, the acceptance check |
| Leaf | cheapest | one or two skeleton files filled to a quoted spec, with their own tests |

J rows go to a mid lead, not straight to the cheapest model, where they're prose readers see (Dc1–Dc5, Ls1: the lead keeps it). The one exception is **Bb2**, a single fully specified leaf with no lead (one file, §9's two rows).

## Collision audit

Every file two tasks in one wave would have touched (*hotspot*), and every later rewrite of an earlier task's output (*rework*), from the table's file columns, the design's §8 layout and the code:

| # | Found | Tasks, wave | Fix |
|---|---|---|---|
| A1 | `bus.rs` (689 lines): B1a, B2, B3, Rv1, Dp1, Ld2, Sc1 each edit it, B1a and B2 in the same wave | W2–W6 | **hook stub** K1: `bus.rs` calls `lanes::apply`, `lanes::settle`, `bus_order::compute`, `duck::gain`, `duck::detect`, `loudness::tap`, `sends::feed`, `bus_slots::apply` with identity bodies, every digest unchanged; each task fills its own module; `bus.rs` is the coordinator's after W1 |
| A2 | `layout.rs`, `core.rs`: no row owns them, though the core gains ≈ 24 KB of state ([ARCH §6]); and **dispatch is in `scheduler.rs`** (`:176–210`, `:300–330`), which B1a, B2, B3, Dp1, Ld2 and Sc1 would each need for their opcode's arm, B1a and B2 in W2, B3 and B1b in W3 (review R1) | W1–W6 | **complete config early**: K1 lays out every M5 region (stage B after Wa1's merge 1) and adds a length entry, a well-formed check and an apply arm in `scheduler.rs` for every new opcode, each calling its owner's stub, and moves `bus::mix` into `lanes.rs`; afterwards only B2 (W2) and B1b (W3) edit `scheduler.rs`, for the pending queue and class B |
| A3 | `counters.rs`, `status.rs`: Cp1, Dp1, Ld2 each add fields or a section | W2, W4, W6 | **counters struct**: K1 declares every M5 counter and writes the 256-B header and the three sections from it and from `duck::status`, `loudness::status`; tasks set values in their own modules |
| A4 | `fx.rs`: Rv1 (the send into a scratch) and B4 (blends) in W3 | W3 | K1 routes the reverb slot into the 1 KB scratch and `sends::feed` (unscaled, bit-identical); Rv1 fills `sends.rs` only; B4 owns `fx.rs` |
| A5 | `due.rs`, `scheduler.rs`: B1b and B2 both edit them; both could start after B1a/Wa1 | W2–W3 | **wave move**: B2 (W2) before B1b (W3). The late-batch rule ties the due list to the pending queue, so a seam would split one mechanism across two owners. +1 d on the pure chain (plan est.) |
| A6 | `lanes.rs`: B1a then B1b | W2, W3 | sequential and additive (B1b adds the stamped segments) |
| A7 | `duck.rs`: B3 (rule table), Dp1 (presence), Sc1 (level) | W3, W4, W6 | sequential, one per wave, additive; K1 declares the module |
| A8 | core `loudness.rs`: Ld2 then Ld7 | W6, W7 | sequential, additive |
| A9 | The wire: Wa1 retires `BUS_MIX`, but `coreBackend.ts`, `commandWriter.ts`, `replay.ts` and the core handler use it until B1a and Wa2 | W1–W2 | **planned stub replacement** H1 plus a coordinator step: Wa1 keeps `BUS_MIX`; B1a maps it onto the `runtime` lane; Wa2 writes `BUS_RAMP` through `laneWriter.ts`'s interim body; **R0** removes `BUS_MIX` at W2's end; Mx2 replaces the interim body in W3 |
| A10 | Tests that hard-code the STATUS layout (three named in Wa2's row; also `statusReaderM3.test.ts`, `statusReaderM4.test.ts`, `wire.roundtrip.test.ts:717–789`, `audio-bench/src/lib.rs:2178`, `schema/music.rs:23`) and `CORE_ABI_MAJOR = 3` (`coreDriver.ts:60`, checked at `context.ts:262`) break `npm test` and every core load at Wa1's merge (review R2) | W1 | all moved into Wa1's merge 1, which is one merge with K1's stage B (`status.rs` asserts the header size statically); Wa2's lead verifies |
| A11 | `coreBackend.ts` (2,140 lines): Dp1, Mx2, Rc3, Ma1, Ma2, Ma3 each edit it, Ma2 and Ma3 possibly together | W3–W8 | **per-concern modules** K0: `core/laneWriter.ts` (Wa2, Mx2), `presence.ts` (Dp1), `liveMix.ts` (Ma1), `structuralDip.ts` (Ma2), `deferredAdds.ts` (Ma3), the sink calls to `mix/profileSink.ts` (Rc3 implements in `capture/events.ts`); `coreBackend.ts` is the coordinator's after W1 |
| A12 | `context.ts`: Rc2's copy between the decode and the RECYCLE | W4 | K0 leaves the hook (a null check); Rc2 fills `capture/recorder.ts` |
| A13 | `Audio.ts`, `backend.ts`, `myco.ts`: Rc4, Ld4, Ma1, Dbg1 add members | W2–W8 | **declare the whole surface early**: K0 declares every M5 member, delegating to stubs in each owner's file |
| A14 | `mixer.ts`: Mx1, Dp1, Rc3, Ld4, Ma1, Ma3 | W1–W8 | Mx1 declares the whole `Bus` surface (H2); Ld4 registers through its loudness source (no edit); the others one per wave (W4, W6, W5, W8) |
| A15 | `mixOps.ts`, `slotTable.ts`: K0 needs the types in `backend.ts` while Mo1 and Sm1 write them | W1 | **interface stub**: K0's first commit holds the types; Mo1 and Sm1 base on it and own the files after |
| A16 | `slotTable.ts`: Sm1 then Ma2 | W1, W6 | sequential, additive; Ma3 uses Sm1's recycle callback and doesn't edit it |
| A17 | `settings.ts`, `audioSettingsModel.ts`, `AudioSettingsSection.tsx`: Sa1, Mo1, Ld5, Dk1, all but Dk1 free to start early | W1–W8 | wave order: Sa1 and Mo1 (W1), Ld5 (W2), Dk1 (W8); added dependencies Ld5 after Mo1 and Sa1, Dk1 after Ld5 |
| A18 | `mirror.ts` (Wa2, Cp2), `debug.ts` (Cp2, Dbg1), `replay.ts` (Wa2, Mx2), `selection.ts` (Mx2, Rc3) | W2–W6 | sequential, one per wave; each later edit additive |
| A19 | `capture/reader.ts`: Rc1, Rc5, Rc6 | W2, W4, W5 | sequential by dependency |
| A20 | `capture/format.ts`: Rc1, Rc1b; Rc2 needs the keyframe codecs Rc1b writes | W2, W4, W5 | **interface stub** H3: Rc1 declares the codec signatures; Rc2 builds against them; Rc1b fills |
| A21 | `profilerSource.ts`: Rc5 creates it, Pf1 extends it, Rc6 (live mode) in Pf1's wave | W4, W5 | **interface stub** H3: Rc5 declares `appendSegment` in the Worker protocol; Rc6 appends from `recorder.ts` through it; Pf1 owns `profilerSource.ts` in W5 |
| A22 | `capture/worker.ts` (the Worker entry, no row names it): Rc5, Rc6, Pf6 | W4, W5, W7 | named in Rc5's list (a plan seam); sequential |
| A23 | `ProfilerPanel.tsx`: Pf4, Pf5 (tables), Pf8 (`editor/mix/*`), X2 | W7–W8 | **hook stub** H5: Pf4 leaves slots; Pf5 fills `VoiceTable.tsx`/`BusTable.tsx`; Pf8 works in new `openSaveFlow.ts`, `ProfilerBanners.tsx`, `profilerKeys.ts`; X2 alone edits the panel in W8 |
| A24 | `editor/mix/index.ts` and the line in `editor/index.ts`: Pf4, Mp2b | W7, W8 | sequential, additive |
| A25 | `babylonBackend.ts`: Bb2, Bb3, Bb1 | W2, W6, W7 | one per wave |
| A26 | The bench registry: Bn1–Bn4, So1 | W3–W10 | one per wave |
| A27 | `samples/*`: Sa1, Sa2 | W1, W9 | sequential |
| A28 | Test files: B1a's harness vs G1's goldens; Ld8's core tests vs Ld2's; Gs1 vs G1; Ck1's TS file vs Fg1's | W2–W7 | **separate test files / separate layers**: B1a alone edits the existing harness; G1, Gs1, Ld6, Ld8, Ck1 add files |
| A29 | The smoke spec, `export.spec.ts`, the walker grown by many tasks | W1–W10 | single writer per wave (the waves plan's table); E2 and E3 own their milestone's export and walker cases with one lead each |
| A30 | **Default flips before their safety net**: Dp1 (presence) before G1's reference; Ma2 (live structural) before Ck1; Mx1 (`Bus.volume`) before Sa1's samples; R0 before B1a and Wa2 | W1–W7 | held branches and joint merges (the waves plan's flip table) |
| A31 | Pf4's dependency on Rc4 puts the capture chain (Rc2 → Rc3 → Rc4) on the profiler's path | W7 | **interface stub** H4: K0's `Audio.capture` surface; E1 tests the real path (dependency changed in the waves plan) |
| A33 | `chain.rs` reads each bus's gain directly (`chain.rs:82, 94`) for voice sends and the bed fold; no task owned it, so lanes would break sends and beds (review R3) | W1–W3 | K1 routes it through a `lanes::` accessor (bit-identical) and moves automation's `gainMul` multiply (`bus.rs:561–568`) into `lanes::apply`; B1a (W2) and B1b (W3) own `chain.rs` |
| A34 | `coreBackend.ts` code outside K0's seams: `writer.master` (`:591, 808, 817`, Mx2's master and hidden-tab mute) and the bus indexing by project position (`:740–801`, which ARCH §4.7 moves to slots) (review R4) | W3, W5, W6 | K0 moves the master writes into `laneWriter.ts` and the indexing into a new `core/busIndex.ts` (Ma1 W5, Ma2 W6) |
| A35 | Mo1 (W1) must cover `MixOp`s whose settings Ld5 (W2) adds: `setBus "meter"`, `setTarget`, `loudnessResetOnPlay`, and Sa1's new rule fields (review R5) | W1 | **complete config early**: K0's first commit declares those settings types in `settings.ts`; Sa1 and Ld5 write only the parse |
| A36 | `BUS_MIX` in 36 files, including the TS goldens and the parity harness (`coreRender.ts:108`); R0 at 0.5 d couldn't convert them (review R6) | W2 | B1a converts the Rust tests and the bench, Wa2 the TS tests and the parity harness, each with a bit-identity check; R0 re-estimated at 1.5 d and only deletes |
| A37 | Ck1 (W7) names "the discontinuity check on the Mixer scene", which Sa2 builds in W9 (review R7) | W7, W9 | that item runs as DSd in W9 after Sa2, using DS0's extracted `runtime/golden/maxStep.ts` |
| A38 | Flips ahead of their net: Mx2's stamped ramps (net in G1, W4); Dp1 removing the presence path the Babylon fallback uses (`babylonBackend.ts:10`) (review R8) | W3, W4 | Mx2 held and merged with Dp1 + G1; Dp1 keeps main's presence path for backends without the core |
| A39 | The mixer gate exits a task's own build (`build.mjs:153–160`) with ≈ 7.9 KB left (review R9) | W1–W6 | the coordinator raises `MIXER_LIMIT` to 360 KB in W0 with a log line |
| A40 | Rotation of 16 written twice (Rc4's `save.ts`, X1's `trigger.ts`); the 0147 amendment given to Hk1, Dc4 and Dc5; the recorder's lazy chunk at risk from a static import in K0's hook (review R14, R15, R18) | W1, W2, W7, W9 | X1 calls Rc4's rotation; Hk1 is 0147's one author; K0 and Rc2 import `recorder.ts` only through `capture.ts`'s dynamic import |
| A32 | Hk1's files are `src/editor/`, not the audio plugin; the plugin boundary test | W2 | Hk1 alone in `src/editor/` this wave; its acceptance runs `src/plugins/plugins.test.ts` |

**Overlaps checked and left as they were:** sequential additive edits in different waves (`duck.rs` B3 → Dp1 → Sc1; `lanes.rs` B1a → B1b; `mixer.ts` Mx1 → Dp1 → Ma1 → Rc3 → Ma3; `capture/format.ts` Rc1 → Rc1b; `reader.ts` Rc1 → Rc5 → Rc6; `worker.ts` Rc5 → Rc6 → Pf6; `profilerSource.ts` Rc5 → Pf1). Read-only uses across a wave (Ld4 reads Mx1's merged loudness source; Pf2–Pf8 read Pf1's models; Mp2a reads Mp1a's models and the existing `BusMeters.tsx` drawing).

## How a task runs

1. **Skeleton.** The lead commits every file the task creates: full types and signatures, a doc comment naming the spec rule (section, ruling R-n or contract C-n/S-n) each function implements, stub bodies tagged with the leaf id, module declarations so everything compiles, test files with named skipped cases.
2. **Leaves, in parallel.** Each leaf works in its own worktree branched from the skeleton commit, fills the stubs in its files, un-skips its tests, runs only its own checks, and makes one commit.
3. **Lead core, at the same time.** The lead writes the parts that need judgement.
4. **Merge.** Leaves own disjoint files, so their branches merge cleanly; a conflict means a boundary is wrong, and the lead fixes the boundary. The lead writes the glue and runs the acceptance check.

Leaf rules (in every brief, and in the ground rules file):
- **Fill, don't reshape.** Signatures, types, module declarations and other files stay as the skeleton has them. If one looks wrong, stop and report.
- **One owner per file.** A fix goes back to the leaf that owns the file (continue it) or to the lead's glue.
- **Tests as leaves.** A test leaf and an implementation leaf can work from the same quoted spec at once, in separate files; on disagreement the lead checks the spec.
- **Measured numbers only:** a leaf whose spec carries a performance or perceptual bound gets the measured number pasted in (spike S1, S3, S4), or stays with its lead.
- Leads may skip a listed leaf under about half a day and do it themselves; they say so in the report.
- The coordinator merges a leaf directly when its lead's work is complete and the leaf is one disjoint test file.

**Dispatch is flat:** the coordinator starts the lead; the lead commits the skeleton and returns the leaf briefs; the coordinator starts the leaves in one message and continues the lead with their branch names.

**Leaf brief** (the shape; the project commands are in the ground rules file):

```
Leaf <ID>: <one line>
Read first: CLAUDE.md; docs/plans/2026-11-audio-mix-m5-ground-rules.md; <skeleton file(s)>; <spec file and section>.
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

Days are the table's; leaf days are plan est. "Unsplit" gives the reason in one line. Spec sources: API = `api-and-models.md`, ARCH = `architecture.md`.

### Plan tasks

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| K0 (2.5, plan) | strongest | all | none: a skeleton across many files is the lead's job | 0 |
| K1 (2.5, plan) | strongest | all | none: a bit-identical restructure needs judgement | 0 |
| S0 (1, plan) | mid | all | none: one spec, real-app flake judgement | 0 |
| SX0 + LS0 (1.5), SXb + LSb (1.5), SXc + LSc (1.5) | mid (the E2 and E3 leads for b and c) | all | none: written from the running product | 0 |
| DS0 (0.5), DSd (0.5) | G1's lead; Sa2's lead | all (DS0 extracts `maxStep` into `runtime/golden/maxStep.ts`) | none: under half a day | 0 |
| R0 (1.5), W0 (1) | coordinator | all | none | 0 |

### M5-0

| Task (d) | Lead | Keeps | Leaves (files, spec source) | Leaf d |
|---|---|---|---|---|
| Wa1 (5) | mid | `schema/mix.rs` and the family edits, `gen_wire`, ABI 4.0, the two merges | **L-Wa1a** `audio-wire/tests/m5_records.rs`: round trip and fuzz of every new record and section (API §4.2–4.5, §4.5's fuzz list, the 17,824 B case). **L-Wa1b** `runtime/wire.m5.test.ts`: TS round trip of the same vectors, STATUS at the caps and at zero | 1 + 0.5 |
| Wa2 (4) | mid | `mirror.ts`, `bufferPool.ts`, `replay.ts` order, `laneWriter.ts` interim (H1) | **L-Wa2a** `core/statusReader.ts`: the three sections into preallocated arrays, every old `WireError` code (a byte-layout reader; M4's L-Z4a kind, 3 of 3 first pass). **L-Wa2b** `core/commandWriter.ts`: writers for the five records (API §4.2) | 1 + 0.75 |
| B1a (4) | strongest | `lanes.rs` product and identity skip, `ramp.rs`, the `BUS_MIX` mapping, the harness | **L-B1aa** `audio-core/tests/lanes.rs`: lane product, identity lanes skipped, retarget from the current value, `BUS_MASTER_OUT`, RESET on targets (ARCH §4.5) | 0.75 |
| B1b (3) | strongest | class B routing, stamped segments, the overflow rule | **L-B1ba** `audio-core/tests/due_class_b.rs`: frame order for two records of a lane, overflow applies at the quantum start and counts `busRecordsEarly`, exactness 1e-7, `splitQuanta` 0 (ARCH §4.5, S4's 5e-8) | 0.75 |
| Rv1 (4) | strongest | `sends.rs` scaling and the run-out | **L-Rv1a** `audio-core/tests/sends_post_fader.rs`: a muted, dipped, faded bus stops feeding; a settled 1 is bit-identical; last-send removal rings out then resets (ARCH §4.5, R11) | 0.75 |
| B2 (5) | strongest | `bus_slots.rs`, the pending queue, the sequence shift (C27) | **L-B2a** `audio-core/tests/bus_slot.rs`: tombstone as a silent root, kept index, stamped slot at the first quantum holding its frame, a late sequence shifted whole (`lateCommands` once), re-parent re-runs the order (API §4.2, R8) | 1 |
| B3 (3) | strongest | `duck.rs` rule table and validation, the re-run triggers | **L-B3a** `audio-core/src/bus_order.rs`: Kahn over child → parent plus level edges, deepest first then lowest index, cycle detection dropping the last edge in rule order, with tests including S4's 36 of 90 and 438 of 992 pairs and equality with today's order (ARCH §4.6) | 1 |
| B4 (4) | strongest | compressor blending, `fx.rs` | **L-B4a** `audio-dsp/src/biquad.rs`: coefficient blend per quantum with its test (S4: +370 instructions per filter) | 1 |
| Dp1 (3) | strongest | unsplit: presence flags cross main and core with stamped voice frames (lifecycle) | none | 0 |
| G1 (5) | strongest | the offline references (stamped ramp, presence duck), the digest checks | **L-G1a** `runtime/golden/audioGoldenM5.test.ts`: native-equals-wasm cases from the row's list (M4's L-Z3a kind) | 1 |
| Mx1 (5) | strongest | `mixer.ts` lane state and `Ramp` evaluation, H2 | **L-Mx1a** `src/engine/audio/loudnessTypes.ts`: `BusLoudness` and its empty values (API §1.1). **L-Mx1b** `mixer.lanes.test.ts`: fade, snapshot and presence curves against today's at the heard clock; `configure` clears script state (the row's acceptance) | 0.25 + 1 |
| Mx2 (5) | strongest | unsplit: replay and rebuild order across lanes (lifecycle) | none | 0 |
| Sa1 (3.5) | mid | the parse, the samples | **L-Sa1a** `settings.audio.test.ts`: every §2 limit and message, the level-cycle message naming the rules, 32 rules and 8 level (M4's L-F1aa kind) | 1 |
| Bn1 (2) | mid | unsplit: scenes against twins need measured judgement | none | 0 |
| Dc1 (1.5) | mid | unsplit: prose readers see | none | 0 |

### M5a

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| Cp1 (3.5) | strongest | unsplit: the shell's clock across cadence switches (timing) | none | 0 |
| Cp2 (4) | mid | the window, refit, `mirror`, `debug` | **L-Cp2a** `cpuMeter.test.ts`: the fake-`Date.now` cases of API §10 (96 and 384 quanta, a 6→48 switch, a skipped post, a backwards step, the coarse-clock hide, the refit, the epoch restart) | 1 |
| Rc1 (5) | strongest | header, framing, `CaptureError`, the caps, H3 | **L-Rc1a** `capture/format.fuzz.test.ts`: the decode fuzz and bombs of API §10 (every header field and record type corrupted, a lying `len`, a count past its cap, 4 GB declared, a deflate bomb, a 10 MB name, invalid UTF-8, an unknown required type). **L-Rc1c** `capture/__fixtures__/` vectors per record type from API §5.3 | 1 + 0.5 |
| Rc1b (1.5) | strongest | the codecs | **L-Rc1ba** `capture/keyframe.test.ts`: 8,192 voices fit 256 KB, round trip (API §5.5) | 0.5 |
| Rc2 (5) | strongest | the ring, eviction, sizing (allocation, lifecycle) | **L-Rc2a** `capture/ring.alloc.test.ts`: zero allocation over 10,000 STATUS records; eviction leaves a decodable ring | 0.5 |
| Rc3 (5) | mid | the taps across modules | **L-Rc3a** `capture/events.ts` encoders for every §5.6 kind and reason (a spec table), with tests | 1 |
| Rc4 (5) | mid | `capture.ts`, the lazy chunk, rotation, the export case | **L-Rc4a** `capture/save.test.ts`: web Blob and `Storage` paths against the fakes, name sanitising, the empty-save rejection, the uncompressed fallback | 0.75 |
| Rc5 (5) | strongest | unsplit: a Worker with transfers and cancel (concurrency) | none | 0 |
| Rc6 (2) | mid | unsplit: segment hand-off lifecycle | none | 0 |
| Pf1 (5) | mid | `profilerSource.ts`, CPU series | **L-Pf1a** `timelineModel.ts`: viewport clamp and min/max downsampling keeping every underrun tick, with tests (API §7) | 1 |
| Pf2 (5) | mid | `cursorModel.ts`, `voiceTableModel.ts` | **L-Pf2a** `busFactorsModel.ts` + `emptyStates.ts`: the seven lane factors and their product; the strings of API §7 | 0.75 |
| Pf3a (5) | mid | unsplit: canvas interaction and `requestAnimationFrame` | none | 0 |
| Pf3b, Pf3c, Pf3d (4.5 each) | mid | unsplit: drawing needs visual judgement | none | 0 |
| Pf4 (5) | mid | unsplit: panel chrome and H5's slots | none | 0 |
| Pf5 (5) | mid | unsplit: a windowed list's scroll behaviour | none | 0 |
| Pf7 (3) | mid | unsplit: lifecycle (release with no take) | none | 0 |
| Pf8 (4) | mid | banners, keys, labels | **L-Pf8a** `openSaveFlow.ts`: a message per `CaptureError` code naming both versions, progress and cancel states, with tests | 0.75 |
| Bb1 (2.5) | mid | unsplit: backend glue | none | 0 |
| Dbg1 (3.5) | mid | `debug.ts`, the panel | **L-Dbg1a** `audioDebugRows.ts`: rows for the new fields with tests (M4's P10 kind) | 1 |
| Bn2 (3.5) | mid | unsplit: measured judgement | none | 0 |
| E1 (4.5) | mid | unsplit: e2e flake judgement | none | 0 |
| Dc2 (2) | mid | unsplit: prose | none | 0 |

### M5b

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| Ld1 (5) | strongest | f64 K-weighting, the simd128 true peak, the notice | **L-Ld1a** `audio-dsp/tests/loudness_s1.rs`: port of spike S1's 189 checks (`spikes/audio-mix/loudness/`) at 48 and 44.1 kHz | 1 |
| Ld2 (5) | strongest | unsplit: the ring, cadences and take semantics | none | 0 |
| Ld7 (4) | strongest | unsplit: the ladder and the 0170 recovery | none | 0 |
| Ld3 (5) | mid | `loudnessStats.ts` | **L-Ld3a** `loudnessStats.test.ts`: bit-closeness to the Rust `Feed` on S1's sub-blocks, gates, LRA, reset, pause, `incomplete` | 1 |
| Ld4 (4.5) | mid | the hub, targets, taint | **L-Ld4a** `loudnessHub.empty.test.ts`: every row of §1.1's empty-state text | 0.5 |
| Ld5 (4) | mid | the section's toggle and table | **L-Ld5a** `settings.meter.test.ts`: the ninth meter refused with its message, limits, defaults not written | 0.75 |
| Ld6 (4) | strongest | the crate cross-check, the `EBU_FILES` harness | **L-Ld6a** `golden/loudness/` synthesised EBU Tech 3341/3342 set from spike S1's generator, with `loudness_ebu.rs` at ±0.1 LU. **L-Ld6b** the Annex 2 table harness | 1 + 0.5 |
| Ld8 (1.5) | mid | unsplit: under the brief's cost | none | 0 |
| Bn3 (3) | mid | unsplit: measured judgement | none | 0 |
| Pf6 (4) | mid | the Worker series, the track | **L-Pf6a** `loudnessTrackModel.ts`: series from sub-blocks and keyframe readings, target marks (warn, never adjust) | 1 |
| Bb2 (1) | **leaf, no lead** | — | **L-Bb2** `babylonBackend.ts`: §9's loudness rows (inert shape, `metered` false, readings `-Infinity`, the panel text) | 1 |
| E2 (3) | mid | unsplit: e2e | none | 0 |
| Dc3 (1.5) | mid | unsplit: prose | none | 0 |

### M5c

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| Sc1 (4) | strongest | the duck lane's min combine in the core | **L-Sc1a** `audio-dsp/src/sidechain.rs`: peak and RMS detectors, the gain computer, attack and release (ARCH §4.6 formulas; S4's checks, 0.024 dB) | 1 |
| Gs1 (3) | strongest | unsplit: references and null tests | none | 0 |
| Sm1 (4.5) | mid | `slotTable.ts` | **L-Sm1a** `slotTable.property.test.ts`: `configWire()` consistent with live voices for any op sequence; recycle never frees a referenced slot; replay equals the live layout | 1 |
| Mo1 (5) | strongest | `applyOpToDraft`, `opClass`, `diffOps` | **L-Mo1a** `mixOps.test.ts`: `invert` round trip for every op; `diffOps(a,b)` applied to `a` gives `b` | 1 |
| Ma1 (5) | strongest | unsplit: classes and batching | none | 0 |
| Ma2 (5) | strongest | unsplit: one stamped sequence, rebuild replay | none | 0 |
| Ma3 (1.5) | mid | unsplit: small | none | 0 |
| Hk1 (4.5) | mid | unsplit: the play-state guard and the 0147 text | none | 0 |
| Ck1 (4.5) | strongest | the native harness at 8 phases | **L-Ck1a** `runtime/mix/clickTests.test.ts`: one case per class of ARCH §4.7's table plus rename, remove, move, mid-list insert, last-send removal, the send during a dip (S4's thresholds) | 1 |
| Dk1 (4) | mid | the section's fields | **L-Dk1a** `duckModel.ts`: gain-reduction model and the cycle message, with tests; new rules default to `level`, RMS at −30 dBFS (owner decision 8) | 0.75 |
| Mp1a (3.5) | mid | `mixerModel.ts` | **L-Mp1aa** `faderModel.ts` + `meterModel.ts`: the dB taper; peak hold and clip latch extending `meterFill` | 1 |
| Mp1b (3) | mid | Compare, session | **L-Mp1ba** `monitorModel.ts`: the taint rules of API §6.6 as a table with tests | 0.75 |
| Mp2a (5), Mp2b (4) | mid | unsplit: views | none | 0 |
| Fg1 (2.5) | mid | unsplit: timing harness | none | 0 |
| Bb3 (3) | mid | unsplit: structural rebuild on the fallback | none | 0 |
| Bn4 (2) | mid | unsplit: measured | none | 0 |
| E3 (5) | mid | unsplit: e2e, every option | none | 0 |
| Dc4 (2) | mid | unsplit: prose | none | 0 |

### M5d

| Task (d) | Lead | Keeps | Leaves | Leaf d |
|---|---|---|---|---|
| X1 (4.5) | mid | the option's plumbing, the dialog, the player | **L-X1a** `capture/trigger.ts`: F9 start/stop/save and the one-second three-finger hold against fake events, calling Rc4's rotation (owner decision 7) | 0.75 |
| X2 (2.5) | mid | unsplit: small | none | 0 |
| X3 (4) | mid | unsplit: e2e | none | 0 |
| Sa2 (4) | mid | unsplit: audible judgement | none | 0 |
| So1 (3) | strongest | unsplit: measurement | none | 0 |
| Ls1 (2.5), Dc5 (4) | mid | unsplit: prose | none | 0 |
| Ls2 (5) | strongest | unsplit: rework as found | none | 0 |

## What it changes (all plan est.)

- **Leaves:** 41 leaves totalling ≈ 34.5 leaf-days (M5-0 14 leaves, 11.75 d; M5a 11, 8.75 d; M5b 8, 6.75 d; M5c 7, 6.5 d; M5d 1, 0.75 d), about 11% of the table's 300.5 d.
- **Days by model** (table days, plus the plan tasks): strongest 119 d before the split → ≈ 103.5 d after (15.5 leaf-days moved off S rows); mid 192.5 d → ≈ 173.5 d (19 moved, Bb2 included). The cheapest model takes ≈ 34.5 d.
- **Critical path:** the leaves on the pure chain (L-B1aa, L-B1ba, L-Mp1aa) run beside their leads, so the chain's 47.5 d may shorten by ≈ 1–2 d if the leads finish their cores while the leaves work; the plan doesn't count on it.
- **Unsplit tasks:** each has its one-line reason above; most are lifecycle, timing, Worker concurrency, measured judgement, views, e2e or prose.

**The pilot's measures (W1):** leaf first-pass success (M4: 34 of 34 at mid-build); lead time spent on skeletons and briefs (K0 and K1 against their 2.5 d); **skeleton fit** (how many later tasks must change a K0 or K1 seam: M4 had one, R1); tokens by model; agent-minutes per table-day. **What changes if it falls short:** a leaf kind needing more than one re-run moves back to its lead and the criteria tighten; if K0 or K1 overrun by more than a day, W2's strongest tasks start on K1's stage A commit and the coordinator takes the remaining seam work; if agent-minutes per table-day run well over M4's pace, the coordinator re-cuts W6–W9 for the measured pace and tells the owner the new estimate.

## Independent review

A fresh agent that didn't write these files reviewed the waves plan, this tree and the design against the code (2026-11-13) for hotspots, rework, contracts that land too late and tasks missing from the source. It confirmed all 79 rows appear once, no task precedes a dependency, and the state-at-planning facts it checked hold. Its findings, each checked against the code by the planner before fixing:

| # | Finding | Severity | Fix |
|---|---|---|---|
| R1 | Dispatch is in `scheduler.rs`, not `core.rs`; B1a/B2 (W2) and B3/B1b (W3) would share it | blocking | A2: K1 adds every arm in `scheduler.rs` |
| R2 | More tests hard-code the STATUS layout, and `CORE_ABI_MAJOR = 3` would fail every core load at Wa1's merge | blocking | A10: all in Wa1's merge 1, one merge with K1's stage B |
| R3 | `chain.rs` reads bus gains directly and had no owner | blocking | A33 |
| R4 | `writer.master` and the bus indexing in `coreBackend.ts` were outside K0's seams | major | A34: `laneWriter.ts`, new `busIndex.ts` |
| R5 | Mo1's ops need settings types Ld5 adds after it | major | A35: K0's first commit declares the types |
| R6 | R0 far bigger than 0.5 d (`BUS_MIX` in 36 files, the parity harness among them) | major | A36: conversions in B1a and Wa2; R0 1.5 d |
| R7 | Ck1's Mixer-scene item can't run before Sa2 | major | A37: DSd in W9 |
| R8 | Mx2's and Dp1's flips ahead of their nets | major | A38 |
| R9 | The mixer gate fails a task's own build | major | A39: raised in W0 |
| R10 | Mid overflow in W6, W8, W9 unacknowledged | major | start orders in each wave (W8 plan est. +2 d) |
| R11 | `check:audio-metered` listed as a must-pass wave gate | minor | shippable item 1: run as a tripwire, logged, not a merge gate |
| R12 | DSd's path differed from G1's; `maxStep` is private | minor | `runtime/golden/`; DS0 extracts the helper |
| R13 | Mx1's `duckGain` and Dbg1's slot rows need later work | minor | coded against stubs, said in their rows |
| R14 | Rotation written twice | minor | A40: X1 calls Rc4's |
| R15 | 0147's amendment had three authors | minor | A40: Hk1 only |
| R16 | Dc5's "after Ls1" missing in W10 | minor | added |
| R17 | K1 stage B and Wa1 merge 1 read as circular | minor | stated as one merge |
| R18 | A static import of `recorder.ts` would defeat the lazy chunk | minor | A40, K0's contract text |
