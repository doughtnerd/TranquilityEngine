/**
 * Tile grid geometry (ADR 0437): one module owns where cells are. A `TileGrid` for a shape and its parameters answers
 * every question the rest of the plugin asks about cells (the Tilemap's coordinate methods, chunk meshes, collision,
 * auto-tiling, the brush and the editor overlay). Pure: no engine imports, points as `[x, y]` in the map's local
 * units (y up), cells as integer `[x, y]`.
 *
 * `cellSize` (w × h) is one cell's bounding box on every shape.
 *
 * - **square**: cell (x, y) covers `x·w .. (x+1)·w` × `y·h .. (y+1)·h`, the numbers the Tilemap has always used.
 * - **isometric**: cell (x, y) is a diamond centred at `((x − y)·w/2, (x + y)·h/2)`. The map's x axis runs up-right
 *   and its y axis up-left on screen, so cell (0, 0) is the map's bottom corner. Cell space maps to local space by an
 *   affine map ("diamond space": cell (u, v) covers u..u+1 × v..v+1, `diamondToLocal`).
 * - **staggered**: the same diamonds addressed as offset rows (stagger axis y) or columns (axis x), as Tiled's
 *   staggered isometric maps are. `staggerIndex` says which rows (columns) are the shifted ones:
 *   - axis y: row y's centres sit at height `y·h/2`; a shifted row's cells sit half a cell (w/2) to the right of where
 *     an unshifted row's would. Row 0 is unshifted under "odd" and shifted under "even".
 *   - axis x: column x's centres sit at `x·w/2` across; a shifted column's cells sit half a cell (h/2) lower.
 *   Every staggered cell is one diamond-space cell (`toDiamond` / `fromDiamond`), so staggered maps merge collision
 *   and pick neighbours exactly as isometric ones do; their neighbours are the diamond's (an "N" is up-left on screen).
 * - **hexagonal**: offset coordinates as Tiled stores them, the same stagger rules. `hexSide` is the length of the flat
 *   sides along the stagger axis as a fraction of the cell size on that axis (Tiled's `hexsidelength` / tile size):
 *   - axis y (pointy-top): rows `(h + hexSide·h)/2` apart, flat sides vertical, shifted rows w/2 to the right.
 *   - axis x (flat-top): columns `(w + hexSide·w)/2` apart, flat sides horizontal, shifted columns h/2 lower.
 *   0 gives diamonds, 1 offset rectangles. Neighbours and the axial conversion use axial coordinates (`offsetToAxial`).
 *
 * **Tiled.** Tiled's maps are y-down; the picture is the same, only the row numbers run the other way.
 * `tiledCellToCell` converts a Tiled cell to this module's cell for a map of a given size, keeping `staggerAxis`,
 * `staggerIndex` and `hexSide` as Tiled has them (`staggeraxis`, `staggerindex`, `hexsidelength / tilewidth|height`):
 * - orthogonal: `(tx, H − 1 − ty)`.
 * - isometric: `(H − 1 − ty, W − 1 − tx)`: Tiled's x axis runs down-right, so its axes swap; Tiled's bottom corner
 *   (W − 1, H − 1) becomes cell (0, 0).
 * - staggered and hexagonal, axis x: `(tx, H − 1 − ty)`.
 * - staggered and hexagonal, axis y: `(tx, K − ty)` with K the even number of H − 1 and H, so every row keeps its
 *   parity and its shift (for an even H the rows run 1..H).
 */

export type GridShape = "square" | "isometric" | "staggered" | "hexagonal";
export type StaggerAxis = "x" | "y";
export type StaggerIndex = "odd" | "even";

export type GridPoint = [number, number];

/** A grid's shape and parameters (the Tilemap's fields). */
export interface GridParams {
  shape: GridShape;
  cellSize: { x: number; y: number };
  staggerAxis?: StaggerAxis;
  staggerIndex?: StaggerIndex;
  hexSide?: number;
}

/** An axis-aligned box in local units: `x, y` its bottom-left. */
export interface GridBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Diamond space (isometric and staggered grids): where the grid's cells are one diamond-space cell each. */
export interface DiamondSpace {
  /** The diamond-space cell of a grid cell. */
  toDiamond(x: number, y: number): GridPoint;
  /** The grid cell of a diamond-space cell. */
  fromDiamond(u: number, v: number): GridPoint;
  /** A diamond-space point (cell (u, v) covers u..u+1 × v..v+1) in local units: an affine map that keeps orientation. */
  toLocal(u: number, v: number): GridPoint;
}

