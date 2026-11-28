# LOD crossfade and per-view selection: feasibility spike

Raw Babylon 9.32.0, WebGL2 on SwiftShader (headless Chromium via Playwright). Every check reads pixels back from the
canvas and counts them; draw-call counts come from wrapping the WebGL2 `draw*` functions. WGSL cannot run here, so
anything that depends on it is marked **[U]** (unverified). The machine is shared: timings are smoke-level.

Run: `node spikes/lod-crossfade/run.mjs [testNamePrefix...]` (builds with esbuild, runs each test in the page, prints JSON;
`OUT=file.json` saves it; `python3 spikes/lod-crossfade/show.py < out` pretty-prints). Full run saved in `results.json`.

| File | Contents |
| --- | --- |
| `lodFadePlugin.ts` | `MycoLodFadePlugin` (GLSL + WGSL [U]), `markFadeBatch`, a vertex-offset stand-in for the graph plugin |
| `harness.ts` | engine, the engine-shaped frame graph (clear, shadow tasks, per view cull + object renderer + hook), pixel and draw-call helpers |
| `test1.ts`, `test1c.ts` | result 1 (instances, thin instances, shadow casters) |
| `test2.ts`, `test3.ts`, `test4.ts` | results 2, 3, 4 |
| `run.mjs`, `build.mjs`, `main.ts`, `index.html`, `show.py` | runner and page |

## 1. Per-view toggling: PROVEN (with ordering rules)

Setup follows `frameGraph.ts`: `clear -> shadow task -> [cull task -> object renderer task] x views`, two cameras in
two viewports of the back buffer, the view hook run from `objectRenderer.onBeforeRenderObservable`. Instances at
x = -2, 0, +2 (32x32 px boxes); camera A must show {-2, 0}, camera B {0, +2}. Pixel counts per column band:

| Case | View A bands | View B bands | Draw calls |
| --- | --- | --- | --- |
| `InstancedMesh`, `setEnabled` off in A's/B's `onBeforeRender`, back on in `onAfterRender` | 1024, 1024, 0 | 0, 1024, 1024 | A: 1 call, 2 instances; B: 1 call, 2 instances |
| same with `isVisible` | identical | identical | identical |
| second frame | identical (the restore works) | | |
| per-view `objectList` for each cull task, no hooks at all | 1024, 1024, 0 | 0, 1024, 1024 | 1 call, 2 instances each |
| thin batch, `thinInstanceBufferUpdated("matrix")` + `thinInstanceCount` in the hook | 1024, 1024, 0 | 0, 1024, 1024 | 1 call, 2 instances each |
| thin batch, `thinInstanceSetBuffer` each time | identical | identical | identical |

So a buffer update between the two views of one frame takes effect for the second view: in WebGL2 `thinInstanceBufferUpdated`
is a direct `bufferSubData`, so the GL command order (A's draw, update, B's draw) is what the GPU sees.

**Hook order** (logged by marker tasks and observers): `clear, shadow-map-before(layer), shadow-map-after, [shadows done],
cull(A), before(A), draw A, after(A), cull(B), before(B), draw B, after(B)`. The CSM task fires `shadow-map-before` once per cascade.

Rules the tests pin down:

- `onBeforeRenderObservable` runs **before** the renderer prepares its draw list (`_prepareRenderingManager`), which
  re-checks `isEnabled() && isVisible` and `layerMask`, so toggling there works.
