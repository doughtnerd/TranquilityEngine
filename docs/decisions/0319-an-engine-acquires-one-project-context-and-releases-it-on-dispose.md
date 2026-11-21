# 0319. An Engine acquires one project context and releases it on dispose

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0050, 0097, 0135, 0175, 0236, 0238, 0254

## Context

Every `Engine.create` changed process globals in `core/projectBoot.ts` (ADR 0238's boot step): `Assets.addSource` for
`EngineOptions.assets`, `Storage.use`, `mixer.configure` with its configure notice, and `Graphics._configure`.
`Engine.dispose` undid none of them. Asset-source ownership was split four ways:

- `launch.ts` added and removed its own source by hand (ADR 0236);
- the public `EngineOptions.assets` path added a source nothing ever removed (a confirmed leak across create/dispose);
- the editor's `useProjectAssets` (`editor/projects.ts`) cleared every source and added the project's;
- the exporter (`export/node.ts`) added and removed by hand.

Storage had no owner at all: after a headless Play stopped, `Storage` still pointed at the play Engine's
`MemoryStorage`, so the editor's saves and settings went to a store nobody would read again. Which project context
was current while the editor's Engine and its play Engine coexist was implicit.

## Decision

We will put the process globals a project registers behind one module, `src/engine/core/projectContext.ts`:
`acquireProjectContext(parts)` applies them all at once and returns a `ProjectContext` whose `release()` (idempotent)
undoes them. `parts` holds any of `assets`, `storage`, `audio` and `graphics`.

- **Engines:** `bootProject` reads what it needs first (the storage backend, the player's saved and detected tier
  from that backend), then acquires one context with the Engine's asset sources, storage, mixer buses and (for
  `quality: "player"`) graphics tiers. A failure before that leaves nothing registered. `Engine.dispose` releases it,
  also when `create` fails (a bootstrap that can't be resolved now disposes the half-made Engine too).
- **Other holders:** `launchGame` acquires a context holding only the game's files (its scripts load before the Engine
  exists) and releases it after disposing the Engine; the editor's open project holds one for its asset source,
  released when another project opens; the exporter holds one around the build.
- **The rule for nested contexts** (editor and play Engines coexist):
  - *Asset sources:* a context removes exactly the sources it added; others stay, whatever order contexts go in.
  - *Storage:* the most recently acquired live context that set a backend is in use. Releasing it puts back the next
    most recent live one's (the editor's, after Play), or the backend in use before the first of them; releasing an
    earlier context changes nothing in use. `Storage.use` returns the backend it replaced for this.
  - *Mixer and graphics:* configured on acquire, kept on release. They are the player's settings for the last project
    configured; nested Engines configure the same project, and putting an older configuration back would revert live
    mix edits made during Play (ADR 0175) and reset script values the editor shows.

Small fixes in the same core: an Engine's Worlds take its resolved settings (`resolveSettings` gives back settings it
made, unchanged); `loadSceneFile` migrates a file once per raw asset value (as `resolvedScene` caches), not on every
load, prefab instance and `GameObject.instantiate`; the warm-up reads `settings.preload` from the resolved view's
raw file instead of reading and migrating the scene again; model loading fetches through `fetchAssetBytes`.

## Alternatives considered

- **Release restores every global to its value before acquire** — simple, but on Play stop it would put back the
  mixer configuration from project open, reverting live mix edits and audio settings saved since.
- **One context threaded through `Engine.create` from `launchGame`** — one object instead of two nested ones, but it
  needs an extra option on the public `EngineOptions`; two nested contexts released in reverse do the same.
- **Keep `Assets.clearSources()` in the editor** — it hides leaks rather than owning sources, and clears sources other
  holders still need.

## Consequences

**Positive**
- One place says what an Engine changes in the process and how it is undone; a disposed Engine leaves no asset
  source and no storage behind, and the editor's storage comes back after Play.
- Tests of create/dispose need no hand cleanup of sources or storage.

**Negative / costs**
- Mixer and graphics stay as the last Engine left them after it is disposed (as before); the record names that.
- Code that called `Storage.use` by hand while contexts live is overridden when the newest context releases.

## Deprecates

The hand-written add/remove pairs in `launch.ts`, `editor/projects.ts` (`Assets.clearSources`) and `export/node.ts`,
removed. `models.ts`'s copy of `fetchAssetBytes`, removed.

## Open questions

None.

## References

`src/engine/core/projectContext.ts`, `src/engine/core/projectBoot.ts`, `src/engine/core/Engine.ts`,
`src/engine/launch.ts`; tests `src/engine/tests/projectContext.test.ts`, `src/engine/tests/launch.test.ts`.
