# 0080. Scene loads warm up the shader pipelines their content will need, derived from what they reference

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0016, 0043, 0047, 0075, 0078, 0079

## Context

On WebGPU, a draw needs a **render pipeline**. A pipeline is the compiled shaders plus the fixed state they run in:
- vertex layout and topology;
- render-target formats and sample count;
- blend, depth and cull state.

The browser makes one from WGSL at runtime; on Windows it goes WGSL → HLSL → the D3D compiler. Babylon creates pipelines **synchronously, at the first draw that needs one** (`WebGPUCacheRenderPipelineTree._createRenderPipeline`), so that frame waits on the GPU process. Nothing can be compiled ahead of time on the web. Chrome's disk cache of compiled shaders sometimes makes a second launch faster, but nothing guarantees it.

What a pipeline depends on beyond the material asset:
- **Shader defines (variants):** the mesh's attributes (UVs, vertex colours, skinning), the lights (ADR 0079 makes those steady), fog, shadows received, whether a texture has loaded, and runtime overrides. A colour override with alpha below 1 switches a material to alpha blending (`applyBuiltinOverrides` in `materials.ts`).
- **The passes the mesh is drawn in:** the main colour pass, the geometry pass on tiers with ambient occlusion or depth of field, and the shadow passes of each shadow-casting light.

Measured in the pirates sample (ADR 0075 notes), after the light fixes:
- Each material first drawn mid-match costs one frame of 150–400 ms: the splash (12 s in), the ghost hull (20 s), the lightning bolt and a sail variant (23 s).
- Loading the match itself is one 700–750 ms frame.
- `Effect.PersistentMode` (`register.ts`) already keeps compiled effects for the engine's life, so each variant compiles once per session. This record is about that first time.

How other engines handle it (discussed 2026-11-06):
- **Unity:** records variants and pipeline states in play sessions (`ShaderVariantCollection`, Unity 6's `GraphicsStateCollection`) and warms them at load.
- **Unreal:** records a PSO cache in playtests. Since 5.2 it also **precaches**: when an asset loads, it works out the pipelines that asset's components will need and compiles them. Recorded caches catch what precaching misses.
- **We take Unreal's approach:** derive from content first, then report what the derivation missed.

Prefabs reach a scene in two ways:
- As instances in the scene file. `collectAssetRefs` (`SceneLoader.ts`) already walks those, and `asset:` references in component data.
- By path from scripts. The pirates sample spawns its splash, cannonballs and ships with `GameObject.instantiate(SPLASH_PREFAB)`, from string constants in `scripts/data.ts`. The scene can't see those.

## Decision

`SceneManager.load` will warm up the pipelines of everything a scene can show **before the swap**, while the previous scene is still on screen. The set is derived from content, plus an explicit list for what can't be derived. In development, any pipeline compiled after loading is reported, naming its asset.

- **The warm set.** For a scene, the union of:
  - **the scene's content:** every node's MeshRenderer and model, and the closure of nested prefab instances (what `collectAssetRefs` walks today), extended to recurse into prefabs that component data references (`asset:` values naming a `.prefab.json`);
  - **prefabs the project's scripts name:** the script compiler (`src/editor/scriptLoader.ts` and the exporter, ADR 0041) records every string literal in a project script that names an existing `.prefab.json` or `.material.json`, in a per-project manifest. The pirates sample's `SPLASH_PREFAB`, `BALL_PREFAB` and `SHIP_PREFAB` are caught this way. These are warmed for every scene of the World that loads the scripts;
  - **the scene's `preload` list:** a new optional `settings.preload` array of asset paths in the scene file, for paths computed at runtime. It's editable in the scene's settings in the Inspector;
  - **calls at runtime:** `SceneManager.preload(paths)`, a new public API (a Promise), for content chosen while a game runs (a boss before its arena opens).
- **Which variants.** For each mesh in the set, the engine works out what the renderer will actually draw:
  - its material with the overrides in its data;
  - its vertex layout;
  - the World's light set (steady under 0079), fog and receive-shadows;
  - the passes the current tier's frame graph will put it in: main, geometry, and the shadow passes when it casts shadows.

  When a material has a colour override in its data, or an animation or script that can change alpha (unknown, so assumed for any material whose renderer is driven by script), both its opaque and alpha-blended variants are warmed. Other runtime-only variants are left to the report below.
- **How it warms (Babylon).** The backend builds each mesh and material as its sync would, hidden, and draws it once into scratch targets with the same formats and sample count as the real passes (for example `rgba16float` + `depth32float`, 4× MSAA). That's the only way to make Babylon create the exact pipeline. Then it disposes of the meshes. Compiled effects persist (PersistentMode), and Babylon's pipeline cache is keyed on the effect and state, so the real draw finds its pipeline ready. The work is spread over frames under a time budget (a few pipelines a frame), with `onProgress` reporting as `preloadTextures` does today.
- **How it warms (three.js, 0078).** The same set, through `renderer.compileAsync(scene, camera)` on a hidden scene of the same meshes.
- **The surface API.** `RenderSurface.warmUp(entries, onProgress)` beside `preloadTextures`. An entry is a prefab or scene path, or a material path with a mesh layout. A headless surface resolves at once.
- **The report (development only).** After a scene's warm-up, the Babylon backend watches for new effects and pipelines. In the editor's play mode and in dev builds, each one logs once, naming:
  - the node and the prefab it came from (`instantiatedPrefabs` in `SceneLoader.ts`);
  - the material;
  - the defines that differ from the nearest warmed variant;
  - the fix, for example: `[myco] prefabs/splash.prefab.json drew a shader variant that wasn't warmed (splash.material.json: +ALPHABLEND); add it to the scene's preload list or tell us the rule it needs`.

  The editor's message log offers to add the path to the scene's `preload`. Player builds don't watch.
- **Loading.** The warm-up sits inside `SceneManager.load`'s existing preload step, after textures (a texture that hasn't loaded gives a different variant), and before the swap. A World's first scene warms behind whatever the game shows while it loads.

