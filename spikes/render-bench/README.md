# Render bench: forest and city scenes, with LOD and occlusion oracles

A measurement spike, not engine code. It builds two benchmark scenes (generated Myco projects), records the baseline
cost of drawing them through the real engine (`launchGame`, the Babylon renderer, the default quality tier), and
measures **oracle upper bounds** on what mesh LOD and CPU occlusion culling could save. It does not design either
feature. Nothing outside `spikes/render-bench/` was touched.

Every number below is from `results.json`, `crosscheck.json` and `validation/validation.json` in this folder.
**Unmeasured numbers are marked (est.), unverified claims [U].**

## Files

| file | what |
|---|---|
| `run.mjs` | the runner: one command; installs/generates/builds if needed, runs the matrix, writes `results.json` |
| `generate.mjs`, `gen/` | deterministic generator of the four projects (+ an `unlit` flavour for pixel validation) into `generated/` (not committed) |
| `bench.html`, `bench.ts`, `vite.config.ts` | the harness page: loads a project like the player does, owns the frame loop, applies camera pose / LOD / visibility, times frames, runs the object-ID pass |
| `glhook.js` | injected WebGL hook: exact per-frame draw-call and triangle counts, bucketed by pass |
| `validate.mjs` | pixel validation of the oracles (one real frame each); writes `validation/` |
| `report.mjs` | prints the markdown tables below from the result files |
| `results.json`, `crosscheck.json`, `validation/` | the data behind this README |

## The scenes

Both are generated, seeded (`generate.mjs`), written as OBJ + MTL + material assets + `myco.scene@5` JSON. Each tree/building
is one model with two material groups (trunk/leaf, wall/window), drawn by one `MeshRenderer` with a `materials` slot list.
A directional light with shadows and an ambient light; camera 60 degree vertical FOV, near 0.1, far 1000; project default
graphics tiers (tier "High": MSAA, shadows "high" (2048 x 2048 shadow viewport), 3 cascades to 80 m).

* **Forest**: 4,000 trees (4 variants, 6,296 / 7,816 / 9,456 / 10,296 triangles), 6,000 rocks (3 variants, 3,024 / 3,968 /
  5,040), on a 400 m x 400 m ground plane (jittered grids, random yaw, scale 0.8-1.3 trees, 0.6-1.6 rocks). Camera 1.7 m high at the
  near edge, looking across (7,558 of the 10,000 objects are inside the frustum). 10,004 nodes.
* **City**: 12 x 12 blocks (80 m pitch, 20 m streets), 4 buildings a block = 576 buildings (6 variants, 2,172-4,716 triangles, window
  boxes on every side) plus 5,000 props along the streets (2 cars 2,880 / 3,708, bench 2,592, lamp post 1,680, bin 1,296).
  Camera 1.7 m high at the end of a 960 m street, looking down it. 5,580 nodes.
* **Two instancing variants** of each: every material asset with `instancing` `auto` (an `InstancedMesh` per renderer, per-instance
  culling) or `thin` (one thin-instance buffer per batch). Ground and road are single renderers.
* LOD levels are made at generation time with `meshoptimizer` 0.22 (`MeshoptSimplifier.simplify`, per material part, ratios 0.5 /
  0.25 / 0.1): `models/<name>_lod1..3.obj`. Every level hit its target triangle count to within a triangle or two (`generated/mesh-stats.json`).
* One camera path per scene (`bench.json`): 10 s of travel, rendered as 100-300 frames at a fixed step (see below), through
  the forest / down the street and round a corner.

## How things are measured, and what they mean

* **Draw calls, triangles (exact).** `glhook.js` wraps every `drawElements*/drawArrays*` of the page's WebGL2 context and sums
  `count/3 x instances` per frame, bucketed by framebuffer and viewport size. Buckets: *main* = the 1280 x 720 viewport (the MSAA scene
  target plus the 1-draw canvas blit); *shadow* = the square 2048 x 2048 framebuffer viewports (3 cascades); *other* = anything else
  (zero draws in every baseline row). The bucket split is by viewport size, an assumption that held in every frame [U beyond these two scenes].
  **Cross-check:** Babylon's own `scene.getActiveIndices() / 3` equals the hook's per-frame triangle total (forest/city, auto/thin,
  differences of 2 triangles; table below).
