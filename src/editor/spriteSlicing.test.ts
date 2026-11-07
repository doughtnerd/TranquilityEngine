import { describe, expect, it } from "vitest";
import {
  autoSlice,
  clampRect,
  dragBorderSide,
  fitBorder,
  setBorderSide,
  gridByCellSize,
  gridByCount,
  isEmptyRect,
  moveRect,
  pivotLabel,
  readingOrder,
  rectBetween,
  resizeRect,
  sliceBase,
  sliceNames,
  sliceRenames,
  type Pixels,
} from "./spriteSlicing";

/** A synthetic RGBA image from rows of characters: "#" opaque, "." transparent. */
function image(rows: string[]): Pixels {
  const height = rows.length, width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => [...row].forEach((c, x) => (data[(y * width + x) * 4 + 3] = c === "#" ? 255 : 0)));
  return { width, height, data };
}

describe("grid slicing", () => {
  it("cuts by cell size, with offset and padding, leaving out partial cells", () => {
    expect(gridByCellSize(4, 4, 2, 2)).toEqual([[0, 0, 2, 2], [2, 0, 2, 2], [0, 2, 2, 2], [2, 2, 2, 2]]);
    expect(gridByCellSize(5, 3, 2, 2)).toEqual([[0, 0, 2, 2], [2, 0, 2, 2]]);
    expect(gridByCellSize(10, 4, 3, 4, [1, 0], [1, 0])).toEqual([[1, 0, 3, 4], [5, 0, 3, 4]]);
    expect(gridByCellSize(4, 4, 0, 2)).toEqual([]);
  });

  it("cuts by cell count", () => {
    expect(gridByCount(500, 500, 2, 2)).toEqual([[0, 0, 250, 250], [250, 0, 250, 250], [0, 250, 250, 250], [250, 250, 250, 250]]);
    expect(gridByCount(10, 4, 3, 1)).toEqual([[0, 0, 3, 4], [3, 0, 3, 4], [6, 0, 3, 4]]);
  });

  it("tells empty cells", () => {
    const img = image(["#...", "....", "..##", "..##"]);
    expect(isEmptyRect(img, [0, 0, 2, 2])).toBe(false);
    expect(isEmptyRect(img, [2, 0, 2, 2])).toBe(true);
    expect(gridByCellSize(4, 4, 2, 2).filter((r) => !isEmptyRect(img, r))).toEqual([[0, 0, 2, 2], [2, 2, 2, 2]]);
  });
});

describe("automatic slicing", () => {
  it("boxes each island of opaque pixels in reading order, diagonals joining", () => {
    const img = image([
      "##....#",
      "##...#.",
      ".......",
      "...##..",
      "...##..",
    ]);
    expect(autoSlice(img)).toEqual([[0, 0, 2, 2], [5, 0, 2, 2], [3, 3, 2, 2]]);
  });

  it("merges overlapping boxes and drops small ones", () => {
    const img = image([
      "###..",
      "#....",
      "#.#..",
      "...#.",
      ".....",
      "....#",
    ]);
    // The L and the diagonal pair touch; their boxes overlap and merge. The lone pixel is too small.
    expect(autoSlice(img, { minSize: 2 })).toEqual([[0, 0, 4, 4]]);
  });

  it("finds nothing in a transparent image", () => {
    expect(autoSlice(image(["....", "...."]))).toEqual([]);
  });

  it("orders rows top to bottom, then left to right", () => {
    expect(readingOrder([[10, 1, 4, 4], [0, 0, 4, 4], [0, 10, 4, 4]])).toEqual([[0, 0, 4, 4], [10, 1, 4, 4], [0, 10, 4, 4]]);
  });
});

describe("editing rectangles", () => {
  it("draws between two corners, inside the image", () => {
    expect(rectBetween([5, 5], [2, 1], 10, 10)).toEqual([2, 1, 3, 4]);
    expect(rectBetween([5, 5], [5, 9], 10, 10)).toBeNull();
    expect(rectBetween([8, 8], [20, 20], 10, 10)).toEqual([8, 8, 2, 2]);
  });

  it("moves and clamps to the image", () => {
    expect(moveRect([0, 0, 4, 4], 3, 2, 10, 10)).toEqual([3, 2, 4, 4]);
    expect(moveRect([0, 0, 4, 4], 30, -2, 10, 10)).toEqual([6, 0, 4, 4]);
    expect(clampRect([-1, -1, 20, 0.2], 10, 10)).toEqual([0, 0, 10, 1]);
  });

  it("resizes from a handle, the opposite edges staying put", () => {
    expect(resizeRect([2, 2, 4, 4], "se", 2, 1, 10, 10)).toEqual([2, 2, 6, 5]);
    expect(resizeRect([2, 2, 4, 4], "nw", -1, -1, 10, 10)).toEqual([1, 1, 5, 5]);
    expect(resizeRect([2, 2, 4, 4], "w", 10, 0, 10, 10)).toEqual([5, 2, 1, 4]); // stops a pixel short
    expect(resizeRect([2, 2, 4, 4], "e", 10, 0, 10, 10)).toEqual([2, 2, 8, 4]); // stops at the border
  });
});

describe("names and pivots", () => {
  it("names slices after the image, skipping taken names", () => {
    expect(sliceBase("images/hero sheet.png")).toBe("hero sheet");
    expect(sliceNames("hero", 3, ["hero_1"])).toEqual(["hero_0", "hero_2", "hero_3"]);
  });

  it("finds renamed slices", () => {
    expect(sliceRenames([{ name: "a", original: "a" }, { name: "walk", original: "b" }, { name: "new", original: null }])).toEqual([["b", "walk"]]);
  });

  it("labels pivots", () => {
    expect(pivotLabel([0.5, 0.5])).toBe("Center");
    expect(pivotLabel([0.5, 0])).toBe("Bottom");
    expect(pivotLabel([0.3, 0])).toBe("Custom");
  });
});

describe("9-slice borders", () => {
  const rect: [number, number, number, number] = [0, 0, 20, 10];
  it("sets a side as a whole number inside the slice", () => {
    expect(setBorderSide(undefined, 0, 4.4, rect)).toEqual([4, 0, 0, 0]);
    expect(setBorderSide([2, 1, 3, 1], 3, -5, rect)).toEqual([2, 1, 3, 0]);
  });
  it("keeps opposite sides from crossing", () => {
    expect(setBorderSide([0, 0, 15, 0], 0, 12, rect)).toEqual([5, 0, 15, 0]);
    expect(setBorderSide([0, 4, 0, 0], 3, 99, rect)).toEqual([0, 4, 0, 6]);
  });
  it("drags a guide from where it started", () => {
    expect(dragBorderSide([3, 0, 0, 0], 0, 3, 5, rect)).toEqual([8, 0, 0, 0]);
    expect(dragBorderSide([3, 0, 0, 0], 0, 3, -9, rect)).toEqual([0, 0, 0, 0]);
  });
  it("fits a border into a smaller rect", () => {
    expect(fitBorder(undefined, rect)).toBeUndefined();
    const b = fitBorder([10, 6, 10, 6], [0, 0, 12, 8])!;
    expect(b[0] + b[2]).toBeLessThanOrEqual(12);
    expect(b[1] + b[3]).toBeLessThanOrEqual(8);
  });
});
