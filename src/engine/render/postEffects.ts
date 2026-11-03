/**
 * Which post-processing runs (ADR 0051): a camera's PostProcessing settings filtered by the
 * active quality tier. Pure, so the rules are unit-tested without WebGL.
 */
import type { QualityTier } from "../core/graphics";
import type { PostEffects, ToneMappingName } from "./PostProcessStack";

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
    vignette: post && s!.vignette ? { darkness: s!.vignetteDarkness, offset: s!.vignetteOffset } : null,
    depthOfField: post && tier.depthOfField && s!.depthOfField ? { focusDistance: s!.focusDistance, focusRange: s!.focusRange, bokehScale: s!.bokehScale } : null,
    chromaticAberration: post && s!.chromaticAberration ? { amount: s!.chromaticAberrationAmount } : null,
  };
  const anyEffect = !!(effects.bloom || effects.ambientOcclusion || effects.colorGrading || effects.vignette || effects.depthOfField || effects.chromaticAberration);
  const needsComposer = (post && anyEffect) || tier.antialias === "smaa" || tier.antialias === "fxaa";
  return { composer: needsComposer ? effects : null, toneMapping, exposure };
}
