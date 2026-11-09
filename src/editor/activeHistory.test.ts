import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetActiveHistory, activeHistory, providePanelHistory, redo, stepBack, undo, type UndoHistory } from "./activeHistory";
import { _reset, KEEPS_HISTORY_FOCUS, openAssetDocument, type AssetDocument } from "./assetDocuments";
import { _useAssetHistoryPlatform, assetHistorySettled } from "./assetHistory";
import { MemoryStorage } from "../engine/platform/Storage";
import { joinPath, openFolderProject, type EditorProject } from "./projects";
import { installShortcuts } from "./shortcuts";
import { assetFormats } from "./sdk/contributions";
import { currentProject, openScene, type OpenScene } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";

interface Thing {
  n: number;
}
const PATH = "things/a.thing.json";

// --- a fake page: capture listeners and elements with just what the focus tracking reads ----------

type Listener = (e: Event) => void;
let listeners: Map<string, Listener[]>;

interface FakeElement {
  parentElement: FakeElement | null;
  closest(selector: string): unknown;
}
/** An element under `parent`, inside an asset editor's root for `asset`, or inside the History panel / menu bar (`keeps`). */
function element(opts: { parent?: FakeElement; asset?: string; keeps?: boolean } = {}): FakeElement {
  const inherited = (sel: string): unknown => opts.parent?.closest(sel) ?? null;
  return {
    parentElement: opts.parent ?? null,
    closest: (sel) => {
      if (sel === "[data-asset-document]" && opts.asset) return { getAttribute: () => opts.asset };
      if (sel === KEEPS_HISTORY_FOCUS && opts.keeps) return {};
      return inherited(sel);
    },
  };
}
/** Focus (or click) `target`, as the capture listeners on the document see it. */
const focus = (target: FakeElement, type: "focusin" | "pointerdown" = "pointerdown") => {
  for (const l of listeners.get(type) ?? []) l({ target } as unknown as Event);
};

/** A scene CommandStack stand-in, counting calls. */
function fakeStack(canUndo: boolean, canRedo = false) {
  const calls: string[] = [];
  const stack = {
    canUndo,
    canRedo,
    undoLabel: canUndo ? "Move node" : null,
    redoLabel: canRedo ? "Add node" : null,
    allStates: [],
    current: 0,
    saved: 0,
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    back: () => calls.push("back"),
    forward: () => calls.push("forward"),
    jumpTo: () => calls.push("jump"),
  };
  return { stack, calls };
}
const openFakeScene = (stack: object) => (openScene.value = { path: "main.scene.json", stack } as unknown as OpenScene);

/** A panel-local history stand-in. */
function panelHistory(): UndoHistory & { calls: string[] } {
  const calls: string[] = [];
  return { name: "Worlds", canUndo: true, canRedo: true, undoLabel: "Add World", redoLabel: null, undo: () => calls.push("undo"), redo: () => calls.push("redo"), calls };
}

let project: EditorProject;
let unregister: () => void;

beforeEach(async () => {
  listeners = new Map();
  vi.stubGlobal("document", {
    addEventListener: (type: string, l: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l)),
  });
  unregister = assetFormats.register({
    id: "thing",
    parse: (raw) => ({ value: { n: (raw as { n?: number } | undefined)?.n ?? 0 }, problems: [] }),
    format: (value: Thing) => `${JSON.stringify(value)}\n`,
  });
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), '{ "n": 1 }');
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  _useAssetHistoryPlatform({ fs: null, userStorage: new MemoryStorage() });
});

afterEach(async () => {
  await assetHistorySettled();
  _reset();
  _resetActiveHistory();
  _useAssetHistoryPlatform(null);
  unregister();
  openScene.value = null;
  currentProject.value = null;
  vi.unstubAllGlobals();
});

const openDoc = () => openAssetDocument<Thing>(project, PATH, "thing") as AssetDocument<Thing>;

