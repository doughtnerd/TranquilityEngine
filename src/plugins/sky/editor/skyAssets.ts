// Sky assets in the editor (ADR 0112, 0134): which sky the Sky panel has open, and New Sky.
// Editing goes through the sky's asset document (`openAssetDocument(project, path, "sky")`).
import { signal } from "@preact/signals";
import { skyPreset, type SkyPresetId } from "../../../engine/sky/presets";
import { formatSky } from "../../../engine/sky/skyFormat";
import { editor } from "../../../editor/sdk";

/** The sky open in the Sky panel, or null. */
export const openSky = signal<string | null>(null);

/** Open a sky in the Sky panel and bring the panel forward. */
export function openSkyAsset(path: string): void {
  openSky.value = path;
  editor.showPanel("sky");
}

/** Where New Sky goes by default: `skies/` if the project has it, else the folder given. */
export function skyFolder(folder: string): string {
  return folder === "" && editor.project.current?.folders.includes("skies") ? "skies" : folder;
}

/**
 * Create `New Sky.sky.json` (or `New Sky 2`…) in `folder` from a preset (Clear Day by default).
 * Returns its path, or null if the project is read-only or writing failed.
 */
export async function createSky(folder: string, preset: SkyPresetId = "clearDay"): Promise<string | null> {
  return editor.project.createFile({ folder: skyFolder(folder), name: "New Sky.sky.json", what: "skies", write: (project, path) => project.writeText(path, formatSky(skyPreset(preset))) });
}
