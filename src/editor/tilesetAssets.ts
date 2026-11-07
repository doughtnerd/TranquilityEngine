// Tileset assets in the editor (ADR 0103): creating `*.tileset.json` files (empty, or one tile per slice of an
// image), reading them, and writing edits from the Inspector's tileset editor (ui/TilesetInspector.tsx) one after
// another, each recorded in the tileset's undo history for the session.
import { newTileset, parseTileset, TILESET_SUFFIX, type TileDef, type TilesetData } from "../engine/tilemap/tileset";
import { fileName } from "./assetBrowser";
import { readImportSettings } from "./assetImport";
import { freePath } from "./assetOps";
import { createGraphHistory } from "./graph/history";
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

/** Each tileset's writes in progress, so quick edits apply one after another. */
const writing = new Map<string, Promise<unknown>>();

/** Write a tileset asset after the writes before it. Throws for a read-only project. */
export function writeTileset(project: EditorProject, path: string, data: TilesetData): Promise<void> {
  const text = formatTileset(data);
  const run = () => project.writeText(path, text);
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
}

const histories = createGraphHistory<TilesetData>();

/** A tileset's undo history this session. */
export const tilesetHistory = (path: string) => histories.get(path);

async function save(project: EditorProject, path: string, data: TilesetData): Promise<void> {
  try {
    const write = writeTileset(project, path, data);
    docVersion.value++;
    await write;
    docVersion.value++;
  } catch (err) {
    status.value = errorStatus(`Couldn't save ${fileName(path)}`, err);
  }
}

/** Apply an edit: `next` is written, and `before` becomes the state to undo to (`record: false` skips the undo step). */
export async function editTileset(project: EditorProject, path: string, before: TilesetData, next: TilesetData, record = true): Promise<void> {
  if (next === before) return;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to edit tilesets.` };
    return;
  }
  if (record) histories.record(path, before);
  await save(project, path, next);
}

/** Undo the tileset's last edit (false with nothing to undo). */
export async function undoTileset(project: EditorProject, path: string): Promise<boolean> {
  const prev = histories.undo(path, readTileset(project, path).tileset);
  if (!prev) return false;
  await save(project, path, prev);
  return true;
}

/** Redo the tileset's last undone edit (false with nothing to redo). */
export async function redoTileset(project: EditorProject, path: string): Promise<boolean> {
  const next = histories.redo(path, readTileset(project, path).tileset);
  if (!next) return false;
  await save(project, path, next);
  return true;
}

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
    await writeTileset(project, path, data);
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
