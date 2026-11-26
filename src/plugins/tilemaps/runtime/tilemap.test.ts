import { afterEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider2D, CharacterController2D, Engine, FLIP_DIAGONAL, FLIP_X, GameObject, RigidBody2D, SceneManager, Tilemap, TilemapChanges, ShapeCollider2D, getComponentClass } from "../../../myco";
import { missingBlobMasks, paintTerrain } from "./autotile";
import { floodCells, lineCells, rectCells } from "./brushes";
import { greedyRectangles, rowRuns, traceOutlines } from "./cellRegions";
import { buildTileShapes } from "./collision";
import { CHUNK_CELLS, cellToChunk, cellValue, decodeChunk, encodeChunk, migrateLayer, newLayer, FLIP_Y } from "./format";
import { buildChunkMeshes, writeTileQuad, type TileFrame } from "./mesh";
import { blobMasks, canonicalBlob, maskToPattern, neighbourMask, patternScore, pickTerrainTile, sidesPattern } from "./neighbourPatterns";
import { flipPoint, rotateClockwise, sourceCorner } from "./tileFlips";
import { Tileset, legacyTileUuid, newTileset, parseTileset, pickWeighted, tileAnchor, type TileDef } from "./tileset";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  terrains: [{ name: "Ground" }],
  tiles: [
    { id: 1, sprite: "asset:t.png#a", collision: "full", data: { kind: "dirt" } },
    { id: 2, sprite: "asset:t.png#b", collision: "oneWay" },
    { id: 3, sprite: "asset:t.png#c", collision: { polygon: [[0, 0], [1, 0], [1, 1]] } },
    { id: 4, sprite: "asset:t.png#d" },
  ],
};

describe("tilemap format (ADR 0103)", () => {
  it("run-length encodes chunks and decodes them back", () => {
    const cells = new Int32Array(CHUNK_CELLS);
    cells[0] = 3;
    cells[1] = 3;
    cells[17] = cellValue(5, FLIP_X);
    const text = encodeChunk(cells);
    expect(text.startsWith("3*2,0*15,")).toBe(true);
    expect([...decodeChunk(text)]).toEqual([...cells]);
    const problems: string[] = [];
    expect(decodeChunk("1,x,2", problems)[2]).toBe(2);
    expect(problems).toHaveLength(1);
  });

  it("maps cells to chunks, negative cells included", () => {
    expect(cellToChunk(0, 0)).toEqual({ cx: 0, cy: 0, index: 0 });
    expect(cellToChunk(17, 1)).toEqual({ cx: 1, cy: 0, index: 17 });
    expect(cellToChunk(-1, -1)).toEqual({ cx: -1, cy: -1, index: 255 });
  });

  it("migrates layers: defaults for missing values, older versions without an upgrade and newer versions refused", () => {
    const l = migrateLayer({ name: "A", chunks: { "0,0": "1", bad: "2" } });
    expect(l).toMatchObject({ v: 2, palette: { 1: legacyTileUuid(1) }, name: "A", sortingLayer: "Default", visible: true, collision: true, opacity: 1 });
    expect(Object.keys(l.chunks)).toEqual(["0,0"]);
    expect(l.palette).toEqual({ 1: legacyTileUuid(1) });
    expect(() => migrateLayer({ v: 99 })).toThrow(/newer/);
    expect(() => migrateLayer({ v: 0 })).toThrow(/no migration from layer version 0/);
  });

  it("turns flags clockwise through the four rotations", () => {
    let f = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      seen.add(f);
      f = rotateClockwise(f);
    }
    expect(f).toBe(0);
    expect(seen.size).toBe(4);
    expect(rotateClockwise(0)).toBe(FLIP_DIAGONAL | FLIP_X);
  });
});

describe("tilesets (ADR 0103)", () => {
  it("parses tiles, skipping bad ones with problems", () => {
    const { tileset, problems } = parseTileset({ ...TILESET, tiles: [...TILESET.tiles, { id: 1, sprite: "dup" }, { id: 0 }, { id: 9, pattern: "bad", collision: { polygon: [[0, 0]] } }] });
    expect(tileset.tiles.map((t) => t.id)).toEqual([1, 2, 3, 4, 9]);
    expect(tileset.tiles[3].collision).toBe("none");
    expect(problems.length).toBe(4);
    expect(() => parseTileset({ format: "other" })).toThrow();
  });

  it("picks weighted tiles", () => {
    const items = [{ weight: 0 }, { weight: 1 }];
    for (let i = 0; i < 10; i++) expect(pickWeighted(items, () => i / 10)).toBe(items[1]);
  });
});