* **Active meshes.** Not reported: `scene.getActiveMeshes()` is already cleared when `engine.step()` returns (length 0). The number
  of objects in the frustum is given by the occlusion pre-pass instead (bounding-sphere vs frustum test of my own).
* **CPU time of the JS frame (`cpuMs`)** = wall time of `engine.step(dt)` around `performance.now()`: transform propagation, render
  sync (batching, culling), Babylon's `scene.render` up to command submission. The harness owns the loop (no `engine.start()`), so
  nothing else is inside the timing. The oracle's own bookkeeping (distance maths, setting `mesh` / `setActive`) is timed
  apart (`oracleBookkeepingMs`, 0.3-1.1 ms p50) and excluded; the engine's cost of *reacting* to those changes is inside `cpuMs`.
  `updateMs`/`renderMs` come from the engine's own timing hook; render is 99% of the step.
* **Two measurement modes** (why: one software-GL frame of the baseline forest takes 47 s, so 300 frames x 5 runs of real
  rendering is days):
  * **cpu mode**: the hook counts draw calls but does **not issue them** (`gl.draw*` skipped, no raster work, no GPU backpressure).
    That is exactly the engine's CPU frame; the counts are the draws it *would* issue. Lots of frames: runs x frames in the tables.
    Frame wall time in this mode is just CPU time plus rAF cadence and is not reported as a result.
  * **raster mode**: real draws on SwiftShader; the frame time is the rAF-to-rAF wall time of the measured frame, i.e. CPU + software
    raster + compositing. A few frames only. **This is a software rasteriser on this machine's shared 4 cores; its absolute numbers say
    nothing about a phone GPU.** What it is good for: relative changes (triangle count and overdraw reduce raster time here), and
    shader/pipeline cost *as SwiftShader sees it*. A real GPU's relative gain from LOD/occlusion would differ (fixed per-draw and
    per-pass costs, tile-based deferred rendering on mobile, vertex vs fragment bound) [U].
* **Warm-up.** 60+ frames with draws skipped until the per-frame draw count is identical for 10 frames (batches and pipelines settle:
  the draw count falls from 51+19 to 33+12 in the first ~20 frames); raster mode then adds 2 real warm-up frames.
* **4x CPU throttle (est.)**: CDP `Emulation.setCPUThrottlingRate` rate 4, applied after the page has loaded. It slows the page's
  main thread only. The observed JS slowdown was **4.7-6.6x** (forest auto baseline 52.6 -> 346 ms) rather than 4x, because the machine was shared
  and loaded; treat the 4x column as a labelled stand-in for the Android floor (ADR 0169, Pixel 8 / Chrome 113), not a prediction [U]: how
  JS time on that device relates to this x86 core under throttling is not measured.
* **Camera path (fly-through)**: 10 s of path divided into the run's frames (150 or 80 here; 300 in the full profile) at a fixed
  `dt = 1/30`; the camera pose is set from the path before each step.
* **Machine**: 4 cores shared with other agents (load average about 3.4-5.7 during the runs), headless Chromium 158.0.8127.36 on
  ANGLE/SwiftShader (Vulkan) WebGL2, viewport 1280 x 720, devicePixelRatio 1, launch flags `--disable-gpu-vsync
  --disable-frame-rate-limit`. Timings are smoke-test grade; rerun on an idle machine.

### The oracles

* **LOD oracle.** Each frame, for each renderer: bounding sphere of its model (AABB-sphere of the baked vertex data x node scale) ->
  screen-height fraction `h = R / (d tan(fov/2))`; level 0 above 0.5, level 1 (0.5 triangles) from 0.5 down to 0.25, level 2 (0.25) down
  to 0.1, level 3 (0.1) down to 0.02, **culled below 0.02**. The swap is `MeshRenderer.mesh = <level asset>` (and `GameObject.setActive(false)`
  for culled), only when the level changes. Rows "lod, no cull" drop the 0.02 cull (it is aggressive: it removes every rock beyond ~52 m).
  There is no cross-fade and no hysteresis; the levels' error was not checked beyond the pixel diff below.
