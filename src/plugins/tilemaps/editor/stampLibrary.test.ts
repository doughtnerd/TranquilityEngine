import { describe, expect, it } from "vitest";
import { FLIP_X, FLIP_Y, cellValue } from "../runtime/format";
import { Tileset, parseTileset } from "../runtime/tileset";
import { blockOfStamp, decodeStamp, encodeStamp, removePrefab, removeStamp, renameStamp, retargetBlock, stampOfBlock, uniqueStampName, withPrefab, withStamp, type StampBlock } from "./stampLibrary";
import { tilesetFormat } from "./tilesetFormat";

const tilesetOf = (tiles: { id: number; uuid: string }[]) => new Tileset(parseTileset({ format: "myco.tileset@1", tiles: tiles.map((t) => ({ ...t, sprite: "" })) }).tileset);

const A = tilesetOf([
  { id: 1, uuid: "u-grass" },
  { id: 2, uuid: "u-wall" },
  { id: 3, uuid: "u-door" },
]);

/** A 4 × 2 house of two layers. */
const HOUSE: StampBlock = {
  width: 4,
  height: 2,
  layers: [
    { name: "Walls", values: [2, 2, 2, cellValue(2, FLIP_X), 2, 0, 0, 2] },
    { name: "Deco", values: [0, cellValue(3, FLIP_Y), 0, 0, 0, 0, 0, 0] },
  ],
};

