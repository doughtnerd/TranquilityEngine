import { afterEach, describe, expect, it } from "vitest";
import { Engine, defineInput, defineRpc, f32, i32, u8, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { inputStreams, netConditions, netWorldInfo, setNetConditions, writeWorldInput, type NetPeerInfo } from "../editor";
import { netSession } from "../net/session";
import type { LoopbackTransport } from "../net/transport/loopback";

// ADR 0033 §9, T15: what the editor's network tools read and set: per-connection traffic counters
// (bytes and messages per kind), input stats, and loopback conditions on every link, both ways.
// Over loopback on a fake clock that advances with `engine.step`.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

function step(engine: Engine, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
  }
}

async function create(clients = ["Client"]): Promise<Engine> {
  const bootstrap: BootstrapConfig = {
    worlds: [...clients.map((name) => ({ name, tags: ["client"] })), { name: "Server", tags: ["server"] }],
    links: clients.map((from) => ({ from, to: "Server", transport: "loopback", options: { now } })),
  };
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

const Ping = defineRpc("test.tools.Ping", { n: i32 });
const Steer = defineInput("test.tools.Steer", { x: f32, turn: i32, fire: u8 });

const info = (engine: Engine, world: string) => netWorldInfo(engine).find((w) => w.world === world)!;
const only = (engine: Engine, world: string): NetPeerInfo => info(engine, world).peers[0];

describe("traffic counters", () => {
  it("count bytes and messages per kind on both ends of a loopback link", async () => {
    const engine = await create();
    step(engine, 30);
    const client = only(engine, "Client"), server = only(engine, "Server");
    expect(client.state).toBe("open");
    expect(server.state).toBe("open");

    // One hello each way's worth: the client sent it, the server received the same bytes.
    expect(client.sent.byKind["net.hello"].messages).toBe(1);
    expect(server.received.byKind["net.hello"]).toEqual(client.sent.byKind["net.hello"]);
    expect(server.sent.byKind["net.welcome"]).toEqual(client.received.byKind["net.welcome"]);
    // Pings every 100 ms, answered: the server got all but at most the one in flight.
    const pings = client.sent.byKind["net.ping"].messages;
    expect(pings).toBeGreaterThanOrEqual(4);
    expect(server.received.byKind["net.ping"].messages).toBeGreaterThanOrEqual(pings - 1);
    expect(client.received.byKind["net.pong"].messages).toBeGreaterThanOrEqual(pings - 2);

    // An RPC and input show up under their own kinds.
    World._runIn(engine._world("Client")!, () => Ping.send({ n: 7 }));
    expect(writeWorldInput(engine, "Client", "test.tools.Steer", { x: 0.5, turn: 1, fire: 1 })).toBe(true);
    step(engine, 10);
    const c = only(engine, "Client"), s = only(engine, "Server");
    expect(c.sent.byKind["net.rpc"].messages).toBe(1);
    expect(s.received.byKind["net.rpc"]).toEqual(c.sent.byKind["net.rpc"]);
    const inputKind = Object.keys(c.sent.byKind).find((k) => k.startsWith("net.input:test.tools.Steer("))!;
    expect(inputKind).toBeDefined();
    expect(s.received.byKind[inputKind].messages).toBeGreaterThan(0);
    // Totals are the sums of the kinds.
    for (const t of [c.sent, c.received, s.sent, s.received]) {
      expect(Object.values(t.byKind).reduce((n, k) => n + k.bytes, 0)).toBe(t.bytes);
      expect(Object.values(t.byKind).reduce((n, k) => n + k.messages, 0)).toBe(t.messages);
    }
    // The server's input stats for the connection, and its snapshot and ghost figures.
    expect(s.inputs).toEqual([{ id: "test.tools.Steer", received: expect.any(Number), repeated: expect.any(Number), late: 0 }]);
    expect(s.inputs[0].received).toBeGreaterThan(0);
    expect(s.snapshotBytes).toBeTypeOf("number");
    expect(s.ghosts).toBe(0);
    expect(c.snapshotBytes).toBeNull();
    expect(info(engine, "Client").ghosts).toBe(0);
  });

  it("lists every networked World with its role and connections", async () => {
    const engine = await create(["A", "B"]);
    step(engine, 20);
    const worlds = netWorldInfo(engine);
    expect(worlds.map((w) => [w.world, w.role, w.peers.length])).toEqual([
      ["A", "client", 1],
      ["B", "client", 1],
      ["Server", "server", 2],
    ]);
    expect(info(engine, "Server").peers.map((p) => p.id).sort()).toEqual([1, 2]);
    expect(info(engine, "A").prediction).toBeNull(); // no predictionStats yet (T13), or nothing to report
  });
});

describe("conditions", () => {
  it("apply to both directions of every loopback link, and raise the RTT by a round trip", async () => {
    const engine = await create(["A", "B"]);
    step(engine, 60);
    expect(info(engine, "A").rtt).toBeLessThan(40);
    // The server's listening transport and each client's: three transports.
    expect(setNetConditions(engine, { latencyMs: 100, jitterMs: 0, loss: 0 })).toBe(3);
    for (const name of ["A", "B", "Server"]) {
      for (const t of netSession(engine._world(name)!)!.transportList()) expect((t as LoopbackTransport).conditions).toEqual({ latencyMs: 100, jitterMs: 0, loss: 0 });
    }
    expect(netConditions(engine)).toEqual({ latencyMs: 100, jitterMs: 0, loss: 0 });
    step(engine, 180);
    // 100 ms each way: about 200 ms (plus up to a frame at each end), not 100 as one way would give.
    for (const name of ["A", "B"]) {
      expect(info(engine, name).rtt).toBeGreaterThan(190);
      expect(info(engine, name).rtt).toBeLessThan(250);
    }
    setNetConditions(engine, { latencyMs: 0 });
    step(engine, 240);
    expect(info(engine, "A").rtt).toBeLessThan(60);
  });

  it("is nothing for an Engine without links", async () => {
    const engine = await Engine.create({ headless: true });
    engines.push(engine);
    expect(setNetConditions(engine, { latencyMs: 50 })).toBe(0);
    expect(netConditions(engine)).toBeNull();
    expect(netWorldInfo(engine)).toEqual([]);
  });
});

describe("input streams for tools", () => {
  it("lists the defined streams with their fields' kinds", () => {
    expect(inputStreams().find((s) => s.id === "test.tools.Steer")).toEqual({
      id: "test.tools.Steer",
      fields: [
        { name: "x", kind: "f32" },
        { name: "turn", kind: "i32" },
        { name: "fire", kind: "u8" },
      ],
    });
  });

  it("won't write input in a server World", async () => {
    const engine = await create();
    step(engine, 5);
    expect(writeWorldInput(engine, "Server", "test.tools.Steer", { x: 1 })).toBe(false);
    expect(writeWorldInput(engine, "Nowhere", "test.tools.Steer", { x: 1 })).toBe(false);
    expect(writeWorldInput(engine, "Client", "test.tools.Nothing", { x: 1 })).toBe(false);
  });
});
