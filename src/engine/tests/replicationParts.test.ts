import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, GameBehavior, Interest, Replicated, behavior, defineComponent, f32, field, replicate, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";
import { serverReplication } from "../net/replication/server";
import { createTransport, registerTransport, type Channel, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";

// ADR 0334: snapshots split into datagram-sized parts, each acked on its own. The link runs over a
// datagram transport registered here: the loopback (fake clock, seeded loss) with `maxDatagramBytes`
// set, as the WebSocket transport has while its WebRTC data channel is open (ADR 0333). It records
// the size of every unreliable message the server sends. With `socketDelayMs`, what the server
// sends by the socket's stream (reliable messages, and unreliable ones over a datagram, ADR 0333) is
// held that much longer than datagrams, in order: a laggy stream the next ticks' datagrams overtake.

let clock = 0;
const now = () => clock;
const DT = 1 / 60;
const DATAGRAM = 600;
const engines: Engine[] = [];
/** Sizes of unreliable messages sent by the server's connections, since the last reset. */
let serverSends: number[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

/** A loopback transport whose connections say unreliable messages up to `DATAGRAM` bytes go as datagrams. */
class DatagramLoopback implements Transport {
  private readonly inner: Transport;
  private readonly wrapped = new WeakMap<TransportConnection, TransportConnection>();
  private listening = false;
  private readonly socketDelayMs: number;
  /** Stream sends held back (`socketDelayMs`), oldest first. */
  private readonly held: { at: number; connection: TransportConnection; data: Uint8Array }[] = [];

  constructor(options: Record<string, unknown>) {
    this.inner = createTransport("loopback", options);
    this.socketDelayMs = typeof options.socketDelayMs === "number" ? options.socketDelayMs : 0;
  }

  async listen(address: string): Promise<void> {
    this.listening = true;
    await this.inner.listen(address);
  }

  connect(address: string): TransportConnection {
    return this.wrap(this.inner.connect(address));
  }

  poll(): TransportEvent[] {
    while (this.held.length > 0 && this.held[0].at <= clock) {
      const { connection, data } = this.held.shift()!;
      if (connection.state !== "closed") connection.send("reliable", data);
    }
    return this.inner.poll().map((e) => ({ ...e, connection: this.wrap(e.connection) }));
  }

  close(): void {
    this.inner.close();
  }

  private wrap(c: TransportConnection): TransportConnection {
    let w = this.wrapped.get(c);
    if (!w) {
      const server = this.listening;
      const held = this.held;
      const delay = this.socketDelayMs;
      w = {
        id: c.id,
        remote: c.remote,
        get state() {
          return c.state;
        },
        maxDatagramBytes: DATAGRAM,
        send(channel: Channel, data: Uint8Array) {
          if (server && channel === "unreliable") serverSends.push(data.byteLength);
          if (server && delay > 0 && (channel === "reliable" || data.byteLength > DATAGRAM)) held.push({ at: clock + delay, connection: c, data: data.slice() });
          else c.send(channel, data);
        },
        close: (reason?: string) => c.close(reason),
      };
      this.wrapped.set(c, w);
    }
    return w;
  }
}
registerTransport("test.parts.datagram", (options) => new DatagramLoopback(options));

/** A replicated counter, on every World. */
@behavior("test.parts.Score")
class Score extends GameBehavior {
  @field(Number, { replicate: true }) score = 0;
}

/** Moves its node in a line on the server and counts its steps. */
@behavior("test.parts.Mover", { worlds: ["server"] })
class Mover extends GameBehavior {
  @field(Number) speed = 0.05;
  fixedUpdate() {
    this.transform.position.y += this.speed;
    this.node.getBehavior(Score)!.score++;
  }
}

/** 300 floats: a full state of 1200 bytes, twice a datagram. */
const Big = defineComponent("test.parts.Big", Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, f32])));
replicate(Big);

