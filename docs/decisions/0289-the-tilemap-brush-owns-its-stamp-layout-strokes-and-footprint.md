# 0289. The tilemap brush owns its stamp layout, strokes and footprint

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0103, 0138, 0231

## Context

Tilemap painting (ADR 0103) was spread over four places in `src/plugins/tilemaps/editor/`: `brushCells.ts` (the value
painted at one cell, a pure function pulled out for its tests), `brush.ts` (`paintCells`, which re-implemented stamp
placement for pencil strokes, plus `fillAt` and `pickFromMap`, each clamping the active layer itself), `paintTool.ts`
(the stroke's state and rules: what a move paints, what the release does, and its own footprint sizing in the
overlay) and `TilePalettePanel.tsx` (three copies of "choose this stamp and switch to the pencil").

The seam leaked a bug: flipping or rotating a multi-cell stamp composed the flips into each tile but never transformed
the block, so a mirrored 3 × 1 stamp painted its tiles in the original order and a rotated 2 × 3 stamp still painted
2 × 3; the footprint was not swapped either. The tests covered flip composition only. The footprint also showed the
stamp's size for a random brush (which paints one cell per cell) and, mid-stroke, did not follow the stamp grid the
stroke paints on.

## Decision

We will make `brush.ts` the one module that answers what a brush paints.

- **Strokes.** `beginStroke(map, tool, cell)` returns a `BrushStroke` (`moveTo(cell)`, `finish()`, `footprint()`,
  `tool`, `start`, `last`). Pencil and erase paint as the pointer moves, fill floods on the press, a rectangle paints
  on release, a pick takes the block into the brush. `finish()` says whether there is something to commit.
- **Footprint.** `footprintAt(tool, cell)` (no stroke) and `stroke.footprint()` give the cells as a `Footprint`
  rectangle. The pencil's footprint is the stamp as laid out, on the stroke's stamp grid; a random or terrain brush,
  erase and fill cover one cell.
- **Layout under flips.** The stamp is oriented once per stroke: each cell's centre maps through `tileFlips.flipPoint`
  with the brush's flags (so the block and its tiles follow the one orientation convention), width and height swap
  on a diagonal flip, and each tile's flags compose with the brush's. Painting, tiling and footprint all read the
  oriented stamp.
- **Choosing.** `chooseStamp(stamp, random?)` and `chooseTerrain(name)` set the brush and pick the pencil when needed;
  the Tile Palette calls them.
- **The paint tool** (`paintTool.ts`) keeps pointer handling, the gesture (one undo step, Escape) and drawing the
  overlay; it holds a `BrushStroke` and draws its footprint.
- `brushCells.ts` is deleted; `paintCells`, `fillAt`, `pickFromMap` and `strokeCells` become private to `brush.ts`.
  Tests drive whole strokes through `beginStroke`.

## Alternatives considered

- **Fix the flip in `paintCells` and the overlay separately** — two more copies of the same rule, the same seam that
  produced the bug.
- **A pure planner returning cells and values** — terrain painting and flood fill need the map (auto-tiling,
  neighbours), so a pure plan would only cover the stamp case and the map-driving paths would stay split.

## Consequences

**Positive**
- Painting, footprint and picking agree; flipped and turned multi-cell stamps paint mirrored and swapped.
- The palette, the paint tool and the overlay use one brush; the paint tool shrinks to pointer and gesture.

**Negative / costs**
- `brush.ts` grows (about 270 lines); the brush is still module-level signals, as before.

## Deprecates

`brushCells.ts` (`brushValueAt`, `withBrushFlips`), exported `paintCells`, `fillAt`, `pickFromMap`, `strokeCells` and
`brushTile` (replaced by `chooseStamp`).

## Open questions

None.

## References

`src/plugins/tilemaps/editor/brush.ts`, `paintTool.ts`, `TilePalettePanel.tsx`, `brush.test.ts`;
`src/plugins/tilemaps/runtime/tileFlips.ts`.
