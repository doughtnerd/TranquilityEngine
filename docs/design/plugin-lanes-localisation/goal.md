# Plugin diagnostics and localisation: goal (design step 1)

Confirmed by the owner on 2026-11-28 (answers below). No record number in this folder's name until the record is written (design step 3).
Proposed records drafted earlier: [0451](../../decisions/0451-localisation-becomes-a-first-party-plugin-over-a-small-language-core.md)
(localisation as a plugin) and [0452](../../decisions/0452-recordings-are-made-of-plugin-lanes-and-one-profiler-serves-the-editor-and-the-studio.md)
(recordings of plugin lanes, one profiler, plugin build steps). This design may revise them.

## Goal (owner's words, 2026-11-27, to confirm)

- "I do think localization should exist as a plugin. Some things might need to live in the engine core but most of it
  should be a plugin."
- "I eventually want to redesign plugins to allow them to submit data that should be exported for profiling during a
  debug build."
- "I would like to keep my profiler in engine." Own data model, grow the debug link, borrow from Perfetto and Tracy.
- "Audio Studio's takes are really just a form of plugin debug data and should be treated as separate lanes/views like
  any other debug data."
- "I still want to support Audio Studio being a standalone tool but reusing the profiler views and profiler core
  between engine and audio would be necessary."

## Decided already (owner, 2026-11-27)

- No protobuf: keep the custom binary formats (netcode bit packing, debug link envelope, record framing).
- Perfetto and OTLP export are out of scope for now.
- The Audio Studio stays a standalone app.
- Plugins opening Tauri windows, and the Audio Studio as a plugin: skipped for now.

## Today, read from the code (2026-11-28)

**Plugins**
- 21 first-party plugins in `src/plugins/catalogue.ts` (ADR 0275); every one can be disabled (`project.json`
  `plugins.disabled`, `src/plugins/enabled.ts`); none is required.
- Third-party plugins load from a project's `plugins/<name>/` and `node_modules` (ADR 0133, 0139).
- Runtime contribution points (`src/plugins/runtimeContext.ts`): `registerComponents`, `registerSystems`,
  `registerEngineSystems`, `registerWorldService`, `registerRenderFeature`, `contribute`, `debugLink.topic`,
  `take.source`. Editor points: `CONTRIBUTION_POINTS` (`src/editor/sdk/plugins.ts`, ADR 0284), including
  `registerPlayStatsCounter` and `registerPlayStatsTable`.
- No export, launch or player-boot contribution: `src/export/webBuild.ts`, `src/export/format.ts` (`GameManifest`:
  `audioCapture`, `audioTake`, `audioTakeFrames`, `localisation`, `debug`), `src/player/buildLaunch.ts` and
  `src/player/main.ts` name each feature (ADR 0447 deferred per-feature slices).

**Localisation**
- Engine core: `src/engine/localisation/`, 5,646 lines (3,878 without tests). Public: `Locale`, `LocalText`, `t`,
  `tHtml`, `LocaleLanguage`, `MessageArg(s)` (`src/engine/index.ts:51-53`).
- Editor tools in the shell: `src/editor/ui/localisation/` (about 2,500 lines), the `strings` core asset kind, the
  Languages and Subtitles settings sections.
- Users: the UI core (`:lang()`, direction, fonts), `Assets` (localised folders), audio (`Audio.language`, line
  tables, captions), `myco.subtitles`, the Svelte renderer (`t()` reactivity), the Studio's Dialogue screens, export
  and the player.

**Recordings and the profiler**
- `.sporesample` files (ADR 0409): 96 B header, deflate stream, META JSON, 20 B record heads, INDEX. Type space: audio
  profile 0x01–0x09, audio requests 0x10–0x3f, plugin take extensions 0x40–0x7e (animation uses 0x40–0x44), INDEX 0x7f,
  required ≥0x80. Caps: 256 KB per record, 64 MiB per capture, 256 MiB per take; no per-plugin budget.