export interface TileGrid {
  readonly shape: GridShape;
  readonly params: Readonly<Required<GridParams>>;
  /** A cell's centre. */
  cellToLocal(x: number, y: number): GridPoint;
  /** The cell holding a local point. */
  localToCell(px: number, py: number): GridPoint;
  /** The cell's corner points, counter-clockwise (4 for square and diamond cells, up to 6 for hexagons). */
  cellOutline(x: number, y: number): GridPoint[];
  /** The bounding box a tile's sprite is placed in. */
  cellBox(x: number, y: number): GridBox;
  /** The point at `(s, t)` of the cell's box (0..1 from its bottom-left; outside for an overhang). */
  cellBoxPoint(x: number, y: number, s: number, t: number): GridPoint;
  /** Neighbour cells: 8 (N NE E SE S SW W NW of the grid's axes) or, on hexagonal grids, 6 clockwise (see `neighbourCount`). */
  neighbours(x: number, y: number): GridPoint[];
  /** How many `neighbours` a cell has: 8, or 6 on hexagonal grids (and so how long an auto-tiling pattern is). */
  readonly neighbourCount: 6 | 8;
  /** Painter's order: draw cells in increasing key (higher on screen first). */
  drawKey(x: number, y: number): number;
  /** Isometric and staggered grids only. */
  readonly diamond: DiamondSpace | null;
}

/** N NE E SE S SW W NW in cell space (square and isometric grids; diamond space for staggered ones). */
const OFFSETS_8: readonly GridPoint[] = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
];

/**
 * Axial neighbours, clockwise from the first side at or clockwise of north. Pointy-top (stagger axis y, a corner points
 * north): NE E SE SW W NW. Flat-top (axis x, a side faces north): N NE SE S SW NW. The two axial frames make it one list.
 */
const AXIAL_6: readonly GridPoint[] = [
  [0, 1], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1],
];

const odd = (n: number) => n & 1;
/** A cell coordinate without a negative zero (Math.round and Math.ceil give -0), so cells compare equal. */
const cell = (x: number, y: number): GridPoint => [x + 0, y + 0];

/** Whether row (or column) `n` is a shifted one. */
function shifted(n: number, index: StaggerIndex): number {
  return index === "odd" ? odd(n) : 1 - odd(n);
}

/**
 * A staggered cell's diamond-space cell. Row (column) 0 of an "odd" map lines up with diamond space; an "even" map is
 * diamond space moved by half a cell (`staggeredOffset`), so rows keep their parity.
 */
export function staggeredToDiamond(x: number, y: number, axis: StaggerAxis, index: StaggerIndex): GridPoint {
  if (axis === "y") {
    const d = index === "odd" ? 2 * x + odd(y) : 2 * x - odd(y);
    return cell((y + d) / 2, (y - d) / 2);
  }
  const s = index === "odd" ? 2 * y - odd(x) : 2 * y + odd(x);
  return cell((s + x) / 2, (s - x) / 2);
}

/** The staggered cell of a diamond-space cell (the inverse of `staggeredToDiamond`). */
export function diamondToStaggered(u: number, v: number, axis: StaggerAxis, index: StaggerIndex): GridPoint {
  if (axis === "y") {
    const y = u + v, d = u - v;
    return cell(index === "odd" ? (d - odd(y)) / 2 : (d + odd(y)) / 2, y);
  }
  const x = u - v, s = u + v;
  return cell(x, index === "odd" ? (s + odd(x)) / 2 : (s - odd(x)) / 2);
}

/** A staggered "even" map's offset from diamond space, in local units (zero for "odd"). */
function staggeredOffset(axis: StaggerAxis, index: StaggerIndex, w: number, h: number): GridPoint {
  if (index === "odd") return [0, 0];
  return axis === "y" ? [w / 2, 0] : [0, -h / 2];
}

/**
 * A hexagonal cell's axial coordinates `[q, r]`: for stagger axis y, `r` is the row and a cell's centre is
 * `q + r/2` cells across (plus half a cell on "even" maps); for axis x, `q` is the column and its centre is `r + q/2`
 * cells up (minus half a cell on "even" maps).
 */
export function offsetToAxial(x: number, y: number, axis: StaggerAxis, index: StaggerIndex): GridPoint {
  if (axis === "y") return cell(index === "odd" ? x - Math.floor(y / 2) : x - Math.ceil(y / 2), y);
  return cell(x, index === "odd" ? y - Math.ceil(x / 2) : y - Math.floor(x / 2));
}

