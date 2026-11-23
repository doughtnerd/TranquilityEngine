import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panelCatalog } from "./catalog";
import { instanceValue } from "./instanceState";
import { createLayoutStore } from "./layoutStore";
import { closePanel, defaultLayout, instancesOf, openTypes, type Layout } from "./model";

/** Browser storage as a map, standing in for `localStorage` (the store reads the global, as in the browser). */
let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
    removeItem: (k: string) => void saved.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const catalog = panelCatalog([
  { id: "list", title: "List", dock: "left" },
  { id: "main", title: "Main", dock: "fill", closable: false },
  { id: "props", title: "Properties", dock: "right" },
  { id: "extra", title: "Extra", onDemand: true },
]);
const store = (key = "test.layout", extra: Partial<Parameters<typeof createLayoutStore>[0]> = {}) => createLayoutStore({ key, catalog: () => catalog, ...extra });

describe("createLayoutStore", () => {
  it("starts from the host's default layout when nothing is saved, and writes nothing until it changes", () => {
    const s = store();
    expect(openTypes(s.layout.value)).toEqual(["list", "props", "main"]);
    expect(saved.has("test.layout")).toBe(false);
    s.show("extra");
    expect(JSON.parse(saved.get("test.layout")!).instances).toEqual(s.layout.value.instances);
  });

  it("uses the host's own defaults when given", () => {
    const only: Layout = defaultLayout(panelCatalog([{ id: "main", title: "Main", dock: "fill" }]));
    const s = store("other", { defaults: () => only });
    expect(openTypes(s.layout.value)).toEqual(["main"]);
  });

  it("reads the layout saved under its key, then a legacy key, and keeps hosts apart", () => {
    const a = store("a.layout");
    a.layout.value = closePanel(a.layout.value, instancesOf(a.layout.value, "props")[0]!, catalog);
    const again = store("a.layout");
    expect(openTypes(again.layout.value)).toEqual(["list", "main"]);
    expect(openTypes(store("b.layout").layout.value)).toEqual(["list", "props", "main"]);
    saved.set("old.layout", saved.get("a.layout")!);
    expect(openTypes(store("new.layout", { legacyKeys: ["old.layout"] }).layout.value)).toEqual(["list", "main"]);
  });

  it("falls back to the default for an unreadable saved layout", () => {
    saved.set("bad.layout", "{not json");
    expect(openTypes(store("bad.layout").layout.value)).toEqual(["list", "props", "main"]);
  });

  it("adds, shows and resets", () => {
    const s = store();
    s.add(["extra"]);
    expect(openTypes(s.layout.value)).toContain("extra");
    s.reset();
    expect(openTypes(s.layout.value)).not.toContain("extra");
  });

  it("forgets the view state of its own instances that leave it, not another store's", () => {
    const a = store("a");
    const b = store("b");
    const aList = instancesOf(a.layout.value, "list")[0]!;
    const bList = instancesOf(b.layout.value, "list")[0]!;
    instanceValue(aList, "x", () => ({ n: 1 })).n = 2;
    instanceValue(bList, "x", () => ({ n: 1 })).n = 3;
    a.layout.value = closePanel(a.layout.value, aList, catalog);
    expect(instanceValue(aList, "x", () => ({ n: 1 })).n).toBe(1); // dropped, so made afresh
    expect(instanceValue(bList, "x", () => ({ n: 1 })).n).toBe(3); // kept
  });
});
