import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, SceneManager, Time, defineSystem, type WorldConfig } from "../index";
import { _undefineSystem } from "../core/systems";
import { World } from "../core/World";
import { _worldOf } from "../core/WorldHandle";

// ADR 0032, T1: several Worlds per Engine, each with its own clock, stepped in one loop.

const files: Record<string, unknown> = {
  "scenes/arena.scene.json": { format: "myco.scene@1", nodes: [{ id: "floor", name: "Floor" }] },
  "scenes/hud.scene.json": { format: "myco.scene@1", nodes: [{ id: "score", name: "Score" }] },
};

/** What a probe system saw in each World, by World name. */
interface Seen {
  fixedSteps: number;
  frames: number;
  fixedDeltaTime: number;
  current: boolean;
  scenes: string[];
}

let seen: Record<string, Seen>;
const PROBE_FIXED = "test.engineWorlds.fixedProbe";
const PROBE_UPDATE = "test.engineWorlds.updateProbe";
const probeWorlds = ["default", "local", "client", "server"];

function entry(name: string): Seen {
  return (seen[name] ??= { fixedSteps: 0, frames: 0, fixedDeltaTime: 0, current: true, scenes: [] });
}

beforeEach(() => {
  seen = {};
  Assets.addSource(Assets.fromObject(files));
  defineSystem({
    name: PROBE_FIXED,
    phase: "fixedUpdate",
    worlds: probeWorlds,
    run(_rows, ctx) {
      const s = entry(ctx.world.name);
      s.fixedSteps++;
      s.fixedDeltaTime = Time.fixedDeltaTime;
      s.current &&= World.active === ctx.world;
    },
  });
  defineSystem({
    name: PROBE_UPDATE,
    phase: "update",
    worlds: probeWorlds,
    run(_rows, ctx) {
      const s = entry(ctx.world.name);
      s.frames++;
      s.current &&= World.active === ctx.world && Time.frameCount === ctx.time.frameCount;
      s.scenes = SceneManager.scenes.map((n) => n.name);
    },
  });
});

afterEach(() => {
  _undefineSystem(PROBE_FIXED);
  _undefineSystem(PROBE_UPDATE);
  Assets.clearSources();
});

const clientServer = (server: Partial<WorldConfig> = {}, client: Partial<WorldConfig> = {}) =>
  Engine.create({
    headless: true,
    bootstrap: (engine) => {
      engine.createWorld({ name: "Server", tags: ["server"], tickRate: 30, ...server });
      engine.createWorld({ name: "Client", tags: ["client"], tickRate: 60, ...client });
    },
  });

