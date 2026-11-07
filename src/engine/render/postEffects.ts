/**
 * Which post-processing runs (ADR 0051): a camera's PostProcessing settings filtered by the
 * active quality tier. Pure, so the rules are unit-tested without WebGL.
 */
import type { QualityTier } from "../core/graphics";

export type ToneMappingName = "none" | "aces" | "agx" | "neutral";
/** Ambient occlusion quality once the tier allows it (the tier's "off" leaves `ambientOcclusion` null). */
export type AOQuality = "low" | "medium" | "high" | "ultra";

/** The effects to run: the camera's PostProcessing component, already filtered by the quality tier. Null members are off. */
export interface PostEffects {
  toneMapping: ToneMappingName;
  exposure: number;
  antialias: "off" | "msaa" | "smaa" | "fxaa";
  bloom: { intensity: number; threshold: number; radius: number } | null;
  ambientOcclusion: { intensity: number; radius: number; quality: AOQuality } | null;
  colorGrading: { brightness: number; contrast: number; saturation: number; hue: number } | null; // hue in degrees
  /** A colour lookup table asset (`.cube`) and how much of it to apply (ADR 0111). */
  lut: { path: string; intensity: number } | null;
  vignette: { darkness: number; offset: number } | null;
  depthOfField: { focusDistance: number; focusRange: number; bokehScale: number } | null;
  chromaticAberration: { amount: number } | null;
}

/**
 * Identifies the pass layout: equal keys mean the frame graph can update values in place, different keys mean a rebuild.
 * Deliberately excludes every numeric value and the multisample count (a plain property on the composer).
 */
export function stackKey(effects: PostEffects, overlay = false): string {
  return [
    overlay ? "overlay" : "base",
    effects.toneMapping,
    effects.antialias === "smaa" || effects.antialias === "fxaa" ? effects.antialias : "no-aa-pass",
    effects.bloom ? "bloom" : "-",
    effects.ambientOcclusion ? `ao:${effects.ambientOcclusion.quality}` : "-",
    effects.colorGrading ? "grade" : "-",
    effects.vignette ? "vig" : "-",
    effects.depthOfField ? "dof" : "-",
    effects.chromaticAberration ? "ca" : "-",
  ].join("|");
}


/** A PostProcessing component's values (the fields `resolvePostEffects` reads). */
export interface PostSettings {
  enabled: boolean;
  toneMapping: ToneMappingName;
  exposure: number;
  bloom: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  ambientOcclusion: boolean;
  aoIntensity: number;
  aoRadius: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  /** Optional: a `.cube` colour lookup table (ADR 0111). */
  lut?: string;
  lutIntensity?: number;
  vignette: boolean;
  vignetteDarkness: number;
  vignetteOffset: number;
  depthOfField: boolean;
  focusDistance: number;
  focusRange: number;
  bokehScale: number;
  chromaticAberration: boolean;
  chromaticAberrationAmount: number;
}

export interface ResolvedPost {
  /** The composer's effects, or null to render directly (no composer). */
  composer: PostEffects | null;
  /** Tone mapping when rendering directly (the renderer's own), so a camera looks the same without the composer. */
  toneMapping: ToneMappingName;
  exposure: number;
}

/**
 * The effects to run for a camera with these settings (null: no PostProcessing component) on
 * this tier. The composer runs when the tier allows post-processing and the camera asks for any
 * effect, or when the tier's anti-aliasing needs it (SMAA, FXAA).
 */
export function resolvePostEffects(s: PostSettings | null, tier: QualityTier): ResolvedPost {
  const on = !!s?.enabled;
  const toneMapping: ToneMappingName = on ? s!.toneMapping : "none";
  const exposure = on ? s!.exposure : 1;
  const post = on && tier.postProcessing;
  const grading = post && (s!.brightness !== 0 || s!.contrast !== 0 || s!.saturation !== 0 || s!.hue !== 0);
  const effects: PostEffects = {
    toneMapping,
    exposure,
    antialias: tier.antialias,
    bloom: post && tier.bloom && s!.bloom ? { intensity: s!.bloomIntensity, threshold: s!.bloomThreshold, radius: s!.bloomRadius } : null,
    ambientOcclusion: post && tier.ambientOcclusion !== "off" && s!.ambientOcclusion ? { intensity: s!.aoIntensity, radius: s!.aoRadius, quality: tier.ambientOcclusion } : null,
    colorGrading: grading ? { brightness: s!.brightness, contrast: s!.contrast, saturation: s!.saturation, hue: s!.hue } : null,
    lut: post && s!.lut && (s!.lutIntensity ?? 1) > 0 ? { path: s!.lut, intensity: Math.min(1, s!.lutIntensity ?? 1) } : null,
    vignette: post && s!.vignette ? { darkness: s!.vignetteDarkness, offset: s!.vignetteOffset } : null,
    depthOfField: post && tier.depthOfField && s!.depthOfField ? { focusDistance: s!.focusDistance, focusRange: s!.focusRange, bokehScale: s!.bokehScale } : null,
    chromaticAberration: post && s!.chromaticAberration ? { amount: s!.chromaticAberrationAmount } : null,
  };
  const anyEffect = !!(effects.bloom || effects.ambientOcclusion || effects.colorGrading || effects.lut || effects.vignette || effects.depthOfField || effects.chromaticAberration);
  const needsComposer = (post && anyEffect) || tier.antialias === "smaa" || tier.antialias === "fxaa";
  return { composer: needsComposer ? effects : null, toneMapping, exposure };
}
