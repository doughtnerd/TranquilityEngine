# 0120. A new World's first frames are held while their pipelines compile asynchronously, and the load's main-thread work is trimmed in Babylon's include expansion and the screen UI's canvas

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0075, 0076, 0080, 0081

## Context

ADR 0080's warm-up draws a scene's content hidden before it's shown, and on WebGPU compiles those pipelines asynchronously (`asyncPipelines.ts`). Two gaps were left on its row: pipelines Babylon makes for itself (post-process passes, the screen UI layer, the clear quad) still compiled blocking, and the load's long main-thread tasks, put down to Babylon's JavaScript shader preprocessing. The rendering plan's preferred fix for the second was a cache of preprocessed shader code shared between Worlds' engines (each World has its own engine, by the owner's choice).

Measured on the pirates sample (editor play mode, Practice against bots, 15 s from the click; headless Chromium on the real GPU through D3D11 with Dawn's FXC compiler, 1600×900; three runs before, four after):

- **What the match World compiled blocking:** 18 pipelines: 8 for the scene's own meshes in the frame graph's first runs, 5 post-process passes, the screen UI layer, and 4 when the engine starts or processes the environment map. Only the warmer's 7 compiled asynchronously. A World's first scene is loaded before its engine draws, so the warm-up can't run ahead of it, and the first frames draw the content for real.
- **The long tasks:** 1.7–2.4 s in all, the worst 0.9–1.35 s. Profiled:
  - **The worst one was the screen UI, not shaders:** 436 ms in `getImageData`, the first readback of the GUI canvas's redrawn rectangle (`uploadRedrawnPart`, ADR 0075 notes). Chrome draws a 2D canvas on the GPU until it has been read back a few times, then moves it to the CPU; the move is that task. The console's `willReadFrequently` warning said so.
  - **Creating effects:** about 560 ms, nearly half of it Babylon's `ProcessIncludes` expanding a shader's `#include`s anew for every set of defines, although the expansion doesn't depend on the defines.
- **A cache shared between engines wouldn't help:** of the match World's 30 PBR-sized shader modules, 4 had code an earlier World (the editor's, the menu's) had already made. Different lights, shadows and materials give different defines, so different code.
- **Seen on the way, not in this record's area:** `Camera.canvasSize` reads `canvas.clientWidth`, which forces a layout in the editor; about 1 s of the 6 s after the click.

## Decision

**A World's first frames are held.** From the first frame a renderer's frame graph runs (`FirstFrames` in `render/babylon/asyncPipelines.ts`), every draw in the graph whose pipeline is missing compiles asynchronously and is skipped. That covers content, Babylon's post-process passes and the UI layer, not just the warmer's draws. Each such frame is covered with the clear colour, as the frames before the graph was ready already were. The hold ends with the first frame that skipped nothing (draws the warmer skips don't count) once the World's textures, models and UI have loaded (`contentLoaded`, `uiLoading`). A 3 s limit also ends it. Frames where a layout change rebuilds the graph instead of running it don't count. After the hold, a missing pipeline compiles as Babylon makes it. A graph rebuilt later (a resize, a camera's effects changing) is never held, because there is a picture on screen to keep. `AsyncPipelines.install` gains a `shown()` predicate and a `skippedShown` count for this.

**Babylon's include expansion is remembered.** Our Babylon patch (`patches/@babylonjs+core+9.32.0.patch`, ADR 0075's rule for small fixes) memoizes `ProcessIncludes` in `Engines/Processors/shaderProcessor.js`:
- The key is the source, `supportsUniformBuffers` and `indexParameters` (light and morph target counts).
- An entry is used only while the include store is the same object and every include it read still holds the same string.
- At most 64 entries, least recently used dropped.
- An expansion that fetched an include over the network isn't remembered.
- `_ClearIncludeCache()` is exported for tests.

**The screen UI's canvas is made for readback.** On WebGPU, where its redrawn rectangle is read back each redraw, `BabylonUI` makes its fullscreen GUI texture through `readableCanvas` (`render/babylon/ui.ts`). It briefly wraps `engine.createCanvas` so the canvas's 2D context is first created with `willReadFrequently: true`. Babylon's own later `getContext("2d")` returns that context.

**Not done: a cache of processed shader code shared between engines.** The measurement above rules it out for now. The plan's item stays shelved.

## Alternatives considered

- **Warm Babylon's internal pipelines ahead of the swap with recorded state.** Replay each internal pipeline's state through `preWarmPipeline` on the new engine. It needs the full render state outside a draw (formats, blend, vertex layout), rebuilt from Babylon internals. The hold gets the same result with the draws Babylon actually makes.
- **Hold only until the first complete frame.** Tried first. The match World's first graph had no UI or post effects yet, drew complete at once, and ended the hold before the expensive pipelines came. Waiting for loaded content fixes that.
- **Keep the last picture instead of the clear colour.** WebGPU shows the previous frame only when nothing touches the canvas's texture, and Babylon's frame graph always does. The frames before a graph is ready already show the clear colour.
- **Skip missing content draws for good, without holding.** Meshes would vanish for a frame or more. ADR 0080 chose never to drop a draw that's on screen.
- **A process-wide cache of processed shaders** (the plan's item 4). Measured above: 4 of 30 PBR modules repeated.
- **Preprocess in a worker.** Babylon's processor runs inside effect creation, with the engine's capabilities and the material plugins' code hooks. Moving it would mean forking that path.
- **Send the include memo upstream first.** Worth doing, but not a reason to wait; the patch carries it meanwhile.

## Consequences

**Positive**
- Pirates match World: blocking pipelines after the click 18 → 6–7 (those left are Babylon's texture tools: the engine's mipmap pipelines, the environment's cube mipmaps, prefilter and RGBD decode). Async 7 → 19. Worst frame 0.9–1.35 s → 150–270 ms.
- Long tasks over the load: 1.7–2.4 s → 0.7–1.5 s, the worst 0.9–1.35 s → 150–250 ms.
- Effect creation over the load: about 560 → 360 ms.
- `getImageData`: 571 → 167 ms over the load.
- A new World appears complete instead of pipeline by pipeline.

**Negative / costs**
- A new World shows its clear colour a little longer: about 0.6 s in the pirates match, at most 3 s.
- The hold relies on the same Babylon internals as `asyncPipelines.ts`, and the patch on `shaderProcessor.js`'s structure. Re-check both on each Babylon upgrade.
- The include memo holds up to 64 expanded sources (PBR is about 100–200 KB each).
- The GUI canvas is drawn on the CPU from the start. Chrome moved it there after a few readbacks anyway.

## Deprecates

Nothing.

## Open questions

- **Hold a World until its whole warm-up drains?** It would start with zero mid-scene compiles but show the clear colour for about 1–2 s. Today the hold ends at the first complete frame once loaded.
- **Hold when a scene load in the same World changes the frame graph's layout at the swap?** That frame still compiles the new post-process passes blocking.
- **Babylon's texture tools** (environment prefiltering, mipmaps, RGBD decode) still compile blocking, once per World.
- **Send the include memo upstream.**

## References

- `src/engine/render/babylon/asyncPipelines.ts` (`FirstFrames`), `BabylonRenderer.ts` (`render`), `ui.ts` (`readableCanvas`), `patches/@babylonjs+core+9.32.0.patch`
- Tests: `src/engine/tests/asyncPipelines.test.ts`, `src/engine/tests/warmUpChecks.test.ts`
- [docs/plans/2026-11-rendering-followups.md](../plans/2026-11-rendering-followups.md) item 4; ADR 0080's row in [implementation-status.md](../architecture/implementation-status.md)
