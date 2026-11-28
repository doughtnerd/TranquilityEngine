import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ImportImageLayer, ImportObjectLayer, ImportTileLayer, ImportTiledMap } from "./model";
import { parseTiledMap, parseTiledTileset } from "./tiled";

const ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (log: string[] = []) => async (path: string): Promise<string | null> => {
  log.push(path);
  // The repo's tsconfig compiles every `.tsx` under src/, so the fixture TSX tilesets are stored as `.tsx.xml`.
  const onDisk = path.endsWith(".tsx") ? `${path}.xml` : path;
  try {
    return await readFile(ROOT + onDisk, "utf8");
  } catch {
    return null;
  }
};
const load = async (path: string, log?: string[]): Promise<ImportTiledMap> => parseTiledMap((await read()(path))!, path, read(log));
const tiles = (map: ImportTiledMap, name: string) => map.layers.find((l) => l.name === name) as ImportTileLayer;

describe("parseTiledMap: orthogonal TMX with CSV and an external TSX", () => {
  it("reads the grid, map fields and typed properties", async () => {
    const map = await load("tiled/ortho.tmx");
    expect(map.format).toBe("tiled");
    expect(map.name).toBe("ortho");
    expect(map.grid).toEqual({ shape: "square", staggerAxis: "y", staggerIndex: "odd", hexSide: 0.5, tileWidth: 16, tileHeight: 16 });
    expect([map.width, map.height, map.infinite]).toEqual([4, 3, false]);
    expect(map.parallaxOrigin).toEqual([8, 4]);
    expect(map.backgroundColor).toBe("#11223380");
    expect(map.class).toBe("Level");
    expect(map.properties).toEqual({
      dark: true,
      lives: 3,
      gravity: 9.5,
      sky: "#336699",
      music: { kind: "file", path: "audio/theme.ogg" },
      boss: { kind: "object", id: "12" },
      spawn: { kind: "class", type: "SpawnInfo", fields: { count: 2, kind: "slime" } },
      note: "line one\nline two",
    });
  });

  it("loads the external tileset once and keeps the embedded one", async () => {
    const log: string[] = [];
    const map = await load("tiled/ortho.tmx", log);
    expect(map.tilesets.map((t) => [t.name, t.path])).toEqual([["terrain", "tiled/terrain.tsx"], ["props", null]]);
    // The template names the same tileset by another relative path; it isn't read or added twice.
    expect(log.filter((p) => p === "tiled/terrain.tsx")).toHaveLength(1);
    const [terrain, props] = map.tilesets;
    expect(terrain!.image).toEqual({ path: "images/terrain.png", width: 72, height: 54 });
    expect([terrain!.margin, terrain!.spacing, terrain!.columns, terrain!.tileCount]).toEqual([1, 2, 4, 12]);
    expect(terrain!.offset).toEqual([0, 4]);
    expect(terrain!.previewGrid).toBe("square");
    expect(terrain!.properties).toEqual({ author: "tests" });
    expect(terrain!.tiles[5]!.rect).toEqual({ x: 19, y: 19, w: 16, h: 16 });
    expect(props!.image).toBeNull();
    expect(props!.columns).toBe(0);
    expect(props!.tiles.map((t) => [t.index, t.image!.path, t.rect])).toEqual([
      [0, "images/barrel.png", { x: 0, y: 0, w: 16, h: 32 }],
      [3, "images/crate.png", { x: 0, y: 0, w: 16, h: 16 }],
    ]);
  });

  it("resolves gids across tilesets with their flip bits", async () => {
    const ground = tiles(await load("tiled/ortho.tmx"), "Ground");
    expect([ground.cellWidth, ground.cellHeight, ground.width, ground.height]).toEqual([16, 16, 4, 3]);
    expect(ground.tint).toBe("#ff8080");
    const f = (x: number, y: number, tilesetIndex: number, tileIndex: number, flipX = false, flipY = false, flipDiagonal = false) => ({ x, y, tilesetIndex, tileIndex, flipX, flipY, flipDiagonal });
    expect(ground.cells).toEqual([
      f(0, 0, 0, 0), f(1, 0, 0, 1), f(2, 0, 0, 2), f(3, 0, 0, 3),
      f(0, 1, 0, 4, true), f(1, 1, 0, 5, false, true), f(2, 1, 0, 6, false, false, true),
      f(0, 2, 1, 0), f(2, 2, 1, 3), f(3, 2, 0, 0, true, true),
    ]);
  });

  it("flattens groups: names joined, opacity and tint multiplied, offsets added, parallax multiplied, lock inherited", async () => {
    const map = await load("tiled/ortho.tmx");
    expect(map.layers.map((l) => [l.kind, l.name])).toEqual([["tiles", "Ground"], ["tiles", "Deco/Vines"], ["objects", "Things"], ["image", "Sky"]]);
    const vines = tiles(map, "Deco/Vines");
    expect(vines.id).toBe("3");
    expect(vines.opacity).toBeCloseTo(0.25);
    expect(vines.visible).toBe(false);
    expect(vines.offset).toEqual([5, -2]);
    expect(vines.parallax).toEqual([0.25, 2]);
    expect(vines.locked).toBe(true);
    expect(vines.tint).toBe("#800000");
    expect(vines.cells).toEqual([{ x: 1, y: 1, tilesetIndex: 0, tileIndex: 8, flipX: false, flipY: false, flipDiagonal: false }]);
    expect(tiles(map, "Ground").locked).toBe(false);
  });

  it("reads objects of every shape, applies templates, and skips text", async () => {
    const map = await load("tiled/ortho.tmx");
    const layer = map.layers.find((l) => l.kind === "objects") as ImportObjectLayer;
    expect(layer.class).toBe("Spawns");
    const byId = new Map(layer.objects.map((o) => [o.id, o]));
    expect([...byId.keys()]).toEqual(["10", "11", "12", "13", "14", "16", "17", "18"]);
    expect(byId.get("10")).toMatchObject({ name: "door", class: "Door", shape: "rect", x: 16, y: 8, width: 16, height: 24, rotation: 90, visible: true });
    expect(byId.get("11")).toMatchObject({ shape: "ellipse", width: 32, height: 16 });
    expect(byId.get("12")).toMatchObject({ shape: "point", class: "Enemy", x: 40, y: 20, width: 0, height: 0 });
    expect(byId.get("13")).toMatchObject({ shape: "polygon", points: [[0, 0], [10, 0], [10, 10]] });
    expect(byId.get("14")).toMatchObject({ shape: "polyline", points: [[0, 0], [5, 5]], visible: false });
    expect(byId.get("16")).toMatchObject({ shape: "tile", tile: { tilesetIndex: 1, tileIndex: 0, flipX: true, flipY: false, flipDiagonal: false } });
    expect(byId.get("17")).toEqual({
      id: "17", name: "chest", class: "Chest", shape: "tile", x: 32, y: 48, width: 16, height: 16, rotation: 0, visible: true,
      tile: { tilesetIndex: 0, tileIndex: 10, flipX: false, flipY: false, flipDiagonal: false },
      template: "tiled/objects/chest.tx",
      properties: { loot: "silver", locked: true },
    });
    expect(byId.get("18")).toMatchObject({ name: "Big chest", x: 0, y: 48, properties: { loot: "gold", locked: true } });
    expect(map.warnings.some((w) => w.includes("text objects"))).toBe(true);
  });

  it("reads image layers", async () => {
    const sky = (await load("tiled/ortho.tmx")).layers.find((l) => l.kind === "image") as ImportImageLayer;
    expect(sky).toMatchObject({ name: "Sky", image: { path: "images/sky.png", width: 320, height: 180 }, repeatX: true, repeatY: false, parallax: [0.1, 0.1] });
  });
});

