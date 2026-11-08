/**
 * @internal Renderer-neutral material resolution (ADR 0127). Answers "which material, which values, which
 * variant" for a material asset, a script Material or a MeshRenderer slot, and returns plain data: no
 * render backend types. A backend's material library (Babylon's: `render/babylon/materialLibrary.ts`)
 * builds its own materials and textures from what this returns, so a new renderer rewrites only that
 * adapter, not the policy here.
 *
 * It owns:
 * - reading and compiling a material asset, a shader graph (ADR 0047) or a shader asset (ADR 0106), and
 *   when that build is stale (the asset's JSON, the graph's JSON, sub-graph or code files, the shader
 *   level a Quality Branch compiled for, ADR 0050);
 * - material slots (ADR 0089): `materials[i]`, then `material`, then the model's import settings;
 * - script Material values over the asset's, and when a shared Material's version needs applying (ADR 0107);
 * - per-renderer property overrides (ADR 0049) and which property names a material has;
 * - keyword values and the variants warm-up draws (ADR 0106);
 * - the fog opt-out (ADR 0071) and `instancing` (ADR 0108);
 * - how an image's import settings sample it (ADR 0040) and how each use of a texture decodes it.
 */
import { Assets, normalizeAssetPath, sidecarValue } from "../scene/Assets";
import { splitSpriteRef, type ImportSettings } from "../scene/importSettings";
import { colorHex, defaultMaterialSettings, materialGraphOfJson, parseMaterial, type MaterialInstancing, type MaterialSettings } from "../scene/material";
import { isShaderAssetPath, parseShaderAsset } from "../scene/shaderAsset";
import { isShaderGraphPath, parseShaderGraph, type GraphValue } from "../scene/shaderGraph";
import { MAX_WARM_VARIANTS, resolveKeywords, warmKeywordVariants, type KeywordValue } from "../scene/shaderKeywords";
import { Color as EngineColor, Vector2 as EngineVector2, Vector3 as EngineVector3 } from "../core/math";
import type { ShaderLevel } from "../core/graphics";
import type { Material } from "./Material";
import type { MaterialPropertyValue } from "./components";
import { compileShaderGraph, type CompiledShaderGraph } from "./shaderGraph/compile";
import { compileShaderAsset, type ShaderAssetSources } from "./shaderGraph/shaderAsset";

/** A warning to show once: `key` dedupes it. */
export interface MaterialWarning {
  key: string;
  message: string;
}

/** Reads a project file: text files (a shader's `.wgsl`) as strings, others as JSON; undefined when missing. */
export type AssetRead = (path: string) => unknown;

/** Reads through `Assets`. Values compare by identity (JSON) or value (text), which is what staleness checks need. */
export const readAsset: AssetRead = (p) => {
  try {
    if (!Assets.has(p)) return undefined;
    const v = Assets.get(p);
    return typeof v === "string" ? v : Assets.json(p);
  } catch {
    return undefined;
  }
};

/** The shader code language a backend draws graphs in. */
export type ShaderTarget = "wgsl" | "glsl";

/** What a built material depends on: when any of it changes, the build is stale. */
export interface MaterialStamp {
  raw: unknown;
  graphRaw: unknown;
  /** Sub-graph and code files with the value they had (ADR 0048, 0106). */
  deps: readonly (readonly [string, unknown])[];
  /** The shader level a graph using Quality Branch nodes compiled for (ADR 0050); undefined when it doesn't care. */
  level: ShaderLevel | undefined;
}

/** A material asset (or a renderer naming a graph or shader directly), resolved. */
export interface ResolvedMaterial {
  path: string;
  /** The path for messages (no `asset:`). */
  where: string;
  /**
   * `none`: missing or not a material (the backend draws its default); `builtin`: a lit, unlit or
   * physical material (ADR 0043, 0052); `graph`: a shader graph or shader asset.
   */
  kind: "none" | "builtin" | "graph";
  /** The shader graph or shader asset it draws (kind `graph`), else null. */
  graph: string | null;
  /** The asset's parsed settings; null for a graph or shader named directly, or none. */
  settings: MaterialSettings | null;
  /** The compiled graph or shader asset (kind `graph`). */
  compiled: CompiledShaderGraph | null;
  /** The graph's own property values (the asset's `properties`). */
  properties: Record<string, GraphValue>;
  /** The keyword values it draws with (the asset's `keywords`). */
  keywords: Record<string, KeywordValue>;
  /** False when the asset opts out of the World's fog (ADR 0071). */
  fog: boolean;
  /** How renderers drawing it batch (ADR 0108). */
  instancing: MaterialInstancing;
  stamp: MaterialStamp;
  warnings: MaterialWarning[];
}

