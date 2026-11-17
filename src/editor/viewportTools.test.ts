// The viewport tool host (ADR 0138): registry following, press routing, keys, the active tool, play mode;
// tool modes and gestures that are one undo step (ADR 0231).
// Driven through the host the session installs (`installViewportTools`), with tools registered in the
// editor's viewport tool registry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../engine";
import type { World } from "../engine/core/World";
import type { GameObject } from "../engine/scene/GameObject";
import { CommandStack, SceneDocument, SetField, type SceneFile } from "./document";
import { viewportTools, type ViewportCancel, type ViewportDrag, type ViewportToolContext, type ViewportToolContribution } from "./sdk/contributions";
import { editor } from "./sdk/editor";
import { activateViewportTool, activeViewportTool, openScene, pickTool, playState, selection, snapping, type OpenScene } from "./state";
import { selectableOutlines } from "./viewportTools";
import { sceneViewTools, type SceneViewCanvas, type SceneViewTools } from "./testing";

const pointerEvent = (type: string, props: Partial<PointerEvent> = {}) =>
  Object.assign(new Event(type, { cancelable: true }), { clientX: 15, clientY: 25, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1, ...props });
const keyEvent = (key: string, props: Partial<KeyboardEvent> = {}) =>
  Object.assign(new Event("keydown", { cancelable: true }), { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...props });
/** A key pressed in a text field. */
const keyInField = (key: string) => Object.defineProperty(keyEvent(key), "target", { value: { nodeType: 1, tagName: "INPUT", type: "text" } });

