import { describe, expect, it } from "vitest";
import { defaultGraphics } from "../core/graphics";
import { resolvePostEffects, type PostSettings } from "../render/postEffects";

// Which post-processing runs for a camera (ADR 0051): the PostProcessing component's values filtered
// by the active quality tier.

const settings = (overrides: Partial<PostSettings> = {}): PostSettings => ({
  enabled: true,
  toneMapping: "agx",
  exposure: 1,
  bloom: false,
  bloomIntensity: 1,
  bloomThreshold: 0.9,
  bloomRadius: 0.85,
  ambientOcclusion: false,
  aoIntensity: 2,
  aoRadius: 1,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  vignette: false,
  vignetteDarkness: 0.5,
  vignetteOffset: 0.5,
  depthOfField: false,
  focusDistance: 10,
  focusRange: 5,
  bokehScale: 2,
  chromaticAberration: false,
  chromaticAberrationAmount: 0.002,
  ...overrides,
});

const [low, medium, high] = defaultGraphics().tiers;

describe("resolvePostEffects without a component", () => {
  it("runs no composer on Low and High, with no tone mapping", () => {
    for (const tier of [low, high]) {
      const r = resolvePostEffects(null, tier);
      expect(r.composer).toBeNull();
      expect(r.toneMapping).toBe("none");
      expect(r.exposure).toBe(1);
    }
  });

  it("keeps the composer on Medium for SMAA, with no effects and no tone mapping", () => {
    const r = resolvePostEffects(null, medium);
    expect(r.composer).not.toBeNull();
    expect(r.composer!.bloom).toBeNull();
    expect(r.composer!.ambientOcclusion).toBeNull();
    expect(r.composer!.colorGrading).toBeNull();
    expect(r.composer!.vignette).toBeNull();
    expect(r.composer!.depthOfField).toBeNull();
    expect(r.composer!.chromaticAberration).toBeNull();
    expect(r.composer!.toneMapping).toBe("none");
    expect(r.toneMapping).toBe("none");
  });
});

describe("resolvePostEffects with only tone mapping", () => {
  it("renders directly on High, keeping the component's tone mapping", () => {
    const r = resolvePostEffects(settings(), high);
    expect(r.composer).toBeNull();
    expect(r.toneMapping).toBe("agx");
  });

  it("keeps the composer on Medium for SMAA, with every effect null", () => {
    const r = resolvePostEffects(settings(), medium);
    expect(r.composer).not.toBeNull();
    expect(r.composer!.bloom).toBeNull();
    expect(r.composer!.ambientOcclusion).toBeNull();
    expect(r.composer!.colorGrading).toBeNull();
    expect(r.composer!.vignette).toBeNull();
    expect(r.composer!.depthOfField).toBeNull();
    expect(r.composer!.chromaticAberration).toBeNull();
    expect(r.toneMapping).toBe("agx");
  });
});

describe("resolvePostEffects effects by tier", () => {
  const requested = { bloom: true, ambientOcclusion: true, vignette: true, depthOfField: true };

  it("runs bloom, ambient occlusion, vignette and depth of field on High", () => {
    const r = resolvePostEffects(settings(requested), high);
    expect(r.composer).not.toBeNull();
    expect(r.composer!.bloom).not.toBeNull();
    expect(r.composer!.ambientOcclusion).not.toBeNull();
    expect(r.composer!.ambientOcclusion!.quality).toBe(high.ambientOcclusion);
    expect(r.composer!.vignette).not.toBeNull();
    expect(r.composer!.depthOfField).not.toBeNull();
  });

  it("runs bloom and vignette but not ambient occlusion or depth of field on Medium", () => {
    const r = resolvePostEffects(settings(requested), medium);
    expect(r.composer).not.toBeNull();
    expect(r.composer!.bloom).not.toBeNull();
    expect(r.composer!.vignette).not.toBeNull();
    expect(r.composer!.ambientOcclusion).toBeNull();
    expect(r.composer!.depthOfField).toBeNull();
  });

  it("turns every effect off on Low, keeping tone mapping and exposure", () => {
    const r = resolvePostEffects(settings({ ...requested, contrast: 0.3, exposure: 1.5 }), low);
    expect(r.composer).toBeNull();
    expect(r.toneMapping).toBe("agx");
    expect(r.exposure).toBe(1.5);
  });
});

describe("resolvePostEffects enabled flag", () => {
  it("treats enabled false like no component", () => {
    const disabled = resolvePostEffects(settings({ enabled: false, exposure: 2, bloom: true, vignette: true }), high);
    expect(disabled).toEqual(resolvePostEffects(null, high));
    expect(disabled.toneMapping).toBe("none");
    expect(disabled.exposure).toBe(1);
  });
});

describe("resolvePostEffects colour grading", () => {
  it("is null when brightness, contrast, saturation and hue are all 0", () => {
    const r = resolvePostEffects(settings(), high);
    expect(r.composer).toBeNull();
    const withComposer = resolvePostEffects(settings({ vignette: true }), high);
    expect(withComposer.composer!.colorGrading).toBeNull();
  });

  it.each(["brightness", "contrast", "saturation", "hue"] as const)("is present when %s is non-zero", (key) => {
    const r = resolvePostEffects(settings({ [key]: 0.25 }), high);
    expect(r.composer).not.toBeNull();
    expect(r.composer!.colorGrading).toEqual({ brightness: key === "brightness" ? 0.25 : 0, contrast: key === "contrast" ? 0.25 : 0, saturation: key === "saturation" ? 0.25 : 0, hue: key === "hue" ? 0.25 : 0 });
  });
});

describe("resolvePostEffects exposure", () => {
  it("passes exposure 2 through in the composer and the direct result", () => {
    const composed = resolvePostEffects(settings({ exposure: 2, bloom: true }), high);
    expect(composed.exposure).toBe(2);
    expect(composed.composer!.exposure).toBe(2);
    const direct = resolvePostEffects(settings({ exposure: 2 }), high);
    expect(direct.exposure).toBe(2);
  });
});

describe("colour lookup tables (ADR 0111)", () => {
  const tiers = defaultGraphics().tiers;
  const [low, , high] = tiers;
  const base = (over: Partial<PostSettings>): PostSettings => ({
    enabled: true, toneMapping: "agx", exposure: 1, bloom: false, bloomIntensity: 1, bloomThreshold: 0.9, bloomRadius: 0.85, ambientOcclusion: false, aoIntensity: 2, aoRadius: 1,
    brightness: 0, contrast: 0, saturation: 0, hue: 0, vignette: false, vignetteDarkness: 0.5, vignetteOffset: 0.5, depthOfField: false, focusDistance: 10, focusRange: 5, bokehScale: 2,
    chromaticAberration: false, chromaticAberrationAmount: 0.002, ...over,
  });

  it("run when the camera names one and the tier allows post-processing, capped at full strength", () => {
    expect(resolvePostEffects(base({ lut: "grades/warm.cube", lutIntensity: 2 }), high).composer?.lut).toEqual({ path: "grades/warm.cube", intensity: 1 });
    expect(resolvePostEffects(base({ lut: "grades/warm.cube" }), low).composer).toBeNull();
    expect(resolvePostEffects(base({ lut: "grades/warm.cube", lutIntensity: 0 }), high).composer?.lut ?? null).toBeNull();
    expect(resolvePostEffects(base({}), high).composer?.lut ?? null).toBeNull();
  });
});