const where = (path: string) => path.replace(/^asset:/, "");

/** The graph or shader asset a material path draws: itself when it names one, else the material's `graph`. */
function graphPathOf(path: string, raw: unknown): string | null {
  if (isShaderGraphPath(path) || isShaderAssetPath(path)) return path;
  return raw !== undefined ? materialGraphOfJson(raw) : null;
}

/** The stamp a material path would have now (cheap: reads, no parse), to compare with a build's. */
export function isStampCurrent(stamp: MaterialStamp, path: string, shaderLevel: ShaderLevel, read: AssetRead = readAsset): boolean {
  const raw = read(path);
  if (raw !== stamp.raw) return false;
  const graphPath = graphPathOf(path, raw);
  if ((graphPath ? read(graphPath) : undefined) !== stamp.graphRaw) return false;
  if (stamp.level !== undefined && stamp.level !== shaderLevel) return false;
  return stamp.deps.every(([p, v]) => read(p) === v);
}

/**
 * Compile a shader graph (ADR 0047) or, with `shaderAsset`, a hand-written shader asset (ADR 0106),
 * whose code files are read with `read` and become dependencies. Problems come back as warnings.
 */
export function compileMaterialShader(graphRaw: unknown, graphWhere: string, shaderAsset: boolean, opts: { shaderLevel: ShaderLevel; target: ShaderTarget; read?: AssetRead }): { compiled: CompiledShaderGraph; warnings: MaterialWarning[] } {
  const read = opts.read ?? readAsset;
  const warnings: MaterialWarning[] = [];
  let compiled: CompiledShaderGraph;
  let problems: string[];
  if (shaderAsset) {
    const parsed = parseShaderAsset(graphRaw, graphWhere);
    problems = parsed.problems;
    const sources: ShaderAssetSources = {};
    const deps: string[] = [];
    for (const lang of ["wgsl", "glsl"] as const) {
      const code = parsed.shader[lang];
      if (!code) continue;
      if ("code" in code) sources[lang] = code.code;
      else {
        const file = normalizeAssetPath(code.file);
        deps.push(file);
        const text = read(file);
        if (typeof text === "string") sources[lang] = text;
        else problems.push(`${graphWhere}: its ${lang.toUpperCase()} file "${file}" isn't in the project.`);
      }
    }
    compiled = compileShaderAsset(parsed.shader, sources, deps);
    const webgpu = opts.target === "wgsl";
    if (webgpu ? compiled.noWgsl : !compiled.glsl) warnings.push({ key: `shader|lang|${graphWhere}`, message: `${graphWhere}: has no ${webgpu ? "WGSL" : "GLSL"} code for this ${webgpu ? "WebGPU" : "WebGL2"} engine; it draws as plain PBR.` });
  } else {
    const parsed = parseShaderGraph(graphRaw, graphWhere);
    problems = parsed.problems;
    compiled = compileShaderGraph(parsed.graph, { shaderLevel: opts.shaderLevel });
    if (opts.target !== "wgsl") warnings.push({ key: "graph|webgl", message: "shader graph materials need WebGPU; on the WebGL2 fallback they draw as plain PBR." });
  }
  for (const p of [...problems, ...compiled.problems.map((q) => `${graphWhere}: ${q}`)]) warnings.push({ key: p, message: p });
  return { compiled, warnings };
}

/**
 * Resolve a material asset path (or a shader graph or shader asset named directly) into what a backend
 * builds: its kind, settings, compiled graph, property and keyword values, fog and instancing, the stamp
 * that says when it's stale, and warnings (missing, malformed, unknown keywords). Never throws.
 */
