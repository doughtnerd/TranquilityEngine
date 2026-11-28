// ADR 0440: y-sorted sorting layers. A draw's height decides its place within its order in layer, in one place
// (`ySortWithin`), and its place (`drawPlace`) is what layered 2D content sits at and what picking ranks by.
import { describe, expect, it } from "vitest";
import { drawPlace, isYSorted, sortingOrder, WITHIN_SPAN, withinOrder, ySortFraction, ySortWithin } from "../render/sortOrder";

const render = { sortingLayers: ["Back", "World", "Front"], ySortedLayers: ["World"] };

describe("ySortFraction", () => {
  it("maps higher y to a smaller fraction, monotonically, into [0, 1)", () => {
    const ys = [-1e6, -100_000, -5000, -1, -0.001, 0, 0.001, 1, 5000, 99_999, 100_000, 1e6];
    const fs = ys.map(ySortFraction);
    for (const f of fs) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
    for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeLessThanOrEqual(fs[i - 1]!);
    expect(ySortFraction(0)).toBe(0.5);
    expect(ySortFraction(1)).toBeLessThan(ySortFraction(0.999)); // linear inside ±100 000: small steps tell apart
  });

  it("clamps beyond ±100 000 units, and counts NaN as 0", () => {
    expect(ySortFraction(100_000)).toBe(0);
    expect(ySortFraction(Number.POSITIVE_INFINITY)).toBe(0);
    expect(ySortFraction(-200_000)).toBe(ySortFraction(-100_000));
    expect(ySortFraction(Number.NEGATIVE_INFINITY)).toBeLessThan(1);
    expect(ySortFraction(Number.NaN)).toBe(ySortFraction(0));
  });
});

describe("y-sorted places", () => {
  it("give a draw's within only in a y-sorted layer", () => {
    expect(isYSorted(render, "World")).toBe(true);
    expect(isYSorted(render, "Back")).toBe(false);
    expect(ySortWithin(render, "World", 3)).toBe(ySortFraction(3));
    expect(ySortWithin(render, "Back", 3)).toBe(0);
    expect(ySortWithin({ sortingLayers: ["Default"] }, "Default", 3)).toBe(0); // no y-sorted layers listed
  });

  it("put higher draws lower within their order in layer, and every height below the next order", () => {
    const at = (order: number, y: number) => drawPlace(render, "World", order, y);
    expect(at(0, 10)).toBeLessThan(at(0, 5)); // higher draws first, so lower things draw over it
    expect(at(0, -1e9)).toBeLessThan(at(1, 1e9)); // orders in layer still sort first
    expect(at(0, 0)).toBe(sortingOrder(render.sortingLayers, "World", 0) + withinOrder(ySortFraction(0)));
    expect(at(0, -1e9) - sortingOrder(render.sortingLayers, "World", 0)).toBeLessThan(WITHIN_SPAN);
    expect(drawPlace(render, "Back", 2, 10)).toBe(2); // not y-sorted: the plain draw order
    expect(drawPlace(render, "Back", 2, -10)).toBe(2);
  });

  it("warn about an unknown layer as sortingOrder does", () => {
    const warned: string[] = [];
    expect(drawPlace(render, "Nope", 1, 0, (l) => warned.push(l))).toBe(1);
    expect(warned).toEqual(["Nope"]);
  });
});
