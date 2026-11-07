/**
 * Material assets (ADR 0043): `*.material.json` files a MeshRenderer draws with. They describe the
 * engine's default lit material (physically based: colour, metalness, roughness) or an unlit one.
 *
 * ```jsonc
 * {
 *   "format": "myco.material@1",
 *   "shader": "lit",                    // "lit" (default) | "unlit" | "physical" (ADR 0052) | a shader graph's path (ADR 0047)
 *   "color": "#ffffffff",               // base colour, #rrggbb or #rrggbbaa; alpha < 1 is see-through
 *   "texture": "asset:textures/a.png",  // base colour texture, multiplied by color (default none)
 *   "tiling": [1, 1],                   // how often the textures repeat across the mesh (default once)
 *   "normalMap": "",                    // lit: tangent-space normal map (default none)
 *   "normalScale": 1,                   // lit: the normal map's strength
 *   "emissionMap": "", "emissionIntensity": 1,     // lit: emission texture (times emission) and a multiplier (HDR glow)
 *   "metalRoughMap": "",                // lit: roughness in green, metalness in blue (glTF's layout), times the factors
 *   "occlusionMap": "", "occlusionStrength": 1,    // lit: ambient occlusion in red
 *   "alphaMode": "auto", "alphaCutoff": 0.5,       // "auto" (blend when color alpha < 1) | "opaque" | "blend" | "mask" (cut out below alphaCutoff)
 *   "metalness": 0,                     // lit: 0 (default) … 1
 *   "roughness": 0.5,                   // lit: 0 (mirror) … 1 (default 0.5)
 *   "emission": "#000000",              // lit: light the surface gives off (default none)
 *   "clearcoat": 0, "clearcoatRoughness": 0,        // physical only: 0 … 1 (defaults 0, 0)
 *   "sheen": 0, "sheenColor": "#ffffff", "sheenRoughness": 1, // physical only
 *   "transmission": 0, "thickness": 0, "ior": 1.5,  // physical only: glass; thickness >= 0, ior 1 … 2.333
 *   "iridescence": 0, "iridescenceIOR": 1.3,        // physical only: 0 … 1, 1 … 2.333
 *   "anisotropy": 0, "anisotropyRotation": 0,       // physical only: 0 … 1, degrees
 *   "specularIntensity": 1, "specularColor": "#ffffff", // physical only: 0 … 1
 *   "attenuationColor": "#ffffff", "attenuationDistance": 0, // physical only: glass tint reached after that many metres (0: none)
 *   "iridescenceThicknessMin": 100, "iridescenceThicknessMax": 400, // physical only: film thickness range, nanometres
 *   "clearcoatMap": "", "clearcoatNormalMap": "", "clearcoatNormalScale": 1, … // physical only: each layer's texture (ADR 0118, MATERIAL_MAPS)
 *   "doubleSided": false,               // draw back faces too (default false)
 *   "fog": true,                        // take the World's Fog (default true; false for glows, ADR 0071)
 *   "properties": { "Tint": "#ff0000" }, // shader graph and shader asset materials: values for the shader's properties
 *   "keywords": { "RIM": true },         // shader graph and shader asset materials: keyword values (ADR 0106)
 *   "instancing": "auto"                 // "auto" (default) | "thin" | "off": how renderers batch (ADR 0108)
 * }
 * ```
 *
 * A material whose shader is a shader graph or a hand-written shader asset (`*.shader.json`, ADR 0106) draws with it; the fixed fields (colour,
 * texture, metalness…) don't apply to it, and `properties` override the graph's defaults by name.
 */
import { Color } from "../core/math";
import { isShaderAssetPath } from "./shaderAsset";
import { isShaderGraphPath, type GraphValue } from "./shaderGraph";
import { parseKeywordValues, type KeywordValue } from "./shaderKeywords";

export const MATERIAL_FORMAT = "myco.material@1";
export const MATERIAL_SUFFIX = ".material.json";

/** True for a material asset path. */
export const isMaterialPath = (path: string): boolean => path.toLowerCase().endsWith(MATERIAL_SUFFIX);

/** `lit`, `unlit`, `physical`, or the path of a shader graph or shader asset (`asset:shaders/water.shadergraph.json`, `asset:shaders/rim.shader.json`). */
export type MaterialShader = "lit" | "unlit" | "physical" | (string & {});