- It runs **after** the view's own `FrameGraphCullObjectsTask`, which drops meshes that are not enabled/visible at that moment.
  Negative control: an instance disabled before the frame and re-enabled in B's hook is **not** drawn (B bands 1024, 1024, 0).
  So: keep instances enabled globally, hide per view in the hook, restore in `onAfterRender` (before the next view's cull task).
  The alternative with no toggling is a per-view cull `objectList` (works for `InstancedMesh`, not for thin batches).
- **Shadows** (`FrameGraphShadowGeneratorTask`, runs before every view). An instance hidden from A in A's hook still casts:
  A boxes 484, 484, 0 yet shadow pixels 704, 704, 704 in both views (instances and thin). Control: disabling it before the
  frame removes its shadow (704, 704, 0) and the shadow draw drops from 3 to 2 instances. So **caster state must be set before the shadow
  task** (before `scene.render()`, or in `shadowMap.onBeforeRenderObservable`, which is idempotent per cascade); **view state in the view hook**.
- Thin batch: caster buffer and view buffer are the same buffer. If the views leave their sets in it, the next frame's shadow
  pass sees the last view's set (measured: frame 2 shadow of the first box missing, 0, 704, 704). Rewriting the full caster
  set in the shadow map's `onBeforeRender` (or restoring in `onAfterRender`) fixes it (704 x 3 on every frame).
- Side finding: a `FrameGraphCascadedShadowGeneratorTask` is keyed by its `camera` (`light._shadowGenerators.set(task.camera, ...)`).
  With one CSM task for camera A, view B received no shadows (0, 0, 0). A second CSM task for B fixes it (704 x 3) at 2x the shadow draws
  (4 calls vs 2). The engine builds `task.camera = views[0].camera`; not checked in the engine itself.
- Not exercised (read from source): `objectRenderer.getCustomRenderList` is read after `onBeforeRender` and could filter per view
  without toggling; `customIsReadyFunction` is a readiness gate and is not needed. Neither is required, the frame graph approach fits.

## 2. Dither crossfade plugin: PROVEN on GLSL/WebGL2; WGSL [U]

`MycoLodFadePlugin` extends the engine's `MycoMaterialPlugin`, priority 220. `MYCO_LOD_FADE` is set in `prepareDefines(defines, scene, mesh)`
from a `WeakSet` of fade-batch source meshes; `getAttributes` adds `mycoLodFade` for those meshes. Fade value f: |f| is the progress t
(quantised to 1/16 in the shader), f >= 0 keeps pixels whose 4x4 Bayer rank >= 16t (outgoing/steady), f < 0 keeps rank < 16t (incoming).
Incoming at t = 0 must be encoded as a tiny negative (`-0.0` is not `< 0`).

Two coincident 128x128 planes (16384 px silhouette), A = +t, B = -t, rendered one at a time into the same canvas and masked:

| t | A px | B px | double-covered | holes | outside silhouette |
| --- | --- | --- | --- | --- | --- |
| 0 | 16384 | 0 | 0 | 0 | 0 |
| 1/16 | 15360 | 1024 | 0 | 0 | 0 |
| 0.3 | 11264 | 5120 | 0 | 0 | 0 |
| 0.5 | 8192 | 8192 | 0 | 0 | 0 |
| 0.75 | 4096 | 12288 | 0 | 0 | 0 |
| 15/16 | 1024 | 15360 | 0 | 0 | 0 |
| 1 | 0 | 16384 | 0 | 0 | 0 |

Exactly 0 holes and 0 double-covered pixels at every t (also t = 0.1: 14336 / 2048), for all four combinations:
`InstancedMesh` (`registerInstancedBuffer("mycoLodFade", 1)` + `instancedBuffers`) and thin instances
(`thinInstanceSetBuffer("mycoLodFade", buf, 1)`), each with and without a second plugin (a vertex-offset plugin, priority 200,
standing in for the graph plugin; the silhouette moved 32 px as expected, x 96..223 vs 64..191, and the fade stayed exact). With both levels
drawn in one frame at t = 0.3 there are 0 holes.

Per-instance values in one draw call: two instances of one fade source, f = 0 and f = 0.5, drawn in 1 call with 2 instances:
4096 px (full) and 2048 px (half) for both batch kinds.

Per-mesh define, one material object, two effects: the steady source's effect has no `MYCO_LOD_FADE`, the fade source's has it, and
the effects differ. Compiled PBR effects (fresh engine each, `postprocess+rgbdDecode` is a constant extra and excluded):

| Scene | PBR effects |
| --- | --- |
| steady instances only (plugins on the material) | 1 (`INSTANCES`) |
| + a fade InstancedMesh batch | 2 (+ `FADE+INSTANCES`) |
| + a fade thin batch too | 3 (+ `FADE+THIN_INSTANCES`) |
| steady thin only | 1 (`THIN_INSTANCES`) |
| steady instances + steady thin + fade instances + fade thin | 4 |

So a plugin with the define false costs nothing, and each fade batch kind adds exactly one effect per material (and per shadow variant, see 3).

Note: Babylon 9.32 itself ships `DitheredTileFadeMaterialPlugin` (priority 190, Bayer include, instanced and thin buffers, interval bounds per
instance). Read from its source only, not evaluated; its doc says it does not cover standalone depth, shadow, picking or custom passes.

## 3. Shadows of fading meshes: default DISPROVEN, ShadowDepthWrapper PROVEN

Wall receiver, fade caster hidden or visible, shadow-map filter NONE, count of shadow pixels on the wall (plain caster = 2688):

| Variant | Shadow px | Fraction | Honoured? |
| --- | --- | --- | --- |
| plain mesh, default shadow shader | 2688 | 1.00 | |
| fade batch t = 0.5, no wrapper | 2688 | 1.00 | **no**: the default `shadowMap` shader ignores the discard |
| fade batch + `ShadowDepthWrapper(mat)` (non-standalone), t = 0.25 / 0.5 / 0.75 | 2016 / 1344 / 672 | 0.75 / 0.50 / 0.25 | yes |
| fade batch + standalone `ShadowDepthWrapper(unlitTwin)`, t = 0.25 / 0.5 / 0.75 | 2016 / 1344 / 672 | 0.75 / 0.50 / 0.25 | yes |
| two levels A(+0.3), B(-0.3), standalone wrapper | 2688 | 1.00 | union of the two dithered shadows has no holes |

What it takes: `material.shadowDepthWrapper = new ShadowDepthWrapper(...)`. The wrapper takes the compiled effect's source (with
the plugin code already spliced in), keeps the `MYCO_LOD_FADE` define and the `mycoLodFade` attribute, and adds the depth output, so the
discard applies. `generator.customShaderOptions` is per generator, not per mesh, so it cannot give one batch a variant: not used.

