# 0424. Y-sorted sorting layers interleave sprites and tile rows by their height on screen

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0014 and 0103)
- **Related:** 0014, 0103, 0108, 0136, 0186, 0399, 0418, 0421

## Context

2D content draws without a depth test, ordered by `alphaIndex` = sorting layer index × 10 000 + order in layer
(`sortOrder.ts`, `layeredQuads.ts`). Within one order, sprite runs of different textures step by `RUN_STEP` (1e-4),
and a tile layer's chunks share their layer's order. Nothing sorts by position: a character can be entirely in front
of a tile layer or entirely behind it, never behind one wall and in front of the next. Top-down and isometric games
(0421) need that: Unity sorts along a Transparency Sort Axis (usually Y) and draws Tilemaps in Individual mode for
it; Godot has `y_sort_enabled` on a parent node and on TileMapLayers.

Sprites are batched (0108): within an order, one thin-instance mesh per material run. A tile layer is one batch per
(chunk, texture). Babylon sorts transparent meshes by `alphaIndex`, then by distance, which under an orthographic 2D
camera says nothing about screen height.

## Decision

**A sorting layer can be y-sorted.** Project settings gain `render.ySortedLayers: string[]` (default empty; names
from `render.sortingLayers`; edited as a checkbox column beside the sorting layer list). In a y-sorted layer, draws
with the same order in layer are ordered by their **sort point's world height**: higher first, so lower things draw
over them. Different orders in layer still sort by order first, as Unity does. Non-y-sorted layers draw exactly as
now.

- **The place** of a y-sorted draw is `sortingOrder(...) + ySortFraction(y)`, where `ySortFraction` maps world y
  monotonically (higher y, smaller fraction) into [0, 0.5): linear over ±100 000 units, clamped beyond. It lives in
  `render/sortOrder.ts` beside `sortingOrder`, and `layeredQuads.ts` is still the only place that sets `alphaIndex`.
  Orders in layer of a y-sorted layer must then be at least 1 apart, which whole numbers are.
- **Sprites** sort by their node's world position (the pivot), Unity's default sort point. In a y-sorted layer the
  sprite batcher gives up texture runs and draws each sprite at its own place, still batching consecutive sprites
  that share a material and the same place (equal heights, common on a grid).
- **Tile layers** on a y-sorted sorting layer draw one batch per (chunk, row, texture) instead of per (chunk, texture),
  placed at the row's sort point: the bottom of the row's cell boxes on square maps, the bottom corner of each
  diamond row or hexagon row on the grids of 0421 (`TileGrid.drawKey` already ranks those rows). A tile that should
  sort by a point other than its cell's bottom (a tree whose trunk is in the cell above) can set `sortOffset` (cells,
  default 0) in the tileset; the row is split by sort point when its tiles differ. Floors go on a layer that isn't
  y-sorted, so they stay one batch per chunk.
- **Other layered 2D content** (decals, lines, skinned sprites, particles with a negative render order) takes its node's
  position as its sort point when its sorting layer is y-sorted, through the same `ySortFraction`.
- **Picking** (0276) uses the same places, so a click picks what is drawn on top.
- **Lit sprites** (0399): the light textures are per sorting layer, unchanged by the order inside it.

### Path to a high-end pipeline

This is a constraint on this design, not a plan.

- **HDR and 2D lights.** Only draw order changes; materials, light textures and HDR output are untouched.
- **Motion vectors.** Unaffected: each draw keeps its own matrix.
- **GPU-driven batching.** Y-sorting is a per-draw sort key (order in layer, then height), so a later GPU-driven path
  sorts keys (on the CPU or with a GPU radix sort) and emits ordered indirect draws; batches per tile row are already
  static geometry. A depth-buffer alternative (z from y, alpha cut-out) would allow unordered draws for hard-edged
  pixel art, but loses soft edges; it can be an option later without changing the setting.

## Alternatives considered

- **A per-node switch** (Godot's `y_sort_enabled` on a parent). Flexible, but sorting is a property of what shares a
  layer; a per-layer setting is one checkbox and matches how scenes are organised in Unity.
- **A sort axis** (Unity's custom axis, e.g. (0, 1, −0.26) for isometric). Y covers top-down and the isometric and
  hex grids of 0421; an axis can be added later as a setting without changing the per-draw key.
- **Depth test with alpha cut-out.** No sorting at all, but breaks semi-transparent edges, shadows and lit sprites'
  blending; kept as a possible option.
- **Per-tile batches.** Exact for any sort point, but thousands of meshes for a big layer; rows give the same result
  for tiles that sort by their cell.

## Consequences

**Positive**
- Characters walk behind and in front of walls, trees and props in top-down and isometric games.
- Tiles and sprites share one rule; floors and non-y-sorted layers cost nothing extra.

**Negative / costs**
- A y-sorted tile layer has up to 16 times as many batches (one per row per chunk), and its sprites batch less.
- Moving sprites change place every frame they move vertically (a property write, no rebuild).
- Fractional orders in layer in a y-sorted layer can collide with the height fraction (documented; whole numbers
  are fine).

## Deprecates

Nothing.

## Open questions

- A custom sort axis, and a per-sprite sort point other than the pivot (Unity's Sprite Sort Point: center).

## References

- ADR 0014 (amended: within an order, a y-sorted layer orders by height), 0103 (amended: tiles sort by row there),
  0108 (sprite runs), 0421 (grid draw keys).
- Unity Transparency Sort Mode/Axis and Tilemap Renderer Individual mode; Godot `CanvasItem.y_sort_enabled`.
- Code: `src/engine/render/sortOrder.ts`, `src/engine/render/babylon/layeredQuads.ts`,
  `src/plugins/tilemaps/runtime/tilemapRenderer.ts`, `src/engine/core/settings.ts`.