* **Occlusion oracle.** A pre-pass renders, in a second WebGL context at 1280 x 720, an **object-ID pass** with the full-resolution
  (LOD 0) geometry, the engine's own baked vertex data and node world matrices and the engine camera's projection (the view matrix
  is validated against the engine's real camera first), depth-tested, no culling, then reads the pixels back. An object is
  **visible** if at least one pixel carries its ID; the others are hidden with `GameObject.setActive(false)`. Static pose: one pass.
  Fly path: 26 poses (every 4% of the path); a frame hides objects not visible in either bracketing pose. A hidden object also
  leaves the **shadow pass**, which a real culler could not do unless it also proved the shadow invisible, so the occlusion savings
  below are an upper bound that includes shadow-caster culling [U: how much of it a conservative implementation keeps].
* **Both** = occlusion first (from LOD 0 geometry), LOD on the survivors.

### What the oracles are not

They cost nothing to decide (a real software occlusion rasteriser costs CPU every frame; not measured here), they are exact (no
conservative bounds, no one-frame latency, no popping), their LOD thresholds are the ones given (not tuned), and the
visibility set for a flythrough frame is a union of two exact poses (slightly pessimistic for the saving, slightly optimistic
about latency). The engine's cost of churn (`setActive`, `mesh` changes) is real and shows in the fly-through rows.

## Results

Smoke-grade: loaded shared machine; cpu-mode rows are 3 runs x 150 frames at 1x, 1 run x 80 frames at 4x; raster rows are 1 run x 2
frames (so p50 = one of two samples). The runner's default profile (5 runs x 300 frames) was **not** run in full: see "How long the
full run takes". p99/max over 450 (1x) or 80 (4x) frames are weak statistics; per-run spreads are in `results.json` (`perRun`).

profile: {"runs":3,"frames":150,"warmup":60,"throttles":[1],"smoke":false,"raster":true,"rasterRuns":1,"rasterFrames":2,"rasterWarmup":2}  renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)

### Baseline (static camera)

| scene | instancing | draw calls (main/shadow/other) | triangles (main/shadow) | JS submit span main / shadow ms | JS CPU ms p50 / p99 / max, 1x | JS CPU ms, 4x (est.) | raster frame ms (SwiftShader) |
|---|---|---|---|---|---|---|---|
| forest | auto | 46 (13/33/0) | 61.37M (44.25M/17.12M) | 3.9 / 7.9 | 52.6 / 78.3 / 89.3 | 346.0 / 439.3 / 439.3 | 47501 (n=2) |
| forest | thin | 46 (13/33/0) | 231.47M (57.87M/173.60M) | 0.1 / 0.2 | 24.8 / 48.0 / 52.5 | 140.2 / 216.7 / 216.7 | - |
| city | auto | 68 (24/44/0) | 10.35M (9.67M/0.68M) | 3.8 / 4.7 | 41.8 / 65.6 / 68.1 | 225.4 / 283.1 / 283.1 | 10171 (n=2) |
| city | thin | 90 (24/66/0) | 52.40M (13.10M/39.30M) | 0.2 / 0.2 | 19.5 / 29.3 / 32.0 | 93.3 / 166.6 / 166.6 | - |

### Oracles (static camera; deltas vs baseline of the same row group)