export function resolveMaterial(path: string, opts: { shaderLevel: ShaderLevel; target: ShaderTarget; read?: AssetRead }): ResolvedMaterial {
  const read = opts.read ?? readAsset;
  const at = where(path);
  const raw = read(path);
  const graphPath = graphPathOf(path, raw);
  const graphRaw = graphPath ? read(graphPath) : undefined;
  const out: ResolvedMaterial = {
    path,
    where: at,
    kind: "none",
    graph: null,
    settings: null,
    compiled: null,
    properties: {},
    keywords: {},
    fog: true,
    instancing: "auto",
    stamp: { raw, graphRaw, deps: [], level: undefined },
    warnings: [],
  };
  if (raw === undefined) {
    out.warnings.push({ key: `missing|${path}`, message: `material "${at}" isn't in the project; using the default material.` });
    return out;
  }
  if (graphPath) {
    try {
      const settings = graphPath === path ? null : parseMaterial(raw, at).settings;
      out.settings = settings;
      if (graphRaw === undefined) throw new Error(`${isShaderAssetPath(graphPath) ? "shader" : "shader graph"} "${where(graphPath)}" isn't in the project.`);
      const { compiled, warnings } = compileMaterialShader(graphRaw, where(graphPath), isShaderAssetPath(graphPath), { ...opts, read });
      out.warnings.push(...warnings);
      out.compiled = compiled;
      out.kind = "graph";
      out.graph = graphPath;
      out.properties = { ...(settings?.properties ?? {}) };
      out.keywords = { ...(settings?.keywords ?? {}) };
      // Keyword values (ADR 0106): unknown names and values are warned once.
      resolveKeywords(compiled.keywords, out.keywords, (m) => out.warnings.push({ key: `${path}|kw|${m}`, message: `${at}: ${m}` }));
      out.stamp = { raw, graphRaw, deps: compiled.dependencies.map((p) => [p, read(p)] as const), level: compiled.usesShaderLevel ? opts.shaderLevel : undefined };
    } catch (err) {
      const message = `${at}: ${(err as Error).message} Using the default material.`;
      out.warnings.push({ key: message, message });
    }
  } else {
    try {
      const { settings, problems } = parseMaterial(raw, at);
      for (const p of problems) out.warnings.push({ key: `${path}|${p}`, message: p });
      out.settings = settings;
      out.kind = "builtin";
    } catch (err) {
      out.warnings.push({ key: `bad|${path}`, message: `${(err as Error).message} Using the default material.` });
    }
  }
  if (out.kind !== "none") {
    // A material can opt out of the World's Fog (ADR 0071).
    try {
      out.fog = parseMaterial(raw).settings.fog;
    } catch {
      /* warned above */
    }
  }
  out.instancing = out.settings?.instancing ?? "auto";
  return out;
}

/** A material's `instancing` (ADR 0108), with editor picking: thin batches draw as instances there, so each object can be picked. */
export function instancingFor(mode: MaterialInstancing | undefined, editorPicking: boolean): MaterialInstancing {
  const m = mode || "auto";
  return m === "thin" && editorPicking ? "auto" : m;
}

// --- Material slots (ADR 0089) ---------------------------------------------------------------------------

/** What draws a model mesh's slots: a MeshRenderer, or a warm-up mesh standing in for one (ADR 0080). */
export interface SlotRequest {
  /** The model (`asset:models/ship.glb`, `builtin:cube`). */
  mesh: string;
  /** The renderer-wide material asset ("" for none). */
  material: string;
  /** Per-slot material assets ("" or missing: that slot has none of its own). */
  materials?: readonly string[];
}

/**
 * Where a slot's material may come from, in order; the first that gives a material draws. `slot`: the
 * slot's own `materials[i]` (its script Material instance, else the asset); `renderer`: the renderer-wide
 * material (with ADR 0049's overrides); `model`: a material asset the model's import settings map the
 * surface to. After all of them, the model's own material.
 */
export type SlotSource = { from: "slot"; slot: number; path: string } | { from: "renderer" } | { from: "model"; path: string };

/** A model's import settings' material assets by surface name (ADR 0089), or null for a built-in mesh or none. */
export function modelMaterialMap(meshRef: string): Readonly<Record<string, string>> | null {
  if (!meshRef || meshRef.startsWith("builtin:")) return null;
  try {
    const materials = Assets.importSettings(splitSpriteRef(meshRef.replace(/^asset:/, "")).path).materials;
    return Object.keys(materials).length ? materials : null;
  } catch {
    return null;
  }
}

