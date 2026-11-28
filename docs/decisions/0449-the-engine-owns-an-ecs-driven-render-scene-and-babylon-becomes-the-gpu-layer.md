# 0449. The engine owns an ECS-driven render scene, and Babylon becomes the GPU layer it draws through

- **Status:** Proposed (direction; each stage gets its own record)
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0012, 0017, 0064, 0075, 0081, 0108, 0128, 0129, 0274, 0276, 0446, 0447, 0448

## Context

The owner's standing goal (0010, 0128, 0129) is that a renderer switch, or a home-grown renderer, needs only a thin
backend adapter. The owner now wants to move to an engine-owned renderer eventually, built around the engine's ECS
core, as Unity's DOTS (Entities Graphics) and Unreal's renderer are built around their own data.

**What exists.** Babylon (0075, 0081) does two jobs today:
- **Scene management:** one Babylon mesh or `InstancedMesh` per drawn object; Babylon walks every scene mesh each
  frame, frustum-culls each one, and tests casters per cascade.
- **GPU work:** materials and shaders (PBR, node and graph materials), shadow maps, the frame graph and post effects,
  shader compilation, and the WebGL2 and WebGPU backends.

The engine already owns the frame plan (0129, 0274), the visibility stage (0446 §3: levels, culling, soon occlusion
from 0447), and the ECS core's typed-array storage with change signals (`tVersion`, and `structureVersion` added for
the visibility stage).

**What the LOD work measured** (build log, "CPU against no LOD" and later; SwiftShader, forest scene, 10k trees):
- With the camera still, after fixes, LOD costs no more CPU than no LOD (interleaved means 53.3 against 55.4 ms) and
  draws 4× fewer triangles.
- Flying, LOD costs 1.8× (85.4 against 47.8 ms). Profiles put it in scene management, not GPU work: about 35 ms in
  Babylon's per-instance code and 13 ms in the engine's bookkeeping to keep one Babylon instance per object per level
  in step with each view.
- 0446's spike measured thin-instance batches at about half the JS CPU of per-object instances.

**What the browser allows.** WebGPU has compute shaders and indirect draws, so GPU culling and LOD selection with
indirect draws are possible. Nanite's software rasteriser needs 64-bit atomics and mesh shaders, which WebGPU doesn't
offer as standard. WebGL2 allows only the CPU-driven version.

## Decision

We will move scene management into the engine, as data in the ECS core, and draw through Babylon as a GPU layer. A
home-grown GPU layer may replace Babylon later, behind the same interface. In stages, each with its own record and a
measured gate:

1. **Engine-owned draw lists (0448).** Per-pass instance buffers and draw lists, built by the engine from the
   visibility stage's results, for meshes under LOD. Babylon receives one source mesh per batch and pass and only
   draws it. Built as an engine-side layer fed from flat arrays, not as an extension of Babylon's instance meshes.
2. **The render scene in the ECS core.** Renderable state (world matrix, bounds, level, mesh and material IDs, shadow
   flags) lives in typed arrays indexed by entity, kept current from change signals (`tVersion`,
   `structureVersion`, dirty lists) instead of walked per frame. The visibility stage and the draw-list builder read
   it. The 0017 data-component machinery is used where it fits.
