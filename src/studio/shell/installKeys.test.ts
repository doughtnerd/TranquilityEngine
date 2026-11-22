// The Studio's global keys, through what they do: keys go to a window `installStudioKeys` listens on, and Undo, Redo and
// history steps reach the active history (here an open scene's stand-in), classified as the editor classifies them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openScene, type OpenScene } from "../../editor/state";
import { installStudioKeys } from "./installKeys";
import { createRouter, type HashLocation } from "./route";
import { provideStudio } from "./studioServices";
import type { StudioAudioRuntime } from "../runtime/studioAudioHost";

type Mods = Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; code: string }>;

let win: EventTarget & { document: { querySelector(): null; querySelectorAll(): never[]; activeElement: null } };
let stop: () => void;
let calls: string[];

/** Press `key` on the Studio's window; returns whether the Studio claimed it (preventDefault). */
function press(key: string, mods: Mods = {}, target: object | null = null): boolean {
  const e = Object.assign(new Event("keydown"), { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...mods, preventDefault: vi.fn() });
  Object.defineProperty(e, "target", { value: target });
  win.dispatchEvent(e);
  return e.preventDefault.mock.calls.length > 0;
}

beforeEach(() => {
  calls = [];
  const stack = { canUndo: true, canRedo: true, undoLabel: "Edit", redoLabel: "Edit", allStates: [], current: 0, saved: 0, undo: () => calls.push("undo"), redo: () => calls.push("redo"), back: () => calls.push("back"), forward: () => calls.push("forward"), jumpTo: () => {} };
  openScene.value = { path: "main.scene.json", stack } as unknown as OpenScene;
  const hash: HashLocation = { get: () => "#/samples", set: () => {}, listen: () => () => {} };
  provideStudio({ router: createRouter(hash), runtime: {} as StudioAudioRuntime });
  win = Object.assign(new EventTarget(), { document: { querySelector: () => null, querySelectorAll: () => [] as never[], activeElement: null } });
  stop = installStudioKeys(win as unknown as Window);
});

afterEach(() => {
  stop();
  openScene.value = null;
});

describe("the Studio's history keys (the editor's classifier)", () => {
  it("Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl+Y redo", () => {
    expect(press("z", { ctrlKey: true })).toBe(true);
    expect(press("z", { metaKey: true, shiftKey: true })).toBe(true);
    expect(press("y", { ctrlKey: true })).toBe(true);
    expect(calls).toEqual(["undo", "redo", "redo"]);
  });

  it("Ctrl/Cmd+Alt(+Shift)+Z steps through history, read by key code when Alt changes the key", () => {
    expect(press("Ω", { metaKey: true, altKey: true, code: "KeyZ" })).toBe(true);
    expect(press("¸", { ctrlKey: true, altKey: true, shiftKey: true, code: "KeyZ" })).toBe(true);
    expect(calls).toEqual(["back", "forward"]);
  });

  it("a text field keeps its own undo", () => {
    expect(press("z", { ctrlKey: true }, { nodeType: 1, tagName: "INPUT", type: "text" })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("with no active history the key goes to the browser", () => {
    openScene.value = null;
    expect(press("z", { ctrlKey: true })).toBe(false);
  });
});
