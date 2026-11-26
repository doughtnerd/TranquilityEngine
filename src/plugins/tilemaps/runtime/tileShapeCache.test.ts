// ADR 0423 and 0425: tile shapes merged per chunk and cached, layer offsets in the shapes, and shadow shapes per tile.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Light2D, SceneManager, ShadowCaster2D, Tilemap, Vector2, type TilemapLayerData } from "../../../myco";
import { buildTileShapes, type TileShapes } from "./collision";
import { newLayer } from "./format";
import { tileGrid, type GridParams } from "./grids";
import { Tileset, parseTileset } from "./tileset";

const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  tiles: [
    { id: 1, sprite: "", collision: "full" },
    { id: 2, sprite: "", collision: "oneWay" },
    { id: 3, sprite: "", collision: { polygon: [[0, 0], [1, 0], [1, 1]] } },
    { id: 4, sprite: "", collision: { shapes: [{ polygon: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] }, { polygon: [[0, 0.8], [1, 0.8], [1, 1], [0, 1]], oneWay: true }] } },
    // Occluders (ADR 0423).
    { id: 5, sprite: "", collision: "full", occluder: "none" }, // glass: blocks bodies, not light
    { id: 6, sprite: "", collision: "none", occluder: "full" }, // a fence you walk behind
    { id: 7, sprite: "", collision: "none", occluder: { shapes: [{ polygon: [[0.25, 0], [0.75, 0], [0.75, 1], [0.25, 1]] }] } },
    { id: 8, sprite: "", collision: "full", occluder: "collision" },
  ],
};
const ts = new Tileset(parseTileset(TILESET).tileset);

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function newMap(fields: Record<string, unknown> = {}): Promise<Tilemap> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILESET, "s.json": { format: "myco.scene@1", nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json", ...fields });
}

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pts = readonly (readonly [number, number])[];
const r6 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
/** A loop as a string that doesn't depend on where it starts. */
function loopKey(loop: Pts): string {
  const pts = loop.map(([x, y]) => `${r6(x)},${r6(y)}`);
  let best = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]! < pts[best]!) best = i;
  return [...pts.slice(best), ...pts.slice(0, best)].join(" ");
}
const loopSet = (loops: readonly Pts[]) => loops.map(loopKey).sort();
function area(poly: Pts): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
const totalArea = (s: Pick<TileShapes, "boxes" | "polygons">) => s.boxes.reduce((a, b) => a + b.w * b.h, 0) + s.polygons.reduce((a, p) => a + area(p), 0);

/**
 * The shapes of every colliding layer's tiles merged as one, the way the Tilemap merged them before chunks (ADR 0105,
 * 0421). A whole or one-way cell in two layers counts once (the union; the whole-map merge counted such a cell's edges
 * twice).
 */
function wholeMap(map: Tilemap, mode: "rectangles" | "outline", params: GridParams): TileShapes {
  const cells: { x: number; y: number; value: number }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < map.layerCount; i++) {
    if (!map.layers[i]!.collision) continue;
    for (const c of map.tiles(i)) {
      const kind = ts.tile(c.id)?.collision;
      const k = `${c.x},${c.y},${String(kind)}`;
      if (typeof kind === "string" && seen.has(k)) continue;
      seen.add(k);
      cells.push(c);
    }
  }
  return buildTileShapes(cells, (id) => ts.tile(id)?.collision, mode, tileGrid(params));
}

