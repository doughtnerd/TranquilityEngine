# 0127. Material resolution is renderer-neutral; a per-scene Babylon material library builds from it

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0047, 0049, 0050, 0054, 0071, 0080, 0081, 0089, 0106, 0107, 0108, 0126

## Context

Turning a material asset into a Babylon material had no module of its own. It lived in
`BabylonRenderer.ts` (about 600 of its 1,983 lines and fifteen caches), and the editor's previews
(`previews/common.ts`) had a second copy: shader-asset reading, sampling modes and texture loading.
Commit 42f2858 had to fix shader-asset support in both places. The warm-up (`PipelineWarmer`, ADR 0080)
was built with nine callbacks into the renderer's private methods, and the thumbnails resolved material
slots (ADR 0089) with their own, slightly different, rules.

The engine has changed renderers once already (three.js to Babylon, ADR 0075 and 0081). Most of this code
isn't about Babylon. It decides which material a slot draws, which values a script Material sets, when a
build is stale, which keyword variants warm-up compiles, and how import settings sample an image. A
renderer change would mean working all of that out again.

## Decision

We split material handling in two.

1. **`render/materialResolution.ts`, renderer-neutral.** It imports no backend types and returns plain
   data:
   - `resolveMaterial(path)`: kind (none, built-in, graph), settings, compiled graph or shader asset,
     property and keyword values, fog opt-out, instancing, warnings, and a `MaterialStamp`.
   - `isStampCurrent`: staleness, from the material JSON, the graph JSON, sub-graph and code files, and
     the shader level.
   - `slotSources`/`pickSlot`: slot order. Each slot tries `materials[i]`, then `material`, then the
     model's import settings, then the model's own material.
   - `scriptValues`/`sharedAction`: script Material values over the asset's, and when a shared version
     is applied (ADR 0107).
   - `overrideWarnings`/`knownProperties`: overrides (ADR 0049).
   - `warmVariantKeywords`: keyword variants (ADR 0106).
   - `samplingOf`/`textureLoad`: sampling and texture uses.
2. **`render/babylon/materialLibrary.ts`, `BabylonMaterialLibrary`, one per Babylon scene.** It is the
   only code that builds Babylon materials and textures from those descriptions: material assets, graph
   and shader-asset materials, script-instance and override copies, probe-reflecting copies, shared slot
   multi-materials, particle copies, and textures with import-settings sampling. Its interface:
   - `material(path)`;
   - `meshMaterials(renderer, slots)`, the material for each MeshRenderer slot;
   - `slotMaterials(request, sources)`, for warm meshes and thumbnails;
   - `texture(path, use)` and `loadedTexture`;
   - `warmVariants(material)`, `isGraph`, `fogless`, `instancing`;
   - `loading()` and `settled()`;
   - `probeCopy`, `copy`, `release`, and `beginSync`/`endSync` (script instances no renderer drew are
     freed).

Every caller goes through the library:
- the World renderer;
- `PipelineWarmer`, which now takes one `materials` dependency (`WarmMaterials`);
- particles, tilemaps and UI, through their existing host callbacks;
- the previews, each with a library on its own preview scene (`previewMaterials`). Previews show assets
  as saved (`scriptMaterials: false`), and thumbnails keep their own single warning.

A new renderer reuses `materialResolution.ts` as it is and writes only an adapter like
`BabylonMaterialLibrary`.

## Alternatives considered

- **One Babylon module holding both policy and building.** This removes the duplicate but leaves the
  policy tied to Babylon, so a renderer change would still re-derive it.
- **A material module behind `RenderSurface`.** This puts materials in the public render-surface seam,
  which ADR 0010 keeps backend-free and which a parallel change is narrowing. The library is internal to
  the Babylon backend.
- **Keep the previews on their own builder.** This is the duplicate that drifted (shader assets,
  sampling, slot fallback).

## Consequences

**Positive**
- `BabylonRenderer.ts` loses about 630 lines and its fifteen material and texture caches. The warmer's
  nine callbacks become one object.
- Previews and the World draw the same material for the same asset:
  - slot fallback when an asset is missing;
  - shader-asset code files and their staleness;
  - sampling and wrapping;
  - shared multi-materials.
- Material behaviour is tested through the library on NullEngine (`materialLibrary.test.ts`), and the
  policy is tested in-process (`materialResolution.test.ts`). No test casts away the renderer's private
  constructor for material reasons.

**Negative / costs**
- Some small preview differences:
  - Thumbnails use the World's slot fallback. A slot whose `materials[i]` can't be drawn now falls back
    to `material`.
  - The node previews share one texture cache instead of loading textures per graph and never freeing
    them.
  - Preview materials are named like the World's (`material:…`, `graph:…`), not `preview:…`.
- The texture loads for shader graphs used to cache a failed load for good. They now retry on the next
  request, as colour textures already did.

## Deprecates

- In `previews/common.ts`: `buildPreviewMaterial`, `loadTexture`, `samplingMode`, `readShaderAsset`,
  `defaultPreviewMaterial`, `PreviewMaterial`, `MaterialSource`, `TextureUse`. All removed.
- In `ThumbnailRenderer.ts`: `slotPicker`, removed.
- `WarmDeps`'s `materialFor`, `materialForSource`, `slotMaterials`, `isGraph`, `fogless`, `instancing`,
  `keywordVariants` and `loadingTextures` are replaced by `materials: WarmMaterials`.

## Open questions

- Whether `MaterialPreview`'s live graph (an unsaved, in-memory graph) should go through the library as
  a description rather than through `createGraphMaterial` with the library's textures.

## References

- `src/engine/render/materialResolution.ts`
- `src/engine/render/babylon/materialLibrary.ts`
- `src/engine/tests/materialResolution.test.ts`
- `src/engine/tests/materialLibrary.test.ts`
