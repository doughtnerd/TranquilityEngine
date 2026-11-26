import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ImportEntityLayer, ImportIntGridLayer, ImportLdtkProject, ImportTileLayer } from "./model";
import { parseLdtkProject } from "./ldtk";

const ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = async (path: string): Promise<string | null> => {
  try {
    return await readFile(ROOT + path, "utf8");
  } catch {
    return null;
  }
};
const load = async (): Promise<ImportLdtkProject> => parseLdtkProject((await read("ldtk/project.ldtk"))!, "ldtk/project.ldtk", read);
const level0 = async () => (await load()).worlds[0]!.levels[0]!;

describe("parseLdtkProject", () => {
  it("reads both worlds with their layouts and levels' world positions", async () => {
    const p = await load();
    expect([p.format, p.name, p.jsonVersion]).toEqual(["ldtk", "project", "1.5.3"]);
    expect(p.worlds.map((w) => [w.identifier, w.iid, w.layout, w.gridWidth, w.gridHeight, w.levels.map((l) => l.identifier)])).toEqual([
      ["Overworld", "w1", "Free", 256, 256, ["Level_0"]],
      ["Underworld", "w2", "GridVania", 64, 48, ["Level_1"]],
    ]);
    const l1 = p.worlds[1]!.levels[0]!;
    expect([l1.iid, l1.uid, l1.worldX, l1.worldY, l1.worldDepth, l1.pxWidth, l1.pxHeight]).toEqual(["lv1", 1, 64, -48, 1, 32, 32]);
    expect(l1.grid).toEqual({ shape: "square", staggerAxis: "y", staggerIndex: "odd", hexSide: 0.5, tileWidth: 16, tileHeight: 16 });
    expect(p.warnings.some((w) => w.includes("Level_1") && w.includes("background"))).toBe(true);
  });

  it("reads tilesets with grid parameters, custom data and enum tags", async () => {
    const [cavern, icons] = (await load()).tilesets;
    expect(cavern).toMatchObject({ name: "Cavern", path: null, tileWidth: 8, tileHeight: 8, margin: 1, spacing: 2, columns: 3, tileCount: 6, image: { path: "images/cavern.png", width: 30, height: 20 } });
    expect(cavern!.tiles[4]!.rect).toEqual({ x: 11, y: 11, w: 8, h: 8 });
    expect(cavern!.tiles[0]!.data).toEqual({ tags: ["Spiky"] });
    expect(cavern!.tiles[1]!.data).toEqual({ customData: { hp: 3 } });
    expect(cavern!.tiles[2]!.data).toEqual({ customData: "crumbly", tags: ["Spiky", "Hot"] });
    expect(cavern!.tiles[3]!.data).toBeUndefined();
    expect(icons!.image).toBeNull();
    expect(icons!.tiles).toEqual([]);
    expect((await load()).warnings.some((w) => w.includes('"Icons"'))).toBe(true);
  });

  it("loads external levels and lists layers bottom first, splitting stacked tiles into extra layers", async () => {
    const lv = await level0();
    expect(lv.backgroundColor).toBe("#40465b");
    expect(lv.fields).toEqual({ title: "Start" });
    expect(lv.layers.map((l) => [l.kind, l.name, l.id])).toEqual([
      ["tiles", "Deco", "li-deco"],
      ["tiles", "Walls", "li-walls"],
      ["tiles", "Walls#2", "li-walls#2"],
      ["tiles", "Walls#3", "li-walls#3"],
      ["intGrid", "Collisions", "li-col"],
      ["tiles", "Collisions", "li-col"],
      ["entities", "Entities", "li-ent"],
    ]);
  });

  it("reads auto-layer tiles with flips, offsets and opacity, snapping off-grid tiles with a warning", async () => {
    const p = await load();
    const layers = p.worlds[0]!.levels[0]!.layers as ImportTileLayer[];
    const cells = (name: string) => layers.find((l) => l.name === name)!.cells.map((c) => [c.x, c.y, c.tilesetIndex, c.tileIndex, c.flipX, c.flipY, c.flipDiagonal]);
    expect(cells("Walls")).toEqual([[0, 0, 0, 0, false, false, false], [1, 0, 0, 2, false, true, false], [1, 1, 0, 4, false, false, false]]);
    expect(cells("Walls#2")).toEqual([[0, 0, 0, 1, true, false, false]]);
    expect(cells("Walls#3")).toEqual([[0, 0, 0, 3, true, true, false]]);
    const walls = layers.find((l) => l.name === "Walls")!;
    expect([walls.cellWidth, walls.width, walls.height, walls.opacity, walls.visible]).toEqual([16, 2, 2, 0.8, true]);
    expect(walls.offset).toEqual([4, -2]);
    expect(layers.find((l) => l.name === "Walls#3")!.offset).toEqual([4, -2]);
    expect(p.warnings.some((w) => w.includes('"Walls"') && w.includes("1 tile(s) off the layer's grid"))).toBe(true);
  });

  it("reads Tiles layers on their own grid size", async () => {
    const deco = (await level0()).layers.find((l) => l.name === "Deco") as ImportTileLayer;
    expect([deco.cellWidth, deco.width, deco.height, deco.visible]).toEqual([8, 4, 4, false]);
    expect(deco.cells.map((c) => [c.x, c.y, c.tileIndex])).toEqual([[1, 1, 5]]);
  });

  it("reads IntGrid values with their identifiers, and the layer's auto tiles", async () => {
    const lv = await level0();
    const grid = lv.layers.find((l) => l.kind === "intGrid") as ImportIntGridLayer;
    expect(grid.values).toEqual([{ value: 1, identifier: "wall", color: "#ffffff" }, { value: 2, identifier: null, color: "#ff0000" }]);
    expect(grid.cells).toEqual([{ x: 0, y: 0, value: 1 }, { x: 0, y: 1, value: 2 }, { x: 1, y: 1, value: 1 }]);
    expect([grid.cellWidth, grid.width, grid.height]).toEqual([16, 2, 2]);
    const auto = lv.layers.find((l) => l.kind === "tiles" && l.name === "Collisions") as ImportTileLayer;
    expect(auto.cells.map((c) => [c.x, c.y, c.tileIndex])).toEqual([[0, 0, 4]]);
  });

  it("reads entities with typed fields, references and tiles", async () => {
    const layer = (await level0()).layers.find((l) => l.kind === "entities") as ImportEntityLayer;
    expect(layer.cellWidth).toBe(16);
    const [player, door] = layer.entities;
    expect(player).toEqual({
      identifier: "Player",
      iid: "ent-player",
      x: 8,
      y: 32,
      width: 16,
      height: 16,
      pivot: [0.5, 1],
      worldX: 8,
      worldY: 32,
      tags: ["hero"],
      fields: {
        hp: 5,
        speed: 1.5,
        alive: true,
        tint: "#ff8800",
        path: [{ kind: "point", cx: 1, cy: 0 }, { kind: "point", cx: 0, cy: 0 }],
        target: { kind: "entity", entityIid: "ent-door", layerIid: "li-ent", levelIid: "lv0", worldIid: "w1" },
        kind: "Hero",
        note: null,
        icon: { kind: "tile", tilesetIndex: 0, x: 11, y: 1, w: 8, h: 8 },
        config: { kind: "file", path: "ldtk/data/player.json" },
      },
      refs: [{ field: "target", ref: { kind: "entity", entityIid: "ent-door", layerIid: "li-ent", levelIid: "lv0", worldIid: "w1" } }],
      tile: { kind: "tile", tilesetIndex: 0, x: 1, y: 1, w: 8, h: 8 },
    });
    expect(door!.tile).toBeUndefined();
    expect(door!.refs).toEqual([{ field: "links", ref: { kind: "entity", entityIid: "ent-player", layerIid: "li-ent", levelIid: "lv0", worldIid: "w1" } }]);
  });

  it("keeps references across worlds", async () => {
    const sign = ((await load()).worlds[1]!.levels[0]!.layers[0] as ImportEntityLayer).entities[0]!;
    expect(sign.refs.map((r) => [r.ref.entityIid, r.ref.worldIid])).toEqual([["ent-door", "w1"]]);
  });

  it("reads a single-world project with inline levels and a linear layout", async () => {
    const text = JSON.stringify({
      jsonVersion: "1.0.0", iid: "p", defaultGridSize: 8, worldLayout: "LinearHorizontal", worldGridWidth: 0, worldGridHeight: 0,
      defs: { layers: [], tilesets: [] }, worlds: [],
      levels: [{ identifier: "A", iid: "a", uid: 0, worldX: -1, worldY: -1, pxWid: 8, pxHei: 8, layerInstances: [], fieldInstances: [] }],
    });
    const p = await parseLdtkProject(text, "one.ldtk", read);
    expect(p.worlds.map((w) => [w.identifier, w.iid, w.layout, w.levels.map((l) => l.identifier)])).toEqual([["World", "p", "LinearHorizontal", ["A"]]]);
    expect(p.worlds[0]!.levels[0]!.grid.tileWidth).toBe(8);
  });

  it("refuses projects older than LDtk 1.0, non-LDtk files and missing level files", async () => {
    await expect(parseLdtkProject(JSON.stringify({ jsonVersion: "0.9.3", defs: {} }), "old.ldtk", read)).rejects.toThrow(/LDtk 1\.0 or later/);
    await expect(parseLdtkProject('{"type":"map"}', "x.ldtk", read)).rejects.toThrow(/not an LDtk project/);
    const missing = JSON.stringify({ jsonVersion: "1.5.3", defs: {}, levels: [{ identifier: "Gone", externalRelPath: "gone.ldtkl", layerInstances: null }] });
    await expect(parseLdtkProject(missing, "ldtk/m.ldtk", read)).rejects.toThrow(/couldn't read level "Gone" from ldtk\/gone\.ldtkl/);
  });
});
