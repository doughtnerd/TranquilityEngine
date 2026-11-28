import { describe, expect, it } from "vitest";
import { assetKind } from "./assetKindLookup";
import { useCoreAssetKinds } from "./testing";
import { fileName, folderOf, isSceneFile, parentFolder, sceneDisplayName } from "./projectPath";

describe("project paths", () => {
  useCoreAssetKinds();

  it("splits a path into its folder and file name", () => {
    expect(fileName("images/bird.png")).toBe("bird.png");
    expect(fileName("project.json")).toBe("project.json");
    expect(folderOf("audio/sfx/a.wav")).toBe("audio/sfx");
    expect(folderOf("a.wav")).toBe("");
  });

  it("gives a folder's parent, and none for the project root", () => {
    expect(parentFolder("a/b")).toBe("a");
    expect(parentFolder("a")).toBe("");
    expect(parentFolder("")).toBeNull();
  });

  it("knows scenes and prefabs by their ending in any case, as the asset kinds do", () => {
    for (const path of ["scenes/main.scene.json", "Level.Scene.JSON", "prefabs/pipe.prefab.json", "prefabs/Pipe.PREFAB.json"]) {
      expect(isSceneFile(path)).toBe(true);
      expect(["scene", "prefab"]).toContain(assetKind(path));
    }
    for (const path of ["data/scene.json", "a.json", "scenes/.scene.json", "scene.json.bak"]) {
      expect(isSceneFile(path)).toBe(false);
      expect(["scene", "prefab"]).not.toContain(assetKind(path));
    }
  });

  it("names a scene or prefab without its folder and ending", () => {
    expect(sceneDisplayName("scenes/level-1.scene.json")).toBe("level-1");
    expect(sceneDisplayName("prefabs/Pipe-Pair.PREFAB.JSON")).toBe("Pipe-Pair");
    expect(sceneDisplayName("data/table.json")).toBe("table");
    expect(sceneDisplayName("images/bird.png")).toBe("bird.png");
  });
});
