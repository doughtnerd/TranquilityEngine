# LOD apply in Babylon: first-wave spike for ADR 0446 section 3

Raw Babylon 9.32.0 (module-by-module imports), WebGL2 on SwiftShader in headless Chromium (Playwright), a frame graph shaped like
`src/engine/render/babylon/frameGraph.ts:590-660` (clear, then per view cull task, optional geometry task, object renderer task; views are
viewports of the back buffer). Harness pieces come from `spikes/lod-crossfade/harness.ts`. WebGPU cannot run here, so anything that depends
on it is **[U]**. Correctness is exact (pixel reads at every instance's centre, `drawElements*` logs, `gl.bufferData` byte totals); times are
JS-side only on a shared machine and are smoke-level. Pixel timing resolution is about 5 us (the page is cross-origin isolated).

Run: `node spikes/lod-apply/run.mjs` (about 7 min, `RUNS=5`, fresh page per run, writes `results.json`; `QUICK=1` for 2 runs).
`node spikes/lod-apply/dev.mjs <test> '<json args>'` runs one test (`1-timing`, `1-parity`, `1-selectorProbe`, `2-scenario`, `2-dispose`,
`3-views`, `3-cascades`, `3-perf`).

| File | Contents |
| --- | --- |
| `test1.ts` | result 1: 10k instances, 4 level meshes, 2 views, three apply strategies, geometry-pass parity |
| `test2.ts` | result 2: shared vertex buffers across level meshes, GL buffer accounting, skinned variant |
| `test3.ts` | result 3: per-view and per-cascade thin source meshes, fill and upload cost |
| `harness2.ts`, `browser.mjs`, `build.mjs`, `run.mjs`, `dev.mjs`, `main.ts`, `index.html` | frame graph with geometry pass, runner, page |

## Recommendation for 0446 section 3

1. **Per-view object lists (a) stay the design; `customLODSelector` (b) is not worth it.** Both are correct, but (a) is 20-30x cheaper in the
   JS the engine owns (0.06 ms vs 1.6 ms per view at 10k, p50), involves no private field, and works the same for every pass. (b) needs the
   private `InstancedMesh._currentLOD` and is a scene-global hook. (c) toggling loses on cost and has a correctness trap with the geometry pass.
2. **Share GPU vertex buffers with one `VertexBuffer` object per kind handed to every level mesh via `mesh.setVerticesBuffer(vb, false)`, and
   `mesh.setIndices(own)`.** That is 1.13x LOD0 in GPU bytes (4 levels), against 2.86x today, and it is ref-counted by Babylon.
   **Do not share one `Geometry` across meshes** (the `SubMesh` range route): it halves buffer count again but breaks thin instances (see 2.4).
3. **Per-pass thin source meshes work as written in section 3**, built the same way as 2 (shared vertex buffers, own index buffer, own
   matrix buffer). Per-cascade lists through `getCustomRenderList` give pixel-identical shadows with 49 % fewer shadow instances in the
   test scene. Cost at 10k per pass is about 0.4 ms fill and 0.05 ms upload per pass, 1.9 ms for all 5 passes (p50), 3.2 MB of matrix buffers.

## 1. Per-view selection at 10k instances: (a) wins, no blocker

Setup: 100 x 100 grid of 2x2 px boxes; 4 level source meshes (one flat colour each); one `InstancedMesh` per instance per level (40k, frozen
world matrices; variant (b) needs only the 10k level-0 anchors). Two views; per frame each draws a different set (60 % of instances each,
30 % in both, rotating every frame) at different levels (`selectLevels(view, frame, Uint8Array)`, 255 = culled). Check: for every instance in
both views the pixel at its centre has the expected level's colour or is black. **0 mismatches of 20,000 in every strategy** (checked on two frames per run). Draw log per view: 4 calls (one per level source), 6000 instances.

Per-view apply cost, ms, 5 runs x 30 frames pooled (n = 150; p50 / p99 / max), and the whole `scene.render()` of both views:

| Strategy | Apply, view A | Apply, view B | `scene.render()` both views |
| --- | --- | --- | --- |
| (a) per-view `FrameGraphObjectList`, rebuilt from the `Uint8Array` | 0.055 / 0.155 / 0.155 | 0.035 / 0.155 / 0.265 | 33.7 / 60.9 / 72.1 |
| (b) `scene.customLODSelector` | 1.67 / 3.37 / 3.81 | 1.58 / 2.76 / 2.79 | 32.0 / 43.5 / 46.1 |
| (c) `setEnabled` hide in `onBeforeRender`, restore in `onAfterRender` | 15.4 / 23.8 / 25.6 | 15.4 / 24.2 / 24.3 | 102.9 / 145.3 / 146.6 |
| (c') same with `isVisible` | 1.60 / 2.97 / 5.7 | 1.62 / 2.43 / 2.5 | 74.5 / 108.1 / 119.0 |

(b)'s apply number is the selector's own time summed per view (10k calls, includes its two `performance.now()` calls); `scene.render()` is
about 33 ms in (a) and (b) alike on SwiftShader, dominated by Babylon's per-instance work and GL, so the whole-frame difference between (a) and (b)
is inside the run-to-run noise (per-run p50s 33.1-35.6 vs 28.1-39.0). The apply column is the reliable one. (c) is the only strategy whose
cost grows with the pool: its cull list has to hold all 40k drawables (the cull task drops disabled meshes before the hook runs, see the
lod-crossfade README), so the cull task tests 40k and the hook flips 30k twice per view.

1.1 **(a) works, including for the geometry pass: PROVEN.** A `FrameGraphGeometryRendererTask` (depth R16F + normals, fed
   `cull.outputObjectList` like `frameGraph.ts:603-621`) draws exactly what the render task draws: draw logs equal (A: 4 calls, 6000
   instances; B: 4 calls, 6001) and the depth texture read back (`_readTexturePixelsSync` of `geometryViewDepthTexture`) is covered at exactly
   the 6000 / 6001 expected instance pixels, 0 mismatches. Same result for (b).
1.2 **(b) is called by the frame graph path: PROVEN.** `ObjectRenderer._prepareRenderingManager` calls `scene.customLODSelector(mesh, camera)`
   (`Rendering/objectRenderer.js:722`) per mesh per camera, results cached in `mesh._currentLOD` (a `Map` keyed by camera, valid for the frame
   id). With a geometry pass and a render pass per camera the selector ran **10,000 times per camera per `scene.render()`**, not 20,000
   (the second pass hits the cache).
1.3 **(b) needs `InstancedMesh._currentLOD` set, and it is one field per instance: PROVEN.** Returning another level's `InstancedMesh`, or
   the level source mesh without touching `_currentLOD`, draws **nothing** (12,001 mismatches, 0 draw calls; `b-noCurrentLod` check):
   `InstancedMesh._activate` registers the instance with `this._currentLOD`, which only `InstancedMesh.getLOD` normally sets. The working
   selector assigns `instance._currentLOD = levelMesh` and returns the level mesh, so 10k level-0 anchors suffice (no 40k pool). Hazards,
   read from source and **[U]** beyond the tested order: the field is per instance, not per camera, and the per-camera cache returns the
   mesh without setting it again, so it only works while each camera's passes run back to back (true in this graph: A geometry, A render,
   B geometry, B render). The selector is also scene-global (probes, editor views, shadow map `cameraForLOD`).
1.4 **(c) with a hook on the render task only breaks the geometry pass: PROVEN.** The geometry pass runs before the render pass of the
   same view, so it saw all 40k drawables (draw log 40,000 instances per view; depth covered at 10,000 of 6,000 expected, 7999 mismatches).
   Installing the same hide/restore on the geometry renderer's observables fixes it (6000 / 6001, 0 mismatches) at double the toggle cost.
1.5 **Winner: (a).** Blockers: none. Costs to plan for: the pool holds one drawable per level per group (40k `InstancedMesh` here:
   0.65-1.0 s to create, see `createMs`; ADR 0446's pooling-per-level already covers this), and every drawable in a list must stay enabled
   and visible globally. Not measured: Babylon's own cull-task cost at 10k vs 40k beyond what the `scene.render()` column shows.

## 2. Shared GPU vertex buffers across level meshes: PROVEN with `setVerticesBuffer`

Model: UV sphere, 100 x 100 quads = 20,000 triangles, 10,201 vertices (positions + normals + uvs = 326,432 B; skinned adds `matricesIndices`
+ `matricesWeights` = 326,432 B more). Four levels by index buffer only (grid strides 1, 2, 5, 10: 20000 / 5000 / 800 / 200 triangles, 312,000 B
of u32 indices in all; LOD0 alone is 240,000 B). Byte totals hook `gl.createBuffer`, `bufferData` (by bound target) and `deleteBuffer`.

| Path | GPU buffers (4 level meshes) | Vertex B | Index B | Total B | x LOD0 mesh |
| --- | --- | --- | --- | --- | --- |
| baseline: `VertexData.applyToMesh` per level (today's `meshOf`) | 16 | 1,305,728 | 312,000 | 1,617,728 | 2.86 |
| **`VertexBuffer` x3 shared via `mesh.setVerticesBuffer(vb, false)`, own `setIndices`** | **7** | **326,432** | 312,000 | **638,432** | **1.13** |
| one `Geometry` (concatenated index buffer) applied to all four, a `SubMesh` range per level | 4 | 326,432 | 312,000 | 638,432 | 1.13 |
| skinned baseline | 24 | 2,611,456 | 312,000 | 2,923,456 | 3.27 |
| skinned, shared `VertexBuffer` x5 | 9 | 652,864 | 312,000 | 964,864 | 1.08 |

LOD0 = 566,432 B (3 kinds) or 892,864 B (skinned). The 0446 target (<= 1.3x LOD0 per model mesh) holds for both shared paths whatever the batch count.

2.1 **Draws correctly: PROVEN.** Plain level meshes, `InstancedMesh` of each level mesh, and thin-instance sources on shared buffers each cover
   5024 / 5024 / 5024 / 4920 px (the same counts as baseline, pi * 40^2 = 5027), and the canvas hash is **identical** to the baseline's for
   `setVerticesBuffer` (`8770a225`) and, skinned, `b6cde6ab` for both. Draw log: one `drawElements*` per row and level with 60000 / 15000 /
   2400 / 600 indices.
2.2 **Further batches on shared buffers cost only their index buffer: PROVEN.** A second set of four thin-source meshes on the same
   `VertexBuffer`s adds 4 buffers / 312,000 B (indices only; baseline: 16 buffers / 1,617,728 B). Eight meshes: 958,924 B live vs 3,243,948 B
   baseline (3.4x less); thin matrix buffers are separate (64 B per instance).
2.3 **Skinned: PROVEN.** Skeleton + shared `matricesIndices` / `matricesWeights` buffers; moving bone 0 by -12 px shifts the sphere centroid
   from row 49.5 to 61.5 in every level (plain, `InstancedMesh` 61.1 after clipping, thin) with the same pixels as baseline.
2.4 **A shared `Geometry` breaks thin instances: PROVEN (blocker for that path).** `thinInstanceSetBuffer` attaches its `world0..3` vertex
   buffers to the mesh's `Geometry`. Four thin source meshes on one `Geometry` all drew at the last mesh's matrices: thin row 0 / 0 / 0 /
   4920 px, wrong canvas hash `28e3f6ae`. Plain meshes and `InstancedMesh` on the shared `Geometry` were fine. So per-pass thin sources need
   a `Geometry` each (they get it from `setVerticesBuffer`: one `Geometry` per mesh holding the shared buffer objects).
2.5 **Lifetime: PROVEN.** `Geometry.setVerticesBuffer` increments the buffer's reference count, so disposing any meshes leaves the survivor
   drawing (5024 px with the other three levels and all four thin sources disposed; 14 `deleteBuffer`s, the shared three stay), and
   disposing all level meshes frees every buffer (7 created, 0 live, 7 deleted; `sharedGeo`: 4 / 0 / 4).
2.6 **Not shared:** index buffers (one per level mesh, one per per-pass source: 4 sources = 312,000 B, 78 KB per source at these sizes, i.e.
   up to 240 KB for a LOD0 source). Sharing them would need `Geometry._indexBuffer` internals; the byte cost is small next to vertex data.
   **[U]** WebGPU (`setVerticesBuffer` is backend-neutral API, but not run here).

## 3. Per-pass thin sources sharing geometry: PROVEN on WebGL2

3.1 **Per-view sources: PROVEN.** Two thin sources (A red, B green; shared vertex buffers, each its own matrix buffer holding that view's
   instances), each in only its own view's cull object list: 6000 / 6001 instances expected and seen at their pixels, 0 mismatches, 0
   instances of the other colour in either view, **1 draw call per view** (6000 / 6001 instances). No hooks, no toggling.
3.2 **Per-cascade sources: PROVEN.** Scene: perspective camera over a lit ground, 171 thin casters (shared buffers), a 3-cascade
   `FrameGraphCascadedShadowGeneratorTask` (1024 map, `shadowMaxZ` 40). Per cascade a source mesh with its own matrix buffer; the shadow map's
   `getCustomRenderList(layer)` selects the casters inside that cascade's `getCascadeTransformMatrix(layer)` box (the planes test of
   `shadowCulling.ts`), fills that source's buffer, uploads, and returns `[source]`:

   | Mode | Shadow px | Per-layer instances drawn | Total shadow instances |
   | --- | --- | --- | --- |
   | baseline: one source with all 171, drawn in every cascade | 3167 | 171 / 171 / 171 | 513 |
   | per-cascade sources | **3167** (identical, same 8 row bands) | 25 / 84 / 155 | **264** (-49 %) |
   | control: cascade 0's list emptied | 770 | 0 / 84 / 155 | 239 |
   | control: cascade 1's list emptied | 2361 | 25 / 0 / 155 | 180 |
   | control: cascade 2's list emptied | 3077 | 25 / 84 / 0 | 109 |

   The per-cascade sets differ, each cascade's shadow region needs its own set (emptying one removes exactly the shadow rows it covers: 2397,
   806 and 90 px), and the union is complete. `thinInstanceCount` of an empty set is handled by returning an empty list, not the source.
   Note: the earlier lod-crossfade finding applies, the CSM task is keyed by camera, so shadows are checked for the one view whose camera owns it.
3.3 **Fill and upload cost at 10k instances per pass: measured.** Sources have 10k capacity (640 KB each); passes keep 60 / 60 / 25 / 40 / 60 %
   (views A, B, cascades 0-2). Fill = `Float32Array.set` of 16 floats per kept instance from a world-matrix array; upload =
   `thinInstanceBufferUpdated("matrix")` (`bufferSubData`). 5 runs x 40 frames pooled (n = 200), ms, p50 / p99 / max:

   | Pass | Fill | Upload |
   | --- | --- | --- |
   | view A (6000) | 0.36 / 0.72 / 0.86 | 0.055 / 0.79 / 0.86 |
   | view B (6000) | 0.35 / 0.71 / 0.71 | 0.050 / 0.36 / 0.45 |
   | cascade 0 (2500) | 0.19 / 0.53 / 0.54 | 0.025 / 0.15 / 0.25 |
   | cascade 1 (4000) | 0.27 / 0.57 / 0.61 | 0.035 / 0.34 / 0.61 |
   | cascade 2 (6000) | 0.35 / 0.89 / 2.05 | 0.050 / 0.43 / 0.75 |
   | **all 5 passes per frame** | | **1.88 / 3.52 / 3.69** |

   Memory: 64 B x 10k = 640,000 B per pass, 3,200,000 B for 5 passes (one shared buffer rewritten per pass would be 640 KB). The upload is the
   JS-side `bufferSubData` call only; the GPU copy cost is not visible on SwiftShader. The cascade selection (frustum test of 171 instances
   against 6 planes) took 0.03-0.9 ms per cascade in the callback (p50 about 0.1); at 10k it is the same order as the fill, not measured separately.
3.4 **[U] WebGPU.** Separate buffers per pass avoid the question of whether queue writes land before the frame's passes (section 3's reasoning);
   not run here.

## Findings that change the ADR text

- Section 1 "Level meshes ... share one set of Babylon vertex buffers": name the API (`VertexBuffer` objects via `setVerticesBuffer(vb, false)`,
  one `Geometry` per mesh). Do not specify a shared `Geometry` with `SubMesh` ranges for anything that will carry thin instances.
- Section 3 "customLODSelector ... replaces it only if it wins": it does not win (1.5); it also needs the private `_currentLOD`.
- Section 3 "the view's geometry pass and render pass both draw from the cull output": confirmed with draws and depth pixels (1.1).
- Toggling needs the hook on the geometry pass too (1.4), another reason not to use it.
