// ADR 0461: the one colour codec — hex text and the sRGB transfer function.
import { describe, expect, it } from "vitest";
import { formatHex, linearToSrgb, parseHex, srgbToLinear } from "./colorSpace";

describe("the colour codec (ADR 0461)", () => {
  it("reads every hex form the same, any case, # optional, and nothing else", () => {
    expect(parseHex("#abc")).toEqual(parseHex("#aabbcc"));
    expect(parseHex("#ABCD")).toEqual(parseHex("#aabbccdd"));
    expect(parseHex(" ff000080 ")).toEqual([1, 0, 0, 128 / 255]);
    expect(parseHex("#00ff00")).toEqual([0, 1, 0, 1]);
    for (const bad of ["red", "", "#", "#ab", "#abcde", "#1234567", "#gggggg", "#ff0000zz"]) expect(parseHex(bad)).toBeNull();
  });

  it("writes #rrggbb, adds aa only below opaque, and clamps so the text is always 7 or 9 characters", () => {
    expect(formatHex([1, 0.5, 0])).toBe("#ff8000");
    expect(formatHex([1, 0, 0], 0.5)).toBe("#ff000080");
    expect(formatHex([1, 0, 0], 0.999)).toBe("#ff0000"); // rounds to ff: dropped
    expect(formatHex([2, -1, 0.5], 1.2)).toBe("#ff0080");
    expect(formatHex([0, 0, 0], -0.5)).toBe("#00000000");
    expect(formatHex(parseHex("#12345678")!, parseHex("#12345678")![3])).toBe("#12345678");
  });

  it("round-trips the sRGB curve and never gives NaN or leaves 0–1 going back to sRGB", () => {
    for (const c of [0, 0.02, 0.04045, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 6); // the two knees differ by 3e-8
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
    expect(linearToSrgb(-0.5)).toBe(0); // the model importer's copy gave NaN
    expect(linearToSrgb(4)).toBeCloseTo(1, 12); // the glTF light copy gave 1.85
    expect(linearToSrgb(Number.NaN)).toBe(0);
  });
});
