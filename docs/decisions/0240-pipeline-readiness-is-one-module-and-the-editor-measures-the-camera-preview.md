# 0240. Pipeline readiness is one module the renderer calls around each frame, and the editor measures the camera preview inset

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0129's `RenderPolicy.cameraPreview`)
- **Related:** 0080, 0120, 0129, 0153, 0154, 0244

Ported from an unmerged architecture pass (written 2026-11-09 as its record 0163). The preview-inset half is as
written there; the readiness half no longer takes replaceable parts (see Alternatives).

## Context

**Readiness.** `BabylonRenderer` (916 lines) held the rules of ADR 0080 (warm up pipelines, re-warm when the tier's
passes change or probes capture, the variant report) and ADR 0120 (hold a World's first frames while their
pipelines compile asynchronously) in twelve fields: `warmer`, `firstFrames`, `firstFrameDrawing`, `contentLoaded`,
`asyncPipelines`, `effects`, `report`, `warmedTier`, `warmedProbes`, `lastRenderAt`, `warmLoaders`, `warmSources`.
Their logic was spread over the constructor, `warmUp`, `warmSource`, `rewarmOnTierChange`, `afterPhase("capture")`
and the middle of `render`, where the hold's begin/skipped/end bookkeeping wrapped the frame graph call. Thumbnails
(0153) were a constructor flag with null branches through it: no `asyncPipelines`, a stub `effects`, a warmer built
anyway. The re-warm rules were tested only through the warmer, never as the renderer applied them.

**Camera preview.** `RenderPolicy.cameraPreview` (0129) carried the editor's inset `HTMLElement`. The renderer's
`previewRect` called `getBoundingClientRect` on it and on the canvas, through `previewInput` (`render`) and the UI
feature's `host.previewRect()` (`sync`): four layout reads a frame inside the Babylon adapter, behind a frame plan
that is otherwise renderer-neutral. Headless tests stopped at the policy.

## Decision

**`render/babylon/pipelineReadiness.ts` holds the 0080 and 0120 rules.** `new PipelineReadiness(engine, scene,
deps)` installs the async pipelines and effect clock on the engine and builds the warmer; `deps` is what only the
renderer knows (its material library, its probe copies of a material, what a drawn object is). It has that one
constructor, the one the renderer calls. The renderer calls:

```ts
warm(items: readonly WarmItem[], later: Promise<readonly WarmItem[] | null>[]): Promise<void>; // resolves at once while no frames draw
setVariantReport(on: boolean): void;
probesCaptured(count: number): void;                 // more captures than last time: re-warm their copies
beforeFrame(camera: Camera | null, casters: AbstractMesh[]): void; // tier change re-warms; the warmer places its batch
drawFrame(graphReady: boolean, draw: () => boolean, loaded: () => boolean): boolean; // runs `draw`; true: cover it with the clear colour
afterFrame(): void;                                  // only after a frame the graph drew
dispose(): void;                                     // unhooks the engine (the report before the effect clock)
```

`FirstFrames` stays the hold's model in `asyncPipelines.ts` (a pure calculation over times and flags, tested alone);
readiness runs it. `pipelineTierKey` stays in `core/graphics.ts`. **A thumbnail renderer has no readiness** (null):
it never calls `render`, and its engine is shared, so it is never hooked; disposing still leaves the shared engine.
Its `warmUp` still asks the features for their items (so the feature hooks behave the same on every renderer) and
draws nothing.

**A lazy feature's warm source is the slot's.** `lazyFeature(spec, load, loadWarm?)` gains `warmSource()`: the
registration's lighter warm factory (ADR 0154 `loadWarm`), loaded once and tried again after a failure, else the
feature itself. `warmLoaders` and `warmSources` leave the renderer.

