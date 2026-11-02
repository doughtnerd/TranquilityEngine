import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Connection, ConnectionState, Engine, GameObject, defineRpc, defineSystem, i32, u8, type BootstrapConfig, type LinkConfig } from "../index";
import { World } from "../core/World";
import { createBitWriter } from "../net/codec";
import { NET_PROTOCOL_VERSION, netSession, registerNetMessage } from "../net/session";
import { LoopbackTransport } from "../net/transport/loopback";

// ADR 0033, T10: connections, network ticks and RPCs, over the loopback transport on a fake clock
// that advances with `engine.step`, so everything is deterministic.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const engines: Engine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

/** Step every given Engine `frames` times, advancing the loopback clock with them. */
function step(list: Engine | Engine[], frames = 1, dt = DT): void {
  const all = Array.isArray(list) ? list : [list];
  for (let i = 0; i < frames; i++) {
    clock += dt * 1000;
    for (const e of all) e.step(dt);
  }
}

async function create(bootstrap: BootstrapConfig): Promise<Engine> {
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

/** A client World linked to a server World over loopback. */
function clientServer(options: Record<string, unknown> = {}, extra: Partial<BootstrapConfig> = {}): BootstrapConfig {
  const link: LinkConfig = { from: "Client", to: "Server", transport: "loopback", options: { now, ...options } };
  return {
    worlds: [
      { name: "Client", tags: ["client"] },
      { name: "Server", tags: ["server"] },
    ],
    links: [link],
    ...extra,
  };
}

function world(engine: Engine, name: string): World {
  return engine._world(name)!;
}

/** The connection nodes of a World, with their data. */
function connections(w: World) {
  const out: { node: GameObject; id: number; state: number; rtt: number }[] = [];
  for (const row of w._query([Connection])) {
    const c = row.connection as { id: number; state: number; rtt: number };
    out.push({ node: row.node, id: c.id, state: c.state, rtt: c.rtt }); // the row object is reused
  }
  return out;
}

describe("connections (T10)", () => {
  it("connects a bootstrap's linked Worlds at Engine.create; each side gets a connection node", async () => {
    const engine = await create(clientServer());
    const client = world(engine, "Client");
    const server = world(engine, "Server");
    // The client's node is there at once, connecting; the server's once it accepts the handshake.
    expect(connections(client).map((c) => c.state)).toEqual([ConnectionState.connecting]);
    expect(connections(server)).toEqual([]);

    step(engine, 3);
    const [c] = connections(client);
    const [s] = connections(server);
    expect(c).toMatchObject({ id: 1, state: ConnectionState.open });
    expect(s).toMatchObject({ id: 1, state: ConnectionState.open });
    expect(c.node.parent).toBe(client.root); // under the World root, not in a scene
    expect(c.node.name).toBe("Connection 1 (server)");
    expect(s.node.name).toBe("Connection 1");

    // Both are networked Worlds now; the server counts ticks from when it started serving.
    expect(server.time.network).toMatchObject({ tick: 3, serverTick: 3, interpolationTick: 3, tickRate: 60 });
    expect(client.time.network?.tick).toBe(3);
  });

  it("gives each client its own connection and id, and keeps connection nodes across scene loads", async () => {
    Assets.addSource(Assets.fromObject({ "scenes/net.scene.json": { format: "tranquility.scene@1", nodes: [{ id: "a", name: "A" }] } }));
    const engine = await create({
      worlds: [
        { name: "P1", tags: ["client"] },
        { name: "P2", tags: ["client"] },
        { name: "Server", tags: ["server"] },
      ],
      links: [
        { from: "P1", to: "Server", transport: "loopback", options: { now } },
        { from: "P2", to: "Server", transport: "loopback", options: { now } },
      ],
    });
    step(engine, 3);
    expect(connections(world(engine, "Server")).map((c) => c.id).sort()).toEqual([1, 2]);
    expect(connections(world(engine, "P1"))[0].id).not.toBe(connections(world(engine, "P2"))[0].id);

    await engine.findWorld("Server")!.loadScene("scenes/net.scene.json");
    step(engine, 1);
    expect(connections(world(engine, "Server"))).toHaveLength(2);
  });

  it("leaves Worlds without links un-networked", async () => {
    const engine = await create({ worlds: [{ name: "Solo" }] });
    step(engine, 2);
    expect(engine.world.time.network).toBeUndefined();
    expect(netSession(engine.world)).toBeNull();
  });

  it("refuses a client with a different tick rate, saying why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create({ ...clientServer(), worlds: [{ name: "Client", tags: ["client"], tickRate: 30 }, { name: "Server", tags: ["server"] }] });
    step(engine, 4);
    expect(connections(world(engine, "Client"))).toEqual([]);
    expect(connections(world(engine, "Server"))).toEqual([]);
    const reason = netSession(world(engine, "Client"))!.closed.at(-1)!.reason;
    expect(reason).toMatch(/Tick rate mismatch: World "Client" runs at 30 ticks per second, the server World "Server" at 60/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/World "Client" couldn't open its connection to the server: .*Tick rate mismatch/));
  });

  it("refuses a client with another protocol version or other RPCs, saying why", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    defineRpc("test.session.Shared", { a: i32 });
    const engine = await create(clientServer({ address: "test-session-raw" }));
    step(engine, 1);

    /** Connect by hand and send a hello; return the close reason the client hears. */
    const handshake = (version: number, rpcs: string[]) => {
      const raw = new LoopbackTransport({ now });
      const link = raw.connect("test-session-raw");
      step(engine, 1);
      raw.poll(); // open
      const w = createBitWriter();
      w.writeVarUint(version);
      w.writeFloat32(60);
      w.writeString("Raw");
      w.writeVarUint(rpcs.length);
      for (const r of rpcs) w.writeString(r);
      w.writeVarUint(0);
      link.send("reliable", Uint8Array.from([0, 0, ...w.finish()]));
      step(engine, 2);
      const close = raw.poll().find((e) => e.kind === "close");
      raw.close();
      return close?.kind === "close" ? close.reason : "";
    };
    expect(handshake(NET_PROTOCOL_VERSION + 1, [])).toMatch(new RegExp(`Protocol version mismatch: World "Raw" speaks netcode version ${NET_PROTOCOL_VERSION + 1}`));
    const reason = handshake(NET_PROTOCOL_VERSION, ["test.session.Shared(a:f32)", "test.session.Extra(x:u8)"]);
    expect(reason).toMatch(/RPC mismatch: only the client defines "test.session.Extra"/);
    expect(reason).toMatch(/"test.session.Shared" differs \(client test.session.Shared\(a:f32\), server test.session.Shared\(a:i32\)\)/);
    expect(connections(world(engine, "Server"))).toHaveLength(1); // only the real client
  });

  it("connects at runtime with WorldHandle.connect", async () => {
    const engine = await create({ worlds: [{ name: "Menu" }] });
    const server = engine.createWorld({ name: "Host", tags: ["server"] });
    engine.findWorld("Menu")!.connect(server, "loopback", { now });
    step(engine, 3);
    expect(connections(world(engine, "Menu")).map((c) => c.state)).toEqual([ConnectionState.open]);
    expect(connections(world(engine, "Host"))).toHaveLength(1);
    expect(() => engine.findWorld("Menu")!.connect(server, "loopback", { now })).toThrow(/already connected to a server/);
    expect(() => server.connect(engine.findWorld("Menu")!, "loopback", { now })).toThrow(/a World can't be both a server and a client/);
    expect(() => server.connect(server, "loopback")).toThrow(/itself/);
  });

  it("removes the client's connection node when the server World is destroyed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientServer({ latencyMs: 50 }));
    step(engine, 10);
    expect(connections(world(engine, "Client"))).toHaveLength(1);
    engine.findWorld("Server")!.destroy();
    step(engine, 1);
    expect(connections(world(engine, "Client"))).toHaveLength(1); // the close is 50 ms away
    step(engine, 3);
    expect(connections(world(engine, "Client"))).toEqual([]);
    expect(netSession(world(engine, "Client"))!.closed.at(-1)!.reason).toMatch(/World "Server" was closed/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/World "Client" lost its connection to the server/));
  });

  it("closes a client's connection when the server destroys its connection node (a kick)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientServer());
    step(engine, 3);
    const [s] = connections(world(engine, "Server"));
    World._runIn(world(engine, "Server"), () => GameObject.destroy(s.node));
    step(engine, 3);
    expect(connections(world(engine, "Server"))).toEqual([]);
    expect(connections(world(engine, "Client"))).toEqual([]);
  });

  it("shows the closing state for the rest of the frame a connection closes in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = await create(clientServer({}, { worlds: [{ name: "Client", tags: ["client", "closing-test"] }, { name: "Server", tags: ["server"] }] }));
    const states: number[] = [];
    defineSystem({ name: "test.session.closingProbe", phase: "update", worlds: ["closing-test"], run: (_rows, ctx) => states.push(...connections(ctx.world).map((c) => c.state)) });
    step(engine, 3);
    engine.findWorld("Server")!.destroy();
    states.length = 0;
    step(engine, 2);
    expect(states).toEqual([ConnectionState.closing]);
  });

  it("disposes and recreates an Engine on the same loopback address", async () => {
    for (let i = 0; i < 3; i++) {
      const engine = await Engine.create({ headless: true, bootstrap: clientServer({ address: "test-session-reused" }) });
      step(engine, 3);
      expect(connections(engine._world("Server")!)).toHaveLength(1);
      engine.dispose();
    }
  });

  it("makes up loopback addresses per Engine, so two Engines' Server Worlds don't clash", async () => {
    const a = await create(clientServer());
    const b = await create(clientServer());
    step([a, b], 3);
    expect(connections(world(a, "Server"))).toHaveLength(1);
    expect(connections(world(b, "Server"))).toHaveLength(1);
  });

  it("connects a client World in one Engine to a server World in another, at an explicit address", async () => {
    const game = await create({ worlds: [{ name: "Client", tags: ["client"] }] });
    const host = await create({ worlds: [{ name: "Server", tags: ["server"] }] });
    game.findWorld("Client")!.connect(host.findWorld("Server")!, "loopback", { address: "test-session-two-engines", now, latencyMs: 20 });
    step([game, host], 10);
    expect(connections(world(game, "Client"))).toMatchObject([{ id: 1, state: ConnectionState.open }]);
    expect(connections(world(host, "Server"))).toMatchObject([{ id: 1, state: ConnectionState.open }]);
  });

  it("reports a WebSocket server World outside Node clearly", async () => {
    const bootstrap: BootstrapConfig = { ...clientServer(), links: [{ from: "Client", to: "Server", transport: "websocket", options: { port: 0 } }] };
    await expect(Engine.create({ headless: true, bootstrap })).rejects.toThrow(/World "Server" can't listen over "websocket" at "0": .*only connect; listening needs the Node server/);
    const noPort: BootstrapConfig = { ...clientServer(), links: [{ from: "Client", to: "Server", transport: "websocket" }] };
    await expect(Engine.create({ headless: true, bootstrap: noPort })).rejects.toThrow(/give the link options.port or options.address/);
  });
});

