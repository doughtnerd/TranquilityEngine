// The prefab brush in the scene (ADR 0440): with prefabs chosen in the Tile Palette, the pencil, rectangle and eraser
// place and remove prefab instances, children of the Tilemap's node at their cells' centres (`cellToLocal`, so every
// grid works). A stroke collects its cells while the pointer moves and, released, applies `prefabBrushLogic.ts`'s plan
// as node removes and inserts in the gesture's one undo step. The instances are ordinary prefab instances (ADR 0086),
// named after the prefab by the node insertion; nothing at runtime knows a brush placed them.
import type { Tilemap } from "../runtime";
import { lineCells, rectCells, type Cell } from "../runtime/brushes";
import { brushPrefabs } from "./brush";
import { planPrefabStroke, type PlacedInstance } from "./prefabBrushLogic";
import { editor, type NodePath, type OpenScene } from "../../../editor/sdk";

/** A project path from a tileset's prefab reference (`asset:props/chest.prefab.json`). */
export const prefabPath = (ref: string): string => ref.replace(/^asset:/, "");

/** Whether the brush places prefabs with `tool` now: prefabs are chosen and the tool is the pencil, rectangle or eraser. */
export function paintsPrefabs(tool: string | null): boolean {
  return brushPrefabs.peek().length > 0 && (tool === "pencil" || tool === "rect" || tool === "erase");
}

/**
 * The prefab instances directly under the Tilemap at `path`, each with the cell its position falls in (a moved instance
 * just falls in another cell). Only a Tilemap at the document's top level (not inside a prefab instance) has them.
 */
function placedInstances(scene: OpenScene, path: NodePath, map: Tilemap): PlacedInstance[] {
  if (path.length !== 1 || !scene.doc.has(path[0])) return [];
  const out: PlacedInstance[] = [];
  for (const id of scene.doc.children(path[0])) {
    const prefab = scene.doc.node(id).prefab;
    const position = prefab ? scene.sync.nodeFor([id])?.transform?.position : undefined;
    if (!prefab || !position) continue;
    const c = map.localToCell(position);
    out.push({ key: id, prefab, cell: [c.x, c.y] });
  }
  return out;
}

/** One prefab brush stroke from the press to the release: the cells it covers so far. */
export interface PrefabStroke {
  readonly tool: "pencil" | "rect" | "erase";
  readonly start: Cell;
  readonly last: Cell;
  moveTo(cell: Cell): boolean;
  /** The cells the stroke covers: the pencil's and eraser's path, or the dragged rectangle. */
  cells(): Cell[];
}

export function beginPrefabStroke(tool: "pencil" | "rect" | "erase", cell: Cell): PrefabStroke {
  const start: Cell = [cell[0], cell[1]];
  let last: Cell = start;
  const path: Cell[] = [start];
  return {
    tool,
    start,
    get last() {
      return last;
    },
    moveTo(c) {
      if (c[0] === last[0] && c[1] === last[1]) return false;
      if (tool !== "rect") path.push(...lineCells(last[0], last[1], c[0], c[1]).slice(1));
      last = [c[0], c[1]];
      return true;
    },
    cells: () => (tool === "rect" ? rectCells(start[0], start[1], last[0], last[1]) : [...path]),
  };
}

/**
 * Apply a stroke of `mode` over `cells` to the Tilemap at `path`, as the undo step `label` (or inside the one open):
 * the instances it replaces or erases removed, the new ones inserted under the Tilemap at their cells' centres.
 * Returns how many instances were added and removed.
 */
export function commitPrefabStroke(scene: OpenScene, path: NodePath, map: Tilemap, mode: "paint" | "erase", cells: readonly Cell[], label: string): { added: number; removed: number } {
  if (path.length !== 1) {
    editor.messages.info("The prefab brush paints Tilemaps that aren't inside a prefab instance.");
    return { added: 0, removed: 0 };
  }
  const prefabs = brushPrefabs.peek().map(prefabPath);
  const plan = planPrefabStroke(mode, cells, placedInstances(scene, path, map), prefabs, map.variantSeed);
  if (plan.remove.length === 0 && plan.add.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  editor.scene.edit(
    label,
    () => {
      if (plan.remove.length > 0) editor.scene.remove(label, plan.remove.map((k) => [k]), scene);
      for (const { cell, prefab } of plan.add) {
        const p = map.cellToLocal(cell[0], cell[1]);
        const made = editor.scene.insert(label, [{ prefab, overrides: [{ component: "engine.Transform", field: "position", value: [p.x, p.y, 0] }] }], path, scene);
        if (made) added++;
      }
    },
    scene,
  );
  return { added, removed: plan.remove.length };
}
