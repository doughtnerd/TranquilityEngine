import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, GameBehavior, Replicated, behavior, field, type BootstrapConfig } from "../index";
import { World } from "../core/World";
import { netSession } from "../net/session";
import { serverReplication } from "../net/replication/server";
import { createTransport, registerTransport, type Channel, type Transport, type TransportConnection, type TransportEvent } from "../net/Transport";

// ADR 0334: snapshots split into datagram-sized parts, each acked on its own. The link runs over a
// datagram transport registered here: the loopback (fake clock, seeded loss) with `maxDatagramBytes`
// set, as the WebSocket transport has while its WebRTC data channel is open (ADR 0333). It records
// the size of every unreliable message the server sends.

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

  constructor(options: Record<string, unknown>) {
    this.inner = createTransport("loopback", options);
  }

  async listen(address: string): Promise<void> {
    this.listening = true;
    await this.inner.listen(address);
  }

  connect(address: string): TransportConnection {
    return this.wrap(this.inner.connect(address));
  }

  poll(): TransportEvent[] {
    return this.inner.poll().map((e) => ({ ...e, connection: this.wrap(e.connection) }));
  }

  close(): void {
    this.inner.close();
  }

  private wrap(c: TransportConnection): TransportConnection {
    let w = this.wrapped.get(c);
    if (!w) {
      const server = this.listening;
      w = {
        id: c.id,
        remote: c.remote,
        get state() {
          return c.state;
        },
        maxDatagramBytes: DATAGRAM,
        send(channel: Channel, data: Uint8Array) {
          if (server && channel === "unreliable") serverSends.push(data.byteLength);
          c.send(channel, data);
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

Assets.addSource(
  Assets.fromObject({
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
    step(engine, 2);
    const ps = peerState(engine);
    expect(ps.lastParts).toBeGreaterThan(1);
    expect(ps.lastBytes).toBeGreaterThan(3 * DATAGRAM);
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
