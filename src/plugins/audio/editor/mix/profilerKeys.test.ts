// ADR 0171/0172 (Pf8; api-and-models §7): the Profiler's keys, scoped to the panel and mapped to `CursorModel`. A case per
// key (the cursor's time after it), inactive when the panel isn't focused, inactive in editable controls and with
// modifiers, and the listener attach/detach. No assertion reads a wall clock.
import { describe, expect, it } from "vitest";
import { CursorModel, NO_TARGETS, type CursorTargets } from "./cursorModel";
import {
  KEY_BINDINGS, attachProfilerKeys,
  type KeyEventLike, type KeyScopeElement,
} from "./profilerKeys";

const f = (...v: number[]) => Float64Array.from(v);
const TARGETS: CursorTargets = {
  ...NO_TARGETS,
  status: f(0, 1, 2, 3, 4, 5),
  underrun: f(1.5, 4.5),
  lateCommand: f(2.5),
  ladder: f(0.5, 3.5),
  marker: f(1, 5),
};

/** A paused file cursor at `t` over `TARGETS`, with a controller recording `cursorMoved` calls. */
function rig(t = 3, live = false) {
  const cursor = new CursorModel({ live });
  cursor.setDuration(6);
  cursor.setTargets(TARGETS);
  if (!live) cursor.seekTo(t);
  const moved: number[] = [];
  return { cursor, controller: { cursor, cursorMoved: async () => void moved.push(cursor.time) }, moved };
}