describe("tile data: collision, animation, Wang sets", () => {
  it("turns collision objects into box-unit polygons, with one-way from the property", async () => {
    const map = await load("tiled/ortho.tmx");
    const t0 = map.tilesets[0]!.tiles[0]!;
    expect(t0.data).toEqual({ friction: 0.5, solid: true, hint: "tiled/notes/solid.txt", class: "Solid" });
    expect(t0.shapes).toHaveLength(3);
    expect(t0.shapes[0]).toEqual({ polygon: [[0, 0.75], [1, 0.75], [1, 1], [0, 1]], oneWay: true });
    const ellipse = t0.shapes[1]!.polygon;
    expect(ellipse).toHaveLength(16);
    for (const [x, y] of ellipse) expect(Math.hypot(x - 0.25, y - 0.25)).toBeCloseTo(0.25);
    expect(t0.shapes[2]).toEqual({ polygon: [[0.5, 0], [1, 0], [1, 0.5]] });
    expect(map.warnings.some((w) => w.includes("collision points and polylines"))).toBe(true);
  });

  it("converts animations to seconds and probability to weight", async () => {
    const t1 = (await load("tiled/ortho.tmx")).tilesets[0]!.tiles[1]!;
    expect(t1.animation).toEqual([{ tileIndex: 1, durationSeconds: 0.1 }, { tileIndex: 2, durationSeconds: 0.25 }]);
    expect(t1.weight).toBe(0.25);
  });

  it("makes terrains and patterns from one-colour Wang tiles and warns on transitions in sets of three colours", async () => {
    const map = await load("tiled/ortho.tmx");
    const ts = map.tilesets[0]!;
    expect(ts.terrains).toEqual([{ name: "Grass", color: "#7cb342" }, { name: "Sand", color: "#ffeeaa" }]);
    // Corner set: corners as labelled, a side `1` where either corner beside it is the colour, else "either".
    expect([ts.tiles[4]!.terrain, ts.tiles[4]!.pattern]).toEqual(["Grass", "11111111"]);
    expect([ts.tiles[5]!.terrain, ts.tiles[5]!.pattern]).toEqual(["Grass", "111110*0"]);
    // Edge set: corners are "either".
    expect([ts.tiles[6]!.terrain, ts.tiles[6]!.pattern]).toEqual(["Sand", "1*1*0*0*"]);
    expect(ts.tiles[7]!.terrain).toBeUndefined();
    expect(map.warnings.some((w) => w.includes("tile 7") && w.includes("several Wang colours"))).toBe(true);
  });
});

