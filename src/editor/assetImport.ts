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
import { assetKind, isSliceEntry, splitSliceEntry } from "./assetBrowser";
import { selectedAssets } from "./assetSelection";
import type { EditorProject } from "./projects";
import { selectedKeys } from "./state";

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

/**
 * The asset the Asset Inspector shows: the one image, audio file, model or material selected in
 * the Assets panel (a selected slice shows its image), or null. The Inspector shows it when no
 * node is selected.
 */
export const inspectedAsset = computed<string | null>(() => {
  const sel = selectedAssets.value;
  if (sel.length !== 1) return null;
  const entry = isSliceEntry(sel[0]) ? splitSliceEntry(sel[0]).image : sel[0];
  return importKind(entry) || assetKind(entry) === "material" ? entry : null;
});

/** True when the Inspector panel should show the Asset Inspector instead of a node. */
export const showsAssetInspector = () => selectedKeys.value.length === 0 && inspectedAsset.value !== null;

/** The image open in the Sprite Editor, if any. */
export const spriteEditorImage = signal<string | null>(null);

export function openSpriteEditor(imagePath: string): void {
  spriteEditorImage.value = imagePath;
}
