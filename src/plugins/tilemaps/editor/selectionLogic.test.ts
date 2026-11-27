import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap } from "../../../myco";
import type { Cell } from "../runtime/brushes";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, cellValue, newLayer } from "../runtime/format";
import { TURN_CLOCKWISE } from "../runtime/tileFlips";
import { blockTargets, cellKey, clearSelection, copySelection, layerLocked, moveSelection, selectionLayers, selectRect, transformSelection, usedCells } from "./selectionLogic";

const TILESET = { format: "myco.tileset@1", tileSize: [16, 16], tiles: [1, 2, 3, 4].map((id) => ({ id, uuid: `u${id}`, sprite: "" })) };

let engine: Engine;
beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "t.tileset.json": TILESET, "s.json": { format: "myco.scene@1", nodes: [] } }));
  engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});
afterEach(() => engine.dispose());

function newMap(gridShape: "square" | "isometric" | "hexagonal" = "square"): Tilemap {
  const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "t.tileset.json", gridShape });
  map.layers = [newLayer("Ground"), newLayer("Top")];
  return map;
}

const keys = (...cells: Cell[]) => new Set(cells.map(([x, y]) => cellKey(x, y)));
/** The map's cell values over a block, row by row from the top. */
const block = (map: Tilemap, x0: number, y0: number, w: number, h: number, layer = 0) =>
  Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => map.getCell(x0 + c, y0 + h - 1 - r, layer)));

