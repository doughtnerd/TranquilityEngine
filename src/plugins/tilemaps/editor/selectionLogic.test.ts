import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Tilemap } from "../../../myco";
import type { Cell } from "../runtime/brushes";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y, cellValue, newLayer } from "../runtime/format";
import { TURN_CLOCKWISE } from "../runtime/tileFlips";
import { blockTargets, cellKey, clearSelection, copySelection, layerLocked, movedSelection, moveSelection, selectionLayers, selectRect, transformSelection, usedCells } from "./selectionLogic";

const TILESET = { format: "myco.tileset@1", tileSize: [16, 16], tiles: [1, 2, 3, 4].map((id) => ({ id, uuid: `u${id}`, sprite: "" })) };

let engine: Engine;
beforeEach(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "t.tileset.json": TILESET, "s.json": { format: "myco.scene@1", nodes: [] } }));
  engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
});
afterEach(() => engine.dispose());

function newMap(gridShape: "square" | "isometric" | "staggered" | "hexagonal" = "square", staggerAxis: "x" | "y" = "y", staggerIndex: "odd" | "even" = "odd"): Tilemap {
  const map = GameObject.create("map").addBehavior(Tilemap, { tileset: "t.tileset.json", gridShape, staggerAxis, staggerIndex });
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

  /** The map's tiles as `id@dx,dy`: each tile's centre (Tilemap.cellToLocal) relative to tile 1's: equal for the same shape wherever it is. */
  const shapeOf = (map: Tilemap): string[] => {
    const cells = [...map.tiles(0)];
    const one = cells.find((t) => t.id === 1)!;
    const o = map.cellToLocal(one.x, one.y);
    return cells
      .map((t) => {
        const p = map.cellToLocal(t.x, t.y);
        return `${t.id}@${(p.x - o.x).toFixed(4)},${(p.y - o.y).toFixed(4)}`;
      })
      .sort();
  };

  for (const shape of ["staggered", "hexagonal"] as const) {
    for (const axis of ["y", "x"] as const) {
      for (const index of ["odd", "even"] as const) {
        it(`moves the selection an odd number of rows or columns keeping its shape on a ${shape} map (axis ${axis}, ${index}) (ADR 0442)`, () => {
          const map = newMap(shape, axis, index);
          map.setTile(0, 0, 1);
          map.setTile(1, 0, 2);
          map.setTile(0, 1, 3);
          map.setTile(1, 1, 4);
          const before = shapeOf(map);
          // Copied, the block remembers its bottom-left row's (column's) kind: row (column) 0 is shifted on "even" maps.
          expect(copySelection(map, keys([0, 0], [1, 1]), [0])?.frame).toEqual({ axis, shifted: index === "even" });
          let sel: Set<string> = keys([0, 0], [1, 0], [0, 1], [1, 1]);
          // Moved by its corner, or dragged by the cell holding tile 4 (which lands where it's dragged to).
          for (const [dx, dy, byFour] of [[0, 3, false], [3, 0, false], [1, 1, true], [-5, 2, true], [0, -1, true]] as const) {
            const four = [...map.tiles(0)].find((t) => t.id === 4)!;
            const anchor: Cell | undefined = byFour ? [four.x, four.y] : undefined;
            const landing = movedSelection(map, sel, dx, dy, anchor);
            sel = moveSelection(map, sel, [0], dx, dy, false, anchor);
            expect(sel).toEqual(landing);
            expect(usedCells(map, [0])).toEqual(sel);
            expect(shapeOf(map)).toEqual(before);
            if (byFour) expect(map.getTile(four.x + dx, four.y + dy)).toBe(4);
          }
        });
      }
    }
  }

  it("moves square and isometric selections cell for cell (ADR 0442)", () => {
    for (const shape of ["square", "isometric"] as const) {
      const map = newMap(shape);
      map.setTile(0, 0, 1);
      map.setTile(1, 1, 2);
      expect(copySelection(map, keys([0, 0], [1, 1]), [0])?.frame).toBeUndefined();
      expect(moveSelection(map, keys([0, 0], [1, 1]), [0], 1, 3, false, [1, 1])).toEqual(keys([1, 3], [2, 4]));
      expect([map.getTile(1, 3), map.getTile(2, 4)]).toEqual([1, 2]);
    }
  });
});
