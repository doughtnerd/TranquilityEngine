// World services (ADR 0135): the engine's one lifecycle for lazily loaded per-World subsystems,
// proved with a fake service.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Component, Engine, GameObject, SceneManager, component, defineWorldService, worldService } from "../index";
import { _registerWorldService, _startWorldService, type WorldServiceDef } from "../core/worldServices";
import { World } from "../core/World";
import { _worldOf } from "../core/WorldHandle";

@component("test.ws.Needy")
class Needy extends Component {}
@component("test.ws.Other")
class Other extends Component {}

interface Fake {
  world: World;
  disposed: boolean;
}

/** A controllable fake service: each `load()` waits until the test resolves or rejects it. */
function fakeService(id: string, neededBy: WorldServiceDef["neededBy"], log: string[]) {
  const loads: { resolve(v: string): void; reject(e: unknown): void }[] = [];
  const def: WorldServiceDef<string, Fake> = {
    id,
    neededBy,
    load: () => new Promise<string>((resolve, reject) => loads.push({ resolve, reject })),
    create: (world, loaded) => (log.push(`create ${id} ${loaded}`), { world, disposed: false }),
    dispose: (f) => (log.push(`dispose ${id}`), (f.disposed = true)),
  };
  return { def, loads };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Until `loads` has `n` pending loads (a scene load awaits other subsystems, such as Rapier, first). */
async function loadsReach(loads: unknown[], n = 1): Promise<void> {
  for (let i = 0; i < 500 && loads.length < n; i++) await new Promise((r) => setTimeout(r, 5));
}

let engine: Engine;
let undo: (() => void)[] = [];
let log: string[] = [];

beforeEach(async () => {
  log = [];
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "empty.json": { format: "myco.scene@1", nodes: [] },
      "needy.json": { format: "myco.scene@1", nodes: [{ id: "a", name: "A", components: [{ type: "test.ws.Needy" }] }] },
      "viaPrefab.json": { format: "myco.scene@1", nodes: [{ id: "p", name: "P", prefab: "needy.prefab.json" }] },
      "needy.prefab.json": { format: "myco.scene@2", nodes: [{ id: "r", name: "R", components: [{ type: "test.ws.Needy" }] }] },
      "twoD.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] },
    }),
  );
  engine = await Engine.create({ headless: true });
});

afterEach(() => {
  engine.dispose();
  for (const u of undo.splice(0)) u();
});

const register = (def: WorldServiceDef<string, Fake>) => undo.push(_registerWorldService(def));

