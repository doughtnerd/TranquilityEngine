import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, FLIP_X, FLIP_Y, GameObject, MapObject, SceneManager, Tilemap, getComponentClass } from "../../../../myco";
import { parseImportSettings } from "../../../../engine/scene/importSettings";
import type { NodeEntry, SceneFile } from "../../../../engine/scene/SceneLoader";
import { parseTileset, type TilesetData } from "../../runtime/tileset";
import type { ImportTiledMap, ImportTileset } from "./model";
import { intGridKey, writeLdtkProject, writeTiledMap, writeTiledTileset, type NativeImportOptions, type NativeImportResult } from "./nativeWriter";
import { parseLdtkProject } from "./ldtk";
import { parseTiledMap, parseTiledTileset } from "./tiled";

const ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = async (path: string): Promise<string | null> => {
  // The repo compiles every `.tsx` under src/, so the fixture TSX tilesets are stored as `.tsx.xml`.
  const onDisk = path.endsWith(".tsx") ? `${path}.xml` : path;
  try {
    return await readFile(ROOT + onDisk, "utf8");
  } catch {
    return null;
  }
};
const tiled = async (path: string) => parseTiledMap((await read(path))!, path, read);
const ldtk = async () => parseLdtkProject((await read("ldtk/project.ldtk"))!, "ldtk/project.ldtk", read);

/** Deterministic uuids: `prefix-1`, `prefix-2`… */
const uuids = (prefix = "u") => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};
const none = () => null;
const OUT: NativeImportOptions = { folder: "out" };

