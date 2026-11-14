import { describe, expect, it, vi } from "vitest";
import { bareAltTracker, boundsOf, openChildWindow, openChildWindows, PANEL_WINDOW_PAGE, POPUP_BLOCKED, windowFeatures } from "./childWindow";

function fakeMain(open: (url: string, target: string, features: string) => Window | null) {
  const main = { location: { href: "http://localhost:3000/editor.html?sample=flappy" }, open: vi.fn(open), addEventListener: vi.fn() } as unknown as Window;
  return main;
}

describe("detached panel windows (ADR 0174)", () => {
  it("open as pop-ups placed and sized by their bounds", () => {
    expect(windowFeatures()).toBe("popup");
    expect(windowFeatures({ x: 10.4, y: -20, w: 640, h: 480 })).toBe("popup,width=640,height=480,left=10,top=-20");
    expect(windowFeatures({ w: 0, h: Number.NaN, x: 5 })).toBe("popup,left=5");
  });

  it("report bounds the way windowFeatures takes them (outer position, inner size)", () => {
    expect(boundsOf({ screenX: 100, screenY: 50, innerWidth: 400, innerHeight: 300 })).toEqual({ x: 100, y: 50, w: 400, h: 300 });
  });

  it("return null and say why when the pop-up is blocked", () => {
    const onRefused = vi.fn();
    expect(openChildWindow({ title: "Inspector", onRefused }, fakeMain(() => null))).toBeNull();
    expect(onRefused).toHaveBeenCalledWith(POPUP_BLOCKED);
    // Some browsers hand back a window that is closed at once.
    expect(openChildWindow({ title: "Inspector", onRefused }, fakeMain(() => ({ closed: true }) as Window))).toBeNull();
    expect(onRefused).toHaveBeenCalledTimes(2);
  });

  it("open the panel page beside the editor's, synchronously, and close it when it doesn't load", async () => {
    const child = { closed: false, document: { readyState: "loading", getElementById: () => null }, close: vi.fn(() => (child.closed = true)) };
    const main = fakeMain(() => child as unknown as Window);
    const opening = openChildWindow({ title: "Inspector", bounds: { w: 300, h: 200 }, timeout: 50 }, main);
    expect(main.open).toHaveBeenCalledWith(`http://localhost:3000/${PANEL_WINDOW_PAGE}`, "_blank", "popup,width=300,height=200");
    expect(main.addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(openChildWindows()).toContain(child);
    await expect(opening).rejects.toThrow(/didn't load/);
    expect(child.close).toHaveBeenCalled();
    expect(openChildWindows()).not.toContain(child);
  });

  it("reject when the user closes the window before it loads", async () => {
    const child = { closed: false, document: { readyState: "loading", getElementById: () => null }, close: vi.fn() };
    const opening = openChildWindow({ title: "Inspector" }, fakeMain(() => child as unknown as Window));
    child.closed = true;
    await expect(opening).rejects.toThrow(/closed before it opened/);
  });

  it("tell a bare Alt press (the menu bar's focus key) from Alt used as a modifier", () => {
    const alt = bareAltTracker();
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });
    alt.down(key("Alt"));
    expect(alt.up(key("Alt"))).toBe(true);
    alt.down(key("Alt"));
    alt.down(key("z", { altKey: true }));
    expect(alt.up(key("Alt"))).toBe(false);
    alt.down(key("Alt"));
    alt.used(); // a click or the wheel while held
    expect(alt.up(key("Alt"))).toBe(false);
    alt.down(key("Alt", { ctrlKey: true }));
    expect(alt.up(key("Alt"))).toBe(false);
  });
});
