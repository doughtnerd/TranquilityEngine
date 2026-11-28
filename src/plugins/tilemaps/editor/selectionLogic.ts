// The tile selection (ADR 0442): a set of cells of a Tilemap and what the selection tool does to the layers it acts on
// (copy, clear, move, flip and turn in place), on the map's cells as the brush paints them. Works in cell space on
// every grid (ADR 0437), as the brush does: a rectangle is a cell-space rectangle, and flips and turns lay the cells out
// as the brush lays out a stamp (`stampLayout.ts`); where the grid can't turn (hexagonal maps) only the tiles' images
// flip. Copies keep the frame the grid gives them and moves are the grid's moves (`TileGrid.frameAt`, `moveCell`,
// ADR 0448), so on staggered and hexagonal maps cells keep their shape (ADR 0444). Locked layers
// (ADR 0441) are the caller's to leave out of `layers`. The editor glue (paintTool.ts) commits each operation as one
// undo step.
import type { Tilemap } from "../runtime";
import type { Cell } from "../runtime/brushes";
import { FLIP_DIAGONAL } from "../runtime/format";
import { orientCell, withFlips } from "./stampLayout";
import type { StampBlock } from "./stampLibrary";

/** Selected cells as `"x,y"` keys. */
export type CellSelection = ReadonlySet<string>;

/** How a dragged rectangle changes the selection: replaces it, adds to it (Shift) or takes from it (Alt). */
export type SelectMode = "replace" | "add" | "subtract";

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** A key back to its cell. */
export function keyCell(key: string): Cell {
  const i = key.indexOf(",");
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** Whether layer `i` of `map` is locked (ADR 0441): the editor's brushes, fills, picks and selection skip it. */
export function layerLocked(map: Tilemap, i: number): boolean {
  return map._layers()[i]?.meta.locked === true;
}

/** The layers the selection acts on: every unlocked layer with `all`, else the active one unless it's locked. */
export function selectionLayers(map: Tilemap, active: number, all: boolean): number[] {
  if (all) return Array.from({ length: map.layerCount }, (_, i) => i).filter((i) => !layerLocked(map, i));
  return active >= 0 && active < map.layerCount && !layerLocked(map, active) ? [active] : [];
}

/** `sel` changed by the rectangle between cells `a` and `b` (inclusive). */
export function selectRect(sel: CellSelection, a: Cell, b: Cell, mode: SelectMode): Set<string> {
  const out = mode === "replace" ? new Set<string>() : new Set(sel);
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mode === "subtract") out.delete(cellKey(x, y));
      else out.add(cellKey(x, y));
    }
  }
  return out;
}

/** Every cell holding a tile in any of `layers` (Ctrl/⌘+A). */
export function usedCells(map: Tilemap, layers: readonly number[]): Set<string> {
  const out = new Set<string>();
  for (const li of layers) for (const { x, y } of map.tiles(li)) out.add(cellKey(x, y));
  return out;
}

/** The smallest rectangle holding the selection, `x0..x1 × y0..y1` with the ends exclusive, or null when empty. */
function selectionBounds(sel: CellSelection): { x0: number; y0: number; x1: number; y1: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const key of sel) {
    const [x, y] = keyCell(key);
    if (!b) b = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
    else {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x + 1);
      b.y1 = Math.max(b.y1, y + 1);
    }
  }
  return b;
}

/**
 * The selected cells of `layers` as a block over the selection's bounds, each layer named as the map's (cells outside
 * the selection empty); null when they hold no tile.
 */
export function copySelection(map: Tilemap, sel: CellSelection, layers: readonly number[]): StampBlock | null {
  const b = selectionBounds(sel);
  if (!b || layers.length === 0) return null;
  const width = b.x1 - b.x0, height = b.y1 - b.y0;
  const names = map.toLayerData().map((l) => l.name);
  const block: StampBlock = {
    width,
    height,
    layers: layers.map((li) => {
      const values = new Array<number>(width * height).fill(0);
      for (const key of sel) {
        const [x, y] = keyCell(key);
        values[(y - b.y0) * width + (x - b.x0)] = map.getCell(x, y, li);
      }
      return { name: names[li] ?? "", values };
    }),
  };
  const frame = map._grid().frameAt(b.x0, b.y0);
  if (frame) block.frame = frame;
  return block.layers.some((l) => l.values.some((v) => v !== 0)) ? block : null;
}

/** Empty the selected cells of `layers`. Returns how many cells changed. */
export function clearSelection(map: Tilemap, sel: CellSelection, layers: readonly number[]): number {
  let n = 0;
  for (const li of layers) for (const key of sel) if (map.setCell(...keyCell(key), 0, li)) n++;
  return n;
}