**The editor measures the inset; the renderer reads fractions.** `RenderPolicy.cameraPreview` becomes
`{ camera: Camera; inset: PreviewInset }`, `PreviewInset = { x, top, width, height, aspect }` (fractions of the
canvas from its top-left, and the inset's own width/height). `ViewportHandle` keeps the camera and frame element the
editor gives it (`setCameraPreview` is unchanged) and measures once a frame in a new `measurePreview()` the surface
calls before the renderer's sync, setting the policy only when the inset changed. The arithmetic is the pure
`previewInset(canvas, frame)` in `renderPolicy.ts`, over two rectangles; the surface supplies the measurer (the
canvas's and the frame's client rects); a headless handle has none and draws no preview. The renderer never touches
the DOM for it: `previewRect` returns the policy's inset while the camera is valid, enabled and synced.

**The camera mirror stays.** `syncCamera`'s maths (the pixel-perfect zoom, the snap offsets, the aspect on the
device-pixel grid) already lives on the engine's `Camera`; what remains is copying into a Babylon `TargetCamera` and
clamping the viewport rectangle. A camera rig module would move those lines, not concentrate them, so none is built.

## Alternatives considered

- **Readiness built from a bag of parts (engine, warmer and report factories, tier, clock, hold limit), as first
  written** — only tests would fill it with fakes (a fake warmer, a fake WebGPU pipeline cache standing in for
  Babylon's internals): a construction path real code never takes, which CLAUDE.md rules out. Readiness is tested on
  a real NullEngine through its own calls instead; the WebGPU hold, which needs a GPU, is checked by e2e.
- **Keep the readiness fields and only test `FirstFrames` more** — the renderer stays the place where five rules
  meet, and the re-warm rules stay untested as applied.
- **A readiness object for thumbnails too (a no-op)** — thumbnails never draw through `render`; a null is honest.
- **The surface measures and rewrites the policy** — two policy shapes (with an element, with an inset); the handle
  already owns the editor's preview state.
- **Measure in `ViewportHandle.setCameraPreview` only** — the inset moves with panel layout, not with calls.

## Consequences

**Positive**
- The renderer's readiness is seven calls (916 to 834 lines); the warm, re-warm, report and WebGL2 no-hold rules
  are tested headless on a NullEngine.
- Disposing restores the engine's `createEffect` even when the variant report was on (the report was unhooked after
  the clock before, which put the clock's wrapper back).
- No layout reads in the renderer; the UI feature and the frame plan read the same inset each frame.

**Negative / costs**
- How `drawFrame` combines the async pipelines' skipped draws with `FirstFrames` is still checked only in a browser
  with WebGPU (e2e), as before: Node has no WebGPU pipeline cache.
- A layout read per frame stays (once, in the editor's handle) while a preview is shown.
- The inset is measured before the sync, so it lags a layout change made later in the same frame by one frame.

## Deprecates

- `BabylonRenderer.warmSource`, `rewarmOnTierChange`, the DOM reads in `previewRect` / `previewInput`, its twelve
  readiness fields and the thumbnail branches for the async pipelines and effect clock: removed. The thumbnail flag
  stays for the shared studio room and not disposing the engine.
- `FirstFrames.done` and its hold-limit constructor parameter (read and set only by tests): removed.
- `RenderPolicy.cameraPreview.frame`: replaced by `inset`. The canvas's size in the arithmetic is now its client
  rect's (it was `clientWidth`/`clientHeight`, the same for a canvas without borders).

## Open questions

- None new.

## References

- `src/engine/render/babylon/pipelineReadiness.ts`, `asyncPipelines.ts` (`FirstFrames`), `warmUp.ts`,
  `BabylonRenderer.ts`, `feature.ts` (`warmSource`), `BabylonSurface.ts`.
- `src/engine/render/renderPolicy.ts` (`PreviewInset`, `previewInset`), `src/engine/render/editorViewport.ts`.
- Tests: `src/engine/tests/pipelineReadiness.test.ts` (NullEngine), `asyncPipelines.test.ts`,
  `viewportPolicy.test.ts`, `renderFeatureHooks.test.ts` (the inset reaches features through the host).