/** The shader graph or shader asset a material draws with, or null for the built-in shaders. */
export const materialGraph = (settings: Pick<MaterialSettings, "shader">): string | null => (settings.shader !== "lit" && settings.shader !== "unlit" && settings.shader !== "physical" ? settings.shader : null);

const graphOfRaw = new WeakMap<object, string | null>();

/**
 * The shader graph a material asset's JSON names (`materialGraph` of its parsed settings), or null:
 * none, or JSON that doesn't parse. Cached per JSON object, since `Assets.json` hands out the same
 * object until the file changes: the renderers ask for every MeshRenderer every frame.
 */
export function materialGraphOfJson(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  let graph = graphOfRaw.get(raw);
  if (graph === undefined) {
    try {
      graph = materialGraph(parseMaterial(raw).settings);
    } catch {
      graph = null;
    }
    graphOfRaw.set(raw, graph);
  }
  return graph;
}

/**
 * The texture slots of the built-in shaders beyond `texture` and `normalMap` (ADR 0118), with glTF's
 * channel layout so a model's materials extract without loss. `srgb`: a colour texture (the rest are data).
 */
export const MATERIAL_MAPS = [
  { key: "emissionMap", label: "Emission Map", shader: "lit", srgb: true },
  { key: "metalRoughMap", label: "Metal/Rough Map", shader: "lit", srgb: false },
  { key: "occlusionMap", label: "Occlusion Map", shader: "lit", srgb: false },
  { key: "clearcoatMap", label: "Clearcoat Map", shader: "physical", group: "Clearcoat", srgb: false },
  { key: "clearcoatRoughnessMap", label: "Clearcoat Roughness Map", shader: "physical", group: "Clearcoat", srgb: false },
  { key: "clearcoatNormalMap", label: "Clearcoat Normal Map", shader: "physical", group: "Clearcoat", srgb: false },
  { key: "sheenColorMap", label: "Sheen Color Map", shader: "physical", group: "Sheen", srgb: true },
  { key: "sheenRoughnessMap", label: "Sheen Roughness Map", shader: "physical", group: "Sheen", srgb: false },
  { key: "transmissionMap", label: "Transmission Map", shader: "physical", group: "Transmission", srgb: false },
  { key: "thicknessMap", label: "Thickness Map", shader: "physical", group: "Transmission", srgb: false },
  { key: "iridescenceMap", label: "Iridescence Map", shader: "physical", group: "Iridescence", srgb: false },
  { key: "iridescenceThicknessMap", label: "Iridescence Thickness Map", shader: "physical", group: "Iridescence", srgb: false },
  { key: "anisotropyMap", label: "Anisotropy Map", shader: "physical", group: "Anisotropy", srgb: false },
  { key: "specularIntensityMap", label: "Specular Intensity Map", shader: "physical", group: "Specular", srgb: false },
  { key: "specularColorMap", label: "Specular Color Map", shader: "physical", group: "Specular", srgb: true },
] as const satisfies readonly { key: string; label: string; shader: "lit" | "physical"; group?: string; srgb: boolean }[];
export type MaterialMapKey = (typeof MATERIAL_MAPS)[number]["key"];

/** How a material's alpha is used: `auto` blends when the colour's alpha is below 1 (ADR 0043); `mask` cuts out below `alphaCutoff`. */
export type MaterialAlphaMode = "auto" | "opaque" | "blend" | "mask";

