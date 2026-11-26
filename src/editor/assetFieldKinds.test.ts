// ADR 0131: which project files an asset field offers, from the kind it declares.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSET_FIELD_KINDS, AssetRef, type AssetFieldKind } from "../engine/core/registry";
import { materialsEditorPlugin } from "../plugins/materials/editor";
import { navigationEditorPlugin } from "../plugins/navigation/editor";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { skyEditorPlugin } from "../plugins/sky/editor";
import { tilemapsEditorPlugin } from "../plugins/tilemaps/editor";
import { environmentEditorPlugin } from "../plugins/environment/editor";
import { meshesEditorPlugin } from "../plugins/meshes/editor";
import { postProcessingEditorPlugin } from "../plugins/post-processing/editor";
import { uiEditorPlugin } from "../plugins/ui/editor";
import { assetChoices, assetKindsOf, assetsForKinds, isHiddenField } from "./assetFieldKinds";
import { messageLog } from "./messages";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

// Sky assets are the Sky plugin's (ADR 0134), its kind `referencedAs` environment; materials and
// shader graphs are the Materials plugin's, `referencedAs` material.
// Models, environment maps, cubemaps, LUTs and UI documents: the Meshes, Environment, Post-processing and UI plugins' (ADR 0140).
const RENDER_PLUGINS = [meshesEditorPlugin, environmentEditorPlugin, postProcessingEditorPlugin, uiEditorPlugin];
beforeAll(() => activatePlugins([materialsEditorPlugin, skyEditorPlugin, particlesEditorPlugin, navigationEditorPlugin, tilemapsEditorPlugin, ...RENDER_PLUGINS]));
afterAll(() => {
  for (const p of [...RENDER_PLUGINS, tilemapsEditorPlugin, navigationEditorPlugin, particlesEditorPlugin]) deactivatePlugin(p.manifest.name);
  deactivatePlugin(skyEditorPlugin.manifest.name);
  deactivatePlugin(materialsEditorPlugin.manifest.name);
});

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
  "ui/Menu.svelte",
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
    expect(offered("svelte")).toEqual(["ui/Menu.svelte"]);
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

  it("keeps a kind outside the engine's own (a plugin's, ADR 0143), and warns once when no asset kind satisfies it", () => {
    expect(assetKindsOf({ name: "s", type: AssetRef, value: "", options: { kind: "spin" } })).toEqual(["spin"]);
    const before = messageLog.peek().length;
    expect(assetsForKinds(["spin"], ["a/x.spin.json"])).toEqual([]);
    expect(assetsForKinds(["spin"], ["a/x.spin.json"])).toEqual([]);
    expect(messageLog.peek().slice(before).map((m) => m.kind)).toEqual(["warning"]);
    expect(assetsForKinds(["lut"], [])).toEqual([]); // the engine's own names never warn: their plugin may be disabled
    expect(messageLog.peek().length).toBe(before + 1);
  });

  it("is empty for an undeclared kind or a field that isn't an asset", () => {
    expect(assetKindsOf({ name: "m", type: AssetRef, value: "" })).toEqual([]);
    expect(assetKindsOf({ name: "n", type: String, value: "", options: { kind: "audio" } })).toEqual([]);
  });

  it("knows hidden fields", () => {
    expect(isHiddenField({ name: "x", type: AssetRef, value: "", options: { hidden: true } })).toBe(true);
    expect(isHiddenField({ name: "x", type: AssetRef, value: "" })).toBe(false);
  });
});

// ADR 0282: what an asset slot offers and shows, which the SDK's AssetPicker renders.
describe("assetChoices", () => {
  const values = (kinds: AssetFieldKind[], files = FILES) => assetChoices(kinds, files, "").entries.map((e) => e.value);

  it("offers built-ins first, then the files that fit, stored with asset: by default or as bare paths", () => {
    expect(values(["texture", "rendertexture"])).toEqual(["asset:images/bird.png", "asset:images/sky.jpg", "asset:rt/mirror.rendertexture.json"]);
    expect(assetChoices(["texture"], FILES, "", { stored: "path" }).entries.map((e) => e.value)).toEqual(["images/bird.png", "images/sky.jpg"]);
    const mesh = values(["mesh"]);
    expect(mesh[0]).toBe("builtin:cube");
    expect(mesh.at(-1)).toBe("asset:models/ship.glb");
  });

  it("leaves sidecars out and narrows by accepts", () => {
    expect(values([], ["images/bird.png", "images/bird.png.meta.json"])).toEqual(["asset:images/bird.png"]);
    expect(assetChoices(["texture"], FILES, "", { accepts: (f) => f.endsWith(".png") }).entries.map((e) => e.value)).toEqual(["asset:images/bird.png"]);
  });

  it("labels files by name, by path where two share a name, and built-ins in words", () => {
    const { entries } = assetChoices(["texture"], ["a/tile.png", "b/tile.png", "c/grass.png"], "");
    expect(entries.map((e) => e.label)).toEqual(["a/tile.png", "b/tile.png", "grass.png"]);
    expect(assetChoices(["mesh"], [], "").entries[0].label).toBe("Cube");
  });

  it("finds the value whatever its reference form, in the slot's stored form", () => {
    expect(assetChoices(["texture"], FILES, "images/bird.png")).toMatchObject({ selected: "asset:images/bird.png", other: null });
    expect(assetChoices(["texture"], FILES, "asset:./images/bird.png", { stored: "path" })).toMatchObject({ selected: "images/bird.png", other: null });
    expect(assetChoices(["mesh"], FILES, "builtin:cube")).toMatchObject({ selected: "builtin:cube", other: null });
    expect(assetChoices(["texture"], FILES, "")).toMatchObject({ selected: "", other: null });
  });

  it("shows a file the project doesn't have as missing, and an existing file it doesn't offer (a sub-mesh) as itself", () => {
    expect(assetChoices(["texture"], FILES, "asset:images/gone.png").other).toEqual({ value: "asset:images/gone.png", label: "gone.png (missing)" });
    expect(assetChoices(["mesh"], FILES, "models/ship.glb#Hull", { stored: "path" }).other).toEqual({ value: "models/ship.glb#Hull", label: "ship.glb#Hull" });
    expect(assetChoices(["mesh"], FILES, "builtin:teapot").other).toEqual({ value: "builtin:teapot", label: "Teapot (missing)" });
  });
});