describe("the active history (ADR 0145)", () => {
  it("is the scene's stack when no editor with its own history is focused", () => {
    const { stack, calls } = fakeStack(true);
    openFakeScene(stack);
    focus(element()); // the viewport
    expect(activeHistory.value?.kind).toBe("scene");
    expect(activeHistory.value?.history.undoLabel).toBe("Move node");
    expect(undo()).toBe(true);
    stepBack();
    expect(calls).toEqual(["undo", "back"]);
  });

  it("is the focused asset document's history, and the scene's again once something else is clicked", () => {
    const { stack, calls } = fakeStack(true);
    openFakeScene(stack);
    const doc = openDoc();
    doc.edit({ n: 2 }, { label: "Set n" });
    const editor = element({ asset: PATH });
    focus(element({ parent: editor }), "focusin");
    expect(activeHistory.value).toMatchObject({ kind: "asset", path: PATH });
    expect(activeHistory.value?.history.undoLabel).toBe("Set n");
    expect(undo()).toBe(true);
    expect(doc.value.value).toEqual({ n: 1 });
    expect(redo()).toBe(true);
    expect(doc.value.value).toEqual({ n: 2 });
    expect(calls).toEqual([]); // the scene wasn't touched

    focus(element({ keeps: true })); // Edit > Undo in the menu bar: still the document's
    expect(activeHistory.value?.kind).toBe("asset");
    focus(element()); // the Hierarchy
    expect(activeHistory.value?.kind).toBe("scene");
    undo();
    expect(calls).toEqual(["undo"]);
  });

  it("is a panel's own history while it's focused, ahead of an asset document on the same root, until unregistered", () => {
    const { stack } = fakeStack(true);
    openFakeScene(stack);
    openDoc().edit({ n: 3 });
    const root = element({ asset: PATH });
    const local = panelHistory();
    const stop = providePanelHistory(root as unknown as Element, local);
    focus(element({ parent: element({ parent: root }) }));
    expect(activeHistory.value).toMatchObject({ kind: "panel", history: local });
    undo();
    redo();
    expect(local.calls).toEqual(["undo", "redo"]);

    focus(element({ keeps: true })); // the History panel keeps it
    expect(activeHistory.value?.kind).toBe("panel");
    stop();
    expect(activeHistory.value?.kind).toBe("asset"); // the document marked on the same root
  });

  it("does nothing when there's nothing to undo or redo, or nothing to act on", () => {
    expect(activeHistory.value).toBeNull(); // no scene, nothing focused
    expect(undo()).toBe(false);
    expect(redo()).toBe(false);
    const { stack, calls } = fakeStack(false);
    openFakeScene(stack);
    expect(undo()).toBe(false);
    expect(redo()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is what Ctrl/Cmd+Z and Ctrl+Y act on, except in text fields", () => {
    class FakeInput {
      type = "text";
      isContentEditable = false;
    }
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("HTMLSelectElement", class {});
    const keyListeners = new Map<string, Listener>();
    const win = { addEventListener: (t: string, l: Listener) => keyListeners.set(t, l), removeEventListener: (t: string) => keyListeners.delete(t) };
    const stopShortcuts = installShortcuts(win as unknown as Window);
    try {
      const { stack, calls } = fakeStack(true, true);
      openFakeScene(stack);
      const root = element();
      const local = panelHistory();
      providePanelHistory(root as unknown as Element, local);
      const inPanel = Object.assign(element({ parent: root }), { isContentEditable: false });
      focus(inPanel);
      const press = (key: string, target: object, shiftKey = false) => {
        const e = { key, ctrlKey: true, metaKey: false, shiftKey, altKey: false, target, preventDefault: vi.fn() };
        keyListeners.get("keydown")!(e as unknown as Event);
        return e.preventDefault;
      };
      expect(press("z", inPanel)).toHaveBeenCalled();
      press("y", inPanel);
      press("z", inPanel, true);
      expect(local.calls).toEqual(["undo", "redo", "redo"]);
      // A text field keeps the browser's own undo.
      const field = Object.assign(new FakeInput(), { closest: () => null });
      expect(press("z", field)).not.toHaveBeenCalled();
      expect(local.calls).toHaveLength(3);
      expect(calls).toEqual([]);
    } finally {
      stopShortcuts();
    }
  });
});
