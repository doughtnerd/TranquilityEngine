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

- **Benchmark scenes** (`spikes/render-bench/`). These are generated Myco projects at 1280×720 on the High tier (MSAA, 3 shadow cascades).
  - **The scenes:**
    - **Forest:** 4,000 trees (6.3–10.3k triangles each) and 6,000 rocks (3–5k).
    - **City:** 576 buildings (2.2–4.7k triangles) and 5,000 street props (1.3–3.7k).
  - **How they're measured:**
    - Draw calls and triangles are exact, from a WebGL hook that agrees with Babylon's count to within 2 triangles.
    - CPU is the JavaScript frame with draws counted but not issued, p50 over 3×150 frames on a loaded shared machine. Treat it as smoke-level.
    - Headless Chromium renders through SwiftShader, a software GPU, so GPU time isn't measured. One real-raster forest frame takes 47 s.
  - **Oracles:** each is a hack done only in the spike.
    - LOD: meshoptimizer levels at 0.5, 0.25 and 0.1, swapped by screen height 0.5/0.25/0.1, culled below 0.02.
    - Occlusion: a full-resolution object-ID pass that hides objects with zero visible pixels.

  | Scene (auto batches) | Triangles per frame (main + shadow) | Draws | JS CPU p50 | LOD oracle | Occlusion oracle | Both |
  |---|---|---|---|---|---|---|
  | forest | 61.4M (44.3M + 17.1M) | 46 | 52.6 ms | −89 % triangles, draws 46→133, CPU −24 % | −90 % triangles, CPU −38 % | −98 % triangles, CPU −36 % |
  | city | 10.3M | 68 | 41.8 ms | −95 % triangles, draws 68→144, CPU −34 % | −96 % triangles, CPU −44 % | −99 % triangles, CPU −42 % |

  - **Thin batches cast whole in every cascade.** With `thin` materials, the forest draws **231.5M** triangles a frame, 173.6M of them in shadows, against 61.4M with `auto`; the city draws 52.4M against 10.3M. Their JS CPU is about half that of `auto` (24.8 and 19.5 ms).
  - **LOD changes very few pixels:** 0.2 % of the forest picture and 1.06 % of the city's.
  - **Occupancy:** at the static camera, most forest objects sit at the coarsest level (30 / 79 / 550 / 4,003, with 5,338 culled).
  - **A moving camera costs more** than a still one in the spike: forest p99 101 ms against 82 ms with both oracles. Its hacks re-acquire drawables when they swap meshes, which the design below avoids.
  - **At 4× CPU throttling (est.)** the baseline JS frame is 225–346 ms. Ten thousand individually instanced objects is far beyond the Android floor (0169) with or without LOD. The per-object cost of the mesh feature is its own problem (Open questions).
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
    "pixelError": 1       // the screen error, in pixels at 1080p, that sets default transition heights
  }
  ```

  `ratio` is the triangle target relative to LOD0, and `error` the limit as a fraction of the diagonal. Each level simplifies from the previous one, which is as good as starting from LOD0 and about 2× faster. A level that can't reach its target stops at its error limit, and the import panel shows what it reached.
- **Occluder stand-ins are a separate setting.** `occluder: "auto" | "lod" | "none"` (0447) sits beside `lod` in the sidecar, not inside it, so a model without levels can still have one.
- **Opt-in per model, with one click.** The import panel's "Generate LODs" switch fills in the defaults above. A sidecar with no `lod` field means no levels, so existing projects and samples, including the frozen navigation terrain, are unchanged. The panel suggests it for meshes of at least 2,000 triangles.
  - A project-wide "generate LODs for new models" default is an owner decision (decision list, item 1).
- **Pipeline, per model mesh:**
  1. **Weld** vertices whose every stream is bit-identical: positions, normals, UVs, second UVs, colours, tangents, joints, weights, and every morph target's deltas.
  2. **Simplify** each submesh with `Sparse`, locking vertices shared between submeshes. Normals, UVs and vertex colours (wind weights) are weighted. Each submesh keeps a minimum of 1 % of its triangles (at least 12), so thin parts don't vanish.
  3. **Measure each level's error** as a sampled two-way Hausdorff distance against LOD0, as a fraction of the diagonal. meshoptimizer's own estimate isn't a bound (0.02–4.7× the limit, and relative to the largest extent rather than the diagonal), so it never sets heights or occluder safety.
  4. **Build the occluder stand-in** (0447), and measure its error the same way.
  5. **Reorder** the shared vertex buffer coarsest-first with `optimizeVertexFetch`, and each level's indices with `optimizeVertexCache`.

  - **Remap.** Welding and reordering permute the vertices, so every per-vertex stream (skin, morph targets, tangents, second UVs, colours) is remapped with the same table, once.
  - **LOD0 changes.** It becomes output-equivalent to the source, not identical: the same triangles, with vertices welded and reordered. Consumers of `mesh.data` (`meshTriangles` for `MeshCollider`, `models.ts:1646`) are audited for that.
  - **Tests.** Unit tests check that a skinned and a morphed fixture keep their per-vertex values through the pipeline.
- **Cost, caching and the main thread.**
  - **Where it runs.** Generation runs in a worker started from the editor's model load (`scene/models.ts`, `parseModel`), and the model draws LOD0 until it finishes. It costs tens of milliseconds for a typical model, and up to about 0.85 s for a Sponza-sized one, plus the Hausdorff sampling (to be measured in the first wave).
  - **Disk cache.** Results are cached keyed by a hash of the source bytes and the settings, in the editor's project cache beside the thumbnail cache (0061), so reopening a project costs nothing.
  - **Games never generate.** The player and the export use baked levels only. A model whose bake failed loads from source with no levels and one warning, so games never load meshoptimizer.
- **`.mycomesh` version 5.** `BakedJson` gains these per mesh:
  - `lods: { indices: Range, groups, error, triangles }[]`, where LOD0 is the existing `indices`;
  - `occluder?: Range`;
  - `bounds: [minX, minY, minZ, maxX, maxY, maxZ]`.

  The bake settings include `lod`, so changing it re-bakes. A version 4 file is refused and the model loads from source, as today (`bakedModel.ts:223`).
- **In memory,** each level is a derived `ModelMesh` (internal), cached with a stable identity. It has LOD0's `surfaces`, skin and morph targets, and its own `data`, which shares LOD0's vertex arrays but has its own `indices` and `groups`, plus its measured `error`. The batch key (`meshBatches.ts:67`) and `makeSource` keep working unchanged.
  - Bounds are computed once per `MeshData` from its positions, or read from the baked file.
- **One vertex buffer on the GPU too.** `meshOf` (`render/babylon/materials.ts:404`) today uploads vertex data for every Babylon mesh. Level meshes and fade-batch meshes will share one set of Babylon vertex buffers per model mesh, each with only its own index buffer. The ×1.1–1.3 figure then holds in GPU memory as well as on disk.
  - This is checked in the first wave, with a GPU-memory target of ≤ 1.3× LOD0 per model mesh, whatever the batch count.

### 2. `LODGroup`, a component

`engine.LODGroup` (public API, `render/components.ts`) on a node controls every `MeshRenderer` and `SkinnedMeshRenderer` in its subtree, stopping at a nested `LODGroup`:

| Field | Default | Meaning |
|---|---|---|
| `levels: number[]` | `[]` | Transition heights, descending, one per level. Level *i* draws while h ≥ `levels[i]`; below the last value the group is culled. Set the last value to 0 to never cull. **Empty means automatic:** the heights are derived live from the members' measured errors, so re-importing with new settings updates them. If no member has levels, the group draws LOD0 and never culls. |
| `fade: "none" \| "crossfade"` | `"crossfade"` | How a level change looks. |
| `fadeDuration` | 0.3 s | How long a crossfade lasts. |
| `forceLevel` | -1 | -1 chooses automatically; *n* always draws level *n* (debugging). |
| `size` | 0 | The group's world size for h. 0 means automatic: the diagonal of its renderers' combined local bounds times the node's largest world scale. |

- **Members.** Members are found through a core `LodMember` interface that renderer components implement: `MeshRenderer` in core, and `SkinnedMeshRenderer` in the animation plugin. So the group in core never imports a plugin (0135, 0140).
  - At group level *i*, each member draws its own mesh's level min(*i*, last), so a group whose meshes have different level counts still switches together.
  - A member whose mesh has no levels draws at every level until the group is culled.
- **Automatic heights come from the measured error.** A level is good enough while its error covers under `pixelError` pixels at 1080p. That gives h = `pixelError` / (1080 × error), and is the same at every field of view and viewport size, as both are relative to the viewport (`spikes/lod-simplify/` §4). The last value is 0.01, culled below 1 % of the screen.
  - Rock example: 0.149, 0.093, 0.056, then culled below 0.01.
  - The defaults are starting points per asset: Hausdorff error ignores shading, so lighting can still pop. `pixelError` and the bar let authors tune them.
  - **Size measure:** h uses the bounding diagonal, consistent with how error is measured. This differs from Unity, which uses the largest extent, so Unity's numbers come out up to 1.7× higher.
- **The editor adds the group.** Placing a model that has levels, or a prefab made from one, adds an `LODGroup` at its root with empty (automatic) heights. Scripts and scenes can add or remove one like any component.
- **Script API.**
  - `lodGroup.currentLevel` is read-only: the level for the main camera, the lowest-depth enabled `Camera`, as 0370's views use.
  - `lodGroup.visibility` is `"drawn" | "lodCulled" | "offScreen" | "occluded"` (0447), so "why is it gone?" has an answer.
  - Both come from the simulation-side selection (§3), so they read the same in the editor, the player and a headless World. With no camera they read 0 and `"drawn"`.
- **Later: authored levels.** An optional `renderers` list per level (Unity's model) is reserved for importing `MSFT_lod` and `_LOD0`/`_LOD1` names. It is not built in v1.

### 3. Selection and visibility: engine-owned, renderer-neutral, per view

- **An engine-owned visibility stage, `render/visibility/`** (core, like the lighting rig, 0140), owns everything that decides what each view draws. The Meshes feature and the animation plugin's skinned feature both read its per-view results, and neither decides anything itself.
  - **Bounds (`bounds.ts`).** Each renderer has a local AABB from its `MeshData`, and a world sphere and AABB recomputed only when its matrix changes (`matrixChanged`). Skinned renderers use their `boundsMode` bounds, dilated by how far they moved since last frame, as bone bounds lag a frame (`skinning/sync.ts`).
  - **Frustum test.**
  - **LOD selection (`select.ts`, pure TypeScript, unit-tested).** `selectLevels(view, groups, out)` writes one byte per group: a level, or 255 for culled. Its inputs:
    - the view's position, its projection (perspective `fieldOfView`, or orthographic `orthographicSize`), its frustum planes and its height in pixels;
    - each group's cached world sphere and transition heights;
    - the tier's `lodBias` and `lodFirstLevel`;
    - `forceLevel`.
  - **Occlusion results** (0447).
- **Hysteresis.** A level change needs h to cross the threshold by 4 %, so a group sitting on a boundary doesn't flicker.
- **The simulation runs the main view's selection.** A World service runs `selectLevels` once per frame for the main camera, in the simulation's update after transforms. It feeds `currentLevel`, `visibility` and the Animator's `"lodGroup"` rate (§6) with no dependence on the renderer, so a headless or server World behaves the same.
  - The renderer reuses that result for its main view, and selects other views itself.
  - Animation reads the selection made in the same frame's update. There is no frame of lag, because selection runs before the animation gather.
- **Which views select:**
  - every view in the frame plan (0129): game cameras, render-texture cameras, the editor scene view and the preview inset;
  - each reflection-probe capture, from the probe's position at its face resolution, with no crossfade.
  - Each view is identified by a `ViewKey` (camera id and output kind). Fade and hysteresis state are kept per key, and `fit(camera)` becomes `fitView(view)` (`feature.ts:163`).
- **Applying it in Babylon: per-view object lists, not toggling.** Each view's `FrameGraphCullObjectsTask` (`frameGraph.ts:596`) is given that view's own object list, built from the visibility stage. The spike shows this works for `InstancedMesh` (`spikes/lod-crossfade/` §1).
  - The view's geometry pass (AO, depth of field, `frameGraph.ts:603-621`) and its render pass both draw from the cull output, so they see the same set. Nothing is hidden and restored, and no `afterView` hook is needed.
  - Probes get a `renderList` filtered by their own selection (`probes.ts:122`).
  - Babylon's `scene.customLODSelector` route is measured against this in the first wave and replaces it only if it wins. That spike measures per-view lists, `customLODSelector` and enable toggling at 10k instances, with JS time per view.
- **Thin batches split per level and per pass.** A level's derived `ModelMesh` is its own batch key, so thin batches split per level automatically (0108).
  - Each thin batch has one source mesh per pass that draws it: each view, and each shadow cascade. All of them share the batch's geometry (§1). Each pass's matrix buffer holds only the instances that pass draws.
  - Rewriting one shared buffer between passes was proven on WebGL2 only. On WebGPU, buffer writes may all land before the frame's passes run, so every pass would see the last write. Separate buffers per pass avoid the question on both backends, at 64 bytes per instance per pass.
  - **Per-cascade compaction:** a cascade's buffer keeps only instances whose spheres meet that cascade's frustum. This is the thin-batch counterpart of `shadowCulling.ts`, and removes the measured 173.6M shadow triangles that thin batches spend drawing everything in every cascade.
- **Shadows.**
  - **Level:** casters use the level the main view chose (its settled level during a crossfade, switching at the fade's midpoint), so shadows match the main view's silhouettes.
  - **Culled groups still cast:** a group culled by LOD keeps casting at its coarsest level until it leaves the tier's `shadowDistance`, so a small object's long evening shadow doesn't pop.
  - **Occlusion** (0447) never removes casters.
  - **How:** caster lists come from the shadow map's custom render list per cascade, which `shadowCulling.ts` already installs, plus the per-cascade thin buffers.
- **No churn.**
  - Drawables are pooled per level and kept while used in any view in the last second.
  - Empty batches are kept alive for a few seconds before disposal (today: at once, `meshBatches.ts:213`).
  - Fade batches are created during warm-up.
  - So a moving camera doesn't create and dispose Babylon meshes, as the spike's oracle did (`meshes.ts:181`, `meshBatches.ts:199`).
- **Render stats.** `RenderStats.triangles` reports the triangles actually drawn, summed over views. The diagnostics (0154) gain `lod: { groups, perLevel: number[], culled, fading }`.

### 4. Crossfade

- **Not prohibitively hard, so it ships in v1,** in the wave after hard switches work (spike: a 105-line plugin, 0 holes and 0 doubled pixels; integration est. 300–350 lines, about 2 person-weeks).
- **`MycoLodFadePlugin`** (`render/babylon/lodFade.ts`) is on the `MycoMaterialPlugin` base (0225), GLSL and WGSL.
  - **Where it goes:** it is added to a material the first time that material draws a fading batch.
  - **What it reads:** a per-instance `mycoLodFade` attribute, via `registerInstancedBuffer` for auto batches and a second thin-instance buffer for thin ones.
  - **What it does:** discards with a 4×4 screen-space ordered dither, using Babylon's own tested `bayerDitherFunctions` include in both languages, which removes most of the WGSL risk. The outgoing level keeps f and the incoming level gets the complement, encoded negative; an incoming level at 0 is a tiny negative, as -0 isn't < 0 (spike).
  - **Its define:** `MYCO_LOD_FADE` is set per mesh in `prepareDefines`, so one material yields a fading effect only for fading batches.
- **Fading instances sit in their own batches.** The batch key gains `fade: boolean`. A `discard` in a shader disables early depth testing on many GPUs even when no pixel discards, so steady instances never pay for it. A group fading in one view draws both levels in that view's fade batches for `fadeDuration`, then returns to a steady batch.
- **Fade state is kept per (group, `ViewKey`)** for views that persist: cameras, and the editor scene view. Probe captures and thumbnails snap. A fade reversed midway runs back from where it is.
- **Every lit or unlit mesh material takes part,** user shaders included, with no work from their authors. Built-in PBR materials, shader graphs and hand-written shader assets (0106) all draw as a `PBRMaterial`, the latter two through `MycoGraphPlugin`. The fade plugin sits on that same material after the graph plugin, and only discards fragments, so `vertexOffset`, keywords and properties are untouched.
  - **Out of scope:** raw `ShaderMaterial`s (sky, GPU particles) and the water, decal and particle plugins aren't LOD members.
- **Shadows switch hard at the fade midpoint.** Dithered shadows would cost a `ShadowDepthWrapper` per fading material, one more effect per fading batch kind, early-Z in the depth pass, and a pattern that shimmers as cascades move (spike §3). They are a later option.
- **Warm-up (0080)** also compiles the fade variant of each material drawn by an `LODGroup` with `fade: "crossfade"`, so a first transition doesn't stall on a pipeline compile. It runs again when a quality-tier change (0055) switches crossfade on.

### 5. Quality tiers

`QualityTier` (`core/graphics.ts`) gains three fields, read by selection and editable in Project Settings:
- `lodBias` (Low 0.6, Medium 0.8, High 1, Ultra 1.5);
- `lodFirstLevel` (the most detailed level a tier may draw: Low 1, so it never draws LOD0; others 0);
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

## RFC round (2026-11-28)

Five reviewers (architect, senior engineer, junior engineer, user persona, premise challenger) all approved with changes. Every point and its resolution is in `docs/rfc/0446-0447/README.md`. The changes to this record:
- **Applying levels.** Per-view object lists replace per-view enable toggling, because the geometry pass ran before the hook. Thin batches get a buffer per pass, as WebGPU may not honour rewrites between passes.
- **Engine-owned visibility.** A visibility stage (`render/visibility/`) and a `LodMember` interface keep core free of plugin imports.
- **Selection in the simulation.** The main view's selection runs in the simulation, so headless Worlds and the Animator see it.
- **GPU memory.** Vertex buffers are shared on the GPU, not only on disk.
- **Error and remap.** Every stream is remapped through welding and reordering. Errors are measured as sampled Hausdorff distances, never meshoptimizer's estimate.
- **Defaults.** Opt-in generation per model. `levels` empty means automatic. LOD-culled objects keep casting shadows.
- **Main thread.** Generation runs in a worker, with a disk cache.
- **Targets.** JS CPU must not exceed baseline with LODs on, plus draw-call and GPU-memory targets.
- **Smaller changes.** Babylon's dither plugin's real limitation is stated. `lodFirstLevel` and `visibility` are added. `customLODSelector` is measured in the first wave.

**Estimate (provisional):** about 27 person-weeks for 0446 and 0447 together (range 22–32), from the senior engineer's task table plus a third in reserve. It is calibrated against estimates, not actuals.

## Alternatives considered

- **Babylon's `addLODLevel`:** chooses per camera inside Babylon, but has no thin-instance support, no crossfade control or shadow rule, and puts selection inside Babylon. The owner ruled it out.
- **Babylon's `scene.customLODSelector` driven by `select.ts`:** keeps selection ours and skips building object lists for `auto` batches (`instancedMesh.pure.js:418-431`). Thin batches still need their own path. It is measured in the first wave against per-view object lists, and taken if it wins.
- **Babylon's `DitheredTileFadeMaterialPlugin`** (9.32): supports instances, thin instances and WGSL (`ditheredTileFadeMaterialPlugin.js:154-220`), but has no define. Its `discard` is compiled into every mesh that uses the material (`:367`), costing steady instances their early depth test. Scoping it to fading batches would mean cloning materials. We keep our own plugin, which is scoped per mesh by a define, and reuse Babylon's Bayer include.
- **The Rust `meshopt` crate:** the same C++ (1.3), but it needed libm and `operator new` shims to build for wasm, and saves only 3 KB over npm.
- **Hard switches only, crossfade later:** about 300–350 fewer lines, but popping is the most visible LOD artefact. The spike found no obstacle, and the Low tier can still switch hard (`lodCrossfade`).
- **Selection in the wasm core with occlusion:** about 3–4× faster (est.), but plain TS with cached bounds is 0.23 ms per 10k groups per view. Keeping it in TS keeps LOD free of wasm and testable in Vitest.
- **LOD on every renderer without a group:** less setup, but no shared switching for multi-mesh models, and no place for per-object heights, fade or force.
- **Separate vertex buffers per level:** simpler, but costs ×1.9–2.3 storage instead of ×1.1–1.3.

## Consequences

**Positive**
- **Dense scenes stop paying for distant detail.** The LOD oracle cut drawn triangles by 89 % in the forest and 95 % in the city, and JS CPU by 24–34 %, while changing 0.2–1 % of pixels.
- **Targets for the build,** re-measured with the promoted benchmark (`tests/e2e`, `@slow`, reading `RenderStats`) on the same machine, using the real default heights rather than the oracle's:
  - forest (auto) triangles ≤ 20 % of baseline;
  - forest (thin) shadow triangles ≤ 25 % of baseline;
  - **JS CPU ≤ baseline at the benchmark camera with LODs on.** Levels alone cost CPU: the oracle's "LOD, no cull" row ran 66.2 ms against 52.6 ms in the forest. The win comes from culling;
  - draw calls ≤ 3× baseline and ≤ 300 in the benchmark (the oracle went 46 → 133);
  - GPU vertex memory ≤ 1.3× LOD0 per model mesh;
  - selection ≤ 0.5 ms per view for 10k groups.
- **Little authoring:** one switch per model generates levels, and placing the model adds the group with automatic heights.
- One selection serves every view, thin batches and shadows, and it's unit-tested.
- User shaders take part in crossfade untouched.
- The engine finally keeps renderer bounds and reports drawn triangles.

**Negative / costs**
- **New dependency** (meshoptimizer, editor and export only, about 26 KB gzip).
- **The first import is slower:** tens of milliseconds per typical model, up to about 0.85 s for a Sponza-sized one, plus Hausdorff sampling. It runs in a worker and is cached on disk.
- **`.mycomesh` grows** ×1.1–1.3 per model with levels, and goes to version 5.
- **More draw calls:** about 3× in the forest, from one batch per level and material slot (oracle 46 → 133), more while fading, which draws both levels for `fadeDuration` in separate batches.
- **More work per frame:** building per-view object lists, and per-pass thin buffers (about 0.17 ms per 10k matrices per pass to fill and upload, plus 64 bytes per instance per pass of memory).
- **Coarser shadows:** casters use the main view's level, so a distant object's shadow is coarser too. LOD-culled objects cast at their coarsest level up to `shadowDistance`, which costs some shadow triangles.
- **Hard-edged models need `permissive`,** or their levels stop at about 60 % of LOD0. The panel says so.
- **Unverified here:** the WGSL plugin code runs only on WebGPU, which needs the owner's GPU machine.

## Deprecates

Nothing. `.mycomesh` version 4 files are refused and models load from source, as for any version change.

## Open questions

- **Impostors** (billboard levels for trees and other foliage), the usual last level in Unity and Unreal forests.
- **Dithered shadows** for crossfading casters, behind a tier field.
- **Authored LOD import** (`MSFT_lod`, `_LOD0` names) through the reserved per-level `renderers` list.
- **Whether probes and render-texture cameras want their own bias field.**
- **The mesh feature's per-object CPU cost:** about 40–53 ms of JS per frame for 10k auto-instanced renderers in the benchmark. That's outside LOD's reach and deserves its own record (engine-side culling feeding Babylon less work, or more thin batching).

## References

- `spikes/lod-simplify/README.md`, `spikes/lod-crossfade/README.md`, `spikes/lod-select/README.md`, `spikes/render-bench/README.md`
- `docs/design/lod-occlusion/goal.md`
- meshoptimizer: https://github.com/zeux/meshoptimizer (MIT)
- Unity LODGroup (screen-relative transition heights, crossfade, LOD bias)
