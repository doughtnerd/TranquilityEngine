// The Physics plugin (ADR 0135, 0137): its 3D World service, started by its Components, with the engine's one
// lifecycle. This file's first test must run before Rapier 3D has loaded in it (Vitest isolates files).
import { describe, expect, it, vi } from "vitest";
import { Assets, BoxCollider, Engine, GameObject, RigidBody, SceneManager } from "../../myco";
import { listSystemCatalog } from "../../engine/core/systems";
import { _startWorldServicesForScene } from "../../engine/core/worldServices";
import { RUNTIME_PLUGINS } from "../runtime";
import { physicsRuntimePlugin } from "./runtime";
import { listComponentIds } from "../../engine/core/registry";
import { pluginOfComponent } from "../runtimeContext";
import { physicsDimensionOf, type PhysicsDimension } from "./runtime";
import { PHYSICS_2D_SERVICE, PHYSICS_3D_SERVICE } from "./runtime/dimensions";
import { physics3DOf } from "./runtime/systems3d";

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

describe("the Physics plugin's 3D service (ADR 0135, 0137)", () => {
  it("never gives a World destroyed while Rapier loads a physics world", async () => {
    Assets.clearSources();
    const a = await Engine.create({ headless: true });
    const worldA = a.world;
    GameObject.create("body").addBehavior(RigidBody); // starts loading Rapier 3D
    expect(physics3DOf(worldA)).toBeNull();
    a.dispose(); // torn down mid-load
    const b = await Engine.create({ headless: true });
    GameObject.create("body").addBehavior(RigidBody); // the same load, now finished
    await vi.waitFor(() => expect(physics3DOf(b.world)).not.toBeNull());
    expect(physics3DOf(worldA)).toBeNull();
    b.dispose();
  });

  it("starts when a RigidBody attaches at runtime in a World whose scene had none (an instantiated prefab)", async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "empty.json": { format: "myco.scene@1", nodes: [] },
        "crate.prefab.json": { format: "myco.scene@2", nodes: [{ id: "r", name: "Crate", components: [{ type: "engine.RigidBody" }, { type: "engine.BoxCollider" }] }] },
      }),
    );
    const engine = await Engine.create({ headless: true });
    await SceneManager.load("empty.json");
    expect(physics3DOf(engine.world)).toBeNull();
    const crate = GameObject.instantiate("crate.prefab.json");
    crate.transform!.position.y = 5;
    await vi.waitFor(() => expect(physics3DOf(engine.world)).not.toBeNull());
    steps(engine, 30);
    expect(crate.transform!.position.y).toBeLessThan(5); // it falls
    expect(crate.getComponent(BoxCollider)).not.toBeNull();
    engine.dispose();
  });

  it("is a first-party runtime half with its service, systems and the scene scan's rules", async () => {
    expect(RUNTIME_PLUGINS).toContain(physicsRuntimePlugin); // its service: the scenes below start it
    expect(listSystemCatalog().find((s) => s.name === "engine.Physics3DStep")).toMatchObject({ builtin: true, worlds: ["*"] });
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "bodies.json": { format: "myco.scene@1", nodes: [{ id: "a", components: [{ type: "engine.RigidBody" }] }] },
        "bodies2d.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [{ id: "a", components: [{ type: "engine.RigidBody" }] }] },
      }),
    );
    // Loading a scene starts the services it needs: physics runs in a fresh World only when the scene needs it.
    // (The scene scan alone: a scene's RigidBody would start the service anyway as it attaches.)
    const needs = async (path: string, settings?: Record<string, unknown>) => {
      const engine = await Engine.create({ headless: true });
      await _startWorldServicesForScene(engine.world, { path, settings, componentTypes: () => (path === "none" ? [] : ["engine.RigidBody"]) });
      const started = physics3DOf(engine.world) !== null;
      engine.dispose();
      return started;
    };
    expect(await needs("bodies.json")).toBe(true); // saying nothing, with a body
    expect(await needs("bodies2d.json", { physics: "2d" })).toBe(false); // another dimension chosen
    expect(await needs("none", { physics: "3d" })).toBe(true); // saying so
    expect(await needs("none")).toBe(false);
  });
});

describe("one description per physics dimension (ADR 0283)", () => {
  it("puts every physics Component in exactly one dimension, Buoyancy in none, and derives the services and systems from them", () => {
    const physicsIds = listComponentIds().filter((id) => pluginOfComponent(id) === "myco.physics");
    const ids2d = PHYSICS_2D_SERVICE.neededBy?.components ?? [];
    const ids3d = PHYSICS_3D_SERVICE.neededBy?.components ?? [];
    expect([...ids2d, ...ids3d, "engine.Buoyancy"].sort()).toEqual([...physicsIds].sort());
    expect(new Set([...ids2d, ...ids3d]).size).toBe(ids2d.length + ids3d.length);
    const table: [string, PhysicsDimension | null][] = [
      ["engine.RigidBody2D", "2d"],
      ["engine.ShapeCollider2D", "2d"],
      ["engine.SpringJoint2D", "2d"],
      ["engine.RigidBody", "3d"],
      ["engine.MeshCollider", "3d"],
      ["engine.CharacterController", "3d"],
      ["engine.Buoyancy", null],
      ["engine.Camera", null],
    ];
    for (const [type, dimension] of table) {
      expect(physicsDimensionOf(type), type).toBe(dimension);
      expect(ids2d.includes(type), type).toBe(dimension === "2d");
      expect(ids3d.includes(type), type).toBe(dimension === "3d");
    }
    expect(PHYSICS_2D_SERVICE.neededBy).toMatchObject({ sceneSetting: { physics: "2d" }, exceptSceneSetting: { physics: ["3d", "none"] } });
    expect(PHYSICS_3D_SERVICE.neededBy).toMatchObject({ sceneSetting: { physics: "3d" }, exceptSceneSetting: { physics: ["2d", "none"] } });
    // Five systems each; 3D pushes after 2D's events (ADR 0011).
    const names = listSystemCatalog().map((s) => s.name);
    for (const stem of ["engine.Physics", "engine.Physics3D"]) {
      for (const step of ["RestoreInterpolated", "Push", "Step", "WriteBack", "Events"]) expect(names, stem + step).toContain(stem + step);
    }
  });
});
