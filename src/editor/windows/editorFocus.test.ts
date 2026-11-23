import { afterEach, describe, expect, it } from "vitest";
import { editorFocus, KEEPS_HISTORY_FOCUS } from "./editorFocus";
import { registerEditorWindow } from "./editorWindows";

type Listener = (e: Event) => void;

/** An editor window, registered as the editor registers its detached windows (ADR 0174). */
function editorWindow() {
  const listeners = new Map<string, Listener[]>();
  const document = {
    addEventListener: (type: string, l: Listener, capture?: boolean) => capture && listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l)),
  };
  const win = { document } as unknown as Window;
  (win as { window: unknown }).window = win;
  const close = registerEditorWindow(win);
  const fire = (type: "focusin" | "pointerdown" | "change", target: unknown) => {
    for (const l of listeners.get(type) ?? []) l({ target } as unknown as Event);
  };
  return { fire, close, listening: () => [...listeners.values()].some((l) => l.length > 0) };
}
const element = (keeps = false) => ({ closest: (sel: string) => (keeps && sel === KEEPS_HISTORY_FOCUS ? {} : null) }) as unknown as Element;

describe("the editor focus (ADR 0145, ADR 0174)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));

  it("follows focus and presses in every editor window, as they open", () => {
    const a = editorWindow(), b = editorWindow();
    cleanups.push(a.close, b.close);
    const inA = element(), inB = element();
    a.fire("focusin", inA);
    expect(editorFocus.value).toBe(inA);
    b.fire("pointerdown", inB);
    expect(editorFocus.value).toBe(inB);
  });

  it("follows a committed change in a field neither focus nor a press reached (a select set by a script)", () => {
    const a = editorWindow();
    cleanups.push(a.close);
    a.fire("pointerdown", element());
    const select = element();
    a.fire("change", select);
    expect(editorFocus.value).toBe(select);
  });

  it("stays where it was for presses in the History panel or a menu, and for targets that aren't elements", () => {
    const a = editorWindow();
    cleanups.push(a.close);
    const field = element();
    a.fire("focusin", field);
    a.fire("pointerdown", element(true));
    a.fire("focusin", { nodeType: 9 }); // the document itself
    expect(editorFocus.value).toBe(field);
  });

  it("stops listening in a window once it closes", () => {
    const a = editorWindow();
    expect(a.listening()).toBe(true);
    a.close();
    expect(a.listening()).toBe(false);
  });
});
