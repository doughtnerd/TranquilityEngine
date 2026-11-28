import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { automaticHeights } from "../../../engine/render/visibility/select";
import { cssVar } from "../../theme";
import { dragDivider, fractionToHeight, heightToFraction, heightsToEdit, layoutBar, levelTriangles, MIN_GAP, markerFraction, percentLabel, segmentColor, segmentLabel, togglePreview } from "./lodBarLogic";

describe("layoutBar", () => {
  it("gives a segment per level and a culled one, widths from the heights", () => {
    const { segments, dividers } = layoutBar([0.5, 0.25, 0.1]);
    expect(segments.map((s) => [s.level, s.from, s.to])).toEqual([[0, 1, 0.5], [1, 0.5, 0.25], [2, 0.25, 0.1], [-1, 0.1, 0]]);
    expect(segments.map((s) => s.width)).toEqual([0.5, 0.25, 0.15, 0.1].map((w) => expect.closeTo(w, 10)));
    expect(segments.map((s) => s.left)).toEqual([0, 0.5, 0.75, 0.9].map((w) => expect.closeTo(w, 10)));
    expect(dividers.map((d) => [d.index, d.height, d.left])).toEqual([[0, 0.5, 0.5], [1, 0.25, 0.75], [2, 0.1, 0.9]]);
  });

  it("has no culled segment when the last height is 0 (never culls)", () => {
    const { segments } = layoutBar([0.4, 0]);
    expect(segments.map((s) => s.level)).toEqual([0, 1]);
    expect(segments.reduce((w, s) => w + s.width, 0)).toBeCloseTo(1, 10);
  });

  it("lays out the automatic heights of the ADR's rock example", () => {
    const { segments } = layoutBar([0.149, 0.093, 0.056, 0.01]);
    expect(segments).toHaveLength(5);
    expect(segments.reduce((w, s) => w + s.width, 0)).toBeCloseTo(1, 10);
    expect(segments[0].width).toBeCloseTo(0.851, 10);
  });

  it("lays out a single level as the whole bar", () => {
    expect(layoutBar([0]).segments).toEqual([{ level: 0, from: 1, to: 0, left: 0, width: 1 }]);
    expect(layoutBar([]).segments).toEqual([]);
  });

  it("clips a height above 1 to the left edge and gives the level no width", () => {
    const { segments } = layoutBar([1.4, 0.5]);
    expect(segments[0].width).toBe(0);
    expect(segments[1].width).toBeCloseTo(0.5, 10);
  });

  it("maps heights and positions to each other", () => {
    expect(heightToFraction(1)).toBe(0);
    expect(heightToFraction(0)).toBe(1);
    expect(fractionToHeight(0.25)).toBe(0.75);
    expect(fractionToHeight(-3)).toBe(1);
    expect(fractionToHeight(9)).toBe(0);
  });
});

describe("dragDivider", () => {
  const heights = [0.5, 0.25, 0.1];

  it("moves one divider and leaves the others", () => {
    expect(dragDivider(heights, 1, 0.3)).toEqual([0.5, 0.3, 0.1]);
  });

  it("keeps it between its neighbours so the heights stay descending", () => {
    expect(dragDivider(heights, 1, 0.9)).toEqual([0.5, 0.5 - MIN_GAP, 0.1]);
    expect(dragDivider(heights, 1, 0.01)).toEqual([0.5, 0.1 + MIN_GAP, 0.1]);
    const out = dragDivider(heights, 0, 5);
    expect(out[0]).toBe(1);
    expect(dragDivider(heights, 0, -5)[0]).toBe(0.25 + MIN_GAP);
  });

  it("lets the last divider reach 0 (never cull) and stay under 1", () => {
    expect(dragDivider(heights, 2, -1)).toEqual([0.5, 0.25, 0]);
    expect(dragDivider(heights, 2, 0.9)).toEqual([0.5, 0.25, 0.25 - MIN_GAP]);
  });

  it("rounds to four decimals", () => {
    expect(dragDivider(heights, 1, 0.123456)[1]).toBe(0.1235);
  });

  it("ignores a bad index or height and does not change its input", () => {
    expect(dragDivider(heights, 5, 0.2)).toEqual(heights);
    expect(dragDivider(heights, -1, 0.2)).toEqual(heights);
    expect(dragDivider(heights, 1, NaN)).toEqual(heights);
    const before = [...heights];
    dragDivider(heights, 1, 0.3);
    expect(heights).toEqual(before);
  });

  it("always yields descending heights in [0, 1], whatever the drag", () => {
    for (const index of [0, 1, 2]) {
      for (const h of [-2, 0, 0.05, 0.1, 0.2, 0.3, 0.6, 0.99, 1, 3]) {
        const out = dragDivider(heights, index, h);
        expect(out.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v < out[i - 1]))).toBe(true);
      }
    }
  });
});

