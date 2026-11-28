# Premise challenger review: ADR 0446 (LOD) and 0447 (occlusion)

What I read: ADR 0446, ADR 0447, `docs/design/lod-occlusion/goal.md`, the READMEs of `spikes/render-bench`, `occlusion-raster` (+ `tables.md`), `lod-crossfade`, `lod-simplify`, `lod-select`; Babylon 9.32 `Meshes/mesh.pure.js`, `instancedMesh.pure.js`, `Rendering/objectRenderer.js`, `Materials/ditheredTileFadeMaterialPlugin.js`; `meshBatches.ts`, `frameGraph.ts` 570-660. I ran nothing.

## Verdicts

- **0446: approve with changes.** The owner's choices (import levels, engine-run `LODGroup`) hold up. Top 3 concerns: (1) the per-view hide hook misses the geometry pass; (2) the benchmark numbers come from an oracle that is more generous than the ADR's own defaults, and the CPU gain is the cull, not the levels; (3) crossfade, skinned levels and rig LOD are wave-1 scope that the spikes don't justify.
- **0447: approve with changes, sequenced after 0446.** Rust/wasm is plausible, but unproven against TypeScript. Top 3 concerns: (1) incremental value over LOD is small in the benchmark and zero on thin batches; (2) the headline savings are upper bounds that include shadow casters; (3) "zero false occlusions" was never tested with the stand-ins the ADR will actually use.

## Issues

1. **0446, blocking: LOD and occlusion are applied after the geometry pass has already drawn everything.** `frameGraph.ts:598-607` feeds `cull.outputObjectList` to the geometry task (AO and depth of field). The hide/compact hook is on the render task (`:644`), which runs later. The spike's own rule is "keep every drawable enabled, hide in the hook" (lod-crossfade README §1), so with AO on, the geometry pass draws all levels of every group. That is about 1.9× the triangles of LOD0 alone. The spike never ran the geometry task. Change: build a per-view `cull.objectList` (spike §1: works for `InstancedMesh` with no hooks), and compact thin buffers in a task before the cull. Then every consumer sees the same set. Add a geometry-pass check to the first wave.

2. **0446, major: the oracle numbers are more generous than the pipeline the ADR specifies.**
   - The bench levels are positions-only, with an error of 0.2 then 1.0 (`generate.mjs:24-25`), so every level hits its ratio. The ADR defaults to `attributes: true`, `permissive: false` and 1/2/4 % error. In the spike, buildings stall at 63 % (lod-simplify README:16), and with attributes plus `Permissive` they reach 6,551 triangles against a 1,301 target (tables, building rows).
   - The bench swaps at fixed h 0.5/0.25/0.1 and culls at 0.02. The ADR derives heights from measured error (rock 0.149/0.093/0.056) and culls at 0.01, so levels switch later and fewer objects are culled.
   - So "forest ≤ 20 % of baseline triangles" and "city −95 %" are unproven. Change: re-run the oracle with the real generator and the real default heights before fixing targets.

3. **0446, major: the CPU saving comes from the cull, not from LOD.** "lod, no cull" costs 66.2 ms in the forest against a 52.6 ms baseline (+26 %), and 38.6 against 41.8 ms in the city (render-bench README, oracles table). The −24 %/−34 % belongs to the 0.02 cull. LOD on thin batches costs +9 %. The target "JS CPU no worse than baseline at level 0" does not catch this. Change: add rows "cull only" and "levels, no cull" to the bench, and a target on JS CPU with levels but no cull.

4. **0446, major: draw calls are understated.** Steady-state draws go 46→133 (forest) and 68→144 (city) from levels alone. The ADR's cost list says "more draw calls while fading". There is no draw-call target, although the Android floor is the stated low end. Change: add a target (for example ≤ 2× baseline) and say how it is met (fewer levels on Low).

5. **0446, major: the dismissal of `DitheredTileFadeMaterialPlugin` is wrong on the facts.** It does cover per-instance and thin-instance values: `setThinInstanceFadeBounds` (`ditheredTileFadeMaterialPlugin.js:154-200`), an instanced-buffer registration (`:273-289`), and complementary Bayer intervals via `setFadeBounds(lower, upper)` (`:100`). It ships GLSL and WGSL. It does not cover shadows (`:29-31`), but the ADR hard-switches shadows anyway, so that gap costs nothing. Using it would drop the 105 lines and the unexecuted WGSL risk. Change: spike it for half a day (ordering after `MycoGraphPlugin`, the per-batch define) before writing `MycoLodFadePlugin`.

6. **0446, major: Babylon already does per-camera, per-instance LOD for `auto` batches.**
   - `InstancedMesh.getLOD` (`instancedMesh.pure.js:418-431`) picks from the source's levels per instance, with the result cached per camera (`objectRenderer.js:716-726`).
   - `scene.customLODSelector` lets the engine's own `select.ts` choose, and returning null culls (`:727`).
   - So the engine-owned selection the owner wants could drive Babylon for `auto` batches, with no enable/disable/restore. Only thin batches need compaction. The ADR's "can't be unit-tested without a renderer" is true of `addLODLevel` and false of this route. No spike tested it [U]; the instance path reads `_currentLOD` from `getLOD`, so a custom selector may need to set it. Change: spike `customLODSelector` with instances before building the hide/restore machinery.

