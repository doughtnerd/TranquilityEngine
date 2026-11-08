// The viewport tool host (ADR 0137): installs every registered viewport tool on the scene view and
// routes input among them. Presses go to the active tool first, then the others in registration
// order; a tool that returns a drag owns that pointer until it's released, and selection, the
// transform gizmo and orbiting never see the press. Keys skip text fields, dialogs, Ctrl/Cmd/Alt
// chords and play mode once for every tool. At most one tool is active (`activeViewportTool`);
// play, Escape, the transform tools and collider editing end it. The host follows the registry, so a
// plugin enabled or disabled while a project is open adds or removes its tools.
import { computed, effect, signal, untracked } from "@preact/signals";
import type { Engine } from "../engine";
import type { World } from "../engine/core/World";
import { addEditorOverlay, removeEditorOverlay, viewportCanvas, type EditorOverlay, type EditorOverlayKind } from "../engine/editor";
import { isEditable } from "./editable";
import { errorStatus } from "./messages";
import type { Registry } from "./sdk/registry";
import { viewportTools, type ViewportDrag, type ViewportPointer, type ViewportToolContext, type ViewportToolContribution } from "./sdk/contributions";
import { activateViewportTool, activeViewportTool, editingCollider, openScene, playState, status } from "./state";

/** The bits of the canvas the host uses (a fake one in tests). */
export interface ViewportHostCanvas extends EventTarget {
  getBoundingClientRect(): { left: number; top: number };
  setPointerCapture?(pointerId: number): void;
  readonly style: { cursor: string };
}

export interface ViewportToolHostOptions {
  readonly engine: Engine;
  readonly world: World;
  readonly canvas: ViewportHostCanvas | null;
  /** Where keys are listened for (the window). */
  readonly keys: EventTarget;
  readonly tools?: Registry<ViewportToolContribution>;
  readonly addOverlay?: (id: string, provider: () => EditorOverlay, kind: EditorOverlayKind) => void;
  readonly removeOverlay?: (id: string) => void;
  /** A modal dialog is open: keys belong to it. */
  readonly dialogOpen?: () => boolean;
  /** A text field that keeps its own keys (default `isEditable`). */
  readonly editable?: (target: EventTarget | null) => boolean;
}

type PressHandler = Parameters<ViewportToolContext["onPress"]>[0];
type HoverHandler = Parameters<ViewportToolContext["onHover"]>[0];
type KeyHandler = Parameters<ViewportToolContext["onKey"]>[0];

interface Install {
  readonly tool: ViewportToolContribution;
  press: PressHandler[];
  hover: HoverHandler[];
  keys: KeyHandler[];
  overlays: string[];
  cursor: string | null;
  cleanup?: () => void;
}

interface PointerLike {
  clientX: number;
  clientY: number;
  button: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  pointerId: number;
}

/** Install the registered viewport tools on the Editor World's scene view. Returns a function that removes them. */
export function installViewportTools(engine: Engine): () => void {
  return createViewportToolHost({
    engine,
    world: engine.world,
    canvas: viewportCanvas(engine.world),
    keys: window,
    dialogOpen: () => document.querySelector(".dialog") !== null,
  });
}

