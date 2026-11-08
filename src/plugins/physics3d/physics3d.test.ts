// The Physics 3D plugin (ADR 0135): a World service started by its Components, with the engine's one
// lifecycle. This file's first test must run before Rapier 3D has loaded in it (Vitest isolates files).
import { describe, expect, it, vi } from "vitest";
import { Assets, BoxCollider, Engine, GameObject, RigidBody, SceneManager } from "../../myco";
import { listSystemCatalog } from "../../engine/core/systems";
import { _servicesNeededBy, _startWorldService, _worldServiceIds } from "../../engine/core/worldServices";
import { RUNTIME_PLUGINS } from "../runtime";
import { physics3dRuntimePlugin } from "./runtime";
import { PHYSICS_3D, physics3DOf } from "./runtime/physics3d";

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

describe("the Physics 3D plugin (ADR 0135)", () => {
  it("never gives a World destroyed while Rapier loads a physics world", async () => {
    Assets.clearSources();
    const a = await Engine.create({ headless: true });
    const worldA = a.world;
    GameObject.create("body").addBehavior(RigidBody); // starts loading Rapier 3D
    expect(physics3DOf(worldA)).toBeNull();
    a.dispose(); // torn down mid-load
    const b = await Engine.create({ headless: true });
    expect(await _startWorldService(b.world, PHYSICS_3D)).not.toBeNull(); // the same load, now finished
    expect(physics3DOf(b.world)).not.toBeNull();
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
    expect(RUNTIME_PLUGINS).toContain(physics3dRuntimePlugin);
    expect(_worldServiceIds()).toContain(PHYSICS_3D);
    expect(listSystemCatalog().find((s) => s.name === "engine.Physics3DStep")).toMatchObject({ builtin: true, worlds: ["*"] });
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "bodies.json": { format: "myco.scene@1", nodes: [{ id: "a", components: [{ type: "engine.RigidBody" }] }] },
        "bodies2d.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [{ id: "a", components: [{ type: "engine.RigidBody" }] }] },
      }),
    );
    const engine = await Engine.create({ headless: true });
    const needs = (path: string, settings?: Record<string, unknown>) => _servicesNeededBy(engine.world, { path, settings, componentTypes: () => (path === "none" ? [] : ["engine.RigidBody"]) }).includes(PHYSICS_3D);
    expect(needs("bodies.json")).toBe(true); // saying nothing, with a body
    expect(needs("bodies2d.json", { physics: "2d" })).toBe(false); // another dimension chosen
    expect(needs("none", { physics: "3d" })).toBe(true); // saying so
    expect(needs("none")).toBe(false);
    engine.dispose();
  });
});
