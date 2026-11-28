# 0452. Plugins contribute diagnostics through one contribution point, every recording is a capture of them, and the profiler is a self-contained module

- **Status:** Proposed (revision 2, after the RFC round)
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0133, 0135, 0139, 0144, 0171, 0172, 0224, 0261, 0275, 0341, 0348, 0373, 0376, 0403, 0408, 0409, 0411, 0412, 0416, 0417, 0451

Design folder: [`docs/design/plugin-lanes-localisation/`](../design/plugin-lanes-localisation/goal.md). RFC round:
[`docs/rfc/0451-0452/`](../rfc/0451-0452/) and the owner's open choices in
[`owner-list.md`](../rfc/0451-0452/owner-list.md). Spikes:
[`spikes/studio-editor-halves/`](../../spikes/studio-editor-halves/README.md),
[`spikes/player-chunks/`](../../spikes/player-chunks/README.md).

## Glossary

- **Diagnostics:** time-stream data a plugin, or the engine core, wants profiled: what happened when, how long
  something took, a number over time, a periodic picture of state. Audio's sounds starting and its DSP load are
  diagnostics; so are the engine's frame times.
- **Diagnostics source:** one contributor's named family of records, such as `myco.audio/profile` or `core/frames`,
  registered through the **diagnostics contribution point** (`ctx.diagnostics.source`). Earlier drafts said "lane".
- **Clock:** what a source's record times count in. There are two independent clocks today: the **engine clock** (the
  engine's frame counter plus real, monotonic time; every World, and animation, ticks inside it) and the **audio
  clock** (audio frames counted by the audio plugin's Rust core, `native/audio/`, read through its `AudioClock`
  capability). A World's scaled time, an animator's time or a tile map's animation time are derived from the engine
  clock, not clocks of their own; a source that needs one writes it as a field.
- **Clock sync record:** a record a source with its own clock writes, pairing a time on its clock with the engine
  frame it was read in, so the profiler can line its records up with everything else.
- **Retention:** what happens when a source's data outgrows its budget. A **ring** source drops its oldest data
  (telemetry); a **log** source never drops and stops the capture with a message at the cap (what re-execution needs).
- **Consumer:** something that needs diagnostics now: a tool subscribed over the debug link, the editor's Play Stats
  overlay, or a capture started by the record key. Sources run only while a consumer exists.
- **Capture:** diagnostics saved to a file (`.sporesample`, 0409). Today's takes and captures become one thing; the
  word "take" is retired.
- **Epoch:** one continuous run of a capture or live session with one set of sources and record types. A script
  reload (0144) or a source arriving late starts a new epoch.
- **Debug link:** the engine's connection between a running game and a tool (0376, 0403).
- **Profiler:** the tool-side module that shows diagnostics live or from a capture.
- **Playback:** moving a time cursor through diagnostics (play, pause, scrub) so every view shows that moment.
- **Re-execution:** feeding recorded diagnostics back into a running engine so they happen again, such as audio
  playing a capture's sounds through the current project.
- **Deep link:** an event that names an asset, so clicking it opens that asset's editor.
- **Diagnostics views:** the profiler tracks and panels a plugin contributes for its own sources.

## Context

**Audio's recordings are the only diagnostics pipeline, and they're audio's.**

- **Files:** `.sporesample` (0409): a 96-byte header with a TAKE flag, then a deflate stream holding META JSON,
  records and an INDEX. Each record has a 20-byte head (`u8 type`, `u8 flags`, `u16 epoch`, `u32 len`, `u32 seq`,
  `f64 frame`); types below 0x80 are skipped by a reader that doesn't know them.
- **Type space:** audio profile 0x01–0x09, audio requests 0x10–0x3f, plugin take extensions 0x40–0x7e (animation uses
  0x40–0x44), INDEX 0x7f.
- **Two clocks:** the audio clock lives in the audio plugin (`native/audio/`, `plugins/audio/runtime/core/clock.ts`,
  the `AudioClock` capability in `backend.ts:595`); nothing in `src/engine/` reads it. Animation has no clock of its
  own: it advances on the World's scaled or fixed step (`plugins/animation/runtime/stages/frame.ts:14`). In a file, a
  record's `frame` is audio's: a STATUS record's frame must equal the audio core's
  `currentFrame` (`capture/format.ts:771-780`). On the debug link it is the build's frame counter
  (`debugLink/records.ts:10`). Nothing without audio has a timebase in a file.
- **Push, not pull:** audio writes from its STATUS tap on the audio clock into a bounded ring (16–32 MiB), keeps take
  requests as a lossless log beside it, and adds pictures asynchronously. Take extensions already push:
  `take.source` registers a lazy loader (`engine/audio/take/extensions.ts:57-70`) whose `start(host)` gets a host to
  write through; animation uses it.
