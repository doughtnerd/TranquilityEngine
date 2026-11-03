# 0053. HDR environments and skyboxes through an Environment component; cascaded shadows set by quality tier

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0043, 0050, 0051, 0052

## Context

Lit materials reflect a built-in studio room (0043), and a directional light's shadows cover a fixed box around its node. High-fidelity outdoor scenes need two things that the quality work (0050–0052) left out: image-based lighting and a sky from an HDR photo (equirectangular `.hdr` or `.exr`), and shadows that stay sharp near the camera across a large area (cascaded shadow maps). three.js r187 has `HDRLoader`, `EXRLoader`, `PMREMGenerator.fromEquirectangular` and a `CSM` addon for WebGLRenderer. Its `CSM.setupMaterial` replaces a material's `onBeforeCompile`, and its constructor swaps two shader chunks globally behind a `USE_CSM` define.

## Decision

### Environment

- `.hdr` and `.exr` files are project assets ("Environment" kind in the Assets panel). PNG and JPEG equirectangular images work too.
- An **`Environment`** component (`engine.Environment`, one per World, the first active one wins) sets the scene's lighting and sky:
  - `map`: an asset path, empty for the built-in studio room.
  - `intensity`: environment lighting, default 1.
  - `skybox`: draw the map as the background, default on; off keeps the camera's background colour.
  - `skyboxIntensity`: default 1.
  - `skyboxBlur`: 0–1, default 0.
  - `rotation`: degrees around Y, default 0.
- Without an Environment the studio room stays at 0.4, as before.
- The maps load on demand, with three's HDR or EXR loader imported only when a World uses one, and are prefiltered with PMREM. Under 0051's composer, the sky is tone mapped with the scene.

### Cascaded shadows

- Quality tiers (0050) gain `shadowCascades` (1 = off, up to 4) and `shadowDistance` (metres the cascades cover from the camera). The defaults are Low 1 and 30, Medium 2 and 50, High 3 and 80, Ultra 4 and 120.
- On a tier with more than one cascade, the first enabled directional light with `castShadows` is drawn through three's `CSM`, following the main camera. It uses the tier's shadow map size per cascade, the light's colour, intensity and direction, and fades between cascades. The light's own `shadowArea` box is ignored in that case.
- Every material in the World is set up for CSM, including shader graph materials, whose `onBeforeCompile` is chained ahead of CSM's.
- Other lights keep ordinary shadow maps.

## Alternatives considered

- **Skybox and environment as project settings.** Unity keeps them in per-scene lighting settings; a component lives in the scene like the lights (0043) and can change at run time.
- **Our own cascades.** CSM is maintained with three and handles cascade fitting and texel snapping.
- **Cubemap skyboxes (six images).** Less common in asset libraries than equirectangular HDRs; can be added later.

## Consequences

**Positive**
- Photographic lighting and skies from free HDRI libraries.
- Sharp shadows across large outdoor scenes, scaled by quality tier.

**Negative / costs**
- HDR maps are large downloads; PMREM prefiltering costs a moment when a map loads.
- CSM swaps two three.js shader chunks globally once it's used. They're guarded by its define, but a three.js upgrade could break the combination; this is covered by tests on real WebGL.
- Each cascade is a shadow render, so Ultra's four cascades cost four shadow passes.

## Deprecates

Nothing. The built-in studio room remains the default environment.

## Open questions

- Reflection probes (local environment maps) and cubemap skies.
- Procedural skies (sun position, atmosphere).
- CSM for several directional lights.

## References

- three.js `HDRLoader`, `EXRLoader`, `PMREMGenerator`, `examples/jsm/csm/CSM.js`.
