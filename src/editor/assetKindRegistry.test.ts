// Asset kinds (ADR 0133/0134): every kind, core or a plugin's, is one `AssetKindContribution`, and
// every lookup (kind of a path, label, icon, opening, Inspector, field kinds, previews, adding to a
// scene, import settings) asks it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materialsEditorPlugin } from "../plugins/materials/editor";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { canAddToScene } from "./assetBrowser";
import { assetsForKinds } from "./assetFieldKinds";
import { inspectableAsset, importKind } from "./assetImport";
import { assetKind, assetKindFor, assetKindInfo, CORE_ASSET_KINDS, opensInCodePanel } from "./assetKinds";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { previewKind } from "./thumbnails/keys";

const fake: AssetKindContribution = {
  id: "fakekind",
  extensions: [".fake.json"],
  label: "Fake",
  icon: "M0 0",
  open() {},
  create: { label: "New Fake", create: async () => null },
  inspector: async () => () => null,
  referencedAs: ["environment"],
  preview: "material",
};
const undo: (() => void)[] = [];
const register = (k: AssetKindContribution) => undo.push(assetKinds.register(k));
// Materials (the "material" field kind's files) are the Materials plugin's (ADR 0134).
beforeEach(() => activatePlugins([materialsEditorPlugin]));
afterEach(() => {
  undo.splice(0).forEach((u) => u());
  deactivatePlugin(materialsEditorPlugin.manifest.name);
});

describe("core asset kinds", () => {
  it("are all registered (the Vitest setup registers them, as editor boot does)", () => {
    const ids = ["scene", "prefab", "image", "sprite", "audio", "rendertexture", "json", "script", "javascript", "typescript", "text", "xml", "other"];
    expect(CORE_ASSET_KINDS.map((k) => k.id).sort()).toEqual([...ids].sort());
    for (const kind of CORE_ASSET_KINDS) {
      expect(assetKindInfo(kind.id), kind.id).toBe(kind);
      expect(kind.label, kind.id).not.toBe("");
      expect(kind.icon, kind.id).toMatch(/^M/);
    }
  });

  // [path, kind, label, opens, code panel, addable, import settings, preview, field kinds it is referenced as]
  const rows: [string, string, string, boolean, boolean, boolean, string | null, string | null, string[]][] = [
    ["scenes/main.scene.json", "scene", "Scene", true, false, true, null, "scene", ["scene"]],
    ["prefabs/pipe.prefab.json", "prefab", "Prefab", true, false, true, null, "prefab", ["prefab"]],
    ["images/bird.PNG", "image", "Image", true, false, true, "image", null, ["texture", "sprite"]],
    ["images/a.jpeg", "image", "Image", true, false, true, "image", null, ["texture", "sprite"]],
    ["images/sheet.png#walk_0", "sprite", "Sprite", true, false, true, null, null, ["sprite"]],
    ["music/town.mp3", "audio", "Audio", false, false, true, "audio", "audio", ["audio"]],
    ["rt/view.rendertexture.json", "rendertexture", "Render Texture", false, false, false, null, null, ["rendertexture"]],
    ["project.json", "json", "JSON", false, true, false, null, null, []],
    ["scripts/bird.ts", "script", "Script", false, true, false, null, null, []],
    ["lib/a.mjs", "javascript", "JS", false, true, false, null, null, []],
    ["lib/a.cts", "typescript", "TS Module", false, true, false, null, null, []],
    ["README.md", "text", "Text", false, true, false, null, null, []],
    ["data/a.xml", "xml", "XML", false, true, false, null, null, []],
    ["types/myco.d.ts", "other", "File", false, false, false, null, null, []],
    ["fonts/a.ttf", "other", "File", false, false, false, null, null, []],
    ["a/x.json#slice", "other", "File", false, false, false, null, null, []],
  ];
  it.each(rows)("%s is a %s", (path, kind, label, opens, code, addable, importSettings, preview, referencedAs) => {
    expect(assetKind(path)).toBe(kind);
    expect(assetKindInfo(kind)?.label).toBe(label);
    expect(assetKindFor(path)?.open !== undefined).toBe(opens);
    expect(opensInCodePanel(kind)).toBe(code);
    expect(canAddToScene(path)).toBe(addable);
    expect(importKind(path)).toBe(importSettings);
    expect(previewKind(path)).toBe(path.includes("#") ? null : preview);
    expect(assetKindFor(path)?.referencedAs ?? []).toEqual(referencedAs);
  });

  it("prefabs and render textures have their own Inspector view; files with import settings show those", () => {
    expect(inspectableAsset("prefabs/pipe.prefab.json")).toBe("prefabs/pipe.prefab.json");
    expect(inspectableAsset("rt/view.rendertexture.json")).toBe("rt/view.rendertexture.json");
    expect(inspectableAsset("images/sheet.png#walk_0")).toBe("images/sheet.png");
    expect(inspectableAsset("scripts/bird.ts")).toBeNull();
  });

  it("scenes and prefabs are added as instances", () => {
    expect(assetKindInfo("scene")?.addToScene?.instance).toBe(true);
    expect(assetKindInfo("prefab")?.addToScene?.instance).toBe(true);
    expect(assetKindInfo("image")?.addToScene?.instance).toBeUndefined();
  });
});