describe("auto-tiling (ADR 0103)", () => {
  const terrainTiles = (patterns: string[]): TileDef[] => patterns.map((pattern, i) => ({ id: 10 + i, uuid: legacyTileUuid(10 + i), sprite: "", collision: "none", terrain: "G", pattern }));

  it("scores patterns: fixed positions must agree, wildcards are free", () => {
    expect(patternScore("1*1*1*1*", 0b01010101)).toBe(4);
    expect(patternScore("1*1*1*1*", 0b01010100)).toBe(-1);
    expect(patternScore("********", 0)).toBe(0);
  });

  it("picks the most specific matching tile, then falls back to the closest", () => {
    const tiles = terrainTiles(["********", sidesPattern(true, true, true, true), sidesPattern(false, true, false, true)]);
    expect(pickTerrainTile(tiles, 0b01010101)!.id).toBe(11);
    expect(pickTerrainTile(tiles, 0b01000100)!.id).toBe(12);
    expect(pickTerrainTile(tiles, 0b00000001)!.id).toBe(10);
    expect(pickTerrainTile(terrainTiles([sidesPattern(true, true, true, true)]), 0)!.id).toBe(10);
  });

  it("has 47 blob masks and matches exact-corner patterns through canonical masks", () => {
    expect(blobMasks()).toHaveLength(47);
    const tiles = terrainTiles(blobMasks().map(maskToPattern));
    expect(missingBlobMasks(tiles)).toEqual([]);
    // NE set without N and E: the corner doesn't count.
    expect(pickTerrainTile(tiles, 0b10)!.pattern).toBe(maskToPattern(canonicalBlob(0b10)));
  });

  it("paints a terrain and re-picks neighbours to fit", () => {
    const tiles = terrainTiles(["0*0*0*0*", "0*1*0*0*", "0*1*0*1*", "0*0*0*1*"]); // alone, end left, middle, end right
    const ts = new Tileset({ format: "myco.tileset@1", tileSize: [16, 16], terrains: [{ name: "G" }], tiles });
    const cells = new Map<string, number>();
    const access = { get: (x: number, y: number) => cells.get(`${x},${y}`) ?? 0, set: (x: number, y: number, id: number) => void cells.set(`${x},${y}`, id) };
    paintTerrain(ts, access, [[0, 0]], "G");
    expect(access.get(0, 0)).toBe(10);
    paintTerrain(ts, access, [[1, 0], [2, 0]], "G");
    expect([access.get(0, 0), access.get(1, 0), access.get(2, 0)]).toEqual([11, 12, 13]);
    paintTerrain(ts, access, [[2, 0]], null);
    expect([access.get(0, 0), access.get(1, 0), access.get(2, 0)]).toEqual([11, 13, 0]);
    expect(neighbourMask(1, 0, "G", (x, y) => ts.tile(access.get(x, y))?.terrain)).toBe(1 << 6);
  });
});

