import { describe, expect, it } from "vitest";
import {
  EDGE_BAND,
  HEADER_HEIGHT,
  MIN_FILL,
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
  it("puts Assets (with the Code tab) full width at the bottom, Hierarchy left, Inspector right, the scene filling the middle", () => {
    const geo = computeGeometry(defaultLayout(), bounds);
    const [bottom, left, right, main] = geo.docks;
    expect(bottom.rect).toEqual({ x: 0, y: 800 - 190, w: 1200, h: 190 }); // outermost: full width
    expect(left.rect.h).toBe(800 - 190); // inside the bottom dock
    expect(right.rect.x + right.rect.w).toBe(1200);
    expect(main.groups[0].group.panels).toEqual(["scene"]);
    expect(main.rect).toEqual({ x: 240, y: 0, w: 1200 - 240 - 300, h: 610 });
    expect(geo.fill).toEqual(main.rect);
    expect(main.handle).toBeNull(); // the filling dock has no size to drag
  });
});

describe("moving panels", () => {
  it("to the outer edge: a new outermost dock that claims the full height", () => {
    const l = movePanel(defaultLayout(), "inspector", { kind: "edge", side: "left", placement: "outer" });
    expect(sides(l)).toEqual(["left:inspector", "bottom:assets+code", "left:hierarchy", "right:history+worlds+network", "left:scene"]); // History stays on the right
    const geo = computeGeometry(l, bounds);
    expect(geo.docks[0].rect).toEqual({ x: 0, y: 0, w: 240, h: 800 });
    expect(geo.docks[1].rect.x).toBe(240); // the bottom dock now starts right of it
  });

  it("to the filling dock's edge: a new dock just outside it", () => {
    const l = movePanel(defaultLayout(), "assets", { kind: "edge", side: "right", placement: "inner" });
    expect(sides(l)).toEqual(["bottom:code", "left:hierarchy", "right:inspector+history+worlds+network", "right:assets", "left:scene"]);
    const geo = computeGeometry(l, bounds);
    expect(geo.docks[3].rect.h).toBe(610); // inside the bottom dock, which still holds Code
    expect(geo.fill.x + geo.fill.w).toBe(geo.docks[3].rect.x); // the scene still fills the rest
  });

  it("into a dock: splits it evenly at the drop position", () => {
    let l = resizeSplit(movePanel(defaultLayout(), "assets", { kind: "split", dock: "left", index: 0 }), "left", 0, 0.3);
    expect(sides(l)).toEqual(["bottom:code", "left:assets|hierarchy", "right:inspector+history+worlds+network", "left:scene"]);
    l = movePanel(l, "inspector", { kind: "split", dock: "left", index: 1 });
    expect(sides(l)).toEqual(["bottom:code", "left:assets|inspector|hierarchy", "right:history+worlds+network", "left:scene"]);
    expect(where(l, "assets").fractions).toEqual([1 / 3, 1 / 3, 1 / 3]); // uniform again after the drop
  });

  it("onto another panel's header: joins it as the active tab", () => {
    const l = movePanel(defaultLayout(), "inspector", { kind: "tab", group: "hierarchy" });
    expect(sides(l)).toEqual(["bottom:assets+code", "left:hierarchy+inspector", "right:history+worlds+network", "left:scene"]);
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

describe("the scene view as a panel", () => {
  it("can join another group as a tab; the next dock in then fills the middle", () => {
    const l = movePanel(defaultLayout(), "scene", { kind: "tab", group: "assets" });
    expect(sides(l)).toEqual(["bottom:assets+code+scene", "left:hierarchy", "right:inspector+history+worlds+network"]);
    const geo = computeGeometry(l, bounds);
    expect(geo.fill).toEqual(geo.docks[2].rect); // the Inspector's dock takes the rest
    expect(geo.fill).toEqual({ x: 240, y: 0, w: 960, h: 610 });
  });

  it("other panels can be dropped into its dock, splitting it", () => {
    const l = movePanel(defaultLayout(), "code", { kind: "split", dock: "main", index: 1 });
    expect(sides(l).at(-1)).toBe("left:scene|code");
  });
});

describe("resizing", () => {
  it("clamps docks so the filling dock keeps its minimum size", () => {
    const l = resizeDock(defaultLayout(), "left", 5000);
    const geo = computeGeometry(l, bounds);
    expect(geo.fill.w).toBeGreaterThanOrEqual(MIN_FILL.w - 1);
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

  it("at the filling dock's edges targets new docks beside it; its middle splits it", () => {
    const c = geo.fill;
    expect(hitTest(l, geo, "assets", c.x + 5, 200)?.target).toEqual({ kind: "edge", side: "left", placement: "inner" });
    expect(hitTest(l, geo, "hierarchy", c.x + c.w / 2, c.y + c.h - 5)?.target).toEqual({ kind: "edge", side: "bottom", placement: "inner" });
    expect(hitTest(l, geo, "inspector", c.x + c.w / 2, c.y + c.h * 0.75)?.target).toEqual({ kind: "split", dock: "main", index: 1 });
    expect(hitTest(l, geo, "scene", c.x + c.w / 2, c.y + c.h / 2)).toBeNull(); // the scene over itself
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
    const dup = structuredClone(l);
    dup.docks[0].groups[0].panels.push("inspector");
    expect(parseLayout(dup)).toBeNull();
    expect(parseLayout({ version: 2, docks: l.docks })).toBeNull();
  });
});

describe("layouts saved before a panel existed", () => {
  it("adds missing panels as tabs beside the Inspector, and the scene view as the filling dock", () => {
    const old = {
      version: 1,
      docks: [
        { id: "left", side: "left", size: 300, groups: [{ id: "g1", panels: ["hierarchy"], active: "hierarchy" }], fractions: [1] },
        {
          id: "right",
          side: "right",
          size: 260,
          groups: [
            { id: "g2", panels: ["inspector"], active: "inspector" },
            { id: "g3", panels: ["assets"], active: "assets" },
          ],
          fractions: [0.5, 0.5],
        },
      ],
    };
    const l = parseLayout(old)!;
    expect(sides(l)).toEqual(["left:hierarchy", "right:inspector+history+worlds+network|assets+code", "left:scene"]); // Code joins Assets, where there's width
    expect(l.docks[0].size).toBe(300); // the user's arrangement is kept
    expect(where(l, "history").groups[0].active).toBe("inspector");
    const geo = computeGeometry(l, bounds);
    expect(geo.fill).toEqual({ x: 300, y: 0, w: 1200 - 300 - 260, h: 800 }); // where the fixed viewport was
  });

  it("uses the first group when the Inspector isn't in the layout", () => {
    const l = parseLayout({
      version: 1,
      docks: [{ id: "b", side: "bottom", size: 200, groups: [{ id: "g", panels: ["assets", "hierarchy"], active: "assets" }], fractions: [1] }],
    })!;
    expect(sides(l)).toEqual(["bottom:assets+hierarchy+inspector+history+code+worlds+network", "left:scene"]);
  });

  it("adds the Worlds panel as a tab beside History, wherever History was moved", () => {
    const saved = movePanel(defaultLayout(), "history", { kind: "tab", group: "hierarchy" });
    for (const d of saved.docks) for (const g of d.groups) g.panels = g.panels.filter((p) => p !== "worlds" && p !== "network"); // saved before they existed
    const l = parseLayout(JSON.parse(JSON.stringify(saved)))!;
    expect(sides(l)).toEqual(["bottom:assets+code", "left:hierarchy+history+worlds+network", "right:inspector", "left:scene"]);
    expect(where(l, "worlds").groups[0].active).toBe("history"); // the user's active tab is kept
  });

  it("adds the Network panel as a tab beside Worlds, wherever Worlds was moved", () => {
    const saved = movePanel(defaultLayout(), "worlds", { kind: "tab", group: "assets" });
    for (const d of saved.docks) for (const g of d.groups) g.panels = g.panels.filter((p) => p !== "network"); // saved before it existed
    const l = parseLayout(JSON.parse(JSON.stringify(saved)))!;
    expect(sides(l)).toEqual(["bottom:assets+code+worlds+network", "left:hierarchy", "right:inspector+history", "left:scene"]);
    expect(where(l, "network").groups[0].active).toBe("worlds");
  });
});