describe("parseTiledMap: TMJ", () => {
  it("decodes base64 with zlib, gzip and no compression, and CSV arrays", async () => {
    const map = await load("tiled/encoded.tmj");
    const pick = (name: string) => tiles(map, name).cells.map((c) => [c.x, c.y, c.tileIndex, c.flipX, c.flipY, c.flipDiagonal]);
    expect(pick("Zlib")).toEqual([[0, 0, 0, false, false, false], [1, 0, 1, false, false, false], [0, 1, 2, false, false, false], [1, 1, 0, true, false, false]]);
    expect(pick("Gzip")).toEqual([[1, 0, 3, false, false, false], [2, 0, 1, false, true, false], [0, 1, 2, false, false, true], [2, 1, 0, false, false, false]]);
    expect(pick("Plain")).toEqual([[0, 0, 4, false, false, false], [2, 1, 5, false, false, false]]);
    expect(pick("Csv")).toEqual([[2, 0, 0, false, false, false]]);
  });

  it("reads TMJ class properties, TSJ tilesets, groups and objects", async () => {
    const map = await load("tiled/encoded.tmj");
    expect(map.properties).toEqual({
      spawn: { kind: "class", type: "SpawnInfo", fields: { count: 2, kind: "slime", nested: { kind: "class", type: "", fields: { on: true } } } },
      target: null,
    });
    expect(map.tilesets.map((t) => t.path)).toEqual(["tiled/terrain.tsx", "tiled/water.tsj"]);
    const objs = map.layers.find((l) => l.kind === "objects") as ImportObjectLayer;
    expect(objs.name).toBe("Group/Objs");
    expect(objs.offset).toEqual([3, 0]);
    expect(objs.objects[0]).toMatchObject({ shape: "tile", tile: { tilesetIndex: 1, tileIndex: 0 } });
    expect(objs.objects[1]).toMatchObject({ shape: "point", properties: { c: "#00ff00" } });
  });

  it("refuses zstd-compressed layers with a message saying what to do", async () => {
    const tmj = JSON.stringify({ type: "map", orientation: "orthogonal", width: 1, height: 1, tilewidth: 8, tileheight: 8, tilesets: [], layers: [{ id: 1, name: "Z", type: "tilelayer", width: 1, height: 1, encoding: "base64", compression: "zstd", data: "KLUv/SAEIQAAAQAAAA==" }] });
    await expect(parseTiledMap(tmj, "z.tmj", read())).rejects.toThrow(/zstd.*CSV or uncompressed Base64/);
  });

  it("throws when a referenced tileset can't be read", async () => {
    const tmj = JSON.stringify({ type: "map", orientation: "orthogonal", width: 1, height: 1, tilewidth: 8, tileheight: 8, tilesets: [{ firstgid: 1, source: "missing.tsj" }], layers: [] });
    await expect(parseTiledMap(tmj, "tiled/m.tmj", read())).rejects.toThrow(/couldn't read the tileset tiled\/missing\.tsj/);
  });

  it("warns about gids that name no tileset", async () => {
    const tmj = JSON.stringify({ type: "map", orientation: "orthogonal", width: 2, height: 1, tilewidth: 8, tileheight: 8, tilesets: [], layers: [{ id: 1, name: "L", type: "tilelayer", width: 2, height: 1, data: [1, 0] }] });
    const map = await parseTiledMap(tmj, "m.tmj", read());
    expect((map.layers[0] as ImportTileLayer).cells).toEqual([]);
    expect(map.warnings).toEqual(["m.tmj: 1 tile(s) name no tileset of the map; skipped."]);
  });
});

describe("parseTiledMap: infinite maps and other orientations", () => {
  it("reads chunks at their positions", async () => {
    const map = await load("tiled/infinite.tmx");
    expect(map.infinite).toBe(true);
    expect(tiles(map, "Endless").cells.map((c) => [c.x, c.y, c.tileIndex])).toEqual([[1, -2, 2], [0, -1, 3], [-2, 0, 0], [-1, 1, 1]]);
  });

  it("reads isometric maps (base64 in XML) and the tileset's preview grid", async () => {
    const map = await load("tiled/iso.tmx");
    expect(map.grid).toMatchObject({ shape: "isometric", tileWidth: 64, tileHeight: 32 });
    expect(map.tilesets[0]!.previewGrid).toBe("isometric");
    expect(tiles(map, "Floor").cells.map((c) => [c.x, c.y, c.tileIndex])).toEqual([[0, 0, 0], [1, 0, 1], [0, 1, 2], [1, 1, 3]]);
  });

  it("reads staggered maps", async () => {
    const map = await load("tiled/staggered.tmx");
    expect(map.grid).toEqual({ shape: "staggered", staggerAxis: "y", staggerIndex: "odd", hexSide: 0.5, tileWidth: 64, tileHeight: 32 });
    expect(tiles(map, "Floor").cells.map((c) => [c.x, c.y])).toEqual([[1, 0], [0, 1]]);
  });

  it("reads hexagonal maps, with the side length as a fraction, and drops hex rotation with a warning", async () => {
    const map = await load("tiled/hex.tmj");
    expect(map.grid).toEqual({ shape: "hexagonal", staggerAxis: "x", staggerIndex: "even", hexSide: 0.375, tileWidth: 32, tileHeight: 28 });
    expect(tiles(map, "Hexes").cells.map((c) => [c.x, c.y, c.tileIndex])).toEqual([[0, 0, 0], [1, 0, 1]]);
    expect(map.warnings.some((w) => w.includes("120°"))).toBe(true);
  });
});

describe("two-colour Wang sets (ADR 0444)", () => {
  /** A TSJ of 8 tiles whose Wang set `type` labels tile i with `wangids[i]` (colours 1 Grass, 2 Water). */
  const tsj = (type: string, wangids: number[][], colours = ["Grass", "Water"]) =>
    JSON.stringify({
      type: "tileset", name: "gw", tilewidth: 16, tileheight: 16, tilecount: 8, columns: 4, image: "gw.png", imagewidth: 64, imageheight: 32,
      wangsets: [{ name: "Ground", type, tile: -1, colors: colours.map((name, i) => ({ name, color: `#00000${i}`, probability: 1, tile: -1 })), wangtiles: wangids.map((wangid, tileid) => ({ tileid, wangid })) }],
    });
  const parse = async (text: string) => parseTiledTileset(text, "gw.tsj", read());
  const terrainsOf = (ts: Awaited<ReturnType<typeof parse>>["tileset"]) => ts.tiles.map((t) => (t.terrain ? `${t.terrain}:${t.pattern}` : "-"));

  it("makes a corner set's terrain of the colour with fewer full tiles; tiles of only the other colour get none", async () => {
    const { tileset, warnings } = await parse(
      tsj("corner", [
        [0, 1, 0, 1, 0, 1, 0, 1], // all grass
        [0, 1, 0, 1, 0, 1, 0, 1], // all grass, a variant
        [0, 2, 0, 2, 0, 2, 0, 2], // all water
        [0, 2, 0, 1, 0, 1, 0, 1], // water at the top-right corner
        [0, 2, 0, 2, 0, 1, 0, 1], // water on the right half
        [0, 1, 0, 2, 0, 1, 0, 2], // water at two opposite corners
        [0, 2, 0, 2, 0, 2, 0, 1], // grass at the top-left corner only
      ]),
    );
    expect(tileset.terrains).toEqual([{ name: "Water", color: "#000001" }]);
    expect(terrainsOf(tileset)).toEqual([
      "-",
      "-",
      "Water:11111111",
      // Corners as labelled; a side is `1` when either corner beside it is water, else "either".
      "Water:1110*0*0",
      "Water:111110*0",
      "Water:10111011",
      "Water:11111110",
      "-",
    ]);
    expect(warnings).toEqual([]);
  });

  it("picks the first colour on a tie, and names sides (edge sets) or sides and corners (mixed sets)", async () => {
    const edge = (await parse(tsj("edge", [[2, 0, 2, 0, 2, 0, 2, 0], [1, 0, 1, 0, 1, 0, 1, 0], [1, 0, 2, 0, 2, 0, 1, 0], [2, 0, 1, 0, 1, 0, 1, 0]]))).tileset;
    expect(edge.terrains.map((t) => t.name)).toEqual(["Grass"]);
    expect(terrainsOf(edge).slice(0, 4)).toEqual(["-", "Grass:1*1*1*1*", "Grass:1*0*0*1*", "Grass:0*1*1*1*"]);
    const mixed = (await parse(tsj("mixed", [[1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 1, 1, 1, 1, 1]]))).tileset;
    expect(mixed.terrains.map((t) => t.name)).toEqual(["Water"]);
    expect(terrainsOf(mixed).slice(0, 4)).toEqual(["-", "-", "Water:11111111", "Water:11100000"]);
  });

  it("still warns about transitions in sets of three or more colours", async () => {
    const { tileset, warnings } = await parse(tsj("corner", [[0, 1, 0, 1, 0, 1, 0, 1], [0, 2, 0, 1, 0, 1, 0, 1], [0, 3, 0, 3, 0, 3, 0, 3]], ["Grass", "Water", "Sand"]));
    expect(terrainsOf(tileset).slice(0, 3)).toEqual(["Grass:11111111", "-", "Sand:11111111"]);
    expect(warnings.some((w) => w.includes("tile 1") && w.includes("several Wang colours"))).toBe(true);
  });
});

describe("parseTiledTileset", () => {
  it("reads a TSJ: grid tiles, class data, collision, animation and an edge Wang set", async () => {
    const { format, tileset, warnings } = await parseTiledTileset((await read()("tiled/water.tsj"))!, "tiled/water.tsj", read());
    expect(format).toBe("tiledTileset");
    expect(tileset).toMatchObject({ name: "water", path: "tiled/water.tsj", tileWidth: 16, tileHeight: 16, columns: 2, tileCount: 4, image: { path: "images/water.png", width: 32, height: 32 } });
    expect(tileset.properties).toEqual({ liquid: true });
    const t0 = tileset.tiles[0]!;
    expect(t0.data).toEqual({ meta: { depth: 3 }, link: 7, class: "Water" });
    expect(t0.shapes).toEqual([{ polygon: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] }]);
    expect(t0.animation).toEqual([{ tileIndex: 0, durationSeconds: 0.15 }, { tileIndex: 1, durationSeconds: 0.15 }]);
    expect(tileset.tiles[3]!.rect).toEqual({ x: 16, y: 16, w: 16, h: 16 });
    expect([tileset.tiles[1]!.terrain, tileset.tiles[1]!.pattern]).toEqual(["Water", "1*1*0*0*"]);
    expect(tileset.tiles[2]!.pattern).toBe("1*1*1*1*");
    expect(tileset.terrains).toEqual([{ name: "Water", color: "#2255ff" }]);
    expect(warnings.some((w) => w.includes("polylines"))).toBe(true);
  });

  it("reads a TSX", async () => {
    const { tileset } = await parseTiledTileset((await read()("tiled/terrain.tsx"))!, "tiled/terrain.tsx", read());
    expect(tileset.name).toBe("terrain");
    expect(tileset.tiles).toHaveLength(12);
  });

  it("refuses files that aren't tilesets", async () => {
    await expect(parseTiledTileset("<map/>", "x.tsx", read())).rejects.toThrow(/not a Tiled tileset/);
    await expect(parseTiledTileset('{"type":"map"}', "x.tsj", read())).rejects.toThrow(/not a Tiled tileset/);
  });
});
