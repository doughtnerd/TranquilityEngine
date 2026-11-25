// A camera's pass plan (ADR 0274): its passes in order, the textures they need, and a layout key built
// only from those passes, so a value that is a uniform never rebuilds the frame graph.
import { describe, expect, it } from "vitest";
import { planCameraPasses } from "../render/passPlan";
import type { PostEffects } from "../render/postEffects";

const effects = (over: Partial<PostEffects> = {}): PostEffects => ({
  toneMapping: "agx",
  exposure: 1,
  antialias: "off",
  bloom: null,
  ambientOcclusion: null,
  colorGrading: null,
  lut: null,
  vignette: null,
  depthOfField: null,
  chromaticAberration: null,
  ...over,
});
const bloom = { intensity: 1, threshold: 0.9, radius: 0.85 };
const ao = (quality: "low" | "medium" | "high" | "ultra" = "medium", intensity = 2, radius = 1) => ({ intensity, radius, quality });
const dof = { focusDistance: 10, focusRange: 5, bokehScale: 2 };
const key = (e: PostEffects | null, depth = false) => planCameraPasses(e, depth).key;

describe("a camera's passes", () => {
  it("are clear, render and finish without effects", () => {
    expect(planCameraPasses(null).passes).toEqual(["clear", "render", "finish"]);
    // Grading, the vignette, the LUT and tone mapping happen in the finish pass.
    const finishOnly = effects({ colorGrading: { brightness: 0.1, contrast: 0, saturation: 0, hue: 0 }, vignette: { darkness: 0.5, offset: 0.5 }, lut: { path: "a.cube", intensity: 1 } });
    expect(planCameraPasses(finishOnly).passes).toEqual(["clear", "render", "finish"]);
  });

  it("add each effect in order, with a geometry pass for ambient occlusion and depth of field", () => {
    const all = effects({ bloom, ambientOcclusion: ao(), depthOfField: dof, chromaticAberration: { amount: 0.002 } });
    expect(planCameraPasses(all).passes).toEqual(["clear", "geometry", "render", "ao", "dof", "bloom", "ca", "finish"]);
    expect(planCameraPasses(effects({ depthOfField: dof })).passes).toEqual(["clear", "geometry", "render", "dof", "finish"]);
  });

  it("add a depth pass before the render pass when something asks for the scene depth (ADR 0109)", () => {
    expect(planCameraPasses(null, true).passes).toEqual(["clear", "geometry", "render", "finish"]);
    // Shared with ambient occlusion: one geometry pass.
    expect(planCameraPasses(effects({ ambientOcclusion: ao() }), true).passes).toEqual(["clear", "geometry", "render", "ao", "finish"]);
  });

  it("end with one FXAA pass for both SMAA and FXAA tiers, none for MSAA", () => {
    expect(planCameraPasses(effects({ antialias: "smaa" })).passes).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(planCameraPasses(effects({ antialias: "fxaa" })).passes).toEqual(["clear", "render", "finish", "fxaa"]);
    expect(planCameraPasses(effects({ antialias: "msaa" })).passes).toEqual(["clear", "render", "finish"]);
  });
});

describe("a camera's textures", () => {
  it("give the geometry pass depth, and normals only when ambient occlusion reads them", () => {
    expect(planCameraPasses(null).geometry).toBeNull();
    expect(planCameraPasses(effects({ depthOfField: dof })).geometry).toEqual({ normals: false });
    expect(planCameraPasses(null, true).geometry).toEqual({ normals: false });
    expect(planCameraPasses(effects({ ambientOcclusion: ao() })).geometry).toEqual({ normals: true });
  });

  it("turn multisampling off when ambient occlusion's geometry pass would share the depth", () => {
    expect(planCameraPasses(effects({ ambientOcclusion: ao() })).multisample).toBe(false);
    expect(planCameraPasses(effects({ depthOfField: dof })).multisample).toBe(true);
    expect(planCameraPasses(null).multisample).toBe(true);
  });

  it("run ambient occlusion at its quality's share of the resolution", () => {
    expect(planCameraPasses(effects({ ambientOcclusion: ao("low") })).aoRatio).toBe(0.5);
    expect(planCameraPasses(effects({ ambientOcclusion: ao("ultra") })).aoRatio).toBe(1);
    expect(planCameraPasses(null).aoRatio).toBeNull();
  });

  it("send the finish pass to an 8-bit texture only when FXAA follows it", () => {
    expect(planCameraPasses(effects({ antialias: "smaa" })).finishToLdr).toBe(true);
    expect(planCameraPasses(effects({ antialias: "msaa" })).finishToLdr).toBe(false);
  });
});

