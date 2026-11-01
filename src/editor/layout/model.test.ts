import { describe, expect, it } from "vitest";
import {
  EDGE_BAND,
  HEADER_HEIGHT,
  MIN_CENTER,
  MIN_FRACTION,
  computeGeometry,
  defaultLayout,
  hitTest,
  movePanel,
  parseLayout,
  resizeDock,
  resizeSplit,
  type Layout,
  type PanelId,
} from "./model";

const bounds = { x: 0, y: 0, w: 1200, h: 800 };
const sides = (l: Layout) => l.docks.map((d) => `${d.side}:${d.groups.map((g) => g.panels.join("+")).join("|")}`);
const where = (l: Layout, p: PanelId) => l.docks.find((d) => d.groups.some((g) => g.panels.includes(p)))!;

describe("default layout", () => {
  it("puts Assets full width at the bottom, Hierarchy left, Inspector right", () => {
    const geo = computeGeometry(defaultLayout(), bounds);
    const [bottom, left, right] = geo.docks;
    expect(bottom.rect).toEqual({ x: 0, y: 800 - 190, w: 1200, h: 190 }); // outermost: full width
    expect(left.rect.h).toBe(800 - 190); // inside the bottom dock
    expect(right.rect.x + right.rect.w).toBe(1200);
    expect(geo.center).toEqual({ x: 240, y: 0, w: 1200 - 240 - 300, h: 610 });
  });
});

describe("moving panels", () => {
  it("to the outer edge: a new outermost dock that claims the full height", () => {
    const l = movePanel(defaultLayout(), "inspector", { kind: "edge", side: "left", placement: "outer" });
    expect(sides(l)).toEqual(["left:inspector", "bottom:assets", "left:hierarchy"]); // right dock emptied and removed
    const geo = computeGeometry(l, bounds);
    expect(geo.docks[0].rect).toEqual({ x: 0, y: 0, w: 240, h: 800 });
    expect(geo.docks[1].rect.x).toBe(240); // the bottom dock now starts right of it
  });

  it("to the viewport's edge: a new innermost dock beside the viewport", () => {
    const l = movePanel(defaultLayout(), "assets", { kind: "edge", side: "right", placement: "inner" });
    expect(sides(l)).toEqual(["left:hierarchy", "right:inspector", "right:assets"]);
    const geo = computeGeometry(l, bounds);
    expect(geo.docks[2].rect.h).toBe(800); // no bottom dock any more
  });

  it("into a dock: splits it evenly at the drop position", () => {
    let l = resizeSplit(movePanel(defaultLayout(), "assets", { kind: "split", dock: "left", index: 0 }), "left", 0, 0.3);
    expect(sides(l)).toEqual(["left:assets|hierarchy", "right:inspector"]);
    l = movePanel(l, "inspector", { kind: "split", dock: "left", index: 1 });
    expect(sides(l)).toEqual(["left:assets|inspector|hierarchy"]);
    expect(where(l, "assets").fractions).toEqual([1 / 3, 1 / 3, 1 / 3]); // uniform again after the drop
  });

  it("onto another panel's header: joins it as the active tab", () => {
    const l = movePanel(defaultLayout(), "inspector", { kind: "tab", group: "hierarchy" });
    expect(sides(l)).toEqual(["bottom:assets", "left:hierarchy+inspector"]);
    expect(where(l, "inspector").groups[0].active).toBe("inspector");
  });

  it("returns the same layout for moves that change nothing or have no target", () => {
    const l = defaultLayout();
    expect(movePanel(l, "hierarchy", { kind: "split", dock: "left", index: 0 })).toBe(l);
    expect(movePanel(l, "hierarchy", { kind: "split", dock: "left", index: 1 })).toBe(l);
    expect(movePanel(l, "hierarchy", { kind: "tab", group: "nope" })).toBe(l);
    expect(movePanel(l, "hierarchy", { kind: "split", dock: "nope", index: 0 })).toBe(l);
  });

  it("taking the last tab out of a group keeps the other tab active", () => {
    const tabbed = movePanel(defaultLayout(), "inspector", { kind: "tab", group: "hierarchy" });
    const l = movePanel(tabbed, "inspector", { kind: "edge", side: "right", placement: "inner" });
    expect(where(l, "hierarchy").groups[0]).toMatchObject({ panels: ["hierarchy"], active: "hierarchy" });
  });
});