describe("tile collision shapes (ADR 0105)", () => {
  it("merges solid cells into few rectangles covering them exactly", () => {
    const cells = rectCells(0, 0, 9, 1).concat(rectCells(0, 2, 2, 4));
    const rects = greedyRectangles(cells);
    expect(rects.length).toBe(2);
    expect(rects.reduce((s, r) => s + r.w * r.h, 0)).toBe(cells.length);
  });

  it("traces outlines with the solid on the left, holes included, collinear points merged", () => {
    const ring = rectCells(0, 0, 2, 2).filter(([x, y]) => !(x === 1 && y === 1));
    const loops = traceOutlines(ring);
    expect(loops).toHaveLength(2);
    const area = (l: [number, number][]) => l.reduce((s, p, i) => s + (l[(i + l.length - 1) % l.length][0] * p[1] - p[0] * l[(i + l.length - 1) % l.length][1]), 0) / 2;
    const areas = loops.map(area).sort((a, b) => a - b);
    expect(areas).toEqual([-1, 9]); // the hole clockwise, the outside counter-clockwise
    expect(loops.every((l) => l.length === 4)).toBe(true);
    // Cells touching at a corner get separate loops.
    expect(traceOutlines([[0, 0], [1, 1]])).toHaveLength(2);
    // ...whichever order the cells come in (the trace may start at the shared corner).
    for (const cells of [[[1, 1], [0, 0]], [[1, 0], [0, 1]], [[0, 1], [1, 0]]] as [number, number][][]) {
      const split = traceOutlines(cells);
      expect(split).toHaveLength(2);
      expect(split.every((l) => l.length === 4)).toBe(true);
    }
  });

  it("splits one-way runs per row and flips polygons with their cell", () => {
    expect(rowRuns([[0, 0], [1, 0], [3, 0], [0, 1]])).toEqual([{ x: 0, y: 0, w: 2, h: 1 }, { x: 3, y: 0, w: 1, h: 1 }, { x: 0, y: 1, w: 1, h: 1 }]);
    expect(flipPoint(0, 0, FLIP_X)).toEqual([1, 0]);
    expect(flipPoint(1, 0, FLIP_Y)).toEqual([1, 1]);
    const ts = new Tileset(parseTileset(TILESET).tileset);
    const shapes = buildTileShapes([{ x: 0, y: 0, value: 1 }, { x: 1, y: 0, value: 1 }, { x: 5, y: 5, value: 2 }, { x: 3, y: 0, value: cellValue(3, FLIP_X) }, { x: 4, y: 0, value: 4 }], (id) => ts.tile(id)?.collision);
    expect(shapes.boxes).toEqual([{ x: 0, y: 0, w: 2, h: 1 }]);
    expect(shapes.oneWay).toEqual([{ x: 5, y: 5, w: 1, h: 1 }]);
    expect(shapes.polygons).toHaveLength(1);
    expect(shapes.polygons[0].some(([x, y]) => x === 3 && y === 1)).toBe(true); // the mirrored slope rises to the left
  });
});

describe("chunk meshes (ADR 0103)", () => {
  it("builds one quad per tile, grouped by texture, with flipped UVs", () => {
    const cells = new Int32Array(CHUNK_CELLS);
    cells[0] = 1;
    cells[1] = cellValue(1, FLIP_X);
    cells[16] = 2;
    const frames: Record<number, { texture: string; uv: [number, number, number, number]; size: [number, number] }> = {
      1: { texture: "a.png", uv: [0, 0, 0.5, 0.5], size: [1, 1] },
      2: { texture: "b.png", uv: [0, 0, 1, 1], size: [1, 2] },
    };
    const meshes = buildChunkMeshes(cells, 1, 0, { x: 2, y: 2 }, (id) => frames[id] ?? null);
    expect(meshes.map((m) => [m.texture, m.quads])).toEqual([["a.png", 2], ["b.png", 1]]);
    const a = meshes[0];
    expect([...a.positions.slice(0, 3)]).toEqual([32, 0, 0]); // chunk 1 starts at cell 16, 2 units a cell
    expect([...a.uvs.slice(0, 2)]).toEqual([0, 0]);
    expect([...a.uvs.slice(8, 10)]).toEqual([0.5, 0]); // the flipped tile's bottom-left samples the right edge
    expect(meshes[1].positions[7]).toBe((1 + 2) * 2); // a 1 × 2 tile in row 1 reaches the top of row 2
    expect(sourceCorner(0, 0, FLIP_DIAGONAL | FLIP_X)).toEqual([0, 1]); // turned clockwise: top-left shows the bottom-left
    expect(sourceCorner(0, 0, FLIP_Y)).toEqual([0, 1]);
  });

  it("splits a texture's tiles into groups, says each quad's cell, and rewrites a quad as a fresh build lays it out (ADR 0421, 0424)", () => {
    const cells = new Int32Array(CHUNK_CELLS);
    cells[0] = 1;
    cells[1] = cellValue(2, FLIP_X);
    cells[17] = 1;
    const frames: Record<number, TileFrame> = { 1: { texture: "a.png", uv: [0, 0, 0.5, 0.5], size: [1, 1] }, 2: { texture: "a.png", uv: [0.5, 0, 1, 0.5], size: [1, 2] } };
    const meshes = buildChunkMeshes(cells, 0, 0, { x: 1, y: 1 }, (id) => frames[id] ?? null, (i) => `row${Math.floor(i / 16)}`);
    expect(meshes.map((m) => [m.texture, m.group, Array.from(m.cells)])).toEqual([["a.png", "row0", [0, 1]], ["a.png", "row1", [17]]]);
    // Without groups: one mesh per texture, as before.
    expect(buildChunkMeshes(cells, 0, 0, { x: 1, y: 1 }, (id) => frames[id] ?? null).map((m) => m.quads)).toEqual([3]);
    // Rewriting quad 1 with tile 1's frame gives what a build with tile 1 there would.
    const [row0] = meshes;
    writeTileQuad(row0.positions, row0.uvs, 1, { x: 1, y: 1 }, 1, 0, frames[1], FLIP_X);
    const swapped = cells.slice();
    swapped[1] = cellValue(1, FLIP_X);
    const [fresh] = buildChunkMeshes(swapped, 0, 0, { x: 1, y: 1 }, (id) => frames[id] ?? null, (i) => `row${Math.floor(i / 16)}`);
    expect(Array.from(row0.positions)).toEqual(Array.from(fresh.positions));
    expect(Array.from(row0.uvs)).toEqual(Array.from(fresh.uvs));
  });
});

