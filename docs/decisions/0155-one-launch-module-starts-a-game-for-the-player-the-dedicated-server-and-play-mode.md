# 0155. One launch module starts a game for the player, the dedicated server and play mode

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0032, 0033, 0041, 0080, 0133, 0135, 0139, 0144

## Context

Three hosts start a game, and each wrote out the same ordered launch itself:

- **The player** (`src/player/main.ts`, 0041): register the build's files as an asset source, set the scripts'
  asset refs (0080), import the compiled scripts and third-party plugin modules, `activateGamePlugins`,
  `Engine.create({ container, project, loadScript })`, load the manifest's main scene into every start-up World
  whose config names no scenes and that has no nodes, `start()`.
- **Play mode** (`src/editor/playMode.ts`, 0022): register the snapshot overlay, stop the editor,
  `applyEditorPlugins`, `Engine.create({ …, quality: "keep" })`, `setVariantReport`, the same "fill empty
  start-up Worlds" loop with the open scene, `start()` unless headless; on stop dispose and remove the overlay.
- **The dedicated server** (`src/server/run.ts`, 0033 §8): load scripts and plugins, cut the bootstrap to
  server Worlds, register the project's assets, `activateGamePlugins(…, { server: true })`,
  `Engine.create({ headless: true, bootstrap })`; on close dispose and remove the source.

The fill loop was copied verbatim into the player and play mode, and to write it the player imported the
editor-only tier (`src/engine/editor`: `engineWorld`, `engineWorldConfig`, `setScriptAssetRefs`). The copies
drifted: the player never removed its asset source (moot for a page, but a failed launch left the source
registered); the server never filled empty Worlds, with nothing saying whether that was meant; only the server
rolled back on a failure between registering its source and creating the Engine. `player.test.ts` checked
the player's launch order by regex over `main.ts`'s source text, because there was no interface to test.

## Decision

**One module, `src/engine/launch.ts`.** `launchGame(options): Promise<LaunchedGame>` runs, in this order:

1. `Assets.addSource(options.assets)`.
2. `scriptAssetRefs`, if given, become the refs warmed up with every scene (0080).
3. `await options.loadScripts?.()`: the host's scripts and plugin modules register their types.
4. `options.activatePlugins()`: the host makes its plugin set active (0144). A throw stops the launch.
5. `Engine.create({ project, bootstrap, loadScript, container, headless, quality })`.
6. With `reportShaderVariants`, shader variants compiled mid-game are logged (0080; play mode).
7. **The entry scene rule:** when `entryScene` is a path, every start-up World whose config has no `scenes` key
   and that holds no nodes after the bootstrap loads it. `scenes: []` starts empty, as before.

`LaunchedGame` is `{ engine, dispose() }`. `dispose()` undoes the launch in reverse: disposes the Engine (which
stops it) and removes the asset source; it is idempotent. A failure at any step undoes the steps already done
(the Engine is disposed if it was made, the source removed) and rethrows the error unchanged.

**The engine stays free of plugins (0135).** `activatePlugins` is a function the host passes, so the module never
imports `src/plugins`: the player and the server pass `() => activateGamePlugins(thirdParty, { disabled[, server] })`;
play mode passes `() => applyEditorPlugins(disabled)`, which keeps the editor halves active.

**What the launch does not own.**

- **The loop.** `launchGame` doesn't call `start()`: the player starts it, play mode starts it after attaching its
  game view (or leaves a headless test to step), the server steps it on its own timer.
- **Plugin deactivation.** The active plugin set outlives one game: the editor's Editor World keeps using it after
  Stop, and the player and server exit with the process. `dispose()` leaves it alone.
- **Error presentation.** Each host formats for its surface: the player's page message, the editor's status bar,
  the server's `ServerError` (with its bootstrap problem list). The launch rethrows the original error so they can.
- **The server's bootstrap filtering** (`serverBootstrap`, `codeBootstrap`) stays in `run.ts`, on top: it needs the
  scripts loaded, so the server loads its code before launching and passes the filtered bootstrap.

**`entryScene` is required, `string | null`,** so every host states it:

- the player passes the manifest's `mainScene` (null in a build without scenes);
- play mode passes the open scene;
- **the server passes `null`: it does not fill empty Worlds.** A dedicated server runs a project folder, not a
  build, so it has no chosen main scene (`--scene` is an export option, 0041), and guessing one with the editor's
  rule would load a client's menu scene into a lobby or match World that its code fills at runtime (0068). Its
  server Worlds list their scenes in the bootstrap, as its "no bootstrap" message already tells authors. This was
  the server's behaviour; it is now a stated choice.

**Fixed drift.** The player removes its asset source on dispose and on a failed launch; play mode, the player
and the server all roll back the same way on a failed launch. The player no longer imports `src/engine/editor`.

## Alternatives considered

- **Put the launch in `src/plugins/` and have it call `activateGamePlugins` itself** — saves the player and server
  one line each, but play mode activates the editor's plugin set, not the game one, so the plugin step varies by
  host anyway; and `src/engine` importing plugins is forbidden (0135, `plugins.test.ts`).
- **Have the launch start the loop** — two of three hosts don't start it (the server, headless play), and play
  mode must attach its game view first.
- **Wrap every failure in one `LaunchError`** — the server's messages are part of its command-line interface
  (tests read them), and the player and editor present differently; one wrapper would be unwrapped in each.
- **Have the server fill empty Worlds with `scenes/main.scene.json`** — see above; it would change what running
  servers load.

## Consequences

**Positive**
- The launch order and the entry scene rule live in one place, tested headless with in-memory ports
  (`src/engine/tests/launch.test.ts`) instead of a regex over `main.ts`.
- The player stops reaching into the editor-only tier.
- Every host rolls back a failed launch the same way.

**Negative / costs**
- The plugin step is a callback, so "which plugins" is still decided in each host (by design: play mode differs).
- The server loads its scripts before its asset source is registered, as before, so its scripts' asset refs are
  computed without the project's assets (harmless headless: there is no renderer to warm up).

## Deprecates

The player's and play mode's copies of the fill loop and their direct `Engine.create` calls; the server's own
add/remove of its asset source around `Engine.create`; `player.test.ts`'s source-text check (the
`activateGamePlugins` failure test moves to `src/plugins/runtime.test.ts`).

## Open questions

- Should a game built on the engine library (no host) get a public `launchGame`? Not now: it isn't in
  `src/engine/index.ts`, so it isn't public API.

## References

- `src/engine/launch.ts`, `src/engine/tests/launch.test.ts`
- `src/player/main.ts`, `src/editor/playMode.ts`, `src/server/run.ts`
- `src/plugins/runtime.ts` (`activateGamePlugins`), `src/plugins/editorPlugins.ts` (`applyEditorPlugins`)
