// Import settings in the editor (ADR 0040): reading and writing an asset's sidecar
// (`<asset>.meta.json`), and which image the Sprite Editor has open (it edits a sidecar's slices).
// ui/AssetInspector.tsx and ui/SpriteEditor.tsx render them. Which asset the Inspector shows is
// inspectorTarget.ts's (ADR 0242).
import { signal } from "@preact/signals";
import {
  defaultImportSettings,
  formatImportSettings,
  parseImportSettings,
  sidecarPath,
  type ImportSettings,
} from "../engine/scene/importSettings";
import type { EditorProject } from "./projects";

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

/** The image open in the Sprite Editor, if any. */
export const spriteEditorImage = signal<string | null>(null);

export function openSpriteEditor(imagePath: string): void {
  spriteEditorImage.value = imagePath;
}
