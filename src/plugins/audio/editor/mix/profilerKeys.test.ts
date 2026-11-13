// ADR 0171/0172 (Pf8; api-and-models §7): the Profiler's keys, scoped to the panel and mapped to `CursorModel`. A case per
// key (the cursor's time after it), inactive when the panel isn't focused, inactive in editable controls and with
// modifiers, and the listener attach/detach. No assertion reads a wall clock.
import { describe, expect, it } from "vitest";
import { CursorModel, NO_TARGETS, type CursorTargets } from "./cursorModel";
import {
  KEY_BINDINGS, PANEL_KEYSHORTCUTS, attachProfilerKeys, handleProfilerKey, isEditableTarget, keyActionOf, runKeyAction,
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
      expect(keyActionOf({ key: k, shiftKey: shift })).toEqual(b.action);
    }
    expect(PANEL_KEYSHORTCUTS.split(" ")).toHaveLength(KEY_BINDINGS.length);
  });

  it("runKeyAction returns whether the cursor changed", () => {
    const { controller } = rig(3);
    expect(runKeyAction({ type: "jump", kind: "marker", direction: "next" }, controller)).toBe(true);
    expect(runKeyAction({ type: "jump", kind: "marker", direction: "next" }, controller)).toBe(false);
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
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(keyActionOf({ key: "ArrowLeft", target: { tagName: "INPUT" } })).toBeNull();
    expect(keyActionOf({ key: "u", ctrlKey: true })).toBeNull();
    expect(keyActionOf({ key: "u", altKey: true })).toBeNull();
    expect(keyActionOf({ key: "u", metaKey: true })).toBeNull();
    expect(keyActionOf({ key: "x" })).toBeNull();
    expect(keyActionOf({ key: "Enter" })).toBeNull();
    expect(keyActionOf({ key: "ArrowLeft", shiftKey: true })).toBeNull();
  });

  it("Space on a focused button is the button's own click", () => {
    expect(keyActionOf({ key: " ", target: { tagName: "BUTTON" } })).toBeNull();
    expect(keyActionOf({ key: " ", target: { tagName: "CANVAS" } })).toEqual({ type: "toggleLive" });
    expect(keyActionOf({ key: "ArrowRight", target: { tagName: "BUTTON" } })).toEqual({ type: "step", direction: "next" });
  });
});

describe("attachProfilerKeys", () => {
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

  it("makes the panel focusable and listed, acts only with focus inside, and detaches cleanly", () => {
    const el = element();
    const { controller, cursor } = rig(3);
    const off = attachProfilerKeys(el, controller);
    expect(el.attrs.get("tabindex")).toBe("0");
    expect(el.attrs.get("aria-keyshortcuts")).toBe(PANEL_KEYSHORTCUTS);
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