- **Code:** framing, recorder, triggers and take ownership in `plugins/audio/runtime/capture/`; codecs and assembler
  in `src/engine/audio/take/`; the link's head reader in `src/engine/debugLink/records.ts`; the audio link client in
  `plugins/audio/editor/debugLink/audioLinkClient.ts`; the Studio's profiler model in `plugins/audio/editor/mix/`
  (`profilerSource.ts`, `liveFollow.ts`, `cursorModel.ts`, the track kit `tracks/kit.ts`) and
  `src/studio/screens/profiler/` (39 files).
- **Takes versus captures:** F9 records a capture (64 MiB cap, profile only); F10 a take (256 MiB cap, requests never
  dropped, optional pictures; 0348), each enabled by an Export option. While a tool holds a take subscription, the
  build's key stops the take without saving it for the player (0417).
- **Live:** the Profiler follows a connected build's capture from connect (0411). The Take screen shows a take only
  while one records (0411 item 1; 0411 rejected streaming the take live, for link traffic).

**Other profiled data uses separate routes.** Play Stats (`src/editor/playStats.ts`) reads frame and phase times,
render counters, node counts and heap through `EngineTiming`, and plugin counters and tables through
`registerPlayStatsCounter` and `registerPlayStatsTable` (`myco.audio.underruns`, frozen navigation's
`myco.navigation.agents`, animation's table). Animation also serves an `animation` topic and replays takes in its
editor debugger.

**Plugin layout:** third-party `plugin.json` declares `runtime` and `editor` entries (`src/plugins/thirdParty.ts`);
first-party halves come from tables keyed by the catalogue, not manifest keys (0275). Disabled plugins activate
against a stub context whose points do nothing (`src/plugins/runtimeContext.ts:135-145`).

**Spike:** every first-party editor half activates in a Studio-like context with no editor shell, but whole halves
would list every plugin's asset kinds in the Studio and start Svelte loads
([`spikes/studio-editor-halves/`](../../spikes/studio-editor-halves/README.md)).

**Owner's direction (2026-11-27/28):** one common diagnostics API; audio's takes are audio's diagnostics and the
Studio a view on them; replay is part of diagnostics; collect only while a tool is connected or after the record key;
nothing saved until Record; phase 1 adds no new data; the profiler is self-contained and starts in the Studio; no
protobuf; Perfetto and OTLP out of scope; no outside users, so no migrations.

## Decision

We will turn `take.source` into one **diagnostics** contribution point, move audio's recording pipeline onto it so
every recording is a **capture**, and separate the **profiler** into a self-contained module.

**Diagnostics sources**

- `ctx.diagnostics.source(name, load)` replaces `take.source`. The registry holds loaders only, like debug link
  topics (`topics.ts`); nothing loads until a consumer exists. The disabled-plugin stub context gets a no-op.
- A source, once loaded, declares its name (`<plugin>/<source>`), version, how many record types it needs, its
  **clock** (engine frames or audio frames), its **retention** (`ring` or `log`) and its link channel (reliable or
  unreliable). Its `start(host)` receives a host to **push** records through (`host.write(type, payload, time)`), as
  take sources do today, from any thread or callback, and returns a run with optional `keyframe`, `stop` and
  `request` handlers.
- Optional per source: **deep links** (which record fields name an asset path), **re-execution** (how to feed records
  back into a running engine), and keyframes for seeking.
- A source that throws is stopped for the rest of the epoch, with one message.
- **Clocks:** a source declares `engine` (the default) or its own clock. A source with its own clock writes **clock
  sync records**; the engine never reads a plugin's clock (no engine file imports a plugin). Audio declares the audio
  clock and writes a sync record each engine frame from the frame map it already keeps (`plugins/audio/runtime/core/
  clock.ts`, 0224). Records are stamped with real time, not a World's scaled time, so pauses and slow motion don't
  distort a profile.
- The core registers `core/frames` on the engine clock: Play Stats' data (frame and step times, per-World phase
  times, render counters, node counts, heap). It knows nothing about audio.

**Captures**

- The framing (header, META, records, INDEX, deflate) moves from the audio plugin to `src/engine/diagnostics/`.
- META gains a **source table**: each source's name, version, clock, retention and the record types it was given.
  The table is fixed per epoch; a script reload or a late source starts a new epoch. Audio keeps its current type
  numbers; other sources get types from the free range. A reader finds a record's source through the table and skips
  unknown ones by length; running out of types refuses the late source with a message.
- The TAKE flag, F10 and the take/capture distinction go. No old file is migrated.
- **Caps:** one capture cap; `ring` sources evict their oldest data, `log` sources stop the capture at the cap.
  Whether the cap is 64 or 256 MiB, and whether audio's requests and pictures are always on, is the owner's call
  (owner list).

