import { describe, expect, it } from "vitest";
import { sceneWithoutAsset, settingsWithoutAsset } from "./assetCleanup";
import type { SceneFile } from "./document";

const file: SceneFile = {
  format: "myco.scene@1",
  nodes: [
    { id: "pipe", prefab: "prefabs/pipe.prefab.json", overrides: [{ component: "engine.Transform", field: "position", value: [1, 2, 0] }] },
    { id: "label", parent: "pipe", components: [{ type: "engine.Transform" }] }, // a child of the instance
    {
      id: "spawner",
      components: [
        { type: "engine.Transform" },
        { type: "game.Spawner", data: { prefab: "prefabs/pipe.prefab.json", target: { $node: "label" }, keep: { $node: "bird" }, list: ["prefabs/pipe.prefab.json", "prefabs/other.prefab.json"] } },
      ],
    },
    {
      id: "bird",
      components: [{ type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png", color: "#ffffff" } }],
    },
    {
      id: "bg",
      prefab: "prefabs/bg.prefab.json",
      overrides: [
        { component: "engine.SpriteRenderer", field: "sprite", value: "asset:images/bird.png" },
        { component: "engine.SpriteRenderer", field: "orderInLayer", value: 2 },
        { addComponent: { type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png" } } },
      ],
    },
  ],
};

describe("taking a deleted prefab out of a scene", () => {
  it("removes its instances with their children, and sets references to them to None", () => {
    const result = sceneWithoutAsset(file, "prefabs/pipe.prefab.json");
    expect(result.changed).toBe(true);
    expect(result.removedNodes.sort()).toEqual(["label", "pipe"]);
    expect(result.file.nodes.map((n) => n.id)).toEqual(["spawner", "bird", "bg"]);
    const data = result.file.nodes[0].components![1].data!;
    expect(data).toEqual({ target: null, keep: { $node: "bird" }, list: ["prefabs/other.prefab.json"] }); // the field naming it goes back to its default
    expect(file.nodes).toHaveLength(5); // the input isn't touched
  });
});

describe("taking a deleted image out of a scene", () => {
  it("drops fields and overrides naming it, in components and added components", () => {
    const result = sceneWithoutAsset(file, "images/bird.png");
    expect(result.changed).toBe(true);
    expect(result.removedNodes).toEqual([]);
    expect(result.file.nodes.find((n) => n.id === "bird")!.components![0].data).toEqual({ color: "#ffffff" });
    expect(result.file.nodes.find((n) => n.id === "bg")!.overrides).toEqual([
      { component: "engine.SpriteRenderer", field: "orderInLayer", value: 2 },
      { addComponent: { type: "engine.SpriteRenderer", data: {} } },
    ]);
  });

  it("changes nothing when nothing names it", () => {
    const result = sceneWithoutAsset(file, "images/other.png");
    expect(result.changed).toBe(false);
    expect(result.file.nodes).toEqual(file.nodes);
  });
});

describe("taking a deleted prefab out of the project settings", () => {
  it("drops autoloads of it", () => {
    expect(settingsWithoutAsset({ name: "x", autoload: ["prefabs/music.prefab.json", "prefabs/ui.prefab.json"] }, "prefabs/music.prefab.json")).toEqual({
      settings: { name: "x", autoload: ["prefabs/ui.prefab.json"] },
      changed: true,
    });
    expect(settingsWithoutAsset({ name: "x" }, "prefabs/music.prefab.json").changed).toBe(false);
  });
});