describe("network ticks (T10)", () => {
  it("at 100 ms latency, the client's server-tick estimate is within a tick of the server's tick and rtt is about 200 ms", async () => {
    // 20 ms frames, so the fake clock stays in whole milliseconds and 100 ms is exactly 5 frames
    // (otherwise each leg rounds up to the next frame the receiver polls in).
    const frame = 1 / 50;
    const engine = await create(clientServer({ latencyMs: 100 }));
    const client = world(engine, "Client");
    const server = world(engine, "Server");
    step(engine, 150, frame); // 3 s to settle

    for (let i = 0; i < 50; i++) {
      step(engine, 1, frame);
      const trueTick = netSession(server)!.tick;
      const net = client.time.network!;
      expect(Math.abs(netSession(client)!.estimatedServerTick - trueTick)).toBeLessThanOrEqual(1);
      expect(net.rtt).toBeCloseTo(200, 0);
      // Prediction runs RTT/2 (6 ticks) plus the command slack (2, T12) ahead; interpolation 6
      // ticks behind plus the 100 ms buffer.
      expect(Math.abs(net.serverTick - (trueTick + 6 + 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(net.interpolationTick + net.interpolationFraction - (trueTick - 12))).toBeLessThanOrEqual(1.5);
      expect(net.tickRate).toBe(60);
    }
    // The server sees the client's RTT on its connection node.
    expect(connections(server)[0].rtt).toBeGreaterThan(190);
    expect(connections(client)[0].rtt).toBeCloseTo(client.time.network!.rtt, 3);
  });

  it("advances serverTick by one per fixed step and never goes backwards", async () => {
    const engine = await create(clientServer({ latencyMs: 30, jitterMs: 20, random: sequenceRandom() }));
    const client = world(engine, "Client");
    step(engine, 120);
    let last = client.time.network!.serverTick;
    let lastInterpolation = client.time.network!.interpolationTick + client.time.network!.interpolationFraction;
    for (let i = 0; i < 120; i++) {
      step(engine, 1);
      const net = client.time.network!;
      expect(net.serverTick).toBeGreaterThanOrEqual(last);
      expect(net.serverTick - last).toBeLessThanOrEqual(2);
      expect(net.interpolationTick + net.interpolationFraction).toBeGreaterThanOrEqual(lastInterpolation);
      last = net.serverTick;
      lastInterpolation = net.interpolationTick + net.interpolationFraction;
    }
  });
});

/** A deterministic 0..1 sequence. */
function sequenceRandom(): () => number {
  let x = 0.37;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

describe("RPCs (T10)", () => {
  const Ping = defineRpc("test.session.Ping", { n: i32 });
  const Pong = defineRpc("test.session.Pong", { n: i32, team: u8 });

  it("arrive as rows with their connection node, in order, both ways, and are gone the next frame", async () => {
    const engine = await create({
      ...clientServer({ latencyMs: 20 }),
      worlds: [
        { name: "Client", tags: ["client", "rpc-client"] },
        { name: "Server", tags: ["server", "rpc-server"] },
      ],
    });
    const client = world(engine, "Client");
    const server = world(engine, "Server");
    const serverFixed: number[] = [];
    const serverUpdate: { n: number; from: unknown }[] = [];
    const clientUpdate: { n: number; team: number; from: unknown }[] = [];
    defineSystem({ name: "test.session.serverFixed", phase: "fixedUpdate", worlds: ["rpc-server"], run: () => serverFixed.push(...[...Ping.read()].map((m) => m.n)) });
    defineSystem({
      name: "test.session.serverUpdate",
      phase: "update",
      worlds: ["rpc-server"],
      run() {
        for (const m of Ping.read()) {
          serverUpdate.push({ n: m.n, from: m.connection });
          Pong.send({ n: m.n * 10, team: 3 }, m.connection);
        }
      },
    });
    defineSystem({ name: "test.session.clientUpdate", phase: "update", worlds: ["rpc-client"], run: () => clientUpdate.push(...[...Pong.read()].map((m) => ({ n: m.n, team: m.team, from: m.connection }))) });

    // Sent before the handshake completes: they wait for it.
    World._runIn(client, () => {
      Ping.send({ n: 1 });
      Ping.send({ n: 2 }, "server");
    });
    step(engine, 10);
    World._runIn(client, () => Ping.send({ n: 3 }));
    step(engine, 10);

    const [serverNode] = connections(server).map((c) => c.node);
    const [clientNode] = connections(client).map((c) => c.node);
    expect(serverUpdate).toEqual([1, 2, 3].map((n) => ({ n, from: serverNode })));
    expect(serverFixed).toEqual([1, 2, 3]); // each seen at exactly one fixed step
    expect(clientUpdate).toEqual([10, 20, 30].map((n) => ({ n, team: 3, from: clientNode })));

    // Read between frames: the last frame's rows, which had none.
    expect([...World._runIn(server, () => Ping.read())]).toEqual([]);
  });

  it("are seen once by fixedUpdate readers even with several fixed steps in a frame, and once by update readers", async () => {
    const engine = await create({
      ...clientServer(),
      worlds: [
        { name: "Client", tags: ["client"] },
        { name: "Server", tags: ["server", "rpc-burst"] },
      ],
    });
    const fixed: number[] = [];
    const update: number[] = [];
    defineSystem({ name: "test.session.burstFixed", phase: "fixedUpdate", worlds: ["rpc-burst"], run: () => fixed.push(...[...Ping.read()].map((m) => m.n)) });
    defineSystem({ name: "test.session.burstUpdate", phase: "update", worlds: ["rpc-burst"], run: () => update.push(...[...Ping.read()].map((m) => m.n)) });
    step(engine, 3);
    World._runIn(world(engine, "Client"), () => Ping.send({ n: 7 }));
    step(engine, 1, DT / 4); // client sends; no fixed step anywhere this frame
    step(engine, 1, DT / 4); // the server receives it in update, with no fixed step
    expect(update).toEqual([7]);
    expect(fixed).toEqual([]);
    step(engine, 1, DT * 3); // three fixed steps: only the first sees it
    expect(fixed).toEqual([7]);
    expect(update).toEqual([7]);
  });

  it("go to every connection with \"all\", and can't be sent from a World that isn't networked", async () => {
    const engine = await create({
      worlds: [
        { name: "A", tags: ["client", "rpc-all"] },
        { name: "B", tags: ["client", "rpc-all"] },
        { name: "Server", tags: ["server"] },
        { name: "Solo" },
      ],
      links: [
        { from: "A", to: "Server", transport: "loopback", options: { now } },
        { from: "B", to: "Server", transport: "loopback", options: { now } },
      ],
    });
    const got: string[] = [];
    defineSystem({ name: "test.session.allProbe", phase: "update", worlds: ["rpc-all"], run: (_r, ctx) => got.push(...[...Pong.read()].map((m) => `${ctx.world.name}:${m.n}`)) });
    step(engine, 3);
    World._runIn(world(engine, "Server"), () => Pong.send({ n: 5, team: 0 }, "all"));
    step(engine, 3);
    expect(got.sort()).toEqual(["A:5", "B:5"]);
    expect(() => World._runIn(world(engine, "Solo"), () => Ping.send({ n: 1 }))).toThrow(/World "Solo": it isn't networked/);
    expect(() => World._runIn(world(engine, "Server"), () => Ping.send({ n: 1 }, "server"))).toThrow(/isn't a network client/);
    expect(() => World._runIn(world(engine, "A"), () => Ping.send({} as { n: number }))).toThrow(/field "n" must be a number/);
    expect(() => defineRpc("test.session.Ping", { n: i32 })).toThrow(/already defined/);
  });
});

describe("the internal message API (T10, for T11 and T12)", () => {
  const SNAP = registerNetMessage("test.session.snapshot");

  it("sends registered kinds as bytes or written bodies, tagged with the sender's tick, drained per kind", async () => {
    const engine = await create(clientServer({ latencyMs: 10 }));
    const client = world(engine, "Client");
    const server = world(engine, "Server");
    step(engine, 5);
    const s = netSession(server)!;
    const [peer] = s.openPeers();
    s.send(SNAP, peer, "unreliable", Uint8Array.from([1, 2, 3]));
    s.send(SNAP, "all", "reliable", (w) => w.writeVarUint(300));
    const tick = s.tick;
    step(engine, 3);
    const got = netSession(client)!.drain(SNAP);
    expect(got.map((m) => [m.channel, [...m.data], m.tick])).toEqual([
      ["unreliable", [1, 2, 3], tick],
      ["reliable", [...createWriterBytes(300)], tick],
    ]);
    expect(got[1].reader().readVarUint()).toBe(300);
    expect(got[0].node).toBe(connections(client)[0].node);
    expect(netSession(client)!.drain(SNAP)).toEqual([]);

    // Client to server, and the peer's acked tick is written to its node.
    netSession(client)!.send(SNAP, "server", "reliable", Uint8Array.from([9]));
    step(engine, 3);
    const [m] = s.drain(SNAP);
    expect([...m.data]).toEqual([9]);
    expect(m.peer).toBe(peer);
    peer.lastAckedTick = 42;
    expect(peer.node!.getData(Connection)!.lastAckedTick).toBe(42);
  });
});

function createWriterBytes(n: number): Uint8Array {
  const w = createBitWriter();
  w.writeVarUint(n);
  return w.finish();
}
