# 0075. Babylon.js replaces three.js as the render backend, used from upstream with module-by-module imports and copied subsystems instead of a fork

- **Status:** Accepted; stage 10 and the Deprecates list superseded by 0078 (both backends stay, Babylon by default)
- **Date:** 2026-11-05
- **Deciders:** Chris Carlson
- **Supersedes:** 0004
- **Related:** 0003, 0010, 0014, 0020, 0021, 0044, 0047, 0050, 0051, 0053, 0054, 0057, 0069, 0071

## Context

three.js renders everything today (0004), hidden behind the engine's components (0010). The rendering quality we want next (volumetric fog and light, light probes, global illumination, SSR, TAA) runs into three limits:

- **WebGL2 only.** three's WebGL add-ons are where its high-end effects are not. Its new effects (SSGI, SSR, TRAA, volumetric lighting) are in `WebGPURenderer`.
- **`WebGPURenderer` requires TSL.** It has no `ShaderMaterial` or `RawShaderMaterial`. Every material is a TSL node graph, and raw WGSL goes in only as functions (`wgslFn`) wired into TSL. We want shaders written in plain WGSL (or GLSL).
- **Add-on version locks.** `postprocessing` 6.39 caps three at 0.187. n8ao, three.quarks, uikit and CSM are separate libraries, each with its own compatibility range.

macOS and Linux webviews are not a target. Windows' WebView2 is Chromium, so WebGPU is available (0003).

**Spike** (`spikes/babylon/`, Babylon 9.32.0, WebGPU, AMD RDNA 3, 1781×1206):

- A complete plain-WGSL vertex and fragment pair runs as a `ShaderMaterial`.
- A plain-WGSL full-screen pass runs as a `FrameGraphCustomPostProcessTask`.
- Shadow-mapped volumetric lighting (`FrameGraphVolumetricLightingTask`), PCF shadows and HDR bloom all work, holding 60 fps (vsync) with everything on.
- No GLSL-to-WGSL transpiler download was needed, because Babylon's own shaders ship as WGSL.
- Importing from the `@babylonjs/core` barrel bundles the whole library: 6.7 MB raw, 1.47 MB gzip. The current player's three.js core chunk is 65 KB gzip.
- **Module-by-module imports** (measured after acceptance, same scene, Vite production build):
  - **Loaded at start:** 430 KB gzip (1.74 MB raw).
  - **Lazy chunks:** 188 KB gzip more. These are per-language shader chunks, loaders, and the WebGL2 fallback engine (11 KB gzip), and they download only when used.
  - **Where the startup bytes go (raw):** meshes 13%, the WebGPU engine 12%, materials 11%, PBR 9%, cameras 6%, engine core 6%, scene 6%, textures 4%, frame graph 5%, lights and shadows 5%, post-processes 2%.
  - **Spike-only weight:** about 140 KB raw (≈ 35 KB gzip) is `ArcRotateCamera` with its input, device-input and behaviour code, which the engine doesn't need because it has its own camera control. `AudioV2` (22 KB raw) is pulled in by the scene and isn't needed either (Howler, 0074).
- **Module-by-module friction.** Two features broke until extra side-effect modules were imported:
  - Engine methods such as `buildTextureLayout` come from extension modules (`Engines/WebGPU/Extensions/index.js`).
  - The lighting-volume task imports `lightingVolume.pure`, which doesn't register its WGSL compute shader. Babylon then fetched the shader over HTTP and got an HTML page. The fix is importing `Lights/lightingVolume.js`.
  - The backend therefore keeps one module that imports every side effect it needs, and a browser test fails on any shader fetch.
