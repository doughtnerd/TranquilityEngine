// The viewport tool host (ADR 0138): registry following, press routing, keys, the active tool, play mode.
// Driven through the host the session installs (`installViewportTools`), with tools registered in the
// editor's viewport tool registry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../engine";
import type { World } from "../engine/core/World";
import type { GameObject } from "../engine/scene/GameObject";
import { shownEditorOverlays } from "../engine/editor";
import { viewportTools, type ViewportDrag, type ViewportToolContext, type ViewportToolContribution } from "./sdk/contributions";
import { activateViewportTool, activeViewportTool, openScene, pickTool, playState, type OpenScene } from "./state";
import { selectableOutlines } from "./viewportTools";
import { sceneViewTools, type SceneViewCanvas, type SceneViewTools } from "./testing";

const pointerEvent = (type: string, props: Partial<PointerEvent> = {}) =>
  Object.assign(new Event(type, { cancelable: true }), { clientX: 15, clientY: 25, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1, ...props });
const keyEvent = (key: string, props: Partial<KeyboardEvent> = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...props });
/** A key pressed in a text field. */
const keyInField = (key: string) => Object.defineProperty(keyEvent(key), "target", { value: { nodeType: 1, tagName: "INPUT", type: "text" } });

let view: SceneViewTools;
let canvas: SceneViewCanvas;
let keys: EventTarget;
let world: World;
const registered: (() => void)[] = [];

/** Register `contribution` in the editor's registry until the test ends; a function that removes it. */
function register(contribution: ViewportToolContribution): () => void {
  const off = viewportTools.register(contribution);
  registered.push(off);
  return off;
}

/** A tool whose context is kept for the test. */
function tool(id: string, setup: (ctx: ViewportToolContext) => void | (() => void) = () => {}): { contribution: ViewportToolContribution; ctx: () => ViewportToolContext } {
  let ctx: ViewportToolContext | null = null;
  return {
    contribution: {
      id,
      install(c) {
        ctx = c;
        return setup(c);
      },
    },
    ctx: () => ctx!,
  };
}

beforeEach(() => {
  playState.value = "edit";
  activateViewportTool(null);
  world = {} as World;
  view = sceneViewTools({ world } as unknown as Engine);
  canvas = view.canvas;
  keys = view.window;
});
afterEach(() => {
  for (const off of registered.splice(0)) off();
  view.stop();
  openScene.value = null;
  playState.value = "edit";
  activateViewportTool(null);
});

