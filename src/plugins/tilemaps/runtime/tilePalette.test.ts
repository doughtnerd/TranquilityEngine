// Stable tile uuids and per-layer palettes (ADR 0392, amending 0103): tiles keep a uuid that's never reused, layers'
// cells are their own small numbers that a palette names by uuid, and files from before both load as they did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap } from "../../../myco";
import { FLIP_X, TILEMAP_LAYER_VERSION, cellValue, migrateLayer, newLayer, type TilemapLayerData } from "./format";
import { Tileset, legacyTileUuid, parseTileset } from "./tileset";

/** A tileset file from before ADR 0392: tiles without uuids. */
const OLD_TILESET = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  tiles: [
    { id: 1, sprite: "asset:t.png#a", collision: "full" },
    { id: 2, sprite: "asset:t.png#b" },
    { id: 3, sprite: "asset:t.png#c" },
  ],
};
/** A layer from before ADR 0392 (version 1): cell values are tileset ids. */
const OLD_LAYER = { name: "G", chunks: { "0,0": `1,2,${cellValue(3, FLIP_X)},0*253` } };

const engines: Engine[] = [];
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
  vi.restoreAllMocks();
});

/** Point the project's tileset at `tileset` (the editor saving it), keeping the scene. */
function useTileset(tileset: unknown): void {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tiles.tileset.json": tileset, "s.json": { format: "myco.scene@1", nodes: [] } }));
}

async function mapWith(tileset: unknown, layers: unknown[]): Promise<Tilemap> {
  useTileset(tileset);
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return GameObject.create("map").addBehavior(Tilemap, { tileset: "tiles.tileset.json", layers: layers as TilemapLayerData[] });
}

const row = (map: Tilemap, layer: number | string = 0) => [0, 1, 2, 3].map((x) => map.getCell(x, 0, layer));

describe("tileset uuids (ADR 0392)", () => {
  it("gives a tile without a uuid the same one on every load, keeps written ones, and refuses duplicates", () => {
    const a = parseTileset(OLD_TILESET).tileset;
    const b = parseTileset(OLD_TILESET).tileset;
    expect(a.tiles.map((t) => t.uuid)).toEqual([legacyTileUuid(1), legacyTileUuid(2), legacyTileUuid(3)]);
    expect(b.tiles.map((t) => t.uuid)).toEqual(a.tiles.map((t) => t.uuid));
    // Saved (written as the file holds it) and read again: the same uuids, now in the file.
    const saved = JSON.parse(JSON.stringify(a));
    expect(saved.tiles[0].uuid).toBe(legacyTileUuid(1));
    expect(parseTileset(saved).tileset).toEqual(a);
    const dup = parseTileset({ ...OLD_TILESET, tiles: [{ id: 1, uuid: "u", sprite: "" }, { id: 2, uuid: "u", sprite: "" }] });
    expect(dup.tileset.tiles.map((t) => t.uuid)).toEqual(["u", legacyTileUuid(2)]);
    expect(dup.problems.join()).toMatch(/tile 2's uuid is another tile's/);
    expect(new Tileset(a).tileByUuid(legacyTileUuid(2))?.id).toBe(2);
  });
});

describe("layer palettes (ADR 0392)", () => {
  it("migrates a version 1 layer: each tileset id becomes its own number, named by the old tile's uuid", () => {
    const layer = migrateLayer(OLD_LAYER);
    expect(layer.v).toBe(TILEMAP_LAYER_VERSION);
    expect(layer.palette).toEqual({ 1: legacyTileUuid(1), 2: legacyTileUuid(2), 3: legacyTileUuid(3) });
    expect(layer.chunks).toEqual(OLD_LAYER.chunks);
  });

  it("loads old files as they drew, and saves them with a palette that loads back the same", async () => {
    const map = await mapWith(OLD_TILESET, [OLD_LAYER]);
    expect(row(map)).toEqual([1, 2, cellValue(3, FLIP_X), 0]);
    const saved = map.toLayerData();
    expect(saved[0]).toMatchObject({ v: TILEMAP_LAYER_VERSION, palette: { 1: legacyTileUuid(1), 2: legacyTileUuid(2), 3: legacyTileUuid(3) }, chunks: OLD_LAYER.chunks });
    // The tileset saved too (now with its uuids), and both loaded again.
    const again = await mapWith(JSON.parse(JSON.stringify(parseTileset(OLD_TILESET).tileset)), JSON.parse(JSON.stringify(saved)));
    expect(row(again)).toEqual(row(map));
    expect(again.toLayerData()).toEqual(saved);
  });

  it("never paints a new tile where a deleted one was, even when the new tile gets the deleted tile's id", async () => {
    const tileset = { ...OLD_TILESET, tiles: OLD_TILESET.tiles.map((t) => ({ ...t, uuid: `uuid-${t.id}` })) };
    const map = await mapWith(tileset, [newLayer("G")]);
    map.setTile(0, 0, 3);
    map.setTile(1, 0, 2);
    // Tile 3 deleted, and a new tile added: the editor gives it id 3 again, but a new uuid.
    useTileset({ ...tileset, tiles: [...tileset.tiles.slice(0, 2), { id: 3, uuid: "uuid-new", sprite: "asset:t.png#z" }] });
    expect(row(map)).toEqual([0, 2, 0, 0]);
    expect([...map.tiles()].map((c) => c.id)).toEqual([2]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("uuid-3"));
    // The cell still names the deleted tile, so saving loses nothing and restoring the tile brings it back.
    const saved = map.toLayerData()[0];
    expect(Object.values(saved.palette).sort()).toEqual(["uuid-2", "uuid-3"]);
    useTileset(tileset);
    expect(row(map)).toEqual([3, 2, 0, 0]);
    // A version 1 layer whose tileset was edited the same way before it was ever saved also stays empty there.
    const old = await mapWith({ ...OLD_TILESET, tiles: [...OLD_TILESET.tiles.slice(0, 2), { id: 3, uuid: "uuid-new", sprite: "" }] }, [OLD_LAYER]);
    expect(row(old)).toEqual([1, 2, 0, 0]);
  });

  it("adds a palette entry for a tile a layer doesn't have yet, and prunes unused entries on save", async () => {
    const map = await mapWith(OLD_TILESET, [OLD_LAYER, newLayer("Top")]);
    map.setTile(0, 0, 2, "Top");
    expect(map.toLayerData()[1].palette).toEqual({ 1: legacyTileUuid(2) });
    expect(map.toLayerData()[1].chunks["0,0"]).toMatch(/^1,0\*255$/);
    map.clearAll("G");
    map.setTile(5, 0, 3, "G");
    expect(map.toLayerData()[0].palette).toEqual({ 3: legacyTileUuid(3) });
    expect(() => map.setTile(0, 0, 99)).toThrow(/no tile 99/);
  });
});
