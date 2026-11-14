// Booting the editor's plugins (ADR 0134) keeps the saved layout's plugin panels, even though plugin
// modules load the layout store before they are activated.
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "myco.editor.layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("editorBoot", () => {
  it("restores a saved layout's Shader Graph and Sky tabs", async () => {
    const { activatePanel, defaultLayout, instancesOf, movePanel } = await import("../editor/layout/model");
    const { applyEditorPlugins, pluginManifests } = await import("./editorPlugins");
    applyEditorPlugins(undefined);
    const start = defaultLayout();
    const [shaderGraph] = instancesOf(start, "shadergraph");
    const [hierarchy] = instancesOf(start, "hierarchy");
    const saved = JSON.stringify(activatePanel(movePanel(start, shaderGraph!, { kind: "tab", group: "hierarchy" }), "sky"));
    applyEditorPlugins(pluginManifests().map((m) => m.name)); // every plugin off again
    vi.resetModules();

    const storage = new Map([[KEY, saved]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
    await import("./editorBoot");
    const { layout } = await import("../editor/layout/store");
    const { openTypes } = await import("../editor/layout/model");
    const panels = openTypes(layout.value);
    expect(panels).toContain("shadergraph");
    expect(panels).toContain("sky");
    expect(layout.value.docks.flatMap((d) => d.groups).find((g) => g.panels.includes(hierarchy!))!.panels).toEqual([hierarchy, shaderGraph]);
    expect(layout.value.panelInfo.shadergraph?.title).toBe("Shader Graph");
    expect(JSON.parse(storage.get(KEY)!)).toEqual(layout.value); // and remembered as it is
  });
});
