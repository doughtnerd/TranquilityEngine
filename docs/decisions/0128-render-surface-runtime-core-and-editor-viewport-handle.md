# 0128. The render surface is a runtime core plus an editor viewport handle

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0022, 0032, 0075 (stage 8), 0081, 0083

## Context

`RenderSurface` (`src/engine/render/RenderSurface.ts`) is the seam between the engine and the renderer
(ADR 0032, 0075). Since the three.js backend was removed (ADR 0081), only `babylon/BabylonSurface.ts`
implements it. It had grown to about 48 members: about 8 for the runtime (canvas, sync, render, release,
warm-up, preload, dispose, started), about 13 diagnostics (`qualityState`, `lightingState`, `skyState`,
`postState`, `waterState`, `probeState`, `particleState`, `renderTextureState`, `renderStats`, `uiRuntime`,
`stackCount`…), and about 27 for the editor (`setGizmo`, `pick`, `rayAt`, `screenBounds`,
`setOverlayProvider`, grid, colours, outlines, previews…).

Adding one editor query meant changing five modules: a one-line forward in `src/engine/editor/index.ts`
(34 of them, `world.render?.x(...)`), a `RenderSurface` member, a forward in `BabylonSurface` plus its
pending-state buffering and replay, `BabylonRenderer.editorTools()`, then `editorQueries`/`editorOverlays`/
`editorGizmo`. Three.js fossils remained: the doc comment named `RenderBackend`, `stackCount()` returned
0 (so the camera e2e that expects 1 and 2 could not pass), and `qualityState()` hard-coded `anisotropy: 1`
and `msaa: true`. E2e specs read the renderer's private `meshRenderers` map.

A hard requirement: switching renderers later, or writing our own, must not need a rewrite of the engine or
the editor. So every interface at this seam speaks engine types only (ADR 0010).

## Decision

We split the seam in three.

**1. `RenderSurface` keeps only what the Engine needs:** `canvas`, `started`, `sync`, `render`, `release`,
`releaseWorld`, `dispose`, `preloadTextures`, `warmUp`, `_setVariantReport`, plus two entry points:
`diagnostics()` and `editorViewport()`. That makes 12 members, down from about 48.

**2. One diagnostics snapshot.** `diagnostics(): RenderDiagnostics` returns engine facts, computed when asked:
`started`, `quality` (tier, pixel ratio, shadows, shadow map size, MSAA from the tier), `lighting`, `sky`,
`post` (with `composedCameras`, the number of canvas cameras that composed effects, which replaces
`stackCount`), `water`, `probes`, `renderTextures`, `particles`, `stats`, `cameras` (each camera that drew the
last frame, as its `Camera` component and its target: `canvas`, `texture` or `preview`), and `drawn` (the
nodes whose meshes are drawn, with each material in engine terms, `{ unlit, clearcoat, transmission }`, and
the nodes whose sprites are drawn). It never names a renderer object, class or frame-graph task. E2e specs
read it instead of private maps.

**3. An editor viewport handle.** The editor asks a surface for `editorViewport(): EditorViewport`
(`render/editorViewport.ts`). It holds the editor's whole view of the viewport. State setters (`setColors`,
`setGrid`, `setSelection`, `setSelectionShown`, `setOverlay`, `setGizmo`, `setCameraPreview`,
`setParticlePreview`, `restartParticlePreview`) keep their value until changed. Queries use canvas CSS
pixels: `grid`, `pick`, `rayAt`, `worldToCanvas`, `pointOnPlane`, `screenBounds`, `meshBounds`, `spriteSize`,
`gizmoActiveAt`, `overlayHandles`, `pickOverlayHandle`, `lightIcons`, `pickUI`, `pickUICanvases`,
`uiElementBox`, `drawn` and `bakeReflectionProbe`. There is also `ready`. Every type in it is an engine type
(`GameObject`, `Camera`, `ViewRay`, `ScreenRect`, `WorldBox`, `LocalPose`, `EditorOverlay`, `EditorColors`).

The handle has two layers:

- **`ViewportHandle`** is written once for every renderer. It keeps the editor's state from the first call,
  starts loading the renderer's editor tools when something first asks (an editor World asks at once; a game
  World only if the editor reaches into it), and hands the state over exactly once when they arrive.
  Queries answer "nothing" until then. It also derives what needs no renderer: plane hits from the ray,
  overlay-handle picking from the handles' canvas positions, and UI picks and boxes from the UI core plus the
  ray and projection.
- **`ViewportAdapter`** is the seam a renderer implements: whole-state setters and the raw queries. It has
  two adapters: Babylon's `BabylonEditorTools` (`babylon/editorTools.ts`, over today's `editorQueries`,
  `editorOverlays`, `editorGizmo` and `editorContext`, with the renderer-level features reached through
  `BabylonEditorContext.renderer`), and an in-memory fake (`render/fakeViewport.ts`: `FakeViewportAdapter`
  and `FakeRenderSurface`) for unit tests.

