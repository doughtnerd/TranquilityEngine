// Material assets in the editor (ADR 0043, the Materials plugin since 0134): creating
// `*.material.json` files, reading them, and editing them through their asset document (the
// `material` format, registered by the plugin's `editor/index.ts`) for the Material inspector.
import { defaultMaterialSettings, formatMaterial, parseMaterial, type MaterialSettings } from "../../../engine/scene/material";
import { defaultShaderAsset, parseShaderAsset, type ShaderAsset } from "../../../engine/scene/shaderAsset";
import type { KeywordValue, ShaderKeyword } from "../../../engine/scene/shaderKeywords";
import { editor, openAssetDocument, type EditOptions, type EditorProject } from "../../../editor/sdk";

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

/** Write a material asset's file directly (New Material and other creators; edits go through `editMaterial`). Throws for a read-only project. */
export async function writeMaterial(project: EditorProject, path: string, settings: MaterialSettings): Promise<void> {
  await project.writeText(path, formatMaterial(settings));
}

/** True if two settings would write the same file. */
export const sameMaterial = (a: MaterialSettings, b: MaterialSettings) => formatMaterial(a) === formatMaterial(b);

/**
 * Change a material asset through its asset document (undo, ordered writes, read-only refusal):
 * `patch` (or what it returns for the settings as they are then) is applied to the document's
 * current settings. Resolves true once the file has the change; false if nothing changed or the
 * project is read-only. `coalesce` merges quick edits (drags) into one undo step.
 */
export async function editMaterial(project: EditorProject, path: string, patch: Partial<MaterialSettings> | ((current: MaterialSettings) => Partial<MaterialSettings>), options?: EditOptions): Promise<boolean> {
  const doc = openAssetDocument<MaterialSettings>(project, path, "material");
  const settings = doc.value.peek();
  const next = { ...settings, ...(typeof patch === "function" ? patch(settings) : patch) };
  if (sameMaterial(next, settings) || doc.readOnly) {
    if (doc.readOnly) doc.edit(next);
    return false;
  }
  doc.edit(next, options);
  if (!options?.coalesce) await doc.flush(); // a drag writes after its pause
  return true;
}

/** Where New Material goes by default: `materials/` if the project has it, else the folder given. */
export function materialFolder(folder: string): string {
  return folder === "" && editor.project.current?.folders.includes("materials") ? "materials" : folder;
}

/**
 * Create `New Material.material.json` (or `New Material 2`…) in `folder`: the default lit
 * material. Returns its path, or null if the project is read-only or writing failed.
 */
export async function createMaterial(folder: string): Promise<string | null> {
  return editor.project.createFile({ folder: materialFolder(folder), name: "New Material.material.json", what: "materials", write: (project, path) => writeMaterial(project, path, defaultMaterialSettings()) });
}

/** A shader asset (`*.shader.json`, ADR 0106) as its file holds it now; the default one if it can't be read. */
export function readShaderAsset(project: EditorProject, path: string): { shader: ShaderAsset; problems: string[] } {
  try {
    return parseShaderAsset(project.assets.get(path), path);
  } catch (err) {
    return { shader: defaultShaderAsset(), problems: [(err as Error).message] };
  }
}

/**
 * A material's keyword values with `name` set to `value`; a value equal to the keyword's default
 * (off, or an enum's first value) is left out so the file stays minimal.
 */
export function withKeywordValue(keywords: Readonly<Record<string, KeywordValue>>, keyword: ShaderKeyword, value: KeywordValue): Record<string, KeywordValue> {
  const out = { ...keywords };
  const isDefault = keyword.values ? value === keyword.values[0] : value === false;
  if (isDefault) delete out[keyword.name];
  else out[keyword.name] = value;
  return out;
}
