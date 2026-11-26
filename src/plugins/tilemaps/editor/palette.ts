// What the Tile Palette does besides drawing (ADR 0103): the stamp a block of tiles makes, and layer edits written
// to the scene as one undoable write of `layers` (`editor.scene.writeField`), and Replace with… (ADR 0426).
import { Tilemap } from "../runtime";
import type { Stamp } from "../runtime/brushes";
import type { TilemapLayerData } from "../runtime/format";
import { editor, type OpenScene } from "../../../editor/sdk";

/**
 * The stamp for the block of the palette grid between tile positions `a` and `b` (indices into `ids`, laid out
 * `columns` to a row from the top). Row 0 of the stamp is the bottom row of the block, as cells count up; positions
 * past the last tile are empty cells.
 */
export function blockStamp(ids: readonly number[], columns: number, a: number, b: number): Stamp {
  const ca = a % columns, ra = Math.floor(a / columns), cb = b % columns, rb = Math.floor(b / columns);
  const c0 = Math.min(ca, cb), c1 = Math.max(ca, cb), r0 = Math.min(ra, rb), r1 = Math.max(ra, rb);
  const width = c1 - c0 + 1, height = r1 - r0 + 1;
  const values: number[] = [];
  for (let row = 0; row < height; row++) {
    const gridRow = r1 - row;
    for (let col = 0; col < width; col++) values.push(ids[gridRow * columns + c0 + col] ?? 0);
  }
  return { width, height, values };
}

/** The map's layers as scene data with `edit` applied to a copy. */
export function editedLayers(map: Tilemap, edit: (layers: TilemapLayerData[]) => void): TilemapLayerData[] {
  const layers = map.toLayerData().map((l) => ({ ...l }));
  edit(layers);
  return layers;
}

/** Write `layers` to the node's Tilemap as one undoable step (prefab instances get an override). */
export function commitLayers(scene: OpenScene, path: readonly string[], layers: TilemapLayerData[], label: string): void {
  editor.scene.edit(label, () => void editor.scene.writeField({ scene, path, type: "engine.Tilemap" }, "layers", layers), scene);
}

/** Where Replace with… replaces a tile (ADR 0426): the active layer, every layer of the map, or every Tilemap of the open scene with the same tileset. */
export type ReplaceScope = "layer" | "layers" | "scene";

/**
 * Replace tile `from` by tile `to` (flip flags kept) in `scope`, written as one undoable step. `layer` is the active
 * layer of the map at `path`. "scene" reaches the Tilemaps of the open scene's own nodes that use the map's tileset
 * (not those inside prefab instances). Returns how many cells changed.
 */
export function replaceTileIn(scene: OpenScene, path: readonly string[], map: Tilemap, from: number, to: number, scope: ReplaceScope, layer: number): number {
  const maps: { path: readonly string[]; map: Tilemap }[] = [{ path, map }];
  if (scope === "scene") {
    for (const root of scene.doc.roots()) {
      for (const id of scene.doc.subtree(root)) {
        const other = scene.sync.nodeFor([id])?.getBehavior(Tilemap);
        if (other && other !== map && other.tileset === map.tileset) maps.push({ path: [id], map: other });
      }
    }
  }
  let changed = 0;
  editor.scene.edit(
    "Replace tile",
    () => {
      for (const m of maps) {
        const n = m.map.replaceTile(from, to, scope === "layer" ? layer : undefined);
        if (n === 0) continue;
        changed += n;
        editor.scene.writeField({ scene, path: m.path, type: "engine.Tilemap" }, "layers", m.map.toLayerData());
      }
    },
    scene,
  );
  return changed;
}

/** Set the node's Tilemap tileset to a project path (or clear it). */
export function commitTileset(scene: OpenScene, path: readonly string[], tilesetPath: string): void {
  editor.scene.edit("Set tileset", () => void editor.scene.writeField({ scene, path, type: "engine.Tilemap" }, "tileset", tilesetPath ? `asset:${tilesetPath}` : ""), scene);
}
