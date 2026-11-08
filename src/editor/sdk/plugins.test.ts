import { afterEach, describe, expect, it } from "vitest";
import { assetKinds, panels } from "./contributions";
import { activatePlugins, deactivatePlugin, isPluginActive, orderPlugins, type EditorPlugin, type PluginManifest } from "./plugins";

const view = async () => () => null;
const plugin = (name: string, deps: string[] = [], activate: EditorPlugin["activate"] = () => {}): EditorPlugin => ({
  manifest: { name, version: "1", dependencies: Object.fromEntries(deps.map((d) => [d, "1"])) } satisfies PluginManifest,
  activate,
});

const names = ["t.a", "t.b", "t.c"];
afterEach(() => names.forEach(deactivatePlugin));

describe("orderPlugins", () => {
  it("puts dependencies first", () => {
    const a = plugin("t.a");
    const b = plugin("t.b", ["t.a"]);
    const c = plugin("t.c", ["t.b"]);
    expect(orderPlugins([c, b, a]).map((p) => p.manifest.name)).toEqual(["t.a", "t.b", "t.c"]);
  });
  it("throws on a missing dependency", () => {
    expect(() => orderPlugins([plugin("t.b", ["t.a"])])).toThrow(/t\.b needs t\.a/);
  });
  it("throws on a cycle", () => {
    expect(() => orderPlugins([plugin("t.a", ["t.b"]), plugin("t.b", ["t.a"])])).toThrow(/cycle/);
  });
});

describe("activatePlugins", () => {
  const full = plugin("t.a", [], (ctx) => {
    ctx.registerPanel({ id: "t.panel", title: "T", view });
    ctx.registerAssetKind({ id: "t.kind", extensions: [".t.json"], label: "T", icon: "" });
  });

  it("registers through the context and deactivatePlugin removes everything", () => {
    activatePlugins([full]);
    expect(isPluginActive("t.a")).toBe(true);
    expect(panels.get("t.panel")).toBeDefined();
    expect(assetKinds.get("t.kind")).toBeDefined();
    deactivatePlugin("t.a");
    expect(isPluginActive("t.a")).toBe(false);
    expect(panels.get("t.panel")).toBeUndefined();
    expect(assetKinds.get("t.kind")).toBeUndefined();
  });

  it("rolls back partial registrations when activation fails", () => {
    const bad = plugin("t.b", [], (ctx) => {
      ctx.registerPanel({ id: "t.half", title: "H", view });
      throw new Error("boom");
    });
    expect(() => activatePlugins([bad])).toThrow("boom");
    expect(panels.get("t.half")).toBeUndefined();
    expect(isPluginActive("t.b")).toBe(false);
  });

  it("is a no-op when already active", () => {
    let calls = 0;
    const p = plugin("t.c", [], (ctx) => {
      calls++;
      ctx.registerPanel({ id: "t.once", title: "O", view });
    });
    activatePlugins([p]);
    expect(() => activatePlugins([p])).not.toThrow();
    expect(calls).toBe(1);
    expect(panels.get("t.once")).toBeDefined();
  });
});
