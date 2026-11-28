// Tileset assets in the editor (ADR 0103; the Tilemaps plugin's since 0146): a tileset with one tile per slice of
// an image, and the slice helpers the Assets panel's Create Tileset from Slices action and the Tile Palette use.
// Creating, reading and editing tilesets goes through the asset kind host and the tileset's asset document (ADR
// 0134, 0233), over this plugin's `tileset` format (`tilesetFormat.ts`).
import { newTileset, type TileDef, type TilesetData } from "../runtime/tileset";
import type { ImportSettings } from "../../../engine/scene/importSettings";
import { randomUuid } from "../../../engine/core/uuid";
import { editor, type EditorProject, assetRefTarget } from "../../../editor/sdk";

/** A tile's sprite reference split into its image and slice (null for a reference that isn't `asset:<image>#<slice>`). */
export function splitSprite(sprite: string): { image: string; slice: string } | null {
  const ref = assetRefTarget(sprite);
  const i = ref.indexOf("#");
  return i > 0 ? { image: ref.slice(0, i), slice: ref.slice(i + 1) } : null;
}

/** The sprite reference of a slice: `asset:images/tiles.png#grass`. */
const sliceSprite = (image: string, slice: string) => `asset:${image}#${slice}`;

/** Tiles for the slices of `settings` that `used` sprites don't have yet, with ids counting up from `firstId`, each with
 * a new random uuid (ADR 0392: never a deleted tile's, so maps that used one don't draw the new tile in its place). */
export function tilesForSlices(settings: ImportSettings, image: string, firstId = 1, used: ReadonlySet<string> = new Set()): TileDef[] {
  const out: TileDef[] = [];
  let id = firstId;
  for (const s of settings.sprites) {
    const sprite = sliceSprite(image, s.name);
    if (!used.has(sprite)) out.push({ id: id++, uuid: randomUuid(), sprite, collision: "none" });
  }
  return out;
}

/** A tileset with one tile per slice of an image (ids 1…n), sized by the first slice, or 16 × 16 for an image without slices. */
function tilesetFromSlices(imagePath: string, project: EditorProject | null = editor.project.current): TilesetData {
  const settings = project ? editor.assets.importSettings(project, imagePath).settings : null;
  const ts = newTileset();
  if (!settings || settings.sprites.length === 0) return ts;
  const [, , w, h] = settings.sprites[0].rect;
  ts.tileSize = [w, h];
  ts.tiles = tilesForSlices(settings, imagePath);
  return ts;
}

/** True if an image has slices to make tiles from. */
export const hasSlices = (project: EditorProject, imagePath: string) => editor.assets.importSettings(project, imagePath).settings.sprites.length > 0;

/** Create a tileset named after an image from its slices, in `folder` (Create Tileset from Slices). Its path, or null. */
export function createTilesetFromSlices(folder: string, imagePath: string): Promise<string | null> {
  const base = editor.assets.fileName(imagePath).replace(/\.[^.]+$/, "");
  return editor.assets.create("tileset", { folder, value: tilesetFromSlices(imagePath), name: base });
}