describe("World services (ADR 0135)", () => {
  it("starts when a loaded scene has a Component that needs it, before the scene is instantiated", async () => {
    const { def, loads } = fakeService("t.scene", { components: ["test.ws.Needy"] }, log);
    register(def);
    const loading = SceneManager.load("needy.json");
    await tick();
    expect(loads).toHaveLength(1);
    expect(engine.world.service("t.scene")).toBeNull();
    loads[0]!.resolve("L");
    await loading;
    expect(engine.world.service<Fake>("t.scene")?.world).toBe(engine.world);
    expect(log).toEqual(["create t.scene L"]);
  });

  it("finds Components in instanced prefabs, and starts on a scene setting", async () => {
    const a = fakeService("t.prefab", { components: ["test.ws.Needy"] }, log);
    const b = fakeService("t.setting", { sceneSetting: { physics: "2d" } }, log);
    register(a.def);
    register(b.def);
    const p = SceneManager.load("viaPrefab.json");
    await tick();
    a.loads[0]!.resolve("A");
    await p;
    expect(b.loads).toHaveLength(0);
    const q = SceneManager.load("twoD.json");
    await loadsReach(b.loads);
    b.loads[0]!.resolve("B");
    await q;
    expect(log).toEqual(["create t.prefab A", "create t.setting B"]);
  });

  it("doesn't start for a scene that doesn't need it", async () => {
    const { def, loads } = fakeService("t.none", { components: ["test.ws.Needy"] }, log);
    register(def);
    await SceneManager.load("empty.json");
    expect(loads).toHaveLength(0);
    expect(engine.world.service("t.none")).toBeNull();
  });

  it("starts when a needing Component attaches, and at once once loaded", async () => {
    const { def, loads } = fakeService("t.attach", { components: ["test.ws.Needy"] }, log);
    register(def);
    await SceneManager.load("empty.json");
    GameObject.create("x").addComponent(Other);
    expect(loads).toHaveLength(0);
    GameObject.create("y").addComponent(Needy);
    GameObject.create("z").addComponent(Needy); // one load, one start
    expect(loads).toHaveLength(1);
    loads[0]!.resolve("L");
    await tick();
    expect(engine.world.service("t.attach")).not.toBeNull();
    expect(log).toEqual(["create t.attach L"]);

    // Loaded once per page: another World creates its instance synchronously on attach.
    const otherWorld = _worldOf(engine.createWorld({ name: "Second" }))!;
    World._runIn(otherWorld, () => GameObject.create("w").addComponent(Needy));
    expect(loads).toHaveLength(1);
    expect(otherWorld.service("t.attach")).not.toBeNull();
    expect(log).toEqual(["create t.attach L", "create t.attach L"]);
  });

  it("drops a load that finishes after the World was destroyed", async () => {
    const { def, loads } = fakeService("t.destroyed", { components: ["test.ws.Needy"] }, log);
    register(def);
    const world = engine.world;
    const started = _startWorldService(world, "t.destroyed");
    engine.dispose();
    loads[0]!.resolve("late");
    expect(await started).toBeNull();
    expect(world.service("t.destroyed")).toBeNull();
    expect(log).toEqual([]);
  });

  it("retries a failed load at the next need", async () => {
    const { def, loads } = fakeService("t.retry", { components: ["test.ws.Needy"] }, log);
    register(def);
    const first = _startWorldService(engine.world, "t.retry");
    loads[0]!.reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    expect(engine.world.service("t.retry")).toBeNull();
    const second = _startWorldService(engine.world, "t.retry");
    expect(loads).toHaveLength(2);
    loads[1]!.resolve("ok");
    expect(await second).not.toBeNull();
    expect(log).toEqual(["create t.retry ok"]);
  });

  it("disposes in reverse start order when the World is torn down", async () => {
    const a = fakeService("t.a", { components: ["test.ws.Needy"] }, log);
    const b = fakeService("t.b", { components: ["test.ws.Other"] }, log);
    register(a.def);
    register(b.def);
    const pb = _startWorldService(engine.world, "t.b");
    b.loads[0]!.resolve("1");
    await pb;
    const pa = _startWorldService(engine.world, "t.a");
    a.loads[0]!.resolve("2");
    await pa;
    engine.dispose();
    expect(log).toEqual(["create t.b 1", "create t.a 2", "dispose t.a", "dispose t.b"]);
  });

  it("disposes running instances when the service is unregistered, and isn't started by an editor World", async () => {
    const { def, loads } = fakeService("t.unreg", { components: ["test.ws.Needy"] }, log);
    const remove = _registerWorldService(def);
    const p = _startWorldService(engine.world, "t.unreg");
    loads[0]!.resolve("L");
    const instance = (await p) as Fake;
    remove();
    expect(instance.disposed).toBe(true);
    expect(engine.world.service("t.unreg")).toBeNull();

    const editor = await Engine.create({ kind: "editor", headless: true });
    try {
      const again = fakeService("t.editor", { components: ["test.ws.Needy"] }, log);
      register(again.def);
      expect(await _startWorldService(editor.world, "t.editor")).toBeNull();
      expect(again.loads).toHaveLength(0);
    } finally {
      editor.dispose();
    }
  });

  it("looks a service up by a typed key, in the current World or a handle's", async () => {
    const { def, loads } = fakeService("t.key", { worldTags: ["default"] }, log);
    register(def);
    const Key = defineWorldService<Fake>("t.key");
    expect(worldService(engine.world as never, Key)).toBeNull();
    const p = SceneManager.load("empty.json"); // the default World's tag needs it
    await tick();
    loads[0]!.resolve("L");
    await p;
    expect(worldService(engine.world as never, Key)?.world).toBe(engine.world);
    const handle = engine.worlds()[0]!;
    expect(worldService(handle, Key)?.world).toBe(engine.world);
  });
});
