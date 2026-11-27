// ADR 0437: isometric, staggered and hexagonal Tilemaps: coordinates, chunk meshes, collision and auto-tiling.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap, Vector2 } from "../../../myco";
import { patternProblems } from "./autotile";
import { tileGrid } from "./grids";
import { buildChunkMeshes, type TileFrame } from "./mesh";
import { parseTileset } from "./tileset";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [32, 16],
  terrains: [{ name: "Hex" }, { name: "Square" }],
  tiles: [
    { id: 1, sprite: "", collision: "full" },
    { id: 2, sprite: "", collision: "oneWay" },
    { id: 3, sprite: "", collision: { polygon: [[0, 0], [1, 0], [1, 1]] } },
    // A hexagonal terrain: alone, with a neighbour to the first side (NE on a pointy map), and to the fourth (SW).
    { id: 20, sprite: "", terrain: "Hex", pattern: "000000" },
    { id: 21, sprite: "", terrain: "Hex", pattern: "100000" },
    { id: 22, sprite: "", terrain: "Hex", pattern: "000100" },
    { id: 23, sprite: "", terrain: "Hex", pattern: "********" }, // 8 neighbours: never fits a hexagonal map
    { id: 30, sprite: "", terrain: "Square", pattern: "********" },
  ],
};

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function newMap(fields: Record<string, unknown>): Promise<Tilemap> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILESET, "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json", ...fields });
}

/** Points rounded so float noise doesn't matter. */
const round = (pts: readonly (readonly number[])[]) => pts.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6 + 0));
function area(poly: readonly (readonly number[])[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

describe("grid shapes on the Tilemap (ADR 0437)", () => {
  it("places, finds and outlines cells through the grid, and names their neighbours", async () => {
    const map = await newMap({ gridShape: "isometric", cellSize: new Vector2(2, 1) });
    map.node.transform!.position.x = 10;
    expect(map.cellToLocal(1, 0).toArray()).toEqual([1, 0.5]);
    expect(map.cellToWorld(1, 0).x).toBeCloseTo(11);
    const back = map.worldToCell(map.cellToWorld(-3, 5));
    expect([back.x, back.y]).toEqual([-3, 5]);
    expect(map.cellOutline(0, 0).map((p) => p.toArray())).toEqual([[0, -0.5], [1, 0], [0, 0.5], [-1, 0]]);
    expect(map.cellNeighbours(0, 0).map((p) => p.toArray())).toHaveLength(8);
    map.gridShape = "hexagonal";
    expect(map.cellNeighbours(0, 0)).toHaveLength(6);
    expect(map.cellOutline(0, 0)).toHaveLength(6);
    const hex = map.worldToCell(map.cellToWorld(2, 3));
    expect([hex.x, hex.y]).toEqual([2, 3]);
  });

  it("merges isometric solid cells in diamond space: rectangles become parallelograms, outlines stay outlines", async () => {
    const map = await newMap({ gridShape: "isometric", cellSize: new Vector2(2, 1) });
    map.fillRect(0, 0, 2, 1, 1);
    const rects = map.collisionShapes("rectangles")!;
    expect(rects.unit).toEqual({ x: 1, y: 1 });
    expect(rects.boxes).toEqual([]);
    // Cells (0, 0) and (1, 0): one parallelogram from (0,0)'s bottom corner along the map's x axis, counter-clockwise.
    expect(rects.polygons.map(round)).toEqual([[[0, -0.5], [2, 0.5], [1, 1], [-1, 0]]]);
    const loops = map.collisionShapes("outline")!.loops.map(round);
    expect(loops).toHaveLength(1);
    expect(area(loops[0])).toBeCloseTo(2 * 1); // two diamonds of w·h/2
    expect(new Set(loops[0].map(String))).toEqual(new Set(rects.polygons.map(round)[0].map(String)));
  });

  it("puts one-way cells in one-way polygons and tile polygons in the cell's box, on isometric and staggered maps", async () => {
    const map = await newMap({ gridShape: "isometric", cellSize: new Vector2(2, 1) });
    map.setTile(0, 0, 2);
    map.setTile(5, 5, 3);
    const s = map.collisionShapes("rectangles")!;
    expect(s.oneWay).toEqual([]);
    expect(s.oneWayPolygons.map(round)).toEqual([[[0, -0.5], [1, 0], [0, 0.5], [-1, 0]]]);
    // Cell (5, 5)'s box is centred at (0, 5): the triangle [0,0] [1,0] [1,1] of the box.
    expect(s.polygons.map(round)).toEqual([[[-1, 4.5], [1, 4.5], [1, 5.5]]]);
    // Staggered cells next to each other in diamond space merge the same way (within a chunk, ADR 0439).
    map.gridShape = "staggered";
    map.clearAll();
    const grid = tileGrid({ shape: "staggered", cellSize: { x: 2, y: 1 } });
    const [ne] = grid.neighbours(4, 4); // N in diamond space
    map.setTile(4, 4, 1);
    map.setTile(ne[0], ne[1], 1);
    expect(map.collisionShapes("rectangles")!.polygons).toHaveLength(1);
  });

  it("gives hexagonal maps one hexagon per solid cell, or the traced outline of their union", async () => {
    const map = await newMap({ gridShape: "hexagonal", cellSize: new Vector2(2, 2), hexSide: 0.5 });
    const cells = [[0, 0], [1, 0], [2, 0]];
    for (const [x, y] of cells) map.setTile(x, y, 1);
    const rects = map.collisionShapes("rectangles")!;
    expect(rects.unit).toEqual({ x: 1, y: 1 });
    expect(rects.polygons).toHaveLength(3);
    expect(rects.polygons.map(round)[0]).toEqual(round(map.cellOutline(0, 0).map((p) => p.toArray())));
    const hexArea = area(rects.polygons[0]);
    const loops = map.collisionShapes("outline")!.loops;
    expect(loops).toHaveLength(1);
    expect(area(loops[0])).toBeCloseTo(3 * hexArea);
    // A ring around an empty cell: an outline outside (counter-clockwise) and one around the hole (clockwise).
    map.clearAll();
    for (const n of map.cellNeighbours(5, 5)) map.setTile(n.x, n.y, 1);
    const ring = map.collisionShapes("outline")!.loops;
    expect(ring).toHaveLength(2);
    const areas = ring.map(area).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-hexArea);
    expect(areas[1]).toBeCloseTo(7 * hexArea);
    // One-way cells are one-way hexagons.
    map.clearAll();
    map.setTile(0, 0, 2);
    expect(map.collisionShapes("rectangles")!.oneWayPolygons.map(round)).toEqual([round(map.cellOutline(0, 0).map((p) => p.toArray()))]);
  });

  it("keeps square maps' shapes in cell units, and changes its signature with the grid", async () => {
    const map = await newMap({ cellSize: new Vector2(2, 1) });
    map.fillRect(0, 0, 2, 1, 1);
    const square = map.collisionShapes("rectangles")!;
    expect(square.unit).toEqual({ x: 2, y: 1 });
    expect(square.boxes).toEqual([{ x: 0, y: 0, w: 2, h: 1 }]);
    const before = map.collisionSignature();
    map.gridShape = "isometric";
    expect(map.collisionSignature()).not.toBe(before);
  });

  it("auto-tiles a hexagonal map with 6-character patterns, skipping tiles of 8", async () => {
    const map = await newMap({ gridShape: "hexagonal" });
    const ne = map.cellNeighbours(0, 0)[0];
    map.paintTerrain([[0, 0], [ne.x, ne.y]], "Hex");
    expect(map.getTile(0, 0)).toBe(21); // its first neighbour (NE) is Hex
    expect(map.getTile(ne.x, ne.y)).toBe(22); // its fourth (SW) is
    map.paintTerrain([[9, 9]], "Hex");
    expect(map.getTile(9, 9)).toBe(20);
    // A terrain whose every tile has 8 neighbours paints nothing on a hexagonal map.
    expect(map.paintTerrain([[20, 20]], "Square")).toEqual([]);
    expect(map.getTile(20, 20)).toBe(0);
    // The tileset shows the misfit as a problem naming the tile.
    const problems = patternProblems(parseTileset(TILESET).tileset);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/tile 23/);
    expect(patternProblems(parseTileset({ ...TILESET, previewGrid: "hexagonal" }).tileset).join("\n")).toMatch(/tile 23[\s\S]*tile 30/);
  });

  it("auto-tiles isometric maps with their own 8 neighbours", async () => {
    const map = await newMap({ gridShape: "staggered" });
    const n = map.cellNeighbours(0, 0)[0];
    map.paintTerrain([[0, 0], [n.x, n.y]], "Square");
    expect(map.getTile(n.x, n.y)).toBe(30);
  });
});

