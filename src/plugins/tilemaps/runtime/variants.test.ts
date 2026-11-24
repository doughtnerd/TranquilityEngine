import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap } from "../../../myco";
import { rectCells } from "./brushes";
import { cellRandom, newSeed } from "./cellHash";

// A row terrain (ADR 0103) whose middle piece has three variants weighted 1, 1 and 2, a "plain" terrain of two
// variants weighted 1 and 3 that fit every neighbourhood alike, and plain tiles for `fillRect`.
const TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  terrains: [{ name: "Row" }, { name: "Plain" }],
  tiles: [
    { id: 10, sprite: "", terrain: "Row", pattern: "0*0*0*0*" },
    { id: 11, sprite: "", terrain: "Row", pattern: "0*1*0*0*" },
    { id: 12, sprite: "", terrain: "Row", pattern: "0*1*0*1*" },
    { id: 13, sprite: "", terrain: "Row", pattern: "0*0*0*1*" },
    { id: 14, sprite: "", terrain: "Row", pattern: "0*1*0*1*" },
    { id: 15, sprite: "", terrain: "Row", pattern: "0*1*0*1*", weight: 2 },
    { id: 20, sprite: "", terrain: "Plain", weight: 1 },
    { id: 21, sprite: "", terrain: "Plain", weight: 3 },
    { id: 1, sprite: "" },
    { id: 2, sprite: "" },
    { id: 3, sprite: "", weight: 3 },
  ],
};
const MIDDLE = [12, 14, 15];

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function newMap(seed?: number): Promise<Tilemap> {
  if (!engines.length) {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILESET, "s.json": { format: "myco.scene@1", nodes: [] } }));
    engines.push(await Engine.create({ headless: true }));
    await SceneManager.load("s.json");
  }
  return GameObject.create("Map").addBehavior(Tilemap, { tileset: "tiles.tileset.json", ...(seed === undefined ? {} : { variantSeed: seed }) });
}
const row = (map: Tilemap, x0: number, x1: number, y = 0) => Array.from({ length: x1 - x0 + 1 }, (_, i) => map.getTile(x0 + i, y));

describe("deterministic tile variants (ADR 0400)", () => {
  it("leaves a neighbour's variant alone when painting doesn't change the shape it needs", async () => {
    const map = await newMap(7);
    map.paintTerrain(rectCells(0, 0, 30, 0), "Row");
    const before = row(map, 0, 30);
    expect(before.slice(1, 30).every((id) => MIDDLE.includes(id))).toBe(true);
    expect(new Set(before.slice(1, 30)).size).toBeGreaterThan(1); // the variants are used
    // Painting each cell of the row again re-picks it and its neighbours, but none of them needs another shape.
    for (let x = 0; x <= 30; x++) map.paintTerrain([[x, 0]], "Row");
    expect(row(map, 0, 30)).toEqual(before);
    // Lengthening the row turns the old end into a middle piece; the other cells keep their tiles.
    map.paintTerrain([[31, 0]], "Row");
    const after = row(map, 0, 31);
    expect(after.slice(0, 30)).toEqual(before.slice(0, 30));
    expect(MIDDLE).toContain(after[30]);
    expect(after[31]).toBe(13);
  });

  it("paints the same map from the same strokes and seed, and another with another seed", async () => {
    const strokes: [number, number][][] = [rectCells(0, 0, 40, 0), [[10, 0]], rectCells(5, 2, 45, 2), [[20, 2]]];
    const paint = (map: Tilemap) => {
      for (const s of strokes) map.paintTerrain(s, "Row");
      return [row(map, 0, 45, 0), row(map, 0, 45, 2)];
    };
    const a = paint(await newMap(42)), b = paint(await newMap(42)), c = paint(await newMap(43));
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it("honours the variants' weights over many cells", async () => {
    const map = await newMap(1);
    map.paintTerrain(rectCells(0, 0, 99, 99), "Plain");
    let heavy = 0;
    for (const { id } of map.tiles()) if (id === 21) heavy++;
    expect(heavy / 10_000).toBeGreaterThan(0.73); // weight 3 of 4: 0.75
    expect(heavy / 10_000).toBeLessThan(0.77);
    map.paintTerrain(rectCells(0, 200, 4000, 200), "Row");
    let middleHeavy = 0;
    for (let x = 1; x < 4000; x++) if (map.getTile(x, 200) === 15) middleHeavy++;
    expect(middleHeavy / 3999).toBeGreaterThan(0.47); // weight 2 of 4
    expect(middleHeavy / 3999).toBeLessThan(0.53);
  });

  it("re-rolls the variants with a new seed, keeping every cell's shape", async () => {
    const map = await newMap(5);
    map.paintTerrain(rectCells(0, 0, 30, 0), "Row");
    map.setTile(0, 3, 1); // not a terrain tile: re-tiling leaves it be
    const before = row(map, 0, 30);
    map.variantSeed = newSeed(map.variantSeed);
    const changed = map.retileTerrain();
    const after = row(map, 0, 30);
    expect(after).not.toEqual(before);
    expect(changed.length).toBeGreaterThan(0);
    expect([after[0], after[30]]).toEqual([11, 13]);
    expect(after.slice(1, 30).every((id) => MIDDLE.includes(id))).toBe(true);
    expect(map.getTile(0, 3)).toBe(1);
    // Painting the same row on a fresh map with the new seed gives what the re-roll gave.
    const fresh = await newMap(map.variantSeed);
    fresh.paintTerrain(rectCells(0, 0, 30, 0), "Row");
    expect(row(fresh, 0, 30)).toEqual(after);
  });

  it("fills a rectangle from several tiles by the seed and the tiles' weights", async () => {
    const a = await newMap(9), b = await newMap(9);
    a.fillRect(0, 0, 100, 100, [2, 3]);
    b.fillRect(0, 0, 100, 100, [2, 3]);
    expect([...b.tiles()]).toEqual([...a.tiles()]);
    let heavy = 0;
    for (const { id } of a.tiles()) if (id === 3) heavy++;
    expect(heavy / 10_000).toBeGreaterThan(0.73);
    expect(heavy / 10_000).toBeLessThan(0.77);
  });
});

describe("cell randomness (ADR 0400)", () => {
  it("is the same for the same cell and seed and spreads evenly", () => {
    expect(cellRandom(3, -5, 8)).toBe(cellRandom(3, -5, 8));
    expect(cellRandom(3, -5, 8)).not.toBe(cellRandom(4, -5, 8));
    expect(cellRandom(3, -5, 8, 0)).not.toBe(cellRandom(3, -5, 8, 1));
    const buckets = new Array(10).fill(0);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) buckets[Math.floor(cellRandom(0, x, y) * 10)]++;
    for (const n of buckets) expect(Math.abs(n - 1000)).toBeLessThan(100);
  });

  it("makes a new seed that differs from the current one", () => {
    expect(newSeed(5, () => 0.5)).not.toBe(5);
    expect(newSeed(0x4000_0000, () => 0.5)).not.toBe(0x4000_0000);
  });
});
