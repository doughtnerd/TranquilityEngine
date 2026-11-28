import { describe, expect, it } from "vitest";
import { isPrefabPath, isScenePath, sceneNodeName } from "./scenePath";

describe("scene and prefab paths (ADR 0467)", () => {
  it("knows scenes and prefabs by their ending in any case, after a non-empty name", () => {
    expect(["a.scene.json", "s/Boss.Scene.JSON"].map(isScenePath)).toEqual([true, true]);
    expect(["a.prefab.json", "scene.json", "s/.scene.json", "a.scene.json.bak"].map(isScenePath)).toEqual([false, false, false, false]);
    expect(["p/x.prefab.json", "p/X.PREFAB.JSON"].map(isPrefabPath)).toEqual([true, true]);
    expect(["p/x.scene.json", "p/.prefab.json"].map(isPrefabPath)).toEqual([false, false]);
  });

  it("names a scene node by its file without the scene or prefab ending, else without .json", () => {
    expect(sceneNodeName("scenes/Boss.Scene.JSON")).toBe("Boss");
    expect(sceneNodeName("prefabs/x.prefab.json")).toBe("x");
    expect(sceneNodeName("scenes/main.json")).toBe("main");
    expect(sceneNodeName("images/bird.png")).toBe("bird.png");
  });
});
