# 0079. Point and spot lights without shadows render through Babylon's clustered lighting

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0043, 0075, 0078, 0080

## Context

Babylon writes the lights on a material into its shader source: `LIGHTCOUNT 5`, `POINTLIGHT4` and so on, one block of code per light, up to the material's `maxSimultaneousLights` (8 in this engine). So a material has a different shader for every light count and mix of types. When a light comes or goes, every lit material compiles a new shader and WebGPU pipeline. On Windows that's 100–500 ms per burst, with the GPU process busy and the frame waiting (ADR 0075, "Frame drops whenever a light came or went").

In the pirates sample each ship carries a lantern (a point light). Ships spawn and sink all match, so the light count wandered between 2 and 7, and frames of up to 1.4 s followed each change. The stop-gap in `lighting.ts` (2026-11-06) keeps the light set steady:
- A gone or disabled Light's Babylon light stays at zero intensity for reuse.
- A World with a point light reserves dark point lights up to 8.

That took frames over 100 ms in 65 s of a match from 20 to 6. But it has costs:
- Every lit pixel evaluates 8 lights, most of them dark.
- There's still a hard cap of 8 lights per material; a ninth lights nothing.
- A Light that's switched off still holds a slot, so a scene with more than 8 Lights can lose a lit one.

Other engines avoid all of this with **clustered (Forward+) lighting**:
- The view is cut into screen tiles and depth slices, and each frame a pass works out which lights touch each cluster.
- The lights live in a GPU buffer, and each pixel loops over its cluster's lights with a count read at runtime.
- So there's one shader whatever the number of lights, and a pixel pays only for the lights near it.

Unity's URP Forward+ and Unreal work this way. three.js has no equivalent.

