# 0186. Layered 2D quads own the 2D material and the draw order

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0014, 0108, 0136, 0185

## Context

ADR 0014 draws 2D content in sorting-layer order, not by depth. On Babylon that order is each transparent mesh's
`alphaIndex` (Babylon sorts transparent meshes by it, lowest first, then back to front), and the material that
lets it work is unlit PBR, two-sided, alpha-blended, with no depth write and depth test ALWAYS.

Both were written several times. The material was set up line for line in `sprites.ts` (a lone sprite's mesh),
`spriteBatches.ts` (sprite runs, 0108) and `quadBatches.ts` (tilemaps through `QuadBatchHost`, 0136).
`alphaIndex` was written four ways: a lone sprite's order in `sprites.ts`, a run's order plus `RUN_STEP` per
further run in `spriteBatches.ts`, a quad batch's order in `quadBatches.ts`, and `particleAlphaIndex` for
particle meshes in `particleDraw.ts` (0185). Tiles, sprite runs and particle meshes interleave correctly only if
all four agree, and nothing said so in one place. The sprite batching tests cast the feature to its internals six
times and read Babylon's private `_thinInstanceDataStorage`.

## Decision

We will have one module, `src/engine/render/babylon/layeredQuads.ts` ("layered 2D quads", formerly
`spriteBatches.ts`), own how 2D content draws on Babylon. Its interface:

- `layeredQuadMaterial(name, scene, texture)`: the 2D quad material. Lone sprites, sprite runs (which add the
  per-instance UV plugin) and quad batches (which add tint and opacity) start from it.
- `placeInLayer(mesh, order)`: a lone sprite or a quad batch at its draw order (`sortingOrder`: layer index ×
  10000 + order in layer).
- `SpriteBatcher`: sprite runs per texture and order, the first run of an order at the order, each further run
  `RUN_STEP` (1e-4) past the one before.
- `placeParticles(mesh, renderOrder)`: a particle mesh by its emitter's `renderOrder`: 0 at Babylon's default
  (`Number.MAX_VALUE`, with the scene's other transparent meshes, after all 2D content), negative at that value,
  positive at +Infinity.

No other code writes `alphaIndex` for 2D or particle meshes. `sprites.ts`, `quadBatches.ts` and
`particleDraw.ts` are its callers; `QuadBatchHost` (0136) is unchanged. The values are those the four writers
produced, with one fix: the run step compared `Math.floor` of the previous run's `alphaIndex` with the order, so
two textures at a fractional order (`orderInLayer` is any number) tied; it now compares the previous run's order.

The sprite batching tests drive `SpriteBatcher` and `BabylonSprites` through their interfaces and read the scene
through Babylon's public API (meshes, `alphaIndex`, `thinInstanceCount`, the buffers handed to
`thinInstanceSetBuffer`). The test-only `SpriteBatcher.meshes()` and `BabylonQuadBatches.meshes()` are removed.

## Alternatives considered

- **A per-scene `LayeredQuads` object handed to every caller** — the order mapping is pure, and the particle draw
  factory has no renderer object to receive it through; module functions keep the callers unchanged in shape.
- **Leave the writers where they are and document the shared scale** — the four places would still drift apart;
  one owner is what makes the agreement checkable in one test.
- **Put particle `renderOrder` on the sorting-layer scale** — would change what existing scenes draw; kept as is
  and written down here.

## Consequences

**Positive**
- One place says where every 2D and particle mesh sits in the draw order; one test checks tiles, sprite runs,
  lone sprites and particle meshes together (`engine/tests/layeredQuads.test.ts`).
- The 2D material can change once for all 2D content.

**Negative / costs**
- Particle `renderOrder` and the 2D draw order still use different scales (a negative `renderOrder` sits among
  the first sorting layer's orders); the module states it rather than resolving it.

## Deprecates

`spriteBatches.ts` (renamed `layeredQuads.ts`), `particleAlphaIndex`/`orderMesh` in `particleDraw.ts`, the
duplicated material setup in `sprites.ts` and `quadBatches.ts`, `SpriteBatcher.meshes()` and
`BabylonQuadBatches.meshes()` (test-only): removed.

## Open questions

Whether particle `renderOrder` should join the sorting-layer scale (sorting layer and order for particle
systems, as Unity's renderer module has).

## References

`src/engine/render/babylon/layeredQuads.ts`, `src/engine/tests/layeredQuads.test.ts`,
`src/engine/tests/spriteBatching.test.ts`.