- **Use the standalone wrapper** (an unlit PBR twin carrying only the vertex plugins and the fade plugin, as `graphShadowDepth` does).
  The non-standalone wrapper takes its effect from the base material's own render, so the frame graph never reports ready before a frame
  has drawn (4 runs hit the 30 s `FrameGraph ... shadow0 not ready` timeout, then worked once frames rendered), and it wraps the whole PBR
  fragment shader for every shadow texel. Standalone: ready at build time, depth-only shader. It also worked with the caster never drawn by a camera.
- Effects (counts include wall and others): default 9, non-standalone 8, standalone 10 (one extra depth effect and one twin effect per
  fade variant, minus the default shadow effect it replaces).
- PCF: a dithered shadow is softened into a lighter shadow (measured density 0.27 at t = 0.5, plain = 1.0; 1 sample, smoke).

**Recommendation: hard-switch the shadow at the fade midpoint.** Keep both levels' shadow-only state in the caster set, let the outgoing
level cast for t < 0.5 and the incoming one for t >= 0.5 (set before the shadow task, see 1). It needs no shadow variant, no extra effects,
no wrapper, and a shadow edge seen through PCF/CSM is soft and rarely shows the pop. Choose dithered shadows only if the pop is visible
(large, high-contrast shadows): cost is one standalone wrapper per material with a fade batch, 1 extra effect per fade batch kind, a
discard in the depth pass (loses early-Z for that batch only), and a per-cascade pattern that shimmers when cascades move.

## 4. Cost (SwiftShader, smoke-level, labelled)

Fragment: 256x256, 16 stacked full-screen quads (1.05 M fragments/frame, none depth-rejected), median of 30 frames, sync read each frame.

| Material | plain | fade f = 0 (no discard) | fade f = 0.5 |
| --- | --- | --- | --- |
| unlit PBR | 11.6 ms | 14.9 ms (1.28x) | 14.3 ms (1.23x) |
| PBR + 1 directional light | 39.1 ms | 44.0 ms (1.13x) | 44.6 ms (1.14x) |

(An earlier run gave 1.19x/1.19x and 1.07x/0.98x: noise is about +-10 percent.) SwiftShader has no early-Z benefit to lose, and a
discard in the first lines does not skip the lit work for half-covered 2x2 quads, so this only shows the ALU/varying overhead (about 1.1-1.3x).
Known GPU concern (not measurable here): `discard` (or alpha-to-coverage) disables early-Z / hierarchical-Z on many GPUs, so a fading
batch loses occlusion culling for its own fragments. That is why fading instances sit in **their own batch with the define**, and steady
instances stay on the plain variant (the effect table above shows the two never mix).

Thin-instance matrix upload (CPU side, `thinInstanceBufferUpdated("matrix")`, whole buffer):

| Matrices | Bytes | JS fill | `thinInstanceBufferUpdated` | `thinInstanceSetBuffer` (new buffer) |
| --- | --- | --- | --- | --- |
| 1k | 64 KB | 0.001 ms | 0.03-0.05 ms | 0.5-0.7 ms |
| 10k | 640 KB | 0.014 ms | 0.17-0.18 ms | 2.0-2.2 ms |

Per view that is 0.05 / 0.18 ms, so two views cost 0.1 / 0.36 ms of CPU; the frame time with 0, 1 and 2 rewrites per frame was
within noise (10k: 108, 117, 112 ms, dominated by SwiftShader drawing). Use `thinInstanceBufferUpdated`, never `thinInstanceSetBuffer`, per view.

## 5. Lines of code

Working plugin, `lodFadePlugin.ts`: GLSL strings 32 lines, WGSL strings 31 lines [U], class + defines + `markFadeBatch` about 42 lines:
**about 105 lines** (the file is 150 with the header comment and the 27-line test stand-in plugin).

Engine integration (est.), about 300-350 lines plus tests:

- fade flag in the batch key: `DrawKey.fade`, `sameDraw`, `drawKey`, batch creation calling `markFadeBatch` (est. 15)
- per-instance fade buffers: `auto` batches write `instancedBuffers.mycoLodFade` per instance (est. 25); `thin` batches keep a second
  Float32Array next to the matrix buffer, grow and swap-remove it in step with the matrix slots, `thinInstanceBufferUpdated("mycoLodFade")` when dirty (est. 40)
- the plugin, registered on built-in and graph materials, ordered after the graph plugin (est. 105 + 10)
- per-view hooks in `frameGraph.ts` (hide/restore in `beforeView`/`onAfterRender`, thin buffers per view) and the caster hook before
  the shadow task, plus the selection code that fills them (est. 80)
- shadows: hard switch needs only the caster list (est. 20); dithered shadows would add a standalone wrapper per fade material (est. 30)
- pipeline warm-up: a fade-variant pass (compile each material's fade effect, and its shadow variant if dithered, on a flagged dummy source) (est. 30)