## Alternatives considered

- **Record and replay** (Unity's collections, Unreal's recorded PSO cache): catches everything a playtest reaches. But it needs playtests before every release, goes stale as content changes, and misses what nobody played. Kept as a possible complement if the report shows derivation gaps we can't close.
- **Compile in the background and skip the draw until ready** (Godot 4.4's fallback; WebGPU's `createRenderPipelineAsync`): no hitch ever, but objects pop in a few frames late. Babylon's WebGPU engine creates pipelines synchronously, so it would mean patching Babylon's pipeline cache. Worth revisiting as a safety net after this lands.
- **Ubershaders** (one slow generic shader while the specialised one compiles): a whole second shader path for every material type. Too much for the gain.
- **Babylon's `material.forceCompilationAsync` alone:** compiles the effect but not the pipeline, which on WebGPU is made at the draw and depends on the target formats and blend state. It doesn't remove the stall.
- **Warm every material in the project at start-up:** simple and complete for small games, but start-up grows with the project and it still misses runtime variants. A project setting could offer it later.

## Consequences

**Positive**
- Content a scene can show is compiled while loading, not mid-game: no first-use hitch for anything derived or listed.
- Works on a first run with no recorded data, and can't go stale.
- The report turns any remaining hitch into a named asset and a fix, instead of an unexplained pause.
- The same set serves both backends.

**Negative / costs**
- Scene loads take longer by the compile time, roughly the hitches moved to load. The pirates match would add the splash, ghost, bolt and sail variants, perhaps 0.5–1.5 s on Windows; to measure.
- Assuming an alpha-blended variant for script-driven renderers compiles some variants that are never drawn.
- The script scan sees string literals only; computed paths need the `preload` list.
- A new public API (`SceneManager.preload`) and scene-file field (`settings.preload`), plus a new `RenderSurface` method.
- Building and drawing hidden meshes has to stay in step with how the renderer's sync builds them, or warmed variants won't match real ones. The report shows drift; a test per pass pins it.

## Deprecates

Nothing.

## Built (2026-11-06)

