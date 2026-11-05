// ADR 0075 stage 3: the finish pass and each camera's pass layout on the Babylon backend, without a GPU.
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { describe, expect, it } from "vitest";
import { cameraPasses } from "../render/babylon/frameGraph";
import { FINISH_SHADER, FINISH_UNIFORMS } from "../render/babylon/finishShader";
import type { PostEffects } from "../render/PostProcessStack";

describe("the finish pass (ADR 0075)", () => {
  it("is registered in WGSL and GLSL, each declaring every uniform", () => {
    const wgsl = ShaderStore.ShadersStoreWGSL[`${FINISH_SHADER}PixelShader`];
    const glsl = ShaderStore.ShadersStore[`${FINISH_SHADER}PixelShader`];
    expect(wgsl).toBeTruthy();
    expect(glsl).toBeTruthy();
    for (const u of FINISH_UNIFORMS) {
      expect(wgsl).toContain(`uniform ${u}: vec4f;`);
      expect(glsl).toContain(`uniform vec4 ${u};`);
    }
  });

  it("keeps its uniform list read-only (Babylon appends the vertex stage's 'scale' to the list it's given)", () => {
    expect(Object.isFrozen(FINISH_UNIFORMS)).toBe(true);
    expect(FINISH_UNIFORMS).not.toContain("scale");
  });
});

describe("a camera's passes (ADR 0075 stage 3)", () => {
  const effects = (overrides: Partial<PostEffects>): PostEffects => ({
    toneMapping: "agx",
    exposure: 1,
    antialias: "off",
    bloom: null,
    ambientOcclusion: null,
    colorGrading: null,
    vignette: null,
    depthOfField: null,
    chromaticAberration: null,
    ...overrides,
  });

  it("are clear, render and finish without effects", () => {
    expect(cameraPasses(null)).toEqual(["clear", "render", "finish"]);
    // Grading, the vignette and tone mapping happen in the finish pass.
    expect(cameraPasses(effects({ colorGrading: { brightness: 0.1, contrast: 0, saturation: 0, hue: 0 }, vignette: { darkness: 0.5, offset: 0.5 } }))).toEqual(["clear", "render", "finish"]);
  });

  it("add each effect, with a geometry pass for ambient occlusion and depth of field", () => {
    const all = effects({
      bloom: { intensity: 1, threshold: 0.9, radius: 0.85 },
      ambientOcclusion: { intensity: 2, radius: 1, quality: "medium" },
      depthOfField: { focusDistance: 10, focusRange: 5, bokehScale: 2 },
      chromaticAberration: { amount: 0.002 },
    });
    expect(cameraPasses(all)).toEqual(["clear", "render", "geometry", "ao", "dof", "bloom", "ca", "finish"]);
    expect(cameraPasses(effects({ depthOfField: { focusDistance: 10, focusRange: 5, bokehScale: 2 } }))).toEqual(["clear", "render", "geometry", "dof", "finish"]);
  });

  it("end with FXAA on tiers with FXAA or SMAA, not MSAA", () => {
    expect(cameraPasses(effects({ antialias: "smaa" }))).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(cameraPasses(effects({ antialias: "fxaa" }))).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(cameraPasses(effects({ antialias: "msaa" }))).toEqual(["clear", "render", "finish"]);
  });
});
