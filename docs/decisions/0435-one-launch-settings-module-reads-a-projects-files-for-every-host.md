# 0435. One launch settings module reads a project's files for every host, and the player decides its launch without a page

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0041, 0135, 0144, 0172, 0236, 0254, 0344, 0348, 0376, 0403

## Context

`launchGame` (0236) runs the launch every host shares, but what a host passes it as `project` was still worked out
in each host:

- **The player** (`src/player/main.ts`) and **the dedicated server** (`src/server/project.ts`) each called
  `projectWithAudio(project.json, audio.json)` (0344), checked `legacyAudio` and threw `LEGACY_AUDIO_MESSAGE` in their
  own error type, and decided separately what to do with audio.json's problems and warnings. Only the server refused a
  `project.json` that isn't an object; the player read it as empty settings.
- **The player's launch decisions lived inline in the page script.** About 60 lines turned `game.json`'s `debug`
  section, the page's query, the desktop shell's flags and the user agent into "dial out?", "listen?" and "which
  platform?" (0376, 0403); the audio capture and take options (0172, 0348) were read field by field. None of it could
  be tested without a page: the only coverage was the @slow export e2e (0236's implementation status says so).
- **Needless casts.** The player read `(manifest as { localisation?: unknown }).localisation`,
  `(manifest.debug as { listen?: boolean }).listen` and `manifest.debug as Partial<…>` although `GameManifest` types
  `localisation` and `debug` (with `listen` and an optional `link`).
- **Each Export option is written in three places**: `BuildOptions` and the manifest it writes
  (`src/export/webBuild.ts`), the manifest type (`src/export/format.ts`), and the player's boot step.

## Decision

**We will read the launch settings once, in `src/engine/launchSettings.ts`.**
`launchSettings(files: { get(path) }): LaunchSettings` takes a project's files as asset values (0254) and returns
either `{ project, notices }` or `{ refusal }`:

- `project` is `project.json`'s values with `audio` set to `audio.json`'s runtime view (0344, through
  `projectWithAudio`); without `project.json`, empty settings.
- `refusal` is a sentence about `project.json` when it isn't an object, or still has the old `audio` section
  (`LEGACY_AUDIO_MESSAGE`). It is returned, not thrown, because hosts word failures for their surface (0236 keeps error
  presentation in the host): the player throws it for its page message, the server wraps it in a `ServerError`
  prefixed with the file's path.
- `notices` are audio.json's parse problems and what the runtime can't play of its mix, each prefixed
  `audio.json: `. The player logs them; the server, which plays no sound, ignores them (as before).

Both hosts that run a project's files as they are use it: the player and the dedicated server. The server's refusals
now come from it, so the two hosts refuse the same projects.

**We will give the player a page-free launch reader, `src/player/buildLaunch.ts`.**

- `checkManifest(raw)`: `game.json`'s format check (the same message as before).
- `buildLaunch(manifest, files, env): BuildLaunch`: stops on files whose JSON doesn't parse and on the launch settings'
  refusal (same messages), and returns `{ project, notices, debug, audioCapture, audioTake }`. `env`
  (`PlayerEnvironment`) is what the page knows of where it runs: the query string, the shell's flags, whether it is a
  Tauri app, the user agent. `debug` (`DebugLaunch`, null without `game.json` `debug`) holds the section, the launch
  override and code, the platform (`web`, `desktop`, `android`), and `dial` / `listen`, with 0403's rule that a
  listen-only build doesn't dial the default address unless given an address or a code. `audioTake` is
  `{ frames }` or null.
- `main.ts` keeps the I/O and the dynamic imports those decisions call for, so a build without an option still holds
  none of its code (the lazy-only check, 0230), and reads the rest of the typed manifest (scripts, plugins, audio
  media, string files, audio effects) directly, without casts.

## Alternatives considered

- **Each feature owns its build-option slice** (what its Export option writes into `game.json` and its player boot
  step, registered once per feature). Considered and deferred. The slices span three layers that the plugin model
  (0135, 0144) keeps apart: the exporter half runs in Node or the editor (`src/export`), the player half runs in the
  page and must stay behind `import()` so release builds carry none of it, and the owners are mixed (the debug link
  and localisation are engine modules, capture and takes the audio plugin's runtime). The boot steps also run at
  different points of the launch: audio media, string files and audio effects before `Engine.create`, the debug link
  after it, the capture triggers after `start()`. A registry for this would be a new contribution kind with launch
  phases on the runtime context and an exporter-side counterpart, which is a change to 0135/0144's plugin model, not
  part of this refactor. The page-free `buildLaunch` is where such slices would plug in on the player side.
- **Use `launchSettings` in editor play mode too.** The editor composes its settings when a project opens
  (`settingsWithAudio` in `editor/audioProjectFile.ts`), migrating an old `audio` section there rather than refusing
  it, and a read-only project keeps its old section; play mode then passes those settings. Refusing at Play would be
  wrong for it, so play mode stays as it is.
- **Throw a `LaunchRefusal` error from `launchSettings`.** Each host would catch and rewrap it (the server prefixes its
  path); returning the refusal is simpler.
- **Have the exporter use `launchSettings`.** The exporter isn't a launch host: it checks only for the legacy section
  (on `project.json`'s text) and copies `audio.json` as a file; it keeps `hasLegacyAudio`.

## Consequences

**Positive**
- The legacy refusal, the `project.json` shape check and audio.json's notices are written once for the player and the
  server, tested headless (`src/engine/tests/launchSettings.test.ts`).
- The player's launch decisions are tested without a page (`src/player/buildLaunch.test.ts`): manifest format, JSON
  problems, refusal, debug dial/listen/platform with query and shell flags, the audio triggers.
- `main.ts` lost its casts and its inline debug decision logic.

**Negative / costs**
- A new Export option still touches `webBuild.ts`, `format.ts`, and now `buildLaunch.ts` plus `main.ts`'s step (the
  per-feature slice is deferred).
- Behaviour change: the player now refuses a build whose `project.json` isn't an object (it ran with empty settings),
  as the server already did. The server's message for that case reads `<path>: project.json must hold an object of
  project settings.` (was `<path> must hold …`).

## Deprecates

The player's and the server's own `projectWithAudio` + `LEGACY_AUDIO_MESSAGE` handling (removed; both call
`launchSettings`); the player's inline debug-link decisions and manifest casts (moved to `buildLaunch`).
`projectWithAudio` stays for the editor and tests.

## Open questions

- The per-feature build-option slice (see Alternatives): revisit when a plugin needs an Export option of its own.

## As built (2026-11-27)

- `src/engine/launchSettings.ts` (`launchSettings`, `LaunchSettings`); `src/player/buildLaunch.ts` (`checkManifest`,
  `buildLaunch`, `BuildLaunch`, `DebugLaunch`, `PlayerEnvironment`); `src/player/main.ts` and `src/server/project.ts`
  call them.
- Tests: `src/engine/tests/launchSettings.test.ts`, `src/player/buildLaunch.test.ts`; `src/server/audioProject.test.ts`
  unchanged and passing.
- Editor play mode and the exporter are unchanged (see Alternatives).

## References

- `src/engine/launch.ts` (0236), `src/engine/audio/project/load.ts` (0344), `src/engine/debugLink/host.ts` (0376, 0403)
