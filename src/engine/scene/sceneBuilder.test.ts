import { describe, expect, it } from "vitest";
import { migrateSceneFile, type SceneFile } from "./SceneLoader";
import { asset, prefab, ref, scene, setField } from "./sceneBuilder";

const roundTrip = (f: SceneFile) => migrateSceneFile(JSON.parse(JSON.stringify(f)) as SceneFile, "builder");

describe("scene builder", () => {
  it("matches a hand-written scene and passes the loader's parse path", () => {
    const built = scene("Main")
      .settings({ physics: "2d" })
      .node("Camera", (n) => n.component("engine.Transform", { position: [0, 0, 10] }))
      .node("Player", (n) =>
        n
          .tags("player")
          .component("engine.Transform", { position: [-2, 0, 0] })
          .component("engine.SpriteRenderer", { sprite: asset("images/bird.png") })
          .component("game.Follow", { target: ref("camera") }, { enabled: false })
          .child("Hitbox", (c) => c.componentNode().component("engine.BoxCollider2D", { size: [1, 1] })),
      )
      .node("Ground", (n) => n.id("ground-a").instanceOf("prefabs/ground.prefab.json", { overrides: [setField("engine.Transform", "position", [32, -13, 0])] }))
      .node("Logic", (n) => n.noTransform().active(false))
      .toJSON();

    const handWritten: SceneFile = {
      format: "myco.scene@3",
      settings: { physics: "2d" },
      nodes: [
        { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 0, 10] } }] },
        {
          id: "player",
          name: "Player",
          tags: ["player"],
          components: [
            { type: "engine.Transform", data: { position: [-2, 0, 0] } },
            { type: "engine.SpriteRenderer", data: { sprite: "asset:images/bird.png" } },
            { type: "game.Follow", enabled: false, data: { target: { $node: "camera" } } },
          ],
        },
        { id: "hitbox", name: "Hitbox", parent: "player", componentNode: true, components: [{ type: "engine.BoxCollider2D", data: { size: [1, 1] } }] },
        {
          id: "ground-a",
          name: "Ground",
          prefab: "prefabs/ground.prefab.json",
          overrides: [{ component: "engine.Transform", field: "position", value: [32, -13, 0] }],
        },
        { id: "logic", name: "Logic", active: false, transform: false, components: [] },
      ],
    };

    expect(built).toEqual(handWritten);
    expect(roundTrip(built)).toEqual(handWritten);
  });

  it("builds prefabs with a single root, de-duplicated ids and nested instance overrides", () => {
    const p = prefab("Pipe Pair", (r) =>
      r
        .id("pair")
        .child("Pipe", (c) => c.component("engine.Transform", { position: [0, 9, 0] }))
        .child("Pipe", (c) => c.component("engine.Transform", { position: [0, -9, 0] })),
    ).toJSON();
    expect(p.nodes.map((n) => [n.id, n.parent])).toEqual([["pair", undefined], ["pipe", "pair"], ["pipe-2", "pair"]]);
    expect(roundTrip(p)).toEqual(p);

    const s = scene("S").node("Inst", (n) => n.instanceOf("prefabs/a.prefab.json", { overrides: [setField("engine.Transform", "position", [1, 0, 0], ["x", "y"])] })).toJSON();
    expect(s.nodes[0].overrides).toEqual([{ target: ["x", "y"], component: "engine.Transform", field: "position", value: [1, 0, 0] }]);
  });

  it("rejects duplicate explicit ids and returns independent copies", () => {
    const b = scene("S").node("A", (n) => n.id("x")).node("B", (n) => n.id("x"));
    expect(() => b.toJSON()).toThrow(/Duplicate node id/);
    const ok = scene("S").node("A");
    const first = ok.toJSON();
    first.nodes.length = 0;
    expect(ok.toJSON().nodes).toHaveLength(1);
  });
});
