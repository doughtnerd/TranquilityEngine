import { describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, behavior, defineSystem, field, getComponentOptions, getFields } from "../index";
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

  it("resolves the default and function bootstraps", async () => {
    const { defaultBootstrap, resolveBootstrap } = await import("../core/bootstrap");
    expect(await resolveBootstrap(undefined)).toBe(defaultBootstrap);
    const custom = () => {};
    expect(await resolveBootstrap(custom)).toBe(custom);
  });
});

// Wave 1 together (T1 Engine, T2 catalog, T4 bootstraps): each task's own tests are in
// engineWorlds, systemCatalog, isolation and bootstrap.test.ts.
describe("a declarative client+server bootstrap (wave 1)", () => {
  it("creates both Worlds, each running the systems its tags pick, at its own tick rate", async () => {
    const ran: string[] = [];
    defineSystem({ name: "test.wave1.Server", phase: "fixedUpdate", worlds: ["server"], run: (_rows, ctx) => void ran.push(`server@${ctx.world.name}`) });
    defineSystem({ name: "test.wave1.Client", phase: "update", worlds: ["client"], run: (_rows, ctx) => void ran.push(`client@${ctx.world.name}`) });
    const engine = await Engine.create({
      headless: true,
      bootstrap: {
        worlds: [
          { name: "Client", tags: ["client"] },
          { name: "Server", tags: ["server"], tickRate: 30 },
        ],
        templates: { Match: { tags: ["server"], tickRate: 20 } },
      },
    });
    expect(engine.world.name).toBe("Client");
    expect(engine.worlds().map((w) => w.name)).toEqual(["Client", "Server"]);
    expect(engine.findWorld("Server")!.systems()).toContain("test.wave1.Server");
    expect(engine.findWorld("Client")!.systems()).not.toContain("test.wave1.Server");
    engine.step(1 / 30);
    expect(ran).toEqual(["client@Client", "server@Server"]); // Worlds step in creation order

    const match = engine.createWorld("Match");
    expect(match.name).toBe("Match");
    expect(match.systems()).toContain("test.wave1.Server");
    engine.dispose();
  });

  it("reports every problem in a bad bootstrap before creating any World", async () => {
    const error = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "A" }, { name: "A", tickRate: 0 }] } }).catch((e: unknown) => e);
    expect((error as { problems: string[] }).problems).toEqual([
      expect.stringMatching(/tickRate must be a positive number/),
      expect.stringMatching(/World names must be unique/),
    ]);
  });
});