describe("resizing", () => {
  it("clamps docks so the viewport keeps its minimum size", () => {
    const l = resizeDock(defaultLayout(), "left", 5000);
    const geo = computeGeometry(l, bounds);
    expect(geo.center.w).toBeGreaterThanOrEqual(MIN_CENTER.w - 1);
    expect(l.docks[1].size).toBe(5000); // stored as asked, drawn clamped
  });

  it("moves a split between groups, keeping both above the minimum", () => {
    const l = movePanel(defaultLayout(), "assets", { kind: "split", dock: "left", index: 1 });
    const r = resizeSplit(l, "left", 0, 0.9);
    expect(where(r, "assets").fractions[1]).toBeCloseTo(MIN_FRACTION);
  });
});

describe("hit testing a drag", () => {
  const l = defaultLayout();
  const geo = computeGeometry(l, bounds);

  it("over another group's header targets tabs; over its own header nothing", () => {
    const h = geo.docks[1].groups[0].header;
    expect(hitTest(l, geo, "inspector", h.x + 20, h.y + HEADER_HEIGHT / 2)?.target).toEqual({ kind: "tab", group: "hierarchy" });
    expect(hitTest(l, geo, "hierarchy", h.x + 20, h.y + HEADER_HEIGHT / 2)).toBeNull();
  });

  it("at the window's outer edges targets new outermost docks", () => {
    expect(hitTest(l, geo, "inspector", 5, 300)?.target).toEqual({ kind: "edge", side: "left", placement: "outer" });
    expect(hitTest(l, geo, "hierarchy", 1195, 300)?.target).toEqual({ kind: "edge", side: "right", placement: "outer" });
    expect(hitTest(l, geo, "inspector", 600, 795)?.target).toEqual({ kind: "edge", side: "bottom", placement: "outer" });
    expect(hitTest(l, geo, "inspector", 5, 300)!.preview).toMatchObject({ x: 0, y: 0, h: 800 });
  });

  it("at the viewport's edges targets new innermost docks; its middle is invalid", () => {
    const c = geo.center;
    expect(hitTest(l, geo, "assets", c.x + 5, 200)?.target).toEqual({ kind: "edge", side: "left", placement: "inner" });
    expect(hitTest(l, geo, "hierarchy", c.x + c.w / 2, c.y + c.h - 5)?.target).toEqual({ kind: "edge", side: "bottom", placement: "inner" });
    expect(hitTest(l, geo, "inspector", c.x + c.w / 2, c.y + c.h / 2)).toBeNull();
    expect(hitTest(l, geo, "inspector", -10, 300)).toBeNull(); // outside the layout
  });

  it("inside a dock targets a split before or after the group under the pointer", () => {
    const left = geo.docks[1].rect;
    const x = left.x + EDGE_BAND + 20;
    expect(hitTest(l, geo, "inspector", x, left.y + left.h * 0.25)?.target).toEqual({ kind: "split", dock: "left", index: 0 });
    const lower = hitTest(l, geo, "inspector", x, left.y + left.h * 0.75)!;
    expect(lower.target).toEqual({ kind: "split", dock: "left", index: 1 });
    expect(lower.preview).toMatchObject({ y: left.y + left.h / 2, h: left.h / 2 }); // the bottom half
    expect(hitTest(l, geo, "hierarchy", x, left.y + left.h * 0.75)).toBeNull(); // its own dock, same place
  });
});

describe("saved layouts", () => {
  it("accepts a valid layout and rejects broken or incomplete ones", () => {
    const l = movePanel(defaultLayout(), "inspector", { kind: "tab", group: "hierarchy" });
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ version: 1, docks: [] })).toBeNull(); // panels missing
    const dup = structuredClone(l);
    dup.docks[0].groups[0].panels.push("inspector");
    expect(parseLayout(dup)).toBeNull();
    expect(parseLayout({ version: 2, docks: l.docks })).toBeNull();
  });
});
