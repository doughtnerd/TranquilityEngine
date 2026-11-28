# 0452. Recordings are made of plugin lanes, one profiler serves the editor and the Studio, and plugins contribute their build steps

- **Status:** Proposed
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0144, 0171, 0172, 0220, 0261, 0326, 0341, 0348, 0373, 0376, 0403, 0408, 0409, 0416, 0417, 0447, 0451

## Context

**Recordings are audio's today, though other plugins already write into them.**

- **Format:** a recording is a `.sporesample` file (0409). It has a 96-byte plain header (TAKE flag for takes), then
  one deflate stream holding a META JSON chunk, records and an INDEX. Each record has a 20-byte head: `u8 type`,
  `u8 flags`, `u16 epoch`, `u32 len`, `u32 seq`, `f64 frame`. Types below 0x80 are skipped by a reader that doesn't
  know them; 0x80 and above make it refuse the file.
- **Type space:**

  | Range | Use |
  |---|---|
  | 0x01–0x09 | audio profile (STATUS, KEYFRAME, EVENT, MARKER, NAMES…) |
  | 0x10–0x3f | audio requests, used by take replay (0x10–0x20 used: PLAY…FADE) |
  | 0x40–0x7e | plugin take extensions (`take.source`); animation uses 0x40–0x44 |
  | 0x7f | INDEX |

- **Caps:** 256 KB per record, 64 MiB per capture and 256 MiB per take, uncompressed. The profile is a bounded ring;
  requests are never dropped. There is no budget per plugin: extension records share the take's cap.
- **Where the code lives:** the framing, header, META, INDEX and recorder are in the audio plugin
  (`plugins/audio/runtime/capture/`). The record codecs, take assembler and extension registry are in
  `src/engine/audio/take/`. The debug link has its own reader of the same head (`src/engine/debugLink/records.ts`).
- **Control:** `Audio.take` (`start`, `stop`, `mark`, `save`), the F9/F10 triggers (`capture/trigger.ts`, enabled by
  `game.json`'s `audioCapture`/`audioTake`), and take ownership (0417: hand-off to a connected tool, a rotated backup
  of 16). ADR 0416 removed recording from the editor: the Studio and game builds record.
- **Live transport:** the debug link (0376, 0403) serves topics registered through `ctx.debugLink.topic`.
  Two exist: `audio` and `animation`.

**The profiler is the Studio's and audio-only.**

- `src/studio/screens/profiler/` (39 files) and `run/` read only audio data. The track kit (0261) is in
  `plugins/audio/editor/mix/tracks/kit.ts`, used only by Studio screens. ADR 0326's table kit
  (`profilerTablesModel.ts`) is not in the tree.
- The editor shows only the Play Stats overlay (`editor/playStats.ts`, `ui/PlayStats.tsx`). It reads FPS, per-World
  phase times, render counters, node counts, heap and plugin counters/tables, through the editor contribution points
  `registerPlayStatsCounter` and `registerPlayStatsTable` and the single `EngineTiming` hook (`setEngineTiming`).
- The Studio activates a fixed plugin set (audio, physics, physics-rapier; `studio/boot/studioPlugins.ts`). It opens
  a recordings folder without a project (0408).

**Build options are hard-coded.** The export options (`audioCapture`, `audioTake`, `audioTakeFrames`, `debugLink`),
`GameManifest`'s keys (`localisation`, `debug`, the audio ones), `buildLaunch` and the player's boot steps
(`player/main.ts`) all name features. ADR 0447 deferred letting each feature own its slice, because that needs a new
contribution kind with launch phases, which is a plugin-model change. There is no export, launch or profiler-lane
contribution point.

**Owner's direction (2026-11-27):**
- Keep the profiler in the engine's own tools, with our own data model, growing the debug link instead of depending
  on Perfetto or Tracy.
- No protobuf: keep the custom binary formats.
- Treat takes as plugin debug data shown as lanes like any other.
- Keep the Audio Studio a standalone tool, with one profiler core and view set shared with the editor.
- Perfetto and OTLP export are out of scope for now.
- Plugins should be able to submit data that a debug build records for profiling.

## Decision

We will make recordings engine-owned and made of **lanes** that the core and plugins contribute, build one
**profiler** module that both the editor and the standalone Studio host, and let plugins contribute their **build
steps**.

**Recording and lane**

- A **recording** is one run's debug data: a `.sporesample` file, or a live debug link session. The file framing
  (header, META, records, INDEX, deflate, caps) moves from the audio plugin to the engine
  (`src/engine/recording/`), unchanged except for the lane table below.
- A **lane** is one family of records from one contributor, named `<plugin>/<lane>` (for example
  `myco.audio/profile`, `myco.audio/requests`, `myco.animation/frames`). The core contributes `core/frames`.