function expectSameAsWholeMap(map: Tilemap, params: GridParams): void {
  const outline = map.collisionShapes("outline")!;
  const whole = wholeMap(map, "outline", params);
  expect(loopSet(outline.loops), "outlines").toEqual(loopSet(whole.loops));
  expect(loopSet(outline.polygons), "polygons").toEqual(loopSet(whole.polygons));
  expect(loopSet(outline.oneWayPolygons), "one-way polygons").toEqual(loopSet(whole.oneWayPolygons));
  expect(outline.oneWay).toEqual(whole.oneWay); // runs joined across chunk borders, in row order
  const rects = map.collisionShapes("rectangles")!;
  const wholeRects = wholeMap(map, "rectangles", params);
  expect(totalArea(rects)).toBeCloseTo(totalArea(wholeRects), 6);
  expect(rects.oneWay).toEqual(wholeRects.oneWay);
  expect(loopSet(rects.oneWayPolygons)).toEqual(loopSet(wholeRects.oneWayPolygons));
  if (params.shape === "square") {
    // The rectangles cover exactly the solid cells, each once.
    const covered = new Map<string, number>();
    for (const b of rects.boxes) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) covered.set(`${x},${y}`, (covered.get(`${x},${y}`) ?? 0) + 1);
    const solid = new Set<string>();
    for (const b of wholeRects.boxes) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) solid.add(`${x},${y}`);
    expect([...covered.keys()].sort()).toEqual([...solid].sort());
    expect([...covered.values()].every((n) => n === 1)).toBe(true);
  }
}

const GRIDS: GridParams[] = [
  { shape: "square", cellSize: { x: 1, y: 1 } },
  { shape: "isometric", cellSize: { x: 2, y: 1 } },
  { shape: "staggered", cellSize: { x: 2, y: 1 }, staggerAxis: "y", staggerIndex: "odd" },
  { shape: "staggered", cellSize: { x: 2, y: 1 }, staggerAxis: "x", staggerIndex: "even" },
  { shape: "hexagonal", cellSize: { x: 2, y: 2 }, staggerAxis: "y", staggerIndex: "odd", hexSide: 0.5 },
  { shape: "hexagonal", cellSize: { x: 3, y: 2 }, staggerAxis: "x", staggerIndex: "even", hexSide: 0.4 },
  { shape: "hexagonal", cellSize: { x: 2, y: 2 }, staggerAxis: "y", staggerIndex: "even", hexSide: 0 },
];

