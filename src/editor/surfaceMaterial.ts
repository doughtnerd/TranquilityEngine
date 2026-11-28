// A model surface as material asset settings (ADR 0089, 0118): the conversion materialExtract.ts
// uses when it extracts a model's materials. Pure: it reads the surface and names textures through
// the caller's function.
import { linearToSrgb } from "../engine/core/colorSpace";
import { Color } from "../engine/core/math";
import { MATERIAL_MAPS, defaultMaterialSettings, type MaterialMapKey, type MaterialSettings } from "../engine/scene/material";
import type { SurfaceInfo, TextureInfo } from "../engine/scene/models";

/** Linear channels in sRGB (material assets store sRGB colours; model surfaces are linear). */
const srgb = (rgb: readonly number[], a = 1) => new Color(linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2]), a);

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
