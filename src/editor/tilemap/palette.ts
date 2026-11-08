// What the Tile Palette does besides drawing (ADR 0103): the stamp a block of tiles makes, and layer edits written
// to the scene as one undoable SetField of `layers`.
import type { Tilemap } from "../../plugins/tilemaps/runtime";
import type { Stamp } from "../../plugins/tilemaps/runtime/brushes";
import type { TilemapLayerData } from "../../plugins/tilemaps/runtime/format";
import { SetField } from "../document";
import type { OpenScene } from "../state";

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
  const [id, ...target] = path;
  const previous = scene.doc.isPrefabInstance(id) ? scene.doc.overrideValue(id, target, "engine.Tilemap", "layers", 0) : scene.doc.fieldValue(id, "engine.Tilemap", "layers", 0);
  if (JSON.stringify(previous) === JSON.stringify(layers)) return;
  scene.stack.beginGroup(label);
  scene.stack.execute(new SetField(id, "engine.Tilemap", "layers", layers, { index: 0, target }));
  scene.stack.endGroup();
}

/** Set the node's Tilemap tileset to a project path (or clear it). */
export function commitTileset(scene: OpenScene, path: readonly string[], tilesetPath: string): void {
  const [id, ...target] = path;
  scene.stack.beginGroup("Set tileset");
  scene.stack.execute(new SetField(id, "engine.Tilemap", "tileset", tilesetPath ? `asset:${tilesetPath}` : "", { index: 0, target }));
  scene.stack.endGroup();
}
