import { describe, expect, it, vi } from "vitest";
import { openChildWindow } from "./childWindow";

type Listener = (e: Event) => void;

class FakeKeyboardEvent {
  constructor(
    readonly type: string,
    readonly init: { key: string; altKey: boolean },
  ) {}
}

function fakeMain(open: (url: string, target: string, features: string) => Window | null) {
  const root = { attributes: [], hasAttribute: () => false, getAttribute: () => null, setAttribute: () => {}, removeAttribute: () => {}, ownerDocument: { defaultView: null } };
  const main = {
    location: { href: "http://localhost:3000/editor.html?sample=flappy" },
    open: vi.fn(open),
    addEventListener: vi.fn(),
    document: { head: { childNodes: [] }, documentElement: root, defaultView: null },
    focus: vi.fn(),
    dispatchEvent: vi.fn(),
    KeyboardEvent: FakeKeyboardEvent,
  };
  return main as typeof main & Window;
}

/** A child whose panel page has loaded: what the window module reads and listens to on it. */
function loadedChild() {
  const listeners = new Map<string, Listener[]>();
  const root = { attributes: [], hasAttribute: () => false, getAttribute: () => null, setAttribute: () => {}, removeAttribute: () => {} };
  const container = {};
  const document = {
    readyState: "complete",
    title: "",
    getElementById: (id: string) => (id === "panel-window-root" ? container : null),
    createComment: () => ({ parentNode: null, nextSibling: null }),
    head: { append: () => {} },
    documentElement: root,
  };
  const child = {
    closed: false,
    document,
    screenX: 100,
    screenY: 50,
    innerWidth: 400,
    innerHeight: 300,
    close: vi.fn(() => (child.closed = true)),
    addEventListener: (type: string, l: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l)),
  };
  const fire = (type: string, e: object) => {
    for (const l of listeners.get(type) ?? []) l({ target: null, preventDefault: () => {}, ...e } as unknown as Event);
  };
  return { child, container, fire };
}

describe("detached panel windows (ADR 0174)", () => {
  it("open as pop-ups placed and sized by their bounds", () => {
    const features = (bounds?: object) => {
      const main = fakeMain(() => null);
      openChildWindow({ title: "Inspector", bounds }, main);
      return main.open.mock.calls[0][2];
    };
    expect(features()).toBe("popup");
    expect(features({ x: 10.4, y: -20, w: 640, h: 480 })).toBe("popup,width=640,height=480,left=10,top=-20");
    expect(features({ w: 0, h: Number.NaN, x: 5 })).toBe("popup,left=5");
  });

  it("return null and say why when the pop-up is blocked", () => {
    const onRefused = vi.fn();
    expect(openChildWindow({ title: "Inspector", onRefused }, fakeMain(() => null))).toBeNull();
    expect(onRefused).toHaveBeenCalledWith(expect.stringMatching(/blocked the new window/));
    // Some browsers hand back a window that is closed at once.
    expect(openChildWindow({ title: "Inspector", onRefused }, fakeMain(() => ({ closed: true }) as Window))).toBeNull();
    expect(onRefused).toHaveBeenCalledTimes(2);
  });

  it("open the panel page beside the editor's, synchronously, and close it when it doesn't load", async () => {
    const child = { closed: false, document: { readyState: "loading", getElementById: () => null }, close: vi.fn(() => (child.closed = true)) };
    const main = fakeMain(() => child as unknown as Window);
    const opening = openChildWindow({ title: "Inspector", bounds: { w: 300, h: 200 }, timeout: 50 }, main);
    expect(main.open).toHaveBeenCalledWith("http://localhost:3000/panel-window.html", "_blank", "popup,width=300,height=200");
    expect(main.addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    await expect(opening).rejects.toThrow(/didn't load/);
    expect(child.close).toHaveBeenCalled();
  });

  it("reject when the user closes the window before it loads", async () => {
    const child = { closed: false, document: { readyState: "loading", getElementById: () => null }, close: vi.fn() };
    const opening = openChildWindow({ title: "Inspector" }, fakeMain(() => child as unknown as Window));
    child.closed = true;
    await expect(opening).rejects.toThrow(/closed before it opened/);
  });

  it("hand back the loaded page, titled, reporting bounds the way they're opened with (outer position, inner size)", async () => {
    const { child, container } = loadedChild();
    const handle = await openChildWindow({ title: "Inspector" }, fakeMain(() => child as unknown as Window))!;
    expect(handle.container).toBe(container);
    expect(child.document.title).toBe("Inspector");
    expect(handle.bounds()).toEqual({ x: 100, y: 50, w: 400, h: 300 });
    handle.close();
    expect(handle.closed.value).toBe(true);
    expect(child.close).toHaveBeenCalled();
  });

  it("forward a bare Alt press (the menu bar's focus key) to the main window, not Alt used as a modifier", async () => {
    const { child, fire } = loadedChild();
    const main = fakeMain(() => child as unknown as Window);
    const handle = await openChildWindow({ title: "Inspector" }, main)!;
    const key = (k: string, mods: object = {}) => ({ key: k, code: "", repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    const forwarded = () => main.focus.mock.calls.length;

    fire("keydown", key("Alt"));
    fire("keyup", key("Alt"));
    expect(forwarded()).toBe(1);
    expect(main.dispatchEvent.mock.calls.map(([e]) => [e.type, e.init.key, e.init.altKey])).toEqual([
      ["keydown", "Alt", true],
      ["keyup", "Alt", false],
    ]);

    fire("keydown", key("Alt"));
    fire("keydown", key("z", { altKey: true }));
    fire("keyup", key("Alt"));
    fire("keydown", key("Alt"));
    fire("pointerdown", {}); // a click while held
    fire("keyup", key("Alt"));
    fire("keydown", key("Alt"));
    fire("wheel", {});
    fire("keyup", key("Alt"));
    fire("keydown", key("Alt", { ctrlKey: true }));
    fire("keyup", key("Alt"));
    expect(forwarded()).toBe(1);

    handle.close(); // stops forwarding
    fire("keydown", key("Alt"));
    fire("keyup", key("Alt"));
    expect(forwarded()).toBe(1);
  });
});
