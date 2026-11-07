# 0081. Remove the three.js render backend; keep three.js only for loading OBJ and FBX models

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Chris Carlson
- **Supersedes:** 0078, 0021
- **Related:** 0010, 0044, 0047, 0057, 0069, 0075, 0076, 0079, 0080

## Context

0078 kept both render backends: Babylon.js by default, three.js as a toggle (`?renderer=three`, `localStorage["myco.renderer"]`, Settings > General > Renderer). It gave two reasons: comparing backends on the same project, and FBX import, which uses three.js's loaders.

Since then:

- **New rendering work is Babylon-only.** Clustered lighting (0079) and pipeline warm-up (0080) exist only on Babylon, and 0080's `RenderBackend.warmUp` resolves at once on three.js. The gap grows with every feature.
- **The toggle has rotted.** The on-screen check of 2026-11-06 found three faults that occur only on three.js: mesh particles with a lit material asset blank the whole render (`Can not resolve #include <cube_uv_reflection_fragment>`); selecting the Camera node breaks the editor view; material-asset particles draw white. None of them occurs on Babylon.
- **Cost of keeping it:** about 7,000 lines depend on the three.js backend, among them `render/RenderBackend.ts` (2,953), `engine/editor/index.ts` (973), `render/ThumbnailRenderer.ts` (829), `ui/UIRuntime.ts` (665), the quarks particle player and preview (about 1,300), `PostProcessStack.ts`, `MaterialPreview.ts`, `shaderGraph/threeMaterial.ts`, `water/WaterRenderer.ts` and `cascadedShadows.ts`. Five dependencies exist only for it: `postprocessing`, `n8ao`, `three.quarks`, `@pmndrs/uikit`, and the three.js parts of `three`. Every rendering change through `RenderSurface` needs two implementations or a recorded gap.
- **What three.js does besides rendering:**
  - the OBJ, MTL and FBX loaders in `scene/models.ts`, loaded on demand in the editor and in games, converted to the renderer-neutral model data (0075 stage 7);
  - small amounts of maths (matrices, quaternions, rays) in `physics/Physics3DWorld.ts`, `render/gizmoMath.ts`, `render/picking.ts`, `render/babylon/editorGizmo.ts` and `ui/UIRuntime.ts`.

## Decision

We will make Babylon.js the only renderer, and keep `three` solely for its model loaders.

- **The toggle goes.** `rendererChoice()`, the `?renderer=` flag, `localStorage["myco.renderer"]`, the Settings renderer field and the three.js branches of `render/previewRouting.ts` and `createRenderSurface.ts` are removed. An old `?renderer=three` link is ignored.
- **The three.js backend is deleted:** `RenderBackend.ts`, `ThumbnailRenderer.ts`, `MaterialPreview.ts`, `PostProcessStack.ts`, `cascadedShadows.ts`, `reflectionProbes.ts`, `fog.ts`, `environmentMap.ts`, `water/WaterRenderer.ts`, `shaderGraph/threeMaterial.ts`, the quarks player (`particles/quarksEffect.ts`, `ParticleRenderer.ts`, `EffectPreview.ts`), the three.js UI runtime and the three.js parts of `engine/editor/index.ts`. Their renderer-neutral pieces (the particle simulation, probe boxes, gizmo maths, preview types) stay.
- **Dependencies removed:** `postprocessing`, `n8ao`, `three.quarks`, `@pmndrs/uikit`.
- **`three` stays only for model loading.** `scene/models.ts` keeps `OBJLoader`, `MTLLoader` and `FBXLoader`, imported on demand as today. Their output is converted to the neutral model data and the three.js objects are dropped right after. No other module imports `three`, and a test enforces that (as `babylonImports.test.ts` does for Babylon).
- **three.js maths moves to the engine's own maths** (`core/math`) in physics, picking, the gizmo maths and the Babylon gizmo, with what's missing added internally. (Corrected while building step 2: `core/math` already had an internal `Mat4` with compose, multiply, invert and decompose; it now also takes `Float64Array`, and a small internal `Quat` adds rotating a vector, the conjugate and axis-angle.) Babylon's maths stays inside `render/babylon/`.
- **The shader graph's GLSL chunk output is removed** (0047's three.js `#include` patching; `compile.ts` GLSL mode and its tests). WGSL is the only graph output (0075 stage 4). On the WebGL2 fallback, graph materials keep drawing as plain PBR with a warning. Water keeps its own GLSL twin.
- **Tests:** tests of the three.js backend are deleted. Where one covers behaviour that also exists on Babylon and has no Babylon test, it's ported first.
- **0010 holds:** neither library appears in the public API.

Built in steps, each ending with `npm test`, `npm run typecheck` and the samples drawing in the editor:

1. Remove the toggle (Babylon always).
2. Move the three.js maths outside the backend to `core/math`.
3. Delete the backend, the quarks player, the UI runtime and the GLSL graph output; remove the four dependencies. (Split while building: 3a deletes the backend and the dependencies; 3b strips the GLSL output from the compiler and the node library, which also touches the graph format's Custom Function `body` and the editor's listing.)
4. Limit `three` to `scene/models.ts`, with the import test; update docs (`CLAUDE.md`, implementation status, guides).

## Alternatives considered

- **Keep both (0078).** Side-by-side comparison, but the toggle is already broken in ways nobody uses it to find, and every feature costs a second implementation or a gap.
- **Remove three.js completely.** No `three` dependency, but FBX import would need our own parser or a converter, and OBJ/MTL a replacement. That's a separate decision, not needed to drop the renderer.
- **Freeze three.js as-is, unmaintained.** No deletion work now, but it keeps rotting, keeps typechecking costs, and leaves a renderer setting that produces broken frames.

## Consequences

**Positive**
- One render path: rendering changes have one implementation, and `RenderSurface` can shrink to what Babylon needs.
- About 7,000 lines and four dependencies gone; faster typecheck and install.
- No setting that leads users to a broken renderer.

**Negative / costs**
- No second renderer to compare against when a Babylon frame looks wrong. Reference images or the Babylon baseline measurements take its place.
- `three` stays in the dependency tree, and its loaders stay in the player's lazy model chunk.
- Behaviour that exists only on three.js is lost unless ported first: none is known to be missing on Babylon today; the implementation-status rows are checked during step 3.
- The graph compiler loses its GLSL output, so graph materials on WebGL2 can't be brought back without writing it again.

## Deprecates

- **0078** (superseded): the toggle and the dual-backend rule.
- **0075's Deprecates list** comes back in force for the renderer: the three.js backend code and `postprocessing`, `n8ao`, `three.quarks`, `@pmndrs/uikit`. `three` and `@types/three` stay for the loaders.
- **0047's GLSL chunk output** is removed; WGSL stays.
- **0021** (particles on three.quarks) is superseded, and **0057** amended: effects play on the renderer-neutral simulation, drawn by Babylon.js (0075 stage 5).

## Open questions

- **Baking models at import:** converting OBJ and FBX to a neutral format (glTF, or our own) when a model is imported or a game is exported would take `three` out of the player entirely. Not needed for this record.
- **WebGL2 graph materials:** whether the WebGL2 fallback should ever run shader graphs (it would need a GLSL output written for Babylon's shaders, not three.js's).

## References

- [0078](0078-keep-both-render-backends.md), [0075](0075-babylonjs-render-backend.md) (stage 10 and Deprecates)
- `docs/architecture/implementation-status.md`, 0075 row: the 2026-11-06 on-screen check
- `src/engine/scene/models.ts` (the loaders), `src/engine/render/createRenderSurface.ts` (the toggle)
