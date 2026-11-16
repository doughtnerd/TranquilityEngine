import { describe, expect, it, vi } from "vitest";
import { openPopover, type DismissReason } from "./popover";

type Listener = (e: Event) => void;

/** A detached panel window (ADR 0174): another realm's window and document, duck-typed as windows/dom.ts reads them. */
function fakeWindow(innerWidth = 320, innerHeight = 240) {
  const listeners = new Map<string, Listener[]>();
  const win = {
    innerWidth,
    innerHeight,
    addEventListener: (type: string, l: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l)),
  } as unknown as Window & { innerWidth: number; innerHeight: number };
  (win as { window: unknown }).window = win;
  const doc = { nodeType: 9, defaultView: win, activeElement: null as Element | null } as unknown as Document & { activeElement: Element | null };
  (win as { document: unknown }).document = doc;
  const fire = (type: string, init: Record<string, unknown>) => {
    const e = { type, stopPropagation: vi.fn(), ...init } as unknown as Event;
    for (const l of listeners.get(type) ?? []) l(e);
    return e;
  };
  const listening = () => [...listeners.values()].some((l) => l.length > 0);
  return { win, doc, fire, listening };
}

type Fake = HTMLElement & { kids: Fake[]; disabled: boolean; fire(type: string, init: Record<string, unknown>): void; focused: boolean };

/** An element in `doc`, `size` big where it's drawn (`rect` for an anchor). */
function element(doc: Document & { activeElement: Element | null }, opts: { size?: { width: number; height: number }; rect?: DOMRect | Partial<DOMRect>; tag?: string; disabled?: boolean } = {}): Fake {
  const listeners = new Map<string, Listener[]>();
  const el = {
    nodeType: 1,
    tagName: (opts.tag ?? "div").toUpperCase(),
    ownerDocument: doc,
    isConnected: true,
    disabled: !!opts.disabled,
    style: {} as Record<string, string>,
    kids: [] as Fake[],
    focused: false,
    getBoundingClientRect: () => (opts.rect ?? { left: 0, top: 0, right: opts.size?.width ?? 0, bottom: opts.size?.height ?? 0, ...opts.size }) as DOMRect,
    contains(node: unknown): boolean {
      return node === el || el.kids.some((c) => c.contains(node as Node));
    },
    querySelector: () => el.kids.find((c) => c.tagName === "BUTTON" && !c.disabled) ?? null,
    focus() {
      el.focused = true;
      doc.activeElement = el as unknown as Element;
    },
    addEventListener: (type: string, l: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
    removeEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l)),
    fire: (type: string, init: Record<string, unknown>) => {
      for (const l of listeners.get(type) ?? []) l({ type, ...init } as unknown as Event);
    },
  };
  return el as unknown as Fake;
}

const MENU = { width: 100, height: 80 };

