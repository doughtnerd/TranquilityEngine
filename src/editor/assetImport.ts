// Import settings in the editor (ADR 0040): reading and writing an asset's sidecar
// (`<asset>.meta.json`), which asset the Asset Inspector shows, and which image the Sprite Editor
// has open. ui/AssetInspector.tsx and ui/SpriteEditor.tsx render them.
import { computed, signal } from "@preact/signals";
import {
  defaultImportSettings,
  formatImportSettings,
  parseImportSettings,
  sidecarPath,
  type ImportSettings,
} from "../engine/scene/importSettings";
import { assetKind, folderOf, isSliceEntry, splitSliceEntry } from "./assetBrowser";
import { openFolder, select as selectAssets, selectedAssets } from "./assetSelection";
import type { EditorProject } from "./projects";
import { select as selectNodes, selectedKeys } from "./state";

export type ImportKind = "image" | "audio" | "model";

/** The kind of import settings an asset has, or null if it has none. */
export function importKind(path: string): ImportKind | null {
  const kind = assetKind(path);
  return kind === "image" || kind === "audio" || kind === "model" ? kind : null;
}

export interface ReadSettings {
  settings: ImportSettings;
  /** Whether the sidecar exists. */
  exists: boolean;
  /** What's wrong with it (bad values are read as the defaults). */
  problems: string[];
}

/** An asset's import settings as its sidecar holds them now (defaults if it has none). */
export function readImportSettings(project: EditorProject, path: string): ReadSettings {
  const meta = sidecarPath(path);
  if (!project.files.includes(meta)) return { settings: defaultImportSettings(), exists: false, problems: [] };
  try {
    const { settings, problems } = parseImportSettings(project.assets.get(meta), meta);
    return { settings, exists: true, problems };
  } catch (err) {
    return { settings: defaultImportSettings(), exists: true, problems: [(err as Error).message] };
  }
}

/** Write an asset's sidecar. Throws for a read-only project. */
export async function writeImportSettings(project: EditorProject, path: string, settings: ImportSettings): Promise<void> {
  await project.writeText(sidecarPath(path), formatImportSettings(settings));
}

/** True if two settings would write the same sidecar. */
export const sameSettings = (a: ImportSettings, b: ImportSettings) => formatImportSettings(a) === formatImportSettings(b);

/** Asset kinds the Inspector has an editor or preview for, besides files with import settings. */
const INSPECTED_KINDS: readonly string[] = ["material", "shadergraph", "shadersubgraph", "particles", "formation", "environment", "prefab"];

/** The file the Asset Inspector shows for an Assets panel entry (a slice shows its image), or null if it has no inspector. */
export function inspectableAsset(entry: string): string | null {
  const file = isSliceEntry(entry) ? splitSliceEntry(entry).image : entry;
  return importKind(file) || INSPECTED_KINDS.includes(assetKind(file)) ? file : null;
}

/**
 * The asset the Asset Inspector shows: the one image, audio file, model, material, shader graph,
 * particle effect, formation, environment or prefab selected in the Assets panel (a selected
 * slice shows its image), or null. The Inspector shows it when no node is selected.
 */
export const inspectedAsset = computed<string | null>(() => {
  const sel = selectedAssets.value;
  return sel.length === 1 ? inspectableAsset(sel[0]) : null;
});

/** True when the Inspector panel should show the Asset Inspector instead of a node. */
export const showsAssetInspector = () => selectedKeys.value.length === 0 && inspectedAsset.value !== null;

/**
 * After the Assets panel's selection changes by a click or the arrow keys: if it is one asset the Inspector can show, deselect the scene's nodes so the Inspector
 * shows it. The Inspector follows the latest selection; selecting nodes deselects the assets in
 * turn (state.ts `select`).
 */
export function inspectSelectedAsset(): void {
  if (inspectedAsset.peek() !== null) selectNodes([]);
}

/** Show `path` in the Assets panel (opening its folder) and select it alone, so the Inspector shows it. */
export function showAsset(path: string): void {
  openFolder(folderOf(path));
  selectAssets([path]);
  inspectSelectedAsset();
}

/** The image open in the Sprite Editor, if any. */
export const spriteEditorImage = signal<string | null>(null);

export function openSpriteEditor(imagePath: string): void {
  spriteEditorImage.value = imagePath;
}
