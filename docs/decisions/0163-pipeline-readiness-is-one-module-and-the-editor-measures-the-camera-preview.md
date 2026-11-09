# 0163. Pipeline readiness is one module the renderer calls around each frame, and the editor measures the camera preview inset

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0080, 0120, 0129, 0153, 0154, 0156 (amends 0129's `RenderPolicy.cameraPreview`)

## Context

**Readiness.** `BabylonRenderer` (977 lines after 0156) held the rules of ADR 0080 (warm up pipelines, re-warm when
the tier's passes change or probes capture, the variant report) and ADR 0120 (hold a World's first frames while
their pipelines compile asynchronously) in twelve fields: `warmer`, `firstFrames`, `firstFrameDrawing`,
`contentLoaded`, `asyncPipelines`, `effects`, `report`, `warmedTier`, `warmedProbes`, `lastRenderAt`, `warmLoaders`,
`warmSources`. Their logic was spread over the constructor, `warmUp`, `warmSource`, `rewarmOnTierChange`,
`afterPhase("capture")` and the middle of `render`, where the hold's begin/skipped/end bookkeeping wrapped the frame
graph call. Thumbnails (0153, 0156) were a constructor flag with null branches through it: no `asyncPipelines`, a
stub `effects`, a warmer built anyway. `FirstFrames` was tested alone; how the renderer combined it with the async
pipelines' `skippedShown`, the warmer's `drawing` and loaded content was tested only by e2e.

**Camera preview.** `RenderPolicy.cameraPreview` (0129) carried the editor's inset `HTMLElement`. The renderer's
`previewRect` called `getBoundingClientRect` on it and on the canvas, through `previewInput` (`render`) and the UI
feature's `host.previewRect()` (`sync`): four layout reads a frame inside the Babylon adapter, behind a frame plan
that is otherwise renderer-neutral. Headless tests stopped at the policy and stubbed `cameraPreviewDrawn`.

## Decision

**`render/babylon/pipelineReadiness.ts` holds the 0080 and 0120 rules.** `PipelineReadiness.forScene(engine, scene,
deps)` installs the async pipelines and effect clock on the engine and builds the warmer; the renderer calls:

```ts
warm(items: readonly WarmItem[], later: Promise<readonly WarmItem[] | null>[]): Promise<void>; // resolves at once while no frames draw
setVariantReport(on: boolean): void;
probesCaptured(count: number): void;                 // more captures than last time: re-warm their copies
beforeFrame(camera: Camera | null, casters: AbstractMesh[]): void; // tier change re-warms; the warmer places its batch
drawFrame(graphReady: boolean, draw: () => boolean, loaded: () => boolean): boolean; // runs `draw`; true: cover it with the clear colour
afterFrame(): void;                                  // only after a frame the graph drew
dispose(): void;
```

`FirstFrames` and `pipelineTierKey` move into it (`FirstFrames` becomes private). Its constructor takes the parts
(engine, warmer and report factories, the tier, a clock, the hold limit), so tests drive it with a fake WebGPU
pipeline cache and a fake warmer. **A thumbnail renderer has no readiness** (null): it never calls `render` or
`warmUp`, so the stub clock, the unused warmer and the engine-ownership flag's other branches go; disposing still
leaves the shared engine.

**A lazy feature's warm source is the slot's.** `lazyFeature(spec, load, loadWarm?)` gains `warmSource()`: the
registration's lighter warm factory (ADR 0154 `loadWarm`), loaded once and tried again after a failure, else the
feature itself. `warmLoaders` and `warmSources` leave the renderer.

**The editor measures the inset; the renderer reads fractions.** `RenderPolicy.cameraPreview` becomes
`{ camera: Camera; inset: PreviewInset }`, `PreviewInset = { x, top, width, height, aspect }` (fractions of the
canvas from its top-left, and the inset's own width/height). `ViewportHandle` keeps the camera and frame element the
editor gives it (`setCameraPreview` is unchanged) and measures once a frame in a new `measure()` the surface calls
before the renderer's sync, setting the policy only when the inset changed. The arithmetic is the pure
`previewInset(canvas, frame)` in `renderPolicy.ts`, over two rectangles; the surface supplies the measurer (the
canvas's and the frame's client rects). The renderer never touches the DOM for it: `previewRect` returns the
policy's inset while the camera is valid, enabled and synced.

**The camera mirror stays.** `syncCamera`'s maths (the pixel-perfect zoom, the snap offsets, the aspect on the
device-pixel grid) already lives on the engine's `Camera` (`_effectiveOrthographicSize`, `_pixelSnap`, `aspect`,
tested in `pixelPerfect.test.ts`); what remains is copying into a Babylon `TargetCamera` and clamping the viewport
rectangle. A camera rig module would move those lines, not concentrate them (deletion test), so none is built.

## Alternatives considered

- **Keep the readiness fields and only test `FirstFrames` more** — the combination (which skipped draws count, when
  the hold ends relative to loaded content and a rebuilt graph) is where the bugs were; it stays untested headless.
- **A readiness object for thumbnails too (a no-op)** — thumbnails never draw through `render`; a null is honest.
- **The surface measures and rewrites the policy** — two policy shapes (with an element, with an inset); the
  handle already owns the editor's preview state.
- **Measure in `ViewportHandle.setCameraPreview` only** — the inset moves with panel layout, not with calls.

## Consequences

**Positive**
- The renderer's readiness is seven calls; the hold, re-warm and report rules are tested headless.
- No layout reads in the renderer; the UI feature and the frame plan read the same inset each frame.

**Negative / costs**
- A layout read per frame stays (once, in the editor's handle) while a preview is shown.
- The inset is measured before the sync, so it lags a layout change made later in the same frame by one frame
  (as the UI layer's did before).

## Deprecates

- `BabylonRenderer.warmSource`, `rewarmOnTierChange`, the DOM reads in `previewRect` / `previewInput`, its twelve
  readiness fields and the thumbnail branches for the async pipelines and effect clock: removed (977 → 891 lines).
  The thumbnail flag stays for the shared studio room, graph Time on sync, and not disposing the engine.
  `FirstFrames` and `pipelineTierKey` move from `asyncPipelines.ts` / `BabylonRenderer.ts` to `pipelineReadiness.ts`.
- `RenderPolicy.cameraPreview.frame`: replaced by `inset`. The canvas's size in the arithmetic is now its client
  rect's (it was `clientWidth`/`clientHeight`, the same for a canvas without borders).

## Open questions

- None new.

## References

- `src/engine/render/babylon/pipelineReadiness.ts`, `asyncPipelines.ts`, `warmUp.ts`, `BabylonRenderer.ts`,
  `feature.ts` (`warmSource`), `BabylonSurface.ts`.
- `src/engine/render/renderPolicy.ts` (`PreviewInset`, `previewInset`), `src/engine/render/editorViewport.ts`.
- Tests: `src/engine/tests/pipelineReadiness.test.ts`, `asyncPipelines.test.ts`, `viewportPolicy.test.ts`,
  `babylonEditorViewport.test.ts` (the preview planned from the policy's inset), `renderFeatureHooks.test.ts`.
