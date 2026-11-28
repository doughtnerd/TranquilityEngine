# 0448. The tile grid answers side, symmetry and lattice questions, so editor tools never branch on its shape

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** — (extends 0437 and 0444)
- **Related:** 0289, 0437, 0442, 0444

## Context

0437 put all cell geometry behind one interface, `TileGrid` (`src/plugins/tilemaps/runtime/grids.ts`): one adapter
per shape (square, diamond for isometric and staggered, hexagonal) answering `cellToLocal`, `neighbours`, `drawKey` and
so on. 0442 and 0444 then added editor features that needed more from the grid than it offered, and the editor worked
the answers out from `grid.params` and from the shape name itself. An architecture review (2026-11-28) found:

- `editor/brush.ts` `sideNeighbours` took a diamond's sides as `neighbours(...).filter((_, i) => i % 2 === 0)`, so it
  depended on the order of `neighbours` (a hidden invariant across the seam), with separate branches for square and
  hexagonal grids.
- "No quarter turn on hexagonal grids" was decided in `canRotateOn` (`gridShape !== "hexagonal"`), again in the Tile
  Palette's two button titles, and again in `tileSelection.ts`'s message.
- `editor/stampLattice.ts` rebuilt the staggered and axial lattices from `grid.params`, `grid.diamond` and the raw
  `offsetToAxial` / `axialToOffset` helpers (`latticeOf`, `isShifted`, `frameOrigin`), and `brush.ts` checked
  `shape !== "staggered" && shape !== "hexagonal"` before listing a footprint's cells.
- `paintTool.ts`, `Tilemap.ts` and `collision.ts` asked `shape === "square"` to mean "cells are unit boxes scaled by the
  cell size" (shapes in cell units, voxel colliders, straight grid lines).
- Commit 046004e5 (0444's stamps keeping their shape on staggered and hexagonal maps) touched 12 files.

## Decision

We will make the grid answer these questions itself. `TileGrid` gains, implemented once per adapter:

- **`sides(x, y)`**: the cells sharing a side, in no promised order (4 on square and diamond grids, 6 on hexagonal
  ones). Flood fill uses it on every grid.
- **`quarterTurn`**: whether the square's symmetries (a quarter turn, and mirroring a block's layout) take cells to
  cells. False on hexagonal grids. The brush's `canRotateOn` and a new `turnRefusal(map)` (the one tooltip and message
  text) read it; the Tile Palette and the selection use those.
- **`cellUnits`**: whether cell (x, y) is the box `x..x+1 × y..y+1` scaled by `cellSize` (square grids).
- **Blocks and their frames (0444)**: `BlockFrame` (was the editor's `StampFrame`) moves into `grids.ts` with
  `frameOfBlockCell(frame, c, r)`, and the grid answers `frameAt(x, y)` (null where blocks land cell for cell),
  `moveCell(from, to, cell)` (a lattice translation), `placeCell(frame, corner, c, r)` and
  `blockCellAt(frame, corner, x, y, width, height)`. The lattice (diamond or axial coordinates) stays private to
  `grids.ts`.

`editor/stampLattice.ts` is deleted; its `orientedFrame` (a frame under flips, a layout question) moves to
`stampLayout.ts`. The editor modules (`brush.ts`, `selectionLogic.ts`, `paintTool.ts`, `tileSelection.ts`,
`TilePalettePanel.tsx`) and `Tilemap.ts` / `collision.ts` no longer branch on the grid's shape. Stamp files are
unchanged (`stagger` still holds `{ axis, shifted }`).

Every grid variant's lattice behaviour (blocks keep their shape, `blockCellAt` inverts `placeCell`, frames follow the
rows) is tested in `grids.test.ts`. The brush, selection and tile-editing tests keep behaviour cases on one staggered
and one hexagonal configuration instead of all eight.

## Alternatives considered

- **Keep `stampLattice.ts` and add only `sides` and `quarterTurn`.** Smaller change, but the lattice would still be
  rebuilt from `params` outside the grid, and the next grid shape would need edits in the editor again.
- **A nested `grid.lattice` object, null on square and isometric grids.** Callers would still branch on null. Every
  grid answering the block questions (cell for cell where there's no lattice) removes the branch.
- **A `rotationReason` string on the grid.** UI text doesn't belong in the runtime grid; the brush builds it from
  `quarterTurn`.

## Consequences

**Positive**
- A new grid shape is one adapter in `grids.ts`; the editor tools follow without edits.
- No caller depends on the order of `neighbours` to find sides.
- The lattice is tested once, per variant, through the interface the editor uses.

**Negative / costs**
- `TileGrid` grows by seven members.
- The selection's "can't turn" message now reads "A quarter turn isn't a symmetry of a hexagonal grid." (the button
  titles' text) instead of "Hexagonal maps can't turn tiles a quarter turn."
- A stamp with a frame now lists its `cells` in the footprint on every grid (cell for cell where the frame doesn't
  apply); the overlay draws the same outline as before.

## Deprecates

`editor/stampLattice.ts` (removed) and its `StampFrame` type (now `BlockFrame` in `runtime/grids.ts`). Shape branches
outside `grids.ts` that remain: `mesh.ts`, `tileShapeCache.ts` and `tilemapRenderer.ts` still test
`shape === "square"` (a follow-up can use `cellUnits`); the tileset's preview grid (`TilesetPreviewGrid`, a separate
setting) keeps its own branches in `tileShapeEditorLogic.ts`, `TileShapeEditor.tsx` and `autotile.ts`.

## Open questions

None.

## References

- `src/plugins/tilemaps/runtime/grids.ts`, `grids.test.ts`
- `src/plugins/tilemaps/editor/brush.ts`, `selectionLogic.ts`, `stampLayout.ts`, `tileSelection.ts`, `paintTool.ts`,
  `TilePalettePanel.tsx`
