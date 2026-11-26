import { describe, expect, it } from "vitest";
import type { Cell } from "../runtime/brushes";
import { planPrefabStroke, type PlacedInstance } from "./prefabBrushLogic";

const CHEST = "props/chest.prefab.json", BARREL = "props/barrel.prefab.json", CRATE = "props/crate.prefab.json";
const at = (key: string, prefab: string, cell: Cell): PlacedInstance => ({ key, prefab, cell });

describe("the prefab brush's strokes (ADR 0426)", () => {
  it("places one instance per cell, replacing another prefab and keeping the same one", () => {
    const existing = [at("a", BARREL, [1, 0]), at("b", CHEST, [2, 0])];
    const plan = planPrefabStroke("paint", [[0, 0], [1, 0], [2, 0], [0, 0]], existing, [CHEST], 7);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.add).toEqual([
      { cell: [0, 0], prefab: CHEST },
      { cell: [1, 0], prefab: CHEST },
    ]);
  });

  it("erases the instances standing in the erased cells", () => {
    const existing = [at("a", BARREL, [1, 0]), at("b", CHEST, [2, 0]), at("c", CHEST, [1, 0]), at("d", CHEST, [9, 9])];
    expect(planPrefabStroke("erase", [[1, 0], [2, 0], [3, 0]], existing, [CHEST], 0)).toEqual({ remove: ["a", "c", "b"], add: [] });
    // Painting a cell holding two instances leaves one.
    expect(planPrefabStroke("paint", [[1, 0]], existing, [CHEST], 0)).toEqual({ remove: ["a", "c"], add: [{ cell: [1, 0], prefab: CHEST }] });
  });

  it("picks among several prefabs by the cell's hash: the same seed places the same prefabs", () => {
    const cells: Cell[] = Array.from({ length: 64 }, (_, i) => [i % 8, Math.floor(i / 8)]);
    const prefabs = [CHEST, BARREL, CRATE];
    const first = planPrefabStroke("paint", cells, [], prefabs, 42).add.map((a) => a.prefab);
    expect(planPrefabStroke("paint", cells, [], prefabs, 42).add.map((a) => a.prefab)).toEqual(first);
    expect(new Set(first)).toEqual(new Set(prefabs));
    expect(planPrefabStroke("paint", cells, [], prefabs, 43).add.map((a) => a.prefab)).not.toEqual(first);
    // Painting over its own result again changes nothing.
    const placed = planPrefabStroke("paint", cells, [], prefabs, 42).add.map((a, i) => at(`n${i}`, a.prefab, a.cell));
    expect(planPrefabStroke("paint", cells, placed, prefabs, 42)).toEqual({ remove: [], add: [] });
  });

  it("does nothing without a prefab", () => {
    expect(planPrefabStroke("paint", [[0, 0]], [], [], 0)).toEqual({ remove: [], add: [] });
  });
});