describe("tile shapes cached per chunk (ADR 0423)", () => {
  for (const params of GRIDS) {
    it(`gives the shapes of a whole-map merge, before and after edits (${params.shape} ${params.staggerAxis ?? ""} ${params.hexSide ?? ""})`, async () => {
      const map = await newMap({ gridShape: params.shape, cellSize: new Vector2(params.cellSize.x, params.cellSize.y), staggerAxis: params.staggerAxis ?? "y", staggerIndex: params.staggerIndex ?? "odd", hexSide: params.hexSide ?? 0.5 });
      map.layers = [newLayer("A"), newLayer("B"), { ...newLayer("Decor"), collision: false }];
      const rnd = random(params.shape.length * 31 + (params.hexSide ?? 1) * 7 + (params.staggerAxis === "x" ? 3 : 0));
      const pick = () => {
        const r = rnd();
        return r < 0.7 ? 1 : r < 0.82 ? 2 : r < 0.92 ? 3 : 4;
      };
      // Spread over chunks on both sides of zero, dense enough for big regions, holes and corner touches.
      for (let y = -20; y < 20; y++) for (let x = -20; x < 20; x++) if (rnd() < 0.45) map.setTile(x, y, pick(), rnd() < 0.8 ? 0 : 1);
      for (let i = 0; i < 300; i++) map.setTile(Math.floor(rnd() * 40) - 20, Math.floor(rnd() * 40) - 20, pick(), 1);
      for (let i = 0; i < 100; i++) map.setTile(Math.floor(rnd() * 40) - 20, Math.floor(rnd() * 40) - 20, 1, 2);
      expectSameAsWholeMap(map, params);
      // Single-cell edits, on chunk borders and inside chunks; each time only that chunk changes.
      for (const [x, y] of [[0, 0], [-1, -1], [15, 3], [16, 3], [5, 5], [-17, 15], [3, -16]] as const) {
        map.setTile(x, y, map.getTile(x, y, 0) ? 0 : 1, 0);
        expectSameAsWholeMap(map, params);
      }
      for (let i = 0; i < 25; i++) {
        const x = Math.floor(rnd() * 44) - 22, y = Math.floor(rnd() * 44) - 22, layer = rnd() < 0.7 ? 0 : 1;
        map.setTile(x, y, map.getTile(x, y, layer) ? 0 : pick(), layer);
        expectSameAsWholeMap(map, params);
      }
      // A chunk emptied in every layer (its merge goes away), then a region painted solid across four chunks.
      map.fillRect(0, 0, 16, 16, 0, 0);
      map.fillRect(0, 0, 16, 16, 0, 1);
      expectSameAsWholeMap(map, params);
      map.fillRect(-6, -6, 12, 12, 1, 0);
      expectSameAsWholeMap(map, params);
      map.layers = [...map.toLayerData()].map((l, i) => (i === 1 ? { ...l, collision: false } : l));
      expectSameAsWholeMap(map, params);
    });
  }

  it("joins a one-way run crossing a chunk border, and an outline crossing four chunks is one loop", async () => {
    const map = await newMap();
    map.fillRect(10, 40, 12, 1, 2); // x 10..21 crosses the border at 16
    map.fillRect(-3, -3, 6, 6, 1); // around the corner of four chunks
    const s = map.collisionShapes("outline")!;
    expect(s.oneWay).toEqual([{ x: 10, y: 40, w: 12, h: 1 }]);
    expect(loopSet(s.loops)).toEqual([loopKey([[-3, -3], [3, -3], [3, 3], [-3, 3]])]);
    expect(map.collisionShapes("rectangles")!.boxes).toHaveLength(4); // rectangles stop at chunk borders
  });

  it("gives the same shapes again until something changes, and notices a reloaded tileset", async () => {
    const map = await newMap();
    map.fillRect(0, 0, 3, 1, 1);
    const a = map.collisionShapes("outline")!;
    expect(map.collisionShapes("outline")).toEqual(a);
    Assets.addSource(Assets.fromObject({ "tiles.tileset.json": { ...TILESET, tiles: TILESET.tiles.map((t) => (t.id === 1 ? { ...t, collision: "oneWay" } : t)) } }));
    const b = map.collisionShapes("outline")!;
    expect(b.loops).toEqual([]);
    expect(b.oneWay).toEqual([{ x: 0, y: 0, w: 3, h: 1 }]);
  });
});

describe("layer offsets in the shapes (ADR 0425)", () => {
  it("moves a layer's shapes by its offset in local units, on a square map in cell units", async () => {
    const map = await newMap({ cellSize: new Vector2(2, 1) });
    const walkway: TilemapLayerData = { ...newLayer("Walkway"), offset: [1, 0.5] };
    map.layers = [newLayer("Ground"), walkway];
    map.setTile(0, 0, 1, 0);
    map.setTile(0, 0, 1, 1);
    const before = map.collisionSignature();
    const s = map.collisionShapes("rectangles")!;
    expect(s.unit).toEqual({ x: 2, y: 1 });
    // In local units: the ground cell at 0..2 × 0..1, the walkway's moved by (1, 0.5).
    const local = s.boxes.map((b) => [b.x * s.unit.x, b.y * s.unit.y, b.w * s.unit.x, b.h * s.unit.y]).sort();
    expect(local).toEqual([[0, 0, 2, 1], [1, 0.5, 2, 1]]);
    // Layers with different offsets don't merge: two outlines.
    expect(map.collisionShapes("outline")!.loops).toHaveLength(2);
    map.layers = map.toLayerData().map((l) => ({ ...l, offset: undefined }));
    expect(map.collisionSignature()).not.toBe(before);
    expect(map.collisionShapes("outline")!.loops).toHaveLength(1); // same cell, same place: one region
  });

  it("moves shapes in local units on other grids, shadows included", async () => {
    const map = await newMap({ gridShape: "hexagonal", cellSize: new Vector2(2, 2) });
    map.layers = [{ ...newLayer("Raised"), offset: [0.5, -0.25] }];
    map.setTile(3, 3, 1);
    const outline = map.cellOutline(3, 3).map((p): [number, number] => [p.x + 0.5, p.y - 0.25]);
    expect(loopSet(map.collisionShapes("outline")!.loops)).toEqual([loopKey(outline)]);
    expect(loopSet(map.shadowShapes()!.loops)).toEqual([loopKey(outline)]);
  });
});