describe("viewport tool host", () => {
  it("follows the registry: installs tools registered later and uninstalls removed ones", () => {
    const cleanup = vi.fn();
    const t = tool("t.a", (ctx) => {
      ctx.overlay(() => ({ lines: [], handles: [] }));
      ctx.overlay(() => ({ lines: [], handles: [] }), { suffix: "extra" });
      return cleanup;
    });
    const remove = register(t.contribution);
    expect(shownEditorOverlays(world)).toEqual(["t.a", "t.a:extra"]);
    t.ctx().activate();
    expect(activeViewportTool.value).toBe("t.a");
    remove();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(shownEditorOverlays(world)).toEqual([]);
    expect(activeViewportTool.value).toBeNull(); // removing the active tool gives the scene view back
  });

  it("offers presses to the active tool first, and a claimed press goes nowhere else", () => {
    const order: string[] = [];
    const moves: number[] = [];
    let ended = false;
    const a = tool("t.a", (ctx) => ctx.onPress(() => void order.push("a")));
    const b = tool("t.b", (ctx) =>
      ctx.onPress((p) => {
        order.push("b");
        expect([p.x, p.y]).toEqual([15, 25]); // canvas pixels (the canvas is at the page's origin)
        return { move: (m) => moves.push(m.x), end: () => (ended = true) } satisfies ViewportDrag;
      }),
    );
    register(a.contribution);
    register(b.contribution);
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later); // selection, the gizmo
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    expect(order).toEqual(["a", "b"]);
    expect(later).not.toHaveBeenCalled();
    expect(canvas.captured).toEqual([1]);
    canvas.dispatchEvent(pointerEvent("pointermove", { clientX: 40 }));
    canvas.dispatchEvent(pointerEvent("pointermove", { clientX: 50, pointerId: 2 })); // another pointer
    canvas.dispatchEvent(pointerEvent("pointerup"));
    expect(moves).toEqual([40]);
    expect(ended).toBe(true);

    order.length = 0;
    b.ctx().activate();
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    expect(order).toEqual(["b"]);
  });

  it("lets unclaimed presses through, and routes nothing while playing", () => {
    const press = vi.fn(() => null);
    register(tool("t.a", (ctx) => ctx.onPress(press)).contribution);
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later);
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    expect(later).toHaveBeenCalledOnce();
    playState.value = "playing";
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    expect(press).toHaveBeenCalledOnce();
  });

  it("cancels a drag and ends the active tool when play starts", () => {
    const cancel = vi.fn();
    const t = tool("t.a", (ctx) => ctx.onPress(() => ({ cancel })));
    register(t.contribution);
    t.ctx().activate();
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    playState.value = "starting";
    expect(cancel).toHaveBeenCalledOnce();
    expect(activeViewportTool.value).toBeNull();
  });

  it("cancels a tool's drag when the tool is removed", () => {
    const cancel = vi.fn();
    const remove = register(tool("t.a", (ctx) => ctx.onPress(() => ({ cancel }))).contribution);
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    remove();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("hovers while no drag runs, and null on leaving", () => {
    const seen: (number | null)[] = [];
    register(tool("t.a", (ctx) => ctx.onHover((p) => seen.push(p ? p.x : null))).contribution);
    canvas.dispatchEvent(pointerEvent("pointermove", { clientX: 30 }));
    canvas.dispatchEvent(pointerEvent("pointerleave"));
    expect(seen).toEqual([30, null]);
  });

  it("gives keys to tools outside text fields, dialogs and chords; a consumed key stops there", () => {
    const got: string[] = [];
    register(tool("t.a", (ctx) => ctx.onKey((e) => (got.push(e.key), e.key === "b"))).contribution);
    const later = vi.fn();
    keys.addEventListener("keydown", later); // shortcuts.ts
    keys.dispatchEvent(keyEvent("b"));
    expect(later).not.toHaveBeenCalled();
    keys.dispatchEvent(keyEvent("c"));
    expect(later).toHaveBeenCalledOnce();
    keys.dispatchEvent(keyEvent("b", { ctrlKey: true }));
    keys.dispatchEvent(keyInField("b"));
    view.dialogOpen = true;
    keys.dispatchEvent(keyEvent("b"));
    view.dialogOpen = false;
    playState.value = "playing";
    keys.dispatchEvent(keyEvent("b"));
    expect(got).toEqual(["b", "c"]);
  });

  it("ends the active tool on Escape, a transform tool or another tool becoming active", () => {
    const t = tool("t.a");
    register(t.contribution);
    t.ctx().activate();
    expect(t.ctx().active.value).toBe(true);
    keys.dispatchEvent(keyEvent("Escape"));
    expect(activeViewportTool.value).toBeNull();
    t.ctx().activate();
    pickTool("move");
    expect(activeViewportTool.value).toBeNull();
    const other = tool("t.b");
    register(other.contribution);
    t.ctx().activate();
    other.ctx().activate();
    expect(t.ctx().active.value).toBe(false);
    expect(activeViewportTool.value).toBe("t.b");
  });

  it("collects the selectable outlines of the installed tools for viewport picking (ADR 0142)", () => {
    const node = {} as GameObject;
    const outline = { node, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][] };
    const t = tool("t.a", (ctx) => ctx.selectable(() => [outline]));
    expect(selectableOutlines(world)).toEqual([]);
    const undo = register(t.contribution);
    expect(selectableOutlines(world)).toEqual([outline]);
    undo();
    expect(selectableOutlines(world)).toEqual([]);
  });

  it("shows the active tool's cursor", () => {
    const t = tool("t.a", (ctx) => ctx.setCursor("crosshair"));
    register(t.contribution);
    expect(canvas.style.cursor).toBe("");
    t.ctx().activate();
    expect(canvas.style.cursor).toBe("crosshair");
    t.ctx().deactivate();
    expect(canvas.style.cursor).toBe("");
  });

  it("makes one undo group per edit, ending it even when the edit throws", () => {
    const calls: string[] = [];
    openScene.value = { stack: { beginGroup: (l: string) => calls.push(`begin ${l}`), endGroup: () => calls.push("end") } } as unknown as OpenScene;
    const t = tool("t.a");
    register(t.contribution);
    expect(t.ctx().edit("Paint", () => calls.push("run"))).toBe(true);
    expect(() =>
      t.ctx().edit("Bad", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(calls).toEqual(["begin Paint", "run", "end", "begin Bad", "end"]);
    openScene.value = null;
    expect(t.ctx().edit("None", () => {})).toBe(false);
  });

  it("reports a tool that fails to install and keeps the others", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const press = vi.fn(() => null);
    register({
      id: "t.bad",
      install(ctx) {
        ctx.onPress(press);
        throw new Error("boom");
      },
    });
    register(tool("t.ok", (ctx) => ctx.onPress(press)).contribution);
    canvas.dispatchEvent(pointerEvent("pointerdown"));
    expect(press).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});
