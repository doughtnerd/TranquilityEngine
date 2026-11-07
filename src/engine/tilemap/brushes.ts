/**
 * Brush geometry for painting tilemaps (ADR 0103), shared by the editor's tools and scripts.
 * Pure: cells in, cells out.
 */

export type Cell = [number, number];

/** Every cell of the rectangle spanned by two corner cells (inclusive). */
export function rectCells(ax: number, ay: number, bx: number, by: number): Cell[] {
  const out: Cell[] = [];
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y]);
  return out;
}

/** The cells on a line between two cells (Bresenham), so a fast pencil drag leaves no gaps. */
export function lineCells(ax: number, ay: number, bx: number, by: number): Cell[] {
  const out: Cell[] = [];
  const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay), sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
  let err = dx + dy, x = ax, y = ay;
  for (;;) {
    out.push([x, y]);
    if (x === bx && y === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) (err += dy), (x += sx);
    if (e2 <= dx) (err += dx), (y += sy);
  }
  return out;
}

/**
 * The 4-connected region of cells with the same value as the start cell. An empty region is
 * bounded by `bounds` (the area searched), so filling empty space stops instead of running forever;
 * at most `limit` cells are returned.
 */
export function floodCells(
  sx: number,
  sy: number,
  valueAt: (x: number, y: number) => number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  limit = 100_000,
): Cell[] {
  const target = valueAt(sx, sy);
  const seen = new Set<string>();
  const out: Cell[] = [];
  const stack: Cell[] = [[sx, sy]];
  while (stack.length && out.length < limit) {
    const [x, y] = stack.pop()!;
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (valueAt(x, y) !== target) continue;
    out.push([x, y]);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** A rectangular block of cell values to paint, `values[row * width + col]`, row 0 at the bottom. 0 cells are skipped when stamping. */
export interface Stamp {
  width: number;
  height: number;
  values: number[];
}

/** The cells a stamp paints with its bottom-left at (x, y), with their values (empty cells skipped). */
export function stampCells(stamp: Stamp, x: number, y: number): { x: number; y: number; value: number }[] {
  const out: { x: number; y: number; value: number }[] = [];
  for (let r = 0; r < stamp.height; r++) {
    for (let c = 0; c < stamp.width; c++) {
      const v = stamp.values[r * stamp.width + c];
      if (v) out.push({ x: x + c, y: y + r, value: v });
    }
  }
  return out;
}