describe("several Worlds per Engine (T1)", () => {
  it("steps two Worlds at 30 and 60 Hz independently in one loop, each with its own accumulator", async () => {
    const engine = await clientServer();
    expect(engine.worlds().map((w) => w.name)).toEqual(["Server", "Client"]);

    engine.step(1 / 60);
    expect(entry("Server").fixedSteps).toBe(0); // half a server tick: no fixedUpdate this frame
    expect(entry("Client").fixedSteps).toBe(1);
    engine.step(1 / 60);
    expect(entry("Server").fixedSteps).toBe(1);
    expect(entry("Client").fixedSteps).toBe(2);

    for (let i = 0; i < 58; i++) engine.step(1 / 60);
    expect(entry("Server")).toMatchObject({ fixedSteps: 30, frames: 60, fixedDeltaTime: 1 / 30 });
    expect(entry("Client")).toMatchObject({ fixedSteps: 60, frames: 60, fixedDeltaTime: 1 / 60 });
    engine.dispose();
  });

  it("applies a World's time scale to its clock only", async () => {
    const engine = await clientServer({ timeScale: 0.5 });
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(entry("Server").fixedSteps).toBe(15);
    expect(entry("Client").fixedSteps).toBe(60);
    engine.dispose();
  });

  it("pauses one World without stopping the other", async () => {
    const engine = await clientServer();
    const server = engine.findWorld("Server")!;
    server.pause();
    expect(server.paused).toBe(true);
    for (let i = 0; i < 10; i++) engine.step(1 / 60);
    expect(seen.Server).toBeUndefined(); // a paused World skips its frames entirely
    expect(entry("Client").frames).toBe(10);

    server.resume();
    engine.step(1 / 60);
    expect(entry("Server").frames).toBe(1);
    expect(entry("Client").frames).toBe(11);
    engine.dispose();
  });

  it("makes the stepping World current: Time and SceneManager act on it", async () => {
    const engine = await clientServer({ scenes: ["scenes/arena.scene.json"] }, { scenes: ["scenes/hud.scene.json"] });
    engine.step(1 / 30);
    expect(entry("Server")).toMatchObject({ current: true, scenes: ["arena"], fixedDeltaTime: 1 / 30 });
    expect(entry("Client")).toMatchObject({ current: true, scenes: ["hud"], fixedDeltaTime: 1 / 60 });
    // Outside a frame, the default World is current, as with one World.
    expect(World.active).toBe(engine.world);
    expect(SceneManager.scenes.map((n) => n.name)).toEqual(["arena"]);
    engine.dispose();
  });

  it("creates, finds and destroys a World at runtime through a handle that doesn't expose its nodes", async () => {
    const engine = await Engine.create({ headless: true });
    const match = Engine.createWorld({ name: "Match", tags: ["server"], scenes: ["scenes/arena.scene.json"] });
    expect(match).toMatchObject({ name: "Match", tags: ["server"], alive: true, paused: false });
    expect(match.hasTag("server")).toBe(true);
    expect(Engine.findWorld("Match")).toBe(match);
    expect(engine.worlds().map((w) => w.name)).toEqual(["Default", "Match"]);
    expect(() => engine.createWorld({ name: "Match" })).toThrow(/already a World named "Match"/);

    // No path from the handle to the World or its nodes.
    expect(Object.keys(match)).toEqual(["_alive"]);
    expect((match as unknown as Record<string, unknown>).root).toBeUndefined();
    expect((match as unknown as Record<string, unknown>).world).toBeUndefined();

    await new Promise((r) => setTimeout(r, 0)); // its start-up scene loads in the background
    await match.loadScene("scenes/hud.scene.json", { additive: true });
    engine.step(1 / 60);
    expect(entry("Match").scenes).toEqual(["arena", "hud"]);
    expect(SceneManager.scenes).toEqual([]); // nothing leaked into the default World
    expect(Array.isArray(match.systems())).toBe(true);

    const frames = entry("Match").frames;
    match.destroy();
    expect(match.alive).toBe(false);
    expect(Engine.findWorld("Match")).toBeNull();
    expect(() => match.pause()).toThrow(/destroyed/);
    engine.step(1 / 60);
    expect(entry("Match").frames).toBe(frames); // no longer stepped
    expect(entry("Default").frames).toBe(2);
    engine.dispose();
  });

  it("tears a World down at the end of its frame when it's destroyed mid-frame", async () => {
    const engine = await Engine.create({ headless: true });
    const match = engine.createWorld({ name: "Match", tags: ["server"] });
    let destroyed = 0;
    class SelfDestruct extends GameBehavior {
      update() {
        Engine.findWorld("Match")!.destroy();
        expect(this.node.isValid).toBe(true); // still there until the frame ends
      }
      onDestroy() {
        destroyed++;
      }
    }
    // Put a behavior in Match by creating it during Match's own frame (Match is current then).
    let added = false;
    defineSystem({
      name: "test.engineWorlds.adder",
      phase: "update",
      worlds: ["server"],
      run(_rows, ctx) {
        if (ctx.world.name === "Match" && !added) {
          added = true;
          GameObject.create("bomb").addBehavior(SelfDestruct);
        }
      },
    });
    try {
      engine.step(1 / 60); // adds the behavior
      engine.step(1 / 60); // starts it
      engine.step(1 / 60); // update destroys Match
      expect(match.alive).toBe(false);
      expect(destroyed).toBe(1);
      expect(World.active).toBe(engine.world);
    } finally {
      _undefineSystem("test.engineWorlds.adder");
      engine.dispose();
    }
  });

  it("keeps engine.world as the default World, so single-World games behave as before", async () => {
    const engine = await Engine.create({ headless: true });
    expect(engine.world).toMatchObject({ name: "Default", worldTags: ["default", "local"], kind: "runtime" });
    expect(World.active).toBe(engine.world);
    expect(engine.worlds().map((w) => w.name)).toEqual(["Default"]);
    const bird = GameObject.create("bird"); // outside a frame: the default World
    expect(bird.world).toBe(engine.world);
    engine.step(1 / 60);
    expect(entry("Default").fixedSteps).toBe(1);
    expect(() => engine.findWorld("Default")!.destroy()).toThrow(/last World/);
    engine.dispose();
    expect(World.active).toBeNull();

    const editor = await Engine.create({ headless: true, kind: "editor" });
    expect(editor.world).toMatchObject({ name: "Editor", worldTags: ["editor"], kind: "editor" });
    editor.dispose();
  });

  it("gives a behaviour its own World's handle as this.world (ADR 0132)", async () => {
    class Probe extends GameBehavior {}
    const engine = await Engine.create({ headless: true });
    const match = engine.createWorld({ name: "Match", tags: ["local"] });
    const inDefault = GameObject.create("a").addBehavior(Probe);
    expect(inDefault.world).toBe(engine.findWorld("Default"));
    const inMatch = World._runIn(_worldOf(match)!, () => GameObject.create("b").addBehavior(Probe));
    expect(inMatch.world).toBe(match);
    expect(inMatch.world.name).toBe("Match");
    engine.dispose();

    const bare = new World();
    const orphan = World._runIn(bare, () => GameObject.create("c").addBehavior(Probe));
    expect(() => orphan.world).toThrow(/has no handle/);
  });

  it("moves engine.world to the next World when the default one is destroyed", async () => {
    const engine = await clientServer();
    expect(engine.world.name).toBe("Server");
    engine.findWorld("Server")!.destroy();
    expect(engine.world.name).toBe("Client");
    expect(World.active).toBe(engine.world);
    engine.dispose();
  });

  it("creates Worlds from the project's templates by name", async () => {
    const engine = await Engine.create({
      headless: true,
      project: { bootstrap: { worlds: [], templates: { Match: { tags: ["server"], tickRate: 30 } } } },
      bootstrap: (e) => void e.createWorld({ name: "Default" }),
    });
    const match = Engine.createWorld("Match");
    expect(match).toMatchObject({ name: "Match", tags: ["server"] });
    engine.step(1 / 30);
    expect(entry("Match").fixedDeltaTime).toBe(1 / 30);
    expect(() => engine.createWorld("Lobby")).toThrow(/no World template named "Lobby".*Match/);
    engine.dispose();
  });
});

