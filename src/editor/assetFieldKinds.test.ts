// ADR 0131: which project files an asset field offers, from the kind it declares.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSET_FIELD_KINDS, AssetRef, type AssetFieldKind } from "../engine/core/registry";
import { skyEditorPlugin } from "../plugins/sky/editor";
import { assetKindsOf, assetListId, assetsForKinds, isHiddenField } from "./assetFieldKinds";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";

// Sky assets are the Sky plugin's (ADR 0134); its kind is `referencedAs` environment.
beforeAll(() => activatePlugins([skyEditorPlugin]));
afterAll(() => deactivatePlugin(skyEditorPlugin.manifest.name));

const FILES = [
  "models/ship.glb",
  "materials/hull.material.json",
  "shaders/glow.shadergraph.json",
  "images/bird.png",
  "images/sky.jpg",
  "rt/mirror.rendertexture.json",
  "audio/flap.ogg",
  "fx/smoke.particles.json",
  "nav/wedge.formation.json",
  "grade/warm.cube",
  "env/studio.hdr",
  "env/probe.env",
  "env/day.sky.json",
  "env/box.cubemap.json",
  "tiles/grass.tileset.json",
  "fonts/Pirata.ttf",
  "ui/menu.ui.xml",
  "main.nav.bin",
  "main.scene.json",
  "enemy.prefab.json",
  "scripts/bird.ts",
];

const offered = (kind: AssetFieldKind) => assetsForKinds([kind], FILES);

describe("assetsForKinds", () => {
  it("offers what each kind needs", () => {
    expect(offered("model")).toEqual(["models/ship.glb"]);
    expect(offered("mesh")).toContain("builtin:cube");
    expect(offered("mesh")).toContain("models/ship.glb");
    expect(offered("mesh")).not.toContain("images/bird.png");
    expect(offered("material")).toEqual(["materials/hull.material.json", "shaders/glow.shadergraph.json"]);
    expect(offered("texture")).toEqual(["images/bird.png", "images/sky.jpg"]);
    expect(offered("sprite")).toEqual(["images/bird.png", "images/sky.jpg"]);
    expect(offered("rendertexture")).toEqual(["rt/mirror.rendertexture.json"]);
    expect(offered("audio")).toEqual(["audio/flap.ogg"]);
    expect(offered("particles")).toEqual(["fx/smoke.particles.json"]);
    expect(offered("formation")).toEqual(["nav/wedge.formation.json"]);
    expect(offered("lut")).toEqual(["grade/warm.cube"]);
    expect(offered("environment")).toEqual(["images/bird.png", "images/sky.jpg", "env/studio.hdr", "env/probe.env", "env/day.sky.json", "env/box.cubemap.json"]);
    expect(offered("envmap")).toEqual(["env/probe.env"]);
    expect(offered("tileset")).toEqual(["tiles/grass.tileset.json"]);
    expect(offered("font")).toEqual(["fonts/Pirata.ttf"]);
    expect(offered("uidocument")).toEqual(["ui/menu.ui.xml"]);
    expect(offered("navbake")).toEqual(["main.nav.bin"]);
    expect(offered("scene")).toEqual(["main.scene.json"]);
    expect(offered("prefab")).toEqual(["enemy.prefab.json"]);
  });

  it("covers every kind: each offers something from a full project", () => {
    for (const kind of ASSET_FIELD_KINDS) expect(offered(kind).length, kind).toBeGreaterThan(0);
  });

  it("joins several kinds, and offers every file for none", () => {
    expect(assetsForKinds(["audio", "font"], FILES)).toEqual(["audio/flap.ogg", "fonts/Pirata.ttf"]);
    expect(assetsForKinds([], FILES)).toEqual(FILES);
  });
});

describe("assetKindsOf", () => {
  it("reads the declared kind of an asset field or a list item", () => {
    expect(assetKindsOf({ name: "m", type: AssetRef, value: "", options: { kind: "material" } })).toEqual(["material"]);
    expect(assetKindsOf({ name: "m[0]", type: AssetRef, value: "", options: { kind: ["texture", "sprite"] } })).toEqual(["texture", "sprite"]);
    expect(assetKindsOf({ name: "m", type: [AssetRef], value: [], options: { kind: "audio" } })).toEqual(["audio"]);
  });

  it("is empty for an undeclared kind or a field that isn't an asset", () => {
    expect(assetKindsOf({ name: "m", type: AssetRef, value: "" })).toEqual([]);
    expect(assetKindsOf({ name: "n", type: String, value: "", options: { kind: "audio" } })).toEqual([]);
  });

  it("names the datalist for the kinds", () => {
    expect(assetListId([])).toBe("asset-list-all");
    expect(assetListId(["material"])).toBe("asset-list-material");
    expect(assetListId(["texture", "rendertexture"])).toBe("asset-list-texture+rendertexture");
  });

  it("knows hidden fields", () => {
    expect(isHiddenField({ name: "x", type: AssetRef, value: "", options: { hidden: true } })).toBe(true);
    expect(isHiddenField({ name: "x", type: AssetRef, value: "" })).toBe(false);
  });
});
