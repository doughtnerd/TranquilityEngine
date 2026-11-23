import { describe, expect, it } from "vitest";
import { foldCandidate, foldView, unfoldEdit } from "./narrowFold";
import { toggleDock, type Dock, type Layout } from "./model";

const dock = (id: string, side: Dock["side"], collapsed?: boolean): Dock => ({ id, side, size: 240, groups: [{ id: `g-${id}`, panels: [`p-${id}`], active: `p-${id}` }], fractions: [1], ...(collapsed ? { collapsed } : {}) });
const layout = (...docks: Dock[]): Layout => ({ version: 2, docks, instances: Object.fromEntries(docks.map((d) => [`p-${d.id}`, { type: d.id }])), known: docks.map((d) => d.id), panelInfo: {} });

const both = layout(dock("left", "left"), dock("right", "right"), dock("bottom", "bottom"), dock("fill", "bottom"));

describe("foldCandidate", () => {
  it("folds the outermost open left dock when narrow with an open right dock", () => {
    expect(foldCandidate(both, 800, 900)).toBe("left");
  });
  it("folds nothing when wide, with no open right dock, or with no open left dock", () => {
    expect(foldCandidate(both, 900, 900)).toBeNull();
    expect(foldCandidate(layout(dock("left", "left"), dock("right", "right", true), dock("fill", "bottom")), 600, 900)).toBeNull();
    expect(foldCandidate(layout(dock("left", "left", true), dock("right", "right"), dock("fill", "bottom")), 600, 900)).toBeNull();
  });
  it("never folds the filling dock", () => {
    expect(foldCandidate(layout(dock("right", "right"), dock("fill", "left")), 300, 900)).toBeNull();
  });
});

describe("foldView and unfoldEdit", () => {
  it("draws the dock folded and stores it open", () => {
    const view = foldView(both, "left");
    expect(view.docks[0].collapsed).toBe(true);
    expect(both.docks[0].collapsed).toBeUndefined();
    // An unrelated edit on the drawn layout (collapsing the bottom dock) keeps the folded dock open in storage.
    const r = unfoldEdit(toggleDock(view, "bottom"), "left");
    expect(r.layout.docks[0].collapsed).toBeUndefined();
    expect(r.layout.docks[2].collapsed).toBe(true);
    expect(r.open).toBe(false);
  });
  it("reports the folded dock opened when an edit expands it", () => {
    const r = unfoldEdit(toggleDock(foldView(both, "left"), "left"), "left");
    expect(r.open).toBe(true);
    expect(r.layout.docks[0].collapsed).toBeUndefined();
  });
  it("folds an opened dock back without storing a collapse", () => {
    const r = unfoldEdit(toggleDock(both, "left"), "left");
    expect(r.open).toBe(false);
    expect(r.layout.docks[0].collapsed).toBeUndefined();
  });
  it("stores an edit as it is with no candidate", () => {
    const next = toggleDock(both, "left");
    expect(unfoldEdit(next, null)).toEqual({ layout: next });
  });
});
