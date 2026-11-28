# 0445. A quad batch owns its draw place and reports it for picking

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0136 and 0276; implements 0440's picking rule for quad batches)
- **Related:** 0014, 0136, 0186, 0276, 0437, 0440

## Context

Quad batches (0136) are how renderer-neutral 2D features draw: tile chunks, 2D lines and decals, skinned sprites and
light volumes. Their place in the draw order (`alphaIndex`, set only by `layeredQuads.ts`, 0186) became a sum after
0437 and 0440: the sorting layer's draw order plus a `within` offset (painter's order, or a height in a y-sorted layer).

Each feature worked that place out twice. It called `drawPlace(...)` (`sortOrder.ts`) for its pick order, then
separately `ySortWithin(...)` to pass to `QuadBatch.setOrder(layer, orderInLayer, within)`; nothing tied the two
together (skinned sprites, decals and lines all did this). Skinned sprites and decals called `drawPlace` without a
warning callback because "the batch warns", so the unknown-layer rule was split as well. The Babylon batch was the one
place that computed the real place, and it never reported it.

That split hid a bug. A tile layer reported one `DrawnNode` (0276) for all its batches with `order: sortingOrder(...)`,
no offset. In a y-sorted layer a tile row drawn over a sprite still picked below it, against 0440's "picking uses the
same places, so a click picks what is drawn on top"; painter's-order chunks on isometric and hexagonal maps had the
same problem. Five tests each hand-rolled a fake `QuadBatchHost` that recorded raw `setOrder` arguments.

## Decision

**A batch owns its place.** `QuadBatch.setOrder(sortingLayer, orderInLayer, sort?)` takes a `DrawSort`
(`{ y?, within? }`): `y` is the sort point's world height, which counts when the layer is y-sorted; `within` is an
explicit sub-order in [0, 1) used otherwise (painter's order, 0437). The batch decides whether the layer is y-sorted,
maps the height, warns once about an unknown layer (through the renderer), places its mesh through `layeredQuads.ts`
(still the one place that sets `alphaIndex`), and reports the result as `QuadBatch.place`.

- **One rule.** `drawPlace(render, layer, order, at, warn)` in `sortOrder.ts` takes a height or a `DrawSort` and is
  the only formula; the Babylon batches call it with the project's render settings.
- **The host answers y-sorting.** `QuadBatchHost.ySorted(sortingLayer)` is for a feature whose geometry depends on it:
  a tile layer splits chunks into rows there, and 2D decals share a batch only at one height there.
- **Picking reads each batch.** A `DrawnNode` whose shape is `quads` carries no `order` (the type forbids it). The
  renderer resolves such a drawing into one editor drawing per distinct batch place, each picked at that place, so a
  tile layer's rows and painter's-order chunks pick as they draw. A feature that draws one batch and reports another
  shape (a 2D line's polyline) reads its batch's `place` for the pick order.
- **Features stop computing places.** Tilemaps, skinned sprites, 2D decals and 2D lines no longer import
  `drawPlace`, `ySortWithin` or `isYSorted`. Lone-mesh features (sprites, particles) still use `sortOrder.ts` directly.
- **One test host.** `src/engine/tests/memoryQuadHost.ts` (a test helper, not a production export) is an in-memory
  `QuadBatchHost` whose batches compute `place` with `drawPlace`; feature tests assert places, not raw arguments.

## Alternatives considered

- **Keep `within` on the interface and add `place` only.** Smaller change, but features would still have to know
  whether a layer is y-sorted to compute `within`, and the duplicate rule stays.
- **Give `DrawnNode` a per-batch order array.** Keeps one drawing per tile layer, but parallel arrays are easy to get
  out of step, and the batch already knows its place.
- **Let a feature yield one `DrawnNode` per batch.** Works, but every feature would repeat the grouping, and the
  renderer already resolves `quads` drawings to meshes.

## Consequences

**Positive**
- A click in a y-sorted layer picks the tile row, decal, line or skinned sprite drawn on top, and isometric chunks pick
  in painter's order.
- One place computes a quad's place and warns about an unknown layer; features pass what they know (layer, order,
  sort point).
- Feature tests share one fake host and check behaviour (places) instead of call arguments.

**Negative / costs**
- A y-sorted tile layer reports one editor drawing per row height (more entries in picking and outlines; same nodes).
- 2D decals on different sorting layers that happened to share a place (two unknown layers) no longer share a batch.

## Deprecates

`QuadBatch.setOrder`'s numeric `within` argument (replaced by `DrawSort`), `BabylonQuadBatchDeps.sortOrder` (replaced
by `sortSettings` and `unknownLayer`), and `order` on quad-batch `DrawnNode`s. All removed in this change.

## Open questions

- Sprites (`babylon/sprites.ts`) and the sprite batcher still compute their places themselves; a later change may move
  them onto the same owner.

## References

- `src/engine/render/sortOrder.ts`, `src/engine/render/quadBatches.ts`, `src/engine/render/babylon/quadBatches.ts`,
  `src/engine/render/babylon/BabylonRenderer.ts` (`drawn`), `src/engine/render/babylon/feature.ts` (`DrawnNode`).
- Test: `src/engine/tests/renderFeatureDrawn.test.ts` (tile row vs sprite picking in a y-sorted layer).