3. **Extraction off the main thread.** Culling, LOD selection and occlusion (0447's wasm core) run over that data in
   a worker or wasm, producing per-pass instance ranges.
4. **GPU-driven on WebGPU.** Compute culling and LOD selection, indirect draws, and a hierarchical depth buffer for
   occlusion, with the CPU path kept for WebGL2. Cluster LOD (Nanite-like, without a software rasteriser) is a later
   record if WebGPU gains what it needs.
5. **The GPU layer itself.** Only after 1–4, and only if Babylon is still measurably in the way. Materials and
   shaders, shadows and post effects move to the engine one at a time, behind the draw-list interface, by one of two
   paths chosen by a spike (below).

**Stage 5: two paths.**
- **(a) Keep Babylon's low-level layer.** Babylon's GPU engines (WebGL2, WebGPU), shader processing (`Effect`),
  uniform buffers, textures and possibly the frame graph stay an upstream dependency, imported module by module as
  now. Its scene graph, meshes and material classes go. Shaders and material logic (PBR, shadow filtering, post
  effects) are copied into the engine and rewired to the draw lists, under 0075's rules for copied code. Babylon is
  **Apache-2.0**, so each copy:
  - keeps the license;
  - notes the Babylon version it came from and that we changed it;
  - adds Babylon's `NOTICE` text to `THIRD_PARTY_NOTICES.md`.

  Replacing the device layer later stays optional, decided only if it measurably costs or blocks something (GPU-driven
  drawing, say). This is the cheapest and lowest-risk path, and the closest analogue to Entities Graphics, which sits
  on Unity's low-level batch API rather than its own GPU code.
- **(b) A Rust render core on wgpu, compiled to wasm** (`native/render/`, beside `native/nav/` and
  `native/visibility/`).
  - **The core:** wgpu (MIT/Apache-2.0) is the device layer, targeting WebGPU, and WebGL2 through its GL backend; naga
    translates shaders.
  - **Design reference:** Bevy's renderer (MIT/Apache-2.0), which extracts from an ECS into a render world, then
    batches and draws. Its shaders can be borrowed under that license.
  - **Shared data:** the render scene's typed arrays live in wasm memory: the TypeScript ECS writes changes there, and
    the core reads them without copying.
  - **What it costs:** every WebGPU call from wasm crosses a JS shim, which GPU-driven drawing mostly removes. The wasm
    module adds about 1–3 MB (estimate). Debugging through wasm is harder. We rebuild what Babylon gives us (materials,
    shadows, post effects) and lose its browser workarounds. Threads in web builds need cross-origin isolation.
  - **What it gives:** the closest fit to the ECS and threading goals (stages 3–4 already belong in wasm), and the
    highest performance ceiling.
- **Choosing.** Stage 5 starts with a spike: the forest gate scene drawn through a minimal instanced path in each
  (Babylon's low-level layer; wgpu in wasm). It measures JS CPU per frame, start-up bytes, WebGL2 parity, and how much
  of a PBR material carries over. The spike's results and the choice get their own record.
- **Not chosen as a path:**
  - Filament (Google, Apache-2.0) is a mature render-only PBR library in wasm with an entity-component scene, but
    brings a C++ toolchain, and its WebGPU backend's maturity needs checking. It can be reconsidered at the spike if
    (b) falls short.
  - bgfx and Diligent are device layers only, with nothing over wgpu for us.
  - Other JS engines (PlayCanvas) only swap one scene graph for another.

**Timeline.** These are estimates, not measurements, in person-weeks for a solo developer working with agents:

| | From scratch | Path (a) | Path (b) |
|---|---|---|---|
| Stages 1–4 | 13–22 | 12–19 | 12–19 |
| Stage 5 | 50–80 | 10–18 | 25–40 |
| **Total** | 63–102 | **22–37** | **37–59** |

- **Stages 1–4:** reuse helps them little; they build what Babylon lacks.
- **Path (a):** saves most because the device layer (~35k lines of compiled JS in Babylon 9.32) stays upstream, and
  the shaders (~40k lines across GLSL and WGSL) are copied, not written.
- **Path (b):** saves by borrowing Bevy's design and shaders, but still builds a full render core.

**Rules that hold throughout:**
- **The public API doesn't change for it.** Components, assets and scripts stay as they are (0010).
- **Each stage ships behind measured gates:** JS CPU and triangles on the gate scenes, against the previous stage,
  measured interleaved (alternating runs), on both an idle desktop and the software renderer.
- **No stage removes a feature the previous one had.** Editor picking and selection keep per-object meshes until the
  engine has its own picking.

## Alternatives considered

- **Stay on Babylon's scene management, tuning it.** This was the LOD work's first approach. It closes the static gap
  but leaves the flying cost (1.8×) in per-object Babylon instances.
- **Write a full renderer now, replacing Babylon in one step.** This repeats what Babylon already does well (PBR,
  shadows, post effects, two GPU backends) before the part that measurably costs us, scene management, is fixed. It
  is months of work with no shippable step in between.
- **Switch to another library (three.js WebGPURenderer, a WebGPU-only engine).** It changes whose scene management
  we fight, not whether we own it. 0075 and 0081 record why three.js was left.

## Consequences

**Positive**
- The costs the profiles found (per-object scene walks, per-instance culling, level-switch churn) go away at stage 1–2,
  and scale with what changed, not with scene size.
- The ECS core becomes the render scene's storage, as in DOTS, so gameplay and rendering share one data model.
- A GPU-driven path on WebGPU becomes possible without the CPU path diverging from it.
- Each stage is shippable and measured on its own; stopping after any stage leaves a working engine.

**Negative / costs**
- Two scene representations during the transition (engine draw lists for some meshes, Babylon meshes for the rest
  and for the editor), and tests that cover both.
- The engine takes on picking, bounds and debug views that Babylon gave for free, as each moves.
- Stage 5, if done, is the largest: materials, shadows and post effects are much of Babylon's value. Path (a) keeps its
  device layer and its weekly browser fixes; path (b) takes all of it on.
- Copied Babylon code (path a) is ours to maintain from the version it came from: upstream fixes no longer reach it.

## Deprecates

Nothing yet. Each stage's record says what it retires.

## Open questions

- Stage 5's path, (a) or (b), from its spike.

- Which spikes stage 2 needs first: draw-list building from ECS columns at 10k and 100k instances, and how mesh and
  material IDs map onto Babylon objects.
- Whether stage 3's worker shares memory with the main thread (SharedArrayBuffer needs cross-origin isolation in web
  builds) or copies per frame.
- The WebGPU features stage 4 needs (indirect first-instance, timestamp queries) and their support in the Tauri
  webview (WebView2).

## References

- `docs/design/lod-occlusion/build-log.md` (the CPU measurements and profiles).
- `spikes/occlusion-gate/profile.mjs` (CPU profiler for the gate scenes).
- Unity Entities Graphics (BatchRendererGroup), Unreal's mesh draw command caching and Nanite (for comparison).
- Babylon.js 9.32.0 `license.md` (Apache-2.0) and `NOTICE.md`; 0075 §"Subsystems we want to own are copied in".
- wgpu, naga and Bevy (MIT/Apache-2.0); Filament (Apache-2.0).
- Subsystem sizes: lines of compiled JS in `node_modules/@babylonjs/core` 9.32.0 (Engines 35k, Shaders and
  ShadersWGSL 40k, Materials 74k, PostProcesses 17k, FrameGraph 20k, Meshes 55k).
