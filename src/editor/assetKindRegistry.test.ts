// The asset kind module (ADR 0133, 0134, 0143): one fake contribution against one module answers
// every per-kind question; core kinds register like plugin kinds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsForKinds } from "./assetFieldKinds";
import {
  assetKind,
  canAddToScene,
  sceneNodesAt,
  fieldKindKnown,
  kindIcon,
  kindImportSettings,
  kindInspector,
  kindLabel,
  kindOpens,
  opensInCodePanel,
  previewOf,
  satisfiesFieldKind,
} from "./assetKindLookup";
import { openAsset } from "./assetKindHost";
import { inspectorTarget, selectAssets } from "./inspectorTarget";
import { SceneDocument } from "./document";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const undo: (() => void)[] = [];
const register = (k: AssetKindContribution) => undo.push(assetKinds.register(k));
afterEach(() => undo.splice(0).forEach((u) => u()));

describe("one kind through the asset kind module", () => {
  const opened: string[] = [];
  const spin: AssetKindContribution = {
    id: "spin",
    extensions: [".spin.json"],
    label: "Spinner",
    icon: "M0 0",
    open: (path) => opened.push(path),
    referencedAs: ["spin"],
    preview: "material",
    addToScene: { nodes: (path) => [{ name: "Spinner", components: [{ type: "engine.Transform", data: { note: path } }] }] },
    importSettings: { view: async () => () => null },
  };

  it("answers kind, label, icon, open, scene nodes, import settings, preview and field kinds", () => {
    expect(assetKind("a/x.spin.json")).toBe("json"); // not registered yet: a generic file
    expect(satisfiesFieldKind("spin", "a/x.spin.json")).toBe(false);
    register(spin);
    expect(assetKind("a/X.SPIN.JSON")).toBe("spin");
    expect(kindLabel("spin")).toBe("Spinner");
    expect(kindIcon("spin")).toBe("M0 0");
    expect(kindOpens("a/x.spin.json")).toBe(true);
    expect(openAsset("a/x.spin.json")).toBe(true);
    expect(opened).toEqual(["a/x.spin.json"]);
    expect(opensInCodePanel("spin")).toBe(false);
    expect(canAddToScene("a/x.spin.json")).toBe(true);
    expect(sceneNodesAt("a/x.spin.json")!.nodes("a/x.spin.json")[0]!.name).toBe("Spinner");
    expect(kindImportSettings("spin")).toBe(spin.importSettings);
    expect(inspectedFor("a/x.spin.json")).toBe("a/x.spin.json");
    expect(previewOf("a/x.spin.json")).toBe("material");
    expect(previewOf("a/x.spin.json.meta.json")).toBeNull();
    expect(satisfiesFieldKind("spin", "a/x.spin.json")).toBe(true);
    expect(fieldKindKnown("spin")).toBe(true);
    expect(assetsForKinds(["spin"], ["a/x.spin.json", "b/y.json"])).toEqual(["a/x.spin.json"]);
  });

  it("unregistering puts the file back to a generic one", () => {
    register(spin);
    undo.splice(0).forEach((u) => u());
    expect(assetKind("a/x.spin.json")).toBe("json");
    expect(kindLabel("spin")).toBe("spin");
    expect(previewOf("a/x.spin.json")).toBeNull();
    expect(fieldKindKnown("spin")).toBe(false);
  });

  it("an inspector wins over import settings", () => {
    register({ ...spin, inspector: async () => () => null });
    expect(kindInspector("spin")).toBeDefined();
    expect(kindImportSettings("spin")).toBeUndefined();
  });
});

describe("matching paths", () => {
  it("takes the longest extension over every kind, whatever the registration order", () => {
    expect(assetKind("a/b.special.png")).toBe("image");
    register({ id: "special", extensions: [".special.png"], label: "Special", icon: "M0 0" });
    expect(assetKind("a/b.special.png")).toBe("special");
    expect(assetKind("a/b.png")).toBe("image");
    expect(assetKind("a/b.special.png#slice")).toBe("other");
    expect(assetKind("a/b.png#slice")).toBe("sprite");
  });

  it("gives a tie to the later registration", () => {
    register({ id: "data", extensions: [".json"], label: "Data", icon: "M0 0" });
    expect(assetKind("a/b.json")).toBe("data");
    expect(assetKind("a/b.scene.json")).toBe("scene");
  });

  it("answers dotfiles, declaration files and unknown endings as other", () => {
    expect(assetKind(".json")).toBe("other");
    expect(assetKind("types/game.d.ts")).toBe("other");
    expect(assetKind("scripts/game.ts")).toBe("script");
    expect(assetKind("lib/x.mts")).toBe("typescript");
    expect(assetKind("a/b.bin")).toBe("other");
  });
});

describe("core kinds", () => {
  it("register like plugin kinds, and the module answers folder, sprite and other itself", () => {
    expect(assetKinds.list().map((k) => k.id)).toEqual(["scene", "prefab", "image", "audio", "rendertexture", "strings", "inputContext", "actionSet", "json", "xml", "script", "javascript", "typescript", "text"]);
    expect([kindLabel("folder"), kindLabel("sprite"), kindLabel("other")]).toEqual(["Folder", "Sprite", "File"]);
    for (const k of ["folder", "sprite", "other"]) expect(kindIcon(k)).toMatch(/^M/);
  });

  it("a slice opens and adds as its image does", () => {
    expect(kindOpens("images/sheet.png#walk_0")).toBe(true);
    expect(canAddToScene("images/sheet.png#walk_0")).toBe(true);
    expect(kindOpens("sounds/hit.wav")).toBe(false);
  });

  it("code kinds open in the Code panel", async () => {
    const codeBuffers = await import("./code/codeBuffers");
    const open = vi.spyOn(codeBuffers, "openScript").mockImplementation(() => {});
    try {
      expect(openAsset("tools/build.mjs")).toBe(true);
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith("tools/build.mjs"));
    } finally {
      open.mockRestore();
    }
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
