# 0452. Plugins contribute diagnostics through one contribution point, every recording is a capture of them, and the profiler is a self-contained module in the Audio Studio

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0144, 0171, 0172, 0261, 0275, 0341, 0348, 0373, 0376, 0403, 0408, 0409, 0411, 0412, 0416, 0417, 0451

Design folder: [`docs/design/plugin-lanes-localisation/`](../design/plugin-lanes-localisation/goal.md) (goal, owner's
answers). Spikes: [`spikes/studio-editor-halves/`](../../spikes/studio-editor-halves/README.md),
[`spikes/player-chunks/`](../../spikes/player-chunks/README.md).

## Glossary

- **Diagnostics:** time-stream data a plugin, or the engine core, wants profiled: what happened when, how long
  something took, a number over time, a periodic picture of state. Audio's sounds starting and its DSP load are
  diagnostics; so are the engine's frame times.
- **Diagnostics contribution point:** the one place a plugin's runtime half registers the diagnostics it produces
  (`ctx.diagnostics`). The core registers its own through the same point.
- **Diagnostics source:** one registration: a named family of records a contributor writes each frame, such as
  `myco.audio/profile` or `core/frames`. Earlier drafts called it a lane.
- **Capture:** diagnostics saved to a file (`.sporesample`, 0409). Today's takes and captures become one thing; the
  word "take" is retired.
- **Debug link:** the engine's connection between a running game and a tool (0376, 0403). It carries diagnostics live.
- **Profiler:** the tool-side module that shows diagnostics live or from a capture. It lives in the Audio Studio for
  now.
- **Playback:** moving a time cursor through diagnostics (play, pause, scrub) so every view shows that moment.
- **Re-execution:** feeding recorded diagnostics back into a running engine so they happen again, such as audio
  playing a capture's sounds through the current project. A plugin offers it for its own sources.
- **Deep link:** an event in the profiler that names an asset, so clicking it opens that asset's editor.
- **Diagnostics views:** the profiler tracks and panels a plugin contributes for its own sources, from its editor half.

## Context

**Audio's recordings are the only diagnostics pipeline, and they're audio's.**

- **Files:** `.sporesample` (0409) has a 96-byte header with a TAKE flag, then one deflate stream holding a META JSON
  chunk, records and an INDEX. Each record has a 20-byte head (`u8 type`, `u8 flags`, `u16 epoch`, `u32 len`,
  `u32 seq`, `f64 frame`). Types below 0x80 are skipped by a reader that doesn't know them.
- **Type space:** audio profile 0x01–0x09, audio requests 0x10–0x3f, plugin take extensions 0x40–0x7e, INDEX 0x7f.
  Animation uses 0x40–0x44 (`plugins/animation/runtime/features/debug/frameRecord.ts`, `takeRecords.ts`).
- **Code:** the framing, recorder, triggers and take ownership are in the audio plugin
  (`plugins/audio/runtime/capture/`: `format.ts`, `reader.ts`, `takeRecorder.ts`, `takeOwnership.ts`, `trigger.ts`);
  codecs and the assembler in `src/engine/audio/take/`; the debug link's own head reader in
  `src/engine/debugLink/records.ts`.
- **Takes versus captures:** a capture is profile-only telemetry (0171, 0172); a take adds the requests replay needs
  (0348). F9 records a capture and F10 a take, each enabled by an Export option (`audioCapture`, `audioTake`).
- **Live:** the Profiler follows a connected build's capture from connect (0411). The Take screen shows a take only
  while one is recording, and asks for Record session otherwise (0411, item 1).

**Other profiled data uses separate routes.**

- **Play Stats** (`src/editor/playStats.ts`): frame time, per-World phase times, render counters, node counts and JS
  heap from the `EngineTiming` hook (`src/engine/core/Engine.ts`). Plugins add counters and tables through two editor
  points, `registerPlayStatsCounter` and `registerPlayStatsTable`: `myco.audio.underruns`, `myco.navigation.agents`,
  and an Animation table (`plugins/animation/editor/profiler/register.ts`).
- **Animation** writes take extension records, serves an `animation` debug link topic
  (`features/debug/register.ts`) and replays takes in its editor debugger (`editor/debugger/takeControl.ts`,
  `runtime/features/debug/takeReplay.ts`).

**The profiler is part of the Studio and audio-only.** `src/studio/screens/profiler/` (39 files) and `run/` read audio
data; the track kit (0261) is in `plugins/audio/editor/mix/tracks/kit.ts`. The Studio activates audio, physics and
physics-rapier only (`studio/boot/studioPlugins.ts`).

