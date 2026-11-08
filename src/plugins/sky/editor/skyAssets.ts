// Sky assets in the editor (ADR 0112, 0134): which sky the Sky panel has open, and New Sky.
// Editing goes through the sky's asset document (`openAssetDocument(project, path, "sky")`).
import { signal } from "@preact/signals";
import { skyPreset, type SkyPresetId } from "../../../engine/sky/presets";
import { formatSky } from "../../../engine/sky/skyFormat";
import { fileName } from "../../../editor/assetBrowser";
import { freePath } from "../../../editor/assetOps";
import { showPanel } from "../../../editor/layout/store";
import { errorStatus } from "../../../editor/messages";
import { currentProject, docVersion, status } from "../../../editor/state";

/** The sky open in the Sky panel, or null. */
export const openSky = signal<string | null>(null);

/** Open a sky in the Sky panel and bring the panel forward. */
export function openSkyAsset(path: string): void {
  openSky.value = path;
  showPanel("sky");
}

/** Where New Sky goes by default: `skies/` if the project has it, else the folder given. */
export function skyFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("skies") ? "skies" : folder;
}

/**
 * Create `New Sky.sky.json` (or `New Sky 2`…) in `folder` from a preset (Clear Day by default).
 * Returns its path, or null if the project is read-only or writing failed.
 */
export async function createSky(folder: string, preset: SkyPresetId = "clearDay"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add skies.` };
    return null;
  }
  const path = freePath(project, skyFolder(folder), "New Sky.sky.json");
  try {
    await project.writeText(path, formatSky(skyPreset(preset)));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