/** A material asset's settings. */
export interface MaterialSettings extends Record<MaterialMapKey, string> {
  shader: MaterialShader;
  /** Base colour; its alpha below 1 makes the material see-through. */
  color: Color;
  /** Base colour texture (`asset:` path), or empty for none. */
  texture: string;
  /** Texture repeats across the mesh's UVs, `[x, y]`. */
  tiling: [number, number];
  /** Tangent-space normal map (`asset:` path), or empty for none. Lit only. */
  normalMap: string;
  metalness: number;
  roughness: number;
  /** Emitted colour (black: none). Lit only. */
  emission: Color;
  /** Multiplies the emission (above 1 for HDR glow, as glTF's emissive strength). Lit only. */
  emissionIntensity: number;
  /** The normal map's strength. */
  normalScale: number;
  /** The occlusion map's strength, 0–1. */
  occlusionStrength: number;
  alphaMode: MaterialAlphaMode;
  /** `mask`: alpha below this is cut out. */
  alphaCutoff: number;
  /** The clearcoat normal map's strength. Physical only. */
  clearcoatNormalScale: number;
  /** Physical only: the colour light inside a transmissive volume turns after `attenuationDistance` metres (0: no tint). */
  attenuationColor: Color;
  attenuationDistance: number;
  /** Physical only: iridescence film thickness range in nanometres (the thickness map picks between them). */
  iridescenceThicknessMin: number;
  iridescenceThicknessMax: number;
  /** Physical only: clear lacquer layer strength, 0–1, and its roughness. */
  clearcoat: number;
  clearcoatRoughness: number;
  /** Physical only: cloth-like sheen strength 0–1, its tint and roughness. */
  sheen: number;
  sheenColor: Color;
  sheenRoughness: number;
  /** Physical only: how see-through (glass) 0–1, the volume's thickness (>= 0) and index of refraction (1–2.333). */
  transmission: number;
  thickness: number;
  ior: number;
  /** Physical only: thin-film rainbow 0–1 and the film's index of refraction (1–2.333). */
  iridescence: number;
  iridescenceIOR: number;
  /** Physical only: brushed-metal stretch 0–1 and its rotation in degrees. */
  anisotropy: number;
  anisotropyRotation: number;
  /** Physical only: strength 0–1 and tint of the specular reflection. */
  specularIntensity: number;
  specularColor: Color;
  doubleSided: boolean;
  /** Take the World's Fog (ADR 0071). */
  fog: boolean;
  /** Shader graph materials: values for the graph's properties, by name (the rest use the graph's defaults). */
  properties: Record<string, GraphValue>;
  /** Shader graph and shader asset materials: keyword values by name (the rest use their defaults, ADR 0106). */
  keywords: Record<string, KeywordValue>;
  /** How renderers drawing this material batch (ADR 0108): instanced (default), one thin-instance buffer, or one mesh each. */
  instancing: MaterialInstancing;
}

export type MaterialInstancing = "auto" | "thin" | "off";

export const defaultMaterialSettings = (): MaterialSettings => ({
  ...(Object.fromEntries(MATERIAL_MAPS.map((m) => [m.key, ""])) as Record<MaterialMapKey, string>),
  emissionIntensity: 1,
  normalScale: 1,
  occlusionStrength: 1,
  alphaMode: "auto",
  alphaCutoff: 0.5,
  clearcoatNormalScale: 1,
  attenuationColor: Color.white,
  attenuationDistance: 0,
  iridescenceThicknessMin: 100,
  iridescenceThicknessMax: 400,
  shader: "lit",
  color: Color.white,
  texture: "",
  tiling: [1, 1],
  normalMap: "",
  metalness: 0,
  roughness: 0.5,
  emission: Color.black,
  clearcoat: 0,
  clearcoatRoughness: 0,
  sheen: 0,
  sheenColor: Color.white,
  sheenRoughness: 1,
  transmission: 0,
  thickness: 0,
  ior: 1.5,
  iridescence: 0,
  iridescenceIOR: 1.3,
  anisotropy: 0,
  anisotropyRotation: 0,
  specularIntensity: 1,
  specularColor: Color.white,
  doubleSided: false,
  fog: true,
  properties: {},
  keywords: {},
  instancing: "auto",
});