describe("brushes (ADR 0103)", () => {
  it("makes rectangles, lines and flood fills", () => {
    expect(rectCells(1, 1, 0, 0)).toHaveLength(4);
    expect(lineCells(0, 0, 3, 1)).toHaveLength(4);
    const solid = new Set(["0,0", "1,0", "2,0"]);
    const filled = floodCells(5, 5, (x, y) => (solid.has(`${x},${y}`) ? 1 : 0), { minX: -1, minY: -1, maxX: 6, maxY: 6 });
    expect(filled).toHaveLength(8 * 8 - 3);
    expect(floodCells(0, 0, (x, y) => (solid.has(`${x},${y}`) ? 1 : 0), { minX: -9, minY: -9, maxX: 9, maxY: 9 })).toHaveLength(3);
  });
});

// --- the component and physics -------------------------------------------------------------------

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function setup(nodes: unknown[] = []) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILESET, "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}
const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

describe("Tilemap component (ADR 0103)", () => {
  it("is registered and loads cells from scene data", async () => {
    expect(getComponentClass("engine.Tilemap")).toBe(Tilemap);
    expect(getComponentClass("engine.ShapeCollider2D")).toBe(ShapeCollider2D);
    await setup([{ id: "m", name: "map", components: [{ type: "engine.Transform", data: { position: [10, 0, 0] } }, { type: "engine.Tilemap", data: { tileset: "asset:tiles.tileset.json", cellSize: [0.5, 0.5], layers: [{ name: "G", chunks: { "0,0": "1*3", "-1,0": "0*15,4" } }] } }] }]);
    const map = GameObject.findObjectOfType(Tilemap)!;
    expect(map.getTile(0, 0)).toBe(1);
    expect(map.getTile(2, 0, "G")).toBe(1);
    expect(map.getTile(3, 0)).toBe(0);
    expect(map.getTile(-1, 0)).toBe(4);
    expect(map.getTileData(1, 0)).toEqual({ kind: "dirt" });
    expect(map.cellBounds()).toEqual({ minX: -1, minY: 0, maxX: 2, maxY: 0 });
    // Cells are half a unit; the node sits at x = 10.
    const cell = map.worldToCell({ x: 10.7, y: 0.2 });
    expect([cell.x, cell.y]).toEqual([1, 0]);
    expect(map.cellToWorld(1, 0).x).toBeCloseTo(10.75);
  });

  it("edits cells, reports changes, and encodes them back to scene data", async () => {
    await setup();
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
    const seen: number[] = [];
    const stop = map.onTileChanged((c) => seen.push(c.value));
    expect(map.setTile(3, 2, 1)).toBe(true);
    expect(map.setTile(3, 2, 1)).toBe(false);
    map.setTile(-20, 0, 4, 0, FLIP_Y);
    expect(TilemapChanges.read).toBeDefined();
    stop();
    map.clearTile(3, 2);
    expect(seen).toEqual([1, cellValue(4, FLIP_Y)]);
    const data = map.toLayerData();
    expect(Object.keys(data[0].chunks)).toEqual(["-2,0"]);
    // Replacing the field (as the editor does) re-decodes it (that unchanged chunks are kept, so nothing redraws, is
    // the tile renderer's test).
    map.layers = data;
    expect(map.getCell(-20, 0)).toBe(cellValue(4, FLIP_Y));
    expect(() => map.setTile(0, 0, 1, "nope")).toThrow();
    // A coordinate that isn't a finite number names no cell: refused, adding no chunk and reporting no change.
    for (const [x, y] of [[NaN, 0], [0, Infinity], [-Infinity, NaN]]) expect(() => map.setTile(x!, y!, 1)).toThrow(/cell/);
    expect(Object.keys(map.toLayerData()[0].chunks)).toEqual(["-2,0"]);
    map.layers = [...data, newLayer("Top")];
    map.fillRect(0, 0, 2, 2, 1, "Top");
    expect(map.getTile(1, 1, 1)).toBe(1);
  });
});

