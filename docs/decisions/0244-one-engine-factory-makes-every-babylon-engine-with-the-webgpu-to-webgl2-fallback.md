# 0244. One engine factory: every Babylon engine is made in one place, with the WebGPU-to-WebGL2 fallback

- **Status:** Proposed
- **Date:** 2026-11-19
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0075, 0079, 0081, 0153, 0189, 0240

Salvaged from an unmerged architecture pass (its record 0156, "every asset thumbnail is a made-up node set"). That
record's main idea, drawing every thumbnail kind as a stage through the render features, is not taken: 0189 keeps
material, shader graph, model and particle thumbnails in their own scenes and says why. Only its engine factory is
recorded here.

## Context

Babylon engines were made in two places, and they had drifted:

- `BabylonRenderer.create` (a World's surface: every game and the editor's viewports) made a `WebGPUEngine` when
  `WebGPUEngine.IsSupportedAsync` said so and awaited `initAsync()`, with no catch. A machine that reports WebGPU but
  can't start it (a blocklisted adapter, a device that can't be made, a driver that fails at device creation) made
  `create` reject, so **the game failed to launch** instead of running on WebGL2.
- `previews/common.ts createPreviewEngine` (material, shader graph and particle previews, and the thumbnail engine
  of 0153 and 0189) caught the same failure, warned and fell back to WebGL2, with its own WebGL options (`alpha`,
  `preserveDrawingBuffer`, so a preview's canvas can be copied into a 2D canvas).

Both chose the WebGPU options (`adaptToDeviceRatio: false`, `setMaximumLimits: true` for the adapter's limits, which
ADR 0079's clustered-light materials need) separately, kept in step by a comment.

## Decision

**`render/babylon/createEngine.ts` `createEngine(canvas, { antialias?, transparent? })` makes every Babylon
engine** that draws into a canvas: `BabylonRenderer.create` and every preview and thumbnail engine. Its rules:

- WebGPU where `WebGPUEngine.IsSupportedAsync` says so, with `adaptToDeviceRatio: false` and `setMaximumLimits:
  true`.
- **If `initAsync` throws, warn once, dispose the half-started WebGPU engine and fall back to WebGL2** (loaded only
  then): a game starts on the slower backend rather than not at all.
- WebGL2 with `adaptToDeviceRatio: false`; `transparent` (previews) adds `alpha` and `preserveDrawingBuffer`.
  `antialias` defaults to on.
- It rejects only when neither backend starts.

`createPreviewEngine` is removed; the previews call the factory. Headless engines (`NullEngine` in tests) are not
made by it. No member, flag or export exists for tests: the factory is tested through its own call, with the browser
APIs it meets (`navigator.gpu`, the canvas's `getContext`) stood in for in Node.

## Alternatives considered

- **Add a catch to `BabylonRenderer.create` only** — fixes the launch failure but keeps two engine recipes that
  have already drifted once.
- **Fall back by reloading the page with WebGL2 forced** — slower and loses state; nothing needs it, since the
  failure happens before anything is drawn.
- **Take the rest of the branch's record (thumbnail stages)** — rejected by 0189.

## Consequences

**Positive**
- A game on a machine that advertises WebGPU but can't start it runs on WebGL2, as previews already did.
- One place says how an engine is made; the World's and the previews' WebGPU options can't drift.

**Negative / costs**
- The fallback reuses the canvas. Babylon takes the canvas's `webgpu` context only after the device exists, so a
  failure there leaves the canvas free; a failure after that point leaves `getContext("webgl2")` returning null and
  the fallback rejects too (as before, the game doesn't start).
- In Node the fallback is checked only up to the WebGL2 engine asking the canvas for its context (there is no WebGL
  in Node); a WebGL2 engine actually drawing after the fallback is checked only by hand in a browser.

## Deprecates

- `previews/common.ts createPreviewEngine`: removed; its callers (`MaterialPreview`, `EffectPreview`,
  `ThumbnailRenderer`) use `createEngine`.
- The engine-making code in `BabylonRenderer.create`: replaced by the factory.

## Open questions

- None.

## References

- `src/engine/render/babylon/createEngine.ts`, `BabylonRenderer.ts` (`create`), `previews/common.ts`,
  `previews/MaterialPreview.ts`, `previews/EffectPreview.ts`, `previews/ThumbnailRenderer.ts`.
- Tests: `src/engine/tests/createEngine.test.ts` (the fallback, the options), `babylonPreviews.test.ts` (mocks the
  factory with a NullEngine).
