// Opening a project applies its plugins (ADR 0133, 0144) without touching the panel layout the session
// has made: only the editor's boot reads the saved layout from storage.
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "myco.editor.layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Boot the editor as `main.tsx` does, over a stored layout (the default when `saved` is null). */
async function boot(saved: string | null = null) {
  const storage = new Map<string, string>(saved ? [[KEY, saved]] : []);
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  await import("../editor/corePanels");
  await import("./editorBoot");
  const model = await import("../editor/layout/model");
  const { layout } = await import("../editor/layout/store");
  const { registeredPanels } = await import("../editor/layout/registeredPanels");
  const plugins = await import("./editorPlugins");
  return { storage, model, layout, registeredPanels, plugins };
}

describe("applyProjectPlugins", () => {
  it("keeps panels moved during the session when a project opens", async () => {
    const { model, layout, plugins } = await boot();
    const [shaderGraph] = model.instancesOf(layout.value, "shadergraph");
    const [hierarchy] = model.instancesOf(layout.value, "hierarchy");
    layout.value = model.movePanel(layout.value, shaderGraph!, { kind: "tab", group: "hierarchy" });
    const moved = JSON.stringify(layout.value.docks);

    plugins.applyProjectPlugins(undefined);
    expect(JSON.stringify(layout.value.docks)).toBe(moved);
    expect(layout.value.docks.flatMap((d) => d.groups).find((g) => g.panels.includes(hierarchy!))!.panels).toEqual([hierarchy, shaderGraph]);
  });

  it("keeps a project's disabled plugin's panel in place and shows it again when another project enables it", async () => {
    const { model, layout, plugins, registeredPanels } = await boot();
    const { FIRST_PARTY_MANIFESTS } = await import("./catalogue");
    const owner = FIRST_PARTY_MANIFESTS.find((m) => m.name === registeredPanels().get("shadergraph")?.owner?.plugin)!;
    const before = model.instancesOf(layout.value, "shadergraph");
    expect(before).toHaveLength(1);

    plugins.applyProjectPlugins([owner.name]); // a project with the Shader Graph plugin off
    expect(registeredPanels().has("shadergraph")).toBe(false);
    expect(model.instancesOf(layout.value, "shadergraph")).toEqual(before); // kept for when it's on again

    plugins.applyProjectPlugins(undefined); // a project with it on
    expect(registeredPanels().has("shadergraph")).toBe(true);
    expect(model.instancesOf(layout.value, "shadergraph")).toEqual(before);
    expect(layout.value.panelInfo.shadergraph?.title).toBe("Shader Graph");
  });

  it("leaves a saved layout applied during the session unmodified", async () => {
    const { model, layout, plugins, registeredPanels } = await boot();
    const saved = await import("../editor/layout/saved");
    const savedStore = await import("../editor/layout/savedStore");
    // The working layout becomes a saved layout's (as applying one from the Layout menu does)...
    const [inspector] = model.instancesOf(layout.value, "inspector");
    layout.value = model.closePanel(layout.value, inspector!, registeredPanels());
    const file = saved.newLayoutFile("Compact", layout.value);
    expect(saved.matchesHead(file, layout.value, registeredPanels())).toBe(true);

    plugins.applyProjectPlugins(undefined);
    expect(saved.matchesHead(file, layout.value, registeredPanels())).toBe(true); // not reverted to the boot layout
    expect(savedStore.layoutModified.value).toBe(false);
  });
});
