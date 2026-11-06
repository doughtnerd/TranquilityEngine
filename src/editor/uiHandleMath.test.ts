// The scene view's UI handle maths (ADR 0077 wave B part 3): canvas ↔ UI pixel maps, resizing from
// each handle, percentages, aspect lock, snapping, moving absolute elements and flex reorder targets.
import { describe, expect, it } from "vitest";
import {
  HANDLES,
  boxMap,
  handlePoints,
  moveAttributes,
  parseLength,
  reorderTarget,
  resizeAttributes,
  type BoxOnCanvas,
  type HandleId,
  type ResizeStart,
} from "./uiHandleMath";

const rect = (x: number, y: number, w: number, h: number, scale = 1): BoxOnCanvas => ({
  points: [
    [x, y],
    [x + w * scale, y],
    [x + w * scale, y + h * scale],
    [x, y + h * scale],
  ],
  size: [w, h],
});

const close = (a: readonly number[] | null, b: readonly number[]) => {
  expect(a).not.toBeNull();
  a!.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

describe("canvas ↔ UI pixels", () => {
  it("divides by the canvas scale on a screen canvas", () => {
    // A 100×50 UI-pixel box drawn at scale 2 from (10, 20).
    const map = boxMap(rect(10, 20, 100, 50, 2))!;
    close(map.toLocal([10, 20]), [0, 0]);
    close(map.toLocal([210, 120]), [100, 50]);
    close(map.toLocal([40, 30]), [15, 5]); // 30 × 10 CSS pixels is 15 × 5 UI pixels
    close(map.toCanvas([50, 25]), [110, 70]);
  });

  it("inverts a perspective view of a world canvas exactly", () => {
    // A 200×100 rectangle seen in perspective: a trapezoid narrower at the top.
    const box: BoxOnCanvas = { points: [[40, 10], [160, 10], [200, 90], [0, 90]], size: [200, 100] };
    const map = boxMap(box)!;
    for (const [u, v] of [[0, 0], [200, 0], [200, 100], [0, 100], [100, 50], [37, 81]]) close(map.toLocal(map.toCanvas([u, v])), [u, v]);
    close(map.toCanvas([200, 100]), [200, 90]);
    // Further away (the top) a canvas pixel is more UI pixels than near the bottom.
    const top = map.toLocal([101, 10])![0] - map.toLocal([100, 10])![0];
    const bottom = map.toLocal([101, 90])![0] - map.toLocal([100, 90])![0];
    expect(top).toBeGreaterThan(bottom);
  });

  it("refuses a degenerate box", () => {
    expect(boxMap(rect(0, 0, 0, 10))).toBeNull();
    expect(boxMap({ points: [[0, 0], [0, 0], [0, 0], [0, 0]], size: [10, 10] })).toBeNull();
  });

  it("places the eight handles on corners and edge midpoints", () => {
    const box = rect(0, 0, 100, 40, 2);
    const at = Object.fromEntries(handlePoints(boxMap(box)!, box.size).map((h) => [h.id, h.at]));
    expect(Object.keys(at)).toEqual([...HANDLES]);
    close(at.nw, [0, 0]);
    close(at.n, [100, 0]);
    close(at.e, [200, 40]);
    close(at.se, [200, 80]);
    close(at.w, [0, 40]);
  });
});

const start = (over: Partial<ResizeStart> = {}): ResizeStart => ({
  width: 100,
  height: 50,
  widthValue: "100",
  heightValue: 50,
  absolute: false,
  left: "auto",
  top: "auto",
  parentWidth: 400,
  parentHeight: 200,
  ...over,
});

describe("resizing", () => {
  it("sets width and height from each handle", () => {
    const cases: Record<HandleId, Record<string, string>> = {
      nw: { width: "90", height: "45" },
      n: { height: "45" },
      ne: { width: "110", height: "45" },
      e: { width: "110" },
      se: { width: "110", height: "55" },
      s: { height: "55" },
      sw: { width: "90", height: "55" },
      w: { width: "90" },
    };
    for (const id of HANDLES) expect(resizeAttributes(start(), id, 10, 5), id).toEqual(cases[id]);
  });

  it("moves left/top with the west and north edges of an absolute element placed by them", () => {
    const abs = start({ absolute: true, left: "30", top: 20 });
    expect(resizeAttributes(abs, "nw", 10, 5)).toEqual({ width: "90", height: "45", left: "40", top: "25" });
    expect(resizeAttributes(abs, "se", 10, 5)).toEqual({ width: "110", height: "55" });
    // Placed by right/bottom: the far edges stay, only the size changes.
    expect(resizeAttributes(start({ absolute: true }), "nw", 10, 5)).toEqual({ width: "90", height: "45" });
    // A percent offset stays a percentage of the parent (400 wide): 10 px more is 2.5% more.
    expect(resizeAttributes(start({ absolute: true, left: "10%" }), "w", 10, 0)).toEqual({ width: "90", left: "12.5%" });
  });

  it("keeps a percentage a percentage, scaled with the box", () => {
    expect(resizeAttributes(start({ widthValue: "50%", width: 200 }), "e", 100, 0)).toEqual({ width: "75%" });
    expect(resizeAttributes(start({ heightValue: "25%" }), "s", 0, -10)).toEqual({ height: "20%" });
    // A box with no width yet: a percentage of the parent's.
    expect(resizeAttributes(start({ widthValue: "0%", width: 0 }), "e", 40, 0)).toEqual({ width: "10%" });
    // auto becomes pixels.
    expect(resizeAttributes(start({ widthValue: "auto" }), "e", 7, 0)).toEqual({ width: "107" });
  });

  it("keeps the aspect ratio with Shift", () => {
    // 100×50: a corner follows the side that changed more.
    expect(resizeAttributes(start(), "se", 50, 5, { keepAspect: true })).toEqual({ width: "150", height: "75" });
    expect(resizeAttributes(start(), "se", 5, 50, { keepAspect: true })).toEqual({ width: "200", height: "100" });
    // An edge scales the other side with it.
    expect(resizeAttributes(start(), "e", 20, 0, { keepAspect: true })).toEqual({ width: "120", height: "60" });
    expect(resizeAttributes(start(), "n", 0, 10, { keepAspect: true })).toEqual({ width: "80", height: "40" });
  });

  it("snaps to whole pixels unless told not to, and never goes below zero", () => {
    expect(resizeAttributes(start(), "e", 10.4, 0)).toEqual({ width: "110" });
    expect(resizeAttributes(start(), "e", 10.4, 0, { snap: false })).toEqual({ width: "110.4" });
    expect(resizeAttributes(start(), "w", 500, 0)).toEqual({ width: "0" });
  });
});

describe("moving an absolute element", () => {
  const at = { left: "auto", top: "auto", right: "auto", bottom: "auto", x: 15, y: 25, parentWidth: 400, parentHeight: 200 };
  it("moves the offsets that place it", () => {
    expect(moveAttributes({ ...at, left: "10", top: "20" }, 5, -5)).toEqual({ left: "15", top: "15" });
    expect(moveAttributes({ ...at, right: 10, bottom: "20px" }, 5, -5)).toEqual({ right: "5", bottom: "25" });
    expect(moveAttributes({ ...at, left: "25%" }, 40, 0)).toEqual({ left: "35%" });
    expect(moveAttributes({ ...at, left: "10" }, 0, 3)).toEqual({ top: "28" }); // unplaced vertically: from where it is
  });

  it("writes left/top from where it is when nothing places it", () => {
    expect(moveAttributes(at, 5, 5)).toEqual({ left: "20", top: "30" });
    expect(moveAttributes(at, 0, 0)).toEqual({});
  });
});

describe("reordering in flex flow", () => {
  // Siblings a(0), c(2), d(3) along a row, the dragged b at markup index 1 (left out).
  const row = [
    { index: 0, start: 0, end: 50 },
    { index: 2, start: 120, end: 170 },
    { index: 3, start: 180, end: 230 },
  ];
  it("drops before the first sibling whose middle is past the pointer", () => {
    expect(reorderTarget(row, 10, 1, false)).toEqual({ index: 0, marker: 0, same: false });
    expect(reorderTarget(row, 100, 1, false)).toEqual({ index: 2, marker: 85, same: true }); // where it is
    expect(reorderTarget(row, 160, 1, false)).toEqual({ index: 3, marker: 175, same: false });
    expect(reorderTarget(row, 500, 1, false)).toEqual({ index: 4, marker: 230, same: false });
    expect(reorderTarget([], 10, 0, false)).toBeNull();
  });

  it("runs against markup order in a reversed direction", () => {
    // row-reverse: markup 3 is leftmost, then 2, then 0.
    const rev = [
      { index: 3, start: 0, end: 50 },
      { index: 2, start: 60, end: 110 },
      { index: 0, start: 180, end: 230 },
    ];
    expect(reorderTarget(rev, 10, 1, true)).toMatchObject({ index: 4, same: false }); // visually first: after 3 in markup
    expect(reorderTarget(rev, 500, 1, true)).toMatchObject({ index: 0, same: false }); // visually last: before 0
    expect(reorderTarget(rev, 150, 1, true)).toMatchObject({ index: 1, same: true });
  });
});

describe("lengths", () => {
  it("reads pixels, percentages and auto", () => {
    expect(parseLength(12)).toEqual({ kind: "px", value: 12 });
    expect(parseLength("12px")).toEqual({ kind: "px", value: 12 });
    expect(parseLength("12.5%")).toEqual({ kind: "%", value: 12.5 });
    expect(parseLength("auto")).toEqual({ kind: "auto" });
    expect(parseLength("")).toEqual({ kind: "auto" });
  });
});
