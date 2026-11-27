// ADR 0140: the editor halves of Meshes and models, Environment, Post-processing and UI own the asset
// kinds that were built into the editor's tables; disabling a plugin turns its files back into generic ones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assetKind, canAddToScene, opensInCodePanel } from "../editor/assetBrowser";
import { kindIcon, kindLabel, registeredKind, satisfiesFieldKind } from "../editor/assetKindLookup";
import { inspectorTarget, selectAssets } from "../editor/inspectorTarget";
import { activatePlugins, deactivatePlugin, isPluginActive } from "../editor/sdk/plugins";
import { previewKind } from "../editor/thumbnails/keys";
import { EDITOR_PLUGINS } from "./editor";
import { environmentEditorPlugin } from "./environment/editor";
import { meshesEditorPlugin } from "./meshes/editor";
import { postProcessingEditorPlugin } from "./post-processing/editor";
import { uiEditorPlugin } from "./ui/editor";
import { useCoreAssetKinds } from "../editor/testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const PLUGINS = [meshesEditorPlugin, environmentEditorPlugin, postProcessingEditorPlugin, uiEditorPlugin];
beforeAll(() => activatePlugins(PLUGINS));
afterAll(() => PLUGINS.forEach((p) => deactivatePlugin(p.manifest.name)));

describe("the render plugins' asset kinds (ADR 0140)", () => {
  it("are first-party editor plugins", () => {
    for (const p of PLUGINS) expect(EDITOR_PLUGINS).toContain(p);
  });

  it("detect, label and give icons to their files", () => {
    const cases: [string, string, string][] = [
      ["models/ship.glb", "model", "Model"],
      ["models/ship.GLTF", "model", "Model"],
      ["models/crate.obj", "model", "Model"],
      ["models/hero.fbx", "model", "Model"],
      ["env/studio.hdr", "environment", "Environment"],
      ["env/studio.exr", "environment", "Environment"],
      ["env/room.env", "environment", "Environment"],
      ["env/room.DDS", "environment", "Environment"],
      ["skies/box.cubemap.json", "cubemap", "Cubemap"],
      ["grading/warm.cube", "lut", "Colour LUT"],
      ["grade/warm.CUBE", "lut", "Colour LUT"],
      ["ui/Menu.svelte", "svelte", "Svelte Component"],
      ["ui/theme.css", "stylesheet", "Stylesheet"],
    ];
    for (const [path, kind, label] of cases) {
      expect(assetKind(path), path).toBe(kind);
      expect(kindLabel(kind)).toBe(label);
      expect(kindIcon(kind)).toMatch(/^M/);
    }
    // A dotfile isn't an asset of the kind its name ends with.
    expect(assetKind(".env")).toBe("other");
    expect(assetKind("config/.env")).toBe("other");
  });

  it("keep their policies: previews, the Code panel, the Inspector, fields, adding to scenes", () => {
    expect(previewKind("models/ship.glb")).toBe("model");
    expect(previewKind("env/studio.hdr")).toBe("environment");
    expect(previewKind("skies/box.cubemap.json")).toBe("environment");
    expect(opensInCodePanel("svelte")).toBe(true);
    expect(opensInCodePanel("stylesheet")).toBe(true);
    for (const k of ["model", "environment", "cubemap", "lut"]) expect(opensInCodePanel(k), k).toBe(false);
    expect(inspectedFor("env/studio.hdr")).toBe("env/studio.hdr");
    expect(inspectedFor("skies/box.cubemap.json")).toBe("skies/box.cubemap.json");
    expect(registeredKind("model")?.inspector).toBeUndefined(); // the shell's import Inspector (ADR 0040) shows models
    expect(registeredKind("model")?.importSettings).toBeDefined(); // with the Meshes plugin's rows (ADR 0143)
    expect(inspectedFor("models/ship.glb")).toBe("models/ship.glb");
    expect(satisfiesFieldKind("mesh", "models/ship.glb")).toBe(true);
    expect(satisfiesFieldKind("model", "models/ship.glb")).toBe(true);
    expect(satisfiesFieldKind("environment", "env/studio.hdr")).toBe(true);
    expect(satisfiesFieldKind("environment", "skies/box.cubemap.json")).toBe(true);
    expect(satisfiesFieldKind("environment", "panoramas/sunset.jpg")).toBe(true);
    expect(satisfiesFieldKind("envmap", "env/room.env")).toBe(true);
    expect(satisfiesFieldKind("envmap", "env/studio.hdr")).toBe(false);
    expect(satisfiesFieldKind("lut", "grading/warm.cube")).toBe(true);
    expect(satisfiesFieldKind("svelte", "ui/Menu.svelte")).toBe(true);
    expect(satisfiesFieldKind("svelte", "ui/theme.css")).toBe(false);
    expect(canAddToScene("models/ship.glb")).toBe(true);
    for (const p of ["env/studio.hdr", "grading/warm.cube", "ui/Menu.svelte"]) expect(canAddToScene(p), p).toBe(false);
  });

  it("go when their plugin is disabled: the files show as generic ones", () => {
    try {
      for (const p of PLUGINS) deactivatePlugin(p.manifest.name);
      for (const p of PLUGINS) expect(isPluginActive(p.manifest.name)).toBe(false);
      expect(assetKind("models/ship.glb")).toBe("other");
      expect(assetKind("env/studio.hdr")).toBe("other");
      expect(assetKind("skies/box.cubemap.json")).toBe("json");
      expect(assetKind("grading/warm.cube")).toBe("other");
      expect(assetKind("ui/theme.css")).toBe("other");
      expect(canAddToScene("models/ship.glb")).toBe(false);
      expect(previewKind("models/ship.glb")).toBeNull();
      expect(satisfiesFieldKind("mesh", "models/ship.glb")).toBe(false);
    } finally {
      activatePlugins(PLUGINS);
    }
    expect(assetKind("models/ship.glb")).toBe("model");
  });
});

/** The file the Inspector shows with `entry` alone selected in the Assets panel (null: none). */
function inspectedFor(entry: string): string | null {
  selectAssets([entry]);
  const target = inspectorTarget.peek();
  const shown = target.kind === "asset" ? target.path : null;
  selectAssets([]);
  return shown;
}
