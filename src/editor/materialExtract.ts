// Extracting a model's materials (ADR 0089): each of the model's own materials becomes a material
// asset in a folder beside it, its embedded textures become image files, and the model's import
// settings map each material's name to its new asset, so renderers draw the extracted assets and
// they can be edited like any other material. The Meshes plugin's model import settings offer it.
import { Color } from "../engine/core/math";
import { Assets } from "../engine/scene/Assets";
import { MATERIAL_MAPS, defaultMaterialSettings, formatMaterial, type MaterialMapKey, type MaterialSettings } from "../engine/scene/material";
import { loadMeshes, materialSlots, DEFAULT_SLOT, type SurfaceInfo, type TextureInfo } from "../engine/scene/models";
import { fileName, folderOf } from "./assetBrowser";
import { readImportSettings, writeImportSettings } from "./assetImport";
import type { EditorProject } from "./projects";

/** One linear channel in sRGB (material assets store sRGB colours; model surfaces are linear). */
const toSrgb = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};
const srgb = (rgb: readonly number[], a = 1) => new Color(toSrgb(rgb[0]), toSrgb(rgb[1]), toSrgb(rgb[2]), a);

/** What extracting a surface keeps and loses. */
export interface ExtractedMaterial {
  settings: MaterialSettings;
  /** Parts of the model's material a material asset can't hold (said in the status message). */
  lost: string[];
}

/**
 * A model surface as material asset settings (ADR 0089, 0118). `texture` gives each texture's asset
 * path for its role (empty when it can't be kept). Material assets hold everything a glTF surface
 * has but vertex colours (a mesh attribute, still drawn) and textures on the second UV set (material
 * textures read the first); those are listed in `lost`.
 */
export function materialFromSurface(surface: SurfaceInfo, texture: (info: TextureInfo, role: string) => string): ExtractedMaterial {
  const s = defaultMaterialSettings();
  const lost: string[] = [];
  const map = (info: TextureInfo | null | undefined, role: string, label: string): string => {
    if (!info) return "";
    if (info.uvSet) lost.push(`${label} (on the second UV set)`);
    return texture(info, role);
  };
  const blended = surface.alphaMode ? surface.alphaMode === "blend" : surface.transparent && surface.opacity < 1;
  s.color = srgb(surface.color, blended ? surface.opacity : 1);
  s.metalness = Math.min(1, Math.max(0, surface.metalness));
  s.roughness = Math.min(1, Math.max(0, surface.roughness));
  s.doubleSided = surface.doubleSided;
  s.texture = map(surface.map, "Color", "base colour map");
  s.normalMap = map(surface.normalMap, "Normal", "normal map");
  if (surface.normalScale !== undefined) s.normalScale = surface.normalScale;
  if (surface.emissive) {
    // HDR emission (glTF's emissive strength) as a colour within 0–1 times an intensity.
    const k = Math.max(1, ...surface.emissive);
    s.emission = srgb(surface.emissive.map((c) => c / k));
    s.emissionIntensity = k;
  }
  s.emissionMap = map(surface.emissiveMap, "Emission", "emission map");
  s.metalRoughMap = map(surface.metalRoughMap, "MetalRough", "metallic-roughness map");
  s.occlusionMap = map(surface.occlusionMap, "Occlusion", "occlusion map");
  if (surface.occlusionStrength !== undefined) s.occlusionStrength = Math.min(1, Math.max(0, surface.occlusionStrength));
  if (surface.alphaMode) s.alphaMode = surface.alphaMode;
  if (surface.alphaMode === "mask") s.alphaCutoff = surface.alphaCutoff ?? 0.5;
  if (surface.unlit) s.shader = "unlit";
  else if (surface.physical) {
    const p = surface.physical;
    const layered =
      p.clearcoat > 0 || p.sheen > 0 || p.transmission > 0 || p.iridescence > 0 || p.specularIntensity !== 1 || p.ior !== 1.5 || p.specularColor.some((c) => c !== 1) || p.anisotropy !== undefined || p.attenuationDistance !== undefined || Object.keys(surface.layerMaps ?? {}).length > 0;
    if (layered) {
      s.shader = "physical";
      s.clearcoat = p.clearcoat;
      s.clearcoatRoughness = p.clearcoatRoughness;
      s.sheen = Math.min(1, p.sheen);
      s.sheenColor = srgb(p.sheenColor);
      s.sheenRoughness = p.sheenRoughness;
      s.transmission = p.transmission;
      s.thickness = p.thickness;
      s.ior = Math.min(2.333, Math.max(1, p.ior));
      s.specularIntensity = Math.min(1, p.specularIntensity);
      s.specularColor = srgb(p.specularColor);
      s.iridescence = p.iridescence;
      s.iridescenceIOR = Math.min(2.333, Math.max(1, p.iridescenceIOR));
      if (p.iridescenceThickness) [s.iridescenceThicknessMin, s.iridescenceThicknessMax] = p.iridescenceThickness;
      if (p.attenuationDistance !== undefined && p.attenuationColor) {
        s.attenuationDistance = p.attenuationDistance;
        s.attenuationColor = srgb(p.attenuationColor);
      }
      if (p.anisotropy !== undefined) {
        s.anisotropy = Math.min(1, Math.max(0, p.anisotropy));
        s.anisotropyRotation = ((p.anisotropyRotation ?? 0) * 180) / Math.PI;
      }
      if (surface.clearcoatNormalScale !== undefined) s.clearcoatNormalScale = surface.clearcoatNormalScale;
      for (const [key, info] of Object.entries(surface.layerMaps ?? {}) as [string, TextureInfo][]) {
        const slot = `${key}Map` as MaterialMapKey;
        const label = MATERIAL_MAPS.find((m) => m.key === slot)?.label ?? slot;
        s[slot] = map(info, label.replace(/ Map$/, "").replace(/ /g, ""), label.toLowerCase());
      }
    }
  }
  return { settings: s, lost };
}

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
  if (!project.canSave) throw new Error(`${project.name} is read-only. Open a project folder (or copy the sample) to extract materials.`);
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
