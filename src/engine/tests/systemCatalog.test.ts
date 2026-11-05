import { describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, defineSystem } from "../index";
import { World } from "../core/World";
import { _undefineSystem, listSystemCatalog } from "../core/systems";
import { worldsMatch } from "../core/worlds";
import "../physics/physics2dSystems";

// ADR 0032, T2 in docs/architecture/worlds-and-netcode-plan.md.

const runs: string[] = [];
const counting = (name: string, worlds: string[]) =>
  defineSystem({ name, phase: "update", worlds, run: (_rows, ctx) => void runs.push(`${name}@${ctx.world.name}`) });

counting("test.cat.Somewhere", ["somewhere"]);
counting("test.cat.Default", ["default"]);

const world = (name: string, tags: string[]) => new World("runtime", {}, { name, tags });

describe("the system catalog (T2)", () => {
  it("lists built-ins for every World and defined systems with their filters", () => {
    const catalog = listSystemCatalog();
    expect(catalog.find((s) => s.name === "engine.UpdateScripts")).toEqual({ name: "engine.UpdateScripts", phase: "update", worlds: ["*"], builtin: true });
    expect(catalog.find((s) => s.name === "engine.PhysicsStep")).toMatchObject({ builtin: true, worlds: ["*"] });
    expect(catalog.find((s) => s.name === "test.cat.Somewhere")).toEqual({ name: "test.cat.Somewhere", phase: "update", worlds: ["somewhere"], builtin: false });
    const builtins = catalog.map((s) => s.builtin);
    expect(builtins).toEqual([...builtins].sort((x, y) => Number(y) - Number(x))); // built-ins first
  });

  it("matches a \"*\" filter against any tags", () => {
    expect(worldsMatch(["*"], ["server"])).toBe(true);
    expect(worldsMatch(["*"], [])).toBe(true);
    expect(worldsMatch(["client", "*"], ["editor"])).toBe(true);
  });

  it("defineSystem only registers; a World runs the catalog systems its tags select", () => {
    const a = world("A", ["somewhere"]);
    const b = world("B", ["elsewhere"]);
    expect(a.systemNames()).toContain("test.cat.Somewhere");
    expect(b.systemNames()).not.toContain("test.cat.Somewhere");
    expect(b.systemNames()).not.toContain("test.cat.Default");
  });

  it("a system added to one World doesn't run in another", () => {
    const a = world("A", ["elsewhere"]);
    const b = world("B", ["elsewhere"]);
    a.addSystem("test.cat.Somewhere");
    runs.length = 0;
    a.scheduler.run("update", 1 / 60);
    b.scheduler.run("update", 1 / 60);
    expect(runs).toEqual(["test.cat.Somewhere@A"]);
    expect(b.systemNames()).not.toContain("test.cat.Somewhere");
  });

  it("removes systems by name, even ones the tags select; adding and removing are idempotent", () => {
    const a = world("A", ["somewhere"]);
    a.removeSystem("test.cat.Somewhere");
    a.removeSystem("test.cat.Somewhere");
    expect(a.systemNames()).not.toContain("test.cat.Somewhere");
    a.addSystem("test.cat.Somewhere");
    a.addSystem("test.cat.Somewhere");
    expect(a.systemNames().filter((n) => n === "test.cat.Somewhere")).toHaveLength(1);
  });

  it("throws for names that aren't in the catalog", () => {
    expect(() => world("A", ["default"]).addSystem("test.cat.Nope")).toThrow(/Unknown system "test.cat.Nope"/);
  });

  it("built-in engine systems are catalog entries a World can leave out", async () => {
    const editor = new World("editor");
    expect(editor.systemNames()).toEqual(expect.arrayContaining(["engine.FixedUpdateScripts", "engine.PhysicsPush", "engine.UpdateScripts", "engine.LateUpdateScripts"]));
    expect(editor.systemNames()).not.toContain("test.cat.Default"); // game systems stay out of the Editor World
    // Physics entries do nothing in a World without a physics world.
    expect(() => editor.scheduler.run("fixedUpdate", 1 / 60)).not.toThrow();

    const engine = await Engine.create({ headless: true });
    let updates = 0;
    class Counter extends GameBehavior {
      update() {
        updates++;
      }
    }
    GameObject.create("c").addBehavior(Counter);
    engine.step(1 / 60);
    expect(updates).toBe(1);
    engine.world.removeSystem("engine.UpdateScripts");
    engine.step(1 / 60);
    expect(updates).toBe(1);
    expect(engine.world.systemNames()).not.toContain("engine.UpdateScripts");
    engine.world.addSystem("engine.UpdateScripts");
    engine.step(1 / 60);
    expect(updates).toBe(2);
    engine.dispose();
  });

  it("systems defined after a World exists join it if its tags match, and leave when undefined", () => {
    const late = world("Late", ["late"]);
    const other = world("Other", ["default"]);
    const removed = world("Removed", ["late"]);
    removed.removeSystem("test.cat.Late");
    expect(late.systemNames()).not.toContain("test.cat.Late");
    counting("test.cat.Late", ["late"]);
    expect(late.systemNames()).toContain("test.cat.Late");
    expect(other.systemNames()).not.toContain("test.cat.Late");
    expect(removed.systemNames()).not.toContain("test.cat.Late");
    _undefineSystem("test.cat.Late");
    expect(late.systemNames()).not.toContain("test.cat.Late");
  });

  it("orders each World's members with after/before, built-ins first by default", () => {
    defineSystem({ name: "test.cat.Before", phase: "update", worlds: ["ordered"], before: ["engine.UpdateScripts"], run() {} });
    defineSystem({ name: "test.cat.After", phase: "update", worlds: ["ordered"], after: ["test.cat.Missing"], run() {} });
    expect(world("O", ["ordered"]).scheduler.order("update")).toEqual(["engine.NetReceive", "engine.ReplicationReceive", "engine.ReplicationInterpolate", "engine.PredictionSmooth", "test.cat.Before", "engine.UpdateScripts", "test.cat.After"]);
  });

  it("the default World keeps today's system order", async () => {
    const engine = await Engine.create({ headless: true });
    // The network systems (ADR 0033) are in every World but do nothing in one that isn't networked.
    // Buoyancy (ADR 0072) runs before the 3D push and does nothing without Buoyancy components.
    // The 3D physics systems (ADR 0045) do nothing in a World without 3D physics.
    expect(engine.world.scheduler.order("fixedUpdate")).toEqual(["engine.NetReceiveTick", "engine.NetInputTick", "engine.PredictionTick", "engine.FixedUpdateScripts", "engine.NavSync", "engine.NavStep", "engine.NavWriteBack", "engine.PhysicsPush", "engine.PhysicsStep", "engine.PhysicsWriteBack", "engine.PhysicsEvents", "engine.Buoyancy", "engine.Physics3DPush", "engine.Physics3DStep", "engine.Physics3DWriteBack", "engine.Physics3DEvents"]);
    expect(engine.world.scheduler.order("update")).toEqual(["engine.NetReceive", "engine.ReplicationReceive", "engine.ReplicationInterpolate", "engine.PredictionSmooth", "engine.UpdateScripts", "test.cat.Default"]);
    expect(engine.world.scheduler.order("lateUpdate")).toEqual(["engine.LateUpdateScripts", "engine.NetInputSend", "engine.ReplicationSend", "engine.NetSend", "engine.Audio"]);
    engine.dispose();
  });
});