Babylon 9 (we're on 9.32) ships it as `ClusteredLightContainer` (`@babylonjs/core/Lights/Clustered/`):
- **The container is itself a light.** It takes one slot on a material, and its defines (`CLUSTLIGHT0`, `CLUSTLIGHT_BATCH 32`, `CLUSTLIGHT_SLICES 16`) don't change as lights are added or removed.
- **Storage:** on WebGPU it holds lights in batches of 32, in a light-data texture and a tile-mask storage buffer written with atomics. It defaults to 64×64 tiles and 16 depth slices (the DOOM 2016 logarithmic split).
- **Shading:** the PBR shader has a clustered path (`pbrClusteredLightingFunctions`). It uses the same distance and spot falloff functions as regular lights and covers clearcoat, sheen, anisotropy and subsurface. Every engine material is a `PBRMaterial` (`materials.ts`, `graphMaterial.ts`, `water.ts`).
- **What it takes:** point and spot lights only. No shadows, no falloff other than the default, no projection or IES textures. `ClusteredLightContainer.IsLightSupported(light)` checks this.
- **Engines:** on WebGL2 it needs float-blendable colour buffers; on WebGL1 it's unavailable (`isSupported` is false).
- **Frame graph:** the object renderer task runs the clustering pass before it draws when built with `{ enableClusteredLights: true }`. It's off by default; `frameGraph.ts` created its render tasks without options until this record.

## Decision

We will draw point and spot lights that don't cast shadows through one `ClusteredLightContainer` per Babylon scene. Every other light stays a regular Babylon light.

- **Which lights cluster.** A Light clusters when all of these hold:
  - its type is `point` or `spot`;
  - `castShadows` is off, or the tier has no shadows;
  - the container is supported on this engine.

  Directional and ambient lights stay regular, and so do shadow-casting point and spot lights: Babylon can't cluster a light with a shadow map, and a game has few of them.
  A Light whose `type` or `castShadows` changes moves between the container and the scene. That costs one recompile, as changing a shadow setting does today.
- **Ownership.** `BabylonLighting` (`lighting.ts`) creates the container lazily, with the first clustered Light, so a World without point or spot lights pays nothing. It keeps the container until the scene is disposed. It mirrors each Light onto its Babylon light as today: colour, intensity, position, direction, range, angle and softness.
- **Coming and going** (changed while building, 2026-11-06).
  - A new Light: a parked clustered light of its type if there is one, else a new Babylon light made outside the scene's list (`dontAddToScene`) and added with `container.addLight`.
  - A gone or disabled Light: its Babylon light stays in the container, parked at zero intensity and a range of 0.001 m, so it falls in almost no cluster. The next Light of its type reuses it.
  - Why not remove it: the container draws its lights whether they're enabled or not, and Babylon's `removeLight` hands a light back to the scene, which marks every mesh's lights dirty. Babylon's `dispose` alone leaves it in the container.
  - Either way: no recompile, and no light limit.
- **Device limits** (found while building). Clustering adds a value passed from the vertex to the fragment stage. A material with cascaded shadows and two-sided lighting (the pirates sample's) then needs 17, past WebGPU's minimum of 16 (`maxInterStageShaderVariables`). Its pipeline failed and the whole pass drew black.
  - The WebGPU engines (`BabylonRenderer.create`, `previews/common.ts`) now ask for the adapter's limits (`setMaximumLimits`); the test machine's adapter allows 28.
  - A device still at 16 doesn't cluster: its lights stay regular, with the stop-gap.
- **Frame graph.** In `frameGraph.ts`, each camera's main render task gets `enableClusteredLights: true`. Geometry, shadow and overlay passes don't light anything, so they don't cluster.
- **Several cameras in one frame.** Babylon's container sorts its lights and fills its depth slices once per frame, for the first camera that renders. A second camera (the editor's camera preview, split screen, a picture-in-picture camera) would shade against the first camera's slices. Before each camera's render task, the backend makes the container compute again for that camera. The fix belongs upstream (key the cache on the camera); until Babylon has it, we patch it in one place with a test. Each camera also needs a tile count to suit its size; the defaults hold for now.
- **Tier settings.** Tiles and slices keep Babylon's defaults (64×64, 16) on every tier, and the clamp on any one light's range (`maxRange`) stays at its default. They're internal and can be tuned per tier later without an API change.
- **When it's unsupported.** WebGL2 without float blending, or a test's `NullEngine`: every light is regular, with the stop-gap (parked lights and the dark point-light reserve) unchanged. The stop-gap stays for regular lights everywhere, since parking still saves a recompile when a shadow-casting light comes or goes. The reserve applies only where clustering is unsupported.
- **three.js backend (0078).** Unchanged. It has no clustered lighting and keeps its per-count shaders. That's acceptable because it's the fallback backend, not the default.
- **No public API change.** The Light component and its fields stay as they are; Babylon stays out of the public API (0010).

## Alternatives considered

- **Keep the stop-gap only.** It works, but it shades 8 lights per pixel always, caps lights at 8, and can drop a lit light past the cap.
- **Our own Forward+ in WGSL.** Full control over culling and the shader, but it reimplements what Babylon maintains, against our own preference for maintained libraries. It would also need its own PBR light loop kept in step with Babylon's.
- **Deferred shading.** Also decouples shaders from light count, but Babylon's deferred path (the prepass renderer) doesn't cover transparency, our material plugins or MSAA the way forward rendering does, and would rework the frame graph.
- **A uniform loop over a fixed light array** (URP's older forward path): one shader with a runtime count, but every pixel loops over every light, and it means patching Babylon's PBR shader. Clustering gets the same steady shader and also culls per tile.
- **Baking and light probes.** Right for static lights and scenery, and planned separately. Moving and spawned lights, like lanterns, can't be baked.

## Consequences

**Positive**
- Point and spot lights without shadows come, go, move and switch on and off with no shader compile.
- No limit of 8 on them: lights cluster in batches of 32, and the buffers grow as needed.
- A pixel shades only the lights in its cluster, instead of 8 lights (most of them dark) everywhere.
- Builds on maintained Babylon code; no shader of ours to keep in step.

**Negative / costs**
- **A clustering pass per lit camera per frame:** a small instanced draw into the tile mask, plus a light-data texture upload and a WebGPU command flush when the lights change. Expected to be well under 1 ms at pirates scale; to measure.
- **Shadow-casting point and spot lights still recompile materials when they come or go.** Parking softens it.
- **The per-camera fix patches Babylon internals** until upstream handles it, and must be checked on each Babylon upgrade (a test pins it).
- **Lighting can differ slightly from today**: the same falloff maths but a different code path and summing order. To confirm with a pixel compare of a paused frame.
- **The backends differ:** three.js keeps the old per-count behaviour.

## Deprecates

- **The dark point-light reserve** in `lighting.ts` (`reservePointLights`), except where clustering is unsupported.
- **Parking outside the container for point and spot lights without shadows.** They park inside the container instead; parking stays for regular lights.

## Open questions

- **Viewports.** Does the tile mask match a camera that draws to part of the target (split screen)? It's sized from `engine.getRenderWidth()`, not the viewport. To test with two viewports.
- **GPU cost against the stop-gap.** Babylon's GPU timer reads 0 under a frame graph (0075), so this needs timestamp queries or a visible-window comparison.
- **Spot softness.** Our softness sets `innerAngle`. Check that the clustered spot cone matches the regular one at a few softness values.
- **Should range be required?** Clustering needs a finite range (Babylon clamps to `maxRange` 16,383). Our default range is 10, so engine lights always have one.

## References

- `node_modules/@babylonjs/core/Lights/Clustered/clusteredLightContainer.pure.js`, `ShadersWGSL/ShadersInclude/pbrClusteredLightingFunctions.js`, `Rendering/objectRenderer.js` (`enableClusteredLights`).
- `src/engine/render/babylon/lighting.ts`, `frameGraph.ts`, `materials.ts`, `graphMaterial.ts`, `water.ts`.
- ADR 0075 notes: "Frame drops whenever a light came or went" (measurements and method).
- Ángel Ortiz, "A Primer On Efficient Rendering Algorithms & Clustered Shading" (2018), the depth split Babylon uses.
- Unity URP Forward+ rendering path documentation, for comparison.
