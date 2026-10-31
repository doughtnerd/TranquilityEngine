import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listComponents, listNodes, instantiateDocument, writeField } from "../editor";
import { Assets, Color, Engine, GameBehavior, GameObject, SpriteRenderer, Vector3, behavior, defineComponent, defineSystem, f32, field } from "../index";
import type { SceneFile } from "../scene/SceneLoader";

const calls: string[] = [];

@behavior("test.editor.Probe")
class Probe extends GameBehavior {
  @field(Number) speed = 1;
  @field(GameObject) target: GameObject | null = null;
  awake() { calls.push("awake"); }
  start() { calls.push("start"); }
  update() { calls.push("update"); }
}

const Spin = defineComponent("test.editor.Spin", { rate: f32 });
let systemRows = 0;
defineSystem({ name: "test.editor.CountSpin", phase: "update", query: [Spin], run(rows) { for (const _ of rows) systemRows++; } });

const prefab: SceneFile = {
  format: "tranquility.scene@1",
  nodes: [
    { id: "root", name: "Thing", components: [{ type: "engine.SpriteRenderer", data: { color: "#ff0000" } }] },
    { id: "inner", name: "Inner", parent: "root" },
  ],
};

const scene: SceneFile = {
  format: "tranquility.scene@1",
  nodes: [
    { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [1, 2, 3] } }, { type: "test.editor.Spin", data: { rate: 2 } }] },
    { id: "b", name: "B", parent: "a", components: [{ type: "test.editor.Probe", data: { speed: 4, target: { $node: "a" } } }] },
    { id: "p", prefab: "prefabs/thing.json" },
  ],
};

let engine: Engine;
beforeEach(async () => {
  calls.length = 0;
  systemRows = 0;
  engine = await Engine.create({ headless: true, kind: "editor", assets: Assets.fromObject({ "prefabs/thing.json": prefab }) });
});
afterEach(() => Assets.clearSources());

describe("editor engine access (ADR 0026)", () => {
  it("instantiates a document in edit mode and reports each node's document path", () => {
    const paths = new Map<string, string>();
    const sceneNode = instantiateDocument(engine.world, scene, "scenes/test.json", { onNode: (n, p) => paths.set(p.join("/"), n.name) });
    expect(sceneNode.isSceneNode).toBe(true);
    expect(Object.fromEntries(paths)).toEqual({ a: "A", b: "B", "p/root": "Thing", "p/inner": "Inner", p: "Thing" });
  });

  it("doesn't run scripts, systems or audio for nodes being edited", () => {
    instantiateDocument(engine.world, scene, "scenes/test.json");
    for (let i = 0; i < 5; i++) engine.step(1 / 60);
    expect(calls).toEqual([]);
    expect(systemRows).toBe(0);

    // Editor tools outside the document still run. (GameObject.create would default to the
    // active scene, which is the edited document, so tools go under the World root.)
    GameObject.create("Tool", { parent: engine.world.root }).addBehavior(Probe);
    engine.step(1 / 60);
    expect(calls).toEqual(["awake", "start", "update"]);
  });

  it("lists nodes in tree order and components with declared fields", () => {
    const sceneNode = instantiateDocument(engine.world, scene, "scenes/test.json");
    const nodes = listNodes(engine.world, sceneNode);
    expect(nodes.map((n) => `${"  ".repeat(n.depth)}${n.name}`)).toEqual(["test", "  A", "    B", "  Thing", "    Inner"]);
    expect(nodes[1].id).toBe("a");

    const a = sceneNode.find("A")!;
    const aComps = listComponents(a);
    expect(aComps.map((c) => `${c.kind}:${c.type}`)).toEqual(["transform:engine.Transform", "data:test.editor.Spin"]);
    expect((aComps[0].fields[0].value as Vector3).toArray()).toEqual([1, 2, 3]);
    expect(aComps[1].fields).toEqual([{ name: "rate", type: f32, value: 2 }]);

    const probe = listComponents(a.find("B")!).find((c) => c.type === "test.editor.Probe")!;
    expect(probe.fields.map((f) => f.name)).toEqual(["speed", "target"]);
    expect(probe.fields[0].value).toBe(4);
    expect((probe.fields[1].value as GameObject).name).toBe("A");
  });

  it("writes serialized field values onto live components", () => {
    const sceneNode = instantiateDocument(engine.world, scene, "scenes/test.json");
    const a = sceneNode.find("A")!;
    const thing = sceneNode.find("Thing")!;
    expect(writeField(a, "engine.Transform", 0, "position", [7, 8, 9])).toBe(true);
    expect(a.transform!.position.toArray()).toEqual([7, 8, 9]);
    expect(writeField(a, "test.editor.Spin", 0, "rate", 5)).toBe(true);
    expect(a.getData(Spin)!.rate).toBe(5);
    expect(writeField(thing, "engine.SpriteRenderer", 0, "color", "#00ff00")).toBe(true);
    expect(thing.getBehavior(SpriteRenderer)!.color.toHex()).toBe(Color.from("#00ff00").toHex());
    const b = a.find("B")!;
    expect(writeField(b, "test.editor.Probe", 0, "target", { $node: "p" }, (id) => (id === "p" ? thing : null))).toBe(true);
    expect(b.getBehavior(Probe)!.target).toBe(thing);
    expect(writeField(b, "test.editor.Probe", 0, "nope", 1)).toBe(false);
    expect(writeField(b, "engine.Camera", 0, "fieldOfView", 1)).toBe(false);
  });
});