// Fixes from the wave 1 review (ADR 0034).
describe("wave 1 review fixes", () => {
  it("lets tags keep deciding a World's systems when a system's filter changes later", async () => {
    const { _setReplacingRegistrations } = await import("../core/registry");
    const def = { name: "test.review.Retag", phase: "update" as const, run() {} };
    defineSystem(def);
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Default" }, { name: "Server", tags: ["server"] }] } });
    const server = engine.findWorld("Server")!;
    expect(engine.findWorld("Default")!.systems()).toContain("test.review.Retag");
    expect(server.systems()).not.toContain("test.review.Retag");
    // A project script is edited to target the server and reloaded (ADR 0030).
    _setReplacingRegistrations(true);
    defineSystem({ ...def, worlds: ["server"] });
    _setReplacingRegistrations(false);
    expect(engine.findWorld("Default")!.systems()).not.toContain("test.review.Retag");
    expect(server.systems()).toContain("test.review.Retag");
    engine.dispose();
    _undefineSystem("test.review.Retag");
  });

  it("still applies a World's own include and exclude", async () => {
    defineSystem({ name: "test.review.Srv", phase: "update", worlds: ["server"], run() {} });
    defineSystem({ name: "test.review.Dbg", phase: "update", run() {} });
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Default", systems: { include: ["test.review.Srv"], exclude: ["test.review.Dbg"] } }] } });
    expect(engine.world.systemNames()).toContain("test.review.Srv");
    expect(engine.world.systemNames()).not.toContain("test.review.Dbg");
    engine.dispose();
    _undefineSystem("test.review.Srv");
    _undefineSystem("test.review.Dbg");
  });

  it("hands the view and input to the next World when the World that has them is destroyed", async () => {
    const engine = await Engine.create({ headless: true });
    const menu = engine.world;
    expect(menu._takesInput).toBe(true);
    // The Host flow: the menu makes a server World and a match World, then destroys itself.
    const server = engine.createWorld({ name: "Server", tags: ["server"] });
    const match = engine.createWorld({ name: "Match", tags: ["client"] });
    engine.findWorld("Default")!.destroy();
    expect(server.alive && match.alive).toBe(true);
    expect(engine.world.name).toBe("Server"); // the next World is the default...
    // ...but the view, and with it input, goes to the first World that wants it: not the server.
    engine.step(1 / 60);
    const takesInput = (name: string) => (engine as unknown as { list: World[] }).list.find((w) => w.name === name)!._takesInput;
    expect(takesInput("Match")).toBe(true);
    expect(takesInput("Server")).toBe(false);
    engine.dispose();
  });

  it("leaves the Engine as it was when a World config is bad", async () => {
    const engine = await Engine.create({ headless: true });
    expect(() => engine.createWorld({ name: "Bad", systems: { include: ["test.review.NoSuchSystem"] } })).toThrow(/NoSuchSystem/);
    expect(() => engine.createWorld({ name: "Bad", tickRate: -1, tags: [1 as unknown as string] })).toThrow(/tags[\s\S]*tickRate/);
    expect(engine.worlds().map((w) => w.name)).toEqual(["Default"]);
    expect(engine.createWorld({ name: "Bad", timeScale: 0 }).name).toBe("Bad"); // 0: starts paused
    engine.dispose();
  });

  it("disposes a half-made Engine when a start-up scene fails to load", async () => {
    const before = World.active;
    await expect(Engine.create({ headless: true, bootstrap: { worlds: [{ name: "W", scenes: ["scenes/missing.scene.json"] }] } })).rejects.toThrow();
    expect(World.active === before || World.active === null).toBe(true); // not left pointing into the failed Engine
  });

  it("keeps code after an await in its own World through this.instantiate and parents", async () => {
    Assets.addSource({ has: (p) => p === "prefabs/coin.prefab.json", get: () => ({ format: "myco.scene@1", nodes: [{ id: "coin", name: "Coin" }] }) });
    let spawner: GameBehavior | null = null;
    class Spawner extends GameBehavior {
      awake() {
        spawner = this;
      }
    }
    const engine = await Engine.create({ headless: true, bootstrap: { worlds: [{ name: "Client", tags: ["client"] }, { name: "Server", tags: ["server"] }] } });
    const serverWorld = (engine as unknown as { list: World[] }).list[1];
    World._runIn(serverWorld, () => GameObject.create("spawner").addBehavior(Spawner));
    // After an await the frame is over and the default (Client) World is current.
    expect(World.active!.name).toBe("Client");
    const coin = spawner!.instantiate("prefabs/coin.prefab.json");
    expect(coin.world).toBe(serverWorld);
    const child = GameObject.create("child", { parent: coin });
    expect(child.world).toBe(serverWorld);
    engine.dispose();
  });
});
