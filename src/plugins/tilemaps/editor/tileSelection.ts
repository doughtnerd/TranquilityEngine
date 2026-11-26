// The selection tool's state and operations (ADR 0426): the selected cells of the selected Tilemap, the "All layers"
// toggle, and copy, cut, delete, move, flip and turn, each one undo step (one write of `layers`, as a stroke is). Copy
// takes the cells into the brush as its stamp (named layers with "All layers"), so the pencil pastes them, in this
// Tilemap or another (`brush.ts` matches another tileset's tiles by uuid). The cell rules are `selectionLogic.ts`'s;
// the scene view's gestures and keys are `paintTool.ts`'s, the buttons the Tile Palette's.
import { signal } from "@preact/signals";
import type { Tilemap } from "../runtime";
import type { Cell } from "../runtime/brushes";
import { FLIP_X, FLIP_Y } from "../runtime/format";
import { TURN_CLOCKWISE } from "../runtime/tileFlips";
import { activeLayer, canRotateOn, chooseBlock, commitTilemap, tilemapOf } from "./brush";
import { clearSelection, copySelection, moveSelection, selectionLayers, selectRect, transformSelection, usedCells, type CellSelection, type SelectMode } from "./selectionLogic";
import { editor } from "../../../editor/sdk";

const NOTHING: CellSelection = new Set();

/** The selected cells and the Tilemap they're of (an empty selection: no map). */
export const tileSelection = signal<{ map: Tilemap | null; cells: CellSelection }>({ map: null, cells: NOTHING });
/** Select, copy, cut and delete act on every unlocked layer instead of the active one (ADR 0426, 0425). */
export const selectAllLayers = signal(false);

/** The selection's cells when it's of `map`, else none. */
export function selectionOf(map: Tilemap | null): CellSelection {
  const s = tileSelection.peek();
  return map && s.map === map ? s.cells : NOTHING;
}

/** Select `cells` of `map` (empty: nothing selected). */
export function setSelection(map: Tilemap, cells: CellSelection): void {
  tileSelection.value = cells.size > 0 ? { map, cells } : { map: null, cells: NOTHING };
}

/** Select nothing. True when something was selected. */
export function clearTileSelection(): boolean {
  if (tileSelection.peek().cells.size === 0) return false;
  tileSelection.value = { map: null, cells: NOTHING };
  return true;
}

/** The layers the selection acts on in `map`: the active one, or every unlocked layer with "All layers". */
export function actedLayers(map: Tilemap): number[] {
  return selectionLayers(map, Math.min(activeLayer.peek(), map.layerCount - 1), selectAllLayers.peek());
}

/** Change the selection of `map` by the rectangle between `a` and `b`. */
export function selectCells(map: Tilemap, a: Cell, b: Cell, mode: SelectMode): void {
  setSelection(map, selectRect(selectionOf(map), a, b, mode));
}

/** Select every used cell of the layers the selection acts on (Ctrl/⌘+A). */
export function selectAllUsed(map: Tilemap): void {
  setSelection(map, usedCells(map, actedLayers(map)));
}

/** The selected Tilemap with its scene and path while the scene can be edited, if the selection is of it. */
function target(): { map: Tilemap; cells: CellSelection; layers: number[]; scene: NonNullable<ReturnType<typeof editor.scene.peekOpen>>; path: readonly string[] } | null {
  if (editor.scene.whyNotEdit() !== null) return null;
  const map = tilemapOf(editor.scene.selection.node());
  const scene = editor.scene.peekOpen(), path = editor.scene.selection.path();
  const cells = selectionOf(map);
  if (!map || !scene || !path || cells.size === 0) return null;
  const layers = actedLayers(map);
  if (layers.length === 0) {
    editor.messages.info(selectAllLayers.peek() ? "Every layer of this Tilemap is locked." : "The active layer is locked. Unlock it in the Tile Palette to edit it.");
    return null;
  }
  return { map, cells, layers, scene, path };
}

/** Copy the selection into the brush as its stamp (Ctrl/⌘+C). True when there was something to copy. */
export function copyTiles(): boolean {
  const t = target();
  if (!t) return false;
  const block = copySelection(t.map, t.cells, t.layers);
  if (!block) {
    editor.messages.info("The selected cells are empty.");
    return false;
  }
  chooseBlock(block, t.map.tilesetAsset);
  return true;
}

/** Copy the selection into the brush and empty its cells, as one undo step (Ctrl/⌘+X). */
export function cutTiles(): boolean {
  const t = target();
  if (!t || !copyTiles()) return false;
  if (clearSelection(t.map, t.cells, t.layers) > 0) commitTilemap(t.scene, t.path, t.map, "Cut tiles");
  return true;
}

/** Empty the selected cells, as one undo step (Delete). */
export function deleteTiles(): boolean {
  const t = target();
  if (!t) return false;
  if (clearSelection(t.map, t.cells, t.layers) > 0) commitTilemap(t.scene, t.path, t.map, "Delete tiles");
  return true;
}

/**
 * Flip (X, Y) or turn (Z) the selected cells in place, as one undo step. On hexagonal maps the tiles' images flip
 * where they are and Rotate does nothing (ADR 0421).
 */
export function transformTiles(axis: "x" | "y" | "rotate"): boolean {
  const t = target();
  if (!t) return false;
  const layout = canRotateOn(t.map);
  if (axis === "rotate" && !layout) {
    editor.messages.info("Hexagonal maps can't turn tiles a quarter turn.");
    return false;
  }
  const flags = axis === "x" ? FLIP_X : axis === "y" ? FLIP_Y : TURN_CLOCKWISE;
  const moved = transformSelection(t.map, t.cells, t.layers, flags, layout);
  setSelection(t.map, moved);
  commitTilemap(t.scene, t.path, t.map, axis === "rotate" ? "Rotate tiles" : "Flip tiles");
  return true;
}

/**
 * Move the selected cells by `(dx, dy)` (with `copy`, copy them), the selection following, written as `label` (inside
 * the scene view's gesture, its undo step).
 */
export function moveTiles(dx: number, dy: number, copy: boolean): boolean {
  const t = target();
  if (!t || (dx === 0 && dy === 0)) return false;
  setSelection(t.map, moveSelection(t.map, t.cells, t.layers, dx, dy, copy));
  commitTilemap(t.scene, t.path, t.map, copy ? "Copy tiles" : "Move tiles");
  return true;
}