/** The selected cells' values in `layers`, lifted: read, and (unless `keep`) cleared. */
function lift(map: Tilemap, sel: CellSelection, layers: readonly number[], keep: boolean): { cell: Cell; layer: number; value: number }[] {
  const out: { cell: Cell; layer: number; value: number }[] = [];
  for (const li of layers) {
    for (const key of sel) {
      const cell = keyCell(key);
      const value = map.getCell(cell[0], cell[1], li);
      if (value) out.push({ cell, layer: li, value });
    }
  }
  if (!keep) clearSelection(map, sel, layers);
  return out;
}

/**
 * Where each cell lands when the selection moves so that cell `anchor` (default: the selection's bottom-left corner)
 * moves by `(dx, dy)` cells: on staggered and hexagonal maps by the grid's lattice, so the cells keep their shape
 * (ADR 0444); elsewhere every cell moves by `(dx, dy)`.
 */
function mover(map: Tilemap, sel: CellSelection, dx: number, dy: number, anchor?: Cell): (cell: Cell) => Cell {
  const b = selectionBounds(sel);
  const from: Cell = anchor ?? (b ? [b.x0, b.y0] : [0, 0]);
  const to: Cell = [from[0] + dx, from[1] + dy];
  const grid = map._grid();
  return (cell) => grid.moveCell(from, to, cell);
}

/** The selection moved so that cell `anchor` (default: its bottom-left corner) moves by `(dx, dy)` cells, keeping its shape (as `moveSelection` moves it). */
export function movedSelection(map: Tilemap, sel: CellSelection, dx: number, dy: number, anchor?: Cell): Set<string> {
  const move = mover(map, sel, dx, dy, anchor);
  return new Set([...sel].map((k) => cellKey(...move(keyCell(k)))));
}

/**
 * Move the selected cells of `layers` so that cell `anchor` (default: the selection's bottom-left corner; the cell a
 * drag grabbed) moves by `(dx, dy)` cells (with `copy`, copy them, leaving the originals). On staggered and hexagonal
 * maps the cells keep their shape (ADR 0444): an odd number of rows (columns) away they move by the grid's lattice.
 * Cells the moved tiles land on are replaced; empty selected cells leave the cells they land on alone. Returns the
 * moved selection.
 */
export function moveSelection(map: Tilemap, sel: CellSelection, layers: readonly number[], dx: number, dy: number, copy = false, anchor?: Cell): Set<string> {
  const moved = movedSelection(map, sel, dx, dy, anchor);
  if (dx === 0 && dy === 0) return moved;
  const move = mover(map, sel, dx, dy, anchor);
  for (const { cell, layer, value } of lift(map, sel, layers, copy)) {
    const [x, y] = move(cell);
    map.setCell(x, y, value, layer);
  }
  return moved;
}

/**
 * Flip (`FLIP_X`, `FLIP_Y`) or turn (`TURN_CLOCKWISE`) the selected cells of `layers` in place, within the selection's
 * bounds (a turn keeps the bottom-left corner and swaps the bounds' width and height), each tile's flips composed with
 * `flags`. Without `layout` (hexagonal maps, ADR 0437) cells stay where they are and only their images flip; turns
 * do nothing. Returns the transformed selection.
 */
export function transformSelection(map: Tilemap, sel: CellSelection, layers: readonly number[], flags: number, layout = true): Set<string> {
  const b = selectionBounds(sel);
  if (!b) return new Set(sel);
  if (!flags || (!layout && flags & FLIP_DIAGONAL)) return new Set(sel);
  const width = b.x1 - b.x0, height = b.y1 - b.y0;
  const place = ([x, y]: Cell): Cell => {
    if (!layout) return [x, y];
    const at = orientCell(x - b.x0, y - b.y0, width, height, flags);
    return [b.x0 + at.c, b.y0 + at.r];
  };
  for (const { cell, layer, value } of lift(map, sel, layers, false)) {
    const [x, y] = place(cell);
    map.setCell(x, y, withFlips(value, flags), layer);
  }
  return new Set([...sel].map((k) => cellKey(...place(keyCell(k)))));
}

/**
 * The map layers a block pastes into (ADR 0442): a one-layer block into `active`, a block of several layers into the
 * map's layers of the same names. Missing and locked layers are skipped.
 */
export function blockTargets(map: Tilemap, block: StampBlock, active: number): { layer: number; values: number[] }[] {
  if (block.layers.length === 1) return active >= 0 && active < map.layerCount && !layerLocked(map, active) ? [{ layer: active, values: block.layers[0].values }] : [];
  const out: { layer: number; values: number[] }[] = [];
  for (const l of block.layers) {
    const i = map.layerIndex(l.name);
    if (i >= 0 && !layerLocked(map, i)) out.push({ layer: i, values: l.values });
  }
  return out;
}