describe("the tile selection (ADR 0440)", () => {
  it("adds and takes rectangles, and selects every used cell", () => {
    let sel = selectRect(new Set(), [0, 0], [2, 1], "replace");
    expect(sel.size).toBe(6);
    sel = selectRect(sel, [3, 0], [3, 0], "add");
    sel = selectRect(sel, [1, 0], [1, 1], "subtract");
    expect(sel).toEqual(keys([0, 0], [2, 0], [3, 0], [0, 1], [2, 1]));
    expect(selectRect(sel, [5, 5], [5, 5], "replace")).toEqual(keys([5, 5]));

    const map = newMap();
    map.setTile(0, 0, 1);
    map.setTile(4, 2, 2, "Top");
    expect(usedCells(map, [0])).toEqual(keys([0, 0]));
    expect(usedCells(map, [0, 1])).toEqual(keys([0, 0], [4, 2]));
  });

  for (const shape of ["square", "isometric"] as const) {
    it(`copies, clears, moves and flips cells in place on a ${shape} map`, () => {
      const map = newMap(shape);
      // 1 2 3      (row y = 1)
      // 4 . 1      (row y = 0)
      map.setTile(0, 1, 1);
      map.setTile(1, 1, 2);
      map.setTile(2, 1, 3, 0, FLIP_X);
      map.setTile(0, 0, 4);
      map.setTile(2, 0, 1);
      const sel = selectRect(new Set(), [0, 0], [2, 1], "replace");
      const copied = copySelection(map, sel, [0])!;
      expect(copied).toEqual({ width: 3, height: 2, layers: [{ name: "Ground", values: [4, 0, 1, 1, 2, cellValue(3, FLIP_X)] }] });

      // Flip X: the block mirrors and each tile's flip composes.
      const flipped = transformSelection(map, sel, [0], FLIP_X);
      expect(flipped).toEqual(sel);
      expect(block(map, 0, 0, 3, 2)).toEqual([
        [3, cellValue(2, FLIP_X), cellValue(1, FLIP_X)],
        [cellValue(1, FLIP_X), 0, cellValue(4, FLIP_X)],
      ]);
      transformSelection(map, sel, [0], FLIP_X); // and back
      // A quarter turn: 3 × 2 becomes 2 × 3 from the same bottom-left corner.
      const turned = transformSelection(map, sel, [0], TURN_CLOCKWISE);
      expect(turned).toEqual(selectRect(new Set(), [0, 0], [1, 2], "replace"));
      expect(map.getCell(2, 1)).toBe(0);
      expect(block(map, 0, 0, 2, 3).flat().filter((v) => v !== 0)).toHaveLength(5);
      expect(block(map, 0, 0, 2, 3)[0]).toEqual([cellValue(4, TURN_CLOCKWISE), cellValue(1, TURN_CLOCKWISE)]);

      // Move by (5, 0): the cells go, the selection follows; Alt-drag copies.
      const moved = moveSelection(map, turned, [0], 5, 0);
      expect(moved).toEqual(selectRect(new Set(), [5, 0], [6, 2], "replace"));
      expect(usedCells(map, [0]).size).toBe(5);
      expect([...usedCells(map, [0])].every((k) => Number(k.split(",")[0]) >= 5)).toBe(true);
      moveSelection(map, moved, [0], 0, 4, true);
      expect(usedCells(map, [0]).size).toBe(10);

      expect(clearSelection(map, moved, [0])).toBe(5);
      expect(usedCells(map, [0]).size).toBe(5);
    });
  }

  it("only flips tiles' images on hexagonal maps, and doesn't turn them", () => {
    const map = newMap("hexagonal");
    map.setTile(0, 0, 1);
    map.setTile(1, 0, 2);
    const sel = keys([0, 0], [1, 0]);
    transformSelection(map, sel, [0], FLIP_X, false);
    expect([map.getCell(0, 0), map.getCell(1, 0)]).toEqual([cellValue(1, FLIP_X), cellValue(2, FLIP_X)]);
    transformSelection(map, sel, [0], TURN_CLOCKWISE, false);
    expect([map.getCell(0, 0), map.getCell(1, 0)]).toEqual([cellValue(1, FLIP_X), cellValue(2, FLIP_X)]);
  });

  it("copies several layers by name and pastes them into the layers of the same names", () => {
    const map = newMap();
    map.setTile(0, 0, 1, "Ground");
    map.setTile(0, 0, 2, "Top", FLIP_Y);
    const copied = copySelection(map, keys([0, 0], [1, 0]), [0, 1])!;
    expect(copied.layers.map((l) => [l.name, l.values])).toEqual([
      ["Ground", [1, 0]],
      ["Top", [cellValue(2, FLIP_Y), 0]],
    ]);
    // Another map with the layers in another order, one missing.
    const other = newMap();
    other.layers = [newLayer("Top"), newLayer("Back")];
    expect(blockTargets(other, copied, 1)).toEqual([{ layer: 0, values: [cellValue(2, FLIP_Y), 0] }]);
    // A one-layer block goes to the active layer.
    expect(blockTargets(other, { ...copied, layers: [copied.layers[0]!] }, 1)).toEqual([{ layer: 1, values: [1, 0] }]);
  });

  it("leaves locked layers out", () => {
    const map = newMap();
    map.layers = [newLayer("Ground"), { ...newLayer("Top"), locked: true }, newLayer("Fx")];
    expect(layerLocked(map, 1)).toBe(true);
    expect(selectionLayers(map, 0, true)).toEqual([0, 2]);
    expect(selectionLayers(map, 1, false)).toEqual([]);
    expect(selectionLayers(map, 2, false)).toEqual([2]);
    const copied = { width: 1, height: 1, layers: ["Ground", "Top", "Fx"].map((name) => ({ name, values: [1] })) };
    expect(blockTargets(map, copied, 0).map((t) => t.layer)).toEqual([0, 2]);
    expect(blockTargets(map, { ...copied, layers: [copied.layers[0]!] }, 1)).toEqual([]);
  });

  it("composes turns with the tiles' own flags", () => {
    const map = newMap();
    map.setTile(0, 0, 1, 0, FLIP_DIAGONAL);
    transformSelection(map, keys([0, 0]), [0], FLIP_Y);
    expect(map.getCell(0, 0)).toBe(cellValue(1, FLIP_DIAGONAL | FLIP_Y));
  });
});
