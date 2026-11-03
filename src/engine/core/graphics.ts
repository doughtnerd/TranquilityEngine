/**
 * Graphics quality tiers (ADR 0050): named sets of rendering settings in `project.json`'s
 * `graphics` section, one of which is active at a time (the player's saved choice, else the
 * project's default). The render backend applies the active tier; `Graphics` switches it.
 *
 * ```jsonc
 * "graphics": {
 *   "defaultTier": "High",
 *   "autoDetect": false,
 *   "targetFrameRate": 60,
 *   "tiers": [
 *     { "name": "Low", "renderScale": 0.75, "antialias": "off", "shadows": "low", "shadowCascades": 1, "shadowDistance": 30, "anisotropy": 1, "shaderLevel": "low", "postProcessing": false, "bloom": false, "ambientOcclusion": "off", "depthOfField": false, "reflectionProbes": "off", "particles": "low" },
 *     { "name": "High", "renderScale": 1, "antialias": "msaa", "shadows": "high", "shadowCascades": 3, "shadowDistance": 80, "anisotropy": 8, "shaderLevel": "high", "postProcessing": true, "bloom": true, "ambientOcclusion": "medium", "depthOfField": true, "reflectionProbes": "medium", "particles": "high" }
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

/**
 * Reflection probe capture resolution (ADR 0054): off (probes ignored, the global environment
 * only), or low/medium/high for 128/256/512 pixels per cube face.
 */
export type ProbeQualityName = "off" | "low" | "medium" | "high";
export const PROBE_QUALITIES: readonly ProbeQualityName[] = ["off", "low", "medium", "high"];

/**
 * Particle budget (ADR 0057): low/medium/high multiply every ParticleSystem's emission rate and
 * max particles by `PARTICLE_SCALE`.
 */
export type ParticleQuality = "low" | "medium" | "high";
export const PARTICLE_QUALITIES: readonly ParticleQuality[] = ["low", "medium", "high"];
/** The factor emission and max particles are multiplied by for each particle quality. */
export const PARTICLE_SCALE: Record<ParticleQuality, number> = { low: 0.25, medium: 0.5, high: 1 };

/** One quality tier. */
export interface QualityTier {
  /** Shown in menus and used to pick the tier (`Graphics.quality = "High"`). Unique. */
  name: string;
  /** Rendering resolution as a share of the screen's (0.25–2); the screen's pixel ratio is capped at 2 first. */
  renderScale: number;
  antialias: AntialiasMode;
  shadows: ShadowQuality;
  /**
   * Cascaded shadow maps (ADR 0053), 1 to 4 (a whole number). Above 1, the first directional
   * light with shadows is drawn with cascaded shadow maps following the main camera; 1 is off.
   */
  shadowCascades: number;
  /** How far the shadow cascades reach from the camera, in metres (10–1000). */
  shadowDistance: number;
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
  /** Reflection probe capture resolution (ADR 0054): "off" ignores probes; low/medium/high capture 128/256/512 px per face. */
  reflectionProbes: ProbeQualityName;
  /** Particle budget (ADR 0057): scales every ParticleSystem's emission and max particles by `PARTICLE_SCALE`. */
  particles: ParticleQuality;
}

export interface GraphicsSettings {
  /** From lowest to highest. At least one. */
  tiers: QualityTier[];
  /** The tier used until the player picks one. */
  defaultTier: string;
  /** Pick the tier from the GPU on first run, and step down if the frame rate falls short (ADR 0055). */
  autoDetect: boolean;
  /** The frame rate automatic detection aims for (20–240). */
  targetFrameRate: number;
}

/** The tiers a project gets when its `project.json` has no `graphics` section. */
export const defaultGraphics = (): GraphicsSettings => ({
  defaultTier: "High",
  autoDetect: false,
  targetFrameRate: 60,
  tiers: [
    { name: "Low", renderScale: 0.75, antialias: "off", shadows: "low", shadowCascades: 1, shadowDistance: 30, anisotropy: 1, shaderLevel: "low", postProcessing: false, bloom: false, ambientOcclusion: "off", depthOfField: false, reflectionProbes: "off", particles: "low" },
    { name: "Medium", renderScale: 1, antialias: "smaa", shadows: "medium", shadowCascades: 2, shadowDistance: 50, anisotropy: 4, shaderLevel: "medium", postProcessing: true, bloom: true, ambientOcclusion: "off", depthOfField: false, reflectionProbes: "low", particles: "medium" },
    { name: "High", renderScale: 1, antialias: "msaa", shadows: "high", shadowCascades: 3, shadowDistance: 80, anisotropy: 8, shaderLevel: "high", postProcessing: true, bloom: true, ambientOcclusion: "medium", depthOfField: true, reflectionProbes: "medium", particles: "high" },
    { name: "Ultra", renderScale: 1.25, antialias: "msaa", shadows: "ultra", shadowCascades: 4, shadowDistance: 120, anisotropy: 16, shaderLevel: "high", postProcessing: true, bloom: true, ambientOcclusion: "high", depthOfField: true, reflectionProbes: "high", particles: "high" },
  ],
});

