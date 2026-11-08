// Tileset assets in the editor (ADR 0103): creating `*.tileset.json` files (empty, or one tile per slice of an
// image), reading them, and the slice helpers the Assets panel and the Tile Palette use. Editing goes through the
// tileset's asset document (ADR 0134), made by the Tilemaps plugin's `tileset` format
// (`src/plugins/tilemaps/editor/`).
import { newTileset, parseTileset, TILESET_SUFFIX, type TileDef, type TilesetData } from "../engine/tilemap/tileset";
import { fileName } from "./assetBrowser";
import { readImportSettings } from "./assetImport";
import { freePath } from "./assetOps";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";
import type { ImportSettings } from "../engine/scene/importSettings";

export interface ReadTileset {
  tileset: TilesetData;
  /** What's wrong with the file (bad tiles are skipped). */
  problems: string[];
}

/** A tileset asset as the file holds it now. */
export function readTileset(project: EditorProject, path: string): ReadTileset {
  try {
    return parseTileset(project.assets.get(path), path);
  } catch (err) {
    return { tileset: newTileset(), problems: [(err as Error).message] };
  }
}

/** The file text of a tileset: pretty JSON, 2-space indent. */
export const formatTileset = (data: TilesetData): string => `${JSON.stringify(data, null, 2)}\n`;

/** A tile's sprite reference split into its image and slice (null for a reference that isn't `asset:<image>#<slice>`). */
export function splitSprite(sprite: string): { image: string; slice: string } | null {
  const ref = sprite.replace(/^asset:/, "");
  const i = ref.indexOf("#");
  return i > 0 ? { image: ref.slice(0, i), slice: ref.slice(i + 1) } : null;
}

/** The sprite reference of a slice: `asset:images/tiles.png#grass`. */
export const sliceSprite = (image: string, slice: string) => `asset:${image}#${slice}`;

/** Tiles for the slices of `settings` that `used` sprites don't have yet, with ids counting up from `firstId`. */
export function tilesForSlices(settings: ImportSettings, image: string, firstId = 1, used: ReadonlySet<string> = new Set()): TileDef[] {
  const out: TileDef[] = [];
  let id = firstId;
  for (const s of settings.sprites) {
    const sprite = sliceSprite(image, s.name);
    if (!used.has(sprite)) out.push({ id: id++, sprite, collision: "none" });
  }
  return out;
}

/** A tileset with one tile per slice of an image (ids 1…n), sized by the first slice, or 16 × 16 for an image without slices. */
export function tilesetFromSlices(imagePath: string, project: EditorProject | null = currentProject.value): TilesetData {
  const settings = project ? readImportSettings(project, imagePath).settings : null;
  const ts = newTileset();
  if (!settings || settings.sprites.length === 0) return ts;
  const [, , w, h] = settings.sprites[0].rect;
  ts.tileSize = [w, h];
  ts.tiles = tilesForSlices(settings, imagePath);
  return ts;
}

/** True if an image has slices to make tiles from. */
export const hasSlices = (project: EditorProject, imagePath: string) => readImportSettings(project, imagePath).settings.sprites.length > 0;

/**
 * Create `New Tileset.tileset.json` (or `… 2`) in `folder`: empty, or `data`. Returns its path, or null if the
 * project is read-only or writing failed.
 */
export async function createTileset(folder: string, data: TilesetData = newTileset(), name = "New Tileset"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add tilesets.` };
    return null;
  }
  const path = freePath(project, folder, `${name}${TILESET_SUFFIX}`);
  try {
    await project.writeText(path, formatTileset(data));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}

/** Create a tileset named after an image from its slices (Create Tileset from Slices). */
export function createTilesetFromSlices(folder: string, imagePath: string): Promise<string | null> {
  const base = fileName(imagePath).replace(/\.[^.]+$/, "");
  return createTileset(folder, tilesetFromSlices(imagePath), base);
}
