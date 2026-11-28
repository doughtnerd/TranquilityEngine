# Occlusion gate: does occlusion still pay with the engine's LOD on? (ADR 0447 section 0)

A measurement spike, not engine code. It adapts `spikes/render-bench/` (same generated forest and city, same seeds, camera poses, WebGL
draw hook, object-ID occlusion oracle) and replaces its LOD oracle with the **engine's real LOD** (ADR 0446). Nothing outside
`spikes/occlusion-gate/` was touched.

**All numbers below are SMOKE-LEVEL**: 3 runs x 30 frames (static) / 40 frames (fly) on a loaded shared 4-core machine (load average 6.3-7.2),
SwiftShader. The coordinator's idle re-run (`node spikes/occlusion-gate/run.mjs`, 3 runs x 100/150 frames) supersedes them. Unverified: **[U]**.

## The gate

> With LOD on, an oracle that hides occluded objects from the main view only and keeps their shadow casters must save at least twice the
> measured occlusion cost (about 1.2 ms per view in Chromium), i.e. **2.4 ms**, in JS CPU, or show a GPU triangle saving worth that cost.

## Files

| file | what |
|---|---|
| `run.mjs` | the runner (expected duration at its head); writes `results.json`; `--profile smoke`, `--runs`, `--frames`, `--fly-frames`, `--throttles 1,4`, `--scenes`, `--only`, `--resume` |
| `generate.mjs`, `gen/` | the render-bench projects, `auto` instancing, rebuilt as `forest-auto-lod` and `city-auto-lod` (sidecar `lod` + an `LODGroup` per object; no simplified OBJs) into `generated/` (not committed) |
| `bench.html`, `bench.ts`, `vite.config.ts` | the harness page: loads the project via `launchGame`, owns the frame loop, applies the pose and the occlusion oracle, times `engine.step` |
| `glhook.js` | WebGL hook: exact draw calls and triangles per frame, bucketed main (1280x720) / shadow (square framebuffers); plus a per-bucket checksum of every draw's arguments |
| `report.mjs` | prints the tables below and the gate arithmetic from `results.json` |
| `results.json` | the data behind this README (per-run spreads, per-frame shadow fingerprints) |

## Method

* **Scenes, tier, camera:** forest (4,000 trees + 6,000 rocks) and city (576 buildings + 5,000 props), `auto` instancing, tier High (MSAA, shadows
  "high", 3 cascades to 80 m), 1280x720, static camera and the 10 s fly-through (fixed `dt` = 1/30). As in the spike, **cpu mode**: draw calls are
  counted but not issued, so the frame time is the engine's JS CPU (`engine.step`); draw and triangle counts are exact. Each run is a fresh browser
  context; settle until the draw count is stable for 10 frames; in fly mode a dry pass over the whole path first, so level drawables already exist.
* **LOD is the engine's:** every model has a sidecar `lod` (the import panel's defaults: levels 0.5 / 0.25 / 0.125, `permissive` for buildings: as
  `tests/e2e/render-bench/scenes.ts`) and every object an automatic `LODGroup`. The editor's LOD host is installed inline (`setLodHost` with
  `generateLods`), so levels are generated as models load (not timed); the visibility service then selects levels per view (main camera and the
  shadow views). Levels generated: trees and rocks 1 / 0.5 / 0.25 / 0.125 of LOD0; buildings mostly **do not simplify** (bld0-2 keep 2,172-3,468
  triangles at every level; bld3 4,716 -> 3,148 at the last); cars, bins, lamps, benches about 1 / 0.52 / 0.28 / 0.14 (`results.json`, `pageInfo.lodLevelTris`).
* **Occlusion oracle (the same for both variants):** the spike's object-ID pass (second WebGL context, full-resolution LOD0 geometry, engine camera
  matrices): an object with zero visible pixels is occluded. Static pose: one pass; fly path: 26 poses, a frame hides objects not visible in either
  bracketing pose (exact, zero latency, costs nothing to decide).
* **Casters kept, method (config `lod+keep`):** the engine's own per-view mechanism, not a hack on Babylon. After the visibility service selects the main
  view, a `world._afterPropagation` hook (registered after the service's own, so it runs after it) writes `hidden[slot] = 1` into the **main view's
  `VisibilityResult`** for each occluded renderer. That is the slot ADR 0447 section 4's occlusion stage writes (`LodVisibility "occluded"`). In
  `babylon/meshes.ts` `prepareViews` the renderer skips a hidden slot for that view only, and shadow casters come from the main result's
  `casterLevels` ("hidden ones still cast"), which the hook does not touch; shadow-cascade views are separate results. (A `layerMask` approach was not
  needed.) The hook's own time (`hookMs`, microseconds: below the timer's 0.1 ms resolution) is subtracted from the reported JS CPU anyway.
* **Casters removed (config `lod+remove`):** the spike's old method, `GameObject.setActive(false)` on the occluded objects, which also takes them out of
  the shadow pass.
