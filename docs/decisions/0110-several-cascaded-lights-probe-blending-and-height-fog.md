# 0110. Cascades for several directional lights, box-projected, blended and baked reflection probes, and height fog

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0050, 0053, 0054, 0071, 0075, 0079, 0080, 0081

## Context

Three accepted records left lighting gaps, all written for three.js and now on Babylon (0081):

- **0053** gives cascaded shadow maps to the first directional light only; a second sun (a moon, a rim light) gets a
  plain shadow box.
- **0054** has no box projection, no blending between probes (a mesh's reflection pops at a box's edge), and no baked
  captures (every load renders six faces per probe).
- **0071** is distance fog only; its open question asked for height fog.

Babylon already has local (box-projected) cube maps (`boundingBoxSize`/`boundingBoxPosition` on a cube texture),
prefiltered `.env` files (`CreateEnvTextureAsync`, `CubeTexture.CreateFromPrefilteredData`), material plugins that
inject shader code, and a frame-graph cascaded shadow task per light.

## Decision

**Cascades for several lights.** Tiers gain `cascadedLights` (1–4; Low 1, Medium 1, High 2, Ultra 4). On tiers with
`shadowCascades` above 1, the first `cascadedLights` enabled directional lights with shadows each get cascades
following the main camera; further ones keep plain maps. On devices at WebGPU's minimum of 16 inter-stage values it's
one light: each cascaded light passes two more values, and a material past the limit fails to compile and draws black
(`lighting.ts`, `cascadeLimit`).

**Reflection probes.** `ReflectionProbe` gains:

- `boxProjection` (off): reflections are corrected as if the surroundings were the probe's box (Babylon's local cube
  maps), for rooms.
- `blendDistance` (1 m): inside that distance of the primary box's faces, a mesh fades towards the next smallest box
  holding it (`probeBoxes.ts`, `blendProbes`). The weight is rounded to 8 steps, since each step is a material copy.
  A material plugin on the probe copy samples the neighbour's cube with Babylon's own helpers
  (`computeCubicCoords`/`computeCubicLocalCoords`, `sampleReflectionTexture`) and mixes the specular radiance
  (`render/babylon/probeBlend.ts`). Diffuse ambient stays the primary's. With no second box, the primary is used
  alone: probes don't fade into the global environment.
- `refresh: "baked"` with `bakedMap` (a `.env` file): the probe uses the file and never captures; without a usable
  file it warns and captures on load. The editor's **Bake** button on a probe writes its current capture to
  `probes/<scene>-<node>.env` (`RenderSurface.bakeReflectionProbe`) and sets the two fields.

**Height fog.** `Fog` gains `heightFog`, `heightFogDensity` (0.05), `heightFogBase` (0 m) and `heightFogFalloff`
(0.2), and `mode` gains `none` (height fog alone). Density is `d · e^(−falloff · (y − base))`, integrated along the
view ray from the camera to the pixel; the amount is `1 − e^(−integral)`, mixed to the fog colour after distance fog.
It's a material plugin registered for every PBR material (built-in, physical, shader graph, sprites, water;
`render/babylon/heightFog.ts`), compiled in only while the World has height fog and for meshes that take fog, so
turning it on or off recompiles lit materials once, like distance fog, and its values are uniforms.

## Alternatives considered

- **Cascades for every directional light.** Unbounded shadow passes and inter-stage values; a tier field keeps it
  predictable.
- **Blending by drawing a blended cube per probe pair.** Needs a per-face, per-mip blend pass and re-blending when
  an `everyFrame` probe recaptures; the shader sample is cheaper and per pixel.
- **Probes fading into the global environment.** Meshes walking out of a room would lose its reflections at the door.
- **Height fog as a depth-based post effect** (0071's suggestion). It's lost on tiers without post-processing and
  needs a depth pass; the material plugin works on every tier and composes with transparency.

## Consequences

**Positive**
- Scenes with two suns get sharp shadows from both on High and Ultra.
- Interiors reflect their walls in the right place; reflections don't pop between rooms; builds skip probe captures.
- Valleys, swamps and seas get ground fog that thins with height, on every tier.

**Negative / costs**
- Each cascaded light costs its cascades' shadow passes.
- Blend copies multiply probe material copies (up to 8 weights per pair of probes in use); the neighbour's diffuse
  isn't blended.
- A blend between a baked probe and a captured one may sample one of them flipped (different cube orientations);
  untested.
- Every PBR material carries a dormant plugin (one define).
- Particles (their own shaders, owned by the GPU particles work) don't take height fog yet.

## Deprecates

Nothing. Answers open questions in 0053 (CSM for several lights), 0054 (box projection, blending, baking) and 0071
(height fog).

## Open questions

- Blending the neighbour's diffuse ambient (spherical harmonics).
- Height fog on particles and on the sky (`affectsSkybox` covers distance fog only).
- Visual check on WebGPU: probe captures read black on the WebGL2 fallback in headless Chromium, on master too.

## References

- `src/engine/render/babylon/lighting.ts`, `probes.ts`, `probeBlend.ts`, `heightFog.ts`; `src/engine/render/probeBoxes.ts`
- Tests: `babylonLighting.test.ts`, `babylonProbes.test.ts`, `reflectionProbes.test.ts`, `heightFog.test.ts`
- Browser check: `spikes/babylon/rendering.html?case=probes` (`&fog` for height fog)