- A lane is either a **profile** lane (telemetry: bounded ring, oldest data dropped behind GAP records) or a
  **request** lane (what the game asked, kept whole for replay; the recording stops with a message at the cap). A
  **capture** is a recording of profile lanes only. A **take** also has request lanes (the TAKE flag, as today).

**Record types per lane**

- The record head stays 20 bytes. META gains a **lane table**: each lane's name, version, family, budget and the
  record types the recorder assigned it. Each lane declares how many types it needs, normal and required (0x80+).
- Audio's existing numbers stay as they are for its two lanes, so audio data in older takes still reads. Other lanes
  get types from the free ranges when a recording starts, which generalises today's 0x40–0x7e extension registry.
- A reader looks a record's lane up by its type through the lane table. A lane it doesn't know is skipped by length,
  and shown in the profiler as "no viewer for `<lane>`".
- **Budgets are per lane** (a share of the recording's cap), so one plugin can't crowd out the others.

**Contributions**

- **Runtime:** `ctx.recording.lane(name, load)` replaces `take.source`. The lane loads lazily and provides its type
  counts, family and budget, a `sample(writer, frame)` that writes its records, optional keyframes for seeking, and,
  for request lanes, an optional replay entry.
- **`core/frames`** is the core lane: frame and step times, per-World phase times, render counters, node counts and
  heap, from the engine's timing source. `EngineTiming` and Play Stats' private hook become that lane's input.
- **Live transport:** the debug link gets one engine topic, `recording`. A tool subscribes to lanes by name and
  receives their records as samples in today's record framing. The `audio` and `animation` topics keep their
  requests and commands (live mixing, animation debugging) and drop the parts the `recording` topic now carries.

**Recording control**

- Take ownership (0417), the triggers (0172 F9/F10, three-finger hold) and the backup rotation move from audio to the
  engine. Control becomes `Recording.start/stop/mark/save` in `myco`, available in builds with debugging on.
- `Audio.take` keeps working, forwarding to `Recording`, for one release, then is removed.
- Captures and takes stay distinct only by which lanes are on: a capture records profile lanes; a take adds request
  lanes.

**One profiler, two hosts**

- A new module, `src/profiler/`, neither editor nor Studio code, holds:
  - **Profiler core:** the recording model; the reader and its worker; seek, cursor, selection and live follow; the
    lane view registry; the track kit (moved from `plugins/audio/editor/mix/tracks/kit.ts`); and the table kit 0326
    described, built here.
  - **Profiler views:** the timeline, ruler and filmstrip, detail panels and tables. They are written against a
    **profiler host** interface: open and save files, status messages, theme, and optional project-aware actions
    such as revealing a node or opening an asset. They never read editor or Studio shell state.
- **Lane views:** a plugin contributes the views for its lanes (tracks, details, readouts, tables) from a separate,
  small `profiler` entry beside its editor half. A host can load lane views without loading the plugin's whole
  editor half. Audio's profiler screens become audio's lane views; animation's take viewer becomes animation's.
- **The Audio Studio** stays standalone. It hosts the profiler; loads the `profiler` entries of every plugin it knows
  (first-party catalogue, plus a project's third-party plugins when a project is open); and keeps replay against the
  project, mixing, playlists and the other audio screens. Its Take and Profiler screens become one Recording view.
- **The editor** hosts the same profiler as a panel, for live debug link sessions and recordings opened from disk.
  Play Stats stays as the quick overlay, reading the `core/frames` lane and the plugins' counters.

**Build steps from plugins**

This fills the slice 0447 deferred.

- **Export step:** a plugin may ship an `export` entry (Node-safe; no page APIs). It declares its Export options (key,
  label, default, whether only debug builds have it) and returns its **manifest slice**, stored under `game.json`'s
  `plugins.<name>`, plus any files to write. Localisation's string files (0451) and audio's media, effects and
  recording options become such steps.
- **Launch step:** a plugin's runtime half registers `ctx.launch.step(phase, load)` with a phase:
  - `beforeEngine`: strings, audio media and effects;
  - `afterEngine`: the debug link;
  - `afterStart`: recording triggers.
  The step reads its own manifest slice. `buildLaunch` and the player run the steps in phase and catalogue order,
  each behind its own `import()`, so a release build carries no step it doesn't use.
- **Debug build:** an Export option of the core. It turns on the debug link and `Recording`, and lets each plugin's
  debug-only options (its lanes, triggers) apply. A release build has no recording code.
- The core's own steps (debug link, recording) use the same shape, registered by the engine instead of a plugin.

**Formats and scope**

- No protobuf. The record framing, the debug link envelope and the netcode encoding stay as they are.
- Perfetto and OTLP export are out of scope. A later exporter can read recordings through the profiler core.

## Alternatives considered

- **Keep recordings audio's and add one take extension per plugin.** This works today for animation, but every
  other plugin's data lives inside audio's file and budget, and the profiler stays audio-only.
- **Adopt Perfetto or Tracy as the profiler.** Perfetto's live capture targets Linux, Android and Chrome internals,
  and Tracy needs a native client with an unstable wire protocol. Neither knows Worlds, plugins or the editor.
  Rejected by the owner in favour of an in-engine profiler that borrows their ideas: tracks, flows, frame marks,
  zone statistics, near-zero cost when not listening.
- **Protobuf for the record format.** Rejected by the owner. Byte-aligned tags cost more than the current framing;
  JS libraries allocate per message; the framing already skips unknown data.
- **Put a lane field in the record head.** Clearer, but it changes every reader and old files, and costs bytes in
  every record. A lane table in META keeps the head and older audio data.
- **One debug link topic per lane.** Each plugin would rewrite subscription, rate and channel handling; one
  `recording` topic carries lanes by name with one implementation.
- **The profiler in the editor, with the Studio embedding the editor.** Breaks the Studio as a standalone tool that
  opens recordings without a project (0408).

## Consequences

**Positive**
- Any plugin's debug data reaches the same file, transport and viewer with one lane contribution and one view
  contribution.
- The editor and the Studio share one profiler. An improvement to the timeline or tables reaches both.
- Build options stop being hard-coded: export, launch and debug steps belong to their features, including
  localisation (0451).
- Budgets per lane, and a lane table any reader can list.

**Negative / costs**
- A large program: moving the framing and control out of audio; the profiler module; the Studio's Take and Profiler
  merge; the editor panel; the export and launch steps; and new contribution points in the runtime context, the
  editor SDK and the exporter.
- `Audio.take` changes to `Recording`. `game.json`'s feature keys move under `plugins.<name>`, so the player and the
  manifest change format together; old exports need re-exporting, which a prebuilt player shipped with the engine
  already implies.
- Plugin `profiler` and `export` entries add two more entry kinds to the plugin layout (0133) and the catalogue
  (0275), and third-party plugins get new surface to learn.
- Records of lanes that get types at record time can't be decoded without META. Every reader already reads META
  first, but tools that scan raw records must change.

## Deprecates

- `take.source` (replaced by `ctx.recording.lane`) and the 0x40–0x7e extension registry (generalised into the lane
  table).
- `Audio.take` (forwards to `Recording` for one release, then removed).
- The audio plugin's ownership of the recording format, triggers and take ownership (moved to the engine).
- The Studio's audio-only Profiler and Take screens (become one Recording view on `src/profiler/`).
- Hard-coded build options in `webBuild.ts`, `format.ts`, `buildLaunch.ts` and `player/main.ts` (replaced by export
  and launch steps).
- Amends, on acceptance: 0348 (takes are recordings with lanes), 0417 (take ownership becomes the engine's recording
  ownership), 0261 (the track kit moves to `src/profiler/`), 0326 (the table kit is built there), 0376 (the
  `recording` topic), 0447 (the deferred slice is built), 0133/0275 (the `profiler` and `export` entries).

## Open questions

- Whether the editor records its own Play sessions. ADR 0416 removed that; with lanes from every plugin, recording
  from the editor may be wanted again. Until decided, the editor views live sessions and opens files only.
- How lanes report cost, so the profiler can show what recording itself spends per lane, and whether a lane may be
  turned off live from the tool.
- Clock domains: the audio worklet, workers, the dedicated server and a phone each have their own clock. Does a lane
  carry its clock domain, with sync points in `core/frames`?
- Flows between lanes and processes (client input → server tick → replication), as Perfetto's flows do: in this
  record, or a later one.
- Whether third-party plugins' `profiler` entries load in the Studio without a project, from a plugins folder.

## References

- `src/plugins/audio/runtime/capture/` (`format.ts`, `reader.ts`, `takeRecorder.ts`, `takeOwnership.ts`,
  `trigger.ts`), `src/engine/audio/take/`, `src/engine/debugLink/` (`topics.ts`, `records.ts`, `session.ts`).
- `src/studio/screens/profiler/`, `src/studio/screens/run/`, `src/plugins/audio/editor/mix/tracks/kit.ts`,
  `src/studio/boot/studioPlugins.ts`.
- `src/editor/playStats.ts`, `src/engine/core/Engine.ts` (`EngineTiming`), `src/plugins/runtimeContext.ts`,
  `src/editor/sdk/plugins.ts` (`CONTRIBUTION_POINTS`).
- `src/export/webBuild.ts`, `src/export/format.ts`, `src/player/buildLaunch.ts`, `src/player/main.ts`.
- ADR 0348 (takes), 0373 and 0378 (animation take records), 0409 (`.sporesample`), 0416 and 0417 (who records),
  0447 (the deferred per-feature slice), 0451 (localisation as a plugin).