describe("shadow shapes per tile (ADR 0423)", () => {
  it("casts with the collision by default: the same outlines shadows had from collision shapes", async () => {
    const map = await newMap({ cellSize: new Vector2(2, 0.5) });
    const rnd = random(7);
    for (let y = -18; y < 18; y++) for (let x = -18; x < 18; x++) if (rnd() < 0.5) map.setTile(x, y, [1, 1, 2, 3, 4, 8][Math.floor(rnd() * 6)]!);
    const c = map.collisionShapes("outline")!;
    const scale = (pts: Pts) => pts.map(([x, y]): [number, number] => [x * 2, y * 0.5]);
    const today = [...c.loops.map(scale), ...c.polygons.map(scale), ...c.boxes.map((b) => scale([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]))];
    const s = map.shadowShapes()!;
    expect(loopSet([...s.loops, ...s.polygons])).toEqual(loopSet(today));
  });

  it("reads each tile's occluder: none, full, its own shapes; and every layer casts", async () => {
    const map = await newMap();
    map.layers = [newLayer("Walls"), { ...newLayer("Fences"), collision: false }];
    map.setTile(0, 0, 5); // glass: collides, casts nothing
    map.setTile(2, 0, 6); // fence: casts its cell, doesn't collide
    map.setTile(3, 0, 1); // a wall beside the fence: one outline with it
    map.setTile(6, 0, 7); // a post: its own shape
    map.setTile(9, 0, 2); // one-way: collision without shadow
    map.setTile(0, 5, 1, 1); // a solid tile on the layer without collision still casts
    const s = map.shadowShapes()!;
    expect(loopSet(s.loops)).toEqual(loopSet([[[2, 0], [4, 0], [4, 1], [2, 1]], [[0, 5], [1, 5], [1, 6], [0, 6]]]));
    expect(loopSet(s.polygons)).toEqual([loopKey([[6.25, 0], [6.75, 0], [6.75, 1], [6.25, 1]])]);
    const c = map.collisionShapes("outline")!;
    expect(loopSet(c.loops)).toEqual(loopSet([[[0, 0], [1, 0], [1, 1], [0, 1]], [[3, 0], [4, 0], [4, 1], [3, 1]]]));
    const before = map.shadowSignature();
    map.setTile(2, 0, 0);
    expect(map.shadowSignature()).not.toBe(before);
    expect(loopSet(map.shadowShapes()!.loops)).toEqual(loopSet([[[3, 0], [4, 0], [4, 1], [3, 1]], [[0, 5], [1, 5], [1, 6], [0, 6]]]));
  });

  it("is what a ShadowCaster2D on the Tilemap casts with (auto and collider)", async () => {
    const map = await newMap();
    const light = GameObject.create("light").addBehavior(Light2D, { type: "point", innerRadius: 10, outerRadius: 20, shadows: true });
    void light;
    const caster = map.node.addBehavior(ShadowCaster2D);
    map.setTile(2, 0, 5); // glass between the light and (4.5, 0.5): no shadow, though it collides
    map.setTile(2, 3, 6); // a fence between the light and (4.5, 3.5): a shadow, though it doesn't collide
    const lightAt = (x: number, y: number) => Light2D.sampleAt(new Vector2(x, y)).r;
    light.node.transform!.position.set(0.5, 0.5, 0);
    expect(lightAt(4.5, 0.5)).toBeCloseTo(1);
    light.node.transform!.position.set(0.5, 3.5, 0);
    expect(lightAt(4.5, 3.5)).toBeCloseTo(0);
    caster.shape = "collider";
    expect(lightAt(4.5, 3.5)).toBeCloseTo(0);
    map.setTile(2, 3, 0);
    expect(lightAt(4.5, 3.5)).toBeCloseTo(1);
  });
});