**When diagnostics are collected**

- **Only while a consumer exists:** a tool subscribed over the debug link, the editor's Play Stats overlay while it
  shows, or a capture started by the record key. Release builds collect nothing.
- **Look-back window:** kept in the build's existing bounded ring (zero allocation per frame), not in the tool. A
  connected tool mirrors it. **Record** marks a span (start and end) that survives a disconnect, and saves it where
  the tool keeps recordings (0408). Nothing is saved until Record.
- **Record key:** F9 or the one-second three-finger hold starts and stops a capture in any debug build, saved to the
  build's disk with today's backup rotation (0417). While a tool holds the build's capture, the key stops it without
  saving it for the player, as 0417 says for takes today. The `audioCapture`/`audioTake`/`audioTakeFrames` Export
  options become one `capture` option.
- **The Take screen is live from connect,** like the Profiler (amends 0411 item 1; the owner reverses 0411's rejected
  alternative). Pictures stream only while a view that shows them is open, to bound link traffic.

**Transport**

- The debug link stays the transport. One engine topic, `diagnostics`, streams every subscribed source's records in
  today's framing, each on its source's channel. The `audio` and `animation` topics keep their commands and requests
  and lose their recording parts.

**Replay**

- **Playback** is generic: the profiler moves a time cursor through any capture or look-back window and every view
  follows it.
- **Re-execution** is a source's optional hook. Audio's replay through the current project (0348) and animation's
  take replay port onto it. Whether re-execution works on the live window is the owner's call (owner list).

**The profiler**

- A self-contained module, which the Studio and any later host use only through its interface. It takes the capture
  model and reader, the capture worker, playback, live follow, the look-back mirror and the track kit, moved from
  `plugins/audio/editor/mix/` (`profilerSource.ts`, `liveFollow.ts`, `cursorModel.ts`, `tracks/kit.ts`) and
  `src/studio/screens/profiler/`. The audio link client's recording parts move to the `diagnostics` topic's client.
- Where its plugin-facing contract lives, in the Studio's folder or a neutral `src/profiler/` that plugins and a
  later editor host can import without importing the Studio app, is the owner's call (owner list).
- **Profiler host interface:** open and save files, status messages, the theme, and **open an asset** for deep links.
  The Studio opens what it edits itself and hands other assets to the editor if it runs, through the existing app
  hand-off (0341, 0380).
- The Take and Profiler screens are both views on it; merging them is later.

**Diagnostics views**

- A plugin's views come from a module in its editor half. Third-party plugins name it with an optional
  `diagnostics` key in `plugin.json`; first-party plugins with an entry in a catalogue table beside the runtime and
  editor halves' tables (0275). No entry means no profiler views. The profiler imports only those modules.
- **Phase 1 views:** audio's existing profiler and take views, and core views of `core/frames`. Animation keeps its
  debugger panel in the editor, reading diagnostics.

**Play Stats**

- The overlay reads `core/frames` and plugins' sources. `registerPlayStatsCounter` and `registerPlayStatsTable` stay
  as thin shims that register a diagnostics source, so frozen navigation keeps working unchanged; first-party users
  other than navigation move to sources.

**Not in phase 1:** new diagnostics data; profiling editor Play; animation views in the profiler; choosing sources,
per-source budgets and cost baselines; a profiler app of its own.

## Alternatives considered

- **Keep audio's pipeline and add take extensions per plugin.** Every other plugin's data rides inside audio's files
  and caps.
- **A pull-only source (`sample(writer, frame)`)** (revision 1). Doesn't fit audio's ring on the audio clock, its
  lossless request log or async pictures (RFC: architect, senior engineer).
- **Keep takes and captures as two formats on one registry** (challenger, about 10–15 table-days cheaper). The owner
  asked for one concept.
- **Collect always, in a rolling buffer.** The owner prefers collection only while something consumes it.
- **The look-back window in the tool.** Loses data across a reconnect and duplicates the build's ring.
- **The Studio activates whole editor halves.** Lists every asset kind and starts Svelte loads; a named views module is
  lighter.
- **A source field in every record head.** Changes every reader and costs bytes per record.
- **Perfetto or Tracy, protobuf.** Rejected by the owner.

## Consequences

**Positive**
- One API for audio, the core, animation, Play Stats' counters and future plugins, evolved from a registry that
  already works.
- Every capture has a timebase, with or without audio, and a future plugin with its own clock (a physics step, a network tick) lines up the same way.
- Takes and captures collapse into one concept, one key and one Export option.
- Deep links and re-execution become available to every plugin.

**Negative / costs**
- Moving framing, recorder, triggers, ownership and the profiler model out of audio touches every reader and both
  Studio screens.