const fileOf = (res: NativeImportResult, path: string) => {
  const f = res.files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} among ${res.files.map((x) => x.path).join(", ")}`);
  return f.text;
};
const json = <T>(res: NativeImportResult, path: string) => JSON.parse(fileOf(res, path)) as T;
const tileset = (res: NativeImportResult, path: string): TilesetData => parseTileset(json(res, path), path).tileset;
const prefab = (res: NativeImportResult, path: string) => json<SceneFile>(res, path).nodes;
const comp = (node: NodeEntry | undefined, type: string) => node?.components?.find((c) => c.type === type)?.data as Record<string, any> | undefined;
const byName = (nodes: NodeEntry[], name: string) => nodes.find((n) => n.name === name)!;

// --- loading a written Tilemap into the engine --------------------------------------------------------------------

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

/** The written Tilemap node as a live `Tilemap` (its tileset from the written files), without its collider. */
async function liveTilemap(res: NativeImportResult, node: NodeEntry): Promise<Tilemap> {
  const files: Record<string, unknown> = {};
  for (const f of res.files) if (f.path.endsWith(".json")) files[f.path] = JSON.parse(f.text);
  const tilemap = node.components!.find((c) => c.type === "engine.Tilemap")!;
  files["s.json"] = { format: "myco.scene@5", nodes: [{ id: "m", name: "map", components: [tilemap] }] };
  Assets.clearSources();
  Assets.addSource(Assets.fromObject(files));
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return GameObject.findObjectOfType(Tilemap)!;
}

// --- Tiled ---------------------------------------------------------------------------------------------------------

describe("writeTiledMap: tilesets and sidecar slices", () => {
  it("writes each tileset with ids = index + 1, grid slices in the image's sidecar and whole images for collections", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids());
    expect(res.files.map((f) => f.path)).toEqual(["out/terrain.tileset.json", "out/props.tileset.json", "images/terrain.png.meta.json", "out/ortho.prefab.json"]);
    const terrain = tileset(res, "out/terrain.tileset.json");
    expect(terrain.tileSize).toEqual([16, 16]);
    expect(terrain.previewGrid).toBe("square");
    expect(terrain.tiles.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(terrain.tiles[5]!.sprite).toBe("asset:images/terrain.png#terrain_5");
    const sidecar = parseImportSettings(json(res, "images/terrain.png.meta.json")).settings;
    expect(sidecar.sprites).toHaveLength(12);
    expect(sidecar.sprites.find((s) => s.name === "terrain_5")!.rect).toEqual([19, 19, 16, 16]);
    const props = tileset(res, "out/props.tileset.json");
    expect(props.tiles.map((t) => [t.id, t.sprite])).toEqual([[1, "asset:images/barrel.png"], [4, "asset:images/crate.png"]]);
  });

  it("carries collision shapes, animation, data, weight and terrains, and warns about an offset no anchor expresses", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids());
    const terrain = tileset(res, "out/terrain.tileset.json");
    const t0 = terrain.tiles[0]!;
    expect(t0.collision).toMatchObject({ shapes: [{ oneWay: true }, {}, {}] });
    expect(t0.data).toMatchObject({ class: "Solid", friction: 0.5, solid: true });
    const t1 = terrain.tiles[1]!;
    expect(t1.weight).toBe(0.25);
    expect(t1.animation).toEqual({ frames: [{ sprite: "asset:images/terrain.png#terrain_1", duration: 0.1 }, { sprite: "asset:images/terrain.png#terrain_2", duration: 0.25 }] });
    expect(terrain.terrains.map((t) => t.name)).toEqual(["Grass", "Sand"]);
    expect([terrain.tiles[5]!.terrain, terrain.tiles[5]!.pattern]).toEqual(["Grass", "111110*0"]);
    expect(terrain.anchor).toBeUndefined();
    expect(res.warnings.some((w) => w.includes('"terrain"') && w.includes("anchor"))).toBe(true);
  });

  it("merges with an existing sidecar: reuses a slice with the same rectangle and keeps the others", async () => {
    const existing = JSON.stringify({ format: "myco.import@1", filter: "point", sprites: [{ name: "grass", rect: [19, 19, 16, 16] }, { name: "terrain_0", rect: [0, 0, 4, 4] }] });
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, (p) => (p === "images/terrain.png.meta.json" ? existing : null), uuids());
    const sidecar = parseImportSettings(json(res, "images/terrain.png.meta.json")).settings;
    expect(sidecar.filter).toBe("point");
    expect(sidecar.sprites.find((s) => s.name === "terrain_0")!.rect).toEqual([0, 0, 4, 4]);
    expect(sidecar.sprites.find((s) => s.name === "terrain_0_2")!.rect).toEqual([1, 1, 16, 16]);
    expect(sidecar.sprites).toHaveLength(13);
    const terrain = tileset(res, "out/terrain.tileset.json");
    expect(terrain.tiles[5]!.sprite).toBe("asset:images/terrain.png#grass");
    expect(terrain.tiles[0]!.sprite).toBe("asset:images/terrain.png#terrain_0_2");
  });

  it("keeps tile uuids and ids on re-import (matched by image and slice)", async () => {
    const map = await tiled("tiled/ortho.tmx");
    const first = writeTiledMap(map, OUT, none, uuids("a"));
    const files = new Map(first.files.map((f) => [f.path, f.text]));
    // Someone renumbered a tile in Myco since; its id is kept too.
    const ts = JSON.parse(files.get("out/terrain.tileset.json")!);
    ts.tiles[3].id = 40;
    files.set("out/terrain.tileset.json", JSON.stringify(ts));
    const again = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, (p) => files.get(p) ?? null, uuids("b"));
    const before = tileset(first, "out/terrain.tileset.json").tiles;
    const after = tileset(again, "out/terrain.tileset.json").tiles;
    expect(after.map((t) => t.uuid)).toEqual(before.map((t) => t.uuid));
    expect(after[3]!.id).toBe(40);
    // The sidecar already holds every slice: nothing to write.
    expect(again.files.some((f) => f.path.endsWith(".meta.json"))).toBe(false);
    // And the prefab is the same file, node ids included.
    expect(fileOf(again, "out/ortho.prefab.json")).toBe(fileOf(first, "out/ortho.prefab.json"));
  });
});

describe("writeTiledMap: the prefab", () => {
  it("has one Tilemap per tileset, layers at their stack order with their meta", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids());
    const nodes = prefab(res, "out/ortho.prefab.json");
    const root = nodes[0]!;
    expect(root.name).toBe("ortho");
    expect(comp(root, "engine.MapObject")).toMatchObject({ type: "Level", properties: { lives: 3, music: "audio/theme.ogg", spawn: { count: 2, kind: "slime" } } });
    // An object reference names the object's node.
    expect(comp(root, "engine.MapObject")!.properties.boss).toBe(nodes.find((n) => n.name === "boss")!.id);
    const terrain = byName(nodes, "terrain");
    expect(terrain.parent).toBe(root.id);
    const tm = comp(terrain, "engine.Tilemap")!;
    expect(tm).toMatchObject({ tileset: "asset:out/terrain.tileset.json", cellSize: [1, 1], gridShape: "square" });
    expect(tm.layers.map((l: any) => [l.name, l.orderInLayer])).toEqual([["Ground", 0], ["Deco/Vines", 1]]);
    expect(tm.layers[0]).toMatchObject({ tint: "#ff8080", opacity: 1, visible: true });
    const vines = tm.layers[1];
    expect(vines).toMatchObject({ visible: false, opacity: 0.25, offset: [5 / 16, 2 / 16], parallax: [0.25, 2], locked: true });
    expect(comp(terrain, "engine.ShapeCollider2D")).toEqual({});
    const props = comp(byName(nodes, "props"), "engine.Tilemap")!;
    expect(props.layers.map((l: any) => l.name)).toEqual(["Ground"]);
    expect(comp(byName(nodes, "props"), "engine.ShapeCollider2D")).toBeUndefined();
  });

  it("puts every cell at its Myco cell (orthogonal: rows flipped), flips included", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids());
    const nodes = prefab(res, "out/ortho.prefab.json");
    const map = await liveTilemap(res, byName(nodes, "terrain"));
    // Tiled row 0 (top) of a 3-row map is Myco row 2.
    expect([0, 1, 2, 3].map((x) => map.getTile(x, 2, "Ground"))).toEqual([1, 2, 3, 4]);
    expect(map.getTile(0, 1, "Ground")).toBe(5);
    expect(map.getCell(0, 1, "Ground") & FLIP_X).toBeTruthy();
    expect(map.getCell(1, 1, "Ground") & FLIP_Y).toBeTruthy();
    expect(map.getTile(1, 1, "Deco/Vines")).toBe(9);
    const props = await liveTilemap(res, byName(prefab(res, "out/ortho.prefab.json"), "props"));
    expect(props.getTile(0, 0)).toBe(1);
    expect(props.getTile(2, 0)).toBe(4);
  });

  it("makes object nodes with MapObjects, trigger colliders and tile sprites", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), { ...OUT, shapesAsTriggers: true }, none, uuids());
    const nodes = prefab(res, "out/ortho.prefab.json");
    const layer = byName(nodes, "Things");
    expect(comp(layer, "engine.MapObject")).toEqual({ type: "Spawns", properties: {} });
    const door = byName(nodes, "door");
    expect(door.parent).toBe(layer.id);
    expect(comp(door, "engine.MapObject")).toEqual({ type: "Door", properties: {} });
    // Top-left (16, 8) of a 48-pixel-high map, turned 90° clockwise.
    const t = comp(door, "engine.Transform")!;
    expect(t.position).toEqual([1, 2.5, 0]);
    expect(t.rotation[2]).toBeCloseTo(-Math.SQRT1_2);
    expect(comp(door, "engine.BoxCollider2D")).toEqual({ size: [1, 1.5], center: [0.5, -0.75], isTrigger: true });
    expect(comp(byName(nodes, "zone"), "engine.PolygonCollider2D")!.points).toHaveLength(16);
    expect(comp(byName(nodes, "boss"), "engine.MapObject")!.type).toBe("Enemy");
    expect(byName(nodes, "boss").components!.some((c) => c.type.endsWith("Collider2D"))).toBe(false);
    const line = nodes.find((n) => n.id.endsWith("-o14"))!;
    expect(line.active).toBe(false);
    expect(comp(line, "engine.EdgeCollider2D")!.points).toEqual([[0, 0], [5 / 16, -5 / 16]]);
    const tileObject = nodes.find((n) => n.id.endsWith("-o16"))!;
    expect(comp(tileObject, "engine.SpriteRenderer")).toMatchObject({ sprite: "asset:images/barrel.png", size: [1, 2], flipX: true, orderInLayer: 2 });
    // Bottom-left (48, 48) → its centre half a tile right and a tile up.
    expect(comp(tileObject, "engine.Transform")!.position).toEqual([3.5, 1, 0]);
    const chest = nodes.find((n) => n.id.endsWith("-o17"))!;
    expect(comp(chest, "engine.MapObject")).toEqual({ type: "Chest", properties: { loot: "silver", locked: true } });
    expect(comp(byName(nodes, "Big chest"), "engine.SpriteRenderer")!.sprite).toBe("asset:images/terrain.png#terrain_10");
    // Without the options: no colliders, and no object nodes at all.
    const plain = prefab(writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids()), "out/ortho.prefab.json");
    expect(plain.some((n) => n.components!.some((c) => c.type === "engine.BoxCollider2D"))).toBe(false);
    const noObjects = prefab(writeTiledMap(await tiled("tiled/ortho.tmx"), { ...OUT, objectsAsNodes: false }, none, uuids()), "out/ortho.prefab.json");
    expect(noObjects.some((n) => n.name === "Things")).toBe(false);
  });

  it("makes an image layer a sprite node at its stack order", async () => {
    const nodes = prefab(writeTiledMap(await tiled("tiled/ortho.tmx"), OUT, none, uuids()), "out/ortho.prefab.json");
    const sky = byName(nodes, "Sky");
    expect(comp(sky, "engine.SpriteRenderer")).toMatchObject({ sprite: "asset:images/sky.png", size: [20, 11.25], orderInLayer: 3 });
    expect(comp(sky, "engine.Transform")!.position).toEqual([10, 3 - 5.625, 0]);
  });

  it("honours pixels per unit", async () => {
    const res = writeTiledMap(await tiled("tiled/ortho.tmx"), { ...OUT, pixelsPerUnit: 32 }, none, uuids());
    expect(comp(byName(prefab(res, "out/ortho.prefab.json"), "terrain"), "engine.Tilemap")!.cellSize).toEqual([0.5, 0.5]);
  });

  it("converts isometric cells (axes swapped and negated)", async () => {
    const res = writeTiledMap(await tiled("tiled/iso.tmx"), OUT, none, uuids());
    const node = byName(prefab(res, "out/iso.prefab.json"), "blocks");
    expect(comp(node, "engine.Tilemap")).toMatchObject({ gridShape: "isometric", cellSize: [1, 0.5] });
    expect(tileset(res, "out/blocks.tileset.json")).toMatchObject({ tileSize: [64, 32], previewGrid: "isometric" });
    const map = await liveTilemap(res, node);
    expect([map.getTile(1, 1), map.getTile(1, 0), map.getTile(0, 1), map.getTile(0, 0)]).toEqual([1, 2, 3, 4]);
  });

  it("converts staggered cells, keeping each row's parity", async () => {
    const res = writeTiledMap(await tiled("tiled/staggered.tmx"), OUT, none, uuids());
    const node = byName(prefab(res, "out/staggered.prefab.json"), "diamonds");
    expect(comp(node, "engine.Tilemap")).toMatchObject({ gridShape: "staggered", staggerAxis: "y", staggerIndex: "odd" });
    const map = await liveTilemap(res, node);
    expect([map.getTile(1, 2), map.getTile(0, 1), map.getTile(0, 2), map.getTile(1, 1)]).toEqual([1, 1, 0, 0]);
  });

  it("converts hexagonal cells and grid fields", async () => {
    const res = writeTiledMap(await tiled("tiled/hex.tmj"), OUT, none, uuids());
    const node = byName(prefab(res, "out/hex.prefab.json"), "hexes");
    expect(comp(node, "engine.Tilemap")).toMatchObject({ gridShape: "hexagonal", staggerAxis: "x", staggerIndex: "even", hexSide: 12 / 32, cellSize: [1, 28 / 32] });
    expect(tileset(res, "out/hexes.tileset.json").previewGrid).toBe("hexagonal");
    const map = await liveTilemap(res, node);
    expect([map.getTile(0, 1), map.getTile(1, 1), map.getTile(0, 0)]).toEqual([1, 2, 0]);
  });
});

describe("Wang patterns in the grid's neighbour order", () => {
  /** A one-tile map of `shape` whose only tile has Wang pattern `pattern` (Tiled's order). */
  function wangMap(shape: ImportTiledMap["grid"]["shape"], staggerAxis: "x" | "y", pattern: string): ImportTiledMap {
    const ts: ImportTileset = {
      name: "w", path: null, tileWidth: 16, tileHeight: 16, image: { path: "w.png", width: 16, height: 16 }, margin: 0, spacing: 0, columns: 1, tileCount: 1, offset: [0, 0],
      tiles: [{ index: 0, rect: { x: 0, y: 0, w: 16, h: 16 }, shapes: [], terrain: "T", pattern }], terrains: [{ name: "T" }], properties: {},
    };
    return {
      format: "tiled", path: "w.tmx", name: "w", grid: { shape, staggerAxis, staggerIndex: "odd", hexSide: 0.5, tileWidth: 16, tileHeight: 16 },
      width: 1, height: 1, infinite: false, parallaxOrigin: [0, 0], properties: {}, tilesets: [ts], layers: [], warnings: [],
    };
  }
  const patternOn = (shape: ImportTiledMap["grid"]["shape"], axis: "x" | "y", pattern: string) => tileset(writeTiledMap(wangMap(shape, axis, pattern), OUT, none, uuids()), "out/w.tileset.json").tiles[0]!.pattern;

  it("keeps square patterns and turns isometric and staggered ones (Tiled's top is Myco's east)", () => {
    expect(patternOn("square", "y", "1*0*0*0*")).toBe("1*0*0*0*");
    expect(patternOn("isometric", "y", "1*0*0*0*")).toBe("0*1*0*0*");
    expect(patternOn("staggered", "y", "01000000")).toBe("00010000");
    expect(patternOn("isometric", "y", "00000010")).toBe("10000000");
  });

  it("gives hexagonal maps 6-character patterns in the grid's own neighbour order", () => {
    // Pointy-top: NE E SE SW W NW ← Tiled's top-right, right, bottom-right, bottom-left, left, top-left neighbours.
    expect(patternOn("hexagonal", "y", "1100000*")).toBe("110000");
    expect(patternOn("hexagonal", "y", "00100010")).toBe("001001");
    // Flat-top: N NE SE S SW NW.
    expect(patternOn("hexagonal", "x", "00010001")).toBe("100100");
  });
});

describe("two-colour corner sets painted as Tiled paints them (ADR 0444)", () => {
  type Orientation = "orthogonal" | "isometric" | "staggered";
  interface Case {
    orientation: Orientation;
    staggeraxis?: "x" | "y";
    staggerindex?: "odd" | "even";
    width: number;
    height: number;
  }
  type Point = [number, number];

  /** Tile i is water at the corners whose bit is set (1 top-right, 2 bottom-right, 4 bottom-left, 8 top-left); tile 16 is a second all-grass tile, so water has fewer full tiles. */
  const wangid = (i: number) => {
    const c = (bit: number) => (i !== 16 && i & bit ? 2 : 1);
    return [0, c(1), 0, c(2), 0, c(4), 0, c(8)];
  };

  /** Tiled's `HexagonalRenderer` neighbours, which its staggered maps use too (staggerindex odd = 0, even = 1). */
  const shiftedLine = (c: Case, x: number, y: number) => (((c.staggeraxis === "x" ? x : y) & 1) ^ (c.staggerindex === "even" ? 1 : 0)) === 1;
  const bottomLeft = (c: Case, [x, y]: Point): Point =>
    c.staggeraxis === "x" ? (shiftedLine(c, x, y) ? [x - 1, y + 1] : [x - 1, y]) : shiftedLine(c, x, y) ? [x, y + 1] : [x - 1, y + 1];
  const bottomRight = (c: Case, [x, y]: Point): Point =>
    c.staggeraxis === "x" ? (shiftedLine(c, x, y) ? [x + 1, y + 1] : [x + 1, y]) : shiftedLine(c, x, y) ? [x + 1, y + 1] : [x, y + 1];

  /**
   * The vertices of Tiled cell (x, y) as Tiled's Wang brush shares them (`WangFiller::setCorner`), in Wang id order:
   * top-right, bottom-right, bottom-left, top-left. Orthogonal and isometric maps name a vertex by the cell it is the
   * top-left corner of, as do staggered ones, whose neighbours are the hexagonal renderer's: vertex v is the top-right
   * corner of topLeft(v), the bottom-left of topRight(v) and the bottom-right of topRight(topLeft(v)).
   */
  const verticesOf = (c: Case, x: number, y: number): Point[] =>
    c.orientation === "staggered"
      ? [bottomRight(c, [x, y]), bottomRight(c, bottomLeft(c, [x, y])), bottomLeft(c, [x, y]), [x, y]]
      : [[x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]];

  /** Where a vertex is, roughly in cells, for drawing a round pond. */
  const vertexAt = (c: Case, [x, y]: Point): Point => {
    if (c.orientation !== "staggered") return [x, y];
    const s = shiftedLine(c, x, y) ? 0.5 : 0;
    return c.staggeraxis === "x" ? [x / 2, y + s] : [x + s, y / 2];
  };

  /** A map of `c` with a round pond painted as Tiled's corner brush paints it, as TMJ. */
  function pondMap(c: Case, centre: Point, radius: number): { text: string; gids: number[] } {
    const water = (v: Point) => {
      const [px, py] = vertexAt(c, v);
      return (px - centre[0]) ** 2 + (py - centre[1]) ** 2 <= radius * radius;
    };
    const gids: number[] = [];
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const [tr, br, bl, tl] = verticesOf(c, x, y).map(water);
        const index = (tr ? 1 : 0) | (br ? 2 : 0) | (bl ? 4 : 0) | (tl ? 8 : 0);
        gids.push(index === 0 && (x + y) % 3 === 0 ? 17 : index + 1);
      }
    const tileset = {
      firstgid: 1, name: "gw", tilewidth: 32, tileheight: 16, tilecount: 17, columns: 17, image: "gw.png", imagewidth: 544, imageheight: 16,
      wangsets: [{ name: "Ground", type: "corner", tile: -1, colors: [{ name: "Grass", color: "#00ff00", probability: 1, tile: -1 }, { name: "Water", color: "#0000ff", probability: 1, tile: -1 }], wangtiles: Array.from({ length: 17 }, (_, tileid) => ({ tileid, wangid: wangid(tileid) })) }],
    };
    const map = {
      type: "map", orientation: c.orientation, ...(c.staggeraxis ? { staggeraxis: c.staggeraxis, staggerindex: c.staggerindex } : {}),
      width: c.width, height: c.height, tilewidth: 32, tileheight: 16, infinite: false, tilesets: [tileset],
      layers: [{ id: 1, name: "Ground", type: "tilelayer", x: 0, y: 0, width: c.width, height: c.height, opacity: 1, visible: true, data: gids }],
    };
    return { text: JSON.stringify(map), gids };
  }

  const cases: [string, Case, Point, number][] = [
    ["orthogonal", { orientation: "orthogonal", width: 9, height: 9 }, [4.5, 4], 2.6],
    ["isometric", { orientation: "isometric", width: 9, height: 9 }, [4, 4.5], 2.6],
    ["staggered (axis y, odd)", { orientation: "staggered", staggeraxis: "y", staggerindex: "odd", width: 8, height: 16 }, [3.5, 4], 2.3],
    ["staggered (axis x, even)", { orientation: "staggered", staggeraxis: "x", staggerindex: "even", width: 16, height: 8 }, [4, 3.5], 2.3],
  ];

  it.each(cases)("%s: re-painting the pond's terrain gives back the tiles Tiled placed", async (_name, c, centre, radius) => {
    const { text, gids } = pondMap(c, centre, radius);
    // Every transition shape the pond needs is there, not only the full tiles.
    expect(new Set(gids).size).toBeGreaterThanOrEqual(10);
    const res = writeTiledMap(await parseTiledMap(text, "gw.tmj", async () => null), OUT, none, uuids());
    const ts = tileset(res, "out/gw.tileset.json");
    expect(ts.terrains.map((t) => t.name)).toEqual(["Water"]);
    // Water at the top-right corner only, in the grid's neighbour order (Tiled's top is an isometric map's east).
    expect(ts.tiles[1]!.pattern).toBe(c.orientation === "orthogonal" ? "1110*0*0" : "*01110*0");
    expect([ts.tiles[0]!.terrain, ts.tiles[16]!.terrain]).toEqual([undefined, undefined]);

    const node = prefab(res, "out/gw.prefab.json").find((n) => n.components?.some((k) => k.type === "engine.Tilemap"))!;
    const map = await liveTilemap(res, node);
    const b = map.cellBounds()!;
    const painted = new Map<string, number>();
    const pond: [number, number][] = [];
    for (let y = b.minY; y <= b.maxY; y++)
      for (let x = b.minX; x <= b.maxX; x++) {
        painted.set(`${x},${y}`, map.getTile(x, y));
        if (map.getTileDef(x, y)?.terrain === "Water") pond.push([x, y]);
      }
    expect(pond.length).toBeGreaterThan(12);
    // The auto-tiler already agrees with every tile Tiled placed…
    expect(map.retileTerrain()).toEqual([]);
    // …and painting the pond's cells again from nothing places the same tiles.
    map.paintTerrain(pond, null);
    expect(pond.every(([x, y]) => map.getTile(x, y) === 0)).toBe(true);
    map.paintTerrain(pond, "Water");
    for (const [key, id] of painted) expect([key, map.getTile(...(key.split(",").map(Number) as [number, number]))]).toEqual([key, id]);
  });
});

describe("writeTiledTileset", () => {
  it("writes a standalone TSJ tileset with its slices", async () => {
    const file = await parseTiledTileset((await read("tiled/water.tsj"))!, "tiled/water.tsj", read);
    const res = writeTiledTileset(file, OUT, none, uuids());
    expect(res.files.map((f) => f.path)).toEqual(["out/water.tileset.json", "images/water.png.meta.json"]);
    const ts = tileset(res, "out/water.tileset.json");
    expect(ts.tiles[0]!.data).toMatchObject({ class: "Water", meta: { depth: 3 } });
    expect(ts.tiles[0]!.animation!.frames.map((f) => f.duration)).toEqual([0.15, 0.15]);
    expect(ts.tiles[1]!.pattern).toBe("1*1*0*0*");
  });
});

// --- LDtk ----------------------------------------------------------------------------------------------------------

describe("writeLdtkProject", () => {
  it("writes the tilesets, the IntGrid tileset with the chosen collision, a prefab per level and per world", async () => {
    const res = writeLdtkProject(await ldtk(), { ...OUT, intGridCollision: { [intGridKey("Collisions", 1)]: "full" } }, none, uuids());
    expect(res.files.map((f) => f.path)).toEqual([
      "out/Cavern.tileset.json",
      "out/project.intgrid.tileset.json",
      "images/cavern.png.meta.json",
      "out/project/Level_0.prefab.json",
      "out/project/Overworld.world.prefab.json",
      "out/project/Level_1.prefab.json",
      "out/project/Underworld.world.prefab.json",
    ]);
    const ig = tileset(res, "out/project.intgrid.tileset.json");
    expect(ig.tiles.map((t) => [t.id, t.sprite, t.collision, t.data])).toEqual([
      [1, "", "full", { intGrid: 1, name: "wall", layer: "Collisions" }],
      [2, "", "none", { intGrid: 2, name: null, layer: "Collisions" }],
    ]);
    const cavern = tileset(res, "out/Cavern.tileset.json");
    expect(cavern.tiles[2]!.data).toEqual({ customData: "crumbly", tags: ["Spiky", "Hot"] });
  });

  it("puts IntGrid values on a hidden Tilemap with a collider, and tile layers at flipped rows", async () => {
    const res = writeLdtkProject(await ldtk(), { ...OUT, intGridCollision: { [intGridKey("Collisions", 1)]: "full" } }, none, uuids());
    const nodes = prefab(res, "out/project/Level_0.prefab.json");
    expect(nodes[0]).toMatchObject({ id: "lv0", name: "Level_0" });
    expect(comp(nodes[0], "engine.MapObject")).toEqual({ type: "", properties: { title: "Start" } });
    const igNode = byName(nodes, "Collisions (IntGrid)");
    expect(comp(igNode, "engine.ShapeCollider2D")).toEqual({});
    const igLayer = comp(igNode, "engine.Tilemap")!.layers[0];
    expect(igLayer).toMatchObject({ name: "Collisions", visible: false, orderInLayer: 4 });
    const ig = await liveTilemap(res, igNode);
    expect([ig.getTile(0, 1), ig.getTile(0, 0), ig.getTile(1, 0), ig.getTile(1, 1)]).toEqual([1, 2, 1, 0]);
    expect(ig.getTileData(0, 1)).toEqual({ intGrid: 1, name: "wall", layer: "Collisions" });

    // Walls (16 px) and Deco (8 px) use one tileset on two grids: two Tilemaps.
    const walls = nodes.find((n) => n.name === "Cavern 16x16")!;
    const wl = comp(walls, "engine.Tilemap")!;
    expect(wl.cellSize).toEqual([1, 1]);
    expect(wl.layers.map((l: any) => [l.name, l.orderInLayer])).toEqual([["Walls", 1], ["Walls#2", 2], ["Walls#3", 3], ["Collisions", 5]]);
    expect(wl.layers[0]).toMatchObject({ opacity: 0.8, offset: [0.25, 0.125] });
    const live = await liveTilemap(res, walls);
    expect([live.getTile(0, 1, "Walls"), live.getTile(1, 1, "Walls"), live.getTile(1, 0, "Walls")]).toEqual([1, 3, 5]);
    expect(live.getCell(1, 1, "Walls") & FLIP_Y).toBeTruthy();
    const deco = comp(nodes.find((n) => n.name === "Cavern 8x8")!, "engine.Tilemap")!;
    expect(deco.cellSize).toEqual([0.5, 0.5]);
    expect(deco.layers[0]).toMatchObject({ name: "Deco", visible: false, orderInLayer: 0 });
  });

  it("makes entities MapObject nodes: fields as properties, points in local units, references as node ids", async () => {
    const res = writeLdtkProject(await ldtk(), { ...OUT, shapesAsTriggers: true }, none, uuids());
    const nodes = prefab(res, "out/project/Level_0.prefab.json");
    const player = nodes.find((n) => n.id === "ent-player")!;
    expect(player.parent).toBe("li-ent");
    expect(comp(player, "engine.Transform")!.position).toEqual([0.5, 0, 0]);
    const mo = comp(player, "engine.MapObject")!;
    expect(mo.type).toBe("Player");
    expect(mo.properties).toMatchObject({ hp: 5, tint: "#ff8800", path: [[1.5, 1.5], [0.5, 1.5]], target: "ent-door", note: null, config: "ldtk/data/player.json" });
    expect(mo.properties.icon).toBe("asset:images/cavern.png#Cavern_1");
    expect(comp(player, "engine.BoxCollider2D")).toEqual({ size: [1, 1], center: [0, 0.5], isTrigger: true });
    const sprite = nodes.find((n) => n.id === "ent-player-sprite")!;
    expect(sprite.parent).toBe("ent-player");
    expect(comp(sprite, "engine.SpriteRenderer")).toEqual({ sprite: "asset:images/cavern.png#Cavern_0", size: [1, 1] });
    expect(comp(sprite, "engine.Transform")!.position).toEqual([0, 0.5, 0]);
    expect(comp(nodes.find((n) => n.id === "ent-door")!, "engine.MapObject")!.properties.links).toContain("ent-player");
  });

  it("instances each world's levels at their world positions, y flipped", async () => {
    const res = writeLdtkProject(await ldtk(), OUT, none, uuids());
    const under = prefab(res, "out/project/Underworld.world.prefab.json");
    expect(under[0]).toMatchObject({ id: "w2", name: "Underworld" });
    expect(under[1]).toEqual({
      id: "lv1",
      name: "Level_1",
      parent: "w2",
      prefab: "out/project/Level_1.prefab.json",
      overrides: [{ component: "engine.Transform", field: "position", value: [4, 1, 0] }],
    });
  });

  it("keeps IntGrid tile uuids on re-import", async () => {
    const first = writeLdtkProject(await ldtk(), OUT, none, uuids("a"));
    const files = new Map(first.files.map((f) => [f.path, f.text]));
    const again = writeLdtkProject(await ldtk(), OUT, (p) => files.get(p) ?? null, uuids("b"));
    expect(tileset(again, "out/project.intgrid.tileset.json").tiles.map((t) => t.uuid)).toEqual(tileset(first, "out/project.intgrid.tileset.json").tiles.map((t) => t.uuid));
    expect(tileset(again, "out/Cavern.tileset.json").tiles.map((t) => t.uuid)).toEqual(tileset(first, "out/Cavern.tileset.json").tiles.map((t) => t.uuid));
  });
});

describe("MapObject (ADR 0438)", () => {
  it("is registered by the Tilemaps plugin and loads its type and properties", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@5", nodes: [{ id: "a", name: "spawn", components: [{ type: "engine.MapObject", data: { type: "Spawn", properties: { team: 2, path: [[1, 2]] } } }] }] } }));
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    await SceneManager.load("s.json");
    expect(getComponentClass("engine.MapObject")).toBe(MapObject);
    const o = GameObject.findObjectOfType(MapObject)!;
    expect([o.type, o.properties]).toEqual(["Spawn", { team: 2, path: [[1, 2]] }]);
  });
});
