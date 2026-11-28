// One rule names scene nodes (ADR 0467): a scene file loaded as the top scene, instanced as a sub-scene, or opened as
// an editor document makes a scene node named alike, its `.scene.json` or `.prefab.json` ending dropped in any case,
// so absolute `{"$node": "/Boss/..."}` references read the same tree wherever the file is loaded.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, SceneManager, behavior, field, type SceneFile } from "../index";
import { instantiateDocument } from "../editor";

@behavior("test.sceneNodeNames.Pointer")
class Pointer extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;
}

const boss: SceneFile = {
  format: "myco.scene@5",
  nodes: [
    { id: "arena", name: "Arena" },
    { id: "p", name: "P", components: [{ type: "test.sceneNodeNames.Pointer", data: { target: { $node: "/Boss/Arena" } } }] },
  ],
};

const files: Record<string, unknown> = {
  "scenes/Boss.Scene.JSON": boss,
  "scenes/holder.scene.json": { format: "myco.scene@5", nodes: [{ id: "b", prefab: "scenes/Boss.Scene.JSON" }] },
  "prefabs/Crate.PREFAB.json": { format: "myco.scene@5", nodes: [{ id: "c", name: "Crate" }] },
};

afterEach(() => Assets.clearSources());

describe("scene node names (ADR 0467)", () => {
  it("names a top scene without its ending in any case, so its absolute references resolve", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    const scene = await SceneManager.load("scenes/Boss.Scene.JSON");
    expect(scene.name).toBe("Boss");
    expect(scene.find("P")!.getBehavior(Pointer)!.target).toBe(scene.find("Arena"));
  });

  it("names the same file alike as a sub-scene", async () => {
    await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    const holder = await SceneManager.load("scenes/holder.scene.json");
    expect(holder.name).toBe("holder");
    expect(holder.children.map((c) => c.name)).toEqual(["Boss"]);
  });

  it("drops a prefab's ending too, at runtime as in the editor", async () => {
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject(files) });
    expect((await SceneManager.load("prefabs/Crate.PREFAB.json")).name).toBe("Crate");
    expect(instantiateDocument(engine.world, files["prefabs/Crate.PREFAB.json"] as SceneFile, "prefabs/Crate.PREFAB.json").name).toBe("Crate");
    expect(instantiateDocument(engine.world, boss, "scenes/Boss.Scene.JSON").name).toBe("Boss");
  });
});