An editor World's `BabylonSurface` waits for the editor tools before `started` resolves, so the viewport is
ready from the first drawn frame.

**`myco/editor` (`src/engine/editor/index.ts`)** exposes `viewport(world)` (a headless World gets a handle
that keeps state and answers nothing) and `renderDiagnostics(world)` instead of the 34 forwards. Functions
that do real work stay: the overlay registry (`addEditorOverlay`, `removeEditorOverlay`,
`setEditorOverlayFilter`, `shownEditorOverlays`, `setEditorOverlay`, `mergeOverlays`), `worldBounds`,
`localPositionFor`, `viewportCanvas` and `resumeEditorWorld`.

## Alternatives considered

- **Keep one wide surface and only trim the fossils.** This is cheapest, but every editor query would still
  cross five modules, and a second renderer would have to implement all 48 members.
- **An editor handle without a shared `ViewportHandle`, with each adapter keeping its own pending state.**
  Each renderer would then repeat the buffering and replay, the part that is easiest to get wrong. The fake
  would not test it either.
- **Make the editor talk to Babylon's tools directly.** This would break ADR 0010 and the requirement that
  the renderer can be replaced.
- **Free functions over `world.render` (the old shape), only re-routed.** The editor would still have no
  object that owns viewport state, and tests would still need to fake the whole surface.

## Consequences

**Positive**
- `RenderSurface` drops to 12 members. A new renderer implements the runtime core, a snapshot and one
  adapter, and the replay comes with `ViewportHandle`.
- An editor query now touches `EditorViewport`, `ViewportAdapter` and the adapter, all in `render/`. The
  editor API and `BabylonSurface` no longer change.
- The editor's viewport logic is testable without Babylon (`FakeRenderSurface`). See the new tests in
  `viewportSelection.test.ts` and `editorViewport.test.ts`, and the Babylon adapter on NullEngine in
  `babylonEditorViewport.test.ts`.
- The e2e specs no longer read private renderer maps for drawn nodes, cameras or materials. `stackCount`'s
  replacement (`post.composedCameras`) reports real numbers.

**Negative / costs**
- Every `myco/editor` caller changed from `pick(world, x, y)` to `viewport(world).pick(x, y)`. These are
  internal: only the editor imports `myco/editor` (ADR 0026).
- An editor World's surface reports `started` one dynamic import later, once the editor tools are loaded.
- The snapshot is computed in full on each call. Play mode's Stats calls it a few times a second, which costs
  more than the old `renderStats()`.
- On a game World, the editor's viewport features (sprite sizes, the UI, previews) now arrive with the editor
  tools, not with the renderer.

## Deprecates

- `RenderSurface` members: every `*State()`, `renderStats`, `uiRuntime`, `stackCount`, and all the editor members
  (now on `EditorViewport`). Removed.
- `myco/editor` functions: `pick`, `screenBounds`, `worldToCanvas`, `pickUI`, `pickUICanvases`,
  `uiElementBox`, `uiElementOutline`, `setSelectionOutline`, `setSelectionOutlineShown`, `setEditorColors`,
  `setGizmo`, `gizmoActive`, `pointOnSpritePlane`, `pointOnGround`, `pointOnPlane`, `rayAt`, `setEditorGrid`,
  `editorGrid`, `setCameraPreview`, `cameraPreviewDrawn`, `setParticlePreview`, `restartParticlePreview`,
  `particleState`, `lightIconsOnCanvas`, `lightWireCount`, `editorDrawingShown`, `renderStats`,
  `overlayHandleAt`, `overlayHandlesOnCanvas` and `spriteSize`. They are removed and replaced by
  `viewport(world)` and `renderDiagnostics(world)`.
- `BabylonRenderer`'s `lightingState`, `skyState`, `postState`, `waterState`, `probeState`,
  `renderTextureState`, `particleState` and `renderStats` merge into `diagnostics()`.

## Open questions

- Moving editor policy out of `BabylonRenderer` (the camera preview, the selected-for-particles set, editor
  layer masks in `render()`) is a later step.
- The material, shader-graph and shader-asset e2e specs still read `meshRenderers` for Babylon-only details
  (readiness, `uniqueId`, per-renderer property overrides). They test the material translation itself. Any
  snapshot fields they need can be added with that work.
- Whether the snapshot should take a field selector if its per-call cost ever shows up in profiles.

## References

- `src/engine/render/RenderSurface.ts`, `src/engine/render/editorViewport.ts`, `src/engine/render/fakeViewport.ts`
- `src/engine/render/babylon/editorTools.ts`, `BabylonSurface.ts`, `BabylonRenderer.ts` (`diagnostics`, `loadEditorTools`)
- Tests: `src/engine/tests/editorViewport.test.ts`, `src/engine/tests/babylonEditorViewport.test.ts`, `src/editor/viewportSelection.test.ts`
