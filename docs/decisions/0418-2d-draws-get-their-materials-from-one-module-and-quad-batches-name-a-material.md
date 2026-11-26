# 0418. 2D draws get their materials from one module, and quad batches name a material

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0130, 0135, 0136, 0395, 0396, 0399, 0414, 0415

## Context

**Three modules decide how a 2D draw is lit.** `render/babylon/sprites.ts` (`litSetup()`, line 317), `quadBatches.ts`
(`litSetup()`, line 90) and `particles.ts` (`layer2D()`, line 155) each check whether the material is lit, find the rig
with `lights2DOf(scene)`, call `batchOfLayer`, load the normal and mask maps and build the same key,
`` `lit${batch}@${rig.version}|…` ``. `sprites.ts` reads import settings itself, repeating `quadLighting()`
(`render/lights2D/spriteMaterial.ts:79`). Rig changes are noticed three ways: `BabylonRenderer.sync` keeps
`lights2DVersion` and calls `quads.refreshLighting()`, the sprite feature polls the version and forgets materials by
matching `@${version}|` in the key string, and particles fold the version into their key. Plain, masked and graph
variants, lit or not, alpha or additive, are built separately (`acquireMaterial` / `maskedMaterial`, about 12 duplicated
lines and three release paths).

**The quad batch interface (`render/quadBatches.ts`, ADR 0136) grows a setter per 2D record.** ADRs 0395, 0399 and 0415
added `setColors`, `setMask`, `setLighting`, `setTangents` and `setBlend`. Two carry ordering rules ("call it after the
geometry; a new geometry with another vertex count drops it"). Each addition touched the Babylon adapter and five
hand-written `QuadBatchHost` fakes (tilemap, lines, volumes, decals, sprites2d tests). The four callers (lines,
tilemaps, decals, skinned sprites) each call `quadLighting(material, layer, image)` and repeat "tangents iff a normal
map", calling `tangents2D(...)`. Every caller gets its order from `sortOrder(sortingLayer, orderInLayer)`, and
`QuadLighting.sortingLayer` repeats that layer. All three `setColors` callers set colours right after the geometry.

**The same "texture now, or load and warn once" pattern is copied about eight times**: three closures in the
`BabylonRenderer` constructor (lines 219–243), `spritesFeature.ts`, `decals.ts`, `dynamicMeshes.ts` and twice in
`quadBatches.ts`, each with its own warn key and wording.

**`XFeature` classes pass through.** `lights2dFeature.ts`, `linesFeature.ts`, `tilemapsFeature.ts` and the decals feature
forward `sync`, `release`, `dispose`, `loaded` and `diagnostics` to an `XRenderer`.

## Decision

- **2D materials module** (`render/babylon/materials2D.ts`). Callers ask for a material for (texture, material asset,
  sorting layer, blend, mask) and get a handle. It owns the lit decision, the normal and mask maps from the texture's
  import settings, the graph-or-layered choice (ADR 0415), the sharing key, release, and invalidation: it watches the
  lighting rig's version itself and refreshes handles in place. Sprites, quad batches and particles call it. Callers never
  see versions or keys; `BabylonRenderer.sync` loses `lights2DVersion` and `quads.refreshLighting()`, and nothing matches
  key strings.
- **The quad batch names a material.**
  - `setOrder(sortingLayer, orderInLayer)` replaces `setOrder(order: number)` and `QuadBatchHost.sortOrder`.
  - `setMaterial(materialAsset | null)` replaces `setLighting(QuadLighting)` and `setTangents`. The host resolves lighting
    through the 2D materials module and works out tangents from the geometry it holds when a normal map applies, including
    each frame for a deforming mesh (`setTriangles`).
  - `setQuads` and `setTriangles` take optional per-vertex `colors`; `setColors` goes. The batch has no ordering rules left.
  - `setMask`, `setBlend`, `setTint`, `setMatrix`, `setVisible`, `dispose` and `textureSize` stay.
  - The interface stays `@internal` (not in `myco`), so this is no public API change.
- **One texture call in the material library**: `texture(path, use, onReady)` returns the texture or null, starts loading
  when needed, calls `onReady` once, and warns once per path and use with one wording. The eight copies call it;
  `BabylonQuadBatchDeps` and `BabylonSpriteHost` shrink.
- **Renderers implement `BabylonFeature` directly**; the pass-through `XFeature` classes go. Lazy loading (ADR 0130, 0135)
  is unchanged: the lazy chunk is the renderer plus its factory.
- **Spike: explicit 2D light binding.** After the above lands, a half-day spike tests whether `Light2DPlugin.bindLights`
  can get the per-camera light textures handed to it rather than through `lights2DOf(scene)` / `lights2DTextures(scene,
  camera)` (scene-keyed WeakMaps), so the frame graph can keep `optimizeTextureAllocation` on (36ab1a75 turned it off).
  If it works, it gets its own record; if Babylon's material-plugin binding forbids it, this record gains a short note why.

Glossary: **2D materials** (Rendering).

## Alternatives considered

- **Narrow the quad batch only** — the lit logic would still be copied in sprites and particles.
- **Pass the sorting layer inside `setMaterial`** — keeps a number order and a layer that can disagree; one
  `setOrder(sortingLayer, orderInLayer)` makes that impossible.
- **Keep `setColors`, document the rule** — the rule is the friction; every caller already has colours with the geometry.
- **A shared helper for the lit setup, kept in each caller** — removes lines but not the three version-tracking paths.

## Consequences

**Positive**
- One place to fix a 2D lit-binding bug; the next 2D draw kind is lit by asking for a material.
- Four plugins stop knowing about normal maps and tangents; five test fakes shrink and stop churning.
- Key and invalidation rules are tested through the module's interface, not by string matching.

**Negative / costs**
- Touches the Babylon adapter, four plugins and their tests at once.
- Tangents for skinned sprites are worked out inside the host; the cost moves, it doesn't vanish.

## Deprecates

- `QuadBatch.setLighting`, `setTangents`, `setColors`, `setOrder(number)`, `QuadBatchHost.sortOrder`, `QuadLighting`
  (callers); `quadLighting()` becomes internal to the 2D materials module.
- The `litSetup()` copies in `sprites.ts`, `quadBatches.ts` and `particles.ts`; `layer2D()`'s key; `lights2DVersion`.
- The `XFeature` pass-through classes in lights2d, lines, tilemaps and decals.

## Open questions

- The light-binding spike's outcome (above).

## References

- Architecture review, 2026-11-25 (candidates 2, 3, 7, 8, 9).
- `src/engine/render/quadBatches.ts`, `src/engine/render/babylon/{sprites,quadBatches,particles,lights2D,lights2DMaterial,frameGraph,materialLibrary}.ts`.
