import { afterAll, describe, expect, it } from "vitest";
import { BootstrapError, assertValidBootstrap, bootstrapLinks, defaultBootstrap, resolveBootstrap, selectSystems, templateConfig } from "../core/bootstrap";
import { defaultSettings, validateBootstrap } from "../core/settings";
import { _undefineSystem, defineSystem, listSystemCatalog } from "../core/systems";
import type { BootstrapConfig, BootstrapEngine, WorldConfig, WorldHandle } from "../core/worlds";

// ADR 0032, task T4. A fake BootstrapEngine records createWorld calls and the systems each World
// would get, so these tests don't depend on the Engine.

const testSystems = ["t4.Movement", "t4.ServerAI", "t4.ClientFX", "t4.DebugDraw"];
defineSystem({ name: "t4.Movement", phase: "fixedUpdate", worlds: ["default", "local", "client", "server"], run() {} });
defineSystem({ name: "t4.ServerAI", phase: "fixedUpdate", worlds: ["server", "local"], run() {} });
defineSystem({ name: "t4.ClientFX", phase: "update", worlds: ["client", "local"], run() {} });
defineSystem({ name: "t4.DebugDraw", phase: "lateUpdate", worlds: ["default"], run() {} });
afterAll(() => testSystems.forEach(_undefineSystem));

interface Created {
  config: WorldConfig;
  systems: string[];
}

function fakeEngine(templates?: BootstrapConfig["templates"]): BootstrapEngine & { created: Created[] } {
  const created: Created[] = [];
  return {
    created,
    settings: defaultSettings,
    createWorld(config) {
      const resolved = typeof config === "string" ? templateConfig({ worlds: [{ name: "Start" }], templates }, config) : config;
      if (created.some((c) => c.config.name === resolved.name)) throw new Error(`duplicate World "${resolved.name}"`);
      // Only this file's systems, since built-ins (T2) and other tests' systems share the catalog.
      created.push({ config: resolved, systems: selectSystems(resolved, listSystemCatalog()).filter((s) => testSystems.includes(s)) });
      return { name: resolved.name } as WorldHandle;
    },
    findWorld(name) {
      return created.some((c) => c.config.name === name) ? ({ name } as WorldHandle) : null;
    },
  };
}