/** A small component added to a big ghost mid-run, to relayout it (ADR 0121, 0405). */
const Badge = defineComponent("test.parts.Badge", { level: f32 });
replicate(Badge);

/** Sets every `Big` field from a seed (the server's values to look for on clients). */
function fillBig(node: GameObject, seed: number): void {
  const big = node.getData(Big)! as unknown as Record<string, number>;
  for (let i = 0; i < 300; i++) big[`f${i}`] = seed + i * 0.25;
}

Assets.addSource(
  Assets.fromObject({
    "prefabs/partsBig.json": { format: "myco.scene@1", nodes: [{ id: "big", name: "Big", components: [{ type: "net.Replicated" }, { type: "test.parts.Big" }] }] },
    "prefabs/partsCrate.json": { format: "myco.scene@1", nodes: [{ id: "crate", name: "Crate", components: [{ type: "net.Replicated" }] }] },
    "prefabs/partsBall.json": { format: "myco.scene@1", nodes: [{ id: "ball", name: "Ball", components: [{ type: "net.Replicated" }, { type: "test.parts.Score" }, { type: "test.parts.Mover" }] }] },
  }),
);

function sequenceRandom(seed = 0.37): () => number {
  let x = seed;
  return () => (x = (x * 9301 + 0.49297) % 1);
}

let nextAddress = 0;

async function create(options: Record<string, unknown> = {}, replication?: { maxSnapshotBytes?: number }): Promise<Engine> {
  const bootstrap: BootstrapConfig = {
    worlds: [
      { name: "P1", tags: ["client"] },
      { name: "Server", tags: ["server"], ...(replication ? { replication } : {}) },
    ],
    links: [{ from: "P1", to: "Server", transport: "test.parts.datagram", options: { now, random: sequenceRandom(), latencyMs: 20, address: `test-parts/${++nextAddress}`, ...options } }],
  };
  const engine = await Engine.create({ headless: true, bootstrap });
  engines.push(engine);
  return engine;
}

function step(engine: Engine, frames = 1): void {
  for (let i = 0; i < frames; i++) {
    clock += DT * 1000;
    engine.step(DT);
  }
}

const world = (engine: Engine, name: string) => engine._world(name)!;
const inWorld = <T,>(w: World, fn: () => T): T => World._runIn(w, fn);

/** A World's ghosts (client) or replicated nodes (server), by ghost id. */
function ghosts(w: World): Map<number, GameObject> {
  const out = new Map<number, GameObject>();
  for (const rep of w._componentsOfType(Replicated)) if (rep.ghostId && rep.node.isValid && (rep.isGhost || netSession(w)?.isServer)) out.set(rep.ghostId, rep.node);
  return out;
}

function spawn(engine: Engine, prefab: string, count: number): void {
  inWorld(world(engine, "Server"), () => {
    for (let i = 0; i < count; i++) GameObject.instantiate(prefab, { position: [i, 0, 0] });
  });
}

const peerState = (engine: Engine) => {
  const server = world(engine, "Server");
  return serverReplication(server)!.peerState(netSession(server)!.openPeers()[0])!;
};

