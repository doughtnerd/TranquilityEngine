// What a stroke of the prefab brush (ADR 0426) does to the prefab instances under a Tilemap: one instance per cell,
// painting an occupied cell replaces what's there, the eraser removes the instances standing in its cells, and random
// mode picks among the chosen prefabs by the cell's hash (`cellRandom` on the random-brush stream, ADR 0400), so the
// same strokes place the same prefabs. Pure: the editor glue (prefabBrush.ts) reads the instances and applies the plan.
import type { Cell } from "../runtime/brushes";
import { cellRandom, RANDOM_BRUSH_STREAM } from "../runtime/cellHash";

/** A prefab instance under the Tilemap: its node key, its prefab and the cell its position falls in. */
export interface PlacedInstance {
  readonly key: string;
  readonly prefab: string;
  readonly cell: Cell;
}

/** The node removes and adds a stroke makes, as one undo step. */
export interface PrefabStrokePlan {
  readonly remove: string[];
  readonly add: { cell: Cell; prefab: string }[];
}

/** The prefab painted at cell (x, y): the one chosen, or with several (random mode) one drawn from the cell and `seed`. */
function prefabAt(prefabs: readonly string[], x: number, y: number, seed: number): string | undefined {
  if (prefabs.length <= 1) return prefabs[0];
  return prefabs[Math.min(prefabs.length - 1, Math.floor(cellRandom(seed, x, y, RANDOM_BRUSH_STREAM) * prefabs.length))];
}

/**
 * The plan of a stroke over `cells`: `paint` puts the brush's prefab in each cell (an instance of the same prefab already
 * there is kept as it is, others there are removed), `erase` removes every instance in the cells.
 */
export function planPrefabStroke(mode: "paint" | "erase", cells: readonly Cell[], existing: readonly PlacedInstance[], prefabs: readonly string[], seed: number): PrefabStrokePlan {
  const byCell = new Map<string, PlacedInstance[]>();
  for (const inst of existing) {
    const k = `${inst.cell[0]},${inst.cell[1]}`;
    byCell.set(k, [...(byCell.get(k) ?? []), inst]);
  }
  const remove: string[] = [];
  const add: { cell: Cell; prefab: string }[] = [];
  const seen = new Set<string>();
  for (const [x, y] of cells) {
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const here = byCell.get(k) ?? [];
    if (mode === "erase") {
      remove.push(...here.map((i) => i.key));
      continue;
    }
    const prefab = prefabAt(prefabs, x, y, seed);
    if (!prefab) continue;
    if (here.length === 1 && here[0].prefab === prefab) continue;
    remove.push(...here.map((i) => i.key));
    add.push({ cell: [x, y], prefab });
  }
  return { remove, add };
}
