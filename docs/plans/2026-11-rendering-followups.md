# Rendering follow-ups: clustered lighting and pipeline warm-up (November 2026)

What's left after the frame-drop work of 2026-11-06 (commit `e60c9af`, branch `claude/frame-lag-gc-perf-e2fb1f`): [0079](../decisions/0079-clustered-lighting-for-point-and-spot-lights.md) (clustered lighting, built) and [0080](../decisions/0080-warm-up-shader-pipelines-on-scene-load.md) (pipeline warm-up, built on the Babylon backend). The cause, method and numbers are in [0075](../decisions/0075-babylonjs-render-backend.md)'s "Frame drops whenever a light came or went" note and 0080's "Built" section.

## Where it stands

- **The cause wasn't garbage collection.** Long frames were the GPU process compiling WebGPU pipelines: every lit material recompiled whenever the light count changed, and materials compiled on first draw mid-match. GC (60–80 MB/s of allocation) costs well under a millisecond a frame.
- **Pirates Practice match, about 70 s from the click.** Baseline is master at `dee6e13`, the Babylon-only baseline:

  | | Master | Now |
  | --- | --- | --- |
  | Frames over 100 ms after the load | 20 | 0 |
  | 99th percentile frame | 60 ms | 21 ms |
  | Pipelines compiled after 10 s | — | 2 |

- **The compile cost moved into the load:** frames of 260–520 ms over the match's first 3 s.

## Fast follow-up

- **The ripple sub-graph's UV node preview draws black** (Shader Graph panel, `samples/playground3d/shaders/ripple.shadersubgraph.json`; seen 2026-11-06 on WebGPU). The sub-graph's own preview is also a flat grey sphere, without its rings. It isn't from ADR 0081 step 3b: the WGSL for every sample graph and node preview is identical to before. Start by checking that the preview mesh has UVs and that `mycoVUv` reaches the fragment stage in the node preview renderer (`render/babylon/previews/MaterialPreview.ts`).

## To do, in suggested order

1. **Editor support for `settings.preload` (0080).** Today the only fix for a miss the report names is hand-editing the scene file.
   - Check the editor keeps `settings.preload` when it saves a scene (not verified; scene saving may drop unknown `settings` keys).
   - Add an Inspector field for the scene's preload list (prefab and material paths).
   - The message log offers to add the path the report names (`[myco] … drew a shader variant that wasn't warmed up …`).
2. **Pixel compare of clustered against regular lighting (0079).** On a paused match frame with particles and the UI pass off (see 0075's "Measuring" note), check the spot cone at a few `spotSoftness` values especially. The clustered PBR path uses the same falloff functions, but it's a different code path.
3. **Warm-up on three.js (0080).** `RenderBackend.warmUp` resolves at once. Planned: hidden copies of the warm set's meshes through three's `renderer.compileAsync`.
4. **Load-time budget (0080 open question).** 6 warm meshes a frame (`BATCH` in `render/babylon/warmUp.ts`) makes the load's frames 260–520 ms. Decide whether to spread them thinner or warm behind a loading screen.
5. **Variants not warmed yet (0080):**
   - particle systems;
   - world-space UI;
   - reflection-probe copies (`probeMaterial`);
   - warming again when the quality tier changes (the passes change).
6. **Unverified for clustering (0079):**
   - GPU time against the stop-gap; needs timestamp queries or a visible window, since Babylon's GPU timer reads 0 under a frame graph;
   - a camera that draws to part of the target (split screen): Babylon sizes the tile mask from `engine.getRenderWidth()`, not the viewport;
   - re-check `reclusterForNextCamera` (it resets Babylon's private `_lightDataRenderId`) on each Babylon upgrade, or get the cache keyed on the camera upstream.
7. **Tests that would need a harness.** The variant report and the override-copy texture fix (`rendererMaterial`) were checked by hand in the browser. There's no harness yet for driving `BabylonRenderer` itself on NullEngine.

## Not part of 0079/0080, noted on the way

- **Allocation during play:** about 60–80 MB/s from the client World's scripts and spawning, with a 370–640 MB heap and a major GC every 5–10 s. It doesn't drop frames today.
- **A failing test:** `src/engine/tests/lobby.test.ts` "players in other Engines join a lobby by URL, and their match shares the lobby's port by path" fails, on master's code too.
- **Later records:** baked lighting (lightmaps) and light probes, deferred by the owner on 2026-11-06.

## How to measure

The hidden browser pane throttles `requestAnimationFrame`, so keep the pane visible.
1. Open `/editor.html?sample=pirates`, press Play, then Practice against bots.
2. Hook `Engine.prototype.step`: import the module URL the editor loaded, found with `performance.getEntriesByType("resource")`, since Vite adds `?t=` after edits. Record each frame's `dt` and step time.
3. Wrap `GPUDevice.prototype.createRenderPipeline` and `createShaderModule` to count compiles, with `pushErrorScope("validation")` to catch invalid pipelines.
4. Count frames over 22, 50 and 100 ms over 60–70 s from the click.
