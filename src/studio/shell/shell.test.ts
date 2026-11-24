// The Studio shell's rules: the seven screens, the router and its hash, the keymap's scopes and preferences.
import { describe, expect, it, vi } from "vitest";
import type { KeyEventLike } from "../../editor/ui/keyCombo";
import { startRequest } from "../boot/startQuery";
import { studioUrl } from "../../editor/studioAssets";
import { createKeymap, panelScopesOf, type KeyContext } from "./keymap";
import { createRouter, formatRoute, parseRoute, resolveRoute, type HashLocation } from "./route";
import { SCREENS, screenGroups } from "./screens";
import { screenDock } from "./studioPanels";
import { outputChoices, outputName } from "./outputDevice";
import { SCREEN_ARRANGEMENTS } from "./screenDocks";
import { SCREEN_PANELS } from "../screens";
import { canClosePanel } from "../../editor/layout/catalog";
import { closePanel, instancesOf, openTypes } from "../../editor/layout/model";

describe("screens", () => {
  it("are eight in four groups; Dialogue (ADR 0354 §9) authors on Ctrl/⌘+8, the next free digit after Packages", () => {
    expect(screenGroups().map((g) => [g.title, g.screens.map((s) => s.title)])).toEqual([
      ["Author", ["Samples", "Playlists", "Dialogue"]],
      ["Mix", ["Mixer", "Spatial"]],
      ["Run", ["Take", "Profiler"]],
      ["Ship", ["Packages"]],
    ]);
    expect(SCREENS.map((s) => [s.id, s.digit])).toEqual([["samples", 1], ["playlists", 2], ["dialogue", 8], ["mixer", 3], ["spatial", 4], ["take", 5], ["profiler", 6], ["packages", 7]]);
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
    const route = { screen: "take", asset: "takes/run 1.sporesample", select: "i7" } as const;
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("reads the editor's hand-off hash (#/<screen>/<asset path>, studioHash)", () => {
    const request = { project: "/games/racer", asset: "music/boss fight.playlist.json" };
    const hash = studioUrl(request).slice(studioUrl(request).indexOf("#"));
    expect(parseRoute(hash)).toEqual({ screen: "playlists", asset: "music/boss fight.playlist.json" });
    expect(parseRoute("#/mixer")).toEqual({ screen: "mixer" });
    expect(parseRoute("#/profiler/captures/a.sporesample?asset=captures/b.sporesample")).toEqual({ screen: "profiler", asset: "captures/b.sporesample" });
    expect(parseRoute("#/nonsense/x.wav")).toEqual({ screen: "samples" });
    expect(parseRoute("#/samples/bad%E0.wav")).toEqual({ screen: "samples" }); // a malformed escape: the screen alone
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

describe("output device name", () => {
  it("names the system output from the browser's list where it has labels", () => {
    expect(outputName([{ kind: "audioinput", deviceId: "default", label: "Mic" }, { kind: "audiooutput", deviceId: "default", label: "Default - Speakers (Realtek)" }])).toBe("System output · Speakers (Realtek)");
    expect(outputName([{ kind: "audiooutput", deviceId: "default", label: "" }])).toBe("System output");
    expect(outputName([])).toBe("System output");
  });
});

describe("output device list", () => {
  it("lists the system output first (the one playing), then the other named outputs, without the aliases", () => {
    const list = outputChoices([
      { kind: "audiooutput", deviceId: "default", label: "Default - Speakers (Realtek)" },
      { kind: "audiooutput", deviceId: "communications", label: "Communications - Headset" },
      { kind: "audiooutput", deviceId: "abc", label: "Speakers (Realtek)" },
      { kind: "audiooutput", deviceId: "hdmi", label: "TV · HDMI" },
      { kind: "audioinput", deviceId: "mic", label: "Mic" },
    ]);
    expect(list.map((d) => [d.name, d.current])).toEqual([["System output · Speakers (Realtek)", true], ["TV · HDMI", false]]);
    expect(outputChoices([])).toEqual([{ id: "default", name: "System output", current: true }]);
  });
});

describe("screen docks", () => {
  // The browser storage layouts are remembered in, in memory.
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) });

  /** The panel types of each group of a layout's side dock, in order. */
  const groupsOf = (dock: ReturnType<typeof screenDock>, side: "left" | "right" | "bottom") => {
    const layout = dock.store.layout.value;
    return layout.docks.find((d) => d.side === side && d.groups.every((g) => !g.panels.some((id) => SCREEN_PANELS[dock.screen].find((p) => p.id === layout.instances[id].type)?.fixed)))?.groups.map((g) => g.panels.map((id) => layout.instances[id].type));
  };

  it("start each screen in the prototype's arrangement: side panels stacked, the bottom dock under the middle (G70)", () => {
    const expected: Record<string, Record<string, string[][]>> = {
      samples: { left: [["samples-library"], ["samples-outline"]], right: [["samples-inspector"]], bottom: [["samples-edits"], ["samples-seam"]] },
      playlists: { left: [["playlists-library"], ["playlists-samples"]], right: [["playlists-inspector"], ["playlists-voices", "playlists-voice-log"]] },
      spatial: { left: [["spatial-scenes"], ["spatial-outline"]], right: [["spatial-inspector"], ["spatial-settings"]], bottom: [["spatial-voices"]] },
      take: { left: [["take-list"], ["take-playlists"]], right: [["take-inspector"]], bottom: [["take-mixer"]] },
      profiler: { left: [["profiler-captures"]], right: [["profiler-cursor"], ["profiler-voice"]], bottom: [["profiler-messages"], ["profiler-why", "profiler-plugins"]] },
    };
    for (const [screen, sides] of Object.entries(expected)) {
      localStorage.removeItem(`myco.studio.layout.${screen}`);
      const dock = screenDock(screen as never, SCREEN_PANELS[screen as keyof typeof SCREEN_PANELS], SCREEN_ARRANGEMENTS[screen as keyof typeof SCREEN_ARRANGEMENTS]);
      for (const [side, groups] of Object.entries(sides)) expect(groupsOf(dock, side as "left"), `${screen} ${side}`).toEqual(groups);
      // The side docks are outermost (full height); the bottom dock sits between them, over the filling dock.
      expect(dock.store.layout.value.docks.map((d) => d.id).filter((id) => id !== "main")).toEqual(Object.keys(sides).sort((a, b) => ["left", "right", "bottom"].indexOf(a) - ["left", "right", "bottom"].indexOf(b)));
    }
    localStorage.removeItem("myco.studio.layout.mixer");
    const mixer = screenDock("mixer", SCREEN_PANELS.mixer, SCREEN_ARRANGEMENTS.mixer);
    expect(groupsOf(mixer, "left")).toEqual([["mixer-snapshots"], ["mixer-gain"]]);
    expect(groupsOf(mixer, "right")![0]).toEqual(["mixer-inspector"]);
    expect(groupsOf(mixer, "right")![1][0]).toBe("mixer-parameters");
  });

  it("name only panels the screens have, and still open every panel that isn't on demand", () => {
    for (const [screen, arrangement] of Object.entries(SCREEN_ARRANGEMENTS)) {
      const ids = new Set(SCREEN_PANELS[screen as keyof typeof SCREEN_PANELS].map((p) => p.id));
      for (const side of Object.values(arrangement!)) for (const g of side!.groups) for (const id of g) expect(ids.has(id), `${screen}: ${id}`).toBe(true);
      localStorage.removeItem(`myco.studio.layout.${screen}`);
      const dock = screenDock(screen as never, SCREEN_PANELS[screen as keyof typeof SCREEN_PANELS], arrangement);
      expect(openTypes(dock.store.layout.value).sort()).toEqual(SCREEN_PANELS[screen as keyof typeof SCREEN_PANELS].filter((p) => !p.onDemand).map((p) => p.id).sort());
    }
  });

  it("keep a layout the user saved before; Reset layout gives the arrangement", () => {
    localStorage.removeItem("myco.studio.layout.samples");
    const old = screenDock("samples", SCREEN_PANELS.samples); // the plain default: Samples and Outline as tabs of one group
    old.store.layout.value = { ...old.store.layout.value }; // remembered
    expect(groupsOf(old, "left")).toEqual([["samples-library", "samples-outline"]]);
    const dock = screenDock("samples", SCREEN_PANELS.samples, SCREEN_ARRANGEMENTS.samples);
    expect(groupsOf(dock, "left")).toEqual([["samples-library", "samples-outline"]]);
    dock.host.reset!();
    expect(groupsOf(dock, "left")).toEqual([["samples-library"], ["samples-outline"]]);
    localStorage.removeItem("myco.studio.layout.samples");
  });

  it("give every screen one fixed panel filling the middle, its own layout key, and the rest in their docks", () => {
    for (const s of SCREENS) {
      const dock = screenDock(s.id, SCREEN_PANELS[s.id]);
      expect(dock.store.key).toBe(`myco.studio.layout.${s.id}`);
      const fixed = SCREEN_PANELS[s.id].filter((p) => p.fixed);
      expect(fixed).toHaveLength(1);
      expect(canClosePanel(dock.catalog, fixed[0].id)).toBe(false);
      const layout = dock.store.layout.value;
      expect(layout.docks.at(-1)!.groups[0].panels.map((id) => layout.instances[id].type)).toEqual([fixed[0].id]); // the filling dock
      expect(openTypes(layout).sort()).toEqual(SCREEN_PANELS[s.id].filter((p) => !p.onDemand).map((p) => p.id).sort());
      const side = SCREEN_PANELS[s.id].find((p) => !p.fixed && !p.onDemand)!;
      dock.store.layout.value = closePanel(layout, instancesOf(layout, side.id)[0]!, dock.catalog);
      expect(openTypes(dock.store.layout.value)).not.toContain(side.id);
      dock.host.reset!();
      expect(openTypes(dock.store.layout.value)).toContain(side.id);
    }
  });

  it("refuse a screen without exactly one fixed panel", () => {
    expect(() => screenDock("mixer", [{ id: "a", title: "A", dock: "left", view: () => null }])).toThrow(/exactly one fixed panel/);
  });
});
