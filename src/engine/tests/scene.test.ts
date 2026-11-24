import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, SceneManager, behavior, defineComponent, f32, field, registerSceneMigration } from "../index";
import { listComponents } from "../editor";

@behavior("test.Holder")
class Holder extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;
  @field(Number) amount = 1;
  @field(String) label = "default";
  seenTargetInAwake: string | null = null;
  awake() {
    this.seenTargetInAwake = this.target?.name ?? null;
  }
}

const Speed = defineComponent("test.Speed", { value: f32 });

const files: Record<string, unknown> = {
  "prefabs/thing.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "root", name: "Thing", components: [{ type: "test.Holder", data: { amount: 2, target: { $node: "inner" } } }] },
      { id: "inner", name: "Inner", parent: "root", components: [{ type: "test.Speed", data: { value: 3 } }] },
      { id: "gate", name: "Gate", parent: "root", componentNode: true, components: [{ type: "test.Holder" }] },
    ],
  },
  "prefabs/outer.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "o", name: "Outer" },
      {
        id: "t",
        parent: "o",
        prefab: "prefabs/thing.json",
        overrides: [{ target: ["inner"], component: "test.Speed", field: "value", value: 9 }],
      },
    ],
  },
  "scenes/main.json": {
    format: "myco.scene@1",
    nodes: [
      { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [1, 2, 0] } }] },
      {
        id: "inst",
        prefab: "prefabs/thing.json",
        overrides: [
          { component: "test.Holder", field: "label", value: "overridden" },
          { component: "engine.Transform", field: "position", value: [5, 0, 0] },
        ],
      },
      { id: "nested", prefab: "prefabs/outer.json" },
      { id: "ref", name: "Ref", components: [{ type: "test.Holder", data: { target: { $node: "a" } } }] },
    ],
  },
  "scenes/pathref.json": { format: "myco.scene@1", nodes: [{ id: "h", name: "H", components: [{ type: "test.Holder", data: { target: { $node: "/Persistent" } } }] }] },
  "scenes/other.json": { format: "myco.scene@1", nodes: [{ id: "x", name: "X" }] },
  "scenes/old.json": { format: "myco.scene@0", nodes: [{ id: "y", title: "Old" }] },
  "scenes/future.json": { format: "myco.scene@99", nodes: [] },
  "prefabs/persistent.json": { format: "myco.scene@1", nodes: [{ id: "p", name: "Persistent", transform: false }] },
};

afterEach(() => Assets.clearSources());

async function engineWith(extra: object = {}) {
  return Engine.create({ headless: true, assets: Assets.fromObject(files), ...extra });
}

describe("scene format (ADR 0013, 0016)", () => {
  it("loads scenes as nodes under the World root", async () => {
    const engine = await engineWith();
    const scene = await SceneManager.load("scenes/main.json");
    expect(scene.isSceneNode).toBe(true);
    expect(scene.parent).toBe(engine.world.root);
    expect(scene.find("A")!.transform!.position.toArray()).toEqual([1, 2, 0]);
    expect(scene.find("A")!.scene).toBe(scene);
  });

  it("resolves $node references before awake, scoped to their file", async () => {
    await engineWith();
    const scene = await SceneManager.load("scenes/main.json");
    const ref = scene.find("Ref")!.getBehavior(Holder)!;
    expect(ref.target!.name).toBe("A");
    expect(ref.seenTargetInAwake).toBe("A");
    const thing = scene.children.find((c) => c.name === "Thing")!;
    expect(thing.getBehavior(Holder)!.target!.name).toBe("Inner");
  });

  it("applies prefab overrides, including nested targets", async () => {
    await engineWith();
    const scene = await SceneManager.load("scenes/main.json");
    const thing = scene.children.find((c) => c.name === "Thing")!;
    expect(thing.getBehavior(Holder)!.label).toBe("overridden");
    expect(thing.getBehavior(Holder)!.amount).toBe(2);
    expect(thing.transform!.position.x).toBe(5);
    expect(thing.find("Inner")!.getData(Speed)!.value).toBe(3);
    const nestedInner = scene.find("Outer/Thing/Inner")!;
    expect(nestedInner.getData(Speed)!.value).toBe(9);
  });

  it("supports component nodes and their owner (ADR 0009)", async () => {
    await engineWith();
    const scene = await SceneManager.load("scenes/main.json");
    const thing = scene.children.find((c) => c.name === "Thing")!;
    const gate = thing.find("Gate")!;
    const holder = gate.getBehavior(Holder)!;
    expect(gate.isComponentNode).toBe(true);
    expect(holder.owner).toBe(thing);
    expect(thing.getBehaviors(Holder)).toHaveLength(1);
    expect(thing.getBehaviorInComponents(Holder)).toBe(thing.getBehavior(Holder));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gate.setParent(scene);
    expect(gate.isComponentNode).toBe(false);
    expect(holder.owner).toBe(gate);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("instantiates prefabs at runtime with a position", async () => {
    await engineWith();
    await SceneManager.load("scenes/other.json");
    const node = GameObject.instantiate("prefabs/thing.json", { position: [4, 5, 0] });
    expect(node.name).toBe("Thing");
    expect(node.transform!.position.toArray()).toEqual([4, 5, 0]);
    expect(node.getBehavior(Holder)!.seenTargetInAwake).toBe("Inner");
  });

  it("replaces scenes on non-additive load but keeps persistent nodes", async () => {
    const engine = await engineWith({ project: { autoload: ["prefabs/persistent.json"] } });
    const first = await SceneManager.load("scenes/main.json");
    const hud = await SceneManager.load("scenes/other.json", { additive: true });
    expect(engine.world.sceneNodes).toHaveLength(2);
    const replacement = await SceneManager.load("scenes/other.json");
    expect(first.isValid).toBe(false);
    expect(hud.isValid).toBe(false);
    expect(engine.world.sceneNodes).toEqual([replacement]);
    expect(engine.world.root.children.map((c) => c.name)).toEqual(["Persistent", "other"]);
  });

  it("resolves a $node reference to a persistent node by path from the World root (ADR 0013)", async () => {
    await engineWith({ project: { autoload: ["prefabs/persistent.json"] } });
    const scene = await SceneManager.load("scenes/pathref.json");
    const holder = scene.find("H")!.getBehavior(Holder)!;
    expect(holder.target!.name).toBe("Persistent");
    expect(holder.seenTargetInAwake).toBe("Persistent");
  });

  it("migrates old formats and rejects newer ones", async () => {
    await engineWith();
    registerSceneMigration(0, (f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, name: (n as unknown as { title: string }).title })) }));
    const old = await SceneManager.load("scenes/old.json");
    expect(old.find("Old")).not.toBeNull();
    await expect(SceneManager.load("scenes/future.json")).rejects.toThrow(/newer/);
  });

  it("migrates an old file once per value, not on every read, instance or instantiate", async () => {
    const prefab = { format: "myco.scene@0", nodes: [{ id: "p", title: "Thing" }] };
    const scene = { format: "myco.scene@1", nodes: [{ id: "a", prefab: "prefabs/old.prefab.json" }, { id: "b", prefab: "prefabs/old.prefab.json" }] };
    await engineWith();
    Assets.addSource(Assets.fromObject({ "prefabs/old.prefab.json": prefab, "scenes/twice.json": scene }));
    let runs = 0;
    registerSceneMigration(0, (f) => (runs++, { ...f, nodes: f.nodes.map((n) => ({ ...n, name: (n as unknown as { title: string }).title })) }));
    const loaded = await SceneManager.load("scenes/twice.json");
    expect(loaded.children.map((c) => c.name)).toEqual(["Thing", "Thing"]);
    GameObject.instantiate("prefabs/old.prefab.json");
    GameObject.instantiate("prefabs/old.prefab.json");
    expect(runs).toBe(1);
    // A changed file (its source serves a new value) is migrated again.
    Assets.addSource(Assets.fromObject({ "prefabs/old.prefab.json": { ...prefab, nodes: [{ id: "p", title: "New" }] } }));
    expect(GameObject.instantiate("prefabs/old.prefab.json").name).toBe("New");
    expect(runs).toBe(2);
  });
});

