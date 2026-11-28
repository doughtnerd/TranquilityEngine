# Senior engineer review: ADR 0446 (LOD) and 0447 (occlusion)

What I read: both records, goal.md, CLAUDE.md, the four spike READMEs (key sections), ADRs 0019, 0108, 0135, 0140, 0225 and the heads of 0050/0090/0106/0129/0130/0370/0372, and the code: `bakedModel.ts`, `models.ts`, `importSettings.ts`, `graphics.ts`, `render/components.ts`, `Animator.ts`, `playback/view.ts`, `meshBatches.ts`, `meshes.ts`, `materials.ts` (`meshOf`), `frameGraph.ts`, `BabylonRenderer.ts`, `mycoMaterialPlugin.ts`, `graphMaterial.ts`, `plugins/meshes/*`, `native/anim/build.mjs`, `native/rustflags.mjs`, `webBuild.ts`. Not read line by line: 0055/0154/0322/0326 (cited only). Records and spikes live on `claude/lod-occlusion-design`; the code is master.

## Verdicts

- **0446: approve with changes.** Sound shape (generated levels, engine-owned selection, one shared vertex buffer, crossfade by plugin). Top concerns: (1) the Babylon integration is under-specified exactly where the risk is (hook sequence, per-view enable toggling at 10k, N-times Babylon instance count); (2) the vertex-remap claim is wrong for morphs, skin and tangents and untested; (3) "default on" doesn't work with how sidecars are created, and generation blocks the editor's main thread every session.
- **0447: approve with changes.** Evidence is good for the city, weak for the forest (28% of the reference culls), and the layering is wrong. Top concerns: (1) the plugin/core seam (`BabylonMeshes` is core and can't import `plugins/meshes`); (2) the conservative-occluder rules (error push-back, per-distance level choice) are the hardest part and are only described; (3) a fixed ~1.2 ms/view tax, default on, including the Low tier.

## Issues

1. **blocking (0446): each level mesh uploads its own vertex buffer.** `meshOf` (`materials.ts:404-408`) calls `vertexDataOf(src).applyToMesh(mesh)`: a new GPU buffer per Babylon `Mesh`. Per-level source meshes (`meshBatches.ts:242`) therefore cost (1 + levels) times the vertex memory on the GPU; the x1.1-1.3 figure is disk/CPU only. Change: specify sharing one `Buffer` across level meshes (own index buffer each) and spike it in wave 0, or state the GPU cost honestly.
2. **blocking (0446): the remap claim is wrong.** The record says skin, morphs and tangents "need no remap". `ModelMesh.skin`, `morphTargets`, `tangents` are separate per-vertex arrays (`models.ts:262-270`, `bakedModel.ts:63-65`). Welding and `optimizeVertexFetch` permute vertices, so every stream, morph deltas included, must be remapped in lockstep, and weld equality must include joints, weights, tangents, uv2, colours. The simplify spike lists morphs and tangents as not measured. Change: put the remap table in the pipeline and require a unit test that a skinned and a morphed fixture keep per-vertex data through generation.
3. **blocking (0446): the hook sequence contradicts itself.** §3 keeps every used drawable enabled because the view's cull drops disabled instances, yet "caster state is set before the shadow tasks" needs non-caster levels disabled during shadows. Spike §1 found the working order: caster state in the shadow map's `onBeforeRender` (idempotent per cascade), restore all-on after, view state in the view hook, restore in `afterView`; thin batches share one buffer for casters and views. Change: write that as a numbered sequence including the three buffer writes per thin batch per frame.
4. **major (0446): per-view `setEnabled` is unmeasured at scale.** The spike toggled 3 instances. `MeshDrawable.setEnabled` (`meshBatches.ts:155`) calls Babylon `setEnabled`; 10k x (hide + restore) x views is real JS. The spike's alternative is a per-view `objectList` on the cull task (`frameGraph.ts:596-598`), which works for instances. Change: measure both at 10k in wave 0 and name the winner in the record.
5. **major (0446): Babylon object count multiplies.** Drawables are per (renderer, source, level), acquired "as first used" (`meshes.ts:150-190`, `drawables[i]`). A forest at the static camera uses all four levels, so Babylon holds and culls up to 4x the instances in every view, on a baseline already at 40-53 ms JS. The oracle's -24% CPU came from swapping meshes, not from this. Change: define release and hysteresis for unused level drawables, and make the target "JS CPU <= baseline at the benchmark camera with LODs on", not only "forced level 0".
6. **major (0446): selection runs in the renderer; the sim reads it.** `currentLevel`, `Animator "lodGroup"` and `cullingMode` (§6) depend on a result computed in the frame graph. The Animator already does update-rate LOD in the sim gather from its own bounds (`view.ts:142-158`). A headless server has no renderer, and a one-frame-late value is a determinism trap (0033). Change: run `selectLevels` for the main camera in a world service in sim time (pure TS already), and let the renderer reuse it for the main view.
7. **major (both): layering (0135, 0140).** `LODGroup` in core `render/components.ts` must control `SkinnedMeshRenderer`, an animation-plugin component (`SkinnedMeshRenderer.ts:14`) drawn through `skinnedDraws.ts`, not `BabylonMeshes`. 0447 puts occlusion in `plugins/meshes/runtime/occlusion/`, but `BabylonMeshes` applies the bits and is core (`runtime/index.ts:2-6`: "core never imports plugins"). Change: define a core `LodMember` interface that renderer components implement, and a core visibility host seam passed through `createMeshesFeature`; say the meshes plugin claims `LODGroup`, as it does `MeshRenderer`.
8. **major (0446): default-on doesn't work.** Sidecars are written by the shell's import Inspector on Apply (`importSettings.ts:542`); a model without one gets `defaultImportSettings()` (`:203-235`, no `lod`). "The editor writes `lod` when it first creates a sidecar" covers almost no models. Change: either an explicit import hook that writes the sidecar for models of 2,000+ triangles, or a default `lod` in `DEFAULT_IMPORT_SETTINGS` with the threshold applied at generation. Pick one.
9. **major (0446): generation blocks the main thread and reruns every session.** Sponza 0.85 s, a 100-model project several seconds, inside `parseModel` (`models.ts:845`) via `loadModel` (`:535`). The disk cache is parked in Open questions. Change: put it in scope (hash of source bytes + settings, in the project cache folder) and generate in a worker or yield per mesh. Also state that the player never generates: `parseModel` without a baked file must ignore `lod` with a warning, or "games never load meshoptimizer" is false after a failed bake (`webBuild.ts:323`).
10. **major (0446): `levels` default is ambiguous.** The table says default "from import", while the editor "adds the group with default heights". A re-import would leave scene data stale. Change: empty `levels` means derived live from the mesh's measured errors; non-empty is an authored override; define behaviour when `levels.length` differs from a member's level count.
11. **major (0447): conservative occluders are not specified to build.** "Depth pushed back by measured error" and "finer level when error covers over half a pixel" need a per-occluder, per-view level choice that the LOD group did not make. Evidence is box and 100-triangle city occluders only; `simplifySloppy` stand-ins were never rasterised against the oracle. Change: a wave 0 task that rasterises the real stand-ins against the 1080p reference; the zero-false-occlusion target must pass on them.
12. **major (0447): default-on tax.** 1.2 ms (Chromium) per view, est. 3-4 ms on the floor, and the forest culls 28% of the reference under safe settings. Low tier is set to the `"low"` buffer and 4,000 triangles on the device with the least headroom. Change: `occlusionBuffer: "off"` on Low, `Camera.occlusionCulling` default on for perspective cameras only, and an auto-disable when the culled share stays under about 5% for N frames (the counts already exist).
13. **minor (0447): wasm packaging.** The spike uses raw `extern "C"` without bindgen, unlike nav/anim/audio, so loader, `?url` asset handling for player and export, `hash.json` and the CI freshness check are bespoke. A scalar build (1.71 vs 0.93 ms native, city boxes) loaded when `WebAssembly.validate` rejects simd would avoid "occlusion off" on older WebKit. Change: record the loader/export contract and decide on the scalar fallback.
14. **minor (0446): `MeshData` identity as batch key.** `drawKey` uses `idOf(k.src.data)` (`meshBatches.ts:67`) and `makeSource` needs a `ModelMesh` (`:242`); a `ModelLod` with only `data` has no `surfaces`. Change: expose levels as cached derived `ModelMesh` views (same `surfaces`, own `data`) so identity is stable.
15. **minor (0446): LOD0 is rewritten.** `optimizeVertexCache`/`Fetch` reorder LOD0 and welding changes its vertex count, while MeshCollider and baked consumers read `mesh.data` (`meshTriangles`, `models.ts:1646`). Change: say LOD0 is output-equivalent, not identical, and audit those callers.
16. **minor (both): tier plumbing.** New `QualityTier` keys need `TIER_KEYS` (`graphics.ts:182`), defaults for missing fields (pattern at `:241`), the doc example (`:12`), `TierValueKey` (`projectSettingsModel.ts:210`) and the panel. The tier field `occlusion` collides with the renderer field `occlusion`: rename it `occlusionBuffer`, and `lodMaxLevel` to `lodFirstLevel`.
17. **minor (0446): error semantics.** Hausdorff error ignores shading (normal and UV error), so `pixelError: 1` heights can pop in lighting; measured error ranged 0.02x-4.7x the limit. Say defaults are per-asset starting points and keep `pixelError` tunable.
18. **minor (testing).** The build targets lean on the throwaway render-bench harness. Promote it to a repo harness (`tests/e2e`, `@slow`) using the now-real `RenderStats.triangles` (`BabylonRenderer.ts:826`); false-occlusion checks are screenshot diffs with occlusion on and off through captures, not the object-ID oracle. Selection, generation and the rasteriser (`cargo test`, scalar vs SIMD equality) are testable through their own interfaces with no hooks.

## API

- `LODGroup` (`@component`): `levels: number[]` (`@field([Number])`, empty = derived), `fade: "none" | "crossfade"` (`@field(String, {choices})`), `fadeDuration = 0.3` (seconds), `forceLevel = -1`, `size = 0`. Getters `currentLevel` (read-only, -1 culled) and `levelCount`. Names fit 0019 (camelCase, string choices; no angles involved).
- `MeshRenderer.occlusion` and `SkinnedMeshRenderer.occlusion`: `"auto" | "occluder" | "occludee" | "none"`, default `"auto"`, plus a read-only `occlusionRole` for the inspector instead of ad hoc logic.
- `Camera.occlusionCulling = true`; `Animator.lodMetric` gains `"lodGroup"`.
- Tier: `lodBias`, `lodFirstLevel`, `lodCrossfade`, `occlusionBuffer: "off" | "low" | "high"`, `occluderBudget`.
- Sidecar `lod` as in 0446, but with `occluder` moved to the model level (it is not a level setting). `.mycomesh` v5 adds `lods`, `occluder`, `bounds`; `decodeBakedModel` (`bakedModel.ts:226`) must compare a normalised `lod` key (null equals absent).
- Editor commands: set transition heights (one undo per drag), set forceLevel, Generate/Remove LODs (sidecar write), preview level (`lodPreview` render policy), occlusion debug toggle. Diagnostics blocks `lod` and `occlusion` as in the records.

## Milestones and estimate

Waves on disjoint files, in person-weeks:

- **W0 spikes (0.5):** shared-buffer level meshes, enable toggle vs `objectList` at 10k, thin per-layer rewrite, sloppy stand-ins vs oracle, morph/skin remap fixture.
- **W1 import (2.5):** `scene/lod/generate.ts`, `importSettings.ts`, `models.ts`, `bakedModel.ts` v5, export path, cache, worker. Files: `src/engine/scene/**`.
- **W2 core (2.5):** `LODGroup`, `render/lod/{bounds,select}.ts`, tiers, diagnostics, sim-side main-camera service. Files: `render/components.ts`, `render/lod/**`, `core/graphics.ts`.
- **W3 Babylon (3.5, highest risk):** `meshes.ts`, `meshBatches.ts`, `frameGraph.ts` hooks, thin compaction, skinned levels. After W1 and W2 types.
- **W4 crossfade (2):** `lodFade.ts`, fade batches, MultiMaterial, warm-up. After W3.
- **W5 visibility crate (3), parallel with W1-W3:** `native/visibility/**`, build script, TS core.
- **W6 occlusion integration (2):** after W1 and W3.
- **W7 editor (3):** LOD bar, import panel, preview, debug views, profiler. After W2.
- **W8 animation, docs, e2e, status (1.5).**

Sum 20.5; with a one-third reserve about **27 person-weeks**. Suggested deliveries: LOD with hard switch (W0-W3, core of W7) first, then crossfade (W4), then occlusion (W5-W6).

## Conflicts

- 0108: batch key and `drawables[i]` indexing change (`meshes.ts:150-190`); `casters()` (`:98-103`) would list every level's instances unless caster state is managed.
- 0135/0140: core can't import plugins (issue 7).
- 0370: the Animator already owns bounds-based LOD (`view.ts:142`) and skinned bounds live in `skinBounds.ts`; `render/lod/bounds.ts` must be one seam with them. "The engine keeps no bounds" is untrue for skinned meshes.
- 0090/0296: export bakes through `bakeModelFile` (`models.ts:907`) and `withBakedModels` (`webBuild.ts:312`); both work unchanged, but a failed bake falls back to source in the player (issue 9).
- CLAUDE.md: navigation is frozen, and `terrain.obj` is safe only because it has no sidecar; keep that sentence. No test-only hooks: the occlusion debug buffer must come from public diagnostics, as the record says. Wasm size gate: raise with a build-log line, as `native/anim/build.mjs` documents.
- 0447 depends on 0446's sidecar `occluder` and baked range, so it is blocked on W1.

## Cheaper alternatives

- A per-view `objectList` instead of enable toggling for instances; thin-batch LOD in a later delivery.
- Occlusion v1 with author-flagged box or simple occluders only (up to 512 triangles) and no generated stand-ins: drops the sloppy-occluder and error push-back machinery, and the city-box numbers are the best measured.
- Hard switch on thin batches, crossfade only on instances.
- A scalar wasm fallback is nearly free; a plain-JS rasteriser is not worth it (SIMD is 3x on raster).

## Questions for the author

1. Is GPU vertex memory a target, or only disk size?
2. Must `currentLevel` be valid headless (sim-side selection)?
3. Which ships first: LOD hard switch, crossfade or occlusion? I would ship LOD first.
4. May the Low tier have occlusion on at all?
5. Is thin foliage a non-goal for occlusion (forest 28%), or do we need a coverage-aware test?
6. May generation change LOD0's index order, given baked-file diffs?