describe("plugin asset kinds", () => {
  it("assetKind, labels, icons, open and inspector", () => {
    expect(assetKind("a/x.fake.json")).toBe("json");
    expect(inspectableAsset("a/x.fake.json")).toBeNull();
    register(fake);
    expect(assetKind("a/X.FAKE.json")).toBe("fakekind");
    expect(assetKindInfo("fakekind")?.label).toBe("Fake");
    expect(assetKindInfo("fakekind")?.icon).toBe("M0 0");
    expect(assetKindFor("a/x.fake.json")?.open).toBeDefined();
    expect(inspectableAsset("a/x.fake.json")).toBe("a/x.fake.json");
    expect(canAddToScene("a/x.fake.json")).toBe(false);
  });

  it("field kinds accept it through referencedAs; previewKind uses its preview", () => {
    const files = ["a/x.fake.json", "a/y.material.json"];
    expect(assetsForKinds(["environment"], files)).toEqual([]);
    expect(previewKind("a/x.fake.json")).toBeNull();
    register(fake);
    expect(assetsForKinds(["environment"], files)).toEqual(["a/x.fake.json"]);
    expect(assetsForKinds(["material"], files)).toEqual(["a/y.material.json"]);
    expect(previewKind("a/x.fake.json")).toBe("material");
  });

  it("unregistering restores the old behaviour", () => {
    register(fake);
    undo.splice(0).forEach((u) => u());
    expect(assetKind("a/x.fake.json")).toBe("json");
    expect(assetKindInfo("fakekind")).toBeUndefined();
    expect(previewKind("a/x.fake.json")).toBeNull();
  });

  it("the longest extension wins; of equal ones, the kind registered last", () => {
    register({ id: "special", extensions: [".special.png"], label: "Special", icon: "M0 0" });
    expect(assetKind("a/b.special.png")).toBe("special");
    expect(assetKind("a/b.png")).toBe("image");
    expect(assetKind("a/b.special.png#slice")).toBe("other");
    register({ id: "mypng", extensions: [".png"], label: "Mine", icon: "M0 0" });
    expect(assetKind("a/b.png")).toBe("mypng");
  });

  it("a particle effect is added to a scene by its kind's addToScene policy", () => {
    expect(canAddToScene("fx/a.particles.json")).toBe(false); // plain JSON while the Particles plugin is off
    activatePlugins([particlesEditorPlugin]);
    try {
      expect(assetKindInfo("particles")?.addToScene).toBeDefined();
      expect(canAddToScene("fx/a.particles.json")).toBe(true);
    } finally {
      deactivatePlugin(particlesEditorPlugin.manifest.name);
    }
  });
});
