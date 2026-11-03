import { describe, expect, it } from "vitest";
import { composerSamples, stackKey, viewportPixels, type PostEffects } from "../render/PostProcessStack";

function fx(over: Partial<PostEffects> = {}): PostEffects {
  return {
    toneMapping: "agx", exposure: 1, antialias: "smaa",
    bloom: { intensity: 1, threshold: 0.9, radius: 0.85 },
    ambientOcclusion: null,
    colorGrading: null,
    vignette: null,
    depthOfField: null,
    chromaticAberration: null,
    ...over,
  };
}

describe("PostProcessStack structure", () => {
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

  it("converts a CSS viewport to whole drawing-buffer pixels", () => {
    expect(viewportPixels({ x: 10, y: 20, width: 100, height: 50 }, 2)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    // Edges are rounded, so adjacent rectangles share an edge.
    const a = viewportPixels({ x: 0, y: 0, width: 100.5, height: 10 }, 1.5);
    const b = viewportPixels({ x: 100.5, y: 0, width: 100.5, height: 10 }, 1.5);
    expect(a.x + a.width).toBe(b.x);
    expect(viewportPixels({ x: 0, y: 0, width: 0, height: 0 }, 1)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("uses 4 samples for msaa without AO, otherwise 0", () => {
    expect(composerSamples(fx({ antialias: "msaa" }))).toBe(4);
    expect(composerSamples(fx({ antialias: "msaa", ambientOcclusion: { intensity: 1, radius: 1, quality: "medium" } }))).toBe(0);
    expect(composerSamples(fx({ antialias: "smaa" }))).toBe(0);
    expect(composerSamples(fx({ antialias: "off" }))).toBe(0);
  });
});
