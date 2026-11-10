// Plugin drop targets for the asset browser's drag (assetDropTargets.ts, assetDrag.ts), headless: `window` and
// `document` are stubs, the drag runs on dispatched pointer events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetDrag, dropDescription, startAssetDrag } from "./assetDrag";
import { draggedAssets, dropTargetFor, registerAssetDropTarget, type AssetDropTargetSpec } from "./assetDropTargets";

type Fake = { parentElement: Fake | null; closest: () => null };
const fake = (parent: Fake | null = null): Fake => ({ parentElement: parent, closest: () => null });
const as = (f: Fake) => f as unknown as HTMLElement;

let under: Fake | null = null;
const win = new EventTarget();
const pointer = (type: string, x: number, y: number, button = 0) => {
  const e = new Event(type) as Event & { clientX: number; clientY: number; button: number };
  Object.assign(e, { clientX: x, clientY: y, button });
  return e;
};
const press = (paths: string[], x = 0, y = 0) => startAssetDrag(pointer("pointerdown", x, y) as unknown as PointerEvent, paths);
const move = (x: number, y: number) => win.dispatchEvent(pointer("pointermove", x, y));
const release = (x: number, y: number) => win.dispatchEvent(pointer("pointerup", x, y));

beforeEach(() => {
  under = null;
  vi.stubGlobal("window", Object.assign(win, { getSelection: () => null }));
  vi.stubGlobal("document", { elementFromPoint: () => under });
});
afterEach(() => {
  vi.unstubAllGlobals();
  assetDrag.value = null;
});

const spec = (over: Partial<AssetDropTargetSpec> = {}): AssetDropTargetSpec => ({
  accepts: (a) => a.every((p) => p.endsWith(".mp3")),
  label: (a, p) => `Add ${a.length} at ${p.x}`,
  drop: () => {},
  ...over,
});

describe("registerAssetDropTarget", () => {
  it("finds the innermost registered element at or above one, and unregisters", () => {
    const outer = fake(), inner = fake(outer), leaf = fake(inner);
    const un1 = registerAssetDropTarget(as(outer), spec());
    const s2 = spec();
    const un2 = registerAssetDropTarget(as(inner), s2);
    expect(dropTargetFor(as(leaf))?.spec).toBe(s2);
    un2();
    expect(dropTargetFor(as(leaf))?.element).toBe(outer);
    un1();
    expect(dropTargetFor(as(leaf))).toBeNull();
  });

  it("an old unregister doesn't remove a newer registration of the same element", () => {
    const el = fake();
    const un1 = registerAssetDropTarget(as(el), spec());
    const s2 = spec();
    registerAssetDropTarget(as(el), s2);
    un1();
    expect(dropTargetFor(as(el))?.spec).toBe(s2);
  });
});

describe("the asset drag over a registered target", () => {
  it("shows the target's label, calls drop on release with the entries and the point, and tells it when the pointer leaves", () => {
    const el = fake();
    const drop = vi.fn(), over = vi.fn(), leave = vi.fn();
    const un = registerAssetDropTarget(as(el), spec({ drop, over, leave }));
    press(["music/town.mp3"]);
    under = el;
    move(40, 12);
    expect(assetDrag.value?.target).toMatchObject({ kind: "plugin", label: "Add 1 at 40" });
    expect(assetDrag.value?.problem).toBeNull();
    expect(dropDescription(assetDrag.value!, null)).toBe("Add 1 at 40");
    expect(over).toHaveBeenCalledWith(["music/town.mp3"], { x: 40, y: 12 });
    expect(draggedAssets()).toEqual(["music/town.mp3"]);
    release(41, 13);
    expect(drop).toHaveBeenCalledWith(["music/town.mp3"], { x: 41, y: 13 });
    expect(leave).toHaveBeenCalledTimes(1);
    expect(assetDrag.value).toBeNull();
    expect(draggedAssets()).toBeNull();
    un();
  });

  it("a target that doesn't accept the entries, or labels the spot null, shows a problem and isn't dropped on", () => {
    const el = fake();
    const drop = vi.fn();
    const un = registerAssetDropTarget(as(el), spec({ drop, label: (_a, p) => (p.x > 50 ? null : "ok") }));
    press(["images/a.png"]);
    under = el;
    move(10, 0);
    expect(assetDrag.value).toMatchObject({ target: null, problem: "can't drop these here" });
    release(10, 0);
    press(["music/a.mp3"]);
    move(60, 0);
    expect(assetDrag.value).toMatchObject({ target: null, problem: "can't drop here" });
    release(60, 0);
    expect(drop).not.toHaveBeenCalled();
    un();
  });

  it("moving off the element tells it to clear, and releasing elsewhere drops nothing in it", () => {
    const el = fake();
    const drop = vi.fn(), leave = vi.fn();
    const un = registerAssetDropTarget(as(el), spec({ drop, leave }));
    press(["music/a.mp3"]);
    under = el;
    move(10, 0);
    under = null; // moved off to somewhere unregistered
    move(11, 0);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(assetDrag.value?.target ?? null).toBeNull(); // no scene open, so not a viewport or hierarchy drop either
    release(11, 0);
    expect(drop).not.toHaveBeenCalled();
    un();
  });

  it("outside registered elements the drag is the browser's own (no plugin target)", () => {
    press(["music/a.mp3"]);
    under = fake();
    move(10, 0);
    expect(assetDrag.value?.target?.kind).not.toBe("plugin");
    release(10, 0);
  });
});