* **Verification that casters are kept:** the hook records, for every shadow-pass frame, (triangles, draw calls, an order-sensitive checksum of every
  draw's mode, count and instance count). `lod+keep` equals `lod` in **every measured frame** (static 30/30, fly 40/40, both scenes; run 0 of each) and
  `lod+remove` in none; shadow triangles are identical to the digit (city 0.249M, forest 7.053M static). **Pixel check of the shadows not done [U]**:
  the lit scenes render black under this SwiftShader (the render-bench README's caveat), so shadow pixels can't be compared here; identical shadow
  submissions (same casters at the same levels, same instance counts) are the evidence instead.

## Results (smoke-level)

JS CPU = `engine.step` minus the oracle's own write; p99/max over 90-120 frames are weak statistics (a single 30-frame run's p99 is its max). Draws and
triangles are per-frame medians; "shadow" is the sum of the shadow cascade passes. `hidden` is the oracle's count (includes objects outside the frustum).

| scene | path | config | runs x frames | JS CPU ms p50 / p99 / max | draws (main/shadow) | triangles total | main | shadow | hidden by occlusion | LOD-culled groups |
|---|---|---|---|---|---|---|---|---|---|---|
| forest | static | lod | 3 x 30 | 118.1 / 182.9 / 182.9 | 115 (46/69) | 14.957M | 7.904M | 7.053M | 0 | 3484 |
| forest | static | lod+keep | 3 x 30 | 98.6 / 182.5 / 182.5 | 111 (42/69) | 8.373M | 1.320M | 7.053M | 9532 | 3484 |
| forest | static | lod+remove | 3 x 30 | 55.1 / 126.9 / 126.9 | 107 (42/65) | 3.018M | 1.320M | 1.698M | 9532 | 9 |
| forest | fly | lod | 3 x 40 | 194.5 / 421.0 / 466.8 | 140 (67/71) | 16.197M | 7.404M | 8.434M | 0 | 2112 |
| forest | fly | lod+keep | 3 x 40 | 153.3 / 518.5 / 754.2 | 136 (63/71) | 11.078M | 2.680M | 8.434M | 9272 | 2112 |
| forest | fly | lod+remove | 3 x 40 | 80.2 / 122.2 / 145.9 | 138 (69/67) | 4.289M | 2.271M | 2.016M | 9272 | 8 |
| city | static | lod | 3 x 30 | 46.6 / 83.1 / 83.1 | 100 (32/68) | 1.820M | 1.571M | 0.249M | 0 | 3604 |
| city | static | lod+keep | 3 x 30 | 43.5 / 102.7 / 102.7 | 100 (32/68) | 0.387M | 0.138M | 0.249M | 5463 | 3604 |
| city | static | lod+remove | 3 x 30 | 33.0 / 64.8 / 64.8 | 78 (32/46) | 0.207M | 0.138M | 0.069M | 5463 | 15 |
| city | fly | lod | 3 x 40 | 62.4 / 117.4 / 125.5 | 112 (52/62) | 1.363M | 1.046M | 0.319M | 0 | 2866 |
| city | fly | lod+keep | 3 x 40 | 52.5 / 99.5 / 108.1 | 108 (48/62) | 0.435M | 0.127M | 0.319M | 5468 | 2866 |
| city | fly | lod+remove | 3 x 40 | 33.2 / 65.0 / 66.5 | 94 (46/46) | 0.191M | 0.127M | 0.069M | 5468 | 11 |

Per-run p50 (ms), to see the spread: city static lod 48.3 / 45.0 / 46.5 vs keep 46.4 / 39.6 / 39.5; city fly lod 58.0 / 67.8 / 58.5 vs keep 56.9 / 53.4 / 47.0;
forest static lod 115.7 / 132.3 / 113.4 vs keep 107.9 / 104.0 / 86.3; forest fly lod 196.2 / 201.5 / 185.2 vs keep 153.7 / 153.3 / 150.5.

### Gate arithmetic (threshold 2 x 1.2 = 2.4 ms of JS CPU, p50)

| scene | path | LOD p50 | LOD+keep p50 | CPU saving (keep vs LOD) | vs 2.4 ms | main-view triangles saved | total triangles saved | casters check | for comparison: LOD+remove saving |
|---|---|---|---|---|---|---|---|---|---|
| city | static | 46.6 | 43.5 | **3.1 ms** | 2.6x the cost: passes, **thin; inside the run-to-run spread** | 1.433M (-91%) | 1.433M (-79%) | 30/30 frames identical | 13.6 ms |
| city | fly | 62.4 | 52.5 | **9.9 ms** | 8.3x: passes | 0.920M (-88%) | 0.928M (-68%) | 40/40 | 29.2 ms |
| forest | static | 118.1 | 98.6 | **19.5 ms** | 16x: passes | 6.584M (-83%) | 6.584M (-44%) | 30/30 | 63.0 ms |
| forest | fly | 194.5 | 153.3 | **41.2 ms** | 34x: passes | 4.724M (-64%) | 5.120M (-32%) | 40/40 | 114.3 ms |

p99 (keep vs LOD; 90-120 frames, indicative only): city static 83.1 -> 102.7, city fly 117.4 -> 99.5, forest static 182.9 -> 182.5, forest fly 421.0 -> 518.5 ms: **no
p99 improvement is established**; the tails are dominated by other spikes on the loaded machine.

**Verdict on these numbers (smoke-level, until the idle re-run):**

* **City: the gate passes**, narrowly on the static camera (3.1 ms against 2.4 ms; the three runs' paired differences were 1.9 / 5.4 / 7.0 ms, so one was under the bar) and clearly on the
  fly-through (9.9 ms). Main-view triangles fall 91% / 88% (1.4M / 0.9M a frame), but the shadow passes (0.25-0.32M) are untouched, so the total falls 79% / 68%.
* **Forest: the gate passes by a wide margin** (19.5 ms static, 41.2 ms fly; 16-34x the cost); main-view triangles -83% / -64%, total only -44% / -32% because the casters stay (7.1-8.4M shadow
  triangles, about half of the remaining frame).
* **GPU triangle route not measured [U]:** no GPU, no Android floor here. The exact counts above are its input; SwiftShader raster time was not run.
* The casters-kept saving is about **a third (forest) to a quarter (city static) of the casters-removed one** (LOD+remove: forest 63 / 114 ms, city 14 / 29 ms), so the spike's earlier
  numbers overstate what a conservative implementation reaches, as ADR 0447 said.

### Caveats that matter for reading the gate

1. **The oracle is an upper bound on culling quality.** It is exact (pixel-perfect, full resolution, no latency) and free. ADR 0447's spike measured the real 256x128 software buffer culling **89% of the
   city's** (the reference culls 97%) and only **28% of the forest's** reference culls (thin trunks and foliage as occluders). So the forest's wide margin is the least transferable: at 28% of the
   culls its saving would be a fraction of the oracle's (not measured here [U]). The city keeps most of its culls, but its static margin is the thinnest.
2. **One view.** The gate is per view; the oracle occludes the main view only (shadow cascades are not occlusion-culled, as the ADR says).
3. **Smoke noise.** Load average 6.3-7.2 on 4 cores; per-run p50 spreads are 5-20%. The static city margin (0.7 ms above the bar) is smaller than that spread. Rerun idle.
4. **The engine's LOD is heavy on CPU here:** forest LOD-only is 118 ms p50 (static), against 40 ms for the render-bench spike's LOD *oracle* swap (the machine is loaded, so inflated, but not 3x) [U cause:
   per-view selection, more batches (115 draws vs 46), level drawables]. The gate compares against LOD-on, as asked; fewer instances to process makes the absolute saving larger.
5. **The engine's LOD saves fewer triangles than the spike's oracle LOD in the city:** 1.57M main-view triangles (static) against the oracle's 0.49M, because the generated levels barely simplify
   the buildings (boxes with window slabs, see Method) and the engine has no 0.02 screen-height cull rule like the oracle's (3,604 groups are still LOD-culled by the engine's own rule).
6. **Per-level counts under `keep`:** `lodLevels` in `results.json` for `lod+keep` equal the LOD-only ones, because the visibility stats are computed before the oracle's hook writes `hidden`; use the triangle counts.
7. **SwiftShader (as the spike stated):** a software rasteriser on shared cores; cpu mode issues no draws, so there is no raster time and no GPU backpressure; absolute JS times are this x86 core's, not
   the Android floor's; the main/shadow split is by viewport size [U beyond these two scenes]. The lit scenes render black here (cause not found), so no pixel comparison was possible.
8. No 4x CPU-throttle rows were run (`--throttles 1,4` adds them). Browser warnings logged: "No available adapters" and a ReadPixels stall note from the occlusion pre-pass; no errors.

## How long it takes

Smoke (this folder's data): 12 configs x 3 runs, 1,980 frames in 5.7 min of page time; with 36 page loads (each loads the model and generates its LOD levels inline: about 20-40 s), builds and
the occlusion pre-passes (forest 232 s, city 35 s, cached in `generated/occlusion-<scene>.json`) about 25 min wall on the loaded machine. The default profile (3 runs x 100 static / 150 fly frames plus
a 150-frame dry fly pass) is about 4x the frames: **about 45-60 min on an idle machine [est.]**.

Reproduce:

```
node spikes/occlusion-gate/run.mjs --profile smoke --runs 3 --results smoke.json    # what this README's data is (renamed results.json)
node spikes/occlusion-gate/run.mjs                                                  # the idle re-run: 3 runs, 100 / 150 frames
node spikes/occlusion-gate/report.mjs                                               # the tables and the gate arithmetic
```

Needs: Node 22, the repo's `node_modules` (symlink it in a worktree), Playwright with a launchable Chromium (the runner falls back to `/opt/node-tools`).