/** The host itself, with its surroundings passed in (tests give it a fake canvas). */
export function createViewportToolHost(options: ViewportToolHostOptions): () => void {
  const { engine, world, canvas, keys } = options;
  const tools = options.tools ?? viewportTools;
  const addOverlay = options.addOverlay ?? ((id, provider, kind) => addEditorOverlay(world, id, provider, kind));
  const removeOverlay = options.removeOverlay ?? ((id) => removeEditorOverlay(world, id));
  const dialogOpen = options.dialogOpen ?? (() => false);
  const editable = options.editable ?? isEditable;

  const installs = new Map<string, Install>();
  let drag: { install: Install; drag: ViewportDrag; pointerId: number } | null = null;
  const cursorVersion = signal(0);
  const editing = () => playState.peek() === "edit";

  /** The active tool's install first, then the others in registration order. */
  const ordered = (): Install[] => {
    const list = [...installs.values()];
    const id = activeViewportTool.peek();
    const act = id === null ? undefined : installs.get(id);
    return act ? [act, ...list.filter((i) => i !== act)] : list;
  };

  const pointer = (e: PointerLike): ViewportPointer => {
    const r = canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, button: e.button, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, pointerId: e.pointerId };
  };

  const cancelDrag = () => {
    const d = drag;
    drag = null;
    d?.drag.cancel?.();
  };

  const install = (tool: ViewportToolContribution) => {
    const inst: Install = { tool, press: [], hover: [], keys: [], overlays: [], cursor: null };
    installs.set(tool.id, inst);
    const context: ViewportToolContext = {
      engine,
      world,
      active: computed(() => activeViewportTool.value === tool.id),
      activate: () => activateViewportTool(tool.id),
      deactivate: () => {
        if (activeViewportTool.peek() === tool.id) activateViewportTool(null);
      },
      onPress: (h) => void inst.press.push(h),
      onHover: (h) => void inst.hover.push(h),
      onKey: (h) => void inst.keys.push(h),
      overlay: (provider, o) => {
        const id = o?.suffix ? `${tool.id}:${o.suffix}` : tool.id;
        addOverlay(id, provider, o?.kind ?? "other");
        if (!inst.overlays.includes(id)) inst.overlays.push(id);
      },
      setCursor: (cursor) => {
        inst.cursor = cursor;
        cursorVersion.value++;
      },
      edit: (label, fn) => {
        const scene = openScene.peek();
        if (!scene) return false;
        scene.stack.beginGroup(label);
        try {
          fn(scene);
        } finally {
          scene.stack.endGroup();
        }
        return true;
      },
    };
    try {
      const cleanup = tool.install(context);
      if (typeof cleanup === "function") inst.cleanup = cleanup;
    } catch (err) {
      console.error(`Viewport tool ${tool.id} failed to install`, err);
      status.value = errorStatus(`Viewport tool ${tool.id} failed to install`, err);
      uninstall(inst);
    }
  };

  const uninstall = (inst: Install) => {
    if (installs.get(inst.tool.id) === inst) installs.delete(inst.tool.id);
    if (drag?.install === inst) cancelDrag();
    for (const id of inst.overlays) removeOverlay(id);
    inst.press = [];
    inst.hover = [];
    inst.keys = [];
    inst.overlays = [];
    const cleanup = inst.cleanup;
    inst.cleanup = undefined;
    try {
      cleanup?.();
    } catch (err) {
      console.error(`Viewport tool ${inst.tool.id} failed to uninstall`, err);
    }
    if (activeViewportTool.peek() === inst.tool.id) activateViewportTool(null);
    cursorVersion.value++;
  };

  // Follow the registry: install new tools, uninstall removed or replaced ones.
  const stopRegistry = effect(() => {
    void tools.version.value;
    untracked(() => {
      const list = tools.list();
      for (const inst of [...installs.values()]) if (tools.get(inst.tool.id) !== inst.tool) uninstall(inst);
      for (const tool of list) if (!installs.has(tool.id)) install(tool);
    });
  });

  // Leaving edit mode cancels a drag and ends the active tool; editing a collider ends it too.
  const stopPlay = effect(() => {
    if (playState.value === "edit") return;
    untracked(() => {
      cancelDrag();
      if (activeViewportTool.peek() !== null) activateViewportTool(null);
    });
  });
  const stopCollider = effect(() => {
    if (editingCollider.value && untracked(() => activeViewportTool.value) !== null) activateViewportTool(null);
  });

  // The active tool's cursor.
  let cursorSet = false;
  const stopCursor = effect(() => {
    void cursorVersion.value;
    const id = activeViewportTool.value;
    if (!canvas) return;
    const cursor = id === null ? null : (installs.get(id)?.cursor ?? null);
    if (cursor) {
      canvas.style.cursor = cursor;
      cursorSet = true;
    } else if (cursorSet) {
      canvas.style.cursor = "";
      cursorSet = false;
    }
  });

  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    if (!editing() || e.ctrlKey || e.metaKey || e.altKey || editable(e.target) || dialogOpen()) return;
    for (const inst of ordered()) {
      for (const h of inst.keys) {
        if (h(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
    }
    if (e.key === "Escape" && !drag && activeViewportTool.peek() !== null) {
      e.preventDefault();
      e.stopImmediatePropagation();
      activateViewportTool(null);
    }
  };
  keys.addEventListener("keydown", onKey, true);

  const hover = (p: ViewportPointer | null) => {
    for (const inst of [...installs.values()]) for (const h of inst.hover) h(p);
  };
  const onDown = (event: Event) => {
    const e = event as PointerEvent;
    if (!editing() || drag) return;
    const p = pointer(e);
    for (const inst of ordered()) {
      for (const h of inst.press) {
        const d = h(p);
        if (!d) continue;
        e.stopImmediatePropagation();
        e.preventDefault();
        canvas!.setPointerCapture?.(e.pointerId);
        drag = { install: inst, drag: d, pointerId: e.pointerId };
        return;
      }
    }
  };
  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (drag) {
      if (drag.pointerId === e.pointerId) drag.drag.move?.(pointer(e));
      return;
    }
    if (editing()) hover(pointer(e));
  };
  const onUp = (event: Event) => {
    const e = event as PointerEvent;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const d = drag;
    drag = null;
    d.drag.end?.(pointer(e));
  };
  const onCancel = (event: Event) => {
    if (drag && drag.pointerId === (event as PointerEvent).pointerId) cancelDrag();
  };
  const onLeave = () => {
    if (!drag) hover(null);
  };
  if (canvas) {
    canvas.addEventListener("pointerdown", onDown, { capture: true });
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
  }

  return () => {
    stopRegistry();
    stopPlay();
    stopCollider();
    for (const inst of [...installs.values()].reverse()) uninstall(inst);
    stopCursor();
    if (canvas && cursorSet) canvas.style.cursor = "";
    keys.removeEventListener("keydown", onKey, true);
    if (canvas) {
      canvas.removeEventListener("pointerdown", onDown, { capture: true });
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
    }
  };
}