- Not measured: GPU cost per effect (Babylon's GPU frame counter stayed at 0 under a frame graph).

**Code affected.** About 8,900 lines in 19 files import three.js or its add-ons, all under `src/engine/`:

- `render/RenderBackend.ts` (2,992 lines)
- `editor/index.ts` (931)
- `render/ThumbnailRenderer.ts` (829)
- `ui/UIRuntime.ts` (576)
- the particle files (about 1,330)
- `physics/Physics3DWorld.ts`, which uses three's math only (410)
- `scene/models.ts` (405)
- the rest of `render/`

Game scripts and the public API don't import three (0010).

## Decision

We will replace three.js with **Babylon.js** as the only renderer, and move to **WebGPU**.

**Dependency policy**
- We depend on **upstream `@babylonjs/core`**, plus `@babylonjs/loaders` for model formats, **pinned to exact versions**. Upgrades are deliberate commits, like three's today.
- **Module-by-module imports only.** Engine code imports from individual module paths, preferring Babylon's side-effect-free `*.pure.js` modules and registering the shaders and side effects it needs. It never imports the `@babylonjs/core` barrel. A Vitest check fails the build on a barrel import under `src/`.
- **Small fixes are patches** (`patch-package`, under `patches/`), each with a comment saying why, and sent upstream when they're general.
- **Subsystems we want to own are copied in, not forked.** When a Babylon subsystem needs changes beyond a patch, its source is copied into the engine module that owns it, for example `src/engine/animation/` for Babylon's animation system. The copy notes the Babylon version it came from and gets an entry in `THIRD_PARTY_NOTICES.md` (Apache 2.0). From then on it's engine code. Each copy is its own decision record; animation is the first candidate.
- We do **not fork the whole library.** See Alternatives.

**Boundary (0010, unchanged in spirit)**
- Babylon is a backend. No Babylon type appears in `src/engine/index.ts` or in file formats. CLAUDE.md's rule becomes: "Babylon.js, Rapier and Howler must never appear in the public API."
- The engine's node graph stays authoritative, and Babylon's scene graph is mirrored from it, as three's is today.
- The scene uses `useRightHandedSystem = true`, so 0014's +Y-up, right-handed convention and all saved data stay as they are.
- `Physics3DWorld`'s use of three's math moves to the engine's own math types.

**Rendering**
- **Engine.** `WebGPUEngine` is the target. Babylon's WebGL2 `Engine` is kept as a fallback where WebGPU is missing, but it isn't a target, and features may be off there.
- **A frame graph drives every frame.** The render backend builds a `FrameGraph` from the World's components and the quality tier (0050): clear, shadows, object render, then the effect tasks, and finally the back buffer. A component or tier change rebuilds the graph. Babylon's classic `DefaultRenderingPipeline` is not used.
- **Custom shaders are plain WGSL.** Hand-written shader assets are WGSL (Babylon's WGSL dialect). GLSL is accepted too, and Babylon translates it.
- **The shader graph (0047)** emits WGSL chunks. Lit graphs extend Babylon's PBR material through `MaterialPluginBase`, which is Babylon's equivalent of `onBeforeCompile`. Unlit graphs become a `ShaderMaterial`.
- **Each feature record maps to Babylon:**
  - **Lights and materials (0043, 0052):** Babylon lights and `PBRMaterial`.
  - **Runtime material properties (0049):** Babylon material uniforms.
  - **Post-processing (0051):** frame-graph tasks for bloom, SSAO2, depth of field, tone mapping, chromatic aberration and grain. `PostProcessing` component fields keep their meaning.
  - **Environments and shadows (0053):** Babylon's HDR/EXR loaders, and frame-graph cascaded shadows.
  - **Reflection probes (0054):** Babylon's `ReflectionProbe`.
  - **Fog (0071):** Babylon scene fog.
  - **Picking and camera rays (0073):** Babylon's ray tests.
  - Each of these records is amended when its part is ported.
- **Particles (0021, 0057):** three.quarks is replaced by Babylon's particle systems. Our effect format and the `ParticleSystem` component stay as they are, and only the translator changes.
- **In-canvas UI (0020, 0069):** uikit only works with three.js, so it can't stay. Its replacement is 0076: Yoga lays out, Babylon GUI draws, the engine routes input. The `UICanvas` component API is kept.
- **Model import (0044):** glTF and OBJ load through `@babylonjs/loaders`. Babylon has no FBX loader; see Open questions.

**Migration**
- **Size budget.** The target is ≤ 400 KB gzip for the render code the player loads at start.
  - The spike measured 430 KB. Taking out its spike-only camera code (about 35 KB) puts the engine's equivalent at about 395 KB, so stage 1 can start.
  - Features that not every game uses (particles, GUI, model loaders, reflection probes, volumetrics) load on demand, as particles and post-processing do today.
  - Babylon modules that come in only through `scene` and that we don't use, such as `AudioV2`, are candidates for a patch.
  - A build check reports the player's startup gzip size and fails above the budget.
- **Side effects in one place.** `src/engine/render/babylon/register.ts` imports every Babylon side-effect module the backend relies on: engine extensions, and the shader-registering modules behind `.pure` imports. A browser test fails if Babylon fetches a shader over HTTP.
- **Two backends during the move.** A new Babylon backend is built next to the three.js backend, chosen by a dev flag. Samples and tests can run on either until the new one reaches parity. Then the three.js backend and its dependencies are deleted in one change. Stage 1 set this up:
  - **The interface.** There was no backend interface before, only the three.js class. `render/RenderSurface.ts` now declares what the engine and editor call, and the editor's overlay and gizmo types moved there with it. `RenderBackend` (three.js) and `babylon/BabylonSurface` both implement it. `Engine` and `World` hold a `RenderSurface`.
  - **The switch.** `render/createRenderSurface.ts` picks the backend: `?renderer=babylon` in the URL, or `localStorage["myco.renderer"] = "babylon"`. three.js is the default.
  - **Lazy loading.** `BabylonSurface` owns the canvas and its layout and loads `babylon/BabylonRenderer` (the only file that imports Babylon, apart from `register.ts`) on demand. Pages on three.js never download Babylon, and frames before it's ready are skipped.
  - **Conventions found in stage 1.** Babylon's front faces default to clockwise even in a right-handed scene, but the engine's geometry winds counter-clockwise (three.js and glTF convention), so every material sets `sideOrientation` to counter-clockwise. Sprite textures need `hasAlpha = true` before Babylon reads their alpha.
  - **Conventions found in stage 2** (`babylon/lighting.ts`):
    - Babylon's PBR materials take 4 lights by default; the backend raises that to 8.
    - three.js puts a directional light's shadow camera near plane behind the light's node. Babylon wants it in front, so the light moves back along its direction by the same distance and the near plane is 0.
    - Prefiltering an HDR cube swaps its GPU texture when it finishes. A material that bound the first texture on WebGPU keeps drawing with it after it's destroyed, and every frame is rejected (a black screen). Environment textures and the sky's copy therefore go to the scene only once they're ready.
    - The default studio room (three.js's `RoomEnvironment`) is generated as a small Radiance `.hdr` in memory (`babylon/studioEnvironment.ts`) and loads through the same `HDRCubeTexture` path as a project's HDR map.
  - **Stage 3** (`babylon/frameGraph.ts`, `babylon/finishShader.ts`) and what it found:
    - **Per-camera textures.** Each camera renders into its own HDR texture the size of its viewport rectangle, so its projection takes the rectangle's aspect ratio. Its finish pass writes into that rectangle of the canvas. A camera without a background colour blends over the ones before it.
    - **Shadows are frame-graph tasks.** Stage 2's classic shadow generators became `FrameGraphShadowGeneratorTask` / `FrameGraphCascadedShadowGeneratorTask`, shared by every camera. `lighting.ts` now returns which lights need shadow maps rather than making generators.
    - **Clears run before shadow maps.** A shadow task renders through Babylon's own render target, outside the frame graph's tracking. A clear task right after it lands on the wrong target, which leaves the camera's depth buffer at zero so every mesh fails the depth test. All cameras' clears therefore run first.
    - **The finish pass is ours.** Babylon's image processing has no AgX, the PostProcessing default, so grading, the vignette, tone mapping and the sRGB encode are one custom pass. It uses three.js's AgX, ACES Filmic and Khronos Neutral curves and the `postprocessing` library's default vignette, in WGSL and GLSL. Its parameters are three `vec4` uniforms.
    - **Uniform lists are copied.** Babylon appends the post-process vertex stage's `scale` to the uniform list a custom post-process is given. Passing a shared constant made the bind loop zero `scale`, collapsing every UV to 0.
    - **A Babylon patch** (`patches/@babylonjs+core+9.32.0.patch`, applied by `patch-package` on `postinstall`) makes the geometry pass clear view depth to the camera's far plane. Babylon left that clear value at 0, so SSAO read the background as the nearest surface and painted it black.
    - **Stage 4** (`shaderGraph/compile.ts`, `nodes.ts`, `wgsl.ts`; `babylon/graphMaterial.ts`):
      - **One compiler, two languages.** `compileShaderGraph(graph, { language: "wgsl" })` emits WGSL from the same node library: every node's `emit` writes both languages through the emit context, with WGSL helpers kept beside the GLSL ones. GLSL output, and its cache keys, are byte-for-byte unchanged.
      - **Custom Function nodes** can't run their GLSL body in WGSL. They gain an optional WGSL body (`function.wgsl` in the graph file; 0047 amended). Without one, the Babylon backend reports a problem and the node outputs its defaults. The editor field for it is still to come.
      - **A material plugin** splices the WGSL into Babylon's PBR shaders: vertex offset before the world position; base colour, alpha and clip at the alpha hook; metalness and roughness into `reflectivityBlock`; emission before the final composition; the normal after `pbrBlockNormalFinal`. A define per graph keeps programs apart.
      - **WebGPU only.** Babylon refuses a WGSL-only plugin on a GLSL material, so on the WebGL2 fallback graph materials draw as plain PBR with a warning.
      - **Varyings are scarce.** WebGPU allows 16 vertex outputs, and PBR with shadows uses most of them. WGSL graphs therefore reuse Babylon's world position and normal varyings and declare only the ones they read.
      - **Graph textures** decode sRGB in hardware (sRGB texture formats), because graph code samples them raw.
      - **Per-renderer properties (ADR 0049):** a graph material's copy shares the program and changes only its values; a built-in material's copy is a fresh clone of the base with the overrides applied.
    - **Stage 5** (`render/particles/simulation.ts`, `babylon/particles.ts`):
      - **Our simulation, Babylon's drawing.** Babylon's particle system lacks much of the effect format (0057): trails, orbit, turbulence, plane collision, colour and size by speed, rate over distance, bursts with cycles and probability. A renderer-neutral CPU simulation (no three.js or Babylon imports, tested headless) plays every module. Babylon's CPU `ParticleSystem`, with its own emission and update turned off, only draws the simulated particles each frame (billboards, stretched, flipbook sheets, blending).
      - **Unchanged parts:** the component API, the lifecycle commands, the editor preview and destroy-on-finish mirror the three.js player. Particle graph bindings (0060) run through the existing program runner, now free of three.js.
      - **Colour:** particles draw in linear space, because the render task marks image processing as applied later, so the finish pass tone maps them once.
      - **Not yet:** mesh and trail render modes draw billboards (trail history is already simulated); particle material assets, `renderOrder` and `blendTiles` are ignored. Each warns once.
    - **Stage 6** (`babylon/probes.ts`, `babylon/water.ts`, fog in `BabylonRenderer.ts`):
      - **Reflection probes** are Babylon `ReflectionProbe`s at the tier's resolution, rendered by hand before the frame graph runs (render targets drawn mid-graph break its state). Capture rules follow three.js: once on load (over a few frames, so late-compiling materials are in), again when moved or on `capture()`, or round-robin every frame. Built-in materials in a probe box draw with a probe copy of their material; graph materials keep the scene's environment. The box picking moved to the renderer-neutral `render/probeBoxes.ts`.
      - **Fog** is Babylon's scene fog: linear, or exponential squared like three.js's FogExp2, with its colour in linear space. A material asset's `"fog": false` turns fog off on the meshes using it. `affectsSkybox` dims the skybox and lerps a plain background, as on three.js.
      - **Water** is a PBR material plugin in WGSL: Gerstner displacement and normals in the vertex stage, deep/shallow/foam colour and ripples in the fragment stage, with two varyings of its own. Probe reflections work, and on the WebGL2 fallback the surface draws as a plain PBR plane.
      - **Includes are expanded before plugins inject.** Code that needs the final normal is therefore anchored on the albedo block's declaration (`ALBEDO_ANCHOR` in `graphMaterial.ts`), not on `#include<pbrBlockNormalFinal>`. This also fixed graph materials with a Normal output.
      - **A GPU check page,** `spikes/babylon/stage6.html?renderer=babylon`, steps the engine by hand and collects shader compile errors and GPU errors, so a real WebGPU check works even when the app window isn't drawing.
    - **Stage 7** (`scene/models.ts`, `babylon/previews/`, `babylon/materials.ts`, `render/previewRouting.ts`):
      - **Renderer-neutral model data.** Each imported or built-in mesh carries `data` (plain positions, normals, UVs, indices, material groups) and `surfaces` (colour, metalness, roughness, opacity, sides, texture image) beside the three.js objects. Physics and the Babylon backend read only these. Models with several materials now draw on Babylon, one submesh per group.
      - **Parsers stay for now.** OBJ and FBX still parse through three.js loaders, converted to the neutral data. Replacing them hinges on the FBX open question below and lands with stage 10. glTF import is a new feature, not parity, and isn't part of the migration.
      - **Editor previews on Babylon.** Thumbnails, Inspector previews, the Shader Graph panel's material and node previews and the particle effect preview have Babylon versions with the same APIs. `previewRouting.ts` loads them by the same `?renderer=` flag, through dynamic imports. Material building and particle drawing are shared with the World renderer (`materials.ts`, `particleDraw.ts`).
      - **Previews read back pixels in the same task.** They render into the preview engine's canvas, then copy into the 2D target before the frame is presented; after presentation, a WebGPU canvas reads as blank.
      - **Particle thumbnails need matting.** Additive particles leave alpha at 0 on a transparent target, so particle thumbnails are drawn over black and over white and combined.
    - **Stage 8** (`babylon/editorContext.ts`, `editorTools.ts`, `editorQueries.ts`, `editorOverlays.ts`, `editorGizmo.ts`; the overlay task in `frameGraph.ts`):
      - **Editor helpers load on demand.** An editor World loads them when its renderer starts; elsewhere, the first editor call loads them, so games never download the gizmos. They read the renderer through a small context interface. Editor state set before they load (grid, colours, selection, overlay, gizmo) is kept by the surface and handed over.
      - **One overlay layer, drawn by the frame graph.** Outlines, overlay lines and handles, camera and light icons, frusta and the transform gizmo live in one `UtilityLayerRenderer`. A small frame graph task of ours draws it onto the canvas right after the view camera's final pass, unprocessed, in that camera's rectangle. Babylon's own `FrameGraphUtilityLayerRendererTask` was rejected because it creates a new layer whenever the graph rebuilds. The overlay scene's image processing is off, so its colours go out as the sRGB values given.
      - **The grid lives in the main scene,** so meshes hide it. It goes through post-processing, unlike three.js's. Editor-only meshes carry `EDITOR_LAYER_MASK`: an editor World's view cameras see them, while game cameras, the camera preview and reflection probes don't. Object renderer tasks force the layer-mask check, because they draw an explicit mesh list.
      - **The camera preview is one more camera in the frame graph,** drawn after the overlay, so the inset covers the editor's helpers.
      - **Picking** uses the engine's camera maths (`screenPointToRay`, `worldToScreenPoint`, viewport-aware), with Babylon's mesh test for meshes. Babylon tests a ray in the mesh's own space, so the ray is transformed into it and the hit is measured back in world space. Ordering matches three.js: text, then icons, then sprites by draw order, then meshes nearest first.
      - **The transform gizmo** is Babylon's position, rotation and scale gizmos on a proxy node placed from the engine's world matrices each frame. Babylon only moves the proxy; drags become local poses (`gizmoMath.localPoseFromWorld`) handed to the editor, which writes the components (ADR 0010). Snapping is Babylon's incremental snapping, counted from where the drag started; three.js's TransformControls snaps to an absolute grid. Planar mode, world and local space, centre and pivot, several nodes and `activeIndex` behave as on three.js.
      - **Drawing part of a mesh** (pooled line and handle batches) makes its submesh non-global. Babylon then reads the submesh's own bounds, which a global submesh never had, so they are copied from the mesh. Without them, the transparent sort throws.
    - **Stage 9, part 1** (0076; `ui/UICore.ts`, `ui/layout.ts`, `ui/uiCoreTypes.ts`, `babylon/ui.ts`, the UI task in `frameGraph.ts`):
      - **The renderer-neutral UI core** lays out with Yoga (`yoga-layout/load`, loaded on demand) and routes the pointer and keyboard by 0069's rules from its own boxes. It also owns the input fields' hidden `<input>`. It runs without a renderer, so it's tested in Node.
      - **Babylon GUI draws it**: one fullscreen texture for screen canvases and the interim `Text`, with each canvas a root container scaled by its scale × the pixel ratio, so text rasterises at device resolution. World canvases are planes with their own mesh texture.
      - **Our own frame graph task draws the screen UI** after the game's camera (the last one, or the editor's view, over its overlay as on three.js). Babylon's `FrameGraphGUITask` was rejected because it disposes the texture whenever the graph rebuilds.
      - **A mesh's GUI texture must draw once before the graph builds.** It's only ready after its first update, which otherwise happens only as a camera renders, and the frame graph waits for every material to be ready before rendering. `ui.ts` updates world-canvas textures in its sync.
      - **The editor helpers load only when wanted.** Stage 8's surface asked for them every frame, so game Worlds downloaded the gizmos too.
    - **Effects (stage 3):** ambient occlusion is SSAO2; depth of field and bloom are Babylon's; chromatic aberration uses the tier's amount. The editor's scene view previews the scene camera's effects, minus depth of field, as on three.js. Babylon's frame graph has no SMAA, so FXAA stands in on tiers that ask for SMAA. The geometry pass that feeds ambient occlusion and depth of field gets its own depth buffer, cleared with the camera's: without one, Babylon's geometry task draws with no depth test, and ambient occlusion drew the edges of meshes behind through the nearer ones (worst at the high AO setting).
    - **Performance on a real GPU** (found 2026-11-06, WebGPU on Windows; the pirates sample's island bay in the editor and in a Practice match, 1060×596, High tier). Measured per frame by driving `sync` and `render` by hand and awaiting `device.queue.onSubmittedWorkDone()`, because the hidden browser pane throttles `requestAnimationFrame`:
      - **Every mesh rebuilt its shader defines every frame.** Babylon's readiness check skips that work only while a mesh's defines aren't dirty, and two things marked every mesh's light defines dirty each frame. The frame graph's object renderer sets each shadow-capable light's `shadowEnabled` to "has a shadow map in this graph" before it renders and restores it after: a light left at Babylon's default (true) with no shadow map, like the pirates' point lights, flipped twice a frame. And the shadow casters' list, a render list Babylon watches, was emptied and refilled every frame; a watched list going from empty to filled marks every mesh in the scene. Fix: `lighting.ts` sets `shadowEnabled` to whether the light has a shadow map, and `frameGraph.ts` replaces the casters' list in one splice, only when it changed. Define rebuilds went from about 1,000 to about 1 a frame.
      - **Nothing was frustum culled.** Babylon's frame graph object renderer draws its whole object list, so all 300 meshes were readied and drawn every frame, on screen or not. Fix: a `FrameGraphCullObjectsTask` per camera feeds its render and geometry passes. Draws went from about 600 to about 190 a frame; a paused frame reads back pixel-identical with culling on and off.
      - **Smaller per-frame costs:** each mesh renderer re-froze its world matrix every frame (a new `Matrix`, and recomputed bounds) even when it hadn't moved; probe lookups ran (and allocated) with no probes; the UI core set about 20 Yoga properties per element every frame, each a call into WebAssembly, even when unchanged. Now matrices are compared first, lookups return at once without probes, and `UICore` remembers what each Yoga node was given.
      - **Before and after,** per frame (25th percentile / median; CPU times are steady, the GPU wait is noisy in the throttled pane). Match: render CPU 44.8/47.8 → 2.4/2.7 ms, sync 3.8/4.2 → 1.6/1.7 ms, GPU wait 62/70 → 9/15 ms, total 111/124 → 14/20 ms. Editor: render 5.1/7.0 → 1.9/2.3 ms, sync 4.0/10.2 → 2.1/2.6 ms, total 19/32 → 9/12 ms. three.js in the same session: match total 5.7/6.5 ms (sync 1.5, render 1.4, GPU 2.6), editor 9.6/10.7 ms. Babylon's CPU cost is now level with three.js; its GPU time is still about twice three.js's at best (about 5 ms against 3), mostly shadows (about 1.4 ms) and the screen UI.
      - **What's left:** Babylon GUI redraws its whole screen texture and uploads it whenever a control changes; the pirates HUD's ship markers move every frame, so that's every frame (about 1–2.5 ms at this size, more at higher resolutions). The editor's overlay provider builds new line arrays every frame and the line batch re-uploads them (about 1 ms with the island bay's navigation overlay, on both backends). Floats bobbing on the waves still re-freeze every frame, since they move.
- **Stages,** each ending with the samples rendering:
  1. Engine, camera, meshes, sprites and materials.
  2. Lights, shadows and environment.
  3. Frame graph and post-processing.
  4. Shader graph to WGSL.
  5. Particles.
  6. Reflection probes and fog.
  7. Model import and thumbnails.
  8. Editor: picking, gizmos, outlines, previews.
  9. UI (0076, 0077).
  10. Delete three.js.
- **Tests.** Headless unit tests use Babylon's `NullEngine`. Browser tests (0023) run the samples on WebGPU in Chromium. WebKit runs are dropped for rendering, since it isn't a target.

## Alternatives considered

- **Stay on three.js with `WebGLRenderer`.** No migration, but no WebGPU, and the quality features we want are either missing or locked behind add-on versions.
- **three.js `WebGPURenderer`.** Keeps the ecosystem and has the newest effects, but every custom shader must be TSL, which we've ruled out.
- **Fork Babylon.** Full control, but Babylon releases weekly and a fork either falls behind or needs ongoing merges. It doesn't help bundle size either: module-by-module imports of upstream should trim the same code without a fork. Copying chosen subsystems gives the control where we need it.
- **PlayCanvas engine.** Also takes WGSL and GLSL, but its WebGPU support is labelled beta, and it has fewer high-end lighting features (no built-in volumetric lighting).
- **A native renderer (wgpu or Bevy) in the Tauri process.** Native shaders and full control, but it leaves the webview: no web export, a different editor viewport, and years of renderer work.

## Consequences

**Positive**
- Custom shaders are plain WGSL or GLSL, with no TSL.
- High-end effects are built in and versioned together: volumetric lighting, SSR, SSAO2, TAA, cascaded shadows, IBL shadows, GPU particles, area lights, compute shaders, and a frame graph to arrange them.
- One upstream instead of a set of add-ons with version caps. Babylon tries hard not to break existing code between releases.
- Copied subsystems, such as animation, let us own the parts we want to change without a fork.

**Negative / costs**
- **A large rewrite:** about 8,900 lines, mostly `RenderBackend.ts`, the editor, thumbnails, particles and UI.
- **Bundle size:** larger than three. Module-by-module imports have to be maintained by hand, and the size gate may fail.
- **Babylon is a full engine.** It has its own scene graph, animation, audio and physics. We use the renderer and ignore the rest, and we still mirror our graph into its scene.
- **UI changes.** uikit is lost and in-canvas UI has to be rebuilt.
- **FBX import loses its loader.**
- **Documentation is thin** for frame graphs. The spike's wiring came from reading Babylon's `.d.ts` files.
- **Effect tuning starts over.** Values are physically based and sensitive (volumetric strength about 0.1, not 1.6), so existing tuning doesn't carry over.
- **Shader graph rework.** The GLSL chunk output (0047) and its tests are rewritten for WGSL.
- **macOS and Linux** (WebKit webviews, no WebGPU) fall back to WebGL2 at best, with some features off.

## Deprecates

When the Babylon backend reaches parity (stage 10), these are removed, together with the three.js backend code in `src/engine/render/`, `editor/`, `ui/`, `scene/models.ts` and `physics/`:

- `three` and `@types/three`
- `postprocessing`
- `n8ao`
- `three.quarks`
- `@pmndrs/uikit`, once the UI record lands

Until then they stay. 0004 becomes `Superseded by 0075`. 0010, 0014, 0020/0069, 0021/0057, 0044, 0047, 0051, 0053, 0054 and 0071 are amended as their stage lands.

## Open questions

- **Bundle size** stays close to the 400 KB budget: about 395 KB is estimated for the engine's equivalent of the spike scene. Whether patching out `AudioV2` and other unused modules is worth carrying a patch.
- **FBX import:** convert at import time (a build-time FBX-to-glTF converter, or keep three's `FBXLoader` in the editor only, as a converter), or drop FBX.
- **GPU timing** under a frame graph, for the editor's profiler and for quality detection (0055).
- **Light probes and GI:** Babylon's IBL shadows and reflective-shadow-map GI versus our own probe grid. This needs its own record.
- **Animation:** copy Babylon's animation system or write our own (its own record).

## References

- Spike: `spikes/babylon/` (`main.ts`, `README.md`)
- [Babylon.js WGSL in WebGPU](https://doc.babylonjs.com/setup/support/webGPU/webGPUWGSL)
- [Material plugins](https://doc.babylonjs.com/features/featuresDeepDive/materials/using/materialPlugins)
- [Frame graph volumetric lighting](https://doc.babylonjs.com/features/featuresDeepDive/frameGraph/frameGraphExamples/frameGraphExampleVolumetricLighting)
- [`FrameGraphVolumetricLightingTask`](https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.FrameGraphVolumetricLightingTask)
- `@babylonjs/core` 9.32.0 `FrameGraph/` declarations, `NodeRenderGraph.setToDefault()`
