// Material assets in the editor (ADR 0043): creating `*.material.json` files, and reading and
// writing them for the Asset Inspector's material editor (ui/AssetInspector.tsx).
import { defaultMaterialSettings, formatMaterial, parseMaterial, type MaterialSettings } from "../engine/scene/material";
import { defaultShaderAsset, formatShaderAsset, parseShaderAsset, type ShaderAsset } from "../engine/scene/shaderAsset";
import type { KeywordValue, ShaderKeyword } from "../engine/scene/shaderKeywords";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { openAssetDocument, type EditOptions } from "./assetDocuments";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { materialFormat } from "./materialFormat";
import { assetFormats } from "./sdk/contributions";
import { currentProject, docVersion, status } from "./state";

// Registered here until the Materials plugin takes this over (ADR 0134).
if (!assetFormats.get("material")) assetFormats.register(materialFormat);

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

/** WGSL starter for New Shader: a `Tint` property sets the base colour. */
export const NEW_SHADER_WGSL = `// Properties are uniforms.<Name>. Keywords are #ifdef KW_<NAME>.
fn surface(s: MycoSurfaceInput, out: ptr<function, MycoSurface>) {
  (*out).baseColor = uniforms.Tint.rgb;
}
`;

/** GLSL ES 3.0 starter for New Shader, the same surface as the WGSL one. */
export const NEW_SHADER_GLSL = `// Properties are bare names. Keywords are #ifdef KW_<NAME>.
void surface(MycoSurfaceInput s, inout MycoSurface o) {
  o.baseColor = Tint.rgb;
}
`;

/** Where New Shader goes by default: `shaders/` if the project has it, else the folder given. */
export function shaderFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("shaders") ? "shaders" : folder;
}

/**
 * Create `New Shader.shader.json` (or `New Shader 2`…) with `New Shader.wgsl` and `New Shader.glsl`
 * beside it: a minimal surface shader with a `Tint` colour property. Returns the JSON's path, or
 * null if the project is read-only or writing failed.
 */
export async function createShader(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add shaders.` };
    return null;
  }
  const dir = shaderFolder(folder);
  const at = (stem: string, ext: string) => (dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`);
  const free = (stem: string) => [".shader.json", ".wgsl", ".glsl"].every((ext) => freePath(project, dir, `${stem}${ext}`) === at(stem, ext));
  let stem = "New Shader";
  for (let n = 2; !free(stem); n++) stem = `New Shader ${n}`;
  const path = at(stem, ".shader.json");
  const shader: ShaderAsset = {
    ...defaultShaderAsset(),
    properties: [{ name: "Tint", type: "color", value: "#ffffff" }],
    wgsl: { file: `asset:${at(stem, ".wgsl")}` },
    glsl: { file: `asset:${at(stem, ".glsl")}` },
  };
  try {
    await project.writeFile(at(stem, ".wgsl"), NEW_SHADER_WGSL);
    await project.writeFile(at(stem, ".glsl"), NEW_SHADER_GLSL);
    await project.writeText(path, formatShaderAsset(shader));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)} with its WGSL and GLSL code.` };
  return path;
}