describe("snapshot parts (ADR 0334)", () => {
  it("splits a snapshot that doesn't fit one datagram into parts that each do; every ghost arrives, and acks make them cheap", async () => {
    const engine = await create();
    step(engine, 10);
    serverSends = [];
    spawn(engine, "prefabs/partsCrate.json", 300);
    // The spawns go in one reliable lifecycle message, however big (ADR 0402); once it's acked, the
    // crates' states (delta-coded against their spawns' states) are a snapshot of several parts.
    const ps = peerState(engine);
    let lifecycle = 0;
    let split = 0;
    for (let i = 0; i < 20 && split === 0; i++) {
      step(engine);
      lifecycle = Math.max(lifecycle, ps.lastLifecycleBytes);
      if (ps.lastParts > 1) split = ps.lastBytes;
    }
    expect(lifecycle).toBeGreaterThan(3 * DATAGRAM);
    expect(split).toBeGreaterThan(DATAGRAM);
    expect(Math.max(...serverSends)).toBeLessThanOrEqual(DATAGRAM);
    step(engine, 30);
    expect(ghosts(world(engine, "P1")).size).toBe(300);
    expect([...ghosts(world(engine, "P1")).values()].map((n) => n.transform!.position.x).sort((a, b) => a - b)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    // Every part's spawns and baselines were acked: unchanged crates cost about a byte each, in one part again.
    step(engine, 30);
    expect(ps.lastParts).toBe(1);
    expect(ps.lastBytes).toBeLessThan(300 * 1.5 + 20);
  });

  it("keeps a tick within maxSnapshotBytes, sending the rest in later ticks", async () => {
    const engine = await create({}, { maxSnapshotBytes: 2000 });
    step(engine, 10);
    spawn(engine, "prefabs/partsCrate.json", 300);
    const totals: number[] = [];
    for (let i = 0; i < 40; i++) {
      step(engine);
      totals.push(peerState(engine).lastBytes);
    }
    expect(Math.max(...totals)).toBeLessThanOrEqual(2000);
    expect(Math.max(...totals.map(() => peerState(engine).lastParts))).toBeLessThanOrEqual(Math.floor(2000 / (DATAGRAM - 8)));
    step(engine, 60);
    expect(ghosts(world(engine, "P1")).size).toBe(300);
  });

  it("under heavy loss, a lost part only delays its ghosts: moving ghosts converge with no read errors", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create({ loss: 0.3, jitterMs: 10 });
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 200);
    step(engine, 240);
    expect(error).not.toHaveBeenCalled();
    const client = ghosts(world(engine, "P1"));
    expect(client.size).toBe(200);
    expect(peerState(engine).lastParts).toBeGreaterThan(1); // 200 moving balls don't fit one datagram
    // Stop them, and every client ghost settles on its server value.
    inWorld(world(engine, "Server"), () => {
      for (const node of ghosts(world(engine, "Server")).values()) node.getBehavior(Mover)!.enabled = false;
    });
    step(engine, 120);
    for (const [id, node] of ghosts(world(engine, "Server"))) {
      expect(client.get(id)!.transform!.position.y).toBeCloseTo(node.transform!.position.y, 3);
      expect(client.get(id)!.getBehavior(Score)!.score).toBe(node.getBehavior(Score)!.score);
    }
  });

  it("structure changes in a split snapshot reach the client under loss", async () => {
    const engine = await create({ loss: 0.25 });
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 150);
    step(engine, 60);
    const server = ghosts(world(engine, "Server"));
    inWorld(world(engine, "Server"), () => {
      for (const [id, node] of server) if (id % 2 === 0) node.setActive(false);
    });
    step(engine, 180);
    const client = ghosts(world(engine, "P1"));
    expect(client.size).toBe(150);
    for (const [id, node] of client) expect(node.active).toBe(id % 2 !== 0);
  });
});

