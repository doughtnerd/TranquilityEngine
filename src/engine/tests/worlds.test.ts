import { describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, behavior, field, getComponentOptions, getFields } from "../index";
import { resolveSettings } from "../core/settings";
import { World } from "../core/World";
import { DEFAULT_WORLD_TAGS, worldsMatch } from "../core/worlds";

// ADR 0032. The contract (wave 0) is tested here; each `todo` is a task's "done when" from
// docs/architecture/worlds-and-netcode-plan.md, for the implementer to fill in.

describe("the World contract (C1)", () => {
  it("names and tags Worlds, from their kind until tags replace it", () => {
    expect(new World("runtime")).toMatchObject({ name: "Default", worldTags: DEFAULT_WORLD_TAGS });
    expect(new World("editor").worldTags).toEqual(["editor"]);
    expect(new World("runtime", {}, { name: "Client", tags: ["client"] })).toMatchObject({ name: "Client", worldTags: ["client"] });
  });

  it("matches worlds filters against World tags", () => {
    expect(worldsMatch(undefined, ["default", "local"])).toBe(true);
    expect(worldsMatch(undefined, ["server"])).toBe(false);
    expect(worldsMatch(["server", "local"], ["server"])).toBe(true);
    expect(worldsMatch(["client"], ["server"])).toBe(false);
  });

  it("gives behaviors their World's clock as this.time", async () => {
    const engine = await Engine.create({ headless: true });
    class Clocked extends GameBehavior {}
    const c = GameObject.create("c").addBehavior(Clocked);
    engine.step(0.25);
    expect(c.time).toBe(engine.world.time);
    expect(c.time.time).toBeCloseTo(0.25);
    engine.dispose();
  });

  it("keeps project.json's bootstrap setting for the bootstrap to read", () => {
    const config = { worlds: [{ name: "Server", tags: ["server"] }] };
    expect(resolveSettings({ bootstrap: config }).bootstrap).toBe(config);
    expect(resolveSettings({}).bootstrap).toBeUndefined();
  });

  it("stubs the runtime World API until T1", async () => {
    const engine = await Engine.create({ headless: true });
    expect(() => engine.createWorld({ name: "Match" })).toThrow(/T1/);
    expect(() => Engine.findWorld("Match")).toThrow(/T1/);
    engine.dispose();
  });
});

describe("component and field options (C2)", () => {
  it("records per-World components and replicated fields", () => {
    @behavior("test.ServerOnlyAI", { worlds: ["server", "local"] })
    class ServerOnlyAI extends GameBehavior {
      @field(Number, { replicate: true, quantize: 0.01 }) speed = 1;
      @field(Number) local = 0;
    }
    expect(getComponentOptions(ServerOnlyAI)).toEqual({ worlds: ["server", "local"] });
    expect(getFields(ServerOnlyAI)).toEqual([
      { name: "speed", type: Number, options: { replicate: true, quantize: 0.01 } },
      { name: "local", type: Number },
    ]);
  });
});

describe("several Worlds per Engine (T1)", () => {
  it.todo("steps two Worlds at 30 and 60 Hz independently in one loop, each with its own accumulator");
  it.todo("pauses one World without stopping the other");
  it.todo("makes the stepping World current: Time and SceneManager act on it, and throw outside any World's frame");
  it.todo("creates, finds and destroys a World at runtime through a handle that doesn't expose its nodes");
  it.todo("keeps engine.world as the default World, so single-World games behave as before");
});

describe("the system catalog (T2)", () => {
  it.todo("defineSystem only registers; a World runs the systems added to it");
  it.todo("a system added to one World doesn't run in another");
  it.todo("built-in engine systems are catalog entries a World can leave out");
  it.todo("the default bootstrap reproduces today's system order");
});

describe("isolation (T3)", () => {
  it.todo("two Worlds in one Engine share no nodes, data, buffers or physics");
  it.todo("assigning a node from another World to a field throws, and so does reparenting across Worlds");
  it.todo("local input reaches only Worlds that take input");
});

describe("bootstraps (T4)", () => {
  it.todo("the default bootstrap makes one Default World tagged default and local");
  it.todo("a declarative client+server config makes both Worlds with the systems their tags and selections pick");
  it.todo("templates create Worlds at runtime by name");
  it.todo("a code bootstrap from a project script creates the Worlds");
  it.todo("bad configs report what's wrong (duplicate names, unknown systems, links to missing Worlds)");
});

describe("bootstrap contract (C1)", () => {
  it("selects catalog systems by tags, include and exclude", async () => {
    const { selectSystems } = await import("../core/bootstrap");
    const catalog = [
      { name: "a", phase: "update" as const, worlds: ["default", "local"], builtin: false },
      { name: "srv", phase: "update" as const, worlds: ["server"], builtin: false },
      { name: "dbg", phase: "update" as const, worlds: ["default"], builtin: false },
    ];
    expect(selectSystems({ name: "D" }, catalog)).toEqual(["a", "dbg"]);
    expect(selectSystems({ name: "S", tags: ["server"], systems: { include: ["a"] } }, catalog)).toEqual(["a", "srv"]);
    expect(selectSystems({ name: "D", systems: { exclude: ["dbg"] } }, catalog)).toEqual(["a"]);
  });

  it("resolves the default and function bootstraps; declarative and script ones wait for T4", async () => {
    const { defaultBootstrap, resolveBootstrap } = await import("../core/bootstrap");
    expect(await resolveBootstrap(undefined)).toBe(defaultBootstrap);
    const custom = () => {};
    expect(await resolveBootstrap(custom)).toBe(custom);
    await expect(resolveBootstrap({ worlds: [] })).rejects.toThrow(/T4/);
  });
});
