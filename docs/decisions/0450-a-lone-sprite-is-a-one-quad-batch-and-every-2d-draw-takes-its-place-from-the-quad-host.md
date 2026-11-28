# 0450. A lone sprite is a one-quad batch, and every 2D draw takes its place from the quad host

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0445; amends 0108's per-object sprite path)
- **Related:** 0014, 0108, 0115, 0136, 0186, 0276, 0415, 0418, 0440, 0445

## Context

0445 made a quad batch own its draw place, and left lone sprites and particles alone ("lone-mesh features still use
`sortOrder.ts` directly"). Sprites drawn with a mesh of their own (9-sliced and tiled slices, graph-shaded sprites, and
every sprite in the editor's scene view, 0108) repeated `BabylonQuadBatch`'s lifecycle line for line in
`babylon/sprites.ts`: build a mesh, acquire and update a `Material2DRequest`, `placeInLayer`, tint, freeze the matrix,
release on dispose, plus their own in-place vertex updates for a 9-slice and buffer replacement for tiling.

The place rule was also spread out. `BabylonSprites` called `drawPlace` with its own warning callback (and kept a
`sortOrder` method only its tests called), the particles plugin called `drawPlace` with another, and the renderer gave
quad batches a third (`unknownLayer`). All three built the same `layer|…` key, but nothing made them the same rule.

## Decision

**A lone sprite is a quad batch.** `BabylonSprites` makes a sprite that needs its own geometry a batch through the
renderer's `BabylonQuadBatches` (`createBatch(name, { own: true })`) and gives it the 4 × 4 grid (or its tiles) with
`setQuads`, its matrix (size, pivot and flips folded in, as before) with `setMatrix`, `setOrder(layer, order, { y })`,
`setMaterial`, `setTint` and `setVisible`. It reports the batch's mesh as its `quad` drawing and the batch's `place` as
its pick order. The thin-instance path (`SpriteBatcher`, 0108) stays separate: it draws many sprites per call with
per-instance colours and UV rectangles, which a batch does not.

Two things the batch lacked, added so that rendering stays the same:

- **`own` batches.** A batch's material is shared by tint (0418); a lone sprite's never was, so a tint animated every
  frame changes one material in place rather than building one per value. `QuadBatchOptions.own` asks the 2D materials
  for an unshared material (`Material2DRequest.own`), as the sprite did.
- **Exact tints.** `QuadBatch.setTint` takes `#rrggbb` or sRGB channels `{ r, g, b }` (`QuadTint`), so a sprite's colour
  isn't rounded to 8 bits on the way.

**The quad host is the one place rule.** `BabylonQuadBatches.place(layer, order, sort?)` (renamed from `placeOf`) is
`drawPlace` on the project's render settings with the renderer's one unknown-layer warning. Batches use it for `place`;
batched sprites use it (and `ySorted`) for their instances; 2D particles get it through their host
(`particlesFeature.ts`). `BabylonFeatureHost.quads` is typed as `BabylonQuadBatches` so backend features can reach it.
`BabylonSpriteHost` loses `sortingLayers()` and `ySortedLayers()` and gains `quads`.

## Alternatives considered

- **Keep the own-mesh path and share only the place rule.** Smaller, but it keeps two copies of the mesh, material and
  vertex-update lifecycle, and lone sprites would not gain what batches gain (per-camera matrices, 0444).
- **Draw 9-slices with the thin-instance batcher.** Its material reads one UV rectangle per instance on a unit quad;
  a 9-slice needs 16 vertices whose inner lines move, so it would need a second instanced mesh and shader path.
- **Add a `place` method to the renderer-neutral `QuadBatchHost`.** Renderer-neutral features don't need it (their
  batches own their places, 0445); only backend features that draw something other than a batch do.

## Consequences

**Positive**
- One lifecycle for every lone 2D quad (tiles, decals, lines, skinned sprites, lone sprites); `sprites.ts` lost its mesh
  building, vertex updating and material plumbing for that path.
- One formula and one unknown-layer warning for every layered 2D draw, from one object the renderer configures.
- Lone sprites can follow a camera's matrix like any batch (0444), should a feature want it.

**Negative / costs**
- A 9-slice whose size changes is rebuilt once as an updatable mesh before it updates in place (a batch builds static
  first); the mesh object a sprite's drawing reports then changes once.
- Plugin render features can now see the backend class through `BabylonFeatureHost.quads`; renderer-neutral ones still
  receive it typed as `QuadBatchHost`.

## Deprecates

`BabylonSprites.sortOrder` (only tests called it; they now check the place a sprite's drawing reports),
`BabylonSpriteHost.sortingLayers`/`ySortedLayers`, `BabylonQuadBatches.placeOf` (now `place`), and the particles
plugin's own `drawPlace` call. All removed in this change.

## Open questions

- `SpriteBatcher` runs still step their places themselves (`RUN_STEP`, 0440) on top of the place they are given.

## References

- `src/engine/render/babylon/sprites.ts`, `src/engine/render/babylon/quadBatches.ts`, `src/engine/render/quadBatches.ts`,
  `src/engine/render/babylon/feature.ts`, `src/plugins/particles/runtime/particlesFeature.ts`.
- Test: `src/engine/tests/spriteBatching.test.ts` ("draws and picks a lone 9-sliced sprite in a y-sorted layer at the
  place of a batched sprite at its height").
