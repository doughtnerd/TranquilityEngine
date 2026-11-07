// Sky assets in the editor (ADR 0112): creating `*.sky.json` from a preset, reading and writing them,
// and which one the Sky panel has open. Writes to one file run one after another, so quick edits from
// the panel's sliders land in order.
import { signal } from "@preact/signals";
import { skyPreset, type SkyPresetId } from "../engine/sky/presets";
import { formatSky, parseSky, type SkyProblem, type SkySettings } from "../engine/sky/skyFormat";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { showPanel } from "./layout/store";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

/** The sky open in the Sky panel, or null. */
export const openSky = signal<string | null>(null);

/** Open a sky in the Sky panel and bring the panel forward. */
export function openSkyAsset(path: string): void {
  openSky.value = path;
  showPanel("sky");
}

/** A sky asset as the file holds it now, with what's wrong with it. */
export function readSky(project: EditorProject, path: string): { settings: SkySettings; problems: SkyProblem[] } {
  return parseSky(project.assets.get(path), path);
}

const writing = new Map<string, Promise<unknown>>();

/** Write a sky asset after the writes before it. Throws for a read-only project. */
export function writeSky(project: EditorProject, path: string, settings: SkySettings): Promise<void> {
  const text = formatSky(settings);
  const run = () => project.writeText(path, text);
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
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
    await writeSky(project, path, skyPreset(preset));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
