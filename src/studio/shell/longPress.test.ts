// Long-press to open a context menu, through what it does: touches on a page `installLongPress` listens on, and the
// `contextmenu` events an element under the finger receives.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LONG_PRESS_MS, installLongPress } from "./longPress";

class FakeTimers {
  now = 0;
  private next = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => void this.pending.delete(id as number);
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.pending]) {
      if (t.at <= this.now) {
        this.pending.delete(id);
        t.fn();
      }
    }
  }
}

/** An element in a page: events dispatched on it reach the page (capture first), as in the DOM. */
class Page extends EventTarget {}
class Element extends EventTarget {
  constructor(private page: Page) {
    super();
  }
  override dispatchEvent(e: Event): boolean {
    Object.defineProperty(e, "target", { value: this, configurable: true });
    this.page.dispatchEvent(e);
    if (e.cancelBubble) return !e.defaultPrevented;
    return super.dispatchEvent(e) && !e.defaultPrevented;
  }
}

const pointer = (type: string, init: Partial<{ pointerType: string; pointerId: number; clientX: number; clientY: number; isPrimary: boolean }> = {}) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerType: "touch", pointerId: 1, clientX: 50, clientY: 60, isPrimary: true, ...init });

let page: Page;
let row: Element;
let timers: FakeTimers;
let stop: () => void;
let menus: { x: number; y: number }[];

beforeEach(() => {
  page = new Page();
  row = new Element(page);
  timers = new FakeTimers();
  stop = installLongPress(page, timers);
  menus = [];
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menus.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
  });
});
afterEach(() => stop());

describe("long-press", () => {
  it("opens the pressed element's menu at the finger after a still hold", () => {
    row.dispatchEvent(pointer("pointerdown"));
    timers.advance(LONG_PRESS_MS - 1);
    expect(menus).toEqual([]);
    timers.advance(1);
    expect(menus).toEqual([{ x: 50, y: 60 }]);
  });

  it("swallows the click that lifting the finger makes, once", () => {
    row.dispatchEvent(pointer("pointerdown"));
    timers.advance(LONG_PRESS_MS);
    row.dispatchEvent(pointer("pointerup"));
    let clicks = 0;
    row.addEventListener("click", () => clicks++);
    row.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    row.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
  });

  it("does nothing for a tap, a drag or a mouse", () => {
    row.dispatchEvent(pointer("pointerdown"));
    timers.advance(100);
    row.dispatchEvent(pointer("pointerup"));
    row.dispatchEvent(pointer("pointerdown"));
    row.dispatchEvent(pointer("pointermove", { clientX: 80 }));
    row.dispatchEvent(pointer("pointerdown", { pointerType: "mouse" }));
    timers.advance(LONG_PRESS_MS * 2);
    expect(menus).toEqual([]);
  });

  it("leaves the browser's own long-press menu alone", () => {
    row.dispatchEvent(pointer("pointerdown"));
    timers.advance(400);
    const native = new Event("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(native, "isTrusted", { value: true });
    row.dispatchEvent(native);
    timers.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(1);
  });

  it("stops listening when stopped", () => {
    stop();
    row.dispatchEvent(pointer("pointerdown"));
    timers.advance(LONG_PRESS_MS);
    expect(menus).toEqual([]);
  });
});
