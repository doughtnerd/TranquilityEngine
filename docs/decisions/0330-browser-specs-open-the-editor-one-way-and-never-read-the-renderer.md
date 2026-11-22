# 0330. Browser specs open the editor one way, and never read the renderer

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0023, 0026, 0128, 0129, 0031

## Context

The browser specs (`tests/e2e/`, 0023) all start by opening the editor and waiting for its edit World to boot. That
wait was hand-written about 75 times in 55 files as `waitForFunction(() => (window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10)`
(in three spellings, some `> 5`, one with its own timeout), and 53 files declared their own `Hooks` type for the
editor's debug hooks on `window` (`session.ts`, `main.tsx`, `playSession.ts`), each a different partial copy, some
as global `Window` augmentations. `fixtures.ts` had `afterFrames` and `openTestProject` but nothing that opened a
sample. The audio helpers booted Play three nearly identical ways (`audioMix.ts` `bootMix`, `audioMusic.ts`
`bootSample` with its own Babylon-backend route, `audioMixLive.ts` `playLiveMix`); `openLiveMix` and `openLabCopy`
re-implemented `openTestProject` because its files were typed text only (`fixtures.ts`, `session.ts`), though
`MemoryFileSystem.files` holds bytes and the specs passed clips through it anyway. `Audio.debug()` was read by
`mixDebug`, `audioDebug` and three spec-local copies; the Sound Lab URL was defined seven times.

Separately, 18 lines in 10 specs read the `@internal` `World.render` by property name in `page.evaluate`
(its `diagnostics()` and `editorViewport()`; one spec monkey-patched `render()` to copy the canvas), against
CLAUDE.md's rule that browser specs use the public `myco` API, the editor UI, saved files and captures, and that a
check those can't express belongs in a unit test of the owning module.

## Decision

**One way to open the editor** (`tests/e2e/fixtures.ts`):

- `openEditor(page, { sample } | { files }, options)` opens a read-only sample (`?sample=<id>`) or the writable test
  project (the Flappy sample in memory with `files` written over it: project path → text or `Uint8Array`), and waits
  for boot once. Options: `viewport` (set before the editor loads), `audioBackend` (the sample's `project.json`
  answered with another audio backend), `frames` (default 10) and `timeout` for the boot wait. `LAB` names the Sound Lab.
- `waitForEditor(page, { frames, timeout })` is the boot condition alone, for a reload or a project opened from the
  start screen. Specs that waited for `> 5` frames or longer keep that through the options.
- `playWithAudio(page, { backend, startTimeout })` presses Play, clicks the game view to unlock audio and waits for
  `Audio.debug()` to report it running on that backend; `readAudioDebug<T>(page)` is the one read of `Audio.debug()`.
  `bootMix`, `bootSample`, `playLiveMix`, `openTestProject` (the fixture) and the local Sound Lab URLs are deleted;
  `openLiveMix`, `openLabCopy` and `openSpatial` build their files and call `openEditor`.
- `Hooks` (with `HookEngine`, `HookWorld`, `HookNode`, `HookHandle`, `HookRect`, `ProjectFiles`) is the one type of
  the editor's window hooks; specs import it and declare none. It is structural: importing the engine's own types
  into the Node tsconfig drags the whole engine (and its DOM and Vite types) into the test compile.
- The editor's `openTestProject` hook takes `Record<string, string | Uint8Array>` (`session.ts`, `main.tsx`), what it
  always stored.

**No spec reads the renderer.** Each check moves to what a user sees, or to a unit test of the render module:

- Through the UI or a capture: the scene view's render scale from the canvas's drawing-buffer size (graphics);
  the particle preview's count and time from its overlay (particles); a minimap camera drawing over the game view's
  corner, added through the public node API (cameras); the camera preview inset (cameras); the fog regression from a
  screenshot of the scene view (postprocessing); the HDR sky and skybox from captures (lighting); the rim shader
  changing the ball (shaderassets); the Move gizmo drawing, against the Select tool (editor); which meshes draw via
  the `nodeRect` hook (three-d); the campfire playing through its components' public `particleCount` (particles).
- In unit tests: the surface reports the tier as applied, shadows at once and render scale from its next frame
  (`renderFeatureHooks.test.ts`, new); each canvas camera with post-processing gets its own composer
  (`framePlan.test.ts`, new); a saved sub-graph rebuilds the materials using it (`materialLibrary.test.ts`, new).
  Already covered and now relied on: probes and the tier (`babylonProbes.test.ts`), cascades, shadow maps and the
  environment (`babylonLighting.test.ts`), tier effects (`postEffects.test.ts`), light icons
  (`babylonEditorDrawing.test.ts`), gizmo hits and presses (`babylonEditorGizmo.test.ts`, `viewportSelection.test.ts`),
  sky bakes (`sky.test.ts`), unselected particle systems (`babylonParticles.test.ts`).
- The window debug hooks themselves (`session.ts`, `main.tsx`, `playSession.ts`) stay; specs use them only to find
  things (`engine.world.time`, `playEngine.world.root`, `orbit`, `overlayHandles`, `nodeRect`, `testFolder`).

## Alternatives considered

- **A Playwright fixture (`test.extend`) that opens the editor before each test.** Specs open different projects,
  some after installing fake folders or routes, some twice; a plain function keeps the order visible.
- **Type `Hooks` with the engine's real `Engine`.** Pulls `src/engine` into `tsconfig.node.json` (decorator metadata,
  `import.meta.env`, `FontFaceSet`): many unrelated errors, and the Node compile would follow every engine change.
- **Keep the render reads behind a public "diagnostics" API.** That would make the renderer's internals public for
  tests' sake, which CLAUDE.md forbids.

## Consequences

**Positive**
- The boot condition and the hooks' shape change in one file, not 55; a new spec can't drift from them.
- The audio specs boot one way; a test project can carry clips without a private copy of the opener.
- Specs check what the user sees; renderer facts are checked where the renderer is, without a browser.

**Negative / costs**
- Some end-to-end checks are coarser: a spec no longer sees the composer count, cascades, probe captures, shadow
  map size or program counts, only that the view draws (frames keep coming, no errors) or changes in a capture.
  Capture thresholds are new and were written without a Playwright run in this pass.
- `Hooks` is a hand-written structural type: it can drift from the hooks' real objects (a spec casts where it needs
  more, as `scene-tools` does for node ids).

## Deprecates

`openTestProject` in `fixtures.ts`, `bootMix` (`audioMix.ts`), `bootSample`, `LAB` and `FLAPPY` (`audioMusic.ts`),
`playLiveMix` and the private `Hooks` (`audioMixLive.ts`), `SpatialHooks` (`audioSpatial.ts`), `LAB_EDITOR`
(`audioExport.ts`), every spec-local `Hooks` type and `Window` augmentation for the hooks, and every page read of
`World.render`: removed.

## Open questions

- A play-session boot helper (`playEngine` stepped N frames) is still written by hand in two specs.

## References

- `tests/e2e/fixtures.ts`, `tests/e2e/README.md` ("Opening the editor")
- Architecture review 13, candidate 3 and small fix 1