7. **0446, major: sequencing and scope.**
   - Crossfade (300-350 lines, a batch-key doubling, per-(group, view) state, warm-up) is justified by popping. But LOD changed 0.2 % and 1.06 % of pixels at harsher thresholds than the ADR's 1 px defaults.
   - Skinned LOD is shipped on a spike that shows CesiumMan at 12.5 % with 34 % error. "Valid by construction" covers joint indices, not quality. The separate-meshes-sharing-a-skeleton render path was never spiked.
   - Rig LOD integration (§6) and the editor bar are more scope.
   - Change: wave A is bounds, per-view selection and thin compaction; wave B is levels with a hard switch; wave C is crossfade, skinned meshes and rig LOD.

8. **0446, minor: levels by default for every mesh over 2,000 triangles.** There is no census of real models; the only sample over 2,000 is frozen `terrain.obj`. Go opt-in until the editor reports reached ratios.

9. **0446, minor: a group culled by LOD casts no shadow.** A small object with a low sun casts a long shadow, and it will pop. Keep casters to a smaller floor than the draw cull.

10. **0447, major: incremental value over LOD is small, and absent on thin.**
    - Occlusion's JS gain is −38 %/−44 % on `auto`, and +0 %/−3 % on `thin` (24.9 against 24.8 ms).
    - On top of LOD, "both" against "lod" is 33.9 against 40.2 ms (forest) and 24.3 against 27.7 ms (city). That is 3-6 ms of gain for 1.2-2.9 ms of cost. City triangles go from 0.49M to 0.10M, which is cheap either way.
    - At 4× throttle, thin baseline is 93-140 ms against "auto + both" at 113-175 ms (est.).
    - The ADR measures against baseline, not against LOD-on. Change: state that v1 occlusion targets `auto` batches, and gate the build on an after-LOD measurement.

11. **0447, major: the savings are upper bounds that include shadow casters.** The oracle removes hidden casters. The ADR never does. In the forest, shadows are 17.1M of 61.4M triangles and 33 of 46 draws, so a real saving is nearer −66 % than −90 % (from the table). The CPU −38 % is inflated the same way. Change: add a bench row "hide from main view only, casters kept" and restate the targets.

12. **0447, major: the central safety claim is untested for the stand-ins the ADR will use.** The spike's occluders are synthetic boxes and prisms, not `simplifySloppy` output. Pushing depth back by error doesn't fix a sloppy proxy that covers pixels the real mesh doesn't. The "28 %" forest figure was measured at shrink 0.25 with trunks included (`tables.md:134`). The "solid" rule that excludes thin things was never measured, and the forest at shrink 0 had 773 false occlusions. Box proxies cull as well as ~100-triangle proxies (14,507 against 14,508) at a third of the cost. Change: run real stand-ins and inset OBB proxies against the 1080p oracle, over more than 8 frames, as a gate.

13. **0447, minor: Rust over TypeScript is unmeasured.** SIMD triples the raster stage, but whole-frame gains are 1.9× (city boxes) and 1.2-1.4× (forest) (README §1). The ADR cites the raster figure. A TypeScript port of the scalar reference, timed in Chromium, would decide it. The animation core's build infrastructure lowers the cost of the Rust choice.

14. **0447, minor: occlusion defaults on.** It costs ~1.2 ms where it culls little (forest: 28 %). Reusing last frame's buffer costs ~0.3 ms (test only). Back off automatically when the culled share stays low.

## The cheapest credible alternative

**0446.** Wave A only, as above: the engine-side bounds, per-view selection and thin per-cascade compaction. Ship small-object culling and hard LOD switches next, and crossfade after. Cost: the code 0446 needs anyway. Loses: crossfade, skinned LOD and the authoring UI, for a while. The thin-batch shadow fix (173.6M triangles) needs no levels at all. The Babylon route (issue 6) for `auto` batches would remove the hide/restore code.

**0447.** Occlusion for `auto` batches only, with inset box occluders, after 0446. Cost: about half the ADR, since there are no sloppy stand-ins and no editor debug view in v1. Loses: culling behind detailed non-box occluders and any gain on thin batches. Babylon's occlusion queries are not an alternative here: queries run per `Mesh.render` (`mesh.pure.js:2122`), and this engine draws `auto` instances through a hidden source (`meshBatches.ts:187`) and thin ones through one source. A query culls a whole batch, never an instance. The ADR's rejection stands, for that reason.

## When the premise is wrong

**0446.**
- The frame is not vertex-bound on real GPUs. Evidence: on a real GPU and on the Android emulator, frame time with all groups forced to level 0 against the oracle run. Every raster number so far is SwiftShader.
- The frame is bound by per-object CPU cost, where LOD does nothing. Evidence: thin is already 2× faster, and LOD adds +9 % on thin. Profile the 24.8 ms thin frame.
- Typical Myco scenes are small. Evidence: a triangle census of real projects.
- Hard-edged assets dominate. Evidence: reached ratios in the import report on real models.

**0447.**
- Scenes are open or foliage-heavy (28 % of culls, less with thin occluders removed). Evidence: cull share on a representative scene.
- After LOD the residual is small (issue 10). Evidence: "lod" against "both" on the real pipeline.
- Real stand-ins cause false occlusions. Evidence: the gate in issue 12.

## Questions for the author

1. Does the geometry pass (AO, DoF) see the hidden set today? If not, how?
2. Was `customLODSelector` considered with instances, and why was the Babylon route not spiked?
3. Which batch mode will real projects use? If `thin`, what is occlusion for?
4. Is the 0.02 cull the real source of the CPU win? Can a "cull only" row be added?
5. What is the draw-call budget at the Android floor?
6. Can a real-GPU frame time be measured before wave B?
