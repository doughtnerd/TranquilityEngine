import { afterEach, describe, expect, it } from "vitest";
import { assetKinds, componentHeaderActions, componentNotes, panels, projectSettingsSections, viewportTools } from "./contributions";
import { createRegistry } from "./registry";
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

describe("a registry's owners (ADR 0284)", () => {
  const sky = { plugin: "t.sky", pluginTitle: "Sky" };
  it("records the plugin with each entry, keeps it once the entry is removed, and forgets it for an entry the editor registers", () => {
    const r = createRegistry<{ id: string }>("Thing");
    const off = r.register({ id: "a" }, sky);
    r.register({ id: "b" });
    expect(r.ownerOf("a")).toEqual(sky);
    expect(r.ownerOf("b")).toBeUndefined();
    expect(r.idsOf("t.sky")).toEqual(["a"]);
    off();
    expect(r.get("a")).toBeUndefined();
    expect(r.ownerOf("a")).toEqual(sky); // a saved layout can still name the plugin to turn back on
    expect(r.idsOf("t.sky")).toEqual(["a"]);
    r.register({ id: "a" });
    expect(r.ownerOf("a")).toBeUndefined();
    expect(r.idsOf("t.sky")).toEqual([]);
  });
  it("records nothing for a taken id", () => {
    const r = createRegistry<{ id: string }>("Thing");
    r.register({ id: "a" });
    expect(() => r.register({ id: "a" }, sky)).toThrow('Thing "a" is already registered.');
    expect(r.ownerOf("a")).toBeUndefined();
  });
});

describe("the plugin context, made from the table of contribution points (ADR 0284)", () => {
  const owner = { plugin: "t.a", pluginTitle: "Tee" };
  it("records the plugin with every entry it registers, the viewport tool's Edit toggle included", () => {
    activatePlugins([
      {
        manifest: { name: "t.a", title: "Tee", version: "1" },
        activate(ctx) {
          ctx.registerPanel({ id: "t.panel", title: "T", view });
          ctx.registerComponentNote({ id: "t.note", note: () => null });
          ctx.registerViewportTool({ id: "t.tool", editsComponents: { types: ["t.Box"], label: "Edit", hint: () => "", stopHint: "" }, install: () => {} });
        },
      },
    ]);
    expect(panels.ownerOf("t.panel")).toEqual(owner);
    expect(componentNotes.ownerOf("t.note")).toEqual(owner);
    expect(viewportTools.ownerOf("t.tool")).toEqual(owner);
    expect(componentHeaderActions.ownerOf("t.tool:edit")).toEqual(owner);
    deactivatePlugin("t.a");
    expect(componentHeaderActions.get("t.tool:edit")).toBeUndefined();
    expect(panels.idsOf("t.a")).toEqual(["t.panel"]);
  });
  it("names a plugin without a title by its name", () => {
    activatePlugins([plugin("t.b", [], (ctx) => ctx.registerPanel({ id: "t.untitled", title: "U", view }))]);
    expect(panels.ownerOf("t.untitled")).toEqual({ plugin: "t.b", pluginTitle: "t.b" });
  });
  it("vets a settings section's keys before registering it", () => {
    const bad = plugin("t.c", [], (ctx) => ctx.registerProjectSettingsSection({ id: "t.bad", title: "Bad", keys: ["bootstrap"], view: async () => () => null }));
    expect(() => activatePlugins([bad])).toThrow(/can't own "bootstrap"/);
    expect(projectSettingsSections.get("t.bad")).toBeUndefined();
    expect(isPluginActive("t.c")).toBe(false);
  });
});
