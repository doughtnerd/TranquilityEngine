// ADR 0426: SVG geometry for inline SVG: path data, shapes as paths, arc lengths (what `getTotalLength()` and
// `draw` read), hit-testing geometry, SVG transforms and the viewBox map.
import { describe, expect, it } from "vitest";
import { distanceToOutline, flattenPath, insideFill, parsePathData, parseSvgTransform, pathLength, pointAtLength, shapePath, viewBoxMap } from "../ui/svg/svgGeometry";

const attrs = (o: Record<string, string>) => (n: string) => o[n] ?? null;

describe("SVG path data and lengths (ADR 0426)", () => {
  it("reads relative, shorthand and implicit commands as absolute ones", () => {
    expect(parsePathData("m10 10 h20 v10 l-5 5 z")).toEqual([
      { c: "M", x: 10, y: 10 }, { c: "L", x: 30, y: 10 }, { c: "L", x: 30, y: 20 }, { c: "L", x: 25, y: 25 }, { c: "Z" },
    ]);
    expect(parsePathData("M0,0 10,0 10,10")).toEqual([{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "L", x: 10, y: 10 }]);
    const s = parsePathData("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0");
    expect(s[2]).toEqual({ c: "C", x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 }); // the first control reflected
    expect(parsePathData("M0 0 L 10 x 20 20")).toEqual([{ c: "M", x: 0, y: 0 }]); // stops at the error
  });

  it("measures lines exactly and curves and arcs by their arc length", () => {
    expect(pathLength(parsePathData("M0 0 L3 4 L3 10"))).toBe(11);
    // A half circle of radius 10 as an arc, and as a whole circle shape.
    expect(pathLength(parsePathData("M0 0 A10 10 0 0 1 20 0"))).toBeCloseTo(Math.PI * 10, 9);
    expect(pathLength(shapePath("circle", attrs({ cx: "0", cy: "0", r: "5" })))).toBeCloseTo(Math.PI * 10, 9);
    // An ellipse's perimeter (Ramanujan's second approximation is good to ~1e-9 here).
    const a = 20, b = 10, h = ((a - b) / (a + b)) ** 2;
    expect(pathLength(shapePath("ellipse", attrs({ rx: "20", ry: "10" })))).toBeCloseTo(Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 3);
    // A straight cubic is as long as its chord; a rounded rect is its sides plus a circle's worth of corners.
    expect(pathLength(parsePathData("M0 0 C 10 0 20 0 30 0"))).toBeCloseTo(30, 9);
    expect(pathLength(shapePath("rect", attrs({ width: "100", height: "50", rx: "10" })))).toBeCloseTo(2 * 80 + 2 * 30 + 2 * Math.PI * 10, 6);
    expect(pathLength(shapePath("polygon", attrs({ points: "0,0 10,0 10,10" })))).toBeCloseTo(20 + Math.SQRT2 * 10, 9);
  });

  it("finds the point at a length, along the arc", () => {
    const p = pointAtLength(parsePathData("M0 0 A10 10 0 0 1 20 0"), (Math.PI * 10) / 2);
    expect(p.x).toBeCloseTo(10, 5);
    expect(p.y).toBeCloseTo(-10, 5); // sweep 1 from the left end goes over the top in y-down coordinates
    expect(pointAtLength(parsePathData("M0 0 L10 0"), 99)).toEqual({ x: 10, y: 0 });
  });
});

describe("SVG hit geometry, transforms and the viewBox (ADR 0426)", () => {
  it("tests fills by nonzero or evenodd, and distance to the outline for strokes", () => {
    // A square with a square hole drawn the same way round: nonzero fills the hole, evenodd doesn't.
    const polys = flattenPath(parsePathData("M0 0 H30 V30 H0 Z M10 10 H20 V20 H10 Z"));
    expect(insideFill(polys, 15, 15, "nonzero")).toBe(true);
    expect(insideFill(polys, 15, 15, "evenodd")).toBe(false);
    expect(insideFill(polys, 5, 5, "evenodd")).toBe(true);
    expect(distanceToOutline(polys, 15, 32)).toBeCloseTo(2, 9);
    const circle = flattenPath(shapePath("circle", attrs({ cx: "0", cy: "0", r: "10" })));
    expect(insideFill(circle, 7, 7)).toBe(true);
    expect(insideFill(circle, 7.2, 7.2)).toBe(false);
  });

  it("composes SVG transform lists and fits a viewBox by preserveAspectRatio", () => {
    expect(parseSvgTransform("translate(10 20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseSvgTransform("rotate(90 10 10)")!;
    expect([r[0], r[1], r[2], r[3], r[4], r[5]].map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1, -1, 0, 20, 0]);
    expect(parseSvgTransform("")).toBeNull();
    expect(viewBoxMap("0 0 100 50", null, 200, 200)).toEqual([2, 0, 0, 2, 0, 50]); // meet, centred down
    expect(viewBoxMap("0 0 100 50", "xMinYMin slice", 200, 200)).toEqual([4, 0, 0, 4, 0, 0]);
    expect(viewBoxMap("10 10 100 50", "none", 200, 200)).toEqual([2, 0, 0, 4, -20, -40]);
    expect(viewBoxMap(null, null, 10, 10)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