- A live Take screen adds link traffic (requests always; pictures while shown).
- The Play Stats points stay as shims while navigation is frozen.
- **Provisional estimate:** 95–130 table-days with a third in reserve (revision 1 said 85–115; the push contract,
  clocks and live streaming add risk). Table-days are the relative unit of earlier plans; the M4 milestone's 290 ran
  in about two days of agent time (`docs/plans/2026-11-audio-mix-m5-waves.md`). Calibrated against estimates, not
  actuals; the technical design's task table replaces it.

## Deprecates

- `take.source` and the 0x40–0x7e extension registry (replaced by `ctx.diagnostics.source` and META's source table).
- The take concept: the TAKE flag, `Audio.take`, `Audio.capture`, F10, the take Export options (replaced by captures,
  engine capture control, F9 and one `capture` option).
- The audio plugin's ownership of the capture format, recorder, triggers, take ownership and the profiler model.
- Amends, on acceptance: 0348 (takes are captures), 0411 item 1 (the Take screen is live), 0416 (the editor records
  nothing; its `Audio.take`/`Audio.capture` wording changes), 0417 (take ownership becomes capture ownership), 0261
  (the track kit moves), 0373 and 0378 (animation's records become a source), 0172 (one key).

## RFC round (2026-11-28)

Reviews: [`docs/rfc/0451-0452/`](../rfc/0451-0452/). Each code claim was checked; the user review was sent back once
to finish its required reading.

| Point | Reviewer | Outcome |
|---|---|---|
| Captures have no timebase without audio: a file's `frame` is audio's (`format.ts:771-780`), the link's is the build's (`records.ts:10`) | architect | **Taken:** a clock per source (`engine` or its own); plugins with their own clock write sync records; `core/frames` stays on the engine clock (owner review, 2026-11-28: the audio clock is the plugin's, so the core can't map it). |
| `sample(writer, frame)` doesn't fit audio's ring, request log or async pictures; `TakeSource.start(host)` already pushes | architect, senior, challenger | **Taken:** push contract evolved from `take.source`, with retention and channel per source. |
| Look-back window should live in the build's ring; Record marks a span that survives a disconnect | architect | **Taken.** |
| Collection should follow consumers (incl. Play Stats in-process), not only "a tool is connected" | architect, challenger | **Taken.** |
| Fix the type table per epoch; handle reloads, late sources, running out of types | architect | **Taken.** |
| A throwing source should stop for the epoch (`session.ts:153-159` logs every frame) | architect | **Taken.** |
| More audio modules move than listed (`profilerSource`, `liveFollow`, `cursorModel`, the link client, the worker) | architect | **Taken.** |
| The profiler's contract should live in a neutral folder, not `src/studio/` | architect | **Owner's call** (owner list): the owner said it lives in the Studio for now. |
| Play Stats points can't go while frozen navigation uses one | senior, architect, challenger | **Taken:** kept as shims. |
| First-party manifests have no `runtime`/`editor` keys | senior | **Taken:** a catalogue table for first-party, `plugin.json` key for third-party. |
| Live Take screen reverses 0411's alternative and adds traffic | senior, user | **Taken as a cost:** the owner's decision stands; pictures stream only while shown. |
| Which cap applies, whether requests and pictures are always on, whether the key loads the take code in every debug build | senior, user | **Owner's call** (owner list). |
| Disabled-plugin stub needs `diagnostics` | mid-level | **Taken.** |
| How a source reaches a tool was unstated | mid-level | **Taken:** one `diagnostics` topic. |
| F9 while a tool owns the capture | user | **Taken:** cites 0417's rule. |
| Look-back length, "save the last N seconds", replay on a live window | user | **Owner's call** (owner list). |
| Play Stats equivalence test at phase 1's end | user | **Taken** into the technical design's tests. |
| Defer META's source table and the manifest key | challenger | **Not taken:** generic sources need the table; the owner chose the key. |
| Estimate low | senior | **Taken:** 95–130. |

## Open questions

- The `diagnostics` topic's subscription shape and the look-back mirror's protocol (technical design).
- Whether `core/frames` should carry per-plugin system times (new data, so not phase 1).

## References

- `src/plugins/audio/runtime/capture/`, `src/engine/audio/take/` (`extensions.ts`), `src/engine/debugLink/`
  (`topics.ts`, `records.ts`, `session.ts`), `src/plugins/runtimeContext.ts`, `src/plugins/thirdParty.ts`.
- `src/plugins/audio/editor/mix/`, `src/plugins/audio/editor/debugLink/audioLinkClient.ts`,
  `src/studio/screens/profiler/`, `src/studio/screens/take/`, `src/studio/boot/studioPlugins.ts`.
- `src/editor/playStats.ts`, `src/plugins/animation/runtime/features/debug/`.