describe("the layout key", () => {
  it("stays when only uniforms change: tone mapping, exposure, grading, vignette, LUT", () => {
    const base = key(effects());
    expect(key(effects({ toneMapping: "none", exposure: 2 }))).toBe(base);
    expect(key(effects({ colorGrading: { brightness: 0.2, contrast: 0.1, saturation: 0, hue: 30 } }))).toBe(base);
    expect(key(effects({ vignette: { darkness: 0.5, offset: 0.5 } }))).toBe(base);
    expect(key(effects({ lut: { path: "grades/warm.cube", intensity: 0.5 } }))).toBe(base);
    // A camera with no composer draws the same passes as one with only finish-pass effects.
    expect(key(null)).toBe(base);
  });

  it("stays when an effect's strength changes", () => {
    expect(key(effects({ bloom: { intensity: 3, threshold: 0.5, radius: 0.2 } }))).toBe(key(effects({ bloom })));
    expect(key(effects({ ambientOcclusion: ao("high", 5, 9) }))).toBe(key(effects({ ambientOcclusion: ao("high", 1, 1) })));
    // Sample counts are a property; only the resolution share is built in.
    expect(key(effects({ ambientOcclusion: ao("low") }))).toBe(key(effects({ ambientOcclusion: ao("medium") })));
  });

  it("is the same for SMAA and FXAA (the same pass), and for off and MSAA (the frame's sample count)", () => {
    expect(key(effects({ antialias: "smaa" }))).toBe(key(effects({ antialias: "fxaa" })));
    expect(key(effects({ antialias: "msaa" }))).toBe(key(effects({ antialias: "off" })));
  });

  it("changes when a pass or texture is added or removed", () => {
    const base = key(effects({ bloom }));
    expect(key(effects())).not.toBe(base);
    expect(key(effects({ bloom, depthOfField: dof }))).not.toBe(base);
    expect(key(effects({ bloom, chromaticAberration: { amount: 0.002 } }))).not.toBe(base);
    expect(key(effects({ bloom, antialias: "smaa" }))).not.toBe(base);
    expect(key(effects({ bloom }), true)).not.toBe(base);
    expect(key(effects({ ambientOcclusion: ao("low") }))).not.toBe(key(effects({ ambientOcclusion: ao("ultra") })));
    // Depth of field and the scene depth both want depth only; ambient occlusion adds normals and drops MSAA.
    expect(key(effects({ depthOfField: dof }))).not.toBe(key(effects({ ambientOcclusion: ao(), depthOfField: dof })));
  });
});

describe("the 2D light pass (ADR 0399)", () => {
  const layout = (styles = 1, directional = false, shadowTextures = 0) => ({ batches: [{ styles, directional }], scale: 0.5, shadowTextures, lowPrecision: false });
  it("runs before the render pass, only with a layer batch to light", () => {
    expect(planCameraPasses(null, false, layout()).passes).toEqual(["clear", "lights2d", "render", "finish"]);
    expect(planCameraPasses(null, true, layout()).passes).toEqual(["clear", "geometry", "lights2d", "render", "finish"]);
    expect(planCameraPasses(null, false, { ...layout(), batches: [] }).passes).toEqual(["clear", "render", "finish"]);
    expect(planCameraPasses(null, false, { ...layout(), batches: [] }).key).toBe(planCameraPasses(null).key);
  });

  it("keys only on which textures exist", () => {
    const k = (l: ReturnType<typeof layout>) => planCameraPasses(null, false, l).key;
    expect(k(layout())).toBe(k(layout()));
    expect(k(layout(2))).not.toBe(k(layout()));
    expect(k(layout(1, true))).not.toBe(k(layout()));
    expect(k(layout(1, false, 1))).not.toBe(k(layout()));
    expect(k({ ...layout(), scale: 0.25 })).not.toBe(k(layout()));
  });
});
