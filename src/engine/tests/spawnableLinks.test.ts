import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, ConnectionState, Engine, type BootstrapConfig } from "../index";
import { validateBootstrap } from "../core/settings";
import type { World } from "../core/World";
import { liveLinks } from "../editor";

// ADR 0062: bootstrap links apply whenever both of their Worlds exist, so they can name Spawnable
// Worlds (templates) that game code creates later. Loopback on a fake clock, as in session.test.ts.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

function step(engine: Engine, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
  }
}

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

const states = (w: World | null) => (w ? [...w._query([Connection])].map((r) => (r.connection as { state: number }).state) : []);

/** Arena's shape: a start-up client, a Spawnable server and a Spawnable second client, linked over loopback. */
function arena(): BootstrapConfig {
  return {
    worlds: [{ name: "Client", tags: ["client"] }],
    templates: { Server: { tags: ["server"], renders: false }, "Client 2": { tags: ["client"] } },
    links: [
      { from: "Client", to: "Server", transport: "loopback", options: { now } },
      { from: "Client 2", to: "Server", transport: "loopback", options: { now } },
    ],
  };
}

describe("links to Spawnable Worlds (ADR 0062)", () => {
  it("validates link ends against start-up Worlds and templates' World names", () => {
    expect(validateBootstrap(arena())).toEqual([]);
    const named: BootstrapConfig = { ...arena(), templates: { ServerTemplate: { name: "Host", tags: ["server"] } }, links: [{ from: "Client", to: "Host", transport: "loopback" }] };
    expect(validateBootstrap(named)).toEqual([]);
    const bad: BootstrapConfig = { ...arena(), links: [{ from: "Client", to: "Nowhere", transport: "loopback" }] };
    expect(validateBootstrap(bad).join("\n")).toMatch(/"Nowhere", which neither bootstrap\.worlds nor bootstrap\.templates lists/);
  });

  it("doesn't connect a link whose Spawnable World doesn't exist yet", async () => {
    const engine = await create(arena());
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([]);
  });

  it("connects the start-up client when game code creates the Spawnable server", async () => {
    const engine = await create(arena());
    engine.createWorld("Server");
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    expect(states(engine._world("Server"))).toEqual([ConnectionState.open]);
  });

  it("connects a Spawnable client to a live Spawnable server when it's created", async () => {
    const engine = await create(arena());
    engine.createWorld("Server");
    step(engine, 2);
    engine.createWorld("Client 2");
    step(engine, 3);
    expect(states(engine._world("Client 2"))).toEqual([ConnectionState.open]);
    expect(states(engine._world("Server"))).toHaveLength(2);
  });

  it("applies the links again when the server World is created again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(arena());
    engine.createWorld("Server").destroy();
    step(engine, 3);
    // The client lost its server; a fresh client World reconnects to the new one.
    engine.findWorld("Client 2") ?? engine.createWorld("Client 2");
    engine.createWorld("Server");
    step(engine, 3);
    expect(states(engine._world("Client 2"))).toEqual([ConnectionState.open]);
  });

  it("reconnects the start-up client when the server is destroyed and created again in one frame", async () => {
    const engine = await create(arena());
    engine.createWorld("Server");
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    engine.findWorld("Server")!.destroy();
    engine.createWorld("Server"); // a restarted match: the client's old connection hasn't closed yet
    step(engine, 6);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    expect(states(engine._world("Server"))).toEqual([ConnectionState.open]);
  });

  it("lets a script connect() again once the linked connection is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create({ ...arena(), templates: { ...arena().templates, Other: { tags: ["server"], renders: false } } });
    const server = engine.createWorld("Server");
    step(engine, 3);
    server.destroy();
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([]);
    const other = engine.createWorld("Other");
    engine.findWorld("Client")!.connect(other, "loopback", { now });
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/by a link/));
  });

  it("makes a script's connect() for an already linked pair do nothing, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(arena());
    const server = engine.createWorld("Server");
    engine.findWorld("Client")!.connect(server, "loopback", { now });
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([ConnectionState.open]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already connected to "Server" by a link/));
  });

  it("only applies a link to a copy of a template that it names", async () => {
    const engine = await create(arena());
    Engine.prototype.createWorld.call(engine, { ...arena().templates!.Server, name: "Server 2" });
    step(engine, 3);
    expect(states(engine._world("Client"))).toEqual([]);
  });

  it("lists live connections between the Engine's Worlds for the Worlds panel", async () => {
    const engine = await create(arena());
    expect(liveLinks(engine)).toEqual([]);
    engine.createWorld("Server");
    engine.createWorld("Client 2");
    step(engine, 3);
    expect(liveLinks(engine)).toEqual([
      { from: "Client", to: "Server", transport: "loopback", state: "open" },
      { from: "Client 2", to: "Server", transport: "loopback", state: "open" },
    ]);
  });
});
