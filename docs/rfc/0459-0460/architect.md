What I read: ADR 0459 and 0460 in full; `docs/design/lod-occlusion/goal.md`; READMEs of `spikes/render-bench`, `occlusion-raster` (+ `tables.md`), `lod-crossfade`, `lod-simplify` (§1–3), `lod-select`; `render/babylon/meshBatches.ts`, `meshes.ts`, `frameGraph.ts` (440–817), `shadowCulling.ts`, `BabylonRenderer.ts` (215–245, 445–605, 826), `feature.ts`, `probes.ts`, `materials.ts:404`, `render/framePlan.ts`, `changeDetection.ts`, `bakedModel.ts:41,223`, the skinning feature (`plugins/animation/runtime/features/skinning/renderFeature.ts`); 0108, 0322 and 0055 (the parts that bear on this), and 0370's LOD and culling section.

**0459: approve with changes.** §1, §2, §4–7 are sound. §3's Babylon application needs rework. **0460: approve with changes.** The core and the budgets are well measured, but the conservativeness rule for simplified occluders is unproven.

Top 3 concerns:
1. Hiding per view in `fit` comes too late. The geometry pass and Babylon's cull have already run, and the shadows have rendered.
2. The design rewrites one thin buffer several times a frame, which is only proven on WebGL2.
3. The record says simplified stand-ins never cause false occlusions, but the spike tested exact boxes only.

## Issues

1. **blocking.** `fit` runs inside the render task's `onBeforeRenderObservable` (`frameGraph.ts:644-649`, `BabylonRenderer.ts:227-230`). That is after the view's geometry pass (`frameGraph.ts:603-621`), which draws `cull.outputObjectList`. So AO and depth of field would see every enabled level and every occluded object. It is also after the per-view cull over all of `scene.meshes` (`frameGraph.ts:384,596-598`). **Change:** give each view's cull task its own `FrameGraphObjectList`, built from the engine's per-view visibility. The spike (§1) shows this works for `InstancedMesh`. Compact thin batches in a task placed before the geometry pass. Then the hide/restore dance and the new `afterView` hook can go.
2. **blocking (portability).** Rewriting a thin buffer per cascade and per view relies on WebGL2's `bufferSubData` ordering (lod-crossfade §1). On WebGPU, `queue.writeBuffer` runs before any command buffer submitted after it. If Babylon records the frame in one submit, every pass sees the last write [U]. **Change:** verify this on WebGPU in wave 1. If it fails, give each (batch, view or cascade) its own matrix buffer, with thin source meshes sharing one geometry. That is also the form a GPU-driven path wants.
3. **blocking (0460).** Three problems with "Push depth back by measured error":
   - The "measured" error is meshoptimizer's estimate. lod-simplify §3 finds the estimate is not a bound: true error is 0.02–4.7× the limit.
   - It's scaled by the diagonal, but the estimate is relative to the largest extent (lod-simplify §3).
   - A depth push does nothing about a stand-in that sticks out sideways past the real silhouette.

   `simplifySloppy` also closes doorways and windows. The spike's zero false occlusions came from exact box and prism occluders. **Change:**
   - Use a sampled Hausdorff error measured at import.
   - Make the coverage shrink at least the error's projected size in buffer pixels, not 0.25 px.
   - Add adversarial scenes to the pixel gate: a doorway, a thin wall, and the camera next to or inside a stand-in.
4. **major.** Two parts of the design keep acquiring and releasing drawables:
   - A fade moves a drawable to another batch (`fade` is in the key). On `auto` that means `release` and `acquire` (`meshes.ts:181-188`), which creates an `InstancedMesh` (`meshBatches.ts:199`).
   - A batch is disposed with its last member (`meshBatches.ts:213-215`). A new batch uploads geometry (`materials.ts:404-407`).

   This is the fly-through churn the record says it avoids (render-bench p99). **Change:** pool drawables per level, keep empty batches alive behind a timeout, and pre-create the fade batches during warm-up.
5. **major.** "×1.1–1.3 storage" is true on disk only. `meshOf` uploads the vertex data once per batch source, so GPU vertex memory grows with levels × fade × material variants. **Change:** one Babylon `Geometry` per `ModelMesh`, with each level mesh a `SubMesh` index range of it. State a target for GPU memory.
6. **major.** The oracle's CPU savings won't carry over. The oracle used `setActive(false)`, which takes an object out of the cull and the shadow pass (render-bench "The oracles"). The design keeps objects enabled through both. The spike measured the cost of toggling on 3 instances only. **Change:** adopt #1, measure toggling at 10k, and re-derive the "city JS CPU −20 %" target.
7. **major (ownership).** Occlusion lives in `myco.meshes`, yet it must:
   - hide `SkinnedMeshRenderer`s, which the animation plugin draws (`skinning/renderFeature.ts`);
   - feed the engine's `render/lod/select.ts`.

   **Change:** add an engine-owned per-view visibility stage (`render/visibility/`) that owns bounds, frustum, LOD and occlusion results. The wasm core loads lazily behind it. Both the meshes and skinning features read from it.