| scene | instancing | oracle | triangles | draw calls | JS CPU ms p50 (1x) | JS CPU ms p50 (4x est.) | raster ms | hidden by occlusion | culled by LOD |
|---|---|---|---|---|---|---|---|---|---|
| forest | auto | baseline | 61.37M (0%) | 46 (0%) | 52.6 (0%) | 346.0 (0%) | 47501 (0%) | 0 | 0 |
| forest | auto | lod | 6.61M (-89%) | 133 (+189%) | 40.2 (-24%) | - | 6636 (-86%) | 0 | 5338 |
| forest | auto | occlusion | 5.87M (-90%) | 46 (0%) | 32.6 (-38%) | - | 4952 (-90%) | 9532 | 0 |
| forest | auto | both | 1.51M (-98%) | 125 (+172%) | 33.9 (-36%) | 174.5 (-50%) | 2156 (-95%) | 9532 | 74 |
| forest | auto | lod, no cull | 8.63M (-86%) | 133 (+189%) | 66.2 | - | - | 0 | 0 |
| forest | thin | baseline | 231.47M (0%) | 46 (0%) | 24.8 (0%) | 140.2 (0%) | - | 0 | 0 |
| forest | thin | lod | 19.42M (-92%) | 172 (+274%) | 27.0 (+9%) | - | - | 0 | 5338 |
| forest | thin | occlusion | 11.55M (-95%) | 46 (0%) | 24.9 (+0%) | - | - | 9532 | 0 |
| forest | thin | both | 2.38M (-99%) | 161 (+250%) | 28.0 (+13%) | 143.6 (+2%) | - | 9532 | 74 |
| city | auto | baseline | 10.35M (0%) | 68 (0%) | 41.8 (0%) | 225.4 (0%) | 10171 (0%) | 0 | 0 |
| city | auto | lod | 0.49M (-95%) | 144 (+112%) | 27.7 (-34%) | - | 1116 (-89%) | 0 | 4625 |
| city | auto | occlusion | 0.44M (-96%) | 64 (-6%) | 23.6 (-44%) | - | 857 (-92%) | 5463 | 0 |
| city | auto | both | 0.10M (-99%) | 97 (+43%) | 24.3 (-42%) | 113.4 (-50%) | 564 (-94%) | 5463 | 40 |
| city | auto | lod, no cull | 1.28M (-88%) | 144 (+112%) | 38.6 | - | - | 0 | 0 |
| city | thin | baseline | 52.40M (0%) | 90 (0%) | 19.5 (0%) | 93.3 (0%) | - | 0 | 0 |
| city | thin | lod | 1.95M (-96%) | 248 (+176%) | 21.2 (+9%) | - | - | 0 | 4625 |
| city | thin | occlusion | 0.85M (-98%) | 68 (-24%) | 19.0 (-3%) | - | - | 5463 | 0 |
| city | thin | both | 0.12M (-100%) | 101 (+12%) | 19.9 (+2%) | 94.6 (+1%) | - | 5463 | 40 |

### LOD level occupancy (static camera, LOD oracle with cull): objects per level L0/L1/L2/L3, culled

- forest: 30 / 79 / 550 / 4003, culled 5338
- city: 14 / 48 / 258 / 631, culled 4625

### Fly-through (10 s equivalent path, JS CPU frame ms; draw calls / triangles are per-frame medians and maxima)

| scene | variant | throttle | frames | CPU p50 | CPU p99 | CPU max | draws med / max | tris med / max |
|---|---|---|---|---|---|---|---|---|
| forest | auto baseline | 1x | 3x150 | 64.8 | 101.2 | 106.6 | 46 / 46 | 48.14M / 62.35M |
| forest | auto baseline | 4x (est.) | 1x80 | 337.5 | 429.6 | 429.6 | 46 / 46 | 48.03M / 62.28M |
| forest | thin baseline | 1x | 3x150 | 29.3 | 55.1 | 61.4 | 46 / 46 | 231.47M / 231.47M |
| forest | thin baseline | 4x (est.) | 1x80 | 137.8 | 240.0 | 240.0 | 46 / 46 | 231.47M / 231.47M |
| forest | auto both | 1x | 3x150 | 47.9 | 81.8 | 89.2 | 124 / 139 | 2.22M / 2.54M |
| forest | auto both | 4x (est.) | 1x80 | 229.0 | 359.4 | 359.4 | 124 / 138 | 2.20M / 2.54M |
| city | auto baseline | 1x | 3x150 | 40.9 | 60.0 | 62.6 | 76 / 86 | 6.94M / 10.35M |
| city | auto baseline | 4x (est.) | 1x80 | 210.2 | 329.2 | 329.2 | 76 / 86 | 6.93M / 10.35M |
| city | thin baseline | 1x | 3x150 | 19.5 | 37.9 | 40.7 | 90 / 90 | 52.40M / 52.40M |
| city | thin baseline | 4x (est.) | 1x80 | 91.6 | 166.5 | 166.5 | 90 / 90 | 52.40M / 52.40M |
| city | auto both | 1x | 3x150 | 27.1 | 44.9 | 48.1 | 111 / 149 | 0.12M / 0.16M |
| city | auto both | 4x (est.) | 1x80 | 133.2 | 243.9 | 243.9 | 111 / 151 | 0.12M / 0.15M |

