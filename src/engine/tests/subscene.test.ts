import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../index";
import { SceneInstance } from "../scene/SceneLoader";

const files: Record<string, unknown> = {
  // A chunk of level: two top-level nodes, one with a child.
  "scenes/chunk.scene.json": {
    format: "tranquility.scene@1",
    nodes: [
      { id: "rock", name: "Rock", components: [{ type: "engine.Transform", data: { position: [1, 0, 0] } }] },
      { id: "tree", name: "Tree", components: [{ type: "engine.Transform", data: { position: [3, 0, 0] } }] },
      { id: "leaf", name: "Leaf", parent: "tree" },
    ],
  },
  "scenes/level.scene.json": {
    format: "tranquility.scene@1",
    nodes: [
      { id: "ground", name: "Ground" },
      {
        id: "east",
        prefab: "scenes/chunk.scene.json",
        overrides: [
          { component: "engine.Transform", field: "position", value: [100, 0, 0] },
          { target: ["tree"], component: "engine.Transform", field: "position", value: [5, 0, 0] },
        ],
      },
      { id: "west", name: "WestChunk", parent: "ground", prefab: "scenes/chunk.scene.json" },
    ],
  },
};

afterEach(() => Assets.clearSources());

describe("scenes inside scenes (ADR 0016)", () => {
  it("instances a scene as a scene node holding the file's top-level nodes", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    const level = await SceneManager.load("scenes/level.scene.json");
    const east = level.children.find((c) => c.name === "chunk")!; // named after the file
    expect(east.isSceneNode).toBe(true);
    expect(east.getBehavior(SceneInstance)!.source).toBe("scenes/chunk.scene.json");
    expect(east.children.map((c) => c.name)).toEqual(["Rock", "Tree"]);
    expect(east.find("Tree/Leaf")).not.toBeNull();
  });

  it("applies overrides to the scene node (empty target) and to nodes inside it", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    const level = await SceneManager.load("scenes/level.scene.json");
    const east = level.children.find((c) => c.name === "chunk")!;
    expect(east.transform!.position.toArray()).toEqual([100, 0, 0]); // the sub-scene can be placed
    expect(east.find("Tree")!.transform!.worldPosition.toArray()).toEqual([105, 0, 0]);
    expect(east.find("Rock")!.transform!.worldPosition.toArray()).toEqual([101, 0, 0]);
  });

  it("nests sub-scenes as children of other nodes, keeping the instance's name", async () => {
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    const level = await SceneManager.load("scenes/level.scene.json");
    const west = level.find("Ground/WestChunk")!;
    expect(west.isSceneNode).toBe(true);
    // Only scene nodes directly under the World root count as loaded scenes.
    expect(engine.world.sceneNodes).toEqual([level]);
    expect(GameObject.create("New").parent).toBe(level);
  });
});