describe("saved stamps (ADR 0440)", () => {
  it("encode in the layer encoding, palette numbers naming uuids, and decode back", () => {
    const stamp = encodeStamp("House", HOUSE, A);
    expect(stamp.size).toEqual([4, 2]);
    expect(stamp.layers[0]).toEqual({ name: "Walls", palette: { 1: "u-wall" }, cells: `1*3,${cellValue(1, FLIP_X)},1,0*2,1` });
    expect(stamp.layers[1]).toEqual({ name: "Deco", palette: { 1: "u-door" }, cells: `0,${cellValue(1, FLIP_Y)},0*6` });
    expect(decodeStamp(stamp, A)).toEqual({ block: HOUSE, missing: 0 });
  });

  it("round-trip through the tileset file, and read tiles by uuid when ids changed", () => {
    const data = withStamp(parseTileset({ format: "myco.tileset@1", tiles: [] }).tileset, encodeStamp("House", HOUSE, A));
    const text = tilesetFormat.format(data);
    const read = tilesetFormat.parse(JSON.parse(text), "t.tileset.json");
    expect(read.problems).toEqual([]);
    expect(read.value.stamps).toEqual(data.stamps);
    // The same tiles under other ids paint the same stamp.
    const renumbered = tilesetOf([
      { id: 7, uuid: "u-door" },
      { id: 8, uuid: "u-wall" },
    ]);
    const { block } = decodeStamp(read.value.stamps![0]!, renumbered);
    expect(block.layers[0]!.values).toEqual([8, 8, 8, cellValue(8, FLIP_X), 8, 0, 0, 8]);
    expect(block.layers[1]!.values[1]).toBe(cellValue(7, FLIP_Y));
  });

  it("read a deleted tile's cells as empty and count them", () => {
    const stamp = encodeStamp("House", HOUSE, A);
    const withoutDoor = tilesetOf([
      { id: 1, uuid: "u-grass" },
      { id: 2, uuid: "u-wall" },
    ]);
    const { block, missing } = decodeStamp(stamp, withoutDoor);
    expect(missing).toBe(1);
    expect(block.layers[1]!.values.every((v) => v === 0)).toBe(true);
    expect(block.layers[0]!.values).toEqual(HOUSE.layers[0]!.values);
  });

  it("are added, replaced, renamed and deleted by name", () => {
    let data = parseTileset({ format: "myco.tileset@1" }).tileset;
    expect(uniqueStampName(data, "Stamp")).toBe("Stamp");
    data = withStamp(data, encodeStamp("Stamp", HOUSE, A));
    expect(uniqueStampName(data, "Stamp")).toBe("Stamp 2");
    data = withStamp(data, encodeStamp("Tree", blockOfStamp({ width: 1, height: 1, values: [1] }), A));
    data = withStamp(data, encodeStamp("Stamp", blockOfStamp({ width: 1, height: 1, values: [3] }), A));
    expect(data.stamps!.map((s) => [s.name, s.size])).toEqual([
      ["Stamp", [1, 1]],
      ["Tree", [1, 1]],
    ]);
    expect(renameStamp(data, "Tree", "Stamp")).toBe(data); // taken
    data = renameStamp(data, "Tree", "Oak");
    expect(data.stamps!.map((s) => s.name)).toEqual(["Stamp", "Oak"]);
    data = removeStamp(removeStamp(data, "Stamp"), "Oak");
    expect("stamps" in data).toBe(false);
  });

  it("keep the frame of a block copied on a staggered or hexagonal map through the tileset file (ADR 0442)", () => {
    const framed: StampBlock = { ...HOUSE, frame: { axis: "x", shifted: true } };
    const stamp = encodeStamp("House", framed, A);
    expect(stamp.stagger).toEqual({ axis: "x", shifted: true });
    const data = withStamp(parseTileset({ format: "myco.tileset@1", tiles: [] }).tileset, stamp);
    const read = tilesetFormat.parse(JSON.parse(tilesetFormat.format(data)), "t.tileset.json");
    expect(read.problems).toEqual([]);
    expect(read.value.stamps).toEqual(data.stamps);
    expect(decodeStamp(read.value.stamps![0]!, A)).toEqual({ block: framed, missing: 0 });
    // Renamed and moved to another tileset, the frame goes along.
    expect(renameStamp(data, "House", "Hut").stamps![0]!.stagger).toEqual({ axis: "x", shifted: true });
    expect(retargetBlock(framed, A, A).block.frame).toEqual({ axis: "x", shifted: true });
    expect(blockOfStamp({ width: 1, height: 1, values: [1] }, "", { axis: "y", shifted: false }).frame).toEqual({ axis: "y", shifted: false });
  });

  it("read a stamp saved without a frame (before ADR 0442, or from a square map) as a block laid out cell for cell", () => {
    const old = { name: "House", size: [4, 2], layers: encodeStamp("House", HOUSE, A).layers };
    const read = parseTileset({ format: "myco.tileset@1", tiles: [], stamps: [old, { ...old, name: "Bad", stagger: { axis: "z", shifted: 1 } }] });
    expect(read.problems).toEqual([]);
    expect(read.tileset.stamps!.map((s) => "stagger" in s)).toEqual([false, false]);
    const { block } = decodeStamp(read.tileset.stamps![0]!, A);
    expect(block).toEqual(HOUSE);
    expect("frame" in block).toBe(false);
    expect("stagger" in encodeStamp("House", HOUSE, A)).toBe(false);
  });

  it("list prefabs once", () => {
    let data = parseTileset({ format: "myco.tileset@1" }).tileset;
    data = withPrefab(withPrefab(data, "asset:props/chest.prefab.json"), "asset:props/chest.prefab.json");
    expect(data.prefabs).toEqual(["asset:props/chest.prefab.json"]);
    expect("prefabs" in removePrefab(data, "asset:props/chest.prefab.json")).toBe(false);
  });
});

describe("stamp blocks between tilesets (ADR 0440)", () => {
  it("match tiles by uuid and skip the ones the other tileset lacks", () => {
    const B = tilesetOf([
      { id: 5, uuid: "u-wall" },
      { id: 6, uuid: "u-grass" },
    ]);
    const { block, missing } = retargetBlock(HOUSE, A, B);
    expect(missing).toBe(1);
    expect(block.layers[0]!.values).toEqual([5, 5, 5, cellValue(5, FLIP_X), 5, 0, 0, 5]);
    expect(block.layers[1]!.values.every((v) => v === 0)).toBe(true);
  });

  it("give a one-layer stamp from a named layer, else the first with a tile", () => {
    expect(stampOfBlock(HOUSE, "Deco").values[1]).toBe(cellValue(3, FLIP_Y));
    expect(stampOfBlock(HOUSE).values).toEqual(HOUSE.layers[0]!.values);
    expect(stampOfBlock({ ...HOUSE, layers: [{ name: "E", values: new Array(8).fill(0) }, HOUSE.layers[1]!] }).values[1]).toBe(cellValue(3, FLIP_Y));
  });
});