describe("ShapeCollider2D on Rapier (ADR 0105)", () => {
  function level(engine: Engine, mode: "rectangles" | "outline" = "rectangles") {
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
    map.fillRect(-10, -1, 20, 1, 1); // floor at y = -1..0
    node.addBehavior(ShapeCollider2D, { mode });
    void engine;
    return map;
  }
  function box(x: number, y: number) {
    const b = GameObject.create("box");
    b.transform!.position = [x, y, 0];
    const rb = b.addBehavior(RigidBody2D, { constraints: { freezePosition: { x: false, y: false }, freezeRotation: true } });
    b.addBehavior(BoxCollider2D, { size: { x: 0.8, y: 0.8 } as never });
    return { b, rb };
  }

  for (const mode of ["rectangles", "outline"] as const) {
    it(`a box lands on a tile floor (${mode})`, async () => {
      const engine = await setup();
      level(engine, mode);
      const { b } = box(0, 2);
      steps(engine, 120);
      expect(b.transform!.worldPosition.y).toBeCloseTo(0.4, 1);
    });
  }

  it("a box slides across merged floor seams without stopping", async () => {
    const engine = await setup();
    const map = level(engine);
    map.fillRect(0, -2, 10, 1, 1); // makes the greedy merge split the floor into parts
    const { b, rb } = box(-8, 0.45);
    steps(engine, 10);
    for (let i = 0; i < 90; i++) {
      rb.velocity = { x: 6, y: rb.velocity.y };
      engine.step(1 / 60);
    }
    expect(b.transform!.worldPosition.x).toBeGreaterThan(0);
    expect(Math.abs(rb.velocity.x - 6)).toBeLessThan(0.5);
  });

  it("rebuilds when scripts change tiles", async () => {
    const engine = await setup();
    const map = level(engine);
    const { b } = box(0, 2);
    steps(engine, 60);
    for (let x = -3; x <= 3; x++) map.clearTile(x, -1);
    steps(engine, 60);
    expect(b.transform!.worldPosition.y).toBeLessThan(-1);
  });

  it("one-way platforms let bodies up through and hold them from above", async () => {
    const engine = await setup();
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
    map.fillRect(-3, 2, 6, 1, 2); // a one-way platform at y = 2..3
    node.addBehavior(ShapeCollider2D);
    const { b, rb } = box(0, 0);
    steps(engine, 2);
    rb.velocity = { x: 0, y: 12 }; // jump up through it
    let maxY = -Infinity;
    for (let i = 0; i < 180; i++) {
      engine.step(1 / 60);
      maxY = Math.max(maxY, b.transform!.worldPosition.y);
    }
    expect(maxY).toBeGreaterThan(3.4);
    expect(b.transform!.worldPosition.y).toBeCloseTo(3.4, 1); // landed on top
  });

  it("a CharacterController2D jumps up through one-way tiles and stands on them (ADR 0423)", async () => {
    const engine = await setup();
    const map = level(engine); // floor top at y = 0
    map.fillRect(-3, 3, 6, 1, 2); // a one-way platform at y = 3..4
    const player = GameObject.create("player");
    player.transform!.position = [0, 1.05, 0]; // capsule 2 tall: feet at y − 1
    const cc = player.addBehavior(CharacterController2D);
    let vy = 0, maxY = -Infinity;
    const frame = () => {
      vy -= 10 / 60;
      cc.move({ x: 0, y: vy / 60 });
      if (cc.isGrounded && vy < 0) vy = 0;
      engine.step(1 / 60);
      maxY = Math.max(maxY, player.transform!.worldPosition.y);
    };
    for (let i = 0; i < 30; i++) frame();
    expect(cc.isGrounded).toBe(true);
    vy = 12;
    for (let i = 0; i < 240; i++) frame();
    expect(maxY).toBeGreaterThan(5.5);
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.worldPosition.y).toBeCloseTo(5, 1); // feet on the tiles' top at 4
  });

  it("oneWay on the collider makes every tile one-way (ADR 0423)", async () => {
    const engine = await setup();
    const node = GameObject.create("map");
    const map = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
    map.fillRect(-3, 2, 6, 1, 1); // "full" tiles at y = 2..3, solid by themselves
    map.fillRect(-10, -3, 20, 1, 1); // and a floor at y = -3..-2
    node.addBehavior(ShapeCollider2D, { oneWay: true });
    const { b, rb } = box(0, 0);
    steps(engine, 2);
    rb.velocity = { x: 0, y: 12 };
    let maxY = -Infinity;
    for (let i = 0; i < 180; i++) {
      engine.step(1 / 60);
      maxY = Math.max(maxY, b.transform!.worldPosition.y);
    }
    expect(maxY).toBeGreaterThan(3.4);
    expect(b.transform!.worldPosition.y).toBeCloseTo(3.4, 1); // up through the full tiles, landed on top
    rb.dropThrough();
    steps(engine, 120);
    expect(b.transform!.worldPosition.y).toBeCloseTo(-1.6, 1); // dropped through onto the floor, one-way too
  });
});

