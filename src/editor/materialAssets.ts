// Material assets in the editor (ADR 0043): creating `*.material.json` files, and reading and
// writing them for the Asset Inspector's material editor (ui/AssetInspector.tsx).
import { defaultMaterialSettings, formatMaterial, parseMaterial, type MaterialSettings } from "../engine/scene/material";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

export interface ReadMaterial {
  settings: MaterialSettings;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: string[];
}

/** A material asset's settings as the file holds them now. */
export function readMaterial(project: EditorProject, path: string): ReadMaterial {
  try {
    return parseMaterial(project.assets.get(path), path);
  } catch (err) {
    return { settings: defaultMaterialSettings(), problems: [(err as Error).message] };
  }
}

/** Write a material asset. Throws for a read-only project. */
export async function writeMaterial(project: EditorProject, path: string, settings: MaterialSettings): Promise<void> {
  await project.writeText(path, formatMaterial(settings));
}

/** True if two settings would write the same file. */
export const sameMaterial = (a: MaterialSettings, b: MaterialSettings) => formatMaterial(a) === formatMaterial(b);

/** Where New Material goes by default: `materials/` if the project has it, else the folder given. */
export function materialFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("materials") ? "materials" : folder;
}

/**
 * Create `New Material.material.json` (or `New Material 2`…) in `folder`: the default lit
 * material. Returns its path, or null if the project is read-only or writing failed.
 */
export async function createMaterial(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add materials.` };
    return null;
  }
  const path = freePath(project, materialFolder(folder), "New Material.material.json");
  try {
    await writeMaterial(project, path, defaultMaterialSettings());
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
