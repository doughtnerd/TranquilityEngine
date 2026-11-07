import { describe, expect, it } from "vitest";
import { stackKey, type PostEffects } from "../render/postEffects";

function fx(over: Partial<PostEffects> = {}): PostEffects {
  return {
    toneMapping: "agx", exposure: 1, antialias: "smaa",
    bloom: { intensity: 1, threshold: 0.9, radius: 0.85 },
    ambientOcclusion: null,
    colorGrading: null,
    lut: null,
    vignette: null,
    depthOfField: null,
    chromaticAberration: null,
    ...over,
  };
}

describe("post-effect pass layout key", () => {
  it("keeps the key when only values change", () => {
    const a = fx();
    const b = fx({ exposure: 2, bloom: { intensity: 3, threshold: 0.5, radius: 0.2 } });
    expect(stackKey(b)).toBe(stackKey(a));
    const ao = (i: number, r: number) => fx({ ambientOcclusion: { intensity: i, radius: r, quality: "high" } });
    expect(stackKey(ao(1, 1))).toBe(stackKey(ao(5, 9)));
  });

  it("changes the key when an effect is toggled", () => {
    const base = stackKey(fx());
    expect(stackKey(fx({ bloom: null }))).not.toBe(base);
    expect(stackKey(fx({ vignette: { darkness: 0.5, offset: 0.5 } }))).not.toBe(base);
    expect(stackKey(fx({ colorGrading: { brightness: 0, contrast: 0, saturation: 0, hue: 0 } }))).not.toBe(base);
    expect(stackKey(fx({ depthOfField: { focusDistance: 5, focusRange: 2, bokehScale: 1 } }))).not.toBe(base);
    expect(stackKey(fx({ chromaticAberration: { amount: 0.002 } }))).not.toBe(base);
    expect(stackKey(fx({ toneMapping: "none" }))).not.toBe(base);
  });

  it("changes the key for the AA pass and AO quality", () => {
    expect(stackKey(fx({ antialias: "fxaa" }))).not.toBe(stackKey(fx({ antialias: "smaa" })));
    expect(stackKey(fx({ antialias: "off" }))).not.toBe(stackKey(fx({ antialias: "smaa" })));
    const ao = (quality: "low" | "ultra") => fx({ ambientOcclusion: { intensity: 1, radius: 1, quality } });
    expect(stackKey(ao("low"))).not.toBe(stackKey(ao("ultra")));
  });

  it("does not rebuild between off and msaa (multisampling is a property)", () => {
    expect(stackKey(fx({ antialias: "msaa" }))).toBe(stackKey(fx({ antialias: "off" })));
  });

  it("includes overlay in the key", () => {
    expect(stackKey(fx(), true)).not.toBe(stackKey(fx(), false));
    expect(stackKey(fx(), false)).toBe(stackKey(fx()));
  });

});
