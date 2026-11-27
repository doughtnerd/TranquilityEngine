import { describe, expect, it } from "vitest";
import { tilesetFormat } from "./tilesetFormat";
import { patchTiles, shapesPatch } from "./tileShapeEditorLogic";

const file = {
  format: "myco.tileset@1",
  tileSize: [16, 16],
  previewGrid: "isometric",
  terrains: [],
  tiles: [
    { id: 1, uuid: "a", sprite: "asset:t.png#a", collision: { shapes: [{ polygon: [[0, 0], [1, 0], [1, 1]] }, { polygon: [[0, 0.5], [1, 0.5], [1, 1], [0, 1]], oneWay: true }] }, occluder: { shapes: [{ polygon: [[0, 0], [1, 0], [0, 1]] }] } },
    { id: 2, uuid: "b", sprite: "asset:t.png#b", collision: { polygon: [[0, 0], [1, 0], [1, 1]], oneWay: true }, occluder: "none", sortOffset: 1 },
    { id: 3, uuid: "c", sprite: "asset:t.png#c", collision: "full", occluder: "full", animation: { frames: [{ sprite: "asset:t.png#c", duration: 0.2 }, { sprite: "asset:t.png#d", duration: 0.2 }], start: "random" } },
  ],
  stamps: [{ name: "Hut", size: [2, 1], layers: [{ name: "Ground", palette: { "1": "a" }, cells: "1,1" }] }],
  prefabs: ["asset:prefabs/tree.prefab.json"],
};

/** Read a file's JSON the way the tileset's asset document does, and write it back. */
const roundTrip = (raw: unknown) => {
  const read = tilesetFormat.parse(raw, "t.tileset.json");
  expect(read.problems).toEqual([]);
  return { value: read.value, text: tilesetFormat.format(read.value) };
};

describe("tileset files keep ADR 0435–0440 fields when saved", () => {
  it("writes back previewGrid, several shapes, occluders, animation, sort offsets, stamps and prefabs", () => {
    const { text } = roundTrip(file);
    expect(JSON.parse(text)).toEqual(file);
  });

  it("writes an edited tile's shapes in the right form, and Same as collision as no occluder", () => {
    const { value } = roundTrip(file);
    const tiles = patchTiles(patchTiles(value.tiles, new Set([1]), shapesPatch("collision", [{ polygon: [[0, 0], [1, 0], [0, 1]] }])), new Set([2]), { occluder: undefined });
    const saved = JSON.parse(tilesetFormat.format({ ...value, tiles })) as typeof file;
    expect(saved.tiles[0]!.collision).toEqual({ polygon: [[0, 0], [1, 0], [0, 1]] });
    expect("occluder" in saved.tiles[1]!).toBe(false);
    expect(roundTrip(saved).value.tiles[1]!.occluder).toBeUndefined();
  });
});
