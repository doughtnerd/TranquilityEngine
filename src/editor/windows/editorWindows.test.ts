import { afterEach, describe, expect, it, vi } from "vitest";
import { childWindows, dialogOpenAnywhere, editorWindows, forEachEditorWindow, isEditorWindow, registerEditorWindow } from "./editorWindows";

function fakeWindow(dialog = false) {
  const win = { document: { querySelector: (sel: string) => (sel === ".dialog" && dialog ? {} : null) } } as unknown as Window;
  (win as { window: unknown }).window = win;
  return win;
}

describe("the editor's windows (ADR 0174, detached windows)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it("lists detached windows as they open and close", () => {
    const a = fakeWindow(), b = fakeWindow();
    const offA = registerEditorWindow(a);
    const offB = registerEditorWindow(b);
    cleanups.push(offA, offB);
    expect(childWindows.value).toEqual([a, b]);
    expect(editorWindows()).toEqual([a, b]); // no main window in Node
    expect(isEditorWindow(a)).toBe(true);
    offA();
    expect(childWindows.value).toEqual([b]);
    expect(isEditorWindow(a)).toBe(false);
  });

  it("runs subscribers for open windows and new ones, and their cleanups when a window closes or they unsubscribe", () => {
    const a = fakeWindow(), b = fakeWindow();
    cleanups.push(registerEditorWindow(a));
    const stopped: Window[] = [];
    const seen = vi.fn((w: Window) => () => void stopped.push(w));
    const unsubscribe = forEachEditorWindow(seen);
    expect(seen).toHaveBeenCalledWith(a);
    const offB = registerEditorWindow(b);
    expect(seen).toHaveBeenCalledWith(b);
    offB();
    expect(stopped).toEqual([b]);
    unsubscribe();
    expect(stopped).toEqual([b, a]);
    // Registering again after unsubscribing doesn't call it.
    cleanups.push(registerEditorWindow(fakeWindow()));
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("registers a window once", () => {
    const a = fakeWindow();
    const seen = vi.fn();
    cleanups.push(forEachEditorWindow(seen));
    cleanups.push(registerEditorWindow(a));
    registerEditorWindow(a)();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(childWindows.value).toEqual([a]);
  });

  it("sees a dialog open in any window", () => {
    cleanups.push(registerEditorWindow(fakeWindow()));
    expect(dialogOpenAnywhere()).toBe(false);
    cleanups.push(registerEditorWindow(fakeWindow(true)));
    expect(dialogOpenAnywhere()).toBe(true);
  });
});
