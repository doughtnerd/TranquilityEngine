// The Studio shell's rules: the six screens, the router and its hash, the keymap's scopes and preferences.
import { describe, expect, it, vi } from "vitest";
import type { KeyEventLike } from "../../editor/ui/keyCombo";
import { startRequest } from "../boot/startQuery";
import { createKeymap, panelScopesOf, type KeyContext } from "./keymap";
import { createRouter, formatRoute, parseRoute, resolveRoute, type HashLocation } from "./route";
import { SCREENS, screenGroups } from "./screens";

describe("screens", () => {
  it("are six in three groups, Ctrl/⌘+1…6 in header order", () => {
    expect(screenGroups().map((g) => [g.title, g.screens.map((s) => s.title)])).toEqual([
      ["Author", ["Samples", "Playlists"]],
      ["Mix", ["Mixer", "Spatial"]],
      ["Run", ["Take", "Profiler"]],
    ]);
    expect(SCREENS.map((s) => s.digit)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

/** A hash location in memory, with Back. */
function memoryHash(initial = "") {
  let hash = initial;
  const history: string[] = [];
  const listeners = new Set<() => void>();
  const location: HashLocation = {
    get: () => hash,
    set: (h, replace) => {
      if (!replace) history.push(hash);
      hash = h;
    },
    listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
  const back = () => {
    hash = history.pop() ?? hash;
    for (const fn of listeners) fn();
  };
  return { location, back, current: () => hash, depth: () => history.length };
}

describe("router", () => {
  it("reads and writes the hash: screen, asset and selection", () => {
    expect(parseRoute("#/mixer?asset=audio.json&select=Music")).toEqual({ screen: "mixer", asset: "audio.json", select: "Music" });
    expect(parseRoute("")).toEqual({ screen: "samples" });
    expect(parseRoute("#/nonsense?asset=x")).toEqual({ screen: "samples", asset: "x" });
    expect(parseRoute("#PROFILER")).toEqual({ screen: "profiler" });
    const route = { screen: "take", asset: "takes/run 1.mycotake", select: "i7" } as const;
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("opens screens; a new screen or asset starts clean, the same screen keeps what isn't replaced", () => {
    const from = { screen: "playlists", asset: "a.playlist.json", select: "clip" } as const;
    expect(resolveRoute(from, { screen: "mixer" })).toEqual({ screen: "mixer" });
    expect(resolveRoute(from, { select: "queue" })).toEqual({ screen: "playlists", asset: "a.playlist.json", select: "queue" });
    expect(resolveRoute(from, { asset: "b.playlist.json" })).toEqual({ screen: "playlists", asset: "b.playlist.json" });
    expect(resolveRoute(from, {})).toEqual(from);
  });

  it("normalises the first hash without a history entry, pushes each move, and follows Back", () => {
    const h = memoryHash("#/bogus");
    const router = createRouter(h.location);
    expect(h.current()).toBe("#/samples");
    expect(h.depth()).toBe(0);
    router.open({ screen: "mixer", select: "Music" });
    expect(h.current()).toBe("#/mixer?select=Music");
    router.open({ screen: "mixer", select: "Music" }); // nowhere new: no entry
    expect(h.depth()).toBe(1);
    h.back();
    expect(router.route.value).toEqual({ screen: "samples" });
    router.dispose();
  });
});

const ev = (key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({ screen: "samples", panels: [], singleKeys: true, typing: false, mac: false, ...over });

describe("keymap", () => {
  it("prefers the innermost panel, then the screen, then global; other screens' keys don't apply", () => {
    const k = createKeymap();
    const hits: string[] = [];
    k.register({ id: "g", keys: ["Space"], label: "Global space", scope: "global", run: () => void hits.push("g") });
    k.register({ id: "s", keys: ["Space"], label: "Play sample", scope: { screen: "samples" }, run: () => void hits.push("s") });
    k.register({ id: "m", keys: ["Space"], label: "Mixer space", scope: { screen: "mixer" }, run: () => void hits.push("m") });
    k.register({ id: "outer", keys: ["Space"], label: "Outer", scope: { panel: "timeline" }, run: () => void hits.push("outer") });
    k.register({ id: "inner", keys: ["Space"], label: "Inner", scope: { panel: "marker" }, run: () => void hits.push("inner") });
    expect(k.handle(ev(" "), ctx())).toBe(true);
    expect(k.handle(ev(" "), ctx({ screen: "take" }))).toBe(true);
    expect(k.handle(ev(" "), ctx({ panels: ["marker", "timeline"] }))).toBe(true);
    expect(k.handle(ev(" "), ctx({ screen: "mixer", panels: ["timeline"] }))).toBe(true);
    expect(hits).toEqual(["s", "g", "inner", "outer"]);
  });

  it("follows the single-key preference, never fires single keys while typing, and combos only when they say so", () => {
    const k = createKeymap();
    const run = vi.fn();
    const undo = vi.fn();
    k.register({ id: "help", keys: ["?"], label: "Shortcuts", scope: "global", run });
    k.register({ id: "screen", keys: ["Mod+3"], label: "Mixer", scope: "global", inText: true, run });
    k.register({ id: "undo", keys: ["Mod+Z"], label: "Undo", scope: "global", run: undo });
    expect(k.handle(ev("?", { shiftKey: true }), ctx({ singleKeys: false }))).toBe(false);
    expect(k.handle(ev("?", { shiftKey: true }), ctx({ typing: true }))).toBe(false);
    expect(k.handle(ev("3", { ctrlKey: true }), ctx({ typing: true }))).toBe(true);
    expect(k.handle(ev("z", { ctrlKey: true }), ctx({ typing: true }))).toBe(false); // the field keeps its own undo
    expect(k.handle(ev("z", { metaKey: true }), ctx({ mac: true }))).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
  });

  it("lets a key through when its binding has nothing to do, and unregisters", () => {
    const k = createKeymap();
    const stop = k.register({ id: "x", keys: ["F6"], label: "Next panel", scope: "global", run: () => false });
    expect(k.handle(ev("F6"), ctx())).toBe(false);
    stop();
    expect(k.resolve(ev("F6"), ctx())).toBeNull();
  });

  it("lists global, then the screen's, then panel shortcuts, marking single keys off when the preference is", () => {
    const k = createKeymap();
    k.register({ id: "p", keys: ["Delete"], label: "Delete marker", scope: { panel: "Markers" }, run() {} });
    k.register({ id: "s", keys: ["Space"], label: "Play", scope: { screen: "samples" }, run() {} });
    k.register({ id: "o", keys: ["Space"], label: "Other", scope: { screen: "mixer" }, run() {} });
    k.register({ id: "g", keys: ["Mod+1"], label: "Samples", scope: "global", run() {} });
    const list = k.list("samples", false, (id) => id.toUpperCase());
    expect(list.map((g) => g.title)).toEqual(["Everywhere", "SAMPLES", "Markers"]);
    expect(list[1].entries[0]).toEqual({ label: "Play", keys: ["Space"], off: true });
    expect(list[0].entries[0].off).toBe(false);
  });

  it("finds the panel scopes an element is in, innermost first", () => {
    const el = (scope: string | null, parent: Element | null) => ({ parentElement: parent, getAttribute: (n: string) => (n === "data-keyscope" ? scope : null) }) as unknown as Element;
    const outer = el("timeline", null);
    expect(panelScopesOf(el("marker", el(null, outer)))).toEqual(["marker", "timeline"]);
    expect(panelScopesOf(null)).toEqual([]);
  });
});

describe("start-up request", () => {
  it("opens a sample, else a project folder, else nothing", () => {
    expect(startRequest("?sample=flappy&project=C:/x")).toEqual({ kind: "sample", id: "flappy" });
    expect(startRequest("?project=C%3A%5CGames%5CRacer")).toEqual({ kind: "folder", root: "C:\\Games\\Racer" });
    expect(startRequest("?project=")).toBeNull();
    expect(startRequest("")).toBeNull();
  });
});