**Spike:** every first-party editor half (18 of the 21 plugins have one) activates cleanly in a Studio-like context
with no editor shell, and the Studio already loads every module they import statically
([`spikes/studio-editor-halves/`](../../spikes/studio-editor-halves/README.md)). Activating whole halves would make
the Studio list every plugin's asset kinds, and two halves start loading Svelte built-ins when activated.

**Owner's direction (2026-11-27/28):** one common diagnostics API that plugins contribute to; audio's takes are just
audio's diagnostics and the Studio a view on them; replay is part of diagnostics; collect only while a tool is
connected or after a button press; phase 1 adds no new data; the profiler stays in the Studio as a self-contained
module and moves out later; no protobuf; Perfetto and OTLP out of scope.

## Decision

We will add one **diagnostics** contribution point, move audio's recording pipeline onto it so every recording is a
**capture**, and separate the **profiler** into a self-contained module that the Audio Studio hosts.

**Diagnostics contribution point**

- `ctx.diagnostics.source(name, load)` on the runtime context. A source loads lazily and provides:
  - its name (`<plugin>/<source>`) and version;
  - how many record types it needs;
  - a `sample(writer, frame)` that writes its records for the frame;
  - optional keyframes, so playback can seek;
  - optional **deep links**: which records name an asset (a path), so the profiler can open it;
  - optional **re-execution**: how to feed its records back into a running engine.
- The core registers `core/frames` through the same point: what Play Stats collects today (frame and step times,
  per-World phase times, render counters, node counts, heap).
- `take.source` is removed; its users move to `ctx.diagnostics.source`.

**Captures**

- The framing (header, META, records, INDEX, deflate, caps) moves from the audio plugin to the engine
  (`src/engine/diagnostics/`), with one change: META gains a **source table**. It lists each source's name, version
  and the record types the recorder gave it.
- Audio keeps its current type numbers for its sources (`myco.audio/profile`, `myco.audio/requests`). Other sources
  get types from the free range when a capture starts. A reader finds a record's source through the table, and skips
  a source it doesn't know by length.
- The TAKE flag and the take/capture distinction go. Every file is a capture of whatever sources were on. No old file
  is migrated (no outside users).
- Budgets stay as today's caps. Per-source budgets and choosing sources are later.

**When diagnostics are collected**

- **Only while a tool is connected, or after the build's record key is pressed.** Release builds collect nothing.
- **Record key:** one key starts and stops a capture in any debug build: F9, or the one-second three-finger hold on
  touch. The file goes to the build's own disk, with today's backup rotation (0417). F10 is freed. The two Export
  options become one (`capture`).
- **Connected tool:** the tool shows diagnostics live from the moment it connects, keeping a bounded look-back
  window in memory or a temporary file. Nothing is saved until Record; Record and Stop save a capture where the tool
  keeps recordings (0408). While a tool is connected its Record controls the build's capture, as Record session does
  today (0411, 0412).
- **The Take screen goes live too:** it streams from connect like the Profiler, no longer waiting for Record
  (amends 0411, item 1).

**Transport**

- The debug link stays the engine's transport. Diagnostics travel as samples in today's record framing. Phase 1 keeps
  the `audio` and `animation` topics and moves their recording parts onto diagnostics. Whether one engine topic
  carries every source is settled in the technical design.

**Replay**

- **Playback** is generic: the profiler moves a time cursor through any capture or live window, and every view
  follows it.
- **Re-execution** is a source's optional hook. Audio's existing replay through the current project (0348) and
  animation's take replay port onto it.

**The profiler**

- A self-contained module inside the Studio (for example `src/studio/profiler/`). The Studio uses it only through its
  interface, never its internals, so it can move into its own app later.
- It holds the capture model and reader, playback, live follow, the look-back window, the track kit (moved from
  `plugins/audio/editor/mix/tracks/kit.ts`) and the views it shows.
- **Profiler host interface:** what the module asks of whoever hosts it: open and save files, status messages, the
  theme, and **open an asset** for deep links. The Studio opens what it edits itself (sounds, playlists) and hands
  other assets to the editor if it's running, through the existing app hand-off (0341, 0380).
- The Take and Profiler screens are both views on it. They stay two screens for now; merging them is later.

**Diagnostics views**

- A plugin's views come from its **editor half**, in a module the manifest names with an optional **`diagnostics`**
  key (for example `"diagnostics": "editor/diagnostics/index.ts"`). No key means no profiler views.
- The profiler imports only those modules, never whole editor halves, so it doesn't depend on the editor's plugin
  loading. A views module registers through the profiler's own registry.