- Format and recorder in the audio plugin (`plugins/audio/runtime/capture/`); codecs and assembler in
  `src/engine/audio/take/`; the debug link's own head reader in `src/engine/debugLink/records.ts`.
- Debug link topics: `audio`, `animation` (registered through `ctx.debugLink.topic`).
- The Studio's Profiler (`src/studio/screens/profiler/`, 39 files) is audio-only; the track kit (ADR 0261) sits in
  `plugins/audio/editor/mix/tracks/kit.ts`; ADR 0326's table kit isn't in the tree.
- The editor shows only Play Stats (`src/editor/playStats.ts`): FPS, per-World phases, render counters, node counts,
  heap, plugin counters (`myco.audio.underruns`, `myco.navigation.agents`) and an Animation table, through
  `EngineTiming` (`src/engine/core/Engine.ts:77`).
- The Studio activates audio, physics and physics-rapier only (`studio/boot/studioPlugins.ts`), and opens recordings
  without a project (ADR 0408).

**Platforms** (from accepted records): web, desktop through Tauri (Windows, macOS, Linux), Android exports (ADR 0155).
Debug builds pair with tools over the debug link on every endpoint (ADR 0403).

## Owner's answers (2026-11-28)

1. **Who uses it today:** only the owner and the samples. No compatibility work: no migrations of old `game.json`
   or recordings, no deprecation periods (`Audio.take` can be replaced outright), no third-party plugin API
   stability promises. Samples are re-exported.
2. **What it's for, in order:** (1) cleaner engine architecture: feature knowledge out of the exporter, player and
   core, one way to do each thing, with the engine itself as the main beneficiary of a well-leveraged plugin
   architecture; (2) better profiling and debugging: any plugin's data in recordings and live sessions, one profiler
   in the editor and the Studio; (3) modular, smaller games: features such as localisation can be turned off and then
   ship nothing. **Third-party plugins** (corrected 2026-11-28): a bonus, not a driver. The architecture should be
   available to them, but first-party use decides its shape.
3. **Low end:** an Android phone, for recording overhead and the player's size, measured over the debug link.
   **Phase 1 targets desktop** (corrected 2026-11-28): the phone is measured in a later phase.
4. **Order:** plugin contributions first (the diagnostics contribution point), then localisation.

## Recording cost (owner, 2026-11-28)

- **No per-frame budget.** A user can exclude lanes or data points from a recording to fit a device.
- **Later:** once the engine is stable, take a baseline of what first-party lanes cost, and warn plugin authors and
  their users in the profiler when a lane exceeds it.

## Scope (owner, 2026-11-28)

- **Plugins stay as they are:** a folder in `plugins/` with a manifest declaring the editor and runtime halves. No new
  entry kinds.
- **Diagnostics** is the contribution point through which a plugin's runtime half hands profiling data to the
  profiler (the owner's name; earlier drafts said "recording" and "lanes"). Audio's takes and captures and
  animation's take records become ordinary diagnostics.
- **Diagnostics views** (a plugin's profiler tracks and panels) come from its **editor half**. The standalone Studio
  activates plugins' editor halves in a reduced context where only the points it uses take effect.
- **Localisation becomes a plugin** (ADR 0451).
- **Dropped:** plugin export and launch build steps. Exporting stays as it is; with localisation a plugin, the
  exporter writes string files by calling the plugin's code directly, as first-party code may. ADR 0447's deferred
  per-feature slice stays deferred.

## Spikes for step 2

1. Plugin export entries: can a plugin's export step (first- and third-party) run wherever exporting runs? (Run before the scope change; now out of scope. Kept for its findings on how plugin code is selected and run.)
2. What the player ships: per-feature chunk sizes, and the cost of one lazy import per launch step.
3. Recording cost per lane on the phone: skipped for phase 1 (desktop first).