/** Each slot's sources, in order (see {@link SlotSource}), for slots with these surface names. */
export function slotSources(req: SlotRequest, surfaceNames: readonly string[]): SlotSource[][] {
  const remap = surfaceNames.length ? modelMaterialMap(req.mesh) : null;
  return surfaceNames.map((name, i) => {
    const out: SlotSource[] = [];
    const own = req.materials?.[i];
    if (own) out.push({ from: "slot", slot: i, path: own });
    out.push({ from: "renderer" });
    const mapped = remap?.[name];
    if (mapped) out.push({ from: "model", path: mapped });
    return out;
  });
}

/** The first source that gives a material, else null (the model's own material draws). */
export function pickSlot<T>(sources: readonly SlotSource[], get: (s: SlotSource) => T | null): T | null {
  for (const s of sources) {
    const m = get(s);
    if (m) return m;
  }
  return null;
}

/** The asset slot 0 draws, which says how a renderer batches (ADR 0108). */
export const instancingPath = (req: SlotRequest): string => req.materials?.[0] || req.material;

// --- Values: script Materials (ADR 0107) and renderer overrides (ADR 0049) -------------------------------

/** The built-in materials' property names (ADR 0049). */
export const BUILTIN_PROPERTIES: ReadonlySet<string> = new Set([
  "color", "emission", "metalness", "roughness", "texture",
  "clearcoat", "clearcoatRoughness", "sheen", "sheenColor", "sheenRoughness", "transmission", "thickness", "ior",
  "iridescence", "iridescenceIOR", "anisotropy", "anisotropyRotation", "specularIntensity", "specularColor",
]);

/** A script value as material-file data: colours as `#rrggbbaa`, vectors as number lists. */
export function toGraphValue(v: MaterialPropertyValue): GraphValue {
  if (v instanceof EngineColor) return colorHex(v);
  if (v instanceof EngineVector2) return [v.x, v.y];
  if (v instanceof EngineVector3) return [v.x, v.y, v.z];
  return Array.isArray(v) ? [...v] : (v as number | string);
}

/** Values (a script Material's, a renderer's overrides) as material-file data. */
export function graphValues(values: Iterable<[string, MaterialPropertyValue]>): Record<string, GraphValue> {
  const out: Record<string, GraphValue> = {};
  for (const [k, v] of values) out[k] = toGraphValue(v);
  return out;
}

/** The property names a material has: a graph's uniform properties, else the built-in ones. */
export function knownProperties(compiled: CompiledShaderGraph | null): ReadonlySet<string> {
  return compiled ? new Set(compiled.uniforms.flatMap((u) => (u.property ? [u.property] : []))) : BUILTIN_PROPERTIES;
}

/** What a script Material sets on a material built from `resolved` (null: the default material). */
export interface ScriptValues {
  /** The Material's own values. */
  values: Record<string, GraphValue>;
  /** Graph materials: the asset's properties under the Material's values. */
  properties: Record<string, GraphValue>;
  /** Graph materials: the asset's keywords under the Material's. */
  keywords: Record<string, KeywordValue>;
  /** Built-in materials: the settings to reset to before the values (null: leave as they are). */
  settings: MaterialSettings | null;
  warnings: MaterialWarning[];
}

/**
 * A script Material's values and keywords over the asset's (ADR 0107): graph and shader-asset materials
 * take them over the asset's properties and keywords; built-in materials reset to the asset's settings,
 * then take the values. Unknown property names and keywords are warned (a built-in has no keywords).
 */
export function scriptValues(resolved: ResolvedMaterial | null, m: Material): ScriptValues {
  const path = resolved?.path ?? "";
  const what = path ? where(path) : "the default material";
  const settings = resolved ? resolved.settings : defaultMaterialSettings();
  const values = graphValues(m._values);
  const keywords = Object.fromEntries(m._keywords) as Record<string, KeywordValue>;
  const warnings: MaterialWarning[] = [];
  const compiled = resolved?.compiled ?? null;
  if (compiled) resolveKeywords(compiled.keywords, keywords, (msg) => warnings.push({ key: `${path}|script-kw|${msg}`, message: `${what}: ${msg}` }));
  else if (m._keywords.size) warnings.push({ key: `${path}|script-kw`, message: `${what} is a built-in material; it has no keywords (shader graphs and shader assets do, ADR 0106).` });
  const known = knownProperties(compiled);
  for (const k of Object.keys(values)) if (!known.has(k)) warnings.push({ key: `${path}|script-prop|${k}`, message: `${what} has no property "${k}"; the Material's value is ignored.` });
  return {
    values,
    properties: { ...(settings?.properties ?? {}), ...values },
    keywords: { ...(settings?.keywords ?? {}), ...keywords },
    settings,
    warnings,
  };
}

