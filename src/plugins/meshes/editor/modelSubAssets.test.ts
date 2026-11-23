// ADR 0371 (T14): a model's `#Skeleton` and `#Anim/<clip>` sub-assets satisfy `skeleton` and `animclip` asset fields in
// the editor through the model kind: field offers list them once the model has loaded, and a stored reference to one is
// shown as itself, not "(missing)".
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Assets } from "../../../engine/index";
import { loadModel } from "../../../engine/scene/models";
import { skinnedGltf } from "../../../engine/tests/fixtures/gltf/skinnedGltf";
import { assetChoices, assetsForKinds } from "../../../editor/assetFieldKinds";
import { satisfiesFieldKind } from "../../../editor/assetKindLookup";
import { activatePlugins, deactivatePlugin } from "../../../editor/sdk/plugins";
import { useCoreAssetKinds } from "../../../editor/testing";
import { meshesEditorPlugin } from ".";

useCoreAssetKinds();
beforeAll(() => activatePlugins([meshesEditorPlugin]));
afterAll(() => {
  deactivatePlugin(meshesEditorPlugin.manifest.name);
  Assets.clearSources();
  vi.restoreAllMocks();
});

const FILES = ["models/rig.gltf", "models/crate.obj", "images/a.png"];

describe("model sub-assets in asset fields", () => {
  it("satisfy skeleton and animclip fields by name, and nothing else", () => {
    expect(satisfiesFieldKind("skeleton", "models/rig.gltf#Skeleton")).toBe(true);
    expect(satisfiesFieldKind("animclip", "models/rig.gltf#Anim/Walk")).toBe(true);
    expect(satisfiesFieldKind("animclip", "models/rig.gltf#Skeleton")).toBe(false);
    expect(satisfiesFieldKind("mesh", "models/rig.gltf#Anim/Walk")).toBe(false);
    expect(satisfiesFieldKind("skeleton", "models/rig.gltf")).toBe(false);
  });

  it("are offered once the model has loaded, and only to fields that take them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "models/rig.gltf": `data:application/octet-stream;base64,${Buffer.from(skinnedGltf()).toString("base64")}` }));
    await loadModel("models/rig.gltf");
    expect(assetsForKinds(["animclip"], FILES)).toEqual(["models/rig.gltf#Anim/Walk", "models/rig.gltf#Anim/Wave", "models/rig.gltf#Anim/Bounce"]);
    expect(assetsForKinds(["skeleton"], FILES)).toEqual(["models/rig.gltf#Skeleton"]);
    expect(assetsForKinds(["mesh"], FILES)).toEqual(expect.not.arrayContaining(["models/rig.gltf#Skeleton"]));
    const choices = assetChoices(["animclip"], FILES, "asset:models/rig.gltf#Anim/Wave");
    expect(choices.selected).toBe("asset:models/rig.gltf#Anim/Wave");
    expect(choices.other).toBeNull();
    expect(choices.entries.map((e) => e.label)).toEqual(["rig.gltf#Anim/Walk", "rig.gltf#Anim/Wave", "rig.gltf#Anim/Bounce"]);
  });
});
