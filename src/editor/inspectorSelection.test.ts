// The Inspector follows the latest selection: selecting one asset it can show (a material, an
// image, a particle effect…) deselects the scene's nodes, and selecting nodes deselects the
// Assets panel's entries, whichever came first.
import { afterEach, describe, expect, it } from "vitest";
import { materialsEditorPlugin } from "../plugins/materials/editor";
import { navigationEditorPlugin } from "../plugins/navigation/editor";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { tilemapsEditorPlugin } from "../plugins/tilemaps/editor";
import { inspectableAsset, inspectedAsset, inspectSelectedAsset, showAsset, showsAssetInspector } from "./assetImport";
import { folderPath, resetAssetBrowser, select as selectAssets, selectedAssets } from "./assetSelection";
import { useEditorPlugins } from "../plugins/testEditorPlugins";
import { select as selectNodes, selectedKeys } from "./state";
import { useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

// Materials and shader graphs have inspectors through the Materials plugin (ADR 0134).
const PLUGINS = [materialsEditorPlugin, particlesEditorPlugin, navigationEditorPlugin, tilemapsEditorPlugin];
useEditorPlugins(PLUGINS, "each");
afterEach(() => {
  selectNodes([]);
  resetAssetBrowser();
});

const INSPECTED = [
  "materials/sail.material.json",
  "shaders/water.shadergraph.json",
  "effects/rain.particles.json",
  "prefabs/ship.prefab.json",
  "images/flag.png",
  "audio/thunder.wav",
];

describe("the Inspector follows the latest selection", () => {
  it("knows which assets have an inspector", () => {
    for (const path of INSPECTED) expect(inspectableAsset(path), path).toBe(path);
    expect(inspectableAsset("images/flag.png#wave")).toBe("images/flag.png"); // a slice shows its image
    expect(inspectableAsset("scenes/main.scene.json")).toBeNull();
    expect(inspectableAsset("scripts/ship.ts")).toBeNull();
    expect(inspectableAsset("materials/")).toBeNull();
  });

  it("shows an asset selected after a node, for every asset kind with an inspector", () => {
    for (const path of INSPECTED) {
      selectNodes(["sun"]);
      selectAssets([path]);
      inspectSelectedAsset(); // what an asset click does
      expect(selectedKeys.value, path).toEqual([]);
      expect(showsAssetInspector(), path).toBe(true);
      expect(inspectedAsset.value).toBe(path);
    }
  });

  it("shows a node selected after an asset, and doesn't fall back to the asset when the node is deselected", () => {
    selectAssets(["materials/sail.material.json"]);
    inspectSelectedAsset();
    expect(showsAssetInspector()).toBe(true);
    selectNodes(["sun", "fog"]); // a multi-selection too
    expect(selectedAssets.value).toEqual([]);
    expect(showsAssetInspector()).toBe(false);
    selectNodes([]);
    expect(showsAssetInspector()).toBe(false);
  });

  it("keeps the nodes for selections the Inspector can't show", () => {
    selectNodes(["sun"]);
    selectAssets(["scenes/main.scene.json"]);
    inspectSelectedAsset();
    expect(selectedKeys.value).toEqual(["sun"]);
    selectAssets(["materials/sail.material.json", "materials/bolt.material.json"]);
    inspectSelectedAsset();
    expect(selectedKeys.value).toEqual(["sun"]);
  });

  it("Select Asset buttons open the asset's folder and show it in place of the node", () => {
    selectNodes(["rain"]);
    showAsset("effects/rain.particles.json");
    expect(folderPath.value).toBe("effects");
    expect(selectedAssets.value).toEqual(["effects/rain.particles.json"]);
    expect(selectedKeys.value).toEqual([]);
    expect(showsAssetInspector()).toBe(true);
  });
});