describe("chunk meshes on non-square grids (ADR 0437)", () => {
  const frame: TileFrame = { texture: "t.png", uv: [0, 0, 1, 1], size: [1, 2] };

  it("places each sprite in its cell's box and draws higher cells first", () => {
    const grid = tileGrid({ shape: "isometric", cellSize: { x: 2, y: 1 } });
    const cells = new Int32Array(256);
    cells[0] = 1; // (0, 0): the front
    cells[17] = 1; // (1, 1): behind it
    cells[1] = 1; // (1, 0)
    const [mesh] = buildChunkMeshes(cells, 0, 0, grid, () => frame);
    expect(mesh.quads).toBe(3);
    // Each quad's bottom-left corner, in draw order: (1, 1) first (highest), then (1, 0), then (0, 0).
    const corners = [0, 1, 2].map((q) => [mesh.positions[q * 12], mesh.positions[q * 12 + 1]]);
    expect(corners).toEqual([grid.cellBoxPoint(1, 1, 0, 0), grid.cellBoxPoint(1, 0, 0, 0), grid.cellBoxPoint(0, 0, 0, 0)]);
    // A sprite twice its cell's height rises above the box: top-right corner at (1, 2) of the box.
    expect([mesh.positions[2 * 12 + 6], mesh.positions[2 * 12 + 7]]).toEqual(grid.cellBoxPoint(0, 0, 1, 2));
  });

  it("leaves square chunks in cell order with the numbers they always had", () => {
    const cells = new Int32Array(256);
    cells[17] = 1;
    cells[0] = 1;
    const [a] = buildChunkMeshes(cells, 0, 0, { x: 0.5, y: 0.5 }, () => frame);
    const [b] = buildChunkMeshes(cells, 0, 0, tileGrid({ shape: "square", cellSize: { x: 0.5, y: 0.5 } }), () => frame);
    expect([...a.positions]).toEqual([...b.positions]);
    expect([a.positions[0], a.positions[1]]).toEqual([0, 0]); // cell (0, 0) first
  });
});
