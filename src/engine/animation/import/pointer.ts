/**
 * `KHR_animation_pointer` (ADR 0371 "Model import", owner 2026-11-22): which glTF properties a pointer channel can
 * animate, as the importer brings them in. `parsePointer` reads a JSON pointer into what it targets; the model import
 * binds that to its nodes (`models.ts`). Anything else is unmapped, and the import lists every unmapped pointer of a
 * file in one warning.
 *
 * | pointer | target | track | field |
 * |---|---|---|---|
 * | `/nodes/{n}/translation`, `rotation`, `scale` | the node or bone | as a TRS channel | |
 * | `/nodes/{n}/weights`, `/meshes/{m}/weights` | the node's mesh, every node using mesh m | `morph` | the target names |
 * | `/nodes/{n}/extensions/KHR_node_visibility/visible` | the node | `activation` | |
 * | `/materials/{i}/…` (the table below) | every mesh node drawing material i (glTF: a shared material changes every mesh using it) | `float` … `color` | `materials[{slot}].{field}` on `engine.MeshRenderer` |
 * | `/materials/{i}/…Texture/extensions/KHR_texture_transform/offset`, `scale`, `rotation` | as above; the material is flagged "animated texture transform" and keeps its transform live instead of baked into UVs | `vec2`, `float` | `materials[{slot}].textureTransform.offset` … |
 * | `/extensions/KHR_lights_punctual/lights/{l}/color`, `intensity`, `range`, `spot/innerConeAngle`, `spot/outerConeAngle` | every node holding light l | `color`, `float` | `engine.Light` `color`, `intensity`, `range`, `spotSoftness`, `spotAngle` |
 * | `/cameras/{c}/perspective/yfov`, `znear`, `zfar`; `/cameras/{c}/orthographic/ymag`, `znear`, `zfar` | every node holding camera c | `float` | `engine.Camera` `fieldOfView`, `near`, `far`, `orthographicSize` |
 *
 * Material fields are the built-in material properties (`render/materialResolution.ts`) where one exists (`color`,
 * `emission`, `metalness`, `roughness`, the physical layers'); the others take the glTF name (`alphaCutoff`,
 * `normalScale`, `occlusionStrength`, `clearcoatNormalScale`, `dispersion`). `emission` is the emissive colour times
 * its strength, as `SurfaceInfo.emissive` (so an animated factor or strength keys the product, the other part held at
 * its static value). Colours stay linear, as surfaces hold them (`SurfaceInfo`). The render sync that applies material, light and camera fields is T24's.
 *
 * Pure. Internal: not public API.
 */

/** @internal The value kinds a pointer animates (`width` numbers per key). */
export type PointerValue = { readonly track: "float" | "vec2" | "vec3" | "color"; readonly width: 1 | 2 | 3 | 4 };

/** @internal What a pointer targets. */
export type PointerTarget =
  | { readonly type: "node"; readonly node: number; readonly path: "translation" | "rotation" | "scale" | "weights" | "visible" }
  | { readonly type: "mesh"; readonly mesh: number }
  | { readonly type: "material"; readonly material: number; readonly field: string; readonly value: PointerValue; readonly textureTransform: boolean }
  | { readonly type: "light"; readonly light: number; readonly property: "color" | "intensity" | "range" | "innerConeAngle" | "outerConeAngle" }
  | { readonly type: "camera"; readonly camera: number; readonly property: "yfov" | "znear" | "zfar" | "ymag" };

const F: PointerValue = { track: "float", width: 1 };
const V2: PointerValue = { track: "vec2", width: 2 };
const V3: PointerValue = { track: "vec3", width: 3 };
const C4: PointerValue = { track: "color", width: 4 };

