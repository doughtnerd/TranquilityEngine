/**
 * Hand-written shader assets (ADR 0106): `*.shader.json` files describing a surface shader whose code
 * is WGSL (WebGPU) and/or GLSL ES 3.0 (WebGL2), in `.wgsl`/`.glsl` files or inline. Materials name one
 * as their `shader`, as they name a shader graph.
 *
 * ```jsonc
 * {
 *   "format": "myco.shader@1",
 *   "target": "lit",                 // "lit" (default) | "unlit"
 *   "surface": "opaque",             // "opaque" (default) | "transparent"
 *   "doubleSided": false,
 *   "properties": [{ "name": "Tint", "type": "color", "value": "#ffffff" }], // as in shader graphs
 *   "keywords": [{ "name": "RIM" }, { "name": "QUALITY", "values": ["LOW", "HIGH"], "variants": "all" }],
 *   "wgsl": "asset:shaders/rim.wgsl", // or { "code": "…" }
 *   "glsl": "asset:shaders/rim.glsl"  // or { "code": "…" }
 * }
 * ```
 *
 * The code's contract (functions it defines, the structs it gets) is in
 * `render/shaderGraph/shaderAsset.ts`, which compiles a shader asset for the material plugin.
 */
import { GRAPH_PROPERTY_TYPES, parseGraphProperties, type GraphProperty } from "./shaderGraph";
import { keywordsJSON, parseKeywords, type ShaderKeyword } from "./shaderKeywords";

export const SHADER_ASSET_FORMAT = "myco.shader@1";
export const SHADER_ASSET_SUFFIX = ".shader.json";

/** True for a shader asset path. */
export const isShaderAssetPath = (path: string): boolean => path.toLowerCase().endsWith(SHADER_ASSET_SUFFIX);

/** Code for one shading language: an asset path to a `.wgsl`/`.glsl` file, or inline text. */
export type ShaderCode = { file: string } | { code: string };

export interface ShaderAsset {
  target: "lit" | "unlit";
  surface: "opaque" | "transparent";
  doubleSided: boolean;
  properties: GraphProperty[];
  keywords: ShaderKeyword[];
  /** WGSL code, used on WebGPU; null for none. */
  wgsl: ShaderCode | null;
  /** GLSL ES 3.0 code, used on WebGL2; null for none. */
  glsl: ShaderCode | null;
}

export const defaultShaderAsset = (): ShaderAsset => ({ target: "lit", surface: "opaque", doubleSided: false, properties: [], keywords: [], wgsl: null, glsl: null });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Property names are the code's uniform names, so they must be identifiers. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Read a shader asset's parsed JSON leniently (defaults for what's missing or bad, listed in `problems`). Throws for something that isn't one. */
export function parseShaderAsset(raw: unknown, where = "shader"): { shader: ShaderAsset; problems: string[] } {
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${SHADER_ASSET_FORMAT}".`);
  if (raw.format !== SHADER_ASSET_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${SHADER_ASSET_FORMAT}".`);
  const problems: string[] = [];
  const shader = defaultShaderAsset();
  if (raw.target !== undefined) {
    if (raw.target === "lit" || raw.target === "unlit") shader.target = raw.target;
    else problems.push(`${where}: "target" should be "lit" or "unlit"; using "lit".`);
  }
  if (raw.surface !== undefined) {
    if (raw.surface === "opaque" || raw.surface === "transparent") shader.surface = raw.surface;
    else problems.push(`${where}: "surface" should be "opaque" or "transparent"; using "opaque".`);
  }
  if (raw.doubleSided !== undefined) {
    if (typeof raw.doubleSided === "boolean") shader.doubleSided = raw.doubleSided;
    else problems.push(`${where}: "doubleSided" should be true or false.`);
  }
  shader.properties = parseGraphProperties(raw.properties, where, problems).filter((p) => {
    if (IDENT.test(p.name)) return true;
    problems.push(`${where}: property "${p.name}" isn't a name code can use (letters, digits, _); skipped.`);
    return false;
  });
  shader.keywords = parseKeywords(raw.keywords, where, problems);
  const code = (key: "wgsl" | "glsl"): ShaderCode | null => {
    const v = raw[key];
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "string") return { file: v };
    if (isObject(v) && typeof v.code === "string") return { code: v.code };
    if (isObject(v) && typeof v.file === "string") return { file: v.file };
    problems.push(`${where}: "${key}" should be a file's asset path or { "code": "…" }; ignored.`);
    return null;
  };
  shader.wgsl = code("wgsl");
  shader.glsl = code("glsl");
  if (!shader.wgsl && !shader.glsl) problems.push(`${where}: has no "wgsl" or "glsl" code; it draws as the default material.`);
  return { shader, problems };
}

/** A shader asset as file JSON: the format, then what differs from the defaults. */
export function shaderAssetJSON(shader: ShaderAsset): Record<string, unknown> {
  const out: Record<string, unknown> = { format: SHADER_ASSET_FORMAT };
  if (shader.target !== "lit") out.target = shader.target;
  if (shader.surface !== "opaque") out.surface = shader.surface;
  if (shader.doubleSided) out.doubleSided = true;
  out.properties = shader.properties.map((p) => ({ name: p.name, type: p.type, value: Array.isArray(p.value) ? [...p.value] : p.value }));
  if (shader.keywords.length) out.keywords = keywordsJSON(shader.keywords);
  const code = (c: ShaderCode | null) => (c ? ("file" in c ? c.file : { code: c.code }) : undefined);
  if (shader.wgsl) out.wgsl = code(shader.wgsl);
  if (shader.glsl) out.glsl = code(shader.glsl);
  return out;
}

/** Shader asset file text (two-space JSON). */
export function formatShaderAsset(shader: ShaderAsset): string {
  return `${JSON.stringify(shaderAssetJSON(shader), null, 2)}\n`;
}

/** The property types a shader asset may declare (as shader graphs). */
export const SHADER_ASSET_PROPERTY_TYPES = GRAPH_PROPERTY_TYPES;