8. **major.** The "solid" rule (smallest extent ≥ 10 % of the largest) excludes walls, floors and terrain, which are the classic occluders. **Change:** test each frame that the occluder's projected minimum width is at least about 2 buffer pixels.
9. **major.** A probe renders its cube outside the frame graph, with no view hook (`probes.ts:208-213`). Since every drawable used by any view stays enabled, a probe would capture every level at once. **Change:** hand each probe a renderList filtered by its own selection (`probes.ts:122`), and compact thin batches in the cube texture's `onBeforeRender`.
10. **major.** Pipeline step 3 contradicts the glossary and the spike, which says to derive transition heights from the measured error. **Change:** use the Hausdorff error for the heights (#3), and fix the units.
11. **minor.** `fit(camera)` (`feature.ts:163`) carries no view id, kind or pixel height, yet fade and hysteresis state are kept per view. **Change:** pass `fitView(view)` instead.
12. **minor.** `currentLevel` and rig LOD should use `FeatureSyncContext.view` (`feature.ts:41`), so they match the view that shadows follow (`frameGraph.ts:483`, `views[0]`). Also document the one-frame lag: animation runs before selection.
13. **minor.** `pixelError` is defined at 1080p, but selection takes the view's height in pixels. Pick one.
14. **minor.** The editor draws thin batches as instances (0108), so it never exercises compaction. Add unit tests and a player-mode check.
15. **minor.** There's no target for draw calls, though the LOD oracle raised draws +189 %. Add one, such as ≤ 2× baseline.
16. **minor.** The oracle's thresholds (0.5/0.25/0.1, cull 0.02) aren't the defaults (rock 0.149/0.093/0.056, cull 0.01). The −89 % triangle figure needs re-measuring with the real defaults.

## Failure modes

- **Camera inside or next to an occluder:** a sealed doorway hides the whole room. Skip occluders whose bounds are within a near distance of the camera.
- **Skinned bounds lag.** With `boundsMode: "bones"`, bounds are computed when the draw dispatches (`skinning/sync.ts:10`), so occlusion tests last frame's box. Dilate the box by its speed.
- **The wasm fails to load or lacks SIMD:** occlusion turns off with a warning. It must never hold the first frame (0120).
- **NaN or zero-scale matrices** must be rejected inside the core.
- **A fade reversed mid-way** must run back from its current progress, not restart at 0.
- **A tier change** (0055 steps down during play) creates new fade batches. Warm-up only covers the start.
- **Observability:** add "freeze culling", which keeps the visibility set fixed while the camera flies, to the debug view, plus a culled-but-visible validator mode for QA.

## Performance

- **Android floor, 30 fps (est., 4× throttle):**
  - selection about 0.9 ms per view;
  - occlusion 3–4 ms per view;
  - compaction about 0.7 ms per 10k matrices, per view and per cascade;
  - toggling not measured.

  With two views and three cascades, the overhead is 10 ms or more before any savings. Default render-texture cameras to occlusion off. In v1, cap occlusion at one view per frame.
- **Shadows:** per-cascade compaction is right, and it is the biggest single win (173.6M triangles in the thin forest).
- **Editor:** play mode draws the scene view, the game view and the preview inset, which triples the per-view costs. Default occlusion off in the scene view (as proposed) and in the inset.
- **Back-off:** a camera whose cull rate stays under 10 % for 60 frames should test less often. A forest wastes 2.9 ms per view.

## Cheaper alternatives

- **Per-view object lists instead of toggling (#1).** Fewer moving parts, and closer to GPU-driven culling.
- **Engine culling plus thin batches as the default for LOD meshes.** The engine now has bounds, frustum, LOD and occlusion. That removes the per-object `InstancedMesh` cost of 40–53 ms (0459's open question) instead of adding a new layer on top of it.
- **Temporal reuse on the Low tier** (about 0.3 ms per view, spike §6), for slow cameras.

## Questions for the author

1. How does Babylon's WebGPU engine order `writeBuffer` calls against the frame's passes?
2. What is the retention policy for unused level and fade drawables? How large can `scene.meshes` grow?
3. Why toggle state per view rather than build per-view object lists?
4. Which views count as "persistent" for fade state when the editor's cameras change?
5. Is occlusion a plugin feature or an engine stage, given that skinned meshes and `LODGroup` depend on it?
6. What GPU-time evidence is planned on a real GPU, both desktop and the Pixel 8?