const key = (k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike & { prevented: number } => {
  const e = { key: k, ...extra, prevented: 0, preventDefault() { e.prevented++; } };
  return e;
};

/** A stand-in panel element whose focus is set by the test. */
function element(preset: Record<string, string> = {}) {
  const attrs = new Map(Object.entries(preset));
  let listener: ((e: KeyEventLike) => void) | null = null;
  const inside = {};
  const doc = { activeElement: null as unknown };
  const el: KeyScopeElement & { fire(e: KeyEventLike): void; inside: object; doc: typeof doc; attrs: Map<string, string>; hasListener(): boolean } = {
    addEventListener: (_t, l) => void (listener = l),
    removeEventListener: (_t, l) => void (listener === l && (listener = null)),
    hasAttribute: (n) => attrs.has(n),
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
    contains: (o) => o === inside || o === el,
    ownerDocument: doc,
    fire: (e) => listener?.(e),
    hasListener: () => listener !== null,
    inside,
    doc,
    attrs,
  };
  return el;
}

/** A key pressed in the panel as `attachProfilerKeys` scopes it, with focus inside when `focused()`; true when the panel took it. */
function handleProfilerKey(e: KeyEventLike, controller: Parameters<typeof attachProfilerKeys>[1], focused: () => boolean): boolean {
  const el = element();
  const off = attachProfilerKeys(el, controller);
  el.doc.activeElement = focused() ? el.inside : null;
  let handled = false;
  el.fire({ ...e, preventDefault: () => { handled = true; e.preventDefault?.(); } });
  off();
  return handled;
}

/** Whether the focused panel takes the key (over a paused file cursor at 3). */
const isOurs = (e: KeyEventLike): boolean => handleProfilerKey(e, rig(3).controller, () => true);

describe("a case per key, through CursorModel", () => {
  const cases: Array<[string, Partial<KeyEventLike> & { key: string }, number]> = [
    ["ArrowLeft steps back one STATUS block", { key: "ArrowLeft" }, 2],
    ["ArrowRight steps forward one STATUS block", { key: "ArrowRight" }, 4],
    ["u: previous underrun", { key: "u" }, 1.5],
    ["Shift+U: next underrun", { key: "U", shiftKey: true }, 4.5],
    ["l: previous late command", { key: "l" }, 2.5],
    ["d: previous ladder step", { key: "d" }, 0.5],
    ["Shift+D: next ladder step", { key: "D", shiftKey: true }, 3.5],
    ["m: previous marker", { key: "m" }, 1],
    ["Shift+M: next marker", { key: "M", shiftKey: true }, 5],
  ];
  for (const [name, ev, expected] of cases) {
    it(name, () => {
      const { controller, cursor, moved } = rig(3);
      const e = key(ev.key, ev);
      expect(handleProfilerKey(e, controller, () => true)).toBe(true);
      expect(cursor.time).toBe(expected);
      expect(cursor.mode).toBe("paused");
      expect(moved).toEqual([expected]);
      expect(e.prevented).toBe(1);
    });
  }

  it("Shift+L: next late command, from before it", () => {
    const { controller, cursor, moved } = rig(1);
    expect(handleProfilerKey(key("L", { shiftKey: true }), controller, () => true)).toBe(true);
    expect(cursor.time).toBe(2.5);
    expect(moved).toEqual([2.5]);
  });

  it("at the end of a kind nothing moves and the controller isn't told, but the key is still ours", () => {
    const { controller, cursor, moved } = rig(3);
    const e = key("L", { shiftKey: true }); // no late command after 3
    expect(handleProfilerKey(e, controller, () => true)).toBe(true);
    expect(cursor.time).toBe(3);
    expect(moved).toEqual([]);
    expect(e.prevented).toBe(1);
    const first = rig(0);
    handleProfilerKey(key("ArrowLeft"), first.controller, () => true);
    expect(first.cursor.time).toBe(0);
    expect(first.moved).toEqual([]);
  });

  it("Space pauses a live view where it is and goes live again; a file can't go live", () => {
    const live = rig(0, true);
    expect(live.cursor.mode).toBe("live");
    expect(handleProfilerKey(key(" "), live.controller, () => true)).toBe(true);
    expect(live.cursor.mode).toBe("paused");
    expect(live.cursor.time).toBe(5);
    expect(live.moved).toEqual([5]);
    expect(handleProfilerKey(key(" "), live.controller, () => true)).toBe(true);
    expect(live.cursor.mode).toBe("live");
    const file = rig(3);
    handleProfilerKey(key(" "), file.controller, () => true);
    expect(file.cursor.mode).toBe("paused");
    expect(file.moved).toEqual([]);
  });

  it("every binding in the legend is reachable by its own keys", () => {
    for (const b of KEY_BINDINGS) {
      const shift = b.keys.startsWith("Shift+");
      const bare = shift ? b.keys.slice(6) : b.keys;
      const k = bare === "Left" ? "ArrowLeft" : bare === "Right" ? "ArrowRight" : bare === "Space" ? " " : shift ? bare : bare.toLowerCase();
      expect(isOurs({ key: k, shiftKey: shift }), b.keys).toBe(true);
    }
    const el = element();
    attachProfilerKeys(el, rig().controller);
    expect(el.attrs.get("aria-keyshortcuts")!.split(" ")).toEqual(KEY_BINDINGS.map((b) => b.shortcuts));
  });

  it("the controller is told only when the cursor changed", () => {
    const { controller, moved } = rig(3);
    handleProfilerKey(key("M", { shiftKey: true }), controller, () => true);
    handleProfilerKey(key("M", { shiftKey: true }), controller, () => true); // no marker after the last
    expect(moved).toEqual([5]);
  });
});

describe("scope", () => {
  it("keys are inactive when the panel isn't focused: nothing moves, nothing is prevented", () => {
    for (const b of KEY_BINDINGS) {
      const { controller, cursor, moved } = rig(3);
      const shift = b.keys.startsWith("Shift+");
      const bare = shift ? b.keys.slice(6) : b.keys;
      const k = bare === "Left" ? "ArrowLeft" : bare === "Right" ? "ArrowRight" : bare === "Space" ? " " : shift ? bare : bare.toLowerCase();
      const e = key(k, { shiftKey: shift });
      expect(handleProfilerKey(e, controller, () => false)).toBe(false);
      expect(cursor.time).toBe(3);
      expect(moved).toEqual([]);
      expect(e.prevented).toBe(0);
    }
  });

  it("editable controls keep their keys; so do Ctrl, Alt and Meta chords and unbound keys", () => {
    expect(isOurs({ key: "u", target: { tagName: "INPUT" } })).toBe(false);
    expect(isOurs({ key: "u", target: { tagName: "textarea" } })).toBe(false);
    expect(isOurs({ key: "u", target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
    expect(isOurs({ key: "u", target: { tagName: "DIV" } })).toBe(true);
    expect(isOurs({ key: "ArrowLeft", target: { tagName: "INPUT" } })).toBe(false);
    expect(isOurs({ key: "u", ctrlKey: true })).toBe(false);
    expect(isOurs({ key: "u", altKey: true })).toBe(false);
    expect(isOurs({ key: "u", metaKey: true })).toBe(false);
    expect(isOurs({ key: "x" })).toBe(false);
    expect(isOurs({ key: "Enter" })).toBe(false);
    expect(isOurs({ key: "ArrowLeft", shiftKey: true })).toBe(false);
  });

  it("Space on a focused button is the button's own click", () => {
    const live = rig(0, true);
    expect(handleProfilerKey(key(" ", { target: { tagName: "BUTTON" } }), live.controller, () => true)).toBe(false);
    expect(live.cursor.mode).toBe("live");
    expect(handleProfilerKey(key(" ", { target: { tagName: "CANVAS" } }), live.controller, () => true)).toBe(true);
    expect(live.cursor.mode).toBe("paused"); // Space toggled live
    const file = rig(3);
    expect(handleProfilerKey(key("ArrowRight", { target: { tagName: "BUTTON" } }), file.controller, () => true)).toBe(true);
    expect(file.cursor.time).toBe(4);
  });
});

describe("attachProfilerKeys", () => {
  it("makes the panel focusable and listed, acts only with focus inside, and detaches cleanly", () => {
    const el = element();
    const { controller, cursor } = rig(3);
    const off = attachProfilerKeys(el, controller);
    expect(el.attrs.get("tabindex")).toBe("0");
    expect(el.attrs.get("aria-keyshortcuts")).toBe(KEY_BINDINGS.map((b) => b.shortcuts).join(" "));
    el.doc.activeElement = {}; // focus elsewhere in the editor
    el.fire(key("ArrowRight"));
    expect(cursor.time).toBe(3);
    el.doc.activeElement = null;
    el.fire(key("ArrowRight"));
    expect(cursor.time).toBe(3);
    el.doc.activeElement = el.inside; // focus within the panel
    el.fire(key("ArrowRight"));
    expect(cursor.time).toBe(4);
    off();
    expect(el.hasListener()).toBe(false);
    expect(el.attrs.has("tabindex")).toBe(false);
    expect(el.attrs.has("aria-keyshortcuts")).toBe(false);
    el.fire(key("ArrowRight"));
    expect(cursor.time).toBe(4);
  });

  it("leaves a tabindex the panel already had", () => {
    const el = element({ tabindex: "-1" });
    const off = attachProfilerKeys(el, rig().controller);
    expect(el.attrs.get("tabindex")).toBe("-1");
    off();
    expect(el.attrs.get("tabindex")).toBe("-1");
  });
});
