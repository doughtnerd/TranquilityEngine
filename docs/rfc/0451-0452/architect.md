# RFC review: 0451 and 0452 (architect)

What I read: ADR 0452 and 0451 (fully); `docs/design/plugin-lanes-localisation/goal.md`; both spike READMEs; decisions sections of 0144, 0348, 0376, 0403, 0408, 0411, 0412, 0416, 0417; `src/plugins/runtimeContext.ts`; `src/engine/audio/take/extensions.ts`; `src/engine/debugLink/{topics,records,session}.ts`; `src/plugins/audio/runtime/capture/{capture,ring,recorder,take,takeRecorder,takeOwnership,trigger,worker}.ts` (heads and key paths), `format.ts:771-780`, `reader.ts` flags; `src/studio/boot/studioPlugins.ts`; the Studio screens' imports from `plugins/audio`; `src/editor/playStats.ts`; `plugins/animation/runtime/features/debug/takeRecord.ts`; `src/player/main.ts`.

**Verdict: approve 0451 with one change; approve 0452 with changes.** The direction is right and reversible. 0452's source contract drops properties today's pipeline depends on.

**Top 3 concerns**
1. A capture has no clock without audio. Every record's `frame` today is an audio sample frame.
2. The source contract is pull-only and has no loss policy, but audio pushes from the worklet's STATUS stream, and take requests must never be dropped.
3. The look-back window is placed in the tool. The build already has a bounded, zero-allocation ring that also survives a disconnect.

## Issues

1. **blocking: no timebase for captures.** A file record's `f64 frame` is the STATUS `currentFrame` (`format.ts:771-780`). Plugin records take "frame from the recorder's now" (`takeRecorder.ts:4`), which is the audio clock. On the link, `frame` is the build's frame counter (`records.ts:10`, `session.ts:147`). With audio disabled, nothing drives a capture's clock, and core/animation records can't sit on audio's axis. *Change:* the engine recorder owns one clock (engine frame number plus a monotonic seconds column per frame). Each source's entry in META's source table names its clock (`engine` or `audio`). Audio writes an engine↔audio mapping record at each keyframe so playback aligns the two.

2. **major: the source contract.** `TakeSourceHost.write` is push today (`extensions.ts:33-43`). Audio's profile is written inside the STATUS tap as blocks arrive (`recorder.ts:1-5`), not once per engine frame. Requests go to a log that is "never dropped", while the profile ring evicts (`takeRecorder.ts:1-5`, `ring.ts:1-6`). *Change:* a source gets a host with `write(type, payload)` at any time, plus the optional per-frame `sample`. It declares a **retention class**: `ring` (evictable, keyframed) or `log` (lossless within the cap). It also declares a **link channel** (reliable/unreliable, as `topics.ts:32-38`).

3. **major: where the look-back lives.** Keep it in the build: the existing ring (`ring.ts:16-32`, 16–32 MiB, keyframed segment eviction, zero allocation per record) under the existing owner refcount (`capture.ts:8-12`). The tool mirrors sealed segments as it does today (R17). Record then marks a `(start, end)` span, as a take does now (`capture.ts` "A take is a (start, end) pair"). A tool-side window duplicates memory, and any span not yet sent is lost if the link drops.

4. **major: "only while a tool is connected" leaves out in-process consumers.** Play Stats runs in the editor's own page and collects only while shown (`playStats.ts:1-5`), not over the link. *Change:* collection is on while there is at least one **consumer**: a link subscription, an in-process subscriber (Play Stats) or the record key. Counted like today's ring owners.

5. **major: type allocation lifecycle.** Types are given "when a capture starts", but the live stream starts at connect. A script reload deactivates and re-activates halves (0144), which re-registers sources mid-stream. META is written once. The 0x40–0x7e range is 63 types. *Change:* fix the table per **epoch**. A source set change ends the epoch and opens a new one with a fresh table (EPOCH records already exist). A source that doesn't fit is refused, named in the status and in META. Record-type counts are declared at registration, so allocating them doesn't load every source's code.

6. **major: what moves into the profiler is under-listed.** Beyond `tracks/kit.ts`, the Studio screens import audio's `editor/mix/{profilerSource,liveFollow,cursorModel,openSaveFlow}`, `editor/debugLink/audioLinkClient` and `runtime/capture/{reader,format,worker}`. The capture worker decodes audio itself (`worker.ts:19-31`: `LoudnessTrackModel`, `wire.generated`). *Change:* list these. Split a generic worker (open, index, seek and range per source) from source decoders, which a views module may supply as a worker entry.

7. **minor: a source that throws.** `session.ts:153-159` logs and breaks on every due frame, forever. *Change:* after its first throw, a source stops for the rest of the epoch. A `source stopped` record marks the gap so readers don't read absence as zero, and one status line names the source.