### Occlusion pre-pass (object-ID pass, 1280x720, full-resolution geometry)

- forest: static pose 7558 objects in frustum, 468 with visible pixels, 7090 occluded = 93.8%; fly path (26 poses) occluded % min 72.3 / median 89.3 / max 97.8; pass took 151 s
- city: static pose 4115 objects in frustum, 113 with visible pixels, 4002 occluded = 97.3%; fly path (26 poses) occluded % min 93.2 / median 96.7 / max 99.8; pass took 26 s

### Cross-check: WebGL-hook triangle total vs Babylon's own scene.getActiveIndices()/3 (median per frame)

| config | hook | Babylon |
|---|---|---|
| forest-auto-static-baseline | 61369916 | 61369914 |
| forest-thin-static-baseline | 231469508 | 231469506 |
| city-auto-static-baseline | 10346188 | 10346186 |
| city-thin-static-baseline | 52401604 | 52401602 |

### Pixel validation (one real SwiftShader frame, unlit flavour of each scene, static camera)

| scene | oracle | non-sky pixels in baseline | silhouette pixels differing | pixels differing by >8/255 | mean abs diff |
|---|---|---|---|---|---|
| forest | occlusion | 918003 | 0 | 138 (0.015%) | 0.008 |
| forest | lod | 918003 | 4 | 1837 (0.199%) | 0.066 |
| city | occlusion | 889131 | 18 | 133 (0.014%) | 0.005 |
| city | lod | 889131 | 1151 | 9742 (1.057%) | 0.51 |

(Rows whose 4x cell is "-" were not run at 4x. `hidden by occlusion` counts every renderer not visible in the ID pass, including
those outside the frustum; the in-frustum figures are in the pre-pass section. `culled by LOD` counts renderers culled that the
occlusion oracle had not already hidden.)

## What the numbers say

All of these are measured in this folder's data unless marked.

1. **Baseline cost is dominated by triangle count that nobody sees.** Forest: 61.4 M triangles a frame (44.3 M main + 17.1 M shadow) in
   46 draw calls; city: 10.3 M (9.7 M + 0.7 M) in 68. Draw calls are tiny because instancing batches by model and material;
   the cost is triangles and per-instance CPU work (JS CPU 52.6 ms forest auto, 41.8 ms city auto at 1x; 346 ms and 225 ms under the
   4x throttle (est.)). The shadow pass is 72% of the forest's draw calls (33 of 46) but 28% of its triangles; with `thin` it is 75% of
   the triangles (below).
2. **`thin` instancing disables per-instance culling, and that makes the GPU side 3.8-5x worse.** A thin batch is culled as one
   mesh whose bounds cover every instance, so all 10,000 forest objects are drawn in the main pass (57.9 M triangles) and again in
   every one of the 3 shadow cascades (173.6 M): **231.5 M triangles a frame** versus 61.4 M with `auto`. City: 52.4 M versus 10.3 M.
   It halves the JS CPU (24.8 vs 52.6 ms forest, 19.5 vs 41.8 ms city). Anything that wants LOD or occlusion
   savings from `thin` batches needs per-instance decisions made on the CPU, which `thin` currently has none of.
