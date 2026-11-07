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

## Fast follow-up (done 2026-11-06)

- **The ripple sub-graph's UV node preview drew black**, and the sub-graph's preview was a flat grey sphere. The cause wasn't the previews: Babylon's PBR material binds the mesh's UV attribute only when the material itself needs UVs (one of its textures), so a graph that reads UVs but samples no texture got `mycoVUv` = 0. Every such material was affected, in the game too (the Playground's water, which uses the ripple). Fixed in `render/babylon/graphMaterial.ts`: the graph plugin's `prepareDefinesBeforeAttributes` sets `_needUVs` when the graph reads UVs (`graphUsesUv`), so Babylon defines `UV1`. Test: `babylonGraphMaterial.test.ts` (UV1 on with a UV-reading graph and no texture, off without). Seen in the Shader Graph panel: the UV gradient, the ripple's rings and the banded sphere.

## To do, in suggested order

1. ~~**Editor support for `settings.preload` (0080).**~~ Done 2026-11-06: Scene settings in the Inspector (click the scene's name in the Hierarchy, or select nothing) edit the list, saving keeps it, and the message log's **Add to preload list** button takes the file a warm-up warning names. See 0080's row in the implementation status.
2. ~~**Pixel compare of clustered against regular lighting (0079).**~~ Done 2026-11-06 with `spikes/babylon/lights.html`: the two match exactly. It found that `spotSoftness` and `range` did nothing on Babylon (physical light falloff); lit materials now use glTF falloff. See the 0079 and 0075 rows.
3. ~~**Warm-up on three.js (0080).**~~ Dropped: the three.js backend was removed (0081).
4. ~~**Load-time budget (0080 open question).**~~ Done 2026-11-06 by compiling the warm-up's pipelines asynchronously on WebGPU (`render/babylon/asyncPipelines.ts`): no compile stalls a frame now, and batches went from 6 to 24 meshes. The pirates load's worst frame went from 600 to about 250 ms; what's left is the load's own JavaScript (main-thread long tasks of 64–275 ms), not pipelines. See 0080's row.
   - **Found (2026-11-06):** the long tasks are mostly Babylon creating effects (about 10 ms each, shader preprocessing in JavaScript). Warm batches are now sized to about 12 ms of effect creation, which helped a little (worst frame about 210 ms). Still to do, each a question of its own:
     - **The swap lump:** 150–190 ms of effects created when the match scene first draws, which the warm-up should have made. Find which defines differ between the warm meshes and the real ones (instances, the scene's lights and shadows, fog), for example by logging every effect created in the first frames after a warm-up, which the variant report skips.
     - **A new World's own effects:** each World has its own Babylon engine, so the match World makes its clear, post-process, shadow and UI effects again (about 50 ms in each of several frames). Whether Worlds could share one engine, or warm those passes too.
     - **Instantiating the scene:** about 90 ms, some 1,000 vertex buffers.
     - Whether the few internal pipelines Babylon still compiles blocking (clear quad, post-process, UI) are worth warming.
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