/** A hexagonal cell's offset coordinates from axial ones (the inverse of `offsetToAxial`). */
export function axialToOffset(q: number, r: number, axis: StaggerAxis, index: StaggerIndex): GridPoint {
  if (axis === "y") return cell(index === "odd" ? q + Math.floor(r / 2) : q + Math.ceil(r / 2), r);
  return cell(q, index === "odd" ? r + Math.ceil(q / 2) : r + Math.floor(q / 2));
}

/**
 * The cell of a Tiled map (y down, `mapWidth × mapHeight` cells) for a grid of these parameters; the stagger axis,
 * index and side length carry over unchanged. See the module header for the mapping.
 */
export function tiledCellToCell(params: Pick<GridParams, "shape" | "staggerAxis">, tx: number, ty: number, mapWidth: number, mapHeight: number): GridPoint {
  switch (params.shape) {
    case "square":
      return [tx, mapHeight - 1 - ty];
    case "isometric":
      return [mapHeight - 1 - ty, mapWidth - 1 - tx];
    default: {
      if ((params.staggerAxis ?? "y") === "x") return [tx, mapHeight - 1 - ty];
      const k = mapHeight - 1 + odd(mapHeight - 1);
      return [tx, k - ty];
    }
  }
}

function withDefaults(p: GridParams): Required<GridParams> {
  return {
    shape: p.shape,
    cellSize: { x: p.cellSize.x, y: p.cellSize.y },
    staggerAxis: p.staggerAxis === "x" ? "x" : "y",
    staggerIndex: p.staggerIndex === "even" ? "even" : "odd",
    hexSide: Number.isFinite(p.hexSide) ? Math.max(0, Math.min(1, p.hexSide!)) : 0.5,
  };
}

/** Coincident neighbouring points removed (a hexagon of side 0 is a diamond). */
function dedupe(points: GridPoint[]): GridPoint[] {
  const out: GridPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) <= 1e-12 && Math.abs(out[0][1] - out[out.length - 1][1]) <= 1e-12) out.pop();
  return out;
}

/** Whether `p` is inside (or on) a counter-clockwise convex polygon. */
function insideConvex(poly: readonly GridPoint[], px: number, py: number, eps: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) < -eps) return false;
  }
  return true;
}

/** The grid for a shape and its parameters. */
export function tileGrid(input: GridParams): TileGrid {
  const params = withDefaults(input);
  switch (params.shape) {
    case "isometric":
    case "staggered":
      return diamondGrid(params);
    case "hexagonal":
      return hexGrid(params);
    default:
      return squareGrid(params);
  }
}

function squareGrid(params: Required<GridParams>): TileGrid {
  const { x: w, y: h } = params.cellSize;
  return {
    shape: "square",
    params,
    neighbourCount: 8,
    diamond: null,
    cellToLocal: (x, y) => [(x + 0.5) * w, (y + 0.5) * h],
    localToCell: (px, py) => [Math.floor(px / w), Math.floor(py / h)],
    cellOutline: (x, y) => [[x * w, y * h], [(x + 1) * w, y * h], [(x + 1) * w, (y + 1) * h], [x * w, (y + 1) * h]],
    cellBox: (x, y) => ({ x: x * w, y: y * h, w, h }),
    cellBoxPoint: (x, y, s, t) => [(x + s) * w, (y + t) * h],
    neighbours: (x, y) => OFFSETS_8.map(([dx, dy]) => [x + dx, y + dy]),
    drawKey: (_x, y) => -y,
  };
}

function diamondGrid(params: Required<GridParams>): TileGrid {
  const { x: w, y: h } = params.cellSize;
  const staggered = params.shape === "staggered";
  const { staggerAxis: axis, staggerIndex: index } = params;
  const [ox, oy] = staggered ? staggeredOffset(axis, index, w, h) : [0, 0];
  const toDiamond = (x: number, y: number): GridPoint => (staggered ? staggeredToDiamond(x, y, axis, index) : [x, y]);
  const fromDiamond = (u: number, v: number): GridPoint => (staggered ? diamondToStaggered(u, v, axis, index) : [u, v]);
  const toLocal = (u: number, v: number): GridPoint => [((u - v) * w) / 2 + ox, ((u + v - 1) * h) / 2 + oy];
  const centre = (x: number, y: number): GridPoint => {
    const [u, v] = toDiamond(x, y);
    return toLocal(u + 0.5, v + 0.5);
  };
  return {
    shape: params.shape,
    params,
    neighbourCount: 8,
    diamond: { toDiamond, fromDiamond, toLocal },
    cellToLocal: centre,
    localToCell(px, py) {
      const X = (px - ox) / w, Y = (py - oy) / h;
      return fromDiamond(Math.floor(X + Y + 0.5), Math.floor(Y - X + 0.5));
    },
    cellOutline(x, y) {
      const [u, v] = toDiamond(x, y);
      return [toLocal(u, v), toLocal(u + 1, v), toLocal(u + 1, v + 1), toLocal(u, v + 1)];
    },
    cellBox(x, y) {
      const [cx, cy] = centre(x, y);
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    },
    cellBoxPoint(x, y, s, t) {
      const [cx, cy] = centre(x, y);
      return [cx - w / 2 + s * w, cy - h / 2 + t * h];
    },
    neighbours(x, y) {
      const [u, v] = toDiamond(x, y);
      return OFFSETS_8.map(([dx, dy]) => fromDiamond(u + dx, v + dy));
    },
    drawKey: (x, y) => -centre(x, y)[1],
  };
}