3. **LOD oracle.** Triangles -89% (forest auto; -86% without the 0.02 cull), -92% (forest thin), -95%/-96% (city auto/thin). Most of
   the forest is far away: of the 10,000 renderers, 30 are level 0, 79 level 1, 550 level 2, 4,003 level 3, and 5,338 are culled below
   0.02 (this includes ones outside the frustum, and most are probably rocks [U]). **Draw calls rise**: 46 -> 133 (+189%) forest auto, 68 -> 144 city auto, because a batch
   exists per (level, material slot): LOD multiplies batches (a design cost to watch against a draw-call-bound mobile target). JS CPU
   is -24% (forest auto) and -34% (city auto) at 1x because far fewer instances are visible; with `thin` it is +9% (more batches, nothing
   to cull per instance). The 0.02 cull removes 5.3 k forest objects; the pixel diff shows LOD itself changes about 1% of the
   city picture (below).
4. **Occlusion oracle.** From eye level the forest hides almost everything: at the static pose **93.8%** of the 7,558 objects in the
   frustum have zero visible pixels (468 visible); along the path the share is 72-98% (median 89%). City street view: **97.3%** of
   4,115 (113 visible); 93-100% along the path. Triangles -90% (forest auto), -95% (forest thin), -96% / -98% (city auto/thin). Draw calls
   do not fall (instancing already batches them: 46 -> 46 forest, 68 -> 64 city auto), so the saving is triangles and instances.
   JS CPU: -38% (forest auto), -44% (city auto) at 1x; **no change with `thin`** (24.9 vs 24.8 ms). Because the oracle also removes
   hidden shadow casters, part of this is shadow-caster culling that a real implementation may not get [U].
5. **Both** (occlusion from LOD 0, LOD on the survivors): triangles -98% forest auto (1.51 M), -99% city auto (0.10 M), -99% forest thin.
   Draw calls still +172% / +43% over baseline (batches per level). JS CPU -36% forest / -42% city at 1x, **-50% at the 4x throttle
   (est.)** in both scenes (forest 346 -> 174.5 ms, city 225 -> 113 ms): the frame is CPU-bound on per-instance work on this stack.
6. **Raster time on SwiftShader (n = 2 frames, one run; only for relative size).** Forest auto baseline 47.5 s a frame; LOD 6.6 s (-86%),
   occlusion 5.0 s (-90%), both 2.2 s (-95%); LOD without cull 8.1 s. City auto 10.2 s; LOD 1.1 s (-89%), occlusion 0.86 s (-92%), both
   0.56 s (-94%); LOD without cull 2.1 s. In this software setup raster time tracks triangle count (about 1.3 and 1.0 M triangles
   a second at baseline); a GPU would not behave like this [U].
