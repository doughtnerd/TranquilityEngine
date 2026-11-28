// Extracting a model's materials (ADR 0089): each of the model's own materials becomes a material
// asset in a folder beside it, its embedded textures become image files, and the model's import
// settings map each material's name to its new asset, so renderers draw the extracted assets and
// they can be edited like any other material. The Meshes plugin's model import settings offer it.
import { Assets } from "../engine/scene/Assets";
import { formatMaterial } from "../engine/scene/material";
import { loadMeshes, materialSlots, DEFAULT_SLOT, type TextureInfo } from "../engine/scene/models";
import { fileName, folderOf } from "./projectPath";
import { readImportSettings, writeImportSettings } from "./assetImport";
import type { EditorProject } from "./projects";
import { readOnlyMessage } from "./readOnly";
import { materialFromSurface } from "./surfaceMaterial";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/ktx2": "ktx2", "image/avif": "avif", "image/gif": "gif" };

/** A file-system-safe name. */
const safe = (name: string) => name.replace(/[\\/:*?"<>|#]/g, "_").trim() || "Material";

export interface ExtractResult {
  /** Material assets written, by the model material's name. */
  materials: Record<string, string>;
  /** Images written for textures embedded in the model. */
  images: string[];
  /** What some materials lost, one line per material. */
  lost: string[];
}

/**
 * Extract every material of the model at `modelPath` into `<folder>/<model> Materials/`, and point
 * the model's import settings at them (existing mappings are replaced). Throws for a read-only
 * project or a model that doesn't load.
 */
export async function extractModelMaterials(project: EditorProject, modelPath: string): Promise<ExtractResult> {
  if (!project.canSave) throw new Error(readOnlyMessage(project, "extract materials"));
  const slots = materialSlots(await loadMeshes(`asset:${modelPath}`)).filter((s) => s.surface !== DEFAULT_SLOT);
  if (!slots.length) throw new Error(`${fileName(modelPath)} has no materials of its own.`);
  const base = fileName(modelPath).replace(/\.[^.]+$/, "");
  const folder = [folderOf(modelPath), `${base} Materials`].filter(Boolean).join("/");
  if (!project.folders.includes(folder)) await project.createFolder(folder);
  // Each project file's URL, to recognise textures the model takes from the project.
  const byUrl = new Map<string, string>();
  for (const f of project.files) {
    try {
      byUrl.set(Assets.url(f), f);
    } catch {
      // not served
    }
  }
  const images: string[] = [];
  const written = new Map<string, string>();
  const result: ExtractResult = { materials: {}, images, lost: [] };
  const used = new Set<string>();
  for (const slot of slots) {
    let name = safe(slot.name);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${safe(slot.name)} ${n}`;
    used.add(name.toLowerCase());
    // Textures: kept as the project file they are, or written out once from the model's bytes.
    const pending: Promise<void>[] = [];
    const textureFor = (role: string) => (info: TextureInfo): string => {
      if (info.path && project.files.includes(info.path)) return `asset:${info.path}`;
      const src = info.src ?? (info.bytes ? `bytes:${slot.name}:${role}` : null);
      if (!src) return "";
      const own = byUrl.get(src);
      if (own) return `asset:${own}`;
      const done = written.get(src);
      if (done) return `asset:${done}`;
      if (!info.bytes && !/^(data|blob):/.test(src)) return "";
      const ext = EXTENSIONS[info.mimeType ?? ""] ?? "png";
      const path = `${folder}/${name} ${role}.${ext}`;
      written.set(src, path);
      pending.push(
        (info.bytes ? Promise.resolve(info.bytes) : fetch(src).then(async (r) => new Uint8Array(await r.arrayBuffer())))
          .then((b) => project.writeBinary(path, b))
          .then(() => void images.push(path)),
      );
      return `asset:${path}`;
    };
    const surface = slot.surface;
    const { settings: color, lost } = materialFromSurface(surface, (info, role) => textureFor(role)(info));
    await Promise.all(pending);
    const path = `${folder}/${name}.material.json`;
    await project.writeText(path, formatMaterial(color));
    result.materials[slot.name] = `asset:${path}`;
    if (lost.length) result.lost.push(`${slot.name}: ${lost.join(", ")}`);
  }
  const { settings } = readImportSettings(project, modelPath);
  await writeImportSettings(project, modelPath, { ...settings, materials: { ...settings.materials, ...result.materials } });
  return result;
}
