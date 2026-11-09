// The asset kind module (ADR 0133, 0134, 0143): one fake contribution against one module answers
// every per-kind question; core kinds register like plugin kinds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetsForKinds } from "./assetFieldKinds";
import {
  assetKind,
  canAddToScene,
  fieldKindKnown,
  kindIcon,
  kindImportSettings,
  kindInspector,
  kindLabel,
  kindOpens,
  openAsset,
  opensInCodePanel,
  previewOf,
  satisfiesFieldKind,
  sceneNodesOf,
} from "./assetKindLookup";
import { CORE_ASSET_KINDS } from "./assetKinds.builtin";
import { SceneDocument } from "./document";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { useCoreAssetKinds } from "./testing";
import { inspectableAsset } from "./inspectorTarget";

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
    addToScene: { nodes: (doc, path) => [{ id: "spinner", components: [{ type: "engine.Transform", data: { note: path } }] }] },
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
    expect(sceneNodesOf("spin")!.nodes(new SceneDocument({ format: "myco.scene@2", nodes: [] }), "a/x.spin.json")[0].id).toBe("spinner");
    expect(kindImportSettings("spin")).toBe(spin.importSettings);
    expect(inspectableAsset("a/x.spin.json")).toBe("a/x.spin.json");
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
    expect(CORE_ASSET_KINDS.map((k) => k.id)).toEqual(["scene", "prefab", "image", "audio", "rendertexture", "json", "xml", "script", "javascript", "typescript", "text"]);
    for (const k of CORE_ASSET_KINDS) expect(assetKinds.get(k.id)).toBe(k);
    expect([kindLabel("folder"), kindLabel("sprite"), kindLabel("other")]).toEqual(["Folder", "Sprite", "File"]);
    for (const k of ["folder", "sprite", "other"]) expect(kindIcon(k)).toMatch(/^M/);
  });

  it("a slice opens and adds as its image does", () => {
    expect(kindOpens("images/sheet.png#walk_0")).toBe(true);
    expect(canAddToScene("images/sheet.png#walk_0")).toBe(true);
    expect(kindOpens("sounds/hit.wav")).toBe(false);
  });

  it("code kinds open in the Code panel", async () => {
    const codeState = await import("./code/codeState");
    const open = vi.spyOn(codeState, "openScript").mockImplementation(() => {});
    try {
      expect(openAsset("tools/build.mjs")).toBe(true);
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith("tools/build.mjs"));
    } finally {
      open.mockRestore();
    }
  });
});
