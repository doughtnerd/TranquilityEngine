# 0031. Samples are projects that ship beside the engine, not inside it

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0030

## Context

The Flappy Bird demo lived in `src/demo/flappy/` and was part of the engine's own build in three ways:

- `npm run dev` / `npm run build:game` served and bundled it as the standalone game (`index.html`, `src/index.ts`, `src/demo/flappy/main.ts`), and `src-tauri/tauri.conf.json` shipped that game as the default desktop app.
- The editor imported `src/demo/flappy/game.ts`, so the demo's behaviors, data components and systems were compiled into every editor build, and `bundledDemoProject()` bundled its JSON and images into the editor.
- Unit tests got the demo's types from that same editor import.

ADR 0030 made project scripts load at runtime, so the demo no longer needs to be compiled in. Keeping it there blurs what the engine is: the editor carried game code that no other project could use, and the demo didn't exercise the path real projects take.

## Decision

We will treat Flappy as a **sample**: an ordinary project in `samples/flappy/` that ships with a download of the engine but isn't built into it.

- **Layout.** `samples/<id>/` is a normal project folder: `project.json`, `scenes/`, `prefabs/`, assets, and `scripts/` (ADR 0030) importing `"tranquility"`. The demo's `behaviors/`, `data.ts` and `systems.ts` move under `scripts/`. An optional `sample.json` gives the name to list it by and a one-line `description`.
- **Shipping.** A `samples()` Vite plugin (in `vite.shared.ts`) serves `samples/` at `/samples/` from the dev server, untouched (so `.ts` files arrive as source), with a manifest at `/samples/index.json` listing each sample's name, description and files with sizes. The editor build copies `samples/` and the manifest into `dist/editor/samples/`, so the desktop editor and a hosted editor serve them as static files beside the editor. Nothing in `src/` imports a sample.
- **Opening.** The editor starts on a **start screen**: Open Project… (desktop) and the samples from the manifest. Opening a sample makes a read-only project from the fetched files; its scripts load through the script loader like any project's. In the desktop editor, **Make a Copy…** writes the sample into a folder the user picks and opens that copy for editing. `editor.html?sample=<id>` opens a sample directly (handy for development and the end-to-end tests).
- **No standalone game build.** `index.html`, `src/index.ts`, the demo's `main.ts`, `build:game` and the game's Tauri config go. The sample plays from the editor's Play button until game builds of projects are designed (open question O14). The default Tauri config becomes the editor's.
- **Tests.** Editor unit tests that use the sample import its scripts (`src/editor/sampleTypes.ts`, through the test helpers; Vitest maps `"tranquility"` to the engine), standing in for the editor-build registrations they had before. Engine tests don't see them. The root `tsconfig.json` type-checks `samples/*/scripts` against the engine.

## Alternatives considered

- **Open the sample automatically at start, as before.** The user preferred a start screen, which is also where Open Project and later recent projects belong.
- **Keep a standalone sample game build (`build:sample`).** Rejected for now: without a design for building any project into a game, a Flappy-only build would be a special case to maintain.
- **Ship samples as Tauri resources.** Would work only in the desktop editor and needs the resource API; serving them beside the editor's own files works in the browser too, with one code path.

## Consequences

**Positive**
- The editor bundle contains no game code or game assets; the sample runs through the same script loading, asset and Play paths as any user project.
- Adding a sample is adding a folder.

**Negative / costs**
- Opening the sample compiles its scripts in the browser (the TypeScript compiler chunk loads first), so it's slower than the compiled-in demo was.
- There's no playable standalone build of Flappy until project game builds exist; its end-to-end game test now drives the editor's Play mode.
- Editor tests depend on a helper to register the sample's types.

## Deprecates

- `src/demo/flappy/` (moved to `samples/flappy/`), `src/index.ts`, `index.html`, `src/demo/flappy/main.ts` and `game.ts`, `npm run build:game`, and the game's `src-tauri/tauri.conf.json` (replaced by the editor's config).
- `bundledDemoProject()`, `demoAssets()`, `demoSettings()` and the editor's import of the demo's types (test helpers replace the latter three).

## Open questions

- ~~How a project folder becomes a game build (O14).~~ Answered by [0041](0041-game-builds.md): a static web player build, packaged for desktop through Tauri.
- Recent projects on the start screen.

## References

- ADR 0030 (runtime script loading), ADR 0026 (projects and saving).
