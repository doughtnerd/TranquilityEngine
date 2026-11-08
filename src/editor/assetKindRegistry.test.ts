// Plugin-registered asset kinds in the editor's lookups (ADR 0133/0134).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materialsEditorPlugin } from "../plugins/materials/editor";
import { assetKind, canAddToScene } from "./assetBrowser";
import { assetsForKinds } from "./assetFieldKinds";
import { kindIcon, kindLabel, kindOpens, registeredKindOpens } from "./assetKindLookup";
import { inspectableAsset } from "./assetImport";
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

describe("registered asset kinds", () => {
  it("assetKind, labels, icons, open and inspector", () => {
    expect(assetKind("a/x.fake.json")).toBe("json");
    expect(inspectableAsset("a/x.fake.json")).toBeNull();
    register(fake);
    expect(assetKind("a/X.FAKE.json")).toBe("fakekind");
    expect(kindLabel("fakekind")).toBe("Fake");
    expect(kindIcon("fakekind")).toBe("M0 0");
    expect(kindLabel("scene")).toBeUndefined();
    expect(kindOpens("a/x.fake.json")).toBe(true);
    expect(registeredKindOpens("fakekind")).toBe(true);
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
    expect(kindLabel("fakekind")).toBeUndefined();
    expect(previewKind("a/x.fake.json")).toBeNull();
  });

  it("a longer registered extension beats a built-in", () => {
    expect(assetKind("a/b.special.png")).toBe("image");
    register({ id: "special", extensions: [".special.png"], label: "Special", icon: "M0 0" });
    expect(assetKind("a/b.special.png")).toBe("special");
    expect(assetKind("a/b.png")).toBe("image");
    expect(assetKind("a/b.special.png#slice")).toBe("other");
  });
});
