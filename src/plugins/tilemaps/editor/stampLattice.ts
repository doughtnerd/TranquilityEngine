// Stamps that keep their shape on staggered and hexagonal maps (ADR 0444). A block of cells is a rectangle in the map's
// offset coordinates, but rows (stagger axis y) or columns (axis x) alternate between shifted and unshifted, so the same
// rectangle has another shape on screen when its bottom-left cell is in a row of the other kind. A block therefore
// remembers its `StampFrame` (the stagger axis and whether its bottom-left row or column is a shifted one), which fixes
// each cell's position relative to the block's origin in the grid's lattice coordinates (diamond coordinates on
// staggered maps, axial ones on hexagonal maps). Placed elsewhere, cells move by a lattice translation and convert back
// to offset coordinates (`moveCell`). Square and isometric cells are their own lattice: blocks land cell for cell.
// A block without a frame (a palette block, a stamp saved before ADR 0444) lands cell for cell on every grid. Pure.
import type { Cell } from "../runtime/brushes";
import { axialToOffset, offsetToAxial, type StaggerAxis, type TileGrid } from "../runtime/grids";
import { orientCell } from "./stampLayout";

/** Where a block of cells was laid out on a staggered or hexagonal map. */
export interface StampFrame {
  /** The stagger axis of the map it was laid out on. */
  axis: StaggerAxis;
  /** Whether the block's bottom-left row (axis y) or column (axis x) is a shifted one. */
  shifted: boolean;
}

/** Converts a grid's cells to lattice coordinates and back; null for square and isometric grids (cells are the lattice). */
function latticeOf(grid: TileGrid): { to(x: number, y: number): Cell; from(a: number, b: number): Cell } | null {
  const { shape, staggerAxis: axis, staggerIndex: index } = grid.params;
  if (shape === "staggered" && grid.diamond) return { to: grid.diamond.toDiamond, from: grid.diamond.fromDiamond };
  if (shape === "hexagonal") return { to: (x, y) => offsetToAxial(x, y, axis, index), from: (q, r) => axialToOffset(q, r, axis, index) };
  return null;
}

/** Whether cell (x, y) of a staggered or hexagonal grid is in a shifted row (axis y) or column (axis x). */
function isShifted(grid: TileGrid, x: number, y: number): boolean {
  const n = grid.params.staggerAxis === "y" ? y : x;
  return (n & 1) === (grid.params.staggerIndex === "odd" ? 1 : 0);
}

/** The frame of a block whose bottom-left cell is (x, y) of `grid`; undefined on square and isometric grids. */
export function frameAt(grid: TileGrid, x: number, y: number): StampFrame | undefined {
  if (!latticeOf(grid)) return undefined;
  return { axis: grid.params.staggerAxis, shifted: isShifted(grid, x, y) };
}

/**
 * Where `cell` lands when cells move so that cell `from` lands on cell `to`, keeping their shape: a lattice translation
 * on staggered and hexagonal grids, the plain offset elsewhere.
 */
export function moveCell(grid: TileGrid, from: Cell, to: Cell, cell: Cell): Cell {
  const lattice = latticeOf(grid);
  if (!lattice) return [cell[0] + to[0] - from[0], cell[1] + to[1] - from[1]];
  const a = lattice.to(from[0], from[1]), b = lattice.to(to[0], to[1]), c = lattice.to(cell[0], cell[1]);
  return lattice.from(c[0] + b[0] - a[0], c[1] + b[1] - a[1]);
}

/** A cell of `grid` with the frame's kind of row or column, standing for where the block was laid out. */
function frameOrigin(grid: TileGrid, frame: StampFrame): Cell {
  const n = frame.shifted === isShifted(grid, 0, 0) ? 0 : 1;
  return frame.axis === "y" ? [0, n] : [n, 0];
}

/** Whether a block of `frame` keeps its shape by a lattice move on `grid` (a frame of the grid's stagger axis on a staggered or hexagonal grid). */
function framed(grid: TileGrid, frame: StampFrame | null | undefined): frame is StampFrame {
  return !!frame && frame.axis === grid.params.staggerAxis && latticeOf(grid) !== null;
}

/**
 * The cell where cell (c, r) of a block laid out in `frame` lands when the block's bottom-left cell is placed on
 * `corner`: by a lattice move on a staggered or hexagonal grid of the frame's stagger axis, else cell for cell.
 */
export function placeCell(grid: TileGrid, frame: StampFrame | null | undefined, corner: Cell, c: number, r: number): Cell {
  if (!framed(grid, frame)) return [corner[0] + c, corner[1] + r];
  const o = frameOrigin(grid, frame);
  return moveCell(grid, o, corner, [o[0] + c, o[1] + r]);
}

/**
 * Which cell of a `width × height` block laid out in `frame`, tiled from a placement on `corner`, falls on cell (x, y):
 * the inverse of `placeCell`, wrapped into the block (a rectangle tiles the stamp's pattern over its cells).
 */
export function blockCellAt(grid: TileGrid, frame: StampFrame | null | undefined, corner: Cell, x: number, y: number, width: number, height: number): { c: number; r: number } {
  let c = x - corner[0], r = y - corner[1];
  if (framed(grid, frame)) {
    const o = frameOrigin(grid, frame);
    const s = moveCell(grid, corner, o, [x, y]);
    c = s[0] - o[0];
    r = s[1] - o[1];
  }
  return { c: ((c % width) + width) % width, r: ((r % height) + height) % height };
}

/**
 * The frame of a `width × height` block laid out under the flips `flags` (`stampLayout.orientedStamp`): the frame of
 * the cell that becomes its bottom-left. Unchanged without `layout` (hexagonal maps, where only images flip).
 */
export function orientedFrame(frame: StampFrame | null | undefined, width: number, height: number, flags: number, layout = true): StampFrame | null {
  if (!frame) return null;
  if (!layout || !flags) return frame;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const at = orientCell(c, r, width, height, flags);
      if (at.c === 0 && at.r === 0) return { axis: frame.axis, shifted: frame.shifted !== (((frame.axis === "y" ? r : c) & 1) === 1) };
    }
  }
  return frame;
}