function hexGrid(params: Required<GridParams>): TileGrid {
  const { x: w, y: h } = params.cellSize;
  const { staggerAxis: axis, staggerIndex: index, hexSide } = params;
  const pointy = axis === "y";
  // Pointy-top: rows `step` apart; flat-top: columns `step` apart.
  const side = pointy ? hexSide * h : hexSide * w;
  const step = pointy ? (h + side) / 2 : (w + side) / 2;
  const centre = (x: number, y: number): GridPoint => (pointy ? [(x + 0.5 * shifted(y, index)) * w, y * step] : [x * step, (y - 0.5 * shifted(x, index)) * h]);
  const outline = (x: number, y: number): GridPoint[] => {
    const [cx, cy] = centre(x, y);
    const pts: GridPoint[] = pointy
      ? [[cx + w / 2, cy - side / 2], [cx + w / 2, cy + side / 2], [cx, cy + h / 2], [cx - w / 2, cy + side / 2], [cx - w / 2, cy - side / 2], [cx, cy - h / 2]]
      : [[cx + w / 2, cy], [cx + side / 2, cy + h / 2], [cx - side / 2, cy + h / 2], [cx - w / 2, cy], [cx - side / 2, cy - h / 2], [cx + side / 2, cy - h / 2]];
    return dedupe(pts);
  };
  const neighbours = (x: number, y: number): GridPoint[] => {
    const [q, r] = offsetToAxial(x, y, axis, index);
    return AXIAL_6.map(([dq, dr]) => axialToOffset(q + dq, r + dr, axis, index));
  };
  return {
    shape: "hexagonal",
    params,
    neighbourCount: 6,
    diamond: null,
    cellToLocal: centre,
    localToCell(px, py) {
      // The nearest cell by the grid's rows and columns, then whichever of it and its neighbours holds the point
      // (a hexagon that isn't regular isn't its centre's Voronoi cell, so the nearest centre alone can be wrong).
      const guess: GridPoint = pointy
        ? (() => {
            const y = Math.round(py / step);
            return cell(Math.round(px / w - 0.5 * shifted(y, index)), y);
          })()
        : (() => {
            const x = Math.round(px / step);
            return cell(x, Math.round(py / h + 0.5 * shifted(x, index)));
          })();
      const eps = 1e-9 * Math.max(w, h);
      const candidates = [guess, ...neighbours(guess[0], guess[1])];
      for (const c of candidates) if (insideConvex(outline(c[0], c[1]), px, py, eps)) return c;
      let best = guess, bestD = Infinity;
      for (const c of candidates) {
        const [cx, cy] = centre(c[0], c[1]);
        const d = ((px - cx) / w) ** 2 + ((py - cy) / h) ** 2;
        if (d < bestD) (best = c), (bestD = d);
      }
      return best;
    },
    cellOutline: outline,
    cellBox(x, y) {
      const [cx, cy] = centre(x, y);
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    },
    cellBoxPoint(x, y, s, t) {
      const [cx, cy] = centre(x, y);
      return [cx - w / 2 + s * w, cy - h / 2 + t * h];
    },
    neighbours,
    drawKey: (x, y) => -centre(x, y)[1],
  };
}

/** The key that tells two grids apart (equal keys, equal geometry). */
export function gridKey(p: GridParams): string {
  const q = withDefaults(p);
  if (q.shape === "square" || q.shape === "isometric") return `${q.shape}|${q.cellSize.x}|${q.cellSize.y}`;
  return `${q.shape}|${q.cellSize.x}|${q.cellSize.y}|${q.staggerAxis}|${q.staggerIndex}|${q.shape === "hexagonal" ? q.hexSide : ""}`;
}