7. **Fly-through (p99 behaviour, CPU frame).** Forest auto baseline p50 64.8 / p99 101.2 / max 106.6 ms (1x), 337.5 / 429.6 (4x est.);
   with both oracles 47.9 / 81.8 / 89.2 ms, 229 / 359 (4x est.). City auto baseline 40.9 / 60.0 / 62.6 ms; both 27.1 / 44.9 / 48.1 ms. So the
   oracles move the p50 by -26% / -34% but p99 only by -19% / -25%, and flying costs more than standing still (forest auto "both":
   47.9 ms flying vs 33.9 static, +41%): changing `mesh` and `active` on many renderers a frame is not free in this engine (that cost is
   inside `cpuMs`; the oracle's own bookkeeping, 0.9-1.1 ms, is not). Triangles in flight: the forest's baseline median is 48 M, max 62 M.
8. **Validity (pixels).** Unlit flavour of each scene, one real frame at the static pose: hiding the occlusion oracle's objects changes
   **0** silhouette pixels in the forest (18 in the city) and 0.015% / 0.014% of the pixels by more than 8/255 (mean difference 0.008 /
   0.005 of 255): hidden objects really are not visible. The LOD oracle changes 0.2% of the forest picture and 1.06% of the city's
   (mean 0.07 / 0.5 of 255) with these thresholds.

## Caveats and things not verified

* **Lit shading renders black under SwiftShader here [U cause].** In captures of the lit scenes the geometry's coverage is right but the
  shaded colour is black (a lit occlusion-variant capture once came out correctly shaded; not reproduced). Materials report ready,
  no shader compile errors, the sun and ambient lights are enabled, the environment texture is present, and the unlit flavour renders
  correctly (`validation/*.png`). Pixel validation therefore uses the unlit projects. Consequence: the raster-mode times of the
  lit scenes may understate the shading cost of a correct frame; draw calls, triangles and JS CPU are unaffected. I did not find the
  cause (SwiftShader precision, the engine's cascaded-shadow set-up for a far camera, and an async prefiltered-environment race were
  all considered; none was tested to a conclusion).
* **Statistics.** CPU-mode rows are 3 runs x 150 frames (1x) or 1 x 80 (4x); raster rows 1 run x 2 frames. p99 and max over 450 or 80
  frames are indicative only; per-run p50s differ by up to ~10% (forest auto baseline 50.6 / 50.3 / 55.1 ms).
* **4x throttling** is main-thread only, applied after load, measured on a loaded machine (4.7-6.6x observed slowdown); the mapping to a
  Pixel 8 is not established [U].
* **Triangle counts include everything drawn** (shadow cascades, the final canvas blit's 2 triangles); the `main` / `shadow` split is by
  viewport size [U beyond these scenes]. The `thin` shadow count assumes the engine's thin batches cast shadows as one mesh
  (stated in `meshBatches.ts`; the 3 x 57.87 M = 173.6 M figure agrees).
* **The oracle LOD thresholds** (0.5 / 0.25 / 0.1, cull 0.02, sphere diameter over screen height) are my reading of the brief; Unity's
  definition of an object's screen size differs in detail from a bounding sphere's diameter, so real thresholds would shift [U].
* **No Android, no real GPU.** Nothing here was run on either. SwiftShader draws the High tier's MSAA scene target at 1280 x 720 on CPU.
* The object-ID pass reads the engine's baked model data and world matrices, so it assumes those are what Babylon draws; the unlit pixel
  comparison (silhouette 0 px, colour 0.015%) is the check that it is.

## How long the full run takes

Measured on this loaded 4-core machine: cpu mode ran 15,120 frames (24 configs x 3 runs x (150 + 60 warm-up)) in 10.4 min of page time,
33 min wall including 72 page loads and the pre-passes; the 4x rows (14 configs, 1 run x 80 frames) took about 10 min; the raster rows
(10 configs, 1 run, 2 + 2 frames) about 5 min (the forest baseline's four frames are most of it). Extrapolating to the default profile on an idle machine [est.]:

| part | what | estimate |
|---|---|---|
| cpu mode, 1x | 24 configs x 5 runs x (300 + 60) frames | about 45 min |
| cpu mode, 4x | the same at about 5x per frame | about 3 h |
| raster mode | 18 static configs x 5 runs x (10 + 2) frames; baseline frames are 47 s (forest auto), minutes with `thin` (231 M triangles) | about 6-8 h |

`node spikes/render-bench/run.mjs --raster off` is about 4 h. `--raster-runs 2 --raster-frames 3 --raster-only -auto-static-` adds about
an hour. Row ids make `--resume` continue a stopped run. The spec's "300 frames per run" is met in cpu mode only; real draws cannot be
run 300 times per configuration on a software rasteriser.

Reproduce this folder's data (what I ran):

```
node spikes/render-bench/run.mjs --runs 3 --frames 150 --throttles 1 --raster off
node spikes/render-bench/run.mjs --runs 1 --frames 80 --throttles 4 --raster off --only baseline --resume
node spikes/render-bench/run.mjs --runs 1 --frames 80 --throttles 4 --raster off --only both --resume
node spikes/render-bench/run.mjs --runs 3 --frames 150 --throttles 1 --raster on --raster-runs 1 --raster-frames 2 --raster-only -auto-static- --resume
node spikes/render-bench/run.mjs --only static-baseline --runs 1 --frames 40 --throttles 1 --raster off --results crosscheck.json
node spikes/render-bench/validate.mjs
node spikes/render-bench/report.mjs
```

Needs: Node 22, the repo's `node_modules` (symlink it in a worktree), Playwright with a Chromium it can launch (the runner falls back to
`/opt/node-tools` when the repo's Playwright wants a newer browser build than is installed), network for `npm install` of `meshoptimizer`
(spike-local `package.json`). The harness build writes the usual Vite transpile cache under the repo's `node_modules/.cache`.
