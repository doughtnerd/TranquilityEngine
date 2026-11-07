import { afterEach, describe, expect, it, vi } from "vitest";
import { identityLut, lutStripRGBA8, lutStripRGBAFloat, parseCubeLut } from "../render/lut";
import { Assets } from "../scene/Assets";
import { assetKind } from "../../editor/assetBrowser";

const identity2 = `# a comment
TITLE "Neutral"

LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0   # black
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe("parseCubeLut", () => {
  it("parses a 2x2x2 identity with comments and a title", () => {
    const lut = parseCubeLut(identity2, "id.cube");
    expect(lut.size).toBe(2);
    expect(lut.title).toBe("Neutral");
    expect(Array.from(lut.data)).toEqual(Array.from(identityLut(2).data));
    expect(lut.problems).toEqual([]);
  });

  it("normalises a custom domain", () => {
    const text = identity2.replace("DOMAIN_MIN 0 0 0", "DOMAIN_MIN -1 -1 -1").replace("DOMAIN_MAX 1 1 1", "DOMAIN_MAX 3 3 3");
    const lut = parseCubeLut(text);
    expect(lut.domainMin).toEqual([-1, -1, -1]);
    expect(lut.domainMax).toEqual([3, 3, 3]);
    expect(lut.data[0]).toBeCloseTo(0.25); // (0 - -1) / 4
    expect(lut.data[3]).toBeCloseTo(0.5); // (1 - -1) / 4
  });

  it("rejects 1D LUTs, missing size, wrong counts and bad numbers", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 4\n0 0 0\n", "a.cube")).toThrow(/a\.cube: 1D LUTs/);
    expect(() => parseCubeLut("0 0 0\n", "a.cube")).toThrow(/a\.cube: missing LUT_3D_SIZE/);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n", "a.cube")).toThrow(/expected 8 entries.*found 1/);
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n" + "0 0 x\n".repeat(8), "a.cube")).toThrow(/a\.cube: line 2/);
    expect(() => parseCubeLut("LUT_3D_SIZE 1\n", "a.cube")).toThrow(/2 to 256/);
  });
});

describe("LUT strips", () => {
  it("lays slices side by side: x = r + b*size, y = g", () => {
    const size = 2;
    const lut = identityLut(size);
    const { width, height, pixels } = lutStripRGBA8(lut);
    expect([width, height]).toEqual([4, 2]);
    const px = (x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    expect(px(1, 0)).toEqual([255, 0, 0, 255]); // r=1,g=0,b=0
    expect(px(0, 1)).toEqual([0, 255, 0, 255]); // g=1
    expect(px(2, 0)).toEqual([0, 0, 255, 255]); // b=1 slice starts at x=2
    expect(px(3, 1)).toEqual([255, 255, 255, 255]);
  });

  it("clamps and rounds RGBA8, keeps floats unclamped", () => {
    const lut = identityLut(2);
    lut.data[0] = 2;
    lut.data[1] = -1;
    lut.data[2] = 0.5;
    expect(Array.from(lutStripRGBA8(lut).pixels.slice(0, 4))).toEqual([255, 0, 128, 255]);
    expect(Array.from(lutStripRGBAFloat(lut).pixels.slice(0, 4))).toEqual([2, -1, 0.5, 1]);
  });
});

describe("assets", () => {
  afterEach(() => {
    Assets.clearSources();
    vi.unstubAllGlobals();
  });

  it(".cube is the Colour LUT kind", () => {
    expect(assetKind("grade/warm.CUBE")).toBe("lut");
  });

  it("Assets.text fetches once and caches", async () => {
    const fetchMock = vi.fn(async () => new Response(identity2));
    vi.stubGlobal("fetch", fetchMock);
    Assets.addSource(Assets.fromObject({ "grade/id.cube": "blob:x" }));
    expect(await Assets.text("asset:grade/id.cube")).toBe(identity2);
    expect(await Assets.text("grade/id.cube")).toBe(identity2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