describe("spawns go reliably, apart from states (ADR 0402)", () => {
  // The server's stream (reliable messages, and parts over a datagram) lags its datagrams by 150 ms,
  // so the next ticks' datagrams overtake it every tick; balls moving every tick keep datagrams going.
  const laggyStream = { socketDelayMs: 150, loss: 0.2 };
  const bigOn = (w: World) => [...ghosts(w).values()].filter((n) => n.getData(Big));

  it("spawns a ghost bigger than a datagram on a client whose datagrams overtake the stream every tick, with its values", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 40);
    const server = world(engine, "Server");
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    fillBig(big, 3);
    step(engine, 120);
    const [clientBig] = bigOn(world(engine, "P1"));
    expect(clientBig).toBeDefined();
    expect(clientBig.getData(Big)!.f0).toBe(3);
    expect(clientBig.getData(Big)!.f299).toBe(3 + 299 * 0.25);
    expect(ghosts(world(engine, "P1")).size).toBe(41);
    // Its state changes since are small (a few fields): they go by datagram and arrive.
    inWorld(server, () => {
      (big.getData(Big)! as unknown as Record<string, number>).f7 = 99;
    });
    step(engine, 60);
    expect(clientBig.getData(Big)!.f7).toBe(99);
    expect(error).not.toHaveBeenCalled(); // no state for a ghost not spawned yet, no baseline it lacks
  });

  it("sends a ghost's state only after its spawn: spawns and despawns under reordering and loss never leave the client reading a state it can't place", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create({ socketDelayMs: 120, loss: 0.3, jitterMs: 10 });
    step(engine, 10);
    const server = world(engine, "Server");
    const balls: GameObject[] = [];
    // A wave of spawns every few ticks, and some destroyed again, some before their spawn can have arrived.
    for (let wave = 0; wave < 10; wave++) {
      inWorld(server, () => {
        for (let i = 0; i < 15; i++) balls.push(GameObject.instantiate("prefabs/partsBall.json", { position: [i, wave, 0] }));
      });
      step(engine, 3);
      inWorld(server, () => GameObject.destroy(balls[balls.length - 1 - (wave % 15)]));
    }
    step(engine, 180);
    expect(error).not.toHaveBeenCalled();
    const live = ghosts(server);
    const client = ghosts(world(engine, "P1"));
    expect([...client.keys()].sort((a, b) => a - b)).toEqual([...live.keys()].sort((a, b) => a - b));
    // Stopped, every ghost settles on its server value.
    inWorld(server, () => {
      for (const node of live.values()) node.getBehavior(Mover)!.enabled = false;
    });
    step(engine, 120);
    for (const [id, node] of live) expect(client.get(id)!.transform!.position.y).toBeCloseTo(node.transform!.position.y, 3);
  });

  it("destroys a big ghost destroyed while its spawn is in flight, leaving nothing on the client", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 10);
    step(engine, 30);
    const server = world(engine, "Server");
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    step(engine, 1); // its spawn is on its way, 150 ms behind
    inWorld(server, () => GameObject.destroy(big));
    step(engine, 60);
    const p1 = world(engine, "P1");
    expect(bigOn(p1)).toEqual([]);
    expect(p1._componentsOfType(Replicated).filter((r) => r.node.isValid && r.node.getData(Big))).toEqual([]);
    expect(ghosts(p1).size).toBe(10);
    expect(error).not.toHaveBeenCalled();
  });

  it("takes a big ghost away when it leaves relevancy and spawns it afresh, up to date, when it comes back", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 10);
    const server = world(engine, "Server");
    const connection = netSession(server)!.openPeers()[0].node!;
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    inWorld(server, () => {
      big.getBehavior(Replicated)!.group = "g";
      Interest.join(connection, "g");
    });
    fillBig(big, 1);
    step(engine, 90);
    const p1 = world(engine, "P1");
    expect(bigOn(p1)).toHaveLength(1);
    // Out, then back within a round trip of the laggy stream, its values changed meanwhile.
    inWorld(server, () => Interest.leave(connection, "g"));
    step(engine, 2);
    fillBig(big, 50);
    inWorld(server, () => Interest.join(connection, "g"));
    step(engine, 90);
    const back = bigOn(p1);
    expect(back).toHaveLength(1);
    expect(back[0].getData(Big)!.f0).toBe(50);
    expect(back[0].getData(Big)!.f299).toBe(50 + 299 * 0.25);
    // Out for good, then destroyed: gone from the client.
    inWorld(server, () => Interest.leave(connection, "g"));
    step(engine, 2);
    inWorld(server, () => GameObject.destroy(big));
    step(engine, 60);
    expect(bigOn(p1)).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("late state parts are read in tick order (ADR 0405)", () => {
  // A state part too big for a datagram goes by the stream, which lags the datagrams by 150 ms: every
  // tick, the next ticks' datagrams overtake it. Balls moving every tick keep datagrams going.
  const laggyStream = { socketDelayMs: 150, loss: 0.1 };
  const bigOn = (w: World) => [...ghosts(w).values()].filter((n) => n.getData(Big));

  it("keeps updating a ghost whose every state change is bigger than a datagram, and it catches up when the changes stop", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 40);
    const server = world(engine, "Server");
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    fillBig(big, 100);
    step(engine, 120);
    const [clientBig] = bigOn(world(engine, "P1"));
    expect(clientBig).toBeDefined();
    // Every field changes every frame, steadily from where it was: each tick's state is a part over a datagram.
    const shown = new Set<number>();
    let shownBefore = -Infinity;
    let wentBack = false;
    for (let i = 0; i < 180; i++) {
      inWorld(server, () => fillBig(big, 101 + i));
      step(engine);
      const f0 = clientBig.getData(Big)!.f0;
      if (f0 < shownBefore - 1e-3) wentBack = true;
      shownBefore = Math.max(shownBefore, f0);
      shown.add(Math.round(f0));
    }
    // It kept moving (a little behind), never showing an older state after a newer one.
    expect(shown.size).toBeGreaterThan(20);
    expect(wentBack).toBe(false);
    // The changes stop: it ends on the server's values.
    inWorld(server, () => fillBig(big, 500));
    step(engine, 120);
    expect(clientBig.getData(Big)!.f0).toBe(500);
    expect(clientBig.getData(Big)!.f299).toBe(500 + 299 * 0.25);
    expect(error).not.toHaveBeenCalled();
  });

  it("isn't starved by lifecycle messages every tick: a late part is stale only for a ghost spawned, relayouted or moved after it", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 20);
    const server = world(engine, "Server");
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    fillBig(big, 1);
    step(engine, 120);
    const [clientBig] = bigOn(world(engine, "P1"));
    const shown = new Set<number>();
    const churn: GameObject[] = [];
    for (let i = 0; i < 180; i++) {
      // A spawn and a despawn every frame: a lifecycle message every tick.
      inWorld(server, () => {
        fillBig(big, 100 + i);
        churn.push(GameObject.instantiate("prefabs/partsCrate.json"));
        if (churn.length > 3) GameObject.destroy(churn.shift()!);
      });
      step(engine);
      shown.add(Math.round(clientBig.getData(Big)!.f0));
    }
    expect(shown.size).toBeGreaterThan(20);
    inWorld(server, () => fillBig(big, 700));
    step(engine, 120);
    expect(clientBig.getData(Big)!.f0).toBe(700);
    expect(error).not.toHaveBeenCalled();
  });

  it("drops late parts from before a relayout instead of reading them in the new layout, and converges after it", async () => {
    const error = vi.spyOn(console, "error");
    const engine = await create(laggyStream);
    step(engine, 10);
    spawn(engine, "prefabs/partsBall.json", 20);
    const server = world(engine, "Server");
    const big = inWorld(server, () => GameObject.instantiate("prefabs/partsBig.json"));
    fillBig(big, 100);
    step(engine, 120);
    const [clientBig] = bigOn(world(engine, "P1"));
    for (let i = 0; i < 120; i++) {
      inWorld(server, () => {
        fillBig(big, 101 + i);
        // A relayout while big parts from before it are still on their way, and another after.
        if (i === 40) big.addData(Badge, { level: 3 });
        if (i === 80) big.removeData(Badge);
        if (i === 100) big.addData(Badge, { level: 9 });
      });
      step(engine);
    }
    inWorld(server, () => fillBig(big, 900));
    step(engine, 120);
    expect(clientBig.getData(Big)!.f0).toBe(900);
    expect(clientBig.getData(Badge)?.level).toBe(9);
    expect(error).not.toHaveBeenCalled();
  });
});