describe("popovers (menus and floating panels), in the window they're in (ADR 0174)", () => {
  it("dismiss on a press outside in their own window, not for presses inside them or their toggle", () => {
    const child = fakeWindow();
    const toggle = element(child.doc);
    const menu = element(child.doc, { size: MENU });
    const item = element(child.doc, { tag: "button" });
    menu.kids.push(item);
    const reasons: DismissReason[] = [];
    const popover = openPopover(menu, { anchor: toggle, inside: [{ current: toggle }], onDismiss: (r) => reasons.push(r) });
    expect(popover.window).toBe(child.win);
    child.fire("pointerdown", { target: item });
    child.fire("pointerdown", { target: toggle });
    expect(reasons).toEqual([]);
    child.fire("pointerdown", { target: element(child.doc) });
    expect(reasons).toEqual(["outside"]);
    expect(child.listening()).toBe(false); // once dismissed it stops listening
  });

  it("stay inside their own window's viewport, measured once drawn", () => {
    const child = fakeWindow(320, 240);
    const menu = element(child.doc, { size: MENU });
    openPopover(menu, { anchor: { x: 300, y: 230 }, onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ left: `${320 - 100 - 4}px`, top: `${240 - 80 - 4}px` });
    openPopover(menu, { anchor: { x: 30, y: 40 }, onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ left: "30px", top: "40px" });
    openPopover(menu, { anchor: { x: 150, y: 40 }, align: "end", onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ left: "50px", top: "40px" });
  });

  it("open beside an anchor element, flipping to the other side when only that one has room", () => {
    const child = fakeWindow(320, 240);
    const menu = element(child.doc, { size: MENU });
    const button = (top: number) => element(child.doc, { rect: { left: 200, right: 260, top, bottom: top + 20 } });
    openPopover(menu, { anchor: button(20), onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ left: "200px", top: "44px" }); // below, 4px gap
    openPopover(menu, { anchor: button(200), onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ top: `${200 - 4 - 80}px` }); // no room below: above
    openPopover(menu, { anchor: button(150), side: "above", align: "end", onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ left: "160px", top: `${150 - 4 - 80}px` });
    openPopover(menu, { anchor: button(20), side: "above", onDismiss: () => {} }).close();
    expect(menu.style).toMatchObject({ top: "44px" }); // no room above: below
  });

  it("leave an unanchored popover where its CSS put it", () => {
    const child = fakeWindow();
    const menu = element(child.doc, { size: MENU });
    openPopover(menu, { onDismiss: () => {} }).close();
    expect(menu.style).toEqual({});
  });

  it("focus their first enabled item, and give focus back on Escape, which goes no further", () => {
    const child = fakeWindow();
    const opener = element(child.doc, { tag: "button" });
    opener.focus();
    opener.focused = false;
    const menu = element(child.doc, { size: MENU });
    const off = element(child.doc, { tag: "button", disabled: true });
    const on = element(child.doc, { tag: "button" });
    menu.kids.push(off, on);
    const onDismiss = vi.fn();
    openPopover(menu, { anchor: { x: 0, y: 0 }, focusFirst: true, onDismiss });
    expect(on.focused).toBe(true);
    child.fire("keydown", { key: "ArrowDown" });
    expect(onDismiss).not.toHaveBeenCalled();
    const escape = child.fire("keydown", { key: "Escape" });
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledWith("escape");
    expect(opener.focused).toBe(true);
  });

  it("leave Escape to owners that handle it", () => {
    const child = fakeWindow();
    const onDismiss = vi.fn();
    openPopover(element(child.doc, { size: MENU }), { escape: false, onDismiss });
    const escape = child.fire("keydown", { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(escape.stopPropagation).not.toHaveBeenCalled();
  });

  it("dismiss when their window loses focus, or focus moves to an element outside them", () => {
    const child = fakeWindow();
    const onDismiss = vi.fn();
    openPopover(element(child.doc, { size: MENU }), { onDismiss });
    child.fire("blur", { target: child.win });
    expect(onDismiss).toHaveBeenCalledWith("blur");
    const withPicker = vi.fn();
    openPopover(element(child.doc, { size: MENU }), { blur: false, onDismiss: withPicker });
    child.fire("blur", { target: child.win }); // a colour input's picker opened
    expect(withPicker).not.toHaveBeenCalled();

    const toggle = element(child.doc);
    const menu = element(child.doc, { size: MENU });
    const onLeave = vi.fn();
    openPopover(menu, { inside: [toggle], onDismiss: onLeave });
    menu.fire("focusout", { relatedTarget: null }); // the focused item went away
    menu.fire("focusout", { relatedTarget: toggle });
    expect(onLeave).not.toHaveBeenCalled();
    menu.fire("focusout", { relatedTarget: element(child.doc) });
    expect(onLeave).toHaveBeenCalledWith("focus");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("stop listening when their owner closes them", () => {
    const child = fakeWindow();
    const onDismiss = vi.fn();
    const popover = openPopover(element(child.doc, { size: MENU }), { onDismiss });
    popover.close();
    popover.close();
    expect(child.listening()).toBe(false);
    child.fire("pointerdown", { target: element(child.doc) });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
