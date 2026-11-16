# 0188. Render tests build renderers the way callers do, and the feature host offers each service once

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0154)
- **Related:** 0080, 0108, 0128, 0135, 0140, 0153, 0154, 0185, 0186, 0187, 0189

## Context

The project rule is that tests go through the interface callers use, with no members kept alive only for tests.
`src/engine/render` and the render plugins' runtime halves had drifted from it:

- `BabylonRenderer` has a private constructor, and its tests (and `bench/instancing.bench.ts`) cast it to a public
  one to build a renderer on Babylon's `NullEngine`. They spied on the private warmer, called the private
  `describeMesh` and a test-only `syncMeshes`, and read the mesh feature through a "tests and e2e" `meshes`
  getter and its `batchStats()`. Three e2e specs read the private `meshRenderers` map by name.
- About twenty members were labelled "for tests". Some were JavaScript copies of shader maths (`heightFogAmount`,
  `softFade`), so their tests checked the copy, not the shader. Others were counters, resets or source lists that
  no production code read (`MeshBatches.stats`/`sources`, `SpriteBatcher.stats`, `BabylonWater.meshes`,
  `AsyncPipelines.compiled`/`skipped`/`busy`, `_resetGraphTextures`, `_resetTextMeasurer`, `SKY_SOURCES`,
  `lightSegments`). `ThumbnailRenderer`'s constructor had been made public for its tests alone.
- `BabylonFeatureHost` (ADR 0154) offered two ways to the same thing: `probeLookup` beside `probes.lookup`, and
  `drawPolicy()` beside `policy().drawPolicy`.

## Decision

We will build renderers in tests the way production does, and keep only members production reads.

- **One production path takes an engine: `BabylonRenderer.forThumbnail`** (ADR 0153). Unit tests and the
  instancing benchmark make their NullEngine renderers with it and drive them through the renderer's own
  interface (`sync`, `warmUp`, `setPolicy`, `resize`, `diagnostics`, `uiState`, `loadEditorTools`) and the Babylon
  scene it exposes, read with Babylon's public API. No test casts the constructor, and no public constructor or
  factory is added for tests. `renderer.render` needs a GPU (the frame graph), so what only a drawn frame shows
  stays with the browser specs.
- **What a drawn object is** moves from the renderer's private `describeMesh` to `describeDrawn(features, drawn)`
  in `feature.ts`, next to the `describe` hook it reads. The renderer's variant report calls it, and its test
  goes through that function.
- **`ThumbnailRenderer` is made with `create`.** Its tests give `createPreviewEngine` a NullEngine with `vi.mock`.
- **The feature host offers each service once.** `probeLookup` and `drawPolicy()` are removed. The Water plugin
  uses `host.probes.lookup` and the Sprites plugin uses `host.policy().drawPolicy`.
- **Members that only tests read are deleted.** A test either reads the same fact through the module's interface
  (the Babylon scene's instanced and thin-instance sources, the editor tools' meshes, the overlay's line mesh, a
  freshly loaded module) or is deleted if it only tested a copy. The JavaScript copies of the height-fog and
  soft-particle shader maths go, with their tests. That shader behaviour is now checked only where the shaders
  run: a browser, by eye or in pixel specs. No current e2e spec checks height fog or soft particles.
- **Browser specs read the render surface's diagnostics** (`drawn.meshes`, `stats.programs`) and drive the editor
  UI, not renderer internals.

## Alternatives considered

- **A public constructor or `forEngine`-style factory for tests.** It is test-only code by another name, and
  ADR 0189 had just removed one.
- **Keep the shader-maths copies as specifications.** They drift from the WGSL and GLSL without failing, and a
  passing test then says nothing about what is drawn.
- **Keep `batchStats()` for the e2e specs.** The counts are already in the Babylon scene, and the e2e specs can
  check the drawn result through diagnostics.

## Consequences

**Positive**
- Render tests fail when the real path breaks, not when an internal is renamed. The bench runs again (it read a
  `spriteBatcher` that no longer existed).
- The feature host is smaller, and each service has one name.

**Negative / costs**
- Nothing in Vitest covers height-fog or soft-particle maths, or the glue between `warmUp` and the warmer's
  queue (NullEngine can't run the frame graph that draws warm items). Both are left to browsers.
- The rewritten e2e checks are weaker in places. A rebuilt or compiled material is detected by the program count
  growing, not by material identity. The script-override check moved to `materialLibrary.test.ts`.

## Deprecates

`BabylonFeatureHost.probeLookup` and `drawPolicy()` (amending 0154). Removed as test-only: `BabylonRenderer.syncMeshes`
and the `meshes` getter, `MeshesFeatureApi.batchStats`, `BabylonMeshes.batchStats`/`batchSources`/`meshesOf`,
`MeshBatches.stats`/`sources`, `SpriteBatcher.stats`, `BabylonWater.meshes`, `heightFogAmount`, `softFade`,
`_resetGraphTextures`, `_resetTextMeasurer`, `SKY_SOURCES`, `lightSegments` (`emitLightSegments` is now private
to `editorIcons.ts`), `AsyncPipelines.compiled`/`skipped`/`busy`, `_setAsyncPipelines`, `BabylonLighting.shadowState`,
`BabylonFrame.state`, `KERNEL_BUFFER_USAGE`. `ThumbnailRenderer`'s constructor is private again.

## Open questions

- `MaterialPreview.readCenter` (and `window.shaderGraphPreview`, set by the materials plugin's editor half) is a
  test hook the shader-graph and physical e2e specs read. Replacing it with canvas screenshots belongs with
  the editor-side sweep.
- `pipelineTierKey` is exported for its unit test. What it decides (a tier change re-warms) is visible only
  in a drawn frame.

## References

- `src/engine/tests/renderFeatureHooks.test.ts`, `babylonEditorViewport.test.ts`, `instancing.test.ts`,
  `babylonPreviews.test.ts`, `babylonEditorDrawing.test.ts`, `bench/instancing.bench.ts`.
