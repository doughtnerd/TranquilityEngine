import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine, defineInput, defineSystem, f32, i32, u8, type BootstrapConfig, type GameObject } from "../index";
import { World } from "../core/World";
import { inputAt } from "../net/input";
import { netSession } from "../net/session";
import type { LoopbackConnection } from "../net/transport/loopback";

// ADR 0033, T12: per-tick input streams, over the loopback transport on a fake clock that advances
// with `engine.step`, so everything is deterministic.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

function step(engine: Engine, frames = 1, dt = DT): void {
  for (let i = 0; i < frames; i++) {
    clock += dt * 1000;
    engine.step(dt);
  }
}

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

/** Client Worlds tagged `client` and `<tag>-client`, linked to a server World tagged `server` and `<tag>-server`. */
function layout(tag: string, options: Record<string, unknown> = {}, clients = ["Client"]): BootstrapConfig {
  return {
    worlds: [...clients.map((name) => ({ name, tags: ["client", `${tag}-client`] })), { name: "Server", tags: ["server", `${tag}-server`] }],
    links: clients.map((from) => ({ from, to: "Server", transport: "loopback", options: { now, ...options } })),
  };
}

function world(engine: Engine, name: string): World {
  return engine._world(name)!;
}

/** A deterministic 0..1 sequence. */
function sequenceRandom(seed = 0.37): () => number {
  let x = seed;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

const Move = defineInput("test.input.Move", { x: f32, y: i32, jump: u8 });

/** The input a client writes for a given server tick: every field changes from tick to tick. */
function inputFor(tick: number, base = 0) {
  return { x: Math.fround(base + Math.sin(tick * 0.1)), y: base + (tick % 7) - 3, jump: tick % 5 === 0 ? 1 : 0 };
}

type Input = { x: number; y: number; jump: number };

/**
 * Systems that drive `tag`'s Worlds: each client writes `inputFor(serverTick, base)` every fixed
 * step (base: 100 per client after the first) and logs it by server tick; the server logs what
 * `Move.of` gives per connection and tick, and moves a position by it.
 */
function drive(tag: string, clients = ["Client"]) {
  const written = new Map<string, Map<number, Input>>(clients.map((c) => [c, new Map()]));
  const applied = new Map<number, Map<number, Input | null>>(); // connection id → tick → input
  const position = new Map<number, number>();
  let enabled = true;
  defineSystem({
    name: `test.input.${tag}.write`,
    phase: "fixedUpdate",
    worlds: [`${tag}-client`],
    run(_rows, ctx) {
      if (!enabled) return;
      const net = ctx.time.network!;
      const values = inputFor(net.serverTick, clients.indexOf(ctx.world.name) * 100);
      Move.write(values);
      written.get(ctx.world.name)!.set(net.serverTick, values);
    },
  });
  defineSystem({
    name: `test.input.${tag}.apply`,
    phase: "fixedUpdate",
    worlds: [`${tag}-server`],
    run(_rows, ctx) {
      const session = netSession(ctx.world)!;
      for (const peer of session.openPeers()) {
        const input = Move.of(peer.node!);
        let log = applied.get(peer.id);
        if (!log) applied.set(peer.id, (log = new Map()));
        log.set(session.tick, input && { ...input });
        if (input) position.set(peer.id, (position.get(peer.id) ?? 0) + input.x);
      }
    },
  });
  return { written, applied, position, stop: () => (enabled = false) };
}

function serverNode(engine: Engine, id = 1): GameObject {
  return netSession(world(engine, "Server"))!.openPeers().find((p) => p.id === id)!.node!;
}

function statsOf(engine: Engine, id = 1) {
  return World._runIn(world(engine, "Server"), () => Move.stats(serverNode(engine, id)))!;
}

describe("input streams (T12)", () => {
  it("drives server-side movement that matches the client's input history over 300 ticks at 100 ms, with jitter and 10% loss", async () => {
    const engine = await create(layout("lossy", { latencyMs: 100, jitterMs: 20, loss: 0.1, random: sequenceRandom() }));
    const run = drive("lossy");
    step(engine, 180); // 3 s for the tick estimate to settle
    const server = netSession(world(engine, "Server"))!;
    const before = statsOf(engine);
    const startTick = server.tick + 1;
    const startPosition = run.position.get(1)!;
    step(engine, 300);
    const endTick = server.tick;
    expect(endTick - startTick + 1).toBe(300);

    // Every server tick applied exactly the input the client wrote for that tick.
    const written = run.written.get("Client")!;
    const applied = run.applied.get(1)!;
    let expected = startPosition;
    for (let t = startTick; t <= endTick; t++) {
      expect(written.has(t), `the client wrote tick ${t}`).toBe(true);
      expect(applied.get(t), `tick ${t}`).toEqual(written.get(t));
      expected += written.get(t)!.x;
    }
    expect(run.position.get(1)).toBe(expected);
    const after = statsOf(engine);
    expect(after.repeated - before.repeated).toBe(0);
    expect(after.late - before.late).toBe(0);
    expect(after.received - before.received).toBe(300);
  });

  it("repeats the last input over a gap longer than the redundancy, and counts it", async () => {
    const engine = await create(layout("gap", { latencyMs: 30 }));
    const run = drive("gap");
    step(engine, 120);
    const server = netSession(world(engine, "Server"))!;
    const link = netSession(world(engine, "Client"))!.serverPeer!.link as LoopbackConnection;
    const before = statsOf(engine);
    const gapStart = server.tick;
    link.setConditions({ loss: 1 }); // the client's packets are all lost for 12 frames
    step(engine, 12);
    link.setConditions(undefined);
    step(engine, 30);

    const after = statsOf(engine);
    const repeated = after.repeated - before.repeated;
    // 12 packets lost, each carrying 4 ticks: 12 - 3 ticks never arrived. The first packet after
    // the gap arrives as the server simulates the second tick it carries, so its first tick is
    // late as well: repeated, and counted late when it turns up.
    expect(after.late - before.late).toBe(1);
    expect(repeated).toBe(9 + 1);
    // Repeated ticks show the newest earlier input; all other ticks their own.
    const applied = run.applied.get(1)!;
    const written = run.written.get("Client")!;
    let repeats = 0;
    for (let t = gapStart; t <= server.tick; t++) {
      if (!deepEqual(applied.get(t), written.get(t))) {
        repeats++;
        expect(applied.get(t)).toEqual(applied.get(t - 1));
      }
    }
    expect(repeats).toBe(repeated);
  });

  it("drops inputs for ticks the server already simulated and counts them late", async () => {
    const engine = await create(layout("late", { latencyMs: 50 }));
    const run = drive("late");
    step(engine, 120);
    const server = netSession(world(engine, "Server"))!;
    const links = [netSession(world(engine, "Client"))!.serverPeer!.link, server.openPeers()[0].link] as LoopbackConnection[];
    const before = statsOf(engine);
    const from = server.tick;
    // Packets suddenly take 100 ms longer each way: until the client's estimate catches up, its inputs are late.
    for (const link of links) link.setConditions({ latencyMs: 150 });
    step(engine, 300); // the estimate takes a few seconds to settle on the new round trip

    const after = statsOf(engine);
    const late = after.late - before.late;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThanOrEqual(after.repeated - before.repeated);
    // A late input never replaces a tick: each tick shows its own input or repeats the one before.
    const applied = run.applied.get(1)!;
    const written = run.written.get("Client")!;
    for (let t = from; t <= server.tick; t++) {
      if (!deepEqual(applied.get(t), written.get(t))) expect(applied.get(t)).toEqual(applied.get(t - 1));
    }
    // And it recovers: the last second has every tick's own input.
    for (let t = server.tick - 59; t <= server.tick; t++) expect(applied.get(t)).toEqual(written.get(t));
  });

  it("keeps two clients' inputs apart", async () => {
    const engine = await create(layout("two", { latencyMs: 40, jitterMs: 10, loss: 0.05, random: sequenceRandom(0.71) }, ["P1", "P2"]));
    const run = drive("two", ["P1", "P2"]);
    step(engine, 240);
    const server = netSession(world(engine, "Server"))!;
    const idOf = (name: string) => netSession(world(engine, name))!.serverPeer!.id;
    for (const name of ["P1", "P2"]) {
      const applied = run.applied.get(idOf(name))!;
      const written = run.written.get(name)!;
      for (let t = server.tick - 120; t <= server.tick; t++) expect(applied.get(t), `${name} at tick ${t}`).toEqual(written.get(t));
    }
    expect(run.applied.get(idOf("P1"))!.get(server.tick)!.y).toBeLessThan(50);
    expect(run.applied.get(idOf("P2"))!.get(server.tick)!.y).toBeGreaterThan(50);
  });

  it("keeps unwritten fields at last tick's values, is null before any input, and refuses writes on the server", async () => {
    const engine = await create(layout("carry", { latencyMs: 20 }));
    const client = world(engine, "Client");
    const server = world(engine, "Server");
    let writes: (() => void)[] = [];
    defineSystem({ name: "test.input.carry.write", phase: "fixedUpdate", worlds: ["carry-client"], run: () => writes.shift()?.() });
    step(engine, 30);
    expect(World._runIn(server, () => Move.of(serverNode(engine)))).toBeNull();
    expect(World._runIn(server, () => Move.stats(serverNode(engine)))).toBeNull();

    writes = [() => Move.write({ x: 1.5, y: 7, jump: 1 }), () => Move.write({ x: 2 }), () => (Move.local.y = -4)];
    step(engine, 3);
    const clientTicks = [...Array(3)].map((_, i) => client.time.network!.serverTick - 2 + i);
    expect(clientTicks.map((t) => inputAt(Move, client, t))).toEqual([
      { x: 1.5, y: 7, jump: 1 },
      { x: 2, y: 7, jump: 1 },
      { x: 2, y: -4, jump: 1 },
    ]);
    step(engine, 20);
    // The server got the same, and holds the newest as the client keeps sending it.
    expect(World._runIn(server, () => Move.of(serverNode(engine)))).toEqual({ x: 2, y: -4, jump: 1 });
    expect(World._runIn(client, () => Move.of(netSession(client)!.serverPeer!.node!))).toEqual({ x: 2, y: -4, jump: 1 });
    expect(World._runIn(server, () => Move.of(server.root))).toBeNull(); // not a connection node

    expect(() => World._runIn(server, () => Move.write({ x: 1 }))).toThrow(/World "Server": it's a network server/);
    expect(() => World._runIn(client, () => Move.write({ z: 1 } as never))).toThrow(/no field "z"/);
    expect(() => defineInput("test.input.Move", { x: f32 })).toThrow(/already defined/);
    expect(() => defineInput("test.input.Bad", { x: f32 }, { redundancy: -1 })).toThrow(/redundancy/);
  });

  it("keeps input messages small: about 14 bytes for 4 ticks of a 9-byte input that holds still", async () => {
    const Stick = defineInput("test.input.Stick", { x: f32, y: f32, fire: u8 });
    const engine = await create(layout("size", { latencyMs: 20 }));
    let x = 0.25;
    defineSystem({ name: "test.input.size.write", phase: "fixedUpdate", worlds: ["size-client"], run: () => Stick.write({ x, y: -0.5, fire: 1 }) });
    step(engine, 200); // ticks above 127, so the header's tick takes 2 bytes
    const link = netSession(world(engine, "Client"))!.serverPeer!.link;
    const sizes: number[] = [];
    const send = link.send.bind(link);
    vi.spyOn(link, "send").mockImplementation((channel, data) => {
      if (channel === "unreliable" && data[0] >= 8 && data.byteLength > 8) sizes.push(data.byteLength); // not pings, or replication's few-byte snapshot acks (T11)
      send(channel, data);
    });
    step(engine, 10);
    const still = [...sizes];
    sizes.length = 0;
    defineSystem({ name: "test.input.size.move", phase: "fixedUpdate", worlds: ["size-client"], before: ["test.input.size.write"], run: () => (x += 0.01) });
    step(engine, 10);
    const moving = [...sizes];

    // Header (kind 1 byte, tick 2 bytes) + count (1 byte) + the first input whole (9 bytes) + 3 × 3 changed bits.
    expect(still).toEqual(Array(10).fill(3 + 1 + 9 + 2));
    // x changes every tick: 3 × (3 bits + 32) more bits. Without delta encoding it would be 3 + 1 + 4 × 9 = 40.
    expect(moving.at(-1)).toBe(3 + 1 + 9 + 14);
  });
});

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
