/**
 * Graphics quality tiers (ADR 0050): named sets of rendering settings in `project.json`'s
 * `graphics` section, one of which is active at a time (the player's saved choice, else the
 * project's default). The render backend applies the active tier; `Graphics` switches it.
 *
 * ```jsonc
 * "graphics": {
 *   "defaultTier": "High",
 *   "tiers": [
 *     { "name": "Low", "renderScale": 0.75, "antialias": "off", "shadows": "low", "anisotropy": 1, "shaderLevel": "low", "postProcessing": false, "bloom": false, "ambientOcclusion": "off", "depthOfField": false },
 *     { "name": "High", "renderScale": 1, "antialias": "msaa", "shadows": "high", "anisotropy": 8, "shaderLevel": "high", "postProcessing": true, "bloom": true, "ambientOcclusion": "medium", "depthOfField": true }
 *   ]
 * }
 * ```
 */

/** Shadow map quality: off, or a shadow map size (low 512 … ultra 4096 pixels square). */
export type ShadowQuality = "off" | "low" | "medium" | "high" | "ultra";
export const SHADOW_QUALITIES: readonly ShadowQuality[] = ["off", "low", "medium", "high", "ultra"];
/** Shadow map size in pixels for each quality (0: no shadows). */
export const SHADOW_MAP_SIZE: Record<ShadowQuality, number> = { off: 0, low: 512, medium: 1024, high: 2048, ultra: 4096 };

/** Edge smoothing: none, multisampling (MSAA), or a post-process filter (SMAA, FXAA). */
export type AntialiasMode = "off" | "msaa" | "smaa" | "fxaa";
export const ANTIALIAS_MODES: readonly AntialiasMode[] = ["off", "msaa", "smaa", "fxaa"];

/** Ambient occlusion quality: off, or the sample count and resolution it runs at (ADR 0051). */
export type AOQuality = "off" | "low" | "medium" | "high" | "ultra";
export const AO_QUALITIES: readonly AOQuality[] = ["off", "low", "medium", "high", "ultra"];

/** The level shader graphs' Quality Branch nodes take (ADR 0050). */
export type ShaderLevel = "low" | "medium" | "high";
export const SHADER_LEVELS: readonly ShaderLevel[] = ["low", "medium", "high"];

/** One quality tier. */
export interface QualityTier {
  /** Shown in menus and used to pick the tier (`Graphics.quality = "High"`). Unique. */
  name: string;
  /** Rendering resolution as a share of the screen's (0.25–2); the screen's pixel ratio is capped at 2 first. */
  renderScale: number;
  antialias: AntialiasMode;
  shadows: ShadowQuality;
  /** Texture filtering at grazing angles: 1 (off) to 16, capped at what the GPU supports. */
  anisotropy: number;
  shaderLevel: ShaderLevel;
  /**
   * Whether post-processing runs at all (ADR 0051). An effect runs only when a camera's
   * PostProcessing component asks for it and the tier allows it; `false` turns every effect off.
   */
  postProcessing: boolean;
  /** Whether bloom may run (needs `postProcessing`; a camera's PostProcessing component must ask for it). */
  bloom: boolean;
  /** The ambient occlusion quality allowed (needs `postProcessing`; "off" disallows it). */
  ambientOcclusion: AOQuality;
  /** Whether depth of field may run (needs `postProcessing`; a camera's PostProcessing component must ask for it). */
  depthOfField: boolean;
}

export interface GraphicsSettings {
  /** From lowest to highest. At least one. */
  tiers: QualityTier[];
  /** The tier used until the player picks one. */
  defaultTier: string;
}

/** The tiers a project gets when its `project.json` has no `graphics` section. */
export const defaultGraphics = (): GraphicsSettings => ({
  defaultTier: "High",
  tiers: [
    { name: "Low", renderScale: 0.75, antialias: "off", shadows: "low", anisotropy: 1, shaderLevel: "low", postProcessing: false, bloom: false, ambientOcclusion: "off", depthOfField: false },
    { name: "Medium", renderScale: 1, antialias: "smaa", shadows: "medium", anisotropy: 4, shaderLevel: "medium", postProcessing: true, bloom: true, ambientOcclusion: "off", depthOfField: false },
    { name: "High", renderScale: 1, antialias: "msaa", shadows: "high", anisotropy: 8, shaderLevel: "high", postProcessing: true, bloom: true, ambientOcclusion: "medium", depthOfField: true },
    { name: "Ultra", renderScale: 1.25, antialias: "msaa", shadows: "ultra", anisotropy: 16, shaderLevel: "high", postProcessing: true, bloom: true, ambientOcclusion: "high", depthOfField: true },
  ],
});