What changed from the decision while building, and what's left:
- **Pipeline reuse holds.** Babylon's WebGPU pipeline cache is keyed on the effect's `uniqueId` and fixed state, with the vertex part taken from each buffer's format hash and location, not buffer identity (`webgpuCacheRenderPipeline.js`). So a warm draw of the same layout and effect into the same pass targets makes the very pipeline the real draw looks up.
- **How it draws.** Batches of 6 meshes a frame, each scaled to 1e-5 at four near-plane distances in front of the first view camera. They're in the frame graph's own object list, and in the shadow casters when they cast. A batch is done after two drawn frames with every material ready and no texture loading. It's given up after 240 frames, and a mesh whose model is still loading is retried for 600 frames.
- **Textures.**
  - A material asset's textures arrive after the material is made, and the first draws of the sails compiled an untextured variant. So a batch waits while the renderer has textures loading, and its blend copies follow their base's textures.
  - The warm set's material paths are preloaded without `asset:`, as `collectAssetRefs` gives them.
  - Found on the way and fixed: a renderer's override copy (the pirates sails with their team colour) taken before its base's texture loaded stayed untextured until its next override. `rendererMaterial` now keeps an unchanged copy's textures in step with its base.
- **When frames aren't running.** `warmUp` only waits while the surface is drawing frames (a frame in the last 500 ms). A World's first scene, loaded before the engine starts, warms over the first frames instead.
- **The report.**
  - It reads a submesh's effect in every render pass (`_drawWrappers`); `subMesh.effect` is empty under the frame graph.
  - It reports only after a quiet 1.5 s once a warm-up drains or the World starts.
  - The Engine holds the switch (`_setVariantReport`, `setVariantReport(engine, on)` in `engine/editor`), so Worlds made at runtime (a lobby's match) get it too. Play mode turns it on.
  - It caught the sails gap above, naming `prefabs/ship.prefab.json` and `+ALBEDO +ALPHABLEND`.
- **Script scan.** `scene/scriptAssetRefs.ts` (no imports, so the Node exporter can use it). The editor's `loadScripts` sets it; exports write `assetRefs` into `game.json` (omitted when empty, no format change), and the player sets it from there. Headless Worlds don't warm and don't preload the warm set's assets.
- **Not yet** (tracked in [the rendering follow-ups](../plans/2026-11-rendering-followups.md)):
  - ~~the three.js backend~~ (removed by 0081);
  - ~~the Inspector field for `settings.preload`, and whether the editor keeps it on save~~ (built 2026-11-06: Scene settings in the Inspector; saving keeps the field);
  - ~~the message log's offer to add a path to it~~ (built 2026-11-06: the warning names the file, and the log offers to add it);
  - ~~particles, world-space UI and reflection-probe variants~~ (built 2026-11-06/07; GPU-kernel emitters and probe blend copies still to do, see the implementation status);
  - ~~warming again on a tier change~~ (built 2026-11-07: everything warmed is drawn again when the tier changes a pipeline setting or new probes capture).
- **Measured** (pirates Practice match, about 70 s from the click, same procedure as 0075's notes):
  - after the first 3 s (the load), frames over 100 ms: 0, against 3–6 with clustering alone and 20 on master;
  - frames over 50 ms after the load: 3, the worst 80 ms;
  - pipelines compiled after 10 s: 2;
  - the load: frames of 260–520 ms over its first 3 s, where the compiles now are.

## Open questions

- **Budget:** how many pipelines a frame to compile while the old scene keeps drawing, and whether a first scene should warm in one go behind a loading screen instead.
- **Particles and UI:** particle systems and world-space UI have their own effects. Include them in the first build, or after the report shows them?
- **Material order:** if Babylon's pipeline cache turns out to be keyed on more than the effect and state (for example the material object), warmed pipelines may not be reused. Verify first, in the spike that starts the build.
- **Tier changes:** when the quality tier changes (and with it the passes), should the loaded scenes warm again?

## References

- ADR 0075 notes: "A pause about every 5 seconds", "Frame drops whenever a light came or went" (measurements and method).
- `node_modules/@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline.js`, `Materials/effect.js` (`PersistentMode`).
- `src/engine/scene/SceneManager.ts` (`load`, the preload step), `src/engine/scene/SceneLoader.ts` (`collectAssetRefs`, `instantiatedPrefabs`), `src/engine/render/RenderSurface.ts` (`preloadTextures`).
- Unreal Engine: "PSO Precaching" and "PSO Caching" documentation; Unity: `ShaderVariantCollection`, `GraphicsStateCollection`; Godot 4.4 release notes (pipeline precompilation, ubershaders); three.js `WebGLRenderer.compileAsync`.