describe("tile anchors (ADR 0119)", () => {
  const tall: TileFrame = { texture: "t.png", uv: [0, 0, 1, 1], size: [1, 2] };
  const xs = (anchor?: [number, number]) => {
    const m = buildChunkMeshes(Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)), 0, 0, { x: 1, y: 1 }, () => ({ ...tall, ...(anchor ? { anchor } : {}) }))[0];
    const p = Array.from(m.positions);
    return { x: [Math.min(p[0], p[3], p[6], p[9]), Math.max(p[0], p[3], p[6], p[9])], y: [Math.min(p[1], p[4], p[7], p[10]), Math.max(p[1], p[4], p[7], p[10])] };
  };
  it("defaults to bottom-left corners together, and aligns the anchor point with the cell's", () => {
    expect(xs()).toEqual({ x: [0, 1], y: [0, 2] });
    expect(xs([0.5, 0])).toEqual({ x: [0, 1], y: [0, 2] }); // width 1: no x offset; bottoms aligned
    expect(xs([0.5, 0.5])).toEqual({ x: [0, 1], y: [-0.5, 1.5] });
    expect(xs([1, 1])).toEqual({ x: [0, 1], y: [-1, 1] });
  });
  it("parses tile and tileset anchors, and the tile's wins", () => {
    const { tileset, problems } = parseTileset({ format: "myco.tileset@1", anchor: [0.5, 0], tiles: [{ id: 1, sprite: "a", anchor: [0, 1] }, { id: 2, sprite: "a" }, { id: 3, sprite: "a", anchor: [2, 0] }] });
    expect(problems.join()).toMatch(/tile 3 "anchor"/);
    expect(tileAnchor(tileset, tileset.tiles[0])).toEqual([0, 1]);
    expect(tileAnchor(tileset, tileset.tiles[1])).toEqual([0.5, 0]);
    expect(tileAnchor(newTileset(), { id: 1, uuid: legacyTileUuid(1), sprite: "", collision: "none" })).toEqual([0, 0]);
  });
});