type PhysicalNumberKey = "clearcoat" | "clearcoatRoughness" | "sheen" | "sheenRoughness" | "transmission" | "thickness" | "ior" | "iridescence" | "iridescenceIOR" | "anisotropy" | "specularIntensity";
/** Numbers of ADR 0118 with their allowed range. */
const EXTRA_NUMBERS: readonly { key: "emissionIntensity" | "normalScale" | "occlusionStrength" | "alphaCutoff" | "clearcoatNormalScale" | "attenuationDistance" | "iridescenceThicknessMin" | "iridescenceThicknessMax"; min: number; max: number; expected: string }[] = [
  { key: "emissionIntensity", min: 0, max: Infinity, expected: "a number of 0 or more" },
  { key: "normalScale", min: -Infinity, max: Infinity, expected: "a number" },
  { key: "occlusionStrength", min: 0, max: 1, expected: "a number from 0 to 1" },
  { key: "alphaCutoff", min: 0, max: 1, expected: "a number from 0 to 1" },
  { key: "clearcoatNormalScale", min: -Infinity, max: Infinity, expected: "a number" },
  { key: "attenuationDistance", min: 0, max: Infinity, expected: "a number of 0 or more (0: no tint)" },
  { key: "iridescenceThicknessMin", min: 0, max: Infinity, expected: "a number of nanometres" },
  { key: "iridescenceThicknessMax", min: 0, max: Infinity, expected: "a number of nanometres" },
];
const PHYSICAL_UNIT_KEYS: PhysicalNumberKey[] = ["clearcoat", "clearcoatRoughness", "sheen", "sheenRoughness", "transmission", "iridescence", "anisotropy", "specularIntensity"];
const PHYSICAL_NUMBER_KEYS: (PhysicalNumberKey | "anisotropyRotation")[] = [...PHYSICAL_UNIT_KEYS, "thickness", "ior", "iridescenceIOR", "anisotropyRotation"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Read a material file's parsed JSON, with defaults for anything missing; bad values are skipped
 * and listed in `problems`. Throws for something that isn't a material of this format.
 */
export function parseMaterial(raw: unknown, where = "material"): { settings: MaterialSettings; problems: string[] } {
  const settings = defaultMaterialSettings();
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${MATERIAL_FORMAT}".`);
  if (raw.format !== MATERIAL_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${MATERIAL_FORMAT}".`);
  const bad = (key: string, expected: string) => problems.push(`${where}: "${key}" should be ${expected}; using the default.`);
  const color = (key: string, fallback: Color): Color => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (typeof v === "string" && HEX.test(v)) return Color.from(v);
    if (Array.isArray(v) && v.length >= 3 && v.length <= 4 && v.every((n) => typeof n === "number" && Number.isFinite(n))) return Color.from(v as number[]);
    bad(key, 'a colour such as "#ff8800"');
    return fallback;
  };
  const unit = (key: "metalness" | "roughness") => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === "number" && v >= 0 && v <= 1) settings[key] = v;
    else bad(key, "a number from 0 to 1");
  };
  const ranged = (key: PhysicalNumberKey, min: number, max: number, expected: string) => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === "number" && v >= min && v <= max) settings[key] = v;
    else bad(key, expected);
  };
  const path = (key: "texture" | "normalMap") => {
    const v = raw[key];
    if (v === undefined) return;
    if (typeof v === "string") settings[key] = v;
    else bad(key, "an asset path");
  };
  if (raw.shader !== undefined) {
    if (raw.shader === "lit" || raw.shader === "unlit" || raw.shader === "physical" || (typeof raw.shader === "string" && (isShaderGraphPath(raw.shader) || isShaderAssetPath(raw.shader)))) settings.shader = raw.shader;
    else bad("shader", '"lit", "unlit", "physical", a shader graph (*.shadergraph.json) or a shader asset (*.shader.json)');
  }
  if (raw.properties !== undefined) {
    if (isObject(raw.properties)) {
      for (const [name, v] of Object.entries(raw.properties)) {
        const ok = typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((n) => typeof n === "number" && Number.isFinite(n)));
        if (ok) settings.properties[name] = Array.isArray(v) ? [...v] : (v as GraphValue);
        else problems.push(`${where}: property "${name}" should be a number, 2–4 numbers, a colour or a texture path; using the graph's default.`);
      }
    } else bad("properties", "an object of property values by name");
  }
  settings.color = color("color", settings.color);
  settings.emission = color("emission", settings.emission);
  path("texture");
  path("normalMap");
  for (const { key } of MATERIAL_MAPS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "string") settings[key] = v;
    else bad(key, "an asset path");
  }
  for (const { key, min, max, expected } of EXTRA_NUMBERS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) settings[key] = v;
    else bad(key, expected);
  }
  if (raw.alphaMode !== undefined) {
    if (raw.alphaMode === "auto" || raw.alphaMode === "opaque" || raw.alphaMode === "blend" || raw.alphaMode === "mask") settings.alphaMode = raw.alphaMode;
    else bad("alphaMode", '"auto", "opaque", "blend" or "mask"');
  }
  settings.attenuationColor = color("attenuationColor", settings.attenuationColor);
  unit("metalness");
  unit("roughness");
  for (const key of PHYSICAL_UNIT_KEYS) ranged(key, 0, 1, "a number from 0 to 1");
  ranged("thickness", 0, Infinity, "a number of 0 or more");
  ranged("ior", 1, 2.333, "a number from 1 to 2.333");
  ranged("iridescenceIOR", 1, 2.333, "a number from 1 to 2.333");
  const anisotropyRotation = raw.anisotropyRotation;
  if (anisotropyRotation !== undefined) {
    if (typeof anisotropyRotation === "number" && Number.isFinite(anisotropyRotation)) settings.anisotropyRotation = anisotropyRotation;
    else bad("anisotropyRotation", "a number of degrees");
  }
  settings.sheenColor = color("sheenColor", settings.sheenColor);
  settings.specularColor = color("specularColor", settings.specularColor);
  if (raw.tiling !== undefined) {
    const t = raw.tiling;
    if (Array.isArray(t) && t.length === 2 && t.every((n) => typeof n === "number" && Number.isFinite(n) && n !== 0)) settings.tiling = [t[0], t[1]];
    else bad("tiling", "[x, y], two non-zero numbers");
  }
  if (raw.fog !== undefined) {
    if (typeof raw.fog === "boolean") settings.fog = raw.fog;
    else bad("fog", "true or false");
  }
  if (raw.doubleSided !== undefined) {
    if (typeof raw.doubleSided === "boolean") settings.doubleSided = raw.doubleSided;
    else bad("doubleSided", "true or false");
  }
  settings.keywords = parseKeywordValues(raw.keywords, where, problems);
  if (raw.instancing !== undefined) {
    if (raw.instancing === "auto" || raw.instancing === "thin" || raw.instancing === "off") settings.instancing = raw.instancing;
    else bad("instancing", '"auto", "thin" or "off"');
  }
  return { settings, problems };
}

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
export function colorHex(c: Color): string {
  const a = Math.round(Math.min(1, Math.max(0, c.a)) * 255);
  return a === 255 ? c.toHex() : `${c.toHex()}${a.toString(16).padStart(2, "0")}`;
}