describe("heightsToEdit", () => {
  const automatic = automaticHeights([{ pixelError: 1, levels: [{ error: 0 }, { error: 0.01 }, { error: 0.02 }] }]);

  it("takes the group's own levels when it has them", () => {
    expect(heightsToEdit([0.6, 0.2, 0.05], automatic)).toEqual([0.6, 0.2, 0.05]);
  });

  it("materialises the automatic heights when `levels` is empty, so the first drag writes them out", () => {
    const heights = heightsToEdit([], automatic)!;
    expect(heights).toEqual(automatic);
    expect(heights).toHaveLength(3);
    expect(dragDivider(heights, 0, 0.4)).toHaveLength(3);
  });

  it("is null with a single level: nothing to drag", () => {
    expect(heightsToEdit([], automaticHeights([]))).toBeNull();
    expect(heightsToEdit([0], [])).toBeNull();
  });
});

describe("labels", () => {
  it("sums triangles over the meshes, a mesh with fewer levels counting its last", () => {
    const meshes = [{ levels: [1000, 500, 250] }, { levels: [400, 200] }, { levels: [90] }];
    expect([0, 1, 2, 3].map((i) => levelTriangles(meshes, i))).toEqual([1490, 790, 540, 540]);
  });

  it("formats percentages", () => {
    expect(percentLabel(0.149)).toBe("14.9%");
    expect(percentLabel(0.5)).toBe("50%");
    expect(percentLabel(0.01)).toBe("1%");
    expect(percentLabel(0.0056)).toBe("0.56%");
    expect(percentLabel(0)).toBe("0%");
  });

  it("labels a level with its number, height and triangles, and the culled segment", () => {
    const heights = [0.5, 0.1];
    const [first, , culled] = layoutBar(heights).segments;
    expect(segmentLabel(first, heights, 12840)).toEqual({ name: "LOD0", height: "≥ 50%", triangles: "12,840 tris" });
    expect(segmentLabel(first, heights, null).triangles).toBe("");
    expect(segmentLabel(culled, heights, null)).toEqual({ name: "Culled", height: "< 10%", triangles: "" });
  });
});

describe("colours", () => {
  it("name theme tokens, one per level and one for culled, all painted at first paint by editor.css", () => {
    expect(segmentColor(0)).toBe("var(--lod0)");
    expect(segmentColor(3)).toBe("var(--lod3)");
    expect(segmentColor(20)).toBe("var(--lod7)");
    expect(segmentColor(-1)).toBe("var(--lod-culled)");
    const css = readFileSync(new URL("../editor.css", import.meta.url), "utf8");
    for (const key of ["lod0", "lod1", "lod2", "lod3", "lod4", "lod5", "lod6", "lod7", "lodCulled"]) {
      expect(css, key).toContain(`${cssVar(key)}: #`);
    }
  });
});

describe("scene view preview and camera marker", () => {
  it("clicking a segment previews it, clicking it again clears, clicking another switches (the culled segment is -1)", () => {
    expect(togglePreview(null, 1)).toBe(1);
    expect(togglePreview(1, 1)).toBeNull();
    expect(togglePreview(1, 2)).toBe(2);
    expect(togglePreview(null, -1)).toBe(-1);
    expect(togglePreview(0, 0)).toBeNull();
  });

  it("places the marker at the camera's height on the same axis as the segments", () => {
    expect(markerFraction(null)).toBeNull();
    expect(markerFraction(Number.NaN)).toBeNull();
    expect(markerFraction(1)).toBe(0);
    expect(markerFraction(0)).toBe(1);
    expect(markerFraction(0.25)).toBeCloseTo(0.75, 10);
    expect(markerFraction(3)).toBe(0); // above the view: pinned to the left edge
  });
});