describe("a load that fails half way (B4)", () => {
  const awoken: string[] = [];
  @behavior("test.failedLoad.Waker")
  class Waker extends GameBehavior {
    awake() { awoken.push(this.node.name); }
  }
  const broken = { format: "myco.scene@5", nodes: [{ id: "n1", name: "Partial", components: [{ type: "test.failedLoad.Waker" }] }, { id: "n2", components: [{ type: "nope.Missing" }] }] };
  const fine = { format: "myco.scene@5", nodes: [{ id: "r", name: "Fine", components: [{ type: "test.failedLoad.Waker" }] }] };

  it("leaves nothing of a scene behind, and the next instantiate wakes only its own nodes", async () => {
    awoken.length = 0;
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "bad.scene.json": broken, "fine.prefab.json": fine }) });
    await expect(SceneManager.load("bad.scene.json")).rejects.toThrow(/unknown component type "nope.Missing"/);
    expect(engine.world.root.children.map((c) => c.name)).toEqual([]);
    expect(SceneManager.scenes).toEqual([]);
    GameObject.instantiate("fine.prefab.json");
    expect(awoken).toEqual(["Fine"]);
    expect(GameObject.findObjectsOfType(Waker).map((w) => w.node.name)).toEqual(["Fine"]);
  });

  it("takes back a prefab instantiated half way", async () => {
    awoken.length = 0;
    const engine = await Engine.create({ headless: true, assets: Assets.fromObject({ "bad.prefab.json": { format: "myco.scene@5", nodes: [{ id: "r", name: "Root", components: [{ type: "test.failedLoad.Waker" }] }, { id: "c", parent: "r", components: [{ type: "nope.Missing" }] }] } }) });
    expect(() => GameObject.instantiate("bad.prefab.json")).toThrow(/nope.Missing/);
    expect(engine.world.root.children.map((c) => c.name)).toEqual([]);
    expect(awoken).toEqual([]);
  });
});

describe("a subclass redeclaring a field (B42)", () => {
  @behavior("test.redeclare.Base")
  class Base extends GameBehavior {
    @field(Number) value: unknown = 0;
  }
  @behavior("test.redeclare.Derived")
  class Derived extends Base {
    @field(String) override value: unknown = "";
  }

  it("loads the field as the subclass declares it", async () => {
    const scene = { format: "myco.scene@5", nodes: [{ id: "n", name: "N", components: [{ type: "test.redeclare.Derived", data: { value: "text" } }] }] };
    await Engine.create({ headless: true, assets: Assets.fromObject({ "s.scene.json": scene }) });
    const loaded = await SceneManager.load("s.scene.json");
    expect(loaded.find("N")!.getBehavior(Derived)!.value).toBe("text");
    expect(listComponents(loaded.find("N")!).find((c) => c.type === "test.redeclare.Derived")!.fields.map((f) => [f.name, f.type])).toEqual([["value", String]]);
  });
});

describe("scene files under the engine's former name (ADR 0037)", () => {
  it("reads tranquility.scene@1 as myco.scene@1", async () => {
    const { migrateSceneFile } = await import("../scene/SceneLoader");
    const file = { format: "tranquility.scene@1", nodes: [{ id: "a", name: "A" }] };
    expect(migrateSceneFile(file as never).nodes).toEqual(file.nodes);
  });
});
