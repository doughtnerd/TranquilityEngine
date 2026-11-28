// A graph canvas's click and box selection (ADR 0468): `pressItem` (what `useGraphSelection` and the
// animation graphs do on an item's pointer-down) and `startBoxSelect` (a drag on the empty pane)
// follow the scene view's rule: Shift adds, Ctrl/Cmd toggles, no modifier replaces.
import { describe, expect, it } from "vitest";
import { startBoxSelect } from "./canvas";
import { pressItem } from "./selection";
import type { CanvasNode } from "./xyflow";

const keys = (mods: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {}) => ({ shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta });

describe("pressing a graph item", () => {
  it("Shift on a selected item keeps it selected, as in the scene view", () => {
    expect([...pressItem(new Set(["a", "b"]), "a", keys({ shift: true }))]).toEqual(["a", "b"]);
    expect([...pressItem(new Set(["a"]), "b", keys({ shift: true }))]).toEqual(["a", "b"]);
  });

  it("Ctrl/Cmd toggles the item", () => {
    expect([...pressItem(new Set(["a", "b"]), "a", keys({ ctrl: true }))]).toEqual(["b"]);
    expect([...pressItem(new Set(["a"]), "b", keys({ meta: true }))]).toEqual(["a", "b"]);
  });

  it("a plain press selects just the item, but keeps the selection when the item is in it (a drag moves them all)", () => {
    expect([...pressItem(new Set(["a", "b"]), "c", keys())]).toEqual(["c"]);
    const sel = new Set(["a", "b"]);
    expect(pressItem(sel, "b", keys())).toBe(sel);
  });
});

/** Nodes 10×10 at x = 0, 20, 40 (ids a, b, c) on a pane at the origin, view unpanned and unzoomed. */
function boxDrag(selection: string[], mods: Parameters<typeof keys>[0], to: { x: number; y: number }): string[][] {
  const listeners = new Map<string, (e: unknown) => void>();
  const pane = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
    addEventListener: (type: string, f: (e: unknown) => void) => listeners.set(type, f),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as HTMLElement;
  const nodes = ["a", "b", "c"].map((id, i) => ({ id, x: i * 20, y: 0, width: 10, height: 10 }) as CanvasNode);
  const seen: string[][] = [];
  startBoxSelect({ clientX: -5, clientY: -5, pointerId: 1, ...keys(mods) } as PointerEvent, {
    pane,
    view: () => ({ x: 0, y: 0, zoom: 1 }),
    nodes: () => nodes,
    selection: new Set(selection),
    onSelection: (ids) => seen.push([...ids]),
    onBox: () => {},
  });
  listeners.get("pointermove")!({ clientX: to.x, clientY: to.y });
  listeners.get("pointerup")!({});
  return seen;
}

describe("box selecting on a graph canvas", () => {
  it("a plain box replaces the selection", () => {
    expect(boxDrag(["c"], {}, { x: 25, y: 15 }).at(-1)).toEqual(["a", "b"]);
  });

  it("Shift adds the boxed items", () => {
    expect(boxDrag(["b", "c"], { shift: true }, { x: 25, y: 15 }).at(-1)).toEqual(["b", "c", "a"]);
  });

  it("Ctrl/Cmd toggles each boxed item, as in the scene view", () => {
    expect(boxDrag(["b", "c"], { ctrl: true }, { x: 25, y: 15 }).at(-1)).toEqual(["c", "a"]);
    expect(boxDrag(["a"], { meta: true }, { x: 25, y: 15 }).at(-1)).toEqual(["b"]);
  });
});