describe("bootstraps (T4)", () => {
  it("the default bootstrap makes one Default World tagged default and local", async () => {
    const engine = fakeEngine();
    const bootstrap = await resolveBootstrap(undefined);
    expect(bootstrap).toBe(defaultBootstrap);
    await bootstrap(engine);
    expect(engine.created).toEqual([{ config: { name: "Default", tags: ["default", "local"] }, systems: ["t4.Movement", "t4.ServerAI", "t4.ClientFX", "t4.DebugDraw"] }]);
  });

  it("a declarative client+server config makes both Worlds with the systems their tags and selections pick", async () => {
    const config: BootstrapConfig = {
      worlds: [
        { name: "Server", tags: ["server"], tickRate: 30, scenes: ["scenes/arena.scene.json"], systems: { exclude: ["t4.Movement"] } },
        { name: "Client", tags: ["client"], renders: true, input: true, systems: { include: ["t4.DebugDraw"] } },
      ],
      links: [{ from: "Client", to: "Server", transport: "loopback", options: { latency: 0.05 } }],
    };
    const engine = fakeEngine();
    await (await resolveBootstrap(config))(engine);
    expect(engine.created.map((c) => c.config)).toEqual(config.worlds);
    expect(engine.created.map((c) => c.systems)).toEqual([
      ["t4.ServerAI"],
      ["t4.Movement", "t4.ClientFX", "t4.DebugDraw"],
    ]);
    expect(bootstrapLinks(config)).toEqual(config.links);
  });

  it("templates create Worlds at runtime by name", () => {
    const templates = { Match: { tags: ["server"], tickRate: 20 }, Named: { name: "Arena", tags: ["client"] } };
    const engine = fakeEngine(templates);
    engine.createWorld("Match");
    engine.createWorld("Named");
    expect(engine.created).toEqual([
      { config: { name: "Match", tags: ["server"], tickRate: 20 }, systems: ["t4.Movement", "t4.ServerAI"] },
      { config: { name: "Arena", tags: ["client"] }, systems: ["t4.Movement", "t4.ClientFX"] },
    ]);
    expect(() => engine.createWorld("Lobby")).toThrow(/no World template named "Lobby".*Templates: Match, Named/);
  });

  it("validates templates like Worlds, with the name optional", () => {
    const setting = { worlds: [{ name: "A" }], templates: { Good: { tags: ["x"] }, Bad: { tickRate: -1, tags: "server", name: "" } } };
    expect(validateBootstrap(setting)).toEqual([
      'bootstrap.templates["Bad"]: name must be a non-empty string (got "").',
      'bootstrap.templates["Bad"]: tags must be a list of strings (got "server").',
      'bootstrap.templates["Bad"]: tickRate must be a positive number (got -1).',
    ]);
    expect(() => templateConfig(setting as unknown as BootstrapConfig, "Bad")).toThrow(BootstrapError);
    expect(templateConfig(setting as unknown as BootstrapConfig, "Good")).toEqual({ name: "Good", tags: ["x"] });
  });

  it("a code bootstrap from a project script creates the Worlds", async () => {
    const loaded: string[] = [];
    const bootstrap = await resolveBootstrap("scripts/Bootstrap.ts", {
      loadScript: async (path) => {
        loaded.push(path);
        return (engine) => {
          engine.createWorld({ name: "Server", tags: ["server"] });
          if (!engine.findWorld("Client")) engine.createWorld({ name: "Client", tags: ["client"] });
        };
      },
    });
    const engine = fakeEngine();
    await bootstrap(engine);
    expect(loaded).toEqual(["scripts/Bootstrap.ts"]);
    expect(engine.created.map((c) => c.config.name)).toEqual(["Server", "Client"]);
  });

  it("explains that code bootstraps need a script loader, or a function in EngineOptions.bootstrap", async () => {
    await expect(resolveBootstrap("scripts/Bootstrap.ts")).rejects.toThrow(/needs a script loader.*editor provides one.*EngineOptions\.bootstrap/);
    await expect(resolveBootstrap("scripts/Bootstrap.ts", { loadScript: async () => 42 as never })).rejects.toThrow(/must export a function named bootstrap/);
    await expect(resolveBootstrap("")).rejects.toThrow(BootstrapError);
  });

  it("bad configs report what's wrong (duplicate names, unknown systems, links to missing Worlds)", async () => {
    const config = {
      worlds: [
        { name: "Server", tags: ["server"], tickRate: 0, systems: { include: ["t4.Nope"] } },
        { name: "Server", timeScale: "fast", systems: { exclude: ["t4.Gone", "t4.Missing"] } },
        { name: "", tags: [1], tickrate: 60 },
      ],
      links: [
        { from: "Client", to: "Server", transport: "loopback" },
        { from: "Server", to: "Server", transport: "" },
      ],
    } as unknown as BootstrapConfig;
    const engine = fakeEngine();
    const bootstrap = await resolveBootstrap(config);
    const error = await Promise.resolve()
      .then(() => bootstrap(engine))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(BootstrapError);
    expect(engine.created).toEqual([]); // nothing is created from an invalid config
    const problems = (error as BootstrapError).problems;
    const known = listSystemCatalog()
      .map((s) => s.name)
      .join(", ");
    expect(problems).toEqual([
      'bootstrap.worlds[0] ("Server"): tickRate must be a positive number (got 0).',
      `bootstrap.worlds[0] ("Server"): systems.include names an unknown system: "t4.Nope". Known systems: ${known}.`,
      'bootstrap.worlds[1] ("Server"): timeScale must be 0 (paused) or more (got "fast").',
      `bootstrap.worlds[1] ("Server"): systems.exclude names unknown systems: "t4.Gone", "t4.Missing". Known systems: ${known}.`,
      'bootstrap.worlds[1] ("Server"): another World is already named "Server"; World names must be unique.',
      'bootstrap.worlds[2]: unknown key "tickrate" (expected name, tags, tickRate, timeScale, renders, input, scenes, systems, lobby).',
      'bootstrap.worlds[2]: name must be a non-empty string (got "").',
      "bootstrap.worlds[2]: tags must be a list of strings (got [1]).",
      'bootstrap.links[0]: from names the World "Client", which neither bootstrap.worlds nor bootstrap.templates lists.',
      'bootstrap.links[1]: links the World "Server" to itself.',
      'bootstrap.links[1]: transport must be a transport name such as "loopback" (got "").',
    ]);
    expect((error as Error).message).toMatch(/^Invalid bootstrap:\n {2}- /);
  });

  it("reports structural problems in the whole setting", () => {
    expect(validateBootstrap(undefined)).toEqual([]);
    expect(validateBootstrap(() => {})).toEqual([]);
    expect(validateBootstrap("scripts/Bootstrap.ts")).toEqual([]);
    expect(validateBootstrap(7)).toEqual(["bootstrap must be an object listing Worlds, or the path of a bootstrap script (got 7)."]);
    expect(validateBootstrap({ worlds: [] })).toEqual(["bootstrap.worlds must list at least one World."]);
    expect(validateBootstrap({ world: [{ name: "A" }], links: {}, templates: [] })).toEqual([
      'bootstrap: unknown key "world" (expected worlds, links, templates).',
      "bootstrap.worlds must be a list of Worlds (got nothing).",
      "bootstrap.links must be a list of links (got an object).",
      "bootstrap.templates must be an object of World configs by template name (got []).",
    ]);
    expect(validateBootstrap({ worlds: [{ name: "A", systems: { include: ["x"], exclude: ["x"] }, renders: "yes" }] })).toEqual([
      'bootstrap.worlds[0] ("A"): renders must be true or false (got "yes").',
      'bootstrap.worlds[0] ("A"): systems.include and systems.exclude both list "x".',
    ]);
    expect(() => bootstrapLinks({ worlds: [{ name: "A" }], links: [{ from: "A", to: "B", transport: "loopback" }] })).toThrow(/"B", which neither bootstrap\.worlds nor bootstrap\.templates lists/);
    expect(() => assertValidBootstrap({ worlds: [{ name: "A", systems: { include: ["t4.Movement"] } }] })).not.toThrow();
  });

  it("selectSystems throws for unknown include and exclude names instead of ignoring them", () => {
    const catalog = [{ name: "a", phase: "update" as const, worlds: ["default"], builtin: false }];
    expect(() => selectSystems({ name: "W", systems: { include: ["b"], exclude: ["c"] } }, catalog)).toThrow(
      /Invalid systems for the World "W":\n {2}- systems\.include names an unknown system: "b"\. Known systems: a\.\n {2}- systems\.exclude names an unknown system: "c"/,
    );
  });
});