/** A new tier's values (the High tier's), with the given name. */
export const defaultTier = (name: string): QualityTier => ({ ...defaultGraphics().tiers[2], name });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TIER_KEYS = ["name", "renderScale", "antialias", "shadows", "anisotropy", "shaderLevel", "postProcessing", "bloom", "ambientOcclusion", "depthOfField"];

/**
 * Read a `graphics` section leniently: bad values are reported and replaced by the default
 * (the High tier's value for a tier field); a section without usable tiers gets the default tiers.
 */
export function parseGraphics(raw: unknown, where = "graphics"): { graphics: GraphicsSettings; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined) return { graphics: defaultGraphics(), problems };
  if (!isObject(raw)) return { graphics: defaultGraphics(), problems: [`${where} must be an object with "tiers" and "defaultTier"; using the default tiers.`] };
  for (const key of Object.keys(raw)) if (key !== "tiers" && key !== "defaultTier") problems.push(`${where}: unknown setting "${key}".`);
  const tiers: QualityTier[] = [];
  if (Array.isArray(raw.tiers)) {
    raw.tiers.forEach((t: unknown, i) => {
      const at = `${where}.tiers[${i}]`;
      if (!isObject(t) || typeof t.name !== "string" || !t.name.trim()) {
        problems.push(`${at}: a tier needs a name; skipped.`);
        return;
      }
      if (tiers.some((q) => q.name === t.name)) {
        problems.push(`${at}: another tier is already named "${t.name}"; skipped.`);
        return;
      }
      const tier = defaultTier(t.name);
      for (const key of Object.keys(t)) if (!TIER_KEYS.includes(key)) problems.push(`${at} ("${t.name}"): unknown setting "${key}".`);
      const bad = (key: string, expected: string) => problems.push(`${at} ("${t.name}"): ${key} should be ${expected}; using ${JSON.stringify(tier[key as keyof QualityTier])}.`);
      if (t.renderScale !== undefined) {
        if (typeof t.renderScale === "number" && t.renderScale >= 0.25 && t.renderScale <= 2) tier.renderScale = t.renderScale;
        else bad("renderScale", "a number from 0.25 to 2");
      }
      if (t.anisotropy !== undefined) {
        if (typeof t.anisotropy === "number" && Number.isInteger(t.anisotropy) && t.anisotropy >= 1 && t.anisotropy <= 16) tier.anisotropy = t.anisotropy;
        else bad("anisotropy", "a whole number from 1 to 16");
      }
      const choice = <K extends "antialias" | "shadows" | "shaderLevel" | "ambientOcclusion">(key: K, options: readonly QualityTier[K][]) => {
        const v = t[key];
        if (v === undefined) return;
        if (options.includes(v as QualityTier[K])) tier[key] = v as QualityTier[K];
        else bad(key, options.map((o) => `"${o}"`).join(", "));
      };
      choice("antialias", ANTIALIAS_MODES);
      choice("shadows", SHADOW_QUALITIES);
      choice("shaderLevel", SHADER_LEVELS);
      choice("ambientOcclusion", AO_QUALITIES);
      for (const key of ["postProcessing", "bloom", "depthOfField"] as const) {
        if (t[key] === undefined) continue;
        if (typeof t[key] === "boolean") tier[key] = t[key] as boolean;
        else bad(key, "true or false");
      }
      tiers.push(tier);
    });
  } else if (raw.tiers !== undefined) problems.push(`${where}.tiers must be a list of tiers; using the default tiers.`);
  if (tiers.length === 0) {
    if (Array.isArray(raw.tiers)) problems.push(`${where}.tiers has no usable tier; using the default tiers.`);
    tiers.push(...defaultGraphics().tiers);
  }
  let chosen = typeof raw.defaultTier === "string" ? raw.defaultTier : "";
  if (!tiers.some((t) => t.name === chosen)) {
    const fallback = tiers.some((t) => t.name === "High") ? "High" : tiers[tiers.length - 1].name;
    if (raw.defaultTier !== undefined) problems.push(`${where}.defaultTier names no tier (${JSON.stringify(raw.defaultTier)}); using "${fallback}".`);
    chosen = fallback;
  }
  return { graphics: { tiers, defaultTier: chosen }, problems };
}