/** An overlay line in `color`, so a test can tell which overlays drew. */
const line = (color: number) => ({ points: [[0, 0, 0], [1, 0, 0]] as [number, number, number][], closed: false, color });
/** The colours of the lines the scene view draws now, in order. */
const drawnColors = () => view.overlay().lines.map((l) => l.color);

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
function tool(id: string, setup: (ctx: ViewportToolContext) => void | (() => void) = () => {}, endsOnSelection?: (mode: unknown) => boolean): { contribution: ViewportToolContribution; ctx: () => ViewportToolContext } {
  let ctx: ViewportToolContext | null = null;
  return {
    contribution: {
      id,
      endsOnSelection,
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
      ctx.overlay(() => ({ lines: [line(1)], handles: [] }));
      ctx.overlay(() => ({ lines: [line(2)], handles: [] }), { suffix: "extra" });
      return cleanup;
    });
    const remove = register(t.contribution);
    expect(drawnColors()).toEqual([1, 2]); // both of its overlays draw, in the order added
    t.ctx().enter();
    expect(activeViewportTool.value).toBe("t.a");
    remove();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(drawnColors()).toEqual([]);
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
    b.ctx().enter();
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
    t.ctx().enter();
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
    t.ctx().enter();
    expect(t.ctx().active.value).toBe(true);
    keys.dispatchEvent(keyEvent("Escape"));
    expect(activeViewportTool.value).toBeNull();
    t.ctx().enter();
    pickTool("move");
    expect(activeViewportTool.value).toBeNull();
    const other = tool("t.b");
    register(other.contribution);
    t.ctx().enter();
    other.ctx().enter();
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
    t.ctx().enter();
    expect(canvas.style.cursor).toBe("crosshair");
    t.ctx().leave();
    expect(canvas.style.cursor).toBe("");
  });

  it("makes one undo step per edit, ending it even when the edit throws", () => {
    const scene = sceneOf();
    openScene.value = scene;
    const t = tool("t.a");
    register(t.contribution);
    expect(t.ctx().edit("Paint", () => (setX(scene, 1), setX(scene, 2)))).toBe(true);
    expect(() =>
      t.ctx().edit("Bad", () => {
        setX(scene, 3);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(scene.stack.allStates.map((s) => s.label)).toEqual(["Opened", "Paint", "Bad"]);
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

/** A scene with one node "a" whose Transform position the tests set. */
function sceneOf(): OpenScene {
  const file: SceneFile = { format: "myco.scene@1", nodes: [{ id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [0, 0, 0] } }] }] };
  const doc = new SceneDocument(file);
  return { path: "scenes/t.scene.json", doc, stack: new CommandStack(doc) } as unknown as OpenScene;
}
const setX = (scene: OpenScene, x: number) => scene.stack.execute(new SetField("a", "engine.Transform", "position", [x, 0, 0]));
const xOf = (scene: OpenScene) => (scene.doc.fieldValue("a", "engine.Transform", "position") as number[])[0];

describe("tool modes (ADR 0231)", () => {
  it("enters and leaves a mode through the context and through editor.viewport, which read the same mode", () => {
    const t = tool("t.a");
    register(t.contribution);
    t.ctx().enter("pencil");
    expect(t.ctx().mode.value).toBe("pencil");
    expect(editor.viewport.mode("t.a").value).toBe("pencil");
    expect(editor.viewport.activeTool).toBe("t.a");
    editor.viewport.enter("t.a", "rect"); // a new mode, the same tool
    expect(t.ctx().mode.value).toBe("rect");
    editor.viewport.leave("t.b"); // not the active tool: nothing
    expect(t.ctx().active.value).toBe(true);
    t.ctx().leave();
    expect(t.ctx().mode.value).toBeNull();
    expect(editor.viewport.activeTool).toBeNull();
  });

  it("ends the mode when another tool, a transform tool, Escape or play takes over, and refuses one while playing", () => {
    const t = tool("t.a");
    const other = tool("t.b");
    register(t.contribution);
    register(other.contribution);
    for (const takeOver of [() => other.ctx().enter(), () => pickTool("move"), () => keys.dispatchEvent(keyEvent("Escape")), () => (playState.value = "playing")]) {
      playState.value = "edit";
      t.ctx().enter({ key: "n" });
      takeOver();
      expect(t.ctx().mode.value).toBeNull();
    }
    t.ctx().enter("x"); // still playing
    expect(t.ctx().active.value).toBe(false);
  });

  it("ends the mode when another scene opens, and on a new selection where the tool asks", () => {
    const keep = tool("t.keep");
    const ends = tool("t.ends", () => {}, (mode) => mode === "strict");
    register(keep.contribution);
    register(ends.contribution);
    keep.ctx().enter("m");
    openScene.value = sceneOf();
    expect(keep.ctx().mode.value).toBeNull();
    keep.ctx().enter("m");
    selection.value = "a";
    expect(keep.ctx().mode.value).toBe("m"); // it didn't ask
    ends.ctx().enter("lenient");
    selection.value = null;
    expect(ends.ctx().mode.value).toBe("lenient"); // asked, with this mode: keep
    ends.ctx().enter("strict");
    selection.value = "a";
    expect(ends.ctx().mode.value).toBeNull();
    expect(editor.viewport.activeTool).toBeNull();
    selection.value = null;
  });

  it("ends the mode when the tool is removed", () => {
    const t = tool("t.a");
    const remove = register(t.contribution);
    t.ctx().enter("m");
    remove();
    expect(editor.viewport.mode("t.a").value).toBeNull();
  });
});

describe("gestures (ADR 0231)", () => {
  let scene: OpenScene;
  let reasons: ViewportCancel[];
  let t: ReturnType<typeof tool>;
  beforeEach(() => {
    scene = sceneOf();
    openScene.value = scene;
    reasons = [];
    t = tool("t.a", (ctx) =>
      ctx.onPress(() => {
        const drag = ctx.gesture("Drag A", { move: (p) => setX(scene, p.x), end: (p) => setX(scene, p.x + 1), cancel: (r) => void reasons.push(r) });
        setX(scene, 1); // the press's own edit joins the step
        return drag;
      }),
    );
    register(t.contribution);
  });
  const press = () => canvas.dispatchEvent(pointerEvent("pointerdown"));
  const move = (x: number) => canvas.dispatchEvent(pointerEvent("pointermove", { clientX: x }));

  it("is one undo step from press to release", () => {
    press();
    move(5);
    move(7);
    canvas.dispatchEvent(pointerEvent("pointerup", { clientX: 9 }));
    expect(xOf(scene)).toBe(10);
    expect(scene.stack.allStates.map((s) => s.label)).toEqual(["Opened", "Drag A"]);
    scene.stack.undo();
    expect(xOf(scene)).toBe(0);
  });

  it("reverts on Escape, which goes no further", () => {
    const later = vi.fn();
    keys.addEventListener("keydown", later);
    t.ctx().enter("m");
    press();
    move(5);
    keys.dispatchEvent(keyEvent("Escape"));
    expect(reasons).toEqual(["escape"]);
    expect(later).not.toHaveBeenCalled();
    expect(xOf(scene)).toBe(0);
    expect(scene.stack.allStates).toHaveLength(1);
    expect(t.ctx().mode.value).toBe("m"); // Escape ended the drag, not the tool
    move(8); // the drag is over
    expect(xOf(scene)).toBe(0);
  });

  it("keeps what was done when the window loses focus, the pointer is cancelled, another tool takes over or play starts", () => {
    const other = tool("t.b");
    register(other.contribution);
    const stops: [ViewportCancel, () => void][] = [
      ["blur", () => keys.dispatchEvent(new Event("blur"))],
      ["pointer", () => canvas.dispatchEvent(pointerEvent("pointercancel"))],
      ["tool", () => other.ctx().enter()],
      ["play", () => (playState.value = "starting")],
    ];
    for (const [reason, stop] of stops) {
      playState.value = "edit";
      press();
      move(5);
      stop();
      expect(reasons.at(-1)).toBe(reason);
      expect(xOf(scene)).toBe(5);
      expect(scene.stack.undoLabel).toBe("Drag A");
      scene.stack.undo();
    }
  });

  it("opens nothing without an open scene", () => {
    openScene.value = null;
    const later = vi.fn();
    canvas.addEventListener("pointerdown", later);
    press(); // the tool's gesture is null: the press goes on to selection
    expect(later).toHaveBeenCalledOnce();
  });
});

describe("snapping (ADR 0231)", () => {
  it("snaps to the move step only while snapping is on", () => {
    const t = tool("t.a");
    register(t.contribution);
    expect(t.ctx().snap(0.37)).toBe(0.37);
    snapping.value = true; // Ctrl/Cmd held
    try {
      expect(t.ctx().snap(0.37)).toBe(0.25); // the default move step
    } finally {
      snapping.value = false;
    }
  });
});