/** A material file's JSON: the format, then only what differs from the defaults. */
export function materialJSON(settings: MaterialSettings): Record<string, unknown> {
  const d = defaultMaterialSettings();
  const out: Record<string, unknown> = { format: MATERIAL_FORMAT };
  if (settings.shader !== d.shader) out.shader = settings.shader;
  if (colorHex(settings.color) !== colorHex(d.color)) out.color = colorHex(settings.color);
  if (settings.texture) out.texture = settings.texture;
  if (settings.tiling[0] !== 1 || settings.tiling[1] !== 1) out.tiling = [...settings.tiling];
  if (settings.normalMap) out.normalMap = settings.normalMap;
  if (settings.metalness !== d.metalness) out.metalness = settings.metalness;
  if (settings.roughness !== d.roughness) out.roughness = settings.roughness;
  if (colorHex(settings.emission) !== colorHex(d.emission)) out.emission = colorHex(settings.emission);
  for (const key of PHYSICAL_NUMBER_KEYS) if (settings[key] !== d[key]) out[key] = settings[key];
  if (colorHex(settings.sheenColor) !== colorHex(d.sheenColor)) out.sheenColor = colorHex(settings.sheenColor);
  if (colorHex(settings.specularColor) !== colorHex(d.specularColor)) out.specularColor = colorHex(settings.specularColor);
  for (const { key } of MATERIAL_MAPS) if (settings[key]) out[key] = settings[key];
  for (const { key } of EXTRA_NUMBERS) if (settings[key] !== d[key]) out[key] = settings[key];
  if (settings.alphaMode !== d.alphaMode) out.alphaMode = settings.alphaMode;
  if (colorHex(settings.attenuationColor) !== colorHex(d.attenuationColor)) out.attenuationColor = colorHex(settings.attenuationColor);
  if (settings.doubleSided) out.doubleSided = true;
  if (!settings.fog) out.fog = false;
  if (Object.keys(settings.keywords).length) out.keywords = { ...settings.keywords };
  if (settings.instancing !== "auto") out.instancing = settings.instancing;
  if (Object.keys(settings.properties).length) out.properties = Object.fromEntries(Object.entries(settings.properties).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  return out;
}

/** Material file text: two-space JSON with number lists on one line. */
export function formatMaterial(settings: MaterialSettings): string {
  const text = JSON.stringify(materialJSON(settings), null, 2).replace(/\[\s+([-\d.e+,\s]+?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s*/).join(", ")}]`);
  return `${text}\n`;
}
