# 0446. Meshes get LOD levels generated at import, chosen per camera by an `LODGroup`, with dithered crossfade

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0050, 0055, 0056, 0080, 0088, 0090, 0106, 0108, 0118, 0128, 0129, 0130, 0225, 0274, 0276, 0296, 0322, 0370, 0372, 0447

## Glossary

- **LOD (level of detail):** cheaper versions of a mesh, drawn when it's small on screen. **LOD0** is the original; LOD1, LOD2… have fewer triangles.
- **Simplification:** making a mesh with fewer triangles that keeps its shape. meshoptimizer's *simplifier* collapses edges until it reaches a triangle target or an error limit.
- **Error:** how far the simplified surface strays from the original, here as a fraction of the mesh's bounding-box diagonal. The *measured* error is a Hausdorff distance (the farthest any point on one surface lies from the other).
- **Weld:** merging vertices whose attributes are identical, so the simplifier sees connected triangles.
- **Sloppy simplification:** meshoptimizer's fast mode that ignores topology. Good for occluder stand-ins (0447), not for drawing.
- **Screen-relative height (h):** the object's size on screen as a fraction of the viewport's height (Unity's LODGroup measure). 1 fills the screen top to bottom.
- **Transition height:** the h below which a group drops to the next level. Below the last one, the group is **culled** (not drawn).
- **LOD bias:** a quality-tier multiplier on h. Above 1 keeps detail longer; below 1 drops it sooner.
- **Crossfade (dithered):** for a short time both levels draw. Each discards a complementary pattern of pixels, so the switch blends instead of popping. No transparency sorting is involved.
- **Batch:** meshes Babylon draws in one call (0108). *Auto* batches are `InstancedMesh`es; *thin* batches are one matrix buffer culled as a whole.
- **View:** one render of the scene from one camera (0129): a game camera, the editor's scene view, a render-texture camera, the preview inset, or a reflection-probe capture.

## Context

**What exists.** Myco draws every MeshRenderer at full detail wherever it is. The only culling is Babylon's frustum culling: each auto instance is culled on its own, and each thin batch as one box (`render/babylon/meshBatches.ts`, `frameGraph.ts:596`). Shadow casters are culled per cascade (`render/babylon/shadowCulling.ts`). The animation core has its own update-rate LOD for skinned meshes (`Animator.lodMetric` off/distance/screenSize, `lodEvery2 = 20`, `lodEvery4 = 40`; `plugins/animation/runtime/features/playback/view.ts:142`), but no mesh swaps. Models import through `scene/gltf.ts` and `scene/models.ts` with sidecars (0040, 0088, 0118), and builds bake them to `.mycomesh` version 4 (`scene/bakedModel.ts:41`). The engine keeps no world bounds of its own: bounds come from Babylon meshes. `RenderStats.triangles` is always 0 (`BabylonRenderer.ts:826`). No shipped games or outside users depend on any of this.

**What the owner chose (2026-11-28).** Levels are generated at import, which is less work for a solo developer than authoring them. Levels are chosen by a Unity-style `LODGroup` that the engine runs itself: renderer-neutral, per camera, working with thin batches, and unit-testable, rather than Babylon's `addLODLevel`. Crossfade is wanted if it isn't prohibitively hard. Authored LOD import (glTF `MSFT_lod`, `_LOD0`/`_LOD1` names) waits.

**Measurements** (spike READMEs in `spikes/`; timings on a shared 4-core Xeon are smoke-level until the coordinator's idle re-run; Android floor (0169) figures are not measured: no emulator in the container, 4× CPU throttling is used as an estimate):

- **Benchmark scenes** (`spikes/render-bench/`): BENCH-PLACEHOLDER.
- **Simplifier** (`spikes/lod-simplify/`): npm `meshoptimizer` 1.3.0 (MIT) runs unchanged in Node 22 and Chromium, with bit-identical output. The simplifier is 19.2 KB min+gzip (26.4 KB with the reorder encoder).
  - Speed: a 3-level chain with normals and UVs weighted takes 19 ms for a 20k-triangle rock and 84 ms for FlightHelmet (95k). Sponza (262k triangles, 103 submeshes) takes 366 ms, and its whole pipeline 846 ms.
  - Quality: on the rock, the maximum measured error is 0.62 / 1.00 / 1.65 % of the diagonal at 50 / 25 / 12.5 % of the triangles. On a two-material tree it is 1.0 / 2.0 / 2.6 %.
  - **Weld first:** an unwelded mesh doesn't simplify at all. Once welded, UV seams and split normals leave no cracks.
  - **Hard-edged meshes stall.** A building stops at 63 % of LOD0 under any error limit. With `Permissive`, it reaches 12.5 % at about 1 % error.
  - **The error limit is an estimate, not a bound.** Measured error ranged from 0.02× to 4.7× the limit.
  - **Submeshes:** each is simplified separately with shared vertices locked. Without locks, 166 cracks opened on a two-material rock; with locks, none. A small, thin submesh needs its own error limit, or it collapses (Lantern: 18 % error against 2.8 % whole-mesh).
  - **Storage:** all levels sharing one vertex buffer take ×1.1–1.3 the size of LOD0. Separate buffers take ×1.9–2.3. Ordering the shared buffer coarsest-first keeps the coarse levels' vertex-fetch efficiency at ×1.00–1.03.
  - **Skinning:** carrying joints and weights through the shared buffer is valid by construction (0 bad joint indices).
- **Crossfade and per-view toggling** (`spikes/lod-crossfade/`, raw Babylon 9.32, WebGL2):
  - Toggling `InstancedMesh` enable state inside each view's `onBeforeRenderObservable`, and restoring it afterwards, draws different sets per view in one frame. Rewriting a thin batch's matrix buffer per view also works: 0.04 ms for 1k matrices, 0.17 ms for 10k with `thinInstanceBufferUpdated`.
  - Shadow casters render before the views, so the caster set is independent of what a view draws.
  - A 105-line material plugin dithers two coincident levels with **0 holes and 0 doubled pixels** at every fade value. It works on both batch kinds, beside a second plugin, and adds exactly one compiled effect per fading batch kind.
  - Babylon's shadow shader ignores the discard. A `ShadowDepthWrapper` fixes that, at one more effect and wrapper per material.
  - WGSL code is written but unexecuted here [U].
- **Selection cost** (`spikes/lod-select/`, plain JS): with world bounding spheres cached and recomputed only when a matrix changes, choosing levels for 10,000 groups takes 0.23 ms per view. Recomputing every sphere every view takes 1.1 ms.

## Decision

### 1. Generation at import, with meshoptimizer

- **New dependency: npm `meshoptimizer` 1.3.0** (MIT, MeshOptimizer by Arseny Kapoulkine), editor and export only: games never load it (they read baked levels). It runs in the editor (browser and Tauri) and in the export CLI with identical output, so a build bakes exactly what the editor showed.
- **The model sidecar gets `lod`** (`ImportSettings`, `scene/importSettings.ts`), null meaning no levels:

  ```jsonc
  "lod": {
    "levels": [ { "ratio": 0.5, "error": 0.01 }, { "ratio": 0.25, "error": 0.02 }, { "ratio": 0.125, "error": 0.04 } ],
    "attributes": true,   // weight normals and UVs (simplifyWithAttributes); false: positions only
    "permissive": false,  // let hard edges and seams collapse (needed for boxy, flat-shaded meshes)
    "lockBorders": false, // keep open borders exactly (terrain tiles that must meet their neighbours)
    "pixelError": 1,      // the screen error, in pixels at 1080p, that sets default transition heights
    "occluder": "auto"    // 0447: "auto" (a sloppy stand-in), "lod" (the coarsest level), "none"
  }
  ```

  `ratio` is the triangle target relative to LOD0, and `error` the limit as a fraction of the diagonal. Each level simplifies from the previous one, which is as good as starting from LOD0 and about 2× faster. A level that can't reach its target stops at its error limit, and the import panel shows what it reached.
- **New imports get the default above when a mesh has at least 2,000 triangles,** and null below that. This is the solo-developer default; the owner may prefer opt-in (see Open questions).
  - The editor writes the setting when it first creates a model's sidecar.
  - **A sidecar with no `lod` field means null,** so existing projects and samples are unchanged. That includes `navigation/models/terrain.obj` (8,128 triangles, the only sample model over 2,000; navigation is frozen).
- **Pipeline, per model mesh:**
  1. Weld vertices with bit-identical attributes.
  2. Simplify each submesh with `Sparse`, locking vertices shared between submeshes. Each submesh keeps a minimum of 1 % of its triangles (at least 12), so thin parts don't vanish.
  3. Measure each level's error: meshoptimizer's own estimate times the diagonal.
  4. Build the occluder stand-in (0447) with `simplifySloppy`.
  5. Reorder the one shared vertex buffer coarsest-first with `optimizeVertexFetch`, and the indices of every level with `optimizeVertexCache`.

  Skin joints and weights, morph targets, tangents and second UVs live in the shared vertex buffer and need no remap.
- **Cost and caching.** Generation runs where the model is parsed (`scene/models.ts`, `parseModel`), in the editor's existing model load. It adds tens of milliseconds for a typical model, and up to about 0.85 s for a Sponza-sized one.
  - The result is cached in memory for the session, keyed by file and settings.
  - A disk cache is later work (Open questions).
- **`.mycomesh` version 5.** `BakedJson` gains these per mesh:
  - `lods: { indices: Range, groups, error, triangles }[]`, where LOD0 is the existing `indices`;
  - `occluder?: Range`;
  - `bounds: [minX, minY, minZ, maxX, maxY, maxZ]`.

  The bake settings include `lod`, so changing it re-bakes. A version 4 file is refused and the model loads from source, as today (`bakedModel.ts:223`).
- **In memory,** `ModelMesh` (internal) gains `lods: ModelLod[]`. Each `ModelLod` has `data: MeshData` that shares LOD0's vertex arrays and has its own `indices` and `groups`, plus its `error`. Bounds are computed once per `MeshData` from its positions, or read from the baked file.

### 2. `LODGroup`, a component

`engine.LODGroup` (public API, `render/components.ts`) on a node controls every `MeshRenderer` and `SkinnedMeshRenderer` in its subtree, stopping at a nested `LODGroup`:

| Field | Default | Meaning |
|---|---|---|
| `levels: number[]` | from import | Transition heights, descending, one per level. Level *i* draws while h ≥ `levels[i]`; below the last value the group is culled. Set the last value to 0 to never cull. |
| `fade: "none" \| "crossfade"` | `"crossfade"` | How a level change looks. |
| `fadeDuration` | 0.3 s | How long a crossfade lasts. |
| `forceLevel` | -1 | -1 chooses automatically; *n* always draws level *n* (debugging). |
| `size` | 0 | The group's world size for h. 0 means automatic: the diagonal of its renderers' combined local bounds times the node's largest world scale. |

- **Members.** At group level *i*, each member draws its own mesh's level min(*i*, last), so a group whose meshes have different level counts still switches together. A member whose mesh has no levels draws at every level until the group is culled.
- **Defaults come from the measured error.** A level is good enough while its error covers under `pixelError` pixels at 1080p. That gives h = `pixelError` / (1080 × error), and is the same at every field of view, as h is relative to the viewport (`spikes/lod-simplify/` §4). The last value defaults to 0.01, culled below 1 % of the screen.
  - Rock example: 0.149, 0.093, 0.056, then culled below 0.01.
  - **Size measure:** h uses the bounding diagonal, consistent with how error is measured. This differs from Unity, which uses the largest extent; Unity's numbers come out up to 1.7× higher.
- **The editor adds the group.** Placing a model that has levels, or a prefab made from one, adds an `LODGroup` at its root with the default heights. Scripts and scenes can add or remove one like any component.
- **Script API.** `lodGroup.currentLevel` is read-only: the level for the main camera, the lowest-depth enabled `Camera`, as 0370's views use. It is -1 when culled.
- **Later: authored levels.** An optional `renderers` list per level (Unity's model) is reserved for importing `MSFT_lod` and `_LOD0`/`_LOD1` names. It is not built in v1.

### 3. Selection: engine-owned, renderer-neutral, per view

- **`render/lod/select.ts`** is pure TypeScript with no backend imports, unit-tested. `selectLevels(view, groups, out)` writes one byte per group (level, or 255 for culled) from:
  - the view's position, its projection (perspective `fieldOfView`, or orthographic `orthographicSize`), its frustum planes and its height in pixels;
  - each group's cached world bounding sphere and transition heights;
  - the tier's `lodBias` and `lodMaxLevel`;
  - `forceLevel`.
- **Frustum and hysteresis.** Groups outside the frustum are marked off-screen too. Babylon's own culling stays as a second test. A level change needs h to cross the threshold by 4 %, so a group sitting on a boundary doesn't flicker.
- **Bounds module, `render/lod/bounds.ts`.** Each renderer has a local AABB from its `MeshData`, and a world sphere and AABB recomputed only when its matrix changes (the existing `matrixChanged`).
  - This is the engine-side bounds store the renderer lacked, also used by 0447.
  - Skinned renderers use their `boundsMode` bounds (`SkinnedMeshRenderer`).
- **Which views select:**
  - every view in the frame plan (0129): game cameras, render-texture cameras, the editor scene view and the preview inset, each with its own camera;
  - each reflection-probe capture (`probes.ts`), from the probe's position at its face resolution, with no crossfade.
- **Shadow cascades** draw each group at the level the first view chose, at its settled level during a crossfade, switching at the fade's midpoint. Shadows then match the main view's silhouettes and need no extra selection. A group culled by LOD in that view casts no shadow. Occlusion (0447) never removes casters.
- **Applying it in Babylon.**
  - `BabylonMeshes` (`render/babylon/meshes.ts`) acquires a drawable per (renderer mesh, level) as levels are first used. A level's `MeshData` is a distinct batch key, so **thin batches split per level** automatically (0108).
  - **Before the frame:** every drawable used by any view stays enabled, because the view's cull task drops instances that start disabled (spike). Caster state is set before the shadow tasks.
  - **In each view's `fit(camera)` hook:** instances not drawn by that view are hidden, and thin batches are compacted (`thinInstanceBufferUpdated`).
  - **After each view:** a new `afterView` hook restores state. It joins the internal `BabylonFeature` interface (`render/babylon/feature.ts`) beside `fit`.
- **Render stats.** `RenderStats.triangles` reports the triangles actually drawn, summed over views. The diagnostics (0154) gain `lod: { groups, perLevel: number[], culled, fading }`.

### 4. Crossfade

- **Not prohibitively hard, so it ships in v1** (spike: a 105-line plugin, 0 holes and 0 doubled pixels; integration est. 300–350 lines).
- **`MycoLodFadePlugin`** (`render/babylon/lodFade.ts`) is on the `MycoMaterialPlugin` base (0225), GLSL and WGSL.
  - **Where it goes:** it is added to a material the first time that material draws a fading batch.
  - **What it reads:** a per-instance `mycoLodFade` attribute, via `registerInstancedBuffer` for auto batches and a second thin-instance buffer for thin ones.
  - **What it does:** discards with a 4×4 screen-space ordered dither. The outgoing level keeps f and the incoming level gets the complement, encoded negative; an incoming level at 0 is a tiny negative, as -0 isn't < 0 (spike).
  - **Its define:** `MYCO_LOD_FADE` is set per mesh in `prepareDefines`, so one material yields a fading effect only for fading batches.
- **Fading instances sit in their own batches.** The batch key gains `fade: boolean`. A `discard` in a shader disables early depth testing on many GPUs even when no pixel discards, so steady instances never pay for it. A group fading in one view draws both levels in that view's fade batches for `fadeDuration`, then returns to a steady batch.
- **Fade state is kept per (group, view)** for views that persist: cameras, and the editor scene view. Probe captures and thumbnails snap.
- **Every lit or unlit mesh material takes part,** user shaders included, with no work from their authors. Built-in PBR materials, shader graphs and hand-written shader assets (0106) all draw as a `PBRMaterial`, the latter two through `MycoGraphPlugin`. The fade plugin sits on that same material after the graph plugin, and only discards fragments, so `vertexOffset`, keywords and properties are untouched.
  - **Out of scope:** raw `ShaderMaterial`s (sky, GPU particles) and the water, decal and particle plugins aren't LOD members.
- **Shadows switch hard at the fade midpoint.** Dithered shadows would cost a `ShadowDepthWrapper` per fading material, one more effect per fading batch kind, early-Z in the depth pass, and a pattern that shimmers as cascades move (spike §3). They are a later option.
- **Warm-up (0080)** also compiles the fade variant of each material drawn by an `LODGroup` with `fade: "crossfade"`, so a first transition doesn't stall on a pipeline compile.

### 5. Quality tiers

`QualityTier` (`core/graphics.ts`) gains three fields, read by selection and editable in Project Settings:
- `lodBias` (Low 0.6, Medium 0.8, High 1, Ultra 1.5);
- `lodMaxLevel` (the finest level a tier may draw: Low 1, others 0);
- `lodCrossfade` (Low false, others true).

Automatic quality (0055, 0322) steps whole tiers, so it moves these too.

### 6. Skinned meshes and the animation core's rig LOD

- **Skinned levels.** `SkinnedMeshRenderer` members draw their mesh's levels as separate Babylon meshes sharing the vertex buffer and the skeleton. A skinned mesh isn't batched, so its fade value is a per-mesh uniform rather than an attribute.
- **Rig LOD follows the group.** `Animator.lodMetric` gains `"lodGroup"`: the update rate follows the enclosing group's main-view level. Level 0 updates every frame, level 1 every 2 frames, level 2 and below every 4. A group culled by LOD counts as not visible for `cullingMode` (0370).
  - Adding an `LODGroup` in the editor sets `"lodGroup"` on Animators below it whose metric is `"off"`.
  - The existing distance and screen-size metrics are unchanged.

### 7. Editor

- **The `LODGroup` inspector section** (`registerInspectorSection`) is a horizontal LOD bar.
  - **Segments:** one coloured segment per level, labelled with the level's triangle count summed over members, then a "Culled" segment.
  - **Thresholds:** draggable dividers set the transition heights, as one undoable command per drag (0026).
  - **Marker:** shows the scene-view camera's current h.
  - **Colours:** level colours are theme tokens, added to `src/editor/theme.ts`.
- **Preview a level in the scene view.** Clicking a segment previews that level in the scene view only, through a `lodPreview: { node, level } | null` entry in the editor's render policy (0129). The preview is never saved; `forceLevel` is the saved setting.
- **Model import settings** (`plugins/meshes/editor/ModelImportSettings.tsx`) gain an LOD section:
  - level rows (ratio, error), the attributes, permissive and lock-borders switches, and pixel error;
  - after generating, each level's reached triangle count and measured error, with a warning when a level stopped short of its target.
- **A "LOD level" debug colouring** for the scene view tints each renderer by its current level. It shares 0447's debug-view menu.

### Path to a high-end pipeline

This is a constraint on the design, not a plan (open question O24, added by this record):
- **Levels are already in GPU-driven form.** They are index ranges into one shared vertex buffer per mesh, which is what indirect multi-draw needs (first index and count per level).
- **Selection's inputs and outputs are what a GPU compute pass uses.** It takes world bounds, view matrices, transition heights and bias, and writes a level per group per view. A WebGPU path would move `select.ts`'s rules into a compute shader that writes indirect draw arguments, keeping `select.ts` as the WebGL2 path and its tests as the reference.
- **Per-instance fade becomes a field** in a GPU instance buffer.
- **Nothing public changes.** `LODGroup` and the sidecar name what to draw, not how.
- **Finer-grained LOD later.** meshoptimizer's `buildMeshlets` can feed cluster-based LOD, Nanite-style, from the same import step.

## Alternatives considered

- **Babylon's `addLODLevel`:** chooses per camera inside Babylon, but has no thin-instance support, no crossfade control or shadow rule, and can't be unit-tested without a renderer. The owner ruled it out.
- **Babylon's `DitheredTileFadeMaterialPlugin`** (9.32): fades whole meshes by per-mesh bounds, for tile LOD. It covers neither shadow passes nor per-instance values in our batches. Our own 105-line plugin fits the plugin base and the batch design.
- **The Rust `meshopt` crate:** the same C++ (1.3), but it needed libm and `operator new` shims to build for wasm, and saves only 3 KB over npm.
- **Hard switches only, crossfade later:** about 300–350 fewer lines, but popping is the most visible LOD artefact. The spike found no obstacle, and the Low tier can still switch hard (`lodCrossfade`).
- **Selection in the wasm core with occlusion:** about 3–4× faster (est.), but plain TS with cached bounds is 0.23 ms per 10k groups per view. Keeping it in TS keeps LOD free of wasm and testable in Vitest.
- **LOD on every renderer without a group:** less setup, but no shared switching for multi-mesh models, and no place for per-object heights, fade or force.
- **Separate vertex buffers per level:** simpler, but costs ×1.9–2.3 storage instead of ×1.1–1.3.

## Consequences

**Positive**
- Dense scenes stop paying for distant detail: BENCH-GAIN-PLACEHOLDER.
- **Little authoring:** models over 2,000 triangles get levels by default, and placing them adds the group.
- One selection serves every view, thin batches and shadows, and it's unit-tested.
- User shaders take part in crossfade untouched.
- The engine finally keeps renderer bounds and reports drawn triangles.

**Negative / costs**
- **New dependency** (meshoptimizer, editor and export only, about 26 KB gzip).
- **Import is slower:** tens of milliseconds per typical model, up to about 0.85 s for a Sponza-sized one, each session until a disk cache exists.
- **`.mycomesh` grows** ×1.1–1.3 per model with levels, and goes to version 5.
- **More draw calls while fading:** a fading group draws both levels for `fadeDuration`, in separate batches.
- **More work in the mesh feature:** per-view passes over drawables, and thin-batch compaction (0.17 ms per 10k matrices per view).
- **Coarser shadows:** casters use the main view's level, so a distant object's shadow is coarser too.
- **Hard-edged models need `permissive`,** or their levels stop at about 60 % of LOD0. The panel says so.
- **Unverified here:** the WGSL plugin code runs only on WebGPU, which needs the owner's GPU machine.

## Deprecates

Nothing. `.mycomesh` version 4 files are refused and models load from source, as for any version change.

## Open questions

- **Default on or opt-in:** levels by default for meshes of at least 2,000 triangles (recommended), or only when asked?
- **A disk cache for generated levels in the editor** (Sponza-sized models cost about 0.85 s per session).
- **Dithered shadows** for crossfading casters, behind a tier field.
- **Authored LOD import** (`MSFT_lod`, `_LOD0` names) through the reserved per-level `renderers` list.
- **Whether probes and render-texture cameras want their own bias field.**

## References

- `spikes/lod-simplify/README.md`, `spikes/lod-crossfade/README.md`, `spikes/lod-select/README.md`, `spikes/render-bench/README.md`
- `docs/design/lod-occlusion/goal.md`
- meshoptimizer: https://github.com/zeux/meshoptimizer (MIT)
- Unity LODGroup (screen-relative transition heights, crossfade, LOD bias)