/** A new tier's values (the High tier's), with the given name. */
export const defaultTier = (name: string): QualityTier => ({ ...defaultGraphics().tiers[2], name });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TIER_KEYS = ["name", "renderScale", "antialias", "shadows", "shadowCascades", "shadowDistance", "anisotropy", "shaderLevel", "postProcessing", "bloom", "ambientOcclusion", "depthOfField", "reflectionProbes", "particles"];

/**
 * Read a `graphics` section leniently: bad values are reported and replaced by the default
 * (the High tier's value for a tier field); a section without usable tiers gets the default tiers.
 */
export function parseGraphics(raw: unknown, where = "graphics"): { graphics: GraphicsSettings; problems: string[] } {
  const problems: string[] = [];
  if (raw === undefined) return { graphics: defaultGraphics(), problems };
  if (!isObject(raw)) return { graphics: defaultGraphics(), problems: [`${where} must be an object with "tiers" and "defaultTier"; using the default tiers.`] };
  for (const key of Object.keys(raw)) if (key !== "tiers" && key !== "defaultTier" && key !== "autoDetect" && key !== "targetFrameRate") problems.push(`${where}: unknown setting "${key}".`);
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
      if (t.shadowCascades !== undefined) {
        if (typeof t.shadowCascades === "number" && Number.isInteger(t.shadowCascades) && t.shadowCascades >= 1 && t.shadowCascades <= 4) tier.shadowCascades = t.shadowCascades;
        else bad("shadowCascades", "a whole number from 1 to 4");
      }
      if (t.shadowDistance !== undefined) {
        if (typeof t.shadowDistance === "number" && t.shadowDistance >= 10 && t.shadowDistance <= 1000) tier.shadowDistance = t.shadowDistance;
        else bad("shadowDistance", "a number from 10 to 1000");
      }
      if (t.anisotropy !== undefined) {
        if (typeof t.anisotropy === "number" && Number.isInteger(t.anisotropy) && t.anisotropy >= 1 && t.anisotropy <= 16) tier.anisotropy = t.anisotropy;
        else bad("anisotropy", "a whole number from 1 to 16");
      }
      const choice = <K extends "antialias" | "shadows" | "shaderLevel" | "ambientOcclusion" | "reflectionProbes" | "particles">(key: K, options: readonly QualityTier[K][]) => {
        const v = t[key];
        if (v === undefined) return;
        if (options.includes(v as QualityTier[K])) tier[key] = v as QualityTier[K];
        else bad(key, options.map((o) => `"${o}"`).join(", "));
      };
      choice("antialias", ANTIALIAS_MODES);
      choice("shadows", SHADOW_QUALITIES);
      choice("shaderLevel", SHADER_LEVELS);
      choice("ambientOcclusion", AO_QUALITIES);
      choice("reflectionProbes", PROBE_QUALITIES);
      choice("particles", PARTICLE_QUALITIES);
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
  let autoDetect = false;
  if (raw.autoDetect !== undefined) {
    if (typeof raw.autoDetect === "boolean") autoDetect = raw.autoDetect;
    else problems.push(`${where}.autoDetect should be true or false; using false.`);
  }
  let targetFrameRate = 60;
  if (raw.targetFrameRate !== undefined) {
    if (typeof raw.targetFrameRate === "number" && raw.targetFrameRate >= 20 && raw.targetFrameRate <= 240) targetFrameRate = raw.targetFrameRate;
    else problems.push(`${where}.targetFrameRate should be a number from 20 to 240; using 60.`);
  }
  return { graphics: { tiers, defaultTier: chosen, autoDetect, targetFrameRate }, problems };
}
