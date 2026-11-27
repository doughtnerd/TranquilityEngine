// ADR 0435: the grid module that owns cell geometry on square, isometric, staggered and hexagonal maps.
import { describe, expect, it } from "vitest";
import { axialToOffset, diamondToStaggered, offsetToAxial, staggeredToDiamond, tiledCellToCell, tileGrid, type GridParams, type GridPoint, type TileGrid } from "./grids";

const SIZE = { x: 2, y: 1 };

/** Every shape and stagger variant, a few hex side lengths included. */
const VARIANTS: GridParams[] = [
  { shape: "square", cellSize: SIZE },
  { shape: "isometric", cellSize: SIZE },
  ...(["x", "y"] as const).flatMap((staggerAxis) =>
    (["odd", "even"] as const).flatMap((staggerIndex): GridParams[] => [
      { shape: "staggered", cellSize: SIZE, staggerAxis, staggerIndex },
      ...[0, 0.5, 1].map((hexSide): GridParams => ({ shape: "hexagonal", cellSize: SIZE, staggerAxis, staggerIndex, hexSide })),
    ]),
  ),
];
const name = (p: GridParams) => [p.shape, p.staggerAxis, p.staggerIndex, p.hexSide].filter((v) => v !== undefined).join(" ");

const CELLS: GridPoint[] = [];
for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) CELLS.push([x, y]);

