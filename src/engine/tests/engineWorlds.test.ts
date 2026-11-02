import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameBehavior, GameObject, SceneManager, Time, defineSystem, type WorldConfig } from "../index";
import { _undefineSystem } from "../core/systems";
import { World } from "../core/World";

// ADR 0032, T1: several Worlds per Engine, each with its own clock, stepped in one loop.

const files: Record<string, unknown> = {
  "scenes/arena.scene.json": { format: "tranquility.scene@1", nodes: [{ id: "floor", name: "Floor" }] },
  "scenes/hud.scene.json": { format: "tranquility.scene@1", nodes: [{ id: "score", name: "Score" }] },
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
    expect(() => match.connect(engine.findWorld("Default")!, "loopback")).toThrow(/T10/);

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