/** @internal Material properties by pointer suffix (after `/materials/{i}/`): the field and value kind. */
export const MATERIAL_POINTERS: Readonly<Record<string, { readonly field: string; readonly value: PointerValue }>> = Object.freeze({
  "pbrMetallicRoughness/baseColorFactor": { field: "color", value: C4 },
  "pbrMetallicRoughness/metallicFactor": { field: "metalness", value: F },
  "pbrMetallicRoughness/roughnessFactor": { field: "roughness", value: F },
  emissiveFactor: { field: "emission", value: V3 },
  "extensions/KHR_materials_emissive_strength/emissiveStrength": { field: "emission", value: F },
  alphaCutoff: { field: "alphaCutoff", value: F },
  "normalTexture/scale": { field: "normalScale", value: F },
  "occlusionTexture/strength": { field: "occlusionStrength", value: F },
  "extensions/KHR_materials_clearcoat/clearcoatFactor": { field: "clearcoat", value: F },
  "extensions/KHR_materials_clearcoat/clearcoatRoughnessFactor": { field: "clearcoatRoughness", value: F },
  "extensions/KHR_materials_clearcoat/clearcoatNormalTexture/scale": { field: "clearcoatNormalScale", value: F },
  "extensions/KHR_materials_sheen/sheenColorFactor": { field: "sheenColor", value: V3 },
  "extensions/KHR_materials_sheen/sheenRoughnessFactor": { field: "sheenRoughness", value: F },
  "extensions/KHR_materials_transmission/transmissionFactor": { field: "transmission", value: F },
  "extensions/KHR_materials_volume/thicknessFactor": { field: "thickness", value: F },
  "extensions/KHR_materials_volume/attenuationDistance": { field: "attenuationDistance", value: F },
  "extensions/KHR_materials_volume/attenuationColor": { field: "attenuationColor", value: V3 },
  "extensions/KHR_materials_ior/ior": { field: "ior", value: F },
  "extensions/KHR_materials_specular/specularFactor": { field: "specularIntensity", value: F },
  "extensions/KHR_materials_specular/specularColorFactor": { field: "specularColor", value: V3 },
  "extensions/KHR_materials_iridescence/iridescenceFactor": { field: "iridescence", value: F },
  "extensions/KHR_materials_iridescence/iridescenceIor": { field: "iridescenceIOR", value: F },
  "extensions/KHR_materials_iridescence/iridescenceThicknessMinimum": { field: "iridescenceThicknessMinimum", value: F },
  "extensions/KHR_materials_iridescence/iridescenceThicknessMaximum": { field: "iridescenceThicknessMaximum", value: F },
  "extensions/KHR_materials_anisotropy/anisotropyStrength": { field: "anisotropy", value: F },
  "extensions/KHR_materials_anisotropy/anisotropyRotation": { field: "anisotropyRotation", value: F },
  "extensions/KHR_materials_dispersion/dispersion": { field: "dispersion", value: F },
});

const TEXTURE_TRANSFORM: Record<string, PointerValue> = { offset: V2, scale: V2, rotation: F };

/**
 * A pointer's segments, or null if it doesn't start with `/`. JSON pointer escapes (`~1`, `~0`) are left as they are:
 * no property the table lists has `/` or `~` in its name, so an escaped segment never matches one.
 */
function segments(pointer: string): string[] | null {
  if (!pointer.startsWith("/")) return null;
  return pointer.slice(1).split("/");
}

const index = (s: string | undefined): number | null => (s !== undefined && /^(0|[1-9]\d*)$/.test(s) ? Number(s) : null);

/** @internal What a `KHR_animation_pointer` pointer targets, or null when the import doesn't map it. */
export function parsePointer(pointer: string): PointerTarget | null {
  const s = segments(pointer);
  if (!s || s.length < 3) return null;
  const i = index(s[1]);
  const rest = s.slice(2).join("/");
  if (s[0] === "nodes" && i !== null) {
    if (rest === "translation" || rest === "rotation" || rest === "scale" || rest === "weights") return { type: "node", node: i, path: rest };
    if (rest === "extensions/KHR_node_visibility/visible") return { type: "node", node: i, path: "visible" };
    return null;
  }
  if (s[0] === "meshes" && i !== null) return rest === "weights" ? { type: "mesh", mesh: i } : null;
  if (s[0] === "materials" && i !== null) {
    const m = MATERIAL_POINTERS[rest];
    if (m) return { type: "material", material: i, field: m.field, value: m.value, textureTransform: false };
    const tt = /^(?:.+\/)?\w+Texture\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/.exec(rest);
    if (tt) return { type: "material", material: i, field: `textureTransform.${tt[1]}`, value: TEXTURE_TRANSFORM[tt[1]], textureTransform: true };
    return null;
  }
  if (s[0] === "cameras" && i !== null) {
    if (rest === "perspective/yfov") return { type: "camera", camera: i, property: "yfov" };
    if (rest === "orthographic/ymag") return { type: "camera", camera: i, property: "ymag" };
    if (/^(perspective|orthographic)\/(znear|zfar)$/.test(rest)) return { type: "camera", camera: i, property: rest.endsWith("znear") ? "znear" : "zfar" };
    return null;
  }
  if (s[0] === "extensions" && s[1] === "KHR_lights_punctual" && s[2] === "lights") {
    const l = index(s[3]);
    const prop = s.slice(4).join("/");
    if (l === null) return null;
    if (prop === "color" || prop === "intensity" || prop === "range") return { type: "light", light: l, property: prop };
    if (prop === "spot/innerConeAngle") return { type: "light", light: l, property: "innerConeAngle" };
    if (prop === "spot/outerConeAngle") return { type: "light", light: l, property: "outerConeAngle" };
    return null;
  }
  return null;
}

/** @internal The unmapped-pointer warning of one file (null when every pointer mapped): one line listing them, each once. */
export function unmappedPointerWarning(pointers: readonly string[]): string | null {
  const list = [...new Set(pointers)];
  if (!list.length) return null;
  return `${list.length} animation pointer${list.length === 1 ? "" : "s"} target${list.length === 1 ? "s" : ""} properties the engine doesn't import, so ${list.length === 1 ? "it isn't" : "they aren't"} animated: ${list.join(", ")}.`;
}