function area(poly: readonly GridPoint[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** A point a little way from the centre towards each corner: still inside the cell. */
function insidePoints(grid: TileGrid, x: number, y: number): GridPoint[] {
  const [cx, cy] = grid.cellToLocal(x, y);
  return [[cx, cy], ...grid.cellOutline(x, y).map(([px, py]): GridPoint => [cx + (px - cx) * 0.9, cy + (py - cy) * 0.9])];
}

describe("tile grids (ADR 0435)", () => {
  for (const params of VARIANTS) {
    describe(name(params), () => {
      const grid = tileGrid(params);

      it("finds every cell from its centre and from points near its corners", () => {
        for (const [x, y] of CELLS) for (const [px, py] of insidePoints(grid, x, y)) expect(grid.localToCell(px, py)).toEqual([x, y]);
      });

      it("outlines cells counter-clockwise around their centre, inside their box", () => {
        for (const [x, y] of CELLS) {
          const outline = grid.cellOutline(x, y);
          expect(area(outline)).toBeGreaterThan(0);
          const box = grid.cellBox(x, y);
          for (const [px, py] of outline) {
            expect(px).toBeGreaterThanOrEqual(box.x - 1e-9);
            expect(px).toBeLessThanOrEqual(box.x + box.w + 1e-9);
            expect(py).toBeGreaterThanOrEqual(box.y - 1e-9);
            expect(py).toBeLessThanOrEqual(box.y + box.h + 1e-9);
          }
          expect([box.w, box.h]).toEqual([SIZE.x, SIZE.y]);
          expect(grid.cellBoxPoint(x, y, 0, 0)).toEqual([box.x, box.y]);
        }
      });

      it("tiles the plane: cells' outlines cover their share of the area, so neighbours don't overlap", () => {
        // Each cell's area matches the lattice's area per cell (the centres' spacing).
        const a = area(grid.cellOutline(0, 0));
        const [x0, y0] = grid.cellToLocal(0, 0);
        const [x2, y2] = grid.cellToLocal(2, 0), [x02, y02] = grid.cellToLocal(0, 2);
        const lattice = Math.abs((x2 - x0) * (y02 - y0) - (y2 - y0) * (x02 - x0)) / 4;
        expect(a).toBeCloseTo(lattice, 9);
      });

      it("names neighbours that name it back, sharing an edge or a corner", () => {
        expect(grid.neighbourCount).toBe(params.shape === "hexagonal" ? 6 : 8);
        for (const [x, y] of CELLS) {
          const ns = grid.neighbours(x, y);
          expect(ns).toHaveLength(grid.neighbourCount);
          expect(new Set(ns.map(String)).size).toBe(ns.length);
          for (const n of ns) expect(grid.neighbours(n[0], n[1]).map(String)).toContain(String([x, y]));
        }
        // Opposite neighbours sit opposite: the neighbour i and i + half are mirrored about the cell.
        const [cx, cy] = grid.cellToLocal(1, 1);
        const ns = grid.neighbours(1, 1).map(([nx, ny]) => grid.cellToLocal(nx, ny));
        const half = ns.length / 2;
        for (let i = 0; i < half; i++) {
          expect(ns[i][0] + ns[i + half][0]).toBeCloseTo(2 * cx, 9);
          expect(ns[i][1] + ns[i + half][1]).toBeCloseTo(2 * cy, 9);
        }
      });

      it("goes round its neighbours clockwise", () => {
        const [cx, cy] = grid.cellToLocal(0, 0);
        const bearings = grid.neighbours(0, 0).map(([nx, ny]) => {
          const [px, py] = grid.cellToLocal(nx, ny);
          return Math.atan2(px - cx, py - cy); // clockwise from north
        });
        let turned = 0;
        for (let i = 0; i < bearings.length; i++) {
          let d = bearings[(i + 1) % bearings.length] - bearings[i];
          while (d <= 0) d += 2 * Math.PI;
          turned += d;
        }
        expect(turned).toBeCloseTo(2 * Math.PI, 9);
      });
    });
  }

  it("keeps the square grid's numbers", () => {
    const g = tileGrid({ shape: "square", cellSize: { x: 0.5, y: 2 } });
    expect(g.cellToLocal(3, -1)).toEqual([1.75, -1]);
    expect(g.localToCell(0.7, -0.1)).toEqual([1, -1]);
    expect(g.cellOutline(1, 0)).toEqual([[0.5, 0], [1, 0], [1, 2], [0.5, 2]]);
    expect(g.neighbours(0, 0)).toEqual([[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]]);
  });

  it("puts isometric cells where the record says: (0, 0) is the bottom corner, x up-right, y up-left", () => {
    const g = tileGrid({ shape: "isometric", cellSize: { x: 2, y: 1 } });
    expect(g.cellToLocal(0, 0)).toEqual([0, 0]);
    expect(g.cellToLocal(1, 0)).toEqual([1, 0.5]);
    expect(g.cellToLocal(0, 1)).toEqual([-1, 0.5]);
    expect(g.cellOutline(0, 0)).toEqual([[0, -0.5], [1, 0], [0, 0.5], [-1, 0]]);
    expect(g.cellBox(0, 0)).toEqual({ x: -1, y: -0.5, w: 2, h: 1 });
    // N is up-left on screen (cell-space +y); painter's order draws the higher cell first.
    expect(g.neighbours(0, 0)[0]).toEqual([0, 1]);
    expect(g.drawKey(1, 1)).toBeLessThan(g.drawKey(0, 0));
  });

  it("converts staggered cells to diamonds and back, keeping each cell's place", () => {
    for (const axis of ["x", "y"] as const) {
      for (const index of ["odd", "even"] as const) {
        const st = tileGrid({ shape: "staggered", cellSize: SIZE, staggerAxis: axis, staggerIndex: index });
        for (const [x, y] of CELLS) {
          const [u, v] = staggeredToDiamond(x, y, axis, index);
          expect(Number.isInteger(u) && Number.isInteger(v)).toBe(true);
          expect(diamondToStaggered(u, v, axis, index)).toEqual([x, y]);
          expect(st.diamond!.toDiamond(x, y)).toEqual([u, v]);
        }
        // Rows (columns) are half a cell apart, and the shifted ones sit half a cell over.
        if (axis === "y") {
          expect(st.cellToLocal(0, 1)[1] - st.cellToLocal(0, 0)[1]).toBeCloseTo(SIZE.y / 2);
          const shift = st.cellToLocal(0, 1)[0] - st.cellToLocal(0, 0)[0];
          expect(shift).toBeCloseTo(index === "odd" ? SIZE.x / 2 : -SIZE.x / 2); // odd: row 1 shifts right; even: row 0 does
        } else {
          expect(st.cellToLocal(1, 0)[0] - st.cellToLocal(0, 0)[0]).toBeCloseTo(SIZE.x / 2);
          const shift = st.cellToLocal(1, 0)[1] - st.cellToLocal(0, 0)[1];
          expect(shift).toBeCloseTo(index === "odd" ? -SIZE.y / 2 : SIZE.y / 2); // odd: column 1 sits lower; even: column 0 does
        }
      }
    }
  });

  it("converts hexagonal offset cells to axial coordinates and back", () => {
    for (const axis of ["x", "y"] as const) {
      for (const index of ["odd", "even"] as const) {
        for (const [x, y] of CELLS) {
          const [q, r] = offsetToAxial(x, y, axis, index);
          expect(axialToOffset(q, r, axis, index)).toEqual([x, y]);
        }
      }
    }
  });

  it("lays hexagons out as Tiled does: pointy rows and flat columns, sides as long as hexSide says", () => {
    const pointy = tileGrid({ shape: "hexagonal", cellSize: { x: 2, y: 2 }, staggerAxis: "y", hexSide: 0.5 });
    expect(pointy.cellOutline(0, 0)).toEqual([[1, -0.5], [1, 0.5], [0, 1], [-1, 0.5], [-1, -0.5], [0, -1]]);
    expect(pointy.cellToLocal(0, 1)).toEqual([1, 1.5]); // rows (h + side) / 2 apart, odd rows half a cell right
    expect(pointy.neighbours(0, 0)).toEqual([[0, 1], [1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1]]); // NE E SE SW W NW
    const flat = tileGrid({ shape: "hexagonal", cellSize: { x: 2, y: 2 }, staggerAxis: "x", hexSide: 0.5 });
    expect(flat.cellOutline(0, 0)).toEqual([[1, 0], [0.5, 1], [-0.5, 1], [-1, 0], [-0.5, -1], [0.5, -1]]);
    expect(flat.cellToLocal(1, 0)).toEqual([1.5, -1]); // odd columns half a cell lower
    expect(flat.neighbours(0, 0)).toEqual([[0, 1], [1, 1], [1, 0], [0, -1], [-1, 0], [-1, 1]]); // N NE SE S SW NW
    // Side 0 makes diamonds (4 corners); side 1 offset rectangles.
    expect(tileGrid({ shape: "hexagonal", cellSize: SIZE, hexSide: 0 }).cellOutline(0, 0)).toHaveLength(4);
    const bricks = tileGrid({ shape: "hexagonal", cellSize: { x: 2, y: 1 }, hexSide: 1 });
    expect(bricks.cellToLocal(0, 1)).toEqual([1, 1]);
    expect(bricks.localToCell(0.1, 0.6)).toEqual([0, 1]);
    expect(bricks.localToCell(-0.1, 0.6)).toEqual([-1, 1]);
  });

  it("converts Tiled's y-down cells, keeping rows above rows and the stagger as Tiled has it", () => {
    expect(tiledCellToCell({ shape: "square" }, 2, 0, 10, 4)).toEqual([2, 3]);
    // Isometric: Tiled's bottom corner (W − 1, H − 1) is cell (0, 0); its top corner (0, 0) the far one.
    expect(tiledCellToCell({ shape: "isometric" }, 9, 3, 10, 4)).toEqual([0, 0]);
    expect(tiledCellToCell({ shape: "isometric" }, 0, 0, 10, 4)).toEqual([3, 9]);
    // Tiled's isometric cell (tx, ty + 1) is down-left on screen of (tx, ty): the same holds after converting.
    const iso = tileGrid({ shape: "isometric", cellSize: SIZE });
    const a = iso.cellToLocal(...tiledCellToCell({ shape: "isometric" }, 4, 1, 10, 4)), b = iso.cellToLocal(...tiledCellToCell({ shape: "isometric" }, 4, 2, 10, 4));
    expect(b[0]).toBeLessThan(a[0]);
    expect(b[1]).toBeLessThan(a[1]);
    // Staggered rows keep their parity (and so their shift), whatever the map's height.
    for (const h of [4, 5]) {
      for (let ty = 0; ty < h; ty++) {
        const [, y] = tiledCellToCell({ shape: "staggered", staggerAxis: "y" }, 0, ty, 3, h);
        expect(y & 1).toBe(ty & 1);
        expect(y).toBeGreaterThanOrEqual(0);
      }
      const rows = [0, 1, 2].map((ty) => tiledCellToCell({ shape: "hexagonal", staggerAxis: "y" }, 0, ty, 3, h)[1]);
      expect(rows[0] - rows[1]).toBe(1);
      expect(rows[1] - rows[2]).toBe(1);
    }
    expect(tiledCellToCell({ shape: "hexagonal", staggerAxis: "x" }, 1, 0, 3, 4)).toEqual([1, 3]);
  });
});