8. **minor: release builds.** State that the diagnostics registry follows `topics.ts:1-6`: loaders only, type-only imports. Release exports then ship no source code, `core/frames` included.

9. **minor: navigation adapter.** Navigation's call site can't change, so `registerPlayStatsCounter` stays as an SDK point that forwards. Say "kept as an adapter", not "replaced".

10. **minor (0451): boot order.** The player calls `installBuildStrings` at `main.ts:62`, before plugins activate (`:99`). *Change:* say whether the player still imports the plugin's boot when `myco.localisation` is disabled (it shouldn't; read `settings.plugins.disabled` first). Say that a re-activated provider (script reload) fires `changed`.

## Failure modes

| Event | Today | Required by the record |
|---|---|---|
| Tool disconnects mid-Record | build backs up the take (0417, `takeOwnership.ts:9-12`) | same for a capture. With the build-side ring (issue 3) the span survives; the tool offers to save what it has, flagged `TRUNCATED` (`reader.ts` already reads it) |
| Build crashes mid-capture | ring lost | tool keeps the mirrored segments; save as truncated, no INDEX (reader rebuilds by scan) |
| Source throws or loads late | warn, left out (`take.ts:258-265`) | issue 7; a late load joins at the next epoch |
| Unknown source in a file | skipped by length | skipped via table. The profiler shows a "no views for `x/y` v2" track; a views module declares the versions it decodes |
| Range exhausted, cap reached | take stops itself (`takeRecorder.ts:378`) | per-source refusal (issue 5); cap stops the capture with a toast, as now |
| Views module throws in the Studio | n/a | that plugin's tracks show an error; other tracks unaffected (registry isolates per module) |

## Performance

- **One encode per record.** `RecordWriter.write` allocates a buffer per record and `take()` copies again (`records.ts:47-74`). At 60 Hz across `core/frames` plus counters that is steady garbage. Encode once into the ring (zero allocation), and let the link ship ring segments. Then live, look-back and capture cost one write.
- **Idle cost is zero.** With no consumer, nothing is registered on `EngineTiming` and no source is loaded (today's Play Stats rule).
- **Connected cost** is bounded by the link's reliable budget (8×64 KiB×30 Hz, `session.ts:19-24`). The record should state that the look-back is the ring size (16 MiB default), not a duration. A duration hides device memory; `ringBytesFor` already caps by `deviceMemory`.
- **Record-key latency.** Sources load at Record (`take.ts:258`). On web that's a fetch. Preload on the first consumer, not on the press.
- **Tool side.** Decoding stays in the worker (issue 6). Main-thread views get columns, never records.

## Seams and ownership

- **Engine (`src/engine/diagnostics/`):** registry (loaders), recorder, ring, framing, clock, source table, consumer refcount, record key, capture ownership and backups. Thread: main. The audio worklet stays behind audio's STATUS tap.
- **Plugins:** runtime sources (push or sample), and views modules plus optional worker decoders.
- **Profiler module:** reader, worker, playback, live follow, track kit, view registry, and the host interface (open/save, status, theme, open asset).
- **Location, for reversibility:** the plugin-facing contract (view registry types, track kit API) shouldn't live under `src/studio/`. Plugin editor halves would import the Studio app, and moving the profiler later would touch every plugin. The editor couldn't reuse the module either (goal, answer 2: one profiler in the editor and the Studio). Put the module in a neutral folder (e.g. `src/profiler/`) that the Studio hosts. No editor or Studio code imports its internals; a check script beside `check:filenames` can enforce it.
- **Transport:** one engine `diagnostics` topic carrying segments follows naturally from issues 2 and 3. Per-plugin topics stay for commands and requests (animation's parameter writes).
- **Portability:** build-side backups use the Tauri FS (desktop, Android); web keeps the per-session download cap. A tool-side temp file would need OPFS on web. One more reason for the build-side ring.

## Cheaper alternatives

- **Generalise audio's ring instead of rewriting it.** Move `ring.ts`, `recorder.ts` and `format.ts` to the engine as-is. Add the source table and the engine clock. Audio becomes the first `ring` source and the take log the first `log` source. Most of the estimate's risk is in that rewrite.
- **Skip `core/frames` as a capture source in phase 1.** Have Play Stats subscribe in-process through the same registry and defer frames-in-captures. That leaves the clock work (issue 1) with a single non-audio user, animation.

## Questions for the author

1. Does Record include the look-back (pre-roll from the window) or start at the press?
2. Which clock does the profiler's time axis show when audio is disabled?
3. Is the 63-type range enough once every first-party plugin has sources, or does the source table let types be reused per epoch?
4. In the takes-folder workspace (no project, 0408), which plugins' views modules load: every first-party one, or only those named in the file's table?