- **Phase 1 views:** audio's existing profiler and take views move into audio's diagnostics module, and core views
  show `core/frames`. Animation keeps its debugger panel in the editor, reading diagnostics instead of takes; it gets
  profiler views later.

**Play Stats**

- The overlay stays and reads diagnostics: `core/frames`, plus the counters and tables plugins now contribute as
  diagnostics sources. `registerPlayStatsCounter` and `registerPlayStatsTable` are replaced. Navigation's counter is
  frozen code, so it keeps working through a thin adapter in the shell and isn't changed.

**Not in phase 1:** new diagnostics data; profiling editor Play (not built today); animation views in the profiler;
choosing sources and customising views; per-source budgets and cost baselines; a profiler app of its own.

## Alternatives considered

- **Keep audio's pipeline and add one take extension per plugin.** Works for animation today, but every other
  plugin's data rides inside audio's files and caps, and the Studio stays an audio tool.
- **Collect diagnostics always, in a rolling buffer.** Debug sessions can last hours; the owner prefers collection
  only while a tool listens or after a button press.
- **The Studio activates every plugin's whole editor half.** The spike shows it works, but the Studio would list
  every plugin's asset kinds and start Svelte loads, and a later standalone profiler couldn't rely on editor halves.
  A named diagnostics module is lighter.
- **A third plugin half, `diagnostics/`, beside runtime and editor.** The views are editor code; a key pointing into
  the editor half keeps the two halves the manifest already declares.
- **A source field in every record head.** Changes every reader and costs bytes in every record; a source table in
  META keeps the head.
- **Perfetto or Tracy as the profiler, protobuf as the format.** Rejected by the owner (in-engine profiler, custom
  binary formats).

## Consequences

**Positive**
- One API for every profiled thing: audio, the core, animation, Play Stats' counters, and future plugins.
- The Studio's audio tools become views on audio's diagnostics, and the profiler can leave the Studio later without
  a rewrite.
- Deep links and re-execution become something any plugin can offer.
- Takes and captures collapse into one concept, one key and one Export option.

**Negative / costs**
- Moving the framing, recorder, triggers and ownership out of audio touches every reader and the Studio's two
  screens.
- The Play Stats points and `take.source` change for every plugin that uses them (audio, animation; navigation
  through an adapter).
- A connected tool's look-back window costs memory or disk while connected.
- **Provisional estimate:** about 77 table-days of work plus a third in reserve, 85–115 table-days in all (table-days
  are the relative unit of earlier plans; the M4 milestone's 290 table-days ran in about two days of agent time,
  `docs/plans/2026-11-audio-mix-m5-waves.md`). Calibrated against earlier task tables' estimates, not actuals. The
  real figure comes from the technical design's task table.

## Deprecates

- `take.source` and the 0x40–0x7e take extension registry (replaced by `ctx.diagnostics.source` and META's source
  table).
- The take concept: the TAKE flag, `Audio.take`, F10, the `audioTake`/`audioTakeFrames` Export options (replaced by
  captures, F9 and one `capture` option). `Audio.capture` gives way to engine capture control.
- The audio plugin's ownership of the capture format, recorder, triggers and take ownership (moved to
  `src/engine/diagnostics/`).
- `registerPlayStatsCounter` and `registerPlayStatsTable` (replaced by diagnostics sources).
- Amends, on acceptance: 0348 (takes are captures), 0411 item 1 (the Take screen is live from connect), 0416 (the
  editor records nothing; unchanged in effect, the terms change), 0417 (take ownership becomes capture ownership in
  the engine), 0261 (the track kit moves into the profiler module), 0373 and 0378 (animation's take records become a
  diagnostics source).

## Open questions

- One engine topic for all sources versus keeping per-plugin topics (technical design).
- The look-back window's length and whether it lives in memory or a temporary file (technical design).
- Whether the record key should show a toast naming the sources recorded.

## References

- `src/plugins/audio/runtime/capture/`, `src/engine/audio/take/`, `src/engine/debugLink/`.
- `src/studio/screens/profiler/`, `src/studio/screens/run/`, `src/studio/boot/studioPlugins.ts`,
  `src/plugins/audio/editor/mix/tracks/kit.ts`.
- `src/editor/playStats.ts`, `src/plugins/animation/editor/profiler/register.ts`,
  `src/plugins/animation/runtime/features/debug/`, `src/plugins/runtimeContext.ts`.
- Spikes: `spikes/studio-editor-halves/`, `spikes/player-chunks/`.