/**
 * What to do with an asset's shared script Material on the asset's built material (ADR 0107), given the
 * version last applied (undefined: none yet) and whether that material has a `texture` value applied:
 * `none` (up to date, or an empty Material never applied), `apply` the values in place, or `rebuild` the
 * asset (a texture value taken back: its own texture has to load onto it again).
 */
export function sharedAction(applied: number | undefined, shared: Material, textureApplied: boolean): "none" | "apply" | "rebuild" {
  if (applied === shared._version || (applied === undefined && shared._empty)) return "none";
  if (applied !== undefined && !shared._values.has("texture") && textureApplied) return "rebuild";
  return "apply";
}

/** A renderer's property overrides' unknown names, as warnings (ADR 0049). */
export function overrideWarnings(material: string, node: string, names: Iterable<string>, compiled: CompiledShaderGraph | null): MaterialWarning[] {
  const known = knownProperties(compiled);
  const out: MaterialWarning[] = [];
  for (const k of names) if (!known.has(k)) out.push({ key: `${material}|prop|${k}`, message: `${node}: its material has no property "${k}"; setMaterialProperty ignores it.` });
  return out;
}

/** The image a `texture` value asks for: null for none set (the base's), "" for no image. */
export function textureValue(values: Record<string, GraphValue>): string | null {
  return typeof values.texture === "string" ? values.texture.replace(/^asset:/, "") : null;
}

// --- Keyword variants (ADR 0106) ------------------------------------------------------------------------

/**
 * The keyword combinations warm-up draws beyond the one a graph material draws: every combination of its
 * `"variants": "all"` keywords, at most {@link MAX_WARM_VARIANTS} (a warning when capped).
 */
export function warmVariantKeywords(compiled: CompiledShaderGraph, current: Record<string, KeywordValue>, name: string): { variants: Record<string, KeywordValue>[]; warning: MaterialWarning | null } {
  if (!compiled.keywords?.some((k) => k.variants === "all")) return { variants: [], warning: null };
  const { variants, capped } = warmKeywordVariants(compiled.keywords, current);
  return {
    variants: variants.slice(1),
    warning: capped ? { key: `warm-cap|${name}`, message: `${name}: its "variants": "all" keywords make more than ${MAX_WARM_VARIANTS} combinations; warm-up compiles the first ${MAX_WARM_VARIANTS}.` } : null,
  };
}

// --- Textures (ADR 0040) --------------------------------------------------------------------------------

/** How an image is sampled: magnification filter, mipmaps (none, nearest or linear between levels) and wrapping. */
export interface Sampling {
  filter: "nearest" | "linear";
  mipmaps: "none" | "nearest" | "linear";
  wrap: "clamp" | "repeat" | "mirror";
}

/** An image's import settings as sampling: point filtering picks the nearest texel and mip level. */
export function samplingOf(settings: ImportSettings): Sampling {
  const point = settings.filter === "point";
  return {
    filter: point ? "nearest" : "linear",
    mipmaps: !settings.mipmaps ? "none" : point ? "nearest" : "linear",
    wrap: settings.wrap === "repeat" ? "repeat" : settings.wrap === "mirror" ? "mirror" : "clamp",
  };
}

/**
 * How a texture is read: `color`, a material's image (the shader decodes sRGB); `sheet`, the same but
 * not flipped (Babylon's particle sprite sheets read V 0 at the image's top); `graphColor`, for shader
 * graph code, which samples raw (the hardware decodes sRGB); `graphData`, linear data (normal maps).
 */
export type TextureUse = "color" | "sheet" | "graphColor" | "graphData";

/** What a use asks of a texture load, and the key its copy is cached under (one copy per path and use). */
export function textureLoad(path: string, use: TextureUse): { key: string; flipY: boolean; decode: "shader" | "srgb" | "linear" } {
  return {
    key: use === "color" ? path : `${path}#${use}`,
    flipY: use !== "sheet",
    decode: use === "graphColor" ? "srgb" : use === "graphData" ? "linear" : "shader",
  };
}

/** The image's sidecar as it is now: a texture sampled from another must be sampled again (the editor's import settings). */
export const samplingSource = (path: string): object | undefined => sidecarValue(path);
